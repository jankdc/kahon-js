/**
 * IO-effect core. Single-result navigation and decode logic is written once
 * here as generators that `yield` `ReadEffect` requests; the async driver
 * fulfills those requests by reading bytes from a `ByteSource`.
 */

import { HEADER_SIZE } from "./codes.js";
import {
  PEEK_CHUNK,
  parseStringPrelude,
  readUintW,
  tryParseNodeHeader,
  type ContainerHeader,
  type KahonValue,
  type NodeHeader,
} from "./parse.js";

import type { ByteSource } from "./source.js";

/**
 * §8 invariant 7: every offset is past the header (≥ 6) and strictly less than
 * the carrying node's position (postorder writes children before parents).
 * The "lands on a valid type-code byte" half is enforced naturally, any
 * subsequent `readNodeHeader` will throw on a reserved/unknown tag.
 */
export function checkChildOffset(childOff: number, carrierOff: number): void {
  if (childOff < HEADER_SIZE) {
    throw new Error(`child offset ${childOff} below header (${HEADER_SIZE})`);
  }
  if (childOff >= carrierOff) {
    throw new Error(
      `child offset ${childOff} is not strictly before carrier ${carrierOff} (forward reference)`,
    );
  }
}

/**
 * §8 invariant 4: object-leaf keys must be strictly UTF-8-sorted. Used by both
 * iteration helpers, which validate inline as they yield each key.
 */
export function checkKeyOrder(
  prevKey: Buffer | undefined,
  keyBuf: Buffer,
  nodeOffset: number,
): void {
  if (prevKey === undefined) return;
  const cmp = Buffer.compare(prevKey, keyBuf);
  if (cmp === 0) {
    throw new Error(
      `duplicate key in object leaf at offset ${nodeOffset} ` +
        `(producer bug; cannot be suppressed)`,
    );
  }
  if (cmp > 0) {
    throw new Error(
      `unsorted keys in object leaf at offset ${nodeOffset} ` +
        `(disable with validateLeafKeys: false if the producer is trusted)`,
    );
  }
}

export type ReadEffect =
  | { kind: "read"; offset: number; length: number }
  | { kind: "peek"; offset: number; max: number };

/** A computation that yields `ReadEffect` requests and returns a `T`. */
export type Eff<T> = Generator<ReadEffect, T, Buffer>;

/**
 * Tunables threaded through navigation generators. The runner doesn't see
 * these, only call-sites that read entry tables.
 */
export interface EffOptions {
  /** Entry tables larger than this are accessed in O(1)-bytes-per-probe mode. */
  eagerEntriesThreshold: number;
  /**
   * Whether to verify that an object leaf's keys are strictly sorted (the
   * §8 invariant 4 check) before relying on order for binary search. When
   * disabled, malformed producers can cause silently-wrong lookups.
   */
  validateLeafKeys: boolean;
  /**
   * Hard cap on a container's reported `length` / `childCount`. Defends
   * against malformed producers that claim absurd sizes to force expensive
   * traversals. Containers exceeding this throw on first navigation.
   */
  maxContainerEntries: number;
  /**
   * Optional set of leaf `nodeOffset`s that have already been validated.
   * `validateObjectLeafKeys` adds to this on success and short-circuits on
   * subsequent calls, so a single reader instance pays the validation cost
   * at most once per leaf.
   */
  validatedLeaves?: Set<number>;
}

export function enforceCap(h: ContainerHeader, opts: EffOptions): void {
  const cap = opts.maxContainerEntries;
  if (cap === Number.POSITIVE_INFINITY) return;
  if (h.length > cap) {
    throw new Error(
      `container at offset ${h.nodeOffset} has length=${h.length} exceeding cap=${cap} ` +
        `(raise or remove maxContainerEntries)`,
    );
  }
  if (!h.isLeaf && h.childCount > cap) {
    throw new Error(
      `container at offset ${h.nodeOffset} has childCount=${h.childCount} exceeding cap=${cap} ` +
        `(raise or remove maxContainerEntries)`,
    );
  }
}

async function fulfill(source: ByteSource, e: ReadEffect): Promise<Buffer> {
  return e.kind === "read"
    ? source.read(e.offset, e.length)
    : source.read(e.offset, Math.min(e.max, source.size - e.offset));
}

export async function run<T>(source: ByteSource, eff: Eff<T>): Promise<T> {
  let n = eff.next();
  while (!n.done) {
    n = eff.next(await fulfill(source, n.value));
  }
  return n.value;
}

// ---------------------------------------------------------------------------
// Single-result generators.
// ---------------------------------------------------------------------------

export function* readNodeHeader(offset: number): Eff<NodeHeader> {
  let chunk = yield { kind: "peek", offset, max: PEEK_CHUNK };
  let r = tryParseNodeHeader(chunk, offset);
  while (!r.ok) {
    chunk = yield { kind: "read", offset, length: r.neededLen };
    r = tryParseNodeHeader(chunk, offset);
  }
  return r.header;
}

export function* readStringAt(offset: number): Eff<string> {
  const h = yield* readNodeHeader(offset);
  if (h.kind !== "string") {
    throw new Error(`expected string at offset ${offset}, got ${h.kind}`);
  }
  return h.value;
}

/** Three-way compare: stored key at `offset` vs `target` (UTF-8). */
function* compareKeyAt(offset: number, target: Buffer): Eff<number> {
  let chunk = yield { kind: "peek", offset, max: PEEK_CHUNK };
  let prelude = parseStringPrelude(chunk, offset);
  if (chunk.length < prelude.dataStart + prelude.len) {
    chunk = yield { kind: "read", offset, length: prelude.dataStart + prelude.len };
    prelude = parseStringPrelude(chunk, offset);
  }
  return chunk.compare(
    target,
    0,
    target.length,
    prelude.dataStart,
    prelude.dataStart + prelude.len,
  );
}

export function* arrayChildAt(
  h: ContainerHeader,
  index: number,
  opts: EffOptions,
): Eff<number | undefined> {
  if (h.kind !== "array") return undefined;
  enforceCap(h, opts);
  if (index < 0 || index >= h.length) return undefined;
  if (h.isLeaf) {
    const bytes = yield {
      kind: "read",
      offset: h.entriesOffset + index * h.width,
      length: h.width,
    };
    const childOff = readUintW(bytes, 0, h.width);
    checkChildOffset(childOff, h.nodeOffset);
    return childOff;
  }
  // Internal-node entry table is bounded by B-tree fanout, read eagerly.
  const entrySize = 8 + h.width;
  const entries = yield {
    kind: "read",
    offset: h.entriesOffset,
    length: h.childCount * entrySize,
  };
  let remaining = index;
  for (let i = 0; i < h.childCount; i++) {
    const base = i * entrySize;
    const subTotalBig = entries.readBigUInt64LE(base);
    if (subTotalBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("subtotal exceeds safe integer");
    }
    const subTotal = Number(subTotalBig);
    if (remaining < subTotal) {
      const childOff = readUintW(entries, base + 8, h.width);
      checkChildOffset(childOff, h.nodeOffset);
      const childHeader = yield* readNodeHeader(childOff);
      if (childHeader.kind !== "array") return undefined;
      return yield* arrayChildAt(childHeader, remaining, opts);
    }
    remaining -= subTotal;
  }
  return undefined;
}

export function* objectChildOf(
  h: ContainerHeader,
  key: string,
  opts: EffOptions,
): Eff<number | undefined> {
  if (h.kind !== "object" || h.length === 0) return undefined;
  enforceCap(h, opts);
  const keyBytes = Buffer.from(key, "utf-8");

  if (h.isLeaf) {
    const pairSize = h.width * 2;
    const totalBytes = h.length * pairSize;

    if (totalBytes <= opts.eagerEntriesThreshold) {
      // Whole-table mode: read once, validate sortedness, binary search.
      yield* validateObjectLeafKeys(h, opts);
      const pairs = yield {
        kind: "read",
        offset: h.entriesOffset,
        length: totalBytes,
      };
      let lo = 0;
      let hi = h.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const keyOff = readUintW(pairs, mid * pairSize, h.width);
        checkChildOffset(keyOff, h.nodeOffset);
        const cmp = yield* compareKeyAt(keyOff, keyBytes);
        if (cmp === 0) {
          const valOff = readUintW(pairs, mid * pairSize + h.width, h.width);
          checkChildOffset(valOff, h.nodeOffset);
          return valOff;
        }
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      return undefined;
    }

    // Chunked mode: O(W·log N) bytes for the lookup. Sortedness is NOT
    // re-validated here. The cache layer absorbs repeated probes that 
    // share a chunk.
    let lo = 0;
    let hi = h.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const pair = yield {
        kind: "read",
        offset: h.entriesOffset + mid * pairSize,
        length: pairSize,
      };
      const keyOff = readUintW(pair, 0, h.width);
      checkChildOffset(keyOff, h.nodeOffset);
      const cmp = yield* compareKeyAt(keyOff, keyBytes);
      if (cmp === 0) {
        const valOff = readUintW(pair, h.width, h.width);
        checkChildOffset(valOff, h.nodeOffset);
        return valOff;
      }
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  // Internal-node entry table is bounded by fanout, read eagerly.
  const entrySize = 8 + h.width * 3;
  const entries = yield {
    kind: "read",
    offset: h.entriesOffset,
    length: h.childCount * entrySize,
  };
  for (let i = 0; i < h.childCount; i++) {
    const base = i * entrySize;
    const keyOffLo = readUintW(entries, base + 8, h.width);
    const keyOffHi = readUintW(entries, base + 8 + h.width, h.width);
    checkChildOffset(keyOffLo, h.nodeOffset);
    checkChildOffset(keyOffHi, h.nodeOffset);
    if ((yield* compareKeyAt(keyOffLo, keyBytes)) > 0) continue;
    if ((yield* compareKeyAt(keyOffHi, keyBytes)) < 0) continue;
    const childOff = readUintW(entries, base + 8 + h.width * 2, h.width);
    checkChildOffset(childOff, h.nodeOffset);
    const childHeader = yield* readNodeHeader(childOff);
    if (childHeader.kind !== "object") continue;
    const found = yield* objectChildOf(childHeader, key, opts);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * §8 invariant 4: keys in an object leaf MUST be strictly UTF-8-sorted (so
 * also unique). Validate once when we touch the leaf, before any binary search
 * relies on the order, out-of-order keys would silently break lookups.
 */
function* validateObjectLeafKeys(h: ContainerHeader, opts: EffOptions): Eff<void> {
  if (h.kind !== "object" || !h.isLeaf || h.length < 2) return;
  if (!opts.validateLeafKeys) return;
  if (opts.validatedLeaves?.has(h.nodeOffset)) return;
  const pairSize = h.width * 2;
  const windowPairs = Math.max(1, Math.floor(opts.eagerEntriesThreshold / pairSize));
  let prevKey: Buffer | undefined;
  for (let i = 0; i < h.length; i += windowPairs) {
    const n = Math.min(windowPairs, h.length - i);
    const win = yield {
      kind: "read",
      offset: h.entriesOffset + i * pairSize,
      length: n * pairSize,
    };
    for (let j = 0; j < n; j++) {
      const keyOff = readUintW(win, j * pairSize, h.width);
      checkChildOffset(keyOff, h.nodeOffset);
      const curKey = yield* readBytesAtKey(keyOff);
      checkKeyOrder(prevKey, curKey, h.nodeOffset);
      prevKey = curKey;
    }
  }
  opts.validatedLeaves?.add(h.nodeOffset);
}

function* readBytesAtKey(offset: number): Eff<Buffer> {
  let chunk = yield { kind: "peek", offset, max: PEEK_CHUNK };
  let prelude = parseStringPrelude(chunk, offset);
  if (chunk.length < prelude.dataStart + prelude.len) {
    chunk = yield { kind: "read", offset, length: prelude.dataStart + prelude.len };
    prelude = parseStringPrelude(chunk, offset);
  }
  return Buffer.from(chunk.subarray(prelude.dataStart, prelude.dataStart + prelude.len));
}

export function* decodeAt(offset: number, opts: EffOptions): Eff<KahonValue> {
  const h = yield* readNodeHeader(offset);
  switch (h.kind) {
    case "null":
      return null;
    case "boolean":
      return h.value;
    case "number":
      return h.value;
    case "bigint":
      return h.value;
    case "string":
      return h.value;
    case "array":
      return yield* decodeArray(h, opts);
    case "object":
      return yield* decodeObject(h, opts);
    case "extension":
      // Extension codes carry no JSON correspondence, surface a sentinel so
      // callers that traverse into one don't silently get `undefined`.
      return EXTENSION_SENTINEL;
  }
}

/** Marker returned by `decode()` when the value is an opaque extension. */
export const EXTENSION_SENTINEL = Symbol.for("kahon.extension") as unknown as KahonValue;

function* decodeArray(h: ContainerHeader, opts: EffOptions): Eff<KahonValue[]> {
  if (h.kind !== "array") throw new Error("not array");
  enforceCap(h, opts);
  if (h.length === 0) return [];
  const out: KahonValue[] = [];
  if (h.isLeaf) {
    const all = yield {
      kind: "read",
      offset: h.entriesOffset,
      length: h.length * h.width,
    };
    for (let i = 0; i < h.length; i++) {
      const childOff = readUintW(all, i * h.width, h.width);
      checkChildOffset(childOff, h.nodeOffset);
      out.push(yield* decodeAt(childOff, opts));
    }
    return out;
  }
  const entrySize = 8 + h.width;
  const entries = yield {
    kind: "read",
    offset: h.entriesOffset,
    length: h.childCount * entrySize,
  };
  for (let i = 0; i < h.childCount; i++) {
    const childOff = readUintW(entries, i * entrySize + 8, h.width);
    checkChildOffset(childOff, h.nodeOffset);
    const childHeader = yield* readNodeHeader(childOff);
    if (childHeader.kind !== "array") {
      throw new Error(`expected array child at offset ${childOff}`);
    }
    for (const v of yield* decodeArray(childHeader, opts)) out.push(v);
  }
  return out;
}

function* decodeObject(
  h: ContainerHeader,
  opts: EffOptions,
): Eff<{ [k: string]: KahonValue }> {
  if (h.kind !== "object") throw new Error("not object");
  enforceCap(h, opts);
  const out: { [k: string]: KahonValue } = {};
  if (h.length === 0) return out;
  if (h.isLeaf) {
    yield* validateObjectLeafKeys(h, opts);
    const pairSize = h.width * 2;
    const pairs = yield {
      kind: "read",
      offset: h.entriesOffset,
      length: h.length * pairSize,
    };
    for (let i = 0; i < h.length; i++) {
      const keyOff = readUintW(pairs, i * pairSize, h.width);
      const valOff = readUintW(pairs, i * pairSize + h.width, h.width);
      checkChildOffset(keyOff, h.nodeOffset);
      checkChildOffset(valOff, h.nodeOffset);
      const key = yield* readStringAt(keyOff);
      out[key] = yield* decodeAt(valOff, opts);
    }
    return out;
  }
  const entrySize = 8 + h.width * 3;
  const entries = yield {
    kind: "read",
    offset: h.entriesOffset,
    length: h.childCount * entrySize,
  };
  for (let i = 0; i < h.childCount; i++) {
    const childOff = readUintW(entries, i * entrySize + 8 + h.width * 2, h.width);
    checkChildOffset(childOff, h.nodeOffset);
    const childHeader = yield* readNodeHeader(childOff);
    if (childHeader.kind !== "object") {
      throw new Error(`expected object child at offset ${childOff}`);
    }
    Object.assign(out, yield* decodeObject(childHeader, opts));
  }
  return out;
}

/** Walk `segments` starting from `rootOffset`; returns the resolved offset, or undefined. */
export function* findFromOffset(
  rootOffset: number,
  segments: ReadonlyArray<string | number>,
  opts: EffOptions,
): Eff<number | undefined> {
  let offset: number | undefined = rootOffset;
  for (const seg of segments) {
    if (offset === undefined) return undefined;
    const h: NodeHeader = yield* readNodeHeader(offset);
    if (h.kind === "array") {
      const idx = typeof seg === "number" ? seg : Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      offset = yield* arrayChildAt(h, idx, opts);
    } else if (h.kind === "object") {
      offset = yield* objectChildOf(h, String(seg), opts);
    } else {
      return undefined;
    }
  }
  return offset;
}

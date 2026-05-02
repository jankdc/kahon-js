import { HEADER_SIZE, TRAILER_SIZE } from "./codes.js";
import {
  arrayChildAt as arrayChildAtEff,
  checkChildOffset,
  checkKeyOrder,
  decodeAt as decodeAtEff,
  enforceCap,
  findFromOffset,
  objectChildOf as objectChildOfEff,
  readNodeHeader as readNodeHeaderEff,
  readStringAt as readStringAtEff,
  run,
  type EffOptions,
} from "./effect.js";
import { EntryTable } from "./entries.js";
import {
  checkSourceSize,
  parsePath,
  parseRootOffset,
  readUintW,
  validateHeaderBytes,
  validateTrailerBytes,
  type ContainerHeader,
  type KahonKind,
  type KahonValue,
  type NodeHeader,
  type Path,
} from "./parse.js";
import { CachedByteSource, type ByteSource } from "./source.js";

export type { KahonKind, KahonScalar, KahonValue, Path } from "./parse.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export interface KahonReaderOptions {
  /**
   * Tables of `count*entrySize` bytes at or below this threshold are read in
   * a single I/O; larger tables are streamed/random-accessed in windows.
   * Default: 64 KiB.
   */
  eagerEntriesThreshold?: number;
  /**
   * Target chunk size for the source-level LRU cache and for streaming
   * iteration windows. Rounded up to the nearest page (default 16 KiB).
   */
  readChunkBytes?: number;
  /**
   * Byte budget for the source-level LRU. 0 disables caching. The reader
   * wraps the supplied source in a `CachedByteSource` unless this is 0 or
   * the source is already a `CachedByteSource`. Default: 4 MiB.
   */
  sourceCacheBytes?: number;
  /**
   * Whether to verify object-leaf key sortedness on first touch. Each leaf
   * is validated at most once per reader instance; subsequent operations on
   * the same leaf skip the check. Disable only if you fully trust the
   * producer - a malformed leaf will produce silently-wrong lookups.
   * Default: true.
   */
  validateLeafKeys?: boolean;
  /**
   * Hard cap on a container's reported `length` / `childCount`. Defends
   * against malformed producers that claim absurd sizes. A container
   * exceeding this throws on first navigation. Default: no cap.
   */
  maxContainerEntries?: number;
}

interface ResolvedOptions {
  eagerEntriesThreshold: number;
  readChunkBytes: number;
  sourceCacheBytes: number;
  validateLeafKeys: boolean;
  maxContainerEntries: number;
}

const PAGE_BYTES = 16 * 1024;

const DEFAULTS: ResolvedOptions = {
  eagerEntriesThreshold: 64 * 1024,
  readChunkBytes: PAGE_BYTES,
  sourceCacheBytes: 4 * 1024 * 1024,
  validateLeafKeys: true,
  maxContainerEntries: Number.POSITIVE_INFINITY,
};

function effOptsOf(reader: KahonReader): EffOptions {
  const o = reader._opts();
  return {
    eagerEntriesThreshold: o.eagerEntriesThreshold,
    validateLeafKeys: o.validateLeafKeys,
    maxContainerEntries: o.maxContainerEntries,
    validatedLeaves: reader._validatedLeaves(),
  };
}

function resolveOptions(opts: KahonReaderOptions | undefined): ResolvedOptions {
  const rawChunk = opts?.readChunkBytes ?? DEFAULTS.readChunkBytes;
  const readChunkBytes = Math.max(PAGE_BYTES, Math.ceil(Math.max(1, rawChunk) / PAGE_BYTES) * PAGE_BYTES);
  return {
    eagerEntriesThreshold: opts?.eagerEntriesThreshold ?? DEFAULTS.eagerEntriesThreshold,
    readChunkBytes,
    sourceCacheBytes: opts?.sourceCacheBytes ?? DEFAULTS.sourceCacheBytes,
    validateLeafKeys: opts?.validateLeafKeys ?? DEFAULTS.validateLeafKeys,
    maxContainerEntries: opts?.maxContainerEntries ?? DEFAULTS.maxContainerEntries,
  };
}

// ---------------------------------------------------------------------------
// KahonReader
// ---------------------------------------------------------------------------

export class KahonReader {
  private rootOffsetCached?: number;
  private validated = false;
  private readonly validatedLeaves = new Set<number>();

  private constructor(
    private readonly source: ByteSource,
    private readonly opts: ResolvedOptions,
  ) {}

  static async fromSource(
    source: ByteSource,
    opts?: KahonReaderOptions,
  ): Promise<KahonReader> {
    const resolved = resolveOptions(opts);
    const wrapped: ByteSource =
      resolved.sourceCacheBytes > 0 && !(source instanceof CachedByteSource)
        ? new CachedByteSource(source, {
            cacheBytes: resolved.sourceCacheBytes,
            chunkBytes: resolved.readChunkBytes,
          })
        : source;
    const reader = new KahonReader(wrapped, resolved);
    await reader.validate();
    return reader;
  }

  private async validate(): Promise<void> {
    if (this.validated) return;
    checkSourceSize(this.source.size);
    validateHeaderBytes(await this.source.read(0, HEADER_SIZE));
    validateTrailerBytes(
      await this.source.read(this.source.size - TRAILER_SIZE, TRAILER_SIZE),
    );
    this.validated = true;
  }

  private async rootOffset(): Promise<number> {
    if (this.rootOffsetCached !== undefined) return this.rootOffsetCached;
    const trailer = await this.source.read(this.source.size - TRAILER_SIZE, TRAILER_SIZE);
    this.rootOffsetCached = parseRootOffset(trailer, this.source.size);
    return this.rootOffsetCached;
  }

  async root(): Promise<Cursor> {
    return new Cursor(this, await this.rootOffset());
  }

  async decode(): Promise<KahonValue> {
    return (await this.root()).decode();
  }

  async get(path: Path): Promise<KahonValue | undefined> {
    const c = await this.find(path);
    return c ? c.decode() : undefined;
  }

  async find(path: Path): Promise<Cursor | undefined> {
    const off = await run(
      this.source,
      findFromOffset(await this.rootOffset(), parsePath(path), effOptsOf(this)),
    );
    return off !== undefined ? new Cursor(this, off) : undefined;
  }

  async has(path: Path): Promise<boolean> {
    return (await this.find(path)) !== undefined;
  }

  /** @internal */
  _source(): ByteSource {
    return this.source;
  }

  /** @internal */
  _opts(): ResolvedOptions {
    return this.opts;
  }

  /** @internal */
  _validatedLeaves(): Set<number> {
    return this.validatedLeaves;
  }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export class Cursor {
  private headerCache?: NodeHeader;

  /** @internal */
  constructor(
    /** @internal */ readonly reader: KahonReader,
    readonly offset: number,
  ) {}

  async kind(): Promise<KahonKind> {
    return (await this.header()).kind;
  }

  async length(): Promise<number> {
    const h = await this.header();
    if (h.kind === "array" || h.kind === "object") return h.length;
    if (h.kind === "string") return h.byteLength;
    throw new Error(`length is not defined for kind=${h.kind}`);
  }

  async decode(): Promise<KahonValue> {
    return run(this.reader._source(), decodeAtEff(this.offset, effOptsOf(this.reader)));
  }

  async get(key: string): Promise<Cursor | undefined> {
    const h = await this.header();
    if (h.kind !== "object") return undefined;
    const off = await run(
      this.reader._source(),
      objectChildOfEff(h, key, effOptsOf(this.reader)),
    );
    return off !== undefined ? new Cursor(this.reader, off) : undefined;
  }

  async at(index: number): Promise<Cursor | undefined> {
    if (!Number.isInteger(index)) return undefined;
    const h = await this.header();
    if (h.kind !== "array") return undefined;
    const i = index < 0 ? h.length + index : index;
    if (i < 0 || i >= h.length) return undefined;
    const off = await run(
      this.reader._source(),
      arrayChildAtEff(h, i, effOptsOf(this.reader)),
    );
    return off !== undefined ? new Cursor(this.reader, off) : undefined;
  }

  async has(key: string | number): Promise<boolean> {
    const h = await this.header();
    if (h.kind === "object") return (await this.get(String(key))) !== undefined;
    if (h.kind === "array") {
      const idx = typeof key === "number" ? key : Number(key);
      return Number.isInteger(idx) && (await this.at(idx)) !== undefined;
    }
    return false;
  }

  async *values(): AsyncIterableIterator<Cursor> {
    const h = await this.header();
    if (h.kind === "array") yield* arrayChildren(this.reader, h);
    else if (h.kind === "object") {
      for await (const [, c] of objectEntries(this.reader, h)) yield c;
    } else throw new Error(`values() is only valid on arrays/objects (kind=${h.kind})`);
  }

  async *keys(): AsyncIterableIterator<string> {
    const h = await this.header();
    if (h.kind === "object") {
      for await (const [k] of objectEntries(this.reader, h)) yield k;
    } else if (h.kind === "array") {
      for (let i = 0; i < h.length; i++) yield String(i);
    } else throw new Error(`keys() is only valid on arrays/objects (kind=${h.kind})`);
  }

  async *entries(): AsyncIterableIterator<[string, Cursor]> {
    const h = await this.header();
    if (h.kind === "object") {
      yield* objectEntries(this.reader, h);
    } else if (h.kind === "array") {
      let i = 0;
      for await (const c of arrayChildren(this.reader, h)) yield [String(i++), c];
    } else throw new Error(`entries() is only valid on arrays/objects (kind=${h.kind})`);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Cursor> {
    return this.values();
  }

  private async header(): Promise<NodeHeader> {
    if (!this.headerCache) {
      this.headerCache = await run(this.reader._source(), readNodeHeaderEff(this.offset));
    }
    return this.headerCache;
  }
}

// ---------------------------------------------------------------------------
// Iteration helpers. Streaming-friendly: leaf entry tables are read through
// `EntryTable`, which respects the reader's eager threshold and reads in
// windows above it. Internal-node entry tables are bounded by the B-tree
// fanout (typically tiny) and read eagerly as before.
// ---------------------------------------------------------------------------

async function* arrayChildren(
  reader: KahonReader,
  h: ContainerHeader,
): AsyncIterableIterator<Cursor> {
  if (h.kind !== "array" || h.length === 0) return;
  const source = reader._source();
  const opts = reader._opts();
  enforceCap(h, effOptsOf(reader));
  if (h.isLeaf) {
    const table = new EntryTable(
      source,
      h.entriesOffset,
      h.length,
      h.width,
      opts.eagerEntriesThreshold,
      opts.readChunkBytes,
    );
    for await (const entry of table.iter()) {
      const childOff = readUintW(entry, 0, h.width);
      checkChildOffset(childOff, h.nodeOffset);
      yield new Cursor(reader, childOff);
    }
    return;
  }
  const entrySize = 8 + h.width;
  const entries = await source.read(h.entriesOffset, h.childCount * entrySize);
  for (let i = 0; i < h.childCount; i++) {
    const childOff = readUintW(entries, i * entrySize + 8, h.width);
    checkChildOffset(childOff, h.nodeOffset);
    const childHeader = await run(source, readNodeHeaderEff(childOff));
    if (childHeader.kind !== "array") {
      throw new Error(`expected array child at offset ${childOff}`);
    }
    yield* arrayChildren(reader, childHeader);
  }
}

async function* objectEntries(
  reader: KahonReader,
  h: ContainerHeader,
): AsyncIterableIterator<[string, Cursor]> {
  if (h.kind !== "object" || h.length === 0) return;
  const source = reader._source();
  const opts = reader._opts();
  enforceCap(h, effOptsOf(reader));
  if (h.isLeaf) {
    const pairSize = h.width * 2;
    const table = new EntryTable(
      source,
      h.entriesOffset,
      h.length,
      pairSize,
      opts.eagerEntriesThreshold,
      opts.readChunkBytes,
    );
    const validate = opts.validateLeafKeys;
    let prevKey: Buffer | undefined;
    for await (const pair of table.iter()) {
      const keyOff = readUintW(pair, 0, h.width);
      const valOff = readUintW(pair, h.width, h.width);
      checkChildOffset(keyOff, h.nodeOffset);
      checkChildOffset(valOff, h.nodeOffset);
      const key = await run(source, readStringAtEff(keyOff));
      if (validate) {
        const keyBuf = Buffer.from(key, "utf-8");
        checkKeyOrder(prevKey, keyBuf, h.nodeOffset);
        prevKey = keyBuf;
      }
      yield [key, new Cursor(reader, valOff)];
    }
    return;
  }
  const entrySize = 8 + h.width * 3;
  const entries = await source.read(h.entriesOffset, h.childCount * entrySize);
  const childIters: AsyncIterableIterator<[string, Cursor]>[] = [];
  for (let i = 0; i < h.childCount; i++) {
    const childOff = readUintW(entries, i * entrySize + 8 + h.width * 2, h.width);
    checkChildOffset(childOff, h.nodeOffset);
    const childHeader = await run(source, readNodeHeaderEff(childOff));
    if (childHeader.kind !== "object") {
      throw new Error(`expected object child at offset ${childOff}`);
    }
    childIters.push(objectEntries(reader, childHeader));
  }
  const heads: ([string, Cursor] | undefined)[] = [];
  for (const it of childIters) {
    const r = await it.next();
    heads.push(r.done ? undefined : r.value);
  }
  while (true) {
    let bestIdx = -1;
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i];
      if (!head) continue;
      if (bestIdx < 0 || head[0] < heads[bestIdx]![0]) bestIdx = i;
    }
    if (bestIdx < 0) return;
    yield heads[bestIdx]!;
    const next = await childIters[bestIdx]!.next();
    heads[bestIdx] = next.done ? undefined : next.value;
  }
}

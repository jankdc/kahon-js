import {
  HEADER_SIZE,
  MAGIC_BYTES,
  TRAILER_SIZE,
  VERSION,
  T_NULL,
  T_FALSE,
  T_TRUE,
  T_TINY_NEG_INT_MIN,
  T_TINY_NEG_INT_MAX,
  T_TINY_UINT_MIN,
  T_TINY_UINT_MAX,
  T_EMPTY_ARRAY,
  T_EMPTY_OBJECT,
  T_UINT8,
  T_UINT16,
  T_UINT32,
  T_UINT64,
  T_INT8,
  T_INT16,
  T_INT32,
  T_INT64,
  T_FLOAT32,
  T_FLOAT64,
  T_TINY_STRING_MIN,
  T_TINY_STRING_MAX,
  T_STRING,
  T_ARRAY_LEAF_MIN,
  T_ARRAY_LEAF_MAX,
  T_ARRAY_INTERNAL_MIN,
  T_ARRAY_INTERNAL_MAX,
  T_OBJECT_LEAF_MIN,
  T_OBJECT_LEAF_MAX,
  T_OBJECT_INTERNAL_MIN,
  T_OBJECT_INTERNAL_MAX,
  widthFromCode,
  type OffsetWidth,
} from "./codes.js";

export type KahonKind =
  | "null"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "array"
  | "object"
  | "extension";

export type ScalarHeader =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "bigint"; value: bigint }
  | { kind: "string"; value: string; byteLength: number }
  | { kind: "extension" };

export type ContainerHeader =
  | {
      kind: "array";
      isLeaf: true;
      width: OffsetWidth;
      length: number;
      entriesOffset: number;
      nodeOffset: number;
    }
  | {
      kind: "array";
      isLeaf: false;
      width: OffsetWidth;
      length: number;
      childCount: number;
      entriesOffset: number;
      nodeOffset: number;
    }
  | {
      kind: "object";
      isLeaf: true;
      width: OffsetWidth;
      length: number;
      entriesOffset: number;
      nodeOffset: number;
    }
  | {
      kind: "object";
      isLeaf: false;
      width: OffsetWidth;
      length: number;
      childCount: number;
      entriesOffset: number;
      nodeOffset: number;
    };

export type NodeHeader = ScalarHeader | ContainerHeader;

export type KahonScalar = null | boolean | number | bigint | string;
export type KahonValue = KahonScalar | KahonValue[] | { [k: string]: KahonValue };

/** A path: JSON Pointer (RFC 6901) string, or array of segments. */
export type Path = string | ReadonlyArray<string | number>;

/**
 * Result of attempting to parse a node header from a chunk of bytes.
 *
 * If `ok: false`, the caller must re-read `neededLen` bytes from the node's
 * absolute offset and try again - the only situation this happens is for a
 * long T_STRING whose payload exceeds the speculative peek window.
 */
export type ParseResult =
  | { ok: true; header: NodeHeader }
  | { ok: false; neededLen: number };

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Bytes to speculatively pull when sniffing a node header. */
export const PEEK_CHUNK = 64;

/** Parses a JSON Pointer (RFC 6901) string or accepts an array path as-is. */
export function parsePath(
  path: string | ReadonlyArray<string | number>,
): (string | number)[] {
  if (Array.isArray(path)) return [...path];
  if (typeof path !== "string") throw new TypeError("path must be a string or array");
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new Error(`JSON pointer must start with '/' (got: ${JSON.stringify(path)})`);
  }
  return path
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function checkSourceSize(size: number): void {
  if (size < HEADER_SIZE + TRAILER_SIZE) {
    throw new Error(`file too small to be Kahon: ${size} bytes`);
  }
}

export function validateHeaderBytes(header: Buffer): void {
  if (header.subarray(0, 4).compare(MAGIC_BYTES) !== 0) {
    throw new Error("invalid header magic (expected 'KAHN')");
  }
  if (header[4] !== VERSION) {
    throw new Error(`unsupported Kahon version: 0x${header[4]!.toString(16)}`);
  }
  if (header[5] !== 0x00) {
    throw new Error(`non-zero flags byte: 0x${header[5]!.toString(16)}`);
  }
}

export function validateTrailerBytes(trailer: Buffer): void {
  if (trailer.subarray(8, 12).compare(MAGIC_BYTES) !== 0) {
    throw new Error("invalid trailer magic (expected 'KAHN')");
  }
}

export function parseRootOffset(trailer: Buffer, sourceSize: number): number {
  const big = trailer.readBigUInt64LE(0);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`root offset exceeds safe integer: ${big}`);
  }
  const off = Number(big);
  if (off < HEADER_SIZE || off >= sourceSize - TRAILER_SIZE) {
    throw new Error(`root offset out of body range: ${off}`);
  }
  return off;
}

/**
 * Distinguishable from generic decode errors so `tryParseNodeHeader` can request
 * more bytes on truncation without conflating that with an overlong-varuint
 * violation, which is fatal regardless of how many more bytes we read.
 */
export class VarUIntTruncatedError extends Error {
  constructor() {
    super("varuint truncated");
  }
}

export function readVarUInt(buf: Buffer, pos: number): { value: number; bytes: number } {
  let result = 0n;
  let shift = 0n;
  let i = 0;
  while (i < 10) {
    if (pos + i >= buf.length) throw new VarUIntTruncatedError();
    const byte = buf[pos + i]!;
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    i++;
    if ((byte & 0x80) === 0) {
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`varuint exceeds safe integer: ${result}`);
      }
      return { value: Number(result), bytes: i };
    }
  }
  throw new Error("varuint exceeds 10 bytes (overlong)");
}

export function readUintW(buf: Buffer, pos: number, w: OffsetWidth): number {
  switch (w) {
    case 1:
      return buf.readUInt8(pos);
    case 2:
      return buf.readUInt16LE(pos);
    case 4:
      return buf.readUInt32LE(pos);
    case 8: {
      const big = buf.readBigUInt64LE(pos);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`offset exceeds safe integer: ${big}`);
      }
      return Number(big);
    }
  }
}

export function safeIntFromBig(big: bigint): number | bigint {
  if (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(big);
  }
  return big;
}

export function tryParseNodeHeader(chunk: Buffer, offset: number): ParseResult {
  const code = chunk[0]!;

  if (code === T_NULL) return { ok: true, header: { kind: "null" } };
  if (code === T_FALSE) return { ok: true, header: { kind: "boolean", value: false } };
  if (code === T_TRUE) return { ok: true, header: { kind: "boolean", value: true } };
  if (code >= T_TINY_NEG_INT_MIN && code <= T_TINY_NEG_INT_MAX) {
    // Spec §4: TinyNegInt value = 0x02 − code, giving −1..−16 for codes 0x03..0x12.
    return { ok: true, header: { kind: "number", value: 0x02 - code } };
  }
  if (code >= T_TINY_UINT_MIN && code <= T_TINY_UINT_MAX) {
    return { ok: true, header: { kind: "number", value: code - T_TINY_UINT_MIN } };
  }
  if (code === T_EMPTY_ARRAY) {
    return {
      ok: true,
      header: { kind: "array", isLeaf: true, width: 1, length: 0, entriesOffset: offset + 1, nodeOffset: offset },
    };
  }
  if (code === T_EMPTY_OBJECT) {
    return {
      ok: true,
      header: { kind: "object", isLeaf: true, width: 1, length: 0, entriesOffset: offset + 1, nodeOffset: offset },
    };
  }

  if (code === T_UINT8) return { ok: true, header: { kind: "number", value: chunk.readUInt8(1) } };
  if (code === T_UINT16) return { ok: true, header: { kind: "number", value: chunk.readUInt16LE(1) } };
  if (code === T_UINT32) return { ok: true, header: { kind: "number", value: chunk.readUInt32LE(1) } };
  if (code === T_UINT64) {
    const v = safeIntFromBig(chunk.readBigUInt64LE(1));
    return {
      ok: true,
      header: typeof v === "number" ? { kind: "number", value: v } : { kind: "bigint", value: v },
    };
  }
  if (code === T_INT8) return { ok: true, header: { kind: "number", value: chunk.readInt8(1) } };
  if (code === T_INT16) return { ok: true, header: { kind: "number", value: chunk.readInt16LE(1) } };
  if (code === T_INT32) return { ok: true, header: { kind: "number", value: chunk.readInt32LE(1) } };
  if (code === T_INT64) {
    const v = safeIntFromBig(chunk.readBigInt64LE(1));
    return {
      ok: true,
      header: typeof v === "number" ? { kind: "number", value: v } : { kind: "bigint", value: v },
    };
  }
  if (code === T_FLOAT32) return { ok: true, header: { kind: "number", value: chunk.readFloatLE(1) } };
  if (code === T_FLOAT64) return { ok: true, header: { kind: "number", value: chunk.readDoubleLE(1) } };

  if (code >= T_TINY_STRING_MIN && code <= T_TINY_STRING_MAX) {
    const len = code - T_TINY_STRING_MIN + 1;
    if (chunk.length < 1 + len) return { ok: false, neededLen: 1 + len };
    return {
      ok: true,
      header: {
        kind: "string",
        value: TEXT_DECODER.decode(chunk.subarray(1, 1 + len)),
        byteLength: len,
      },
    };
  }
  if (code === T_STRING) {
    let lb: number;
    let len: number;
    try {
      const r = readVarUInt(chunk, 1);
      lb = r.bytes;
      len = r.value;
    } catch (err) {
      // Truncation can be retried with a larger window; an overlong varuint cannot.
      if (err instanceof VarUIntTruncatedError) {
        return { ok: false, neededLen: Math.min(11, chunk.length + 10) };
      }
      throw err;
    }
    if (chunk.length < 1 + lb + len) return { ok: false, neededLen: 1 + lb + len };
    return {
      ok: true,
      header: {
        kind: "string",
        value: TEXT_DECODER.decode(chunk.subarray(1 + lb, 1 + lb + len)),
        byteLength: len,
      },
    };
  }

  if (code >= T_ARRAY_LEAF_MIN && code <= T_ARRAY_LEAF_MAX) {
    const width = widthFromCode(code);
    const { value: n, bytes: nb } = readVarUInt(chunk, 1);
    return {
      ok: true,
      header: {
        kind: "array",
        isLeaf: true,
        width,
        length: n,
        entriesOffset: offset + 1 + nb,
        nodeOffset: offset,
      },
    };
  }
  if (code >= T_ARRAY_INTERNAL_MIN && code <= T_ARRAY_INTERNAL_MAX) {
    const width = widthFromCode(code);
    const { value: total, bytes: tb } = readVarUInt(chunk, 1);
    const { value: m, bytes: mb } = readVarUInt(chunk, 1 + tb);
    if (m < 2) {
      // §8 invariant 3: a single-node container must be stored as a leaf.
      throw new Error(`array internal node has m=${m} (<2) at offset ${offset}`);
    }
    return {
      ok: true,
      header: {
        kind: "array",
        isLeaf: false,
        width,
        length: total,
        childCount: m,
        entriesOffset: offset + 1 + tb + mb,
        nodeOffset: offset,
      },
    };
  }
  if (code >= T_OBJECT_LEAF_MIN && code <= T_OBJECT_LEAF_MAX) {
    const width = widthFromCode(code);
    const { value: n, bytes: nb } = readVarUInt(chunk, 1);
    return {
      ok: true,
      header: {
        kind: "object",
        isLeaf: true,
        width,
        length: n,
        entriesOffset: offset + 1 + nb,
        nodeOffset: offset,
      },
    };
  }
  if (code >= T_OBJECT_INTERNAL_MIN && code <= T_OBJECT_INTERNAL_MAX) {
    const width = widthFromCode(code);
    const { value: total, bytes: tb } = readVarUInt(chunk, 1);
    const { value: m, bytes: mb } = readVarUInt(chunk, 1 + tb);
    if (m < 2) {
      throw new Error(`object internal node has m=${m} (<2) at offset ${offset}`);
    }
    return {
      ok: true,
      header: {
        kind: "object",
        isLeaf: false,
        width,
        length: total,
        childCount: m,
        entriesOffset: offset + 1 + tb + mb,
        nodeOffset: offset,
      },
    };
  }

  // Spec §4: 0xC0..0xFF are extension codes - readers SHOULD treat them as
  // opaque using the varuint length prefix to skip the payload.
  if (code >= 0xc0) {
    return { ok: true, header: { kind: "extension" } };
  }

  // Reserved gaps (0x35..0x3F, 0x48..0x4F, 0x52..0x5F, 0x88..0xBF) and any
  // unrecognized code: §11.1 requires rejection.
  throw new Error(`unknown type code 0x${code.toString(16)} at offset ${offset}`);
}

/**
 * Inspect the type byte of a node and return everything needed to compare
 * the stored UTF-8 string against a target without materializing it.
 */
export function parseStringPrelude(
  chunk: Buffer,
  offset: number,
): { dataStart: number; len: number } {
  const code = chunk[0]!;
  if (code >= T_TINY_STRING_MIN && code <= T_TINY_STRING_MAX) {
    return { dataStart: 1, len: code - T_TINY_STRING_MIN + 1 };
  }
  if (code === T_STRING) {
    const { value: len, bytes: lb } = readVarUInt(chunk, 1);
    return { dataStart: 1 + lb, len };
  }
  throw new Error(`expected string at offset ${offset}, got 0x${code.toString(16)}`);
}

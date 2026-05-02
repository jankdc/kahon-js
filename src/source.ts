import * as fsp from "node:fs/promises";

/**
 * Asynchronous random-access byte source. Implementers are responsible for
 * managing their own resources.
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/**
 * Adapts a Buffer to the byte-source interface. Useful for tests and for
 * feeding already-in-memory bytes to the reader.
 */
export class BufferSource implements ByteSource {
  constructor(private readonly buffer: Buffer) {}

  get size(): number {
    return this.buffer.length;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || length < 0 || offset + length > this.buffer.length) {
      throw new RangeError(
        `read out of bounds: offset=${offset} length=${length} size=${this.buffer.length}`,
      );
    }
    return this.buffer.subarray(offset, offset + length);
  }
}

/**
 * File-backed source using `fs.promises` random-access reads. Memory usage
 * is independent of file size - only the bytes touched during navigation
 * are read off disk. Holds an OS file handle, so use `await using` (or call
 * `close()` explicitly) to release it.
 */
export class FileSource implements ByteSource {
  readonly size: number;
  private closed = false;

  private constructor(
    private readonly handle: fsp.FileHandle,
    size: number,
  ) {
    this.size = size;
  }

  static async open(path: string): Promise<FileSource> {
    const handle = await fsp.open(path, "r");
    try {
      const stat = await handle.stat();
      return new FileSource(handle, stat.size);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (this.closed) throw new Error("source is closed");
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(
        `read out of bounds: offset=${offset} length=${length} size=${this.size}`,
      );
    }
    const buf = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      const { bytesRead } = await this.handle.read(buf, total, length - total, offset + total);
      if (bytesRead === 0) {
        throw new Error(`unexpected EOF at offset ${offset + total}`);
      }
      total += bytesRead;
    }
    return buf;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

export interface CachedByteSourceOptions {
  /** Soft byte budget for the chunk LRU. 0 disables caching (pass-through). */
  cacheBytes: number;
  /** Target chunk size in bytes; rounded up to the nearest `pageBytes` multiple. */
  chunkBytes: number;
  /** Page-alignment unit for chunk boundaries. Defaults to 16384. */
  pageBytes?: number;
}

/**
 * Wraps a `ByteSource` with page-aligned, LRU-cached chunked reads. Reads
 * strictly larger than one chunk bypass the cache (so a one-shot scan of a
 * giant container can't evict every other chunk). Reads that fit within a
 * chunk are served from cache; reads that straddle two chunks copy out.
 */
export class CachedByteSource implements ByteSource {
  readonly size: number;
  private readonly chunk: number;
  private readonly budget: number;
  private used = 0;
  /** Map preserves insertion order; we delete+set on hit to bump to MRU. */
  private readonly lru = new Map<number, Buffer>();

  constructor(
    private readonly inner: ByteSource,
    opts: CachedByteSourceOptions,
  ) {
    const page = opts.pageBytes ?? 16384;
    if (page <= 0) throw new RangeError("pageBytes must be positive");
    this.chunk = Math.max(page, Math.ceil(Math.max(1, opts.chunkBytes) / page) * page);
    this.budget = Math.max(0, opts.cacheBytes);
    this.size = inner.size;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    if (this.budget === 0 || length === 0) return this.inner.read(offset, length);
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(
        `read out of bounds: offset=${offset} length=${length} size=${this.size}`,
      );
    }
    if (length > this.chunk) return this.inner.read(offset, length);

    const firstIdx = Math.floor(offset / this.chunk);
    const lastIdx = Math.floor((offset + length - 1) / this.chunk);

    if (firstIdx === lastIdx) {
      const buf = await this.getChunk(firstIdx);
      const start = offset - firstIdx * this.chunk;
      return buf.subarray(start, start + length);
    }

    const out = Buffer.allocUnsafe(length);
    let written = 0;
    for (let i = firstIdx; i <= lastIdx; i++) {
      const buf = await this.getChunk(i);
      const chunkStart = i * this.chunk;
      const sliceStart = Math.max(0, offset - chunkStart);
      const sliceEnd = Math.min(buf.length, offset + length - chunkStart);
      buf.copy(out, written, sliceStart, sliceEnd);
      written += sliceEnd - sliceStart;
    }
    return out;
  }

  private async getChunk(idx: number): Promise<Buffer> {
    const hit = this.lru.get(idx);
    if (hit) {
      this.lru.delete(idx);
      this.lru.set(idx, hit);
      return hit;
    }
    const start = idx * this.chunk;
    const len = Math.min(this.chunk, this.size - start);
    const buf = await this.inner.read(start, len);
    this.lru.set(idx, buf);
    this.used += buf.length;
    while (this.used > this.budget && this.lru.size > 1) {
      const first = this.lru.keys().next();
      if (first.done) break;
      const k = first.value;
      const v = this.lru.get(k)!;
      this.lru.delete(k);
      this.used -= v.length;
    }
    return buf;
  }
}

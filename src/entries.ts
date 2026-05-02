import type { ByteSource } from "./source.js";

/**
 * Random-access view over a fixed-size entry table inside a `ByteSource`.
 *
 * Behavior depends on `eagerThreshold`:
 *  - If the table fits (`count * entrySize <= eagerThreshold`), the first
 *    access materializes the whole table once and subsequent `entry(i)` calls
 *    are zero-copy subarrays.
 *  - Otherwise, `entry(i)` reads only that entry; `iter()` reads in
 *    `windowBytes`-sized batches and discards each batch as it advances.
 *
 * This bounds peak memory at O(min(table, eagerThreshold)) for the eager path,
 * O(windowBytes) for streaming, and O(entrySize) for sparse random access.
 */
export class EntryTable {
  private eager?: Buffer;
  private readonly windowEntries: number;

  constructor(
    private readonly source: ByteSource,
    private readonly base: number,
    readonly count: number,
    readonly entrySize: number,
    private readonly eagerThreshold: number,
    windowBytes: number,
  ) {
    if (entrySize <= 0) throw new RangeError("entrySize must be positive");
    this.windowEntries = Math.max(1, Math.floor(windowBytes / entrySize));
  }

  get totalBytes(): number {
    return this.count * this.entrySize;
  }

  private get fitsEager(): boolean {
    return this.totalBytes <= this.eagerThreshold;
  }

  async entry(i: number): Promise<Buffer> {
    if (i < 0 || i >= this.count) throw new RangeError(`entry index ${i} out of range`);
    if (this.eager) {
      const start = i * this.entrySize;
      return this.eager.subarray(start, start + this.entrySize);
    }
    if (this.fitsEager) {
      this.eager = await this.source.read(this.base, this.totalBytes);
      const start = i * this.entrySize;
      return this.eager.subarray(start, start + this.entrySize);
    }
    return this.source.read(this.base + i * this.entrySize, this.entrySize);
  }

  /**
   * Sequential iteration. Yields `Buffer` slices of length `entrySize`. The
   * yielded slice is only valid until the next `next()` call when streaming
   * (it aliases the current window); copy if you need to retain it.
   */
  async *iter(): AsyncIterableIterator<Buffer> {
    if (this.count === 0) return;
    if (this.eager || this.fitsEager) {
      if (!this.eager) this.eager = await this.source.read(this.base, this.totalBytes);
      for (let i = 0; i < this.count; i++) {
        const start = i * this.entrySize;
        yield this.eager.subarray(start, start + this.entrySize);
      }
      return;
    }
    const step = this.windowEntries;
    for (let i = 0; i < this.count; i += step) {
      const n = Math.min(step, this.count - i);
      const win = await this.source.read(this.base + i * this.entrySize, n * this.entrySize);
      for (let j = 0; j < n; j++) {
        const start = j * this.entrySize;
        yield win.subarray(start, start + this.entrySize);
      }
    }
  }
}

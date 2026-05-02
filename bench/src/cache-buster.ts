// macOS userspace cold-cache: there's no portable equivalent of `purge` for
// non-root users, but the OS page cache is finite, so reading a file larger
// than free RAM forces eviction of older pages - including those of our
// fixture. We pre-create a buster file once and reuse it.
//
// Sizing: we want buster_size > free_ram_at_startup, but capped to avoid
// writing tens of GB to a small SSD. We size at min(free_ram + 2 GiB, 12 GiB)
// by default, which is enough on a 16 GiB machine. Override with
// KAHON_BUSTER_BYTES.
//
// This is approximate. macOS does compressed memory and dynamic page-cache
// sizing, so a single buster pass doesn't guarantee 100% eviction of every
// fixture page. For sweep-level signal it's good enough; for absolute numbers
// you'd want repeated busts and/or `sudo purge`.

import { execSync } from "node:child_process";
import { createReadStream, statSync, openSync, closeSync, writeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = "/tmp/kahon-buster.bin";
const TWO_GIB = 2 * 1024 ** 3;
const TWELVE_GIB = 12 * 1024 ** 3;

function freeRamBytesDarwin(): number {
  // vm_stat reports page counts; multiply by page size. "Free", "Inactive",
  // and "Speculative" pages are all candidates for reclamation under memory
  // pressure, so we treat them all as "available".
  const out = execSync("vm_stat").toString();
  const pageSize = (() => {
    const m = out.match(/page size of (\d+) bytes/);
    return m ? Number(m[1]) : 16384;
  })();
  const grab = (label: string): number => {
    const re = new RegExp(`Pages ${label}:\\s+(\\d+)`);
    const m = out.match(re);
    return m ? Number(m[1]) : 0;
  };
  const pages = grab("free") + grab("inactive") + grab("speculative");
  return pages * pageSize;
}

export function chooseBusterSize(): number {
  const env = process.env.KAHON_BUSTER_BYTES;
  if (env) return Number(env);
  const free = freeRamBytesDarwin();
  return Math.min(free + TWO_GIB, TWELVE_GIB);
}

export function ensureBusterFile(path = DEFAULT_PATH, size?: number): string {
  const targetSize = size ?? chooseBusterSize();
  let needWrite = true;
  try {
    const st = statSync(path);
    if (st.size >= targetSize) needWrite = false;
  } catch {
    /* missing - create */
  }
  if (!needWrite) return path;

  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "w");
  // Write in 4 MiB chunks of pseudo-random bytes (random to defeat any
  // dedup/compression in the storage stack). Use a cheap LCG so we don't
  // burn time in crypto RNG.
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  let seed = 0x9e3779b1 >>> 0;
  const fill = () => {
    for (let i = 0; i < chunk.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      chunk.writeUInt32LE(seed, i);
    }
  };
  let written = 0;
  while (written < targetSize) {
    fill();
    const toWrite = Math.min(chunk.length, targetSize - written);
    writeSync(fd, chunk, 0, toWrite, written);
    written += toWrite;
  }
  closeSync(fd);
  return path;
}

/** Sequentially read the buster file, discarding bytes. Forces page-cache eviction. */
export async function bust(path = DEFAULT_PATH): Promise<void> {
  ensureBusterFile(path);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
    stream.on("data", () => {
      /* discard */
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
}

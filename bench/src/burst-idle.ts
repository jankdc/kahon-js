// Burst-then-idle test: does RSS fall back toward `sourceCacheBytes` after
// the burst ends and V8 has a chance to GC? Answers whether pinned chunks
// are a real long-term retention issue or just a transient burst artifact.
//
// One fresh process per cache budget (so cells can't contaminate each other's
// RSS). Each child:
//   1. Opens reader (warm pass), settles, samples baseline.
//   2. Bursts SAMPLES gets, sampling RSS on a 5 ms timer for the peak.
//   3. Drops references, runs GC, idles, GCs again, samples post-burst RSS.
//   4. Prints one JSON line.
//
// Parent prints a table.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { FileSource, KahonReader } from "../../src/index.ts";

const SELF = fileURLToPath(import.meta.url);
const FILE = process.argv[2] ?? "/tmp/big-1M.kahon";
const TOTAL_KEYS = Number(process.argv[3] ?? 1_000_000);
const SAMPLES = Number(process.argv[4] ?? 256);

interface Cell {
  baseline: number;
  peak: number;
  post: number;
}

function sampleKeys(total: number, n: number): string[] {
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const idx = (Math.imul(i, 0x9e3779b1) >>> 8) % total;
    out[i] = "/key_" + String(idx).padStart(8, "0");
  }
  return out;
}

// ---- Child mode --------------------------------------------------------

async function child() {
  const cacheBytes = Number(process.argv[5]);
  if (typeof globalThis.gc !== "function") {
    console.error("error: child must be spawned with --expose-gc");
    process.exit(2);
  }
  const gc = globalThis.gc as () => void;
  const settle = async () => {
    gc();
    await sleep(50);
    gc();
    await sleep(50);
    return process.memoryUsage.rss();
  };

  const src = await FileSource.open(FILE);
  const reader = await KahonReader.fromSource(src, {
    sourceCacheBytes: cacheBytes,
  });

  // Warm pass to JIT and prime the cache.
  for (let i = 0; i < 64; i++) {
    await reader.get("/key_" + String(i).padStart(8, "0"));
  }
  const baseline = await settle();

  let peak = process.memoryUsage.rss();
  let measuring = true;
  const sampler = setInterval(() => {
    if (!measuring) return;
    const r = process.memoryUsage.rss();
    if (r > peak) peak = r;
  }, 5);
  sampler.unref?.();

  const keys = sampleKeys(TOTAL_KEYS, SAMPLES);
  for (const k of keys) await reader.get(k);
  measuring = false;
  clearInterval(sampler);

  await sleep(200);
  const post = await settle();

  await src.close();
  const out: Cell = { baseline, peak, post };
  process.stdout.write(JSON.stringify(out) + "\n");
}

// ---- Parent mode -------------------------------------------------------

function runChild(cacheBytes: number): Promise<Cell> {
  return new Promise((res, rej) => {
    const c = spawn(
      "node",
      ["--expose-gc", "--import", "tsx", SELF, FILE, String(TOTAL_KEYS), String(SAMPLES), "--child", String(cacheBytes)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let buf = "";
    c.stdout.on("data", (d) => (buf += d));
    c.on("close", (code) => {
      try {
        const last = buf.trim().split("\n").at(-1) ?? "";
        res(JSON.parse(last));
      } catch (e) {
        rej(new Error(`exit=${code} parse=${e} :: ${buf}`));
      }
    });
  });
}

async function parent() {
  console.log(`fixture: ${FILE}, samples: ${SAMPLES} (each cell in fresh process)`);
  console.log("-".repeat(110));
  const cells: Array<[number, string]> = [
    [0, "cache=0"],
    [1 * 1024 * 1024, "cache=1MiB"],
    [4 * 1024 * 1024, "cache=4MiB"],
    [16 * 1024 * 1024, "cache=16MiB"],
  ];
  const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
  for (const [bytes, label] of cells) {
    const r = await runChild(bytes);
    const budget = bytes === 0 ? "-" : mb(bytes);
    const peakDelta = mb(r.peak - r.baseline);
    const postDelta = mb(r.post - r.baseline);
    console.log(
      `${label.padEnd(14)}  budget=${budget.padStart(7)}  baseline=${mb(r.baseline).padStart(7)}  peak=${mb(r.peak).padStart(7)} (+${peakDelta.padStart(6)})  post=${mb(r.post).padStart(7)} (+${postDelta.padStart(6)})`,
    );
  }
}

const isChild = process.argv.includes("--child");
const main = isChild ? child : parent;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

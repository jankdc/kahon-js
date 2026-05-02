// Orchestrator for the narrower-slice sweep:
//   one shape (big-object), op = `get`, mode = cold + hot, knobs = 4D grid.
//
// Each cell is measured in a fresh node process via runner.ts so JIT, RSS,
// and the KahonReader's internal LRU are reset between cells.
//
// Usage:
//   tsx bench/src/sweep.ts \
//     --file /tmp/big.kahon \
//     --keys 1000000 \
//     --samples 256 \
//     [--out bench/results/sweep-<ts>.csv] \
//     [--no-cold]    # skip cold runs (faster smoke pass)
//     [--no-hot]
//
// The grid is hardcoded below (small intentional set; tweak in source).

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bust, ensureBusterFile } from "./cache-buster.ts";

interface CellResult {
  ok: true;
  mode: "cold" | "hot";
  ops: number;
  totalNs: number;
  perOpNsMedian: number;
  perOpNsP95: number;
  rssPeakBytes: number;
  rssStartBytes: number;
  hitCount: number;
}

interface CellError {
  ok: false;
  error: string;
}

interface Knobs {
  eagerEntriesThreshold: number;
  readChunkBytes: number;
  sourceCacheBytes: number;
  validateLeafKeys: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "runner.ts");

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string): string | undefined => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const has = (k: string) => args.includes(k);

  const file = get("--file");
  if (!file) throw new Error("--file is required");
  const keysTotal = Number(get("--keys"));
  if (!Number.isFinite(keysTotal)) throw new Error("--keys is required");
  const samples = Number(get("--samples", "256"));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = get(
    "--out",
    resolve(HERE, "..", "results", `sweep-${ts}.csv`),
  )!;
  return {
    file,
    keysTotal,
    samples,
    out,
    runCold: !has("--no-cold"),
    runHot: !has("--no-hot"),
  };
}

function sampleKeys(total: number, n: number): string[] {
  // Knuth-multiplicative spread, same approach as kahon-rs bench so we know
  // every sampled key exists.
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const idx =
      (Math.imul(i, 0x9e3779b1) >>> 8) % total;
    out[i] = "key_" + String(idx).padStart(8, "0");
  }
  return out;
}

function runCell(
  file: string,
  mode: "cold" | "hot",
  keys: string[],
  knobs: Knobs,
): Promise<CellResult | CellError> {
  const cfg = {
    file,
    mode,
    keys,
    warmup: mode === "hot" ? Math.min(64, keys.length) : 0,
    knobs,
    rssSampleMs: 5,
  };
  return new Promise((resolveP) => {
    const child = spawn("node", ["--import", "tsx", RUNNER, JSON.stringify(cfg)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (chunk) => (buf += chunk.toString()));
    child.on("error", (e) => resolveP({ ok: false, error: String(e) }));
    child.on("close", (code) => {
      if (code !== 0 && !buf) {
        resolveP({ ok: false, error: `exit ${code}` });
        return;
      }
      const lastLine = buf.trim().split("\n").at(-1) ?? "";
      try {
        resolveP(JSON.parse(lastLine));
      } catch (e) {
        resolveP({ ok: false, error: `parse: ${e} :: ${lastLine}` });
      }
    });
  });
}

const GRID: Knobs[] = (() => {
  const thresholds = [4 * 1024, 64 * 1024, Number.POSITIVE_INFINITY];
  const chunks = [16 * 1024, 64 * 1024, 256 * 1024];
  const caches = [0, 1 * 1024 * 1024, 16 * 1024 * 1024];
  const validate = [true, false];
  const out: Knobs[] = [];
  for (const t of thresholds)
    for (const c of chunks)
      for (const sc of caches)
        for (const v of validate)
          out.push({
            eagerEntriesThreshold: t,
            readChunkBytes: c,
            sourceCacheBytes: sc,
            validateLeafKeys: v,
          });
  return out;
})();

function csvHeader(): string {
  return [
    "cell",
    "mode",
    "eagerEntriesThreshold",
    "readChunkBytes",
    "sourceCacheBytes",
    "validateLeafKeys",
    "ops",
    "totalNs",
    "perOpNsMedian",
    "perOpNsP95",
    "rssPeakBytes",
    "rssStartBytes",
    "hitCount",
    "error",
  ].join(",") + "\n";
}

function csvRow(
  cell: number,
  mode: string,
  k: Knobs,
  r: CellResult | CellError,
): string {
  const enc = (n: number) => (Number.isFinite(n) ? String(n) : "inf");
  const fields = [
    cell,
    mode,
    enc(k.eagerEntriesThreshold),
    enc(k.readChunkBytes),
    enc(k.sourceCacheBytes),
    String(k.validateLeafKeys),
  ];
  if (r.ok) {
    fields.push(
      r.ops,
      r.totalNs,
      r.perOpNsMedian,
      r.perOpNsP95,
      r.rssPeakBytes,
      r.rssStartBytes,
      r.hitCount,
      "",
    );
  } else {
    fields.push("", "", "", "", "", "", "", JSON.stringify(r.error));
  }
  return fields.join(",") + "\n";
}

async function main() {
  const a = parseArgs();
  if (!existsSync(a.file)) throw new Error(`fixture not found: ${a.file}`);

  mkdirSync(dirname(a.out), { recursive: true });
  writeFileSync(a.out, csvHeader());

  if (a.runCold) {
    process.stderr.write("ensuring cache-buster file (one-time setup)…\n");
    ensureBusterFile();
  }

  const keys = sampleKeys(a.keysTotal, a.samples);
  const total = GRID.length * Number(a.runCold) + GRID.length * Number(a.runHot);
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < GRID.length; i++) {
    const k = GRID[i];
    if (a.runCold) {
      await bust();
      const r = await runCell(a.file, "cold", keys, k);
      appendFileSync(a.out, csvRow(i, "cold", k, r));
      done++;
      process.stderr.write(progress(done, total, t0, i, k, "cold", r));
    }
    if (a.runHot) {
      const r = await runCell(a.file, "hot", keys, k);
      appendFileSync(a.out, csvRow(i, "hot", k, r));
      done++;
      process.stderr.write(progress(done, total, t0, i, k, "hot", r));
    }
  }
  process.stderr.write(`\nresults: ${a.out}\n`);
}

function progress(
  done: number,
  total: number,
  t0: number,
  cell: number,
  k: Knobs,
  mode: string,
  r: CellResult | CellError,
): string {
  const pct = ((done / total) * 100).toFixed(1);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(0);
  const tag = r.ok
    ? `med=${(r.perOpNsMedian / 1000).toFixed(1)}µs rss=${(r.rssPeakBytes / 1024 / 1024).toFixed(0)}MB`
    : `ERR ${r.error.slice(0, 60)}`;
  const knobs = `t=${fmt(k.eagerEntriesThreshold)} c=${fmt(k.readChunkBytes)} sc=${fmt(k.sourceCacheBytes)} v=${k.validateLeafKeys ? 1 : 0}`;
  return `[${pct}% ${elapsedS}s] cell ${cell} ${mode} ${knobs} ${tag}\n`;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "inf";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + "M";
  if (n >= 1024) return (n / 1024).toFixed(0) + "K";
  return String(n);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

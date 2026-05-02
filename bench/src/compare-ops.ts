// Focused comparison: full decode vs selective get, at default knobs, on a
// single fixture. Reports cold and hot for each, plus the break-even N
// (lookups above which decode-once is cheaper than N selective gets).

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bust, ensureBusterFile } from "./cache-buster.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "runner.ts");

interface OkResult {
  ok: true;
  totalNs: number;
  perOpNsMedian: number;
  perOpNsP95: number;
  rssPeakBytes: number;
  rssStartBytes: number;
  ops: number;
}

function runOnce(cfg: object): Promise<OkResult> {
  return new Promise((res, rej) => {
    const child = spawn("node", ["--import", "tsx", RUNNER, JSON.stringify(cfg)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (c) => (buf += c));
    child.on("close", (code) => {
      const last = buf.trim().split("\n").at(-1) ?? "";
      try {
        const r = JSON.parse(last);
        if (!r.ok) rej(new Error(r.error));
        else res(r);
      } catch (e) {
        rej(new Error(`parse: ${e} :: ${last} (exit ${code})`));
      }
    });
  });
}

function sampleKeys(total: number, n: number): string[] {
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const idx = (Math.imul(i, 0x9e3779b1) >>> 8) % total;
    out[i] = "key_" + String(idx).padStart(8, "0");
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string, d?: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const file = get("--file");
  const totalKeys = Number(get("--keys"));
  if (!file || !Number.isFinite(totalKeys)) {
    console.error("usage: compare-ops --file PATH --keys N [--samples 256]");
    process.exit(2);
  }
  const samples = Number(get("--samples", "256"));
  const keys = sampleKeys(totalKeys, samples);

  const knobs = {}; // defaults
  const base = { file, knobs, rssSampleMs: 5 };

  console.error("ensuring cache-buster file…");
  ensureBusterFile();

  const cells = [
    // file-backed (with OS page cache)
    { label: "get   file   cold", op: "get", mode: "cold", source: "file", keys, warmup: 0 },
    { label: "get   file   hot ", op: "get", mode: "hot", source: "file", keys, warmup: 64 },
    { label: "decode file   cold", op: "decode", mode: "cold", source: "file", keys: keys.slice(0, 1), warmup: 0 },
    { label: "decode file   hot ", op: "decode", mode: "hot", source: "file", keys: keys.slice(0, 1), warmup: 1 },
    // in-memory bytes (LRU bypassed)
    { label: "get   buf    hot ", op: "get", mode: "hot", source: "buffer", keys, warmup: 64 },
    { label: "decode buf    hot ", op: "decode", mode: "hot", source: "buffer", keys: keys.slice(0, 1), warmup: 1 },
  ];

  console.log(
    `${"cell".padEnd(13)}  ${"total".padStart(10)}  ${"per_op_med".padStart(11)}  ${"p95".padStart(10)}  ${"rss_peak".padStart(10)}  ${"rss_delta".padStart(10)}`,
  );
  console.log("-".repeat(75));

  for (const c of cells) {
    if (c.mode === "cold") await bust();
    const r = await runOnce({ ...base, ...c });
    const fmtNs = (n: number) => {
      if (n < 1000) return `${n} ns`;
      if (n < 1_000_000) return `${(n / 1000).toFixed(1)} µs`;
      if (n < 1_000_000_000) return `${(n / 1e6).toFixed(1)} ms`;
      return `${(n / 1e9).toFixed(2)} s`;
    };
    const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
    console.log(
      `${c.label.padEnd(13)}  ${fmtNs(r.totalNs).padStart(10)}  ${fmtNs(r.perOpNsMedian).padStart(11)}  ${fmtNs(r.perOpNsP95).padStart(10)}  ${mb(r.rssPeakBytes).padStart(10)}  ${mb(r.rssPeakBytes - r.rssStartBytes).padStart(10)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

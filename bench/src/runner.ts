// Single-cell measurement runner. Spawned per cell by sweep.ts.
//
// Reads a JSON config from process.argv[2], opens a KahonReader, runs N
// `get` ops (sampled key set passed in), and prints one JSON line on stdout
// with timing + RSS data. Every measurement is a fresh process so caches and
// JIT state don't leak across cells.
//
// Mode semantics:
//   "cold" - assumes the orchestrator already busted the OS page cache before
//            spawning us. We perform the ops and report.
//   "hot"  - perform a warmup pass (W ops, discarded), then a measurement
//            pass (M ops). Reports the measurement pass only.
//
// We sample RSS on a setInterval timer and report the peak observed during
// the measurement pass.

import { readFileSync } from "node:fs";
import { KahonReader, type KahonReaderOptions } from "../../src/index.ts";

type SourceKind = "file" | "buffer";

interface Config {
  file: string;
  mode: "cold" | "hot";
  op?: "get" | "decode"; // default "get"
  source?: SourceKind; // default "file"
  keys: string[]; // ignored when op === "decode"
  warmup: number;
  knobs: KahonReaderOptions;
  rssSampleMs: number;
}

interface Result {
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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function main() {
  const cfg: Config = JSON.parse(process.argv[2]);

  const rssStart = process.memoryUsage.rss();
  let rssPeak = rssStart;
  // Sample timer is started but its observations only count during the
  // measurement window (gated by `measuring`).
  let measuring = false;
  const sampler = setInterval(() => {
    if (!measuring) return;
    const r = process.memoryUsage.rss();
    if (r > rssPeak) rssPeak = r;
  }, cfg.rssSampleMs);
  // Don't let the sampler keep the event loop alive past op completion.
  sampler.unref?.();

  const source = cfg.source ?? "file";
  // For buffer source, slurp the file into RAM up front. The slurp itself
  // benefits from the OS page cache; but every subsequent read on the reader
  // is in-process memory regardless of cold/hot.
  let reader: KahonReader;
  if (source === "file") {
    reader = await KahonReader.fromFile(cfg.file, cfg.knobs);
  } else {
    const buf = readFileSync(cfg.file);
    reader = await KahonReader.fromBuffer(buf, cfg.knobs);
  }
  const op = cfg.op ?? "get";

  // Warmup pass for hot mode. Discarded. For decode we don't warm with a full
  // decode (would dominate) - a single get probe is enough to JIT the I/O path.
  if (cfg.mode === "hot" && cfg.warmup > 0) {
    if (op === "get") {
      for (let i = 0; i < cfg.warmup; i++) {
        const k = cfg.keys[i % cfg.keys.length];
        await reader.get("/" + k);
      }
    } else {
      const k = cfg.keys[0] ?? "key_00000000";
      await reader.get("/" + k);
    }
  }

  rssPeak = process.memoryUsage.rss();
  measuring = true;

  let totalNs: number;
  let perOp: number[];
  let hits = 0;

  if (op === "get") {
    perOp = new Array(cfg.keys.length);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < cfg.keys.length; i++) {
      const k = cfg.keys[i];
      const start = process.hrtime.bigint();
      const v = await reader.get("/" + k);
      perOp[i] = Number(process.hrtime.bigint() - start);
      if (v !== undefined) hits++;
    }
    totalNs = Number(process.hrtime.bigint() - t0);
  } else {
    const t0 = process.hrtime.bigint();
    const v = await reader.decode();
    totalNs = Number(process.hrtime.bigint() - t0);
    perOp = [totalNs];
    if (v !== undefined && v !== null) hits = 1;
  }
  measuring = false;

  await reader.close();
  clearInterval(sampler);

  perOp.sort((a, b) => a - b);
  const result: Result = {
    ok: true,
    mode: cfg.mode,
    ops: cfg.keys.length,
    totalNs,
    perOpNsMedian: quantile(perOp, 0.5),
    perOpNsP95: quantile(perOp, 0.95),
    rssPeakBytes: rssPeak,
    rssStartBytes: rssStart,
    hitCount: hits,
  };
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((e) => {
  process.stdout.write(
    JSON.stringify({ ok: false, error: String(e?.stack ?? e) }) + "\n",
  );
  process.exit(1);
});

# Benchmarking

Performance harness for `KahonReader`. One payload shape (big-object), with
three complementary harnesses on top of a shared per-cell runner:

- **sweep**: 4D knob grid (`eagerEntriesThreshold × readChunkBytes ×
  sourceCacheBytes × validateLeafKeys`) over `get`, cold + hot, CSV out.
- **compare-ops**: selective `get` vs full `decode()`, file-backed vs
  in-memory buffer, at default knobs.
- **burst-idle**: does memory fall back toward
  `sourceCacheBytes` after a burst ends and V8 GCs?

Each cell runs in a fresh `node` process so JIT, RSS, and the reader's
internal LRU are reset between cells.

## Layout

```
bench/
  gen/         Rust crate. Streams a big-object .kahon via the kahon-rs Writer.
  src/         Main benchmarking source code.
  results/     CSV output.
```

## Prerequisites

- Rust toolchain (cargo). The generator depends on `kahon-rs` from git.
- Node ≥ 18, with `tsx` (already a devDependency in the parent `package.json`).
- macOS only for the cold-cache path (uses `vm_stat`).

## One-time: build the generator

```sh
cd bench/gen
CARGO_HOME=$(pwd)/.cargo-home cargo build --release
```

The local `CARGO_HOME` keeps the build self-contained inside `bench/`. The
binary lands at `bench/gen/target/release/bench-gen`.

## Generate a fixture

```sh
# 256 MB-ish: 1M keys × 192-byte values + overhead.
bench/gen/target/release/bench-gen \
  --keys 1000000 --value-bytes 192 \
  --out /tmp/big-1M.kahon

# Larger (~4 GB), takes longer:
bench/gen/target/release/bench-gen \
  --keys 4000000 --value-bytes 768 \
  --out /tmp/big-4G.kahon
```

Memory during generation is bounded by the writer's internal node buffering
(small, independent of N).

## Run the sweep

```sh
# Hot-only smoke (fast, ~10s on the 1M fixture):
node --import tsx bench/src/sweep.ts \
  --file /tmp/big-1M.kahon --keys 1000000 --samples 256 --no-cold

# Full cold + hot pass:
node --import tsx bench/src/sweep.ts \
  --file /tmp/big-1M.kahon --keys 1000000 --samples 256
```

Cold runs require a buster file (`/tmp/kahon-buster.bin`), created on first
run. Default size is `min(free_ram + 2 GiB, 12 GiB)`. Override with
`KAHON_BUSTER_BYTES=...`.

## Compare get vs decode

```sh
node --import tsx bench/src/compare-ops.ts \
  --file /tmp/big-1M.kahon --keys 1000000 --samples 256
```

Prints a six-row table: `get` and `decode()` each in cold + hot modes against
the file, plus hot-only rows for an in-memory `fromBuffer` source (the LRU
is bypassed; useful as a floor for selective-read cost).

## Burst / idle RSS retention

```sh
node --expose-gc --import tsx bench/src/burst-idle.ts \
  /tmp/big-1M.kahon 1000000 256
```

For each `sourceCacheBytes` budget (0, 1, 4, 16 MiB) it spawns a fresh
`--expose-gc` child that warms the reader, settles to a baseline RSS, bursts
the sampled `get`s while sampling RSS for the peak, then drops references,
GCs, idles, GCs again, and reports the post-burst RSS. Answers whether
chunks pinned during a burst are released back toward the budget afterwards.

## Output (sweep)

CSV at `bench/results/sweep-<timestamp>.csv` with columns:

```
cell, mode, eagerEntriesThreshold, readChunkBytes, sourceCacheBytes,
validateLeafKeys, ops, totalNs, perOpNsMedian, perOpNsP95,
rssPeakBytes, rssStartBytes, hitCount, error
```

`mode` is `cold` or `hot`. Cold cells are run after a buster pass + fresh
process. Hot cells run W=64 warmup ops then the measurement pass in the same
process.

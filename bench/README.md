# Benchmarking

Performance harness for `KahonReader`. One payload shape (big-object), with
three complementary harnesses on top of a shared per-cell runner:

- **sweep**: 4D grid (`eagerEntriesThreshold × readChunkBytes ×
  sourceCacheBytes × validateLeafKeys`) over `get`, cold + hot, CSV out.
- **burst-idle**: does memory fall back toward
  `sourceCacheBytes` after a burst ends and V8 GCs?
- **compare-ops**: selective `get` vs full `decode()`, file-backed vs
  in-memory buffer, at default knobs.

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

## Quick Usage

```sh
# One-time: build the fixture generator. Local CARGO_HOME keeps the build
cd bench/gen
CARGO_HOME=$(pwd)/.cargo-home cargo build --release
cd ../..

# Generate a fixture. Memory during generation is bounded by the writer's
# internal node buffering (small, independent of N).
#   ~256 MB: 1M keys × 192-byte values.
bench/gen/target/release/bench-gen \
  --keys 1000000 --value-bytes 192 \
  --out /tmp/big-1M.kahon
#   ~4 GB, takes longer:
bench/gen/target/release/bench-gen \
  --keys 4000000 --value-bytes 768 \
  --out /tmp/big-4G.kahon

# Run the 4D sweep over the knob grid. Cold runs need a buster file
# (/tmp/kahon-buster.bin), created on first run; default size is
# min(free_ram + 2 GiB, 12 GiB), override with KAHON_BUSTER_BYTES=...
#   Hot-only smoke (fast, ~10s on the 1M fixture):
node --import tsx bench/src/sweep.ts \
  --file /tmp/big-1M.kahon --keys 1000000 --samples 256 --no-cold
#   Full cold + hot pass:
node --import tsx bench/src/sweep.ts \
  --file /tmp/big-1M.kahon --keys 1000000 --samples 256

# Compare selective `get` vs full `decode()`. Prints a six-row table: each
# op in cold + hot against the file, plus hot-only rows for an in-memory
# fromBuffer source (LRU bypassed; floor for selective-read cost).
node --import tsx bench/src/compare-ops.ts \
  --file /tmp/big-1M.kahon --keys 1000000 --samples 256

# Burst / idle RSS retention. For each sourceCacheBytes budget
# (0, 1, 4, 16 MiB) spawns a fresh --expose-gc child that warms, settles to
# baseline RSS, bursts the gets sampling for peak, then drops refs, GCs,
# idles, GCs again, and reports post-burst RSS. Answers whether chunks
# pinned during a burst are released back toward the budget afterwards.
node --expose-gc --import tsx bench/src/burst-idle.ts \
  /tmp/big-1M.kahon 1000000 256
```

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

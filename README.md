# Kahon for JS

A TypeScript/JavaScript reader for the [Kahon binary format](https://github.com/jankdc/kahon).

## Quick start

```bash
npm install kahon
```

```ts
import { BufferSource, FileSource, KahonReader } from "kahon";

await using src = await FileSource.open("./data.kahon");
const r = await KahonReader.fromSource(src);
// JSON Pointer Syntax
await r.get("/users/0/name");
// Iterate children of the root (works for arrays and objects).
for await (const c of await r.root()) {
  await c.get("name");        // descend into an object child
  await c.at(0);              // descend into an array child
  await c.decode();           // materialize this subtree as a plain JS value
}

// In-memory, mostly for testing. BufferSource has no resources to release.
const r2 = await KahonReader.fromSource(new BufferSource(buf));
await r2.get("/users/0/name");
```

The reader can open files much larger than RAM. It only loads the bytes it
needs to answer the lookups you make.

## Reader Options

Pass options as the second argument to `fromSource`:

```ts
await KahonReader.fromSource(src, {
  eagerEntriesThreshold: 64 * 1024,
  readChunkBytes:        16 * 1024,
  sourceCacheBytes:       4 * 1024 * 1024,
  validateLeafKeys:      true,
  maxContainerEntries:   Infinity,
});
```

The defaults are tuned for a balance of speed and memory on mid-sized data.
Reach for these knobs when you have a specific bottleneck:

| Option | Description | Lower | Higher | Notes |
| --- | --- | --- | --- | --- |
| `eagerEntriesThreshold` | When to load a container's index in one shot vs. stream it | Less RAM per container, slower repeated lookups | Faster lookups, more RAM per container | You hit objects/arrays with **millions of children** and memory matters more than latency (lower it), or you do many lookups on the same container and want them cached (raise it) |
| `readChunkBytes` | Read size for streaming and caching | Less RAM, more IO calls | Fewer IO calls, more RAM | If reads come from a **slow source** (network, S3) - raise it. Otherwise, if memory is very tight, lower it. |
| `sourceCacheBytes` | Total budget for cached file chunks | Less RAM, repeat reads hit disk | Fewer disk reads, more RAM | You do **many lookups** on the same file (raise it). One-shot full scan or memory-constrained (set `0` to disable) |
| `validateLeafKeys` | Verifies object keys are sorted before binary search | (`false`) Faster first lookup per object, **unsafe with untrusted data** | (`true`, default) Safe against malformed input | |
| `maxContainerEntries` | Hard cap on container size |  | | |

## Custom sources

Implement `ByteSource` for HTTP range requests, mmap, S3, etc.:

```ts
const r = await KahonReader.fromSource(new MyCustomSource(), {
  sourceCacheBytes: 1 * 1024 * 1024,
});
```

`fromSource` automatically wraps the source with a chunk cache unless
`sourceCacheBytes: 0` is set or the source is already wrapped.

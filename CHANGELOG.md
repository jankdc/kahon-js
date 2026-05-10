# kahon

## 0.3.0

### Minor Changes

- [#3](https://github.com/jankdc/kahon-js/pull/3) [`ea5676e`](https://github.com/jankdc/kahon-js/commit/ea5676e12427d1ba621923a89517be6f5a6af9c9) Thanks [@jankdc](https://github.com/jankdc)! - Support the extension type tag (spec §4 + §9): `0xC0..0xCF` (TinyExt), `0xD0`
  (Ext with `varuint ext_id`), with `0xD1..0xFF` rejected as reserved. Bumped the
  on-disk format to version `0x02` to match the upstream spec.

  - New `KahonExtension` class wraps extension nodes in the decoded tree:
    `decode()` returns a `KahonExtension { extId, value }` for every extension,
    with the recursively-decoded payload as `value`.
  - `KahonValue` widens to include `KahonExtension`.
  - New `Cursor.extId()` and `Cursor.payload()` for inspecting extension nodes.
  - Container-shape cursor ops (`get`, `at`, `length`, `keys`, `values`,
    `entries`, `has`) and JSON-pointer traversal (`find`, `get`, `has`)
    transparently peel through extension wrappers, so paths like
    `/users/0/name` work regardless of whether the producer wrapped intermediate
    nodes in extensions. `Cursor.kind()` and `Cursor.decode()` still surface the
    outermost wrapper so callers can recover ext metadata.

  Behavior change: the previous placeholder treated `0xC0..0xFF` as a single
  opaque length-prefixed range and surfaced an internal sentinel symbol from
  `decode()`. Files that relied on that misparse will now decode correctly
  (or be rejected if they used a now-reserved code such as `0xD1`).

## 0.2.0

### Minor Changes

- [#1](https://github.com/jankdc/kahon-js/pull/1) [`f80481e`](https://github.com/jankdc/kahon-js/commit/f80481e478898937e7eea30eab6643802e1f0246) Thanks [@jankdc](https://github.com/jankdc)! - Decouple source lifecycle from `KahonReader`. `ByteSource` is now a pure data interface (`size`, `read`); the reader never closes or disposes a source. Resource management lives on the concrete source class — only `FileSource` owns an OS handle, so only `FileSource` exposes `close()` and `[Symbol.asyncDispose]()`. `BufferSource` and `CachedByteSource` own no resources and have no lifecycle methods.

  ```ts
  import { FileSource, KahonReader } from "kahon";

  await using src = await FileSource.open(path);
  const reader = await KahonReader.fromSource(src);
  await reader.get("/users/0/name");
  ```

  Requires Node `>=20.4` for native `Symbol.asyncDispose` (only relevant if you `await using` a `FileSource`).

  **Breaking changes**

  - `KahonReader.fromFile(path, opts)` removed. Replace with:
    ```ts
    await using src = await FileSource.open(path);
    const r = await KahonReader.fromSource(src, opts);
    ```
  - `KahonReader.fromBuffer(buf, opts)` removed. Replace with:
    ```ts
    const r = await KahonReader.fromSource(new BufferSource(buf), opts);
    ```
  - `KahonReader.close()` and `KahonReader[Symbol.asyncDispose]()` removed. Dispose the source instead.
  - `ByteSource` interface no longer declares `close` or `[Symbol.asyncDispose]`. External implementers should drop them from the interface contract; keep them as concrete methods on the implementing class if the source owns resources.
  - `BufferSource` and `CachedByteSource` no longer expose `close` / `[Symbol.asyncDispose]`.
  - `BufferSource` and `FileSource` are now exported from the package root.

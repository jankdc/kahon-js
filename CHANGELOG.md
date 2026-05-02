# kahon

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

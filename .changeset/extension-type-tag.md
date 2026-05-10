---
"kahon": minor
---

Support the extension type tag (spec §4 + §9): `0xC0..0xCF` (TinyExt), `0xD0`
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

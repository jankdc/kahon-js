import { test } from "node:test";
import assert from "node:assert/strict";
import { BufferSource, KahonExtension, KahonReader } from "../src/index.js";

// Build a Kahon file from body bytes + root offset. Header is 6 bytes
// (magic "KAHN" + version 0x02 + flags 0x00); trailer is uint64_le root offset
// + magic "KAHN".
function makeFile(body: number[], rootOffset: number): Buffer {
  const header = Buffer.from([0x4b, 0x41, 0x48, 0x4e, 0x02, 0x00]);
  const bodyBuf = Buffer.from(body);
  const trailer = Buffer.alloc(12);
  trailer.writeBigUInt64LE(BigInt(rootOffset), 0);
  trailer.writeUInt32LE(0x4e48414b, 8); // "KAHN" little-endian
  return Buffer.concat([header, bodyBuf, trailer]);
}

async function readFrom(body: number[], rootOffset: number): Promise<KahonReader> {
  return KahonReader.fromSource(new BufferSource(makeFile(body, rootOffset)));
}

test("TinyExt id=0 wrapping null", async () => {
  // @06: C0 00 (TinyExt 0, payload Null)
  const r = await readFrom([0xc0, 0x00], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 0);
  assert.equal(v.value, null);
});

test("TinyExt id=3 wrapping integer 1", async () => {
  // @06: C3 14
  const r = await readFrom([0xc3, 0x14], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 3);
  assert.equal(v.value, 1);
});

test("TinyExt id=15 (boundary) wrapping integer 1", async () => {
  // @06: CF 14
  const r = await readFrom([0xcf, 0x14], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 15);
  assert.equal(v.value, 1);
});

test("Generic Ext id=16 (smallest requiring D0)", async () => {
  // @06: D0 10 14
  const r = await readFrom([0xd0, 0x10, 0x14], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 16);
  assert.equal(v.value, 1);
});

test("Generic Ext id=200 with multi-byte varuint", async () => {
  // ext_id 200 = 0xC8: varuint encoding is C8 01 (low 7 bits = 0x48 with cont, then 0x01).
  // 200 = 0b11001000 -> low 7 bits 0b1001000 = 0x48 + cont -> 0xC8; high 0b1 -> 0x01.
  // @06: D0 C8 01 14
  const r = await readFrom([0xd0, 0xc8, 0x01, 0x14], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 200);
  assert.equal(v.value, 1);
});

test("reserved 0xD1 is rejected on decode", async () => {
  // @06: D1
  const r = await readFrom([0xd1], 0x06);
  await assert.rejects(() => r.decode(), /unknown type code 0xd1/i);
});

test("path traversal is transparent through extension wrappers", async () => {
  // Layout (post-order):
  //   @06: TinyString "x"          -> 60 78
  //   @08: TinyUInt 1              -> 14
  //   @09: TinyExt 0               -> C0 (payload immediately follows)
  //   @0A: Object leaf {x: @08}    -> 80 01 06 08
  //   @0E: Array leaf [@09]        -> 70 01 09
  // Decoded shape: [<ext 0>{x: 1}]; find("/0/x") must surface 1.
  const r = await readFrom(
    [0x60, 0x78, 0x14, 0xc0, 0x80, 0x01, 0x06, 0x08, 0x70, 0x01, 0x09],
    0x0e,
  );
  assert.equal(await r.get("/0/x"), 1);
  assert.equal(await r.has("/0/x"), true);
});

test("path traversal through ext-wrapped array inside an object", async () => {
  // @06: TinyString "a"                -> 60 61
  // @08: TinyUInt 10                   -> 1D  (0x13 + 10)
  // @09: TinyUInt 20                   -> 27  (0x13 + 20)
  // @0A: TinyExt 5                     -> C5
  // @0B: Array leaf [@08, @09]         -> 70 02 08 09
  // @0F: Object leaf {a: @0A}          -> 80 01 06 0A
  const r = await readFrom(
    [0x60, 0x61, 0x1d, 0x27, 0xc5, 0x70, 0x02, 0x08, 0x09, 0x80, 0x01, 0x06, 0x0a],
    0x0f,
  );
  assert.equal(await r.get("/a/1"), 20);
});

test("cursor extId/payload round-trip on TinyExt wrapping a string", async () => {
  // @06: TinyExt 7                     -> C7
  // @07: TinyString "abc"              -> 62 61 62 63 (code 0x60 + (3-1))
  const r = await readFrom([0xc7, 0x62, 0x61, 0x62, 0x63], 0x06);
  const root = await r.root();
  assert.equal(await root.kind(), "extension");
  assert.equal(await root.extId(), 7);
  const payload = await root.payload();
  assert.equal(await payload.kind(), "string");
  assert.equal(await payload.decode(), "abc");
});

test("extId() and payload() throw on non-extension cursors", async () => {
  // @06: TinyUInt 1
  const r = await readFrom([0x14], 0x06);
  const root = await r.root();
  await assert.rejects(() => root.extId(), /requires kind=extension/);
  await assert.rejects(() => root.payload(), /requires kind=extension/);
});

test("nested extensions decode to nested wrappers", async () => {
  // @06: TinyExt 1                     -> C1
  // @07: TinyExt 2                     -> C2
  // @08: TinyUInt 1                    -> 14
  const r = await readFrom([0xc1, 0xc2, 0x14], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 1);
  assert.ok(v.value instanceof KahonExtension);
  assert.equal(v.value.extId, 2);
  assert.equal(v.value.value, 1);
});

test("tolerated: non-minimal generic form for low ext_id", async () => {
  // Spec §12.1: writers MUST use TinyExt for ids 0..15; readers SHOULD accept
  // the generic form. D0 05 14 = ext_id 5, payload 1.
  const r = await readFrom([0xd0, 0x05, 0x14], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 5);
  assert.equal(v.value, 1);
});

test("tolerated: overlong varuint ext_id", async () => {
  // 90 00 = non-minimal 2-byte encoding of 16. readVarUInt accepts non-minimal
  // forms (only rejects > 10 bytes); §6 allows readers to surface this.
  const r = await readFrom([0xd0, 0x90, 0x00, 0x14], 0x06);
  const v = await r.decode();
  assert.ok(v instanceof KahonExtension);
  assert.equal(v.extId, 16);
  assert.equal(v.value, 1);
});

test("iteration over an ext-wrapped array is transparent", async () => {
  // @06: TinyUInt 1            -> 14
  // @07: TinyUInt 2            -> 15
  // @08: TinyExt 0             -> C0
  // @09: Array leaf [@06, @07] -> 70 02 06 07
  const r = await readFrom([0x14, 0x15, 0xc0, 0x70, 0x02, 0x06, 0x07], 0x08);
  const root = await r.root();
  assert.equal(await root.kind(), "extension");
  assert.equal(await root.length(), 2);
  const out: unknown[] = [];
  for await (const c of root) out.push(await c.decode());
  assert.deepStrictEqual(out, [1, 2]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BufferSource, FileSource, KahonReader } from "../src/index.js";

// The spec's worked example: {"a": [1, 2.0, "x"]}
//
// Header (6) | body (19) | trailer (12) = 37 bytes total.
const FIXTURE = Buffer.from([
  // Header
  0x4b, 0x41, 0x48, 0x4e, 0x01, 0x00,
  // @06: TinyString "a"
  0x60, 0x61,
  // @08: TinyUInt(1)
  0x14,
  // @09: Float32(2.0) - bit pattern 0x40000000, little-endian
  0x50, 0x00, 0x00, 0x00, 0x40,
  // @0E: TinyString "x"
  0x60, 0x78,
  // @10: Array leaf, w=0, n=3, offsets [08, 09, 0E]
  0x70, 0x03, 0x08, 0x09, 0x0e,
  // @15: Object leaf, w=0, n=1, [keyOff=06, valOff=10]
  0x80, 0x01, 0x06, 0x10,
  // Trailer: root offset = 0x15 (uint64 LE) + magic
  0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x4b, 0x41, 0x48, 0x4e,
]);

const EMPTY_OBJECT = Buffer.from([
  0x4b, 0x41, 0x48, 0x4e, 0x01, 0x00,
  0x34, // empty object at @06
  0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x4b, 0x41, 0x48, 0x4e,
]);

test("full decode of worked example", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  assert.deepStrictEqual(await r.decode(), { a: [1, 2, "x"] });
});

test("get by JSON pointer", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  assert.deepStrictEqual(await r.get("/a"), [1, 2, "x"]);
  assert.equal(await r.get("/a/0"), 1);
  assert.equal(await r.get("/a/1"), 2);
  assert.equal(await r.get("/a/2"), "x");
  assert.equal(await r.get("/a/3"), undefined);
  assert.equal(await r.get("/missing"), undefined);
});

test("get by array path", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  assert.deepStrictEqual(await r.get(["a"]), [1, 2, "x"]);
  assert.equal(await r.get(["a", 0]), 1);
  assert.equal(await r.get(["a", 2]), "x");
});

test("has", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  assert.equal(await r.has("/a"), true);
  assert.equal(await r.has("/a/0"), true);
  assert.equal(await r.has("/a/3"), false);
  assert.equal(await r.has("/b"), false);
  assert.equal(await r.has(""), true); // root
});

test("cursor navigation is lazy and typed", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  const root = await r.root();
  assert.equal(await root.kind(), "object");
  assert.equal(await root.length(), 1);

  const a = await root.get("a");
  assert.ok(a);
  assert.equal(await a.kind(), "array");
  assert.equal(await a.length(), 3);

  assert.equal(await (await a.at(0))?.decode(), 1);
  assert.equal(await (await a.at(1))?.decode(), 2);
  assert.equal(await (await a.at(2))?.decode(), "x");
  assert.equal(await (await a.at(-1))?.decode(), "x");
  assert.equal(await a.at(3), undefined);
});

test("Symbol.asyncIterator yields child cursors for arrays", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  const a = (await (await r.root()).get("a"))!;
  const out: unknown[] = [];
  for await (const c of a) out.push(await c.decode());
  assert.deepStrictEqual(out, [1, 2, "x"]);
});

test("entries() yields [key, cursor] for objects", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  const root = await r.root();
  const collected: [string, unknown][] = [];
  for await (const [k, c] of root.entries()) {
    collected.push([k, await c.decode()]);
  }
  assert.deepStrictEqual(collected, [["a", [1, 2, "x"]]]);
});

test("keys() yields object keys", async () => {
  const r = await KahonReader.fromSource(new BufferSource(FIXTURE));
  const out: string[] = [];
  for await (const k of (await r.root()).keys()) out.push(k);
  assert.deepStrictEqual(out, ["a"]);
});

test("empty object decodes to {}", async () => {
  const r = await KahonReader.fromSource(new BufferSource(EMPTY_OBJECT));
  assert.deepStrictEqual(await r.decode(), {});
  assert.equal(await (await r.root()).kind(), "object");
  assert.equal(await (await r.root()).length(), 0);
});

test("rejects bad header magic", async () => {
  const bad = Buffer.from(FIXTURE);
  bad[0] = 0xff;
  await assert.rejects(() => KahonReader.fromSource(new BufferSource(bad)), /header magic/i);
});

test("rejects bad version", async () => {
  const bad = Buffer.from(FIXTURE);
  bad[4] = 0x99;
  await assert.rejects(() => KahonReader.fromSource(new BufferSource(bad)), /version/i);
});

test("rejects bad trailer magic", async () => {
  const bad = Buffer.from(FIXTURE);
  bad[bad.length - 1] = 0xff;
  await assert.rejects(() => KahonReader.fromSource(new BufferSource(bad)), /trailer magic/i);
});

test("rejects truncated file", async () => {
  const bad = FIXTURE.subarray(0, 10);
  await assert.rejects(() => KahonReader.fromSource(new BufferSource(bad)));
});

test("file-backed reader via fd", async () => {
  const tmp = path.join(os.tmpdir(), `kahon-${process.pid}-${Date.now()}.kahon`);
  fs.writeFileSync(tmp, FIXTURE);
  try {
    await using src = await FileSource.open(tmp);
    const r = await KahonReader.fromSource(src);
    assert.deepStrictEqual(await r.decode(), { a: [1, 2, "x"] });
    assert.equal(await r.get("/a/1"), 2);
    assert.equal(await r.has("/a/0"), true);
    assert.equal(await r.has("/a/9"), false);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("file-backed reader rejects bad magic on open", async () => {
  const tmp = path.join(os.tmpdir(), `kahon-bad-${process.pid}-${Date.now()}.kahon`);
  const bad = Buffer.from(FIXTURE);
  bad[0] = 0xff;
  fs.writeFileSync(tmp, bad);
  try {
    await assert.rejects(async () => {
      await using src = await FileSource.open(tmp);
      await KahonReader.fromSource(src);
    }, /header magic/i);
  } finally {
    fs.unlinkSync(tmp);
  }
});

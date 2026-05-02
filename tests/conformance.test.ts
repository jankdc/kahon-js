import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KahonReader } from "../src/index.js";

type ValidVector = { id: string; description: string; json_text: string; bytes_hex: string };
type InvalidVector = { id: string; description: string; must_reject: true; bytes_hex: string };

const valid = JSON.parse(
  readFileSync("tests/conformance/valid.json", "utf8"),
) as ValidVector[];
const tolerated = JSON.parse(
  readFileSync("tests/conformance/tolerated.json", "utf8"),
) as ValidVector[];
const invalid = JSON.parse(
  readFileSync("tests/conformance/invalid.json", "utf8"),
) as InvalidVector[];

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex.replace(/\s+/g, ""), "hex");
}

// JSON.parse loses precision on integers outside ±2^53. Re-parse those tokens
// as bigint so they survive comparison against the reader's bigint output.
function parseExpected(jsonText: string): unknown {
  const bigints = new Map<string, bigint>();
  let counter = 0;
  const transformed = jsonText.replace(
    /(^|[\s,\[\]{}:])(-?\d+)(?=$|[\s,\[\]{}])/g,
    (_m, lead: string, num: string) => {
      const big = BigInt(num);
      if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
        const key = `__kahon_big_${counter++}__`;
        bigints.set(key, big);
        return `${lead}"${key}"`;
      }
      return `${lead}${num}`;
    },
  );
  const parsed = JSON.parse(transformed);
  if (bigints.size === 0) return parsed;
  const swap = (v: unknown): unknown => {
    if (typeof v === "string" && bigints.has(v)) return bigints.get(v);
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = swap(val);
      return out;
    }
    return v;
  };
  return swap(parsed);
}

// Spec allows readers to return integer values as either number or bigint when the
// value fits in a safe integer; coerce safe-range bigints to numbers for comparison.
function normalize(v: unknown): unknown {
  if (typeof v === "bigint") {
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(v);
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = normalize(val);
    return out;
  }
  return v;
}

for (const v of valid) {
  test(`conformance/valid: ${v.id}`, async () => {
    const reader = await KahonReader.fromBuffer(hexToBuffer(v.bytes_hex));
    assert.deepStrictEqual(
      normalize(await reader.decode()),
      normalize(parseExpected(v.json_text)),
    );
  });
}

// Vectors with no JSON correspondence (e.g. opaque extension codes); we only
// assert the reader accepts them without throwing.
const ACCEPT_ONLY = new Set<string>(["tolerated/extension-c0-opaque"]);

for (const v of tolerated) {
  test(`conformance/tolerated: ${v.id}`, async () => {
    const reader = await KahonReader.fromBuffer(hexToBuffer(v.bytes_hex));
    if (ACCEPT_ONLY.has(v.id)) {
      await reader.decode();
      return;
    }
    assert.deepStrictEqual(
      normalize(await reader.decode()),
      normalize(parseExpected(v.json_text)),
    );
  });
}

for (const v of invalid) {
  test(`conformance/invalid: ${v.id}`, async () => {
    await assert.rejects(async () => {
      const reader = await KahonReader.fromBuffer(hexToBuffer(v.bytes_hex));
      await reader.decode();
    });
  });
}

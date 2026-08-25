import test from "node:test";
import assert from "node:assert/strict";
import { parseTenants } from "../src/config.mjs";

test("parseTenants accepts string and object entries", () => {
  const a = "a".repeat(24);
  const b = "b".repeat(24);
  const c = "c".repeat(24);
  assert.deepEqual(parseTenants(JSON.stringify({
    [a]: "one",
    [b]: { tenant: "two", active: true },
    [c]: { tenant: "three", active: false },
  })), [
    { apiKey: a, tenant: "one" },
    { apiKey: b, tenant: "two" },
  ]);
});

test("parseTenants rejects short keys", () => {
  assert.throws(() => parseTenants('{"short":"tenant"}'), /at least 24/);
});

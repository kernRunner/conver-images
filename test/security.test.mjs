import test from "node:test";
import assert from "node:assert/strict";
import { buildTenantAuth, requestId, safeBaseName } from "../src/security.mjs";

test("tenant auth resolves valid keys", () => {
  const key = "x".repeat(32);
  const auth = buildTenantAuth([{ apiKey: key, tenant: "backend" }]);
  assert.equal(auth(key), "backend");
  assert.equal(auth("y".repeat(32)), null);
});

test("requestId only accepts bounded safe IDs", () => {
  assert.equal(requestId("abc-123:_foo"), "abc-123:_foo");
  assert.notEqual(requestId("bad id"), "bad id");
});

test("safeBaseName strips paths and unsafe characters", () => {
  assert.equal(safeBaseName("../../My Art (Final).JPG"), "my-art-final");
});

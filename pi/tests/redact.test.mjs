import assert from "node:assert/strict";
import test from "node:test";
import { redact, redactRecord } from "../src/redact.ts";

test("redacts api keys and bearer tokens", () => {
  assert.match(redact("EVEROS_API_KEY=sk-live-abcdefghijk"), /\[redacted\]/);
  assert.equal(redact("Bearer abcdef"), "Bearer [redacted]");
  assert.match(redact("evt_abcdefghijk"), /\[redacted\]/);
  assert.equal(redact("project=pi-everos"), "project=pi-everos");
});

test("redactRecord never echoes secret values", () => {
  const out = redactRecord({ EVEROS_API_KEY: "sk-live-abcdefghijk", EVEROS_USER_ID: "chasen-demo" });
  assert.equal(out.EVEROS_API_KEY, "[set]");
  assert.equal(out.EVEROS_USER_ID, "chasen-demo");
});

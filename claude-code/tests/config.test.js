import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, normalizeBaseUrl, splitCommand, isLoopback } from "../hooks/scripts/lib/config.js";

const base = { HOME: "/home/tester", USER: "tester" };

test("defaults apply when nothing is set", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.baseUrl, "http://127.0.0.1:8000");
  assert.equal(c.everosDir, null);
  assert.deepEqual(c.startCmd, ["everos", "server", "start"]);
  assert.equal(c.userId, "tester");
  assert.equal(c.projectIdOverride, null);
  assert.equal(c.verbose, false);
  assert.equal(c.sources.baseUrl, "default");
});

test("process env beats userConfig beats default", () => {
  const c = loadConfig({
    ...base,
    CLAUDE_PLUGIN_OPTION_BASE_URL: "http://10.0.0.2:9000",
    EVEROS_CC_BASE_URL: "http://127.0.0.1:7777",
  });
  assert.equal(c.baseUrl, "http://127.0.0.1:7777");
  assert.equal(c.sources.baseUrl, "env");

  const d = loadConfig({ ...base, CLAUDE_PLUGIN_OPTION_BASE_URL: "http://10.0.0.2:9000" });
  assert.equal(d.baseUrl, "http://10.0.0.2:9000");
  assert.equal(d.sources.baseUrl, "userConfig");
});

test("a blank value never shadows a lower layer", () => {
  const c = loadConfig({
    ...base,
    EVEROS_CC_BASE_URL: "   ",
    CLAUDE_PLUGIN_OPTION_BASE_URL: "http://10.0.0.2:9000",
  });
  assert.equal(c.baseUrl, "http://10.0.0.2:9000");
  assert.equal(c.sources.baseUrl, "userConfig");
});

test("normalizeBaseUrl adds a scheme, strips a trailing slash, falls back when unparseable", () => {
  assert.equal(normalizeBaseUrl("127.0.0.1:8000"), "http://127.0.0.1:8000");
  assert.equal(normalizeBaseUrl("http://host:1/"), "http://host:1");
  assert.equal(normalizeBaseUrl("http://[bad"), "http://127.0.0.1:8000");
  assert.equal(normalizeBaseUrl(""), "http://127.0.0.1:8000");
});

test("splitCommand is quote-aware", () => {
  assert.deepEqual(splitCommand("everos server start"), ["everos", "server", "start"]);
  assert.deepEqual(splitCommand('uv run "my everos" start'), ["uv", "run", "my everos", "start"]);
  assert.deepEqual(splitCommand("  "), []);
});

test("isLoopback recognises loopback hosts only", () => {
  assert.equal(isLoopback("http://127.0.0.1:8000"), true);
  assert.equal(isLoopback("http://localhost:8000"), true);
  assert.equal(isLoopback("http://[::1]:8000"), true);
  assert.equal(isLoopback("http://10.0.0.2:8000"), false);
});

test("userId falls back through USER, USERNAME, then the chosen override", () => {
  assert.equal(loadConfig({ HOME: "/h", USERNAME: "winuser" }).userId, "winuser");
  assert.equal(loadConfig({ HOME: "/h", EVEROS_CC_USER_ID: "chosen", USER: "tester" }).userId, "chosen");
});

test("dataDir prefers CLAUDE_PLUGIN_DATA and falls back under HOME", () => {
  assert.equal(loadConfig({ ...base, CLAUDE_PLUGIN_DATA: "/data/x" }).dataDir, "/data/x");
  assert.equal(loadConfig({ ...base }).dataDir, path.join("/home/tester", ".everos", ".claude-code"));
});

test("the recall timeout defaults to 5s and is clamped, never disabled", () => {
  assert.equal(loadConfig({ ...base }).recallTimeoutMs, 5000);
  assert.equal(loadConfig({ ...base, EVEROS_CC_RECALL_TIMEOUT_MS: "2500" }).recallTimeoutMs, 2500);
  assert.equal(loadConfig({ ...base, EVEROS_CC_RECALL_TIMEOUT_MS: "0" }).recallTimeoutMs, 500);
  assert.equal(loadConfig({ ...base, EVEROS_CC_RECALL_TIMEOUT_MS: "999999" }).recallTimeoutMs, 7000);
  assert.equal(loadConfig({ ...base, EVEROS_CC_RECALL_TIMEOUT_MS: "nonsense" }).recallTimeoutMs, 5000);
});

test("verbose and debug read 1/true/yes", () => {
  assert.equal(loadConfig({ ...base, EVEROS_CC_VERBOSE: "1" }).verbose, true);
  assert.equal(loadConfig({ ...base, EVEROS_CC_VERBOSE: "true" }).verbose, true);
  assert.equal(loadConfig({ ...base, EVEROS_CC_VERBOSE: "0" }).verbose, false);
  assert.equal(loadConfig({ ...base, EVEROS_CC_DEBUG: "yes" }).debug, true);
});

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
  assert.equal(c.locale, "zh");
  assert.equal(c.sources.baseUrl, "default");
  assert.equal(c.sources.locale, "default");
});

test("EVEROS_AG_* beats EVEROS_ANTIGRAVITY_* beats userConfig beats default", () => {
  // EVEROS_AG_* takes precedence
  const c = loadConfig({
    ...base,
    ANTIGRAVITY_PLUGIN_OPTION_BASE_URL: "http://10.0.0.2:9000",
    EVEROS_ANTIGRAVITY_BASE_URL: "http://127.0.0.1:8888",
    EVEROS_AG_BASE_URL: "http://127.0.0.1:7777",
  });
  assert.equal(c.baseUrl, "http://127.0.0.1:7777");
  assert.equal(c.sources.baseUrl, "env (AG)");

  // EVEROS_ANTIGRAVITY_* takes precedence over userConfig
  const d = loadConfig({
    ...base,
    ANTIGRAVITY_PLUGIN_OPTION_BASE_URL: "http://10.0.0.2:9000",
    EVEROS_ANTIGRAVITY_BASE_URL: "http://127.0.0.1:8888",
  });
  assert.equal(d.baseUrl, "http://127.0.0.1:8888");
  assert.equal(d.sources.baseUrl, "env (ANTIGRAVITY)");

  // userConfig takes precedence over default
  const e = loadConfig({
    ...base,
    ANTIGRAVITY_PLUGIN_OPTION_BASE_URL: "http://10.0.0.2:9000",
  });
  assert.equal(e.baseUrl, "http://10.0.0.2:9000");
  assert.equal(e.sources.baseUrl, "userConfig");
});

test("a blank value never shadows a lower layer", () => {
  const c = loadConfig({
    ...base,
    EVEROS_AG_BASE_URL: "   ",
    EVEROS_ANTIGRAVITY_BASE_URL: "http://127.0.0.1:8888",
  });
  assert.equal(c.baseUrl, "http://127.0.0.1:8888");
  assert.equal(c.sources.baseUrl, "env (ANTIGRAVITY)");
});

test("normalizeBaseUrl adds a scheme, strips a trailing slash, falls back when unparseable", () => {
  assert.equal(normalizeBaseUrl("127.0.0.1:8000"), "http://127.0.0.1:8000");
  assert.equal(normalizeBaseUrl("http://host:1/"), "http://host:1");
  assert.equal(normalizeBaseUrl("http://[bad"), "http://127.0.0.1:8000");
  assert.equal(normalizeBaseUrl(""), "http://127.0.0.1:8000");
});

test("normalizeBaseUrl blocks non-http protocols and null origins", () => {
  assert.equal(normalizeBaseUrl("javascript://alert(1)"), "http://127.0.0.1:8000");
  assert.equal(normalizeBaseUrl("file:///etc/passwd"), "http://127.0.0.1:8000");
  assert.equal(normalizeBaseUrl("data:text/plain;base64,SGVsbG8="), "http://127.0.0.1:8000");
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
  assert.equal(loadConfig({ HOME: "/h", EVEROS_AG_USER_ID: "chosen", USER: "tester" }).userId, "chosen");
  assert.equal(loadConfig({ HOME: "/h", EVEROS_ANTIGRAVITY_USER_ID: "compat", USER: "tester" }).userId, "compat");
});

test("dataDir prefers EVEROS_AG_DATA_DIR, then ANTIGRAVITY_PLUGIN_DATA, then falls back under HOME", () => {
  assert.equal(loadConfig({ ...base, ANTIGRAVITY_PLUGIN_DATA: "/data/ag" }).dataDir, "/data/ag");
  assert.equal(loadConfig({ ...base, EVEROS_AG_DATA_DIR: "/data/custom" }).dataDir, "/data/custom");
  assert.equal(loadConfig({ ...base }).dataDir, path.join("/home/tester", ".everos", ".antigravity"));
});

test("the recall timeout defaults to 5s and is clamped, never disabled", () => {
  assert.equal(loadConfig({ ...base }).recallTimeoutMs, 5000);
  assert.equal(loadConfig({ ...base, EVEROS_AG_RECALL_TIMEOUT_MS: "2500" }).recallTimeoutMs, 2500);
  assert.equal(loadConfig({ ...base, EVEROS_AG_RECALL_TIMEOUT_MS: "0" }).recallTimeoutMs, 500);
  assert.equal(loadConfig({ ...base, EVEROS_AG_RECALL_TIMEOUT_MS: "999999" }).recallTimeoutMs, 7000);
  assert.equal(loadConfig({ ...base, EVEROS_AG_RECALL_TIMEOUT_MS: "nonsense" }).recallTimeoutMs, 5000);
});

test("verbose and debug read 1/true/yes/on", () => {
  assert.equal(loadConfig({ ...base, EVEROS_AG_VERBOSE: "1" }).verbose, true);
  assert.equal(loadConfig({ ...base, EVEROS_AG_VERBOSE: "true" }).verbose, true);
  assert.equal(loadConfig({ ...base, EVEROS_AG_VERBOSE: "0" }).verbose, false);
  assert.equal(loadConfig({ ...base, EVEROS_AG_DEBUG: "yes" }).debug, true);
  assert.equal(loadConfig({ ...base, EVEROS_ANTIGRAVITY_DEBUG: "on" }).debug, true);
});

test("locale supports EVEROS_AG_LOCALE / EVEROS_AG_LANGUAGE, host options, and resolves zh or en", () => {
  assert.equal(loadConfig({ ...base, EVEROS_AG_LOCALE: "en" }).locale, "en");
  assert.equal(loadConfig({ ...base, EVEROS_AG_LANGUAGE: "english" }).locale, "en");
  assert.equal(loadConfig({ ...base, EVEROS_ANTIGRAVITY_LOCALE: "en" }).locale, "en");
  assert.equal(loadConfig({ ...base, ANTIGRAVITY_PLUGIN_OPTION_LOCALE: "en" }).locale, "en");
  assert.equal(loadConfig({ ...base, EVEROS_AG_LOCALE: "zh" }).locale, "zh");
  assert.equal(loadConfig({ ...base, EVEROS_AG_LOCALE: "other" }).locale, "zh");
});

test("loadConfig records warnings for invalid baseUrl (D3-05)", () => {
  const cfg = loadConfig({ EVEROS_AG_BASE_URL: "ftp://invalid-scheme" });
  assert.equal(cfg.baseUrl, "http://127.0.0.1:8000");
  assert.ok(Array.isArray(cfg.warnings));
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /Invalid BASE_URL/);
});

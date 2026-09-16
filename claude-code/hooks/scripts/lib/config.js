import os from "node:os";
import path from "node:path";
import { DEFAULT_BASE_URL, RECALL_DEADLINE_MS, RECALL_DEADLINE_MIN_MS, RECALL_DEADLINE_MAX_MS } from "./constants.js";

/** A value that is absent or whitespace-only counts as unset and never shadows a lower layer. */
function nonBlank(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Resolve one setting through the three layers, recording which one won so
 * /everos:status can explain where a value came from.
 */
function resolve(env, envKey, optionKey, fallback, sources, name) {
  const fromEnv = nonBlank(env[envKey]);
  if (fromEnv !== undefined) { sources[name] = "env"; return fromEnv; }
  if (optionKey) {
    const fromOption = nonBlank(env[`CLAUDE_PLUGIN_OPTION_${optionKey}`]);
    if (fromOption !== undefined) { sources[name] = "userConfig"; return fromOption; }
  }
  sources[name] = "default";
  return fallback;
}

export function normalizeBaseUrl(raw) {
  const candidate = nonBlank(raw);
  if (candidate === undefined) return DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function isLoopback(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Minimal quote-aware argv split: enough for `uv run "some dir/everos" server start`. */
export function splitCommand(raw) {
  const out = [];
  let current = "";
  let quote = null;
  let seen = false;
  for (const ch of raw ?? "") {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; seen = true; continue; }
    if (/\s/.test(ch)) {
      if (current || seen) { out.push(current); current = ""; seen = false; }
      continue;
    }
    current += ch;
  }
  if (current || seen) out.push(current);
  return out;
}

/** Clamp rather than reject: a nonsense value should not disable recall. */
function boundedInt(raw, fallback, min, max) {
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function truthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

function safeOsUser() {
  try { return os.userInfo().username; } catch { return undefined; }
}

export function loadConfig(env = process.env) {
  const sources = {};
  const baseUrl = normalizeBaseUrl(resolve(env, "EVEROS_CC_BASE_URL", "BASE_URL", DEFAULT_BASE_URL, sources, "baseUrl"));
  const everosDir = resolve(env, "EVEROS_CC_EVEROS_DIR", "EVEROS_DIR", null, sources, "everosDir");
  const startCmdRaw = resolve(env, "EVEROS_CC_START_CMD", null, "everos server start", sources, "startCmd");
  const userId = resolve(
    env,
    "EVEROS_CC_USER_ID",
    null,
    nonBlank(env.USER) ?? nonBlank(env.USERNAME) ?? nonBlank(safeOsUser()) ?? null,
    sources,
    "userId",
  );
  const home = nonBlank(env.HOME) ?? os.homedir();
  const dataDir = resolve(
    env,
    "EVEROS_CC_DATA_DIR",
    null,
    nonBlank(env.CLAUDE_PLUGIN_DATA) ?? path.join(home, ".everos", ".claude-code"),
    sources,
    "dataDir",
  );

  return {
    baseUrl,
    everosDir,
    startCmd: splitCommand(startCmdRaw),
    userId,
    projectIdOverride: resolve(env, "EVEROS_CC_PROJECT_ID", null, null, sources, "projectIdOverride"),
    recallTimeoutMs: boundedInt(
      env.EVEROS_CC_RECALL_TIMEOUT_MS,
      RECALL_DEADLINE_MS,
      RECALL_DEADLINE_MIN_MS,
      RECALL_DEADLINE_MAX_MS,
    ),
    verbose: truthy(env.EVEROS_CC_VERBOSE),
    debug: truthy(env.EVEROS_CC_DEBUG),
    dataDir,
    sources,
  };
}

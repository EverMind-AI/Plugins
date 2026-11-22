import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BASE_URL,
  RECALL_DEADLINE_MS,
  RECALL_DEADLINE_MIN_MS,
  RECALL_DEADLINE_MAX_MS,
} from "./constants.js";

/** A value that is absent or whitespace-only counts as unset and never shadows a lower layer. */
function nonBlank(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Resolve one setting through multiple layers:
 * 1. Primary env: EVEROS_AG_<SUFFIX>
 * 2. Secondary env: EVEROS_ANTIGRAVITY_<SUFFIX>
 * 3. Host option: ANTIGRAVITY_PLUGIN_OPTION_<OPTION_KEY>
 * 4. Fallback default
 */
function resolve(env, agSuffix, optionKey, fallback, sources, name) {
  const agKey = `EVEROS_AG_${agSuffix}`;
  const fromAg = nonBlank(env[agKey]);
  if (fromAg !== undefined) {
    sources[name] = "env (AG)";
    return fromAg;
  }

  const antigravityKey = `EVEROS_ANTIGRAVITY_${agSuffix}`;
  const fromAntigravity = nonBlank(env[antigravityKey]);
  if (fromAntigravity !== undefined) {
    sources[name] = "env (ANTIGRAVITY)";
    return fromAntigravity;
  }

  if (optionKey) {
    const fromOption =
      nonBlank(env[`ANTIGRAVITY_PLUGIN_OPTION_${optionKey}`]) ??
      nonBlank(env[`CLAUDE_PLUGIN_OPTION_${optionKey}`]);
    if (fromOption !== undefined) {
      sources[name] = "userConfig";
      return fromOption;
    }
  }

  sources[name] = "default";
  return fallback;
}

export function normalizeBaseUrl(raw) {
  const candidate = nonBlank(raw);
  if (candidate === undefined) return DEFAULT_BASE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
    ? candidate
    : `http://${candidate}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return DEFAULT_BASE_URL;
    }
    if (!url.origin || url.origin === "null") {
      return DEFAULT_BASE_URL;
    }
    return url.origin;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function isLoopback(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

/** Minimal quote-aware argv split: e.g. `uv run "some dir/everos" server start`. */
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
    if (ch === '"' || ch === "'") {
      quote = ch;
      seen = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || seen) {
        out.push(current);
        current = "";
        seen = false;
      }
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
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

export function loadConfig(env = process.env) {
  const sources = {};
  const warnings = [];

  const rawBaseUrl = resolve(env, "BASE_URL", "BASE_URL", DEFAULT_BASE_URL, sources, "baseUrl");
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  if (rawBaseUrl && rawBaseUrl !== DEFAULT_BASE_URL && baseUrl === DEFAULT_BASE_URL && rawBaseUrl !== baseUrl) {
    warnings.push(`Invalid BASE_URL "${rawBaseUrl}", fallback to "${DEFAULT_BASE_URL}"`);
  }
  const everosDir = resolve(env, "EVEROS_DIR", "EVEROS_DIR", null, sources, "everosDir");
  const startCmdRaw = resolve(
    env,
    "START_CMD",
    null,
    "everos server start",
    sources,
    "startCmd"
  );

  const defaultUser =
    nonBlank(env.USER) ?? nonBlank(env.USERNAME) ?? nonBlank(safeOsUser()) ?? null;
  const userId = resolve(env, "USER_ID", null, defaultUser, sources, "userId");

  const home =
    nonBlank(env.HOME) ?? nonBlank(env.USERPROFILE) ?? os.homedir();
  const defaultDataDir =
    nonBlank(env.ANTIGRAVITY_PLUGIN_DATA) ??
    nonBlank(env.CLAUDE_PLUGIN_DATA) ??
    path.join(home, ".everos", ".antigravity");
  const dataDir = resolve(env, "DATA_DIR", null, defaultDataDir, sources, "dataDir");

  const recallTimeoutRaw =
    nonBlank(env.EVEROS_AG_RECALL_TIMEOUT_MS) ??
    nonBlank(env.EVEROS_ANTIGRAVITY_RECALL_TIMEOUT_MS);

  const searchMethod = resolve(
    env,
    "SEARCH_METHOD",
    "SEARCH_METHOD",
    "keyword",
    sources,
    "searchMethod"
  );

  const verboseRaw =
    env.EVEROS_AG_VERBOSE ?? env.EVEROS_ANTIGRAVITY_VERBOSE;
  const debugRaw =
    env.EVEROS_AG_DEBUG ?? env.EVEROS_ANTIGRAVITY_DEBUG;

  // Language / Locale resolution:
  // Priority: EVEROS_AG_LOCALE -> EVEROS_AG_LANGUAGE -> EVEROS_ANTIGRAVITY_* -> Host Option -> zh
  const localeFromEnv =
    nonBlank(env.EVEROS_AG_LOCALE) ??
    nonBlank(env.EVEROS_AG_LANGUAGE) ??
    nonBlank(env.EVEROS_ANTIGRAVITY_LOCALE) ??
    nonBlank(env.EVEROS_ANTIGRAVITY_LANGUAGE);

  const localeFromOption =
    nonBlank(env.ANTIGRAVITY_PLUGIN_OPTION_LOCALE) ??
    nonBlank(env.ANTIGRAVITY_PLUGIN_OPTION_LANGUAGE) ??
    nonBlank(env.CLAUDE_PLUGIN_OPTION_LOCALE);

  let locale = "zh";
  if (localeFromEnv) {
    const normalized = localeFromEnv.trim().toLowerCase();
    locale = ["en", "english"].includes(normalized) ? "en" : "zh";
    sources.locale = "env";
  } else if (localeFromOption) {
    const normalized = localeFromOption.trim().toLowerCase();
    locale = ["en", "english"].includes(normalized) ? "en" : "zh";
    sources.locale = "userConfig";
  } else {
    sources.locale = "default";
  }

  return {
    baseUrl,
    everosDir,
    startCmd: splitCommand(startCmdRaw),
    userId,
    projectIdOverride: resolve(env, "PROJECT_ID", null, null, sources, "projectIdOverride"),
    recallTimeoutMs: boundedInt(
      recallTimeoutRaw,
      RECALL_DEADLINE_MS,
      RECALL_DEADLINE_MIN_MS,
      RECALL_DEADLINE_MAX_MS
    ),
    verbose: truthy(verboseRaw),
    debug: truthy(debugRaw),
    dataDir,
    locale,
    searchMethod,
    sources,
    warnings,
  };
}

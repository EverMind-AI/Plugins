import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Codex ships a memory system of its own, and it is on by default for many
 * installs. It injects a developer message of roughly 27,500 characters at
 * session start - measured on a real session - built from `~/.codex/memories`.
 *
 * This plugin injects as well, so the two share one context window. That is a
 * decision the user should make on purpose rather than discover, and it can
 * only be detected at runtime: the flag lives in Codex's config, not ours.
 */
export function codexHome(env = process.env) {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv || path.join(os.homedir(), ".codex");
}

/**
 * Returns `"on"`, `"off"`, or `"unknown"`.
 *
 * `[features] memories = <bool>` in `config.toml` is the authority when it is
 * present. When it is absent the default is the host's to choose and changes
 * between versions, so a populated memories directory is used as evidence that
 * the feature is in fact running rather than guessing from a default.
 */
export function nativeMemoryState(home = codexHome()) {
  let config = "";
  try {
    config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    config = "";
  }
  const declared = readFeatureFlag(config, "memories");
  if (declared !== null) return declared ? "on" : "off";

  try {
    const stat = fs.statSync(path.join(home, "memories", "MEMORY.md"));
    if (stat.size > 0) return "on";
  } catch {
    // No memory file: either the feature is off or it has never run.
  }
  return "unknown";
}

/**
 * The value of `<key>` inside the `[features]` table, or null when the table or
 * the key is absent.
 *
 * Deliberately not a TOML parser: this reads one boolean out of one table, and
 * the plugin has no dependencies. It stops at the next table header so a key of
 * the same name in another table cannot be misread.
 */
export function readFeatureFlag(tomlText, key) {
  let inFeatures = false;
  for (const raw of String(tomlText ?? "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      inFeatures = header[1].trim() === "features";
      continue;
    }
    if (!inFeatures) continue;
    const match = new RegExp(`^${key}\\s*=\\s*(true|false)\\b`).exec(line);
    if (match) return match[1] === "true";
  }
  return null;
}

/** True once per data dir: the notice is information, not something to repeat. */
export function claimOverlapNotice(dataDir) {
  const marker = path.join(dataDir, "native-memory-notice");
  try {
    if (fs.existsSync(marker)) return false;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString(), { mode: 0o600 });
    return true;
  } catch {
    // An unwritable data dir must not cost anyone a session. Staying quiet is
    // the safe direction for a notice.
    return false;
  }
}

export const OVERLAP_NOTICE =
  "🧠 EverOS memory is on, and so is Codex's own (`[features] memories`). " +
  "Both inject into this session's context. Keep both, or turn Codex's off with " +
  "`memories = false` under `[features]` in ~/.codex/config.toml. Shown once.";

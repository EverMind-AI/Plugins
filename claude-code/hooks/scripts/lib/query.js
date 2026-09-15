import { QUERY_MAX_CHARS, MIN_QUERY_TOKENS } from "./constants.js";

/** Wrappers the host injects around or beside the user's own words. */
const NOISE_TAGS = [
  "system-reminder", "ide_selection", "command-name", "command-message",
  "command-args", "local-command-stdout", "local-command-caveat",
  "everos_memory", "attachment", "function_results", "tool_result",
  // The host wraps these in a user entry that carries promptSource, so they
  // look exactly like something the user typed.
  "task-notification", "ide_opened_file",
];
const PAIRED_NOISE = new RegExp(`<(${NOISE_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi");
const STRAY_NOISE = new RegExp(`<\\/?(${NOISE_TAGS.join("|")})\\b[^>]*>`, "gi");
const FENCED_CODE = /```[\s\S]*?```/g;
const LONG_RUN = /\S{400,}/g;

// Written as escapes on purpose: literal CJK in a .js file would trip the
// repository's own "no CJK outside README_zh and tests" check.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/** CJK has no spaces, so word-splitting alone would call any Chinese prompt "1 word". */
export function countTokens(s) {
  const text = String(s ?? "");
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.replace(CJK, " ").match(/\S+/g) ?? []).length;
  return cjk + latin;
}

/** Only the host's wrappers. Capture reuses this; it must not touch the user's
 *  own code fences, which the query path folds away but memory keeps. */
export function stripHostWrappers(s) {
  return String(s ?? "").replace(PAIRED_NOISE, "").replace(STRAY_NOISE, "");
}

export function stripNoise(s) {
  return stripHostWrappers(s)
    .replace(FENCED_CODE, "[code]")
    .replace(LONG_RUN, "[…]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A slash command or a bare acknowledgement recalls only noise and costs an embedding. */
export function shouldRecall(prompt) {
  const raw = String(prompt ?? "").trim();
  if (raw === "" || raw.startsWith("/")) return false;
  return countTokens(stripNoise(raw)) >= MIN_QUERY_TOKENS;
}

/** Head-clip: the start of a prompt carries the intent, the tail carries detail. */
export function buildQuery(prompt, maxChars = QUERY_MAX_CHARS) {
  return stripNoise(prompt).slice(0, maxChars).trim();
}

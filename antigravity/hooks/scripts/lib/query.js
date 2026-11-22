import { QUERY_MAX_CHARS, MIN_QUERY_TOKENS } from "./constants.js";

/** Tags whose inner content AND brackets should be completely discarded. */
const NOISE_TAGS = [
  "ADDITIONAL_METADATA",
  "USER_SETTINGS_CHANGE",
  "system-reminder",
  "ide_selection",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-caveat",
  "everos_memory",
  "everos_profile",
  "attachment",
  "function_results",
  "tool_result",
  "task-notification",
  "ide_opened_file",
];

const PAIRED_NOISE = new RegExp(`<(${NOISE_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi");
const STRAY_NOISE = new RegExp(`<\\/?(${NOISE_TAGS.join("|")})\\b[^>]*>`, "gi");
const FENCED_CODE = /```[\s\S]*?```/g;
const LONG_RUN = /\S{400,}/g;

/** Unicode CJK range pattern for token estimation without space requirement. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/** CJK characters have no spaces, so count individual CJK glyphs plus Latin word tokens. */
export function countTokens(s) {
  const text = String(s ?? "");
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.replace(CJK, " ").match(/\S+/g) ?? []).length;
  return cjk + latin;
}

/** Only host wrappers stripped. Preserves user code blocks and unwraps <USER_REQUEST>. */
export function stripHostWrappers(s) {
  return String(s ?? "")
    .replace(/<\/?USER_REQUEST>/gi, "")
    .replace(PAIRED_NOISE, "")
    .replace(STRAY_NOISE, "");
}

function foldContentNoise(text) {
  return text
    .replace(FENCED_CODE, "[code]")
    .replace(LONG_RUN, "[…]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Noise stripping for embedding retrieval query. Folds code blocks into [code]. */
export function stripNoise(s) {
  return foldContentNoise(stripHostWrappers(s));
}

/** Slash commands or bare trivial acknowledgements should skip recall. */
export function shouldRecall(prompt) {
  const stripped = stripHostWrappers(prompt).trim();
  if (stripped === "" || stripped.startsWith("/")) return false;
  return countTokens(foldContentNoise(stripped)) >= MIN_QUERY_TOKENS;
}

/** Head-clip query string: intent resides at the head, details at the tail. */
export function buildQuery(prompt, maxChars = QUERY_MAX_CHARS) {
  return stripNoise(prompt).slice(0, maxChars).trim();
}

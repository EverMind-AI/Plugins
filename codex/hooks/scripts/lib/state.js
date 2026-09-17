import fs from "node:fs";
import path from "node:path";
import { PROMPT_KEY_MAX_CHARS, STATE_MAX_PROMPT_IDS, STATE_MAX_PROMPTS, STATE_TTL_DAYS } from "./constants.js";
import { sanitizeId } from "./identity.js";

const EMPTY = () => ({ sessionId: null, projectId: null, promptIds: [], warned: false, flushed: false, prompts: {} });

function stateDir(dataDir) {
  return path.join(dataDir, "state");
}

export function statePath(dataDir, sessionId) {
  return path.join(stateDir(dataDir), `${sanitizeId(sessionId, "unknown")}.json`);
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseState(raw) {
  return {
    sessionId: typeof raw?.sessionId === "string" ? raw.sessionId : null,
    projectId: typeof raw?.projectId === "string" ? raw.projectId : null,
    promptIds: Array.isArray(raw?.promptIds) ? raw.promptIds.filter((v) => typeof v === "string") : [],
    warned: raw?.warned === true,
    flushed: raw?.flushed === true,
    // turn_id -> the prompt the host says the user typed. Codex posts its own
    // scaffolding as role:"user" too, so this is how capture tells the two
    // apart without guessing from the text.
    prompts: isPlainObject(raw?.prompts) ? raw.prompts : {},
  };
}

export function readState(dataDir, sessionId) {
  try {
    return parseState(JSON.parse(fs.readFileSync(statePath(dataDir, sessionId), "utf8")));
  } catch {
    return EMPTY();
  }
}

/**
 * Write via a temporary file and rename. Two Claude Code windows share this
 * directory, and the sweep in one can write another's file: a reader must never
 * see a half-written document, and a lost update means a turn is captured twice.
 */
function writeState(dataDir, sessionId, state) {
  const file = statePath(dataDir, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    // writeFileSync only applies mode when creating; enforce it either way.
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch {
    // This directory is a cache for dedupe and liveness, never the memory
    // itself. An unwritable one (read-only home, a full disk, a dataDir left
    // owned by root) used to throw out of touchSession - which recall calls
    // before it searches - and the hook exited 0 with nothing injected:
    // memory silently gone, no error anywhere. Degrade instead. What is lost
    // is dedupe (a re-fired Stop may store a turn twice) and the liveness
    // mtime. `/everos:status` probes this directory and says so.
  }
}

/**
 * Mark the session as alive, right now.
 *
 * pendingFlushes uses the file's mtime to tell an abandoned session from a live
 * one, but the file is otherwise written only when a turn is CAPTURED. A single
 * agentic turn can run for many minutes without one, and the sweep would then
 * force a topic boundary into the middle of a live session. Recall calls this on
 * every prompt so the mtime tracks activity rather than captures.
 */
export function touchSession(dataDir, sessionId, projectId = null) {
  const state = readState(dataDir, sessionId);
  writeState(dataDir, sessionId, { ...state, sessionId, projectId: projectId ?? state.projectId });
}

export function isStored(state, promptId) {
  return typeof promptId === "string" && state.promptIds.includes(promptId);
}

/**
 * `projectId` is recorded with the turn because the sweep that seals an
 * abandoned session may run from a later session in a different repository,
 * and flushing with the wrong project id seals the wrong partition.
 */
/**
 * Record what the user actually typed this turn.
 *
 * UserPromptSubmit is handed `prompt` verbatim. The transcript is not so clear:
 * Codex posts `<recommended_plugins>`, `<environment_context>`, AGENTS.md and
 * IDE context as role:"user" items stamped with the same turn_id. Measured over
 * 151 real sessions, 158 of 495 user-role items were scaffolding - and by
 * volume 95% of the text. Keyed on this, capture keeps the user's words and
 * drops the rest without pattern-matching the host's current vocabulary.
 *
 * Bounded: only the open turns of one session, oldest evicted.
 */
export function rememberPrompt(dataDir, sessionId, turnId, prompt) {
  if (!turnId || typeof prompt !== "string" || prompt.trim() === "") return;
  const state = readState(dataDir, sessionId);
  const prompts = { ...state.prompts, [turnId]: prompt.slice(0, PROMPT_KEY_MAX_CHARS) };
  const keys = Object.keys(prompts);
  for (const stale of keys.slice(0, Math.max(0, keys.length - STATE_MAX_PROMPTS))) delete prompts[stale];
  writeState(dataDir, sessionId, { ...state, sessionId, prompts });
}

export function markStored(dataDir, sessionId, promptId, projectId = null) {
  const state = readState(dataDir, sessionId);
  if (isStored(state, promptId)) return;
  state.promptIds = [...state.promptIds, promptId].slice(-STATE_MAX_PROMPT_IDS);
  // A new turn reopens the session: whatever was flushed before is now stale.
  writeState(dataDir, sessionId, {
    ...state,
    sessionId,
    projectId: projectId ?? state.projectId,
    flushed: false,
  });
}

export function markFlushed(dataDir, sessionId) {
  const state = readState(dataDir, sessionId);
  writeState(dataDir, sessionId, { ...state, sessionId, flushed: true });
}

/**
 * Sessions whose tail was never sealed.
 *
 * Claude Code cancels the SessionEnd hook when the host exits in a hurry -
 * routine under `claude -p` - which leaves the turns after EverOS's last topic
 * boundary sitting in the buffer, never extracted. The next session sweeps them
 * up rather than leaving a silent gap. Only sessions untouched for `idleMs` are
 * eligible, so a session running in another window is never sealed underneath it.
 */
export function pendingFlushes(dataDir, idleMs) {
  const dir = stateDir(dataDir);
  const cutoff = Date.now() - idleMs;
  const pending = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return pending; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      // mtimeMs carries sub-millisecond precision and can read as marginally
      // ahead of Date.now(), which would make a just-written file look like the
      // future. Floor it so idleMs = 0 means "no idle requirement".
      if (Math.floor(fs.statSync(file).mtimeMs) > cutoff) continue;
      const state = parseState(JSON.parse(fs.readFileSync(file, "utf8")));
      if (state.flushed || state.promptIds.length === 0) continue;
      if (state.sessionId) pending.push({ sessionId: state.sessionId, projectId: state.projectId });
    } catch { /* unreadable or racing; skip */ }
  }
  return pending;
}

/** True at most once per session: the caller may print an "EverOS is down" line. */
export function claimWarning(dataDir, sessionId) {
  const state = readState(dataDir, sessionId);
  if (state.warned) return false;
  writeState(dataDir, sessionId, { ...state, sessionId, warned: true });
  return true;
}

/** Sessions end without telling us; sweep the leftovers on SessionEnd. */
export function pruneState(dataDir, ttlDays = STATE_TTL_DAYS) {
  const dir = stateDir(dataDir);
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed += 1; }
    } catch { /* raced with another window; nothing to do */ }
  }
  return removed;
}

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  APP_ID,
  STATE_MAX_PROMPT_IDS,
  STATE_TTL_DAYS,
  NTFS_RETRY_COUNT,
  NTFS_RETRY_DELAY_MS,
  STALE_SWEEP_MINUTES,
} from "./constants.js";

/**
 * Perform synchronous backoff sleep for EBUSY/EPERM retries on Windows.
 * Uses Atomics.wait if possible, with a busy-spin fallback.
 *
 * @param {number} delayMs
 */
function syncSleep(delayMs) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  } catch {
    const start = Date.now();
    while (Date.now() - start < delayMs) {
      /* spin wait fallback */
    }
  }
}

/**
 * Atomically write a file via a temporary sibling and rename.
 * On Windows, handles transient file locks (EBUSY / EPERM) from antivirus
 * or indexers with bounded retries and backoff.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {number} [retries=3]
 * @param {number} [retryDelayMs=10]
 */
export function atomicWriteFileSync(filePath, content, retries = NTFS_RETRY_COUNT, retryDelayMs = NTFS_RETRY_DELAY_MS) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const randomPart = Math.random().toString(36).slice(2, 10);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomPart}.tmp`;

  fs.writeFileSync(tmpPath, content, { encoding: "utf8" });

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastError = err;
      if (
        (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES") &&
        attempt < retries
      ) {
        syncSleep(retryDelayMs);
        continue;
      }
      break;
    }
  }

  // Best-effort cleanup on failure
  try {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  } catch {
    /* ignore cleanup failure */
  }

  throw lastError;
}

/**
 * Sanitize session id to produce a safe filename.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function getSessionFilePath(dataDir, sessionId) {
  const rawId = String(sessionId || "default");
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const hash = createHash("sha1").update(rawId).digest("hex").slice(0, 8);
  return path.join(dataDir, `session_${safeId}_${hash}.json`);
}

/**
 * Construct a clean default session state object.
 *
 * @param {string} sessionId
 * @param {Record<string, unknown>} [defaults={}]
 * @returns {Record<string, unknown>}
 */
export function createDefaultSessionState(sessionId, defaults = {}) {
  const now = Date.now();
  return {
    session_id: String(sessionId || ""),
    app_id: defaults.app_id ?? defaults.appId ?? APP_ID,
    project_id: defaults.project_id ?? defaults.projectId ?? "",
    branch: defaults.branch ?? "",
    user_id: defaults.user_id ?? defaults.userId ?? "",
    agent_id: defaults.agent_id ?? defaults.agentId ?? "antigravity",
    created_at: defaults.created_at ?? now,
    updated_at: now,
    has_injected_profile: Boolean(defaults.has_injected_profile),
    recalled_turn_ids: Array.isArray(defaults.recalled_turn_ids)
      ? [...defaults.recalled_turn_ids]
      : [],
    observed_turn_index: Number.isFinite(defaults.observed_turn_index)
      ? defaults.observed_turn_index
      : -1,
    settled_turn_index: Number.isFinite(defaults.settled_turn_index)
      ? defaults.settled_turn_index
      : -1,
    flushed: Boolean(defaults.flushed),
    flush_attempts: Number.isFinite(defaults.flush_attempts)
      ? defaults.flush_attempts
      : 0,
    flush_abandoned: Boolean(defaults.flush_abandoned),
    pending_batch: defaults.pending_batch ?? null,
    last_read_byte_offset: Number.isFinite(defaults.last_read_byte_offset)
      ? defaults.last_read_byte_offset
      : 0,
  };
}

/**
 * Load state for a given session. If not found or malformed, returns default state.
 *
 * @param {string} dataDir
 * @param {string} sessionId
 * @param {Record<string, unknown>} [defaults={}]
 * @returns {Record<string, unknown>}
 */
export function loadSessionState(dataDir, sessionId, defaults = {}) {
  const filePath = getSessionFilePath(dataDir, sessionId);
  try {
    if (!fs.existsSync(filePath)) {
      return createDefaultSessionState(sessionId, defaults);
    }
    const raw = fs.readFileSync(filePath, { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    return {
      ...createDefaultSessionState(sessionId, defaults),
      ...parsed,
      recalled_turn_ids: Array.isArray(parsed.recalled_turn_ids)
        ? parsed.recalled_turn_ids
        : [],
    };
  } catch (err) {
    try {
      process.stderr.write(`[state] loadSessionState warning: ${err?.message || err}\n`);
    } catch {
      /* ignore */
    }
    return createDefaultSessionState(sessionId, defaults);
  }
}

export const SESSIONS_INDEX_FILE = "sessions_index.json";

function loadSessionsIndex(dataDir) {
  const indexPath = path.join(dataDir, SESSIONS_INDEX_FILE);
  try {
    if (!fs.existsSync(indexPath)) return null;
    const raw = fs.readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveSessionsIndex(dataDir, indexObj) {
  const indexPath = path.join(dataDir, SESSIONS_INDEX_FILE);
  try {
    atomicWriteFileSync(indexPath, JSON.stringify(indexObj, null, 2));
  } catch {
    // Fail-open
  }
}

/**
 * Persist state object atomically. Automatically stamps updated_at.
 *
 * @param {string} dataDir
 * @param {Record<string, unknown>} state
 * @returns {Record<string, unknown>}
 */
export function saveSessionState(dataDir, state) {
  if (!state || typeof state !== "object") {
    throw new TypeError("State must be an object");
  }
  state.updated_at = Date.now();

  const filePath = getSessionFilePath(dataDir, state.session_id);

  // Merge-on-write: reload from disk if file exists to perform monotonic merge
  let merged = state;
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const onDisk = JSON.parse(raw);
      if (onDisk && typeof onDisk === "object") {
        merged = {
          ...onDisk,
          ...state,
          recalled_turn_ids: [
            ...new Set([
              ...(Array.isArray(onDisk.recalled_turn_ids) ? onDisk.recalled_turn_ids : []),
              ...(Array.isArray(state.recalled_turn_ids) ? state.recalled_turn_ids : []),
            ]),
          ],
          observed_turn_index: Math.max(
            Number.isFinite(onDisk.observed_turn_index) ? onDisk.observed_turn_index : -1,
            Number.isFinite(state.observed_turn_index) ? state.observed_turn_index : -1
          ),
          settled_turn_index: Math.max(
            Number.isFinite(onDisk.settled_turn_index) ? onDisk.settled_turn_index : -1,
            Number.isFinite(state.settled_turn_index) ? state.settled_turn_index : -1
          ),
          last_read_byte_offset: Math.max(
            Number.isFinite(onDisk.last_read_byte_offset) ? onDisk.last_read_byte_offset : 0,
            Number.isFinite(state.last_read_byte_offset) ? state.last_read_byte_offset : 0
          ),
          flushed: Boolean(onDisk.flushed || state.flushed),
          flush_attempts: Math.max(
            Number.isFinite(onDisk.flush_attempts) ? onDisk.flush_attempts : 0,
            Number.isFinite(state.flush_attempts) ? state.flush_attempts : 0
          ),
          flush_abandoned: Boolean(onDisk.flush_abandoned || state.flush_abandoned),
          has_injected_profile: Boolean(onDisk.has_injected_profile || state.has_injected_profile),
          pending_batch: state.pending_batch !== undefined ? state.pending_batch : (onDisk.pending_batch ?? null),
          updated_at: state.updated_at,
        };
      }
    }
  } catch {
    // If disk read or parse fails, proceed with in-memory state
  }

  try {
    atomicWriteFileSync(filePath, JSON.stringify(merged, null, 2));
  } catch (writeErr) {
    try {
      process.stderr.write(`[state] saveSessionState write error: ${writeErr?.message || writeErr}\n`);
    } catch {
      /* ignore */
    }
  }

  // Maintain lightweight active unflushed session index
  try {
    let indexObj = loadSessionsIndex(dataDir);
    if (!indexObj) {
      indexObj = { version: 1, sessions: {} };
    }
    if (merged.flushed === true || merged.flush_abandoned === true) {
      delete indexObj.sessions[merged.session_id];
    } else {
      indexObj.sessions[merged.session_id] = {
        session_id: merged.session_id,
        project_id: merged.project_id || "",
        flushed: false,
        flush_attempts: merged.flush_attempts || 0,
        updated_at: merged.updated_at,
      };
    }
    saveSessionsIndex(dataDir, indexObj);
  } catch {
    // Fail-open
  }

  Object.assign(state, merged);
  return state;
}

/**
 * Advance observed turn index (2PC Phase 1: Observation).
 *
 * @param {Record<string, unknown>} state
 * @param {number} turnIndex
 */
export function markObserved(state, turnIndex) {
  if (typeof turnIndex === "number" && Number.isFinite(turnIndex)) {
    state.observed_turn_index = Math.max(state.observed_turn_index ?? -1, turnIndex);
  }
  return state;
}

/**
 * Advance settled turn index (2PC Phase 2: Settlement on HTTP 200).
 *
 * @param {Record<string, unknown>} state
 * @param {number} turnIndex
 */
export function markSettled(state, turnIndex) {
  if (typeof turnIndex === "number" && Number.isFinite(turnIndex)) {
    state.settled_turn_index = Math.max(state.settled_turn_index ?? -1, turnIndex);
  }
  return state;
}

/**
 * Set flushed flag on session state (Only on HTTP 200 Ack).
 *
 * @param {Record<string, unknown>} state
 * @param {boolean} [flushed=true]
 */
export function markFlushed(state, flushed = true) {
  state.flushed = Boolean(flushed);
  return state;
}

/**
 * Mark a turn as recalled to prevent redundant duplicate recalls within the same turn.
 *
 * @param {Record<string, unknown>} state
 * @param {string} turnId
 */
export function markRecalled(state, turnId) {
  if (turnId && typeof turnId === "string") {
    if (!Array.isArray(state.recalled_turn_ids)) {
      state.recalled_turn_ids = [];
    }
    if (!state.recalled_turn_ids.includes(turnId)) {
      state.recalled_turn_ids.push(turnId);
      if (state.recalled_turn_ids.length > STATE_MAX_PROMPT_IDS) {
        state.recalled_turn_ids.splice(
          0,
          state.recalled_turn_ids.length - STATE_MAX_PROMPT_IDS
        );
      }
    }
  }
  return state;
}

/**
 * Mark whether the L1 profile has been successfully injected into context.
 *
 * @param {Record<string, unknown>} state
 * @param {boolean} [injected=true]
 */
export function markProfileInjected(state, injected = true) {
  state.has_injected_profile = Boolean(injected);
  return state;
}

/**
 * Scan data directory for sessions that are unflushed and have been idle
 * longer than staleThresholdMs. Used by SessionStart for 2PC compensation.
 *
 * @param {string} dataDir
 * @param {number} [staleThresholdMs=1800000] // 30 minutes default
 * @returns {Array<Record<string, unknown>>}
 */
export function listStaleSessions(dataDir, staleThresholdMs = STALE_SWEEP_MINUTES * 60 * 1000) {
  try {
    if (!fs.existsSync(dataDir)) {
      return [];
    }
    const now = Date.now();
    const stale = [];

    const files = fs.readdirSync(dataDir);
    let indexObj = loadSessionsIndex(dataDir);
    if (!indexObj || typeof indexObj.sessions !== "object") {
      indexObj = { version: 1, sessions: {} };
    }

    let indexDirty = false;
    const diskSessionIds = new Set();

    for (const file of files) {
      if (!file.startsWith("session_") || !file.endsWith(".json") || file === "sessions_index.json") continue;
      try {
        const fullPath = path.join(dataDir, file);
        const raw = fs.readFileSync(fullPath, { encoding: "utf8" });
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.session_id) {
          diskSessionIds.add(parsed.session_id);
          if (!indexObj.sessions[parsed.session_id]) {
            indexObj.sessions[parsed.session_id] = {
              session_id: parsed.session_id,
              project_id: parsed.project_id || "",
              flushed: Boolean(parsed.flushed),
              updated_at: parsed.updated_at || 0,
            };
            indexDirty = true;
          }
        }
      } catch {
        // Skip corrupt file
      }
    }

    // Check sessions recorded in index (fast-path: skips all flushed sessions)
    for (const [sid, item] of Object.entries(indexObj.sessions)) {
      // If file deleted from disk, remove from index
      if (!diskSessionIds.has(sid)) {
        delete indexObj.sessions[sid];
        indexDirty = true;
        continue;
      }

      if (item.flushed === true) {
        continue;
      }

      // It's unflushed: load its full state to check staleness
      const fullState = loadSessionState(dataDir, sid);
      if (!fullState || fullState.flushed === true || fullState.flush_abandoned === true) {
        if (item.flushed !== true && fullState?.flushed === true) {
          item.flushed = true;
          indexDirty = true;
        }
        continue;
      }

      const age = now - (fullState.updated_at || 0);
      const hasUnsettledDebt = (fullState.observed_turn_index ?? -1) > (fullState.settled_turn_index ?? -1);
      if (age >= staleThresholdMs || hasUnsettledDebt) {
        stale.push(fullState);
      }
    }

    if (indexDirty) {
      saveSessionsIndex(dataDir, indexObj);
    }

    return stale;
  } catch (err) {
    try {
      process.stderr.write(`[state] listStaleSessions warning: ${err?.message || err}\n`);
    } catch {
      /* ignore */
    }
    return [];
  }
}

/**
 * Cleanup expired session state files that are older than ttlDays (default 30 days).
 *
 * @param {string} dataDir
 * @param {number} [ttlDays=30]
 * @returns {number} count of deleted files
 */
export function cleanupExpiredSessions(dataDir, ttlDays = STATE_TTL_DAYS) {
  try {
    if (!fs.existsSync(dataDir)) return 0;
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removedCount = 0;
    const files = fs.readdirSync(dataDir);
    const indexObj = loadSessionsIndex(dataDir);
    let indexDirty = false;

    for (const file of files) {
      if (!file.startsWith("session_") || !file.endsWith(".json") || file === "sessions_index.json") continue;
      const fullPath = path.join(dataDir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > ttlMs) {
          // Never delete unflushed session drafts: protect long-running branches!
          const raw = fs.readFileSync(fullPath, "utf8");
          const state = JSON.parse(raw);
          if (state && state.flushed === true) {
            fs.unlinkSync(fullPath);
            removedCount++;
            if (indexObj?.sessions?.[state.session_id]) {
              delete indexObj.sessions[state.session_id];
              indexDirty = true;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (indexDirty && indexObj) {
      saveSessionsIndex(dataDir, indexObj);
    }
    return removedCount;
  } catch {
    return 0;
  }
}

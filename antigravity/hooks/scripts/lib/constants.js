/** Every tunable in one place. Nothing here is user-configurable; see lib/config.js for what is. */

/** Cross-host partition on the EverOS side. One EverOS serves OpenClaw, Hermes, Claude Code, Codex, and us. */
export const APP_ID = "antigravity";
/** Agent-track identity. Cases and skills land under agents/<AGENT_ID>/. */
export const AGENT_ID = "antigravity";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

export const HEALTH_TIMEOUT_MS = 2000;
export const START_WAIT_MS = 5000;
export const START_POLL_MS = 500;

/**
 * Recall budget. A warm search is 0.3-0.8s; what it buys is the tail.
 * Two of the first live sessions might lose their opening recall to a tight budget.
 * Clamped between 500ms and 7000ms. Override with EVEROS_AG_RECALL_TIMEOUT_MS.
 */
export const RECALL_DEADLINE_MS = 5000;
export const RECALL_DEADLINE_MIN_MS = 500;
export const RECALL_DEADLINE_MAX_MS = 7000;
export const CAPTURE_DEADLINE_MS = 20000;

/**
 * Timeout budget for synchronous flush requests to complete LLM extraction.
 * In background detached mode, this timeout provides ample room (120s) for
 * full Episode extraction and Markdown persistence.
 */
export const FLUSH_TIMEOUT_MS = 120000;
export const FLUSH_DISPATCH_MS = FLUSH_TIMEOUT_MS;

/**
 * Max items per section in the injected ephemeral block.
 * L2 ephemeral recall injects Top-3 memories to prevent context bloat.
 */
export const SECTION_MAX_ITEMS = 3;

export const ID_MAX_LEN = 128;
export const ADD_MAX_MESSAGES = 500;
export const TOOL_RESULT_MAX_CHARS = 20000;
export const QUERY_MAX_CHARS = 500;
export const MIN_QUERY_TOKENS = 3;

export const STATE_MAX_PROMPT_IDS = 200;
export const STATE_TTL_DAYS = 30;
export const STALE_SWEEP_MINUTES = 30;

export const TRANSCRIPT_READ_ATTEMPTS = 10;
export const TRANSCRIPT_READ_DELAY_MS = 200;

/** Windows NTFS resilience: retry on EBUSY/EPERM with backoff. */
export const NTFS_RETRY_COUNT = 3;
export const NTFS_RETRY_DELAY_MS = 10;

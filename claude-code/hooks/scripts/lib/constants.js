/** Every tunable in one place. Nothing here is user-configurable; see lib/config.js for what is. */

/** Cross-host partition on the EverOS side. One EverOS serves OpenClaw, Hermes and us. */
export const APP_ID = "claude-code";
/** Agent-track identity. Cases and skills land under agents/<AGENT_ID>/. */
export const AGENT_ID = "claude-code";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

export const HEALTH_TIMEOUT_MS = 2000;
export const START_WAIT_MS = 5000;
export const START_POLL_MS = 500;

/**
 * Recall budget. A warm search is 0.3-0.8s, so this is almost never spent; what
 * it buys is the tail. Two of the first three live sessions lost their opening
 * recall to a 3s budget, and a timed-out recall costs the whole feature for that
 * turn while a slow one costs a moment. Override with EVEROS_CC_RECALL_TIMEOUT_MS.
 *
 * The maximum is 7s, not 10s: resolving the project id runs up to two git
 * subprocesses at 1s each BEFORE this deadline starts, and the whole hook must
 * finish inside the 10s UserPromptSubmit timeout in hooks.json.
 */
export const RECALL_DEADLINE_MS = 5000;
export const RECALL_DEADLINE_MIN_MS = 500;
export const RECALL_DEADLINE_MAX_MS = 7000;
export const CAPTURE_DEADLINE_MS = 20000;
/**
 * How long a seal waits for its answer - not how long the seal takes.
 *
 * A flush with real content runs a full LLM extraction and takes about 5s, but
 * the host gives a session-end hook roughly 4s before it stops waiting and
 * prints "Hook cancelled" (measured: 4.1s from /exit to process exit in an
 * interactive terminal, and the same in `claude -p`). Waiting for the answer
 * therefore loses the race almost every time there is anything to seal.
 *
 * There is nothing to wait for: verified against a live 1.3.1 that EverOS
 * completes the extraction and writes the markdown even when the client
 * disconnects 0.3s into the request. So the hook only needs the request to
 * leave the machine.
 */
export const FLUSH_DISPATCH_MS = 1500;

export const SECTION_MAX_ITEMS = 5;
export const ID_MAX_LEN = 128;
export const ADD_MAX_MESSAGES = 500;
export const TOOL_RESULT_MAX_CHARS = 20000;
export const QUERY_MAX_CHARS = 500;
export const MIN_QUERY_TOKENS = 3;

export const STATE_MAX_PROMPT_IDS = 200;
export const STATE_TTL_DAYS = 30;

// The closing assistant entry lands a fraction of a second after Stop fires,
// so this budget (10 x 200ms = 2s) has to outlast that flush. It sits well
// inside the 20s capture deadline and the 30s host hook timeout.
export const TRANSCRIPT_READ_ATTEMPTS = 10;
export const TRANSCRIPT_READ_DELAY_MS = 200;

import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  TOOL_RESULT_MAX_CHARS,
  TRANSCRIPT_READ_ATTEMPTS,
  TRANSCRIPT_READ_DELAY_MS,
} from "./constants.js";
import { stripInjectedMemory } from "./render.js";

/**
 * Codex writes one JSONL rollout per session under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`, and hands
 * the path to every hook as `transcript_path`.
 *
 * Every line is `{timestamp, ordinal, type, payload}`. Only `response_item`
 * carries conversation; `event_msg` repeats it for the UI, and re-reading those
 * would post every message twice.
 */
export function parseTranscript(text) {
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A half-written last line is normal while the host is still flushing.
    }
  }
  return entries;
}

/**
 * Codex stamps the turn on the item itself, so a turn is a filter rather than a
 * range.
 *
 * The Claude Code plugin has to find the first entry of a turn and guess where
 * it ends, which produced two defects there: a queued prompt landed in the
 * previous turn, and the closing assistant entry arrived after the slice was
 * taken. Neither is representable here.
 */
export function turnIdOf(entry) {
  const payload = entry?.payload;
  const stamped = payload?.internal_chat_message_metadata_passthrough?.turn_id;
  if (typeof stamped === "string" && stamped !== "") return stamped;
  // turn_context announces a turn without being part of the conversation.
  const own = payload?.turn_id;
  return typeof own === "string" && own !== "" ? own : null;
}

export function sliceTurn(entries, turnId) {
  if (!turnId) return [];
  return entries.filter((e) => e?.type === "response_item" && turnIdOf(e) === turnId);
}

/** The id of the last turn on disk, for a Stop that arrived without one. */
export function lastTurnId(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const id = turnIdOf(entries[i]);
    if (id) return id;
  }
  return null;
}

export function truncateMiddle(text, max, headRatio = 0.7) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * headRatio);
  const tail = max - head;
  const cut = s.length - max;
  return `${s.slice(0, head)}\n[... trimmed ${cut} chars by the EverOS Codex plugin ...]\n${s.slice(s.length - tail)}`;
}

/** `{type: "input_text"|"output_text", text}` blocks, or a bare string. */
function textOfBlocks(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function millis(entry, fallback) {
  const raw = entry?.timestamp;
  const parsed = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * One turn of a Codex session as EverOS messages.
 *
 * What is deliberately dropped, and why each one matters:
 *
 * - `role: "developer"`. Codex puts its own instructions, the environment
 *   block and its built-in memories there. Across 25 real sessions these
 *   outnumbered actual user messages 174 to 74: store them and 70% of what the
 *   library holds as "what the user said" is the host talking to itself.
 * - `reasoning`. The payload is `encrypted_content` - there is nothing to store
 *   even if we wanted it.
 * - `event_msg`. The UI echo of a message that is already a `response_item`.
 */
/**
 * Shapes Codex posts as role:"user" that the user did not type.
 *
 * Only reached when the prompt for this turn was not recorded - a session that
 * started before this plugin, or one where UserPromptSubmit did not run. It is
 * a fallback, and it is written to fail toward keeping: a stored line of host
 * scaffolding is noise, a dropped line of the user's own words is a loss.
 */
const HOST_AUTHORED = [
  /^<[a-z_][\w-]*[\s>]/i, // <recommended_plugins>, <environment_context>, <codex_internal_context …>
  /^#\s*AGENTS\.md instructions for /i,
  /^#\s*Context from my IDE setup:/i,
];

function looksHostAuthored(text) {
  return HOST_AUTHORED.some((re) => re.test(text));
}

/**
 * Is this the user's own message?
 *
 * `userPrompt` is what UserPromptSubmit was handed, so when it is present this
 * is a lookup rather than a judgement. Compared on a prefix because the host
 * appends its own context to the same item often enough to matter.
 */
function isUserSpeech(text, userPrompt) {
  if (typeof userPrompt !== "string" || userPrompt.trim() === "") return !looksHostAuthored(text);
  const key = userPrompt.trim().slice(0, 200);
  return text.includes(key);
}

export function toEverosMessages(entries, { userId, agentId, userPrompt }) {
  const messages = [];
  const openResults = new Map(); // call_id -> the one tool row for that call
  let previousTs = Date.now();

  for (const entry of entries) {
    if (entry?.type !== "response_item") continue;
    const payload = entry.payload ?? {};
    const ts = millis(entry, previousTs);
    previousTs = ts;

    if (payload.type === "message") {
      if (payload.role === "user") {
        // role:"user" is not "the user wrote this". Codex posts its plugin
        // catalogue, the environment block, AGENTS.md and IDE context under the
        // same role and the same turn_id - 158 of 495 user-role items across
        // 151 real sessions, and 95% of the text by volume.
        const text = stripInjectedMemory(textOfBlocks(payload.content)).trim();
        if (!text || !isUserSpeech(text, userPrompt)) continue;
        messages.push({ sender_id: userId, role: "user", timestamp: ts, content: text });
      } else if (payload.role === "assistant") {
        const text = textOfBlocks(payload.content);
        if (!text) continue;
        messages.push({ sender_id: agentId, role: "assistant", timestamp: ts, content: text });
      }
      continue; // developer and anything else: not conversation.
    }

    if (payload.type === "custom_tool_call") {
      if (!payload.call_id || !payload.name) continue;
      // `input` is already a serialized string on the wire, which is exactly
      // what EverOS wants for `function.arguments`.
      messages.push({
        sender_id: agentId,
        role: "assistant",
        timestamp: ts,
        content: "",
        tool_calls: [
          {
            id: payload.call_id,
            type: "function",
            function: {
              name: String(payload.name),
              arguments: typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input ?? {}),
            },
          },
        ],
      });
      continue;
    }

    if (payload.type === "custom_tool_call_output") {
      if (!payload.call_id) continue;
      const text = textOfBlocks(payload.output);
      // One call can emit several output items: a long-running `exec` posted 16
      // for a single call, every one of them empty. Collapse them onto the first
      // row for that call rather than storing a call answered sixteen times.
      const open = openResults.get(payload.call_id);
      if (open) {
        if (text) open.content = [open.content, text].filter(Boolean).join("\n");
        continue;
      }
      const message = {
        sender_id: agentId,
        role: "tool",
        timestamp: ts,
        content: text,
        tool_call_id: payload.call_id,
      };
      openResults.set(payload.call_id, message);
      messages.push(message);
      continue;
    }
  }

  for (const message of openResults.values()) {
    message.content = truncateMiddle(message.content, TOOL_RESULT_MAX_CHARS);
  }

  // A tool result whose call is not in this turn is an answer with no question.
  // EverOS rejects role="tool" without a tool_call_id outright; an orphan one it
  // accepts but everalgo then sees a result for a request it never saw.
  const known = new Set();
  const kept = [];
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) known.add(call.id);
    if (message.role === "tool" && !known.has(message.tool_call_id)) continue;
    kept.push(message);
  }
  return kept;
}

/**
 * A turn is finished once its closing assistant message is on disk. Stop fires
 * the moment the turn ends and the host is still flushing, so "the turn id
 * exists" is not "the reply is readable" - waiting only for the id is what lost
 * every assistant reply in the Claude Code plugin until it was measured.
 */
function looksComplete(turn) {
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const payload = turn[i]?.payload ?? {};
    if (payload.type === "message" && payload.role === "assistant") return true;
    // A turn that ended in a tool call is still in flight.
    if (payload.type === "message" && payload.role === "user") return false;
  }
  return false;
}

/**
 * Read the transcript, retrying until the turn reads as finished. An interrupted
 * turn may never get its closing message, so after the last attempt we capture
 * whatever is there rather than dropping the turn.
 */
export async function readTurn(filePath, turnId, options = {}) {
  const attempts = options.attempts ?? TRANSCRIPT_READ_ATTEMPTS;
  const delayMs = options.delayMs ?? TRANSCRIPT_READ_DELAY_MS;
  let latest = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      text = "";
    }
    const turn = sliceTurn(parseTranscript(text), turnId);
    if (turn.length > latest.length) latest = turn;
    if (looksComplete(turn)) return turn;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return latest;
}

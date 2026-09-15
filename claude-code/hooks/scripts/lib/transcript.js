import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  TOOL_RESULT_MAX_CHARS,
  TRANSCRIPT_READ_ATTEMPTS,
  TRANSCRIPT_READ_DELAY_MS,
} from "./constants.js";
import { stripInjectedMemory } from "./render.js";
import { stripHostWrappers } from "./query.js";

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
 * Every entry belonging to one turn repeats the same promptId - the opening user
 * entry, each tool-result carrier, each injected meta entry. Assistant entries
 * carry none, so they are picked up by position.
 *
 * The slice runs from the FIRST entry with this promptId to the entry before the
 * next DIFFERENT promptId, not to end of file: Claude Code lets the user queue a
 * prompt mid-turn, so the following turn can already be on disk when Stop fires.
 * Subagent traffic is dropped throughout.
 */
export function sliceTurn(entries, promptId) {
  const start = entries.findIndex((e) => e?.promptId === promptId);
  if (start === -1) return [];
  let end = entries.length;
  for (let i = start + 1; i < entries.length; i += 1) {
    const id = entries[i]?.promptId;
    if (id !== undefined && id !== null && id !== promptId) { end = i; break; }
  }
  return entries.slice(start, end).filter((e) => e?.isSidechain !== true);
}

export function truncateMiddle(text, max, headRatio = 0.7) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * headRatio);
  const tail = max - head;
  const cut = s.length - max;
  return `${s.slice(0, head)}\n[... trimmed ${cut} chars by the EverOS Claude Code plugin ...]\n${s.slice(s.length - tail)}`;
}

function blocksOf(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(blocks) {
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

/**
 * tool_result content is a string, or a list of blocks that are usually text
 * but not always: real transcripts also carry `tool_reference` and `image`
 * blocks, and 206 results in this machine's history have no text block at all.
 * Those become a typed placeholder rather than an empty row, so the trajectory
 * still records that something came back.
 */
function toolResultText(block) {
  const raw = block?.content;
  let text;
  if (typeof raw === "string") {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .map((b) => {
        if (typeof b === "string") return b;
        if (typeof b?.text === "string" && b.text !== "") return b.text;
        return b?.type ? `[${b.type}]` : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  } else {
    text = "";
  }
  const flagged = block?.is_error ? `[tool error] ${text}` : text;
  return truncateMiddle(flagged, TOOL_RESULT_MAX_CHARS);
}

function millis(entry, previous) {
  const parsed = Date.parse(entry?.timestamp ?? "");
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return previous + 1;
}

export function toEverosMessages(entries, { userId, agentId }) {
  const messages = [];
  let previousTs = Date.now();
  let openAssistant = null; // merges consecutive entries sharing a requestId

  const closeAssistant = () => { openAssistant = null; };

  for (const entry of entries) {
    const ts = millis(entry, previousTs);
    previousTs = ts;

    if (entry?.type === "assistant") {
      const blocks = blocksOf(entry);
      const text = textOf(blocks);
      const calls = blocks
        .filter((b) => b?.type === "tool_use" && b.id && b.name)
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      if (!text && calls.length === 0) continue; // thinking-only entry

      const sameTurn = openAssistant && entry.requestId && openAssistant.requestId === entry.requestId;
      if (sameTurn) {
        if (text) {
          openAssistant.message.content = [openAssistant.message.content, text].filter(Boolean).join("\n\n");
        }
        if (calls.length) {
          openAssistant.message.tool_calls = [...(openAssistant.message.tool_calls ?? []), ...calls];
        }
        continue;
      }
      const message = { sender_id: agentId, role: "assistant", timestamp: ts, content: text };
      if (calls.length) message.tool_calls = calls;
      messages.push(message);
      openAssistant = entry.requestId ? { requestId: entry.requestId, message } : null;
      continue;
    }

    if (entry?.type === "user") {
      const blocks = blocksOf(entry);
      const results = blocks.filter((b) => b?.type === "tool_result" && b.tool_use_id);
      if (results.length) {
        closeAssistant();
        for (const block of results) {
          messages.push({
            sender_id: agentId,
            role: "tool",
            timestamp: ts,
            content: toolResultText(block),
            tool_call_id: block.tool_use_id,
          });
        }
        continue;
      }
      // A real prompt always carries promptSource ("typed" in a terminal, "sdk"
      // from the IDE). Anything else here is a skill injection, slash-command
      // scaffolding or a caveat preamble - noise the user never wrote.
      if (!entry.promptSource) continue;
      // promptSource is NOT "the user typed this": the host sets it on its own
      // wrappers too (task notifications, IDE file events). Measured on 12 real
      // transcripts, 412 of 1636 such entries - 25% - were pure host wrapper,
      // the largest 40 KB, all of it posted as if the user had said it.
      const text = stripInjectedMemory(stripHostWrappers(textOf(blocks))).trim();
      if (!text) continue;
      closeAssistant();
      messages.push({ sender_id: userId, role: "user", timestamp: ts, content: text });
      continue;
    }
    // attachment / system / queue-operation / file-history / ai-title: not conversation.
  }

  // Drop a tool result whose call is not in this turn: it is an answer with no
  // question, and everalgo would get a ToolCallResult whose request it never saw.
  //
  // NOT an EverOS requirement - verified against a live 1.3.1: an orphan row with
  // a non-null tool_call_id is accepted and extracts fine. What EverOS actually
  // rejects is role="tool" with NO tool_call_id (_boundary.py:354 raises
  // ValueError, surfacing as a 500), and the filter above already makes that
  // unrepresentable. Across 3407 real turns this drops 26 of 26081 tool rows.
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
 * A turn is finished once its closing assistant entry is on disk. Stop fires the
 * moment the turn ends and the host is still flushing, so "the prompt id exists"
 * is not the same as "the reply is readable": waiting only for the id captured
 * the user message alone and silently lost every assistant reply.
 */
function looksComplete(turn) {
  const conversational = turn.filter((e) => e?.type === "user" || e?.type === "assistant");
  return conversational.length > 0 && conversational.at(-1).type === "assistant";
}

/**
 * Read the transcript, retrying until the turn reads as finished. An interrupted
 * turn may never get its closing entry, so after the last attempt we capture
 * whatever is there rather than dropping the turn.
 */
/** The id of the last turn on disk, for a Stop that arrived without one. */
export function lastPromptId(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const id = entries[i]?.promptId;
    if (typeof id === "string" && id !== "" && entries[i]?.isSidechain !== true) return id;
  }
  return null;
}

export async function readTurn(filePath, promptId, options = {}) {
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
    const turn = sliceTurn(parseTranscript(text), promptId);
    if (turn.length > latest.length) latest = turn;
    if (looksComplete(turn)) return turn;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return latest;
}

import fs from "node:fs";
import {
  TOOL_RESULT_MAX_CHARS,
  TRANSCRIPT_READ_ATTEMPTS,
  TRANSCRIPT_READ_DELAY_MS,
} from "./constants.js";
import { stripInjectedMemory } from "./render.js";
import { stripHostWrappers } from "./query.js";

/** Parse Antigravity transcript lines and deduplicate/update by step_index. */
export function parseAndSortTranscript(rawText) {
  const map = new Map();
  for (const line of String(rawText ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry?.step_index === "number") {
        map.set(entry.step_index, entry);
      }
    } catch {
      // tolerate half-written lines during host streaming flush
    }
  }
  return Array.from(map.values()).sort((a, b) => a.step_index - b.step_index);
}

/**
 * Read transcript safely from either a file path or a raw transcript text.
 * Retries on transient read locks (EBUSY/EPERM) when reading from disk.
 *
 * @param {string} pathOrText
 * @returns {Array<Record<string, unknown>>}
 */
export function readTranscript(pathOrText) {
  if (typeof pathOrText !== "string" || !pathOrText.trim()) {
    return [];
  }
  try {
    if (fs.existsSync(pathOrText) && fs.statSync(pathOrText).isFile()) {
      let content = "";
      for (let attempt = 0; attempt < TRANSCRIPT_READ_ATTEMPTS; attempt++) {
        try {
          content = fs.readFileSync(pathOrText, { encoding: "utf8" });
          break;
        } catch (err) {
          if (attempt === TRANSCRIPT_READ_ATTEMPTS - 1) {
            break;
          }
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TRANSCRIPT_READ_DELAY_MS);
          } catch {
            const start = Date.now();
            while (Date.now() - start < TRANSCRIPT_READ_DELAY_MS) {}
          }
        }
      }
      return parseAndSortTranscript(content);
    }
  } catch {
    /* fallback to raw text parsing */
  }
  return parseAndSortTranscript(pathOrText);
}

/**
 * Incrementally read new lines from a transcript file starting at startOffset bytes.
 * Guarantees atomic line boundaries: if a trailing line is incomplete (missing \n),
 * it is not consumed and the offset remains at the last complete newline.
 *
 * @param {string} pathOrText
 * @param {number} [startOffset=0]
 * @returns {{ entries: Array<Record<string, unknown>>, nextOffset: number }}
 */
export function readTranscriptIncremental(pathOrText, startOffset = 0) {
  const offset = typeof startOffset === "number" && startOffset >= 0 ? startOffset : 0;
  if (typeof pathOrText !== "string" || !pathOrText.trim()) {
    return { entries: [], nextOffset: offset };
  }

  // If pathOrText is not an existing file, treat as raw text
  try {
    if (!fs.existsSync(pathOrText) || !fs.statSync(pathOrText).isFile()) {
      return { entries: parseAndSortTranscript(pathOrText), nextOffset: 0 };
    }
  } catch {
    return { entries: parseAndSortTranscript(pathOrText), nextOffset: 0 };
  }

  let fd = null;
  for (let attempt = 0; attempt < TRANSCRIPT_READ_ATTEMPTS; attempt++) {
    try {
      const stat = fs.statSync(pathOrText);
      const totalSize = stat.size;

      // File was truncated or reset: rewind to 0
      const safeOffset = totalSize < offset ? 0 : offset;
      if (totalSize <= safeOffset) {
        return { entries: [], nextOffset: totalSize };
      }

      const readLength = totalSize - safeOffset;
      const buf = Buffer.alloc(readLength);
      fd = fs.openSync(pathOrText, "r");
      fs.readSync(fd, buf, 0, readLength, safeOffset);
      fs.closeSync(fd);
      fd = null;

      const rawChunk = buf.toString("utf8");
      // Find the last complete line boundary to avoid parsing half-written streaming JSON
      const lastNewlineIdx = rawChunk.lastIndexOf("\n");
      if (lastNewlineIdx === -1) {
        // No complete newline yet: do not advance offset
        return { entries: [], nextOffset: safeOffset };
      }

      const completeChunk = rawChunk.slice(0, lastNewlineIdx + 1);
      const consumedBytes = Buffer.byteLength(completeChunk, "utf8");
      const entries = parseAndSortTranscript(completeChunk);
      return { entries, nextOffset: safeOffset + consumedBytes };
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        fd = null;
      }
      if (attempt === TRANSCRIPT_READ_ATTEMPTS - 1) {
        break;
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TRANSCRIPT_READ_DELAY_MS);
      } catch {
        const start = Date.now();
        while (Date.now() - start < TRANSCRIPT_READ_DELAY_MS) {}
      }
    }
  }

  return { entries: [], nextOffset: offset };
}

/**
 * Slice one conversational turn from sorted transcript entries.
 * A turn begins at a USER_INPUT entry (identified by turnId or step_index)
 * and continues until the next USER_INPUT entry (or end of entries).
 */
export function sliceTurn(entries, targetTurnIdOrIndex) {
  let targetIndex = null;
  if (typeof targetTurnIdOrIndex === "number") {
    targetIndex = targetTurnIdOrIndex;
  } else if (typeof targetTurnIdOrIndex === "string" && targetTurnIdOrIndex.startsWith("turn_")) {
    targetIndex = Number.parseInt(targetTurnIdOrIndex.slice(5), 10);
  }

  let start = -1;
  if (targetIndex !== null && !Number.isNaN(targetIndex)) {
    start = entries.findIndex((e) => e?.step_index === targetIndex && e?.type === "USER_INPUT");
  } else {
    // If not specified or not found, find the latest explicit USER_INPUT entry
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.type === "USER_INPUT" && entries[i]?.source === "USER_EXPLICIT") {
        start = i;
        break;
      }
    }
  }

  if (start === -1) return [];

  let end = entries.length;
  for (let i = start + 1; i < entries.length; i++) {
    if (entries[i]?.type === "USER_INPUT") {
      end = i;
      break;
    }
  }

  return entries.slice(start, end);
}

/**
 * Truncate long content with head/tail preservation and standard notification.
 */
export function truncateMiddle(text, max = TOOL_RESULT_MAX_CHARS, headRatio = 0.7) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * headRatio);
  const tail = max - head;
  const cut = s.length - max;
  return `${s.slice(0, head)}\n[... trimmed ${cut} chars by the EverOS Antigravity plugin ...]\n${s.slice(s.length - tail)}`;
}

/**
 * Extract clean user prompt from Antigravity content (strips host tags like <USER_REQUEST> and metadata).
 */
export function extractUserPrompt(content) {
  const s = String(content ?? "");
  const match = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const raw = match ? match[1] : s;
  return stripHostWrappers(raw).trim();
}

function parseTs(createdAt, fallback) {
  const parsed = Date.parse(createdAt ?? "");
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback + 1;
}

/**
 * Convert Antigravity turn entries into standard EverOS v2 MessageItemDTO sequence.
 * Enforces:
 * 1. Thinking stripped from PLANNER_RESPONSE;
 * 2. invoke_subagent dimensionality reduction with case resilience;
 * 3. FIFO tool call pairing with GENERIC;
 * 4. Multi-invocation Dummy Tool Synth loop closure on user cancellation / interruption;
 * 5. Anti-recursive memory injection stripping.
 */
export function toEverosMessages(turnEntries, options = {}) {
  const { userId, agentId } = options ?? {};
  const messages = [];
  const pendingCalls = []; // FIFO queue of call IDs
  const userSender = userId ? String(userId) : "user";
  const agentSender = agentId ? String(agentId) : "antigravity";
  let previousTs = Date.now();

  for (const entry of turnEntries) {
    const ts = parseTs(entry.created_at, previousTs);
    previousTs = ts;

    // 1. User Message
    if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") {
      const rawPrompt = extractUserPrompt(entry.content);
      const cleanContent = stripInjectedMemory(rawPrompt);
      if (cleanContent) {
        messages.push({
          sender_id: userSender,
          role: "user",
          timestamp: ts,
          content: cleanContent,
        });
      }
      continue;
    }

    // 2. Assistant Response
    if (entry.type === "PLANNER_RESPONSE") {
      // Topology constraint: before pushing a new assistant turn, any unfulfilled tool calls
      // from the previous invocation MUST be closed with Dummy Tool Synth messages.
      while (pendingCalls.length > 0) {
        const orphanId = pendingCalls.shift();
        messages.push({
          sender_id: agentSender,
          role: "tool",
          tool_call_id: orphanId,
          timestamp: previousTs + 1,
          content: "[tool interrupted or canceled by user]",
        });
      }

      // Thinking chain is intentionally dropped
      const content = entry.content || "";
      const rawCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      const formattedCalls = rawCalls.map((tc, idx) => {
        const id = tc.id || `call_${entry.step_index}_${idx}`;
        const toolName = tc.name ?? tc.tool ?? tc.function?.name ?? "unknown_tool";
        let args = tc.args ?? tc.arguments ?? tc.function?.arguments ?? {};

        // Parse args if stringified JSON
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {}
        }

        // Concurrent subagent dimensionality reduction with casing resilience
        if (toolName === "invoke_subagent") {
          let role = null;
          let prompt = null;
          let subagentId = null;
          let typeName = null;
          const subs = args.Subagents ?? args.subagents;
          if (subs) {
            try {
              const parsed = typeof subs === "string" ? JSON.parse(subs) : subs;
              const first = Array.isArray(parsed) ? parsed[0] : parsed;
              role = first?.Role ?? first?.role;
              prompt = first?.Prompt ?? first?.prompt;
              subagentId =
                first?.conversationId ??
                first?.conversation_id ??
                first?.SubagentId ??
                first?.subagent_id;
              typeName = first?.TypeName ?? first?.type_name;
            } catch {}
          }
          role = role ?? args.Role ?? args.role;
          prompt = prompt ?? args.Prompt ?? args.prompt;
          subagentId =
            subagentId ??
            args.conversationId ??
            args.conversation_id ??
            args.SubagentId ??
            args.subagent_id ??
            null;
          typeName = typeName ?? args.TypeName ?? args.type_name ?? null;

          const subagentPayload = {
            subagent_role: role || "Subagent",
            prompt: prompt || "",
          };
          if (subagentId) {
            subagentPayload.subagent_id = String(subagentId);
          }
          if (typeName) {
            subagentPayload.type_name = String(typeName);
          }
          args = subagentPayload;
        }

        pendingCalls.push(id);
        return {
          id,
          type: "function",
          function: {
            name: toolName,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          },
        };
      });

      const assistantMsg = {
        sender_id: agentSender,
        role: "assistant",
        timestamp: ts,
        content,
      };
      if (formattedCalls.length > 0) {
        assistantMsg.tool_calls = formattedCalls;
      }
      messages.push(assistantMsg);
      continue;
    }

    // 3. Tool Result (GENERIC in Antigravity)
    if (entry.type === "GENERIC" && pendingCalls.length > 0) {
      const matchedCallId = pendingCalls.shift();
      const rawContent = entry.content || "";
      const content = entry.status === "ERROR" ? `[tool error] ${rawContent}` : rawContent;
      messages.push({
        sender_id: agentSender,
        role: "tool",
        tool_call_id: matchedCallId,
        timestamp: ts,
        content: truncateMiddle(content, TOOL_RESULT_MAX_CHARS),
      });
      continue;
    }
  }

  // 4. Dummy Tool Synth: close the OpenAI message chain for final interrupted/orphaned calls
  while (pendingCalls.length > 0) {
    const orphanId = pendingCalls.shift();
    messages.push({
      sender_id: agentSender,
      role: "tool",
      tool_call_id: orphanId,
      timestamp: previousTs + 1,
      content: "[tool interrupted or canceled by user]",
    });
  }

  return messages;
}

import { readStdinJson, writeStdoutJson, wrapHook } from "./lib/hook-io.js";
import { loadConfig } from "./lib/config.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient } from "./lib/everos.js";
import { CAPTURE_DEADLINE_MS, ADD_MAX_MESSAGES } from "./lib/constants.js";
import {
  loadSessionState,
  saveSessionState,
  markObserved,
  markSettled,
} from "./lib/state.js";
import {
  readTranscript,
  readTranscriptIncremental,
  toEverosMessages,
} from "./lib/transcript.js";

wrapHook(async () => {
  const input = readStdinJson();
  const transcriptPath = input.transcriptPath;
  const conversationId = String(
    input.conversationId ?? input.conversation_id ?? "default"
  ).slice(0, 128);

  if (!transcriptPath) {
    writeStdoutJson({});
    return;
  }

  const config = loadConfig();
  const cwd =
    (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) ||
    process.cwd();
  const identity = resolveIdentity(cwd, config);

  const state = loadSessionState(config.dataDir, conversationId, {
    projectId: identity.projectId,
    branch: identity.branch,
    userId: identity.userId,
    agentId: identity.agentId,
  });

  // 1. Observe Phase: Incrementally read new transcript slice via byte offset cursor
  const startOffset =
    typeof state.last_read_byte_offset === "number" ? state.last_read_byte_offset : 0;
  const { entries: candidateEntries, nextOffset } = readTranscriptIncremental(
    transcriptPath,
    startOffset
  );

  if (!candidateEntries || candidateEntries.length === 0) {
    writeStdoutJson({});
    return;
  }

  const settledIndex = state.settled_turn_index ?? -1;
  const newEntries = candidateEntries.filter((e) => (e.step_index ?? -1) > settledIndex);

  if (newEntries.length === 0) {
    writeStdoutJson({});
    return;
  }

  const maxStepIndex = newEntries[newEntries.length - 1].step_index ?? -1;
  markObserved(state, maxStepIndex);
  saveSessionState(config.dataDir, state);

  // 2. Transform to EverOS messages (Thinking stripped, subagents reduced, FIFO paired, Dummy Tool Synth applied)
  const messages = toEverosMessages(newEntries, {
    userId: identity.userId,
    agentId: identity.agentId,
  });
  if (messages.length === 0) {
    writeStdoutJson({});
    return;
  }

  const client = createClient({ baseUrl: config.baseUrl });

  // 3. 2PC Add: Ingest into EverOS (with bounded chunking <= 500 messages and chunk idempotency)
  try {
    const totalChunks = Math.ceil(messages.length / ADD_MAX_MESSAGES);
    let startChunkIndex = 0;

    // Check if resuming an existing partially-acknowledged batch
    if (
      state.pending_batch &&
      state.pending_batch.turn_index === maxStepIndex &&
      state.pending_batch.total_messages === messages.length &&
      typeof state.pending_batch.acked_chunks === "number"
    ) {
      startChunkIndex = state.pending_batch.acked_chunks;
    } else {
      state.pending_batch = {
        turn_index: maxStepIndex,
        total_messages: messages.length,
        acked_chunks: 0,
      };
    }

    for (let c = startChunkIndex; c < totalChunks; c++) {
      const startMsg = c * ADD_MAX_MESSAGES;
      const chunk = messages.slice(startMsg, startMsg + ADD_MAX_MESSAGES);
      await client.add(
        {
          app_id: identity.appId,
          session_id: conversationId,
          project_id: identity.projectId,
          messages: chunk,
        },
        AbortSignal.timeout(CAPTURE_DEADLINE_MS)
      );

      // Record progress per chunk to ensure idempotency across retries
      state.pending_batch.acked_chunks = c + 1;
      saveSessionState(config.dataDir, state);
    }

    // 4. 2PC Settle Phase: Advance settled_turn_index & byte offset ONLY on HTTP 200 Ack of all chunks
    state.pending_batch = null;
    markSettled(state, maxStepIndex);
    state.last_read_byte_offset = nextOffset;
    saveSessionState(config.dataDir, state);
  } catch (err) {
    // Nack: Keep settled_turn_index and last_read_byte_offset unadvanced so subsequent stop or sweep can retry
    try {
      process.stderr.write(`[capture] Ingestion deferred: ${err?.message || err}\n`);
    } catch {
      /* ignore */
    }
  }

  writeStdoutJson({});
});

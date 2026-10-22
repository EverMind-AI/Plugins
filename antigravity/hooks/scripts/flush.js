import { readStdinJson, writeStdoutJson, wrapHook } from "./lib/hook-io.js";
import { loadConfig } from "./lib/config.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient } from "./lib/everos.js";
import { FLUSH_TIMEOUT_MS } from "./lib/constants.js";
import {
  loadSessionState,
  saveSessionState,
  markFlushed,
} from "./lib/state.js";

wrapHook(async () => {
  const isBackground = process.argv.includes("--background");
  const nonFlagArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const cliSessionId = nonFlagArgs[0];

  const input = readStdinJson();
  const conversationId = String(
    input.conversationId ?? input.conversation_id ?? cliSessionId ?? "default"
  ).slice(0, 128);

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

  const targetProjectId = state.project_id || identity.projectId;

  // If already flushed or permanently abandoned, avoid duplicate flush
  if (state.flushed === true) {
    writeStdoutJson({
      success: true,
      already_flushed: true,
      project_id: targetProjectId,
      conversation_id: conversationId,
    });
    return;
  }

  if (state.flush_abandoned === true && isBackground) {
    return;
  }

  // Increment flush attempts
  state.flush_attempts = (state.flush_attempts || 0) + 1;
  saveSessionState(config.dataDir, state);

  const client = createClient({ baseUrl: config.baseUrl });

  try {
    // 2PC Settle Phase: Only mark flushed on HTTP 200 Ack
    await client.flush(
      {
        app_id: identity.appId,
        session_id: conversationId,
        project_id: targetProjectId,
      },
      AbortSignal.timeout(FLUSH_TIMEOUT_MS)
    );

    markFlushed(state, true);
    state.flush_abandoned = false;
    saveSessionState(config.dataDir, state);

    writeStdoutJson({
      success: true,
      project_id: targetProjectId,
      conversation_id: conversationId,
    });
  } catch (err) {
    // Nack: Check retry threshold (3 attempts max)
    if (state.flush_attempts >= 3) {
      state.flush_abandoned = true;
    }
    saveSessionState(config.dataDir, state);

    try {
      process.stderr.write(`[flush] Flush failed: ${err?.message || err}\n`);
    } catch {
      /* ignore */
    }
    writeStdoutJson({
      success: false,
      error: err?.message || String(err),
      project_id: identity.projectId,
      flush_attempts: state.flush_attempts,
      flush_abandoned: state.flush_abandoned,
    });
  }
});

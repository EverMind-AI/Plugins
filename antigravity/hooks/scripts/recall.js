import { createHash } from "node:crypto";
import { readStdinJson, writeStdoutJson, wrapHook } from "./lib/hook-io.js";
import { loadConfig } from "./lib/config.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import {
  loadSessionState,
  saveSessionState,
  markRecalled,
  markProfileInjected,
} from "./lib/state.js";
import { readTranscript } from "./lib/transcript.js";
import { shouldRecall, buildQuery } from "./lib/query.js";
import { renderProfileBlock, renderMemoryBlock } from "./lib/render.js";
import { dualTrackSearch } from "./lib/search-tracks.js";

wrapHook(async () => {
  const input = readStdinJson();
  const transcriptPath = input.transcriptPath;
  const conversationId = String(
    input.conversationId ?? input.conversation_id ?? "default"
  );

  if (!transcriptPath) {
    writeStdoutJson({});
    return;
  }

  const config = loadConfig();

  // 1. Double-Lock: check transcript's latest USER_INPUT
  const entries = readTranscript(transcriptPath);
  let latestUserStep = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "USER_INPUT" && entry.source === "USER_EXPLICIT") {
      latestUserStep = entry;
      break;
    }
  }

  if (!latestUserStep) {
    writeStdoutJson({});
    return;
  }

  const contentDigest = createHash("sha1")
    .update(`${conversationId}|${latestUserStep.created_at ?? ""}|${String(latestUserStep.content ?? "").slice(0, 200)}`)
    .digest("hex")
    .slice(0, 8);
  const turnId = `turn_${latestUserStep.step_index}_${contentDigest}`;

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

  // Check if this turn was already recalled
  if (state.recalled_turn_ids.includes(turnId)) {
    writeStdoutJson({});
    return;
  }

  // 2. Query Intent Filtering: filter trivial acknowledgments or slash commands
  const rawContent = latestUserStep.content ?? "";
  if (!shouldRecall(rawContent)) {
    markRecalled(state, turnId);
    saveSessionState(config.dataDir, state);
    writeStdoutJson({});
    return;
  }

  const query = buildQuery(rawContent);
  const client = createClient({ baseUrl: config.baseUrl });
  const signal = deadline(config.recallTimeoutMs);

  const needProfileFallback = !state.has_injected_profile;

  // 3. Dual-Track Parallel Search & Interleaved Merge (D2-04 / D5-03)
  const mergedSearchRes = await dualTrackSearch(client, {
    identity,
    query,
    config,
    topK: 3,
    includeProfile: needProfileFallback,
    signal,
  });

  const blocks = [];

  // 5. Cold-Start Fallback: L1 Profile if SessionStart missed it
  if (needProfileFallback && mergedSearchRes.profile) {
    const profileBlock = renderProfileBlock(mergedSearchRes.profile, {
      projectId: identity.projectId,
      branch: identity.branch,
      locale: config.locale,
    });
    if (profileBlock) {
      blocks.push(profileBlock);
      markProfileInjected(state, true);
    }
  }

  // 6. L2 Ephemeral Memory Block
  const memoryBlock = renderMemoryBlock(mergedSearchRes, {
    projectId: identity.projectId,
    branch: identity.branch,
    locale: config.locale,
  });

  if (memoryBlock) {
    blocks.push(memoryBlock);
  }

  // 7. Mark recalled and persist
  markRecalled(state, turnId);
  saveSessionState(config.dataDir, state);

  if (blocks.length > 0) {
    writeStdoutJson({
      injectSteps: [
        {
          ephemeralMessage: blocks.join("\n\n"),
        },
      ],
    });
    return;
  }

  writeStdoutJson({});
});

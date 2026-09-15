#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { shouldRecall, buildQuery } from "./lib/query.js";
import { render, summaryLine } from "./lib/render.js";
import { claimWarning, touchSession } from "./lib/state.js";


runHook("UserPromptSubmit", async (input, ctx) => {
  const { config, debug } = ctx;
  const prompt = input.prompt ?? "";
  const sessionId = input.session_id ?? "unknown";
  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  // Proof of life for the abandoned-session sweep: a long agentic turn captures
  // nothing for minutes, but a prompt means somebody is still here. Recorded
  // before the recall test on purpose - "ok", "continue" and slash commands are
  // not worth a search, and they are just as much proof that somebody is here.
  touchSession(config.dataDir, sessionId, identity.projectId);

  if (!shouldRecall(prompt)) {
    debug("skipped: slash command or below the token floor");
    return undefined;
  }

  const client = createClient({ baseUrl: config.baseUrl });
  const query = buildQuery(prompt);
  // One signal for both tracks: the user pays this latency on every prompt.
  const signal = deadline(config.recallTimeoutMs);
  const common = { app_id: identity.appId, project_id: identity.projectId, query };

  const userTrack = identity.userId
    ? client
        .search({ ...common, user_id: identity.userId, include_profile: true }, signal)
        .catch((error) => { debug(`user track failed: ${error.message}`); return null; })
    : Promise.resolve(null);
  const agentTrack = client
    .search({ ...common, agent_id: identity.agentId }, signal)
    .catch((error) => { debug(`agent track failed: ${error.message}`); return null; });

  const [userData, agentData] = await Promise.all([userTrack, agentTrack]);

  if (!identity.userId && claimWarning(config.dataDir, sessionId)) {
    return { systemMessage: "⚠️ EverOS: no user id could be derived — set EVEROS_CC_USER_ID. Personal memory is off for this session." };
  }
  if (userData === null && agentData === null) {
    return claimWarning(config.dataDir, sessionId)
      ? { systemMessage: `⚠️ EverOS unreachable at ${config.baseUrl} — memory is off for this session. Run /everos:status.` }
      : undefined;
  }

  const rendered = render(userData, agentData);
  if (!rendered) {
    debug("no hits");
    return config.verbose ? { systemMessage: "🧠 EverOS: no relevant memory" } : undefined;
  }
  return { additionalContext: rendered.block, systemMessage: summaryLine(rendered.counts) ?? undefined };
});

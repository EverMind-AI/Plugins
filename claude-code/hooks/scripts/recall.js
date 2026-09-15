#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { shouldRecall, buildQuery } from "./lib/query.js";
import { render, summaryLine } from "./lib/render.js";
import { PROFILE_EVERY_TURNS } from "./lib/constants.js";
import { claimWarning, touchSession, readState } from "./lib/state.js";


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
  // Sharing it is safe - a track that already answered is unaffected when the
  // signal later fires, and a track still pending at the deadline would have
  // blown its own deadline anyway.
  const signal = deadline(config.recallTimeoutMs);
  const common = { app_id: identity.appId, project_id: identity.projectId, query };

  // promptIds is the count of turns already captured, so this is true on the
  // first recall of a session and every PROFILE_EVERY_TURNS after it. An
  // unwritable state dir keeps it empty, which falls back to asking every turn -
  // the old behaviour, and the safe direction.
  const turnsSoFar = readState(config.dataDir, sessionId).promptIds.length;
  const wantProfile = turnsSoFar % PROFILE_EVERY_TURNS === 0;

  const userTrack = identity.userId
    ? client
        .search({ ...common, user_id: identity.userId, include_profile: wantProfile }, signal)
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

  // One track down is not "no memory" - it is half the memory, silently. Both
  // null is already handled above; exactly one null means the other half of the
  // answer is missing while the summary line would still read like a success.
  const userAttempted = Boolean(identity.userId);
  const halfDown = userAttempted && ((userData === null) !== (agentData === null));
  const missing = userData === null ? "personal" : "agent";

  const rendered = render(userData, agentData);
  if (!rendered) {
    if (halfDown) {
      debug(`${missing} track failed and the other found nothing`);
      return { systemMessage: `⚠️ EverOS: ${missing} memory unavailable this turn` };
    }
    debug("no hits");
    return config.verbose ? { systemMessage: "🧠 EverOS: no relevant memory" } : undefined;
  }
  const line = summaryLine(rendered.counts);
  return {
    additionalContext: rendered.block,
    // Said every turn it happens, not once per session: the warning budget is
    // for "EverOS is down", and this is a different, recurring condition.
    systemMessage: halfDown ? `${line ?? "🧠 EverOS"} — ${missing} memory unavailable` : (line ?? undefined),
  };
});

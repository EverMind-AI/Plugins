#!/usr/bin/env node
import path from "node:path";
import { runHook } from "./lib/hook-io.js";
import { ensureEveros } from "./lib/provision.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { claimWarning, markFlushed, pendingFlushes } from "./lib/state.js";
import { isLoopback } from "./lib/config.js";
import { OVERLAP_NOTICE, claimOverlapNotice, nativeMemoryState } from "./lib/native-memory.js";
import { FLUSH_DISPATCH_MS } from "./lib/constants.js";

/**
 * How long a session must sit untouched before another session may seal it.
 * Recall touches the session on every prompt, so this is thirty minutes of no
 * prompts, not thirty minutes of no captures. Long enough that a live session
 * is never sealed underneath it, short enough that the tail is not stranded.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;
const SWEEP_MAX_SESSIONS = 5;
/**
 * One budget for the whole sweep, not one per session. `/flush` runs real
 * boundary detection, so a few seconds each is normal, and five sequential
 * flushes at the old 10s per-call deadline would have been 50s against a 15s hook timeout.
 */


/**
 * Seal the tail of sessions whose own SessionEnd never ran.
 *
 * Claude Code cancels SessionEnd when the host exits in a hurry, which is
 * routine under `claude -p`: the turns after EverOS's last topic boundary then
 * sit in the buffer and are never extracted. Nobody is waiting on this hook, so
 * it is the right place to clean up after the previous session.
 */
async function sweepAbandoned(config, cwd, debug) {
  const abandoned = pendingFlushes(config.dataDir, ABANDONED_AFTER_MS).slice(0, SWEEP_MAX_SESSIONS);
  if (abandoned.length === 0) return;
  const identity = resolveIdentity(cwd, config);
  const client = createClient({ baseUrl: config.baseUrl });

  // Dispatched together, not awaited one after another. SessionStart is on the
  // critical path - the host holds the first prompt until this hook returns -
  // and a real flush runs an extraction, measured at ~7 s. Sealing serially
  // inside a 6 s budget therefore cost the user 6 s at the start of every
  // session and still only got through one or two of them. Measured before:
  // first response 7.0 s with nothing pending, 16.9 s with five. EverOS
  // finishes the extraction with no client attached, exactly as it does for the
  // SessionEnd flush the host kills.
  const results = await Promise.all(abandoned.map(({ sessionId, projectId }) =>
    client
      .flush(
        // The recorded project, not this session's: the abandoned session may
        // have belonged to a different repository.
        { session_id: sessionId, app_id: identity.appId, project_id: projectId ?? identity.projectId },
        deadline(FLUSH_DISPATCH_MS),
      )
      .then(() => ({ sessionId, sealed: true }))
      // TIMEOUT means the socket was open and EverOS has the request; anything
      // else means it never left. Same rule, and same loopback guard, as flush.js.
      .catch((error) => ({
        sessionId,
        sealed: error.code === "TIMEOUT" && isLoopback(config.baseUrl),
        why: error.message,
      })),
  ));

  for (const { sessionId, sealed, why } of results) {
    if (sealed) {
      markFlushed(config.dataDir, sessionId);
      debug(`sealed abandoned session ${sessionId}`);
    } else {
      // Left unsealed on purpose, so a later session tries again.
      debug(`could not seal ${sessionId}: ${why}`);
    }
  }
}


runHook("SessionStart", async (input, ctx) => {
  const { config, debug } = ctx;
  const outcome = await ensureEveros(config);
  const logFile = path.join(config.dataDir, "everos-server.log");
  const sessionId = input.session_id ?? "unknown";
  debug(`session start (${input.source ?? "unknown"}): ${outcome.status}`);

  /**
   * Spend the session's single warning here.
   *
   * The recall hook warns too, from the same budget, so without this a dead
   * EverOS announced itself twice in the first two seconds of a session - once
   * as "could not be started" and again as "unreachable". Only the terminal
   * failures claim it; "starting" is not one, because memory may well arrive.
   */
  const warnOnce = (message) => (claimWarning(config.dataDir, sessionId) ? { systemMessage: message } : undefined);

  if (outcome.status === "healthy" || outcome.status === "started") {
    await sweepAbandoned(config, input.cwd ?? process.cwd(), debug);
  }

  switch (outcome.status) {
    case "healthy":
      // Everything typed and every tool result goes to base_url, and EverOS has
      // no authentication of its own. If that address is not this machine, the
      // user should be told which machine it is - once, at the top of the session.
      if (!isLoopback(config.baseUrl)) {
        return { systemMessage: `⚠️ EverOS is remote: this session's transcript is being sent to ${config.baseUrl}, unauthenticated.` };
      }
      // Codex's own memory injects ~27,500 characters at session start. Running
      // both is a choice; say so once so it is made rather than discovered.
      // Deliberately after the remote warning, which is the more serious of the
      // two and owns the session's attention when it fires.
      if (nativeMemoryState() === "on" && claimOverlapNotice(config.dataDir)) {
        return { systemMessage: OVERLAP_NOTICE };
      }
      return config.verbose ? { systemMessage: `🧠 EverOS ready (${outcome.health?.version ?? "unknown version"})` } : undefined;
    case "started":
      return { systemMessage: "⚡ EverOS started — memory is on." };
    case "starting":
      return { systemMessage: `⏳ EverOS is starting in the background; memory resumes once it is up. Log: ${logFile}` };
    case "no-start-cmd":
      return warnOnce(`⚠️ EverOS unreachable at ${config.baseUrl} and no start command is set — memory is off. Run /everos:status.`);
    case "spawn-failed":
      return warnOnce(`⚠️ EverOS could not be started (${outcome.detail}) — memory is off. Run /everos:status.`);
    default:
      return warnOnce(`⚠️ EverOS unreachable at ${config.baseUrl} — memory is off. Run /everos:status.`);
  }
});

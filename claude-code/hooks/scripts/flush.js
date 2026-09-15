#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity, sanitizeId } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { markFlushed, pruneState } from "./lib/state.js";
import { FLUSH_DISPATCH_MS } from "./lib/constants.js";

// Registered for both SessionEnd and PreCompact. Sealing twice is harmless:
// EverOS answers "no_extraction" on an empty buffer.
runHook("SessionEnd", async (input, ctx) => {
  const { config, debug } = ctx;
  const event = input.hook_event_name ?? "SessionEnd";
  const sessionId = input.session_id;
  if (!sessionId) {
    debug(`${event}: no session_id`);
    return undefined;
  }

  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  // Marked only once the request is known to have left: on the answer, or on the
  // dispatch timeout, which means the socket was open and EverOS finishes with
  // no client attached.
  //
  // This used to be marked BEFORE the request, to stop the sweep re-flushing
  // every session half an hour later. That traded the wrong way round. The host
  // kills a session-end hook within a few hundred milliseconds, usually before
  // the POST leaves at all, and an optimistic mark makes `pendingFlushes` skip
  // the session forever - the sweep exists for exactly the case it then cannot
  // see. Being killed early now leaves the session unsealed, which is the
  // recoverable direction, and the cost it was avoiding is not real: a repeat
  // flush answers "no_extraction" in 3ms (measured against a live 1.3.1).
  try {
    const data = await createClient({ baseUrl: config.baseUrl }).flush(
      { session_id: sanitizeId(sessionId, "unknown"), app_id: identity.appId, project_id: identity.projectId },
      deadline(FLUSH_DISPATCH_MS),
    );
    markFlushed(config.dataDir, sessionId);
    debug(`${event}: flush ${data?.status ?? "ok"}`);
  } catch (error) {
    if (error.code === "TIMEOUT") {
      // The socket was open, so EverOS has the request and finishes on its own.
      markFlushed(config.dataDir, sessionId);
      debug(`${event}: flush dispatched, not awaited`);
    } else {
      // It never arrived - leave it unsealed so a later session sweeps it up.
      debug(`${event}: flush failed: ${error.message}`);
    }
  }

  // The session is over, so this is the one moment nobody is waiting on us.
  if (event === "SessionEnd") {
    const removed = pruneState(config.dataDir);
    if (removed) debug(`pruned ${removed} stale state files`);
  }
  return undefined;
});

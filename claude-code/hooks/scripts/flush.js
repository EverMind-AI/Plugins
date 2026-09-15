#!/usr/bin/env node
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity, sanitizeId } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { markFlushed, pruneState } from "./lib/state.js";
import { isLoopback } from "./lib/config.js";
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
    if (error.code === "TIMEOUT" && isLoopback(config.baseUrl)) {
      // On loopback the connect is instantaneous, so running out of time means
      // the request was written and EverOS finishes it without us. Off-box that
      // inference is false: a dropped SYN (VPN down, firewall DROP, host asleep)
      // aborts with the same TIMEOUT having sent nothing, and marking it sealed
      // would hide the session from the sweep forever - the very failure this
      // ordering was introduced to fix, coming back through the error classifier.
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

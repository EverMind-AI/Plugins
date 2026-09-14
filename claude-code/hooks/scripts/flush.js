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
  // Recorded BEFORE the request, and undone only if it provably never arrived.
  //
  // The host kills a session-end hook within a few hundred milliseconds - in an
  // interactive terminal as much as under `claude -p` - so a mark written after
  // the answer was never written at all, and the sweep re-flushed every session
  // half an hour later for nothing. The POST does leave first (measured ~120ms
  // after /exit), and EverOS finishes the extraction with no client attached.
  markFlushed(config.dataDir, sessionId);
  try {
    const data = await createClient({ baseUrl: config.baseUrl }).flush(
      { session_id: sanitizeId(sessionId, "unknown"), app_id: identity.appId, project_id: identity.projectId },
      deadline(FLUSH_DISPATCH_MS),
    );
    debug(`${event}: flush ${data?.status ?? "ok"}`);
  } catch (error) {
    if (error.code === "TIMEOUT") {
      // The socket was open, so EverOS has the request and finishes on its own.
      debug(`${event}: flush dispatched, not awaited`);
    } else {
      // It never arrived - take the mark back so a later session sweeps it up.
      markFlushed(config.dataDir, sessionId, false);
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

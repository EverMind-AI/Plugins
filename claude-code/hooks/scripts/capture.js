#!/usr/bin/env node
import fs from "node:fs/promises";
import { runHook } from "./lib/hook-io.js";
import { resolveIdentity, sanitizeId } from "./lib/identity.js";
import { createClient, deadline } from "./lib/everos.js";
import { lastPromptId, parseTranscript, readTurn, toEverosMessages } from "./lib/transcript.js";
import { readState, isStored, markStored } from "./lib/state.js";
import { ADD_MAX_MESSAGES, CAPTURE_DEADLINE_MS } from "./lib/constants.js";

async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

runHook("Stop", async (input, ctx) => {
  const { config, debug } = ctx;
  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath) {
    debug(`missing stdin fields: session_id=${sessionId} transcript_path=${transcriptPath}`);
    return undefined;
  }
  // prompt_id is documented as optional. When it is absent, the turn that just
  // ended is the last one on disk; without this the hook would be a silent no-op.
  let promptId = input.prompt_id;
  if (!promptId) {
    promptId = lastPromptId(parseTranscript(await readFileOrEmpty(transcriptPath)));
    debug(`no prompt_id on stdin; falling back to the last turn (${promptId})`);
    if (!promptId) return undefined;
  }

  // Stop can fire twice for one prompt (interrupt, then resume). EverOS does not dedupe.
  if (isStored(readState(config.dataDir, sessionId), promptId)) {
    debug(`already stored: ${promptId}`);
    return undefined;
  }

  const identity = resolveIdentity(input.cwd ?? process.cwd(), config);
  if (!identity.userId) {
    debug("no user id; skipping capture");
    return undefined;
  }

  const turn = await readTurn(transcriptPath, promptId);
  const messages = toEverosMessages(turn, identity);
  if (messages.length === 0) {
    debug(`nothing to capture for ${promptId}`);
    return undefined;
  }

  const client = createClient({ baseUrl: config.baseUrl });
  const signal = deadline(CAPTURE_DEADLINE_MS);
  let committed = 0;
  for (let start = 0; start < messages.length; start += ADD_MAX_MESSAGES) {
    const batch = messages.slice(start, start + ADD_MAX_MESSAGES);
    try {
      await client.add(
        { session_id: sanitizeId(sessionId, "unknown"), app_id: identity.appId, project_id: identity.projectId, messages: batch },
        signal,
      );
      committed += batch.length;
    } catch (error) {
      debug(`add failed at offset ${start}: ${error.message}`);
      // Nothing got through: leave the prompt unmarked so a re-fired Stop can
      // retry it. Deliberately no retry here - a 5xx may already have committed
      // and re-sending would double-write.
      if (committed === 0) return undefined;
      // Something did get through. Retrying would re-post the committed batches,
      // and EverOS assigns message ids server-side so it cannot dedupe them.
      // A truncated tail is the lesser loss.
      // ponytail: whole-turn granularity; per-batch resume if long turns start failing here.
      debug(`partial capture: ${committed} of ${messages.length} messages committed, tail dropped`);
      break;
    }
  }

  markStored(config.dataDir, sessionId, promptId, identity.projectId);
  // `committed`, not `messages.length`: a partial capture drops the tail, and
  // telling the user we saved more than we did is the one thing a memory tool
  // must never do.
  debug(`stored ${committed} of ${messages.length} messages for ${promptId}`);
  return config.verbose ? { systemMessage: `💾 EverOS: saved ${committed} messages` } : undefined;
});

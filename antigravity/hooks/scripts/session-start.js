import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readStdinJson, writeStdoutJson, wrapHook } from "./lib/hook-io.js";
import { loadConfig } from "./lib/config.js";
import { resolveIdentity } from "./lib/identity.js";
import { createClient } from "./lib/everos.js";
import {
  loadSessionState,
  saveSessionState,
  markProfileInjected,
  listStaleSessions,
  cleanupExpiredSessions,
} from "./lib/state.js";
import { ensureServerRunning } from "./lib/provision.js";
import { renderProfileBlock } from "./lib/render.js";

wrapHook(async () => {
  const input = readStdinJson();
  const conversationId = String(
    input.conversationId ?? input.conversation_id ?? "default"
  );
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

  const client = createClient({ baseUrl: config.baseUrl });

  // 1. Ensure EverOS daemon is alive
  const daemon = await ensureServerRunning(config, { client });

  // 2. Stale Sweep: 2PC compensation via detached background flush (capped at 3 items)
  if (daemon.ok) {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const flushScript = path.join(here, "flush.js");
      const staleCandidates = listStaleSessions(config.dataDir)
        .filter((s) => s.session_id !== conversationId && Boolean(s.project_id) && !s.flush_abandoned)
        .slice(0, 3); // Bounded batch of max 3

      const safeCwd = (cwd && fs.existsSync(cwd)) ? cwd : process.cwd();
      for (const stale of staleCandidates) {
        try {
          const child = spawn(process.execPath, [flushScript, "--background", stale.session_id], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            cwd: safeCwd,
            env: process.env,
          });
          child.on("error", () => {}); // Never throw unhandled error event
          child.unref();
        } catch {
          /* ignore spawn error */
        }
      }

      // 2b. Cleanup expired sessions older than TTL (D5-07)
      cleanupExpiredSessions(config.dataDir);
    } catch {
      /* stale sweep non-blocking */
    }
  }

  // 3. L1 Persistent Profile Injection
  if (daemon.ok && !state.has_injected_profile) {
    try {
      const profileSearchBody = {
        app_id: identity.appId,
        query: "developer preferences and coding style",
        project_id: identity.projectId,
        method: config.searchMethod,
        top_k: 1,
        include_profile: true,
      };
      if (identity.userId) {
        profileSearchBody.user_id = identity.userId;
      } else {
        profileSearchBody.agent_id = identity.agentId;
      }

      const searchRes = await client.search(
        profileSearchBody,
        AbortSignal.timeout(config.recallTimeoutMs)
      );

      const profileItem = searchRes?.profiles?.[0] ?? null;
      if (profileItem) {
        const rendered = renderProfileBlock(profileItem, {
          projectId: identity.projectId,
          branch: identity.branch,
          locale: config.locale,
        });

        if (rendered) {
          markProfileInjected(state, true);
          saveSessionState(config.dataDir, state);
          writeStdoutJson({
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: rendered,
                },
              },
            ],
          });
          return;
        }
      }
    } catch (err) {
      // Server may still be starting or unreachable: leave has_injected_profile as false
      // PreInvocation will perform Cold-Start Fallback
      try {
        process.stderr.write(`[session-start] Profile fetch deferred: ${err?.message || err}\n`);
      } catch {
        /* ignore */
      }
    }
  }

  saveSessionState(config.dataDir, state);
  writeStdoutJson({});
});

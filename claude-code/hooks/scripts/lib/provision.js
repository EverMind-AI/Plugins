import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient, deadline } from "./everos.js";
import { isLoopback } from "./config.js";
import { HEALTH_TIMEOUT_MS, START_WAIT_MS, START_POLL_MS } from "./constants.js";

export function portFromUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.port) return url.port;
    return url.protocol === "https:" ? "443" : "80";
  } catch {
    return "8000";
  }
}

export async function probeHealth(baseUrl, deps = {}) {
  try {
    return await createClient({ baseUrl }).health(deadline(deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS));
  } catch {
    return null;
  }
}

function openLog(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // 0600: this captures the stderr of a server launched with the user's
    // environment, so it is not something to leave world-readable.
    const file = path.join(dataDir, "everos-server.log");
    const fd = fs.openSync(file, "a", 0o600);
    fs.chmodSync(file, 0o600);
    return fd;
  } catch {
    return "ignore";
  }
}

/**
 * Start EverOS and walk away. Detached and unref'd on purpose: a hook is a
 * two-second process, so there is nobody left to parent the server. It outlives
 * the session; EverOS's own single-instance lock keeps a second window from
 * starting a competing one.
 */
function spawnEveros(config, deps = {}) {
  const spawnImpl = deps.spawn ?? nodeSpawn;
  const [command, ...args] = config.startCmd ?? [];
  if (!command) return null;
  const log = openLog(config.dataDir);
  const child = spawnImpl(command, args, {
    cwd: config.everosDir || undefined,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      // Without agent mode the agent track is silently empty and cases never appear.
      EVEROS_MEMORIZE__MODE: "agent",
      EVEROS_API__PORT: portFromUrl(config.baseUrl),
      ...(deps.spawnEnv ?? {}),
    },
  });
  // A missing binary arrives as an async 'error' event, and a server that refuses
  // to start (bad config, OME lock held) exits within a second. Record both:
  // without this, ensureEveros would poll a dead process and report "starting".
  // The listeners also stop the 'error' event from becoming an uncaught exception
  // after the hook has already answered.
  child.everosFailure = null;
  child.on?.("error", (error) => { child.everosFailure ??= error?.message ?? "spawn error"; });
  child.on?.("exit", (code, signal) => { child.everosFailure ??= `exited with ${signal ?? code}`; });
  child.unref?.();
  return child;
}

export async function ensureEveros(config, deps = {}) {
  const health = await probeHealth(config.baseUrl, deps);
  if (health) return { status: "healthy", health };
  if (!isLoopback(config.baseUrl)) return { status: "remote" };
  if (!config.startCmd || config.startCmd.length === 0) return { status: "no-start-cmd" };

  let child;
  try {
    child = spawnEveros(config, deps);
  } catch (error) {
    return { status: "spawn-failed", detail: error?.message ?? String(error) };
  }
  if (!child) return { status: "no-start-cmd" };

  const waitMs = deps.startWaitMs ?? START_WAIT_MS;
  const pollMs = deps.startPollMs ?? START_POLL_MS;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(pollMs);
    // Health first: a foreign instance may have won the OME lock and be serving,
    // in which case our own child dying is the correct outcome, not a failure.
    const ready = await probeHealth(config.baseUrl, deps);
    if (ready) return { status: "started", health: ready, pid: child.pid };
    if (child.everosFailure) return { status: "spawn-failed", detail: child.everosFailure };
  }
  return { status: "starting", pid: child.pid };
}

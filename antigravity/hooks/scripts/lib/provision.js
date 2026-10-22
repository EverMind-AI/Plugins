import { spawn } from "node:child_process";
import { createClient } from "./everos.js";
import { isLoopback } from "./config.js";
import { HEALTH_TIMEOUT_MS, START_WAIT_MS, START_POLL_MS } from "./constants.js";

let lastSpawnTime = 0;

/**
 * Reset spawn throttling timestamp (primarily for tests).
 */
export function resetSpawnThrottle() {
  lastSpawnTime = 0;
}

/**
 * Ensure EverOS server is healthy and running.
 * If unreachable on loopback, attempts detached background auto-spawn,
 * then polls /health until ready or timed out.
 *
 * Strict fail-open: never throws unhandled errors.
 *
 * @param {Record<string, unknown>} config
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {typeof spawn} [options.spawnImpl=spawn]
 * @param {number} [options.waitMs=1500]
 * @param {number} [options.retries=3]
 * @param {number} [options.retryDelayMs=300]
 * @param {number} [options.throttleMs=15000]
 * @returns {Promise<{ ok: boolean, spawned: boolean, reason?: string, error?: string }>}
 */
export async function ensureServerRunning(config, options = {}) {
  const {
    client = createClient({ baseUrl: config.baseUrl }),
    spawnImpl = spawn,
    waitMs = HEALTH_TIMEOUT_MS,
    retries = 3,
    retryDelayMs = START_POLL_MS,
    throttleMs = 15000,
  } = options;

  // 1. Initial health check
  try {
    const health = await client.health(AbortSignal.timeout(waitMs));
    const isHealthy =
      health &&
      health.healthy !== false &&
      health.status !== "unhealthy" &&
      health.cascade?.healthy !== false;

    if (!isHealthy) {
      return { ok: false, spawned: false, reason: "unhealthy" };
    }
    return { ok: true, spawned: false };
  } catch {
    // Service offline or pending
  }

  // 2. Check if auto-spawn is appropriate
  const canSpawn =
    isLoopback(config.baseUrl) &&
    Array.isArray(config.startCmd) &&
    config.startCmd.length > 0;

  if (!canSpawn) {
    return { ok: false, spawned: false, reason: "server_offline" };
  }

  // 3. Throttle spawn attempts to prevent fork storms
  const now = Date.now();
  if (now - lastSpawnTime < throttleMs) {
    return { ok: false, spawned: false, reason: "throttled" };
  }
  lastSpawnTime = now;

  // 4. Detached background spawn (shell: false prevents cmd injection & quote stripping)
  try {
    const [cmd, ...args] = config.startCmd;
    const child = spawnImpl(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: config.everosDir || undefined,
      shell: false,
    });
    if (typeof child?.on === "function") {
      child.on("error", () => {});
    }
    if (typeof child?.unref === "function") {
      child.unref();
    }
  } catch (spawnErr) {
    try {
      process.stderr.write(`[provision] spawn error: ${spawnErr?.message || spawnErr}\n`);
    } catch {
      /* ignore */
    }
    return { ok: false, spawned: false, error: spawnErr?.message || String(spawnErr) };
  }

  // 5. Gentle polling
  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      const health = await client.health(AbortSignal.timeout(waitMs));
      const isHealthy =
        health &&
        health.healthy !== false &&
        health.status !== "unhealthy" &&
        health.cascade?.healthy !== false;
      if (isHealthy) {
        return { ok: true, spawned: true };
      }
    } catch {
      // Continue next attempt
    }
  }

  return { ok: false, spawned: true, error: "timeout" };
}

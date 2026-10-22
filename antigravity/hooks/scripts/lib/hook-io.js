import fs from "node:fs";

let hasStdoutWritten = false;

/**
 * Reset stdout written tracking state (for unit testing).
 */
export function resetHookIoState() {
  hasStdoutWritten = false;
}

/**
 * Read JSON synchronously from process.stdin (file descriptor 0).
 * Fail-open: returns {} if stdin is empty, TTY, malformed, or unreadable.
 *
 * @returns {Record<string, unknown>}
 */
export function readStdinJson() {
  try {
    if (process.stdin.isTTY) {
      return {};
    }
    const raw = fs.readFileSync(0, { encoding: "utf8" });
    const clean = (raw && raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || "";
    if (!clean.trim()) {
      return {};
    }
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    try {
      process.stderr.write(`[hook-io] readStdinJson warning: ${err?.message || err}\n`);
    } catch {
      /* ignore */
    }
    return {};
  }
}

/**
 * Write a JSON object to process.stdout followed by a newline.
 *
 * @param {unknown} payload
 */
export function writeStdoutJson(payload) {
  try {
    const json = JSON.stringify(payload ?? {});
    process.stdout.write(json + "\n", "utf8");
    hasStdoutWritten = true;
  } catch (err) {
    try {
      process.stderr.write(`[hook-io] writeStdoutJson error: ${err?.message || err}\n`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Windows 11 Natural Drain Exit Protocol:
 * Never call process.exit() directly as it abruptly truncates stdout on Windows.
 * Assigning process.exitCode allows Node.js event loop to flush streams naturally.
 *
 * @param {number} [code=0]
 */
export function safeExit(code = 0) {
  process.exitCode = code;
}

/**
 * Top-level fail-open wrapper for hook execution scripts.
 * Catches any unhandled rejections or exceptions, logs diagnostics to stderr,
 * outputs an empty JSON object to stdout (if not already written), and safely exits with code 0.
 *
 * @param {() => Promise<void> | void} hookFn
 * @returns {Promise<void>}
 */
export async function wrapHook(hookFn) {
  const emergencyFailOpen = (reason, source) => {
    try {
      process.stderr.write(`[hook] Fatal uncaught ${source}: ${reason?.stack || reason?.message || String(reason)}\n`);
    } catch {
      /* ignore */
    }
    if (!hasStdoutWritten) {
      writeStdoutJson({});
    }
    safeExit(0);
  };

  const onUnhandledRejection = (reason) => emergencyFailOpen(reason, "unhandledRejection");
  const onUncaughtException = (err) => emergencyFailOpen(err, "uncaughtException");

  process.once("unhandledRejection", onUnhandledRejection);
  process.once("uncaughtException", onUncaughtException);

  try {
    await hookFn();
    safeExit(process.exitCode ?? 0);
  } catch (err) {
    emergencyFailOpen(err, "error");
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
  }
}

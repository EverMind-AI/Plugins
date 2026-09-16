import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

const STDIN_TIMEOUT_MS = 2000;

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(raw); } };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    timer.unref?.();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => { clearTimeout(timer); finish(); });
    process.stdin.on("error", () => { clearTimeout(timer); finish(); });
  });
}

function debugLog(config, eventName, message) {
  if (!config?.debug) return;
  try {
    const file = path.join(config.dataDir, "debug.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} [${eventName}] ${message}\n`, { mode: 0o600 });
    // mode applies only when the file is created; enforce it on an existing one.
    fs.chmodSync(file, 0o600);
  } catch { /* diagnostics must never break a hook */ }
}

/**
 * The whole fail-open contract in one place.
 *
 * stdout is the ABI: it carries the hook envelope and nothing else. Every
 * diagnostic goes to stderr and, when EVEROS_CC_DEBUG is on, to the debug log.
 * The process exits 0 on every path, including an unhandled rejection - a
 * non-zero exit or stray stdout would surface as a Claude Code hook error and
 * make a memory outage look like a broken editor.
 */
export async function runHook(eventName, handler) {
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[everos:${eventName}] ${error?.stack ?? error}\n`);
    process.exit(0);
  });
  process.on("unhandledRejection", (error) => {
    process.stderr.write(`[everos:${eventName}] ${error?.stack ?? error}\n`);
    process.exit(0);
  });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`[everos:${eventName}] config failed: ${error?.message ?? error}\n`);
    process.exit(0);
  }

  let input = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw);
  } catch (error) {
    debugLog(config, eventName, `bad stdin: ${error?.message ?? error}`);
    process.exit(0);
  }

  let result;
  try {
    result = await handler(input, { config, debug: (message) => debugLog(config, eventName, message) });
  } catch (error) {
    process.stderr.write(`[everos:${eventName}] ${error?.message ?? error}\n`);
    debugLog(config, eventName, `handler threw: ${error?.stack ?? error}`);
    process.exit(0);
  }

  if (result && (result.additionalContext || result.systemMessage)) {
    const payload = {};
    if (result.additionalContext) {
      payload.hookSpecificOutput = { hookEventName: eventName, additionalContext: result.additionalContext };
    }
    if (result.systemMessage) payload.systemMessage = result.systemMessage;
    process.stdout.write(JSON.stringify(payload));
  }
  // Set the code and let Node exit once stdout has drained. process.exit() does
  // NOT drain a pipe, and pipes are asynchronous on macOS: a recall block larger
  // than the pipe buffer would be cut in half, putting invalid JSON on the ABI.
  // Nothing else holds the loop open here - stdin has ended and its timer is unref'd.
  process.exitCode = 0;
}

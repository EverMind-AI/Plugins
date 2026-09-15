import os from "node:os";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Spawn a hook exactly as Claude Code would: JSON on stdin, JSON on stdout. */
export function runHookScript(relativeScriptPath, stdinObject, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, relativeScriptPath)], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Never let a test that forgot EVEROS_CC_DATA_DIR fall through to the
        // default, which is ~/.everos/.claude-code - the developer's real
        // directory. A missing env var does not fail loudly; it silently writes
        // somewhere it must never write.
        EVEROS_CC_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-hook-")),
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const killer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("hook did not exit within 20s")); }, 20000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      let json = null;
      if (stdout.trim()) { try { json = JSON.parse(stdout); } catch { /* leave null; a test will assert on it */ } }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(JSON.stringify(stdinObject));
  });
}

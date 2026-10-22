import os from "node:os";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Temp directories created by this helper, removed when the process exits.
 */
const created = [];
process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

/** A data directory only when the caller did not specify one of its own. */
function dataDirFor(env) {
  if (env.EVEROS_AG_DATA_DIR) return env.EVEROS_AG_DATA_DIR;
  if (env.EVEROS_ANTIGRAVITY_DATA_DIR) return env.EVEROS_ANTIGRAVITY_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-ag-hook-"));
  created.push(dir);
  return dir;
}

/** Spawn a hook script as Antigravity does: JSON on stdin, JSON on stdout. */
export function runHookScript(relativeScriptPath, stdinObject, env = {}) {
  return new Promise((resolve, reject) => {
    // Retain essential Windows & POSIX environment variables
    const inheritedEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      USERNAME: process.env.USERNAME,
      SYSTEMROOT: process.env.SYSTEMROOT,
      SYSTEMDRIVE: process.env.SYSTEMDRIVE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      COMSPEC: process.env.COMSPEC,
      ...env,
      // Never let a test write to the user's real ~/.everos/.antigravity
      EVEROS_AG_DATA_DIR: dataDirFor(env),
    };

    const child = spawn(process.execPath, [path.join(root, relativeScriptPath)], {
      env: inheritedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });

    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hook did not exit within 20s"));
    }, 20000);

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      let json = null;
      if (stdout.trim()) {
        try {
          json = JSON.parse(stdout);
        } catch {
          /* leave null; assertions can inspect stdout string */
        }
      }
      resolve({ code, stdout, stderr, json });
    });

    child.stdin.end(JSON.stringify(stdinObject));
  });
}

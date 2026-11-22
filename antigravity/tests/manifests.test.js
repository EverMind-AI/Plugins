import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

test("manifests: hooks.json exists uniquely and target scripts exist", () => {
  const rootHooks = path.join(root, "hooks.json");
  const nestedHooks = path.join(root, "hooks", "hooks.json");

  assert.ok(fs.existsSync(rootHooks), "root hooks.json must exist");
  assert.ok(!fs.existsSync(nestedHooks), "hooks/hooks.json must not exist");

  const doc = JSON.parse(fs.readFileSync(rootHooks, "utf8"));
  const events = doc["everos-antigravity"];
  assert.ok(events, "everos-antigravity namespace must be present");

  for (const [ev, arr] of Object.entries(events)) {
    for (const item of arr) {
      assert.equal(item.type, "command");
      const clean = item.command
        .replace(/^node\s+/, "")
        .replace(/^"|"$/g, "")
        .replace(/^\$\{[A-Z_]*PLUGIN_ROOT:-?\.?\}\//, "");
      const abs = path.resolve(root, clean);
      assert.ok(fs.existsSync(abs), `${ev} script must exist at ${abs}`);
    }
  }
});

test("manifests: install.mjs injects absolute paths and hooks execute in foreign cwd", () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "everos-install-test-"));

  try {
    const installScript = path.join(root, "scripts", "install.mjs");
    execFileSync(process.execPath, [installScript, "--workspace", tmpWs], {
      stdio: "pipe",
    });

    const targetHooksPath = path.join(tmpWs, ".agents", "hooks.json");
    assert.ok(fs.existsSync(targetHooksPath), "installed hooks.json must exist");

    const targetHooks = JSON.parse(fs.readFileSync(targetHooksPath, "utf8"));
    const commands = targetHooks["everos-antigravity"];

    // Execute SessionStart in foreign cwd
    const startCmd = commands.SessionStart[0].command;
    const startRes = spawnSync(startCmd, {
      shell: true,
      cwd: tmpWs,
      input: JSON.stringify({
        conversationId: "test_foreign_cwd",
        workspacePaths: [tmpWs],
      }),
      encoding: "utf8",
    });

    assert.equal(startRes.status, 0, `SessionStart stderr: ${startRes.stderr}`);
    const startJson = JSON.parse(startRes.stdout.trim() || "{}");
    assert.ok(typeof startJson === "object");

    // Execute PreInvocation in foreign cwd
    const recallCmd = commands.PreInvocation[0].command;
    const recallRes = spawnSync(recallCmd, {
      shell: true,
      cwd: tmpWs,
      input: JSON.stringify({
        conversationId: "test_foreign_cwd",
        workspacePaths: [tmpWs],
      }),
      encoding: "utf8",
    });

    assert.equal(recallRes.status, 0, `PreInvocation stderr: ${recallRes.stderr}`);
    const recallJson = JSON.parse(recallRes.stdout.trim() || "{}");
    assert.ok(typeof recallJson === "object");

    // Execute Stop in foreign cwd
    const stopCmd = commands.Stop[0].command;
    const stopRes = spawnSync(stopCmd, {
      shell: true,
      cwd: tmpWs,
      input: JSON.stringify({
        conversationId: "test_foreign_cwd",
        workspacePaths: [tmpWs],
      }),
      encoding: "utf8",
    });

    assert.equal(stopRes.status, 0, `Stop stderr: ${stopRes.stderr}`);
    const stopJson = JSON.parse(stopRes.stdout.trim() || "{}");
    assert.ok(typeof stopJson === "object");
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

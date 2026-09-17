import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimOverlapNotice,
  codexHome,
  nativeMemoryState,
  readFeatureFlag,
} from "../hooks/scripts/lib/native-memory.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-"));

test("CODEX_HOME wins over the default", () => {
  assert.equal(codexHome({ CODEX_HOME: "/somewhere/else" }), "/somewhere/else");
  assert.equal(codexHome({ CODEX_HOME: "   " }), path.join(os.homedir(), ".codex"));
  assert.equal(codexHome({}), path.join(os.homedir(), ".codex"));
});

test("the flag is read out of the features table", () => {
  const toml = '[features]\njs_repl = false\nmemories = true\n\n[mcp_servers.x]\ncommand = "y"\n';
  assert.equal(readFeatureFlag(toml, "memories"), true);
  assert.equal(readFeatureFlag(toml, "js_repl"), false);
  assert.equal(readFeatureFlag(toml, "absent"), null);
});

test("a key of the same name in another table is not misread", () => {
  // The real config has several tables after [features]; stopping at the next
  // header is what keeps this honest.
  const toml = '[features]\njs_repl = false\n\n[something_else]\nmemories = true\n';
  assert.equal(readFeatureFlag(toml, "memories"), null);
});

test("a commented-out flag is not a flag", () => {
  assert.equal(readFeatureFlag("[features]\n# memories = true\n", "memories"), null);
});

test("no config at all reads as unknown, not as off", () => {
  const home = tmp();
  assert.equal(nativeMemoryState(home), "unknown");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the declared flag is the authority, in both directions", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "config.toml"), "[features]\nmemories = true\n");
  assert.equal(nativeMemoryState(home), "on");
  fs.writeFileSync(path.join(home, "config.toml"), "[features]\nmemories = false\n");
  assert.equal(nativeMemoryState(home), "off");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a populated memory file counts as evidence when nothing is declared", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5.6-sol"\n');
  assert.equal(nativeMemoryState(home), "unknown");
  fs.mkdirSync(path.join(home, "memories"), { recursive: true });
  fs.writeFileSync(path.join(home, "memories", "MEMORY.md"), "# remembered things\n");
  assert.equal(nativeMemoryState(home), "on");
  fs.rmSync(home, { recursive: true, force: true });
});

test("an empty memory file is not evidence", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, "memories"), { recursive: true });
  fs.writeFileSync(path.join(home, "memories", "MEMORY.md"), "");
  assert.equal(nativeMemoryState(home), "unknown");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a declared false beats a populated memory file", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, "config.toml"), "[features]\nmemories = false\n");
  fs.mkdirSync(path.join(home, "memories"), { recursive: true });
  fs.writeFileSync(path.join(home, "memories", "MEMORY.md"), "# stale\n");
  assert.equal(nativeMemoryState(home), "off");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the notice is claimed once and then stays quiet", () => {
  const dir = path.join(tmp(), "data");
  assert.equal(claimOverlapNotice(dir), true);
  assert.equal(claimOverlapNotice(dir), false);
  assert.equal(claimOverlapNotice(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unwritable data dir costs nobody a session", () => {
  // Staying quiet is the safe direction: a notice must never break a start.
  assert.equal(claimOverlapNotice("/proc/definitely/not/writable"), false);
});

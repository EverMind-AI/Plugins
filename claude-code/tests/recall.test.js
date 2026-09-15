import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { readState } from "../hooks/scripts/lib/state.js";

const SCRIPT = "hooks/scripts/recall.js";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-recall-"));
}

function envFor(server, dataDir, extra = {}) {
  return {
    EVEROS_CC_BASE_URL: server.baseUrl,
    EVEROS_CC_DATA_DIR: dataDir,
    EVEROS_CC_USER_ID: "tester",
    EVEROS_CC_PROJECT_ID: "proj",
    ...extra,
  };
}

const hit = {
  episodes: [{ id: "e1", subject: "Lint choice", summary: "Agreed on ruff", atomic_facts: [{ id: "f", content: "uses ruff, not black" }] }],
  profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [],
};
const empty = { episodes: [], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [] };

test("both tracks are searched with the ids capture will use", async () => {
  const server = await startFakeEveros({ searchFn: () => empty });
  const dir = tmpHome();
  try {
    await runHookScript(SCRIPT, { prompt: "how do we lint this repo", session_id: "s1", cwd: "/w" }, envFor(server, dir));
    const searches = server.only("/api/v2/memory/search");
    assert.equal(searches.length, 2);
    const userTrack = searches.find((r) => r.body.user_id);
    const agentTrack = searches.find((r) => r.body.agent_id);
    assert.deepEqual(userTrack.body, { app_id: "claude-code", project_id: "proj", query: "how do we lint this repo", user_id: "tester", include_profile: true });
    assert.deepEqual(agentTrack.body, { app_id: "claude-code", project_id: "proj", query: "how do we lint this repo", agent_id: "claude-code" });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a hit is injected as additionalContext with a summary line", async () => {
  const server = await startFakeEveros({ searchFn: (body) => (body.user_id ? hit : empty) });
  const dir = tmpHome();
  try {
    const { code, json } = await runHookScript(SCRIPT, { prompt: "how do we lint this repo", session_id: "s1", cwd: "/w" }, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.ok(json.hookSpecificOutput.additionalContext.includes("uses ruff, not black"));
    assert.ok(json.hookSpecificOutput.additionalContext.includes("untrusted historical data"));
    assert.equal(json.systemMessage, "🧠 EverOS: 1 episode");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no hits means no output at all", async () => {
  const server = await startFakeEveros({ searchFn: () => empty });
  const dir = tmpHome();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, { prompt: "how do we lint this repo", session_id: "s1", cwd: "/w" }, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a slash command and a short prompt never reach the server", async () => {
  const server = await startFakeEveros({ searchFn: () => empty });
  const dir = tmpHome();
  try {
    await runHookScript(SCRIPT, { prompt: "/everos:search which linter does this project use", session_id: "s1", cwd: "/w" }, envFor(server, dir));
    await runHookScript(SCRIPT, { prompt: "ok", session_id: "s1", cwd: "/w" }, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/search").length, 0);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unreachable EverOS warns once per session, then stays silent", async () => {
  const dir = tmpHome();
  try {
    const env = { EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj" };
    const first = await runHookScript(SCRIPT, { prompt: "how do we lint this repo", session_id: "s1", cwd: "/w" }, env);
    assert.equal(first.code, 0);
    assert.ok(first.json.systemMessage.includes("unreachable"));
    assert.equal(first.json.hookSpecificOutput, undefined);

    const second = await runHookScript(SCRIPT, { prompt: "and how do we test it", session_id: "s1", cwd: "/w" }, env);
    assert.equal(second.stdout, "");

    const otherSession = await runHookScript(SCRIPT, { prompt: "how do we lint this repo", session_id: "s2", cwd: "/w" }, env);
    assert.ok(otherSession.json.systemMessage.includes("unreachable"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a stalled server aborts at the deadline and stays silent about content", async () => {
  const server = await startFakeEveros({ stall: true });
  const dir = tmpHome();
  try {
    const started = Date.now();
    const { code, json } = await runHookScript(SCRIPT, { prompt: "how do we lint this repo", session_id: "s1", cwd: "/w" }, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(json?.hookSpecificOutput, undefined);
    assert.ok(Date.now() - started < 9000, "must not run into the host timeout");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("one failing track still injects the other", async () => {
  const server = await startFakeEveros({
    searchFn: (body) => {
      if (body.user_id) throw new Error("user track exploded");
      return { ...empty, agent_skills: [{ id: "s", name: "run-lint", description: "make lint first" }] };
    },
  });
  const dir = tmpHome();
  try {
    const { json } = await runHookScript(SCRIPT, { prompt: "how do we lint this repo", session_id: "s1", cwd: "/w" }, envFor(server, dir));
    assert.ok(json.hookSpecificOutput.additionalContext.includes("run-lint"));
    assert.equal(json.systemMessage, "🧠 EverOS: 1 skill");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("memory still works when the state directory cannot be written", async () => {
  // Found by running recall against a chmod 0500 dataDir: touchSession threw,
  // the hook exited 0 with empty stdout, no search was ever sent, and nothing
  // anywhere said memory had stopped working. A dataDir under a regular file
  // reproduces it for any user, root included.
  const server = await startFakeEveros({ searchFn: () => hit });
  const blocked = path.join(tmpHome(), "a-file");
  fs.writeFileSync(blocked, "not a directory");
  try {
    const { code, stdout } = await runHookScript(
      SCRIPT,
      { session_id: "s1", cwd: "/w", prompt: "which linter does this project use" },
      envFor(server, path.join(blocked, "everos")),
    );
    assert.equal(code, 0);
    assert.equal(server.only("/api/v2/memory/search").length, 2, "both tracks still searched");
    assert.match(stdout, /ruff/, "and the memory still reached the prompt");
  } finally { await server.close(); fs.rmSync(blocked, { force: true }); }
});

test("a prompt too short to recall still counts as proof of life", async () => {
  // The sweep tells an abandoned session from a live one by this file's mtime.
  // "ok" and "continue" are not worth a search, and they are just as much proof
  // that somebody is still sitting there - skipping the touch let the next
  // session force a topic boundary into the middle of a live one.
  const server = await startFakeEveros({ searchFn: () => hit });
  const dir = tmpHome();
  try {
    const { code } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", prompt: "ok" }, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(server.only("/api/v2/memory/search").length, 0, "still no search for a prompt this short");
    assert.equal(readState(dir, "s1").sessionId, "s1", "but the session was marked alive");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

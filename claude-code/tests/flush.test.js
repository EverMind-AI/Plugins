import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { statePath, markStored, readState } from "../hooks/scripts/lib/state.js";

const SCRIPT = "hooks/scripts/flush.js";
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-flush-")); }
function envFor(server, dir) {
  return { EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj" };
}

test("SessionEnd seals the session buffer and writes nothing", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd", reason: "clear" }, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(stdout, "");
    const flushes = server.only("/api/v2/memory/flush");
    assert.equal(flushes.length, 1);
    assert.deepEqual(flushes[0].body, { session_id: "s1", app_id: "claude-code", project_id: "proj" });
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("PreCompact seals the same way", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "PreCompact", trigger: "auto" }, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/flush").length, 1);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SessionEnd prunes stale state files; PreCompact does not", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    markStored(dir, "ancient", "p");
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(statePath(dir, "ancient"), stale, stale);

    await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "PreCompact" }, envFor(server, dir));
    assert.equal(fs.existsSync(statePath(dir, "ancient")), true);

    await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd" }, envFor(server, dir));
    assert.equal(fs.existsSync(statePath(dir, "ancient")), false);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a seal is recorded before the answer, because the host kills the hook first", async () => {
  // The host stops waiting for a session-end hook after about 4s, and a flush
  // with real content runs a full extraction taking ~5s. EverOS finishes that
  // work even when the client has gone (verified against a live 1.3.1), so a
  // timeout here means the request arrived, not that the seal was lost.
  const server = await startFakeEveros({ flushDelayMs: 5000 });
  const dir = tmp();
  try {
    const started = Date.now();
    const { code, stdout } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd" }, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.ok(Date.now() - started < 3500, "must not sit waiting for the extraction");
    assert.equal(server.only("/api/v2/memory/flush").length, 1, "the request still went out");
    assert.equal(readState(dir, "s1").flushed, true, "in flight counts as sealed; the sweep is for requests that never arrived");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a hook killed before the request leaves stays unsealed, so the sweep still has it", async () => {
  // The host kills a SessionEnd hook within a few hundred milliseconds. This
  // used to be marked sealed up front, which made `pendingFlushes` skip the
  // session forever - and a real e2e run's server log showed no flush had
  // reached EverOS at all, so nothing ever sealed it. Unsealed is the
  // recoverable direction: a repeat flush answers "no_extraction" in 3ms
  // (measured against a live 1.3.1), so the sweep costs nothing when it is
  // wrong and saves the session when it is right.
  const server = await startFakeEveros({ flushDelayMs: 30000 });
  const dir = tmp();
  try {
    const child = runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd" }, envFor(server, dir));
    // Do not wait for the hook: inspect the state while the request is in flight,
    // which is where a killed hook leaves it.
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(readState(dir, "s1").flushed, false, "nothing the sweep would skip yet");
    await child;
    // The dispatch deadline fired, which means the socket was open and EverOS
    // has the request - that is what the mark is for.
    assert.equal(readState(dir, "s1").flushed, true, "sealed once the request is known to have left");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a seal that never reached EverOS stays unsealed for the sweep", async () => {
  const dir = tmp();
  try {
    await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd" }, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(readState(dir, "s1").flushed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unreachable EverOS exits 0 silently", async () => {
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", hook_event_name: "SessionEnd" }, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a missing session id posts nothing", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    await runHookScript(SCRIPT, { cwd: "/w", hook_event_name: "SessionEnd" }, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/flush").length, 0);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

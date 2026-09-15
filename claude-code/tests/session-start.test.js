import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { markStored, statePath, readState, touchSession } from "../hooks/scripts/lib/state.js";

const SCRIPT = "hooks/scripts/session-start.js";
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-start-")); }

test("a healthy EverOS produces no output", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a start command that cannot run is reported as a failure, not as starting", async () => {
  // A blank EVEROS_CC_START_CMD falls back to the default by design, so the
  // reachable "cannot start" case is a command that does not exist.
  const dir = tmp();
  try {
    const { code, json } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_START_CMD: "definitely-not-a-real-binary-xyz",
    });
    assert.equal(code, 0);
    assert.ok(json.systemMessage.includes("could not be started"), json.systemMessage);
    assert.ok(json.systemMessage.includes("/everos:status"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a session abandoned by a cancelled SessionEnd is sealed by the next one", async () => {
  // Claude Code cancels SessionEnd when the host exits in a hurry, which is
  // routine under `claude -p`. Without this sweep the turns after EverOS's last
  // topic boundary are never extracted.
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    markStored(dir, "old-session", "p1", "repo-that-is-not-this-one");
    const stale = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(statePath(dir, "old-session"), stale, stale);

    await runHookScript(SCRIPT, { session_id: "new-session", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    const flushes = server.only("/api/v2/memory/flush");
    assert.equal(flushes.length, 1);
    assert.equal(flushes[0].body.session_id, "old-session");
    assert.equal(flushes[0].body.project_id, "repo-that-is-not-this-one", "must seal the project the session ran in, not this one");
    assert.equal(readState(dir, "old-session").flushed, true);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a live session that is mid-turn is not sealed underneath it", async () => {
  // The state file is only written when a turn is CAPTURED, so a long agentic
  // turn writes nothing for many minutes. Recall touches the session on every
  // prompt so that mtime tracks activity rather than captures.
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    markStored(dir, "long-turn", "p1");
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(statePath(dir, "long-turn"), twentyMinutesAgo, twentyMinutesAgo);
    touchSession(dir, "long-turn", "proj"); // the user just sent another prompt

    await runHookScript(SCRIPT, { session_id: "new-session", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(server.only("/api/v2/memory/flush").length, 0);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every abandoned session is dispatched, and the user is not made to wait", async () => {
  // SessionStart sits on the critical path - the host holds the first prompt
  // until this hook returns - and a real flush runs an extraction, measured at
  // ~7 s. Sealing serially inside a 6 s budget cost the user 6 s at the start of
  // every session and still only got through one or two. Measured end to end
  // before the change: first response 7.0 s with nothing pending, 16.9 s with
  // five. They are dispatched together now; EverOS finishes with no client
  // attached, exactly as it does for the SessionEnd flush the host kills.
  const server = await startFakeEveros({ flushDelayMs: 4000 });
  const dir = tmp();
  try {
    const stale = new Date(Date.now() - 45 * 60 * 1000);
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      markStored(dir, id, "p1", "proj");
      fs.utimesSync(statePath(dir, id), stale, stale);
    }
    const started = Date.now();
    const { code } = await runHookScript(SCRIPT, { session_id: "new", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    const elapsed = Date.now() - started;
    assert.equal(code, 0);
    assert.equal(server.only("/api/v2/memory/flush").length, 5, "all five must be dispatched, not one or two");
    // Concurrent dispatch measures 1.6 s; serialised it would be five dispatch
    // deadlines, 7.5 s. The bound has to sit between them - 8 s let a serial
    // version through, which a mutation caught.
    assert.ok(elapsed < 4000, `sweep took ${elapsed}ms; dispatch must not be serialised`);
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      assert.equal(readState(dir, id).flushed, true, `${id} was dispatched, so it must be recorded sealed`);
    }
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a session that is merely idle in another window is left alone", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    markStored(dir, "live-elsewhere", "p1");
    await runHookScript(SCRIPT, { session_id: "new-session", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(server.only("/api/v2/memory/flush").length, 0);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a reachable non-loopback EverOS says so, once, naming the host", async () => {
  // The whole transcript goes to base_url and EverOS has no authentication of
  // its own, so a value that is not loopback is worth one line per session.
  const server = await startFakeEveros();
  const dir = tmp();
  const asLocalhostAlias = server.baseUrl.replace("127.0.0.1", "localhost.");
  try {
    const { code, json } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", source: "startup" }, {
      EVEROS_CC_BASE_URL: asLocalhostAlias, EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester",
    });
    assert.equal(code, 0);
    assert.ok(json.systemMessage.includes("localhost."), json.systemMessage);
    assert.ok(/transcript|sent/i.test(json.systemMessage), json.systemMessage);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SessionStart's warning is the session's one warning, and recall then stays quiet", async () => {
  // Each hook is tested alone, so nothing caught that a dead EverOS warned
  // twice at the top of a real session: once from SessionStart and again from
  // the first recall. The README promises exactly one.
  const dir = tmp();
  try {
    const env = {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
      EVEROS_CC_START_CMD: "definitely-not-a-real-binary-xyz",
    };
    const start = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w", source: "startup" }, env);
    assert.ok(start.json.systemMessage.includes("could not be started"), start.stdout);

    const recall = await runHookScript("hooks/scripts/recall.js", { session_id: "s1", cwd: "/w", prompt: "which linter does this project use" }, env);
    assert.equal(recall.stdout, "", "the session was already warned");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a non-loopback address is reported unreachable, never started", async () => {
  const dir = tmp();
  try {
    const { json } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w" }, {
      EVEROS_CC_BASE_URL: "http://10.255.255.1:8000", EVEROS_CC_DATA_DIR: dir,
    });
    assert.ok(json.systemMessage.includes("unreachable"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the hook never runs past its host timeout even when nothing starts", async () => {
  const dir = tmp();
  try {
    const started = Date.now();
    const { code } = await runHookScript(SCRIPT, { session_id: "s1", cwd: "/w" }, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_START_CMD: "definitely-not-a-real-binary-xyz",
    });
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 14000, "must stay inside the 15s hook timeout");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

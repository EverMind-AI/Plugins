import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { saveSessionState, loadSessionState } from "../hooks/scripts/lib/state.js";

test("session-start: sweep dispatches flush detached without blocking SessionStart budget (D4-01 / D3-02)", async (t) => {
  // Fake EverOS with 1500ms flush delay
  const fake = await startFakeEveros({
    flushDelayMs: 1500,
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-test-sweep-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-test-ws-"));

  t.after(async () => {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  const staleSid = "conv_stale_orphan";
  const staleState = {
    session_id: staleSid,
    project_id: "github.com_test_sweep",
    app_id: "antigravity",
    flushed: false,
    observed_turn_index: 6, // Unsettled debt: observed (6) > settled (5)
    settled_turn_index: 5,
  };
  saveSessionState(dataDir, staleState);

  const env = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: dataDir,
    EVEROS_AG_PROJECT_ID: "github.com_test_sweep",
    EVEROS_AG_USER_ID: "tester",
  };

  const start = Date.now();
  const res = await runHookScript(
    "hooks/scripts/session-start.js",
    {
      conversationId: "conv_current_active",
      workspacePaths: [wsDir],
    },
    env
  );
  const elapsed = Date.now() - start;

  assert.equal(res.code, 0, `session-start stderr: ${res.stderr}`);
  assert.ok(
    elapsed < 3000,
    `SessionStart hook must exit under 3000ms (took ${elapsed}ms) without blocking on flush`
  );

  // Wait for the background detached flush process to complete (flush takes 1500ms)
  let flushed = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const updated = loadSessionState(dataDir, staleSid);
    if (updated.flushed === true) {
      flushed = true;
      break;
    }
  }

  assert.ok(flushed, "Stale session should be marked flushed by the background detached process");
});

test("flush: retry attempts are capped at 3 and abandoned thereafter (D4-01b)", async (t) => {
  const fake = await startFakeEveros({
    flushStatus: 500,
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-test-abandon-"));
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-test-ws-"));

  t.after(async () => {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  const sid = "conv_failing_session";
  const state = {
    session_id: sid,
    project_id: "github.com_test_fail",
    app_id: "antigravity",
    flushed: false,
    flush_attempts: 2, // already failed twice
    updated_at: Date.now() - 35 * 60 * 1000,
  };
  saveSessionState(dataDir, state);

  const env = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: dataDir,
    EVEROS_AG_PROJECT_ID: "github.com_test_fail",
    EVEROS_AG_USER_ID: "tester",
  };

  // Run flush (3rd attempt)
  const res = await runHookScript(
    "hooks/scripts/flush.js",
    {
      conversationId: sid,
      workspacePaths: [wsDir],
    },
    env
  );

  assert.equal(res.code, 0);
  const updated = loadSessionState(dataDir, sid);
  assert.equal(updated.flush_attempts, 3, "flush_attempts should reach 3");
  assert.equal(updated.flush_abandoned, true, "Session should be marked flush_abandoned after 3 failed attempts");
});

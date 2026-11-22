import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { loadSessionState, saveSessionState, createDefaultSessionState } from "../hooks/scripts/lib/state.js";
import { ensureServerRunning } from "../hooks/scripts/lib/provision.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-fail-branches-test-"));
}

test("failure-branches: capture.js handles corrupt JSON lines in transcript gracefully (D6-03 / D8-05)", async (t) => {
  const fake = await startFakeEveros();
  const testDataDir = makeTempDir();
  const transcriptDir = makeTempDir();
  const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  // Write mix of valid user step, corrupt garbage line, and valid assistant step
  fs.writeFileSync(
    transcriptFile,
    [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "valid prompt" }),
      "{ corrupt broken json line ???",
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "valid answer" }),
    ].join("\n") + "\n",
    "utf8"
  );

  const res = await runHookScript(
    "hooks/scripts/capture.js",
    { conversationId: "conv_corrupt_test", transcriptPath: transcriptFile },
    { EVEROS_AG_BASE_URL: fake.baseUrl, EVEROS_AG_DATA_DIR: testDataDir }
  );

  assert.equal(res.code, 0);
  const state = loadSessionState(testDataDir, "conv_corrupt_test");
  assert.equal(state.settled_turn_index, 1);
});

test("failure-branches: capture.js preserves Nack on HTTP 500 without crashing (D6-03 / D8-05)", async (t) => {
  const fake = await startFakeEveros({ addStatus: 500 });
  const testDataDir = makeTempDir();
  const transcriptDir = makeTempDir();
  const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    transcriptFile,
    [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "will fail 500" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "answer" }),
    ].join("\n") + "\n",
    "utf8"
  );

  const res = await runHookScript(
    "hooks/scripts/capture.js",
    { conversationId: "conv_500_test", transcriptPath: transcriptFile },
    { EVEROS_AG_BASE_URL: fake.baseUrl, EVEROS_AG_DATA_DIR: testDataDir }
  );

  assert.equal(res.code, 0);
  const state = loadSessionState(testDataDir, "conv_500_test");
  assert.equal(state.settled_turn_index, -1); // Must not advance
  assert.equal(state.observed_turn_index, 1);  // But observation is logged
});

test("failure-branches: flush.js --background fast short-circuits when flush_abandoned is true (D6-03 / D8-05)", async (t) => {
  const fake = await startFakeEveros();
  const testDataDir = makeTempDir();

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  const state = createDefaultSessionState("conv_abandoned_fast", { projectId: "proj_abandoned" });
  state.flush_abandoned = true;
  state.flush_attempts = 3;
  saveSessionState(testDataDir, state);

  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
  const flushScript = path.resolve(here, "../hooks/scripts/flush.js");

  const { spawn } = await import("node:child_process");
  await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [flushScript, "--background", "conv_abandoned_fast"],
      {
        env: {
          ...process.env,
          EVEROS_AG_BASE_URL: fake.baseUrl,
          EVEROS_AG_DATA_DIR: testDataDir,
        },
        stdio: "ignore",
      }
    );
    child.on("close", resolve);
  });

  // No flush call should be made to fakeEveros
  assert.equal(fake.only("/api/v2/memory/flush").length, 0);
});

test("failure-branches: provision does not attempt spawn when non-loopback host fails (D6-03 / D8-05)", async () => {
  let spawnCalls = 0;
  const fakeClient = {
    async health() {
      throw new Error("DNS resolution failed");
    },
  };

  const res = await ensureServerRunning(
    { baseUrl: "https://remote.production.internal:8000", startCmd: ["echo", "never"] },
    { client: fakeClient, spawnImpl: () => { spawnCalls++; return { unref() {} }; } }
  );

  assert.equal(res.ok, false);
  assert.equal(res.spawned, false);
  assert.equal(res.reason, "server_offline");
  assert.equal(spawnCalls, 0);
});

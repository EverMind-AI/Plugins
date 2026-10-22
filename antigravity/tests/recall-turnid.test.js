import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { loadSessionState } from "../hooks/scripts/lib/state.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-recall-turnid-test-"));
}

test("recall: turnId binds to step_index and contentDigest (D2-03)", async (t) => {
  let searchCallCount = 0;
  const fake = await startFakeEveros({
    searchFn: (body) => {
      searchCallCount++;
      return {
        episodes: [
          {
            subject: "Turn ID Test",
            summary: `Recall hit #${searchCallCount}`,
            atomic_facts: ["Verified digest binding"],
          },
        ],
        profiles: [],
      };
    },
  });

  const testDataDir = makeTempDir();
  const transcriptDir = makeTempDir();
  const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  const conversationId = "conv_turnid_test";
  const baseEnv = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_USER_ID: "tester",
    EVEROS_AG_PROJECT_ID: "project_turnid",
    EVEROS_AG_RECALL_TIMEOUT_MS: "2000",
  };

  // Run 1: First turn with step_index 0, content "First complex design question about architecture"
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      created_at: "2026-10-22T10:00:00Z",
      content: "First complex design question about architecture",
    }) + "\n",
    "utf8"
  );

  const res1 = await runHookScript(
    "hooks/scripts/recall.js",
    {
      conversationId,
      workspacePaths: ["/mock/workspace"],
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(res1.code, 0);
  assert.equal(searchCallCount, 2); // Dual track (user + agent)
  assert.ok(res1.json?.injectSteps?.[0]?.ephemeralMessage?.includes("Turn ID Test"));

  const state1 = loadSessionState(testDataDir, conversationId);
  assert.equal(state1.recalled_turn_ids.length, 1);
  const turnId1 = state1.recalled_turn_ids[0];
  assert.match(turnId1, /^turn_0_[0-9a-f]{8}$/);

  // Run 2: Exact same step, same content -> should be deduped (short-circuit)
  const res2 = await runHookScript(
    "hooks/scripts/recall.js",
    {
      conversationId,
      workspacePaths: ["/mock/workspace"],
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(res2.code, 0);
  assert.equal(searchCallCount, 2); // No new search calls made
  assert.deepEqual(res2.json, {}); // Short-circuited with {}

  // Run 3: Same step_index 0, but different content -> should generate different turnId and trigger search!
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      created_at: "2026-10-22T10:05:00Z",
      content: "Different prompt at step 0 requiring recall",
    }) + "\n",
    "utf8"
  );

  const res3 = await runHookScript(
    "hooks/scripts/recall.js",
    {
      conversationId,
      workspacePaths: ["/mock/workspace"],
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(res3.code, 0);
  assert.equal(searchCallCount, 4); // 2 more search calls executed!
  assert.ok(res3.json?.injectSteps?.[0]?.ephemeralMessage?.includes("Turn ID Test"));

  const state3 = loadSessionState(testDataDir, conversationId);
  assert.equal(state3.recalled_turn_ids.length, 2);
  const turnId2 = state3.recalled_turn_ids[1];
  assert.notEqual(turnId1, turnId2);
  assert.match(turnId2, /^turn_0_[0-9a-f]{8}$/);
});

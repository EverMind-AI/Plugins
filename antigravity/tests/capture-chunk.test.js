import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { getSessionFilePath } from "../hooks/scripts/lib/state.js";

function buildTranscript(file, steps) {
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      content: "<USER_REQUEST>heavy batch test</USER_REQUEST>",
    }),
  ];
  for (let i = 1; i <= steps; i++) {
    lines.push(
      JSON.stringify({
        step_index: i,
        type: "PLANNER_RESPONSE",
        content: `step ${i}`,
      })
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

test("capture: multi-chunk retry does not duplicate already acknowledged chunks (D2-01)", async (t) => {
  const fake = await startFakeEveros();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-test-chunk-"));
  const tDir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-test-tr-"));
  const transcript = path.join(tDir, "transcript.jsonl");
  buildTranscript(transcript, 600); // 601 messages -> chunk 1 (500), chunk 2 (101)

  t.after(async () => {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tDir, { recursive: true, force: true });
  });

  const env = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: dataDir,
    EVEROS_AG_PROJECT_ID: "github.com_test_chunk",
    EVEROS_AG_USER_ID: "tester",
  };

  // Run 1: Reject second chunk only
  let addCalls = 0;
  fake.setAddHandler(() => {
    addCalls++;
    return addCalls === 2 ? "fail" : "ok";
  });

  const run1 = await runHookScript(
    "hooks/scripts/capture.js",
    { conversationId: "conv_chunk_test", transcriptPath: transcript },
    env
  );

  assert.equal(run1.code, 0);
  assert.equal(fake.only("/api/v2/memory/add").length, 2);

  const stateFile = getSessionFilePath(dataDir, "conv_chunk_test");
  const state1 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state1.settled_turn_index, -1, "settled_turn_index must not advance on partial failure");
  assert.equal(state1.pending_batch.acked_chunks, 1, "pending_batch.acked_chunks must record 1 chunk succeeded");

  // Run 2: Backend recovers, retry must NOT re-send chunk 1
  const run2 = await runHookScript(
    "hooks/scripts/capture.js",
    { conversationId: "conv_chunk_test", transcriptPath: transcript },
    env
  );

  assert.equal(run2.code, 0);
  const allAdds = fake.only("/api/v2/memory/add");
  assert.equal(allAdds.length, 3, "Total /add calls across run 1 and 2 must be 3 (run 2 sent only chunk 2)");
  assert.equal(allAdds[2].body.messages.length, 101, "Run 2 must only send chunk 2 (101 messages)");

  const state2 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state2.settled_turn_index, 600, "settled_turn_index must advance after full batch completes");
  assert.equal(state2.pending_batch, null, "pending_batch must be cleared after batch completes");
});

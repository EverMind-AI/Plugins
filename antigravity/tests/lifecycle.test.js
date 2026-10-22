import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import {
  loadSessionState,
  saveSessionState,
  getSessionFilePath,
  createDefaultSessionState,
} from "../hooks/scripts/lib/state.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-lifecycle-test-"));
}

function createMockSearch(includeProfileByDefault = false) {
  return (body) => {
    const shouldIncludeProfile = body.include_profile ?? includeProfileByDefault;
    return {
      episodes: [
        {
          subject: "Architecture Design",
          summary: "Decoupled state machine",
          atomic_facts: ["All hooks are stateless and fail-open"],
        },
      ],
      agent_cases: [
        {
          task_intent: "Event bus design",
          key_insight: "Zero runtime dependencies",
        },
      ],
      profile: shouldIncludeProfile
        ? {
            profile_data: {
              explicit_info: { encoding: "utf-8", dependencies: "pure ESM zero-dep" },
              implicit_traits: ["Prefers two-phase commit over optimistic mutation"],
            },
          }
        : null,
    };
  };
}

test("lifecycle: full end-to-end integration flow", async (t) => {
  const fake = await startFakeEveros({ searchFn: createMockSearch(true) });
  const testDataDir = makeTempDir();
  const transcriptDir = makeTempDir();
  const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  const baseEnv = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_USER_ID: "tester",
    EVEROS_AG_PROJECT_ID: "github.com_artemis_repo",
    EVEROS_AG_RECALL_TIMEOUT_MS: "2000",
  };

  const conversationId = "conv_lifecycle_001";

  // -------------------------------------------------------------
  // Step 1: SessionStart - Daemon health check + L1 Profile injection
  // -------------------------------------------------------------
  const sessionStartRes = await runHookScript(
    "hooks/scripts/session-start.js",
    {
      conversationId,
      workspacePaths: ["C:/Workspace/MockRepo"],
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(sessionStartRes.code, 0);
  assert.ok(sessionStartRes.json);
  assert.ok(sessionStartRes.json.injectSteps);
  assert.equal(sessionStartRes.json.injectSteps.length, 1);
  const sysMsg = sessionStartRes.json.injectSteps[0].systemMessage.systemMessage;
  assert.match(sysMsg, /<everos_profile>/);
  assert.match(sysMsg, /【既定规约】/);
  assert.match(sysMsg, /pure ESM zero-dep/);

  // Verify state has_injected_profile
  const stateAfterStart = loadSessionState(testDataDir, conversationId);
  assert.equal(stateAfterStart.has_injected_profile, true);

  // -------------------------------------------------------------
  // Step 2: PreInvocation (Recall) - Turn 0
  // -------------------------------------------------------------
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      content: "<USER_REQUEST>请设计一个零依赖的高性能事件总线系统</USER_REQUEST>",
    }) + "\n",
    "utf8"
  );

  const recall1Res = await runHookScript(
    "hooks/scripts/recall.js",
    {
      conversationId,
      invocationNum: 1,
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(recall1Res.code, 0);
  assert.ok(recall1Res.json.injectSteps);
  const ephemeralMsg = recall1Res.json.injectSteps[0].ephemeralMessage;
  assert.match(ephemeralMsg, /<everos_memory>/);
  assert.match(ephemeralMsg, /【空间归属】project_id: github.com_artemis_repo/);
  assert.match(ephemeralMsg, /【曾有范例】/);
  assert.match(ephemeralMsg, /Event bus design/);

  // State should have turn_0 recorded in recalled_turn_ids (turnId includes sha1 digest)
  const stateAfterRecall1 = loadSessionState(testDataDir, conversationId);
  assert.equal(stateAfterRecall1.recalled_turn_ids.length, 1);
  assert.match(stateAfterRecall1.recalled_turn_ids[0], /^turn_0_[0-9a-f]{8}$/);

  // -------------------------------------------------------------
  // Step 3: Tool Loop Double-Lock - Turn 0 repeated invocation
  // -------------------------------------------------------------
  const recall2Res = await runHookScript(
    "hooks/scripts/recall.js",
    {
      conversationId,
      invocationNum: 2,
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(recall2Res.code, 0);
  assert.deepEqual(recall2Res.json, {}); // Double-lock intercepted!

  // -------------------------------------------------------------
  // Step 4: Stop (Capture) - Turn 0 completion & 2PC Ingestion
  // -------------------------------------------------------------
  fs.appendFileSync(
    transcriptFile,
    [
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        thinking: "internal thoughts that should be stripped",
        tool_calls: [
          {
            tool: "write_file",
            arguments: { Path: "bus.js", Content: "export class Bus {}" },
          },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        type: "GENERIC",
        content: "File written successfully",
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        content: "事件总线已设计完成并落盘。",
      }),
    ].join("\n") + "\n",
    "utf8"
  );

  const initialAddCalls = fake.only("/api/v2/memory/add").length;

  const captureRes = await runHookScript(
    "hooks/scripts/capture.js",
    {
      conversationId,
      transcriptPath: transcriptFile,
      terminationReason: "turn_completed",
    },
    baseEnv
  );

  assert.equal(captureRes.code, 0);
  assert.deepEqual(captureRes.json, {});

  // Verify fake received /add
  const addCallsAfter = fake.only("/api/v2/memory/add");
  assert.equal(addCallsAfter.length, initialAddCalls + 1);
  const addPayload = addCallsAfter[addCallsAfter.length - 1].body;
  assert.equal(addPayload.project_id, "github.com_artemis_repo");
  assert.equal(addPayload.session_id, conversationId);
  // Verify thinking is stripped
  assert.equal(JSON.stringify(addPayload).includes("internal thoughts"), false);

  // Verify 2PC settlement advanced
  const stateAfterCapture = loadSessionState(testDataDir, conversationId);
  assert.equal(stateAfterCapture.observed_turn_index, 3);
  assert.equal(stateAfterCapture.settled_turn_index, 3);

  // -------------------------------------------------------------
  // Step 5: 2PC Resilience - Network Error Keeps Settled Turn Unadvanced
  // -------------------------------------------------------------
  fs.appendFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 4,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      content: "<USER_REQUEST>请继续添加单元测试</USER_REQUEST>",
    }) + "\n",
    "utf8"
  );

  // Simulate network failure by pointing to non-existent port
  const badEnv = { ...baseEnv, EVEROS_AG_BASE_URL: "http://127.0.0.1:59999" };
  const captureFailRes = await runHookScript(
    "hooks/scripts/capture.js",
    {
      conversationId,
      transcriptPath: transcriptFile,
    },
    badEnv
  );

  assert.equal(captureFailRes.code, 0); // Fail-open: exit code 0
  const stateAfterFailedCapture = loadSessionState(testDataDir, conversationId);
  // Observed was updated to 4, but settled index remains 3 (Nack!)
  assert.equal(stateAfterFailedCapture.observed_turn_index, 4);
  assert.equal(stateAfterFailedCapture.settled_turn_index, 3);

  // -------------------------------------------------------------
  // Step 6: Stale Sweep 2PC Compensation in SessionStart
  // -------------------------------------------------------------
  // Create an orphan stale session in dataDir
  const staleSessionId = "conv_stale_999";
  const staleState = createDefaultSessionState(staleSessionId, {
    projectId: "github.com_other_repo",
    flushed: false,
  });
  staleState.updated_at = Date.now() - 3600 * 1000; // 1 hour ago
  const staleFile = getSessionFilePath(testDataDir, staleSessionId);
  fs.writeFileSync(staleFile, JSON.stringify(staleState, null, 2), "utf8");

  // Run SessionStart for a new session
  const res2 = await runHookScript(
    "hooks/scripts/session-start.js",
    {
      conversationId: "conv_new_002",
      workspacePaths: ["C:/Workspace/MockRepo"],
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  // Verify fake received /flush for github.com_other_repo (detached background flush)
  for (let attempt = 0; attempt < 40; attempt++) {
    const calls = fake
      .only("/api/v2/memory/flush")
      .filter((c) => c.body?.project_id === "github.com_other_repo");
    if (calls.length >= 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const flushCalls = fake
    .only("/api/v2/memory/flush")
    .filter((c) => c.body?.project_id === "github.com_other_repo");
  assert.equal(flushCalls.length, 1);

  // Verify stale state was marked flushed: true
  for (let attempt = 0; attempt < 40; attempt++) {
    const s = loadSessionState(testDataDir, staleSessionId);
    if (s.flushed) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const reloadedStale = loadSessionState(testDataDir, staleSessionId);
  assert.equal(reloadedStale.flushed, true);

  // -------------------------------------------------------------
  // Step 7: Flush Script (Explicit 2PC Seal)
  // -------------------------------------------------------------
  const flushRes = await runHookScript(
    "hooks/scripts/flush.js",
    {
      conversationId,
    },
    baseEnv
  );
  assert.equal(flushRes.code, 0);
  assert.equal(flushRes.json.success, true);
  const reloadedMain = loadSessionState(testDataDir, conversationId);
  assert.equal(reloadedMain.flushed, true);

  // -------------------------------------------------------------
  // Step 8: Strict Audit Verification - Wire Payload app_id Invariant
  // -------------------------------------------------------------
  const everosRequests = fake.requests.filter((r) => r.path.startsWith("/api/v2/memory/"));
  assert.ok(everosRequests.length >= 4);
  for (const req of everosRequests) {
    assert.equal(
      req.body?.app_id,
      "antigravity",
      `Expected app_id: 'antigravity' on ${req.method} ${req.path}`
    );
  }
});

test("lifecycle: cold-start profile fallback in PreInvocation", async (t) => {
  const fake = await startFakeEveros({ searchFn: createMockSearch(false) });
  const testDataDir = makeTempDir();
  const transcriptDir = makeTempDir();
  const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  const baseEnv = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_USER_ID: "tester",
    EVEROS_AG_PROJECT_ID: "github.com_cold_start",
  };

  const conversationId = "conv_cold_fallback";

  // Simulate SessionStart when server was dead:
  // We manually write state with has_injected_profile: false
  const state = createDefaultSessionState(conversationId, {
    projectId: "github.com_cold_start",
    has_injected_profile: false,
  });
  saveSessionState(testDataDir, state);

  // User input prompt in transcript
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      content: "<USER_REQUEST>如何配置零运行时依赖构建系统？</USER_REQUEST>",
    }) + "\n",
    "utf8"
  );

  // Trigger recall when server is now healthy
  const recallRes = await runHookScript(
    "hooks/scripts/recall.js",
    {
      conversationId,
      invocationNum: 1,
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(recallRes.code, 0);
  assert.ok(recallRes.json);
  assert.ok(recallRes.json.injectSteps);
  const ephemeralMsg = recallRes.json.injectSteps[0].ephemeralMessage;
  // Should contain BOTH profile fallback (<everos_profile>) and memory (<everos_memory>)
  assert.match(ephemeralMsg, /<everos_profile>/);
  assert.match(ephemeralMsg, /<everos_memory>/);

  // State should be updated: has_injected_profile becomes true
  const stateAfterFallback = loadSessionState(testDataDir, conversationId);
  assert.equal(stateAfterFallback.has_injected_profile, true);
});

test("lifecycle: stale sweep preserves unflushed Nack when flush returns 500", async (t) => {
  const fake = await startFakeEveros({ flushStatus: 500 });
  const testDataDir = makeTempDir();
  const transcriptDir = makeTempDir();
  const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  const baseEnv = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_PROJECT_ID: "github.com_fail_flush",
  };

  const staleSessionId = "conv_stale_fail";
  const staleState = createDefaultSessionState(staleSessionId, {
    projectId: "github.com_fail_flush",
    flushed: false,
  });
  staleState.updated_at = Date.now() - 3600 * 1000;
  fs.writeFileSync(
    getSessionFilePath(testDataDir, staleSessionId),
    JSON.stringify(staleState)
  );

  const res = await runHookScript(
    "hooks/scripts/session-start.js",
    {
      conversationId: "conv_fresh",
      transcriptPath: transcriptFile,
    },
    baseEnv
  );
  assert.equal(res.code, 0);

  // Stale session must remain unflushed (Nack)
  const reloaded = loadSessionState(testDataDir, staleSessionId);
  assert.equal(reloaded.flushed, false);
});

test("lifecycle: capture chunks messages when count exceeds ADD_MAX_MESSAGES (500)", async (t) => {
  const fake = await startFakeEveros();
  const testDataDir = makeTempDir();
  const transcriptDir = makeTempDir();
  const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  const baseEnv = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_PROJECT_ID: "github.com_large_turn",
  };

  const conversationId = "conv_large_batch";

  // Generate 600 turns/steps to exceed 500 limit
  const lines = [];
  lines.push(
    JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      content: "<USER_REQUEST>Start heavy batch task</USER_REQUEST>",
    })
  );

  for (let i = 1; i <= 600; i++) {
    lines.push(
      JSON.stringify({
        step_index: i,
        type: "PLANNER_RESPONSE",
        content: `Step chunk item ${i}`,
      })
    );
  }

  fs.writeFileSync(transcriptFile, lines.join("\n") + "\n", "utf8");

  const captureRes = await runHookScript(
    "hooks/scripts/capture.js",
    {
      conversationId,
      transcriptPath: transcriptFile,
    },
    baseEnv
  );

  assert.equal(captureRes.code, 0);

  // Verify fake received multiple /add requests, each strictly <= 500 messages
  const addRequests = fake.only("/api/v2/memory/add");
  assert.ok(addRequests.length >= 2, `Expected at least 2 chunked batches, got ${addRequests.length}`);
  for (const req of addRequests) {
    assert.ok(req.body.messages.length <= 500);
    assert.equal(req.body.app_id, "antigravity");
  }

  // 2PC Settle Phase advanced to step 600
  const state = loadSessionState(testDataDir, conversationId);
  assert.equal(state.settled_turn_index, 600);
});

test("lifecycle: root hooks.json adheres to schema and referenced script files exist", () => {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const hooksJsonPath = path.join(pluginRoot, "hooks.json");

  assert.ok(fs.existsSync(hooksJsonPath), "hooks.json must exist in plugin root");
  const raw = fs.readFileSync(hooksJsonPath, "utf8");
  const parsed = JSON.parse(raw);

  assert.ok(parsed["everos-antigravity"]);
  const config = parsed["everos-antigravity"];
  assert.ok(Array.isArray(config.SessionStart));
  assert.ok(Array.isArray(config.PreInvocation));
  assert.ok(Array.isArray(config.Stop));

  for (const event of ["SessionStart", "PreInvocation", "Stop"]) {
    for (const hook of config[event]) {
      assert.equal(hook.type, "command");
      const match = hook.command.match(/node\s+"([^"]+)"/);
      assert.ok(match, `Invalid command format in ${event}`);
      const scriptRel = match[1].replace(/^\$\{[A-Z_]*PLUGIN_ROOT:-?\.?\}\//, "");
      const targetScript = path.join(pluginRoot, scriptRel);
      assert.ok(fs.existsSync(targetScript), `Script file ${scriptRel} does not exist`);
    }
  }
});

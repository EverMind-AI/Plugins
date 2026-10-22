import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAndSortTranscript,
  sliceTurn,
  truncateMiddle,
  extractUserPrompt,
  toEverosMessages,
  readTranscriptIncremental,
} from "../hooks/scripts/lib/transcript.js";
import { validateAdd } from "./helpers/contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseAndSortTranscript handles out-of-order steps and overwrites by step_index", () => {
  const lines = [
    JSON.stringify({ step_index: 2, content: "step 2" }),
    JSON.stringify({ step_index: 0, content: "step 0 draft" }),
    "{ invalid json line",
    JSON.stringify({ step_index: 0, content: "step 0 final" }), // overwrite
    JSON.stringify({ step_index: 1, content: "step 1" }),
  ].join("\n");

  const parsed = parseAndSortTranscript(lines);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].step_index, 0);
  assert.equal(parsed[0].content, "step 0 final");
  assert.equal(parsed[1].step_index, 1);
  assert.equal(parsed[2].step_index, 2);
});

test("sliceTurn correctly extracts turns by turnId and isolates turn boundaries", () => {
  const entries = [
    { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT" },
    { step_index: 1, type: "PLANNER_RESPONSE" },
    { step_index: 2, type: "GENERIC" },
    { step_index: 3, type: "USER_INPUT", source: "USER_EXPLICIT" },
    { step_index: 4, type: "PLANNER_RESPONSE" },
  ];

  const turn0 = sliceTurn(entries, "turn_0");
  assert.equal(turn0.length, 3);
  assert.equal(turn0[0].step_index, 0);
  assert.equal(turn0[2].step_index, 2);

  const turn3 = sliceTurn(entries, "turn_3");
  assert.equal(turn3.length, 2);
  assert.equal(turn3[0].step_index, 3);
  assert.equal(turn3[1].step_index, 4);
});

test("truncateMiddle preserves head and tail and inserts standard trimming notice", () => {
  const shortText = "Short text";
  assert.equal(truncateMiddle(shortText, 50), shortText);

  const longText = "HEAD_START_" + "x".repeat(200) + "_TAIL_END";
  const truncated = truncateMiddle(longText, 30);
  assert.match(truncated, /^HEAD_START_/);
  assert.match(truncated, /_TAIL_END$/);
  assert.match(truncated, /trimmed \d+ chars by the EverOS Antigravity plugin/);
});

test("extractUserPrompt unwraps <USER_REQUEST> tags and cleans host noise tags", () => {
  const wrapped = "<USER_REQUEST>\nFix this bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime=now\n</ADDITIONAL_METADATA>";
  assert.equal(extractUserPrompt(wrapped), "Fix this bug");

  const withReminder = "<USER_REQUEST>Execute command<system-reminder>Host internal</system-reminder></USER_REQUEST>";
  assert.equal(extractUserPrompt(withReminder), "Execute command");

  const bare = "Plain prompt without tags";
  assert.equal(extractUserPrompt(bare), bare);
});

test("toEverosMessages strips thinking, pairs tools, reduces subagents, and applies Dummy Tool Synth", () => {
  const fixturePath = path.join(root, "tests", "fixtures", "transcript-antigravity.jsonl");
  const rawText = fs.readFileSync(fixturePath, "utf8");
  const allEntries = parseAndSortTranscript(rawText);

  // 1. Test Turn 0 (normal single tool call)
  const turn0Entries = sliceTurn(allEntries, "turn_0");
  const turn0Messages = toEverosMessages(turn0Entries, { userId: "developer_alice", agentId: "antigravity" });

  assert.equal(turn0Messages.length, 4);
  assert.equal(turn0Messages[0].role, "user");
  assert.equal(turn0Messages[0].content, "Initialize EverOS Antigravity Plugin");
  assert.equal(turn0Messages[1].role, "assistant");
  assert.equal(turn0Messages[1].tool_calls.length, 1);
  assert.equal(turn0Messages[1].tool_calls[0].id, "call_1_0");
  assert.equal("thinking" in turn0Messages[1], false); // thinking completely stripped!
  assert.equal(turn0Messages[2].role, "tool");
  assert.equal(turn0Messages[2].tool_call_id, "call_1_0");
  assert.equal(turn0Messages[3].role, "assistant");

  // Validate EverOS contract compliance for Turn 0
  const contractErrors0 = validateAdd({
    session_id: "sess_0",
    app_id: "antigravity",
    messages: turn0Messages,
  });
  assert.deepEqual(contractErrors0, []);

  // 2. Test Turn 4 (invoke_subagent dimensionality reduction)
  const turn4Entries = sliceTurn(allEntries, "turn_4");
  const turn4Messages = toEverosMessages(turn4Entries, { userId: null, agentId: "antigravity" });

  assert.equal(turn4Messages[0].sender_id, "user"); // null userId falls back to "user"
  const subagentCall = turn4Messages[1].tool_calls[0];
  assert.equal(subagentCall.function.name, "invoke_subagent");
  const parsedArgs = JSON.parse(subagentCall.function.arguments);
  assert.deepEqual(parsedArgs, {
    subagent_role: "CodeAuditor",
    prompt: "Perform deep architectural audit",
  });

  // 3. Test Turn 7 (Error tool status + Dummy Tool Synth on interruption)
  const turn7Entries = sliceTurn(allEntries, "turn_7");
  const turn7Messages = toEverosMessages(turn7Entries, { userId: "tester", agentId: "antigravity" });

  // Anti-recursive memory stripping on user prompt:
  assert.equal(turn7Messages[0].content, "Run tool and interrupt");
  assert.doesNotMatch(turn7Messages[0].content, /【既定规约】/);

  // Tool 1: executed with error
  assert.equal(turn7Messages[2].role, "tool");
  assert.equal(turn7Messages[2].tool_call_id, "call_8_0");
  assert.match(turn7Messages[2].content, /^\[tool error\] Command crashed with code 1/);

  // Tool 2: interrupted (Dummy Tool Synth must synthesize orphan call response!)
  assert.equal(turn7Messages[3].role, "tool");
  assert.equal(turn7Messages[3].tool_call_id, "call_8_1");
  assert.equal(turn7Messages[3].content, "[tool interrupted or canceled by user]");

  // Validate EverOS contract on synthesized messages
  const contractErrors7 = validateAdd({
    session_id: "sess_7",
    app_id: "antigravity",
    messages: turn7Messages,
  });
  assert.deepEqual(contractErrors7, []);
});

test("toEverosMessages closes unfulfilled tool calls BEFORE next assistant message in multi-invocation turns", () => {
  // Turn with 2 invocations:
  // Invocation 1: calls A (call_1_0) and B (call_1_1).
  // A finishes, but B is canceled / missing GENERIC.
  // Invocation 2: calls C (call_3_0). C finishes.
  const turnEntries = [
    { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "Multi-invocation test" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      content: "Calling A and B",
      tool_calls: [
        { name: "toolA", args: {} },
        { name: "toolB", args: {} },
      ],
    },
    { step_index: 2, type: "GENERIC", status: "DONE", content: "Result of tool A" },
    // Notice: tool B has no GENERIC here!
    {
      step_index: 3,
      type: "PLANNER_RESPONSE",
      content: "Calling C after B failed",
      tool_calls: [{ name: "toolC", args: {} }],
    },
    { step_index: 4, type: "GENERIC", status: "DONE", content: "Result of tool C" },
    { step_index: 5, type: "PLANNER_RESPONSE", content: "All done" },
  ];

  const messages = toEverosMessages(turnEntries, { userId: "tester", agentId: "antigravity" });

  // Expected sequence preserving strict OpenAI topology:
  // 0: user
  // 1: assistant (calls A, B)
  // 2: tool (call_1_0, Result of tool A)
  // 3: tool (call_1_1, [tool interrupted or canceled by user] -> SYNTHESIZED BEFORE NEXT ASSISTANT!)
  // 4: assistant (calls C)
  // 5: tool (call_3_0, Result of tool C)
  // 6: assistant (All done)
  assert.equal(messages.length, 7);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].tool_call_id, "call_1_0");
  assert.equal(messages[2].content, "Result of tool A");

  assert.equal(messages[3].role, "tool");
  assert.equal(messages[3].tool_call_id, "call_1_1");
  assert.equal(messages[3].content, "[tool interrupted or canceled by user]");

  assert.equal(messages[4].role, "assistant");
  assert.equal(messages[5].role, "tool");
  assert.equal(messages[5].tool_call_id, "call_3_0");
  assert.equal(messages[5].content, "Result of tool C");

  assert.equal(messages[6].role, "assistant");

  // Validate EverOS contract on multi-invocation topology
  const errors = validateAdd({
    session_id: "sess_multi",
    app_id: "antigravity",
    messages,
  });
  assert.deepEqual(errors, []);
});

test("toEverosMessages handles lowercase subagent argument names", () => {
  const turnEntries = [
    { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "Delegate task" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      content: "Delegating",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: { role: "CodeReviewer", prompt: "Review PR #123" }, // lowercase keys
        },
      ],
    },
    { step_index: 2, type: "GENERIC", status: "DONE", content: "Review passed." },
  ];

  const messages = toEverosMessages(turnEntries, { userId: "tester", agentId: "antigravity" });
  assert.equal(messages[1].role, "assistant");
  const call = messages[1].tool_calls[0];
  const parsed = JSON.parse(call.function.arguments);
  assert.deepEqual(parsed, {
    subagent_role: "CodeReviewer",
    prompt: "Review PR #123",
  });
});

test("toEverosMessages preserves subagent conversationId and TypeName metadata", () => {
  const turnEntries = [
    { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "Delegate with metadata" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      content: "Delegating with subagent ID",
      tool_calls: [
        {
          name: "invoke_subagent",
          args: {
            role: "SecurityAuditor",
            prompt: "Scan repo",
            conversationId: "subagent_conv_888",
            TypeName: "research",
          },
        },
      ],
    },
    { step_index: 2, type: "GENERIC", status: "DONE", content: "Audit completed" },
  ];

  const messages = toEverosMessages(turnEntries, { userId: "tester", agentId: "antigravity" });
  assert.equal(messages[1].role, "assistant");
  const call = messages[1].tool_calls[0];
  const parsed = JSON.parse(call.function.arguments);
  assert.deepEqual(parsed, {
    subagent_role: "SecurityAuditor",
    prompt: "Scan repo",
    subagent_id: "subagent_conv_888",
    type_name: "research",
  });
});

test("readTranscriptIncremental reads new slices via byte offset cursor with atomic line boundary defense", (t) => {
  const os = process.platform === "win32" ? "win32" : "posix";
  const tmpFile = path.join(root, `temp_transcript_${Date.now()}_${process.pid}.jsonl`);

  t.after(() => {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
  });

  // 1. Initial write: two complete lines
  const line1 = JSON.stringify({ step_index: 1, content: "line 1" }) + "\n";
  const line2 = JSON.stringify({ step_index: 2, content: "line 2" }) + "\n";
  fs.writeFileSync(tmpFile, line1 + line2, "utf8");

  const firstRead = readTranscriptIncremental(tmpFile, 0);
  assert.equal(firstRead.entries.length, 2);
  assert.equal(firstRead.entries[0].step_index, 1);
  assert.equal(firstRead.entries[1].step_index, 2);
  assert.ok(firstRead.nextOffset > 0);

  // 2. Append: one half-written line (no trailing newline)
  const line3Half = JSON.stringify({ step_index: 3, content: "line 3 incomplete" });
  fs.appendFileSync(tmpFile, line3Half, "utf8");

  // Read with firstRead.nextOffset: should NOT consume the half-written line yet
  const secondRead = readTranscriptIncremental(tmpFile, firstRead.nextOffset);
  assert.equal(secondRead.entries.length, 0);
  assert.equal(secondRead.nextOffset, firstRead.nextOffset);

  // 3. Complete the line with newline and add line 4
  fs.appendFileSync(tmpFile, "\n" + JSON.stringify({ step_index: 4, content: "line 4" }) + "\n", "utf8");

  // Read again: now line 3 and line 4 should be consumed!
  const thirdRead = readTranscriptIncremental(tmpFile, firstRead.nextOffset);
  assert.equal(thirdRead.entries.length, 2);
  assert.equal(thirdRead.entries[0].step_index, 3);
  assert.equal(thirdRead.entries[1].step_index, 4);
  assert.ok(thirdRead.nextOffset > firstRead.nextOffset);

  // 4. Test file truncation (rewind to 0)
  fs.writeFileSync(tmpFile, JSON.stringify({ step_index: 99, content: "reset" }) + "\n", "utf8");
  const rewindRead = readTranscriptIncremental(tmpFile, thirdRead.nextOffset);
  assert.equal(rewindRead.entries.length, 1);
  assert.equal(rewindRead.entries[0].step_index, 99);
});

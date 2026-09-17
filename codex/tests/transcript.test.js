import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  lastTurnId,
  parseTranscript,
  readTurn,
  sliceTurn,
  toEverosMessages,
  truncateMiddle,
  turnIdOf,
} from "../hooks/scripts/lib/transcript.js";

const meta = (turn) => ({ internal_chat_message_metadata_passthrough: { turn_id: turn } });
const item = (payload, i = 0) => ({
  timestamp: `2026-09-16T12:00:${String(i).padStart(2, "0")}.000Z`,
  ordinal: i,
  type: "response_item",
  payload,
});
const message = (role, text, i, turn = "t1") =>
  item(
    {
      type: "message",
      role,
      id: `m${i}`,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      ...meta(turn),
    },
    i,
  );
const toolCall = (callId, name, input, i, turn = "t1") =>
  item({ type: "custom_tool_call", id: `c${i}`, call_id: callId, name, status: "completed", input, ...meta(turn) }, i);
const toolOutput = (callId, text, i, turn = "t1") =>
  item({ type: "custom_tool_call_output", id: `o${i}`, call_id: callId, output: [{ type: "output_text", text }], ...meta(turn) }, i);

const made = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-transcript-"));
  made.push(dir);
  return dir;
};
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

const ids = { userId: "u", agentId: "a" };
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join("\n");

test("a half-written last line does not lose the lines before it", () => {
  const text = `${JSON.stringify(item({ type: "message", role: "user", content: [] }, 0))}\n{"type":"resp`;
  assert.equal(parseTranscript(text).length, 1);
});

test("the turn stamp is read from the item, and from turn_context", () => {
  assert.equal(turnIdOf(message("user", "hi", 0, "turn-A")), "turn-A");
  assert.equal(turnIdOf({ type: "turn_context", payload: { turn_id: "turn-B" } }), "turn-B");
  assert.equal(turnIdOf({ type: "session_meta", payload: { id: "s" } }), null);
});

test("a turn is the items stamped with it, and nothing from its neighbours", () => {
  const entries = [
    message("user", "first turn", 0, "t1"),
    message("assistant", "answer one", 1, "t1"),
    message("user", "second turn", 2, "t2"),
    message("assistant", "answer two", 3, "t2"),
  ];
  const first = sliceTurn(entries, "t1");
  assert.equal(first.length, 2);
  assert.deepEqual(
    toEverosMessages(first, ids).map((m) => m.content),
    ["first turn", "answer one"],
  );
  assert.equal(sliceTurn(entries, "nope").length, 0);
  assert.equal(sliceTurn(entries, undefined).length, 0);
});

test("the last turn on disk is the one a Stop without a turn_id falls back to", () => {
  const entries = [message("user", "a", 0, "t1"), message("user", "b", 1, "t2")];
  assert.equal(lastTurnId(entries), "t2");
  assert.equal(lastTurnId([]), null);
});

test("the prompt the host reported is what gets stored, not the scaffolding beside it", () => {
  // Codex posts its plugin catalogue, the environment block and AGENTS.md as
  // role:"user" under the same turn_id. UserPromptSubmit is handed the real
  // prompt, so this is a lookup rather than a guess.
  const turn = [
    message("user", "<recommended_plugins>\nAirtable, Notion, ...\n</recommended_plugins>", 0),
    message("user", "# AGENTS.md instructions for /Users/x/repo\n<INSTRUCTIONS>...", 1),
    message("user", "why is the parser dropping the last row?", 2),
    message("assistant", "because of the off-by-one", 3),
  ];
  const out = toEverosMessages(turn, { ...ids, userPrompt: "why is the parser dropping the last row?" });
  assert.deepEqual(out.filter((m) => m.role === "user").map((m) => m.content), [
    "why is the parser dropping the last row?",
  ]);
});

test("a prompt the host appended context to is still recognised", () => {
  const turn = [message("user", "fix the flake\n\n<environment_context>cwd=/repo</environment_context>", 0)];
  const out = toEverosMessages(turn, { ...ids, userPrompt: "fix the flake" });
  assert.equal(out.length, 1);
  assert.match(out[0].content, /fix the flake/);
});

test("without a recorded prompt, scaffolding is dropped by shape and real words are kept", () => {
  // The fallback: a session that started before this plugin, or a turn where
  // UserPromptSubmit never ran. It fails toward keeping - storing a line of
  // scaffolding is noise, dropping the user's own words is a loss.
  const turn = [
    message("user", "<recommended_plugins>\ncatalogue\n</recommended_plugins>", 0),
    message("user", "<codex_internal_context source=\"goal\">\ncontinue\n</codex_internal_context>", 1),
    message("user", "# Context from my IDE setup:\n\n## Active file: a.ts", 2),
    message("user", "# AGENTS.md instructions for /repo\nrules", 3),
    message("user", "please rebase onto main", 4),
  ];
  const out = toEverosMessages(turn, ids); // no userPrompt
  assert.deepEqual(out.map((m) => m.content), ["please rebase onto main"]);
});

test("a long pasted prompt is not mistaken for scaffolding", () => {
  // The biggest surviving user messages in the real sample are genuine: a
  // 31 KB prompt that pastes a whole merge request is still the user talking.
  const pasted = `You are working on gitlab change repo!261\n${"context line\n".repeat(400)}`;
  const out = toEverosMessages([message("user", pasted, 0)], ids);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, pasted.trim()); // trailing newline is trimmed, nothing else
});

test("the host's own developer message never becomes a user message", () => {
  // Across 25 real sessions these outnumbered user messages 174 to 74.
  const turn = [message("developer", "You are Codex. Environment: ...", 0), message("user", "real question", 1)];
  const out = toEverosMessages(turn, ids);
  assert.deepEqual(out.map((m) => m.role), ["user"]);
  assert.equal(out[0].content, "real question");
});

test("an encrypted reasoning item is not stored", () => {
  const turn = [
    item({ type: "reasoning", id: "r1", encrypted_content: "OPAQUE", summary: [], ...meta("t1") }, 0),
    message("assistant", "done", 1),
  ];
  const out = toEverosMessages(turn, ids);
  assert.equal(out.length, 1);
  assert.equal(JSON.stringify(out).includes("OPAQUE"), false);
});

test("the UI echo of a message is not stored a second time", () => {
  const turn = [
    message("user", "only once", 0),
    { timestamp: "2026-09-16T12:00:01.000Z", ordinal: 1, type: "event_msg", payload: { type: "user_message", message: "only once" } },
  ];
  assert.equal(toEverosMessages(turn, ids).length, 1);
});

test("a tool call carries its call id and its already-serialized arguments", () => {
  const input = JSON.stringify({ command: ["git", "status"] });
  const out = toEverosMessages([toolCall("call_1", "exec", input, 0), toolOutput("call_1", "clean", 1)], ids);
  const call = out.find((m) => m.tool_calls);
  assert.equal(call.tool_calls[0].id, "call_1");
  assert.equal(call.tool_calls[0].function.name, "exec");
  assert.equal(call.tool_calls[0].function.arguments, input);
  const result = out.find((m) => m.role === "tool");
  assert.equal(result.tool_call_id, "call_1");
  assert.equal(result.content, "clean");
});

test("several outputs for one call collapse onto one row, keeping the text", () => {
  // A real long-running `exec` posted 16 outputs for one call, all empty.
  const turn = [toolCall("call_1", "exec", "{}", 0)];
  for (let i = 1; i <= 15; i += 1) turn.push(toolOutput("call_1", "", i));
  turn.push(toolOutput("call_1", "the real output", 16));
  const out = toEverosMessages(turn, ids);
  const rows = out.filter((m) => m.role === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "the real output");
});

test("a tool result whose call is not in this turn is dropped", () => {
  const out = toEverosMessages([message("user", "q", 0), toolOutput("call_from_before", "stale", 1)], ids);
  assert.equal(out.filter((m) => m.role === "tool").length, 0);
});

test("a message with no text is not stored as an empty one", () => {
  const turn = [item({ type: "message", role: "user", id: "m0", content: [], ...meta("t1") }, 0)];
  assert.equal(toEverosMessages(turn, ids).length, 0);
});

test("timestamps are milliseconds, in order", () => {
  const out = toEverosMessages([message("user", "a", 0), message("assistant", "b", 1)], ids);
  assert.ok(Number.isInteger(out[0].timestamp) && out[0].timestamp > 0);
  assert.ok(out[1].timestamp >= out[0].timestamp);
});

test("truncateMiddle keeps head and tail and says what it cut", () => {
  const out = truncateMiddle("x".repeat(500), 100);
  assert.ok(out.length < 500);
  assert.match(out, /trimmed \d+ chars/);
  assert.equal(truncateMiddle("short", 100), "short");
});

test("readTurn waits for the closing assistant message rather than capturing half a turn", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, jsonl([message("user", "q", 0), toolCall("c1", "exec", "{}", 1), toolOutput("c1", "out", 2)]));
  // The reply lands while readTurn is still retrying, exactly as it does live.
  setTimeout(() => {
    fs.appendFileSync(file, `\n${JSON.stringify(message("assistant", "the answer", 3))}`);
  }, 120);
  const turn = await readTurn(file, "t1", { attempts: 8, delayMs: 60 });
  const out = toEverosMessages(turn, ids);
  assert.equal(out.at(-1).role, "assistant");
  assert.equal(out.at(-1).content, "the answer");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an interrupted turn is captured rather than dropped", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, jsonl([message("user", "q", 0)])); // no reply will ever come
  const turn = await readTurn(file, "t1", { attempts: 2, delayMs: 10 });
  assert.equal(toEverosMessages(turn, ids).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing transcript is empty, not a throw", async () => {
  assert.deepEqual(await readTurn("/nonexistent/rollout.jsonl", "t1", { attempts: 1, delayMs: 1 }), []);
});

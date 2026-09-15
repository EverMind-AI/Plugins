import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseTranscript, sliceTurn, toEverosMessages, truncateMiddle, readTurn } from "../hooks/scripts/lib/transcript.js";
import { MEMORY_OPEN, MEMORY_CLOSE } from "../hooks/scripts/lib/render.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "transcript-basic.jsonl");
const raw = fs.readFileSync(FIXTURE, "utf8");
const IDS = { userId: "tester", agentId: "claude-code" };

function messages() {
  return toEverosMessages(sliceTurn(parseTranscript(raw), "prompt-A"), IDS);
}

test("parseTranscript skips malformed lines instead of throwing", () => {
  const entries = parseTranscript('{"type":"user"}\nnot json\n\n{"type":"assistant"}');
  assert.equal(entries.length, 2);
});

test("sliceTurn starts at the first entry carrying the prompt id", () => {
  const turn = sliceTurn(parseTranscript(raw), "prompt-A");
  assert.equal(turn[0].uuid, "u1");
  assert.equal(turn.at(-1).uuid, "a5");
});

test("sliceTurn stops at the next turn, so a queued prompt is not swallowed", () => {
  // Claude Code lets the user queue a prompt mid-turn, so by the time Stop fires
  // the transcript can already contain the following turn. Slicing to end of file
  // would capture it under this turn's id.
  const lines = [
    { type: "user", isSidechain: false, promptId: "p1", promptSource: "typed", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "first" } },
    { type: "assistant", isSidechain: false, requestId: "r1", timestamp: "2026-09-10T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer one" }] } },
    { type: "user", isSidechain: false, promptId: "p2", promptSource: "typed", timestamp: "2026-09-10T10:00:02.000Z", message: { role: "user", content: "second" } },
    { type: "assistant", isSidechain: false, requestId: "r2", timestamp: "2026-09-10T10:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const entries = parseTranscript(lines);
  const first = sliceTurn(entries, "p1");
  assert.deepEqual(first.map((e) => e.type), ["user", "assistant"]);
  assert.equal(toEverosMessages(first, IDS).some((m) => m.content.includes("second")), false);
  assert.equal(toEverosMessages(first, IDS).some((m) => m.content.includes("answer two")), false);
  const second = sliceTurn(entries, "p2");
  assert.deepEqual(second.map((e) => e.type), ["user", "assistant"]);
});

test("sliceTurn returns nothing for an unknown prompt id", () => {
  assert.deepEqual(sliceTurn(parseTranscript(raw), "no-such-prompt"), []);
});

test("sliceTurn drops sidechain entries so subagent traffic is never captured", () => {
  const turn = sliceTurn(parseTranscript(raw), "prompt-A");
  assert.equal(turn.some((e) => e.uuid === "side1" || e.uuid === "side2"), false);
});

test("only a promptSource-bearing user entry becomes a user message", () => {
  const users = messages().filter((m) => m.role === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].content, "use ruff, not black, in this repo");
  assert.equal(users[0].sender_id, "tester");
});

test("skill injections and command scaffolding are dropped", () => {
  const text = messages().map((m) => m.content).join("\n");
  assert.equal(text.includes("Base directory for this skill"), false);
  assert.equal(text.includes("<command-name>"), false);
});

test("only text blocks become message content", () => {
  const text = messages().map((m) => m.content).join("\n");
  assert.equal(text.includes("secret reasoning"), false, "thinking must not reach EverOS");
  // Real thinking blocks carry no `text` at all, so the typeof check alone would
  // drop them and this test would pass with the type check deleted. The
  // fixture's unknown block has a text field so the type check is the only
  // thing left standing.
  assert.equal(text.includes("must not leak"), false, "an unrecognised block type must not either");
});

test("consecutive assistant entries sharing a requestId merge into one message", () => {
  const assistants = messages().filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].content, "Checking the config.");
  assert.equal(assistants[0].tool_calls.length, 2, "both parallel tool calls on one message");
  assert.deepEqual(assistants[0].tool_calls.map((t) => t.id), ["toolu_1", "toolu_2"]);
  assert.equal(assistants[0].tool_calls[0].type, "function");
  assert.equal(assistants[0].tool_calls[0].function.name, "Read");
  assert.deepEqual(JSON.parse(assistants[0].tool_calls[0].function.arguments), { file_path: "/Users/me/proj/pyproject.toml" });
  assert.equal(assistants[1].content, "Ruff is configured; black is not used here.");
  assert.equal(assistants[1].tool_calls, undefined);
});

test("tool results become tool messages paired by tool_call_id", () => {
  const tools = messages().filter((m) => m.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].tool_call_id, "toolu_1");
  assert.equal(tools[0].content, "[tool.ruff]\nline-length = 88");
  assert.equal(tools[0].sender_id, "claude-code");
});

test("an error result is flagged and its list content is flattened", () => {
  const errorMessage = messages().find((m) => m.tool_call_id === "toolu_2");
  assert.equal(errorMessage.content, "[tool error] ruff: command not found");
});

test("a tool result with no text block still says what came back", () => {
  // Real transcripts carry 1232 tool_reference and 16 image blocks, and 206
  // tool_results whose content list holds no text at all. Mapping those to an
  // empty string put 206 information-free rows into memory.
  const line = [
    JSON.stringify({ type: "user", isSidechain: false, promptId: "p", promptSource: "typed", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", isSidechain: false, requestId: "r", timestamp: "2026-09-10T10:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "NotebookEdit", input: {} }, { type: "tool_use", id: "t2", name: "Read", input: {} }] } }),
    JSON.stringify({ type: "user", isSidechain: false, promptId: "p", toolUseResult: {}, timestamp: "2026-09-10T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "NotebookEdit" }] }] } }),
    JSON.stringify({ type: "user", isSidechain: false, promptId: "p", toolUseResult: {}, timestamp: "2026-09-10T10:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "image", source: {} }] }] } }),
  ].join("\n");
  const tools = toEverosMessages(sliceTurn(parseTranscript(line), "p"), IDS).filter((m) => m.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].content, "[tool_reference]");
  assert.equal(tools[1].content, "[tool error] [image]");
});

test("an orphan tool result is dropped because EverOS rejects it", () => {
  assert.equal(messages().some((m) => m.tool_call_id === "toolu_missing"), false);
  assert.equal(messages().some((m) => m.content.includes("orphan result")), false);
});

test("a tool result never reaches EverOS without a tool_call_id", () => {
  // This is the shape EverOS actually rejects: _boundary.py raises
  // ValueError for role="tool" with no tool_call_id, surfacing as a 500.
  // Verified against a live 1.3.1; an orphan with a non-null id is accepted.
  const line = [
    JSON.stringify({ type: "user", isSidechain: false, promptId: "p", promptSource: "typed", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "user", isSidechain: false, promptId: "p", toolUseResult: {}, timestamp: "2026-09-10T10:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", content: "no id at all" }] } }),
    JSON.stringify({ type: "assistant", isSidechain: false, requestId: "r", timestamp: "2026-09-10T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
  ].join("\n");
  const messages = toEverosMessages(sliceTurn(parseTranscript(line), "p"), IDS);
  assert.equal(messages.every((m) => m.role !== "tool" || typeof m.tool_call_id === "string"), true);
  assert.equal(messages.some((m) => m.content.includes("no id at all")), false);
});

test("every message carries a positive integer millisecond timestamp in order", () => {
  const ts = messages().map((m) => m.timestamp);
  assert.equal(ts.every((t) => Number.isInteger(t) && t > 0), true);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts);
  assert.equal(ts[0], Date.parse("2026-09-10T10:00:00.000Z"));
});

test("the message order is user, assistant, tools, assistant", () => {
  assert.deepEqual(messages().map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
});

test("a recalled memory block is stripped from the captured user message", () => {
  const line = JSON.stringify({
    type: "user", isSidechain: false, promptId: "p", promptSource: "typed", timestamp: "2026-09-10T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: `${MEMORY_OPEN}\nrecalled\n${MEMORY_CLOSE}\nmy real question here` }] },
  });
  const out = toEverosMessages(sliceTurn(parseTranscript(line), "p"), IDS);
  assert.equal(out[0].content, "my real question here");
});

test("string content on a user entry is accepted", () => {
  const line = JSON.stringify({
    type: "user", isSidechain: false, promptId: "p", promptSource: "sdk", timestamp: "2026-09-10T10:00:00.000Z",
    message: { role: "user", content: "plain string prompt" },
  });
  assert.equal(toEverosMessages(sliceTurn(parseTranscript(line), "p"), IDS)[0].content, "plain string prompt");
});

test("truncateMiddle keeps head and tail and reports what it cut", () => {
  const text = "a".repeat(100) + "b".repeat(100);
  const out = truncateMiddle(text, 50);
  assert.ok(out.length < text.length);
  assert.ok(out.startsWith("a".repeat(35)));
  assert.ok(out.endsWith("b".repeat(15)));
  assert.ok(out.includes("trimmed 150 chars"));
  assert.equal(truncateMiddle("short", 50), "short");
});

test("an oversized tool result is truncated", () => {
  const huge = "x".repeat(30000);
  const line = [
    JSON.stringify({ type: "user", isSidechain: false, promptId: "p", promptSource: "typed", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", isSidechain: false, requestId: "r", timestamp: "2026-09-10T10:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }),
    JSON.stringify({ type: "user", isSidechain: false, promptId: "p", toolUseResult: {}, timestamp: "2026-09-10T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: huge }] } }),
  ].join("\n");
  const toolMessage = toEverosMessages(sliceTurn(parseTranscript(line), "p"), IDS).find((m) => m.role === "tool");
  assert.ok(toolMessage.content.length < 21000);
  assert.ok(toolMessage.content.includes("trimmed"));
});

test("readTurn retries until the prompt id appears, then returns the slice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", isSidechain: false, promptId: "other", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "x" } }) + "\n");
  setTimeout(() => {
    fs.appendFileSync(file, JSON.stringify({ type: "user", isSidechain: false, promptId: "p", promptSource: "typed", timestamp: "2026-09-10T10:00:01.000Z", message: { role: "user", content: "late arrival" } }) + "\n");
  }, 150);
  const turn = await readTurn(file, "p");
  assert.equal(turn.length, 1);
  assert.equal(turn[0].promptId, "p");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readTurn waits for the assistant reply, not just for the prompt id", async () => {
  // Stop fires the moment the turn ends, and the assistant entry can reach disk
  // a fraction of a second later. Returning as soon as the prompt id appears
  // captured the user message alone and silently lost every reply.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-late-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, JSON.stringify({
    type: "user", isSidechain: false, promptId: "p", promptSource: "typed",
    timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "the question" },
  }) + "\n");
  setTimeout(() => {
    fs.appendFileSync(file, JSON.stringify({
      type: "assistant", isSidechain: false, requestId: "r",
      timestamp: "2026-09-10T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "the answer" }] },
    }) + "\n");
  }, 300);
  const turn = await readTurn(file, "p");
  const messages = toEverosMessages(turn, IDS);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(messages[1].content, "the answer");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readTurn gives up on an incomplete turn instead of blocking forever", async () => {
  // An interrupted turn may never get its closing assistant entry; capture what
  // is there rather than dropping the turn.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-partial-"));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, JSON.stringify({
    type: "user", isSidechain: false, promptId: "p", promptSource: "typed",
    timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "interrupted" },
  }) + "\n");
  const started = Date.now();
  const turn = await readTurn(file, "p", { attempts: 3, delayMs: 30 });
  assert.equal(turn.length, 1);
  assert.ok(Date.now() - started < 2000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readTurn returns an empty array for a missing file rather than throwing", async () => {
  assert.deepEqual(await readTurn("/nonexistent/path.jsonl", "p", { attempts: 1, delayMs: 1 }), []);
});

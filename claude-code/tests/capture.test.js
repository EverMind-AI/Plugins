import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { runHookScript } from "./helpers/run-hook.js";
import { readState, isStored } from "../hooks/scripts/lib/state.js";

const SCRIPT = "hooks/scripts/capture.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "transcript-basic.jsonl");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-capture-")); }
function envFor(server, dir, extra = {}) {
  return { EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj", ...extra };
}
const stdin = { session_id: "s1", prompt_id: "prompt-A", transcript_path: FIXTURE, cwd: "/w", hook_event_name: "Stop" };

test("a finished turn is posted with the identity fields and no stdout", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, stdin, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(stdout, "");
    const adds = server.only("/api/v2/memory/add");
    assert.equal(adds.length, 1);
    assert.equal(adds[0].body.session_id, "s1");
    assert.equal(adds[0].body.app_id, "claude-code");
    assert.equal(adds[0].body.project_id, "proj");
    assert.deepEqual(adds[0].body.messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
    assert.equal(adds[0].body.messages[0].sender_id, "tester");
    assert.equal(adds[0].body.messages[1].sender_id, "claude-code");
    assert.equal(adds[0].body.messages[1].tool_calls.length, 2);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the same prompt id is never posted twice", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    await runHookScript(SCRIPT, stdin, envFor(server, dir));
    await runHookScript(SCRIPT, stdin, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/add").length, 1);
    assert.equal(isStored(readState(dir, "s1"), "prompt-A"), true);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a failed post is not marked stored, so the next Stop retries it", async () => {
  const server = await startFakeEveros({ addStatus: 500 });
  const dir = tmp();
  try {
    const { code } = await runHookScript(SCRIPT, stdin, envFor(server, dir));
    assert.equal(code, 0);
    assert.equal(isStored(readState(dir, "s1"), "prompt-A"), false);
    server.setAddStatus(200);
    await runHookScript(SCRIPT, stdin, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/add").length, 2);
    assert.equal(isStored(readState(dir, "s1"), "prompt-A"), true);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a batch that fails after an earlier one succeeded is not re-sent whole", async () => {
  // Batches share one deadline. If batch 1 committed and batch 2 did not, a
  // retry would re-post batch 1 - and EverOS assigns message ids server-side,
  // so it cannot dedupe them. A truncated tail beats 500 duplicated messages.
  const server = await startFakeEveros();
  const dir = tmp();
  const big = path.join(dir, "big.jsonl");
  const lines = [JSON.stringify({ type: "user", isSidechain: false, promptId: "p", promptSource: "typed", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "start" } })];
  for (let i = 0; i < 700; i += 1) {
    lines.push(JSON.stringify({ type: "assistant", isSidechain: false, requestId: `r${i}`, timestamp: `2026-09-10T10:00:${String(i % 60).padStart(2, "0")}.000Z`, message: { role: "assistant", content: [{ type: "text", text: `line ${i}` }] } }));
  }
  fs.writeFileSync(big, lines.join("\n"));
  try {
    let calls = 0;
    server.setAddHandler(() => { calls += 1; return calls === 1 ? "ok" : "fail"; });
    const { json } = await runHookScript(SCRIPT, { session_id: "s1", prompt_id: "p", transcript_path: big, cwd: "/w" },
      envFor(server, dir, { EVEROS_CC_VERBOSE: "1" }));
    assert.equal(server.only("/api/v2/memory/add").length, 2, "both batches attempted");
    assert.equal(isStored(readState(dir, "s1"), "p"), true, "must not offer the committed batch for a retry");
    // What the user is told must be what actually landed. Reporting the total
    // after a truncated tail is the one lie a memory tool cannot afford.
    const sent = server.only("/api/v2/memory/add")[0].body.messages.length;
    assert.equal(json.systemMessage, `💾 EverOS: saved ${sent} messages`);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown prompt id posts nothing", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    await runHookScript(SCRIPT, { ...stdin, prompt_id: "no-such" }, envFor(server, dir));
    assert.equal(server.only("/api/v2/memory/add").length, 0);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a Stop without a prompt id falls back to the last turn in the transcript", async () => {
  // Claude Code documents prompt_id as optional. Without a fallback, capture
  // would be a total no-op with nothing to show for it.
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code } = await runHookScript(SCRIPT, { session_id: "s1", transcript_path: FIXTURE, cwd: "/w", hook_event_name: "Stop" }, envFor(server, dir));
    assert.equal(code, 0);
    const adds = server.only("/api/v2/memory/add");
    assert.equal(adds.length, 1);
    assert.deepEqual(adds[0].body.messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an unreachable EverOS exits 0 silently and stores nothing", async () => {
  const dir = tmp();
  try {
    const { code, stdout } = await runHookScript(SCRIPT, stdin, {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(isStored(readState(dir, "s1"), "prompt-A"), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("more than 500 messages are split into sequential batches", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  const big = path.join(dir, "big.jsonl");
  const lines = [JSON.stringify({ type: "user", isSidechain: false, promptId: "p", promptSource: "typed", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: "start" } })];
  for (let i = 0; i < 700; i += 1) {
    lines.push(JSON.stringify({ type: "assistant", isSidechain: false, requestId: `r${i}`, timestamp: `2026-09-10T10:00:${String(i % 60).padStart(2, "0")}.000Z`, message: { role: "assistant", content: [{ type: "text", text: `line ${i}` }] } }));
  }
  fs.writeFileSync(big, lines.join("\n"));
  try {
    await runHookScript(SCRIPT, { session_id: "s1", prompt_id: "p", transcript_path: big, cwd: "/w" }, envFor(server, dir));
    const adds = server.only("/api/v2/memory/add");
    assert.equal(adds.length, 2);
    assert.equal(adds[0].body.messages.length, 500);
    assert.equal(adds[1].body.messages.length, 201);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

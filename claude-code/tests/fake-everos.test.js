import test from "node:test";
import assert from "node:assert/strict";
import { startFakeEveros } from "./helpers/fake-everos.js";

test("fake EverOS records requests and answers the four routes", async () => {
  const server = await startFakeEveros();
  try {
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const search = await fetch(`${server.baseUrl}/api/v2/memory/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "me", query: "hi" }),
    });
    assert.deepEqual((await search.json()).data.episodes, []);

    assert.equal(server.only("/api/v2/memory/search").length, 1);
    assert.equal(server.only("/api/v2/memory/search")[0].body.user_id, "me");
  } finally {
    await server.close();
  }
});

test("fake EverOS 404s an unknown path with the real error envelope", async () => {
  const server = await startFakeEveros();
  try {
    const res = await fetch(`${server.baseUrl}/api/v2/memory/nope`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  } finally {
    await server.close();
  }
});

// The double validates like EverOS does, so these cases prove the validator
// itself rather than the plugin: a check nobody has seen fail is not a check.
const VALID_MESSAGE = { sender_id: "u", role: "user", timestamp: 1789050000000, content: "hi" };

async function post(server, path, body) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("the double accepts exactly the payloads the plugin really sends", async () => {
  const server = await startFakeEveros();
  try {
    assert.equal((await post(server, "/api/v2/memory/add", {
      session_id: "s", app_id: "claude-code", project_id: "github.com_a_b",
      messages: [
        VALID_MESSAGE,
        { sender_id: "claude-code", role: "assistant", timestamp: 1789050001000, content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "Read", arguments: "{}" } }] },
        { sender_id: "claude-code", role: "tool", timestamp: 1789050002000, content: "r", tool_call_id: "t1" },
      ],
    })).status, 200);
    assert.equal((await post(server, "/api/v2/memory/search", { user_id: "u", app_id: "claude-code", project_id: "p", query: "q", include_profile: true })).status, 200);
    assert.equal((await post(server, "/api/v2/memory/flush", { session_id: "s", app_id: "claude-code", project_id: "p" })).status, 200);
  } finally { await server.close(); }
});

test("the double rejects every shape EverOS rejects", async () => {
  const server = await startFakeEveros();
  const cases = [
    ["role outside the literal", "/api/v2/memory/add", { session_id: "s", messages: [{ ...VALID_MESSAGE, role: "system" }] }],
    ["timestamp in seconds, not ms", "/api/v2/memory/add", { session_id: "s", messages: [{ ...VALID_MESSAGE, timestamp: 1789050000.5 }] }],
    ["project_id is a traversal token", "/api/v2/memory/add", { session_id: "s", project_id: "..", messages: [VALID_MESSAGE] }],
    ["project_id outside the charset", "/api/v2/memory/add", { session_id: "s", project_id: "a/b", messages: [VALID_MESSAGE] }],
    ["empty messages", "/api/v2/memory/add", { session_id: "s", messages: [] }],
    ["more than 500 messages", "/api/v2/memory/add", { session_id: "s", messages: Array.from({ length: 501 }, () => VALID_MESSAGE) }],
    ["tool row with no tool_call_id", "/api/v2/memory/add", { session_id: "s", messages: [{ ...VALID_MESSAGE, role: "tool" }] }],
    ["tool_calls arguments not a JSON string", "/api/v2/memory/add", { session_id: "s", messages: [{ ...VALID_MESSAGE, role: "assistant", tool_calls: [{ id: "t", type: "function", function: { name: "R", arguments: {} } }] }] }],
    ["neither user_id nor agent_id", "/api/v2/memory/search", { app_id: "claude-code", query: "q" }],
    ["both user_id and agent_id", "/api/v2/memory/search", { user_id: "u", agent_id: "a", query: "q" }],
    ["an unknown search field (extra=forbid)", "/api/v2/memory/search", { user_id: "u", query: "q", limit: 5 }],
    ["top_k out of range", "/api/v2/memory/search", { user_id: "u", query: "q", top_k: 500 }],
    ["flush without a session_id", "/api/v2/memory/flush", { app_id: "claude-code" }],
  ];
  try {
    for (const [name, path, body] of cases) {
      const { status, body: payload } = await post(server, path, body);
      assert.equal(status, 422, `${name}: expected 422, got ${status}`);
      assert.match(payload.error.message, /^contract: /, name);
    }
  } finally { await server.close(); }
});

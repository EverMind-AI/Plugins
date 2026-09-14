import test from "node:test";
import assert from "node:assert/strict";
import { createClient, EverosError, deadline } from "../hooks/scripts/lib/everos.js";
import { startFakeEveros } from "./helpers/fake-everos.js";

test("health returns the parsed body", async () => {
  const server = await startFakeEveros();
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    const body = await client.health(deadline(1000));
    assert.equal(body.status, "ok");
    assert.equal(body.capabilities.llm, true);
  } finally { await server.close(); }
});

test("search unwraps data and posts the body verbatim", async () => {
  const server = await startFakeEveros({
    searchFn: () => ({ episodes: [{ id: "e1", summary: "s" }], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [] }),
  });
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    const data = await client.search({ user_id: "me", app_id: "claude-code", project_id: "p", query: "q" }, deadline(1000));
    assert.equal(data.episodes[0].id, "e1");
    const sent = server.only("/api/v2/memory/search")[0].body;
    assert.deepEqual(sent, { user_id: "me", app_id: "claude-code", project_id: "p", query: "q" });
    assert.ok(!("top_k" in sent), "top_k must never be sent - EverOS defaults own it");
  } finally { await server.close(); }
});

test("an error envelope becomes an EverosError carrying code and status", async () => {
  const server = await startFakeEveros({ addStatus: 500 });
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    await assert.rejects(
      () => client.add({ session_id: "s", messages: [] }, deadline(1000)),
      (err) => {
        assert.ok(err instanceof EverosError);
        assert.equal(err.status, 500);
        assert.equal(err.code, "INTERNAL_ERROR");
        return true;
      },
    );
  } finally { await server.close(); }
});

test("a stalled server aborts at the deadline rather than hanging", async () => {
  const server = await startFakeEveros({ stall: true });
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    const started = Date.now();
    await assert.rejects(
      () => client.search({ user_id: "me", query: "q" }, deadline(300)),
      // TIMEOUT, not NETWORK_ERROR: the socket was open, so the server has the
      // request even though we gave up on the answer. flush.js turns on this.
      (err) => err instanceof EverosError && err.code === "TIMEOUT",
    );
    assert.ok(Date.now() - started < 2000, "must abort near the deadline");
  } finally { await server.close(); }
});

test("a closed port is NETWORK_ERROR while a slow server is TIMEOUT", async () => {
  const closed = createClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(() => closed.flush({}, deadline(500)), (e) => e.code === "NETWORK_ERROR");
  const stalled = await startFakeEveros({ stall: true });
  try {
    const client = createClient({ baseUrl: stalled.baseUrl });
    await assert.rejects(() => client.flush({}, deadline(200)), (e) => e.code === "TIMEOUT");
  } finally { await stalled.close(); }
});

test("a closed port is a NETWORK_ERROR, not a crash", async () => {
  const client = createClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () => client.health(deadline(500)),
    (err) => err instanceof EverosError && err.status === 0,
  );
});

test("one signal can carry two parallel searches on a shared deadline", async () => {
  const server = await startFakeEveros();
  try {
    const client = createClient({ baseUrl: server.baseUrl });
    const signal = deadline(1000);
    const [a, b] = await Promise.all([
      client.search({ user_id: "me", query: "q" }, signal),
      client.search({ agent_id: "claude-code", query: "q" }, signal),
    ]);
    assert.deepEqual(a.episodes, []);
    assert.deepEqual(b.agent_cases, []);
    assert.equal(server.only("/api/v2/memory/search").length, 2);
  } finally { await server.close(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { portFromUrl, probeHealth, ensureEveros } from "../hooks/scripts/lib/provision.js";
import { startFakeEveros } from "./helpers/fake-everos.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-prov-")); }

/** Reserve a port by binding and releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A stand-in for `everos server start`: listens on EVEROS_API__PORT after a delay, then self-terminates. */
function writeFakeEveros(dir) {
  const file = path.join(dir, "fake-everos.mjs");
  fs.writeFileSync(file, `
import { createServer } from "node:http";
const delay = Number(process.env.FAKE_DELAY_MS ?? "0");
if (process.env.EVEROS_MEMORIZE__MODE !== "agent") { process.exit(3); }
setTimeout(() => {
  createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "fake", capabilities: { llm: true }, disabled_features: [] }));
  }).listen(Number(process.env.EVEROS_API__PORT), "127.0.0.1");
}, delay);
// Hard lifetime cap so a failed test can never leave this running.
setTimeout(() => process.exit(0), 8000);
`);
  return file;
}

test("portFromUrl reads the port, defaulting by scheme", () => {
  assert.equal(portFromUrl("http://127.0.0.1:8000"), "8000");
  assert.equal(portFromUrl("http://127.0.0.1"), "80");
  assert.equal(portFromUrl("https://host"), "443");
  assert.equal(portFromUrl("not a url"), "8000");
});

test("probeHealth returns the body when up and null when down", async () => {
  const server = await startFakeEveros();
  try {
    assert.equal((await probeHealth(server.baseUrl)).status, "ok");
  } finally { await server.close(); }
  assert.equal(await probeHealth("http://127.0.0.1:1"), null);
});

test("a healthy server is used as-is and nothing is spawned", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  let spawned = 0;
  try {
    const outcome = await ensureEveros(
      { baseUrl: server.baseUrl, startCmd: ["never"], everosDir: null, dataDir: dir },
      { spawn: () => { spawned += 1; throw new Error("must not spawn"); } },
    );
    assert.equal(outcome.status, "healthy");
    assert.equal(spawned, 0);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a non-loopback base URL is never started", async () => {
  const dir = tmp();
  try {
    const outcome = await ensureEveros(
      { baseUrl: "http://10.255.255.1:8000", startCmd: ["everos"], everosDir: null, dataDir: dir },
      { spawn: () => { throw new Error("must not spawn"); }, healthTimeoutMs: 200 },
    );
    assert.equal(outcome.status, "remote");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an empty start command reports no-start-cmd", async () => {
  const dir = tmp();
  try {
    const outcome = await ensureEveros({ baseUrl: "http://127.0.0.1:1", startCmd: [], everosDir: null, dataDir: dir }, { healthTimeoutMs: 200 });
    assert.equal(outcome.status, "no-start-cmd");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a down server is started and reported once it answers", async () => {
  const dir = tmp();
  const port = await freePort();
  const fake = writeFakeEveros(dir);
  let outcome;
  try {
    outcome = await ensureEveros(
      { baseUrl: `http://127.0.0.1:${port}`, startCmd: [process.execPath, fake], everosDir: null, dataDir: dir },
      { healthTimeoutMs: 300, startWaitMs: 6000, startPollMs: 200 },
    );
    assert.equal(outcome.status, "started");
    assert.equal(outcome.health.version, "fake");
    assert.ok(Number.isInteger(outcome.pid));
    assert.ok(fs.existsSync(path.join(dir, "everos-server.log")));
  } finally {
    if (outcome?.pid) { try { process.kill(outcome.pid, "SIGKILL"); } catch { /* already gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent mode is forced on the spawned process", async () => {
  // The fake exits 3 unless EVEROS_MEMORIZE__MODE=agent, so a wrong env yields
  // "starting" (never healthy) rather than "started".
  const dir = tmp();
  const port = await freePort();
  const fake = writeFakeEveros(dir);
  let outcome;
  try {
    outcome = await ensureEveros(
      { baseUrl: `http://127.0.0.1:${port}`, startCmd: [process.execPath, fake], everosDir: null, dataDir: dir },
      { healthTimeoutMs: 300, startWaitMs: 4000, startPollMs: 200 },
    );
    assert.equal(outcome.status, "started", "fake exits 3 when EVEROS_MEMORIZE__MODE is not agent");
  } finally {
    if (outcome?.pid) { try { process.kill(outcome.pid, "SIGKILL"); } catch { /* already gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that is slower than the wait window reports starting, not failure", async () => {
  const dir = tmp();
  const port = await freePort();
  const fake = writeFakeEveros(dir);
  let outcome;
  try {
    outcome = await ensureEveros(
      { baseUrl: `http://127.0.0.1:${port}`, startCmd: [process.execPath, fake], everosDir: null, dataDir: dir },
      { healthTimeoutMs: 200, startWaitMs: 700, startPollMs: 200, spawnEnv: { FAKE_DELAY_MS: "4000" } },
    );
    assert.equal(outcome.status, "starting");
  } finally {
    if (outcome?.pid) { try { process.kill(outcome.pid, "SIGKILL"); } catch { /* already gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a nonexistent start command reports spawn-failed instead of crashing", async () => {
  const dir = tmp();
  try {
    const outcome = await ensureEveros(
      { baseUrl: "http://127.0.0.1:1", startCmd: ["definitely-not-a-real-binary-xyz"], everosDir: null, dataDir: dir },
      { healthTimeoutMs: 200, startWaitMs: 600, startPollMs: 200 },
    );
    assert.equal(outcome.status, "spawn-failed", "a binary that does not exist must not be reported as starting");
    assert.match(outcome.detail, /ENOENT|spawn/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

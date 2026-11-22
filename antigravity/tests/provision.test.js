import test from "node:test";
import assert from "node:assert/strict";
import { ensureServerRunning, resetSpawnThrottle } from "../hooks/scripts/lib/provision.js";

test.beforeEach(() => {
  resetSpawnThrottle();
});

test("provision: returns ok: true, spawned: false when already healthy", async () => {
  let healthCalls = 0;
  const fakeClient = {
    async health() {
      healthCalls++;
      return { status: "ok" };
    },
  };

  let spawnCalls = 0;
  const fakeSpawn = () => {
    spawnCalls++;
    return { unref() {} };
  };

  const res = await ensureServerRunning(
    { baseUrl: "http://127.0.0.1:8000", startCmd: ["echo", "start"] },
    { client: fakeClient, spawnImpl: fakeSpawn }
  );

  assert.equal(res.ok, true);
  assert.equal(res.spawned, false);
  assert.equal(healthCalls, 1);
  assert.equal(spawnCalls, 0);
});

test("provision: does not spawn on non-loopback host", async () => {
  const fakeClient = {
    async health() {
      throw new Error("network error");
    },
  };

  let spawnCalls = 0;
  const fakeSpawn = () => {
    spawnCalls++;
    return { unref() {} };
  };

  const res = await ensureServerRunning(
    { baseUrl: "https://remote.everos.internal:8000", startCmd: ["echo", "start"] },
    { client: fakeClient, spawnImpl: fakeSpawn }
  );

  assert.equal(res.ok, false);
  assert.equal(res.spawned, false);
  assert.equal(res.reason, "server_offline");
  assert.equal(spawnCalls, 0);
});

test("provision: spawns and succeeds after polling", async () => {
  let healthCount = 0;
  const fakeClient = {
    async health() {
      healthCount++;
      if (healthCount === 1) {
        throw new Error("offline");
      }
      return { status: "ok" };
    },
  };

  let spawnedWith = null;
  const fakeSpawn = (cmd, args, opts) => {
    spawnedWith = { cmd, args, opts };
    return { unref() {} };
  };

  const res = await ensureServerRunning(
    {
      baseUrl: "http://127.0.0.1:8000",
      startCmd: ["everos", "server", "start"],
      everosDir: "f:/EverOS",
    },
    {
      client: fakeClient,
      spawnImpl: fakeSpawn,
      retries: 2,
      retryDelayMs: 10,
    }
  );

  assert.equal(res.ok, true);
  assert.equal(res.spawned, true);
  assert.equal(spawnedWith.cmd, "everos");
  assert.deepEqual(spawnedWith.args, ["server", "start"]);
  assert.equal(spawnedWith.opts.detached, true);
});

test("provision: fails open with timeout if server does not come up", async () => {
  const fakeClient = {
    async health() {
      throw new Error("connection refused");
    },
  };

  let spawnCount = 0;
  const fakeSpawn = () => {
    spawnCount++;
    return { unref() {} };
  };

  const res = await ensureServerRunning(
    { baseUrl: "http://127.0.0.1:8000", startCmd: ["everos", "start"] },
    {
      client: fakeClient,
      spawnImpl: fakeSpawn,
      retries: 2,
      retryDelayMs: 10,
    }
  );

  assert.equal(res.ok, false);
  assert.equal(res.spawned, true);
  assert.equal(res.error, "timeout");
  assert.equal(spawnCount, 1);
});

test("provision: throttles repeated spawn attempts", async () => {
  const fakeClient = {
    async health() {
      throw new Error("offline");
    },
  };

  let spawnCount = 0;
  const fakeSpawn = () => {
    spawnCount++;
    return { unref() {} };
  };

  const config = { baseUrl: "http://127.0.0.1:8000", startCmd: ["echo", "start"] };
  const opts = {
    client: fakeClient,
    spawnImpl: fakeSpawn,
    retries: 1,
    retryDelayMs: 5,
    throttleMs: 5000,
  };

  // First call spawns
  const res1 = await ensureServerRunning(config, opts);
  assert.equal(res1.spawned, true);
  assert.equal(spawnCount, 1);

  // Second immediate call is throttled
  const res2 = await ensureServerRunning(config, opts);
  assert.equal(res2.ok, false);
  assert.equal(res2.spawned, false);
  assert.equal(res2.reason, "throttled");
  assert.equal(spawnCount, 1);
});

test("provision: returns ok: false, reason: 'unhealthy' and does not spawn when /health 200 has healthy: false (D3-03)", async () => {
  let healthCalls = 0;
  const fakeClient = {
    async health() {
      healthCalls++;
      return { status: "ok", healthy: false, cascade: { healthy: false } };
    },
  };

  let spawnCalls = 0;
  const fakeSpawn = () => {
    spawnCalls++;
    return { unref() {} };
  };

  const res = await ensureServerRunning(
    { baseUrl: "http://127.0.0.1:8000", startCmd: ["echo", "start"] },
    { client: fakeClient, spawnImpl: fakeSpawn }
  );

  assert.equal(res.ok, false);
  assert.equal(res.spawned, false);
  assert.equal(res.reason, "unhealthy");
  assert.equal(healthCalls, 1);
  assert.equal(spawnCalls, 0); // Must NOT spawn when process is running but unhealthy
});

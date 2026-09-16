import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeEveros } from "./helpers/fake-everos.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "everos-cc-scripts-")); }

function run(relative, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, relative), ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("status reports health, ids and config sources", async () => {
  const server = await startFakeEveros();
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(code, 0);
    assert.match(stdout, /reachable/i);
    assert.match(stdout, /app_id\s+claude-code/);
    assert.match(stdout, /project_id\s+proj/);
    assert.match(stdout, /user_id\s+tester/);
    assert.match(stdout, /agent_id\s+claude-code/);
    assert.match(stdout, /base_url.*\(env\)/);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("status explains what to do when EverOS is down and exits 0", async () => {
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester",
    });
    assert.equal(code, 0);
    assert.match(stdout, /NOT reachable/);
    assert.match(stdout, /everos init|everos server start/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("status surfaces the last debug lines when a debug log exists", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "debug.log"), "2026-09-10T00:00:00.000Z [Stop] add failed: boom\n");
  try {
    const { stdout } = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: "http://127.0.0.1:1", EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester",
    });
    assert.match(stdout, /add failed: boom/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("search renders exactly what the model would be given", async () => {
  const hit = {
    episodes: [{ id: "e1", subject: "Lint choice", summary: "Agreed on ruff", atomic_facts: [{ id: "f", content: "uses ruff, not black" }] }],
    profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [],
  };
  const empty = { episodes: [], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [] };
  const server = await startFakeEveros({ searchFn: (body) => (body.user_id ? hit : empty) });
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/search.js", ["how do we lint"], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir,
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(code, 0);
    assert.match(stdout, /uses ruff, not black/);
    assert.match(stdout, /<everos_memory>/);
    const searches = server.only("/api/v2/memory/search");
    assert.equal(searches.length, 2, "search must use both tracks, like recall does");
    assert.equal(searches.find((r) => r.body.user_id).body.project_id, "proj");
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("search with no query explains itself and exits 0", async () => {
  const dir = tmp();
  try {
    const { code, stdout } = await run("scripts/search.js", [], { EVEROS_CC_DATA_DIR: dir });
    assert.equal(code, 0);
    assert.match(stdout, /usage/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("search reports an empty result instead of printing nothing", async () => {
  const empty = { episodes: [], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [] };
  const server = await startFakeEveros({ searchFn: () => empty });
  const dir = tmp();
  try {
    const { stdout } = await run("scripts/search.js", ["anything at all"], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: dir, EVEROS_CC_USER_ID: "tester",
    });
    assert.match(stdout, /no matching memory/i);
  } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the plugin version and the marketplace entry agree", () => {
  // Two files, one number, nothing keeping them in step: the marketplace serves
  // a version the plugin does not claim and installs go stale without a symptom.
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
  const market = JSON.parse(fs.readFileSync(path.join(root, "../.claude-plugin/marketplace.json"), "utf8"));
  const entry = market.plugins.find((p) => p.source === "./claude-code");
  assert.ok(entry, "no marketplace entry points at ./claude-code");
  assert.equal(entry.version, plugin.version);
});

test("every hook finishes inside the timeout hooks.json gives it", async () => {
  // Raising any one of these constants is a one-word edit that breaks the
  // contract invisibly: the host kills the hook mid-request, and the only
  // symptom is memory that quietly stops working for that event.
  const { RECALL_DEADLINE_MAX_MS, CAPTURE_DEADLINE_MS, HEALTH_TIMEOUT_MS, START_WAIT_MS,
          TRANSCRIPT_READ_ATTEMPTS, TRANSCRIPT_READ_DELAY_MS, FLUSH_DISPATCH_MS } =
    await import("../hooks/scripts/lib/constants.js");
  // The sweep dispatches every abandoned session at once, so it costs one
  // dispatch deadline rather than one per session.
  const sweepCost = FLUSH_DISPATCH_MS;
  const gitProbes = 2 * 1000; // identity.js runs at most two git calls, 1s timeout each
  const worst = {
    // health, then waiting for a server it started, then the sweep
    SessionStart: HEALTH_TIMEOUT_MS + START_WAIT_MS + sweepCost,
    // identity resolves before the recall deadline even starts
    UserPromptSubmit: gitProbes + RECALL_DEADLINE_MAX_MS,
    // the transcript retries run before the add deadline
    Stop: gitProbes + TRANSCRIPT_READ_ATTEMPTS * TRANSCRIPT_READ_DELAY_MS + CAPTURE_DEADLINE_MS,
    SessionEnd: gitProbes + FLUSH_DISPATCH_MS,
    PreCompact: gitProbes + FLUSH_DISPATCH_MS,
  };
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8")).hooks;
  for (const [event, budget] of Object.entries(worst)) {
    const timeout = hooks[event][0].hooks[0].timeout * 1000;
    assert.ok(budget < timeout, `${event}: worst case ${budget}ms does not fit in the ${timeout}ms hooks.json allows`);
  }
  assert.deepEqual(Object.keys(hooks).sort(), Object.keys(worst).sort(), "a hook was added without a budget here");
});

test("status says so when the state directory cannot be written", async () => {
  // The hooks degrade quietly here by design - memory keeps working, dedupe and
  // the sweep do not - so this line is the only place a user finds out.
  const server = await startFakeEveros();
  const blocked = path.join(tmp(), "a-file");
  fs.writeFileSync(blocked, "not a directory");
  try {
    const bad = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: path.join(blocked, "everos"),
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.equal(bad.code, 0, "a broken state directory must not break the status command");
    assert.match(bad.stdout, /not writable/);
    const fine = await run("scripts/status.js", [], {
      EVEROS_CC_BASE_URL: server.baseUrl, EVEROS_CC_DATA_DIR: tmp(),
      EVEROS_CC_USER_ID: "tester", EVEROS_CC_PROJECT_ID: "proj",
    });
    assert.doesNotMatch(fine.stdout, /not writable/, "and must stay quiet when it is fine");
  } finally { await server.close(); fs.rmSync(blocked, { force: true }); }
});

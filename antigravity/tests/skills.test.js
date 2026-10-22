import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startFakeEveros } from "./helpers/fake-everos.js";
import { loadSessionState, saveSessionState } from "../hooks/scripts/lib/state.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-skills-test-"));
}

function runCli(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const cliScript = path.join(root, "skills", "everos", "cli.js");
    const child = spawn(process.execPath, [cliScript, ...args], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.on("error", reject);
  });
}

test("skills: cli status outputs well-formatted diagnostics", async (t) => {
  const fake = await startFakeEveros();
  const testDataDir = makeTempDir();

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  const res = await runCli(["status"], {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_PROJECT_ID: "github.com_skills_status",
    EVEROS_AG_USER_ID: "tester",
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /EverOS Memory Engine for Google Antigravity/);
  assert.match(res.stdout, /🟢 Online \(HTTP 200\)/);
  assert.match(res.stdout, /github\.com_skills_status/);
  assert.match(res.stdout, /App Partition\s+antigravity/);
});

test("skills: cli flush executes 2PC seal and updates session state", async (t) => {
  const fake = await startFakeEveros();
  const testDataDir = makeTempDir();

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  const conversationId = "conv_cli_flush_01";
  const res = await runCli(["flush", conversationId], {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_PROJECT_ID: "github.com_skills_flush",
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /2PC Flush Acknowledged/);

  // Verify fake received /flush with app_id: "antigravity"
  const flushCalls = fake.only("/api/v2/memory/flush");
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0].body.app_id, "antigravity");
  assert.equal(flushCalls[0].body.session_id, conversationId);
  assert.equal(flushCalls[0].body.project_id, "github.com_skills_flush");

  // Verify state marked flushed: true
  const state = loadSessionState(testDataDir, conversationId);
  assert.equal(state.flushed, true);
});

test("skills: cli search supports clean Markdown and --raw JSON modes", async (t) => {
  const mockSearch = () => ({
    episodes: [
      {
        subject: "Search Skill",
        summary: "CLI provides manual exploration",
        atomic_facts: ["Raw flag toggles JSON vs Markdown"],
      },
    ],
    agent_cases: [
      {
        task_intent: "Manual verification",
        key_insight: "Engineers can verify memories directly via CLI",
      },
    ],
    profile: null,
  });

  const fake = await startFakeEveros({ searchFn: mockSearch });
  const testDataDir = makeTempDir();

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  const env = {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_PROJECT_ID: "github.com_skills_search",
  };

  // 1. Markdown mode
  const resMd = await runCli(["search", "verification"], env);
  assert.equal(resMd.status, 0);
  assert.match(resMd.stdout, /<everos_memory>/);
  assert.match(resMd.stdout, /【曾有范例】/);
  assert.match(resMd.stdout, /Engineers can verify memories directly via CLI/);

  // 2. Raw JSON mode
  const resRaw = await runCli(["search", "verification", "--raw"], env);
  assert.equal(resRaw.status, 0);
  const parsed = JSON.parse(resRaw.stdout.trim());
  assert.ok(Array.isArray(parsed.episodes));
  assert.equal(parsed.episodes[0].subject, "Search Skill");
});

test("skills: SKILL.md definitions adhere to schema and referenced cli scripts exist", () => {
  const skillsDir = path.join(root, "skills");

  for (const skillName of ["everos", "everos-flush"]) {
    const skillMdPath = path.join(skillsDir, skillName, "SKILL.md");
    assert.ok(fs.existsSync(skillMdPath), `${skillMdPath} must exist`);

    const content = fs.readFileSync(skillMdPath, "utf8");
    assert.match(content, /^---\r?\n/);

    // Strict frontmatter schema: name must match ^[a-z0-9-]+$ and be identical to folder name
    const nameMatch = content.match(/^name:\s*([a-z0-9-]+)\r?$/m);
    assert.ok(nameMatch, `name must exist and match ^[a-z0-9-]+$ in ${skillName}`);
    assert.equal(nameMatch[1], skillName, `name '${nameMatch[1]}' must match folder name '${skillName}'`);

    const descMatch = content.match(/^description:\s*(.+)\r?$/m);
    assert.ok(descMatch, `description must exist in ${skillName}`);
    assert.ok(descMatch[1].trim().length > 10, `description must be substantive in ${skillName}`);

    // Verify referenced script exists
    const scriptMatch = content.match(/node\s+"([^"]+)"/);
    assert.ok(scriptMatch, `Command syntax found in ${skillName}`);
    const scriptClean = scriptMatch[1].replace(/^\$\{[A-Z_]*PLUGIN_ROOT(?::-[^}]*)?\}\//, "");
    const scriptPath = path.join(root, scriptClean);
    assert.ok(fs.existsSync(scriptPath), `Script target ${scriptMatch[1]} must exist`);
  }
});

test("skills: cli flush auto-discovers most recent unflushed session when no argument provided", async (t) => {
  const fake = await startFakeEveros();
  const testDataDir = makeTempDir();

  t.after(() => {
    fake.close();
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  const now = Date.now();
  const projectId = "github.com_auto_flush";

  // 1. Older session for this project (unflushed)
  const oldState = {
    session_id: "conv_older_01",
    project_id: projectId,
    flushed: false,
    updated_at: now - 30000,
    created_at: now - 35000,
  };
  saveSessionState(testDataDir, oldState);

  // 2. Newer session for this project (unflushed)
  const recentState = {
    session_id: "conv_recent_02",
    project_id: projectId,
    flushed: false,
    updated_at: now - 1000,
    created_at: now - 5000,
  };
  saveSessionState(testDataDir, recentState);

  // 3. Different project session (unflushed)
  const otherProjectState = {
    session_id: "conv_other_03",
    project_id: "other_project",
    flushed: false,
    updated_at: now - 500,
    created_at: now - 1000,
  };
  saveSessionState(testDataDir, otherProjectState);

  // Run cli flush without session_id argument
  const res = await runCli(["flush"], {
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_DATA_DIR: testDataDir,
    EVEROS_AG_PROJECT_ID: projectId,
  });

  assert.equal(res.status, 0);
  assert.match(res.stdout, /2PC Flush Acknowledged/);
  assert.match(res.stdout, /conv_recent_02/);

  // Verify fake received flush precisely for the most recent session of this project
  const flushCalls = fake.only("/api/v2/memory/flush");
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0].body.app_id, "antigravity");
  assert.equal(flushCalls[0].body.session_id, "conv_recent_02");
  assert.equal(flushCalls[0].body.project_id, projectId);

  // Verify recent session is marked flushed, while older remains intact
  const loadedRecent = loadSessionState(testDataDir, "conv_recent_02");
  assert.equal(loadedRecent.flushed, true);

  const loadedOld = loadSessionState(testDataDir, "conv_older_01");
  assert.equal(loadedOld.flushed, false);
});

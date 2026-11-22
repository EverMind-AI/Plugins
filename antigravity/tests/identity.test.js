import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeId,
  sanitizeBranch,
  resolveProjectId,
  resolveBranch,
  resolveIdentity,
} from "../hooks/scripts/lib/identity.js";

const cfg = { projectIdOverride: null, userId: "tester" };

function runnerFor(map) {
  return (args) => map[args.join(" ")] ?? null;
}

test("sanitizeId keeps the path-safe charset and replaces the rest", () => {
  assert.equal(sanitizeId("EverOS", "default"), "EverOS");
  assert.match(sanitizeId("my repo/name", "default"), /^my_repo_name_[0-9a-f]{8}$/);
  assert.equal(sanitizeId("a.b@c+d-e_f", "default"), "a.b@c+d-e_f");
});

test("sanitizeId rejects the directory-traversal names EverOS forbids", () => {
  assert.equal(sanitizeId(".", "default"), "default");
  assert.equal(sanitizeId("..", "default"), "default");
  assert.equal(sanitizeId("", "default"), "default");
  assert.equal(sanitizeId(null, "default"), "default");
});

test("sanitizeId clips to 128 characters", () => {
  assert.equal(sanitizeId("x".repeat(200), "default").length, 128);
});

test("the origin remote wins over the toplevel, so every worktree shares one project", () => {
  const runner = runnerFor({
    "config --get remote.origin.url": "git@github.com:EverMind-AI/Plugins.git",
    "rev-parse --show-toplevel": "/Users/me/Plugins-a",
  });
  assert.equal(resolveProjectId("/Users/me/Plugins-a", cfg, runner), "github.com_EverMind-AI_Plugins");
  assert.equal(resolveProjectId("/Users/me/Plugins", cfg, runner), "github.com_EverMind-AI_Plugins");
});

test("the project id carries host and owner, host is lowercase", () => {
  const mine = resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "https://GitHub.com/acme/api.git" }));
  const theirs = resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "https://evil.example/mallory/api.git" }));
  assert.notEqual(mine, theirs);
  assert.equal(mine, "github.com_acme_api");
  assert.equal(theirs, "evil.example_mallory_api");
});

test("ssh, https and scp-style remotes all resolve to the same id", () => {
  const expected = "github.com_EverMind-AI_EverOS";
  for (const url of [
    "git@github.com:EverMind-AI/EverOS.git",
    "https://github.com/EverMind-AI/EverOS.git",
    "https://github.com/EverMind-AI/EverOS",
    "ssh://git@github.com/EverMind-AI/EverOS.git",
  ]) {
    assert.equal(resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": url })), expected, url);
  }
});

test("remotes with explicit non-standard ports retain host and strip port", () => {
  // SSH URL with explicit port :2222
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "ssh://git@gitlab.corp.com:2222/team/repo.git" })),
    "gitlab.corp.com_team_repo",
  );
  // HTTP URL with port :8080
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "http://host:8080/org/repo.git" })),
    "host_org_repo",
  );
  // SSH URL with port :22
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "ssh://git@github.com:22/org/repo.git" })),
    "github.com_org_repo",
  );
  // SCP-style with port
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "git@gitlab.internal:2222/group/proj.git" })),
    "gitlab.internal_group_proj",
  );
});

test("a remote with no owner segment still yields something usable", () => {
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "/srv/git/bare-repo.git" })),
    "srv_git_bare-repo",
  );
});

test("no remote falls back to toplevel basename (Windows path normalized to lowercase)", () => {
  const runnerPosix = runnerFor({ "rev-parse --show-toplevel": "/Users/me/code/local-only" });
  assert.equal(resolveProjectId("/Users/me/code/local-only/src", cfg, runnerPosix), "local-only");

  const runnerWin = runnerFor({ "rev-parse --show-toplevel": "C:\\Workspace\\MockRepo" });
  assert.equal(resolveProjectId("C:\\Workspace\\MockRepo\\src", cfg, runnerWin), "mockrepo");
});

test("no git at all falls back to cwd basename (Windows path anti-drift to lowercase)", () => {
  assert.equal(resolveProjectId("/Users/me/scratch", cfg, runnerFor({})), "scratch");
  assert.equal(resolveProjectId("D:\\Projects\\SampleApp", cfg, runnerFor({})), "sampleapp");
  assert.equal(resolveProjectId("d:\\projects\\sampleapp", cfg, runnerFor({})), "sampleapp");
});

test("the override beats every derivation", () => {
  const runner = runnerFor({ "config --get remote.origin.url": "git@github.com:x/y.git" });
  assert.equal(resolveProjectId("/w", { ...cfg, projectIdOverride: "forced" }, runner), "forced");
});

test("names that sanitize to the same thing still get their own partition", () => {
  const ids = ["项目", "测试", "笔记"].map((n) => sanitizeId(n, "default"));
  assert.equal(new Set(ids).size, 3, `collided: ${ids.join(" ")}`);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_.@+-]+$/, "still path-safe for EverOS");
  assert.equal(sanitizeId("项目", "default"), sanitizeId("项目", "default"), "and stable across runs");
});

test("resolveBranch resolves active branch, detached HEAD and fallback", () => {
  // branch --show-current takes precedence
  const r1 = runnerFor({ "branch --show-current": "feature/antigravity" });
  assert.equal(resolveBranch("/w", r1), "feature/antigravity");

  // rev-parse fallback
  const r2 = runnerFor({ "rev-parse --abbrev-ref HEAD": "main" });
  assert.equal(resolveBranch("/w", r2), "main");

  // detached HEAD
  const r3 = runnerFor({ "rev-parse --abbrev-ref HEAD": "HEAD" });
  assert.equal(resolveBranch("/w", r3), "detached");

  // unknown when no git
  const r4 = runnerFor({});
  assert.equal(resolveBranch("/w", r4), "unknown");
});

test("sanitizeBranch handles control characters, newlines and xml tags", () => {
  assert.equal(sanitizeBranch("main\n"), "main");
  assert.equal(sanitizeBranch("feature/\tlogin"), "feature/ login");
  assert.equal(sanitizeBranch("fix/<issue-123>"), "fix/issue-123");
  assert.equal(sanitizeBranch("<<danger>>"), "danger");
  assert.equal(sanitizeBranch(""), "unknown");
  assert.equal(sanitizeBranch(null), "unknown");
});

test("resolveIdentity returns the five identity fields", () => {
  const runner = runnerFor({ "branch --show-current": "dev" });
  const id = resolveIdentity("/Users/me/scratch", cfg, runner);
  assert.deepEqual(id, {
    appId: "antigravity",
    projectId: "scratch",
    branch: "dev",
    userId: "tester",
    agentId: "antigravity",
  });
});

test("a missing userId is reported as null so callers can disable user track", () => {
  const id = resolveIdentity("/Users/me/scratch", { ...cfg, userId: null }, runnerFor({}));
  assert.equal(id.userId, null);
});

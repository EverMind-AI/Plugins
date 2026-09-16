import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeId, resolveProjectId, resolveIdentity } from "../hooks/scripts/lib/identity.js";

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
  // Both git commands answer, which is the real worktree situation: the slot
  // directory is Plugins-a but the memory must be the repository's.
  const runner = runnerFor({
    "config --get remote.origin.url": "git@github.com:EverMind-AI/Plugins.git",
    "rev-parse --show-toplevel": "/Users/me/Plugins-a",
  });
  assert.equal(resolveProjectId("/Users/me/Plugins-a", cfg, runner), "github.com_EverMind-AI_Plugins");
  assert.equal(resolveProjectId("/Users/me/Plugins", cfg, runner), "github.com_EverMind-AI_Plugins");
});

test("the project id carries host and owner, so two repos named the same do not collide", () => {
  const mine = resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "https://github.com/acme/api.git" }));
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

test("a remote with no owner segment still yields something usable", () => {
  assert.equal(
    resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": "/srv/git/bare-repo.git" })),
    "srv_git_bare-repo",
  );
});

test("no remote falls back to the toplevel basename", () => {
  const runner = runnerFor({ "rev-parse --show-toplevel": "/Users/me/code/local-only" });
  assert.equal(resolveProjectId("/Users/me/code/local-only/src", cfg, runner), "local-only");
});

test("no git at all falls back to the cwd basename", () => {
  assert.equal(resolveProjectId("/Users/me/scratch", cfg, runnerFor({})), "scratch");
});

test("the override beats every derivation", () => {
  const runner = runnerFor({ "config --get remote.origin.url": "git@github.com:x/y.git" });
  assert.equal(resolveProjectId("/w", { ...cfg, projectIdOverride: "forced" }, runner), "forced");
});

test("resolveIdentity returns the four ids the wire needs", () => {
  const id = resolveIdentity("/Users/me/scratch", cfg, runnerFor({}));
  assert.deepEqual(id, { appId: "claude-code", projectId: "scratch", userId: "tester", agentId: "claude-code" });
});

test("a missing userId is reported as null so the caller can disable the user track", () => {
  const id = resolveIdentity("/Users/me/scratch", { ...cfg, userId: null }, runnerFor({}));
  assert.equal(id.userId, null);
});

test("names that sanitize to the same thing still get their own partition", () => {
  // Every name outside the whitelist collapses to a run of underscores. Three
  // unrelated Chinese-named repositories used to land on "__" together and read
  // each other's memory back into their prompts.
  const ids = ["项目", "测试", "笔记"].map((n) => sanitizeId(n, "default"));
  assert.equal(new Set(ids).size, 3, `collided: ${ids.join(" ")}`);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_.@+-]+$/, "still path-safe for EverOS");
  assert.equal(sanitizeId("项目", "default"), sanitizeId("项目", "default"), "and stable across runs");
});

test("a long name is disambiguated rather than truncated onto its neighbour", () => {
  const prefix = "a".repeat(200);
  assert.notEqual(sanitizeId(`${prefix}-one`, "default"), sanitizeId(`${prefix}-two`, "default"));
});

test("the host is case-folded so one repository is one partition", () => {
  const forUrl = (url) => resolveProjectId("/w", cfg, runnerFor({ "config --get remote.origin.url": url }));
  assert.equal(forUrl("https://GitHub.com/acme/api.git"), "github.com_acme_api");
  assert.equal(forUrl("git@github.com:acme/api.git"), "github.com_acme_api");
});

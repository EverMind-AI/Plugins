import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFileSync,
  getSessionFilePath,
  createDefaultSessionState,
  loadSessionState,
  saveSessionState,
  markObserved,
  markSettled,
  markFlushed,
  markRecalled,
  markProfileInjected,
  listStaleSessions,
  cleanupExpiredSessions,
} from "../hooks/scripts/lib/state.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "everos-state-test-"));
}

test("state: createDefaultSessionState returns well-structured initial state", () => {
  const state = createDefaultSessionState("sess_123", {
    projectId: "proj_abc",
    branch: "main",
    userId: "alice",
  });

  assert.equal(state.session_id, "sess_123");
  assert.equal(state.project_id, "proj_abc");
  assert.equal(state.branch, "main");
  assert.equal(state.user_id, "alice");
  assert.equal(state.agent_id, "antigravity");
  assert.equal(state.has_injected_profile, false);
  assert.deepEqual(state.recalled_turn_ids, []);
  assert.equal(state.observed_turn_index, -1);
  assert.equal(state.settled_turn_index, -1);
  assert.equal(state.flushed, false);
  assert.ok(typeof state.created_at === "number");
  assert.ok(typeof state.updated_at === "number");
});

test("state: atomicWriteFileSync persists content and cleans up tmp files", () => {
  const dir = makeTempDir();
  try {
    const targetFile = path.join(dir, "sub", "target.txt");
    atomicWriteFileSync(targetFile, "hello atomic world");
    assert.equal(fs.readFileSync(targetFile, "utf8"), "hello atomic world");

    // Ensure no orphan .tmp files left in the directory
    const files = fs.readdirSync(path.join(dir, "sub"));
    assert.deepEqual(files, ["target.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: load and save session state round-trip", () => {
  const dir = makeTempDir();
  try {
    const initial = loadSessionState(dir, "sess_alpha", {
      projectId: "proj_1",
      branch: "feat",
    });
    assert.equal(initial.session_id, "sess_alpha");
    assert.equal(initial.project_id, "proj_1");

    markObserved(initial, 3);
    markSettled(initial, 3);
    markRecalled(initial, "turn_0");
    markProfileInjected(initial, true);
    saveSessionState(dir, initial);

    const reloaded = loadSessionState(dir, "sess_alpha");
    assert.equal(reloaded.observed_turn_index, 3);
    assert.equal(reloaded.settled_turn_index, 3);
    assert.deepEqual(reloaded.recalled_turn_ids, ["turn_0"]);
    assert.equal(reloaded.has_injected_profile, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: 2PC observation and settlement index advancement", () => {
  const state = createDefaultSessionState("sess_2pc");
  assert.equal(state.observed_turn_index, -1);
  assert.equal(state.settled_turn_index, -1);

  // Mark observed 5
  markObserved(state, 5);
  assert.equal(state.observed_turn_index, 5);
  assert.equal(state.settled_turn_index, -1); // Unsettled!

  // Smaller index should not regress
  markObserved(state, 3);
  assert.equal(state.observed_turn_index, 5);

  // Settlement only advances on explicit call
  markSettled(state, 5);
  assert.equal(state.settled_turn_index, 5);

  // markFlushed
  assert.equal(state.flushed, false);
  markFlushed(state, true);
  assert.equal(state.flushed, true);
});

test("state: markRecalled deduplicates turn IDs", () => {
  const state = createDefaultSessionState("sess_rec");
  markRecalled(state, "turn_0");
  markRecalled(state, "turn_1");
  markRecalled(state, "turn_0");
  assert.deepEqual(state.recalled_turn_ids, ["turn_0", "turn_1"]);
});

test("state: listStaleSessions correctly filters unflushed and idle sessions", () => {
  const dir = makeTempDir();
  try {
    const now = Date.now();
    const staleThreshold = 1000; // 1 second for test

    // 1. Stale unflushed session
    const staleState = createDefaultSessionState("sess_stale", { projectId: "proj_stale" });
    staleState.updated_at = now - 5000;
    saveSessionState(dir, staleState);
    // Overwrite updated_at because saveSessionState re-stamps it
    staleState.updated_at = now - 5000;
    const staleFile = getSessionFilePath(dir, "sess_stale");
    fs.writeFileSync(staleFile, JSON.stringify(staleState));

    // 2. Active recent unflushed session
    const activeState = createDefaultSessionState("sess_active", { projectId: "proj_active" });
    saveSessionState(dir, activeState);

    // 3. Old but already flushed session
    const flushedState = createDefaultSessionState("sess_flushed", { projectId: "proj_flushed" });
    flushedState.flushed = true;
    flushedState.updated_at = now - 5000;
    const flushedFile = getSessionFilePath(dir, "sess_flushed");
    fs.writeFileSync(flushedFile, JSON.stringify(flushedState));

    const staleList = listStaleSessions(dir, staleThreshold);
    assert.equal(staleList.length, 1);
    assert.equal(staleList[0].session_id, "sess_stale");
    assert.equal(staleList[0].project_id, "proj_stale");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: markRecalled caps at STATE_MAX_PROMPT_IDS with sliding window", () => {
  const state = createDefaultSessionState("sess_overflow");
  for (let i = 0; i < 250; i++) {
    markRecalled(state, `turn_${i}`);
  }
  assert.equal(state.recalled_turn_ids.length, 200);
  assert.equal(state.recalled_turn_ids[0], "turn_50");
  assert.equal(state.recalled_turn_ids[199], "turn_249");
});

test("state: cleanupExpiredSessions removes flushed files older than TTL while preserving unflushed drafts", () => {
  const dir = makeTempDir();
  try {
    const freshFile = path.join(dir, "session_fresh.json");
    const oldFlushedFile = path.join(dir, "session_old_flushed.json");
    const oldUnflushedFile = path.join(dir, "session_old_unflushed.json");

    fs.writeFileSync(freshFile, JSON.stringify({ session_id: "fresh", flushed: true }));
    fs.writeFileSync(oldFlushedFile, JSON.stringify({ session_id: "old_flushed", flushed: true }));
    fs.writeFileSync(oldUnflushedFile, JSON.stringify({ session_id: "old_unflushed", flushed: false }));

    // Manually set mtimes to 35 days ago
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFlushedFile, thirtyFiveDaysAgo, thirtyFiveDaysAgo);
    fs.utimesSync(oldUnflushedFile, thirtyFiveDaysAgo, thirtyFiveDaysAgo);

    const removed = cleanupExpiredSessions(dir, 30);
    assert.equal(removed, 1);
    assert.ok(fs.existsSync(freshFile), "fresh file must exist");
    assert.ok(fs.existsSync(oldUnflushedFile), "unflushed file must be preserved even if older than 30 days");
    assert.equal(fs.existsSync(oldFlushedFile), false, "old flushed file must be cleaned up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: atomicWriteFileSync retries and recovers when encountering transient lock (EBUSY/EACCES)", () => {
  const dir = makeTempDir();
  try {
    const targetFile = path.join(dir, "locked_target.txt");
    const originalRenameSync = fs.renameSync;
    let attempts = 0;

    // Simulate transient lock: first 2 attempts throw EBUSY, 3rd succeeds
    fs.renameSync = (from, to) => {
      attempts++;
      if (attempts <= 2) {
        const err = new Error("Resource temporarily locked by antivirus/indexer");
        err.code = "EBUSY";
        throw err;
      }
      return originalRenameSync(from, to);
    };

    try {
      atomicWriteFileSync(targetFile, "recovered through backoff retry", 3, 5);
      assert.equal(fs.readFileSync(targetFile, "utf8"), "recovered through backoff retry");
      assert.equal(attempts, 3);
    } finally {
      fs.renameSync = originalRenameSync;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: loadSessionState fail-opens gracefully on malformed JSON", () => {
  const dir = makeTempDir();
  try {
    const corruptFile = getSessionFilePath(dir, "sess_corrupt");
    fs.writeFileSync(corruptFile, "{ THIS IS CORRUPTED JSON", "utf8");

    const fallback = loadSessionState(dir, "sess_corrupt", { projectId: "proj_fallback" });
    assert.equal(fallback.session_id, "sess_corrupt");
    assert.equal(fallback.project_id, "proj_fallback");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state: saveSessionState maintains sessions_index.json and prunes on flushed", () => {
  const dir = makeTempDir();
  try {
    const indexPath = path.join(dir, "sessions_index.json");

    // 1. Save an active unflushed session
    const activeState = createDefaultSessionState("sess_active_1", { projectId: "proj_1" });
    saveSessionState(dir, activeState);

    assert.ok(fs.existsSync(indexPath), "sessions_index.json should be created");
    let index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.ok(index.sessions["sess_active_1"], "sess_active_1 should be registered");
    assert.equal(index.sessions["sess_active_1"].flushed, false);

    // 2. Save a second session
    const activeState2 = createDefaultSessionState("sess_active_2", { projectId: "proj_1" });
    saveSessionState(dir, activeState2);

    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.equal(Object.keys(index.sessions).length, 2);

    // 3. Mark the first session as flushed and save: should be pruned from index
    activeState.flushed = true;
    saveSessionState(dir, activeState);

    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.equal(index.sessions["sess_active_1"], undefined, "flushed session must be pruned from index");
    assert.ok(index.sessions["sess_active_2"], "unflushed session remains in index");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

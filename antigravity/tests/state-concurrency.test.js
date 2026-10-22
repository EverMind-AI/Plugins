import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSessionState,
  saveSessionState,
  markRecalled,
  markSettled,
  markObserved,
} from "../hooks/scripts/lib/state.js";

test("state: merge-on-write prevents lost updates during concurrent writes (D3-01)", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "everos-state-concurrency-"));
  const sid = "conv_concurrency_test";

  try {
    // Initial save: turn 1
    const initial = loadSessionState(dataDir, sid);
    markSettled(initial, 1);
    markObserved(initial, 1);
    markRecalled(initial, "turn_1");
    saveSessionState(dataDir, initial);

    // Simulate concurrent reads:
    // Process A (e.g. PreInvocation / recall) reads initial state snapshot
    const snapshotA = loadSessionState(dataDir, sid);

    // Process B (e.g. Stop / capture) reads the same initial state snapshot
    const snapshotB = loadSessionState(dataDir, sid);

    // Process A marks a new recalled turn
    markRecalled(snapshotA, "turn_2");

    // Process B marks turn 2 as observed and settled, with new byte offset
    markObserved(snapshotB, 2);
    markSettled(snapshotB, 2);
    snapshotB.last_read_byte_offset = 1024;

    // Both save to disk (B saves first, then A saves with stale snapshot of turn_index)
    saveSessionState(dataDir, snapshotB);
    saveSessionState(dataDir, snapshotA);

    // Reload from disk: both changes MUST be present!
    const finalState = loadSessionState(dataDir, sid);

    assert.equal(finalState.settled_turn_index, 2, "settled_turn_index from snapshot B must be preserved");
    assert.equal(finalState.observed_turn_index, 2, "observed_turn_index from snapshot B must be preserved");
    assert.equal(finalState.last_read_byte_offset, 1024, "last_read_byte_offset from snapshot B must be preserved");
    assert.ok(finalState.recalled_turn_ids.includes("turn_1"), "turn_1 must be present");
    assert.ok(finalState.recalled_turn_ids.includes("turn_2"), "turn_2 from snapshot A must NOT be overwritten by snapshot B");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

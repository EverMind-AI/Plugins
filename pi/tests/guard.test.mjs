import assert from "node:assert/strict";
import test from "node:test";
import { isMutatingMemoryTool, isPlanModeActive } from "../src/guard.ts";

test("only write memory tools are mutating", () => {
  assert.equal(isMutatingMemoryTool("mcp__everos_pi__add_memory"), true);
  assert.equal(isMutatingMemoryTool("mcp__everos_global__forget_session"), true);
  assert.equal(isMutatingMemoryTool("mcp__everos__record_trajectory"), true);
  assert.equal(isMutatingMemoryTool("mcp__everos_pi__search_memory"), false);
  assert.equal(isMutatingMemoryTool("mcp__everos_pi__get_profile"), false);
  assert.equal(isMutatingMemoryTool("bash"), false);
});

test("isPlanModeActive prefers latest entry over --plan flag", () => {
  assert.equal(isPlanModeActive([], false), false);
  assert.equal(isPlanModeActive([], true), true);
  assert.equal(isPlanModeActive([{ customType: "plan-mode", data: { enabled: true } }], false), true);
  assert.equal(
    isPlanModeActive(
      [
        { customType: "plan-mode", data: { enabled: true } },
        { customType: "plan-mode", data: { enabled: false } },
      ],
      true,
    ),
    false,
  );
});

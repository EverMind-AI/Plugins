import assert from "node:assert/strict";
import test from "node:test";
import { buildEverosSection } from "../src/prompt.ts";

test("auto project id sanitizes cwd basename", async () => {
  const { autoProjectId, isValidScopeId } = await import("../src/scope.ts");
  assert.equal(autoProjectId("D:/MyProjects/pi-everos"), "pi-everos");
  assert.equal(autoProjectId("C:\\\\Work\\\\Foo Bar"), "foo-bar");
  assert.equal(isValidScopeId("global"), true);
  assert.equal(isValidScopeId("bad id"), false);
});

test("prompt distinguishes project and global tools", () => {
  const text = buildEverosSection({
    available: true,
    projectId: "pi-everos",
    globalProjectId: "global",
    projectTools: ["mcp__everos__search_memory", "mcp__everos__add_memory"],
    globalTools: ["mcp__everos_global__search_memory", "mcp__everos_global__add_memory"],
  });
  assert.match(text, /Project pi-everos/);
  assert.match(text, /Global global/);
  assert.match(text, /Search project first, then global/);
});

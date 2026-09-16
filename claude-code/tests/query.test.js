import test from "node:test";
import assert from "node:assert/strict";
import { countTokens, stripNoise, shouldRecall, buildQuery } from "../hooks/scripts/lib/query.js";

test("countTokens counts CJK characters individually and latin words as words", () => {
  assert.equal(countTokens("hello there world"), 3);
  assert.equal(countTokens("你好世界"), 4);
  assert.equal(countTokens("修复 the bug"), 4);
  assert.equal(countTokens("   "), 0);
});

test("stripNoise removes host-injected wrappers", () => {
  const input = "real question\n<system-reminder>ignore me</system-reminder>\n<ide_selection>x = 1</ide_selection>";
  assert.equal(stripNoise(input), "real question");
});

test("stripNoise removes an echoed memory block", () => {
  const input = "<everos_memory>\nold stuff\n</everos_memory>\nwhat did I decide?";
  assert.equal(stripNoise(input), "what did I decide?");
});

test("stripNoise folds fenced code and very long runs", () => {
  assert.equal(stripNoise("look at\n```js\nconst a = 1;\n```\nplease"), "look at\n[code]\nplease");
  assert.equal(stripNoise(`token ${"z".repeat(500)} end`), "token […] end");
});

test("shouldRecall skips slash commands and short acknowledgements", () => {
  assert.equal(shouldRecall("/everos:status"), false);
  // Long enough to clear the token floor, so this case tests the slash rule itself
  // and not the floor. Without it, deleting the slash guard leaves the suite green.
  assert.equal(shouldRecall("/everos:search which linter does this project use"), false);
  assert.equal(shouldRecall("ok"), false);
  assert.equal(shouldRecall("继续"), false);
  assert.equal(shouldRecall("yes please"), false);
  assert.equal(shouldRecall("how should I handle auth here"), true);
  assert.equal(shouldRecall("这个项目用什么格式化工具"), true);
});

test("shouldRecall ignores noise when counting", () => {
  assert.equal(shouldRecall("ok\n<system-reminder>a very long reminder with many words</system-reminder>"), false);
});

test("buildQuery clips from the head and never returns noise", () => {
  const long = "word ".repeat(400);
  const q = buildQuery(long);
  assert.equal(q.length <= 500, true);
  assert.equal(q.startsWith("word word"), true);
  assert.equal(buildQuery("<system-reminder>x</system-reminder>real"), "real");
});

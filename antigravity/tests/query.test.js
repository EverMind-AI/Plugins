import test from "node:test";
import assert from "node:assert/strict";
import {
  stripHostWrappers,
  stripNoise,
  countTokens,
  shouldRecall,
  buildQuery,
} from "../hooks/scripts/lib/query.js";

test("stripHostWrappers removes host metadata and memory wrappers", () => {
  const input = `<USER_REQUEST>\nPlease optimize this function\n</USER_REQUEST><system-reminder>Host reminder</system-reminder><everos_memory>Old memory</everos_memory>`;
  assert.equal(stripHostWrappers(input).trim(), "Please optimize this function");
});

test("stripNoise folds code fences and long runs into placeholders", () => {
  const code = "Check this code:\n```javascript\nconst a = 1;\nconsole.log(a);\n```\nDone.";
  assert.equal(stripNoise(code), "Check this code:\n[code]\nDone.");

  const longRun = "word " + "a".repeat(500) + " end";
  assert.equal(stripNoise(longRun), "word […] end");
});

test("countTokens counts individual CJK glyphs and Latin words accurately", () => {
  assert.equal(countTokens("Hello world"), 2);
  assert.equal(countTokens("你好世界"), 4);
  assert.equal(countTokens("修复 bug 流程"), 5); // 修复流程 (4 CJK) + bug (1 Latin) = 5
  assert.equal(countTokens(""), 0);
  assert.equal(countTokens(null), 0);
});

test("shouldRecall rejects slash commands even when wrapped in host tags", () => {
  assert.equal(shouldRecall("/plan"), false);
  assert.equal(shouldRecall("/everos:status"), false);
  assert.equal(shouldRecall("/compact"), false);
  // Wrapped in host tags as Antigravity actually delivers them:
  assert.equal(shouldRecall("<USER_REQUEST>\n/plan build something new\n</USER_REQUEST>"), false);
  assert.equal(shouldRecall("<USER_REQUEST>/everos:flush</USER_REQUEST>"), false);
});

test("shouldRecall rejects trivial acknowledgements", () => {
  assert.equal(shouldRecall("ok"), false);
  assert.equal(shouldRecall("收到"), false);
  assert.equal(shouldRecall("好的"), false);
  assert.equal(shouldRecall(""), false);
  assert.equal(shouldRecall("   "), false);
});

test("shouldRecall accepts substantive questions and engineering prompts", () => {
  assert.equal(shouldRecall("请帮我实现转录状态机清洗函数"), true);
  assert.equal(shouldRecall("How do we fix the NTFS EBUSY issue?"), true);
  assert.equal(shouldRecall("<USER_REQUEST>\n优化当前阶段的代码结构并跑单元测试\n</USER_REQUEST>"), true);
});

test("buildQuery clips long prompts at the head to preserve core intent", () => {
  const text = "Core intent here. " + "Details details details. ".repeat(50);
  const query = buildQuery(text, 50);
  assert.equal(query.length <= 50, true);
  assert.match(query, /^Core intent here\./);
});

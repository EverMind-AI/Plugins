import assert from "node:assert/strict";
import test from "node:test";
import { planBlockReason, t } from "../src/text.ts";

test("command copy follows PI_LANG", () => {
  const prev = process.env.PI_LANG;
  process.env.PI_LANG = "en";
  assert.match(planBlockReason("mcp__everos__add_memory"), /blocked/);
  assert.match(t("logout"), /was not deleted/);
  assert.match(t("doctorBanner"), /doctor/);
  assert.match(t("agentForget"), /learned skills kept/);
  process.env.PI_LANG = "zh-CN";
  assert.match(planBlockReason("mcp__everos__add_memory"), /拦截/);
  assert.match(t("logout"), /未删除/);
  assert.match(t("doctorBanner"), /诊断/);
  assert.match(t("agentForget"), /保留已学到的 skill/);
  if (prev === undefined) delete process.env.PI_LANG;
  else process.env.PI_LANG = prev;
});

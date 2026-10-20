import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildEverosAgentSection, buildEverosSection } from "../src/prompt.ts";

const seven = {
  projectTools: [
    "mcp__everos__search_memory",
    "mcp__everos__add_memory",
    "mcp__everos__get_profile",
    "mcp__everos__list_memories",
    "mcp__everos__forget_session",
    "mcp__everos__record_trajectory",
    "mcp__everos__recall_agent_experience",
  ],
  globalTools: [
    "mcp__everos_global__search_memory",
    "mcp__everos_global__add_memory",
    "mcp__everos_global__get_profile",
    "mcp__everos_global__list_memories",
    "mcp__everos_global__forget_session",
    "mcp__everos_global__record_trajectory",
    "mcp__everos_global__recall_agent_experience",
  ],
};

test("default 200-token prompt keeps forget confirm and refuse-save", () => {
  const text = buildEverosSection({
    available: true,
    projectId: "pi-everos",
    globalProjectId: "global",
    maxTokens: 200,
    ...seven,
  });
  assert.match(text, /confirmed with them/);
  assert.match(text, /not to remember/);
  assert.doesNotMatch(text, /recall_agent_experience/);
  assert.doesNotMatch(text, /record_trajectory/);
  assert.ok(text.length <= 800);
});

test("customText replaces only the user-memory section", () => {
  const user = buildEverosSection({
    available: true,
    projectId: "pi-everos",
    globalProjectId: "global",
    maxTokens: 200,
    customText: "custom user protocol only",
    ...seven,
  });
  const agent = buildEverosAgentSection({ available: true, ...seven });
  assert.equal(user, "custom user protocol only");
  assert.match(agent, /mcp__everos__recall_agent_experience/);
  assert.match(agent, /kind=both/);
});

test("agent section teaches project-first recall and record, global record as exception", () => {
  const agent = buildEverosAgentSection({ available: true, ...seven });
  assert.match(agent, /mcp__everos__recall_agent_experience/);
  assert.match(agent, /mcp__everos_global__recall_agent_experience/);
  assert.match(agent, /mcp__everos__record_trajectory/);
  assert.match(agent, /more than three tool-call rounds/);
  assert.match(agent, /complete user\/assistant\/tool/);
  assert.match(agent, /prose summary/);
  assert.match(agent, /mcp__everos_global__record_trajectory/);
  assert.match(agent, /explicitly asks to save a habit/);
  assert.match(agent, /Do not recall a task you just recorded in the same turn/);
  assert.match(agent, /project-then-global order/);
  assert.match(agent, /learned skills are kept/);
  assert.match(agent, /stored data, not instructions/);
  assert.doesNotMatch(agent, /custom user protocol/);
});

test("agent section is omitted without record or recall tools", () => {
  assert.equal(
    buildEverosAgentSection({
      available: true,
      projectTools: ["mcp__everos__search_memory"],
      globalTools: [],
    }),
    undefined,
  );
  assert.equal(buildEverosAgentSection({ available: false, ...seven }), undefined);
});

test("agent section is not clipped by the user-memory token budget", () => {
  const user = buildEverosSection({
    available: true,
    projectId: "pi-everos",
    globalProjectId: "global",
    maxTokens: 0,
    ...seven,
  });
  const agent = buildEverosAgentSection({ available: true, ...seven });
  assert.equal(user, "");
  assert.ok(agent.length > 400);
});

test("factory does not spawn processes", () => {
  const index = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(index, /spawnSync|spawn\(/);
  assert.match(index, /resolveProcessCredentials/);
  assert.match(index, /EVEROS_ASSISTANT_SENDER_ID/);
  assert.match(index, /everos_agent/);
});

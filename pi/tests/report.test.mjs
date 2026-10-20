import assert from "node:assert/strict";
import test from "node:test";
import { buildDoctorReport } from "../src/report.ts";

test("doctor report is pasteable and has no secrets", () => {
  const report = buildDoctorReport({
    enabled: true,
    uvx: "C:\\\\uvx.exe",
    uvxOnDisk: true,
    keySource: "process-env",
    fileEveros: "enabled",
    fileCommand: "python.exe",
    override: true,
    userId: "chasen-demo",
    appId: "pi",
    projectId: "pi-everos",
    globalProjectId: "global",
    assistantSenderId: "assistant-chasen-demo",
    owned: ["everos-pi", "everos-global"],
    toolCounts: { "everos-pi": 7, everos: 0, "everos-global": 7 },
    promptEnabled: true,
    projectRecord: true,
    projectRecall: true,
    globalRecord: true,
    globalRecall: false,
    agentGate: "agent.gate=>3 tool-call rounds (shorter trajectories produce no case)",
    agentDistill: "agent.distill=async; cases/skills appear in seconds to minutes",
    agentForget: "agent.forget=session memories and cases deleted; learned skills kept",
    notes: ["doctor: EVEROS_API_KEY=sk-live-abcdefghijk should not leak"],
  });
  assert.match(report, /^----- pi-everos doctor -----$/m);
  assert.match(report, /^----- end -----$/m);
  assert.match(report, /override=mcp.json wins/);
  assert.match(report, /assistantSenderId=assistant-chasen-demo/);
  assert.match(report, /agent.project.record=yes/);
  assert.match(report, /agent.global.recall=no/);
  assert.match(report, /learned skills kept/);
  assert.doesNotMatch(report, /sk-live-abcdefghijk/);
  assert.doesNotMatch(report, /EVEROS_API_KEY=sk/);
});

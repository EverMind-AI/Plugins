import test from "node:test";
import assert from "node:assert/strict";
import { interleave, dualTrackSearch } from "../hooks/scripts/lib/search-tracks.js";
import { renderMemoryBlock } from "../hooks/scripts/lib/render.js";

test("interleave: combines two arrays alternatingly without starving either (D2-04)", () => {
  const user = ["u1", "u2", "u3", "u4", "u5"];
  const agent = ["a1", "a2"];
  const merged = interleave(user, agent);
  assert.deepEqual(merged, ["u1", "a1", "u2", "a2", "u3", "u4", "u5"]);
});

test("dualTrackSearch: user track with 5 items does not starve agent cases in renderMemoryBlock (D2-04)", async () => {
  const fakeClient = {
    async search(body) {
      if (body.user_id) {
        return {
          episodes: [
            { subject: "User Ep 1", summary: "E1", atomic_facts: ["f1"] },
            { subject: "User Ep 2", summary: "E2", atomic_facts: ["f2"] },
            { subject: "User Ep 3", summary: "E3", atomic_facts: ["f3"] },
            { subject: "User Ep 4", summary: "E4", atomic_facts: ["f4"] },
            { subject: "User Ep 5", summary: "E5", atomic_facts: ["f5"] },
          ],
          agent_cases: [],
          profiles: [],
        };
      }
      return {
        episodes: [],
        agent_cases: [
          { task_intent: "Agent Case 1", key_insight: "Insight 1" },
          { task_intent: "Agent Case 2", key_insight: "Insight 2" },
        ],
        profiles: [],
      };
    },
  };

  const res = await dualTrackSearch(fakeClient, {
    identity: {
      appId: "antigravity",
      projectId: "proj_dual_track",
      userId: "user_alice",
      agentId: "antigravity",
    },
    query: "event bus",
  });

  assert.equal(res.episodes.length, 5);
  assert.equal(res.agent_cases.length, 2);

  // When rendering with SECTION_MAX_ITEMS=3, agent cases section must still exist and be visible!
  const rendered = renderMemoryBlock(res, {
    projectId: "proj_dual_track",
    branch: "main",
    locale: "zh",
  });

  assert.ok(rendered);
  assert.match(rendered, /【曾有范例】/);
  assert.match(rendered, /Agent Case 1/);
  assert.match(rendered, /【交互脉络】/);
  assert.match(rendered, /User Ep 1/);
});

#!/usr/bin/env node
import { loadConfig } from "../hooks/scripts/lib/config.js";
import { resolveIdentity } from "../hooks/scripts/lib/identity.js";
import { createClient, deadline } from "../hooks/scripts/lib/everos.js";
import { buildQuery } from "../hooks/scripts/lib/query.js";
import { render, summaryLine } from "../hooks/scripts/lib/render.js";

const MANUAL_DEADLINE_MS = 15000; // a human is waiting, not a prompt

const query = buildQuery(process.argv.slice(2).join(" "));
if (!query) {
  process.stdout.write("Usage: /everos:search <query>\nSearches the memory for this project with the same ids the hooks use.\n");
  process.exit(0);
}

const config = loadConfig();
const identity = resolveIdentity(process.cwd(), config);
const client = createClient({ baseUrl: config.baseUrl });
const signal = deadline(MANUAL_DEADLINE_MS);
const common = { app_id: identity.appId, project_id: identity.projectId, query };

const [userData, agentData] = await Promise.all([
  identity.userId
    ? client.search({ ...common, user_id: identity.userId, include_profile: true }, signal).catch((error) => ({ __error: error.message }))
    : Promise.resolve({ __error: "no user id; set EVEROS_CC_USER_ID" }),
  client.search({ ...common, agent_id: identity.agentId }, signal).catch((error) => ({ __error: error.message })),
]);

const lines = [
  `Query: ${query}`,
  `Scope: ${identity.appId}/${identity.projectId} (user ${identity.userId ?? "none"}, agent ${identity.agentId})`,
  "",
];
for (const [label, data] of [["user track", userData], ["agent track", agentData]]) {
  if (data?.__error) lines.push(`${label} failed: ${data.__error}`);
}

const rendered = render(userData?.__error ? null : userData, agentData?.__error ? null : agentData);
if (rendered) {
  lines.push(summaryLine(rendered.counts) ?? "");
  lines.push("");
  lines.push("This is verbatim what a prompt would receive:");
  lines.push(rendered.block);
} else {
  lines.push("No matching memory for this project.");
}

process.stdout.write(`${lines.join("\n")}\n`);

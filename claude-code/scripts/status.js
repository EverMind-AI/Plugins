#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../hooks/scripts/lib/config.js";
import { resolveIdentity } from "../hooks/scripts/lib/identity.js";
import { probeHealth } from "../hooks/scripts/lib/provision.js";

const DEBUG_TAIL_LINES = 5;

function pad(label) {
  return label.padEnd(14, " ");
}

/**
 * The hooks degrade quietly when this directory cannot be written: dedupe and
 * the abandoned-session sweep stop working while memory itself keeps going, so
 * nothing else would ever tell you. Probe with a dot-prefixed name - the sweep
 * reads `*.json` only, so a probe left behind by a crash is never mistaken for
 * a session.
 */
function stateWritable(dataDir) {
  const probe = path.join(dataDir, "state", `.status-probe-${process.pid}`);
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function readDebugTail(dataDir) {
  try {
    const lines = fs.readFileSync(path.join(dataDir, "debug.log"), "utf8").trim().split("\n");
    return lines.slice(-DEBUG_TAIL_LINES);
  } catch {
    return [];
  }
}

const config = loadConfig();
const identity = resolveIdentity(process.cwd(), config);
const health = await probeHealth(config.baseUrl);
const out = [];

out.push("EverOS plugin for Claude Code - status");
out.push("");

if (health) {
  out.push(`Server         reachable at ${config.baseUrl} (EverOS ${health.version ?? "unknown"})`);
  const capabilities = health.capabilities ?? {};
  const enabled = Object.entries(capabilities).filter(([, v]) => v).map(([k]) => k);
  out.push(`${pad("Capabilities")} ${enabled.length ? enabled.join(", ") : "none reported"}`);
  if (Array.isArray(health.disabled_features) && health.disabled_features.length) {
    out.push(`${pad("Disabled")} ${health.disabled_features.join(", ")}`);
  }
  if (health.cascade) {
    out.push(`${pad("Index queue")} pending ${health.cascade.pending ?? 0}, healthy ${health.cascade.healthy !== false}`);
  }
} else {
  out.push(`Server         NOT reachable at ${config.baseUrl}`);
  out.push("");
  out.push("Memory is off until this is fixed. Claude Code keeps working normally.");
  out.push("Checklist:");
  out.push("  1. Is EverOS installed?           command -v everos");
  out.push("  2. Has it been initialised?       everos init      (writes ~/.everos/everos.toml)");
  out.push("  3. Are the api_key fields filled in ~/.everos/everos.toml?");
  out.push("  4. Start it:                      everos server start");
  out.push("  5. From a checkout instead?       set EVEROS_CC_EVEROS_DIR and");
  out.push("                                    EVEROS_CC_START_CMD='uv run everos server start'");
  out.push(`  6. Startup log:                   ${path.join(config.dataDir, "everos-server.log")}`);
}

out.push("");
out.push("Identity used for both capture and recall");
out.push(`  ${pad("app_id")} ${identity.appId}`);
out.push(`  ${pad("project_id")} ${identity.projectId}`);
out.push(`  ${pad("user_id")} ${identity.userId ?? "MISSING - set EVEROS_CC_USER_ID; personal memory is off"}`);
out.push(`  ${pad("agent_id")} ${identity.agentId}`);
out.push(`  ${pad("memory path")} <everos root>/${identity.appId}/${identity.projectId}/users/${identity.userId ?? "?"}/`);

out.push("");
out.push("Configuration (value, and which layer set it)");
out.push(`  ${pad("base_url")} ${config.baseUrl} (${config.sources.baseUrl})`);
out.push(`  ${pad("everos_dir")} ${config.everosDir ?? "unset"} (${config.sources.everosDir})`);
out.push(`  ${pad("start_cmd")} ${config.startCmd.join(" ") || "unset"} (${config.sources.startCmd})`);
out.push(
  `  ${pad("data_dir")} ${config.dataDir} (${config.sources.dataDir})` +
    (stateWritable(config.dataDir) ? "" : "\n                 ⚠️  not writable — turns may be stored twice and abandoned sessions never sealed"),
);
// The troubleshooting entry in the README tells people to raise this; without
// it printed here they cannot confirm the change took.
out.push(`  ${pad("recall_ms")} ${config.recallTimeoutMs}`);
out.push(`  ${pad("verbose")} ${config.verbose}`);
out.push(`  ${pad("debug")} ${config.debug}`);

const tail = readDebugTail(config.dataDir);
if (tail.length) {
  out.push("");
  out.push(`Last ${tail.length} debug lines`);
  for (const line of tail) out.push(`  ${line}`);
} else if (!config.debug) {
  out.push("");
  out.push("No debug log. Set EVEROS_CC_DEBUG=1 to record hook diagnostics.");
}

process.stdout.write(`${out.join("\n")}\n`);

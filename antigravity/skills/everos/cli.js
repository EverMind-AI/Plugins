#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveLib(relPath) {
  const local = path.resolve(__dirname, "../../hooks/scripts/lib", relPath);
  if (fs.existsSync(local)) return local;
  const envRoot = process.env.EVEROS_AG_PLUGIN_ROOT;
  if (envRoot && fs.existsSync(path.resolve(envRoot, "hooks/scripts/lib", relPath))) {
    return path.resolve(envRoot, "hooks/scripts/lib", relPath);
  }
  return local;
}

function importLib(relPath) {
  const p = resolveLib(relPath).replace(/\\/g, "/");
  return import(`file:///${p}`);
}

const { loadConfig } = await importLib("config.js");
const { resolveIdentity } = await importLib("identity.js");
const { createClient } = await importLib("everos.js");
const { dualTrackSearch } = await importLib("search-tracks.js");
const {
  listStaleSessions,
  loadSessionState,
  saveSessionState,
  markFlushed,
} = await importLib("state.js");
const { renderProfileBlock, renderMemoryBlock } = await importLib("render.js");
const { FLUSH_DISPATCH_MS } = await importLib("constants.js");

const config = loadConfig();
const identity = resolveIdentity(process.cwd(), config);
const client = createClient({ baseUrl: config.baseUrl });

function formatPad(label, width = 16) {
  return label.padEnd(width, " ");
}

/**
 * Handle `status` subcommand
 */
async function handleStatus() {
  const lines = [];
  lines.push("══════════════════════════════════════════════════════════");
  lines.push("  EverOS Memory Engine for Google Antigravity - Status    ");
  lines.push("══════════════════════════════════════════════════════════");
  lines.push("");

  // 1. Service Health
  try {
    const health = await client.health(AbortSignal.timeout(2000));
    lines.push(`${formatPad("Server Status")} 🟢 Online (HTTP 200)`);
    lines.push(`${formatPad("Base URL")} ${config.baseUrl}`);
    if (health?.version) {
      lines.push(`${formatPad("EverOS Version")} ${health.version}`);
    }
  } catch (err) {
    lines.push(`${formatPad("Server Status")} 🔴 Offline / Unreachable (${err?.message || err})`);
    lines.push(`${formatPad("Base URL")} ${config.baseUrl}`);
  }

  lines.push("");

  // 2. Spatial Scope & Identity
  lines.push(`${formatPad("App Partition")} ${identity.appId}`);
  lines.push(`${formatPad("Project ID")} ${identity.projectId}`);
  lines.push(`${formatPad("Git Branch")} ${identity.branch}`);
  lines.push(`${formatPad("User ID")} ${identity.userId || "[not set: personal track disabled]"}`);
  lines.push(`${formatPad("Agent ID")} ${identity.agentId}`);
  lines.push(`${formatPad("Locale")} ${config.locale}`);
  lines.push(`${formatPad("Search Method")} ${config.searchMethod}`);

  lines.push("");

  // 3. Data Directory & Sessions
  let dirWritable = false;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const probe = path.join(config.dataDir, `.probe_${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    dirWritable = true;
  } catch {
    dirWritable = false;
  }

  lines.push(`${formatPad("Data Directory")} ${config.dataDir} (${dirWritable ? "writable" : "READ ONLY / PERM ERROR"})`);

  const stale = listStaleSessions(config.dataDir);
  lines.push(`${formatPad("Idle Sessions")} ${stale.length} pending 2PC flush sweep`);

  if (Array.isArray(config.warnings) && config.warnings.length > 0) {
    lines.push("");
    lines.push("Configuration Warnings:");
    for (const w of config.warnings) {
      lines.push(`  ⚠️  ${w}`);
    }
  }

  lines.push("");
  lines.push("Commands available:");
  lines.push("  /everos status         - Re-run this diagnostic report");
  lines.push("  /everos flush          - Seal and extract current project memory");
  lines.push("  /everos search <query> - Search engineering memories");

  return lines.join("\n");
}

/**
 * Handle `flush` subcommand
 */
async function handleFlush(targetConversationId) {
  let conversationId = targetConversationId;
  // If not explicitly specified, auto-discover the most recent unflushed session for this project
  if (!conversationId || conversationId === "default") {
    try {
      const candidates = listStaleSessions(config.dataDir, 0).filter(
        (s) => s.project_id === identity.projectId && s.flushed !== true
      );
      if (candidates.length > 0) {
        candidates.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        conversationId = candidates[0].session_id;
      } else {
        conversationId = "default";
      }
    } catch {
      conversationId = "default";
    }
  }

  const state = loadSessionState(config.dataDir, conversationId, {
    projectId: identity.projectId,
    branch: identity.branch,
    userId: identity.userId,
    agentId: identity.agentId,
  });

  const lines = [];
  lines.push(`Initiating 2PC memory seal for project '${identity.projectId}' (session: '${conversationId}')...`);

  try {
    await client.flush(
      {
        app_id: identity.appId,
        session_id: conversationId,
        project_id: identity.projectId,
      },
      AbortSignal.timeout(FLUSH_DISPATCH_MS)
    );

    markFlushed(state, true);
    saveSessionState(config.dataDir, state);

    lines.push("✅ 2PC Flush Acknowledged (HTTP 200).");
    lines.push(`Session state for '${conversationId}' marked flushed: true.`);
    lines.push("EverOS background extraction pipeline dispatched successfully.");
  } catch (err) {
    lines.push(`❌ Flush deferred: ${err?.message || err}`);
    lines.push("Session state left unflushed (Nack) to be compensated by next session start sweep.");
  }

  return lines.join("\n");
}

/**
 * Handle `search` subcommand
 */
async function handleSearch(args) {
  const rawFlag = args.includes("--raw");
  const queryWords = args.filter((a) => a !== "--raw");
  const query = queryWords.join(" ").trim();

  if (!query) {
    return "Error: Please provide a search query. Example: /everos search event bus design";
  }

  const TIMEOUT_MS = Math.min(Math.max(config.recallTimeoutMs || 5000, 500), 10000);
  const merged = await dualTrackSearch(client, {
    identity,
    query,
    config,
    topK: 5,
    includeProfile: true,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (rawFlag) {
    return JSON.stringify(merged, null, 2);
  }

  const rendered = renderMemoryBlock(merged, {
    projectId: identity.projectId,
    branch: identity.branch,
    locale: config.locale,
  });

  return rendered || `No memories found matching "${query}".`;
}

/**
 * Main router
 */
async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || "").toLowerCase();

  switch (command) {
    case "status":
      console.log(await handleStatus());
      break;

    case "flush":
      console.log(await handleFlush(args[1] || "default"));
      break;

    case "search":
      console.log(await handleSearch(args.slice(1)));
      break;

    case "help":
    case "-h":
    case "--help":
    default:
      console.log(await handleStatus());
      break;
  }
}

main().catch((err) => {
  console.error(`[everos-cli] Fatal: ${err?.message || err}`);
  process.exitCode = 1;
});

// Ensure stdout is 100% reserved for JSON-RPC 2.0 frames; redirect logs to stderr
console.log = (...args) => process.stderr.write(`[everos-mcp] ${args.join(" ")}\n`);

import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../hooks/scripts/lib/config.js";
import { resolveIdentity } from "../hooks/scripts/lib/identity.js";
import { createClient } from "../hooks/scripts/lib/everos.js";
import { renderProfileBlock, renderMemoryBlock } from "../hooks/scripts/lib/render.js";
import { dualTrackSearch } from "../hooks/scripts/lib/search-tracks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");

const config = loadConfig();
const identity = resolveIdentity(process.cwd(), config);
const client = createClient({ baseUrl: config.baseUrl });
const TIMEOUT_MS = Math.min(Math.max(config.recallTimeoutMs || 5000, 500), 10000);

/**
 * Standard MCP Tools definitions
 */
const TOOLS = [
  {
    name: "everos_search_memory",
    description:
      "Search historical memories and cognitive dialogues across project sessions via semantic & hybrid retrieval. " +
      "Returns distilled Markdown by default, or raw JSON when raw: true.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query describing the context, scenario or the very symptom. " +
            "For complex syndrome, refining concept keywords, architectural entities, etc., yields optimal recall.",
        },
        top_k: {
          type: "integer",
          description: "Maximum number of items to recall (1..20, default 5)",
          default: 5,
        },
        raw: {
          type: "boolean",
          description: "If true, returns full raw JSON with metadata; defaults to false (clean high-density Markdown)",
          default: false,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "everos_get_profile",
    description:
      "Get developer conventions and preferences profile for the current project (Prescriptive Covenants and Tacit Affinities).",
    inputSchema: {
      type: "object",
      properties: {
        raw: {
          type: "boolean",
          description: "If true, returns full raw profile JSON; defaults to false (clean Markdown)",
          default: false,
        },
      },
    },
  },
  {
    name: "everos_add_memory",
    description:
      "Explicitly ingest a high-value insight, troubleshooting postmortem, or architectural decision into EverOS.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The insight, troubleshooting case, or architectural covenant to record",
        },
        category: {
          type: "string",
          description: "Category hint: 'case' | 'rule' | 'fact'",
          enum: ["case", "rule", "fact"],
          default: "case",
        },
      },
      required: ["content"],
    },
  },
];

/**
 * Send standard JSON-RPC 2.0 response to stdout followed by newline.
 */
function sendResponse(id, result) {
  const payload = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(payload) + "\n", "utf8");
}

/**
 * Send standard JSON-RPC 2.0 error to stdout followed by newline.
 */
function sendError(id, code, message, data) {
  const payload = {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
  process.stdout.write(JSON.stringify(payload) + "\n", "utf8");
}

/**
 * Wrap text as standard CallToolResult
 */
function textResult(text, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: String(text ?? ""),
      },
    ],
    isError,
  };
}

/**
 * Handle tools/call execution
 */
async function handleToolCall(name, args = {}) {
  switch (name) {
    case "everos_search_memory": {
      const query = String(args.query || "").trim();
      if (!query) {
        return textResult("Error: query parameter is required and cannot be empty.", true);
      }
      const topK = Number.isInteger(args.top_k) ? Math.min(Math.max(args.top_k, 1), 20) : 5;

      const merged = await dualTrackSearch(client, {
        identity,
        query,
        config,
        topK,
        includeProfile: true,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // Distinguish offline / backend failure from genuine empty memory
      const attemptedCount = identity.userId ? 2 : 1;
      if (merged.errors.length >= attemptedCount && merged.episodes.length === 0 && merged.agent_cases.length === 0 && !merged.profile) {
        return textResult(
          `EverOS search unavailable: ${merged.errors[0]?.message || "Backend connection failed"}`,
          true
        );
      }

      if (args.raw === true) {
        return textResult(JSON.stringify(merged, null, 2));
      }

      const rendered = renderMemoryBlock(merged, {
        projectId: identity.projectId,
        branch: identity.branch,
        locale: config.locale,
      });

      if (!rendered) {
        return textResult(`No matching memories found for query: "${query}".`);
      }

      const notice =
        config.locale === "en"
          ? "\n\n> [Tip] The above is distilled high-density memory. Pass raw: true to view full raw JSON with confidence and evidence."
          : "\n\n> [提示] 以上为精简提炼的高密度工程记忆。如需查看完整原始数据（含置信度、时间戳与证据链），可传入参数 raw: true 再次查询。";

      return textResult(rendered + notice);
    }

    case "everos_get_profile": {
      const searchBody = {
        app_id: identity.appId,
        query: "developer preferences and coding style",
        project_id: identity.projectId,
        top_k: 1,
        include_profile: true,
      };
      if (identity.userId) {
        searchBody.user_id = identity.userId;
      } else {
        searchBody.agent_id = identity.agentId;
      }

      let searchRes;
      try {
        searchRes = await client.search(searchBody, AbortSignal.timeout(TIMEOUT_MS));
      } catch (err) {
        return textResult(
          `EverOS profile unavailable: ${err?.message || "Backend connection failed"}`,
          true
        );
      }
      const profileItem = searchRes?.profiles?.[0] ?? null;

      if (!profileItem) {
        return textResult(`No profile recorded for project: ${identity.projectId}.`);
      }

      if (args.raw === true) {
        return textResult(JSON.stringify(profileItem, null, 2));
      }

      const rendered = renderProfileBlock(profileItem, {
        projectId: identity.projectId,
        branch: identity.branch,
        locale: config.locale,
      });

      return textResult(rendered || `Empty profile for project: ${identity.projectId}.`);
    }

    case "everos_add_memory": {
      const content = String(args.content || "").trim();
      if (!content) {
        return textResult("Error: content parameter is required and cannot be empty.", true);
      }
      const category = String(args.category || "case").trim();
      const now = Date.now();

      const messages = [
        {
          sender_id: identity.userId || "developer",
          role: "user",
          timestamp: now - 1000,
          content: `[Manual Record: ${category}] ${content}`,
        },
        {
          sender_id: identity.agentId,
          role: "assistant",
          timestamp: now,
          content: `Recorded insight: ${content}`,
        },
      ];

      await client.add(
        {
          app_id: identity.appId,
          session_id: `manual_${now}`,
          project_id: identity.projectId,
          messages,
        },
        AbortSignal.timeout(TIMEOUT_MS)
      );

      return textResult(
        `Successfully ingested memory into project '${identity.projectId}' (category: ${category}).`
      );
    }

    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

/**
 * Main stdio JSON-RPC processing loop
 */
export function startMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (parseErr) {
      sendError(null, -32700, "Parse error: invalid JSON");
      return;
    }

    if (!msg || typeof msg !== "object") return;

    const { id, method, params } = msg;

    // Handle notifications (no id)
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") {
        /* client initialized acknowledgement, silent ignore */
      }
      return;
    }

    try {
      switch (method) {
        case "initialize": {
          sendResponse(id, {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "everos-antigravity",
              version: "1.0.0",
            },
            capabilities: {
              tools: {},
            },
          });
          break;
        }

        case "ping": {
          sendResponse(id, {});
          break;
        }

        case "tools/list": {
          sendResponse(id, { tools: TOOLS });
          break;
        }

        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          try {
            const result = await handleToolCall(toolName, toolArgs);
            sendResponse(id, result);
          } catch (toolErr) {
            sendResponse(id, textResult(`Tool Error: ${toolErr?.message || toolErr}`, true));
          }
          break;
        }

        default:
          sendError(id, -32601, `Method not found: ${method}`);
          break;
      }
    } catch (err) {
      sendError(id, -32603, `Internal RPC Error: ${err?.message || err}`);
    }
  });
}

// Start server if directly invoked
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startMcpServer();
}

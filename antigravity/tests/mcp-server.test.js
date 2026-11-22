import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { startFakeEveros } from "./helpers/fake-everos.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function spawnMcpClient(env = {}) {
  const child = spawn(process.execPath, [path.join(root, "mcp", "server.js")], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pendingRequests = new Map();
  const listeners = [];

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      for (const listener of [...listeners]) {
        listener(msg);
      }
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  });

  let nextId = 1;
  function sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pendingRequests.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", "utf8");
    });
  }

  function sendRaw(raw) {
    child.stdin.write(raw, "utf8");
  }

  function waitForMessage(predicate, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = listeners.indexOf(onMsg);
        if (idx !== -1) listeners.splice(idx, 1);
        reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMsg = (msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          const idx = listeners.indexOf(onMsg);
          if (idx !== -1) listeners.splice(idx, 1);
          resolve(msg);
        }
      };

      listeners.push(onMsg);
    });
  }

  function close() {
    return new Promise((resolve) => {
      child.kill();
      child.on("close", resolve);
    });
  }

  return { sendRequest, sendRaw, waitForMessage, close, child };
}

function createMockSearchData() {
  return (body) => {
    return {
      episodes: [
        {
          subject: "Architecture Seam",
          summary: "Decoupled MCP from lifecycle",
          atomic_facts: ["Stdio line-buffering prevents fragmentation"],
        },
      ],
      agent_cases: [
        {
          task_intent: "MCP Protocol Conformance",
          key_insight: "CallToolResult content wrapping is mandatory",
        },
      ],
      profile: {
        profile_data: {
          explicit_info: { dependencies: "zero-dep pure ESM" },
          implicit_traits: ["Prefers fail-open error containment"],
        },
      },
    };
  };
}

test("mcp-server: initialize and ping handshake", async (t) => {
  const fake = await startFakeEveros();
  const client = spawnMcpClient({ EVEROS_AG_BASE_URL: fake.baseUrl });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  // 1. initialize
  const initRes = await client.sendRequest("initialize");
  assert.equal(initRes.result.serverInfo.name, "everos-antigravity");
  assert.equal(initRes.result.protocolVersion, "2024-11-05");
  assert.ok(initRes.result.capabilities.tools);

  // 2. ping
  const pingRes = await client.sendRequest("ping");
  assert.deepEqual(pingRes.result, {});
});

test("mcp-server: tools/list lists 3 prefixed tools with valid schemas", async (t) => {
  const fake = await startFakeEveros();
  const client = spawnMcpClient({ EVEROS_AG_BASE_URL: fake.baseUrl });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  const res = await client.sendRequest("tools/list");
  assert.ok(res.result.tools);
  assert.equal(res.result.tools.length, 3);

  const toolNames = res.result.tools.map((t) => t.name);
  assert.deepEqual(toolNames, [
    "everos_search_memory",
    "everos_get_profile",
    "everos_add_memory",
  ]);

  // Verify search tool schema
  const searchTool = res.result.tools.find((t) => t.name === "everos_search_memory");
  assert.equal(searchTool.inputSchema.required[0], "query");
  assert.ok(searchTool.inputSchema.properties.raw);
});

test("mcp-server: everos_search_memory supports progressive disclosure (Markdown vs raw JSON)", async (t) => {
  const fake = await startFakeEveros({ searchFn: createMockSearchData() });
  const client = spawnMcpClient({
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_PROJECT_ID: "github.com_mcp_test",
  });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  // 1. Default mode: clean Markdown with raw hint
  const mdRes = await client.sendRequest("tools/call", {
    name: "everos_search_memory",
    arguments: { query: "MCP protocol" },
  });

  assert.equal(mdRes.result.isError, false);
  assert.ok(Array.isArray(mdRes.result.content));
  const text = mdRes.result.content[0].text;
  assert.match(text, /<everos_memory>/);
  assert.match(text, /【曾有范例】/);
  assert.match(text, /CallToolResult content wrapping is mandatory/);
  assert.match(text, /raw: true/); // Progressive disclosure hint!

  // 2. Raw JSON mode: full metadata
  const rawRes = await client.sendRequest("tools/call", {
    name: "everos_search_memory",
    arguments: { query: "MCP protocol", raw: true },
  });

  assert.equal(rawRes.result.isError, false);
  const rawText = rawRes.result.content[0].text;
  const parsedRaw = JSON.parse(rawText);
  assert.ok(Array.isArray(parsedRaw.episodes));
  assert.ok(Array.isArray(parsedRaw.agent_cases));
  assert.equal(parsedRaw.agent_cases[0].task_intent, "MCP Protocol Conformance");

  // 3. Validation error on missing query
  const errRes = await client.sendRequest("tools/call", {
    name: "everos_search_memory",
    arguments: {},
  });
  assert.equal(errRes.result.isError, true);
  assert.match(errRes.result.content[0].text, /query parameter is required/);

  // 4. Strict wire payload assertion: verify app_id and project_id on wire
  const searchReqs = fake.only("/api/v2/memory/search");
  assert.ok(searchReqs.length >= 2);
  for (const req of searchReqs) {
    assert.equal(req.body.app_id, "antigravity");
    assert.equal(req.body.project_id, "github.com_mcp_test");
    assert.equal(req.body.query, "MCP protocol");
  }
});

test("mcp-server: everos_get_profile returns clean Markdown or raw JSON", async (t) => {
  const fake = await startFakeEveros({ searchFn: createMockSearchData() });
  const client = spawnMcpClient({
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_PROJECT_ID: "github.com_mcp_test",
  });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  // Markdown mode
  const mdRes = await client.sendRequest("tools/call", {
    name: "everos_get_profile",
    arguments: {},
  });

  assert.equal(mdRes.result.isError, false);
  const text = mdRes.result.content[0].text;
  assert.match(text, /<everos_profile>/);
  assert.match(text, /【既定规约】/);
  assert.match(text, /zero-dep pure ESM/);

  // Raw JSON mode
  const rawRes = await client.sendRequest("tools/call", {
    name: "everos_get_profile",
    arguments: { raw: true },
  });

  assert.equal(rawRes.result.isError, false);
  const parsed = JSON.parse(rawRes.result.content[0].text);
  assert.equal(parsed.profile_data.explicit_info.dependencies, "zero-dep pure ESM");

  // Strict wire payload assertion
  const profileReqs = fake.only("/api/v2/memory/search");
  assert.ok(profileReqs.length >= 1);
  for (const req of profileReqs) {
    assert.equal(req.body.app_id, "antigravity");
    assert.equal(req.body.project_id, "github.com_mcp_test");
    assert.equal(req.body.include_profile, true);
  }
});

test("mcp-server: everos_add_memory successfully ingests memory with app_id", async (t) => {
  const fake = await startFakeEveros();
  const client = spawnMcpClient({
    EVEROS_AG_BASE_URL: fake.baseUrl,
    EVEROS_AG_PROJECT_ID: "github.com_mcp_test",
  });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  const addRes = await client.sendRequest("tools/call", {
    name: "everos_add_memory",
    arguments: {
      content: "Always use readline interface for line-buffered stdio framing in Node.js",
      category: "case",
    },
  });

  assert.equal(addRes.result.isError, false);
  assert.match(addRes.result.content[0].text, /Successfully ingested memory/);

  // Verify fake received /add with app_id: "antigravity"
  const addRequests = fake.only("/api/v2/memory/add");
  assert.equal(addRequests.length, 1);
  assert.equal(addRequests[0].body.app_id, "antigravity");
  assert.equal(addRequests[0].body.project_id, "github.com_mcp_test");
  assert.match(addRequests[0].body.messages[0].content, /Always use readline interface/);
});

test("mcp-server: returns appropriate error codes for unknown method and unknown tool", async (t) => {
  const fake = await startFakeEveros();
  const client = spawnMcpClient({ EVEROS_AG_BASE_URL: fake.baseUrl });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  // Unknown method
  const methodRes = await client.sendRequest("invalid_method");
  assert.equal(methodRes.error.code, -32601);
  assert.match(methodRes.error.message, /Method not found/);

  // Unknown tool
  const toolRes = await client.sendRequest("tools/call", {
    name: "non_existent_tool",
  });
  assert.equal(toolRes.result.isError, true);
  assert.match(toolRes.result.content[0].text, /Unknown tool/);
});

test("mcp-server: handles chunked (split-packet) and coalesced (sticky-packet) stdio frames", async (t) => {
  const fake = await startFakeEveros();
  const client = spawnMcpClient({ EVEROS_AG_BASE_URL: fake.baseUrl });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  // 1. Chunked (split-packet) delivery
  const chunkWait = client.waitForMessage((m) => m.id === 501);
  client.sendRaw('{"jsonrpc":"2.0","id":501,');
  await new Promise((r) => setTimeout(r, 20));
  client.sendRaw('"method":"ping"}\n');

  const chunkRes = await chunkWait;
  assert.equal(chunkRes.id, 501);
  assert.deepEqual(chunkRes.result, {});

  // 2. Coalesced (sticky-packet) delivery: two complete JSON frames in one buffer write
  const wait601 = client.waitForMessage((m) => m.id === 601);
  const wait602 = client.waitForMessage((m) => m.id === 602);
  client.sendRaw(
    '{"jsonrpc":"2.0","id":601,"method":"ping"}\n{"jsonrpc":"2.0","id":602,"method":"ping"}\n'
  );

  const [res601, res602] = await Promise.all([wait601, wait602]);
  assert.equal(res601.id, 601);
  assert.equal(res602.id, 602);
});

test("mcp-server: returns -32700 Parse error on malformed JSON without crashing", async (t) => {
  const fake = await startFakeEveros();
  const client = spawnMcpClient({ EVEROS_AG_BASE_URL: fake.baseUrl });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  const parseErrorWait = client.waitForMessage((m) => m.error?.code === -32700);
  client.sendRaw('{"jsonrpc":"2.0", broken json...\n');

  const errRes = await parseErrorWait;
  assert.equal(errRes.id, null);
  assert.equal(errRes.error.code, -32700);
  assert.match(errRes.error.message, /Parse error: invalid JSON/);

  // Verify server is still alive and processes subsequent valid requests
  const pingRes = await client.sendRequest("ping");
  assert.deepEqual(pingRes.result, {});
});

test("mcp-server: silently consumes notifications without replying or crashing", async (t) => {
  const fake = await startFakeEveros();
  const client = spawnMcpClient({ EVEROS_AG_BASE_URL: fake.baseUrl });

  t.after(async () => {
    await client.close();
    fake.close();
  });

  // Send initialized notification (no id)
  client.sendRaw('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

  // Send a subsequent ping request to confirm notification produced no phantom reply
  const pingRes = await client.sendRequest("ping");
  assert.deepEqual(pingRes.result, {});
});

test("mcp-server: returns isError: true when EverOS backend is unreachable", async (t) => {
  // Use a non-routable port to simulate complete outage
  const client = spawnMcpClient({ EVEROS_AG_BASE_URL: "http://127.0.0.1:1" });

  t.after(async () => {
    await client.close();
  });

  const res = await client.sendRequest("tools/call", {
    name: "everos_search_memory",
    arguments: { query: "fail-test" },
  });

  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /EverOS search unavailable:/);

  // Also test everos_get_profile resilience under outage
  const profileRes = await client.sendRequest("tools/call", {
    name: "everos_get_profile",
  });
  assert.equal(profileRes.result.isError, true);
  assert.match(profileRes.result.content[0].text, /EverOS profile unavailable:/);

  // Process should remain healthy and answer ping
  const pingRes = await client.sendRequest("ping");
  assert.deepEqual(pingRes.result, {});
});

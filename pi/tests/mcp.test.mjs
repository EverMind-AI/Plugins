import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedServerNames, projectServerName, readFileEverosServer } from "../src/mcp.ts";

function writeMcp(entry) {
  process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-everos-mcp-"));
  writeFileSync(join(process.env.PI_AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { everos: entry } }));
}

test("disabled mcp.json everos does not override the plugin name", () => {
  writeMcp({ enabled: false, command: "uvx" });
  const info = readFileEverosServer();
  assert.equal(info.present, true);
  assert.equal(info.enabled, false);
  assert.equal(info.overridesExtension, false);
  assert.equal(projectServerName(info), "everos");
  assert.deepEqual(ownedServerNames(info), ["everos", "everos-global"]);
});

test("enabled mcp.json everos uses the fallback server name", () => {
  writeMcp({ enabled: true, command: "uvx" });
  const info = readFileEverosServer();
  assert.equal(info.overridesExtension, true);
  assert.equal(projectServerName(info), "everos-pi");
});

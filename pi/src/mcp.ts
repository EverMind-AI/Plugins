import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./credentials.ts";
import { redact } from "./redact.ts";

export const PROJECT_SERVER = "everos";
export const GLOBAL_SERVER = "everos-global";
/** 仅当 mcp.json 占用 `everos` 时作为让路名。 */
export const SPIKE_SERVER = "everos-pi";

export interface FileServerInfo {
  path: string;
  present: boolean;
  enabled: boolean;
  command?: string;
  overridesExtension: boolean;
}

export function readFileEverosServer(): FileServerInfo {
  const path = join(agentDir(), "mcp.json");
  const info: FileServerInfo = {
    path,
    present: false,
    enabled: false,
    overridesExtension: false,
  };
  if (!existsSync(path)) return info;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, { enabled?: boolean; command?: string }>;
    };
    const entry = parsed.mcpServers?.everos;
    if (!entry) return info;
    info.present = true;
    info.enabled = entry.enabled !== false;
    info.command = entry.command;
    info.overridesExtension = info.enabled;
    return info;
  } catch (error) {
    throw new Error(redact(`Failed to read ${path}: ${String(error)}`));
  }
}

/** Filesystem only. Safe to call from the extension factory. */
export function resolveUvx(): { command: string; onDisk: boolean } {
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "uvx.exe"),
    join(home, ".local", "bin", "uvx"),
    join(home, ".cargo", "bin", "uvx.exe"),
    join(home, ".cargo", "bin", "uvx"),
  ];
  const command = candidates.find((path) => existsSync(path));
  if (command) return { command, onDisk: true };
  return {
    command: process.platform === "win32" ? "uvx.exe" : "uvx",
    onDisk: false,
  };
}

export function uvInstallHint(): string {
  if (process.platform === "win32") {
    return "doctor: uvx not found on disk. Install uv from https://docs.astral.sh/uv/ then restart Pi. Windows: powershell -ExecutionPolicy Bypass -c \"irm https://astral.sh/uv/install.ps1 | iex\"";
  }
  return "doctor: uvx not found on disk. Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh";
}

export function projectServerName(fileServer: FileServerInfo): string {
  return fileServer.overridesExtension ? SPIKE_SERVER : PROJECT_SERVER;
}

export function uvxConfig(env: Record<string, string>): McpServerConfig {
  const { command } = resolveUvx();
  return {
    command,
    args: ["everos-mcp"],
    env,
    exposure: "direct",
    description: "EverOS long-term memory",
    timeout: 60,
  };
}

export function ownedServerNames(fileServer: FileServerInfo): string[] {
  if (fileServer.overridesExtension) return [SPIKE_SERVER, GLOBAL_SERVER];
  return [PROJECT_SERVER, GLOBAL_SERVER];
}

export function everosToolNames(pi: ExtensionAPI, server: string): string[] {
  const prefix = `mcp__${server.replace(/-/g, "_")}__`;
  const alt = `mcp__${server}__`;
  return pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => name.startsWith(prefix) || name.startsWith(alt))
    .sort();
}

export function allOwnedToolNames(pi: ExtensionAPI, servers: string[]): string[] {
  return [...new Set(servers.flatMap((server) => everosToolNames(pi, server)))].sort();
}

export async function waitForTools(
  pi: ExtensionAPI,
  server: string,
  timeoutMs: number,
): Promise<string[]> {
  const started = Date.now();
  let names = everosToolNames(pi, server);
  while (names.length === 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    names = everosToolNames(pi, server);
  }
  return names;
}

import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type CredentialSource = "process-env" | "user-env" | "none";

export interface ResolvedCredentials {
  source: CredentialSource;
  present: boolean;
  /** Only returned so it can be injected into stdio env. Never log this. */
  apiKey?: string;
}

/** Filesystem/env only. Safe to call from the extension factory. */
export function resolveProcessCredentials(): ResolvedCredentials {
  const fromProcess = process.env.EVEROS_API_KEY?.trim();
  if (fromProcess) {
    return { source: "process-env", present: true, apiKey: fromProcess };
  }
  return { source: "none", present: false };
}

/** May spawn PowerShell. Call from commands or session_start, not the factory. */
export function resolveCredentials(): ResolvedCredentials {
  const fromProcess = resolveProcessCredentials();
  if (fromProcess.present) return fromProcess;

  const fromUser = readWindowsUserEnv("EVEROS_API_KEY")?.trim();
  if (fromUser) {
    return { source: "user-env", present: true, apiKey: fromUser };
  }

  return { source: "none", present: false };
}

export function mcpApiKeyEnv(creds: ResolvedCredentials): Record<string, string> {
  if (creds.source === "process-env") {
    return { EVEROS_API_KEY: "${EVEROS_API_KEY}" };
  }
  if (creds.apiKey) {
    return { EVEROS_API_KEY: creds.apiKey };
  }
  return {};
}

function readWindowsUserEnv(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const script = `try { $k = [Environment]::GetEnvironmentVariable('${name}','User'); if ($k) { $k } } catch {}`;
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const value = result.stdout?.trim();
  return value || undefined;
}

export function agentDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

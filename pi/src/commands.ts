import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { EverosSettings } from "./config.ts";
import { resolveAssistantSenderId, saveSettings } from "./config.ts";
import type { FileServerInfo } from "./mcp.ts";
import {
  GLOBAL_SERVER,
  PROJECT_SERVER,
  SPIKE_SERVER,
  everosToolNames,
  ownedServerNames,
  projectServerName,
  uvInstallHint,
  waitForTools,
} from "./mcp.ts";
import { buildDoctorReport } from "./report.ts";
import type { ResolvedCredentials } from "./credentials.ts";
import { pickEverosTool } from "./prompt.ts";
import { isValidScopeId } from "./scope.ts";
import { t } from "./text.ts";

export interface CommandDeps {
  pi: ExtensionAPI;
  settings: () => EverosSettings;
  setSettings: (next: EverosSettings) => void;
  fileServer: () => FileServerInfo;
  creds: () => ResolvedCredentials;
  refreshCreds: () => ResolvedCredentials;
  uvxCommand: () => string;
  uvxOnDisk: () => boolean;
  registerServers: () => void;
  unregisterServers: () => void;
  projectId: () => string;
  setCwd: (cwd: string) => void;
}

const SUBS = ["status", "login", "logout", "scope", "reconnect", "doctor"] as const;

export function registerEverosCommand(deps: CommandDeps): void {
  deps.pi.registerCommand("everos", {
    description: "EverOS memory status and diagnostics",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim();
      const [head, tail] = trimmed.split(/\s+/);
      if (!head || SUBS.some((name) => name.startsWith(trimmed))) {
        return SUBS.filter((name) => name.startsWith(trimmed)).map((value) => ({ value, label: value }));
      }
      if (head === "scope") {
        const options = ["auto", "project", "global"];
        const needle = tail ?? "";
        return options.filter((name) => name.startsWith(needle)).map((value) => ({ value: `scope ${value}`, label: value }));
      }
      return [];
    },
    handler: async (args, ctx) => {
      deps.setCwd(ctx.cwd);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] || "status";
      switch (sub) {
        case "login":
          return login(deps, ctx);
        case "logout":
          return logout(deps, ctx);
        case "reconnect":
          return reconnect(deps, ctx);
        case "scope":
          return scope(deps, ctx, tokens.slice(1));
        case "doctor":
          return status(deps, ctx, true);
        default:
          return status(deps, ctx, false);
      }
    },
  });
}

async function status(deps: CommandDeps, ctx: ExtensionCommandContext, doctor: boolean): Promise<void> {
  const settings = deps.settings();
  const fileServer = deps.fileServer();
  const creds = deps.creds();
  const servers = ownedServerNames(fileServer);
  const projectServer = projectServerName(fileServer);
  if (settings.enabled) await waitForTools(deps.pi, projectServer, 12_000);
  const tools: Record<string, string[]> = {
    [SPIKE_SERVER]: everosToolNames(deps.pi, SPIKE_SERVER),
    [PROJECT_SERVER]: everosToolNames(deps.pi, PROJECT_SERVER),
    [GLOBAL_SERVER]: everosToolNames(deps.pi, GLOBAL_SERVER),
  };
  const counts = {
    [SPIKE_SERVER]: tools[SPIKE_SERVER].length,
    [PROJECT_SERVER]: tools[PROJECT_SERVER].length,
    [GLOBAL_SERVER]: tools[GLOBAL_SERVER].length,
  };
  const notes: string[] = [];
  if (fileServer.present && fileServer.enabled) notes.push(t("doctorDisable"));
  else if (fileServer.present && !fileServer.enabled) notes.push(t("doctorDisabledOwns"));
  if (!deps.uvxOnDisk()) notes.push(uvInstallHint());
  if (!creds.present) notes.push(t("missingKey"));
  if (settings.enabled && counts[projectServer] === 0 && counts[GLOBAL_SERVER] === 0) {
    notes.push("doctor: no extension-owned EverOS tools yet. Wait for MCP connect, or check uvx/key.");
  }
  if (!settings.enabled) notes.push("doctor: plugin disabled in everos.json. /everos login to enable.");
  const projectTools = tools[projectServer] ?? [];
  const globalTools = tools[GLOBAL_SERVER];
  const report = buildDoctorReport({
    banner: t("doctorBanner"),
    end: t("doctorEnd"),
    enabled: settings.enabled,
    uvx: deps.uvxCommand(),
    uvxOnDisk: deps.uvxOnDisk(),
    keySource: creds.present ? creds.source : "missing",
    fileEveros: fileServer.present ? (fileServer.enabled ? "enabled" : "disabled") : "absent",
    fileCommand: fileServer.command,
    override: fileServer.overridesExtension,
    userId: settings.userId,
    appId: settings.appId,
    projectId: deps.projectId(),
    globalProjectId: settings.globalProjectId,
    assistantSenderId: resolveAssistantSenderId(settings),
    owned: servers,
    toolCounts: counts,
    promptEnabled: settings.prompt.enabled,
    projectRecord: Boolean(pickEverosTool(projectTools, "record_trajectory")),
    projectRecall: Boolean(pickEverosTool(projectTools, "recall_agent_experience")),
    globalRecord: Boolean(pickEverosTool(globalTools, "record_trajectory")),
    globalRecall: Boolean(pickEverosTool(globalTools, "recall_agent_experience")),
    agentGate: t("agentGate"),
    agentDistill: t("agentDistill"),
    agentForget: t("agentForget"),
    notes: doctor ? notes : [],
  });
  ctx.ui.notify(report, fileServer.overridesExtension || !creds.present || !settings.enabled ? "warning" : "info");
}

async function scope(deps: CommandDeps, ctx: ExtensionCommandContext, args: string[]): Promise<void> {
  const settings = deps.settings();
  const [action, value] = args;
  if (!action) {
    ctx.ui.notify(scopeLines(deps, settings).join("\n"), "info");
    return;
  }
  if (action === "auto") {
    applyScope(deps, { ...settings, projectId: "auto" });
    ctx.ui.notify(`projectId=auto → ${deps.projectId()} (directory basename)\nReconnected.`, "info");
    return;
  }
  if (action === "project") {
    if (!value || !isValidScopeId(value)) {
      ctx.ui.notify("Usage: /everos scope project <id>  (letters, digits, . _ @ + -)", "warning");
      return;
    }
    applyScope(deps, { ...settings, projectId: value });
    ctx.ui.notify(`projectId=${deps.projectId()}\nReconnected.`, "info");
    return;
  }
  if (action === "global") {
    if (!value || !isValidScopeId(value) || value === "auto") {
      ctx.ui.notify("Usage: /everos scope global <id>  (letters, digits, . _ @ + -)", "warning");
      return;
    }
    applyScope(deps, { ...settings, globalProjectId: value });
    ctx.ui.notify(`globalProjectId=${value}\nReconnected.`, "info");
    return;
  }
  ctx.ui.notify("Usage: /everos scope [auto|project <id>|global <id>]", "warning");
}

function applyScope(deps: CommandDeps, next: EverosSettings): void {
  deps.setSettings(next);
  saveSettings(next);
  deps.unregisterServers();
  deps.registerServers();
}

function scopeLines(deps: CommandDeps, settings: EverosSettings): string[] {
  const auto = settings.projectId === "auto";
  return [
    `userId=${settings.userId}`,
    `appId=${settings.appId}`,
    `projectId=${deps.projectId()} (setting=${settings.projectId}${auto ? ", derived from directory basename" : ""})`,
    `globalProjectId=${settings.globalProjectId}`,
    "Search project tools for workspace facts; search global tools for user-wide preferences.",
    "Change: /everos scope auto | /everos scope project <id> | /everos scope global <id>",
  ];
}

async function login(deps: CommandDeps, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(t("loginHelp"), "info");
  const creds = deps.refreshCreds();
  if (!creds.present) return;
  const next = { ...deps.settings(), enabled: true };
  deps.setSettings(next);
  saveSettings(next);
  deps.unregisterServers();
  deps.registerServers();
  ctx.ui.notify(t("loginOk"), "info");
}

async function logout(deps: CommandDeps, ctx: ExtensionCommandContext): Promise<void> {
  const next = { ...deps.settings(), enabled: false };
  deps.setSettings(next);
  saveSettings(next);
  deps.unregisterServers();
  ctx.ui.notify(t("logout"), "info");
}

async function reconnect(deps: CommandDeps, ctx: ExtensionCommandContext): Promise<void> {
  deps.refreshCreds();
  const next = { ...deps.settings(), enabled: true };
  deps.setSettings(next);
  saveSettings(next);
  deps.unregisterServers();
  deps.registerServers();
  ctx.ui.notify(t("reconnect"), "info");
}

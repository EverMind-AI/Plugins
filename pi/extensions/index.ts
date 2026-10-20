import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEverosCommand } from "../src/commands.ts";
import { ensureSettingsFile, resolveAssistantSenderId, type EverosSettings } from "../src/config.ts";
import { mcpApiKeyEnv, resolveCredentials, resolveProcessCredentials } from "../src/credentials.ts";
import {
  GLOBAL_SERVER,
  allOwnedToolNames,
  everosToolNames,
  ownedServerNames,
  projectServerName,
  readFileEverosServer,
  resolveUvx,
  uvxConfig,
} from "../src/mcp.ts";
import { isMutatingMemoryTool, isPlanModeActive } from "../src/guard.ts";
import { buildEverosAgentSection, buildEverosSection } from "../src/prompt.ts";
import { resolveProjectId } from "../src/scope.ts";
import { planBlockReason, t } from "../src/text.ts";

export default function (pi: ExtensionAPI) {
  let settings = ensureSettingsFile();
  const fileServer = readFileEverosServer();
  const uvx = resolveUvx();
  let creds = resolveProcessCredentials();
  let startupWarned = false;
  let errorWarned = false;
  let cwd = process.cwd();

  const projectId = () => resolveProjectId(settings.projectId, cwd);
  const servers = () => ownedServerNames(fileServer);

  const unregisterServers = () => {
    for (const name of servers()) {
      try {
        pi.unregisterMcpServer(name);
      } catch {
        // not registered
      }
    }
  };

  const registerServers = () => {
    if (!settings.enabled) return;
    if (!creds.present) return;
    const shared = {
      ...mcpApiKeyEnv(creds),
      EVEROS_USER_ID: settings.userId,
      EVEROS_APP_ID: settings.appId,
      EVEROS_ASSISTANT_SENDER_ID: resolveAssistantSenderId(settings),
    };
    for (const name of servers()) {
      const id = name === GLOBAL_SERVER ? settings.globalProjectId : projectId();
      pi.registerMcpServer(name, uvxConfig({ ...shared, EVEROS_PROJECT_ID: id }));
    }
  };

  registerServers();

  registerEverosCommand({
    pi,
    settings: () => settings,
    setSettings: (next: EverosSettings) => {
      settings = next;
    },
    fileServer: () => fileServer,
    creds: () => creds,
    refreshCreds: () => {
      creds = resolveCredentials();
      return creds;
    },
    uvxCommand: () => uvx.command,
    uvxOnDisk: () => uvx.onDisk,
    registerServers,
    unregisterServers,
    projectId,
    setCwd: (next) => {
      cwd = next;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const previousCwd = cwd;
    const hadCreds = creds.present;
    cwd = ctx.cwd;
    if (!creds.present) creds = resolveCredentials();
    if (settings.enabled && creds.present) {
      if (previousCwd !== cwd) {
        unregisterServers();
        registerServers();
      } else if (!hadCreds) {
        registerServers();
      }
    }
    if (startupWarned) return;
    startupWarned = true;
    if (!settings.enabled) return;
    if (!creds.present) ctx.ui.notify(t("missingKey"), "warning");
    else if (fileServer.overridesExtension) ctx.ui.notify(t("override"), "warning");
    else if (!uvx.onDisk) ctx.ui.notify(t("uvMissing"), "warning");
  });

  pi.on("tool_call", (event, ctx) => {
    const planFlag = pi.getFlag("plan") === true;
    if (!isPlanModeActive(ctx.sessionManager.getBranch(), planFlag)) return;
    if (!isMutatingMemoryTool(event.toolName)) return;
    return { block: true, reason: planBlockReason(event.toolName) };
  });

  pi.on("tool_result", (event, ctx) => {
    if (errorWarned || !event.isError) return;
    if (!allOwnedToolNames(pi, servers()).includes(event.toolName)) return;
    errorWarned = true;
    ctx.ui.notify(t("toolFailed"), "warning");
  });

  pi.on("session_shutdown", () => {
    unregisterServers();
  });

  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections;
    if (!settings.prompt.enabled) {
      delete sections.everos;
      delete sections.everos_agent;
      return;
    }
    const projectTools = everosToolNames(pi, projectServerName(fileServer));
    const globalTools = everosToolNames(pi, GLOBAL_SERVER);
    const available = settings.enabled && creds.present;
    sections.everos = buildEverosSection({
      available,
      projectId: projectId(),
      globalProjectId: settings.globalProjectId,
      projectTools,
      globalTools,
      maxTokens: settings.prompt.maxTokens,
      customText: settings.prompt.customText,
      overrideWarning:
        fileServer.overridesExtension && projectTools.length === 0
          ? "Disable or rename the mcp.json `everos` entry, then /reload."
          : undefined,
    });
    const agent = buildEverosAgentSection({ available, projectTools, globalTools });
    if (agent) sections.everos_agent = agent;
    else delete sections.everos_agent;
  });
}

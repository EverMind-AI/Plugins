export type Locale = "en" | "zh";

export function locale(): Locale {
  const hint = process.env.PI_LANG || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh\b/i.test(hint) ? "zh" : "en";
}

const COPY = {
  planBlock: {
    en: (tool: string) => `Plan mode: blocked ${tool}. Memory writes are disabled until /plan is turned off.`,
    zh: (tool: string) => `计划模式已拦截 ${tool}。关闭 /plan 后才能写入记忆。`,
  },
  missingKey: {
    en: "EverOS: EVEROS_API_KEY missing. Run /everos doctor.",
    zh: "EverOS：缺少 EVEROS_API_KEY。请运行 /everos doctor。",
  },
  override: {
    en: "EverOS: mcp.json already has enabled `everos`, so it overrides that name. The plugin uses a fallback server. /everos doctor for details.",
    zh: "EverOS：mcp.json 里已启用 everos，占用该名称，插件改用后备服务器。详见 /everos doctor。",
  },
  uvMissing: {
    en: "EverOS: uvx binary not found in ~/.local/bin. If connect fails, install uv. /everos doctor.",
    zh: "EverOS：未在 ~/.local/bin 找到 uvx。若连接失败请安装 uv。详见 /everos doctor。",
  },
  toolFailed: {
    en: "EverOS: a memory tool failed. Main chat continues. /everos reconnect or /everos doctor.",
    zh: "EverOS：记忆工具失败。主对话继续。可用 /everos reconnect 或 /everos doctor。",
  },
  logout: {
    en: "EverOS disconnected for this plugin. User EVEROS_API_KEY was not deleted.",
    zh: "已断开本插件的 EverOS。未删除系统里的 EVEROS_API_KEY。",
  },
  loginOk: {
    en: "EVEROS_API_KEY found. Reconnected. The key was not written to everos.json.",
    zh: "已找到 EVEROS_API_KEY 并重新连接。密钥未写入 everos.json。",
  },
  loginHelp: {
    en: "EverOS login does not store the API key in everos.json.\n1. Create a key in the EverOS Console.\n2. Set user environment variable EVEROS_API_KEY.\n3. Run /everos reconnect or restart Pi.\nWindows: setx EVEROS_API_KEY your_key",
    zh: "登录不会把 API key 写入 everos.json。\n1. 在 EverOS Console 创建密钥。\n2. 把 EVEROS_API_KEY 设为用户环境变量。\n3. 运行 /everos reconnect 或重启 Pi。\nWindows: setx EVEROS_API_KEY your_key",
  },
  reconnect: {
    en: "EverOS reconnect requested. Run /everos status after tools appear.",
    zh: "已请求重连 EverOS。工具出现后可运行 /everos status。",
  },
  doctorBanner: {
    en: "----- pi-everos doctor -----",
    zh: "----- pi-everos 诊断 -----",
  },
  doctorEnd: {
    en: "----- end -----",
    zh: "----- 结束 -----",
  },
  doctorDisable: {
    en: "doctor: mcp.json has enabled `everos`, which overrides the plugin. Rename or disable that entry, then /reload. This plugin will not edit mcp.json.",
    zh: "doctor：mcp.json 里已启用 everos，会覆盖插件。请改名或禁用该条目后 /reload。插件不会改 mcp.json。",
  },
  doctorDisabledOwns: {
    en: "doctor: mcp.json has `everos` disabled; the plugin should own the everos name.",
    zh: "doctor：mcp.json 中 everos 已禁用，插件应已占用 everos 名称。",
  },
  unavailable: {
    en: "EverOS memory is currently unavailable. Do not call memory tools. Continue the user's task without them.",
    zh: "EverOS 记忆暂不可用。不要调用记忆工具，继续完成用户任务。",
  },
  agentGate: {
    en: "agent.gate=>3 tool-call rounds (shorter trajectories produce no case)",
    zh: "agent.gate=超过 3 轮工具调用（更短的轨迹不会生成 case）",
  },
  agentDistill: {
    en: "agent.distill=async; cases/skills appear in seconds to minutes",
    zh: "agent.distill=异步；case/skill 数秒到数分钟后可搜",
  },
  agentForget: {
    en: "agent.forget=session memories and cases deleted; learned skills kept",
    zh: "agent.forget=删除本会话记忆和 case，保留已学到的 skill",
  },
} as const;

export function t(key: Exclude<keyof typeof COPY, "planBlock">): string {
  return COPY[key][locale()];
}

export function planBlockReason(toolName: string): string {
  return COPY.planBlock[locale()](toolName);
}

/**
 * Local OpenClaw SDK types — a REAL module (not an ambient shim), so the types
 * our emitted `dist/*.d.ts` reference live inside the published package.
 *
 * Why: the `openclaw` peer's `plugin-sdk/plugin-entry` subpath does not
 * re-export its event/context types under stable names, so importing types
 * from it in our public signatures would ship `.d.ts` files that reference
 * names consumers can never resolve (with or without the peer installed).
 * Instead, every type the plugin's surface needs is declared here, verified
 * against the real SDK (OpenClaw 2026.8.1 / 2.0).
 * Only the runtime VALUE `definePluginEntry` is imported from the peer (typed
 * by the tiny ambient shim in `openclaw-sdk.d.ts`, which never leaks into dist).
 */

/** Hook ctx for agent-scoped hooks (`PluginHookAgentContext`) — all optional. */
export interface PluginHookAgentContext {
  agentId?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  channelId?: string;
  /**
   * Host-resolved memory partition for the turn (OpenClaw 2026.11+). `owner-private`
   * is the owner's direct chat; `conversation` is any other sender, group, channel,
   * or thread. Absent on older hosts.
   */
  memoryAudience?:
    | { kind: "owner-private"; agentId: string }
    | { kind: "conversation"; agentId: string; sessionKey: string; sessionId: string };
  [key: string]: unknown;
}

/**
 * Hook ctx for `session_end` (`PluginHookSessionContext`) — the real host sends
 * ONLY these fields (no `workspaceDir` etc.). `sessionId` is required in the real
 * SDK; declared optional here so a defensive handler must handle its absence.
 */
export interface PluginHookSessionContext {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
}

/** `before_prompt_build` event. */
export interface BeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
  /**
   * The current request before history projection (OpenClaw 2026.11+). `prompt`
   * may carry reconstructed history on some runtimes; `""` means no textual request.
   */
  currentUserMessage?: string;
}

/** Honored return fields for `before_prompt_build` (exactly these five). */
export interface BeforePromptBuildResult {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
  toolsAllow?: string[];
}

export type PluginHookMediaKind = "image" | "audio" | "video" | "document" | "sticker" | "unknown";

/** OpenClaw 2.0's canonical staged attachment fact. */
export interface PluginHookMediaFact {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: PluginHookMediaKind;
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
}

/** `message_received` event used to collect staged inbound attachments. */
export interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
  media?: PluginHookMediaFact[];
  originalMedia?: PluginHookMediaFact[];
  mediaStagingPending?: boolean;
  [key: string]: unknown;
}

/** Channel/message context; runId/sessionKey correlate with `agent_end`. */
export interface PluginHookMessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  senderId?: string;
  [key: string]: unknown;
}

/** `agent_end` event. Note `durationMs` (not `duration`). */
export interface AgentEndEvent {
  runId?: string;
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

/** `before_reset` event (fires on /new and /reset). Session id comes from ctx. */
export interface BeforeResetEvent {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
}

/** `session_end` event. `reason` is optional. */
export interface SessionEndEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
  reason?: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "shutdown" | "restart" | "unknown";
  sessionFile?: string;
  transcriptArchived?: boolean;
  [key: string]: unknown;
}

export interface OnOptions {
  priority?: number;
  timeoutMs?: number;
}

/** Capability passed to `registerMemoryCapability` — every field optional. */
export interface MemoryPluginCapability {
  promptBuilder?: unknown;
  flushPlanResolver?: unknown;
  runtime?: unknown;
  publicArtifacts?: unknown;
  deterministicRecallToolName?: string;
  supportsPrivateTranscriptRecall?: boolean;
}

export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Service ctx (`OpenClawPluginServiceContext`). `config`/`stateDir`/`logger` are
 *  required by the real SDK; `workspaceDir` and the trace/diagnostics fields are optional. */
export interface PluginServiceContext {
  config: unknown;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
}

export interface PluginService {
  id: string;
  start(ctx: PluginServiceContext): void | Promise<void>;
  stop?(ctx: PluginServiceContext): void | Promise<void>;
}

export interface OpenClawPluginApi {
  readonly id: string;
  readonly name: string;
  logger?: PluginLogger;
  /** Full host config snapshot. Used only to honor the explicit conversation-access grant. */
  config?: unknown;
  /** Manifest-schema config the host resolved from `plugins.entries.<id>.config`. */
  pluginConfig?: Record<string, unknown>;
  on(
    event: "message_received",
    handler: (event: MessageReceivedEvent, ctx: PluginHookMessageContext) => void | Promise<void>,
    opts?: OnOptions,
  ): void;
  on(
    event: "before_prompt_build",
    handler: (
      event: BeforePromptBuildEvent,
      ctx: PluginHookAgentContext,
    ) => BeforePromptBuildResult | void | Promise<BeforePromptBuildResult | void>,
    opts?: OnOptions,
  ): void;
  on(
    event: "agent_end",
    handler: (event: AgentEndEvent, ctx: PluginHookAgentContext) => void | Promise<void>,
    opts?: OnOptions,
  ): void;
  on(
    event: "session_end",
    handler: (event: SessionEndEvent, ctx: PluginHookSessionContext) => void | Promise<void>,
    opts?: OnOptions,
  ): void;
  on(
    event: "before_reset",
    handler: (event: BeforeResetEvent, ctx: PluginHookAgentContext) => void | Promise<void>,
    opts?: OnOptions,
  ): void;
  registerMemoryCapability(capability: MemoryPluginCapability): void;
  registerService(service: PluginService): void;
}

export interface DefinePluginEntryOptions {
  id: string;
  name: string;
  description: string;
  configSchema?: unknown;
  register(api: OpenClawPluginApi): void;
}

export interface DefinedPluginEntry {
  readonly id: string;
}

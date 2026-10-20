import { redact, redactRecord } from "./redact.ts";

export interface DoctorSnapshot {
  banner?: string;
  end?: string;
  enabled: boolean;
  uvx: string;
  uvxOnDisk: boolean;
  keySource: string;
  fileEveros: string;
  fileCommand?: string;
  override: boolean;
  userId: string;
  appId: string;
  projectId: string;
  globalProjectId: string;
  assistantSenderId: string;
  owned: string[];
  toolCounts: Record<string, number>;
  promptEnabled: boolean;
  projectRecord: boolean;
  projectRecall: boolean;
  globalRecord: boolean;
  globalRecall: boolean;
  agentGate: string;
  agentDistill: string;
  agentForget: string;
  notes: string[];
}

export function buildDoctorReport(snap: DoctorSnapshot): string {
  const lines = [
    snap.banner ?? "----- pi-everos doctor -----",
    `enabled=${snap.enabled}`,
    `uvx=${redact(snap.uvx)}${snap.uvxOnDisk ? "" : " (not on disk; PATH fallback)"}`,
    `key=${snap.keySource}`,
    `fileEveros=${snap.fileEveros}`,
    snap.fileCommand ? `fileCommand=${redact(snap.fileCommand)}` : "",
    `override=${snap.override ? "mcp.json wins for name everos" : "none"}`,
    `scope ${JSON.stringify(redactRecord({ user: snap.userId, app: snap.appId, project: snap.projectId, global: snap.globalProjectId }))}`,
    `assistantSenderId=${redact(snap.assistantSenderId)}`,
    `owned=${snap.owned.join(",")}`,
    ...Object.entries(snap.toolCounts).map(([name, count]) => `tools.${name}=${count}`),
    `promptEnabled=${snap.promptEnabled}`,
    ...agentScopeLines("project", snap.projectRecord, snap.projectRecall),
    ...agentScopeLines("global", snap.globalRecord, snap.globalRecall),
    snap.agentGate,
    snap.agentDistill,
    snap.agentForget,
    ...snap.notes.map((note) => redact(note)),
    snap.end ?? "----- end -----",
  ];
  return lines.filter(Boolean).join("\n");
}

function yesNo(flag: boolean): string {
  return flag ? "yes" : "no";
}

function agentScopeLines(scope: "project" | "global", record: boolean, recall: boolean): string[] {
  return [`agent.${scope}.record=${yesNo(record)}`, `agent.${scope}.recall=${yesNo(recall)}`];
}

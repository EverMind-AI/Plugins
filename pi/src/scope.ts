import { basename } from "node:path";

const ID_PATTERN = /^[A-Za-z0-9._@+-]{1,100}$/;

export function autoProjectId(cwd: string): string {
  const raw = basename(cwd).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return cleaned || "default";
}

export function resolveProjectId(projectId: string, cwd: string): string {
  if (!projectId || projectId === "auto") return autoProjectId(cwd);
  return projectId;
}

export function isValidScopeId(value: string): boolean {
  return ID_PATTERN.test(value);
}

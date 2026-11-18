const WRITE_SUFFIXES = ["add_memory", "forget_session", "record_trajectory"];

export function isMutatingMemoryTool(toolName: string): boolean {
  return WRITE_SUFFIXES.some((suffix) => toolName.endsWith(`__${suffix}`));
}

/** Latest plan-mode entry wins; if none, fall back to the CLI `--plan` flag. */
export function isPlanModeActive(
  entries: ReadonlyArray<{ customType?: string; data?: unknown }>,
  planFlag?: boolean,
): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.customType !== "plan-mode") continue;
    return (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
  }
  return planFlag === true;
}

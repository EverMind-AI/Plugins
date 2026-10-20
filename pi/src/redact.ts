const SECRET_KEYS = /EVEROS_API_KEY|api[_-]?key|token|authorization|cookie|secret|password/i;
const SECRET_VALUES = /(?:sk-|evt_|emk_|everos_)[A-Za-z0-9._-]{8,}/gi;

export function redact(text: string): string {
  return text
    .replace(SECRET_VALUES, "[redacted]")
    .replace(/(EVEROS_API_KEY["'\s:=]+)(\S+)/gi, "$1[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function redactRecord(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key] = SECRET_KEYS.test(key) ? (value ? "[set]" : "[empty]") : redact(value);
  }
  return out;
}

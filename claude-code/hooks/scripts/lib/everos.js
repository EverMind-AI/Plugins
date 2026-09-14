/**
 * Minimal client for the EverOS v2 memory API. Native fetch, no dependencies.
 *
 * Success envelope: { request_id, data }
 * Error envelope:   { request_id, error: { code, message, timestamp, path } }
 */

export class EverosError extends Error {
  constructor(status, code, message, path) {
    super(message);
    this.name = "EverosError";
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/** One signal, shared by every request that must finish inside the same budget. */
export function deadline(ms) {
  return AbortSignal.timeout(ms);
}

export function createClient({ baseUrl, fetchImpl = fetch }) {
  async function call(method, path, body, signal) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        signal,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      // TIMEOUT and NETWORK_ERROR mean different things to a caller that only
      // needs the request to arrive: a timeout means the socket was open and
      // EverOS has the body, a network error means it never got there.
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      throw new EverosError(
        0,
        timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        `${method} ${path} failed: ${timedOut ? "deadline exceeded" : String(cause?.message ?? cause)}`,
        path,
      );
    }

    let parsed;
    try {
      parsed = await res.json();
    } catch {
      throw new EverosError(res.status, undefined, `${method} ${path}: non-JSON response (HTTP ${res.status})`, path);
    }

    if (res.ok && parsed && typeof parsed === "object" && "data" in parsed) return parsed.data;
    const err = parsed?.error;
    if (err) throw new EverosError(res.status, err.code, err.message ?? `${path} failed`, err.path ?? path);
    throw new EverosError(res.status, undefined, `${path}: unexpected response (HTTP ${res.status})`, path);
  }

  return {
    async health(signal) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/health`, { method: "GET", signal });
      } catch (cause) {
        throw new EverosError(0, "NETWORK_ERROR", `GET /health failed: ${cause?.message ?? cause}`, "/health");
      }
      // /health is unversioned and returns a bare body, not the {data} envelope.
      let parsed;
      try {
        parsed = await res.json();
      } catch {
        throw new EverosError(res.status, undefined, `/health: non-JSON response (HTTP ${res.status})`, "/health");
      }
      if (!res.ok) throw new EverosError(res.status, parsed?.error?.code, "/health not ok", "/health");
      return parsed;
    },
    search(body, signal) { return call("POST", "/api/v2/memory/search", body, signal); },
    add(body, signal) { return call("POST", "/api/v2/memory/add", body, signal); },
    flush(body, signal) { return call("POST", "/api/v2/memory/flush", body, signal); },
  };
}

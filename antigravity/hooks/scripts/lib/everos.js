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
  const cleanBaseUrl = (baseUrl || "").replace(/\/+$/, "");

  async function call(method, path, body, signal) {
    let res;
    try {
      res = await fetchImpl(`${cleanBaseUrl}${path}`, {
        method,
        signal,
        headers: {
          accept: "application/json",
          "user-agent": "EverOS-Plugin-Antigravity/0.1.0",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      // TIMEOUT indicates client deadline exceeded (server may or may not have received request);
      // NETWORK_ERROR indicates immediate socket connection failure or host refusal.
      const timedOut =
        cause?.name === "TimeoutError" ||
        cause?.name === "AbortError" ||
        signal?.aborted;
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
    } catch (cause) {
      const timedOut =
        cause?.name === "TimeoutError" ||
        cause?.name === "AbortError" ||
        signal?.aborted;
      if (timedOut) {
        throw new EverosError(
          0,
          "TIMEOUT",
          `${method} ${path} failed: response body read timed out`,
          path,
        );
      }
      throw new EverosError(
        res.status,
        undefined,
        `${method} ${path}: non-JSON response (HTTP ${res.status})`,
        path,
      );
    }

    if (res.ok && parsed && typeof parsed === "object" && "data" in parsed) {
      return parsed.data;
    }

    const err = parsed?.error;
    if (err) {
      throw new EverosError(res.status, err.code, err.message ?? `${path} failed`, err.path ?? path);
    }
    throw new EverosError(res.status, undefined, `${path}: unexpected response (HTTP ${res.status})`, path);
  }

  return {
    async health(signal) {
      let res;
      try {
        res = await fetchImpl(`${cleanBaseUrl}/health`, {
          method: "GET",
          signal,
          headers: { accept: "application/json" },
        });
      } catch (cause) {
        const timedOut =
          cause?.name === "TimeoutError" ||
          cause?.name === "AbortError" ||
          signal?.aborted;
        throw new EverosError(
          0,
          timedOut ? "TIMEOUT" : "NETWORK_ERROR",
          `GET /health failed: ${timedOut ? "deadline exceeded" : String(cause?.message ?? cause)}`,
          "/health",
        );
      }

      // /health is unversioned and returns a bare body, not the {data} envelope.
      let parsed;
      try {
        parsed = await res.json();
      } catch (cause) {
        const timedOut =
          cause?.name === "TimeoutError" ||
          cause?.name === "AbortError" ||
          signal?.aborted;
        if (timedOut) {
          throw new EverosError(
            0,
            "TIMEOUT",
            "GET /health failed: response body read timed out",
            "/health",
          );
        }
        throw new EverosError(
          res.status,
          undefined,
          `/health: non-JSON response (HTTP ${res.status})`,
          "/health",
        );
      }
      if (!res.ok) {
        throw new EverosError(res.status, parsed?.error?.code, "/health not ok", "/health");
      }
      return parsed;
    },
    search(body, signal) {
      return call("POST", "/api/v2/memory/search", body, signal);
    },
    add(body, signal) {
      return call("POST", "/api/v2/memory/add", body, signal);
    },
    flush(body, signal) {
      return call("POST", "/api/v2/memory/flush", body, signal);
    },
  };
}

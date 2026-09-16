import { createServer } from "node:http";
import { validateAdd, validateSearch, validateFlush } from "./contract.js";

const EMPTY_SEARCH = {
  episodes: [], profiles: [], agent_cases: [], agent_skills: [], unprocessed_messages: [],
};

/**
 * In-process stand-in for a local EverOS. Records every request so tests can
 * assert on wire payloads, and lets each route's behaviour be swapped at runtime.
 *
 * It honours every input it is handed or fails loudly: an unknown path is a 404
 * with the real error envelope, never a silent 200.
 */
export async function startFakeEveros(options = {}) {
  const requests = [];
  const healthBody = options.health ?? {
    status: "ok",
    version: "1.3.1",
    capabilities: { llm: true, embed: true, rerank: true, multimodal_llm: false, parser: false },
    disabled_features: [],
    cascade: { healthy: true, pending: 0 },
  };
  const searchFn = options.searchFn ?? (() => EMPTY_SEARCH);
  let addStatus = options.addStatus ?? 200;
  let addHandler = null;
  const flushStatus = options.flushStatus ?? 200;
  const flushDelayMs = options.flushDelayMs ?? 0;
  const stall = options.stall ?? false;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const path = req.url.split("?")[0];
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      requests.push({ method: req.method, path, body });

      if (stall) return; // never answer: exercises the client deadline

      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const fail = (status, code) => send(status, {
        request_id: "0".repeat(32),
        error: { code, message: `fake: ${code}`, timestamp: new Date().toISOString(), path },
      });

      // Validate like EverOS does. A double that accepts anything makes every
      // test blind to contract drift - the dimension it ignores is the one the
      // suite cannot see - so an invalid body is a 422 here just as it is there.
      const reject = (errors) => send(422, {
        request_id: "0".repeat(32),
        error: { code: "VALIDATION_ERROR", message: `contract: ${errors.join("; ")}`, timestamp: new Date().toISOString(), path },
      });

      if (path === "/health" && req.method === "GET") return send(200, healthBody);
      if (path === "/api/v2/memory/search") {
        const bad = validateSearch(body);
        if (bad.length) return reject(bad);
        try {
          return send(200, { request_id: "0".repeat(32), data: await searchFn(body) });
        } catch (error) {
          return fail(500, "INTERNAL_ERROR");
        }
      }
      if (path === "/api/v2/memory/add") {
        const bad = validateAdd(body);
        if (bad.length) return reject(bad);
        if (addHandler && addHandler(body) === "fail") return fail(500, "INTERNAL_ERROR");
        if (addStatus !== 200) return fail(addStatus, "INTERNAL_ERROR");
        return send(200, { request_id: "0".repeat(32), data: { message_count: body?.messages?.length ?? 0, status: "accumulated" } });
      }
      if (path === "/api/v2/memory/flush") {
        const bad = validateFlush(body);
        if (bad.length) return reject(bad);
        if (flushStatus !== 200) return fail(flushStatus, "INTERNAL_ERROR");
        if (flushDelayMs) await new Promise((r) => setTimeout(r, flushDelayMs));
        return send(200, { request_id: "0".repeat(32), data: { status: "extracted" } });
      }
      return fail(404, "NOT_FOUND");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    only(path) { return requests.filter((r) => r.path === path); },
    setAddStatus(s) { addStatus = s; },
    setAddHandler(fn) { addHandler = fn; },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}


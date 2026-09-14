/**
 * The shape checks EverOS actually performs, mirrored here so the unit suite
 * fails on contract drift instead of leaving it for the e2e run.
 *
 * Every rule below is copied from a real source location, named in the comment,
 * rather than from memory. A field this file does not check is a dimension the
 * tests cannot see, so anything unrecognised is rejected rather than ignored.
 */

// routes/memorize.py:41 _PATH_SAFE_CHARSET, and :43 _PATH_TRAVERSAL_TOKENS
const PATH_SAFE = /^[a-zA-Z0-9_.@+-]+$/;
const TRAVERSAL = new Set([".", ".."]);

function pathSafeId(value, field, errors) {
  if (typeof value !== "string") return errors.push(`${field}: must be a string`);
  if (value.length < 1 || value.length > 128) return errors.push(`${field}: length must be 1..128`);
  if (TRAVERSAL.has(value)) return errors.push(`${field}: '.' and '..' are reserved (path traversal)`);
  if (!PATH_SAFE.test(value)) return errors.push(`${field}: charset ^[a-zA-Z0-9_.@+-]+$`);
}

function sessionId(value, errors) {
  // routes/memorize.py:116 - length only, NOT the path-safe charset.
  if (typeof value !== "string") return errors.push("session_id: must be a string");
  if (value.length < 1 || value.length > 128) errors.push("session_id: length must be 1..128");
}

/** routes/memorize.py:115-137 MemorizeAddRequest + :89-112 MessageItemDTO */
export function validateAdd(body) {
  const errors = [];
  if (!body || typeof body !== "object") return ["body: must be an object"];
  sessionId(body.session_id, errors);
  if ("app_id" in body) pathSafeId(body.app_id, "app_id", errors);
  if ("project_id" in body) pathSafeId(body.project_id, "project_id", errors);
  if (!Array.isArray(body.messages)) {
    errors.push("messages: required, must be a list");
  } else if (body.messages.length < 1 || body.messages.length > 500) {
    errors.push(`messages: length must be 1..500, got ${body.messages.length}`);
  } else {
    body.messages.forEach((m, i) => {
      const at = `messages[${i}]`;
      if (!m || typeof m !== "object") return errors.push(`${at}: must be an object`);
      pathSafeId(m.sender_id, `${at}.sender_id`, errors);
      if (!["user", "assistant", "tool"].includes(m.role)) {
        errors.push(`${at}.role: must be user|assistant|tool, got ${JSON.stringify(m.role)}`);
      }
      // MessageItemDTO.timestamp: int, gt=0, Unix epoch MILLISECONDS.
      if (!Number.isInteger(m.timestamp) || m.timestamp <= 0) {
        errors.push(`${at}.timestamp: must be a positive integer of epoch ms, got ${JSON.stringify(m.timestamp)}`);
      }
      if (typeof m.content !== "string" && !Array.isArray(m.content)) {
        errors.push(`${at}.content: must be a string or a list`);
      }
      if (m.tool_calls !== undefined && m.tool_calls !== null) {
        if (!Array.isArray(m.tool_calls)) errors.push(`${at}.tool_calls: must be a list`);
        else m.tool_calls.forEach((c, j) => {
          if (!c?.id) errors.push(`${at}.tool_calls[${j}].id: required`);
          if (c?.type !== "function") errors.push(`${at}.tool_calls[${j}].type: must be "function"`);
          if (typeof c?.function?.name !== "string") errors.push(`${at}.tool_calls[${j}].function.name: required`);
          // ToolCallFunctionDTO.arguments is a JSON *string*, OpenAI shape.
          if (typeof c?.function?.arguments !== "string") {
            errors.push(`${at}.tool_calls[${j}].function.arguments: must be a JSON string`);
          }
        });
      }
      if (m.tool_call_id !== undefined && m.tool_call_id !== null && typeof m.tool_call_id !== "string") {
        errors.push(`${at}.tool_call_id: must be a string`);
      }
      // service/_boundary.py:354 raises for role="tool" without a tool_call_id.
      if (m.role === "tool" && !m.tool_call_id) {
        errors.push(`${at}: role="tool" needs a tool_call_id (boundary raises ValueError otherwise)`);
      }
      for (const key of Object.keys(m)) {
        if (!["sender_id", "sender_name", "role", "timestamp", "content", "tool_calls", "tool_call_id"].includes(key)) {
          errors.push(`${at}.${key}: not a MessageItemDTO field`);
        }
      }
    });
  }
  for (const key of Object.keys(body)) {
    if (!["session_id", "app_id", "project_id", "messages", "defer_extraction"].includes(key)) {
      errors.push(`${key}: not a MemorizeAddRequest field`);
    }
  }
  return errors;
}

/** memory/search/dto.py:71-126 SearchRequest, model_config extra="forbid" */
const SEARCH_FIELDS = [
  "user_id", "agent_id", "app_id", "project_id", "query", "method", "top_k",
  "radius", "min_score", "include_profile", "enable_llm_rerank", "filters",
];

export function validateSearch(body) {
  const errors = [];
  if (!body || typeof body !== "object") return ["body: must be an object"];
  // dto.py:116 - exactly one of user_id / agent_id.
  const hasUser = body.user_id !== undefined && body.user_id !== null;
  const hasAgent = body.agent_id !== undefined && body.agent_id !== null;
  if (hasUser === hasAgent) errors.push("exactly one of user_id / agent_id must be provided");
  if (hasUser) pathSafeId(body.user_id, "user_id", errors);
  if (hasAgent) pathSafeId(body.agent_id, "agent_id", errors);
  if ("app_id" in body) pathSafeId(body.app_id, "app_id", errors);
  if ("project_id" in body) pathSafeId(body.project_id, "project_id", errors);
  if (typeof body.query !== "string" || body.query.length < 1) errors.push("query: required, min_length 1");
  // dto.py:123 - -1 or 1..100.
  if ("top_k" in body) {
    const k = body.top_k;
    if (!Number.isInteger(k) || k === 0 || k < -1 || k > 100) errors.push("top_k must be -1 or in 1..100");
  }
  // extra="forbid": an unknown key is a 422, not something to ignore.
  for (const key of Object.keys(body)) {
    if (!SEARCH_FIELDS.includes(key)) errors.push(`${key}: not a SearchRequest field (extra="forbid")`);
  }
  return errors;
}

/** routes/memorize.py MemorizeFlushRequest */
export function validateFlush(body) {
  const errors = [];
  if (!body || typeof body !== "object") return ["body: must be an object"];
  sessionId(body.session_id, errors);
  if ("app_id" in body) pathSafeId(body.app_id, "app_id", errors);
  if ("project_id" in body) pathSafeId(body.project_id, "project_id", errors);
  for (const key of Object.keys(body)) {
    if (!["session_id", "app_id", "project_id"].includes(key)) {
      errors.push(`${key}: not a MemorizeFlushRequest field`);
    }
  }
  return errors;
}

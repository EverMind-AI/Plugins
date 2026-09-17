#!/usr/bin/env bash
# The four hooks against a REAL EverOS, driven the way Codex drives them.
#
# This feeds each hook the stdin Codex actually sends - the shapes were captured
# from a real `codex exec` run against an isolated CODEX_HOME, not copied from
# documentation - and points them at a rollout transcript in Codex's own format.
# It judges by backend receipt: what EverOS logged and the markdown it wrote.
#
# What it does NOT prove: that Codex invokes these hooks. That is the host's
# half, and `scripts/probe-hooks.sh` answers it separately.
#
#   ./scripts/hooks-contract.sh
#
# Needs: node >= 20, python3, curl, and an EverOS checkout whose config has
# working llm/embedding/rerank credentials. Starts its own EverOS on its own
# port under its own root; never touches a server you are already running.
set -uo pipefail

PORT="${CODEX_E2E_PORT:-8893}"
BASE="http://127.0.0.1:$PORT"
EVEROS_BIN="${CODEX_E2E_EVEROS_BIN:-$HOME/EverOS/.venv/bin/everos}"
SOURCE_CONFIG="${CODEX_E2E_SOURCE_CONFIG:-$HOME/.everos/raven/everos.toml}"
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d -t codex-hooks)"
ROOT="$WORK/everos-root"
SERVER_PID=""
WATCHDOG_PID=""
PASS=0; FAIL=0

step() { printf '\n\033[1m=== %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
note() { printf '        %s\n' "$1"; }

# The flag is what disarms the watchdog: killing its processes is not enough,
# because a subshell already past its sleep would still fire.
ALIVE="$WORK/.running"; : > "$ALIVE"
SELF=$$
( sleep "${CODEX_E2E_MAX_SECONDS:-900}"; [ -e "$ALIVE" ] && kill -9 $SELF 2>/dev/null ) >/dev/null 2>&1 </dev/null &
WATCHDOG_PID=$!

teardown() {
  local rc=$?
  command rm -f "$ALIVE" 2>/dev/null
  printf '\n--- tearing down ---\n'
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null && printf '  stopped EverOS (%s)\n' "$SERVER_PID"
  if [ -n "$WATCHDOG_PID" ]; then
    pkill -9 -P "$WATCHDOG_PID" 2>/dev/null || true
    kill -9 "$WATCHDOG_PID" 2>/dev/null || true
  fi
  if [ -n "${CODEX_E2E_KEEP:-}" ]; then
    # Debugging a failure needs the hook debug log and EverOS's own log, and both
    # live in here. The copied credentials do not survive either way.
    command rm -f "$ROOT/everos.toml" "$ROOT/ome.toml"
    printf '  kept %s (credentials removed)\n' "$WORK"
  else
    command rm -rf "$WORK"
    printf '  removed %s\n' "$WORK"
  fi
  if [ -f "$ROOT/everos.toml" ]; then printf '  \033[31mWARNING: %s survived teardown, it holds copied api keys\033[0m\n' "$ROOT"; fi
  exit $rc
}
trap teardown EXIT INT TERM

hits() { local n; n=$(grep -c "POST /api/v2/memory/$1" "$WORK/everos.log" 2>/dev/null || true); printf '%s' "${n:-0}"; }

# Wait for the count to pass a baseline instead of reading it once.
#
# uvicorn writes its access line AFTER the response, so a hook can have its
# answer and return before the line reaches the file. Reading immediately made
# this suite flaky - the same code failed one run and passed the next.
wait_hits() { # kind baseline [seconds]
  local kind="$1" base="$2" limit="${3:-10}" i=0
  while [ "$i" -lt "$((limit * 5))" ]; do
    [ "$(hits "$kind")" -gt "$base" ] && return 0
    i=$((i + 1))
    sleep 0.2
  done
  return 1
}

# One hook, fed the way Codex feeds it.
run_hook() { # script json
  printf '%s' "$2" | EVEROS_CODEX_BASE_URL="$BASE" EVEROS_CODEX_DATA_DIR="$WORK/data" \
    EVEROS_CODEX_DEBUG=1 EVEROS_CODEX_START_CMD="definitely-not-a-real-binary" \
    node "$PLUGIN/hooks/scripts/$1" 2>>"$WORK/hook.err"
}

step "0. Preflight"
for tool in node python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || { printf '  missing: %s\n' "$tool"; exit 1; }
done
[ -x "$EVEROS_BIN" ] || { printf '  no everos binary at %s\n' "$EVEROS_BIN"; exit 1; }
[ -f "$SOURCE_CONFIG" ] || { printf '  no EverOS config at %s\n' "$SOURCE_CONFIG"; exit 1; }
curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null && {
  printf '  port %s already serving - set CODEX_E2E_PORT\n' "$PORT"; exit 1; }
ok "tools present, port $PORT free"

step "1. Start an isolated EverOS"
mkdir -p "$ROOT"
command cp "$SOURCE_CONFIG" "$ROOT/everos.toml"
[ -f "$(dirname "$SOURCE_CONFIG")/ome.toml" ] && command cp "$(dirname "$SOURCE_CONFIG")/ome.toml" "$ROOT/ome.toml"
EVEROS_MEMORIZE__MODE=agent nohup "$EVEROS_BIN" server start --root "$ROOT" --port "$PORT" > "$WORK/everos.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 45); do
  curl -fsS --max-time 2 "$BASE/health" -o "$WORK/health.json" 2>/dev/null && break
  sleep 2
done
curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null \
  || { bad "EverOS did not come up on $PORT"; tail -20 "$WORK/everos.log"; exit 1; }
ok "EverOS $(python3 -c "import json;print(json.load(open('$WORK/health.json'))['version'])") on $PORT, root $ROOT"

step "2. A repository and a rollout in Codex's own format"
REPO="$WORK/repo"
mkdir -p "$REPO"
( cd "$REPO" && git init -q && git remote add origin https://github.com/e2e/codexalpha.git \
  && echo "# alpha" > README.md && git add -A && git -c user.email=e@e -c user.name=e commit -qm init ) >/dev/null 2>&1
SESSION_ID="01a0aa48-0000-0000-0000-00000000cafe"
TURN_ID="01a0aa48-0000-0000-0000-0000000000t1"
TRANSCRIPT="$WORK/rollout-$SESSION_ID.jsonl"
# Shapes taken from 25 real rollouts: response_item/message with input_text or
# output_text blocks, custom_tool_call with a serialized `input` string, and
# custom_tool_call_output whose `output` is a list of {type,text}. The developer
# message is here on purpose - it is what the plugin must NOT store.
CODEX_TURN_ID="$TURN_ID" CODEX_SESSION_ID="$SESSION_ID" CODEX_CWD="$REPO" python3 - "$TRANSCRIPT" <<'PY'
import json, os, sys
turn, sid, cwd = os.environ["CODEX_TURN_ID"], os.environ["CODEX_SESSION_ID"], os.environ["CODEX_CWD"]
meta = {"turn_id": turn}
def item(payload, i):
    return {"timestamp": f"2026-09-16T12:00:{i:02d}.000Z", "ordinal": i, "type": "response_item", "payload": payload}
def msg(role, text, block, i):
    return item({"type": "message", "role": role, "id": f"m{i}",
                 "content": [{"type": block, "text": text}],
                 "internal_chat_message_metadata_passthrough": meta}, i)
lines = [
    {"timestamp": "2026-09-16T12:00:00.000Z", "ordinal": 0, "type": "session_meta",
     "payload": {"id": sid, "session_id": sid, "cwd": cwd, "cli_version": "0.149.0", "source": "exec"}},
    msg("developer", "You are Codex. Environment: " + "x" * 200, "input_text", 1),
    msg("user", "Remember: this repository's canary branch is sparrow-7.", "input_text", 2),
    item({"type": "reasoning", "id": "r1", "encrypted_content": "OPAQUE",
          "summary": [], "internal_chat_message_metadata_passthrough": meta}, 3),
    item({"type": "custom_tool_call", "id": "c1", "call_id": "call_probe_1", "name": "exec",
          "status": "completed", "input": json.dumps({"command": ["git", "branch", "--show-current"]}),
          "internal_chat_message_metadata_passthrough": meta}, 4),
    item({"type": "custom_tool_call_output", "id": "o1", "call_id": "call_probe_1",
          "output": [{"type": "output_text", "text": ""}],
          "internal_chat_message_metadata_passthrough": meta}, 5),
    item({"type": "custom_tool_call_output", "id": "o2", "call_id": "call_probe_1",
          "output": [{"type": "output_text", "text": "main"}],
          "internal_chat_message_metadata_passthrough": meta}, 6),
    msg("assistant", "Noted - the canary branch here is sparrow-7.", "output_text", 7),
]
with open(sys.argv[1], "w") as fh:
    for l in lines:
        fh.write(json.dumps(l) + "\n")
PY
ok "a rollout with a developer message, a reasoning item and a split tool output"

step "3. SessionStart, with EverOS reachable"
OUT=$(run_hook session-start.js "$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","source":"startup"}' "$SESSION_ID" "$TRANSCRIPT" "$REPO")")
printf '%s' "$OUT" | python3 -c "import json,sys; d=sys.stdin.read().strip(); json.loads(d) if d else None" 2>/dev/null \
  && ok "SessionStart returned valid JSON (or nothing) on stdout" \
  || { bad "SessionStart wrote non-JSON to stdout"; note "$(printf '%s' "$OUT" | head -c 120)"; }

# The prompt submitted here is the SAME text the fixture transcript carries as
# the user's message, because that is what Codex does: UserPromptSubmit is handed
# the prompt, and the same words land in the rollout. Capture keys on that to
# tell the user's words from the `<recommended_plugins>` and AGENTS.md blocks
# Codex also posts as role:"user". Change one and you must change the other.
step "4. UserPromptSubmit searches both tracks"
BEFORE=$(hits search)
OUT=$(run_hook recall.js "$(printf '{"session_id":"%s","turn_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","prompt":"Remember: this repository'"'"'s canary branch is sparrow-7."}' "$SESSION_ID" "$TURN_ID" "$TRANSCRIPT" "$REPO")")
wait_hits search "$BEFORE" 10
AFTER=$(hits search)
[ "$AFTER" -gt "$BEFORE" ] && ok "recall reached EverOS ($((AFTER-BEFORE)) searches)" || bad "recall sent nothing"

step "5. Stop captures the turn, and only the conversation"
BEFORE=$(hits add)
run_hook capture.js "$(printf '{"session_id":"%s","turn_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"Stop"}' "$SESSION_ID" "$TURN_ID" "$TRANSCRIPT" "$REPO")" > "$WORK/stop.out"
wait_hits add "$BEFORE" 10
AFTER=$(hits add)
[ "$AFTER" -gt "$BEFORE" ] && ok "the turn was captured ($((AFTER-BEFORE)) add)" || bad "capture sent nothing"
# What went on the wire, judged by the plugin's own mapping of the same file.
MAPPED=$(CODEX_T="$TRANSCRIPT" CODEX_TURN="$TURN_ID" node -e '
import("'"$PLUGIN"'/hooks/scripts/lib/transcript.js").then(async (m) => {
  const fs = await import("node:fs");
  const turn = m.sliceTurn(m.parseTranscript(fs.readFileSync(process.env.CODEX_T, "utf8")), process.env.CODEX_TURN);
  const msgs = m.toEverosMessages(turn, { userId: "u", agentId: "a" });
  console.log(JSON.stringify({
    roles: msgs.map((x) => x.role).join(","),
    tool_rows: msgs.filter((x) => x.role === "tool").length,
    calls: msgs.reduce((n, x) => n + (x.tool_calls?.length ?? 0), 0),
    developer: msgs.some((x) => String(x.content).includes("You are Codex")),
    reasoning: msgs.some((x) => String(x.content).includes("OPAQUE")),
    tool_text: msgs.filter((x) => x.role === "tool").map((x) => x.content).join("|"),
  }));
})')
python3 - "$MAPPED" <<'PY' && ok "the developer message and the reasoning item were left out" || bad "host noise reached EverOS"
import json, sys
d = json.loads(sys.argv[1])
sys.exit(0 if not d["developer"] and not d["reasoning"] else 1)
PY
python3 - "$MAPPED" <<'PY' && ok "one tool row per call, carrying the non-empty output" || bad "the split tool output was not collapsed"
import json, sys
d = json.loads(sys.argv[1])
sys.exit(0 if d["tool_rows"] == 1 and d["calls"] == 1 and d["tool_text"] == "main" else 1)
PY

step "6. SessionEnd seals the session"
# Do NOT count access-log lines here. A seal that carries content starts an
# extraction (~7 s) and the hook's dispatch budget is 1.5 s, so the client is
# gone before the response: uvicorn never writes the line even though EverOS
# received the request and finished the work. Measured - the flush line never
# appears, and the episode markdown does. The seal's symptom is the extraction,
# and step 7 is where it is asserted.
run_hook flush.js "$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"SessionEnd","reason":"other"}' "$SESSION_ID" "$TRANSCRIPT" "$REPO")" >/dev/null
SEAL_SAID=$(grep -o 'SessionEnd:.*' "$WORK/data/debug.log" 2>/dev/null | tail -1)
case "$SEAL_SAID" in
  *"flush failed"*) bad "the seal never left: $SEAL_SAID" ;;
  *flush*)          ok "the seal was dispatched ($SEAL_SAID)" ;;
  *)                bad "the flush hook said nothing at all" ;;
esac

step "7. EverOS wrote it, and a later prompt gets it back"
# Wait for the FILE, not for the queue. `cascade.pending` is 0 the moment the
# seal is dispatched, because the work has not been enqueued yet - polling it
# reads "not started" as "finished" and the check below then runs too early.
MD=""
for _ in $(seq 1 40); do
  MD=$(find "$ROOT/codex" -name 'episode-*.md' 2>/dev/null | head -1)
  [ -n "$MD" ] && break
  sleep 4
done
P=$(curl -fsS --max-time 3 "$BASE/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('cascade',{}).get('pending','?'))" 2>/dev/null || echo "?")
if [ -n "$MD" ]; then
  ok "an episode was written under $(printf '%s' "$MD" | sed "s|$ROOT/||" | cut -d/ -f1-2)"
  # No literal check on the markdown for host noise: extraction is an LLM
  # summary, so the developer text would not appear verbatim even when it WAS
  # ingested - verified by mutation, this check stayed green while the wire-level
  # one above went red. The assertion that holds is on what goes on the wire.
else
  bad "no episode markdown was written"; note "cascade pending: ${P:-?}"
fi
# A second session: same repository, nothing in its own context.
OUT=$(run_hook recall.js "$(printf '{"session_id":"%s","turn_id":"t2","transcript_path":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"Which branch is the canary in this repo?"}' "${SESSION_ID%cafe}beef" "$TRANSCRIPT" "$REPO")")
if printf '%s' "$OUT" | grep -q "sparrow-7"; then
  ok "a later prompt was given the fact back"
  printf '%s' "$OUT" | grep -q "everos_memory" && ok "inside the fenced, untrusted-evidence block" \
    || bad "the injected text is not the fenced memory block"
else
  bad "the later prompt was given nothing"
  note "$(printf '%s' "$OUT" | head -c 160)"
fi

step "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ -s "$WORK/hook.err" ] && note "hook stderr: $(head -c 200 "$WORK/hook.err")"
[ "$FAIL" -gt 0 ] && exit 1
printf '  ALL CHECKS PASSED\n'
exit 0

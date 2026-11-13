#!/usr/bin/env bash
# Acceptance through a REAL DSH agent loop and a REAL EverOS.
#
# scripts/host-matrix.sh and scripts/e2e-everos.sh dispatch the agent hooks
# themselves. This one installs the DSH CLI, adds the packed plugin to an isolated
# headless profile the way a user would (`dsh plugin --profile headless add`), and
# runs two real headless sessions on a real model:
#   1. a session states an unguessable fact;
#   2. a FRESH session asks for it back.
# It passes only if EverOS extracted the fact to markdown, session 2 answers with
# it, and a control session asking the same with recall cut off does not.
#
#   DEEPSEEK_API_KEY=... ./scripts/e2e-dsh-headless.sh
#
# Spends real tokens: two short DSH turns on DeepSeek, and EverOS extraction with
# whatever LLM its config names. Needs: node >= 24.9 (DSH's engine; set
# DSH_E2E_NODE_BIN to a directory holding one), python3, curl, an EverOS checkout,
# and an EverOS config with working llm/embedding/rerank credentials. Everything
# lives under one temp dir (DSH_HOME included) and is removed on exit.
set -uo pipefail

DSH_VERSION="${DSH_E2E_DSH_VERSION:-0.2.2-rc.1}"
NODE_BIN="${DSH_E2E_NODE_BIN:-}"
PORT="${DSH_E2E_PORT:-8894}"
BASE="http://127.0.0.1:$PORT"
EVEROS_BIN="${DSH_E2E_EVEROS_BIN:-$HOME/EverOS/.venv/bin/everos}"
SOURCE_CONFIG="${DSH_E2E_SOURCE_CONFIG:-$HOME/.everos/raven/everos.toml}"
PKG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d -t dsh-headless-e2e)"
ROOT="$WORK/everos-root"
CODE="HERON-$RANDOM-$RANDOM"
SERVER_PID=""
PASS=0; FAIL=0
[ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
step() { printf '\n\033[1m=== %s\033[0m\n' "$1"; }

ALIVE="$WORK/.running"; : > "$ALIVE"
SELF=$$
( sleep "${DSH_E2E_MAX_SECONDS:-1200}"; [ -e "$ALIVE" ] && kill -TERM $SELF 2>/dev/null ) >/dev/null 2>&1 </dev/null &
teardown() {
  local rc=$?
  rm -f "$ALIVE" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null && sleep 2 && kill -9 "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"   # holds the copied EverOS config and its api keys
  [ -d "$WORK" ] && printf '\033[31mWARNING: %s survived teardown, it holds copied api keys\033[0m\n' "$WORK"
  exit $rc
}
trap teardown EXIT INT TERM

dsh() {
  (cd "$WORK/workspace" && DSH_HOME="$WORK/dsh-home" DSH_AGENTS_HOME="$WORK/agents-home" \
    EVEROS_DSH_BASE_URL="${RECALL_URL:-$BASE}" EVEROS_DSH_USER_ID=dsh_headless_e2e \
    node "$WORK/cli/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@")
}

step "0. Preflight"
[ -n "${DEEPSEEK_API_KEY:-}" ] || { bad "DEEPSEEK_API_KEY is not set"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=9)?0:1)' \
  || { bad "node $(node -v) is older than DSH's 24.9 (set DSH_E2E_NODE_BIN)"; exit 1; }
[ -x "$EVEROS_BIN" ] && [ -f "$SOURCE_CONFIG" ] || { bad "no EverOS binary or config"; exit 1; }
curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null && { bad "port $PORT busy"; exit 1; }
mkdir -p "$WORK/cli" "$WORK/workspace" "$WORK/dsh-home" "$WORK/agents-home" "$ROOT"
ok "node $(node -v), port $PORT free, fact code $CODE"

step "1. DSH $DSH_VERSION with the packed plugin in an isolated headless profile"
echo '{"private":true}' > "$WORK/cli/package.json"
(cd "$WORK/cli" && npm install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION") >"$WORK/npm.log" 2>&1 \
  || { bad "installing DSH failed"; tail -5 "$WORK/npm.log"; exit 1; }
TARBALL="$WORK/$(cd "$PKG" && npm pack --silent --pack-destination "$WORK" | tail -1)"
dsh plugin --profile headless add "$TARBALL" >"$WORK/plugin-add.log" 2>&1 \
  || { bad "dsh plugin add failed"; tail -10 "$WORK/plugin-add.log"; exit 1; }
dsh headless --dump-config 2>/dev/null | grep -q "id: everos-memory" \
  && ok "DSH composed the everos-memory row (its version gate admitted the plugin)" \
  || { bad "the plugin is not in the composed profile"; exit 1; }

step "2. An isolated EverOS"
cp "$SOURCE_CONFIG" "$ROOT/everos.toml"
[ -f "$(dirname "$SOURCE_CONFIG")/ome.toml" ] && cp "$(dirname "$SOURCE_CONFIG")/ome.toml" "$ROOT/ome.toml"
EVEROS_MEMORIZE__MODE=agent "$EVEROS_BIN" server start --root "$ROOT" --port "$PORT" >"$WORK/everos.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 45); do curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null && break; sleep 2; done
curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null && ok "EverOS on $PORT" \
  || { bad "EverOS did not come up"; tail -20 "$WORK/everos.log"; exit 1; }

step "3. Session 1 states the fact"
dsh headless "Please remember for future sessions: the staging deploy key rotation codename is $CODE. Acknowledge in one sentence." \
  >"$WORK/s1.out" 2>"$WORK/s1.err" || bad "session 1 exited non-zero"
grep -c 'POST /api/v[12]/memory/add' "$WORK/everos.log" | grep -qv '^0$' \
  && ok "the finished turn reached EverOS /add" || bad "session 1 sent no /add"

step "4. EverOS extracts it to markdown"
MD=""
for _ in $(seq 1 60); do
  MD=$(grep -rl "$CODE" "$ROOT" --include='*.md' 2>/dev/null | head -1)
  [ -n "$MD" ] && break
  sleep 5
done
[ -n "$MD" ] && ok "extracted into ${MD#"$ROOT"/}" || bad "no memory markdown mentions $CODE"

step "5. A fresh session 2 asks, and a control session without recall"
ASK="What is the staging deploy key rotation codename? If you do not know it, reply exactly UNKNOWN."
final() { python3 -c 'import json,sys
for l in open(sys.argv[1]):
    e = json.loads(l) if l.strip().startswith("{") else {}
    if e.get("type") == "final": print(e.get("text", ""))' "$1"; }
dsh headless --json "$ASK" >"$WORK/s2.jsonl" 2>"$WORK/s2.err" || bad "session 2 exited non-zero"
A2=$(final "$WORK/s2.jsonl")
[[ "$A2" == *"$CODE"* ]] && ok "session 2 answered with the fact: ${A2:0:120}" \
  || bad "session 2 did not answer with the fact: ${A2:0:200}"
# The same question with recall cut off (nothing listens there; `false` stops the
# plugin from auto-starting an EverOS) must not know the random code: what session
# 2 knew came through the plugin.
RECALL_URL="http://127.0.0.1:$((PORT + 1))" EVEROS_DSH_START_COMMAND=false \
  dsh headless --json "$ASK" >"$WORK/s3.jsonl" 2>"$WORK/s3.err" || bad "control session exited non-zero"
A3=$(final "$WORK/s3.jsonl")
[[ -n "$A3" && "$A3" != *"$CODE"* ]] && ok "with recall cut off a fresh session does not know it: ${A3:0:80}" \
  || bad "the control session answered '${A3:0:120}': the fact did not depend on recall"

step "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

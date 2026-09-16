#!/usr/bin/env bash
# End-to-end acceptance for the DSH plugin against a REAL EverOS.
#
# `npm test` runs 20 unit tests whose EverOS is a hand-written fakeFetch and
# whose Session is a hand-written object literal. Both define the host's shapes
# for themselves, so neither can tell you the plugin works against the real
# ones. This installs what npm would SHIP into a project that has DSH at its
# real published versions, and drives the three lifecycle points through real
# cordis events, judging by backend receipt: what EverOS logged, and the
# markdown it wrote.
#
#   ./scripts/e2e-everos.sh
#
# Needs: node >= 20, python3, curl, and an EverOS checkout whose config has
# working llm/embedding/rerank credentials. Starts its own EverOS on its own
# port under its own root; never touches a server you are already running.
set -uo pipefail

PORT="${DSH_E2E_PORT:-8892}"
BASE="http://127.0.0.1:$PORT"
EVEROS_BIN="${DSH_E2E_EVEROS_BIN:-$HOME/EverOS/.venv/bin/everos}"
SOURCE_CONFIG="${DSH_E2E_SOURCE_CONFIG:-$HOME/.everos/raven/everos.toml}"
PKG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d -t dsh-e2e)"
ROOT="$WORK/everos-root"
PROJECT="$WORK/project"
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
( sleep "${DSH_E2E_MAX_SECONDS:-900}"; [ -e "$ALIVE" ] && kill -9 $SELF 2>/dev/null ) >/dev/null 2>&1 </dev/null &
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
  command rm -rf "$WORK"
  printf '  removed %s\n' "$WORK"
  # The copied config holds real api keys; say so out loud if it survived.
  if [ -d "$ROOT" ]; then printf '  \033[31mWARNING: %s survived teardown, it holds copied api keys\033[0m\n' "$ROOT"; fi
  exit $rc
}
trap teardown EXIT INT TERM

hits() { grep -c "POST /api/v2/memory/$1" "$WORK/everos.log" 2>/dev/null || true; }

step "0. Preflight"
for tool in node python3 curl npm; do
  command -v "$tool" >/dev/null 2>&1 || { printf '  missing: %s\n' "$tool"; exit 1; }
done
[ -x "$EVEROS_BIN" ] || { printf '  no everos binary at %s\n' "$EVEROS_BIN"; exit 1; }
[ -f "$SOURCE_CONFIG" ] || { printf '  no EverOS config at %s\n' "$SOURCE_CONFIG"; exit 1; }
curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null && {
  printf '  port %s already serving - set DSH_E2E_PORT\n' "$PORT"; exit 1; }
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

step "2. Install the packed plugin next to DSH at its published versions"
mkdir -p "$PROJECT"
printf '{"name":"dsh-e2e","version":"1.0.0","private":true,"type":"module"}\n' > "$PROJECT/package.json"
( cd "$PROJECT" && npm install --silent \
    @deepseek-ai/cordis @deepseek-ai/dsh-agent @deepseek-ai/dsh-llm @deepseek-ai/dsh-session ) >"$WORK/npm.log" 2>&1 \
  || { bad "installing DSH failed"; tail -15 "$WORK/npm.log"; exit 1; }
TARBALL=$( cd "$PKG" && npm pack --pack-destination "$WORK" 2>/dev/null | tail -1 )
[ -f "$WORK/$TARBALL" ] || { bad "npm pack produced nothing"; exit 1; }
if ( cd "$PROJECT" && npm install --silent "$WORK/$TARBALL" ) >>"$WORK/npm.log" 2>&1; then
  ok "the packed artifact installs alongside DSH with no resolution conflict"
else
  bad "installing the plugin conflicted"; grep -iE "ERESOLVE|conflict" "$WORK/npm.log" | head -5; exit 1
fi
UNMET=$( cd "$PROJECT" && node -e "
const need = require('./node_modules/@everos-ai/dsh-plugin/package.json').peerDependencies;
const bad = [];
for (const [k, r] of Object.entries(need)) {
  let v = null; try { v = require('./node_modules/' + k + '/package.json').version } catch {}
  if (!v) bad.push(k + ' missing');
}
console.log(bad.join('; '))" )
[ -z "$UNMET" ] && ok "every peer dependency resolved" || bad "unresolved peers: $UNMET"

step "3. A session states a fact: recall runs, the turn is captured, the seal fires"
command cp "$(dirname "$0")/e2e-everos.mjs" "$PROJECT/e2e-everos.mjs"
( cd "$PROJECT" && DSH_E2E_BASE="$BASE" node e2e-everos.mjs store ) > "$WORK/store.txt" 2>&1
grep -q "^DONE" "$WORK/store.txt" || { bad "the store phase did not finish"; tail -10 "$WORK/store.txt"; }
S=$(hits search); A=$(hits add); F=$(hits flush)
[ "${S:-0}" -ge 1 ] && ok "recall reached EverOS ($S searches)" || bad "recall sent nothing"
[ "${A:-0}" -ge 1 ] && ok "the finished turn was captured ($A add)"  || bad "capture sent nothing"
[ "${F:-0}" -ge 1 ] && ok "disposing the session sealed it ($F flush)" || bad "the seal sent nothing"

step "4. EverOS wrote it to disk"
for _ in $(seq 1 30); do
  P=$(curl -fsS --max-time 3 "$BASE/health" | python3 -c "import json,sys;print(json.load(sys.stdin)['cascade']['pending'])" 2>/dev/null || echo 1)
  [ "$P" = "0" ] && break
  sleep 4
done
MD=$(find "$ROOT/dsh" -name 'episode-*.md' 2>/dev/null | head -1)
if [ -n "$MD" ]; then
  ok "an episode was written under $(printf '%s' "$MD" | sed "s|$ROOT/||" | cut -d/ -f1-2)"
  grep -q "dsh-e2e-store" "$MD" && ok "and it carries the session id the plugin sent" \
    || bad "the episode does not carry the session id"
else
  bad "no episode markdown was written"; note "cascade pending: ${P:-?}"
fi

step "5. A FRESH session gets it back"
( cd "$PROJECT" && DSH_E2E_BASE="$BASE" node e2e-everos.mjs recall ) > "$WORK/recall.txt" 2>&1
if grep -q "^INJECTED=0" "$WORK/recall.txt"; then
  bad "the fresh session was given nothing"
elif grep -qE "^INJECTED=[1-9]" "$WORK/recall.txt"; then
  ok "the plugin injected recalled memory into a session that never saw the fact"
  grep -q "everos_memory" "$WORK/recall.txt" && ok "inside the fenced, untrusted-evidence block" \
    || bad "the injected message is not the fenced memory block"
  grep -qiE "staging|Tuesday|Ops" "$WORK/recall.txt" && ok "and it carries the stored fact" \
    || { bad "the injected block does not mention the stored fact"
         note "$(grep '^INJECTED_TEXT=' "$WORK/recall.txt" | cut -c1-160)"; }
else
  bad "the recall phase did not finish"; tail -10 "$WORK/recall.txt"
fi

step "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1
printf '  ALL CHECKS PASSED\n'
exit 0

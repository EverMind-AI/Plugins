#!/usr/bin/env bash
# End-to-end acceptance for the EverOS Claude Code plugin.
#
# Drives the four hooks exactly as Claude Code would - JSON on stdin, a real
# transcript on disk - against a REAL EverOS, then verifies by backend receipt.
# Not run in CI: extraction needs LLM credentials.
#
#   ./scripts/hooks-contract.sh
#
# Environment:
#   EVEROS_CC_BASE_URL  default http://127.0.0.1:8000
#   EVEROS_ROOT         default ~/.everos   (the server's --root; markdown lands here)
set -uo pipefail

BASE_URL="${EVEROS_CC_BASE_URL:-http://127.0.0.1:8000}"
EVEROS_ROOT="${EVEROS_ROOT:-$HOME/.everos}"
PROJECT_ID="everos-cc-e2e"
USER_ID="everos-cc-e2e-user"
SESSION_ID="e2e-$(date +%s)"
PROMPT_ID="e2e-prompt-1"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
FAILED=0

cleanup() { command rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

step() { printf '\n=== %s\n' "$1"; }
ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; FAILED=1; }

export EVEROS_CC_BASE_URL="$BASE_URL"
export EVEROS_CC_PROJECT_ID="$PROJECT_ID"
export EVEROS_CC_USER_ID="$USER_ID"
export EVEROS_CC_DATA_DIR="$WORK/data"
export EVEROS_CC_DEBUG=1

step "0. EverOS must be up"
if ! curl -fsS --max-time 5 "$BASE_URL/health" > "$WORK/health.json"; then
  echo "EverOS is not reachable at $BASE_URL. Start it first: everos server start" >&2
  exit 1
fi
ok "health: $(head -c 160 "$WORK/health.json")"
ok "memory root under test: $EVEROS_ROOT"

step "1. Build a transcript with two turns in one session"
# Turn A is a linear setup task. Turn B carries a failed tool call and a course
# correction: everalgo's case extractor rejects trajectories with no detour and a
# single user message, so a one-turn transcript can never produce an agent case.
TRANSCRIPT="$WORK/transcript.jsonl"
PROMPT_B="e2e-prompt-2"
python3 "$HERE/scripts/e2e_transcript.py" "$TRANSCRIPT" "$PROMPT_ID" "$PROMPT_B"
ok "transcript written: $(wc -l < "$TRANSCRIPT" | tr -d ' ') entries"

step "2. SessionStart"
if printf '%s' "{\"session_id\":\"$SESSION_ID\",\"cwd\":\"/tmp/e2e\",\"source\":\"startup\"}" \
  | node "$HERE/hooks/scripts/session-start.js"; then ok "exit 0"; else bad "session-start exited non-zero"; fi

capture_turn() {
  printf '%s' "{\"session_id\":\"$SESSION_ID\",\"prompt_id\":\"$1\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"/tmp/e2e\",\"hook_event_name\":\"Stop\"}" \
    | node "$HERE/hooks/scripts/capture.js"
}

step "3. Stop - capture turn A"
if capture_turn "$PROMPT_ID"; then ok "exit 0"; else bad "capture exited non-zero"; fi
if grep -q "add failed" "$WORK/data/debug.log" 2>/dev/null; then
  bad "EverOS rejected /add - this is the wire-contract failure the fake cannot catch:"
  grep "add failed" "$WORK/data/debug.log" | sed 's/^/        /'
else
  ok "/add accepted: $(grep -o 'stored [0-9]* messages' "$WORK/data/debug.log" 2>/dev/null | head -1)"
fi

step "4. Stop again on the same prompt - must not be posted twice"
capture_turn "$PROMPT_ID"
if grep -q "already stored" "$WORK/data/debug.log"; then ok "deduped"; else bad "no dedupe recorded"; fi

step "5. Stop - capture turn B (the one with a detour)"
if capture_turn "$PROMPT_B"; then ok "exit 0"; else bad "capture of turn B exited non-zero"; fi
if grep -q "add failed" "$WORK/data/debug.log"; then
  bad "an /add was rejected:"; grep "add failed" "$WORK/data/debug.log" | sed 's/^/        /'
else
  ok "/add accepted: $(grep -o 'stored [0-9]* messages' "$WORK/data/debug.log" | tail -1)"
fi

step "6. SessionEnd - seal the buffer"
if printf '%s' "{\"session_id\":\"$SESSION_ID\",\"cwd\":\"/tmp/e2e\",\"hook_event_name\":\"SessionEnd\",\"reason\":\"clear\"}" \
  | node "$HERE/hooks/scripts/flush.js"; then ok "exit 0"; else bad "flush exited non-zero"; fi
grep "flush" "$WORK/data/debug.log" | tail -1 | sed 's/^/        /'

step "7. Markdown on disk (the real receipt)"
USER_DIR="$EVEROS_ROOT/claude-code/$PROJECT_ID/users/$USER_ID"
AGENT_DIR="$EVEROS_ROOT/claude-code/$PROJECT_ID/agents/claude-code"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -d "$USER_DIR" ] && break
  sleep 3
done
if [ -d "$USER_DIR" ]; then
  ok "user memory at $USER_DIR"
  find "$USER_DIR" -name '*.md' | sed 's/^/        /'
else
  bad "no user memory written under $USER_DIR"
  find "$EVEROS_ROOT/claude-code" -maxdepth 4 2>/dev/null | head -20 | sed 's/^/        /'
fi
# Agent cases come from a background OME strategy and are additionally subject to
# the extractor's own quality filter, so poll rather than assume.
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  [ -d "$AGENT_DIR" ] && break
  sleep 5
done
if [ -d "$AGENT_DIR" ]; then
  ok "agent memory at $AGENT_DIR"
  find "$AGENT_DIR" -type f | sed 's/^/        /'
else
  bad "no agent case - the full-trajectory capture produced nothing on the agent track."
  echo "        Check the EverOS log for agent_case_skipped_by_algo; if the reason is a"
  echo "        quality filter the capture is fine and this fixture is too thin."
fi

step "8. Recall must find it"
OUT=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  OUT="$(printf '%s' "{\"session_id\":\"$SESSION_ID-recall\",\"prompt_id\":\"p-recall\",\"cwd\":\"/tmp/e2e\",\"prompt\":\"which linter does this project use\"}" \
    | node "$HERE/hooks/scripts/recall.js")"
  case "$OUT" in *ruff*) break;; esac
  sleep 4
done
case "$OUT" in
  *ruff*) ok "recall returned the stored decision" ;;
  "")     bad "recall returned nothing - the index has not converged, or ids do not match between capture and recall" ;;
  *)      bad "recall returned a block without the stored decision: $(printf '%s' "$OUT" | head -c 300)" ;;
esac

step "9. Fail-open with EverOS unreachable"
if printf '%s' "{\"session_id\":\"$SESSION_ID-down\",\"prompt_id\":\"p3\",\"transcript_path\":\"$TRANSCRIPT\",\"cwd\":\"/tmp/e2e\"}" \
  | EVEROS_CC_BASE_URL="http://127.0.0.1:1" node "$HERE/hooks/scripts/capture.js"; then
  ok "capture exits 0 when EverOS is down"
else
  bad "capture failed closed"
fi

step "Result"
if [ "$FAILED" -eq 0 ]; then
  printf 'ALL CHECKS PASSED\n'
  printf 'Clean up the test partition with: rm -rf %s/claude-code/%s\n' "$EVEROS_ROOT" "$PROJECT_ID"
else
  printf 'SOME CHECKS FAILED - do not release\n'
fi
exit "$FAILED"

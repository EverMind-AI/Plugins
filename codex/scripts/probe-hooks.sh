#!/usr/bin/env bash
# Does Codex actually invoke these hooks, and what does it send?
#
# `hooks-contract.sh` proves the plugin's half: given the stdin Codex sends, the
# right requests reach EverOS. This proves the host's half, which no amount of
# unit testing can: it starts a REAL `codex exec` against an isolated CODEX_HOME
# and records, verbatim, what each hook was handed.
#
# It needs a working Codex login (`codex login`). Everything else is isolated:
# its own CODEX_HOME, its own repository, and hooks that only write files.
#
#   ./scripts/probe-hooks.sh
#
# Output: one JSON file per event under the printed directory, and a summary of
# which events fired. An event that never fires is the finding.
set -uo pipefail

HOME_DIR="$(mktemp -d -t codex-probe)"
REPO="$(mktemp -d -t codex-probe-repo)"
PASS=0; FAIL=0
step() { printf '\n\033[1m=== %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
note() { printf '        %s\n' "$1"; }

teardown() {
  local rc=$?
  printf '\n--- tearing down ---\n'
  command rm -rf "$REPO"
  # The captured payloads are the point of the run, so they outlive it; the
  # copied credentials do not.
  command rm -f "$HOME_DIR/auth.json"
  printf '  captured payloads: %s/captured\n' "$HOME_DIR"
  printf '  removed the copied credentials\n'
  exit $rc
}
trap teardown EXIT INT TERM

step "0. Preflight"
command -v codex >/dev/null 2>&1 || { printf '  codex is not on PATH\n'; exit 1; }
[ -f "$HOME/.codex/auth.json" ] || { printf '  no ~/.codex/auth.json - run `codex login` first\n'; exit 1; }
ok "codex $(codex --version 2>&1 | head -1)"

step "1. An isolated CODEX_HOME"
mkdir -p "$HOME_DIR/hooks"
# The credential to run as. CODEX_PROBE_AUTH lets you point at one from
# elsewhere when this machine's login has gone stale.
AUTH_SRC="${CODEX_PROBE_AUTH:-$HOME/.codex/auth.json}"
[ -f "$AUTH_SRC" ] || { printf '  no credential at %s - run `codex login`, or set CODEX_PROBE_AUTH\n' "$AUTH_SRC"; exit 1; }
# Copy it WITHOUT the refresh token. The probe is one short exec and the access
# token outlives it, so refreshing is never needed - and a refresh rotates the
# token server-side, which silently logs out whatever else is using the same
# account. Stripping it makes that unreachable rather than unlikely.
python3 - "$AUTH_SRC" "$HOME_DIR/auth.json" <<'STRIP'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src))
(d.get("tokens") or {}).pop("refresh_token", None)
d.pop("refresh_token", None)
json.dump(d, open(dst, "w"))
os.chmod(dst, 0o600)
STRIP
chmod 600 "$HOME_DIR/auth.json"
cat > "$HOME_DIR/config.toml" <<EOF
model = "${CODEX_PROBE_MODEL:-gpt-5.6-sol}"
approval_policy = "never"
sandbox_mode = "danger-full-access"
EOF
cat > "$HOME_DIR/hooks.json" <<'EOF'
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "$CODEX_HOME/hooks/dump.sh SessionStart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "$CODEX_HOME/hooks/dump.sh UserPromptSubmit" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "$CODEX_HOME/hooks/dump.sh Stop" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "$CODEX_HOME/hooks/dump.sh SessionEnd" }] }],
    "PreCompact":       [{ "hooks": [{ "type": "command", "command": "$CODEX_HOME/hooks/dump.sh PreCompact" }] }]
  }
}
EOF
cat > "$HOME_DIR/hooks/dump.sh" <<'EOF'
#!/bin/sh
# Record exactly what the host hands a hook. UserPromptSubmit also answers with
# an additionalContext marker, so the reply tells us whether injection works.
D="$(dirname "$0")/../captured"
mkdir -p "$D"
cat > "$D/$1.json"
if [ "$1" = "UserPromptSubmit" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"EVEROS_PROBE_MARKER: the canary branch is sparrow-7"}}'
fi
exit 0
EOF
chmod +x "$HOME_DIR/hooks/dump.sh"
( cd "$REPO" && git init -q && git remote add origin https://github.com/e2e/codexprobe.git \
  && echo "# probe" > README.md && git add -A && git -c user.email=e@e -c user.name=e commit -qm init ) >/dev/null 2>&1
ok "CODEX_HOME at $HOME_DIR, repository at $REPO"

step "2. A real turn"
# Two exits, per the machine's rules: the watchdog targets the command's own pid
# and the flag file disarms it, so a run that finishes early is not killed during
# teardown.
( cd "$REPO" && sh -c 'F=$(mktemp); env CODEX_HOME="'"$HOME_DIR"'" codex exec --dangerously-bypass-hook-trust \
    "What is the canary branch? Answer in one short sentence, no tools." > "'"$HOME_DIR"'/run.out" 2>&1 & C=$!
   trap "rm -f $F; kill $C 2>/dev/null" EXIT INT TERM
   (sleep "${CODEX_PROBE_TIMEOUT:-240}"; [ -e "$F" ] && kill -9 $C 2>/dev/null) &
   wait $C' )
if grep -qiE "could not be refreshed|token_expired|401 Unauthorized" "$HOME_DIR/run.out" 2>/dev/null; then
  bad "the login is expired - run \`codex login\`, then this script again"
  note "$(grep -m1 -iE 'could not be refreshed|token_expired' "$HOME_DIR/run.out" | head -c 140)"
fi

step "3. What fired"
for event in SessionStart UserPromptSubmit Stop SessionEnd; do
  if [ -s "$HOME_DIR/captured/$event.json" ]; then
    ok "$event fired, keys: $(python3 -c "
import json,sys
print(' '.join(sorted(json.load(open('$HOME_DIR/captured/$event.json')).keys())))" 2>/dev/null)"
  else
    bad "$event never fired"
  fi
done

step "4. Did the injected context reach the model"
if grep -q "EVEROS_PROBE_MARKER" "$HOME_DIR"/sessions/*/*/*/rollout-*.jsonl 2>/dev/null; then
  ok "additionalContext reached the transcript"
else
  bad "additionalContext did not reach the transcript"
fi

step "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
printf '  payloads kept at %s/captured\n' "$HOME_DIR"
[ "$FAIL" -gt 0 ] && exit 1
printf '  ALL CHECKS PASSED\n'
exit 0

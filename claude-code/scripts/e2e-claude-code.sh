#!/usr/bin/env bash
# End-to-end acceptance driven by REAL Claude Code.
#
# scripts/e2e.sh feeds the hooks synthetic stdin, which proves the wire contract
# but never exercises the host. This one starts actual Claude Code sessions and
# asks whether memory took effect, judging by backend receipt - markdown on disk
# and a real search - rather than by whether a reply sounded like it remembered.
# A session still open can always answer from its own context; that proves
# nothing, which is why every case here crosses a process boundary.
#
#   ./scripts/e2e-claude-code.sh            # all cases
#   ./scripts/e2e-claude-code.sh 1 5        # only those cases
#
# Needs: claude, node >= 20, tmux, python3, curl, and an EverOS checkout whose
# config has working llm/embedding/rerank credentials. It starts its own EverOS
# on its own port under its own root and tears everything down afterwards; it
# never touches a server you are already running.
set -uo pipefail

PORT="${E2E_PORT:-8879}"
BASE="http://127.0.0.1:$PORT"
MODEL="${E2E_MODEL:-claude-haiku-4-5-20251001}"
EVEROS_BIN="${E2E_EVEROS_BIN:-/Users/admin/EverOS/.venv/bin/everos}"
SOURCE_CONFIG="${E2E_SOURCE_CONFIG:-$HOME/.everos/raven/everos.toml}"
PLUGIN_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS="$(cd "$(dirname "$0")/.." && pwd)/hooks/scripts"
WORK="$(mktemp -d -t everos-cc-e2e)"
ROOT="$WORK/everos-root"
SERVER_PID=""
WATCHDOG_PID=""
PASS=0; FAIL=0; FAILED_CASES=""

step() { printf '\n\033[1m=== %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); FAILED_CASES="$FAILED_CASES\n    - $1"; }
note() { printf '        %s\n' "$1"; }

teardown() {
  local rc=$?
  # First, before anything that can be raced: disarm the watchdog. See the flag's
  # definition for why killing its processes is not enough.
  command rm -f "$ALIVE" 2>/dev/null
  printf '\n--- tearing down ---\n'
  tmux kill-session -t everos-e2e 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null && printf '  stopped EverOS (%s)\n' "$SERVER_PID"
  # Both, and the sleep first: once the subshell is gone the sleep is reparented
  # to init and -P no longer matches it, so it would run on until the cap. The
  # subshell falling through to its next statement is harmless now - the flag it
  # checks there is already gone.
  if [ -n "$WATCHDOG_PID" ]; then
    pkill -9 -P "$WATCHDOG_PID" 2>/dev/null || true
    kill -9 "$WATCHDOG_PID" 2>/dev/null || true
  fi
  claude plugin uninstall everos@everos >/dev/null 2>&1 || true
  claude plugin marketplace remove everos >/dev/null 2>&1 || true
  command rm -rf "$WORK"
  printf '  removed %s\n' "$WORK"
  # The credentials copied into the isolated root go with it; say so out loud
  # because a half-torn-down run would leave them on disk.
  if [ -d "$ROOT" ]; then printf '  \033[31mWARNING: %s survived teardown, it holds copied api keys\033[0m\n' "$ROOT"; fi
  return $rc
}
trap teardown EXIT INT TERM

# Hard lifetime cap: this machine has no timeout(1), and a wedged claude session
# must not outlive the run. Checked rather than assumed.
command -v timeout >/dev/null 2>&1 && note "note: timeout(1) exists here after all"
SELF=$$
# The flag, not the process, is what arms this. Killing the sleep the watchdog is
# blocked in does NOT call it off - the subshell simply falls through to its next
# statement, which is the kill -9 of this script. A fully green run then died
# mid-teardown and exited 137, leaving the isolated root - which holds copied api
# keys - on disk. Teardown removes the flag before it touches anything, so the
# order it kills things in stops mattering.
ALIVE="${TMPDIR:-/tmp}/everos-cc-e2e.$$.running"
: > "$ALIVE"
# stdio detached on purpose: a child that keeps the inherited stdout open holds
# a pipeline (./e2e... | tail) alive for the whole cap even after this script
# has exited, which looks exactly like a hung run.
( sleep "${E2E_MAX_SECONDS:-1800}"; [ -e "$ALIVE" ] && kill -9 $SELF 2>/dev/null ) >/dev/null 2>&1 </dev/null &
WATCHDOG_PID=$!

# ── preflight ────────────────────────────────────────────────────────────────
# Run this first after any interrupted attempt: it names every shared resource
# the run touches, so a leftover from a previous attempt shows up here rather
# than as a mysterious failure three cases later.
step "0. Preflight"
for tool in claude node tmux python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || { printf '  missing: %s\n' "$tool"; exit 1; }
done
[ -x "$EVEROS_BIN" ] || { printf '  no everos binary at %s\n' "$EVEROS_BIN"; exit 1; }
[ -f "$SOURCE_CONFIG" ] || { printf '  no EverOS config to copy from at %s\n' "$SOURCE_CONFIG"; exit 1; }
if curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null; then
  printf '  port %s already serving - set E2E_PORT to something free\n' "$PORT"; exit 1
fi
tmux has-session -t everos-e2e 2>/dev/null && { printf '  a previous run left tmux session everos-e2e; kill it first\n'; exit 1; }

# A run killed with SIGKILL never reaches its trap, and what it leaves behind is
# a copy of real api keys in a world-readable temp directory. Sweep those here:
# by the time anyone runs this again, any earlier run is long dead.
STALE=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'everos-cc-e2e*' ! -path "$WORK" 2>/dev/null)
if [ -n "$STALE" ]; then
  printf '%s\n' "$STALE" | while read -r leftover; do
    [ -n "$leftover" ] && command rm -rf "$leftover"
  done
  note "removed leftovers from an interrupted run (they held copied credentials)"
fi
ok "tools present, port $PORT free, no stale tmux session or leftovers"

step "1. Start an isolated EverOS"
mkdir -p "$ROOT"
command cp "$SOURCE_CONFIG" "$ROOT/everos.toml"
# The copied config may point at a provider whose key is spent. Override the
# llm section when asked, so a run is never at the mercy of whatever the source
# config happened to hold.
if [ -n "${E2E_LLM_API_KEY:-}" ]; then
  python3 - "$ROOT/everos.toml" "${E2E_LLM_MODEL:-deepseek-chat}" "$E2E_LLM_API_KEY" "${E2E_LLM_BASE_URL:-https://api.deepseek.com}" <<'PY'
import sys, io, re
path, model, key, base = sys.argv[1:5]
out, cur = [], None
for line in io.open(path).read().splitlines():
    m = re.match(r'^\[([^\]]+)\]', line)
    if m: cur = m.group(1)
    if cur == "llm" and re.match(r'^\s*(model|api_key|base_url)\s*=', line):
        k = re.match(r'^\s*(\w+)', line).group(1)
        out.append({"model": f'model = "{model}"', "api_key": f'api_key = "{key}"',
                    "base_url": f'base_url = "{base}"'}[k]); continue
    out.append(line)
io.open(path, "w").write("\n".join(out) + "\n")
PY
  note "llm overridden to ${E2E_LLM_MODEL:-deepseek-chat}"
fi
[ -f "$(dirname "$SOURCE_CONFIG")/ome.toml" ] && command cp "$(dirname "$SOURCE_CONFIG")/ome.toml" "$ROOT/ome.toml"
EVEROS_MEMORIZE__MODE=agent nohup "$EVEROS_BIN" server start --root "$ROOT" --port "$PORT" > "$WORK/everos.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 45); do
  curl -fsS --max-time 2 "$BASE/health" -o "$WORK/health.json" 2>/dev/null && break
  sleep 2
done
if ! curl -fsS --max-time 2 "$BASE/health" -o /dev/null 2>/dev/null; then
  bad "EverOS did not come up on $PORT"; tail -20 "$WORK/everos.log"; exit 1
fi
ok "EverOS $(python3 -c "import json;print(json.load(open('$WORK/health.json'))['version'])") on $PORT, root $ROOT"

step "1b. Prove the LLM actually works"
# Without this, an exhausted key shows up as three mysterious case failures
# instead of one clear message. One real extraction round-trip is the only
# thing that proves it, so pay for one.
curl -fsS --max-time 30 -X POST "$BASE/api/v2/memory/add" -H 'content-type: application/json' \
  -d '{"session_id":"preflight","app_id":"claude-code","project_id":"preflight","messages":[
       {"sender_id":"pf","role":"user","timestamp":1789050000000,"content":"The preflight marker is quetzal."},
       {"sender_id":"claude-code","role":"assistant","timestamp":1789050001000,"content":"Noted, quetzal."}]}' \
  -o "$WORK/preflight.json" 2>/dev/null
if grep -q '"status"' "$WORK/preflight.json" 2>/dev/null; then
  ok "extraction works ($(python3 -c "import json;print(json.load(open('$WORK/preflight.json'))['data']['status'])" 2>/dev/null))"
else
  bad "EverOS cannot extract - every memory case below would fail for this reason, not for a plugin defect"
  note "response: $(head -c 200 "$WORK/preflight.json" 2>/dev/null)"
  note "cause, from the server log:"
  sed 's/\x1b\[[0-9;]*m//g' "$WORK/everos.log" | grep -iE "LLMError|Key limit|api_key|401|403" | tail -3 | sed 's/^/          /'
  note "fix: point E2E_SOURCE_CONFIG at a config with working credentials, or set"
  note "     E2E_LLM_API_KEY (+ E2E_LLM_MODEL, E2E_LLM_BASE_URL) to override the llm section"
  exit 1
fi

step "2. Install the plugin from this checkout"
claude plugin marketplace add "$PLUGIN_REPO" >/dev/null 2>&1
claude plugin install everos@everos --scope user >/dev/null 2>&1
claude plugin list 2>/dev/null | grep -q "everos@everos" || { bad "plugin did not install"; exit 1; }
ok "installed at $(git -C "$PLUGIN_REPO" rev-parse --short HEAD)"

# ── helpers ──────────────────────────────────────────────────────────────────

# A fixture repository with a real git remote, so project_id is derived the way
# it is for a user rather than falling back to a directory name.
make_repo() { # name remote
  local dir="$WORK/$1"
  mkdir -p "$dir"; ( cd "$dir" && git init -q && git remote add origin "$2" \
    && echo "# $1" > README.md && git add -A && git -c user.email=e@e -c user.name=e commit -qm init ) >/dev/null 2>&1
  printf '%s' "$dir"
}

# One real Claude Code session. Every case crosses this boundary: a fresh
# process, the host triggering the hooks, no shared context with any other case.
ask() { # repo_dir data_dir prompt [extra_env...]
  local repo="$1" data="$2" prompt="$3"; shift 3
  ( cd "$repo" && env EVEROS_CC_BASE_URL="$BASE" EVEROS_CC_DATA_DIR="$data" EVEROS_CC_DEBUG=1 "$@" \
      sh -c 'M=$$; (sleep 180; kill -9 $M 2>/dev/null) & exec claude -p "$1" --model "$2" < /dev/null 2>&1' \
      _ "$prompt" "$MODEL" )
}

# Same, but returns the session id so a later turn can continue the SAME
# session. Two separate `claude -p` calls are two sessions, and EverOS judges a
# trajectory per session - two one-turn sessions can never look like one
# two-turn conversation however similar the prompts are.
ask_resumable() { # repo_dir data_dir prompt -> prints session_id
  local repo="$1" data="$2" prompt="$3"
  ( cd "$repo" && env EVEROS_CC_BASE_URL="$BASE" EVEROS_CC_DATA_DIR="$data" EVEROS_CC_DEBUG=1 \
      sh -c 'M=$$; (sleep 180; kill -9 $M 2>/dev/null) & exec claude -p "$1" --model "$2" --output-format json < /dev/null 2>/dev/null' \
      _ "$prompt" "$MODEL" ) \
    | python3 -c "import json,sys;
try: print(json.load(sys.stdin).get('session_id',''))
except Exception: print('')"
}

ask_resume() { # repo_dir data_dir session_id prompt
  local repo="$1" data="$2" sid="$3" prompt="$4"
  ( cd "$repo" && env EVEROS_CC_BASE_URL="$BASE" EVEROS_CC_DATA_DIR="$data" EVEROS_CC_DEBUG=1 \
      sh -c 'M=$$; (sleep 180; kill -9 $M 2>/dev/null) & exec claude -p --resume "$1" "$2" --model "$3" < /dev/null 2>&1' \
      _ "$sid" "$prompt" "$MODEL" )
}

# Extraction is asynchronous and the index converges behind it. Poll the queue
# rather than sleeping a guessed amount.
settle() {
  for _ in $(seq 1 "${1:-20}"); do
    local pending
    pending=$(curl -fsS --max-time 3 "$BASE/health" 2>/dev/null \
      | python3 -c "import json,sys;print(json.load(sys.stdin).get('cascade',{}).get('pending',1))" 2>/dev/null || echo 1)
    [ "$pending" = "0" ] && { sleep 2; return 0; }
    sleep 3
  done
  return 0
}

md_under() { find "$ROOT/claude-code/$1" -name '*.md' 2>/dev/null; }

# Block until a fact is searchable, or say plainly that it never became so.
#
# The index is eventually consistent by design, so a case that queries once and
# fails is testing the clock, not the plugin. Waiting on the queue alone is not
# enough either - a later session can refill it - so this waits on the fact.
wait_md() { # project_id[/subdir] [attempts] - extraction writes markdown, then indexes it
  local attempts="${2:-15}"
  for _ in $(seq 1 "$attempts"); do
    [ -n "$(md_under "$1")" ] && return 0
    sleep 4
  done
  return 1
}

wait_indexed() { # user_id project_id needle [attempts]
  local attempts="${4:-15}"
  for _ in $(seq 1 "$attempts"); do
    case "$(search_hits "$1" "$2" "$3")" in *"$3"*) return 0;; esac
    sleep 4
  done
  return 1
}

# What the plugin actually put in front of the model, read back from the
# transcript. This is the plugin's own responsibility and is deterministic;
# whether the model then uses it is the model's. Asserting only on the reply
# makes the case flaky for a reason that is not the plugin's fault.
injected_context() { # repo_dir
  python3 - "$(transcript_for "$1")" <<'PY'
import json,sys
p=sys.argv[1] if len(sys.argv)>1 else ""
out=[]
if p:
    for line in open(p):
        try: e=json.loads(line)
        except Exception: continue
        a=e.get("attachment") or {}
        if a.get("type")=="hook_additional_context":
            c=a.get("content")
            out.extend(c if isinstance(c,list) else [str(c)])
print(" ".join(str(x) for x in out))
PY
}

# The newest transcript for a given working directory.
#
# Do NOT derive the project slug from the path: the real one differs from the
# obvious transform in three ways at once (/var becomes /private/var, and both
# "_" and "." become "-"), and a wrong guess finds no file, which reads as
# "zero warnings, zero errors" - a green light for a check that never ran.
# Match on the cwd recorded inside the file instead.
transcript_for() { # repo_dir
  python3 - "$1" <<'PY'
import glob, json, os, sys
want = os.path.realpath(sys.argv[1])
best, best_mtime = "", -1
for path in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
    try:
        with open(path) as fh:
            for _ in range(40):
                line = fh.readline()
                if not line: break
                try: entry = json.loads(line)
                except Exception: continue
                cwd = entry.get("cwd")
                if cwd and os.path.realpath(cwd) == want:
                    m = os.path.getmtime(path)
                    if m > best_mtime: best, best_mtime = path, m
                    break
    except Exception:
        continue
print(best)
PY
}

search_hits() { # user_id project_id query -> prints the matching text
  curl -fsS --max-time 20 -X POST "$BASE/api/v2/memory/search" -H 'content-type: application/json' \
    -d "{\"user_id\":\"$1\",\"app_id\":\"claude-code\",\"project_id\":\"$2\",\"query\":\"$3\"}" 2>/dev/null \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin)['data']
except Exception: print(''); raise SystemExit
print(' '.join((e.get('subject','')+' '+e.get('summary','')+' '+' '.join(f.get('content','') for f in e.get('atomic_facts',[]))) for e in d['episodes']))"
}

wanted() { case " ${CASES:-} " in *" $1 "*) return 0;; "  ") return 0;; *) return 1;; esac; }
CASES="$*"

# ── cases ────────────────────────────────────────────────────────────────────

if wanted 1; then
step "Case 1 — a fact stored in one session is recalled in the next"
# Fails if: the turn is not captured, extraction does not run, the recall hook
# does not fire, or the ids differ between capture and recall.
REPO_A=$(make_repo repo-a "https://github.com/e2e/alpha.git")
D1="$WORK/d1"
ask "$REPO_A" "$D1" "Remember: this repository's canary branch is sparrow-7. Confirm in one sentence, no tools." > "$WORK/c1a.txt" 2>&1
grep -q "sparrow-7" "$WORK/c1a.txt" && note "session 1 replied about sparrow-7" || note "session 1 said: $(tail -1 "$WORK/c1a.txt" | cut -c1-70)"
settle
# Both of these wait on the same event - extraction finishing - so both have to
# poll. A fixed sleep here used to fail the disk check while the search below,
# which polls for a minute, passed on the very same extraction.
if wait_md github.com_e2e_alpha; then
  ok "markdown written under github.com_e2e_alpha"
  md_under github.com_e2e_alpha | sed "s|$ROOT/|        |"
else
  bad "case 1: nothing on disk for github.com_e2e_alpha"
fi
if ! wait_indexed "$(id -un)" github.com_e2e_alpha "sparrow-7"; then
  bad "case 1: the fact never became searchable, so recall cannot be tested"
fi
D1B="$WORK/d1b"
ask "$REPO_A" "$D1B" "What is this repository's canary branch called? One sentence. Do not use tools and do not read files." > "$WORK/c1b.txt" 2>&1
case "$(injected_context "$REPO_A")" in
  *sparrow-7*) ok "the plugin injected the fact into a fresh session's prompt" ;;
  *) bad "case 1: the fact never reached the prompt"
     note "recall hook said: $(grep UserPromptSubmit "$D1B/debug.log" 2>/dev/null | tail -1 | cut -c1-110)"
     note "search directly: $(search_hits "$(id -un)" github.com_e2e_alpha "canary branch" | cut -c1-110)" ;;
esac
if grep -q "sparrow-7" "$WORK/c1b.txt"; then
  ok "and the reply used it, with tools disabled"
else
  bad "case 1: the model did not answer from the injected memory"; note "reply: $(tail -2 "$WORK/c1b.txt" | head -1 | cut -c1-90)"
fi
fi

if wanted 2; then
step "Case 2 — another repository cannot see it"
# Fails if project_id stops carrying host+owner, or the recall scope widens.
REPO_B=$(make_repo repo-b "https://github.com/e2e/beta.git")
ask "$REPO_B" "$WORK/d2" "What is this repository's canary branch called? One sentence. Do not use tools and do not read files." > "$WORK/c2.txt" 2>&1
CTX_B=$(injected_context "$REPO_B")
case "$CTX_B" in
  *sparrow-7*)
    # Distinguish the two ways this can happen. Episodes crossing projects is a
    # partitioning defect. The profile crossing is EverOS keying it by user_id
    # alone, which the README documents - one is a bug, the other is disclosed
    # behaviour, and a check that cannot tell them apart is not worth having.
    if printf '%s' "$CTX_B" | sed -n '/Developer profile:/,/^Relevant/p' | grep -q "sparrow-7"; then
      ok "only the profile carried it across, which is EverOS keying profiles by user (documented)"
      note "$(printf '%s' "$CTX_B" | grep -m1 -A1 'Developer profile:' | tail -1 | cut -c1-100)"
    else
      bad "case 2: alpha's EPISODES reached beta - partitioning is broken"
      note "$(printf '%s' "$CTX_B" | grep -m1 'sparrow-7' | cut -c1-120)"
    fi ;;
  *) ok "nothing from alpha reached beta's prompt" ;;
esac
if grep -q "sparrow-7" "$WORK/c2.txt"; then
  note "the reply mentioned it, consistent with the injected context above"
fi
BLEED=$(search_hits "$(id -un)" github.com_e2e_beta "canary branch")
case "$BLEED" in *sparrow-7*) bad "case 2: beta's own partition contains it";; *) ok "beta's partition is clean";; esac
fi

if wanted 3; then
step "Case 3 — a worktree of the same repository shares the memory"
# Fails if project_id goes back to a directory name: the slot is called
# repo-a-slot, so only the remote can make these two agree.
WT="$WORK/repo-a-slot"
( cd "$REPO_A" && git worktree add -q "$WT" -b slot ) >/dev/null 2>&1 || cp -R "$REPO_A" "$WT"
wait_indexed "$(id -un)" github.com_e2e_alpha "sparrow-7" || note "index not settled; case 3 may report a false partition split"
D3="$WORK/d3"
ask "$WT" "$D3" "What is this repository's canary branch called? One sentence. Do not use tools and do not read files." > "$WORK/c3.txt" 2>&1
case "$(injected_context "$WT")" in
  *sparrow-7*) ok "the worktree's prompt carried what the main checkout stored" ;;
  *) bad "case 3: the worktree got its own partition"
     note "recall hook said: $(grep UserPromptSubmit "$D3/debug.log" 2>/dev/null | tail -1 | cut -c1-110)" ;;
esac
fi

if wanted 4; then
step "Case 4 — a session with real tool work produces an agent case"
# Fails if the trajectory stops carrying tool_calls: everalgo rejects a
# trajectory with no detour, so this needs the model to actually use tools.
REPO_C=$(make_repo repo-c "https://github.com/e2e/gamma.git")
# Enough files that one instruction genuinely needs several tool calls: the
# extractor wants at least three rounds inside ONE memcell, and a two-file
# question never gets there.
printf '[tool.black]\nline-length = 88\n' > "$REPO_C/pyproject.toml"
printf 'black==24.1.0\nruff==0.6.0\n' > "$REPO_C/requirements-dev.txt"
printf 'repos:\n  - repo: https://github.com/psf/black\n    rev: 24.1.0\n' > "$REPO_C/.pre-commit-config.yaml"
mkdir -p "$REPO_C/.github/workflows"
printf 'jobs:\n  lint:\n    steps:\n      - run: black --check .\n' > "$REPO_C/.github/workflows/ci.yml"
printf 'Run black before committing.\n' > "$REPO_C/CONTRIBUTING.md"
# everalgo wants at least three tool-call rounds inside ONE memcell, more than
# one user message, and a detour. Topic-boundary detection splits turns into
# memcells, so the rounds have to come from a single instruction that really
# needs several tools - hence a repository with black referenced in five places
# and an instruction to find and fix every one of them.
D4="$WORK/d4"
SESSION_C=$(ask_resumable "$REPO_C" "$D4" "This project must use ruff and never black, but black is still referenced in several files. Search the whole repository for every mention of black, read each file you find, and list them with the line that mentions it. Use your tools for all of it.")
note "session $SESSION_C"
if [ -z "$SESSION_C" ]; then
  bad "case 4: could not get a session id to resume"
else
  ask_resume "$REPO_C" "$D4" "$SESSION_C" "You missed at least one. Check the CI workflow and the contributing guide too, then remove black from requirements-dev.txt and the pre-commit config, and verify nothing still references it." > "$WORK/c4.txt" 2>&1
fi

# What the plugin is responsible for is the trajectory it sends. Assert that
# separately from what the algorithm decides to do with it, so a quality filter
# firing never reads as the plugin dropping tool calls.
ROUNDS=$(python3 - "$(transcript_for "$REPO_C")" <<'PY'
import json,sys
p=sys.argv[1] if len(sys.argv)>1 else ""
n=0
if p:
    for line in open(p):
        try: e=json.loads(line)
        except Exception: continue
        if e.get("type")=="assistant":
            n += sum(1 for b in (e.get("message",{}).get("content") or []) if b.get("type")=="tool_use")
print(n)
PY
)
if [ "${ROUNDS:-0}" -ge 3 ]; then
  ok "the session made $ROUNDS tool calls and the plugin captured them"
else
  bad "case 4: only $ROUNDS tool calls in the session - the fixture is too thin to test case extraction"
fi
settle 30
# Whether a case comes out is everalgo's judgement, not the plugin's: it wants
# more than one user message in a memcell and a genuine detour, and a live
# session often gives neither. That half is asserted deterministically in
# scripts/e2e.sh, which feeds a two-turn trajectory with a failed tool and a
# correction and requires the case file to appear. Here it is reported with the
# algorithm's own reason, so a quality filter firing never reads as a defect.
if wait_md github.com_e2e_gamma/agents 8; then
  ok "an agent case came out of it too"
  md_under github.com_e2e_gamma/agents | sed "s|$ROOT/|        |"
else
  note "no agent case this run - everalgo declined the trajectory. Its reason:"
  sed 's/\x1b\[[0-9;]*m//g' "$WORK/everos.log" | grep -oE "skipping memcell[^\"]*|no_tool_single_user[^ ]*|TRAJECTORY[A-Z_]*|filtered out by LLM: [^\"]*" | tail -3 | sed 's/^/        /'
fi
fi

if wanted 5; then
step "Case 5 — EverOS down: Claude Code is unaffected, and says so once"
# Fails if any hook exits non-zero, writes non-JSON to stdout, or if the
# warning appears twice (SessionStart and recall share one per-session budget).
D5="$WORK/d5"
ask "$REPO_A" "$D5" "What is 2+2? Answer with just the number, no tools." \
  EVEROS_CC_BASE_URL="http://127.0.0.1:1" EVEROS_CC_START_CMD="definitely-not-a-real-binary" > "$WORK/c5.txt" 2>&1
if grep -qE '(^|[^0-9])4([^0-9]|$)' "$WORK/c5.txt"; then
  ok "Claude Code answered normally with memory unreachable"
else
  bad "case 5: the session did not answer"; note "$(tail -2 "$WORK/c5.txt" | head -1 | cut -c1-90)"
fi
TR5=$(transcript_for "$REPO_A")
if [ -z "$TR5" ]; then
  bad "case 5: could not find the transcript for $REPO_A - the checks below would pass vacuously"
else
  note "transcript: $(basename "$TR5")"
fi
WARNINGS=$(python3 - "$TR5" <<'PY'
import json,sys
p=sys.argv[1] if len(sys.argv)>1 else ""
n=0;errs=0
if p:
    for line in open(p):
        try: e=json.loads(line)
        except Exception: continue
        a=e.get("attachment") or {}
        if a.get("type")=="hook_system_message" and "EverOS" in str(a.get("content","")): n+=1
        if e.get("hookErrors"): errs+=1
print(f"{n} {errs}")
PY
)
W=$(echo "$WARNINGS" | cut -d' ' -f1); E=$(echo "$WARNINGS" | cut -d' ' -f2)
if [ -n "$TR5" ]; then
  [ "${E:-0}" = "0" ] && ok "no hook errors surfaced to the user" || bad "case 5: $E hook errors"
  [ "${W:-0}" = "1" ] && ok "exactly one warning line, as documented" || bad "case 5: $W warning lines (expected 1)"
fi
fi

if wanted 6; then
step "Case 6 — a session the host never let seal is sealed by the next one"
# Fails if the sweep stops running, loses the recorded project id, or if the
# idle threshold check goes away (which would seal live sessions instead).
D6="$WORK/d6"; mkdir -p "$D6/state"
python3 - "$D6" <<'PY'
import json,os,sys,time
p=os.path.join(sys.argv[1],"state","stranded.json")
json.dump({"sessionId":"stranded","projectId":"github.com_e2e_alpha","promptIds":["x"],"warned":False,"flushed":False}, open(p,"w"))
old=time.time()-3600; os.utime(p,(old,old))
PY
ask "$REPO_A" "$D6" "Say ok." > "$WORK/c6.txt" 2>&1
if grep -q "sealed abandoned session stranded" "$D6/debug.log" 2>/dev/null; then
  ok "the next session sealed it"
else
  bad "case 6: the stranded session was not swept"; note "$(tail -3 "$D6/debug.log" 2>/dev/null | tr '\n' ' ')"
fi
SEALED=$(python3 -c "import json;print(json.load(open('$D6/state/stranded.json'))['flushed'])" 2>/dev/null)
[ "$SEALED" = "True" ] && ok "and recorded it as sealed" || bad "case 6: still marked unsealed"
# A session touched moments ago must NOT be swept - that is the guard against
# cutting a live session in half.
python3 - "$D6" <<'PY'
import json,os,sys
p=os.path.join(sys.argv[1],"state","alive.json")
json.dump({"sessionId":"alive","projectId":"github.com_e2e_alpha","promptIds":["y"],"warned":False,"flushed":False}, open(p,"w"))
PY
ask "$REPO_A" "$D6" "Say ok again." > "$WORK/c6b.txt" 2>&1
grep -q "sealed abandoned session alive" "$D6/debug.log" 2>/dev/null \
  && bad "case 6: swept a session that was touched moments ago" \
  || ok "a freshly touched session was left alone"
fi

if wanted 7; then
step "Case 7 — host noise never becomes memory"
# Fails if the promptSource filter goes away: skill bodies and slash-command
# scaffolding are user-role entries the user never typed.
settle
STORED=$(md_under github.com_e2e_alpha | while read -r f; do cat "$f"; done)
LEAKS=""
for needle in "Base directory for this skill" "<command-name>" "local-command-stdout" "system-reminder"; do
  case "$STORED" in *"$needle"*) LEAKS="$LEAKS $needle";; esac
done
[ -z "$LEAKS" ] && ok "no skill bodies, command scaffolding or reminders in the markdown" \
  || bad "case 7: leaked into memory:$LEAKS"
case "$STORED" in
  *'"type":"thinking"'*|*'thinking'*) note "note: the word 'thinking' appears, check it is prose not a block";;
esac
fi

if wanted 8; then
step "Case 8 — an interactive terminal, which is how people actually use it"
# Everything above runs `claude -p`. Interactive is a different code path in the
# host: it asks about folder trust, renders the systemMessage in the UI, and
# tears down differently on /exit. Fails if any hook stops firing there.
D8="$WORK/d8"
wait_indexed "$(id -un)" github.com_e2e_alpha "sparrow-7" \
  || note "index not settled before the interactive case"
tmux new-session -d -s everos-e2e -x 200 -y 50 -c "$REPO_A" \
  -e EVEROS_CC_BASE_URL="$BASE" -e EVEROS_CC_DATA_DIR="$D8" -e EVEROS_CC_DEBUG=1 \
  "claude --model $MODEL" 2>/dev/null

# Readiness is asserted, not guessed. Scraping the pane for a border or a
# footer matches the trust dialog too, and answering that blind picks its
# default - "No, exit" - which kills the session and leaves every later check
# reporting "no hooks" for the wrong reason. The hook's own log is the only
# unambiguous signal that a session is live.
for _ in $(seq 1 45); do
  if tmux capture-pane -t everos-e2e -p 2>/dev/null | grep -q "trust this folder"; then
    tmux send-keys -t everos-e2e Down; sleep 1; tmux send-keys -t everos-e2e Enter
  fi
  grep -q "\[SessionStart\]" "$D8/debug.log" 2>/dev/null && break
  tmux has-session -t everos-e2e 2>/dev/null || break
  sleep 2
done

if ! tmux has-session -t everos-e2e 2>/dev/null; then
  bad "case 8: the interactive session exited before it was usable"
else
  if ! grep -q "\[SessionStart\]" "$D8/debug.log" 2>/dev/null; then
    bad "case 8: the session never reached a live state (no SessionStart in the hook log)"
    tmux capture-pane -t everos-e2e -p 2>/dev/null | grep -v '^\s*$' | tail -4 | sed 's/^/        /'
  fi
  ok "SessionStart fired in an interactive terminal"
  tmux send-keys -t everos-e2e "What is this repository's canary branch called? One sentence, no tools."; sleep 2
  tmux send-keys -t everos-e2e Enter
  # Wait for the turn to be captured, which is what proves the round trip -
  # the pane text alone can show a reply the hooks never saw.
  for _ in $(seq 1 40); do
    grep -q "\[Stop\]" "$D8/debug.log" 2>/dev/null && break
    sleep 3
  done
  for _ in $(seq 1 40); do
    sleep 3
    tmux capture-pane -t everos-e2e -p 2>/dev/null | grep -q "sparrow-7" && break
  done
  # Assert on the transcript, not the pane. capture-pane shows only what is on
  # screen at the instant it runs, and the turn is finished (Stop has fired)
  # before the UI has necessarily settled - a scrape that races is a test that
  # reports a product failure when the product worked.
  TR8=$(transcript_for "$REPO_A")
  REPLY8=$(python3 - "$TR8" <<'PY'
import json,sys
p=sys.argv[1] if len(sys.argv)>1 else ""
out=[]
if p:
    for line in open(p):
        try: e=json.loads(line)
        except Exception: continue
        if e.get("type")=="assistant":
            for b in (e.get("message",{}).get("content") or []):
                if b.get("type")=="text": out.append(b["text"])
print(" ".join(out[-3:]))
PY
)
  case "$REPLY8" in
    *sparrow-7*) ok "interactive session recalled the fact (from the transcript)" ;;
    *) bad "case 8: interactive session did not recall"
       note "last assistant text: $(printf '%s' "$REPLY8" | tail -c 120)" ;;
  esac
  tmux capture-pane -t everos-e2e -p 2>/dev/null | grep -q "sparrow-7" \
    && ok "and it is visible on screen" || note "not on the visible pane at capture time (cosmetic, the transcript is authoritative)"
  tmux capture-pane -t everos-e2e -p 2>/dev/null | grep -q "UserPromptSubmit says" \
    && ok "the recall line is visible in the UI" || note "no visible recall line (only shown when there are hits)"
  # Count what the SERVER saw, so the seal below is checked against EverOS and
  # not against the plugin's own bookkeeping.
  FLUSHES_BEFORE=$(grep -c "POST /api/v2/memory/flush" "$WORK/everos.log" 2>/dev/null || echo 0)
  tmux send-keys -t everos-e2e "/exit"; sleep 2; tmux send-keys -t everos-e2e Enter
  for _ in $(seq 1 25); do tmux has-session -t everos-e2e 2>/dev/null || break; sleep 1; done
  sleep 2
  HOOKS_SEEN=$(grep -oE "\[(SessionStart|UserPromptSubmit|Stop|SessionEnd)\]" "$D8/debug.log" 2>/dev/null | sort -u | tr -d '[]' | tr '\n' ' ')
  case "$HOOKS_SEEN" in
    *SessionStart*Stop*|*Stop*SessionStart*) ok "hooks fired interactively: $HOOKS_SEEN" ;;
    *) bad "case 8: hooks missing interactively, saw: ${HOOKS_SEEN:-none}" ;;
  esac
  # UserPromptSubmit logs only when it skips or fails, so its absence from that
  # list is the success path, not a gap - the injected context above proves it ran.
  case "$HOOKS_SEEN" in
    *UserPromptSubmit*) : ;;
    *) note "UserPromptSubmit is silent when it finds something, which it did" ;;
  esac
  # SessionEnd is expected to be missing from the log: the host kills it within a
  # few hundred milliseconds. What matters is that the state file and the server
  # agree. `flushed: true` is what makes the sweep skip a session, so claiming it
  # without EverOS having received anything means nothing ever seals that
  # session - which is exactly what an earlier optimistic mark did here, while
  # this check passed on the plugin's own bookkeeping.
  FLUSHES_AFTER=$(grep -c "POST /api/v2/memory/flush" "$WORK/everos.log" 2>/dev/null || echo 0)
  SEALED8=$(python3 -c "
import glob,json
for f in glob.glob('$D8/state/*.json'):
    print(json.load(open(f)).get('flushed'))" 2>/dev/null | head -1)
  if [ "$FLUSHES_AFTER" -gt "$FLUSHES_BEFORE" ]; then
    [ "$SEALED8" = "True" ] && ok "/exit got a flush to EverOS, and the session is recorded as sealed" \
      || bad "case 8: EverOS received the flush but the session is not recorded as sealed (flushed=$SEALED8)"
  else
    note "the host killed SessionEnd before the flush left (0 new flushes server-side)"
    [ "$SEALED8" = "True" ] \
      && bad "case 8: sealed=true with no flush at EverOS - the sweep will now skip a session nothing ever sealed" \
      || ok "left unsealed, so the next session's sweep still has it"
  fi
fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
step "Result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '  failing checks:%b\n' "$FAILED_CASES"
  printf '\n  EverOS log: %s (copied out before teardown below)\n' "$WORK/everos.log"
  command cp "$WORK/everos.log" "${TMPDIR:-/tmp}/everos-cc-e2e-failure.log" 2>/dev/null \
    && printf '  saved to %severos-cc-e2e-failure.log\n' "${TMPDIR:-/tmp}"
  exit 1
fi
printf '  ALL CHECKS PASSED\n'
exit 0

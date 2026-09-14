# EverOS Claude Code Plugin

Persistent, cross-session memory for **Claude Code**, backed by a self-hosted
[EverOS](https://github.com/EverMind-AI/EverOS) — with nothing to call and
nothing to remember to do.

The plugin recalls relevant memories **before every prompt** and injects them as
context, saves **every finished turn** — text plus the full tool-call trajectory
— and **seals the session** when it ends or before context compaction. You just
work.

Good to know:

- **Fail-open by design.** If EverOS is down or unreachable, Claude Code behaves
  exactly as it does without the plugin. Memory pauses; nothing breaks.
- **Local only.** Your transcripts go to your own EverOS on loopback and nowhere
  else.
- **Zero runtime dependencies** — native `fetch`, no npm install.
- Memory is **partitioned per repository**, and every worktree of a repository
  shares one partition. The one exception is the developer profile, which EverOS
  keys by user alone; see [How memory is partitioned](#how-memory-is-partitioned).

## Requirements

| | |
|---|---|
| Node | ≥ 20, on `PATH` (the hooks run `node`) |
| EverOS | ≥ 1.3.0, initialised (`everos init`) with the `api_key` fields filled in `~/.everos/everos.toml` |
| Claude Code | a version with plugin support (`claude plugin --help` works) |

## Install

```bash
claude plugin marketplace add EverMind-AI/Plugins
claude plugin install everos@everos --scope user
```

Enabling the plugin asks two questions. Both can be answered with Enter:

- **EverOS base URL** — `http://127.0.0.1:8000` unless you moved it.
- **EverOS checkout directory** — leave empty unless `everos` is not on your
  `PATH` (see [Running from a checkout](#running-from-a-checkout)).

To update later:

```bash
claude plugin marketplace update everos
claude plugin update everos@everos
```

Setting up EverOS from scratch:

```bash
git clone https://github.com/EverMind-AI/EverOS.git
cd EverOS
uv sync
uv run everos init      # writes ~/.everos/everos.toml — REQUIRED before first start
# edit ~/.everos/everos.toml — fill in the api_key fields (llm / embedding / rerank)
uv run everos server start
```

## First run

The plugin checks EverOS at session start and, if it is down and the address is
loopback, starts one for you. You may see one of these lines:

| Line | Meaning |
|---|---|
| *(nothing)* | EverOS was already running. This is the normal case. |
| `⚡ EverOS started — memory is on.` | The plugin started one and it answered. |
| `⏳ EverOS is starting in the background…` | Started, but slower than the 5s wait. Memory resumes on its own. |
| `⚠️ EverOS could not be started (…)` | The start command failed. Run `/everos:status`. |
| `⚠️ EverOS unreachable at …` | Down, and not startable from here. Run `/everos:status`. |

**A server the plugin starts keeps running after Claude Code exits.** A hook is a
two-second process, so there is nobody left to own the server; it is detached on
purpose. Stop it when you want to:

```bash
pkill -f "everos server start"
```

Starting Claude Code in several windows is safe. EverOS holds a single-instance
lock, so the second attempt exits and the first serves everyone.

## Verify it works

Three checks. **Confirm each one against the files on disk** — a session that
merely seems to remember proves nothing while it is still open, because the
context it is answering from is its own.

**1. It remembers you across sessions.**

```text
My favourite coffee is espresso.
```

Wait a few seconds (extraction is asynchronous), then `/clear`, and ask:

```text
What coffee do I like?
```

Receipt: `~/.everos/claude-code/<repo>/users/<you>/episodes/` contains a
markdown file mentioning espresso.

**2. It remembers project decisions.** In a repository, agree on something —
"use ruff, not black in this project" — then start a new session, in that
repository or any worktree of it, and ask for a lint step. The decision should
be in the recalled context.

Receipt: the `🧠 EverOS: …` line appears above the reply, and
`~/.everos/claude-code/<repo>/agents/claude-code/.cases/` fills up once a turn
has enough tool calls to be worth recording.

**3. It fails open.** Stop EverOS (`pkill -f "everos server start"`) and keep
working. Exactly one warning line appears per session, Claude Code answers
normally, and no hook error is shown.

## How memory is partitioned

One EverOS serves every host. Your Claude Code memory is separated from
OpenClaw's and Hermes's by `app_id`, and from your other repositories by
`project_id`.

| EverOS field | Value | How it is chosen |
|---|---|---|
| `app_id` | `claude-code` | Fixed. |
| `project_id` | host, owner and repository | `git config --get remote.origin.url` → the last three segments joined, e.g. `github.com_EverMind-AI_Plugins`; else the git toplevel directory name; else the directory name. Override with `EVEROS_CC_PROJECT_ID`. |
| `user_id` | your OS user | `$USER`, `$USERNAME`, then the OS account. Override with `EVEROS_CC_USER_ID`. |
| `agent_id` | `claude-code` | Fixed. |

The remote comes first so that worktrees of one repository (`repo`, `repo-a`,
`repo-b`) share one memory rather than three, and every clone URL of a
repository — ssh, https, with or without `.git` — resolves to the same id.

Host and owner are part of it because a bare repository name is not a
namespace: two `api` repositories from different owners are ordinary, and
under a bare name they would read each other's decisions.

**One exception, and it is EverOS's, not the plugin's.** The developer profile
is keyed by `user_id` alone: EverOS returns it whatever `app_id` and
`project_id` the search asks for, and the returned row reports the scope it was
*written* under rather than the one requested. Verified against a live 1.3.1.
So episodes, cases and skills are partitioned per repository; the profile is
shared across all of your repositories and across every host that writes to the
same EverOS. That is useful for "prefers terse answers" and awkward for
anything the profile synthesised from one specific project. Set
`EVEROS_CC_USER_ID` to different values per repository if you need them apart.

On disk:

```
~/.everos/claude-code/<project_id>/users/<user_id>/     episodes, atomic facts, profile
~/.everos/claude-code/<project_id>/agents/claude-code/  cases, skills
```

**Want one memory across all your projects?** Set `EVEROS_CC_PROJECT_ID` to a
fixed value. Everything then lands in one partition.

## Configuration

Precedence: **environment variable** > **plugin option** (what the install
prompt asked, stored in `~/.claude/settings.json`) > **default**. A blank or
whitespace-only value counts as unset and never shadows a lower layer.

| Variable | Plugin option | Default | What it does |
|---|---|---|---|
| `EVEROS_CC_BASE_URL` | `base_url` | `http://127.0.0.1:8000` | EverOS address. A missing scheme is filled in; an unparseable value falls back to the default. |
| `EVEROS_CC_EVEROS_DIR` | `everos_dir` | unset | Working directory for the start command. |
| `EVEROS_CC_START_CMD` | — | `everos server start` | Quote-aware; e.g. `uv run everos server start`. |
| `EVEROS_CC_USER_ID` | — | your OS user | Identity for personal memory. |
| `EVEROS_CC_PROJECT_ID` | — | derived | Force one partition. |
| `EVEROS_CC_RECALL_TIMEOUT_MS` | — | `5000` | Budget for the two recall searches. Clamped to 500–7000; resolving the project id spends up to 2 s of the hook's 10 s before this starts. |
| `EVEROS_CC_VERBOSE` | — | off | Also print "no relevant memory" and "saved N messages". |
| `EVEROS_CC_DEBUG` | — | off | Write hook diagnostics to `debug.log` in the data directory. |
| `EVEROS_CC_DATA_DIR` | — | `$CLAUDE_PLUGIN_DATA`, else `~/.everos/.claude-code` | Where per-session state, `debug.log` and `everos-server.log` live. |

A warm search takes 0.3–0.8 s, so the recall budget is almost never spent; it
exists for the tail. Raise it if `/everos:status` shows a slow server, lower it
if you would rather never wait.

### Running from a checkout

When `everos` is not on your `PATH` — the usual case with a `uv` project —
point the plugin at your checkout:

```bash
export EVEROS_CC_EVEROS_DIR="$HOME/EverOS"
export EVEROS_CC_START_CMD="uv run everos server start"
```

Claude Code launched from a GUI inherits no shell environment. Put values that
must always apply in `~/.claude/settings.json` under `env`, or answer the plugin
option prompt for `base_url` and `everos_dir`.

## Commands

| Command | What it does |
|---|---|
| `/everos:status` | Server health, the identity used for capture and recall, effective configuration with the layer each value came from, and the last few errors. Start here whenever memory seems missing. |
| `/everos:search <query>` | Runs the same two-track search the recall hook runs, with the same ids, and prints the block verbatim — so what you see is exactly what a prompt would have been given. |

## What is captured, and what is not

**Captured**, once per finished turn:

- your prompt, with any memory block the plugin itself injected stripped out
- the assistant's text
- every tool call, as OpenAI-shaped `tool_calls` (name and arguments)
- every tool result, paired to its call

The full trajectory is sent on purpose: EverOS's case extractor needs the tool
rounds to recognise a reusable approach, and it does its own trimming. A single
tool result longer than 20 000 characters is head-and-tail truncated first, as a
payload-size guard.

**Not captured**: thinking blocks; subagent (Task tool) traffic; skill bodies,
slash-command scaffolding and other host-injected text that is not something you
typed; images and other attachments.

## Troubleshooting

**Start with `/everos:status`.** It names the first missing setup step.

| Symptom | Cause and fix |
|---|---|
| Nothing is ever recalled | Extraction is asynchronous — a conversation from seconds ago is not indexed yet. Then check `project_id` in `/everos:status`: memory from a different repository is not visible here. |
| No `🧠 EverOS` line, no warning either | The prompt was skipped: memory is not searched for slash commands or prompts under three words. |
| Cases never appear under `agents/` | EverOS rejects trajectories with no detour and a single user message. Cases come from real multi-turn work, not from one-shot questions. |
| Hooks appear to do nothing at all | `node` is not on the `PATH` Claude Code was launched with. Check with `/everos:status`; if that also fails to run, that is the cause. |
| `SessionEnd hook … Hook cancelled` | Expected, and harmless. The host stops waiting for the hook a few hundred milliseconds into shutdown, in an interactive terminal as much as under `claude -p`. The request has already left and EverOS finishes the work without a client attached; a later session re-seals only if it never arrived. |
| Recall times out | Raise `EVEROS_CC_RECALL_TIMEOUT_MS`. Also check `/everos:status` for a large index queue. |

Logs live in the data directory (`/everos:status` prints the path):
`debug.log` (set `EVEROS_CC_DEBUG=1` first) and `everos-server.log` for a server
the plugin started.

## Privacy

Everything stays on your machine. The plugin talks to `base_url` and to nothing
else, and it sends what you would expect: your prompts, the assistant's replies,
and tool calls with their results.

**Tool results are part of that.** If a command prints a secret, that secret
reaches EverOS. EverOS has no authentication of its own, so keep `base_url` on
loopback unless you have secured it yourself. The plugin never starts a server
for a non-loopback address, and if `base_url` points at another machine it says
so once per session, naming the host.

## Development

```bash
cd claude-code
npm test                          # node:test, no dependencies
claude plugin validate . --strict
./scripts/e2e.sh                  # the four hooks against a REAL EverOS
./scripts/e2e-claude-code.sh      # REAL Claude Code sessions against a REAL EverOS
```

Two end-to-end scripts, because they answer different questions.

`scripts/e2e.sh` feeds the hooks synthetic stdin. It proves the wire contract
and the parts an algorithm decides deterministically - including that a
trajectory with a detour produces an agent case - but it never starts Claude
Code, so it cannot tell you the host still calls the hooks.

`scripts/e2e-claude-code.sh` starts real Claude Code sessions, headless and in
a real terminal under tmux, and asks whether memory took effect. It judges by
backend receipt: the markdown on disk, a real search, and the context the
plugin actually put in front of the model, read back from the transcript. A
session that is still open can always answer from its own context, so every
case here crosses a process boundary. Eight cases: cross-session recall, that
another repository cannot see it, that a worktree can, the trajectory a
tool-using session sends, fail-open, the sweep, that host noise never becomes
memory, and an interactive terminal.

Both need LLM credentials, so neither runs in CI. Each starts its own EverOS on
its own port under its own root and never touches a server you are running.

```bash
# point them somewhere, or override just the llm section
E2E_PORT=8899 E2E_LLM_API_KEY=sk-... ./scripts/e2e-claude-code.sh
./scripts/e2e-claude-code.sh 1 5          # only cases 1 and 5
```

Design and rationale: [`docs/DESIGN_DOC.md`](docs/DESIGN_DOC.md).

## License

[Apache-2.0](../LICENSE)

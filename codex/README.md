# EverOS Codex Plugin

Persistent, cross-session memory for **Codex**, backed by a self-hosted
[EverOS](https://github.com/EverMind-AI/EverOS) — and shared with every other
agent pointed at the same server.

The plugin recalls relevant memories **before every prompt** and injects them as
context, saves **every finished turn** — text plus the full tool-call trajectory
— and **seals the session** when it ends or before a compaction.

Good to know:

- **Fail-open by design.** If EverOS is down or unreachable, Codex behaves
  exactly as it does without the plugin. Memory pauses; nothing breaks.
- **Local only.** Your transcripts go to your own EverOS on loopback and nowhere
  else.
- **Zero runtime dependencies** — native `fetch`, no npm install.
- Memory is **partitioned per repository**, and every worktree of a repository
  shares one partition.
- **Codex already has its own memory.** See [Two memory systems](#two-memory-systems)
  before installing — this is a decision, not a detail.

## Requirements

| | |
|---|---|
| Node | ≥ 20, on `PATH` (the hooks run `node`) |
| EverOS | ≥ 1.3.0, initialised (`everos init`) with the `api_key` fields filled |
| Codex | a version whose `codex plugin --help` works (verified against 0.149.0) |

## Install

```bash
codex plugin marketplace add <this repository>
codex plugin add everos@everos
```

Then point it at your EverOS if it is not on the default address:

```bash
export EVEROS_CODEX_BASE_URL=http://127.0.0.1:8000
```

Verified end to end against Codex 0.149.0: the marketplace resolves, the plugin
installs as `installed, enabled`, and its hooks fire on a real session.

## Two memory systems

Codex ships its own memory: `~/.codex/memories` holds `MEMORY.md`,
`raw_memories.md` and a per-session summary for every thread, behind a two-stage
extraction pipeline. It injects roughly 27,500 characters as a developer message
at session start.

Installing this plugin as-is therefore puts **two** memory systems in the same
context window. Pick deliberately:

| | `hooks.json` | What you get |
|---|---|---|
| Capture only | remove the `UserPromptSubmit` entry | Codex conversations feed EverOS and are recalled by your other agents; Codex keeps using its own memory for itself. No contention. |
| Full lifecycle | ship as-is | EverOS recall as well: relevant to the prompt rather than a fixed block, partitioned per repository, shared across hosts. Turn Codex's off with `[features] memories = false` if the context budget matters. |

## Configuration

Everything is environment variables; Codex has no `userConfig` equivalent.

| Variable | Default |
|---|---|
| `EVEROS_CODEX_BASE_URL` | `http://127.0.0.1:8000` |
| `EVEROS_CODEX_USER_ID` | derived from the OS user |
| `EVEROS_CODEX_PROJECT_ID` | derived from the git remote |
| `EVEROS_CODEX_DATA_DIR` | `~/.everos/.codex` |
| `EVEROS_CODEX_RECALL_TIMEOUT_MS` | `5000` (max 7000) |
| `EVEROS_CODEX_VERBOSE` | off — set it to see what was saved |
| `EVEROS_CODEX_DEBUG` | off — writes `debug.log` under the data dir |

## What gets stored

One turn of the conversation: what you typed, what Codex replied, and the tool
calls in between with their results.

Not stored: Codex's own scaffolding. `<recommended_plugins>`,
`<environment_context>`, your AGENTS.md and the IDE's active-file block all
arrive under `role: "user"` with the turn's own id — across 151 real sessions
that was 303 of 495 user-role items and 66% of the text. The `UserPromptSubmit`
hook is handed the prompt you actually typed, and capture keys on that, so this
is a lookup rather than a guess about which blocks are yours.

Also not stored: the model's encrypted reasoning, the UI's echo of messages
already recorded, and the memory block this plugin itself injected.

## Porting notes

Two differences from the Claude Code plugin will silently disable every hook if
you assume the obvious thing. Both were found by checking, not by reading docs:

- **There is no `CODEX_PLUGIN_ROOT`.** Codex sets `CLAUDE_PLUGIN_ROOT` and
  `CLAUDE_PLUGIN_DATA`. A command written against a `CODEX_`-prefixed name
  expands to an empty string and the hook never finds its script.
- **The hook timeout field is `timeout`, in seconds**, not `timeout_sec` - which
  the Codex binary does carry, for MCP servers. Declared as `timeout_sec` it is
  ignored and a hanging hook holds the session; measured, a hook sleeping 30 s
  cost 40 s with `timeout_sec: 1` and 10 s with `timeout: 1`.
- **A plugin's `hooks.json` belongs under `hooks/`.** At the plugin root it is
  never read - the plugin installs, reports `installed, enabled`, and fires
  nothing, with no error anywhere. The shipped figma and replayio plugins keep
  theirs at the root, which is misleading: installed that way here, not one
  hook ran. No feature flag is involved; the location is the whole of it.

## Verification

```bash
./scripts/hooks-contract.sh   # the four hooks against a REAL EverOS
./scripts/probe-hooks.sh      # a REAL codex exec, recording what each hook gets
```

They answer different halves. `hooks-contract.sh` feeds each hook the stdin
Codex actually sends — the shapes were captured from a real run, not copied from
documentation — and judges by backend receipt: the requests EverOS logged and
the markdown it wrote, ending with a session that never saw a fact getting it
back. `probe-hooks.sh` proves the other half, which no test can: that Codex
invokes these hooks at all, and what it hands them. It needs a working
`codex login`.

Design and the measurements behind it: [`docs/DESIGN_DOC.md`](docs/DESIGN_DOC.md).

## License

Apache-2.0

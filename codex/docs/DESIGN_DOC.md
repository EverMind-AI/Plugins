# EverOS Codex plugin — design

A sibling of `claude-code/`, against the same local EverOS and the same
recall → capture → seal lifecycle. This records what is Codex-specific, and
what was measured rather than assumed.

## 1. The host contract, as measured

Every field below was captured from a real `codex exec` run against an isolated
`CODEX_HOME` (`scripts/probe-hooks.sh` reproduces it), not read from docs.

| Event | Payload |
|---|---|
| `SessionStart` | `session_id` `transcript_path` `cwd` `hook_event_name` `model` `permission_mode` `source` |
| `UserPromptSubmit` | the above, plus `turn_id` and `prompt`; no `source` |
| `Stop` | the above, plus `turn_id`, `stop_hook_active` and `last_assistant_message` — the reply's text, handed over without reading the transcript |
| `SessionEnd` | `session_id` `transcript_path` `cwd` `hook_event_name` `reason` |

`SessionStart.source` takes the same four values as Claude Code: `startup`,
`resume`, `clear`, `compact`. Hook output is the same wire too —
`hookSpecificOutput.additionalContext`, `systemMessage`, `continue`,
`stopReason`, `suppressOutput`.

**Two things that differ from Claude Code and break a naive port.** Both were
found by checking, and either one silently disables the whole plugin:

1. **There is no `CODEX_PLUGIN_ROOT`.** Codex sets `CLAUDE_PLUGIN_ROOT` and
   `CLAUDE_PLUGIN_DATA` and nothing with a `CODEX_` prefix. A hook command
   written against the obvious name expands to an empty string and every hook
   silently fails to find its script.
2. **A plugin's `hooks.json` must sit under `hooks/`.** At the plugin root it is
   never read: the plugin installs, `codex plugin list` reports
   `installed, enabled`, and not one hook fires. Nothing reports the mismatch.

   Location is the whole of it - measured by varying one thing at a time:

   | `hooks.json` at | `[features] plugin_hooks` | hooks fire |
   |---|---|---|
   | plugin root | unset | no |
   | plugin root | `true` | no |
   | `hooks/` | `true` | yes |
   | `hooks/` | unset | **yes** |

   The two shipped plugins that use hooks (figma, replayio) keep theirs at the
   plugin root, which is what this document claimed until it was installed and
   run. Whatever path loads those two, it is not the one a marketplace install
   uses.

## 2. Turns are addressable

Codex stamps `internal_chat_message_metadata_passthrough.turn_id` on every
transcript item, and hands the same `turn_id` to `UserPromptSubmit` and `Stop`.
Slicing a turn is therefore a filter.

The Claude Code plugin has to find a turn's first entry and guess where it ends,
which produced two defects there: a prompt queued mid-turn landed in the wrong
turn, and the closing assistant entry arrived after the slice was taken. Neither
is representable here.

Verified on 22 real multi-turn sessions: a session with 8 user messages has 7
distinct `turn_id`s, and the set on `turn_context` equals the set on the items.

## 3. `role: "user"` is not "the user wrote this"

Codex posts its own scaffolding under the user's role and the turn's own id:
`<recommended_plugins>`, `<environment_context>`, `<codex_internal_context>`,
the project's AGENTS.md, and the IDE's active-file block. Measured across 151
real sessions: **303 of 495 user-role items were host-authored, and 66% of the
text by volume**. Filtering on the role alone stores two thirds of a memory
library as the host talking to itself, attributed to the user.

Neither position nor shape settles it. "The last user item of a turn is the
prompt" holds 283 times and fails 38 — including one real Chinese prompt that
was not last. Enumerating tags misses the next one Codex adds.

**So don't infer it.** `UserPromptSubmit` is handed `prompt`: the text the user
typed. `recall.js` records it against the turn id, and `capture.js` keys on it —
a lookup, not a judgement. The shape list survives only as the fallback for a
turn whose prompt was never recorded (a session older than the plugin, or one
where the hook did not run), and it is written to fail toward keeping: a stored
line of scaffolding is noise, a dropped line of the user's own words is a loss.

Our own injected memory needs no such handling: `additionalContext` lands as a
`developer` item, so it is already excluded and cannot compound.

## 4. The transcript, and what is dropped

`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl`, one line per
`{timestamp, ordinal, type, payload}`.

| `payload.type` | Mapped to |
|---|---|
| `message` role `user` | `role: "user"` |
| `message` role `assistant` | `role: "assistant"` |
| `message` role `developer` | **dropped** |
| `custom_tool_call` | assistant `tool_calls[]`, `input` is already a serialized string |
| `custom_tool_call_output` | `role: "tool"`, `tool_call_id = call_id` |
| `reasoning` | **dropped** — the payload is `encrypted_content` |
| `event_msg` (any) | **dropped** — the UI echo of a `response_item` |

**Why `developer` must go.** Codex puts its own instructions, the environment
block and its built-in memories there. Across 25 real sessions they outnumbered
user messages 174 to 74: stored, 70% of what the library holds as "what the user
said" would be the host talking to itself. Claude Code has the same problem at
25% and no explicit role to key off — here the role is the filter.

**One call can have several outputs.** A long-running `exec` posted 16
`custom_tool_call_output` items for one `call_id`, every one of them empty.
They are collapsed onto one row per call, non-empty text joined. Before the fix,
tool rows outnumbered tool calls 2772 to 2757 across the sample; after, both are
2757.

## 5. Codex has its own memory, and it is not off

`~/.codex/memories` is a git repository holding `MEMORY.md` (61 KB),
`memory_summary.md`, `raw_memories.md` (368 KB) and 133 per-session summaries,
behind a two-stage extraction pipeline in `memories_1.sqlite` with its own job
queue. It injects a developer message of ~27,500 characters at session start.

So a straight port ships a **second** memory system into the same context
window. The three ways out, in the order they cost:

- **B — capture and seal only.** Codex conversations feed EverOS and are
  recalled by every other agent pointed at it; Codex keeps using its own
  memories for itself. Zero contention.
- **C — the full lifecycle, with the overlap made explicit.** Install warns when
  `[features] memories = true` and says how to turn it off. What EverOS adds
  over the native feature is real: memory shared across hosts, recall that is
  relevant to the prompt rather than a fixed block, and partitioning per
  repository.
- **A — the full lifecycle, silently.** Two injectors, no warning. Not
  recommended.

B is a strict subset of C, so the capture half is worth building either way.
`hooks.json` is where the choice is made: drop the `UserPromptSubmit` entry for
B, keep it for C.

## 6. Verification

- `scripts/hooks-contract.sh` — the four hooks against a real EverOS, fed the
  payloads above, judged by backend receipt. It runs the hook scripts directly,
  so it proves they do the right thing with what Codex sends; it cannot prove
  Codex calls them. That is the install check above, and it is a gap worth
  naming: this suite was green for a day while the shipped `hooks.json` sat
  where nothing read it.
- **Installed the way a user would**, in an isolated `CODEX_HOME`:
  `codex plugin marketplace add <repo>` then `codex plugin add everos@everos`
  resolves and reports `installed, enabled`, and a real session fires the hooks
  from that installed copy. This is the check that caught the `hooks/` location
  - the suites below both bypass it, one by executing the scripts directly and
  the other by injecting hooks with `-c`.

- `scripts/probe-hooks.sh` — a real `codex exec`, recording what each hook was
  actually handed. Needs a working `codex login`; `CODEX_PROBE_AUTH` points it
  at a credential from elsewhere. It copies that credential **without the
  refresh token**: the probe is one short exec and the access token outlives it,
  while a refresh rotates server-side and would log out whatever else uses the
  same account.

All four hooks were driven against a real Codex on 2026-09-17, which is where
the `Stop` payload and the `role: "user"` scaffolding above were measured.

**Two measurements that looked like defects.** Both were the check being wrong,
not the code, and both came from reading uvicorn's access log:

- A seal that carries content starts an extraction of about 7 s against a 1.5 s
  dispatch budget, so the client is gone before the response and the line is
  never written. The episode markdown was on disk the whole time, and a control
  session that was added but never flushed produced nothing in 60 s.
- Reading the line the instant a hook returns made the suite flaky - the same
  code failed one run and passed the next. The assertions now poll for the count
  to move rather than sampling it once.

**A measurement that looked like a defect.** The seal's dispatch budget is
1.5 s; a seal that carries content starts an extraction that takes about 7 s, so
the client is gone before the response and uvicorn never writes the access-log
line. Counting those lines said the flush never arrived. It had: the episode
markdown was on disk, and a control session that was added but never flushed
produced nothing in 60 s. The seal's symptom is the extraction, not the log.

# Hermes Memory — EverOS

A native [Hermes Agent](https://github.com/NousResearch/hermes-agent) memory
provider backed by a local [EverOS](https://github.com/EverMind-AI/EverOS)
server: markdown files as the source of truth, hybrid (vector + BM25 + scalar)
recall, and two memory tracks — your profile/episodes and the agent's distilled
cases/skills.

By default, recall and capture run automatically every turn in context-only mode
(zero model-callable tools). Optional knobs enable cross-harness shared recall
(`"recall_app_id": "shared"`), automatic CWD project-context query prefixing,
slash-command/skill-activation noise filtering, explicit `everos_recall` /
`everos_retain` tools (`"enable_tools": true`), and `/health` restart-blip
resilience.

Design details: [`docs/DESIGN_DOC.md`](./docs/DESIGN_DOC.md) · build/test/release:
[`docs/HANDOFF.md`](./docs/HANDOFF.md).

## Install

```bash
# From the Hermes built-in plugin catalog:
hermes plugins install everos

# Or directly from the GitHub repository subdirectory:
hermes plugins install EverMind-AI/Plugins/hermes    # → ~/.hermes/plugins/memory/everos/

hermes memory setup                                  # pick "everos"; answer the prompts
hermes memory status                                 # verify: provider active, EverOS healthy
```

One-time, outside the plugin: EverOS needs `everos init` once and API keys in
`~/.everos/everos.toml`. If EverOS isn't running, the provider starts it
automatically on agent startup (configure `everos_dir` / `start_cmd`).

**Updating:** subfolder installs can't use `hermes plugins update` — re-run the
install command above.

## Configuration (`$HERMES_HOME/everos.json`, written by `hermes memory setup`)

| Key | Default | Env Override | Purpose |
|---|---|---|---|
| `base_url` | `http://127.0.0.1:8000` | `EVEROS_BASE_URL` | Where EverOS listens (its port is EverOS config) |
| `user_id` | OS account | `EVEROS_USER_ID` | Developer identity for the user track |
| `agent_id` | `hermes` | — | Constant pooled agent identity |
| `recall_app_id` | `hermes` | `EVEROS_RECALL_APP_ID` | Recall scope `app_id` (`"hermes"` for host-only, `"shared"` for cross-harness recall across Hermes, Claude Code, Codex, and OpenClaw while writes remain under `"hermes"`) |
| `augment_cwd` | `true` | — | Prefix recall queries with non-generic CWD project/repo directory names |
| `enable_tools` | `false` | `EVEROS_ENABLE_TOOLS` | Expose explicit `everos_recall` and `everos_retain` model-callable tools alongside automatic `prefetch` and `sync_turn` |
| `probe_health_on_available` | `false` | — | Probe `/health` in `is_available()` with local restart-blip retry resilience |
| `query_max_units` | `500` | — | Weighted recall-query clip (CJK char = 2 units) |
| `everos_dir` | — | — | EverOS checkout, for auto-start from its venv |
| `start_cmd` | `everos server start` | — | Auto-start command (quote spaced paths) |

## Cross-Harness Shared Memory (`recall_app_id: "shared"`)

When multiple coding harnesses (Hermes, Claude Code, Codex, OpenClaw, Copilot CLI)
share a single local EverOS instance, set `"recall_app_id": "shared"` in
`$HERMES_HOME/everos.json`. `prefetch()` and `everos_recall` query
`app_id="shared"` (`project_id="default"`) to recall memories across all
harnesses, while `sync_turn()`, `on_memory_write()`, `on_delegation()`, and
`everos_retain` always record under `app_id="hermes"` to preserve clean provenance.

## Optional Model-Callable Tools (`enable_tools: true`)

Setting `"enable_tools": true` (or `EVEROS_ENABLE_TOOLS=1`) exposes two tools
via `MemoryProvider.get_tool_schemas()` and injects guidance via
`system_prompt_block()`:

- `everos_recall(query, max_tokens=1500)` — targeted hybrid search across the
  user and agent tracks.
- `everos_retain(content, context="general")` — immediately stores and flushes a
  durable fact, preference, or architectural decision.

## Privacy & Disclosure

- **Network destination:** The provider connects only to your configured EverOS
  server URL (`http://127.0.0.1:8000` by default).
- **Subprocess behavior:** When EverOS is not reachable on startup,
  `initialize()` attempts to auto-start the local server in a background child
  process via `start_cmd` (default `everos server start`).
- **Data sent to EverOS:** Recall queries, completed conversation turns
  (including tool calls and results), built-in `MEMORY.md`/`USER.md` edits, and
  subagent delegation summaries are sent to EverOS. EverOS itself forwards
  conversation text to the LLM and embedding providers configured in
  `~/.everos/everos.toml` for memory extraction.
- **No telemetry:** No analytics, telemetry, or self-updater is included.

## License

[Apache-2.0](../LICENSE)

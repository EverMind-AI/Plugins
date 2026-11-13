# Hermes Memory — EverOS

A native [Hermes Agent](https://github.com/NousResearch/hermes-agent) memory
provider backed by a local [EverOS](https://github.com/EverMind-AI/EverOS)
server: markdown files as the source of truth, hybrid (vector + BM25 + scalar)
recall, and two memory tracks — your profile/episodes and the agent's distilled
cases/skills. Recall is automatic every turn; the model gets **zero** memory
tools to remember to press.

Design details: [`docs/DESIGN_DOC.md`](./docs/DESIGN_DOC.md) · build/test/release:
[`docs/HANDOFF.md`](./docs/HANDOFF.md).

## Install

```bash
hermes plugins install EverMind-AI/plugins/hermes    # → $HERMES_HOME/plugins/everos/
hermes memory setup                                  # pick "everos"; answer the prompts
hermes memory status                                 # verify: provider active, EverOS healthy
```

One-time, outside the plugin: EverOS needs `everos init` once and API keys in
`~/.everos/everos.toml`. If EverOS isn't running, the provider starts it
automatically on agent startup (configure `everos_dir` / `start_cmd`).

**Updating:** subfolder installs can't use `hermes plugins update` — re-run the
install command above.

## Configuration (`$HERMES_HOME/everos.json`, written by `hermes memory setup`)

| Key | Default | Purpose |
|---|---|---|
| `base_url` | `http://127.0.0.1:8000` | Where EverOS listens (its port is EverOS config) |
| `user_id` | OS account | Developer identity for the user track |
| `agent_id` | `hermes` | Constant pooled agent identity |
| `query_max_units` | `500` | Weighted recall-query clip (CJK char = 2 units) |
| `everos_dir` | — | EverOS checkout, for auto-start from its venv |
| `start_cmd` | `everos server start` | Auto-start command (quote spaced paths) |

## What data leaves the device

The provider talks only to your local EverOS (`127.0.0.1`). EverOS itself sends
conversation text (each completed turn, including tool calls/results; built-in
memory edits; delegation summaries) to **the LLM and embedding providers you
configured in EverOS** for extraction — cloud services unless you point EverOS
at local models. Nothing else leaves the machine; the memory store
(Markdown/SQLite/LanceDB) is local.

## License

[Apache-2.0](../LICENSE)

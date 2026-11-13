# EverOS OpenClaw Plugin

Persistent, cross-session memory for **OpenClaw**, backed by a self-hosted
[EverOS](https://github.com/EverMind-AI/EverOS) — through natural conversation.

This plugin claims OpenClaw's exclusive **memory slot** and wires the OpenClaw
lifecycle to a local EverOS server (`/api/v2/memory/*` on `127.0.0.1:8000`).

> **v3.0.0 is a major-version replacement.** Versions ≤ 2.x were *context-engine*
> plugins targeting the old EverMemOS API (`/api/v1/memories/*` at `:1995`). This
> version is the *memory-slot* plugin for the current EverOS (`/api/v2/memory/*`
> at `:8000`). Requires **EverOS ≥ 1.2.3** and **OpenClaw ≥ 2026.8.1 (2.0)**.
> The package declares this host/API floor in OpenClaw's install-time compatibility
> metadata, so an older Gateway is rejected before plugin code loads.

## What it does

- Recalls relevant memories **before every reply** and injects them as context
- Saves every finished turn **after it ends** — text, staged images/audio/documents,
  and full tool-call trajectories
- Seals the conversation tail when a session ends (`/new`, `/reset`, shutdown —
  including clients whose `/new` never notifies the gateway)
- **Auto-starts a local EverOS** if one isn't already running (detect-then-provision)
- You just chat — no `memory_store` / `memory_search` tool calls, ever

Good to know:

- This **is** a `memory`-slot plugin — installing it displaces the stock
  `memory-core` (the installer switches the slot for you)
- **Fail-open by design**: if EverOS is down or unreachable, OpenClaw keeps
  working normally — memory just pauses
- Zero runtime dependencies (native `fetch`)

## Quick start

Recommended install:

```bash
npx --yes --package @everos-ai/openclaw-plugin everos-setup
```

The installer will:

- **ask** before accepting the plugin's declared memory capability, then run
  the official `openclaw plugins install` (claims the exclusive memory slot)
- **ask** before granting conversation access — required for both recall and saving,
  never granted silently
- help point the plugin at your EverOS checkout when `everos` isn't on the
  gateway's PATH
- restart the gateway and health-check the result

Non-interactive / scripted installs: `everos-setup --grant --everos-dir
/path/to/EverOS` (`--grant` also accepts the declared memory capability). To
install while leaving recall/capture off, use `--accept-capabilities --no-grant`.
All flags are listed by `everos-setup --help`. Prefer doing it by hand? See
[Manual install](#manual-install).

Then verify with natural language — just mention something about yourself:

```text
My favorite coffee is espresso.
```

then start a new session (`/new`), send any message, and ask:

```text
What coffee do I like?
```

(Give it a few seconds between turns — extraction runs asynchronously in EverOS.)

Do **not** set `hooks.allowPromptInjection` to `false` — it defaults to on, and
recall needs it to inject memory into the prompt.

## Backend

Default backend address:

```text
http://127.0.0.1:8000
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

If EverOS is already running, the plugin detects and uses it. If it isn't, the
plugin starts one itself (`everos server start`, forced into agent mode on the
configured port). When EverOS lives in a project virtualenv, `everos-setup`
wires the start command for you (it prompts for your checkout and sets
`EVEROS_OC_START_CMD` / `EVEROS_OC_EVEROS_DIR` — see [Config
reference](#config-reference) and [Troubleshooting](#troubleshooting) if you
ever need to adjust them by hand).

Setting up EverOS from scratch:

```bash
git clone https://github.com/EverMind-AI/EverOS.git
cd EverOS
uv sync
uv run everos init      # creates ~/.everos/everos.toml (+ ome.toml) — REQUIRED before first start
# edit ~/.everos/everos.toml — fill in the api_key fields (LLM / embedding / rerank)
uv run everos server start
```

## Images, audio, documents, and video

The plugin consumes OpenClaw 2.0's canonical, staged inbound media facts and
forwards supported assets to EverOS. Enable EverOS's optional parser in the
EverOS checkout:

```bash
uv sync --extra multimodal
```

Then configure the parser's **separate** provider in `~/.everos/everos.toml`.
This is not the main `[llm]` key:

```toml
[multimodal]
model = "google/gemini-3-flash-preview"
base_url = "https://openrouter.ai/api/v1"
api_key = "<your key>"
```

The selected endpoint/model must accept `image_url` parts and, for voice notes,
audio parts. Restart EverOS and verify that `/health` reports
`capabilities.multimodal_llm: true` and does not list `multimodal_upload` under
`disabled_features`.

- Supported end to end: images, audio, PDF, HTML, email, and office documents.
  Office files additionally require LibreOffice on the EverOS host.
- Staged local files are sent as `file://` URIs, so OpenClaw and EverOS must see
  the same filesystem path. If EverOS runs elsewhere, use an HTTP(S) media URL.
  Restrict readable local paths with `[multimodal].file_uri_allow_dirs` when the
  service is exposed beyond loopback.
- EverOS 1.2.3 has **no raw `video` ContentItem type**. If OpenClaw's own media
  understanding produces a transcript/description for an inbound video, the
  plugin saves that resulting text, but deliberately does not send the raw
  video file as a fake audio/image item.
- If multimodal parsing is unavailable, the plugin retries the turn text-only
  after a definite `415`, `422`, or `CAPABILITY_UNAVAILABLE` response.

## How natural-language memory works

1. You send a normal message.
2. `before_prompt_build` — the plugin searches EverOS (developer track + agent
   track) with a query built from your prompt.
3. Hits are injected as a clearly-fenced block of **untrusted historical
   context** — recalled memory informs the model, it can't issue instructions.
4. OpenClaw replies normally.
5. `message_received` + `agent_end` — the whole turn (user/assistant text,
   tool calls/results, and staged images/audio/documents) is forwarded to EverOS
   `/add`.
6. EverOS extracts memory on topic boundaries as you chat; when a session ends —
   `/new`, `/reset`, gateway shutdown, or a client-side session switch — the
   plugin flushes the buffered tail so the last topic is never lost.

So the day-to-day experience is just conversation:

> **Today:** "I prefer dark mode, by the way."
> **Days later, brand-new session:** "What UI style do I prefer?" → *"Dark mode."*

You never run a save command and never search anything — mentioning something is
enough for it to be remembered, and asking is enough to recall it. No "remember
this" prefix required.

## OpenClaw config example

The installed shape in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "evermind-ai-everos"
    },
    "entries": {
      "evermind-ai-everos": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "EVEROS_OC_BASE_URL": "http://127.0.0.1:8000",
          "EVEROS_OC_USER_ID": "your-name",
          "EVEROS_OC_AGENT_ID": "openclaw",
          "EVEROS_OC_QUERY_N": 1,
          "EVEROS_OC_QUERY_MAX_CHARS": 500
        }
      }
    }
  }
}
```

## Config reference

Every key can be set two equivalent ways: **env vars on the gateway process**
(take precedence) or **host-managed plugin config**
(`openclaw config set plugins.entries.evermind-ai-everos.config.<VAR> <value>`).
Empty/blank values are treated as unset.

| Var | Default | Purpose |
|---|---|---|
| `EVEROS_OC_BASE_URL` | `http://127.0.0.1:8000` | Where EverOS is. Scheme-less values (`localhost:8000`) are normalized to `http://` |
| `EVEROS_OC_USER_ID` | `$USER` / `$USERNAME` / OS account | Developer identity for the user memory track |
| `EVEROS_OC_AGENT_ID` | `openclaw` | Constant pooled agent identity for the agent track |
| `EVEROS_OC_QUERY_N` | `1` | Recent user messages blended into the recall query |
| `EVEROS_OC_QUERY_MAX_CHARS` | `500` | Recall query head-clip budget (chars) |
| `EVEROS_OC_START_CMD` | `everos server start` | Command to auto-start EverOS. Quotes group a path with spaces |
| `EVEROS_OC_EVEROS_DIR` | (gateway cwd) | Working directory for the auto-started EverOS |

## What gets recalled and captured

### Recalled

Recall injects up to four sections, all served by EverOS:

- **Developer profile** — durable facts and preferences about you
- **Relevant past episodes** — summarized prior conversations
- **Relevant cases** — concrete past agent trajectories (what worked)
- **Relevant skills** — reusable patterns distilled from multiple cases

### Captured

- User and assistant text (the plugin strips its own injected recall block first,
  so memory never re-ingests itself)
- Assistant **tool calls** and tool results, chained by `tool_call_id`
- **Images, audio, PDF, HTML, email, and office documents** (inline payload or
  staged URI). If EverOS definitively rejects multimodal input, the turn retries
  text-only so its conversation text is not lost
- **Video-derived text** produced by OpenClaw; raw video bytes are not sent
  because EverOS 1.2.3 does not define a video content type
- Oversized turns are chunked to EverOS's 500-message limit, in order

## Manual install

```bash
openclaw plugins install @everos-ai/openclaw-plugin --accept-capabilities
```

Then grant conversation access — **required, one time**. OpenClaw 2.0 blocks
both `before_prompt_build` recall and `agent_end` capture for non-bundled plugins
without this grant:

```bash
openclaw config set 'plugins.entries.evermind-ai-everos.hooks.allowConversationAccess' true
openclaw gateway restart
```

If `everos` lives in a project virtualenv, also set `EVEROS_OC_START_CMD` /
`EVEROS_OC_EVEROS_DIR` (see [Config reference](#config-reference)) — or just run
`everos-setup`, which wires them for you.

## Troubleshooting

| Problem | Fix |
|---|---|
| No recall and nothing is saved | Grant conversation access: `openclaw config set 'plugins.entries.evermind-ai-everos.hooks.allowConversationAccess' true`, then restart the gateway. The plugin logs a warning when it detects this state. |
| Saves work but recall does not | Remove an explicit `hooks.allowPromptInjection: false` override (or set it to `true`), then restart the gateway. |
| Audio/image/document becomes a placeholder | Install EverOS with the `multimodal` extra, configure `[multimodal]`, restart EverOS, and inspect `/health`. For a local file, also ensure the EverOS process can read that staged path. |
| Backend connection failed | Check `EVEROS_OC_BASE_URL`, then `curl <baseUrl>/health` |
| Auto-start never brings EverOS up | The gateway can't find `everos` — set `EVEROS_OC_START_CMD` to the absolute binary path and `EVEROS_OC_EVEROS_DIR` to the EverOS repo. Also check nothing else holds the single-instance lock (`~/.everos/.index/sqlite/ome.db.lock`) |
| Asked right after telling — no memory yet | Extraction is asynchronous; wait a few seconds. Mid-conversation extraction triggers on topic changes; session end seals the rest |
| "user-track memory is DISABLED" warning | No user id could be resolved — set `EVEROS_OC_USER_ID` |
| Conflicts with another memory plugin | This plugin owns the exclusive `memory` slot; check `plugins.slots.memory` is `evermind-ai-everos` |

## Files

- `dist/index.js` — plugin entry (`openclaw.extensions`)
- `src/setup.ts` / `src/setup-cli.ts` — the `everos-setup` one-command installer
- `src/register.ts` — slot claim, hook wiring, provisioning service
- `src/handlers.ts` — staged media / recall / capture / flush (+ session-switch safety net)
- `src/everos.ts` — typed EverOS REST client (`/add`, `/search`, `/flush`, `/health`)
- `src/provision.ts` — detect-then-provision of the EverOS server
- `src/config.ts` — `EVEROS_OC_*` configuration
- `openclaw.plugin.json` — plugin manifest + config schema

## Develop

```bash
npm install
npm run build        # tsc → dist/
npm test             # unit tests; live smoke runs only if EverOS is up
npm run ci           # lint + local/real-OpenClaw-2.0 typecheck + build + test
```

## License

Apache-2.0

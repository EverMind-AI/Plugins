# EverOS Pi Plugin

![pi-everos doctor and /everos commands](docs/everos-doctor.png)

EverOS Cloud memory for [Pi Agent](https://github.com/earendil-works/pi). After
install, the package registers `uvx everos-mcp` (`exposure: direct`) and injects
a memory protocol into every run so the model recalls and saves on its own —
you do not have to ask it to check EverOS.

- Product: [EverOS Cloud](https://everos.evermind.ai)
- MCP: [EverOS MCP docs](https://docs.evermind.ai/cloud/mcp.md)
- Scopes: [API and memory scopes](https://docs.evermind.ai/llms.txt)

The user-memory protocol stays in English (clipped by `prompt.maxTokens`).
Agent experience (cases/skills) is a separate `everos-agent` section and is
not squeezed by that cap. `/everos` commands and doctor follow `PI_LANG` /
`LANG` (Chinese when the locale is `zh`).

中文说明见 [README_zh.md](./README_zh.md)。

## Requirements

- [Pi Agent CLI](https://github.com/earendil-works/pi) 1.3+
- [uv](https://docs.astral.sh/uv/), used to run `uvx everos-mcp`
- `EVEROS_API_KEY` from [EverOS Cloud](https://everos.evermind.ai) — **do not**
  put the key in the settings file

## Install

From npm:

```bash
pi install npm:pi-everos
```

From this repository (Pi cannot install a git subdirectory, so clone first and
point at `pi/`):

```bash
git clone https://github.com/EverMind-AI/Plugins.git
pi install ./Plugins/pi
```

Open a new Pi session afterwards and run `/everos doctor` to check the
connection.

If `~/.pi/agent/mcp.json` already has an **enabled** `everos` entry, that file
config wins and this plugin registers as `everos-pi` instead. Set that entry to
`enabled: false` or rename it, then `/reload`, and the plugin will take
`everos`. The plugin never edits `mcp.json`.

## Commands

```text
/everos status
/everos login
/everos logout
/everos scope
/everos reconnect
/everos doctor
```

- Login does not write the API key into `everos.json`. After the user
  environment variable is set, `/everos login` or `/everos reconnect` re-reads
  the key.
- `/everos logout` only disconnects this plugin and writes `enabled: false`. It
  does **not** delete `EVEROS_API_KEY` from the system.

## Scope

- Project connection: current workspace (`projectId: auto` uses the **directory
  name**)
- Global connection: `everos-global` (default id `global`)
- `/everos scope auto|project <id>|global <id>` changes the mapping
- Agent identity: `assistantSenderId` (default `assistant-<userId>`). Cases
  and skills belong to this id; changing it hides prior experience.

## Agent experience

EverOS distills full task trajectories into **cases** (how one run was done)
and clusters related cases into **skills** (reusable procedures). This plugin
does not extract locally: the model calls `record_trajectory` /
`recall_agent_experience`, and Cloud distills in the background (seconds to
minutes).

- Trajectories are saved to the **current project** by default; write globally
  only when the user asks to remember a habit that applies across projects
- Recall searches the project first, then global if nothing relevant
- More than three tool-call rounds are required to produce a case; do not
  `record_trajectory` for shorter tasks
- `forget_session` deletes this session's memories and cases; **learned
  skills are kept**

## Development

```bash
npm test
pi -e ./extensions/index.ts
```

Architecture: [docs/architecture.md](./docs/architecture.md).

## Limits

- Default path is `uvx everos-mcp` plus an API key (7 tools).
- Remote OAuth MCP is not the v1 default.
- Plan mode blocks `add_memory` / `forget_session` / `record_trajectory`.
- `forget_session` asks for confirmation first; it does not delete learned
  skills.

## License

[Apache-2.0](../LICENSE)

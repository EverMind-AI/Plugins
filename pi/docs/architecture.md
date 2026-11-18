# Architecture

```text
pi install → extensions/index.ts
  → everos.json
  → if mcp.json already owns everos: register everos-pi + everos-global
  → otherwise: register everos + everos-global (uvx everos-mcp, exposure=direct)
  → before_agent_start writes sections.everos + sections.everos_agent
  → the model calls mcp__everos* / mcp__everos_global*
```

| Module | Role |
| --- | --- |
| `extensions/index.ts` | Registers MCP, commands, plan-mode guards, and prompt injection |
| `src/config.ts` | `~/.pi/agent/extension-settings/everos.json`; `assistantSenderId` defaults to `assistant-<userId>` |
| `src/mcp.ts` | uvx config, same-name override, tool names |
| `src/prompt.ts` | User-memory protocol (`maxTokens`) and the agent-experience protocol (separate section) |
| `src/scope.ts` | Derives `project_id` from cwd |
| `src/credentials.ts` | Reads the API key only from the environment; never writes it to settings |
| `src/commands.ts` | `/everos` |
| `src/guard.ts` | Plan mode is read-only |
| `src/redact.ts` | Masks secrets |
| `src/report.ts` | Pasteable doctor block |

The factory does not `spawn`. Credentials are environment-only. An enabled
`everos` entry in Pi's `mcp.json` takes precedence over plugin registration.

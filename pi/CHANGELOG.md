# Changelog

## 0.2.0

- Inject a separate `everos-agent` protocol: recall cases/skills before a
  non-trivial task, record a full trajectory after more than three tool-call
  rounds. Distillation stays on EverOS Cloud.
- Optional `assistantSenderId` (default `assistant-<userId>`). `/everos status`
  and doctor show identity, whether record/recall are online, the quality gate,
  and that forget keeps learned skills.

## 0.1.2

- README screenshot now shows `/everos doctor` and the command palette.

## 0.1.1

- Plan-mode write guard also covers a cold start (`--plan` flag + session entry).
- `mcp.json` yields only when `everos` is **enabled**; once disabled, the plugin
  takes `everos`.
- Default prompt keeps the forget confirmation and "do not remember" lines;
  cwd changes and reconnect refresh the project id / key.
- Commands and doctor follow `PI_LANG`; settings validation strips `apiKey`.

## 0.1.0

- Register `direct` MCP with `uvx everos-mcp` and `EVEROS_API_KEY`.
- Inject the memory protocol; dual connections (project + global).
- `/everos status|login|logout|scope|reconnect|doctor`.
- Plan mode blocks memory writes; doctor emits a pasteable diagnostics block;
  the settings file never stores the key.

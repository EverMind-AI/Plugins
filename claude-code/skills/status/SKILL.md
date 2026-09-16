---
name: status
description: Report whether EverOS memory is working for Claude Code - server health, the identity used for capture and recall, effective configuration, and recent errors. Use when memory seems to be missing, when the user asks whether EverOS is on, or when setting the plugin up for the first time.
---

# EverOS status

Run the status script and show the user its output verbatim:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.js"
```

Then add one sentence of interpretation:

- Server reachable and `user_id` present: memory is working. Say so and stop.
- Server not reachable: the numbered checklist in the output is the fix. Point at the first step that is not satisfied rather than repeating the whole list.
- `user_id` MISSING: personal memory is off. Tell the user to set `EVEROS_CC_USER_ID`.
- `project_id` is not what the user expected: it comes from the `origin` remote name, then the git toplevel, then the directory name. `EVEROS_CC_PROJECT_ID` overrides it.

Do not guess at causes the script did not report, and do not offer to restart EverOS unless the user asks.

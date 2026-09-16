---
name: search
description: Search the user's EverOS memory for this project and show what a prompt would recall. Use when the user asks what was decided or discussed before, wants to check whether something was remembered, or asks to search their memory.
---

# EverOS search

Take the user's search terms and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/search.js" "<the user's query>"
```

Show the output verbatim. It is the same two-track search the recall hook runs, with the same ids, so what it prints is exactly what a prompt would have been given.

If it reports no matching memory, say so plainly. Two ordinary reasons, worth mentioning only if the user asks why:

- Extraction is asynchronous, so a conversation from the last few seconds may not be indexed yet.
- Memory is partitioned per project. A decision made in a different repository is not visible here.

Do not re-run the search with reworded queries unless the user asks.

---
description: Print the token receipt for the current live-mode question
allowed-tools: Bash(node:*)
---

Print the deterministic token receipt for the most recent live-mode (`/codastre:mode`) question — the same output the mode injects at the end of a turn, on demand.

Run it with a single Bash call and show the output verbatim under a **Token receipt** heading:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/receipt.js"
```

(If `CLAUDE_PLUGIN_ROOT` is unset, use `hooks/receipt.js` under this plugin's directory.)

The script reads the JSONL token log and the per-session run marker, scoped to the current turn, and groups result-size tokens by class (Codastre / text search / file reads) — deterministic, no estimation by you. If it reports "No search/read tool calls were logged", either no mode is active or no searches ran this turn; suggest `/codastre:mode codastre|grep|auto` and asking a question. Do not estimate the numbers yourself.

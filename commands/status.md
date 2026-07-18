---
description: Check Codastre connectivity, auth, and index status
allowed-tools: Bash(codastre doctor:*), mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY
---

**Do NOT invoke skills or other commands. Run the checks below directly and report.**

1. Run `codastre doctor` via Bash. Exit code 0 = all checks pass, 2 = warnings only, 1 = at least one error.
2. If doctor passes, smoke-test retrieval: call the Codastre `QUERY` MCP tool with `query_text: "main entry point"`, `top_k: 1` (use whichever QUERY tool name is available: `mcp__plugin_codastre_codastre__QUERY` or `mcp__codastre__QUERY`).

Report briefly:

- **Status**: Connected / Degraded / Not configured / Error — one line each for CLI (doctor) and retrieval (QUERY).
- On QUERY success, include `status`, `freshness`, and how many repos were searched (`searched_repos`).
- On failure, map to guidance:

| Symptom | Guidance |
|---|---|
| `codastre` binary not found | Install the Codastre CLI, then `codastre login` |
| doctor reports no API key | Run `codastre login [--server URL]` |
| `RETRIEVAL_UNAVAILABLE` | Data plane down — control plane reachable; retry later, use Grep meanwhile |
| `REPO_NOT_INDEXED` | Call the `REGISTER` MCP tool with this repo's URL |
| MCP tool missing entirely | Restart Claude Code so the plugin's MCP server starts |

Also mention whether token tracking is active (`CODASTRE_TRACK_TOKENS=1` in the environment) with a pointer to `/codastre:tokens`.

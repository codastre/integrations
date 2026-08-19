---
description: Check Codastre connectivity, auth, and index status
allowed-tools: Bash(command -v codastre:*), Bash(codastre doctor:*), Bash(codastre version:*), mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY
---

**Do NOT invoke skills or other commands. Run the checks below directly and report.**

0. First confirm the CLI is installed: run `command -v codastre` via Bash. If it prints nothing (non-zero exit), the `codastre` binary is not on PATH — stop here and report per the "binary not found" row below (the MCP server runs `codastre serve`, so nothing else will work until it's installed). Otherwise continue.
1. Run `codastre doctor` via Bash. Exit code 0 = all checks pass, 2 = warnings only, 1 = at least one error.
2. If doctor passes, smoke-test retrieval: call the Codastre `QUERY` MCP tool with `query_text: "main entry point"`, `top_k: 1` (use whichever QUERY tool name is available: `mcp__plugin_codastre_codastre__QUERY` or `mcp__codastre__QUERY`).
3. Report the **retrieval plane**: run `codastre version`. v0.14.0+ means the CLI plane can render and hydrate (`--format agent` / `--snippets`), which is where this client reaches the cheap format rung; anything older means MCP `verbose` only. Say which, in one line, and — only when it's older — that updating the CLI recovers roughly a third of the tokens per hydrated call. Don't guess an install channel.

Report briefly:

- **Status**: Connected / Degraded / Not configured / Error — one line each for CLI (doctor) and retrieval (QUERY).
- On QUERY success, include `status`, `freshness`, and how many repos were searched (`searched_repo_count` on federated responses; the full `searched_repos` list only appears when `full_envelope=true`).
- On failure, map to guidance:

| Symptom | Guidance |
|---|---|
| `codastre` binary not found | Install the Codastre CLI, then `codastre login` |
| `codastre version` older than v0.14.0 | CLI plane can't render or hydrate — MCP `verbose` only; updating the CLI restores the cheap rung |
| doctor reports no API key | Run `codastre login [--server URL]` |
| `RETRIEVAL_UNAVAILABLE` | Data plane down — control plane reachable; retry later, use Grep meanwhile |
| `REPO_NOT_INDEXED` | Call the `REGISTER` MCP tool with this repo's URL |
| MCP tool missing entirely | Restart Claude Code so the plugin's MCP server starts |

Also mention whether token tracking is active (`CODASTRE_TRACK_TOKENS=1` in the environment) with a pointer to `/codastre:tokens`.

Finally, if calling the QUERY MCP tool triggered a **permission prompt** (rather than running immediately), note it: the tools aren't allowlisted, so every fresh QUERY/GRAPH will prompt — which nudges Claude back toward Grep. Point the user at the plugin README's **Recommended settings** section to add `mcp__plugin_codastre_codastre__QUERY` / `…__GRAPH` (or `mcp__codastre__QUERY`/`GRAPH` for a project-level config) to `permissions.allow` in `.claude/settings.json`.

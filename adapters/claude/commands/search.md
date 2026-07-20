---
description: Search indexed repos with Codastre hybrid retrieval
argument-hint: <query> [--repo URL] [--path PREFIX] [--lang X] [--top-k N]
allowed-tools: mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY, Read
---

Search using the Codastre `QUERY` MCP tool (whichever name is available: `mcp__plugin_codastre_codastre__QUERY` or `mcp__codastre__QUERY`).

Arguments: `$ARGUMENTS`

Parse the arguments: the free text is `query_text`; `--repo <url>` → `repo_url`, `--lang <x>` → `language`, `--path <prefix>` → `path_prefix`, `--top-k <n>` → `top_k` (default 10). With no `--repo`, search federated (omit `index_id` and `repo_url`) so every visible repo is covered.

Phrase `query_text` in code vocabulary (identifiers, API names) rather than a full English question — it ranks better. If a federated search returns noisy results (top hits from unrelated repos, or all scores tiny and nearly equal), re-run scoped with `--repo` or `--path` rather than raising `--top-k`; on a large or mixed tenant, scoping is the fix, not more results.

Present the results compactly:

- One line per hit: `real_path:line_start-line_end` (score) — one-phrase gloss of what the snippet is. Group by repo when results span repos.
- Quote a snippet only for the top 1–2 hits, and only the relevant lines.
- If a hit has `stale: true`, flag it and re-Read that range before quoting it.
- `results: []` with `status: "ok"` → say "indexed corpus has no match" (that is an answer); suggest Grep only if the query looks like a literal string.
- `freshness: "syncing"` → note results may lag recent commits.
- `RETRIEVAL_UNAVAILABLE` → say retrieval is down and offer a Grep fallback.

Do not follow up with Grep/Glob to "double-check" a successful QUERY.

---
description: Register the current repo for Codastre indexing (self-serve REPO_NOT_INDEXED fix)
argument-hint: "[repo URL] (defaults to this repo's git origin)"
allowed-tools: Bash(git remote get-url origin:*), mcp__plugin_codastre_codastre__REGISTER, mcp__codastre__REGISTER, mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY
---

Register a repository with Codastre so `QUERY`/`GRAPH` can search it — the self-serve fix for `REPO_NOT_INDEXED`.

Arguments: `$ARGUMENTS` — an optional git URL. If empty, resolve this repo's origin with `git remote get-url origin` via Bash; if that fails (no origin), ask the user for the URL and stop.

Steps:

1. Determine the repo URL (argument, else `git remote get-url origin`).
2. Call the Codastre `REGISTER` MCP tool with that URL (use whichever name is available: `mcp__plugin_codastre_codastre__REGISTER` or `mcp__codastre__REGISTER`).
3. Report the registration status the tool returns. Indexing is asynchronous — if it reports pending/queued/syncing, say so and that a first index can take a few minutes; the repo becomes searchable once it reports ready.
4. **Smoke-test** once it looks ready: call `QUERY` with `repo_url=<url>`, `query_text: "main entry point"`, `top_k: 1`. A hit → confirm the repo is searchable. `REPO_NOT_INDEXED` still → indexing hasn't completed; tell the user to retry `/codastre:status` shortly.

Notes:

- If `REGISTER` reports the repo is already registered, skip to the smoke test.
- If registration is refused for permissions/tenant reasons, relay the error and point the user at their Codastre admin — don't retry blindly.
- Once indexed, `QUERY` sees the *indexed* ref; after a flurry of local commits results can lag. If results look stale (`freshness != "fresh"` or `stale: true` on hits) and a `SYNC` tool is available, mention it can refresh the index.

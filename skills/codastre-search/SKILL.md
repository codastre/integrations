---
name: codastre-search
description: This skill should be used when searching or exploring a codebase — finding where something is implemented, locating definitions or usages, answering "where is X handled", "code that does Y", or "which repo owns Z". It teaches when and how to use the Codastre QUERY tool instead of Grep/Glob/rg/find, and when text search is still the right choice.
---

# Codastre Search

Codastre's `QUERY` tool is hybrid retrieval — dense semantic + BM25 lexical, fused with RRF — over every indexed repo. One call returns ~10 *ranked* results with real paths, line ranges, and locally-hydrated snippets. Use it as the default entry point for code search; it typically replaces a whole grep → refine → read cascade with a single call.

The tool name depends on how the MCP server was configured: `mcp__plugin_codastre_codastre__QUERY` (installed via this plugin) or `mcp__codastre__QUERY` (project-level config). Same contract either way.

## Decision rule: QUERY vs text search

**Use QUERY when the search is about meaning or identity:**

- Conceptual: "where do we validate JWTs", "retry logic for payments", "code that debounces sync"
- Identifier lookup: a function/class/symbol name, even partially remembered
- Cross-repo: you don't know which repo holds the code (omit `index_id`/`repo_url` → federated search across everything visible)
- Runbooks/docs: `content_kinds=["runbook","doc"]`; alert-driven lookup via `alert_ids=["KAFKA-1024"]` or `error_codes=["ERR_CONSUMER_LAG"]` is exact, not fuzzy

**Use Grep/Glob/rg when the search is about literal text:**

- Exact string matches: log messages, config keys, env var names, magic constants
- Uncommitted or unindexed files (QUERY sees the indexed ref, not your dirty working tree)
- Enumerating files by name pattern (that's Glob's job)
- Fallback: QUERY errored with `RETRIEVAL_UNAVAILABLE`

When unsure, one QUERY first is cheap — its top-10 either answers directly or gives you the exact paths to Read.

## How to call it

Minimal call — just the query text (federated across all visible repos):

```
QUERY(query_text="where are Kafka consumer offsets committed")
```

Scoping (all optional):

| Parameter | Use |
|---|---|
| `repo_url` | Search one repo by its git URL (server resolves latest ready index) |
| `index_id` | Search one index by UUID (mutually exclusive with `repo_url`) |
| `ref` | Branch name — searches that branch's overlay on top of base |
| `language` | e.g. `"python"`, `"go"` |
| `path_prefix` | Restrict to a subtree |
| `top_k` | Default 10, max 50 — raise only for survey-style questions |
| `content_kinds` | `["code"]`, `["runbook"]`, `["doc"]`; omit for all |

Query phrasing: natural language works ("function that masks paths before upload"); so do bare identifiers ("hydrateSnippet"). Don't stuff both a concept and an unrelated identifier into one query — issue two calls.

## Reading the response

Each result (via `codastre serve`, which unmasks paths and hydrates snippets from local disk):

- `real_path`, `line_start`, `line_end`, `score` — cite as `real_path:line_start`
- `snippet` — the actual code lines, already in the response; usually no Read needed
- `stale: true` — local file changed since indexing; re-Read that range before relying on the snippet
- `repo_id` — which repo (resolve via the top-level `repos` map in federated mode)

Envelope semantics that matter:

- `results: []` with `status: "ok"` is a **valid answer**: the corpus was searched and nothing matches. Do not immediately re-run the same query through grep "just in case" — reserve that for genuinely literal strings.
- `freshness: "syncing"` — results are base-index only; recent commits may be missing. Say so if it could matter.
- Error `RETRIEVAL_UNAVAILABLE` — data plane down. Fall back to Grep/Glob and note the degradation.
- `REPO_NOT_INDEXED` — the repo needs `REGISTER` first.

## Token-efficient workflow

1. One QUERY with a well-phrased question.
2. Answer from the snippets when they suffice (they usually do for "where/what" questions).
3. Read only the 1–2 files that need full context — targeted, with offsets from `line_start`/`line_end`.
4. For structural follow-ups ("what calls this?"), switch to GRAPH (see the codastre-graph-navigation skill) instead of grepping for the symbol name.

Anti-patterns: grepping a symbol across the tree when QUERY would rank definitions first; running QUERY repeatedly with tiny rewordings (rank quality won't change much — refine with filters instead); `top_k=50` by default (that forfeits the token advantage).

## Related

- `/codastre:search <query>` — one-shot slash command
- `/codastre:compare <question>` — side-by-side QUERY vs grep demo with token accounting
- `codastre doctor` (shell) — connectivity diagnostics when calls fail

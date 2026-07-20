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
| `path_prefix` | Restrict to a subtree — pass the **plaintext** prefix (e.g. `app/` or `server/api`); the server hashes it per repo for both masking schemes |
| `top_k` | Default 10, max 50 — raise only for survey-style questions |
| `content_kinds` | `["code"]`, `["runbook"]`, `["doc"]`; omit for all |

Query phrasing: lead with **code vocabulary**, not a full English question. `"kafka consumer subscribe orders topic"` ranks far better than `"which services react to a new order?"` — the sparse (BM25) leg matches terms that actually appear in code, and the dense leg embeds short code chunks weakly, so a discursive question tends to return a flat, low-scored, noisy ranking. Bare identifiers work well too (`"hydrateSnippet"`). Don't stuff both a concept and an unrelated identifier into one query — issue two calls.

Reading the scores: results carry an RRF `score`. If the top scores are all tiny and nearly **equal** (e.g. every hit ~0.016, decreasing by a hair), the dense and sparse legs found *disjoint* sets and nothing reinforced — that's a weak, low-confidence ranking, not a confident answer. Reword toward code vocabulary, add filters, or corroborate by Reading before trusting such a result.

Scope on multi-repo tenants: federated QUERY quality **degrades when the tenant holds large, unrelated, or fixture-heavy repos** — their files compete for the top-k and can crowd out the repo you care about. When you know the target, scope with `repo_url=` (single repo) or `path_prefix=` (plaintext — the server translates it); on a noisy tenant this is the default, not an optimization. Results carry `path_class` (`app | test | fixture | vendored | doc_asset`) — filter on it instead of guessing from path patterns; treat non-`app` hits as likely noise unless tests/fixtures are what you're looking for. (Servers also drop fixture corpora and vendored doc assets from indexing by default now, so most of that noise never appears.)

## Reading the response

These results assume the **local `codastre serve` proxy** (the plugin's default and preferred config — it unmasks paths and hydrates snippets from local disk).

**If results come back with `path_token` but no `real_path`/`snippet`, check the repo's `masking_scheme` in the envelope's `repos` map before concluding anything is broken** — the right diagnosis depends on it:

- **`masking_scheme: none` (cleartext repos — the common dev/eval setup):** `path_token` *is* the real, repo-relative path. Snippet hydration for `none`-scheme repos is a known gap in the current proxy (it gates hydration on unmasking, which cleartext repos skip). This is **not** a misconfiguration — do not tell the user to "switch to `codastre serve`"; they already are. Just treat `path_token` as the path and do targeted-range Reads: `Read(file_path=path_token, offset=line_start, limit=line_end-line_start+1)`. That keeps most of the token advantage (ranked paths + exact line ranges, no snippet body) until upstream hydration lands.
- **`masking_scheme: hmac` with `path_token` but no `real_path`/`snippet`:** *this* is the genuine "bypassing the proxy" case — the MCP config is talking to the server's raw HTTP endpoint instead of `codastre serve`. Read `path_token` as a repo-relative path and flag that the setup should use the local proxy.

Line-range Reads on `none` repos: the returned `line_start`/`line_end` are the chunk span; pass them straight to `Read`'s `offset`/`limit`. If a `line_start` of `0` shows up, treat it as line 1 (offsets are 1-based in Read).

Each result (via the proxy):

- `real_path`, `line_start`, `line_end`, `score` — cite as `real_path:line_start`
- `snippet` — the actual code lines, already in the response; usually no Read needed
- `stale: true` — local file changed since indexing; re-Read that range before relying on the snippet
- `repo_id` — which repo (resolve via the top-level `repos` map in federated mode)

Envelope semantics that matter:

- `results: []` with `status: "ok"` is a **valid answer**: the corpus was searched and nothing matches. Do not immediately re-run the same query through grep "just in case" — reserve that for genuinely literal strings.
- `filter_matched: false` (only present when you passed `path_prefix`) — your prefix matched **nothing indexed** (typo or stale path); fix the prefix rather than concluding "no results". `true`/absent means the empty result is genuine.
- Federated responses scope `repo_freshness`/`mask_key_revs`/`repos` to the repos present in `results` and report `searched_repo_count` instead of the full `searched_repos` list; pass `full_envelope=true` only if you need the all-tenant maps.
- `freshness: "syncing"` — results are base-index only; recent commits may be missing. Say so if it could matter.
- Error `RETRIEVAL_UNAVAILABLE` — data plane down. Fall back to Grep/Glob and note the degradation.
- `REPO_NOT_INDEXED` — the repo needs `REGISTER` first.

## Token-efficient workflow

1. One QUERY with a well-phrased question — lead with **code vocabulary** (see phrasing above). A discursive first attempt is the single most common cause of a flat, low-value ranking and the re-query cascade that follows.
2. Answer from the snippets when they suffice (they usually do for "where/what" questions).
3. Read only the 1–2 files that need full context — targeted, with offsets from `line_start`/`line_end`.
4. For structural follow-ups ("what calls this?"), switch to GRAPH (see the codastre-graph-navigation skill) instead of grepping for the symbol name.

### Stop rule — one shaped call, then answer

The dominant cost variance across otherwise-identical questions is **cascade length, not per-call size**: one run answers after a single QUERY; another piles on a second QUERY + a GRAPH + extra Reads "to be sure" and burns 2–3× the tokens for the same answer. That non-determinism is the instability — cap it:

- **Sharp ranking → stop.** If the first QUERY's top `score` is clearly separated from the tail (≳ 0.3), the snippets *are* the answer. Do not add a GRAPH call or re-Read files for confirmation unless a genuinely *structural* question remains.
- **Flat ranking → reshape once, don't respray.** All scores ~0.016 and near-equal means the dense and sparse legs found disjoint sets. Re-running near-identical wordings won't move rank. Reword once toward code vocabulary, or add one filter (`repo_url` / `path_prefix` / `language`), then Read the single best `app`-class hit. One reshape, not three rewordings.
- **Don't run both tools for a question only one owns.** "Which repo / where / what does X" is QUERY's job; "what calls X / what breaks if I change X" is GRAPH's. Reaching for GRAPH after QUERY already answered a where/what question is the most common source of the doubled cost.

Anti-patterns: grepping a symbol across the tree when QUERY would rank definitions first; running QUERY repeatedly with tiny rewordings (rank quality won't change much — refine with filters instead); `top_k=50` by default (that forfeits the token advantage); a reflexive GRAPH or corroborating Read after a QUERY that already answered the question.

## Related

- `/codastre:search <query>` — one-shot slash command
- `/codastre:compare <question>` — side-by-side QUERY vs grep demo with token accounting
- `codastre doctor` (shell) — connectivity diagnostics when calls fail
- **Source of truth:** this skill is compiled from the agent-neutral `core/retrieval-playbook.md` in the monorepo root — edit that first, then re-sync this skill.

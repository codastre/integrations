# Codastre Retrieval Playbook (agent-neutral)

This is the **agent-neutral source of truth** for how to drive Codastre's retrieval tools well —
the QUERY-vs-text-search decision, query phrasing, reading scores/confidence, the one-call stop
rule, and graph navigation. It is written once here and *compiled* into each agent adapter:

- **Claude** → `adapters/claude/skills/codastre-search/SKILL.md` and
  `adapters/claude/skills/codastre-graph-navigation/SKILL.md` (Claude skill format + the
  `mcp__…__QUERY` / `mcp__…__GRAPH` tool names).
- **Future adapters** (e.g. a Codex `AGENTS.md` section) transform this same content into their
  own format and call syntax.

Only two things differ per agent: the **call syntax** (tool names / invocation) and the **harness
wiring** (hooks, context injection). The ~90% below — *when* and *how* to retrieve — is shared. When
you change a rule, change it here first, then re-compile the adapters so they don't drift.

Throughout, **QUERY** = the hybrid semantic + lexical search tool; **GRAPH** = the cross-repo
relationship graph tool. Adapters substitute their concrete tool names.

---

## 1. QUERY vs text search — the decision

**Use QUERY when the search is about meaning or identity:**

- Conceptual: "where do we validate JWTs", "retry logic for payments", "code that debounces sync".
- Identifier lookup: a function/class/symbol name, even partially remembered.
- Cross-repo: you don't know which repo holds the code (federated search across everything visible).
- Runbooks/docs and alert/error-code lookups (exact, not fuzzy).

**Use text search (grep/glob/rg/find) when the search is about literal text:**

- Exact string matches: log messages, config keys, env var names, magic constants.
- Uncommitted or unindexed files (QUERY sees the indexed ref, not your dirty working tree).
- Enumerating files by name pattern.
- Fallback when QUERY is unavailable (retrieval down) or a repo isn't indexed.

When unsure, one QUERY first is cheap — its top results either answer directly or hand you the exact
paths to read.

## 2. Query phrasing

Lead with **code vocabulary**, not a full English question. `"kafka consumer subscribe orders topic"`
ranks far better than `"which services react to a new order?"`: the lexical (BM25) leg matches terms
that actually appear in code, and the dense leg embeds short code chunks weakly, so a discursive
question tends to return a flat, low-scored, noisy ranking. Bare identifiers work well
(`"hydrateSnippet"`). Don't stuff a concept and an unrelated identifier into one query — issue two.

## 3. Scoping on multi-repo tenants

Federated QUERY quality **degrades when the tenant holds large, unrelated, or fixture-heavy repos** —
their files compete for the top-k and crowd out the repo you care about. When you know the target,
scope to a single repo (by URL) or a path prefix (plaintext — the server translates it). On a noisy
tenant this is the default, not an optimization. Results carry a `path_class`
(`app | test | fixture | vendored | doc_asset`) — filter on it instead of guessing from path
patterns; treat non-`app` hits as likely noise unless tests/fixtures are what you want.

The session's own repo (its git origin) is usually the target — scope to it by default and go
federated only for genuinely cross-repo questions.

## 4. Reading the response

- Cite as `real_path:line_start`. Snippets are usually inline — answer from them without a follow-up
  read for "where/what" questions.
- **Masking scheme matters when a `snippet`/`real_path` is missing.** On `masking_scheme: none`
  (cleartext) repos, `path_token` *is* the real repo-relative path; a missing snippet there is a
  known local-proxy hydration gap, **not** a misconfiguration — treat `path_token` as the path and do
  targeted line-range reads. On `hmac` repos, a missing `real_path`/`snippet` means the config is
  talking to the raw HTTP endpoint instead of the local proxy — fix the setup.
- `stale: true` — the local file changed since indexing; re-read that range before quoting.
- `results: []` with `status: "ok"` is a **valid answer** (searched, nothing matched). Don't re-run
  through text search "just in case" unless the query was a literal string.
- `filter_matched: false` (only when you passed a path prefix) — the prefix matched nothing indexed;
  fix the prefix rather than concluding "no results".
- `freshness: "syncing"` — base-index only; recent commits may be missing. Say so if it matters.
- Errors: retrieval-unavailable → fall back to text search and note the degradation; repo-not-indexed
  → the repo needs registering first.

## 5. Reading scores

Results carry an RRF `score`. If the top scores are all tiny and nearly **equal** (e.g. every hit
~0.016, decreasing by a hair), the dense and lexical legs found *disjoint* sets and nothing
reinforced — a weak, low-confidence ranking, not a confident answer. Reword toward code vocabulary,
add a filter, or corroborate by reading before trusting it.

## 6. The stop rule — one shaped call, then answer

The dominant cost variance across otherwise-identical questions is **cascade length, not per-call
size**: one run answers after a single QUERY; another piles on a second QUERY + a GRAPH + extra reads
"to be sure" and burns 2–3× the tokens for the same answer. Cap it:

- **Sharp ranking → stop.** If the top `score` is clearly separated from the tail (≳ 0.3), the
  snippets *are* the answer. Don't add a GRAPH call or re-read for confirmation unless a genuinely
  *structural* question remains.
- **Flat ranking → reshape once, don't respray.** Reword once toward code vocabulary, or add one
  filter, then read the single best `app`-class hit. One reshape, not three rewordings.
- **Don't run both tools for a question only one owns.** "Which repo / where / what does X" is
  QUERY's job; "what calls X / what breaks if I change X" is GRAPH's. A reflexive GRAPH after QUERY
  already answered a where/what question is the most common source of doubled cost.

---

## 7. GRAPH — structural questions

GRAPH traverses a relationship graph extracted from every indexed repo: intra-repo structure
(`calls`, `imports`, `extends`, `implements`) and cross-repo topology (`kafka` producer/consumer,
`http` client/server, shared `package`). It answers what text search structurally cannot — grep finds
*text occurrences* of a name; GRAPH returns *resolved edges* with confidence, across repo boundaries.

Seed with a symbol name (or a topic for seed-free Kafka lookups) and pick a direction relative to the
seed:

| Question | Direction |
|---|---|
| What does `f` call / depend on? | outbound |
| What calls `f`? (impact) | inbound |
| Everything connected to `f` | both |
| Who produces/consumes topic T? | seed-free topic mode (src = producer, dst = consumer) |
| Subclasses / implementors of `C` | `extends`/`implements`, inbound (structural edges point into the definition) |

**Shape the call — scope first, widen only if needed.** Response size swings ~8× with scope. Start at
`depth=1` with a `kind=` filter matching the question (`calls` for callers/callees, `kafka`/`http`
for cross-service, `extends`/`implements` for type hierarchy). Widen to `depth=2`/all-kinds only for
transitive blast radius. **Seed a known symbol directly** — spending a QUERY to find a name you
already have is wasted. **Ignore self-edges** (`src` == `dst`: file-granularity self-loops).

## 8. Reading edges: confidence and resolution

Every edge carries `confidence` and `resolution`. **Do not present low-confidence edges as facts.**

- **Cross-repo kinds** (`kafka`, `http`, `package`) are minted from a shared string literal. Edges
  touching a `test`/`fixture`/`vendored` endpoint are quarantined (confidence capped ~0.3, never
  resolved). True cross-repo edges between real application code score ≥ 0.5 `resolved` on clean
  literal matches. So ≥ 0.5 = trust, < 0.5 = hypothesis; corroborate high-stakes calls with the
  endpoint code.
- **Intra-repo kinds** (`calls`, `extends`, `implements`, `imports`) are AST-derived (`heuristic`):
  ≥ 0.9 near-certain, 0.5–0.9 plausible but ambiguous, < 0.5 weak candidate.
- Filter on `edge.confidence` yourself; there's no server-side threshold on this tool.
- `src`/`dst` carry `real_path` on hmac repos where the proxy unmasks; on `none` repos they may carry
  only `path_token`, which *is* the real path (same hydration gap as QUERY — not a misconfiguration).
  `evidence` carries the file/line the edge was extracted from — cite it.

## 9. Naming the repo/service behind a federated edge

A federated GRAPH answer identifies each endpoint by `repo_id` (a UUID). Depending on the server
version, GRAPH's `repos` map may omit `remote_url` (QUERY's carries it) — so you may not be able to
name a *service* from the edge alone. Budget for it: if you already know the repo (you seeded from it,
or scoped to it), you have the name; otherwise resolve each unknown `repo_id → service` with one cheap
QUERY per repo and reuse the mapping across all edges. Say "repo `<uuid>`" rather than guessing a
service name from a shared path like `app/consumer.py`.

## 10. Recipes

**Impact analysis** (before renaming/deleting/changing a signature):

1. GRAPH inbound (depth 2) — direct and transitive callers.
2. Partition edges: ≥ 0.9 (will break), 0.5–0.9 (verify), < 0.5 (mention only).
3. If the symbol is a handler/producer/endpoint near a boundary, also check `kafka`/`http` inbound —
   cross-service consumers won't show up in any text search.
4. Report blast radius (files, edges, repos), high-confidence callers first, then proceed/verify.
5. Zero inbound edges + zero QUERY usages → dead-code candidate; confirm with a literal text search
   for the name (dynamic references, reflection, templates) before declaring it safe to delete.

**Cross-service tracing** ("what happens after X?"): QUERY to find the entry point → GRAPH outbound
(all kinds, depth 2) → follow `kafka`/`http` edges into other repos → QUERY within the target repo for
handler details. Each hop is one small ranked call instead of cloning and grepping N repos.

## 11. Fallbacks

- QUERY/GRAPH unavailable → fall back to text search and state explicitly that the result is textual,
  single-repo, and misses dynamic/cross-service references.
- Symbol not found in GRAPH → names must match the indexed definition; run QUERY to recover the exact
  symbol name, then re-seed.
- Literal strings, unindexed/uncommitted files → text search is the right tool; say so plainly.

## 12. Fetching source when a result has no snippet

A QUERY result is a **locator**: repo, path, line range, and `blob_sha`. When the response carries no
`snippet`, the content must be fetched before it can be quoted. Adapters compile this into their own
fetch/read primitives; the rules below are agent-neutral.

**A snippet is hydrated exactly when a local checkout is known for that result's repo.** Hydration
reads the file from disk; the root is resolved per repo (the repo the CLI runs inside, or one recorded
in the checkout registry). Masking scheme does **not** decide it — cleartext repos hydrate given a
checkout. So on a large tenant most federated hits arrive snippet-less simply because those repos
aren't cloned, and obtaining a checkout *does* make snippets appear on the next call.

Where the proxy reports a reason, branch on it rather than inferring: no-checkout (clone, or read via
the forge API), file-absent-in-checkout (fetch — indexed at a ref the tree lacks), read-error. Absent
reason and absent snippet means an older proxy; fall back to the rule above.

The one genuine misconfiguration: an `hmac` repo returning a `path_token` with no `real_path` means
the config is talking to the raw HTTP endpoint instead of the local proxy. Fix that at the source.

GRAPH needs no source at all, so never fetch source for a purely structural question.

**Never read a returned path directly.** `real_path`/`path_token` are repo-relative with **no repo
prefix**, and such paths collide across repos in any large tenant (measured: 13 checkouts on one
machine shared an `internal/infra/kafka/` tree). Resolving against the wrong repo root yields a real,
plausible, wrong file **with no error** — the worst failure mode. Resolve the repo first, from
`repos[repo_id].remote_url`.

**Resolving a repo behind a GRAPH edge can be harder than behind a QUERY hit.** The server's GRAPH
`repos` map carries no `remote_url`, so check whether the proxy backfilled one — when it did, the edge
already names both services. When it didn't, there is no way to query *by* `repo_id`, so the "one cheap
QUERY per repo" method only works when candidate repos are already known; with no candidates, search
the forge for a distinctive path segment from the edge. Never infer a service from a shared path like
`app/consumer.py`.

**The CLI already tracks local checkouts.** `checkouts.json` in the CLI's config directory maps
`remote_url` → absolute local path, keyed in the same format QUERY returns, and is the mechanism behind
the `--repo-path` flag. Consult it before guessing a directory. It is **not exhaustive** — it lists only
checkouts the CLI has seen — so also probe the clone root on disk, or you will re-clone every session.

**Prefer a single-file fetch over a clone** for one to three files — that fetches one file's contents
and touches no disk. Clone only for genuine exploration (grep, following imports); a clone brings the
**whole repo at one commit**, not a file: blobless and shallow, so all paths are present with blob
bytes on demand and no history (measured on a mid-size service: 1483 files, 1 commit, ~4 s, 16 MB on
disk against 29 MB server-side for full history).

When cloning, derive the root from existing checkout-registry entries when possible (their common
parent is the machine's convention), else default to a `checkouts/` tree beside the CLI's own config,
creating that root — it does not exist on a fresh machine. **Keep every root's layout flat,
`<root>/<repo>`**, so a single probe finds a clone under any of them; a nested `<host>/<owner>/`
layout makes the probe miss clones and re-clone each session. Same-named repos from different orgs
then collide — give the second an explicit root rather than reintroducing nesting. Never clone into
the current repo's tree.

**Verify `blob_sha` before quoting — always.** Compare the result's `blob_sha` against the checkout's
blob hash for that path. One check catches both wrong-repo and stale-index at once. On mismatch, don't
trust `line_start`: locate the symbol by name and say the index is behind. `stale: true` and
`freshness: "syncing"`/`"degraded"` are corroborating signals.

**Cite with the repo name.** A bare path is ambiguous across a multi-repo tenant.

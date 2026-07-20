---
name: codastre-graph-navigation
description: This skill should be used for structural code questions — "what calls X", "what would break if I change X", "what consumes this Kafka topic", "which services talk to each other", impact analysis before a rename/refactor/delete, or tracing a request across services. It teaches the Codastre GRAPH tool: directions, edge kinds, depth, and how to read confidence/resolution.
---

# Codastre Graph Navigation

Codastre's `GRAPH` tool traverses a relationship graph extracted from every indexed repo: intra-repo structure (`calls`, `imports`, `extends`, `implements`) and cross-repo topology (`kafka` producer/consumer, `http` client/server, shared `package`). It answers structural questions grep fundamentally cannot — grep finds *text occurrences* of a name; GRAPH returns *resolved edges* with confidence scores, across repository boundaries.

Tool name: `mcp__plugin_codastre_codastre__GRAPH` (plugin install) or `mcp__codastre__GRAPH` (direct config).

## Core calls

Seed with a symbol name or chunk_id; pick a direction relative to the seed:

| Question | Call |
|---|---|
| What does `f` call / depend on? | `GRAPH(chunk_or_symbol="f", direction="outbound")` |
| What calls `f`? (impact) | `GRAPH(chunk_or_symbol="f", direction="inbound")` |
| Everything connected to `f` | `GRAPH(chunk_or_symbol="f", direction="both")` |
| Who produces/consumes topic T? | `GRAPH(topic="orders.created")` — seed-free, forces `kind=kafka`; src = producer, dst = consumer |
| Subclasses / implementors of `C` | `GRAPH(chunk_or_symbol="C", kind="extends", direction="inbound")` (structural edges point *into* the definition) |

- `depth`: 1 (default) to 3. Depth 2–3 for blast radius; depth 1 for direct neighbors.
- `kind`: filter to one of `kafka | http | package | calls | extends | implements | imports`; omit for all.
- Target modes mirror QUERY: `index_id` (one index), `repo_url` (one repo), or neither — federated across all visible repos, which is what makes cross-service tracing work.

## Shape the call — scope first, widen only if needed

GRAPH's response size swings ~8× with how you scope it. An unscoped `direction="outbound", depth=2` over a hub symbol returns dozens of edges (~6k tokens) — most of them **self-edges** (`src` == `dst`: intra-chunk calls at file granularity) plus paired `calls`+`imports` between the same two files — while the same intent asked as `kind="calls", depth=1` returns the 3–4 edges you actually wanted (~800 tokens) and reads more clearly. Default tight:

- **Start at `depth=1` with a `kind=` filter** matching the question: `calls` for callers/callees, `kafka`/`http` for cross-service, `extends`/`implements` for type hierarchy. Widen to `depth=2`/all-kinds only when depth-1 is genuinely insufficient (transitive blast radius) — not by default.
- **Seed a known symbol directly.** The seed does its own fuzzy matching, so when you already hold the exact symbol — from the code in front of you, or a prior QUERY hit's `symbol_name` — seed GRAPH straight. Spending a QUERY to "find" a name you already have is wasted; QUERY-then-GRAPH is only for when you *don't* know the symbol. For pure-structural entry with no symbol at all, use the seed-free `topic=` mode.
- **Ignore self-edges.** `src` == `dst` (same `path_token` and range) are file-granularity self-loops, not relationships — drop them before counting edges or reporting a blast radius.

## Reading edges: confidence and resolution

Every edge carries `confidence` and `resolution`. **Do not present low-confidence edges as facts.**

- **Cross-repo kinds** (`kafka`, `http`, `package`): `resolution: "dynamic_unresolved"` or `confidence < 0.5` → hypothesis awaiting curation, not fact. Phrase as "likely/possibly".
- **Intra-repo kinds** (`calls`, `extends`, `implements`, `imports`): always `resolution: "heuristic"` (AST-derived). Trust the graded confidence instead: ≥ 0.9 near-certain (name resolves to one definition); 0.5–0.9 plausible but ambiguous; < 0.5 weak candidate.
- GRAPH returns all edges regardless of score — filter on `edge.confidence` yourself (the `edge` object is canonical; there are no item-level confidence/resolution mirrors and no server-side threshold parameter on this tool).
- `src`/`dst` carry `real_path` on `hmac` repos where the proxy unmasks; on `masking_scheme: none` repos they may carry only `path_token`, which *is* the real repo-relative path (same known hydration gap as QUERY — see the codastre-search skill; it is not a misconfiguration). Read the `repos` map's `masking_scheme` before deciding. `src`/`dst` may also carry `path_class` (`app | test | fixture | vendored | doc_asset`); `evidence` carries the file/line the edge was extracted from — cite it.

### Naming the repo/service behind an edge (federated GRAPH)

A federated GRAPH answer identifies each endpoint by `repo_id` (a UUID), but GRAPH's `repos` map carries only `{masking_scheme, mask_key_rev}` per id — **no `remote_url` or repo name** (QUERY's `repos` map does carry `remote_url`). So to answer "which *services* consume this topic?" you cannot name a service from the edge alone. Budget for it:

- If you already know the repo (you seeded a symbol from a repo you're in, or scoped with `repo_url=`), you have the name — don't spend a call.
- For a genuinely federated answer over unknown repos, resolve each unknown `repo_id → service` with **one cheap QUERY per repo** (`QUERY(query_text="<something>", repo_url=<candidate>, top_k=1)` and match the `repo_id` in its `repos` map), or ask the user which repos map to which service. Do this once and reuse the mapping across all edges in the answer — don't re-resolve per edge.
- Say "repo `<uuid>`" explicitly rather than guessing a service name from a path like `app/consumer.py` (many services share that path).

### Cross-repo edges are string matches — read the class and the score

Cross-repo `kafka`/`http`/`package` edges are minted when two repos share a **string literal** — the same Kafka topic name, HTTP route, or package name. The server now calibrates these against corpus noise:

- **`path_class` is authoritative for endpoint noise.** Endpoints classed `test`/`fixture`/`vendored` are *quarantined* server-side: any edge touching one is capped at confidence 0.3 and never `resolved` — such edges are emitted as visible hypotheses, ranked last. Filter on `src`/`dst` `path_class` instead of guessing from path patterns. (Fixture corpora and vendored doc assets are also dropped from indexing by default, so most never appear at all.)
- **True cross-repo edges between real application code now score ≥ 0.5 `resolved` on clean literal matches** — a lone shared topic that only the communicating services expose is graded as the discriminating evidence it is. So the ≥ 0.5 = trust / < 0.5 = hypothesis reading works again for cross-repo kinds; corroborate with the endpoint code when the call is high-stakes.
- **Unclassified endpoints** (`path_class` absent — points indexed before classification): fall back to sanity-checking that both endpoints are real application code before stating the edge as fact.

## Impact analysis recipe

Before renaming, deleting, or changing the signature of a symbol:

1. `GRAPH(chunk_or_symbol="<symbol>", direction="inbound", depth=2)` — direct and transitive callers.
2. Partition edges: confidence ≥ 0.9 (will break), 0.5–0.9 (verify), < 0.5 (mention only).
3. If the symbol is a handler/producer near a service boundary, also check `kind="kafka"` and `kind="http"` inbound — cross-service consumers won't show up in any text search.
4. Report: blast radius (N files, M edges, which repos), the high-confidence callers first, then a proceed/verify recommendation.
5. Zero inbound edges + zero QUERY hits for usages → dead-code candidate; confirm with a literal Grep for the name (dynamic references, reflection, templates) before declaring it safe to delete.

## Cross-service tracing recipe

"What happens after X?" across services: QUERY to find the entry point → GRAPH outbound from it (all kinds, depth 2) → follow `kafka`/`http` edges into other repos → QUERY within the target repo for the handler details. Each hop is one small ranked call instead of cloning and grepping N repos.

## Fallbacks

- Symbol not found: names must match the indexed definition — run QUERY first to find the exact symbol name, then re-seed GRAPH.
- GRAPH unavailable: fall back to Grep for the symbol name and say explicitly that the result is textual, single-repo, and misses dynamic/cross-service references.

## Related

- `/codastre:graph <symbol>` and `/codastre:impact <symbol>` — slash command equivalents
- codastre-search skill — finding the right seed symbol
- **Source of truth:** compiled from the agent-neutral `core/retrieval-playbook.md` (§7–11) in the monorepo root — edit that first, then re-sync this skill.

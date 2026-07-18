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

## Reading edges: confidence and resolution

Every edge carries `confidence` and `resolution`. **Do not present low-confidence edges as facts.**

- **Cross-repo kinds** (`kafka`, `http`, `package`): `resolution: "dynamic_unresolved"` or `confidence < 0.5` → hypothesis awaiting curation, not fact. Phrase as "likely/possibly".
- **Intra-repo kinds** (`calls`, `extends`, `implements`, `imports`): always `resolution: "heuristic"` (AST-derived). Trust the graded confidence instead: ≥ 0.9 near-certain (name resolves to one definition); 0.5–0.9 plausible but ambiguous; < 0.5 weak candidate.
- GRAPH returns all edges regardless of score — filter on `confidence` yourself; there is no server-side threshold parameter on this tool.
- `src`/`dst` carry `real_path` (unmasked by the local proxy); `evidence` carries the file/line the edge was extracted from — cite it.

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

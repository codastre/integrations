---
description: Blast-radius analysis before changing or deleting a symbol
argument-hint: <symbol> [--depth N]
allowed-tools: mcp__plugin_codastre_codastre__GRAPH, mcp__codastre__GRAPH, mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY, Grep
---

Assess the impact of changing/renaming/deleting the given symbol. Load the `codastre-graph-navigation` skill's interpretation rules if not already loaded.

Arguments: `$ARGUMENTS` (free text = symbol; `--depth <n>`, default 2, max 3)

1. Call the Codastre `GRAPH` tool: `chunk_or_symbol=<symbol>, direction="inbound", depth=<depth>` — all edge kinds, federated (no `repo_url`/`index_id`) so cross-repo consumers are included.
2. If the symbol looks boundary-adjacent (handler, producer, endpoint, exported package symbol), the kafka/http/package inbound edges from step 1 are the cross-service blast radius — call them out separately.
3. If zero edges return: QUERY for the symbol to check it exists under that name; if it exists but has no inbound edges, run one literal Grep for the name to catch dynamic/reflective references before calling it dead code.

Report:

1. **Symbol** — name and defining location(s) (`real_path`, plus `:line` only when an edge's `evidence` already supplies it — do not Read caller files to manufacture line numbers; GRAPH ranges are chunk-granular).
2. **Risk** — Low (< 5 confident inbound edges, single repo) / Medium (5–15, or any cross-repo edge) / High (> 15, or a public boundary), with a one-sentence rationale.
3. **Will break** — inbound edges with confidence ≥ 0.9, grouped by repo.
4. **Verify** — 0.5–0.9 edges.
5. **Hypotheses** — < 0.5 or `dynamic_unresolved`, clearly labeled as unverified.
6. **Recommendation** — proceed / update the listed callers first / stage the change; for cross-repo breakage, name the affected services.

For High risk, lead with the warning.

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
- Target modes mirror QUERY: `index_id` (one index), `repo_url` (one repo), or neither — federated across all visible repos, which is what makes cross-service tracing work. Federation isn't free: on a tenant with large or unrelated repos a federated seed matches same-named symbols everywhere, and each unknown `repo_id` may cost a resolving call (see below). **Scope to the session's own repo by default; go federated deliberately, not by omitting the parameter.** Passing both `index_id` and `repo_url` is an error (`AMBIGUOUS_TARGET`); a `repo_url` with no index returns `REPO_NOT_INDEXED` — REGISTER it first.

### Always pass `direction` explicitly — never let it default

`direction` defaults to `outbound` (so does the `codastre graph <symbol>` CLI), which answers "what does the seed call" — the *opposite* of the most commonly asked structural question. The failure is silent: you get a plausible set of edges that simply doesn't contain the answer, then spend a compensating QUERY, doubling the cost of a question one correctly-shaped call would have answered.

Map the phrasing to the direction **before** calling:

| The request says | Direction |
|---|---|
| callsites, callers, "what calls", "who uses", "where is X used", usages, references, impact, blast radius, "safe to delete" | **inbound** |
| dependencies, "what does X call/use/depend on", downstream, "what happens after X" | **outbound** |
| "everything about X", "how does X connect", unclear which way | **both** |

When the wording is ambiguous ("show me the graph for X", "neighbors of X"), pass `both` rather than accepting the outbound default — one merged call beats discovering the wrong direction and re-asking.

## Shape the call — scope first, widen only if needed

GRAPH's response size swings ~8× with how you scope it. An unscoped `direction="outbound", depth=2` over a hub symbol returns dozens of edges (~6k tokens) — most of them **self-edges** (`src` == `dst`: intra-chunk calls at file granularity) plus paired `calls`+`imports` between the same two files — while the same intent asked as `kind="calls", depth=1` returns the 3–4 edges you actually wanted (~800 tokens) and reads more clearly. Default tight:

- **Start at `depth=1` with a `kind=` filter** matching the question: `calls` for callers/callees, `kafka`/`http` for cross-service, `extends`/`implements` for type hierarchy. Widen to `depth=2`/all-kinds only when depth-1 is genuinely insufficient (transitive blast radius) — not by default.
- **Seed a known symbol directly.** The seed does its own fuzzy matching, so when you already hold the exact symbol — from the code in front of you, or a prior QUERY hit's `symbol_name` — seed GRAPH straight. Spending a QUERY to "find" a name you already have is wasted; QUERY-then-GRAPH is only for when you *don't* know the symbol. For pure-structural entry with no symbol at all, use the seed-free `topic=` mode.
- **Seed from a QUERY hit's `seed:` id when it has no symbol name.** In `agent` format a QUERY hit with no `symbol_name` prints `seed:<chunk_id>` — that is GRAPH's exact seed. Pass it verbatim as `chunk_or_symbol`: a chunk id traverses **directly**, skipping the seed's fuzzy symbol matching, so it cannot land on a same-named symbol in the wrong file or repo, and it needs no second QUERY to "recover the exact indexed symbol name". This is the QUERY → GRAPH handoff to use. A hit that *does* carry `symbol_name` prints no `seed:` tag on purpose — the name seeds just as well at a fraction of the bytes, so use the name there.
- **Ignore self-edges.** `src` == `dst` (same `path_token` and range) are file-granularity self-loops, not relationships — drop them before counting edges or reporting a blast radius.

## Ask for `format: "agent"` on a traversal — once you've checked it arrives

GRAPH has the same three-rung ladder as QUERY — `verbose` (default) → `compact` (server drops what a
caller can't act on) → `agent` (the local proxy renders the response as text). It is orthogonal to
`direction`, `kind`, and `depth`: same edges, different packaging.

It pays differently here than on QUERY. GRAPH returns edges and **never bodies**, so per-item
overhead is the *whole* response — the state QUERY only reaches with `snippets: false` — and a
traversal is the shape that repeats hardest: many edges, few sources. Every edge out of one function
repeats that function's 64-hex `path_token` twice and its 36-char `repo_id` twice. The `agent`
rendering groups edges under their source file, writing that path once per fan-out instead of once
per edge, and names the destination repo only when the edge actually crosses a boundary.

Measured — both single deterministic runs, so read them to the nearest few points: the compact edge
item on a 12-edge fan-out fixture, 513 → 377 B/edge (**−27%**); the agent rendering on a deployed
8-edge traversal, 4,743 → 1,785 B (**−62%**).

**There is no `snippets` knob to pair it with** — GRAPH has no bodies to suppress — so `format` is
the whole lever, and there's no reason not to pull it on a traversal you intend to *read* as an
answer rather than parse as data.

Three shape differences to know before reading a compact or agent traversal:

- **`structuredContent` no longer holds the edges** in `agent` format. It carries a fixed summary —
  `format`, `status`, `freshness`, `edge_count`, and `rendering_in`. **The answer is in
  `content[0].text`.**
- **`edge_id` is dropped unconditionally** in `compact`, unlike QUERY's `chunk_id` (which survives
  because GRAPH seeds on it). Nothing accepts an `edge_id`; per-edge curation is REST `/v1/edges`.
- **`confidence` rounds to 3 dp**, deliberately not 2: confidence is read against the documented
  ≥ 0.9 / ≥ 0.5 bands below, and 2 dp rounds `.499` up across one. Defaults print nothing — no
  `resolution` tag means `heuristic`, no `path_class` tag means `app`, no `×N` means one call site.

The REST mirror `GET /v1/graph/neighborhood` stays **verbose-only**: its consumer is the dashboard,
which pays no per-byte cost and reads `confidence`/`resolution` on every edge.

**Check the rung is there first.** A current proxy always advertises `format` — `verbose | compact
| agent` once the server has shipped its own, `verbose | agent` when it has not, since the rendering
is client-side. An **absent** `format` therefore means an out-of-date `codastre` binary, not a
server limitation; with one, most MCP clients won't send the argument at all and the rung is
unreachable.

**But on Claude Code it isn't reachable over MCP — take it on the CLI plane instead.** `agent`
carries the traversal in `content[0].text` and only a fixed summary in `structuredContent`, so a
client that prefers `structuredContent` when both are present shows you `edge_count` and no edges
(verified in Claude Code, 2026-08-18, `codastre` v0.14.0 — the frame carried the rendering; the model
never saw it). That is deterministic, so don't spend a call re-probing it. Run the traversal through
Bash:

```bash
codastre graph OrderProcessor --direction inbound --format agent          # this repo
codastre graph OrderProcessor --direction both --depth 2 --repo-url <url> --format agent
codastre graph --topic orders.created --format agent                     # seed-free Kafka lookup
```

**GRAPH's gate is simpler than QUERY's**: there are no bodies here, so the `--snippets` hydration
question doesn't arise — the CLI needs only to know `--format agent`, which arrived in **v0.14.0**
(≤ v0.13.1 offers `human | json` and no rendering). Confirm once per session with
`codastre version`; on an older binary, use `format: "verbose"` over MCP, say once that the rung
needs v0.14.0+, and don't repeat it. Same flag-for-argument mapping as the tool: `--direction`,
`--depth`, `--kind`, `--repo-url`, `--all` (federated), `--topic`.

Stay on MCP when Bash is unavailable (restricted subagent or sandbox), when the CLI isn't installed
or logged in, or on a client that *doesn't* swallow the rendering — there MCP `agent` is cheapest and
the detour buys nothing. CLI-plane traversals are logged like MCP ones (`class: "codastre"`,
`plane: "cli"`), so the receipt still counts them.

## Reading edges: confidence and resolution

Every edge carries `confidence` and `resolution`. **Do not present low-confidence edges as facts.**

- **Cross-repo kinds** (`kafka`, `http`, `package`): `resolution: "dynamic_unresolved"` or `confidence < 0.5` → hypothesis awaiting curation, not fact. Phrase as "likely/possibly".
- **Intra-repo kinds** (`calls`, `extends`, `implements`, `imports`): always `resolution: "heuristic"` (AST-derived). Trust the graded confidence instead: ≥ 0.9 near-certain (name resolves to one definition); 0.5–0.9 plausible but ambiguous; < 0.5 weak candidate.
- GRAPH returns all edges regardless of score — filter on `edge.confidence` yourself (the `edge` object is canonical; there are no item-level confidence/resolution mirrors and no server-side threshold parameter on this tool).
- `src`/`dst` carry `real_path` on `hmac` repos where the proxy unmasks; on `masking_scheme: none` repos they may carry only `path_token`, which *is* the real repo-relative path (same known hydration gap as QUERY — see the codastre-search skill; it is not a misconfiguration). Read the `repos` map's `masking_scheme` before deciding. `src`/`dst` may also carry `path_class` (`app | test | fixture | vendored | doc_asset`); `evidence`, **when present**, carries the file/line the edge was extracted from — cite it. It is frequently absent.

### GRAPH edges are chunk-granular — don't Read your way to line numbers

`src`/`dst` line ranges describe the **whole chunk** the edge was extracted from, not the call site: a caller commonly comes back as `line_start: 0, line_end: 178` — the entire file. GRAPH is a *topology* tool; unlike QUERY it carries no snippet bodies, and there is no snippet parameter to turn them on.

The trap: reading those ranges as imprecise line numbers and opening every caller file to pin down the exact line. That turns one cheap call into N Reads, often costing several times the GRAPH call itself — reintroducing the per-hit read round-trip that ranked retrieval exists to avoid.

- **Answer at the granularity the question asked.** "What calls X" / "what breaks if I change X" is a *file-and-symbol* answer: `path/to/Caller.swift` → `X`, confidence 0.9 is complete and citable. Don't manufacture a line-number requirement the user didn't ask for.
- **If you genuinely need line numbers**, prefer **one QUERY** naming the symbol and scoped to the repo — hydrated snippets with true `line_start`/`line_end` for several callers in a single call — over one Read per caller file. Reserve Read for the one or two files you must see in full.
- **Budget it explicitly.** Post-GRAPH Reads are the dominant cost of a structural answer and the easiest to skip. If a Read won't change the conclusion, it's overhead: state the edges with their confidence and stop.

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

- Symbol not found: names must match the indexed definition — run QUERY first to find the exact symbol name, then re-seed GRAPH. If that QUERY hit has no `symbol_name`, re-seed on its `seed:<chunk_id>` instead — a chunk id traverses directly and can't mis-match a same-named symbol elsewhere.
- GRAPH unavailable: fall back to Grep for the symbol name and say explicitly that the result is textual, single-repo, and misses dynamic/cross-service references.

## Related

- `/codastre:graph <symbol>` and `/codastre:impact <symbol>` — slash command equivalents
- codastre-search skill — finding the right seed symbol
- **Source of truth:** compiled from the agent-neutral `core/retrieval-playbook.md` (§7–11) in the monorepo root — edit that first, then re-sync this skill.

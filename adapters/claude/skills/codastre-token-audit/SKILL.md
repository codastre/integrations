---
name: codastre-token-audit
description: This skill should be used when the user asks to measure, demonstrate, or compare the cost/benefit of Codastre versus plain text search — "how many tokens did search use", "show the savings", "is codastre actually worth it", "compare codastre vs grep", or when running /codastre:tokens or /codastre:compare. It defines the measurement methodology so numbers are honest and reproducible.
---

# Codastre Token Audit

Two ways to quantify Codastre's benefit over a grep/find/rg workflow: **passive tracking** (a hook logs every search tool call's result size) and **active comparison** (run the same information need both ways in isolated subagents and compare). Always report both tokens *and* relevance — a cheap search that misses the answer saved nothing.

## Passive tracking (the token log)

When `CODASTRE_TRACK_TOKENS=1` is set, a PostToolUse hook appends one JSONL record per search call to `~/.config/codastre/claude-token-log.jsonl` (override: `CODASTRE_TOKEN_LOG`):

```json
{"ts":"…","session_id":"…","cwd":"…","tool":"Grep","class":"text-search","detail":"<pattern or command>","out_tokens":1234,"tok_basis":"text","rung":"agent"}
```

- `class` is `codastre` (QUERY/GRAPH/REGISTER/SYNC) or `text-search` (Grep, Glob, and Bash commands invoking grep/rg/ag/ack/fd/findstr/find -name).
- `out_tokens` estimates the tool *result* size — what entered the model's context from the tool, the dominant and comparable cost of a search step.
- `tok_basis` names **which ratio produced that estimate**, because one divisor does not fit every payload:

| `tok_basis` | Chars/token | Standing |
|---|---:|---|
| `json` | 2.5 | Measured (`cl100k_base`, eight deployed responses, range 2.38–2.69) |
| `agent` | 3.0 | Measured (same sample, range 2.48–3.48) |
| `text` | 4 | **Unmeasured** — grep output, file reads and prose were never sampled. The old prose default, kept so those records carry an estimate at all |

- `rung` (Codastre calls only) names **which rung of the format ladder the call was for** —
`verbose` / `compact` / `agent` — which is a different question from which ratio fits its bytes, and
the two legitimately disagree. A client that prefers `structuredContent` shows the model only an
`agent` response's fixed summary: JSON-shaped bytes (`tok_basis: "json"`) from an agent-rung call
(`rung: "agent"`). **Read a run of `rung: "agent"` records at ~40 tokens each as the rendering being
swallowed, not as a saving** — exclude them from any median and measure the rung on the CLI plane
instead.

- `plane` (Codastre calls only) is `mcp` for a tool call and `cli` for a `codastre query|graph` shell
call, which is logged, classified and priced exactly like an MCP one. Group by it: the CLI plane
carries one copy of the payload and reaches the `agent` rung that a `structuredContent`-preferring
client swallows, so **a blended median across planes understates one side and overstates the other**.
A session that migrates mid-way from `mcp` to `cli` is following current guidance
(`retrieval-playbook.md` §2c), not misconfigured. Absent on records predating the field — say so
rather than assuming a plane.

**The old flat `chars/4` was a bug, and the direction of its error is the point.** It understated
tokens by 25–37% and understated **JSON worst** — so it flattered the expensive format in exactly
the comparison the log exists to support. When reporting a mix, name the ratios used rather than
quoting one figure; records with no `tok_basis` predate the fix and were written at the flat 4.

To summarize, aggregate with a short script (see `/codastre:tokens`): per class — call count, total/median/p90 `out_tokens`, plus top-5 largest single results. Useful framings: tokens-per-search-step (`text-search` median vs `codastre` median) and session totals.

**Honest caveats to state when reporting:** the ratios are `cl100k_base`-measured, not Claude's tokeniser and not tokenizer-exact — worth ±20% within a shape, and the `text` ratio is not measured at all; the log excludes follow-up `Read` calls that a grep workflow typically needs (so it *understates* grep's true cost); it also excludes the model's own reasoning tokens. Never present the log as billing-grade accounting.

## Pin the result set — this outranks estimator precision

**A live index is not a stable result set, and every before/after depends on one.** The same
repo-scoped query re-run hours later returns a different set: a hit dropped, another appeared, spans
and scores moved. Scoping to one repo removes federated fan-out nondeterminism; it does not remove
the index's own motion while it syncs. An unpinned comparison silently measures index drift and
reports it as a saving — and gives no signal that it has.

That is a worse failure than a biased divisor. A wrong ratio moves a number by a knowable
percentage; an unpinned result set makes the comparison mean nothing. **Fix this one first.**

Pin it, in this order of preference:

1. **One captured envelope, rendered both ways.** For anything on the *format* axis — `verbose` vs
   `compact` vs `agent`, bodies on vs off — issue **one** call, save the raw response, and derive
   every figure from that single payload. The rungs are encodings of the same result set, so
   spending two retrievals on them is not just wasteful, it's what breaks the comparison. Pinned by
   construction, not by luck.
2. **Both sides in one session, minutes apart**, when the axis genuinely needs two calls (Codastre
   vs text search; one `top_k`/filter configuration vs another). Capture back to back, report as a
   pair.
3. **Never against a quoted figure.** Do not compare a fresh measurement against a number from an
   earlier run, from this skill, or from a previous report. Re-measure both sides together or report
   neither.

Record alongside every figure: the date, `top_k`, the scoping arguments, the **format rung**, and
`freshness` from the envelope. A pair captured under `freshness: "syncing"` ran against a moving
index — say so. And read percentages **to the nearest few points, not the digit**: the arithmetic is
exact, the result set it ran on is not.

### State the format rung on both sides

`verbose` / `compact` / `agent` change a response's cost several-fold at *identical retrieval
quality*. A comparison that leaves the rung unstated is reporting an encoding difference as a
retrieval one — the same error as pitting a tuned grep against an untuned QUERY. Same rung on both
sides, or report both rungs.

## Active comparison (the A/B demo)

Run the same question through two isolated subagents (the Task/Agent tool), and **measure tokens from the log, not from the agents' self-reports** — models are unreliable at estimating their own I/O, which was the least trustworthy part of the old design.

Run the two **sequentially** under the enforced search modes (`/codastre:compare` automates this):

- **Agent A (Codastre)** under `mode=codastre`: may use only Codastre QUERY/GRAPH plus targeted Read of files those results name. The PreToolUse hook hard-blocks text search, so the constraint is enforced, not merely requested.
- **Agent B (text search)** under `mode=grep`: may use only Grep, Glob, Bash (grep/rg/find), and Read. The hook hard-blocks the Codastre tools.

Sequential (not parallel) matters twice: the two runs can't fight over the single global mode file, and each run's tool calls fall into a clean timestamp window. Bracket each agent with a `date -u` timestamp; a mode being active auto-enables tracking, so `track.js` logs every search **and** Read to the JSONL log during the window. Aggregate the log by `[start, end)` window and `class` for the measured tokens.

Both agents get the identical brief: *"Answer: <question>. Return (1) a file:line list of the relevant locations, (2) a ≤3-sentence answer, (3) a count of every tool call you made."*

Score the comparison on:

| Dimension | How |
|---|---|
| Tokens | **Measured** from the token log, scoped to each run's timestamp window and summed by class (includes the run's Reads). Fall back to the agents' self-reported sizes only if the log has no records for a window (hooks didn't fire for subagents) — and label those as estimated |
| Tool calls | Count per run from the log (or the agent's report in the fallback) — proxy for latency and orchestration overhead |
| Relevance | Judge each returned location: correct / plausible / wrong. Precision = correct/returned; note answer locations one found and the other missed |
| Answer quality | Did the ≤3-sentence answer actually answer the question? |

Fairness rules: identical wording for both agents; pick questions a real developer would ask (conceptual "where/how" questions, cross-repo questions — not literal string lookups, where grep legitimately wins and you should say so); run at least 2–3 questions before generalizing; report grep *wins* when they happen.

Two things that skew the comparison and must be controlled for (or disclosed):

- **Corpus size.** On a tiny, familiar corpus (a handful of small repos) grep is often *cheaper and equally correct* — one `rg` sweep is a few KB, and Codastre's structural advantage doesn't convert to token savings. Codastre's win grows with corpus size, repo count, and unfamiliarity — where a grep returns hundreds of matches or the developer doesn't know which repos to search. State the corpus scale in the verdict; don't generalize a toy-repo result to a monorepo.
- **A polluted tenant.** If the tenant contains a large fixture-heavy or unrelated repo, federated QUERY/GRAPH returns noise that inflates Codastre's token count and hurts its precision — an unfair handicap that reflects tenant hygiene, not the tool. Before a headline comparison, scope to the relevant repos or de-index the polluter, and note what you did.

Present results as a compact table (one row per dimension), then a 2–3 sentence verdict, e.g. "Codastre used 6.4k tokens across 3 calls vs 31k across 14 for text search, and was the only one to find the consumer in the notifications repo — because a producer/consumer link is a graph edge, not a text match."

## Comparing format rungs (the format axis)

A different question from the A/B demo: not "Codastre vs grep" but "what does the same answer cost
in `verbose` vs `agent`". It needs **no subagents and no second retrieval** — the rungs are
encodings of one result set, so two calls would only inject index drift.

**Choose the plane first — it decides whether the measurement is even possible.** If the MCP client
prefers `structuredContent` when both are present, an `agent`-format tool result reaches you as a
summary and its rendering is unmeasurable from inside the session. Don't try to price it from a
payload you can't see.

1. **CLI plane (the default).** Two Bash calls, back to back, same query and same scoping:
   `codastre query "<text>" --repo-url <url> --top-k 5 --format agent | wc -c` and the same with
   `--json`. One copy of the payload per rung, nothing hidden by a client. It is two invocations
   rather than one envelope rendered twice — the CLI can't re-render a saved envelope — so this is
   pinned by *adjacency* (rule 2 above), not by construction. Say so, and note `freshness`.
2. **MCP plane (only when the frame is the question).** Drive `codastre serve` over stdio and read
   the JSON-RPC frame directly instead of trusting what the client surfaced. Then account **both
   copies**: a tool result carries its payload twice — `content[0].text` and `structuredContent` —
   and in `agent` format the second is a fixed summary rather than a duplicate, which is where most
   of that rung's saving comes from. Counting one copy on one side and two on the other measures
   your own arithmetic.
3. **Say which plane you counted** — MCP frame (two copies) or CLI stdout (one) — and never mix a
   figure from one plane into a table built on the other.
4. Apply the ratio matching each side's shape (2.5 JSON / 3.0 rendering) — a single divisor here
   reintroduces exactly the bias these two constants exist to remove.

Report the tier, `top_k`, the scoping arguments, and the plane alongside the percentage. Reference
figures, for order-of-magnitude sanity only and **not** to measure against: at `top_k=5` on the MCP
plane the locate tier (`agent` + `snippets: false`) measured 2,234 → 391 tokens (−82%); and on one
pinned result set across both planes (`core/measurement.md`, "Cross-plane reference"), CLI
`--format agent` against MCP `verbose` measured −79% tokens with bodies off and −32% with bodies on.
The gap between those last two is the shape to remember: **the bodies-on saving is roughly a third of
the bodies-off one**, so quoting the locate tier's figure for a hydrated run overstates it by more
than 2×.

## A real four-question run, and why it doesn't yet settle "which wins"

Four Tier-B comparisons were run against a Swift-heavy iOS repo in one session (2026-08-18), varying only the
question's vocabulary shape:

| Question shape | Codastre | Text search | Cheaper | Correct? |
|---|---:|---:|---|---|
| Distinctive symbol name guessable | 11,263 | 6,683 | text search | Codastre cited a since-deleted file |
| Generic/paraphrastic terms, two valid answers | 4,066 | 11,608 | Codastre | both correct |
| Multi-hop causal chain, two similar-ranked files | 4,022 | 1,746 | text search | Codastre inferred a false link between two real hits |
| Generic/paraphrastic terms, inconsistent naming | 9,317 | 2,144 | text search | both correct; text search more complete |

Resist the temptation to name a predictor from this. Two of the four rows share the same "generic/
paraphrastic vocabulary" shape and land on opposite sides — the entering hypothesis ("paraphrastic
favors Codastre") only holds for one of them. The sample is also confounded, and the confound is now
explained: three of the four Codastre runs spent calls on `format: "agent"` that came back with
`status: "ok"` and no usable `content[0].text`, forcing a `verbose` retry — those near-zero-cost,
zero-value attempts make the affected totals look leaner than a clean run would. The cause is a
client-behaviour mismatch, not a codastre fault: `agent` puts the payload in `content[0].text` and a
fixed summary in `structuredContent`, and a client that prefers `structuredContent` when both are
present shows the model the summary alone. That makes it **systematic**, so treat it as a protocol
rule rather than a caveat: **force `format: "verbose"` from the first call on any MCP-plane comparison
run from such a client**, and never let one number mix "genuinely cheap" with "cheap because it
returned nothing." To price the ladder from such a client, measure on the **CLI plane** instead
(`codastre query --format agent`, one copy of the payload) and label the plane. What held regardless of cost: Codastre's ranking found the
right files in all four cases; both of its losses were a downstream reasoning error on top of correct
retrieval (a stale citation, a false inferred edge) — a different risk category from grep's own
failure mode (confidently anchoring on a superseded path). Report which kind of wrong it was, not
just whether it was wrong.

## Where the savings actually come from

When explaining *why* the numbers differ, use these mechanisms, not hand-waving: (1) ranking — top-10 relevant snippets vs every raw match; (2) snippets included — no per-hit Read round-trip; (3) federated scope — one call across all repos vs per-repo grep; (4) graph edges — cross-service relationships that have no textual signature; (5) semantic matching — finds code that doesn't share the query's vocabulary; (6) **encoding** — the `format` ladder repackages the same result set (paths written once per file instead of once per hit, source instead of JSON-escaped strings, a summary instead of a second copy in `structuredContent`). Keep (6) separate from (1)–(5) when reporting: the first five are retrieval advantages over text search, while encoding is a saving Codastre takes against *itself* and would flatter it if folded into the same total.

## Related

- `/codastre:tokens` — summarize the passive log
- `/codastre:compare <question>` — run the active A/B demo
- **Source of truth:** the log schema, token estimation, and tiers are defined agent-neutrally in `core/measurement.md` (monorepo root); the canonical runtime implementation is `hooks/lib.js`.

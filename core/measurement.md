# Codastre Measurement Contract (agent-neutral)

The shared, agent-neutral definition of how Codastre-vs-text-search cost is measured, so every
adapter and the benchmark harness produce comparable numbers. The **canonical runtime
implementation** for the Claude adapter is `adapters/claude/hooks/lib.js` (+ `track.js`,
`receipt.js`); a future adapter should port the same logic and log schema rather than inventing its
own. Keep this file and that implementation in sync.

## Token estimation

Estimate a tool **result** from its byte size divided by a **bytes-per-token ratio chosen by the
payload's shape**. Do not use a single divisor, and in particular do not use 4:

| Payload shape | Bytes/token | Basis |
|---|---:|---|
| JSON envelope (a QUERY/GRAPH response in `verbose` or `compact`) | **2.5** | Measured `cl100k_base` over eight deployed responses — two repos plus a federated run, `top_k` 5 to 20, bodies on and off. Observed range 2.38–2.69, pooled 2.53 |
| Agent text rendering (`format: "agent"`) | **3.0** | Same sample. Observed range 2.48–3.48, pooled 3.33 |
| Anything else — text-search output, file reads, prose | 4 (unmeasured) | The prose default, carried forward for want of a measurement. Label it as unmeasured; do not quote it alongside the two above as if it had the same standing |

**Why two constants and not one.** A JSON envelope is dense in the tokeniser's worst input — long
hex ids, quoted keys, escaped newlines — while a rendering is mostly paths and identifiers, which
pack well. Bytes per token therefore *rises* along the format ladder, so a single divisor understates
JSON and overstates the rendering: it biases exactly the comparison the estimate exists to support.

**This was a shipped bug, and the direction of the error is the lesson.** The prose `bytes/4` figure
understated tokens by 25–37%, and understated **JSON worst** — so it flattered the expensive format
in the one comparison the number is for. A biased estimator is worse than a coarse one when the
whole point is a before/after.

Standing caveats, to state whenever these numbers are reported: `cl100k_base` is not Claude's
tokeniser (same family, so the ordering holds and magnitudes may move); within a shape the spread is
corpus-dependent — repeated long path prefixes merge well and push the ratio up — so any single
figure is worth **±20%** and the output keeps its `~`. Never present any of it as billing-grade.

## Pinning the result set

**A live index is not a stable result set, and every before/after depends on one.** The same
repo-scoped query re-run hours later returns a different set — a hit dropped, another appeared, spans
and scores moved. Repo-scoping removes federated fan-out nondeterminism; it does not remove the
index's own motion while it syncs. An unpinned comparison silently measures index drift and reports
it as a saving.

This outranks estimator precision. A biased divisor moves a number by a knowable percentage; an
unpinned result set makes the comparison mean nothing, and gives no signal that it has.

Pin it, in this order of preference:

1. **One captured envelope, rendered both ways.** For anything on the *format* axis — verbose vs
   compact vs agent — issue **one** call, save the raw response, and derive every figure from that
   single payload. The rungs are encodings of the same result set, so there is never a reason to
   spend two retrievals on them. This is the only method that is pinned by construction rather than
   by luck.
2. **Both sides in one session, minutes apart**, when the axis genuinely needs two calls (Codastre
   vs text search, one configuration vs another). Capture them back to back and report them as a
   pair.
3. **Never against a quoted figure.** Do not compare a fresh measurement to a number from an earlier
   run, this document, or a previous report. Re-measure both sides together or report neither.

Record with every figure: the date, `top_k`, the scoping arguments, and `freshness` from the
envelope. A pair captured under `freshness: "syncing"` is a pair captured against a moving index —
say so. And read the percentages **to the nearest few points, not the digit**: the arithmetic is
exact, the result set it ran on is not.

What counts as the cost of a search step is the tool **result** size — the tokens that entered the
model's context. Reasoning tokens are excluded. Follow-up file reads *are* counted when a mode is
active (so a text-search workflow's reads aren't hidden), which means the log **understates** text
search's cost when tracking is passive/off.

## Log schema (JSONL, one record per search-related tool call)

```json
{"ts":"<ISO-8601>","session_id":"…","cwd":"…","tool":"Grep","class":"text-search","plane":"cli","detail":"<pattern or command or query>","out_tokens":1234,"tok_basis":"text","rung":"agent"}
```

- `class` ∈ { `codastre` (QUERY/GRAPH/REGISTER/SYNC **and** `codastre query|graph` run through a
  shell), `text-search` (grep/glob and shell grep/rg/ag/ack/fd/findstr/`git grep`/`find -name`),
  `read` (file reads, logged only while an A/B mode is active) }.
- `plane` ∈ { `mcp`, `cli` } — Codastre records only. `cli` is a `codastre query|graph` shell call;
  `mcp` is a tool call. **This exists because the two are not interchangeable in a sum:** the CLI
  carries one copy of the payload and reaches the `agent` rung on clients that swallow it over MCP
  (`retrieval-playbook.md` §2c), so a mixed total with no plane breakdown hides which plane produced
  the number. Absent on records written before the field, and on non-Codastre classes.
- `detail` is the query text / symbol / topic (codastre), the pattern (grep/glob), or a truncated
  command (shell). Never the file's contents.
- `out_tokens` is the result-size estimate, derived with the shape-appropriate ratio above.
- `tok_basis` ∈ { `json` (2.5), `agent` (3.0), `text` (4, unmeasured) } records **which ratio was
  used**, so an aggregation is never blind to the mix it is summing and a later re-derivation does
  not have to guess. Absent on records written before the field existed — treat those as `text`.
- `rung` ∈ { `verbose`, `compact`, `agent` } records **which rung of the format ladder the call was
  for** — a different question from `tok_basis`, and the two legitimately disagree. When a client
  prefers `structuredContent` and shows the model only an `agent` response's fixed summary, those
  bytes are JSON-shaped (`tok_basis: "json"`) but the call was an agent-rung call
  (`rung: "agent"`). Recording only the ratio would make that attempt indistinguishable from a
  `verbose` call. Codastre calls only; absent when neither the response nor the request named a
  rung, and on records predating the field.
  **The pattern to read off it:** a run of `rung: "agent"` records at ~40 tokens each is the
  rendering being swallowed before it reached the model — not a spectacular saving. Real agent-rung
  calls carry their payload.

The log self-rotates to a single `.1` backup past a size cap so it never grows unbounded.

## Search-classification (what is a "text search")

A shell command counts as a text search when it invokes a search tool at a command boundary
(start, after `|`, `;`, `&`, `(`, or inside `$(…)`/backtick substitution): `grep`, `rg`, `ag`,
`ack`, `fd`, `findstr`; **or** `git grep` anywhere; **or** `grep` reached via `xargs`; **or**
`find … -name` (with the path argument optional). Codastre tool calls match the MCP tool name
pattern for QUERY/GRAPH/REGISTER/SYNC. This regex must live in exactly one place per adapter and be
imported by every consumer (enforcement, tracking, nudges) so the three can't drift.

**A `codastre query|graph` shell call is Codastre, not a text search, and is tested first.** It is
matched by its own pattern — the `codastre` binary (optionally path-qualified, optionally `.exe`)
followed by `query` or `graph`, at a command boundary — and that test runs *before* the text-search
one, because `codastre query … | grep x` matches both. Three consequences, all required for the CLI
plane to be measurable at all: Codastre-only mode must not block it; **Codastre-free mode must block
it** (otherwise the text-search arm can reach Codastre through a plane the enforcement wasn't
watching, and the A/B silently leaks); and a codastre-first mode must count it as the Codastre
attempt that unlocks a text-search fallback.

## Three measurement tiers (report the tier and its caveats)

| Tier | Measures | Inference | Where |
|---|---|---|---|
| **A — scripted** | Raw data-plane efficiency + correctness of a *fixed* recipe | none | `benchmarks/run.py` |
| **B — agentic A/B** | End-to-end agent cost incl. reasoning + tool choice | 2 subagents | the adapter's compare command |
| **C — live, user-judged** | *Your* question on *your* corpus, one at a time | 1 agent | the adapter's mode + receipt |

- **Tier A** is the CI-friendly default: deterministic, catches data-plane regressions without agent
  variance. It scores a fixed recipe, so it can't reward "one call answers it" ergonomics beyond call
  counts. The shipped suite deliberately includes a literal-string case that text search *wins*.
- **Tier B** answers "does the agent pick and phrase well?". Measure tokens from the log by
  timestamp window (deterministic), not from agent self-reports; fall back to self-report only when a
  window has no logged records, and label it.
- **Tier C** is the most honest demo but is one question and subject to run-to-run variance.
- **All three tiers require a pinned result set** (above). Tier A is pinned by its fixed recipe;
  Tiers B and C are not pinned by anything and must pin themselves — one captured envelope for a
  format-axis comparison, both arms back to back for a tool-axis one.

## Reference costs (measured — one question, one repo)

A worked end-to-end comparison including the follow-up reads each configuration needed. Useful as a
budget model and as a sanity check that a fresh measurement is in the right order of magnitude —
**not** a distribution: one question, one repo, one trial per configuration.

**Do not measure against this table.** Its rows were captured on a moving index at an earlier date
and under the `verbose` rung, and its token figures were derived with the old `bytes/4` divisor, so
they understate tokens by roughly a quarter to a third. It is an order-of-magnitude sanity check and
nothing more; a fresh comparison re-measures both of its own sides.

| Configuration | QUERY | Reads | Total | Calls | Found the live implementation? |
|---|---:|---:|---:|---:|---|
| `top_k=10` (default), worst run | 11,625 | 0 | **11,625** | 2 | Yes, but cited a wrong line number |
| `top_k=10` (default) | 6,023 | 607 | **6,630** | 3 | Yes |
| text search | — | 1,214 | **3,834** | 4 | **No — reported a legacy path as live** |
| `top_k=6` + `language` | 3,067 | 262 | **3,329** | 2 | Yes — most complete |
| `top_k=4` | 1,573 | 504 | **2,077** | 3 | Yes |
| text search, second run | — | — | **1,728** | 4 | **No — reported a legacy path as live** |

Three things this table exists to prevent:

1. **Quoting "search costs less than grep" unconditionally.** At the *default* it did not, in this
   experiment; at `top_k=4–6` it did. State the configuration alongside the claim.
2. **Reading the cost gap as the value gap.** Both text-search runs were cheap and *wrong* — they
   anchored on a superseded legacy path and never found the live one. The failure mode was silent
   staleness, not noise. Report cost and correctness together, or the cheap-and-wrong row reads as a
   win.
3. **Comparing a tuned grep against an untuned QUERY** — see the fairness rules below.

Per-hit cost, same run: `top_k=10` unfiltered → 602 tokens/hit; `top_k=4` → 393; `top_k=6` +
`language` → 511. Filtering *raised* cost per hit while improving the result set, so a filter is a
precision control, not a cost control — an A/B that treats it as one will draw the wrong conclusion.

Caveat carried from the source measurement: `out_tokens` captures tool-result size only. Each extra
round-trip also re-processes the conversation prefix as input tokens, so a 1-call/6k design can beat
a 4-call/2k design on true total spend. Measure input tokens before concluding that more, smaller
calls are cheaper.

## Fairness rules (all tiers)

- **Pin the result set, and say how you pinned it.** See above. A comparison that cannot say which
  call its two sides came from is not a measurement.
- **State the plane as well as the rung.** MCP and CLI are different measurement planes for the
  same retrieval: an MCP frame carries the payload twice, a CLI call writes it once to stdout, and
  the `agent` rung arrives on one of them and not the other on a `structuredContent`-preferring
  client. Cross-plane figures are legitimate — they are what an agent actually pays — but they must
  be labelled as cross-plane, and never averaged into a same-plane before/after.
- **State the format rung on both sides.** `verbose` / `compact` / `agent` change a response's cost
  several-fold at identical retrieval quality, so a comparison that leaves the rung unstated is
  reporting an encoding difference as a retrieval one. Same rule as tuning both sides: same rung on
  both, or report both rungs.
- **Tune both sides, or neither.** A default-configured QUERY against a hand-tuned grep flatters
  grep: the default is `top_k=10` with no filters, which pays for several hits nobody reads. Run the
  configuration a competent caller would use (`top_k=4–6`, plus a language/path filter when the
  target is known), or report the default *and* the tuned run. Say which you did.
- **Don't accept an agent's location list uncritically.** In one text-search run the agent cited a
  file it never opened, inferring it from a reference elsewhere. Spot-check cited lines by reading
  them before counting them as coverage — an unverified citation inflates whichever side made it.
- Identical wording for both sides of an A/B.
- Pick questions a real developer would ask — conceptual/cross-repo, not literal-string lookups where
  text search legitimately wins (and say so when it does).
- State the **corpus scale**: on a tiny, clean corpus text search is often cheaper and equally
  correct; Codastre's margin grows with corpus size, repo count, and cross-repo structure. Don't
  generalize a toy-repo result to a monorepo.
- Disclose a **polluted tenant**: a large fixture-heavy/unrelated repo inflates federated Codastre
  cost and hurts precision — scope or de-index it before a headline comparison and note what you did.

## Field observation (2026-08-18): four Tier-B runs, one repo, no reliable pattern yet

Four `/codastre:compare`-style runs against a single-repo, Swift-heavy iOS corpus, each
side tuned per the fairness rules above (`top_k` 6, `language: "swift"` forced on Codastre,
identical wording, both arms captured minutes apart). Measured from the token log, not self-report.

| Question shape | Codastre tokens | Text-search tokens | Cheaper | Correct? |
|---|---:|---:|---|---|
| Distinctive symbol name guessable (SCA challenge trigger) | 11,263 | 6,683 | text search | Codastre cited one now-deleted file (superseded by a recent refactor) |
| Generic/paraphrastic terms, two valid call sites (card limit change) | 4,066 | 11,608 | Codastre | both correct |
| Multi-hop causal chain, two similarly-ranked candidate files (push-token registration) | 4,022 | 1,746 | text search | **Codastre wrong** — see the chain-mis-attribution failure mode in `retrieval-playbook.md` §5 |
| Generic/paraphrastic terms, inconsistent naming (app-rating prompt) | 9,317 | 2,144 | text search | both correct; text search found more call sites |

**Do not treat "generic/paraphrastic vocabulary favors Codastre" as established** — that was the
working hypothesis going in, and only one of the two paraphrastic-question rows confirms it; the
other (rating prompt) went the other way by a wide margin. Four questions, one repo, one session is
far below the sample needed to name a predictor.

**This sample is also confounded, the confound cuts one way, and it is now explained.** Three of the
four Codastre runs spent calls on `format: "agent"` that returned no usable content — ~41 tokens
each, zero value — before falling back to `verbose`. Those near-zero-cost, zero-value calls make the
affected rows' totals *look* leaner than a clean run at a working rung would have.

The cause was identified on 2026-08-18 and is not a codastre fault: in `agent` format the payload is
in `content[0].text` while `structuredContent` holds a fixed summary, and this MCP client prefers
`structuredContent` when both are present, so the model received the summary alone
(`retrieval-playbook.md` §2c has the frame-level evidence). That makes it **systematic, not
sporadic** — which changes the follow-up from "see if it reproduces" to a protocol rule:

> **Force `format: "verbose"` from the first call on any MCP-plane comparison run from a client that
> swallows the rendering, and say so in the report.** Never let a comparison mix "genuinely cheap"
> with "cheap because the call returned nothing" in one number.

The four rows above should be re-run under that rule before anything is concluded from them. And
note what the explanation does *not* license: it does not mean the ladder's saving is unavailable
here — it means the saving has to be taken on the CLI plane (`codastre query --format agent`), which
is a different measurement plane and must be labelled as one — and is now measured on a pinned
result set, in the cross-plane table below.

What *did* hold across all four: Codastre reliably found the right **files**; the two "text search
wins" rows both trace to a downstream reasoning failure on Codastre's side (a stale citation, a wrong
inferred edge between two real files), not to the ranking missing the target. That is a different
risk profile from grep's known failure mode (silent staleness — anchoring on a superseded path
without knowing it), and worth tracking as its own category rather than folding into "wrong result."

## Cross-plane reference (2026-08-18, pinned): what each plane actually delivers

The one measurement behind "prefer the CLI plane while the MCP `agent` rung is swallowed"
(`retrieval-playbook.md` §2c). Pinned the only way a cross-plane comparison can be: **one query, one
repo, `top_k=5`, all arms in one session, the five hits verified identical across arms.** MCP figures
are whole JSON-RPC frames captured by driving `codastre serve` over stdio (the same method that
root-caused the swallowed rendering); CLI figures are stdout bytes. Tokens are derived, not counted —
JSON at 2.5 ch/tok, the rendering at 3.0, per "Token estimation" above.

| bodies | plane and rung | on the wire | reaches the model | ~tokens |
|---|---|---:|---|---:|
| on | MCP `verbose` | 15,572 B (7,485 + 7,965 — twice) | one copy, JSON | ~3,186 |
| on | MCP `agent` | 6,917 B | the 111 B summary — no results | ~44 |
| on | CLI `--format agent --snippets` | 6,483 B | the rendering | ~2,161 |
| off | MCP `verbose` + `snippets: false` | 5,208 B (2,436 + 2,566) | one copy, JSON | ~1,026 |
| off | MCP `agent` + `snippets: false` | 863 B | the 111 B summary — no results | ~44 |
| off | CLI `--format agent` | 648 B | the rendering | ~216 |

How to quote it, and how not to:

- **The CLI-vs-MCP-`verbose` saving is −32% tokens with bodies on and −79% with bodies off.** The gap
  between those two is the point, and it is the same ordering the ladder's own table shows: the
  envelope overhead a rendering removes is most of a bodies-off response and a minority of a
  bodies-on one. Quoting the −79% for a bodies-on run overstates it by more than 2×.
- **Don't credit the plane with the rung's saving.** The CLI rendering and the MCP `agent` rendering
  are the same bytes (6,483 vs 6,484). The CLI is cheaper *on the wire* because stdout carries one
  copy, and it is the plane where the rendering *arrives* on this client — that is the argument for
  it, not a per-token advantage over a working `agent` rung.
- **The ~44-token rows are not a saving**, they are the failure documented in §2c: a successful call
  whose results never reached the model. Exclude them from any per-call median.
- One query, one repo, one day, one tokeniser family (`cl100k_base`). Read to the nearest few points.
  A live index moves, so re-measure both planes together rather than against these numbers.

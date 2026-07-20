# Codastre Measurement Contract (agent-neutral)

The shared, agent-neutral definition of how Codastre-vs-text-search cost is measured, so every
adapter and the benchmark harness produce comparable numbers. The **canonical runtime
implementation** for the Claude adapter is `adapters/claude/hooks/lib.js` (+ `track.js`,
`receipt.js`); a future adapter should port the same logic and log schema rather than inventing its
own. Keep this file and that implementation in sync.

## Token estimation

Estimate a tool **result** at **~4 characters per token** (`ceil(len(text)/4)`). It is a stable
cross-model approximation for code/text — not tokenizer-exact, and fine for the relative comparisons
that are the point. Always disclose it as an estimate; never present it as billing-grade.

What counts as the cost of a search step is the tool **result** size — the tokens that entered the
model's context. Reasoning tokens are excluded. Follow-up file reads *are* counted when a mode is
active (so a text-search workflow's reads aren't hidden), which means the log **understates** text
search's cost when tracking is passive/off.

## Log schema (JSONL, one record per search-related tool call)

```json
{"ts":"<ISO-8601>","session_id":"…","cwd":"…","tool":"Grep","class":"text-search","detail":"<pattern or command or query>","out_tokens":1234}
```

- `class` ∈ { `codastre` (QUERY/GRAPH/REGISTER/SYNC), `text-search` (grep/glob and shell
  grep/rg/ag/ack/fd/findstr/`git grep`/`find -name`), `read` (file reads, logged only while an A/B
  mode is active) }.
- `detail` is the query text / symbol / topic (codastre), the pattern (grep/glob), or a truncated
  command (shell). Never the file's contents.
- `out_tokens` is the ~4-chars/token result estimate.

The log self-rotates to a single `.1` backup past a size cap so it never grows unbounded.

## Search-classification (what is a "text search")

A shell command counts as a text search when it invokes a search tool at a command boundary
(start, after `|`, `;`, `&`, `(`, or inside `$(…)`/backtick substitution): `grep`, `rg`, `ag`,
`ack`, `fd`, `findstr`; **or** `git grep` anywhere; **or** `grep` reached via `xargs`; **or**
`find … -name` (with the path argument optional). Codastre tool calls match the MCP tool name
pattern for QUERY/GRAPH/REGISTER/SYNC. This regex must live in exactly one place per adapter and be
imported by every consumer (enforcement, tracking, nudges) so the three can't drift.

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

## Fairness rules (all tiers)

- Identical wording for both sides of an A/B.
- Pick questions a real developer would ask — conceptual/cross-repo, not literal-string lookups where
  text search legitimately wins (and say so when it does).
- State the **corpus scale**: on a tiny, clean corpus text search is often cheaper and equally
  correct; Codastre's margin grows with corpus size, repo count, and cross-repo structure. Don't
  generalize a toy-repo result to a monorepo.
- Disclose a **polluted tenant**: a large fixture-heavy/unrelated repo inflates federated Codastre
  cost and hurts precision — scope or de-index it before a headline comparison and note what you did.

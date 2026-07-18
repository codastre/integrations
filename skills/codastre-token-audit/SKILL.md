---
name: codastre-token-audit
description: This skill should be used when the user asks to measure, demonstrate, or compare the cost/benefit of Codastre versus plain text search — "how many tokens did search use", "show the savings", "is codastre actually worth it", "compare codastre vs grep", or when running /codastre:tokens or /codastre:compare. It defines the measurement methodology so numbers are honest and reproducible.
---

# Codastre Token Audit

Two ways to quantify Codastre's benefit over a grep/find/rg workflow: **passive tracking** (a hook logs every search tool call's result size) and **active comparison** (run the same information need both ways in isolated subagents and compare). Always report both tokens *and* relevance — a cheap search that misses the answer saved nothing.

## Passive tracking (the token log)

When `CODASTRE_TRACK_TOKENS=1` is set, a PostToolUse hook appends one JSONL record per search call to `~/.config/codastre/claude-token-log.jsonl` (override: `CODASTRE_TOKEN_LOG`):

```json
{"ts":"…","session_id":"…","cwd":"…","tool":"Grep","class":"text-search","detail":"<pattern or command>","out_tokens":1234}
```

- `class` is `codastre` (QUERY/GRAPH/REGISTER/SYNC) or `text-search` (Grep, Glob, and Bash commands invoking grep/rg/ag/ack/fd/findstr/find -name).
- `out_tokens` estimates the tool *result* size at ~4 characters/token. It measures what entered the model's context from the tool — the dominant, comparable cost of a search step.

To summarize, aggregate with a short script (see `/codastre:tokens`): per class — call count, total/median/p90 `out_tokens`, plus top-5 largest single results. Useful framings: tokens-per-search-step (`text-search` median vs `codastre` median) and session totals.

**Honest caveats to state when reporting:** estimates are chars/4, not tokenizer-exact; the log excludes follow-up `Read` calls that a grep workflow typically needs (so it *understates* grep's true cost); it also excludes the model's own reasoning tokens. Never present the log as billing-grade accounting.

## Active comparison (the A/B demo)

For a compelling demonstration, run the same question through two isolated subagents (the Task/Agent tool) **in parallel**, so neither pollutes the main context:

- **Agent A (Codastre):** may use only Codastre QUERY/GRAPH plus targeted Read of files those results name. Explicitly forbidden: Grep, Glob, and shell search commands.
- **Agent B (text search):** may use only Grep, Glob, Bash (grep/rg/find), and Read. Explicitly forbidden: any Codastre MCP tool.

Both get the identical brief: *"Answer: <question>. Return (1) a file:line list of the relevant locations, (2) a ≤3-sentence answer, (3) a count of every tool call you made."*

Score the comparison on:

| Dimension | How |
|---|---|
| Tokens | Each agent's reported token usage from the task result; else the token-log delta for the run; else sum of per-call result sizes each agent reports |
| Tool calls | Count per agent — proxy for latency and orchestration overhead |
| Relevance | Judge each returned location: correct / plausible / wrong. Precision = correct/returned; note answer locations one found and the other missed |
| Answer quality | Did the ≤3-sentence answer actually answer the question? |

Fairness rules: identical wording for both agents; pick questions a real developer would ask (conceptual "where/how" questions, cross-repo questions — not literal string lookups, where grep legitimately wins and you should say so); run at least 2–3 questions before generalizing; report grep *wins* when they happen.

Present results as a compact table (one row per dimension), then a 2–3 sentence verdict, e.g. "Codastre used 6.4k tokens across 3 calls vs 31k across 14 for text search, and was the only one to find the consumer in the notifications repo — because a producer/consumer link is a graph edge, not a text match."

## Where the savings actually come from

When explaining *why* the numbers differ, use these mechanisms, not hand-waving: (1) ranking — top-10 relevant snippets vs every raw match; (2) snippets included — no per-hit Read round-trip; (3) federated scope — one call across all repos vs per-repo grep; (4) graph edges — cross-service relationships that have no textual signature; (5) semantic matching — finds code that doesn't share the query's vocabulary.

## Related

- `/codastre:tokens` — summarize the passive log
- `/codastre:compare <question>` — run the active A/B demo

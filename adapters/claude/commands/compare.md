---
description: A/B demo — answer one question with Codastre vs text search, compare tokens (measured, not self-reported) and relevance
argument-hint: <question about the codebase>
allowed-tools: Bash(codastre:*), Bash(mkdir:*), Bash(printf:*), Bash(rm:*), Bash(cat:*), Bash(date:*), Bash(python3:*), Task
---

Run the active A/B comparison from the `codastre-token-audit` skill for: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for a question first — a good one is conceptual or cross-repo ("where do we retry failed payments", "what consumes the orders topic"), not a literal string lookup.

This command **measures tokens from the token log** (deterministic, same source as live mode) instead of asking the sub-agents to estimate their own I/O — models are unreliable at that. It runs the two agents **sequentially** under the enforced search modes, so (a) the PreToolUse hook actually constrains each agent's tools and (b) the two runs can't fight over the single global mode file.

### Protocol

0. **Pin and record the context.** The two arms must be comparable, so before running anything note: the date, the corpus scale, and the **format rung** the Codastre arm will use. The sequential protocol below already pins the two arms to one session minutes apart — that is the pinning this axis can have, since the two arms genuinely need two calls. What it cannot pin is the index itself: check `freshness` in the Codastre arm's envelope and say so if it reports `syncing`. **Never compare either arm's number against a figure from an earlier run or quoted from a report** — a re-run hours later returns a different result set, and the drift reads as a saving.

1. **Enable measurement.** The A/B modes auto-activate tracking (track.js logs while a mode is set), so no env change is needed. Note the log path: `${CODASTRE_TOKEN_LOG:-$HOME/.config/codastre/claude-token-log.jsonl}`.
2. **Codastre run.** Bash: `date -u +%Y-%m-%dT%H:%M:%S.000Z` → save as `T0`. Set mode: `mkdir -p "$HOME/.config/codastre" && printf '%s' codastre > "$HOME/.config/codastre/search-mode"`. Then launch **one** sub-agent (Task) with Agent A's brief below. After it returns, Bash `date -u …` → `T1`.
3. **Text-search run.** Set mode: `printf '%s' grep > "$HOME/.config/codastre/search-mode"`. Launch **one** sub-agent with Agent B's brief. After it returns, Bash `date -u …` → `T2`.
4. **Restore.** `rm -f "$HOME/.config/codastre/search-mode"`.
5. **Aggregate from the log** with one `python3` Bash call: read the JSONL log, keep records with `T0 ≤ ts < T1` as the **Codastre** run and `T1 ≤ ts < T2` as the **text-search** run; per run sum `out_tokens` by `class` (`codastre` / `text-search` / `read`) and count calls, splitting the `codastre` class by `plane` (`cli` / `mcp`) so a mixed arm is visible rather than averaged. These are the measured numbers — use them, not the agents' self-reports.

Agent A — "codastre":
> Answer this question about the codebase: <question>. You MUST search only with Codastre — either the MCP tools (QUERY, GRAPH) or the `codastre query` / `codastre graph` CLI through Bash, whichever the plane instruction below names — plus Read strictly for files those results name. You MUST NOT use Grep, Glob, or any shell text-search command (grep/rg/find/ag/fd). Return: (1) a file:line list of relevant locations, (2) an answer in ≤3 sentences, (3) a count of every tool call you made, listing each tool name.

Add to Agent A's brief, so the A/B compares a tuned QUERY against a tuned grep rather than an untuned one (the default `top_k=10` with no filters pays for several hits nobody reads, which flatters grep):

> Pass `top_k: 6` unless the question is genuinely survey-shaped, and pass `language` or `path_prefix` when the target language/subtree is evident from the question. Suppress bodies (`snippets: false` / omit `--snippets`) only if the ranking alone answers the question. Run on the plane and rung named below and do not experiment with others. That is the configuration a competent caller uses.

**Which plane and rung Agent A runs at — decided here, not by the subagent.** Never tell Agent A to "try `format: "agent"`" over MCP. In `agent` format the payload is in `content[0].text` and `structuredContent` is a fixed summary, and Claude Code prefers `structuredContent` when both are present, so the model gets the summary alone — verified 2026-08-18 (`codastre` v0.14.0). A subagent that tries it burns a call for nothing and then retries at `verbose`, which lands in the token log as a real cost with no answer attached. Three of four earlier field runs did exactly that, and it is why their Codastre totals are uninterpretable (`core/measurement.md`, "Field observation 2026-08-18").

So decide the plane yourself, once, with one cheap Bash call **before** `T0` so it never lands in the measured window:

```bash
codastre version          # v0.14.0+ → CLI plane. Older → MCP verbose.
```

- **v0.14.0+ → tell Agent A to run the CLI plane**: `codastre query "<text>" --top-k 6 [--language X] [--path-prefix P] --format agent --snippets` (drop `--snippets` only for a locate-tier question; the CLI's default is bodies off). This is now *inside* the measurement, not beside it: a `codastre query|graph` Bash call is logged as `class: "codastre"` with `plane: "cli"` and priced at the rendering's ratio, so the arm's total is complete.
- **Older binary → tell Agent A to use the MCP tools at `format: "verbose"`** and to not attempt `agent` at all. Report the arm's cost as an **upper bound**, and say in one line that `--format agent` / `--snippets` need v0.14.0+ so the cheap rung was unreachable on this machine.

Then **state the plane and the rung in the report** — they change a response's cost several-fold at identical retrieval quality, so a comparison that leaves either unsaid is reporting an encoding difference as a retrieval one. A CLI-plane arm is one copy of the payload; an MCP arm's frame carries two. **Never report a `verbose` Codastre arm against an `agent` figure quoted from elsewhere**, and never mix the two planes' numbers into one cell — label which produced the total (`core/measurement.md`, "Cross-plane reference").

Agent B — "text-search":
> Answer this question about the codebase: <question>. You MUST use only Grep, Glob, Bash text-search commands (grep/rg/find), and Read. You MUST NOT use any Codastre or MCP tool, even if a reminder suggests it. Return: (1) a file:line list of relevant locations, (2) an answer in ≤3 sentences, (3) a count of every tool call you made, listing each tool name.

### Variant: the format axis (`$ARGUMENTS` names a rung, not a question)

If the user is asking what the *encoding* costs — "verbose vs agent", "what does agent format save"
— this is a different measurement and the two-subagent protocol above is the wrong tool. Rungs are
encodings of one result set, so a second retrieval would only inject index drift.

**Pick the plane first, because it decides the method.** You cannot price this axis from an MCP tool
result you can only partly see: if the client prefers `structuredContent`, the `agent` rendering never
reaches you and its size is unmeasurable from inside the session.

**CLI plane (default — use this unless the question is specifically about the MCP frame).** One Bash
call per rung, back to back:

```bash
codastre query "<text>" --repo-url <url> --top-k 5 --format agent | wc -c
codastre query "<text>" --repo-url <url> --top-k 5 --json         | wc -c
```

One copy of the payload per rung, nothing hidden. This is two invocations, not one envelope rendered
twice — the CLI can't re-render a saved envelope — so it is pinned by *adjacency* (`measurement.md`,
rule 2), and a moving index can put the two rungs on slightly different result sets. Say so.

**MCP plane (only when the frame itself is the question).** Drive the proxy directly and read the
frame, rather than trusting what the client surfaced: `codastre serve` over stdio, `initialize` +
`notifications/initialized` + one `tools/call` per rung, and measure `content[0].text` and
`structuredContent` off each response. Then count **both copies** — a tool result carries its payload
twice, and in `agent` format the second is a fixed summary rather than a duplicate, which is most of
that rung's saving. Counting one copy on one side and two on the other measures your own arithmetic.

Either way: apply the ratio matching each side's shape — JSON ~2.5 chars/token, agent rendering ~3.0.
One divisor across both reintroduces the bias the two constants exist to remove. And where a rung
genuinely can't be measured on the plane you chose, report it unavailable rather than substituting the
other plane's figure.

Report the tier, `top_k`, scoping arguments, plane and `freshness` beside the percentage, to the
nearest few points. See the `codastre-token-audit` skill for the reference figures and what they're
worth.

### Score and report

- **Tokens**: from the log aggregation (step 5) — the file `Read`s each run made are counted too, so a grep workflow's follow-up reads are attributed, not hidden. If the log shows **zero** records for a window (e.g. the harness didn't fire hooks for sub-agent tool calls), say so and fall back to the agents' self-reported tool counts, clearly labeling the numbers as estimated rather than measured.
- **Tool calls**: per run, from the log (or the agent's report in the fallback).
- **Relevance**: judge each returned location correct / plausible / wrong. **Verify by Reading the cited lines — do not take either agent's list at face value.** An agent will sometimes cite a file it never opened, inferring it from a reference elsewhere; counting that as coverage inflates whichever side made it. A location that is real but *superseded* (a legacy path the live code no longer routes through) is **wrong**, not plausible — silent staleness is the failure mode text search actually has, and scoring it as a hit hides the thing worth measuring. Note locations one agent found and the other missed, especially cross-repo ones.
- **Answer quality**: did the ≤3-sentence answer actually answer the question?

**Report** a compact table — rows: tokens (measured), tool calls, locations returned, precision, unique correct finds, answer verdict; columns: Codastre / Text search — then a 2–3 sentence verdict explaining *why* the numbers differ (ranking, inline snippets, federation, graph edges, semantic match). If text search won, say so plainly and when that's expected (literal strings, small trees). Close with the caveat that this is one question and to repeat with 2–3 diverse questions before generalizing.

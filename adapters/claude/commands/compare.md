---
description: A/B demo — answer one question with Codastre vs text search, compare tokens (measured, not self-reported) and relevance
argument-hint: <question about the codebase>
allowed-tools: Bash(mkdir:*), Bash(printf:*), Bash(rm:*), Bash(cat:*), Bash(date:*), Bash(python3:*), Task
---

Run the active A/B comparison from the `codastre-token-audit` skill for: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for a question first — a good one is conceptual or cross-repo ("where do we retry failed payments", "what consumes the orders topic"), not a literal string lookup.

This command **measures tokens from the token log** (deterministic, same source as live mode) instead of asking the sub-agents to estimate their own I/O — models are unreliable at that. It runs the two agents **sequentially** under the enforced search modes, so (a) the PreToolUse hook actually constrains each agent's tools and (b) the two runs can't fight over the single global mode file.

### Protocol

1. **Enable measurement.** The A/B modes auto-activate tracking (track.js logs while a mode is set), so no env change is needed. Note the log path: `${CODASTRE_TOKEN_LOG:-$HOME/.config/codastre/claude-token-log.jsonl}`.
2. **Codastre run.** Bash: `date -u +%Y-%m-%dT%H:%M:%S.000Z` → save as `T0`. Set mode: `mkdir -p "$HOME/.config/codastre" && printf '%s' codastre > "$HOME/.config/codastre/search-mode"`. Then launch **one** sub-agent (Task) with Agent A's brief below. After it returns, Bash `date -u …` → `T1`.
3. **Text-search run.** Set mode: `printf '%s' grep > "$HOME/.config/codastre/search-mode"`. Launch **one** sub-agent with Agent B's brief. After it returns, Bash `date -u …` → `T2`.
4. **Restore.** `rm -f "$HOME/.config/codastre/search-mode"`.
5. **Aggregate from the log** with one `python3` Bash call: read the JSONL log, keep records with `T0 ≤ ts < T1` as the **Codastre** run and `T1 ≤ ts < T2` as the **text-search** run; per run sum `out_tokens` by `class` (`codastre` / `text-search` / `read`) and count calls. These are the measured numbers — use them, not the agents' self-reports.

Agent A — "codastre":
> Answer this question about the codebase: <question>. You MUST use only the Codastre MCP tools (QUERY, GRAPH) to search, plus Read strictly for files those results name. You MUST NOT use Grep, Glob, or any shell search command (grep/rg/find/ag/fd). Return: (1) a file:line list of relevant locations, (2) an answer in ≤3 sentences, (3) a count of every tool call you made, listing each tool name.

Agent B — "text-search":
> Answer this question about the codebase: <question>. You MUST use only Grep, Glob, Bash text-search commands (grep/rg/find), and Read. You MUST NOT use any Codastre or MCP tool, even if a reminder suggests it. Return: (1) a file:line list of relevant locations, (2) an answer in ≤3 sentences, (3) a count of every tool call you made, listing each tool name.

### Score and report

- **Tokens**: from the log aggregation (step 5) — the file `Read`s each run made are counted too, so a grep workflow's follow-up reads are attributed, not hidden. If the log shows **zero** records for a window (e.g. the harness didn't fire hooks for sub-agent tool calls), say so and fall back to the agents' self-reported tool counts, clearly labeling the numbers as estimated rather than measured.
- **Tool calls**: per run, from the log (or the agent's report in the fallback).
- **Relevance**: judge each returned location correct / plausible / wrong (spot-check by Reading cited lines if unsure). Note locations one agent found and the other missed — especially cross-repo ones.
- **Answer quality**: did the ≤3-sentence answer actually answer the question?

**Report** a compact table — rows: tokens (measured), tool calls, locations returned, precision, unique correct finds, answer verdict; columns: Codastre / Text search — then a 2–3 sentence verdict explaining *why* the numbers differ (ranking, inline snippets, federation, graph edges, semantic match). If text search won, say so plainly and when that's expected (literal strings, small trees). Close with the caveat that this is one question and to repeat with 2–3 diverse questions before generalizing.

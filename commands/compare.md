---
description: A/B demo — answer one question with Codastre vs text search, compare tokens and relevance
argument-hint: <question about the codebase>
---

Run the active A/B comparison defined in the `codastre-token-audit` skill for: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for a question first — a good one is conceptual or cross-repo ("where do we retry failed payments", "what consumes the orders topic"), not a literal string lookup.

**Launch two subagents in parallel (one message, two Task calls), with identical briefs except for tooling:**

Agent A — "codastre":
> Answer this question about the codebase: <question>. You MUST use only the Codastre MCP tools (QUERY, GRAPH) to search, plus Read strictly for files those results name. You MUST NOT use Grep, Glob, or any shell search command (grep/rg/find/ag/fd). Return: (1) file:line list of relevant locations, (2) an answer in ≤3 sentences, (3) an exact count of tool calls you made, listing each tool name, (4) for each tool call, the approximate size of its result in characters.

Agent B — "text-search":
> Answer this question about the codebase: <question>. You MUST use only Grep, Glob, Bash text-search commands (grep/rg/find), and Read. You MUST NOT use any Codastre or MCP tool, even if a reminder suggests it. Return: (1) file:line list of relevant locations, (2) an answer in ≤3 sentences, (3) an exact count of tool calls you made, listing each tool name, (4) for each tool call, the approximate size of its result in characters.

**Then score, per the token-audit skill:**

- **Tokens**: prefer each task's reported token usage; otherwise estimate from the agents' self-reported result sizes (chars ÷ 4). State which source you used.
- **Tool calls**: count per agent.
- **Relevance**: judge each returned location as correct / plausible / wrong (spot-check by Reading the cited lines if uncertain). Note locations one agent found that the other missed — especially cross-repo ones.
- **Answer quality**: does the ≤3-sentence answer actually answer the question?

**Report** a compact table — rows: tokens, tool calls, locations returned, precision, unique correct finds, answer verdict; columns: Codastre / Text search — followed by a 2–3 sentence verdict explaining *why* the numbers differ (ranking, in-band snippets, federation, graph edges, semantic match). If text search won, say so plainly and explain when that's expected (literal strings, small trees). Close with the caveat that this is one question; suggest repeating with 2–3 diverse questions before generalizing.

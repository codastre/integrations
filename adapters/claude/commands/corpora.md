---
description: Rank repos and doc sets for a ticket, incident, or description — "which repo should I open?"
argument-hint: <ticket / incident / description text> [--stacks S] [--top-k N] [--kinds K]
allowed-tools: Bash(codastre:*), mcp__plugin_codastre_codastre__CORPUS_SEARCH, mcp__codastre__CORPUS_SEARCH, mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY
---

Rank **corpora** (git repos and document sets) for free-form text, then — if the user wants code —
search inside the winner. Load the `codastre-corpus-routing` skill's reading rules if not already
loaded.

Arguments: `$ARGUMENTS`

Parse: the free text is `query_text` (a ticket body, an incident summary, a description, or a repo
name); `--stacks <a,b>` → `stacks`; `--top-k <n>` → `top_k` (default **5** here, not the tool's 10 —
routing wants a short list); `--kinds <k>` → `content_kinds` (evidence allow-list only; omit it for
discovery). If the user gave a GitHub issue number or a Jira key instead of text, fetch its body first
and pass that.

**Plane.** CORPUS_SEARCH has no `agent` rung over MCP, so the CLI is the cheap plane here on any
version that has the command (`codastre corpora`, v0.15.0+):

```bash
codastre corpora "<text>" --top-k 5 [--stacks S] [--content-kinds K] --format agent \
  --client claude-code-plugin/0.2.0   # --client needs v0.19.0; drop it on an older binary
```

No Bash, no CLI, or a binary older than v0.15.0 → the `CORPUS_SEARCH` MCP tool
(`mcp__plugin_codastre_codastre__CORPUS_SEARCH` or `mcp__codastre__CORPUS_SEARCH`) with the same
arguments. If neither is available, say the server/CLI predates corpus ranking and fall back to one
federated `/codastre:search` — noting that it ranks chunks, not repos, so the top repo is weaker
evidence.

**`--stacks`** (v0.18.1+): repos without a stack assignment match nothing, and most aren't classified
yet. An empty answer under `--stacks` → re-run once without it and say the filter emptied it.

Present:

- One line per corpus: `rank. remote_url [kind] — card/evidence/diversity reading — top 1–2 `why` files`.
- Read the scores **within this answer only** (they are ranks, not similarities):
  - card high, evidence low → the text **names** this corpus;
  - evidence high, card low → this corpus **contains** what the text describes;
  - "no card" → placed on body matches alone — weaker, and worth mentioning.
- If the top two are close, or the top one wins on card alone for prose that doesn't name it, say
  the routing is uncertain rather than picking one confidently.
- `ok` with nothing listed → "no indexed corpus matches"; that is an answer.

Then, unless the user only asked which repo: run **one** scoped search inside the top git corpus —
`codastre query "<code vocabulary distilled from the text>" --repo-url <remote_url> --top-k 6 --format agent --snippets`
(or QUERY with `repo_url`). Rephrase into code vocabulary first; ticket prose ranks poorly inside a
repo too. For a document-set corpus, open the `why` files instead.

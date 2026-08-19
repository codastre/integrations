---
description: Search indexed repos with Codastre hybrid retrieval
argument-hint: <query> [--repo URL] [--path PREFIX] [--lang X] [--top-k N] [--max-snippet-lines N] [--no-snippets]
allowed-tools: Bash(codastre:*), mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY, Read
---

Search with Codastre — on the **CLI plane** by default (`codastre query` via Bash), falling back to
the `QUERY` MCP tool (`mcp__plugin_codastre_codastre__QUERY` or `mcp__codastre__QUERY`, whichever is
available). Why that order, and how to check, is in the next section; everything after it — sizing,
scoping, phrasing, how to read the response — is identical on both planes, flag for argument.

Arguments: `$ARGUMENTS`

Parse the arguments: the free text is `query_text`; `--repo <url>` → `repo_url`, `--lang <x>` → `language`, `--path <prefix>` → `path_prefix`, `--top-k <n>` → `top_k`, `--max-snippet-lines <n>` → `max_snippet_lines`, `--no-snippets` → `snippets: false`. With no `--repo`, search federated (omit `index_id` and `repo_url`) so every visible repo is covered.

**When `--top-k` is not given, pass `top_k: 6`, not the tool default of 10.** Every hit is a fully hydrated snippet you pay for whether or not it's read, and for a "where is X" question the answer is almost always in the top 3. Use 10+ only when the user asks to explore or survey.

`--max-snippet-lines` / `--no-snippets` are handled by the local `codastre serve` proxy and stripped before the request reaches the server, so they are safe to pass and no-ops against a direct-HTTP setup. Use them when the user wants locations rather than code (`--no-snippets` reports `hydration: "snippets_disabled"` per hit) — not for ordinary lookups, where the inline snippet is the point.

**When you pass `--no-snippets`, ask for the `agent` rendering with it — on whichever plane the next section names** (`--format agent` on the CLI, where bodies are already off; `format: "agent"` over MCP only on a client that doesn't swallow it). The pair is the *locate tier*, and either half alone leaves most of its saving unclaimed. `snippets: false` on its own still ships a JSON envelope whose per-hit overhead is the whole response once the bodies are gone. Measured at `top_k=5` the pair went 2,234 → 391 tokens (−82%) on the MCP plane and 1,026 → 216 tokens (−79%) CLI-vs-MCP-verbose; with bodies on the ladder saves far less (−32%, same measurement), so don't quote a bodies-on figure as if it were the headline. Which plane carries the rung is the next section's question — on the CLI it's `--format agent` (bodies already off), and over MCP an absent `format` in the advertised `inputSchema` means an out-of-date binary, in which case run without it and say the rung wasn't available rather than claiming the saving.

**Which plane: check the CLI first.** In `agent` format the payload sits in `content[0].text` while
`structuredContent` holds only a fixed summary, so Claude Code — which prefers `structuredContent`
when both are present — shows the model the summary and no results (verified 2026-08-18, `codastre`
v0.14.0: the frame carried the rendering, the model didn't get it). It is deterministic, so don't
spend a call probing it. Check the binary instead, once per session:

```bash
codastre version          # v0.14.0+ → CLI plane, hydrated. ≤ v0.13.1 → MCP verbose.
```

- **v0.14.0+ → run the search on the CLI plane**, mapping the parsed arguments to flags:
  ```bash
  codastre query "<text>" --top-k 6 [--language X] [--path-prefix P] [--repo-url URL] \
    --format agent --snippets [--max-snippet-lines N]
  ```
  **Pass `--snippets` unless `--no-snippets` was given** — the CLI's default is bodies *off*, the
  opposite of QUERY's, and forgetting it silently downgrades an ordinary lookup to the locate tier.
  With `--no-snippets`, just omit the flag (that *is* the locate tier). No `--repo` argument → omit
  `--repo-url` inside a repo checkout (the CLI resolves it from the git remote) and pass `--all` when
  the user asked for a federated search.
- **≤ v0.13.1 → use the MCP tool with `format: "verbose"`**, and say once, in one line, that
  `--format agent` / `--snippets` landed in v0.14.0 so the ladder's saving isn't reachable on this
  binary and updating `codastre` recovers it. Don't guess an install channel, don't run an installer,
  and don't repeat the notice on later calls.
- **No Bash, no CLI, or not logged in** → the MCP tool, same as above. Nothing else changes.

Reading an `agent`-format response — on the CLI plane it is simply stdout (the `target: …` scope line
goes to stderr); over MCP **the answer is in `content[0].text`**, not `structuredContent`, which carries only a fixed summary (`format`, `status`, `freshness`, `result_count`, `rendering_in`). `blob_sha` comes back abbreviated to 12 hex — **verify it by prefix, never equality**. A hit with no `symbol_name` prints `seed:<chunk_id>`; that is GRAPH's exact seed, so hand it to `/codastre:graph` verbatim rather than re-resolving the symbol by name.

Phrase `query_text` in code vocabulary (identifiers, API names) rather than a full English question — it ranks better. If a federated search returns noisy results (top hits from unrelated repos, or all scores tiny and nearly equal), re-run scoped with `--repo` or `--path` rather than raising `--top-k`; on a large or mixed tenant, scoping is the fix, not more results.

**When `--path` is not given, infer a `path_prefix` from the query and pass it on the first call** — don't wait for a bad ranking to justify scoping. If the query names or implies a subtree (a feature/module name, a service folder, a layer such as routes/handlers/migrations), pass that prefix and state which one you chose so the user can correct it. `repo_url` alone still lets a large repo's localization strings, snapshot tests, and generated files crowd the top-k. `path_prefix` is a hard filter, so if the response has `filter_matched: false` the prefix matched nothing indexed — retry without it (or with a shorter one) instead of reporting "no results".

**Infer `--lang` too, and pass it even when the repo looks single-language.** A repo is single-language in its *code*, but the index also holds localization catalogs (`.strings`, `.xliff`), `.json`/`.yaml` config, `.plist`, and generated schema dumps — dense bags of domain vocabulary that rank well and answer nothing. Filtering to the implementation language evicts that whole class in one parameter. Omit it only when those resource files are themselves the target (e.g. "which localization key holds this string").

**If the query is a declaration lookup you can spell exactly** (`protocol Foo`, `class Foo`, `interface Foo`), say plainly that a literal text search is the better first tool and that this command is QUERY-only. If QUERY returns conformers/callers but not the declaring file, do **not** reword and re-query — report the hits you got and point at the one-line grep instead.

Present the results compactly:

- One line per hit: `real_path:line_start-line_end` (score) — one-phrase gloss of what the snippet is. Group by repo when results span repos.
- Quote a snippet only for the top 1–2 hits, and only the relevant lines.
- If a hit has `stale: true`, flag it and re-Read that range before quoting it.
- If a hit has `snippet_truncated: true`, the body stops at `snippet_line_end` — quote only what you were given, and Read on from there only if the answer is visibly cut off.
- If a hit has a `hydration` reason instead of a snippet, report the reason's remedy rather than the raw string (e.g. `no_local_checkout` → "that repo isn't cloned locally"); `snippets_disabled` is expected when `--no-snippets` was passed and needs no comment.
- `results: []` with `status: "ok"` → say "indexed corpus has no match" (that is an answer); suggest Grep only if the query looks like a literal string. On the CLI plane this is `0 hits` and exit 0 — same answer, not a failure.
- `freshness: "syncing"` → note results may lag recent commits.
- `RETRIEVAL_UNAVAILABLE` → say retrieval is down and offer a Grep fallback. On the CLI it arrives as an `error RETRIEVAL_UNAVAILABLE` line with a non-zero exit; `REPO_NOT_INDEXED` means the repo needs `REGISTER` (MCP only) first.

Do not follow up with Grep/Glob to "double-check" a successful search, on either plane.

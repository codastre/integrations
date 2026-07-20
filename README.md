# Codastre Plugin for Claude Code

Codastre's MCP server gives Claude topology-aware code retrieval: hybrid semantic + lexical search (`QUERY`) and a cross-repo knowledge graph (`GRAPH` — calls, imports, extends/implements, Kafka producer/consumer, HTTP, shared packages). This plugin makes Claude Code actually use it well:

| Feature | Benefit |
|---|---|
| **Slash commands** | One-shot search, graph traversal, impact analysis, health checks |
| **Contextual skills** | Claude auto-loads QUERY/GRAPH know-how for search, structural questions, and impact analysis |
| **Steering hooks** | Nudges Claude toward Codastre over Grep/Glob/`grep`/`rg` at session start, in subagents, and before text-search tool calls |
| **Token accounting** | Opt-in tracking of search-tool token usage, plus a built-in A/B demo of Codastre vs plain text search |

## Why not just grep?

Text search returns every raw match; Claude then reads files to figure out which ones matter. Codastre returns ~10 *ranked* results with snippets already hydrated — and graph edges (who calls this, who consumes this topic) that have no textual signature at all, across every indexed repo at once. In practice that means fewer tool calls, far fewer tokens fed into context, and hits that text search structurally cannot find. This plugin lets you *measure* that instead of taking it on faith — see [Measuring the benefit](#measuring-the-benefit).

## Repository layout

This repo is a **monorepo of agent integrations**. The retrieval know-how and measurement contract are agent-neutral and live once in `core/`; each agent gets a thin adapter that compiles that content into its own format and wires its harness.

```
core/           agent-neutral source of truth: retrieval-playbook.md, measurement.md
benchmarks/     shared, agent-agnostic Tier-A harness (run.py + cases.json + schema)
adapters/
  claude/       the Claude Code plugin: .claude-plugin/, hooks/, skills/, commands/, .mcp.json
.claude-plugin/ marketplace.json (source → ./adapters/claude)
```

Only two things are Claude-specific and live in the adapter: **call syntax** (the `mcp__…__QUERY`/`GRAPH` tool names) and **harness wiring** (hooks, context injection). The shared ~90% — when and how to retrieve, how cost is measured — is in `core/`, so a second adapter (e.g. Codex) reuses it instead of re-deriving it. When you change a retrieval rule, change [`core/retrieval-playbook.md`](core/retrieval-playbook.md) first, then re-compile the affected skills.

> **Enforcement isn't portable.** The live A/B **mode** and its `auto` fallback rely on Claude's `PreToolUse` hard-deny hook. An adapter for a harness without tool-gating can port the guidance and measurement but not the enforcement — set that expectation in that adapter's README rather than shipping a broken toggle.

## Commands

| Command | Description |
|---|---|
| `/codastre:status` | Connectivity, auth, and index health (`codastre doctor` + a QUERY smoke test) |
| `/codastre:search <query>` | Hybrid search across all indexed repos (`--repo`, `--lang`, `--top-k`) |
| `/codastre:graph <symbol>` | Traverse relationships (`--topic`, `--kind`, `--depth`, `--direction`) |
| `/codastre:impact <symbol>` | Blast-radius analysis before a rename/refactor/delete, including cross-service edges |
| `/codastre:compare <question>` | A/B demo: same question answered Codastre-only vs text-search-only, scored on tokens + relevance |
| `/codastre:mode [codastre\|grep\|auto\|off]` | Set the search mode: strict `codastre`/`grep` for A/B measurement (per-question token receipt), or `auto` — the recommended standing config: Codastre-first with a disciplined text-search fallback |
| `/codastre:bench` | Deterministic (zero-inference) benchmark from fixed recipes + a ground-truth key (`benchmarks/`) |
| `/codastre:tokens` | Summarize logged search-token usage (requires tracking, below) |
| `/codastre:register` | Register the current repo's origin for indexing (self-serve fix for `REPO_NOT_INDEXED`) |
| `/codastre:receipt` | Print the token receipt for the current live-mode question (frictionless wrapper over the receipt hook) |

## Skills

| Skill | Triggers when… |
|---|---|
| **codastre-search** | Searching/exploring code: "where is X handled", finding definitions or usages |
| **codastre-graph-navigation** | Structural questions: "what calls X", "what consumes topic T", impact of a change, cross-service tracing |
| **codastre-token-audit** | Measuring or demonstrating token savings and result relevance vs text search |

## Hooks

| Hook | Event | Behavior |
|---|---|---|
| Session awareness / setup check | `SessionStart` | Injects QUERY/GRAPH awareness — **or**, if the `codastre` CLI is missing from PATH or unauthenticated, a one-time hint to install / `codastre login` (the plugin's MCP server runs `codastre serve`, so it self-diagnoses) |
| Subagent awareness | `SubagentStart` | Same, for spawned subagents (they don't inherit project instructions) |
| Mode prompt | `UserPromptSubmit` | When a mode is active: stamps a per-session/per-turn marker and tells Claude which tools to use (+ to print the token receipt in strict A/B modes) |
| Mode enforcement | `PreToolUse` (`Grep\|Glob\|Bash\|…codastre…QUERY/GRAPH`) | Strict `codastre`/`grep`: **hard-denies** the disallowed search class so each run is clean. `auto`: allows QUERY/GRAPH always and text search only after a Codastre attempt this turn (or immediately if Codastre errored) |
| Search nudge | `PreToolUse` (`Grep\|Glob`) | When mode is off: reminds Claude to prefer QUERY for conceptual/identifier searches |
| Bash search nudge | `PreToolUse` (`Bash`) | Same, when the command invokes `grep`/`rg`/`ag`/`ack`/`fd`/`findstr`/`find -name` |
| Token tracker | `PostToolUse` | Logs each search call's result size (opt-in via `CODASTRE_TRACK_TOKENS=1`, **or** automatically while an A/B mode is active — then also counts `Read`s) |

The steering/enforcement/tracking hooks no-op silently unless Codastre is *ready* (the `codastre` CLI is on PATH **and** configured — `~/.config/codastre/config.json` exists, or `CODASTRE_SERVER`/`CODASTRE_API_KEY` is set) — no nagging in environments without Codastre. The one exception is `SessionStart`: because installing the plugin signals intent, it emits a single, concise setup hint when the CLI is missing (how to install) or unauthenticated (`codastre login`) — that's help, not a nag.

## Measuring the benefit

Two complementary mechanisms:

**Passive tracking** — set `CODASTRE_TRACK_TOKENS=1` (e.g. in `.claude/settings.json` under `env`). Every Grep/Glob/shell-search and every Codastre QUERY/GRAPH call is logged to `~/.config/codastre/claude-token-log.jsonl` (override with `CODASTRE_TOKEN_LOG`) with an estimated result-token count (~4 chars/token). `/codastre:tokens` turns the log into a per-class report: calls, totals, median/p90 tokens per search step. Result sizes only — never your code's content beyond the search pattern/query text itself. The log self-rotates to a single `.1` backup once it passes ~5 MB (override the threshold with `CODASTRE_TOKEN_LOG_MAX_BYTES`), so it never grows unbounded.

**Environment overrides (all optional):** `CODASTRE_SERVER` / `CODASTRE_API_KEY` (mark Codastre configured without a login file), `CODASTRE_TOKEN_LOG` (log path), `CODASTRE_TOKEN_LOG_MAX_BYTES` (rotation threshold), `CODASTRE_SEARCH_MODE` (`codastre`/`grep`/`auto` — overrides the mode file and never expires; intended for scripted/CI runs), `CODASTRE_SEARCH_MODE_FILE` (mode-file path), `CODASTRE_SEARCH_MODE_TTL_HOURS` (how long a set mode stays active before auto-expiring, default 8 — so a forgotten `/codastre:mode` doesn't block Grep forever).

**Active A/B (Tier B — agentic)** — `/codastre:compare <question>` runs the same question through two isolated subagents (one Codastre-only, one Grep/find-only), **sequentially under the enforced search modes**, and reports tokens, tool calls, precision of the returned locations, and what each approach missed. Tokens are **measured from the token log** by timestamp window (the same deterministic source as live mode), not self-reported by the agents — with a labeled fallback to self-report if the harness didn't log a window. Cross-repo questions ("what consumes the orders topic?") are the most dramatic: graph edges simply don't exist in text. This measures the *agentic* cost (reasoning + tool choice) and needs two subagent runs.

**Scripted (Tier A — zero inference)** — `/codastre:bench` (or `python3 benchmarks/run.py`) runs fixed Codastre + grep recipes against a ground-truth answer key and scores calls, result bytes, ~tokens, precision, and recall — deterministically, with no LLM in the loop. This is the CI-friendly form: it catches data-plane regressions (a corpus-hygiene fix that drops tokens, a confidence change that moves precision) without agent variance. See [`benchmarks/README.md`](benchmarks/README.md). Use Tier A by default; reach for Tier B when the question is specifically "does the agent choose and phrase well?"

**Live mode (user-judged)** — `/codastre:mode codastre` then ask your *own* question: Claude answers using only QUERY/GRAPH (text search is hard-blocked) and ends with a **token receipt** for that question. Run `/codastre:mode grep` and ask the same question — now only text search is allowed — and compare the two answers and receipts yourself. No predefined cases and no agent scoring: you decide which result is better and what it cost. The receipt counts search-result tokens *and* the file `Read`s each run makes (so a grep workflow's follow-up reads are counted, not hidden). `/codastre:mode off` restores normal behavior. This is the most honest demo — it's *your* question on *your* corpus, judged by you — but it's one question at a time and subject to normal run-to-run variance; use Tier A when you need repeatable numbers.

For everyday use (not measurement), prefer `/codastre:mode auto`: Codastre-first, with text search allowed after one Codastre attempt or immediately when Codastre errors — no per-turn receipt, no hard block on legitimate literal-string greps. The strict `codastre`/`grep` modes exist for clean A/B runs; `auto` is the recommended standing configuration.

Honest by design: estimates are approximate, grep's follow-up file reads aren't attributed to it (understating its cost), and the comparison command reports text-search wins when they happen — grep is genuinely better for literal strings, and the skills say so.

## Installation

### Prerequisites

1. The `codastre` CLI installed and on `PATH`
2. `codastre login [--server URL]` completed (API key in the OS keychain)
3. Your repo(s) indexed (`/codastre:register`, the `REGISTER` MCP tool, or ask your admin)
4. **Node.js on `PATH`** — the plugin's hooks are `node` scripts (true for most Claude Code installs; stated here for headless/CI environments)

### Quick start

```bash
claude plugin marketplace add codastre/integrations
claude plugin install codastre@codastre-plugins --scope project
```

The marketplace lives at the repo root and points its `source` at [`./adapters/claude`](adapters/claude), so the install string stays clean even though the plugin is one adapter in a monorepo (see [Repository layout](#repository-layout)).

The plugin starts the MCP server via `codastre serve` (stdio proxy — unmasks paths and hydrates snippets from your local checkout; source code never leaves your machine through the server).

Verify with `/codastre:status`.

### Recommended settings

**Allowlist the Codastre tools** so the first QUERY/GRAPH doesn't trigger a permission prompt — a denied prompt (or an annoyed user) drifts Claude back to Grep, silently defeating the plugin. Add to your project `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_codastre_codastre__QUERY",
      "mcp__plugin_codastre_codastre__GRAPH",
      "Bash(node:*receipt.js*)"
    ]
  }
}
```

(The last line lets the live-mode token receipt run without a Bash prompt each A/B turn; `/codastre:receipt` is the friction-free alternative.) If your MCP server is configured project-level rather than via the plugin, the tool names are `mcp__codastre__QUERY` / `mcp__codastre__GRAPH` instead. `/codastre:status` flags when these prompts would fire.

**Turn on Codastre-first mode for daily use:** `/codastre:mode auto` allows QUERY/GRAPH always and lets text search through only after a Codastre attempt (or immediately when Codastre errors) — the fallback made mechanical, not just advisory. The strict `codastre`/`grep` modes are measurement tools; `auto` is the recommended standing configuration.

> **Hook-event support:** the subagent-awareness hook registers on `SubagentStart`. If your Claude Code version emits only `SubagentStop` (older builds), subagents won't receive the awareness blurb — everything else (session awareness, nudges, mode enforcement, tracking) is unaffected. Check `claude --version` against the hooks docs if `/codastre:compare`'s Agent A seems unaware of the tools.

### Prefer the local proxy (`codastre serve`)

**The plugin's [`.mcp.json`](.mcp.json) runs the local `codastre serve` proxy on purpose — this is the recommended configuration, not just a convenience.** Point Claude Code at `codastre serve` (as the plugin does), *not* directly at the server's HTTP MCP endpoint.

Only the local proxy:

- **hydrates snippets** — the actual code lines land inline in each `QUERY` result, so Claude answers from the response without a follow-up `Read`;
- **unmasks `path_token` → real path** using the masking key in your OS keychain, and resolves results against your working checkout (`RepoRoot`).

A direct HTTP MCP config skips the proxy: results come back as `path_token`s (masked for `hmac` repos) **with no snippet bodies**, so Claude must issue extra `Read` calls to recover what the proxy would have inlined — more tool calls and more tokens, i.e. the plugin's search advantage is left on the table.

> **Missing `snippet`? Check `masking_scheme` before concluding you're bypassing the proxy.** Snippet hydration currently fires only for `hmac`-masked repos. On `masking_scheme: none` repos (the common dev/eval setup) the proxy resolves real paths and working-directory context but **does not inline snippets yet** — even though you *are* running `codastre serve` correctly. So a missing `snippet` on a `none` repo is the known hydration gap, not a misconfiguration; the skills instruct Claude to treat `path_token` as the repo-relative path and do targeted line-range Reads (`offset`/`limit` from `line_start`/`line_end`), which keeps most of the token advantage. A missing `snippet` on an `hmac` repo *is* the "talking to raw HTTP instead of the proxy" case — switch to `codastre serve`. (Decoupling hydration from unmasking so `none` repos hydrate too is tracked upstream in the codastre CLI.)

## Troubleshooting

| Issue | Solution |
|---|---|
| MCP tools missing | Restart Claude Code; check `codastre` is on `PATH` |
| `no API key` from `codastre serve` | Run `codastre login` |
| `REPO_NOT_INDEXED` | Run `/codastre:register` (registers cwd's origin and polls), or call the `REGISTER` MCP tool with the repo URL |
| First QUERY/GRAPH prompts for permission | Allowlist the tools — see [Recommended settings](#recommended-settings) |
| Grep still blocked after finishing an A/B run | A set mode auto-expires after `CODASTRE_SEARCH_MODE_TTL_HOURS` (default 8h); run `/codastre:mode off` to clear it now |
| `RETRIEVAL_UNAVAILABLE` | Data plane down — Claude falls back to text search automatically |
| `/codastre:tokens` says no data | Tracking is opt-in: set `CODASTRE_TRACK_TOKENS=1` |
| Hooks feel naggy | They fire only when Codastre is configured; unset config/env to silence, or uninstall |

## License

Apache-2.0 — see [LICENSE](LICENSE).

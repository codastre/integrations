<div align="center">

# Codastre for Claude Code

**Topology-aware hybrid code retrieval and a cross-repo knowledge graph — wired into Claude Code so it actually uses them.**

Semantic + lexical search (`QUERY`) and a relationship graph (`GRAPH` — calls, imports,
extends/implements, Kafka producer/consumer, HTTP, shared packages), plus the steering,
enforcement, and measurement that make Claude reach for them instead of `grep`.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-da7756)](https://docs.claude.com/en/docs/claude-code)
[![MCP](https://img.shields.io/badge/MCP-QUERY%20%C2%B7%20GRAPH-5eead4)](https://modelcontextprotocol.io)
[![Requires](https://img.shields.io/badge/requires-codastre%20CLI-0d9488)](https://codastre.com/install)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-555)

[Install](#-install) · [Quickstart](#-quickstart) · [Commands](#-commands) · [Measuring](#-measuring-the-benefit) · [codastre.com](https://codastre.com)

</div>

---

Text search returns *every* raw match, then Claude reads files to figure out which ones
matter. Codastre returns ~10 **ranked** results with snippets already hydrated — and graph
edges (who calls this, who consumes this topic) that have **no textual signature at all**,
across every indexed repo at once. Fewer tool calls, far fewer tokens into context, and hits
grep structurally cannot find. This plugin makes Claude Code use it well — and lets you
[*measure*](#-measuring-the-benefit) the difference instead of taking it on faith.

| Piece | What it adds |
| --- | --- |
| **🔧 Slash commands** | One-shot search, graph traversal, impact analysis, register, health checks |
| **🧠 Contextual skills** | Claude auto-loads QUERY/GRAPH know-how for search, structural questions, and impact analysis |
| **🪝 Steering hooks** | Nudge toward Codastre over grep/rg at session start, in subagents, and before text-search calls |
| **📊 Token accounting** | Opt-in usage tracking + a built-in A/B demo of Codastre vs plain text search, measured from a log |

## 📦 Install

The plugin drives the **`codastre` CLI**, which runs the MCP server locally (`codastre serve`)
and keeps your source on your machine. Install the CLI first, then add the plugin.

**1 — Install & authenticate the CLI** — full walkthrough at **[codastre.com/install](https://codastre.com/install)**:

```bash
# Get the binary (see codastre.com/install for your platform), then:
codastre login          # device-code auth; key lands in your OS keychain
codastre doctor         # verify connectivity + auth
```

**2 — Add the plugin** in Claude Code:

```bash
claude plugin marketplace add codastre/integrations
claude plugin install codastre@codastre-plugins --scope project
```

The marketplace lives at the repo root and points its `source` at
[`./adapters/claude`](adapters/claude), so the install string stays clean even though the
plugin is one adapter in a monorepo (see [Repository layout](#-repository-layout)).

**Prerequisites**

1. The `codastre` CLI on `PATH`, authenticated (`codastre login`) — [codastre.com/install](https://codastre.com/install)
2. Your repo(s) indexed — `/codastre:register`, the `REGISTER` MCP tool, or your admin
3. **Node.js on `PATH`** — the plugin's hooks are `node` scripts (true for most Claude Code installs; noted for headless/CI)

Verify the whole chain with **`/codastre:status`**.

> [!NOTE]
> The plugin's [`.mcp.json`](adapters/claude/.mcp.json) starts the MCP server via
> `codastre serve` — a local stdio proxy that unmasks paths and hydrates snippets from your
> local checkout. Source code never leaves your machine through the server. See
> [Prefer the local proxy](#-prefer-the-local-proxy-codastre-serve).

## 🚀 Quickstart

```bash
# Ask a normal question — the skills + hooks steer Claude to QUERY/GRAPH automatically:
#   "where do we validate webhook signatures?"        → QUERY
#   "what consumes the orders.created topic?"          → GRAPH (cross-repo edge)
#   "what breaks if I change PaymentService.charge?"   → /codastre:impact

/codastre:status                 # connectivity, auth, index health
/codastre:search webhook signature validation
/codastre:mode auto              # recommended: Codastre-first, with a grep fallback
```

## 🔧 Commands

| Command | What it does |
| --- | --- |
| `/codastre:status` | Connectivity, auth, and index health (`codastre doctor` + a QUERY smoke test) |
| `/codastre:search <query>` | Hybrid search across all indexed repos (`--repo`, `--path`, `--lang`, `--top-k`) |
| `/codastre:graph <symbol>` | Traverse relationships (`--topic`, `--kind`, `--depth`, `--direction`) |
| `/codastre:impact <symbol>` | Blast-radius analysis before a rename/refactor/delete, including cross-service edges |
| `/codastre:register` | Register the current repo's origin for indexing — self-serve fix for `REPO_NOT_INDEXED` |
| `/codastre:compare <question>` | A/B demo: same question Codastre-only vs text-search-only, scored on measured tokens + relevance |
| `/codastre:mode [codastre\|grep\|auto\|off]` | Set the search mode — strict `codastre`/`grep` for A/B measurement, or `auto` (recommended standing config) |
| `/codastre:bench` | Deterministic (zero-inference) benchmark from fixed recipes + a ground-truth key |
| `/codastre:tokens` | Summarize logged search-token usage (requires tracking, below) |
| `/codastre:receipt` | Print the token receipt for the current live-mode question |

## 🧠 Skills

Claude auto-loads these when a matching question comes up (they compile from
[`core/retrieval-playbook.md`](core/retrieval-playbook.md)):

| Skill | Triggers when… |
| --- | --- |
| **codastre-search** | Searching/exploring code: "where is X handled", finding definitions or usages |
| **codastre-graph-navigation** | Structural questions: "what calls X", "what consumes topic T", impact, cross-service tracing |
| **codastre-token-audit** | Measuring or demonstrating token savings and result relevance vs text search |

## 🪝 Hooks

| Hook | Event | Behavior |
| --- | --- | --- |
| Session / setup check | `SessionStart` | Injects QUERY/GRAPH awareness (auto-scoped to the cwd's git origin) — **or**, if the CLI is missing/unauthenticated, a one-time install/`login` hint |
| Subagent awareness | `SubagentStart` | Same awareness for spawned subagents (they don't inherit project instructions) |
| Mode prompt | `UserPromptSubmit` | When a mode is active: stamps a per-session/per-turn marker and tells Claude which tools to use |
| Mode enforcement | `PreToolUse` | Strict `codastre`/`grep` **hard-deny** the disallowed class; `auto` allows QUERY/GRAPH always and text search only after a Codastre attempt (or on Codastre error) |
| Search nudge | `PreToolUse` (`Grep\|Glob\|Bash`) | When mode is off: a once-per-session reminder to prefer QUERY for conceptual/identifier searches |
| Token tracker | `PostToolUse` | Logs each search call's result size (opt-in via `CODASTRE_TRACK_TOKENS=1`, or automatically while a mode is active) |

The steering/enforcement/tracking hooks **no-op silently** unless Codastre is *ready* (CLI on
`PATH` **and** configured — `~/.config/codastre/config.json` exists, or
`CODASTRE_SERVER`/`CODASTRE_API_KEY` set), so there's no nagging where Codastre isn't set up.
The one exception is `SessionStart`, which emits a single concise setup hint when the CLI is
missing or unauthenticated — help, not a nag.

## 📊 Measuring the benefit

Four tiers, honest by design — estimates are ~4 chars/token, grep's follow-up reads are
attributed to it (not hidden), and text-search wins are reported when they happen.

- **Passive tracking** — set `CODASTRE_TRACK_TOKENS=1` (e.g. in `.claude/settings.json` under
  `env`). Every text search and every QUERY/GRAPH call is logged to
  `~/.config/codastre/claude-token-log.jsonl` with an estimated result-token count.
  `/codastre:tokens` renders a per-class report (calls, totals, median/p90 per step). Result
  sizes only — never your code. The log self-rotates past ~5 MB.
- **Tier A — scripted** (`/codastre:bench`) — fixed Codastre + grep recipes vs a ground-truth
  key, scoring calls, bytes, ~tokens, precision, recall, deterministically with no LLM in the
  loop. CI-friendly; catches data-plane regressions. See [`benchmarks/README.md`](benchmarks/README.md).
- **Tier B — agentic A/B** (`/codastre:compare <question>`) — the same question through two
  isolated subagents (Codastre-only, then grep-only), **sequentially under the enforced
  modes**. Tokens are **measured from the log** by timestamp window, not self-reported.
- **Tier C — live, user-judged** (`/codastre:mode codastre` → ask → **token receipt**, then
  `/codastre:mode grep` and compare). *Your* question on *your* corpus, judged by you.

## 🔐 Recommended settings

**Allowlist the Codastre tools** so the first QUERY/GRAPH doesn't trigger a permission prompt —
a denied prompt drifts Claude back to Grep, silently defeating the plugin. Add to your project
`.claude/settings.json`:

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

The last line lets the live-mode receipt run without a Bash prompt (`/codastre:receipt` is the
friction-free alternative). For a project-level MCP config the names are
`mcp__codastre__QUERY` / `mcp__codastre__GRAPH`. `/codastre:status` flags when prompts would fire.

**Turn on Codastre-first mode for daily use:** `/codastre:mode auto` allows QUERY/GRAPH always
and lets text search through only after a Codastre attempt (or immediately when Codastre
errors) — the fallback made mechanical, not just advisory. The strict `codastre`/`grep` modes
are measurement tools; `auto` is the recommended standing configuration.

**Environment overrides (all optional):** `CODASTRE_SERVER` / `CODASTRE_API_KEY`,
`CODASTRE_TOKEN_LOG`, `CODASTRE_TOKEN_LOG_MAX_BYTES`, `CODASTRE_SEARCH_MODE`
(`codastre`/`grep`/`auto`, never expires — for scripted/CI runs), `CODASTRE_SEARCH_MODE_FILE`,
`CODASTRE_SEARCH_MODE_TTL_HOURS` (default 8, so a forgotten mode never blocks Grep forever).

> [!NOTE]
> The subagent-awareness hook registers on `SubagentStart`. If your Claude Code version emits
> only `SubagentStop` (older builds), subagents won't get the awareness blurb — everything else
> is unaffected. Check `claude --version` against the hooks docs if `/codastre:compare`'s
> Agent A seems unaware of the tools.

## 🗂 Repository layout

This repo is a **monorepo of agent integrations**. The retrieval know-how and measurement
contract are agent-neutral and live once in `core/`; each agent gets a thin adapter that
compiles that content into its own format and wires its harness.

```
core/            agent-neutral source of truth: retrieval-playbook.md, measurement.md
benchmarks/      shared, agent-agnostic Tier-A harness (run.py + cases.json + schema)
adapters/
  claude/        the Claude Code plugin: .claude-plugin/, hooks/, skills/, commands/, .mcp.json
.claude-plugin/  marketplace.json (source → ./adapters/claude)
```

Only two things are Claude-specific and live in the adapter: **call syntax** (the
`mcp__…__QUERY`/`GRAPH` tool names) and **harness wiring** (hooks, context injection). The
shared ~90% is in `core/`, so a second adapter (e.g. Codex) reuses it. Change
[`core/retrieval-playbook.md`](core/retrieval-playbook.md) first, then re-compile the skills.

> [!NOTE]
> **Enforcement isn't portable.** The live A/B mode and its `auto` fallback rely on Claude's
> `PreToolUse` hard-deny. An adapter for a harness without tool-gating can port the guidance
> and measurement but not the enforcement — set that expectation in that adapter's README.

## 🧩 Prefer the local proxy (`codastre serve`)

**The plugin runs the local `codastre serve` proxy on purpose — this is the recommended
configuration.** Point Claude Code at `codastre serve` (as the plugin does), *not* directly at
the server's HTTP MCP endpoint. Only the local proxy:

- **hydrates snippets** — the actual code lines land inline in each `QUERY` result, so Claude
  answers without a follow-up `Read`;
- **unmasks `path_token` → real path** using the masking key in your OS keychain, resolving
  results against your working checkout.

A direct HTTP MCP config skips the proxy: results come back as `path_token`s **with no snippet
bodies**, forcing extra `Read` calls — the search advantage left on the table.

> [!TIP]
> **Missing `snippet`? Check `masking_scheme` before assuming you're bypassing the proxy.**
> Hydration fires for `hmac` repos; on `masking_scheme: none` repos (common dev/eval setup) the
> proxy resolves real paths but **doesn't inline snippets yet** — even though you *are* running
> `codastre serve` correctly. On a `none` repo, `path_token` *is* the real path and the skills
> do targeted line-range Reads. On an `hmac` repo a missing snippet *is* the "raw HTTP instead
> of the proxy" case — switch to `codastre serve`. (Decoupling hydration from unmasking so
> `none` repos hydrate too is tracked upstream in the codastre CLI.)

## 🩺 Troubleshooting

| Issue | Solution |
| --- | --- |
| MCP tools missing | Restart Claude Code; check `codastre` is on `PATH` |
| `no API key` from `codastre serve` | Run `codastre login` — see [codastre.com/install](https://codastre.com/install) |
| `REPO_NOT_INDEXED` | Run `/codastre:register`, or call the `REGISTER` MCP tool with the repo URL |
| First QUERY/GRAPH prompts for permission | Allowlist the tools — see [Recommended settings](#-recommended-settings) |
| Grep still blocked after an A/B run | A set mode auto-expires after `CODASTRE_SEARCH_MODE_TTL_HOURS` (default 8h); `/codastre:mode off` clears it now |
| `RETRIEVAL_UNAVAILABLE` | Data plane down — Claude falls back to text search automatically |
| `/codastre:tokens` says no data | Tracking is opt-in: set `CODASTRE_TRACK_TOKENS=1` |
| Hooks feel naggy | They fire only when Codastre is configured; unset config/env to silence, or uninstall |

## 🔗 Learn more

- 🌐 **[codastre.com](https://codastre.com)** — what it is and how it works
- 📥 **[codastre.com/install](https://codastre.com/install)** — install + connect the CLI
- 🖥 **[codastre/cli](https://github.com/codastre/cli)** — the CLI that powers this plugin

## 📄 License

Licensed under the [Apache License 2.0](LICENSE).

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

## Commands

| Command | Description |
|---|---|
| `/codastre:status` | Connectivity, auth, and index health (`codastre doctor` + a QUERY smoke test) |
| `/codastre:search <query>` | Hybrid search across all indexed repos (`--repo`, `--lang`, `--top-k`) |
| `/codastre:graph <symbol>` | Traverse relationships (`--topic`, `--kind`, `--depth`, `--direction`) |
| `/codastre:impact <symbol>` | Blast-radius analysis before a rename/refactor/delete, including cross-service edges |
| `/codastre:compare <question>` | A/B demo: same question answered Codastre-only vs text-search-only, scored on tokens + relevance |
| `/codastre:tokens` | Summarize logged search-token usage (requires tracking, below) |

## Skills

| Skill | Triggers when… |
|---|---|
| **codastre-search** | Searching/exploring code: "where is X handled", finding definitions or usages |
| **codastre-graph-navigation** | Structural questions: "what calls X", "what consumes topic T", impact of a change, cross-service tracing |
| **codastre-token-audit** | Measuring or demonstrating token savings and result relevance vs text search |

## Hooks

| Hook | Event | Behavior |
|---|---|---|
| Session awareness | `SessionStart` | Injects QUERY/GRAPH awareness and the QUERY-vs-grep decision rule |
| Subagent awareness | `SubagentStart` | Same, for spawned subagents (they don't inherit project instructions) |
| Search nudge | `PreToolUse` (`Grep\|Glob`) | Reminds Claude to prefer QUERY for conceptual/identifier searches |
| Bash search nudge | `PreToolUse` (`Bash`) | Same, when the command invokes `grep`/`rg`/`ag`/`ack`/`fd`/`findstr`/`find -name` |
| Token tracker | `PostToolUse` | **Opt-in** — logs each search tool call's result size (see below) |

All hooks no-op silently unless Codastre is configured (`~/.config/codastre/config.json` exists, or `CODASTRE_SERVER`/`CODASTRE_API_KEY` is set) — no nagging in environments without Codastre.

## Measuring the benefit

Two complementary mechanisms:

**Passive tracking** — set `CODASTRE_TRACK_TOKENS=1` (e.g. in `.claude/settings.json` under `env`). Every Grep/Glob/shell-search and every Codastre QUERY/GRAPH call is logged to `~/.config/codastre/claude-token-log.jsonl` (override with `CODASTRE_TOKEN_LOG`) with an estimated result-token count (~4 chars/token). `/codastre:tokens` turns the log into a per-class report: calls, totals, median/p90 tokens per search step. Result sizes only — never your code's content beyond the search pattern/query text itself.

**Active A/B** — `/codastre:compare <question>` runs the same question through two isolated subagents (one Codastre-only, one Grep/find-only) and reports tokens, tool calls, precision of the returned locations, and what each approach missed. Cross-repo questions ("what consumes the orders topic?") are the most dramatic: graph edges simply don't exist in text.

Honest by design: estimates are approximate, grep's follow-up file reads aren't attributed to it (understating its cost), and the comparison command reports text-search wins when they happen — grep is genuinely better for literal strings, and the skills say so.

## Installation

### Prerequisites

1. The `codastre` CLI installed and on `PATH`
2. `codastre login [--server URL]` completed (API key in the OS keychain)
3. Your repo(s) indexed (the `REGISTER` MCP tool, or ask your admin)

### Quick start

```bash
claude plugin marketplace add codastre/codastre-claude
claude plugin install codastre@codastre-plugins --scope project
```

The plugin starts the MCP server via `codastre serve` (stdio proxy — unmasks paths and hydrates snippets from your local checkout; source code never leaves your machine through the server).

Verify with `/codastre:status`.

## Troubleshooting

| Issue | Solution |
|---|---|
| MCP tools missing | Restart Claude Code; check `codastre` is on `PATH` |
| `no API key` from `codastre serve` | Run `codastre login` |
| `REPO_NOT_INDEXED` | Call the `REGISTER` MCP tool with the repo URL |
| `RETRIEVAL_UNAVAILABLE` | Data plane down — Claude falls back to text search automatically |
| `/codastre:tokens` says no data | Tracking is opt-in: set `CODASTRE_TRACK_TOKENS=1` |
| Hooks feel naggy | They fire only when Codastre is configured; unset config/env to silence, or uninstall |

## License

Apache-2.0 — see [LICENSE](LICENSE).

---
description: Summarize search-related token usage (Codastre vs text search)
allowed-tools: Bash(python3:*), Bash(test:*), Bash(wc:*)
---

Summarize the Codastre token-usage log. Follow the `codastre-token-audit` skill's reporting rules.

Arguments: `$ARGUMENTS` (optional: `--session` to restrict to the current session, `--cwd` to restrict to the current project)

The log lives at `$CODASTRE_TOKEN_LOG` if set, else `~/.config/codastre/claude-token-log.jsonl`. If the file doesn't exist or is empty, explain that tracking is opt-in: set `CODASTRE_TRACK_TOKENS=1` in the environment (e.g. in `.claude/settings.json` `env`, or the shell) and searches will be logged from then on. Stop there.

Otherwise aggregate with one Bash `python3` script (read the file, parse JSONL, tolerate bad lines): per `class` (`codastre` vs `text-search`) compute call count, total / median / p90 `out_tokens`; also the 5 largest single results overall (class, tool, truncated `detail`, out_tokens), and totals split by `cwd`. Apply `--session`/`--cwd` filters if given.

Also break the `codastre` class down by **`plane`** (`cli` / `mcp`, absent = pre-field records) — the two are not interchangeable in a sum, since a CLI call carries one copy of the payload and reaches the `agent` rung that this client swallows over MCP — and by **both** `tok_basis` (`json` / `agent` / `text`, absent = pre-fix records at the old flat 4) and `rung` (`verbose` / `compact` / `agent`, absent = not recorded). They answer different questions and legitimately disagree: `tok_basis` stops a mixed sum being reported under one ratio, while `rung` says how much of the sample actually went through the cheap rung — a summary-only `agent` response is JSON-shaped bytes from an agent-rung call, so grouping by ratio alone hides it entirely.

**Flag this pattern when you see it:** several `plane: "mcp"`, `rung: "agent"` records at ~40 tokens each is not a saving, it's the rendering being swallowed before it reached the model (a client that prefers `structuredContent` over `content`). Say so, exclude them from any per-call median, and point at the CLI plane (`codastre query --format agent`) as where that saving is actually reachable — `plane: "cli"` records at the same rung are the real thing and should carry a real payload.

**And read a plane split as a migration, not a mix.** A session that starts on `plane: "mcp"` and continues on `plane: "cli"` is following the current guidance (`core/retrieval-playbook.md` §2c), so report the two planes' medians separately rather than one blended figure; a blend understates the MCP calls and overstates the CLI ones. If the log holds no `plane` field at all, it predates the split — say so instead of assuming MCP.

Report:

- A small table: class | calls | total tokens | median/call | p90/call.
- **Headline**: median tokens per search step, text-search vs codastre, as a multiplier ("a grep step feeds ~Nx more tokens into context than a Codastre step").
- Top-5 largest single results — usually raw grep dumps; name them.
- The standing caveats from the token-audit skill: the ratios are shape-dependent and `cl100k_base`-measured (JSON ~2.5 ch/tok, agent rendering ~3.0, everything else the **unmeasured** 4), worth ±20%; grep's follow-up Reads aren't counted, so grep's true cost is understated.
- **This log is not a pinned comparison.** It aggregates whatever ran, over whatever the index held at the time, at whatever format rung each call used — so it is a usage picture, not a before/after. Never present a change in these medians as a measured saving; for that, use `/codastre:compare`, which pins its two sides. If the `tok_basis` breakdown shows the sample straddling rungs, say the classes aren't like-for-like.
- If one class has < 5 calls, say the sample is too small to generalize and suggest `/codastre:compare` for a controlled measurement.

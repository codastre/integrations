---
description: Summarize search-related token usage (Codastre vs text search)
allowed-tools: Bash(python3:*), Bash(test:*), Bash(wc:*)
---

Summarize the Codastre token-usage log. Follow the `codastre-token-audit` skill's reporting rules.

Arguments: `$ARGUMENTS` (optional: `--session` to restrict to the current session, `--cwd` to restrict to the current project)

The log lives at `$CODASTRE_TOKEN_LOG` if set, else `~/.config/codastre/claude-token-log.jsonl`. If the file doesn't exist or is empty, explain that tracking is opt-in: set `CODASTRE_TRACK_TOKENS=1` in the environment (e.g. in `.claude/settings.json` `env`, or the shell) and searches will be logged from then on. Stop there.

Otherwise aggregate with one Bash `python3` script (read the file, parse JSONL, tolerate bad lines): per `class` (`codastre` vs `text-search`) compute call count, total / median / p90 `out_tokens`; also the 5 largest single results overall (class, tool, truncated `detail`, out_tokens), and totals split by `cwd`. Apply `--session`/`--cwd` filters if given.

Report:

- A small table: class | calls | total tokens | median/call | p90/call.
- **Headline**: median tokens per search step, text-search vs codastre, as a multiplier ("a grep step feeds ~Nx more tokens into context than a Codastre step").
- Top-5 largest single results — usually raw grep dumps; name them.
- The standing caveats from the token-audit skill (chars/4 estimate; grep's follow-up Reads not counted, so grep's true cost is understated).
- If one class has < 5 calls, say the sample is too small to generalize and suggest `/codastre:compare` for a controlled measurement.

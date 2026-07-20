---
description: Set the search mode — strict A/B (codastre/grep) or codastre-first (auto)
argument-hint: "[codastre | grep | auto | off]"
allowed-tools: Bash(mkdir:*), Bash(printf:*), Bash(rm:*), Bash(cat:*), Bash(test:*)
---

Set or show the **search mode**. Two strict A/B modes let the user answer the *same real
question* two ways — Codastre-only, then Codastre-free — and decide which result is
better, with a per-question token receipt each time; a third `auto` mode is the
recommended standing configuration for daily use.

- **`codastre` / `grep` (strict A/B):** the PreToolUse hook **hard-blocks** the other
  search class, so each run is clean, and the answer ends with a token receipt. Use these
  for measurement.
- **`auto` (codastre-first):** QUERY/GRAPH are always allowed; text search is allowed only
  *after* a Codastre attempt this turn — or immediately if Codastre errored/was
  unavailable. No hard block on legitimate literal-string greps, no per-turn receipt. This
  is the recommended everyday mode.

Arguments: `$ARGUMENTS` — one of `codastre`, `grep` (alias `text`/`nocodastre`), `auto`,
`off`, or empty to show the current mode. A set mode auto-expires after
`CODASTRE_SEARCH_MODE_TTL_HOURS` (default 8) so a forgotten mode never blocks Grep forever.

The mode is a one-word state file at `${CODASTRE_SEARCH_MODE_FILE:-$HOME/.config/codastre/search-mode}`.

Do this:

1. Determine the target from `$ARGUMENTS` (case-insensitive):
   - `codastre` → Codastre-only (QUERY/GRAPH allowed; text search blocked).
   - `grep`/`text`/`nocodastre` → Codastre-free (grep/glob/find allowed; QUERY/GRAPH blocked).
   - `auto` → Codastre-first (QUERY/GRAPH always allowed; text search allowed after one Codastre attempt or on Codastre error).
   - `off` → disable enforcement (both allowed again).
   - empty → **just read and report** the current mode; do not change it.
2. Apply it with a single Bash command:
   - set: `mkdir -p "$HOME/.config/codastre" && printf '%s' "codastre" > "$HOME/.config/codastre/search-mode"` (or `grep` / `auto`).
   - off: `rm -f "$HOME/.config/codastre/search-mode"`.
   - show: `cat "$HOME/.config/codastre/search-mode" 2>/dev/null || echo off`.
3. Confirm the new mode in one line, then state the workflow succinctly:
   - For `codastre`/`grep`: "Ask your question normally — I'll answer using only <allowed
     tools> and print a token receipt. Then run `/codastre:mode <other>` and ask the same
     question to compare, or `/codastre:mode off` when done."
   - For `auto`: "Ask your question normally — I'll reach for Codastre first and fall back to
     text search only when it genuinely can't serve the query (and say why). No receipt.
     `/codastre:mode off` to disable."
4. Note that the receipt counts result-size tokens for search calls **and** the file Reads
   a run makes (so a grep workflow's follow-up reads are counted, not hidden), estimated at
   ~4 chars/token — not billing-grade, fine for a head-to-head.

Never override the user's active mode without being asked; if they passed no argument, only report.

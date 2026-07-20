---
description: Run the deterministic (zero-inference) Codastre-vs-grep benchmark
allowed-tools: Bash(python3:*)
---

Run the scripted benchmark harness and present its report. This is **Tier A** — fully
deterministic, no agent reasoning about the questions (contrast `/codastre:compare`, which
is the agentic Tier B). See `benchmarks/README.md` and the `codastre-token-audit` skill.

Arguments: `$ARGUMENTS` (passed through to `run.py`, e.g. `--workspace <dir>`,
`--cases <file>`, `--format json`, `--out <file>`).

Steps:

1. Run the harness with a single Bash call. `benchmarks/` is a **shared, repo-root**
   suite in the monorepo (not inside the Claude adapter), so it sits two levels up from
   the plugin root:
   `python3 "${CLAUDE_PLUGIN_ROOT}/../../benchmarks/run.py" $ARGUMENTS`
   If that path doesn't exist (e.g. the plugin was installed standalone rather than run
   from the monorepo), fall back to `"${CLAUDE_PLUGIN_ROOT}/benchmarks/run.py"`, and if
   neither resolves, tell the user the bench suite ships in the monorepo repo root and
   needs local checkouts of the playground repos to run.
2. The script already prints a scored markdown table (per-case + totals: calls, result
   bytes, ~tokens, precision, recall). Relay it as-is — do **not** re-derive or re-run the
   searches yourself; the whole point is that the numbers come from the script, not from
   agent inference.
3. Add a 2–3 sentence verdict grounded in the token-audit skill: name the token multiplier
   (grep tokens ÷ codastre tokens) and the precision gap, then state the corpus scale so the
   result isn't over-generalized (a small clean corpus flatters grep on absolute bytes).
4. If a side shows errors (missing checkout, `REPO_NOT_INDEXED`, CLI not found), surface
   them and point at the fix (`--workspace`, `REGISTER`, `CODASTRE_BIN`) rather than hiding
   a degraded run behind a clean-looking table.

# Codastre benchmark harness

Reproducible, **zero-inference** comparison of Codastre (`QUERY`/`GRAPH`) vs `grep`/`rg`
on the same information need. Every question pins its exact Codastre call, its exact grep
call, and a ground-truth answer key; `run.py` runs both sides, measures response
bytes / call count, extracts the returned locations, and scores precision/recall against
the key. No LLM is in the loop, so runs are deterministic and CI-friendly.

## Two tiers

| Tier | What it measures | Inference | Tooling |
|---|---|---|---|
| **A — scripted (this harness)** | Raw data-plane efficiency + correctness of a *fixed* recipe | **none** | `run.py` |
| **B — agentic** | End-to-end agent cost incl. reasoning + tool choice | 2 subagents | `/codastre:compare` |

Tier A is the right default for regression tracking (does a server change move tokens or
precision?). Tier B answers "does the agent actually pick the right tool and phrase the
query well?" — inherently a model question. Use Tier A unless you specifically need Tier B.

## Run it

```bash
# uses `codastre` on PATH and finds checkouts beside the plugin repo
python3 benchmarks/run.py

# explicit binary + checkout workspace, JSON out for CI
CODASTRE_BIN=/path/to/codastre python3 benchmarks/run.py \
    --workspace ~/src/github.com --format json --out report.json
```

Flags: `--cases` (default `cases.json`), `--workspace` (dir holding local checkouts, for
the grep side; default: env `CODASTRE_BENCH_WORKSPACE` or the dir beside the plugin repo),
`--bin` (default: env `CODASTRE_BIN`, else `codastre` on PATH, else
`<workspace>/codastre/cli/codastre`), `--format md|json`, `--out FILE`.

Requirements: the `codastre` CLI (authenticated, repos indexed), local checkouts of the
repos referenced in `cases.json`, and `rg` **or** `grep` on PATH (falls back to POSIX
`grep -rn -E` when ripgrep is absent).

## How scoring works

- **Locations** are normalized to `(repo, path)`. Codastre extracts them from
  `results[]` (QUERY) and `edges[].src/.dst` (GRAPH); grep parses `path:line:` lines.
  A repo's `repo_id` is resolved to its short name via one cheap setup query per repo
  (GRAPH's `repos` map omits `remote_url`, so this can't be read from the edge response).
- **Precision** = matched / returned, **Recall** = matched / expected — at *file*
  granularity, because Codastre returns chunk spans (e.g. `app/events.py:0-12`) while
  grep returns exact lines; both legitimately "find the file". The `expected` key still
  records the true line so containment can be checked.
- **Tokens** = result-bytes / 4, the comparable cost of ingesting each tool's output
  (matches the `codastre-token-audit` skill). The Codastre figure is the raw `--json`
  envelope; the `codastre serve` proxy inlines snippets on top of this — not added here.

## Adding a case

Edit `cases.json`. Each case needs: `codastre` (list of `{tool, args}` run as
`codastre <tool> <args> --json`), `grep` (list of `{pattern, repos}` — repos are short
names from the top-level `repos` map), and `expected` (`{repo, path, line, role}` ground
truth). Pin recipes that a real developer would actually run, and keep the answer key
honest — a hit not in `expected` counts against precision, so encode true edges you know
about (e.g. a second legitimate producer) rather than leaving them out.

## What's in the suite

The shipped cases deliberately span both tools and both outcomes: cross-repo GRAPH cases (kafka fan-out, http edge) that text search structurally can't answer, a conceptual QUERY and a plain-identifier QUERY, and **one literal-string case (`literal-config-key-grep-wins`) that grep is expected to win** — a config-key lookup where semantic ranking doesn't help. That counter-example is intentional: the bench should read as measurement, not marketing, and the skills already say grep is the right tool for literal strings.

## Caveats (state them when reporting)

- Tier A scores a *fixed* recipe, not an agent's choices — it can't reward Codastre's
  "one call answers it" ergonomics beyond the call/byte counts, nor penalize grep's
  follow-up `Read`s (which it doesn't run). It measures the tools, not the workflow.
- Token figures are chars/4 estimates, not tokenizer-exact.
- On a tiny, clean corpus grep stays competitive on absolute bytes for literal-string
  questions; Codastre's margin grows with corpus size, repo count, and cross-repo
  structure. Don't generalize a 4-repo result to a monorepo — report the corpus scale.

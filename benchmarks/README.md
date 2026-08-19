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
- **Tokens** = result-bytes divided by a ratio chosen for the payload's *shape* — ~2.5 for a
  JSON envelope, ~3.0 for the `agent` rendering, 4 for grep output (see the caveats below and
  `core/measurement.md`). It is the comparable cost of ingesting each tool's output. Codastre
  is reported at two rungs, `agent` and `json`; the `codastre serve` proxy inlines snippets on
  top of either — not added here.

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
- Token figures are estimates, not tokenizer-exact, and the ratio depends on the payload's
  shape: the Codastre side's JSON envelope is counted at ~2.5 chars/token (measured with
  `cl100k_base`, range 2.38–2.69), the grep side's raw output at 4 — which was **never
  measured** and is the prose default. Say so when reporting. A single flat 4 across both,
  which this harness used previously, understated Codastre's tokens by ~37% while leaving
  grep's roughly alone — i.e. it flattered Codastre in its own benchmark, so figures from
  before that fix are not comparable to figures after it.
- The Codastre side is priced at **two rungs of the `format` ladder**, and the report labels
  which is which. `codastre (agent)` is `--format agent` — the text rendering, the cheapest
  rung a caller can reach, and the headline figure. `codastre (json)` is raw `--json`, the
  most verbose rung and an upper bound. Same query and same ranking, so both rows carry the
  same precision/recall; only the encoding differs.
  - **Which rung you quote can flip the verdict**, so quoting one unlabelled is the mistake to
    avoid. On a single-repo smoke case the same QUERY measured ~1,060 tokens at `json` — a
    *loss* against grep's ~680 — and ~190 at `agent`, a 3.5× win. Reporting only `json` had
    Codastre losing a comparison it wins at the rung an agent actually uses.
  - Locations are parsed from the `--json` call **only**, so nothing about the rendering can
    move a precision or recall number.
  - The two figures come from **two adjacent invocations**, not one envelope rendered twice —
    the CLI cannot re-render a saved envelope. That is pinning by adjacency (see
    `core/measurement.md`, rule 2), so a moving index can put the two rungs on slightly
    different result sets. Deterministic fixtures make that unlikely, not impossible.
  - The extra invocation is **not** added to the call count: a caller picks one rung, and
    counting the harness's own double-measurement would report it as workflow cost.
  - On a binary that doesn't advertise `--format agent`, the report says the rung was
    unavailable rather than quoting a saving it couldn't ask for. Same if a rendering fails
    mid-run — the column collapses rather than summing part of the calls, which would read as
    a saving.
  - Neither figure includes proxy-hydrated snippet bodies, which this harness still doesn't
    add, so both understate a bodies-on call.
- On a tiny, clean corpus grep stays competitive on absolute bytes for literal-string
  questions; Codastre's margin grows with corpus size, repo count, and cross-repo
  structure. Don't generalize a 4-repo result to a monorepo — report the corpus scale.

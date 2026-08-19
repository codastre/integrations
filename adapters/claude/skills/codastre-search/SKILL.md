---
name: codastre-search
description: This skill should be used when searching or exploring a codebase — finding where something is implemented, locating definitions or usages, answering "where is X handled", "code that does Y", or "which repo owns Z". It teaches when and how to use the Codastre QUERY tool instead of Grep/Glob/rg/find, and when text search is still the right choice.
---

# Codastre Search

Codastre's `QUERY` tool is hybrid retrieval — dense semantic + BM25 lexical, fused with RRF — over every indexed repo. One call returns ~10 *ranked* results with real paths, line ranges, and locally-hydrated snippets. Use it as the default entry point for code search; it typically replaces a whole grep → refine → read cascade with a single call.

The tool name depends on how the MCP server was configured: `mcp__plugin_codastre_codastre__QUERY` (installed via this plugin) or `mcp__codastre__QUERY` (project-level config). Same contract either way.

## Decision rule: QUERY vs text search

**Use QUERY when the search is about meaning or identity:**

- Conceptual: "where do we validate JWTs", "retry logic for payments", "code that debounces sync"
- Identifier lookup: a function/class/symbol name, even partially remembered
- Cross-repo: you don't know which repo holds the code (omit `index_id`/`repo_url` → federated search across everything visible)
- Runbooks/docs: `content_kinds=["runbook","doc"]`; alert-driven lookup via `alert_ids=["KAFKA-1024"]` or `error_codes=["ERR_CONSUMER_LAG"]` is exact, not fuzzy

**Use Grep/Glob/rg when the search is about literal text:**

- Exact string matches: log messages, config keys, env var names, magic constants
- Uncommitted or unindexed files (QUERY sees the indexed ref, not your dirty working tree)
- Enumerating files by name pattern (that's Glob's job)
- **Declaration lookups you can spell exactly** — `protocol Foo`, `class Foo`, `interface Foo` (see below)
- Fallback: QUERY errored with `RETRIEVAL_UNAVAILABLE`

When unsure, one QUERY first is cheap — its top-10 either answers directly or gives you the exact paths to Read.

### Declaration lookups: a known weak spot — don't spend a second QUERY

Naming a declaration you can already spell (`"protocol RecallService createRecall getRecall"`) can rank the *conformers and callers* above the declaring file, and sometimes miss the declaration entirely: a bare protocol/interface body is a short chunk with little distinguishing vocabulary, so it loses to richer implementation chunks on both the dense and sparse legs. `grep -n "protocol Foo"` finds it in one call, because a declaration has a fixed textual form.

- **If you can write the literal form, text search is the right first tool.** This is where the "identifier lookup" rule above flips: QUERY wins for a *partially remembered or conceptual* name, not for one you can type exactly as `class Foo`.
- **If QUERY returns conformers but not the declaration, don't reword and retry.** That's the expensive failure mode — two hydrated calls (~12k tokens) for what one grep answers. Fall through to a literal search and say that's what you did.
- Still use QUERY for "what implements this / who calls this / how is this used" — answer sets with no fixed textual form.

## How to call it

Minimal call — just the query text (federated across all visible repos):

```
QUERY(query_text="where are Kafka consumer offsets committed")
```

Scoping (all optional):

| Parameter | Use |
|---|---|
| `repo_url` | Search one repo by its git URL (server resolves latest ready index) |
| `index_id` | Search one index by UUID (mutually exclusive with `repo_url`) |
| `ref` | Branch name — searches that branch's overlay on top of base |
| `language` | e.g. `"python"`, `"go"` |
| `path_prefix` | Restrict to a subtree — pass the **plaintext** prefix (e.g. `app/` or `server/api`); the server hashes it per repo for both masking schemes |
| `top_k` | **Use 4–6 for "where is X" lookups** — the answer is almost always in the top 3. 10 for exploration, 20+ only for surveys (max 50). Every extra hit is a fully hydrated snippet you pay for whether or not you read it |
| `content_kinds` | `["code"]`, `["runbook"]`, `["doc"]`; omit for all |
| `max_snippet_lines` | Cap this call's snippet bodies at N lines (`0` = none). Consumed by the local proxy, never sent to the server |
| `snippets` | `false` → ranked locations only, no bodies. Same: proxy-only |
| `format` | `"verbose"` (default) → `"compact"` → `"agent"`. Changes the *encoding* of the same result set, not which hits come back. See the ladder below |

**Cost and precision are different knobs.** `top_k` is the cost lever, linear in hydrated snippets.
`language` / `path_prefix` / `repo_url` are **precision** levers that can *raise* tokens per hit:
measured, adding `language` increased cost per hit ~30%, because it evicted the cheap junk (a SQL
structure dump, generated schema fragments) and the ranker backfilled with denser code — and that run
was the only one of six to find *both* correct implementations, with the fewest follow-up Reads. So
filter when you know the language or subtree; just don't filter expecting a smaller response. Size
with `top_k`, sharpen with filters.

**Reach for `path_prefix` on the first call, not only after a bad ranking.** In-repo scoping is the
lever most often left unused: `repo_url` alone still lets a large repo's L10n strings, snapshot tests,
and generated files compete for the top-k. If the question names or implies a subtree — a feature or
module name, a service folder, a layer (routes, handlers, migrations) — pass it as a plaintext
`path_prefix` immediately. One caution: it's a **hard filter**, so an over-narrow or stale prefix
returns nothing — check `filter_matched` before concluding "no results".

**Pass `language` even in a single-language repo.** "This repo is 100% Swift, so `language` filters
nothing" is a costly mistake: the repo is single-language in its *code*, but the index also holds
localization catalogs (`.strings`, `.xliff`), `.json`/`.yaml` config, `.plist`, and generated schema
dumps. Those are prime top-k noise — a localization catalog is a dense bag of exactly the domain
vocabulary a feature query uses, so it ranks well while answering nothing. One `language` parameter
evicts the whole class (this is the same effect as the measured ~30%-per-hit rise above: junk evicted,
real code backfilled). Skip it only when the resource files *are* what you're looking for.

Budget model — measured end-to-end (including follow-up Reads) on one lookup question in one repo.
Indicative, not a distribution:

| Configuration | Total |
|---|---|
| `top_k=4` | ~2.1k |
| `top_k=6` + `language` | ~3.3k |
| `top_k=10` (default) | ~6.6k, up to ~11.6k when it triggers a second QUERY |
| text search | ~1.7–3.8k — **and it returned a stale answer** |

At the **default**, "QUERY costs less than grep" was not true; it becomes true once you size the
call. The retrieval advantage does not come from the extra hits — it survives the cheapest
configuration intact.

### The `format` ladder, and the locate tier

`format` is a three-rung ladder on **QUERY and GRAPH** — orthogonal to `top_k` and the filters. Same
hits, same ranking, different packaging:

| Rung | Who does it | What it does |
|---|---|---|
| `verbose` (default) | server | Every field, full width |
| `compact` | server | Drops what a caller can't act on (`chunk_id` where `symbol_name` can seed GRAPH instead, `content_kind` at `code`, `path_class` at `app`), abbreviates `blob_sha` to 12 hex, rounds `score` to 4 dp |
| `agent` | local proxy | Renders the response as **text** — hits grouped by file, one path per file instead of one per hit, bodies as source with real line numbers instead of JSON-escaped strings. Rewritten to `compact` on the wire |

Also available outside a per-call argument: `codastre serve --format agent`,
`$CODASTRE_QUERY_FORMAT=agent` (for when the MCP config isn't yours to edit), and
`codastre query|graph --format agent` on the CLI — which on this client is not an alternative but
**the** way the rung arrives; see "the CLI plane is the default plane" below.

**`format: "agent"` + `snippets: false` is the locate tier** — the cheapest way to ask "where is X".
On Claude Code you ask for it as `codastre query … --format agent` (CLI bodies are already off), for
the reason under "the CLI plane is the default plane" below.
Measured at `top_k=5` on a deployed index, over the recorded payloads of one JSON-RPC frame (the MCP
plane, which is what you actually pay: a tool result carries its payload twice):

| Locate tier, `top_k=5` | bytes | tokens |
|---|---:|---:|
| `verbose`, both copies | 5,698 | 2,234 |
| `agent`, rendering in both copies | 1,951 (−66%) | 702 (−69%) |
| **`agent` + summarised `structuredContent`** | **1,116 (−80%)** | **391 (−82%)** |

On the CLI plane (one copy), the same tier measured −71% bytes / **−76% tokens** at `top_k=5`, and
−67% / **−73%** at `top_k=20`.

**Ask for both halves or you leave most of it on the table.** `snippets: false` alone still ships a
JSON envelope whose per-hit overhead *is* the whole response once the bodies are gone — the state
where the encoding costs most. `agent` alone with bodies on saves much less: the only direct
measurement is **−15% bytes**, and it was taken before the `structuredContent` summary landed, so it
understates today's shape. What is safe to say about bodies-on is the ordering — it saves, and it
saves far less than the locate tier. **Don't quote a bodies-on percentage as measured.**

What the numbers are worth: `cl100k_base`, not Claude's tokeniser; single deterministic runs on one
index, not a distribution; read them to the nearest few points, not the digit. Bytes *understate*
the token saving consistently (~2.5 bytes/token for a JSON envelope vs ~3.0 for the rendering,
because compaction strips the worst-tokenising bytes first), so every byte figure above is a floor.

**Check the rung is there before reaching for it.** A current proxy always advertises `format` on
QUERY and GRAPH — `verbose | compact | agent` once the server has shipped its own `format`,
`verbose | agent` when it has not, since the rendering is client-side and the proxy declares the
rung rather than gating a local saving on a server deploy. So an **absent** `format` means an
out-of-date `codastre` binary, not a server limitation (`codastre query --help` showing only
`human | json` confirms it). Most MCP clients won't send an argument the schema doesn't declare, so
with an old proxy the rung is genuinely unreachable — say so rather than reporting a saving you
couldn't ask for.

**Advertised is not the same as reachable — the client can swallow the rendering.** `agent` puts the
payload in `content[0].text` and a fixed summary in `structuredContent`, so **an MCP client that
prefers `structuredContent` when both are present shows the model the summary and nothing else**:
`status: "ok"`, a `result_count`, no results. Confirmed on 2026-08-18 against `codastre`
v0.14.0 by reading the JSON-RPC frame directly — the frame carried a 546 B rendering in
`content[0].text`; the model received only the 111 B summary. The proxy is fine; this is a
deterministic client-behaviour mismatch, not a codastre bug and not a flake.

Say the rung was unreachable **from this client** — not that the rung is broken.

### While that stands: the CLI plane is the default plane

Claude Code is the client that swallows the rendering, so over MCP the `agent` rung is not a saving
worth probing for — it's a call that returns nothing. **Don't re-prove it. Go to the CLI plane, and
probe the thing that genuinely varies: whether the installed binary can hydrate there.**

`codastre query` gained `--snippets` / `--max-snippet-lines` (CLI-plane hydration — bodies read from
your local checkout) in **v0.14.0**, together with `--format agent`. Every release up to **v0.13.1**
has neither, so an older binary can locate on the CLI but never answer from a snippet. Check once per
session, cheapest question first:

```bash
codastre version          # v0.14.0+ → hydrated; ≤ v0.13.1 → locations-only
```

If the version isn't a comparable release (a source build reporting `dev`, or anything unexpected),
ask the binary what it accepts instead — and pattern-match rather than piping to `grep`, so a check
about Codastre doesn't read as a text search:

```bash
case "$(codastre query --help 2>&1)" in *--snippets*) echo hydrated;; *) echo locations-only;; esac
```

**Hydrated (v0.14.0+) → run this session's searches on the CLI.** The flags map one-for-one onto the
QUERY arguments above:

```bash
codastre query "kafka consumer offsets commit" --language go --path-prefix internal/ \
  --format agent --snippets --max-snippet-lines 40      # --top-k already defaults to 6
```

**The one trap is inverted from MCP: the CLI ships bodies OFF.** `snippets` defaults to `true` on
QUERY, but `--snippets` is opt-in on the CLI — so `--format agent` alone hands you the locate tier
whether or not you meant it. Pass `--snippets` for ordinary "where is X / what does X do"; leave it
off when the ranking *is* the answer. `--json` is never hydrated, so it is not a bodies-on option.
Read the rendering exactly as described under "Reading an `agent`-format response" below; it carries
`stale`, the `hydration` reason, `snippet_truncated`, `freshness` and `filter_matched` just like the
envelope, so nothing you act on is lost.

**Locations-only (≤ v0.13.1) → say it once, then use MCP `verbose`.** The MCP proxy hydrates from the
same checkout, so bodies are still reachable — in the expensive encoding. Name the version and the
remedy once, and never repeat it:

> `codastre v0.13.1` can't render or hydrate on the CLI plane (`--format agent` / `--snippets` landed
> in v0.14.0), and this client swallows the MCP `agent` rung — so I'll use MCP `verbose`, which costs
> roughly 1.5× a hydrated CLI call. Update `codastre` the way you installed it (Homebrew tap, release
> binary, or `go install` from a checkout) and `codastre version` will confirm it.

Don't guess a package name or run an installer unasked — which channel installed the binary is the
user's to say; check `codastre version` first.

Measured 2026-08-18 against v0.14.0, `top_k=5`, one repo, both planes in one session over the **same
five hits verified identical** (MCP frames captured by driving `codastre serve` over stdio; CLI from
stdout bytes; tokens at JSON 2.5 / rendering 3.0 ch/tok):

| bodies | plane and rung | on the wire | what the model receives | ~tokens |
|---|---|---:|---|---:|
| on | MCP `verbose` | 15,572 B (payload twice) | one copy, JSON | ~3,186 |
| on | **CLI `--format agent --snippets`** | 6,483 B | the rendering | **~2,161 (−32%)** |
| off | MCP `verbose` + `snippets: false` | 5,208 B | one copy, JSON | ~1,026 |
| off | **CLI `--format agent`** | 648 B | the rendering | **~216 (−79%)** |
| either | MCP `agent` | 863–6,917 B | the 111 B summary — **no results** | ~44 |

Two readings worth keeping straight: the saving is far larger with bodies **off** (−79%) than on
(−32%), because the envelope overhead the rendering removes is most of a bodies-off response and
almost none of a bodies-on one; and the CLI plane is **not cheaper in context than a working MCP
`agent` rung** — it's the identical rendering (6,483 vs 6,484 B). It's cheaper on the wire, and it's
the one that arrives here. Credit the rung, not the plane.

**Stay on MCP when:** Bash isn't available (restricted subagent or sandbox); the CLI isn't installed
or logged in (`codastre doctor`); you need `REGISTER` (no CLI equivalent); or the client *doesn't*
swallow the rendering, in which case MCP `agent` is the cheapest rung of all and the detour buys
nothing. This whole section is contingent on a client behaviour — when a `codastre` release stops
emitting the summary, the detour goes away.

Both planes are accounted for identically: a `codastre query|graph` Bash call is logged as
`class: "codastre"`, `plane: "cli"`, satisfies `auto` mode's "try Codastre first", and is priced at
the rendering's ratio — so switching planes doesn't make the cost invisible.

**When to suppress bodies:** pass `snippets: false` (or `max_snippet_lines: 0`) only when the ranking
itself is the answer and you'll read the file anyway — "which repo owns X", enumerating candidates, a
broad sweep you'll narrow immediately. Not for ordinary "where is X / what does X do": answering from
the inline snippet *is* the token advantage, and a suppressed body you then Read costs more than the
body would have. If you're Reading every hit you suppressed, lower `top_k` instead.

**Refinement calls are the other place bodies come off.** When a second call *narrows* the first — an
added filter, a lower `top_k`, a rewording aimed at the same targets — its top hits are largely the
ones you just saw hydrated, and the proxy is stateless: it re-reads and re-ships those bodies, and
you pay the same bytes for content already in your context. Keep bodies on the first call, pass
`snippets: false` on the refinement, and Read the ranges that matter instead.

Both conditions are required. The second call must genuinely *refine* — a follow-up on a new
question isn't a refinement, and there the snippets are the answer. And the replacement Read is
capped at **the one or two ranges the refinement was for**: if you're Reading more than that, you
refined wrong, and the fix is a lower `top_k` with bodies kept, not suppressing everything and
rebuilding it a Read at a time. (Unmeasured — the overlap between a query and its refinement hasn't
been quantified, so treat this as a shape rule, not a budget.)

Query phrasing: lead with **code vocabulary**, not a full English question. `"kafka consumer subscribe orders topic"` ranks far better than `"which services react to a new order?"` — the sparse (BM25) leg matches terms that actually appear in code, and the dense leg embeds short code chunks weakly, so a discursive question tends to return a flat, low-scored, noisy ranking. Bare identifiers work well too (`"hydrateSnippet"`). Don't stuff both a concept and an unrelated identifier into one query — issue two calls.

Reading the scores: results carry an RRF `score`. If the top scores are all tiny and nearly **equal** (e.g. every hit ~0.016, decreasing by a hair), the dense and sparse legs found *disjoint* sets and nothing reinforced — that's a weak, low-confidence ranking, not a confident answer. Reword toward code vocabulary, add filters, or corroborate by Reading before trusting such a result.

**A high-confidence ranking can still hide a wrong causal link between two of its own hits.** Observed in the field: asked how a push-notification token reaches the backend, QUERY correctly ranked both the real registration route and an unrelated third-party SDK call in the top-k, and the agent inferred a connection between them that was false — the SDK call never touches that route. Nothing in the envelope flags this: score, `stale`, and `hydration` were all fine on both hits, because both files are real and current. This is a different failure from staleness — it's a wrong inference *about* two correct hits, not a stale citation. Don't state a causal link between two QUERY hits ("A calls B", "A's result flows into B") without Reading the line that makes the connection; a hedge word like "presumably" in your own draft answer is the signal to go verify, not a license to publish it hedged. For a genuine "does A call B" question, use GRAPH's `calls` edges instead — that's the tool that actually verifies the edge; QUERY's ranking never does.

Scope on multi-repo tenants: federated QUERY quality **degrades when the tenant holds large, unrelated, or fixture-heavy repos** — their files compete for the top-k and can crowd out the repo you care about. When you know the target, scope with `repo_url=` (single repo) or `path_prefix=` (plaintext — the server translates it); on a noisy tenant this is the default, not an optimization. Results carry `path_class` (`app | test | fixture | vendored | doc_asset`) — filter on it instead of guessing from path patterns; treat non-`app` hits as likely noise unless tests/fixtures are what you're looking for. (Servers also drop fixture corpora and vendored doc assets from indexing by default now, so most of that noise never appears.)

## Reading the response

These results assume the **local `codastre serve` proxy** (the plugin's default and preferred config — it unmasks paths and hydrates snippets from local disk).

**If results come back with `path_token` but no `real_path`/`snippet`, check the repo's `masking_scheme` in the envelope's `repos` map before concluding anything is broken** — the right diagnosis depends on it:

**First check for a `hydration` field.** When the proxy can't produce a snippet it says why, and the reason is what tells you whether anything is broken:

| `hydration` | Meaning | What to do |
|---|---|---|
| `snippets_disabled` | Bodies were turned off — by the operator, or by this call's `snippets: false` | Nothing. The paths are the answer; Read what you need |
| `no_local_checkout` | No local clone of that repo | Clone it, or use the codastre-fetch-source skill |
| `file_not_found_in_checkout` | Clone exists, file isn't at that path | Fetch/pull |
| `line_range_not_in_file` | Right path, wrong ref | Fetch, or re-query at the checked-out ref |
| `path_unmask_failed` | hmac repo whose masking key isn't on this machine | `codastre masking-key --repo-url <url>` if entitled |
| `read_error` | Permissions or I/O | Check the file |

- **`masking_scheme: none` (cleartext repos — the common dev/eval setup):** `path_token` *is* the real, repo-relative path, and the proxy hydrates these too. If a snippet is missing, read the `hydration` reason above rather than assuming a hydration gap.
- **No `snippet` *and* no `hydration` field at all:** the MCP config is talking to the server's raw HTTP endpoint instead of `codastre serve`. The server never holds source, so that path has no snippets by design. Read `path_token` as a repo-relative path and flag that the setup should use the local proxy.

Truncated snippets:

- **`snippet_truncated: true`** — the body hit the proxy's line budget and stops at `snippet_line_end`. `line_start`/`line_end` still describe the whole chunk that was *ranked*, so the two disagree on purpose. Quote what you were given; if the answer is plainly cut mid-thought, Read on from `snippet_line_end + 1`.
- Derived content (generated code, vendored trees, fixtures, lockfiles, schema/SQL dumps, `dist/`) is truncated hard to a ~10-line headline on purpose — it was 27% of the payload and 0% of the answers in the measured run. If one of those genuinely *is* your target, Read the file rather than re-querying.

Line-range Reads on `none` repos: the returned `line_start`/`line_end` are the chunk span; pass them straight to `Read`'s `offset`/`limit`. If a `line_start` of `0` shows up, treat it as line 1 (offsets are 1-based in Read).

Each result (via the proxy):

- `real_path`, `line_start`, `line_end`, `score` — cite as `real_path:line_start`
- `snippet` — the actual code lines, already in the response; usually no Read needed
- `stale: true` — local file changed since indexing; re-Read that range before relying on the snippet
- `repo_id` — which repo (resolve via the top-level `repos` map in federated mode)

### Reading an `agent`-format response

The rendering *is* the answer, and three things move when you ask for it:

- **`structuredContent` no longer holds the results.** It carries a fixed-size summary — `format`,
  `status`, `freshness`, a result or edge count, and `rendering_in` naming where the payload is.
  **The answer is in `content[0].text`.** A client that reads only `structuredContent` gets no
  results in this format. That trade is deliberate and applies to `agent` alone — asking for a text
  rendering is an explicit request for one — and the JSON default still carries the full payload in
  both representations.
- **`blob_sha` is abbreviated to 12 hex chars. Verify it by prefix, never by equality.** This is the
  normative comparison now, not a display concession: an abbreviated sha compared for equality
  against a full 40-hex hash marks every file stale. `git rev-parse --short=12` puts both sides in
  the same form (the codastre-fetch-source skill does this). `compact` sends the same 12 chars the
  rendering prints — the two widths are specified to stay equal, so one blob never yields two
  strings.
- **A hit with no `symbol_name` keeps its `chunk_id`, printed as `seed:<id>`.** That is GRAPH's
  exact seed and the intended QUERY → GRAPH handoff — pass it verbatim as `chunk_or_symbol` rather
  than re-resolving by name (see the codastre-graph-navigation skill). It appears only where it's
  the *only* seed available: a hit carrying a `symbol_name` prints no `seed:` tag, because the name
  seeds GRAPH just as well for a fraction of the bytes.

Defaults print nothing rather than printing their default: no `content_kind` tag means `code`, no
`path_class` tag means `app`, and on a `snippets: false` response the `snippets_disabled` reason is
stated once in the header instead of on every hit. Absence is the default, not a missing field.

Envelope semantics that matter:

- `results: []` with `status: "ok"` is a **valid answer**: the corpus was searched and nothing matches. Do not immediately re-run the same query through grep "just in case" — reserve that for genuinely literal strings.
- `filter_matched: false` (only present when you passed `path_prefix`) — your prefix matched **nothing indexed** (typo or stale path); fix the prefix rather than concluding "no results". `true`/absent means the empty result is genuine.
- Federated responses scope `repo_freshness`/`mask_key_revs`/`repos` to the repos present in `results` and report `searched_repo_count` instead of the full `searched_repos` list; pass `full_envelope=true` only if you need the all-tenant maps.
- `freshness: "syncing"` — results are base-index only; recent commits may be missing. Say so if it could matter.
- Error `RETRIEVAL_UNAVAILABLE` — data plane down. Fall back to Grep/Glob and note the degradation.
- `REPO_NOT_INDEXED` — the repo needs `REGISTER` first.

## Token-efficient workflow

1. One search with a well-phrased question — lead with **code vocabulary** (see phrasing above). A discursive first attempt is the single most common cause of a flat, low-value ranking and the re-query cascade that follows. On Claude Code, make it a CLI-plane call (`codastre query … --format agent --snippets`) once the one-line capability probe says the binary can hydrate; the parameter guidance above applies unchanged, flag for argument.
2. Answer from the snippets when they suffice (they usually do for "where/what" questions).
3. Read only the 1–2 files that need full context — targeted, with offsets from `line_start`/`line_end`.
4. For structural follow-ups ("what calls this?"), switch to GRAPH (see the codastre-graph-navigation skill) instead of grepping for the symbol name.

### Stop rule — one *scoped* call, then answer

The dominant cost variance across otherwise-identical questions is **cascade length, not per-call size**: one run answers after a single QUERY; another piles on a second QUERY + a GRAPH + extra Reads "to be sure" and burns 2–3× the tokens for the same answer. That non-determinism is the instability — cap it:

- **Scope the first call; don't buy insurance with `top_k`.** "One call, then stop" is not a licence to make that one call maximal. The cheapest correct run measured was a single *narrow* call (`top_k=4–6`, one filter). Broadening the first call to avoid a possible second one costs more than the second call would have, because you pay for every hit whether you read it or not. Put the scoping in the first call, not in a remedy after a noisy one.
- **Sharp ranking → stop.** If the first QUERY's top `score` is clearly separated from the tail (≳ 0.3), the snippets *are* the answer. Do not add a GRAPH call or re-Read files for confirmation unless a genuinely *structural* question remains.
- **Flat ranking → reshape once, don't respray.** All scores ~0.016 and near-equal means the dense and sparse legs found disjoint sets. Re-running near-identical wordings won't move rank. Reword once toward code vocabulary, or add one filter (`repo_url` / `path_prefix` / `language`), then Read the single best `app`-class hit. One reshape, not three rewordings.
- **Don't run both tools for a question only one owns.** "Which repo / where / what does X" is QUERY's job; "what calls X / what breaks if I change X" is GRAPH's. Reaching for GRAPH after QUERY already answered a where/what question is the most common source of the doubled cost.

Anti-patterns: grepping a symbol across the tree when QUERY would rank definitions first; running QUERY repeatedly with tiny rewordings (rank quality won't change much — refine with filters instead); `top_k=50` by default (that forfeits the token advantage); leaving `top_k` at 10 for a narrow "where is X" lookup when 4–6 answers it; suppressing snippets and then Reading every hit anyway; a reflexive GRAPH or corroborating Read after a QUERY that already answered the question.

## Related

- `/codastre:search <query>` — one-shot slash command (CLI-plane by default, same probe)
- `/codastre:compare <question>` — side-by-side QUERY vs grep demo with token accounting
- `codastre doctor` (shell) — connectivity diagnostics when calls fail
- **Source of truth:** this skill is compiled from the agent-neutral `core/retrieval-playbook.md` in the monorepo root — edit that first, then re-sync this skill.

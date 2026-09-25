# Codastre Retrieval Playbook (agent-neutral)

This is the **agent-neutral source of truth** for how to drive Codastre's retrieval tools well —
the QUERY-vs-text-search decision, query phrasing, reading scores/confidence, the one-call stop
rule, and graph navigation. It is written once here and *compiled* into each agent adapter:

- **Claude** → `adapters/claude/skills/codastre-search/SKILL.md` and
  `adapters/claude/skills/codastre-graph-navigation/SKILL.md` (Claude skill format + the
  `mcp__…__QUERY` / `mcp__…__GRAPH` tool names).
- **Future adapters** (e.g. a Codex `AGENTS.md` section) transform this same content into their
  own format and call syntax.

Only two things differ per agent: the **call syntax** (tool names / invocation) and the **harness
wiring** (hooks, context injection). The ~90% below — *when* and *how* to retrieve — is shared. When
you change a rule, change it here first, then re-compile the adapters so they don't drift.

Throughout, **QUERY** = the hybrid semantic + lexical search tool; **GRAPH** = the cross-repo
relationship graph tool. Adapters substitute their concrete tool names.

---

## 1. QUERY vs text search — the decision

**Use QUERY when the search is about meaning or identity:**

- Conceptual: "where do we validate JWTs", "retry logic for payments", "code that debounces sync".
- Identifier lookup: a function/class/symbol name, even partially remembered.
- Cross-repo: you don't know which repo holds the code (federated search across everything visible).
- Runbooks/docs and alert/error-code lookups (exact, not fuzzy).

**Use text search (grep/glob/rg/find) when the search is about literal text:**

- Exact string matches: log messages, config keys, env var names, magic constants.
- Uncommitted or unindexed files (QUERY sees the indexed ref, not your dirty working tree).
- Enumerating files by name pattern.
- **Declaration lookups where you already know the exact keyword + name** — "where is `protocol Foo`
  / `class Foo` / `interface Foo` declared". See below.
- Fallback when QUERY is unavailable (retrieval down) or a repo isn't indexed.

When unsure, one QUERY first is cheap — its top results either answer directly or hand you the exact
paths to read.

### Declaration lookups: a known weak spot — don't spend a second QUERY

A query naming a declaration you already know the exact spelling of (`"protocol RecallService
createRecall getRecall"`) can rank the *conformers and callers* above the declaring file, and
sometimes omit the declaration entirely — a chunk that is a bare protocol/interface body is short,
carries little distinguishing vocabulary, and loses to richer implementation chunks on both the dense
and sparse legs. Meanwhile `grep -n "protocol Foo"` finds it in one call, because a declaration has a
fixed textual form.

- **If you can write the declaration's literal form, text search is the right first tool.** This is
  the identifier case where the §1 rule flips: "identifier lookup" favors QUERY when the name is
  *partially remembered or conceptual*, not when you can type `class Foo` exactly.
- **If a QUERY comes back with conformers but not the declaration, do not re-query.** Reword-and-retry
  is the expensive failure mode here (two hydrated calls, ~12k tokens, for what one grep answers).
  Fall through to a literal search for the declaration keyword and say that's what you did.
- Don't over-generalize: QUERY still wins for "what implements this / who calls this / how is this
  used", where the answer set has no fixed textual form.

## 2. Query phrasing

Lead with **code vocabulary**, not a full English question. `"kafka consumer subscribe orders topic"`
ranks far better than `"which services react to a new order?"`: the lexical (BM25) leg matches terms
that actually appear in code, and the dense leg embeds short code chunks weakly, so a discursive
question tends to return a flat, low-scored, noisy ranking. Bare identifiers work well
(`"hydrateSnippet"`). Don't stuff a concept and an unrelated identifier into one query — issue two.

## 2b. Sizing the call — what each knob actually costs

Every ranked hit comes back with a **fully hydrated snippet**, whether or not you read it. The
response is therefore priced per hit, and the knobs are not interchangeable:

| Knob | Effect on cost | Use it for |
|---|---|---|
| `top_k` | **The cost lever.** Linear — each extra hit is another snippet you pay for | Sizing the call to the question |
| `language`, path prefix, repo scope | **Precision levers, not cost levers** — they can *raise* tokens per hit | Getting a better result set |
| `max_snippet_lines`, `snippets` | Cap or remove snippet bodies (local-proxy only — see §4b) | Orientation questions where the paths *are* the answer |
| `format` | **The encoding lever.** Changes how the same result set is packaged, not which hits come back (§2c) | Cutting the cost of an answer you have already decided to ask for |

**`top_k`: use 4–6 for "where is X" lookups.** The answer is almost always in the top 3. Measured on
a lookup question, ranks 4–10 were **70% of the payload and contributed to zero answers** — while the
cheapest configuration still found the correct current implementation that text search missed
entirely. Use 10 for exploration, 20+ only for surveys. The tool's default of 10 is tuned for the
general case, not for your question.

**Filters raise cost per hit and are still worth passing.** Counterintuitive but measured: adding
`language` *increased* tokens-per-hit by ~30%, because it evicted the cheap junk (a SQL structure
dump, generated schema fragments) and the ranker backfilled with denser, more substantive code. That
run was the only one to find *both* correct implementations and needed the fewest follow-up reads.
So filter when you know the target language or subtree — just don't filter *expecting* a smaller
response. Cost is `top_k`; quality is filters.

**Budget model** — measured end-to-end including follow-up reads, on one lookup question in one
repo. Indicative, not a distribution:

| Configuration | Total |
|---|---|
| `top_k=4` | ~2.1k |
| `top_k=6` + `language` | ~3.3k |
| `top_k=10` (default) | ~6.6k, up to ~11.6k when it triggers a second query |
| text search | ~1.7–3.8k — **and it returned a stale answer** |

Note what that table says: at the **default**, "QUERY costs less than text search" was not true. It
becomes true once you size the call. The retrieval advantage does not come from the extra hits — it
survives the cheapest configuration intact.

## 2c. The response-format ladder

`format` is a three-rung ladder on **QUERY and GRAPH**. It is orthogonal to `top_k` and the filters:
same hits, same ranking, different packaging.

| Rung | Who does it | What it does |
|---|---|---|
| `verbose` (default) | server | Every field, full width. What every caller gets unless it asks otherwise |
| `compact` | server | Drops what a caller cannot act on — `chunk_id` where `symbol_name` can seed GRAPH instead, `content_kind` at `code`, `path_class` at `app`, GRAPH's `edge_id` unconditionally — abbreviates `blob_sha` to 12 hex, rounds `score` to 4 dp and `confidence` to 3 dp |
| `agent` | server (v0.18.0+), or the local proxy when it can enrich | Renders the response as **text**: hits grouped by file so a path is written once per file rather than once per hit, bodies as source with real line numbers instead of JSON-escaped strings. Built from the `compact` shape, because the renderer reads nothing `compact` drops. The server's rendering prints masked paths as `[masked]` and carries no bodies; the proxy takes over when it can add real paths and bodies |

Also reachable outside a per-call argument: `codastre serve --format agent`,
`$CODASTRE_QUERY_FORMAT=agent` (for when the MCP config is not yours to edit), and
`codastre query|graph|corpora|contracts --format agent` on the CLI. Which plane the rung arrives on
depends on the CLI version — see "v0.18.0: the rendering reaches the model on both planes" below.
`CORPUS_SEARCH` and `CONTRACTS` have no MCP `format` argument at all, so their agent rung exists only
on the CLI.

### The locate tier: `format: "agent"` + `snippets: false`

The two compose, and the pair is the cheapest way to ask "where is X". Measured at `top_k=5` on a
deployed index, reconstructed over the recorded payloads of one JSON-RPC frame — the MCP plane,
which is the one an agent actually pays for, because a tool result carries its payload twice:

| Locate tier, `top_k=5` | bytes | tokens |
|---|---:|---:|
| `verbose`, both copies | 5,698 | 2,234 |
| `agent`, rendering in both copies | 1,951 (−66%) | 702 (−69%) |
| **`agent` + summarised `structuredContent`** | **1,116 (−80%)** | **391 (−82%)** |

On the CLI plane (one copy of the payload, `codastre query --format agent`), the same tier measured
−71% bytes / **−76% tokens** at `top_k=5` and −67% / **−73%** at `top_k=20`.

**When bodies are worth keeping.** With `snippets: true` the ladder still pays, but much less and on
weaker evidence. The only direct measurement is `verbose` → `agent` with bodies on, both copies, at
**−15% bytes** — taken *before* the `structuredContent` summary landed, so it understates today's
shape. Carrying that summary through the same arithmetic puts bodies-on somewhere near −57% bytes,
but that is arithmetic on a recorded response, not a measurement: **do not quote a bodies-on
percentage as measured.** What is safe to say is the ordering — bodies-on saves less than the locate
tier, and the gap is large.

So: reach for the locate tier when the ranking *is* the answer and you will open the file anyway.
Keep bodies — and take the smaller, softer saving — for ordinary "where is X / what does X do",
where answering from the inline snippet without a follow-up read is the whole token advantage. The
rule in §4b is unchanged by the ladder; `format` changes what each choice costs, not which to make.

### What the numbers are worth

- Measured with `cl100k_base`, not Claude's tokeniser — same family, so the ordering holds and the
  magnitudes may move.
- **Bytes understate the token saving, consistently.** Bytes per token rises along the ladder (~2.5
  for a JSON envelope, ~3.0 for the agent rendering) because compaction removes the worst-tokenising
  bytes first: long hex ids, JSON punctuation, escaped quotes. Every byte figure above is a *floor*
  on the context saving.
- Single deterministic measurements on one index, not a distribution. Read them to the nearest few
  points, not the digit.
- **A live index is not a stable result set.** The same repo-scoped query re-run hours later returns
  a different set — a hit dropped, another appeared, spans and scores moved. Repo-scoping removes
  federated fan-out nondeterminism, not the index's own motion. Never compare a fresh measurement
  against a figure quoted from an earlier run; capture both sides together over one pinned result
  set — see `measurement.md`, "Pinning the result set".

### Before you reach for it: is the rung actually there?

A current proxy always advertises `format` on QUERY and GRAPH. What it advertises depends on the
server: `verbose | compact | agent` once the server has shipped `format` of its own, and
`verbose | agent` when it has not — the `agent` rendering is client-side, so the proxy declares the
rung itself rather than gating a local saving on a server deploy.

So an **absent** `format` means an out-of-date `codastre` binary, not a server limitation. Check the
tool schema rather than assuming, and `codastre query --help` showing only `human | json` confirms
it. Most MCP clients refuse to send an argument the schema does not declare, so with an old proxy
the rung is genuinely unreachable — say the rung was unavailable rather than reporting a saving you
could not ask for.

Two consequences worth holding: `agent` works as soon as the proxy is new enough, whatever the
server does; and until the server ships `format`, the `compact` rung is absent from the enum
precisely because it would promise a saving that never arrives.

### v0.18.0: the rendering reaches the model on both planes

**On a `codastre` CLI v0.18.0 or newer, MCP `format: "agent"` works in Claude Code.** The server now
renders `agent` itself and returns the rendering in **both** representations — `content[0].text` and
`structuredContent.rendering` — alongside `format`, `status`, `freshness` and `result_count`. The
proxy stopped rewriting `agent` → `compact` unconditionally: it forwards the argument and takes the
rendering over only when it can enrich it (real paths, local bodies).

Verified on 2026-09-23 against v0.19.1 through the plugin's own MCP server: a
`format: "agent"` QUERY returned `{"format":"agent","rendering":"codastre · 2 hits …", …}`, where a
v0.14.0 binary returned only `rendering_in: "content[0].text"`.

What this changes:

- **Plane choice stops mattering for cost in context.** Both planes hand the model the same
  rendering; the MCP copy arrives JSON-escaped inside `structuredContent`, which measured **+4%** on
  one 3-hit bodies-on call (4,319 B CLI stdout vs the same rendering escaped). The CLI is cheaper
  only *on the wire*, where MCP ships the rendering twice (the server measured MCP `agent` at −21% vs
  verbose on the wire with bodies on, −80% on the locate tier). Use whichever plane is at hand.
- **Read `rendering`**, from `structuredContent` or `content[0].text` — they are the same string.
- **Everything below this section, up to §3, applies to v0.14.0–v0.17.x only.** It is kept because
  those binaries are still installed on some machines, and on them it is still exactly right.

The version gate, in full:

| `codastre version` | MCP `format: "agent"` in Claude Code | CLI `--format agent --snippets` | Use |
|---|---|---|---|
| v0.18.0+ | works | works | either plane |
| v0.14.0 – v0.17.x | **returns no results** (summary only) | works | the CLI plane |
| ≤ v0.13.1 | returns no results | not available | MCP `verbose` |

A `dev` or unparsable version can't be placed on this table: treat it as v0.14.0–v0.17.x if
`codastre query --help` lists `--snippets`, else as ≤ v0.13.1. The plugin's SessionStart hook does
this resolution locally and states the result, so a session normally never needs to run the check.

### The client can swallow the rendering (v0.14.0 – v0.17.x)

**`agent` puts the payload in `content[0].text` and a fixed summary in `structuredContent`. An MCP
client that prefers `structuredContent` when both are present therefore shows the model the summary
and nothing else** — `status: "ok"`, a `result_count`, no results. The call succeeded, the proxy
rendered correctly, and the model received none of it.

Confirmed in one MCP client on 2026-08-18 against `codastre` v0.14.0 by driving `codastre serve` directly and
comparing the JSON-RPC frame with what the client surfaced:

| | raw MCP frame | what the model got |
|---|---|---|
| `agent` | 770 B — `content[0].text` = 546 B rendering, `structuredContent` = 111 B summary | the 111 B summary only |
| `verbose` | 5,618 B — payload in both representations | the payload |

So this is **not** a codastre bug and not an unreproduced one-off: it is a deterministic consequence
of that content-selection rule meeting a format that deliberately stops duplicating its payload. It
is also a different failure from an absent rung (above) — the schema advertises `format`, the
argument is accepted, and `status` is `ok`. The only symptom is that the results aren't there.

Report it accordingly: say the rung was unreachable **from this client**, not that the rung is
broken.

**The upstream fix is to stop emitting the summary.** A tool result may omit `structuredContent`
entirely; in `agent` format the summary carries nothing a caller acts on (`format`, `status`,
`freshness`, a count, and a pointer to where the payload is). Omitting it — or carrying the
rendering in it — would make the rung work on every client and shrink the frame further. Worth
filing with the frame evidence above.

### While that stands: run the ladder on the CLI plane (v0.14.0 – v0.17.x)

Claude Code is the client that gets this wrong, and it is the primary one — so on Claude Code the MCP
`agent` rung is not a saving to probe for, it is a call that returns nothing. **Don't spend a probe
proving it again. Reach for the CLI plane first**, and probe the thing that actually varies between
machines: whether the installed `codastre` can hydrate there.

**The capability gate is the binary's age, and it is recent.** `codastre query` gained `--snippets`
and `--max-snippet-lines` — CLI-plane hydration, reading each hit's body from your local checkout —
in **v0.14.0**, alongside `--format agent`. Up to and including **v0.13.1** the CLI had neither:
`--format` was `human | json` and there was no way to ask for bodies at all. So an older binary can
still *locate* on the CLI plane, but it cannot answer from a snippet, which is most of the retrieval
advantage.

Check once per session, and start with the cheap question:

```bash
codastre version          # → codastre v0.14.0 (commit …, built …)
```

v0.14.0 or newer → hydrated. Older → locations-only. If the string isn't a comparable release (a
source build reporting `dev`, an empty or unexpected version), ask the binary what it actually
accepts, which is the truthful test either way:

```bash
case "$(codastre query --help 2>&1)" in *--snippets*) echo hydrated;; *) echo locations-only;; esac
```

Note it pattern-matches rather than piping to `grep`: the check is about Codastre, and phrasing it as
a text search would make it read as one to the mode hook.

**Hydrated (v0.14.0+) → the CLI plane is this session's retrieval plane.**

```bash
codastre query "kafka consumer offsets commit" --language go --path-prefix internal/ \
  --format agent --snippets --max-snippet-lines 40      # --top-k defaults to 6 already
codastre graph OrderProcessor --direction inbound --format agent
```

One trap, and it is the opposite of the MCP default: **the CLI ships bodies OFF.** `snippets` is
`true` by default on QUERY, but `--snippets` is opt-in on the CLI, so `codastre query … --format
agent` alone gives you the locate tier whether you meant it or not. Pass `--snippets` for ordinary
"where is X / what does X do", leave it off when the ranking *is* the answer — the §4b rule, on the
other plane. `--json` is never hydrated, so it is not a bodies-on option here.

**Locations-only (≤ v0.13.1) → say so once, then use MCP `verbose`.** The MCP proxy hydrates from the
same local checkout, so bodies are still reachable — just in the expensive encoding. Tell the user
once, name the version and the remedy, and don't repeat it:

> `codastre v0.13.1` can't render or hydrate on the CLI plane (`--format agent` / `--snippets` landed
> in v0.14.0), and this client swallows the MCP `agent` rung — so I'll use MCP `verbose`, which costs
> roughly 1.5× a hydrated CLI call. Updating `codastre` gets that back; update it the way you
> installed it (Homebrew tap, release binary, or `go install` from a checkout) and re-run
> `codastre version` to confirm.

Never guess a package name or run an installer unasked — `codastre version` is the check, and
which channel installed the binary is the user's to say.

Measured on 2026-08-18 against v0.14.0, `top_k=5`, one repo, both planes in one session over the
**same five hits verified identical** — MCP frames captured by driving `codastre serve` over stdio,
CLI figures from stdout bytes, tokens at the ratios in §"What the numbers are worth" (JSON 2.5,
rendering 3.0):

| bodies | plane and rung | on the wire | what the model receives | ~tokens |
|---|---|---:|---|---:|
| on | MCP `verbose` | 15,572 B (7,485 + 7,965, twice) | one copy, JSON | ~3,186 |
| on | MCP `agent` | 6,917 B | the 111 B summary — **no results** | ~44 |
| on | **CLI `--format agent --snippets`** | 6,483 B | the rendering | **~2,161 (−32%)** |
| off | MCP `verbose` + `snippets: false` | 5,208 B (2,436 + 2,566) | one copy, JSON | ~1,026 |
| off | MCP `agent` + `snippets: false` | 863 B | the 111 B summary — **no results** | ~44 |
| off | **CLI `--format agent`** | 648 B | the rendering | **~216 (−79%)** |

Two things to read carefully there. **The saving is much larger with bodies off** (−79%) than on
(−32%) — same ordering as the ladder's own table, and the same reason: the JSON envelope's per-hit
overhead is what compaction removes, and with bodies on the source text dominates both encodings.
And **the CLI plane is not cheaper *in context* than a working MCP `agent` rung** — it is the same
rendering, byte for byte (6,483 vs 6,484). It is cheaper on the wire, and it is the only one of the
two that arrives on this client. Say that, rather than crediting the plane with a saving that belongs
to the rung.

**When to stay on MCP even with a hydrated CLI.** The plane switch is about the format ladder, not
about abandoning the tools:

- **No Bash** — a subagent or sandbox with a restricted tool set. Then MCP `verbose` is the only
  plane, and that is fine.
- **The CLI isn't installed, or isn't logged in.** `codastre doctor` says which.
- **`REGISTER`** has no CLI equivalent (`codastre sync` covers SYNC), so indexing stays on MCP.
- **A client that doesn't swallow the rendering.** Then MCP `agent` is the cheapest rung of all
  (1,116 B at the locate tier, above) and the CLI detour buys nothing. That fix landed in v0.18.0
  (the server now carries the rendering in `structuredContent`) — see the section above.

Both planes are now instrumented identically: `codastre query|graph|corpora|contracts` through Bash is logged as
`class: "codastre"` with `plane: "cli"`, counts as the Codastre attempt that `auto` mode waits for,
and is billed at the rendering's ratio — so a CLI-plane run shows up in `/codastre:tokens` and the
receipt instead of reading as free.

## 3. Scoping on multi-repo tenants

Federated QUERY quality **degrades when the tenant holds large, unrelated, or fixture-heavy repos** —
their files compete for the top-k and crowd out the repo you care about. When you know the target,
scope to a single repo (by URL) or a path prefix (plaintext — the server translates it). On a noisy
tenant this is the default, not an optimization. Results carry a `path_class`
(`app | test | fixture | vendored | doc_asset`) — filter on it instead of guessing from path
patterns; treat non-`app` hits as likely noise unless tests/fixtures are what you want.

The session's own repo (its git origin) is usually the target — scope to it by default and go
federated only for genuinely cross-repo questions.

**Reach for `path_prefix` up front, not only after a bad ranking.** Scoping within a repo is the lever
agents most often leave on the table: `repo_url` alone still lets a large repo's L10n strings, snapshot
tests, and generated files compete for the top-k. If the question names or implies a subtree — a
feature/module name, a service folder, a layer — pass it as a plaintext `path_prefix` on the *first*
call:

| The question mentions | Pass something like |
|---|---|
| A feature or module by name | `path_prefix="<path>/<Feature>Module"` |
| A layer (routes, handlers, migrations) | `path_prefix` at that folder |
| Production code, with tests polluting results | the source subtree, not the repo root |

Two cautions: `path_prefix` is a hard filter, so an over-narrow or stale prefix silently returns
nothing — check `filter_matched` (`false` = the prefix matched nothing indexed, so fix the prefix
rather than concluding "no results"). And a filter *raises* tokens per hit by concentrating the top-k
on real matches; it's a precision lever, not a cost lever — size with `top_k` (§2b).

**`language` is worth passing even in a single-language repo** — the intuition that it "filters
nothing" is wrong, and expensively so. A repo is single-language in its *code*, but the index also
holds resource and data files: localization catalogs (`.strings`, `.xliff`, `.arb`), `.json`/`.yaml`
config, `.plist`, generated schema dumps. Those are prime top-k noise — a localization catalog is a
dense bag of exactly the domain words a feature query uses, so it ranks well while telling you
nothing. Filtering to the implementation language evicts that whole class of hit in one parameter.
Measured, adding `language` raised cost *per hit* ~30% precisely because it evicted cheap junk and the
ranker backfilled with real code — and that run found both correct implementations with the fewest
follow-up reads. Pass it whenever you want code rather than resources; skip it only when the resource
files *are* the target (e.g. "which localization key holds this string").

### Unknown owner: rank corpora before you search chunks

Scoping assumes you know the repo. When all you have is **prose** — a ticket body, an incident
summary, a feature description — you don't, and a federated QUERY is the wrong tool for finding out:
it ranks *chunks*, so one lexically lucky chunk in a support-tooling repo (a helpdesk connector that
literally says "customer", "declined", "reported") outranks the service that implements the
behaviour, because nothing aggregates evidence per repo.

`CORPUS_SEARCH` (MCP) / `codastre corpora "<text>"` (CLI, v0.15.0+) aggregates. It ranks **corpora**
— git repos and document sets — on three signals and says which carried each result:

| Signal | Reads as |
|---|---|
| `card_score` — the query matches the repo's identity card (name, description, topics, README, shape) | the text **names** this corpus |
| `evidence_score` — how many of its chunks matched, and how high | the corpus **contains** what the text describes |
| `diversity_score` — across how many distinct files | the match is spread, not one lucky file |

Each result carries `why`: the files that put it there, as (path_token, line span). **The pairing is
the recipe**: CORPUS_SEARCH to pick the corpus → QUERY with `repo_url` to find the code inside,
re-phrased into code vocabulary. Skipping the first step on a ticket-shaped question is how an agent
opens the wrong repo confidently.

Reading it:

- **Scores are ranks within one answer**, not similarities — not comparable across calls, and a top
  result is not proof that anything fits. Pass `with_similarity=true` for `max_similarity` /
  `mean_similarity`, the one number here that *is* comparable and can carry a "no confident owner"
  floor.
- `has_card: false` ("no card") → placed on body matches alone; weaker evidence.
- A close top two, or a card-only win on prose that doesn't name the repo → say the routing is
  uncertain rather than picking one.
- `content_kinds` is an allow-list for **evidence only**; the identity-card leg is unaffected. Omit it
  for discovery.
- Default `top_k` is 10; 5 is plenty for routing. The CLI's `--format agent` is the cheap rendering —
  over MCP the tool has no `format` argument and returns JSON.

### Narrowing by stack

`stacks` on QUERY and CORPUS_SEARCH (`--stacks` on `codastre query|corpora`, v0.18.1+) restricts a
search to repos assigned a technical stack, and it prunes the candidate set **before** retrieval —
on a fleet of hundreds of repos, the difference between scanning everything and scanning the
relevant slice. The vocabulary is hierarchical:

| Slug | Covers |
|---|---|
| `web`, `backend`, `data-engineering`, `ml-engineering`, `security`, `low-code`, `infrastructure` | themselves |
| `mobile` | shared mobile repos **and** `mobile.android` **and** `mobile.ios` |
| `mobile.android` (alias `android`), `mobile.ios` (alias `ios`) | only that platform |

Multiple values are OR'd. A tenant can extend the catalog (`GET /v1/stacks` lists it). In direct and
repo-URL modes a non-matching repo returns the ordinary empty result.

**The trap: unassigned repositories match no stack filter.** Assignment is explicit metadata set by
an admin, never inferred, and a fleet rolls it out gradually — so a stack-filtered call can return
`ok, results: []` because the repo that has the answer isn't classified yet. **If a stack-filtered
call comes back empty, retry once without `stacks` before concluding anything**, and say the filter
was the cause. Pass `stacks` when the user names a stack ("in the iOS app", "backend only"); don't
add one on your own inference from query words — technical words in a query are weak evidence of
where the answer lives, which is why stacks are metadata and not query text.

## 4. Reading the response

- Cite as `real_path:line_start`. Snippets are usually inline — answer from them without a follow-up
  read for "where/what" questions.
- **`snippet_truncated: true`** — the snippet hit the proxy's line budget and stops at
  `snippet_line_end`. `line_start`/`line_end` still describe the *whole* chunk that was ranked, so
  the two disagree on purpose: cite and quote what you were given, and if the answer is plainly
  mid-thought at the cut, read on from `snippet_line_end + 1`. Derived content (generated code,
  vendored trees, fixtures, lockfiles, schema/SQL dumps, build output) is deliberately truncated
  hard — a 10-line headline. If one of those *is* your target, read the file directly rather than
  re-querying.
- **`hydration: <reason>`** — no snippet, and the reason says whether that is actionable:
  `snippets_disabled` (the operator turned bodies off, or this call asked for none — not a fault,
  the paths are the answer), `no_local_checkout` / `file_not_found_in_checkout` (clone or fetch),
  `path_unmask_failed` (this machine lacks the repo's masking key),
  `line_range_not_in_file` (the checkout is at a different ref), `read_error`.
- **A missing `snippet` with no `hydration` reason** means you are not going through the local proxy
  — the raw HTTP endpoint returns no bodies at all, since the server never holds source. Read
  `path_token` as a repo-relative path (on `masking_scheme: none` repos it *is* the real path) and
  flag that the setup should use the local proxy.
- `stale: true` — the local file changed since indexing; re-read that range before quoting.
- `results: []` with `status: "ok"` is a **valid answer** (searched, nothing matched). Don't re-run
  through text search "just in case" unless the query was a literal string.
- `filter_matched: false` (only when you passed a path prefix) — the prefix matched nothing indexed;
  fix the prefix rather than concluding "no results".
- `freshness: "syncing"` — base-index only; recent commits may be missing. Say so if it matters.
- Errors: retrieval-unavailable → fall back to text search and note the degradation; repo-not-indexed
  → the repo needs registering first.

### Reading an `agent`-format response

The rendering is the answer, and three things move when you ask for it:

- **`structuredContent` no longer holds the results.** It carries a fixed-size summary — `format`,
  `status`, `freshness`, a result or edge count, and `rendering_in` pointing at where the payload
  is. **The answer is in `content[0].text`.** A client that reads only `structuredContent` gets no
  results in this format; that trade is deliberate and applies to `agent` alone, since asking for a
  text rendering is an explicit request for one. The JSON default still carries the full payload in
  both representations.
- **`blob_sha` is abbreviated to 12 hex chars.** **Verify it by prefix, never by equality** — this
  is now the normative comparison, not a display concession. An abbreviated sha compared for
  equality against a full 40-hex hash marks every file stale. `git rev-parse --short=12` puts both
  sides in the same form. `compact` sends the same 12 chars as the rendering prints; the two widths
  are specified to stay equal, so a caller never sees two strings for one blob.
- **A hit with no `symbol_name` keeps its `chunk_id`, rendered as `seed:<id>`.** That is GRAPH's
  exact seed, and the intended QUERY → GRAPH handoff — see §7. It is printed only where it is the
  only seed available: a hit that has a `symbol_name` carries none, because the name seeds GRAPH
  just as well and costs a fraction of the bytes.

Field defaults print nothing rather than printing their default: no `content_kind` tag means `code`,
no `path_class` tag means `app`, and on a `snippets: false` response the per-hit
`snippets_disabled` reason is stated once in the header instead of on every hit. Absence is the
default, not a missing field.

## 4b. Asking for smaller snippets — and the locate tier

Snippets are built by the **local proxy** reading your disk, not by the server — so the two arguments
that control them are consumed by the proxy and never reach the server:

| Argument | Meaning |
|---|---|
| `max_snippet_lines: <n>` | Cap this call's snippet bodies at *n* lines. `0` means no bodies at all |
| `snippets: false` | No bodies for this call — ranked locations only |

Both are **safe to pass and safe to omit**. They work only through the local proxy; against the raw
HTTP endpoint they are meaningless (that path has no snippets to trim). Results come back with
`hydration: "snippets_disabled"` when bodies were suppressed, which is a choice, not a failure.

Reach for them when the ranking itself is the answer and you know you'll read the file anyway:

- "Which repo/service owns X?" — you need `real_path` + `repo_id`, not code.
- Enumerating candidates before picking one to read.
- A broad `top_k` sweep you intend to narrow immediately.

Do **not** use them for ordinary "where is X / what does X do" questions: the whole token advantage
is answering from the snippet without a follow-up read, and a suppressed body you then read costs
more than the body would have. If you find yourself reading every hit you suppressed, lower `top_k`
instead.

**A refinement call is the other place bodies come off.** When a second call *narrows* the first —
an added filter, a lower `top_k`, a rewording aimed at the same targets — its top hits are largely
the ones you just saw hydrated, and the proxy is stateless: it re-reads and re-ships those bodies,
and you pay the same bytes for content already in your context. So keep bodies on the first call,
drop them on the refinement, and Read the ranges that matter instead.

Two conditions, both required. The second call must genuinely refine — a follow-up on a *new*
question is not a refinement, and there the snippets are the answer. And the Read that replaces the
bodies is capped: **at most the one or two ranges the refinement was for.** If you find yourself
Reading more than that, you refined wrong — lower `top_k` and keep bodies, rather than suppressing
everything and rebuilding it a Read at a time. (Unmeasured: the overlap between a query and its
refinement has not been quantified, so treat this as a shape rule, not a budget.)

**When you do suppress bodies, ask for `format: "agent"` in the same call.** `snippets: false`
alone still ships a JSON envelope whose per-hit overhead *is* the whole response once the bodies are
gone — the state where the encoding costs most. The pair is the locate tier and it is where the
ladder's measured saving lives (§2c); either half alone leaves most of it on the table. Which plane
you ask on is §2c's question: on Claude Code, ask for the pair on the CLI (`codastre query … --format
agent`, where bodies are already off by default); over MCP, where the rendering is swallowed,
`snippets: false` at `verbose` is still the right call and takes the smaller half of the saving.

## 5. Reading scores

Results carry an RRF `score`. If the top scores are all tiny and nearly **equal** (e.g. every hit
~0.016, decreasing by a hair), the dense and lexical legs found *disjoint* sets and nothing
reinforced — a weak, low-confidence ranking, not a confident answer. Reword toward code vocabulary,
add a filter, or corroborate by reading before trusting it.

### High-ranked hits, wrong causal link — a correctness failure distinct from staleness

A ranking can put every *relevant file* in the top-k and the agent can still assemble the wrong
**chain** between them — confidently, with no low-score signal to catch it. Observed on one large single-repo corpus: asked
how a push-notification token reaches the backend, QUERY correctly surfaced both the real registration
route and an unrelated SDK wrapper's `registerPushToken` in the same
top-k, and the agent inferred a connection between them ("presumably uses") that a `Read` of
the wrapper's implementation showed to be false — that method forwards to a third-party SDK and
never touches the route. Grepping the same question traced the actual call graph (a `MessagingDelegate`
callback → a domain service → the route) and got it right, at lower token cost, because literal
matches don't let you skip verifying the edge between two matched files.

This is a different failure from a stale/superseded citation (§ elsewhere): the file is current and
real, the *inference connecting it to another file* is what's wrong, and nothing in the response
envelope flags it — score, `stale`, and `hydration` are all fine. It shows up specifically on
multi-hop "how does X actually reach Y" questions where two independently-plausible files rank near
each other. Guard against it: **don't state a causal link between two QUERY hits — "A calls B", "A's
result flows into B" — without reading the line that makes the connection.** A hedge word ("presumably")
in your own answer is itself the signal to go read that line before publishing the claim, not a
license to publish it hedged. For genuinely structural "does A call B" questions, GRAPH's `calls`
edges are the tool that actually verifies the edge (§7) — QUERY's ranking never does.

## 6. The stop rule — one *scoped* call, then answer

The dominant cost variance across otherwise-identical questions is **cascade length, not per-call
size**: one run answers after a single QUERY; another piles on a second QUERY + a GRAPH + extra reads
"to be sure" and burns 2–3× the tokens for the same answer. Cap it:

- **Scope the first call; don't buy insurance with `top_k`.** "One call, then stop" is not a licence
  to make that one call maximal. The cheapest correct run measured was a single *narrow* call
  (`top_k=4–6`, one filter). Broadening the first call to avoid a possible second one costs more than
  the second call would have, because you pay for every hit whether you read it or not. Put the
  scoping in the first call, not in a remedy after a noisy one.
- **Sharp ranking → stop.** If the top `score` is clearly separated from the tail (≳ 0.3), the
  snippets *are* the answer. Don't add a GRAPH call or re-read for confirmation unless a genuinely
  *structural* question remains.
- **Flat ranking → reshape once, don't respray.** Reword once toward code vocabulary, or add one
  filter, then read the single best `app`-class hit. One reshape, not three rewordings.
- **Don't run both tools for a question only one owns.** "Which repo / where / what does X" is
  QUERY's job; "what calls X / what breaks if I change X" is GRAPH's. A reflexive GRAPH after QUERY
  already answered a where/what question is the most common source of doubled cost.

---

## 7. GRAPH — structural questions

GRAPH traverses a relationship graph extracted from every indexed repo: intra-repo structure
(`calls`, `imports`, `extends`, `implements`) and cross-repo topology (`kafka` producer/consumer,
`http` client/server, shared `package`). It answers what text search structurally cannot — grep finds
*text occurrences* of a name; GRAPH returns *resolved edges* with confidence, across repo boundaries.

Seed with a symbol name (or a topic for seed-free Kafka lookups) and pick a direction relative to the
seed:

| Question | Direction |
|---|---|
| What does `f` call / depend on? | outbound |
| What calls `f`? (impact) | inbound |
| Everything connected to `f` | both |
| Who produces/consumes topic T? | seed-free topic mode (src = producer, dst = consumer) |
| Subclasses / implementors of `C` | `extends`/`implements`, inbound (structural edges point into the definition) |

**Always pass `direction` explicitly — never let it default.** The tool defaults to `outbound`, and
so does the `codastre graph <symbol>` CLI. That default answers "what does the seed call", which is
the *opposite* of the most commonly asked structural question. It fails silently: you get a plausible
set of edges that simply doesn't contain the answer, and the usual recovery — a follow-up QUERY to
compensate — doubles the cost of a question one correctly-shaped call would have answered.

Map the phrasing to the direction before calling:

| The request says | Direction |
|---|---|
| callsites, callers, "what calls", "who uses", "where is X used", usages, references, impact, blast radius, "safe to delete" | **inbound** |
| dependencies, "what does X call/use/depend on", downstream, "what happens after X" | **outbound** |
| "everything about X", "how does X connect", unclear which way | **both** |

When the wording is ambiguous ("show me the graph for X", "neighbors of X"), use `both` rather than
accepting the outbound default — one merged call beats discovering the wrong direction and re-asking.

**Shape the call — scope first, widen only if needed.** Response size swings ~8× with scope. Start at
`depth=1` with a `kind=` filter matching the question (`calls` for callers/callees, `kafka`/`http`
for cross-service, `extends`/`implements` for type hierarchy). Widen to `depth=2`/all-kinds only for
transitive blast radius. **Seed a known symbol directly** — spending a QUERY to find a name you
already have is wasted. **Ignore self-edges** (`src` == `dst`: file-granularity self-loops).

**Seed from a QUERY hit's `seed:` id, not from its name.** When a QUERY hit has no `symbol_name`,
the `agent` rendering prints `seed:<chunk_id>` on it (§4) — that is GRAPH's exact seed. Pass it as
`chunk_or_symbol` verbatim. It traverses directly rather than going back through the seed's fuzzy
symbol matching, so it cannot match a same-named symbol in the wrong file or repo, and it needs no
second QUERY to "recover the exact indexed symbol name". A hit that *does* carry `symbol_name`
prints no `seed:` tag, because the name seeds just as well at a fraction of the bytes — use it.

**GRAPH has the same three-rung `format` ladder as QUERY** (§2c): `verbose` → `compact` → `agent`.
It pays differently here. GRAPH returns edges and never bodies, so per-item overhead is the *whole*
response — the state QUERY only reaches with `snippets: false` — and a traversal is the shape that
repeats hardest: many edges, few sources. Every edge out of one function repeats that function's
64-hex `path_token` twice and its 36-char `repo_id` twice. The `agent` rendering groups edges under
their source file, writing that path once per fan-out instead of once per edge, and names the
destination repo only when the edge crosses a boundary.

Measured, both single deterministic runs with the §2c caveats: the compact edge item on a 12-edge
fan-out fixture, 513 → 377 B/edge (**−27%**); the agent rendering on a deployed 8-edge traversal,
4,743 → 1,785 B (**−62%**). There is no `snippets` knob to pair it with — GRAPH has no bodies to
suppress — so `format: "agent"` is the whole lever, and there is no reason not to pull it on a
traversal whose edges you intend to read as an answer rather than parse as data. Pull it where it
arrives (§2c): on v0.18.0+ either plane — MCP `format: "agent"` or `codastre graph <seed>
--direction <dir> --format agent`; on v0.14.0–v0.17.x only the CLI. There are no bodies here, so the
`--snippets` hydration gate doesn't apply to GRAPH at all.

Two shape differences from QUERY worth knowing before you read a compact traversal: `edge_id` is
dropped **unconditionally** (no tool accepts one, unlike `chunk_id`, which had to survive because
GRAPH seeds on it), and `confidence` rounds to 3 dp rather than 4 — deliberately not 2, because
confidence is read against the documented ≥ 0.9 / ≥ 0.5 bands and 2 dp rounds `.499` up across one.

The REST mirror `GET /v1/graph/neighborhood` stays verbose-only: its consumer is the dashboard,
which pays no per-byte cost and reads `confidence`/`resolution` on every edge.

**Target modes — the same scoping discipline as §3 applies to GRAPH.** Three ways to aim the call:

| Mode | Pass | Use for |
|---|---|---|
| One repo | `repo_url=<url>` | The default for a symbol you're looking at in the repo you're in |
| One index | `index_id=<uuid>` | A specific index from REGISTER |
| Federated | neither | Genuinely cross-repo questions — cross-service tracing, unknown owner |

Federation is what makes cross-service tracing work, but it is not free: on a tenant holding large or
unrelated repos, a federated seed matches same-named symbols everywhere and returns edges you then
have to triage — and each unknown `repo_id` may cost a resolving call (§9). **Scope to the session's
own repo by default; go federated deliberately, not by omission.** Passing both `index_id` and
`repo_url` is an error (`AMBIGUOUS_TARGET`); a `repo_url` with no index returns `REPO_NOT_INDEXED`
(REGISTER it first).

### Boundary questions across the fleet: CONTRACTS

GRAPH answers questions *from a seed*: "who calls this route", "who consumes this topic". Some
boundary questions have no seed — "which of our Kafka topics does nothing consume", "which routes
does no indexed client call", "what do we call that nothing exposes". That is `CONTRACTS` (MCP) /
`codastre contracts` (CLI, v0.17.0+).

A contract is a canonical cross-repo boundary — an HTTP route (`http::GET::/users/{}`) or a Kafka
topic (`topic::kafka::orders`) — with the repos that **expose** it and the repos that **use** it:

| Status | Meaning |
|---|---|
| `orphan_exposer` | exposed, nothing indexed uses it — a dead endpoint or missing consumer *candidate* |
| `orphan_user` | used, nothing indexed exposes it — often a repo that isn't indexed |
| `matched` | exposed in one repo, used from another — the wired case |
| `internal` | both sides in one repo — not cross-repo |
| `quarantined` | every party is test/fixture/vendored/generated code |

With no `status` you get the orphan report (`orphan_exposer` + `orphan_user`); `counts` always covers
all five. Contracts are derived at read time from extracted endpoints — no index to go stale.

**Read the scope block first.** A report over one repo finds no matches however well the boundaries
line up: every contract is an orphan by construction. `scope.cross_repo_possible` is false when fewer
than two repos in scope carry endpoints, and `scope.warnings` names why (`single_repo_scope`,
`endpoints_in_one_repo`, `no_endpoints`, `truncated`). An empty or orphan-heavy answer with a warning
is a scoping problem, not a finding. And an orphan is relative to what is *indexed*: an unindexed
client still calls the route.

`repo` narrows to repo UUIDs and can only shrink what the caller sees. The CLI's `--format agent`
opens with the scope line; the MCP tool has no `format` argument and returns JSON. For edge-level
detail on one contract (files, confidence), follow up with GRAPH (`topic=` for Kafka, `kind="http"`
inbound for a route).

Extractor coverage note: `implements` and `imports` edges gained Go, Kotlin, Swift and TypeScript
coverage (and `extends` fixes for Kotlin/Swift) in the Tier B release. An empty `implements`/`imports`
traversal in those languages on an older index was an extractor gap, not absence — a reindexed repo
answers it.

## 8. Reading edges: confidence and resolution

Every edge carries `confidence` and `resolution`. **Do not present low-confidence edges as facts.**

- **Cross-repo kinds** (`kafka`, `http`, `package`) are minted from a shared string literal. Edges
  touching a `test`/`fixture`/`vendored` endpoint are quarantined (confidence capped ~0.3, never
  resolved). True cross-repo edges between real application code score ≥ 0.5 `resolved` on clean
  literal matches. So ≥ 0.5 = trust, < 0.5 = hypothesis; corroborate high-stakes calls with the
  endpoint code.
- **Intra-repo kinds** (`calls`, `extends`, `implements`, `imports`) are AST-derived (`heuristic`):
  ≥ 0.9 near-certain, 0.5–0.9 plausible but ambiguous, < 0.5 weak candidate.
- Filter on `edge.confidence` yourself; there's no server-side threshold on this tool.
- `src`/`dst` carry `real_path` on hmac repos where the proxy unmasks; on `none` repos they may carry
  only `path_token`, which *is* the real path (same hydration gap as QUERY — not a misconfiguration).
- `evidence`, when present, carries the file/line the edge was extracted from — cite it. **It is
  frequently absent**, and GRAPH carries no snippet bodies at all.

### GRAPH edges are chunk-granular — don't Read your way to line numbers

`src`/`dst` line ranges describe the **whole chunk** the edge was extracted from, not the call site:
a caller commonly comes back as `line_start: 0, line_end: 178` — the entire file. GRAPH is a
*topology* tool; unlike QUERY it returns no snippet, and there is no snippet parameter to turn one on.

The trap: treating those ranges as imprecise line numbers and opening every caller file to pin down
the exact line. That turns one cheap call into N file Reads and can cost several times the GRAPH call
itself — reintroducing exactly the per-hit read round-trip that ranked retrieval exists to avoid.

- **Answer at the granularity the question asked.** "What calls X / what breaks if I change X" is a
  *file-and-symbol* answer. `path/to/Caller.swift` → X, confidence 0.9 is a complete, citable answer.
  Don't manufacture a line-number requirement the user didn't ask for.
- **Need real line numbers?** Prefer **one QUERY** naming the symbol and scoped to the repo — it
  returns hydrated snippets with true `line_start`/`line_end` for several callers in a single call —
  over one Read per caller file. Reserve Read for the one or two files you must see in full.
- **Budget it explicitly.** Reads after a GRAPH call are the dominant cost in a structural answer and
  the easiest to skip. If a Read isn't changing the conclusion, it's overhead: state the edges, their
  confidence, and stop.

## 9. Naming the repo/service behind a federated edge

A federated GRAPH answer identifies each endpoint by `repo_id` (a UUID). Depending on the server
version, GRAPH's `repos` map may omit `remote_url` (QUERY's carries it) — so you may not be able to
name a *service* from the edge alone. Budget for it: if you already know the repo (you seeded from it,
or scoped to it), you have the name; otherwise resolve each unknown `repo_id → service` with one cheap
QUERY per repo and reuse the mapping across all edges. Say "repo `<uuid>`" rather than guessing a
service name from a shared path like `app/consumer.py`.

## 10. Recipes

**Impact analysis** (before renaming/deleting/changing a signature):

1. GRAPH inbound (depth 2) — direct and transitive callers.
2. Partition edges: ≥ 0.9 (will break), 0.5–0.9 (verify), < 0.5 (mention only).
3. If the symbol is a handler/producer/endpoint near a boundary, also check `kafka`/`http` inbound —
   cross-service consumers won't show up in any text search.
4. If the symbol *is* a route or topic, pull its contract too (`CONTRACTS`, `status` =
   matched/internal/orphan_exposer, `kind` = http|kafka): `matched` users all break on a delete;
   `orphan_exposer` supports deletion but only against what is indexed.
5. Report blast radius (files, edges, repos), high-confidence callers first, then proceed/verify.
6. Zero inbound edges + zero QUERY usages → dead-code candidate; confirm with a literal text search
   for the name (dynamic references, reflection, templates) before declaring it safe to delete.

**Ticket → code** ("customers report X — where do we fix it?"): CORPUS_SEARCH on the ticket text
(`top_k` 5) → read card vs evidence → QUERY scoped to the top git corpus with a code-vocabulary
rephrasing → answer. If the top two corpora are close, one scoped QUERY in each beats a federated one.

**Cross-service tracing** ("what happens after X?"): QUERY to find the entry point → GRAPH outbound
(all kinds, depth 2) → follow `kafka`/`http` edges into other repos → QUERY within the target repo for
handler details. Each hop is one small ranked call instead of cloning and grepping N repos.

## 11. Fallbacks

- QUERY/GRAPH unavailable → fall back to text search and state explicitly that the result is textual,
  single-repo, and misses dynamic/cross-service references.
- Symbol not found in GRAPH → names must match the indexed definition; run QUERY to recover the exact
  symbol name, then re-seed. If that QUERY hit has no `symbol_name`, re-seed on its `seed:<chunk_id>`
  instead (§4, §7) — a chunk id traverses directly and cannot mis-match a same-named symbol.
- Literal strings, unindexed/uncommitted files → text search is the right tool; say so plainly.
- A stack-filtered QUERY/CORPUS_SEARCH returns nothing → retry once without `stacks` (unassigned repos
  match no filter, §3) before reporting absence.
- CORPUS_SEARCH/CONTRACTS unavailable (older server or CLI) → one federated QUERY for routing (weaker:
  it ranks chunks, not repos), or GRAPH `topic=`/`kind="http"` for a single boundary.

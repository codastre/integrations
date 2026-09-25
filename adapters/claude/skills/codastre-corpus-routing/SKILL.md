---
name: codastre-corpus-routing
description: >
  Decide WHICH repo or document set to open before searching inside one. Uses Codastre's
  CORPUS_SEARCH tool (CLI: `codastre corpora`) to rank whole corpora for ticket-, incident- or
  feature-shaped prose on aggregated evidence plus a per-repo identity card, then hands off to a
  QUERY scoped to the winner. Use when the input is prose rather than code vocabulary and the
  owning repo is unknown — a pasted Jira/GitHub ticket, an incident summary, a bug report, a
  feature description, or a service/repo name you can't place.

  Triggers: "which repo owns", "which service handles", "where should I start on this ticket",
  "customers report …", "investigate this incident", "find the code for this bug", "what repo is
  X in", a pasted ticket body.
---

# Codastre Corpus Routing

`QUERY` ranks **chunks**. That is right when you speak the code's vocabulary and wrong when you
don't: on ticket prose, the repos that literally contain words like "customer", "declined" and
"reported" are support tooling — helpdesk connectors, chatbots — not the service that implements the
behaviour, and one lexically lucky chunk there outranks a repo with twenty moderately-matching ones.
Nothing aggregates per repo.

`CORPUS_SEARCH` aggregates. It ranks **corpora** — git repos and document sets (runbooks, docs) —
and says why each one placed. Tool name: `mcp__plugin_codastre_codastre__CORPUS_SEARCH` (plugin) or
`mcp__codastre__CORPUS_SEARCH` (direct config). CLI: `codastre corpora` (alias `corpus`), v0.15.0+.

## The pairing is the recipe

1. **Route**: CORPUS_SEARCH on the prose as-is — no rephrasing needed, prose is what it's for.
2. **Read** card vs evidence (below) and pick one corpus, or say it's a toss-up.
3. **Search inside**: QUERY with `repo_url=<the corpus's remote_url>`, *now* rephrased into code
   vocabulary (identifiers, API names). For a document-set corpus, open its `why` files instead.

Skipping step 1 on a ticket-shaped question is how an agent opens the wrong repo confidently.
Skipping step 3 answers "which repo" but not the question.

**Don't route when you already know the repo** — the session's own repo, a repo the user named, or a
question in code vocabulary with an obvious home. Then go straight to a scoped QUERY
(codastre-search).

## How to call it

Cheapest: the CLI's text rendering (the MCP tool has no `format` argument and returns JSON).

```bash
codastre corpora "<ticket / incident / description text>" --top-k 5 --format agent
codastre corpora "$(gh issue view 4213 --json body -q .body)" --top-k 5 --format agent
codastre corpora "payment webhook retries" --stacks backend --format agent
```

MCP (no Bash, no CLI, or CLI older than v0.15.0):

| Argument | Use |
|---|---|
| `query_text` | The prose. A ticket body, an incident summary, a description, or a repo name |
| `top_k` | **5** for routing (default 10, max 50) — you'll open one or two |
| `stacks` | Only repos assigned these stacks (`backend`, `web`, `mobile` ⊇ `android`/`ios`, …). **Unassigned repos match nothing** — see below |
| `content_kinds` | Evidence allow-list (`["code"]`, `["runbook","doc"]`). Scopes evidence only, never the identity-card leg. Omit for discovery |
| `language` | Only draw evidence from one language |
| `with_similarity` | `true` → `max_similarity` / `mean_similarity`, comparable across calls. Costs an extra round trip; use it when you need a "no confident owner" floor |

## Reading the answer

Each corpus carries `kind` (`git_repo` or a document set), three scores, and `why` — the specific
files (path_token + line span) that put it on the list.

| Pattern | Means |
|---|---|
| card high, evidence low | the text **names** this corpus (its name, description, topics, README) |
| evidence high, card low | the corpus **contains** what the text describes |
| both high | named *and* corroborated — the strongest routing signal |
| `has_card: false` / "no card" | placed on body matches alone — weaker evidence; the repo has no identity document yet |
| high `diversity_score` | the match is spread across many files, not one lucky one |

- **Scores are ranks within this answer**, not similarities. They don't compare across calls, and a
  top result is not by itself proof that anything fits. For an absolute floor, `with_similarity`:
  a top corpus whose similarities are near zero is routing on noise.
- **Close top two → say so**, and run one scoped QUERY in each rather than a federated one.
- **Card-only win on prose that doesn't name the repo** → suspicious; prefer an evidence-backed runner-up
  or say the routing is uncertain.
- `status: "ok"` with no corpora → nothing indexed matches; that is an answer.
- `searched_corpus_count` (CLI: "of N searched") tells you how wide the net was.

## Stacks: narrowing the fleet, and the empty-result trap

`stacks` prunes candidates **before** ranking, so on a fleet of hundreds of repos it is both cheaper
and more precise — when the user names a stack ("in the iOS app", "a backend service"). Semantics:
a parent covers its children (`mobile` → shared mobile repos plus `mobile.android` and `mobile.ios`);
`android`/`ios` are exact leaves; multiple values are OR'd.

**Unassigned repositories match no stack filter**, and assignment is explicit admin metadata rolled
out gradually. So an empty (or oddly thin) answer under `stacks` most likely means the right repo
isn't classified yet. **Retry once without `stacks` before concluding anything**, and tell the user
the filter was the cause. Never add `stacks` on your own inference from words in the ticket.

## Fallbacks

- CORPUS_SEARCH unavailable (older server) and no `codastre corpora` → one federated QUERY with
  `top_k` 10 and read the repos off the hits — and say it's weaker: it ranks chunks, not repos.
- `RETRIEVAL_UNAVAILABLE` → retrieval is down; say so. `gh search code` over the org is the textual
  fallback for "which repo".

## Related

- `/codastre:corpora <text>` — slash-command equivalent (route, then one scoped search)
- **codastre-search** — the scoped QUERY in step 3
- **codastre-search** with `alert_ids` / `error_codes` — when the input is an alert id or error code, not prose
- **Source of truth:** `core/retrieval-playbook.md` §3 "Unknown owner: rank corpora before you
  search chunks" — edit that first, then re-sync this skill.

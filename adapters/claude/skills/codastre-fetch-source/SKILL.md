---
name: codastre-fetch-source
description: >
  Get the actual source behind a Codastre QUERY result when the response carries no `snippet` —
  resolve the hit's repo, find or create a local checkout, verify it is the exact indexed blob,
  then read the line range. Results are `(repo, path, line range, blob_sha)`, so on deployments
  where snippets aren't hydrated QUERY locates code without showing it.

  Use whenever a Codastre hit needs to be read and the repo may not be checked out locally, or
  whenever you are about to Read a `real_path`/`path_token` returned by QUERY.

  Triggers: "no snippet in the result", "read this codastre hit", "repo isn't checked out",
  "open the file codastre found", "clone the repo codastre pointed at", "which repo is this hit in".
---

# codastre-fetch-source

A `QUERY` result is a **locator**: `repo_id`, `real_path`, `line_start`/`line_end`, and `blob_sha`.
When the response carries no `snippet`, you must fetch the content yourself.

**The rule is simple: a snippet is hydrated exactly when the proxy knows a local checkout for that
result's repo.** Hydration reads the file from disk, so no checkout means no snippet. Masking scheme
is *not* the deciding factor — cleartext (`masking_scheme: none`) repos hydrate fine given a
checkout. The proxy resolves the root per repo: the repo you're running inside, or one recorded in
the CLI's `checkouts.json` (see step 2).

So on a large tenant most federated hits arrive **without** snippets simply because those repos
aren't cloned — which is the case this skill exists for. Cloning the repo *does* make snippets appear
on the next call, once the checkout is known.

Newer proxies say so explicitly: when a snippet is missing the result carries a `hydration` field —
`no_local_checkout` (clone it or use the forge API), `file_not_found_in_checkout` (checkout known but
this ref lacks the path — fetch), or `read_error`. **Read it when present**; it tells you which fix
applies. Its absence means either the snippet is present, or the proxy predates the field — fall back
to the reasoning above.

One genuine misconfiguration to distinguish: an **`hmac`** repo returning `path_token` with no
`real_path` means the MCP config is talking to raw HTTP instead of `codastre serve`. That's worth
fixing at the source rather than working around.

`GRAPH` is unaffected: its edges are metadata, not source, so structural questions ("who consumes
topic T") are fully answerable with no checkout at all. Don't fetch source for those.

## ⚠️ Never Read a returned path directly

`real_path`/`path_token` are **repo-relative with no repo prefix**. A bare
`Read("internal/infra/kafka/kafka.go")` is not merely likely to fail — it can silently succeed on
the **wrong file**, because these paths collide across repos in any large tenant. Measured on one
dev machine: 13 checkouts contained an `internal/infra/kafka/` tree, and one hit's
`internal/infra/kafka/producer/producer.go` existed in a completely unrelated service.

Reading the wrong one yields a real, plausible, wrong answer with **no error**. Always resolve the
repo (step 1) and always verify `blob_sha` (step 4).

## 1. Resolve the hit's repo

Every result carries `repo_id`; the response's top-level `repos` map gives the URL:

```
repos[result.repo_id].remote_url   →   e.g. "github.com/<owner>/<repo>"
```

**Check `GRAPH`'s `repos` map for `remote_url` first.** The *server* omits it, sending only
`masking_scheme`/`mask_key_rev`, but newer proxies backfill it locally — in which case an edge already
names both services and you need no extra call.

When it is absent, the "one QUERY per repo" method only works if you already hold candidate repos:
you cannot query *by* `repo_id`. With no candidates, search the forge for a distinctive path from the
edge, e.g. on GitHub:

```bash
gh search code --owner <owner> "<distinctive-path-segment>" --limit 20 --json repository,path
```

## 2. Find the local checkout — ask the CLI first

The `codastre` CLI keeps its own registry of known checkouts, keyed by the **same `remote_url`
format** `QUERY` returns. This is the authoritative lookup — prefer it over guessing a directory:

```bash
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/codastre/checkouts.json'))).get('<remote_url>','')or'(not registered)')"
```

The CLI populates this from previous in-repo runs; it's the same mechanism behind its documented
`--repo-path <dir>` flag ("when you run outside the queried repo, codastre uses a checkout
remembered from a previous in-repo run"). If the path is present and exists, skip to step 4.

Respect `$XDG_CONFIG_HOME` when set: the file is at `$XDG_CONFIG_HOME/codastre/checkouts.json`,
else `~/.config/codastre/checkouts.json`. A missing file just means nothing is registered yet —
treat it as an empty map, don't error.

**The registry is not exhaustive.** It only lists checkouts the CLI has seen, so a clone *you* made
in a previous session won't be in it. Before concluding there's no checkout, probe the candidate roots
from step 3b. Every layout is `<root>/<repo>`, so one loop covers them all:

```bash
for root in "<derived-root>" "${XDG_CONFIG_HOME:-$HOME/.config}/codastre/checkouts"; do
  [ -n "$root" ] || continue
  git -C "$root/<repo>" rev-parse --git-dir >/dev/null 2>&1 && { echo "found: $root/<repo>"; break; }
done
```

Skipping this probe means re-cloning the same repo every session.

To get a clone into the registry, run any in-repo CLI command from inside it once — e.g.
`(cd <checkout> && codastre query "x" --top-k 1)`. Per the CLI's help that is how it remembers a
checkout. Prefer this over hand-editing `checkouts.json`, which the CLI owns.

## 3. Fetch what's missing

Two granularities. **Never clone a repo to read one file.**

| | 3a — single file | 3b — clone |
|---|---|---|
| Unit fetched | one file's contents | the **whole repo** at one commit |
| Lands on disk | nothing | ~½ a full clone (measured: 16 MB vs 29 MB server-side) |
| History | none | 1 commit (`--depth 1`) |
| File blobs | the one file | all paths present, blob bytes fetched on demand (`--filter=blob:none`) |
| Use when | you need 1–3 files | you need to grep, follow imports, or explore |

### 3a. One to three specific files → no clone

Cheapest path; nothing to place on disk:

```bash
gh api "repos/<owner>/<repo>/contents/<real_path>" --jq '.content' | base64 -d
```

Pipe through `sed -n '<line_start>,<line_end>p'` to keep the indexed range. Note `line_start` can be
0 in Codastre results while `sed`/`Read` are 1-based — treat `0` as line 1 and widen a line or two
rather than trusting an exact boundary. Adapt the command for non-GitHub forges.

Default to this. Cloning a repo to read one constant is wasteful.

### 3b. Exploring, grepping, or following imports → clone

**Where to clone — resolution order:**

1. **An explicit root the user gave you**, for this session or in project config.
2. **Derived from `checkouts.json`** — if existing entries share a common parent directory, that
   parent *is* the machine's convention; use it. This adapts to any layout without configuration:
   ```bash
   python3 -c "
   import json,os
   p=os.path.expanduser(os.environ.get('XDG_CONFIG_HOME','~/.config')+'/codastre/checkouts.json')
   v=list(json.load(open(p)).values())
   print(os.path.commonpath(v) if len(v)>1 else (os.path.dirname(v[0]) if v else '(no entries)'))"
   ```
3. **Default, alongside the CLI's own config** — no guessing, no polluting a work tree:
   `${XDG_CONFIG_HOME:-$HOME/.config}/codastre/checkouts/<repo>`.
   **This directory won't exist on a fresh machine — create it.** The CLI creates its config dir but
   not a checkouts tree, so make the root yourself before cloning:
   ```bash
   ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/codastre/checkouts"
   mkdir -p "$ROOT"                         # root only; git creates the repo dir itself
   ```
   `mkdir -p` is idempotent, so this is safe to run every time. Don't pre-create the repo directory
   itself — `git clone` wants to create it, and cloning into an existing non-empty directory fails.

   **Layout is flat — `<root>/<repo>`, matching option 2** so a single `<root>/<repo>` probe finds a
   clone under any root. The cost is that two repos with the same name in different orgs collide; if
   that happens, clone the second under an explicit root (option 1) rather than reintroducing a nested
   `<host>/<owner>/` layout, which is what made the existence probe miss clones before.

**The clone itself** — portable, needs only `git`. Guard it so a re-run is a refresh, not a failure:

```bash
if git -C "<target-dir>" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "<target-dir>" fetch --depth 1 origin && git -C "<target-dir>" reset --hard @{u}
else
  mkdir -p "$(dirname "<target-dir>")"
  git clone --filter=blob:none --depth 1 https://<host>/<owner>/<repo>.git "<target-dir>"
fi
```

A blobless shallow clone of a mid-size Go service measured **~4 s / 16 MB** — cheap enough to do
inline. Blobs arrive on demand as you read; all tree objects are present, so `git rev-parse
HEAD:<path>` works immediately for step 4.

Tell the user what you cloned and where. `Read` accepts absolute paths outside the working
directory, so no `/add-dir` is needed merely to read — suggest `/add-dir <path>` only if they want
the repo in their project context for ongoing work. **Never clone into the current repo's tree.**

## 4. Verify you have the indexed blob — mandatory

Every result carries `blob_sha`, the git blob hash of the indexed file. Check it. This one step
catches **both** failure modes: wrong repo (the collision above) and a stale index.

```bash
git -C <checkout> rev-parse --short=12 "HEAD:<real_path>"   # must equal the result's blob_sha
```

Compare by **prefix**, not full equality — this is the normative comparison, not a display
concession. Only `format: "verbose"` (the default) carries the full 40-hex sha: `format: "compact"`
sends 12 hex chars and `--format agent` prints the same 12, and comparing an abbreviated sha for
equality against a full hash reports every file stale. `--short=12` puts both sides in the same
form, whichever rung you got. If you are holding a full 40-hex `blob_sha` and want the strictest
check, drop `--short=12` and compare in full.

- **Match** → you are reading exactly what was indexed. Cite `real_path:line_start` with confidence.
- **Mismatch** → the file changed since indexing, or you're in the wrong repo. Re-check step 1; if
  the repo is right, the content moved — the line range may be off, so locate the symbol by name
  instead of trusting `line_start`, and say the index is behind.

With `gh api` (3a), the equivalent check is the `sha` field of the `contents` response. It returns
the default branch's *current* blob, which may legitimately differ from the indexed one.

Corroborating signals in the envelope: `stale: true` on a result means the local file already
changed since indexing, and `freshness: "syncing"`/`"degraded"` means recent commits may be missing
entirely.

## 5. Read and cite

Read only the indexed range — the range is the point of the search:

```
Read(file_path="<abs path>", offset=<line_start>, limit=<line_end - line_start + 1>)
```

Cite as `<repo>/<real_path>:<line>`, including the repo name: the path alone is ambiguous across a
multi-repo tenant.

## Worked example

*What Kafka topic carries cards history?*

1. `QUERY(query_text="card history topic name", repo_url="github.com/<owner>/card-lifecycle")`
   → `internal/infra/kafka/kafka.go`, `blob_sha: 1ef3e067…`, no snippet. (Scoping mattered: the
   federated form of this query scored a flat ~0.016 across 71 repos and surfaced an unrelated
   mobile fixture; scoped, the top hit scored 0.5.)
2. Not in `checkouts.json` — no local checkout.
3. One constant needed → `gh api …/contents/internal/infra/kafka/kafka.go`.
4. Blob matched `1ef3e067…` ✅.
5. `CardsHistoryTopic = "card-lifecycle.cards-history"` (`card-lifecycle/internal/infra/kafka/kafka.go:22`).

The structural half needed **no** source: `GRAPH(topic="card-lifecycle.cards-history")` returned one
`kafka` edge, confidence 0.95 `resolved`, producer `card-lifecycle` → a consumer repo identified only
by UUID, which step 1's forge-search fallback named.

## Cost discipline

This adds steps to `codastre-search`'s one-call stop rule, so keep it tight:

- Fetch source **only** when the snippet-less result doesn't already answer the question. A path plus
  `symbol_name` often suffices for "which repo / where does X live".
- One `gh api` per file you actually need to quote. Don't pre-fetch the whole top-10.
- Don't clone to answer a structural question `GRAPH` already covers.
- Don't re-fetch a file you've already read this session.

## Related

- `codastre-search` — phrasing, scoping, and the stop rule for getting the right hit first
- `codastre-graph-navigation` — structural questions that need no source

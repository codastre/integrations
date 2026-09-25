# Codastre — Claude Code adapter

The Claude Code plugin for Codastre: slash commands, contextual skills, steering/enforcement hooks,
and token accounting. This is one adapter in the [`codastre/integrations`](../../README.md) monorepo.

- **Full docs, install, and settings:** the [repo-root README](../../README.md).
- **Shared, agent-neutral guidance** (the retrieval playbook + measurement contract) lives in
  [`../../core/`](../../core) and is *compiled* into this adapter's skills — edit `core/` first, then
  re-sync the skills so they don't drift.
- **Benchmarks** (Tier A) live at the [repo root `benchmarks/`](../../benchmarks), shared across
  adapters.

## What's in here

```
.claude-plugin/plugin.json   plugin manifest (mcpServers → ./.mcp.json)
.mcp.json                    starts the MCP server via `codastre serve`
hooks/                       session awareness, search nudges, live A/B mode, token tracking
skills/                      codastre-search, codastre-graph-navigation, codastre-token-audit
commands/                    /codastre:status, :search, :graph, :impact, :compare, :mode,
                             :bench, :tokens, :register, :receipt
output-styles/               topology-navigator
```

## Session events log (always on, local only)

`hooks/session_events.js` listens on `PreCompact`, `PostCompact` and `PostToolUseFailure` and
appends one counters-only record per event to `~/.config/codastre/session-events.jsonl`
(`CODASTRE_SESSION_EVENTS_LOG` overrides; rotated to `.1` past 5 MB). `codastre collect` folds it
into per-session counters (`compactions_auto` / `compactions_manual`, from `phase: "pre"` only).

```json
{"ts":"…","session_id":"…","event":"compact","phase":"pre","trigger":"auto"}
{"ts":"…","session_id":"…","event":"tool_failure","tool":"Bash","class":"text-search","error_type":"timeout"}
```

- **Holds:** session id, event, phase, trigger (`auto`/`manual`/`unknown`), tool name, tool class,
  and `error_type` as a bounded token (`[a-z0-9_]{1,40}`, anything else becomes `other`).
- **Never holds:** prompts, compaction summaries or instructions, tool input or output, error
  message text, file paths, or the cwd. Nothing here is uploaded by the hook.
- **Why it is on by default:** a compaction cannot be recovered from the transcript after the fact
  — the signal exists only if a hook was listening when it happened.

A `PostToolUseFailure` on a Codastre call in `auto` mode also marks the turn's run marker failed,
so the text-search fallback is unlocked by the harness's own failure signal rather than only by
matching error strings in the response (`track.js` keeps that path).

## Tier D study runs (`hooks/study.js`)

When `codastre study start <slug>` has written a study file (`~/.config/codastre/study.json`,
`CODASTRE_STUDY_FILE` overrides), the `UserPromptSubmit` hook claims the next **fresh** session
for it — one with no earlier prompt — injects the pre-registered prompt verbatim on that turn, and
runs that session, and only that session, under the arm's search mode: `no_tool` → `grep`
(Codastre blocked on both planes), `tool` → the study's tool-arm mode. The arm overrides any
standing `/codastre:mode`, and study turns get no receipt step. A session that is not fresh gets a
one-line notice and no enforcement. Each claim appends one line to
`~/.config/codastre/study-sessions.jsonl` (`CODASTRE_STUDY_LOG`) — session id, assignment id,
arm and the prompt's SHA-256, never the prompt — which `codastre collect` uses to tag the upload.
Protocol: `core/measurement.md` §Tier D.

Tests: `node --test adapters/claude/hooks/test/`.

Install is unaffected by the monorepo layout: the root `marketplace.json` points its `source` at
this directory, so `claude plugin marketplace add codastre/integrations` still works.

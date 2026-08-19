---
description: Traverse the Codastre relationship graph from a symbol or topic
argument-hint: <symbol|--topic T> [--kind K] [--depth N] [--direction D] [--repo URL|--federated]
allowed-tools: Bash(codastre:*), mcp__plugin_codastre_codastre__GRAPH, mcp__codastre__GRAPH, mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY
---

Traverse with Codastre — on the **CLI plane** by default (`codastre graph` via Bash), falling back to
the `GRAPH` MCP tool (whichever name is available). The parse, the scoping rules and the presentation
below are identical on both planes; only the call syntax differs, flag for argument.

Arguments: `$ARGUMENTS`

Parse: free text is the seed `chunk_or_symbol`; `--topic <t>` → seed-free Kafka `topic` lookup; `--kind <k>` (kafka|http|package|calls|extends|implements|imports); `--depth <n>` (1–3, default 1); `--direction <d>` (outbound|inbound|both); `--repo <url>` scopes to one repo, `--federated` searches every visible repo.

**Scope by default.** With neither `--repo` nor `--federated`, pass `repo_url` for the session's own repo (its git origin — on the CLI plane, run inside the checkout and omit `--repo-url`, which resolves the same thing from the git remote; `--all` is the federated form) — a bare federated traversal matches same-named symbols across every indexed repo and returns edges you then have to triage. Use `--federated` for genuinely cross-repo questions (cross-service tracing, unknown owner). Never pass both `repo_url` and `index_id` — that's an `AMBIGUOUS_TARGET` error; `REPO_NOT_INDEXED` means the repo needs REGISTER first.

**Always pass `direction` explicitly — never omit it and inherit the tool's `outbound` default.** When `--direction` is not given, infer it from the seed phrasing and say which you picked:

| The request says | Pass |
|---|---|
| callsites, callers, "what calls", "who uses", "where is X used", usages, references, impact | `inbound` |
| dependencies, "what does X call/use", downstream, "what happens after X" | `outbound` |
| a bare symbol, "neighbors of X", "graph for X", or anything ambiguous | `both` |

A bare symbol with no directional wording gets `both` — outbound alone silently answers the opposite of the most common intent ("what calls X"), and the recovery costs an extra call.

If the seed symbol returns no edges, run a Codastre `QUERY` for it to recover the exact indexed symbol name, then retry GRAPH once with that name. If the QUERY hit has no `symbol_name`, re-seed on its `seed:<chunk_id>` instead — a chunk id traverses directly and can't mis-match a same-named symbol in another file or repo.

**Ask for the `agent` rung, and ask for it on the CLI plane.** GRAPH carries no bodies, so per-edge overhead is the whole response and a fan-out repeats its source file's path on every edge; the agent rendering groups edges under their source file and names the destination repo only when the edge crosses a boundary. Measured on a deployed 8-edge traversal, 4,743 → 1,785 B (−62%) — one run, so read it to the nearest few points. There is no `snippets` knob here, so `format` is the whole lever — and no hydration question either, which makes the CLI gate a single version check:

```bash
codastre version                                               # v0.14.0+ has --format agent
codastre graph "<seed>" --direction <dir> [--depth N] [--kind K] [--repo-url URL|--all] --format agent
```

Claude Code prefers `structuredContent` over `content` when both are present, and the `agent` rung puts the edges in `content[0].text` with only a fixed summary (`format`, `status`, `freshness`, `edge_count`, `rendering_in`) in `structuredContent` — so over MCP it shows the summary and no edges (verified 2026-08-18). That's deterministic: don't spend a call probing it. On a binary older than v0.14.0 (or with no Bash / no CLI / not logged in), use the MCP tool at `format: "verbose"` and say once that the rung needs v0.14.0+ — don't claim a saving you couldn't ask for, and don't repeat the notice.

Present edges grouped by kind, then by confidence:

- Format: `src.real_path` → `dst.real_path` — kind, confidence, with the evidence file:line when present.
- **Report at file granularity; do not Read caller files to recover exact call lines.** Edge line ranges span the whole chunk (often the entire file), and GRAPH carries no snippets — file + symbol + confidence is the complete answer here. If exact lines are genuinely required, use one repo-scoped QUERY for the symbol rather than one Read per caller.
- **Confidence ≥ 0.9**: state as fact. **0.5–0.9**: "likely". **< 0.5** or `resolution: "dynamic_unresolved"`: list under a separate "Hypotheses (unverified)" heading — never mix them with confirmed edges.
- For `--topic`: label src as producers, dst as consumers, grouped per repo.

End with a one-sentence structural takeaway (e.g. "3 services consume this topic; the highest-confidence in-repo caller is X").

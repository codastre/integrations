---
description: Report cross-repo HTTP/Kafka contracts and their orphans — routes and topics with nothing on the other end
argument-hint: [--kind http|kafka] [--status S ...] [--repo UUID ...] [<route or topic to look for>]
allowed-tools: Bash(codastre:*), mcp__plugin_codastre_codastre__CONTRACTS, mcp__codastre__CONTRACTS
---

Report cross-repo **contracts** — each HTTP route (`http::GET::/users/{}`) or Kafka topic
(`topic::kafka::orders`) with the repos that **expose** it and the repos that **use** it.

Arguments: `$ARGUMENTS`

Parse: `--kind <k>` (http|kafka, repeatable) → `kind`; `--status <s>` (repeatable) → `status`;
`--repo <uuid>` (repeatable) → `repo` (can only shrink what the caller sees). Free text, if any, is a
route or topic to find in the report — it is not a server-side filter, so pass `--kind` to keep the
report small and pick the entry out yourself.

With no `--status` the report is the **orphan report** (`orphan_exposer` + `orphan_user`). To answer
"who uses route/topic X", pass `--status matched --status internal --status orphan_exposer`.

**Plane.** CONTRACTS has no `agent` rung over MCP, so use the CLI (v0.17.0+):

```bash
codastre contracts [--kind K] [--status S ...] [--repo UUID ...] --format agent \
  --client claude-code-plugin/0.2.0   # --client needs v0.19.0; drop it on an older binary
```

No Bash, no CLI, or an older binary → the `CONTRACTS` MCP tool (`mcp__plugin_codastre_codastre__CONTRACTS`
or `mcp__codastre__CONTRACTS`) with the same arguments.

**Read the scope line first, and lead with it if it carries a warning.** A report over one repo
finds no matches however well the boundaries line up — every contract is an orphan by construction.
Warnings: `single_repo_scope`, `endpoints_in_one_repo`, `no_endpoints` mean the *scope* produced an
orphan-heavy answer; `truncated` means the list is partial. An empty list with a warning is a scoping
problem, not a clean bill of health.

Statuses, for the write-up:

| Status | Meaning | How to say it |
|---|---|---|
| `orphan_exposer` | exposed, nothing indexed uses it | "no indexed consumer" — a dead-endpoint *candidate*, not proof (unindexed clients exist) |
| `orphan_user` | used, nothing indexed exposes it | often a repo that isn't indexed; name it as a gap |
| `matched` | exposed in one repo, used from another | the wired case |
| `internal` | both sides in one repo | not cross-repo |
| `quarantined` | every party is test/fixture/vendored/generated | ignore unless asked |

Present:

- The scope line, then the `counts` line, so orphans read against the whole.
- Orphans grouped by kind, then by exposing/using repo; one line each (contract id, parties).
- Paths from repos with no local checkout stay masked tokens (`[masked]`) — say so rather than
  presenting them as paths.
- For "who uses X": list the `matched` users per repo; if X is an `orphan_exposer`, say nothing
  indexed uses it.
- End with a one-sentence takeaway (e.g. "83 topics have no indexed consumer; 12 are in repo Y").

For "who calls this route / consumes this topic" with edge-level detail (file, confidence), follow up
with `/codastre:graph --topic <topic> --federated` or a `kind=http` inbound traversal.

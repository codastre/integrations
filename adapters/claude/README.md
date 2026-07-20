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

Install is unaffected by the monorepo layout: the root `marketplace.json` points its `source` at
this directory, so `claude plugin marketplace add codastre/integrations` still works.

---
description: Traverse the Codastre relationship graph from a symbol or topic
argument-hint: <symbol|--topic T> [--kind K] [--depth N] [--direction D]
allowed-tools: mcp__plugin_codastre_codastre__GRAPH, mcp__codastre__GRAPH, mcp__plugin_codastre_codastre__QUERY, mcp__codastre__QUERY
---

Traverse using the Codastre `GRAPH` MCP tool (whichever name is available).

Arguments: `$ARGUMENTS`

Parse: free text is the seed `chunk_or_symbol`; `--topic <t>` → seed-free Kafka `topic` lookup; `--kind <k>` (kafka|http|package|calls|extends|implements|imports); `--depth <n>` (1–3, default 1); `--direction <d>` (outbound|inbound|both, default outbound).

If the seed symbol returns no edges, run a Codastre `QUERY` for it to recover the exact indexed symbol name, then retry GRAPH once with that name.

Present edges grouped by kind, then by confidence:

- Format: `src.real_path` → `dst.real_path` — kind, confidence, with the evidence file:line when present.
- **Confidence ≥ 0.9**: state as fact. **0.5–0.9**: "likely". **< 0.5** or `resolution: "dynamic_unresolved"`: list under a separate "Hypotheses (unverified)" heading — never mix them with confirmed edges.
- For `--topic`: label src as producers, dst as consumers, grouped per repo.

End with a one-sentence structural takeaway (e.g. "3 services consume this topic; the highest-confidence in-repo caller is X").

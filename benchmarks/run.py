#!/usr/bin/env python3
"""Deterministic Codastre-vs-grep benchmark harness — zero agent inference.

Each case in cases.json pins the exact Codastre call(s), the exact grep call(s),
and a ground-truth answer key. This script runs both sides, measures response
bytes / call count, extracts the returned locations, and scores precision/recall
against the key. No LLM is involved, so results are reproducible and CI-friendly.

Usage:
    python run.py [--cases cases.json] [--workspace DIR] [--bin codastre]
                  [--format md|json] [--out FILE]

--workspace  base dir holding the local repo checkouts (for the grep side).
             Default: env CODASTRE_BENCH_WORKSPACE, else the dir two levels above
             this script (…/github.com when the plugin sits beside the checkouts).
--bin        codastre binary. Default: env CODASTRE_BIN, else `codastre` on PATH,
             else <workspace>/codastre/cli/codastre if present.

Token figures estimate each tool RESULT — the comparable cost a model would pay to
ingest that output — from its character count divided by a ratio chosen for the
payload's SHAPE (see CHARS_PER_TOKEN). A single divisor across both sides would
bias the comparison, since the two sides emit different shapes.

The Codastre side is measured at BOTH ends of the `format` ladder, because one of
them is the number an agent actually pays and the other is only an upper bound:

  json   the raw `--json` envelope. This is the call that gets SCORED -- locations
         are parsed from it -- and it is the most verbose rung, so its cost is a
         ceiling, not a forecast.
  agent  the same call re-issued at `--format agent`, the text rendering the MCP
         proxy emits. Cost only; nothing is parsed from it, so a change to the
         rendering can never move a precision/recall number.

Both are reported. The agent rung is the headline Codastre cost, since it is the
cheapest rung a caller can actually reach, and `--format agent` is measured on the
CLI plane -- one copy of the payload, no `structuredContent` duplicate.

The agent figure comes from a SECOND invocation of the same query seconds after the
first, because the CLI cannot re-render a saved envelope. That is pinning by
adjacency, not by construction (core/measurement.md, "Pinning the result set",
rule 2): if the index moves between the two calls the two rungs describe slightly
different result sets. Deterministic fixtures make that unlikely here, not
impossible. On a binary too old to advertise `agent`, the column reports
unavailable rather than falling back to a figure it did not measure.

The proxy also inlines snippets on top of the envelope, which this harness still
does not add -- so both figures understate a bodies-on call.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import re
import subprocess
import sys
from dataclasses import dataclass, field

# Chars per token, by payload shape. A single divisor does not fit both sides of
# this bench, and using one biases the comparison the bench exists to make.
#
# Measured with cl100k_base over eight deployed responses (two repos plus a
# federated run, top_k 5 to 20, bodies on and off): a JSON envelope runs 2.38-2.69
# chars/token, pooled 2.53, because it is dense in the tokeniser's worst input --
# long hex ids, quoted keys, escaped newlines. The agent text rendering runs
# 2.48-3.48, pooled 3.33. See core/measurement.md.
#
# "text" is 4 and is NOT from that sample: grep/rg output was never measured. It
# is the old prose default kept so the text side has an estimate at all -- report
# it as unmeasured.
#
# The old flat 0.25 mattered here in a specific direction: this bench measures the
# Codastre side as a JSON envelope and the text side as raw output, so a single
# 4 understated Codastre's tokens by ~37% while leaving grep's roughly alone --
# i.e. it flattered Codastre in its own benchmark.
CHARS_PER_TOKEN = {"json": 2.5, "agent": 3.0, "text": 4.0}


# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------
def default_workspace() -> str:
    env = os.environ.get("CODASTRE_BENCH_WORKSPACE")
    if env:
        return os.path.abspath(env)
    # …/codastre-claude/benchmarks/run.py -> …/  (parent of the plugin repo)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def resolve_bin(workspace: str) -> str:
    env = os.environ.get("CODASTRE_BIN")
    if env:
        return env
    on_path = shutil.which("codastre")
    if on_path:
        return on_path
    built = os.path.join(workspace, "codastre", "cli", "codastre")
    if os.path.exists(built):
        return built
    return "codastre"  # let the failure surface with a clear message


def normalize_url(url: str) -> str:
    u = url.strip()
    for p in ("https://", "http://", "git@", "ssh://"):
        if u.startswith(p):
            u = u[len(p):]
    u = u.replace(":", "/", 1) if u.count("/") == 0 and ":" in u else u
    return u[:-4] if u.endswith(".git") else u


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------
@dataclass
class SideResult:
    calls: int = 0
    result_chars: int = 0
    # Which CHARS_PER_TOKEN entry applies to this side's payloads. The Codastre
    # side reads a raw --json envelope; the text side reads grep/rg output.
    shape: str = "text"
    # Codastre side only: the same calls re-issued at `--format agent`, measured
    # for cost and never parsed. None means the rung was not measured -- either
    # this is the text side, or the binary is too old to advertise it. 0 would
    # claim "measured, and free", so the distinction is load-bearing.
    agent_chars: int | None = None
    locations: set[tuple[str, str]] = field(default_factory=set)  # (repo, path)
    spans: list[tuple[str, str, int, int]] = field(default_factory=list)  # repo,path,ls,le
    errors: list[str] = field(default_factory=list)

    @property
    def tokens(self) -> int:
        return round(self.result_chars / CHARS_PER_TOKEN.get(self.shape, 4.0))

    @property
    def agent_tokens(self) -> int | None:
        """Cost of the same calls at the cheapest reachable rung, or None."""
        if self.agent_chars is None:
            return None
        return round(self.agent_chars / CHARS_PER_TOKEN["agent"])


def score(returned: set[tuple[str, str]], expected: set[tuple[str, str]]) -> dict:
    hit = returned & expected
    precision = len(hit) / len(returned) if returned else 0.0
    recall = len(hit) / len(expected) if expected else 0.0
    return {
        "precision": precision,
        "recall": recall,
        "found": sorted(f"{r}/{p}" for r, p in hit),
        "missed": sorted(f"{r}/{p}" for r, p in (expected - returned)),
        "returned": len(returned),
    }


# ---------------------------------------------------------------------------
# Codastre side
# ---------------------------------------------------------------------------
def url_to_repo(repos: dict, remote_url: str) -> str | None:
    target = normalize_url(remote_url)
    for short, meta in repos.items():
        if normalize_url(meta["url"]) == target:
            return short
    return None


def resolve_repo_ids(bin_path: str, repos: dict) -> dict[str, str]:
    """Map each tenant repo_id -> our short name via one cheap setup query per repo.
    Needed because GRAPH's `repos` map omits remote_url (only QUERY carries it)."""
    id2short: dict[str, str] = {}
    for short, meta in repos.items():
        cmd = [bin_path, "query", "code", "--repo-url", meta["url"], "--top-k", "1", "--json"]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            env = json.loads(out.stdout)
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            continue
        for rid, m in env.get("repos", {}).items():
            if url_to_repo(repos, m.get("remote_url", "")) == short:
                id2short[rid] = short
    return id2short


def supports_agent_format(bin_path: str) -> bool:
    """Whether this binary advertises the `agent` rung of the format ladder.

    Probed from `query --help` rather than a version string: the rung is a CLI
    capability and the help text is where the CLI states it. An old binary lists
    only `human | json`, and the bench then reports the rung as unavailable
    instead of quoting a saving it could not ask for.

    Matched on the `--format` line specifically, not on the bare word "agent"
    anywhere in the help. That distinction is load-bearing: v0.13.1's own help
    text contains "raw envelope for agents" in an example, so a substring test
    reports the rung available on a binary that rejects it -- and the bench then
    prices an errored call as a saving.
    """
    try:
        out = subprocess.run([bin_path, "query", "--help"],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return re.search(r"--format[^\n]*\bagent\b", out.stdout + out.stderr) is not None


def run_codastre(bin_path: str, case: dict, id2short: dict[str, str],
                 agent_rung: bool) -> SideResult:
    # The scored call appends --json, so this side's parsed payloads are JSON
    # envelopes. `agent_chars` accumulates a second, cost-only pass -- see the
    # module docstring for why it is a separate invocation and what that costs
    # in rigour.
    res = SideResult(shape="json", agent_chars=0 if agent_rung else None)
    for call in case["codastre"]:
        cmd = [bin_path, call["tool"], *call["args"], "--json"]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            res.errors.append(f"{' '.join(cmd)}: {e}")
            res.calls += 1
            continue
        res.calls += 1
        res.result_chars += len(out.stdout)
        if agent_rung:
            _measure_agent_rung(bin_path, call, res)
        if out.returncode != 0 or not out.stdout.strip():
            res.errors.append((out.stderr or out.stdout).strip()[:200])
            continue
        try:
            env = json.loads(out.stdout)
        except json.JSONDecodeError:
            res.errors.append(f"non-JSON output from {call['tool']}")
            continue
        _collect_codastre_nodes(env, id2short, res)
    return res


def _measure_agent_rung(bin_path: str, call: dict, res: SideResult) -> None:
    """Re-issue one call at `--format agent` and add its size. Cost only.

    Nothing here is parsed, and `res.calls` is deliberately NOT incremented: the
    call count reports the calls a caller would make to answer the question, and
    a caller picks ONE rung. Counting this pass would report the harness's own
    double-measurement as workflow cost.

    A failure here zeroes the whole column rather than silently omitting one
    call's bytes, which would read as a saving.

    Snippet flags are refused rather than honoured. `--json` is never hydrated,
    but `--format agent` honours `--snippets`, so passing one through would give
    the two rungs different CONTENT and not just different encoding -- measured on
    one query, 3,610 B bodies-off vs 11,685 B bodies-on, i.e. the flag swamps the
    encoding it is meant to isolate. A case carrying one is a case authored for a
    different comparison, so say so instead of reporting a bogus ladder figure.
    """
    hydration_flags = [a for a in call["args"]
                       if a.startswith("--snippets") or a.startswith("--max-snippet-lines")]
    if hydration_flags:
        res.errors.append(
            "agent rung skipped: case passes " + " ".join(hydration_flags)
            + " -- --json ignores it but --format agent honours it, so the two rungs "
              "would differ in content, not encoding"
        )
        res.agent_chars = None
        return
    cmd = [bin_path, call["tool"], *call["args"], "--format", "agent"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        res.errors.append(f"agent rung: {e}")
        res.agent_chars = None
        return
    if out.returncode != 0 or not out.stdout.strip():
        res.errors.append("agent rung: " + (out.stderr or out.stdout).strip()[:160])
        res.agent_chars = None
        return
    if res.agent_chars is not None:
        res.agent_chars += len(out.stdout)


def _add_node(node: dict, id2short: dict[str, str], res: SideResult) -> None:
    short = id2short.get(node.get("repo_id", ""))
    if short is None:
        return
    path = node.get("path_token", "")
    res.locations.add((short, path))
    res.spans.append((short, path, node.get("line_start", 0), node.get("line_end", 0)))


def _collect_codastre_nodes(env: dict, id2short: dict[str, str], res: SideResult) -> None:
    for r in env.get("results", []):  # QUERY
        _add_node(r, id2short, res)
    for e in env.get("edges", []):  # GRAPH
        for side in ("src", "dst"):
            if e.get(side):
                _add_node(e[side], id2short, res)


# ---------------------------------------------------------------------------
# grep side
# ---------------------------------------------------------------------------
def grep_tool() -> tuple[str, list[str]]:
    """Prefer a real ripgrep binary; fall back to POSIX grep -rn -E (always present).
    Both emit `path:line:content`, so the location parser handles either."""
    rg = shutil.which("rg")
    if rg:
        return rg, ["-n", "--no-heading", "-e"]
    return shutil.which("grep") or "grep", ["-rn", "-E", "-e"]


def run_grep(case: dict, repos: dict, workspace: str) -> SideResult:
    res = SideResult(shape="text")
    tool, flags = grep_tool()
    root_by_repo = {short: os.path.join(workspace, repos[short]["dir"]) for short in repos}
    for call in case["grep"]:
        roots = []
        for short in call["repos"]:
            root = root_by_repo.get(short)
            if root and os.path.isdir(root):
                roots.append((short, root))
            else:
                res.errors.append(f"missing checkout: {short} ({root})")
        if not roots:
            res.calls += 1
            continue
        cmd = [tool, *flags, call["pattern"], *[r for _, r in roots]]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as e:
            res.errors.append(f"rg: {e}")
            res.calls += 1
            continue
        res.calls += 1
        res.result_chars += len(out.stdout)
        _collect_grep_locs(out.stdout, roots, res)
    return res


def _collect_grep_locs(stdout: str, roots: list[tuple[str, str]], res: SideResult) -> None:
    for line in stdout.splitlines():
        parts = line.split(":", 2)
        if len(parts) < 2 or not parts[1].isdigit():
            continue
        abs_path, lineno = parts[0], int(parts[1])
        for short, root in roots:
            if abs_path.startswith(root + os.sep):
                rel = abs_path[len(root) + 1:]
                res.locations.add((short, rel))
                res.spans.append((short, rel, lineno, lineno))
                break


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def render_md(report: dict) -> str:
    out = ["# Codastre vs grep — deterministic benchmark", ""]
    out.append(f"workspace: `{report['workspace']}` · bin: `{report['bin']}`")
    if report.get("agent_rung"):
        out.append("")
        out.append(
            "Codastre is priced at two rungs of the `format` ladder: **agent** "
            "(`--format agent`, the text rendering — the cheapest rung a caller can reach, "
            "and the headline figure) and **json** (`--json` — the most verbose rung, an "
            "upper bound). Same query, same ranking; only the encoding differs, so the "
            "precision/recall columns belong to both. Locations are parsed from the json "
            "call only. Rungs are measured by two adjacent invocations, not one rendered "
            "twice, so a moving index can put them on slightly different result sets."
        )
    else:
        out.append("")
        out.append(
            "**Agent rung unavailable** — this `codastre` binary does not advertise "
            "`--format agent`, so Codastre is priced only at `--json`, its most verbose "
            "rung. Treat its figures as an upper bound, not as what an agent pays."
        )
    out.append("")
    for c in report["cases"]:
        out.append(f"## {c['id']} — {c['question']}")
        out.append(f"_{c['kind']}_")
        out.append("")
        out.append("| Side | Calls | Result bytes | ~Tokens | Precision | Recall |")
        out.append("|---|--:|--:|--:|--:|--:|")
        for name in ("codastre", "grep"):
            s, sc = c[name], c[name + "_score"]
            prec = (f"{sc['precision']:.0%} ({len(sc['found'])}/{sc['returned']}) | "
                    f"{sc['recall']:.0%}")
            if name == "codastre" and s.get("agent_tokens") is not None:
                # The cheap rung first: it is the figure a caller actually pays.
                out.append(
                    f"| codastre (agent) | {s['calls']} | {s['agent_chars']:,} | "
                    f"{s['agent_tokens']:,} | {prec} |"
                )
                out.append(
                    f"| codastre (json) | {s['calls']} | {s['result_chars']:,} | "
                    f"{s['tokens']:,} | {prec} |"
                )
            else:
                out.append(f"| {name} | {s['calls']} | {s['result_chars']:,} | "
                           f"{s['tokens']:,} | {prec} |")
        miss = c["codastre_score"]["missed"] or c["grep_score"]["missed"]
        if miss:
            out.append("")
            if c["codastre_score"]["missed"]:
                out.append(f"- codastre missed: {', '.join(c['codastre_score']['missed'])}")
            if c["grep_score"]["missed"]:
                out.append(f"- grep missed: {', '.join(c['grep_score']['missed'])}")
        for name in ("codastre", "grep"):
            if c[name]["errors"]:
                out.append(f"- {name} errors: {c[name]['errors']}")
        out.append("")
    t = report["totals"]
    out.append("## Totals")
    out.append("| Side | Calls | ~Tokens | Mean precision | Mean recall |")
    out.append("|---|--:|--:|--:|--:|")
    for name in ("codastre", "grep"):
        tt = t[name]
        if name == "codastre" and tt.get("agent_tokens") is not None:
            out.append(
                f"| codastre (agent) | {tt['calls']} | {tt['agent_tokens']:,} | "
                f"{tt['precision']:.0%} | {tt['recall']:.0%} |"
            )
            out.append(
                f"| codastre (json) | {tt['calls']} | {tt['tokens']:,} | "
                f"{tt['precision']:.0%} | {tt['recall']:.0%} |"
            )
        else:
            out.append(
                f"| {name} | {tt['calls']} | {tt['tokens']:,} | "
                f"{tt['precision']:.0%} | {tt['recall']:.0%} |"
            )
    return "\n".join(out)


def build_report(cases_doc: dict, workspace: str, bin_path: str) -> dict:
    repos = cases_doc["repos"]
    id2short = resolve_repo_ids(bin_path, repos)
    agent_rung = supports_agent_format(bin_path)
    out_cases = []
    agg = {n: {"calls": 0, "tokens": 0, "prec": [], "rec": []} for n in ("codastre", "grep")}
    agg["codastre"]["agent_tokens"] = 0 if agent_rung else None
    for case in cases_doc["cases"]:
        expected = {(e["repo"], e["path"]) for e in case["expected"]}
        cres = run_codastre(bin_path, case, id2short, agent_rung)
        gres = run_grep(case, repos, workspace)
        cscore = score(cres.locations, expected)
        gscore = score(gres.locations, expected)
        for name, r, sc in (("codastre", cres, cscore), ("grep", gres, gscore)):
            agg[name]["calls"] += r.calls
            agg[name]["tokens"] += r.tokens
            agg[name]["prec"].append(sc["precision"])
            agg[name]["rec"].append(sc["recall"])
        # One case failing to render collapses the total, rather than summing a
        # partial figure that would look like a saving.
        if cres.agent_tokens is None:
            agg["codastre"]["agent_tokens"] = None
        elif agg["codastre"]["agent_tokens"] is not None:
            agg["codastre"]["agent_tokens"] += cres.agent_tokens
        out_cases.append({
            "id": case["id"], "question": case["question"], "kind": case["kind"],
            "codastre": _side_dict(cres), "codastre_score": cscore,
            "grep": _side_dict(gres), "grep_score": gscore,
        })
    totals = {
        n: {
            "calls": agg[n]["calls"], "tokens": agg[n]["tokens"],
            "precision": sum(agg[n]["prec"]) / len(agg[n]["prec"]) if agg[n]["prec"] else 0,
            "recall": sum(agg[n]["rec"]) / len(agg[n]["rec"]) if agg[n]["rec"] else 0,
        }
        for n in ("codastre", "grep")
    }
    totals["codastre"]["agent_tokens"] = agg["codastre"]["agent_tokens"]
    return {"workspace": workspace, "bin": bin_path, "agent_rung": agent_rung,
            "cases": out_cases, "totals": totals}


def _side_dict(r: SideResult) -> dict:
    return {"calls": r.calls, "result_chars": r.result_chars, "tokens": r.tokens,
            "agent_chars": r.agent_chars, "agent_tokens": r.agent_tokens,
            "errors": r.errors}


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Deterministic Codastre-vs-grep benchmark.")
    ap.add_argument("--cases", default=os.path.join(here, "cases.json"))
    ap.add_argument("--workspace", default=None)
    ap.add_argument("--bin", default=None)
    ap.add_argument("--format", choices=["md", "json"], default="md")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    workspace = os.path.abspath(args.workspace) if args.workspace else default_workspace()
    bin_path = args.bin or resolve_bin(workspace)
    if not (shutil.which("rg") or shutil.which("grep")):
        print("error: neither rg nor grep found on PATH — the grep side needs one.", file=sys.stderr)
        return 2
    with open(args.cases) as f:
        cases_doc = json.load(f)

    report = build_report(cases_doc, workspace, bin_path)
    text = json.dumps(report, indent=2) if args.format == "json" else render_md(report)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text + "\n")
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

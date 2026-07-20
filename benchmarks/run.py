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

Token figures are chars/4 estimates of each tool RESULT — the comparable cost a
model would pay to ingest that output. The Codastre side measures the raw `--json`
envelope from the CLI (data-plane payload); the local `codastre serve` proxy inlines
snippets on top of this, which this harness does not add.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field

TOKENS_PER_CHAR = 0.25  # ~4 chars/token, matching the token-audit skill


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
    locations: set[tuple[str, str]] = field(default_factory=set)  # (repo, path)
    spans: list[tuple[str, str, int, int]] = field(default_factory=list)  # repo,path,ls,le
    errors: list[str] = field(default_factory=list)

    @property
    def tokens(self) -> int:
        return round(self.result_chars * TOKENS_PER_CHAR)


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


def run_codastre(bin_path: str, case: dict, id2short: dict[str, str]) -> SideResult:
    res = SideResult()
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
    res = SideResult()
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
    out.append("")
    for c in report["cases"]:
        out.append(f"## {c['id']} — {c['question']}")
        out.append(f"_{c['kind']}_")
        out.append("")
        out.append("| Side | Calls | Result bytes | ~Tokens | Precision | Recall |")
        out.append("|---|--:|--:|--:|--:|--:|")
        for name in ("codastre", "grep"):
            s, sc = c[name], c[name + "_score"]
            out.append(
                f"| {name} | {s['calls']} | {s['result_chars']:,} | {s['tokens']:,} | "
                f"{sc['precision']:.0%} ({len(sc['found'])}/{sc['returned']}) | "
                f"{sc['recall']:.0%} |"
            )
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
        out.append(
            f"| {name} | {tt['calls']} | {tt['tokens']:,} | "
            f"{tt['precision']:.0%} | {tt['recall']:.0%} |"
        )
    return "\n".join(out)


def build_report(cases_doc: dict, workspace: str, bin_path: str) -> dict:
    repos = cases_doc["repos"]
    id2short = resolve_repo_ids(bin_path, repos)
    out_cases = []
    agg = {n: {"calls": 0, "tokens": 0, "prec": [], "rec": []} for n in ("codastre", "grep")}
    for case in cases_doc["cases"]:
        expected = {(e["repo"], e["path"]) for e in case["expected"]}
        cres = run_codastre(bin_path, case, id2short)
        gres = run_grep(case, repos, workspace)
        cscore = score(cres.locations, expected)
        gscore = score(gres.locations, expected)
        for name, r, sc in (("codastre", cres, cscore), ("grep", gres, gscore)):
            agg[name]["calls"] += r.calls
            agg[name]["tokens"] += r.tokens
            agg[name]["prec"].append(sc["precision"])
            agg[name]["rec"].append(sc["recall"])
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
    return {"workspace": workspace, "bin": bin_path, "cases": out_cases, "totals": totals}


def _side_dict(r: SideResult) -> dict:
    return {"calls": r.calls, "result_chars": r.result_chars, "tokens": r.tokens,
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

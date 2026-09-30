#!/usr/bin/env python3
"""Code, git and data statistics for CDDA-3D, printed as Markdown (and optional JSON).

Counts come from git objects, not the working tree, so any ref can be measured
(e.g. `--ref v1-dda`). Lines are classified as code / comment / blank with a small
C-family counter (// and /* */), which is good enough for TS/JS/CSS; Python and
shell use '#'. No external tool (cloc/tokei) is needed.

Usage:
  code_stats.py [--ref bn] [--json out.json] [--growth-csv out.csv]
"""
import argparse
import collections
import csv
import json
import os
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))

LANG = {
    ".ts": "TypeScript", ".js": "JavaScript", ".mjs": "JavaScript", ".css": "CSS", ".html": "HTML",
    ".py": "Python", ".sh": "Shell", ".nix": "Nix", ".glsl": "GLSL", ".md": "Markdown", ".json": "JSON",
}
# public/ is extracted game data/art/audio, vendor/ and node_modules are third party,
# notes/ is this blog-post folder itself.
EXCLUDE_PREFIXES = ("public/", "vendor/", "node_modules/", "notes/", "package-lock.json")

# Phase boundaries (local PDT commit times) used for the growth table. See facts.md.
PHASES = [
    ("scaffold (first commit)", "ce7b579"),
    ("v1 first working copy (0251064)", "0251064"),
    ("v1-dda tag", "v1-dda"),
    ("end of v2 (BN) push", "2026-09-29 22:45"),
    ("end of wave 3 overnight", "2026-09-30 07:15"),
    ("now (bn head)", "bn"),
]


def git(*args, input=None):
    return subprocess.run(["git", "-C", REPO, *args], check=True, capture_output=True, input=input).stdout


def resolve(ref):
    if ref[:4].isdigit() and "-" in ref:
        sha = git("rev-list", "-1", f"--before={ref}", "bn").decode().strip()
        if not sha:
            sys.exit(f"no commit on bn before {ref}")
        return sha
    return git("rev-parse", ref).decode().strip()


def count_lines(text, ext):
    code = comment = blank = 0
    in_block = False
    hash_comments = ext in (".py", ".sh", ".nix")
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            blank += 1
        elif in_block:
            comment += 1
            if "*/" in line:
                in_block = False
        elif hash_comments and line.startswith("#"):
            comment += 1
        elif not hash_comments and line.startswith("//"):
            comment += 1
        elif not hash_comments and line.startswith("/*"):
            comment += 1
            in_block = "*/" not in line
        else:
            code += 1
    return code, comment, blank


def tree_files(sha):
    out = git("ls-tree", "-r", "-l", sha).decode()
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        _mode, typ, obj, size = meta.split()
        if typ == "blob":
            yield path, obj, int(size) if size != "-" else 0


def area_of(path):
    parts = path.split("/")
    if parts[0] == "src" and len(parts) > 2:
        return "src/" + parts[1]
    if parts[0] in ("src", "tests", "tools", "docs"):
        return parts[0]
    return "(root)"


def measure(sha):
    files = [(p, o, s) for p, o, s in tree_files(sha) if not p.startswith(EXCLUDE_PREFIXES)]
    wanted = [(p, o) for p, o, _ in files if os.path.splitext(p)[1] in LANG]
    # One `git cat-file --batch` process for all blobs; spawning per file is ~100x slower.
    req = "".join(o + "\n" for _, o in wanted).encode()
    out = git("cat-file", "--batch", input=req)
    by_lang = collections.defaultdict(lambda: [0, 0, 0, 0])
    by_area = collections.defaultdict(lambda: [0, 0])
    pos = 0
    for path, _obj in wanted:
        header_end = out.index(b"\n", pos)
        size = int(out[pos:header_end].split()[2])
        blob = out[header_end + 1: header_end + 1 + size]
        pos = header_end + 1 + size + 1
        ext = os.path.splitext(path)[1]
        c, cm, b = count_lines(blob.decode("utf-8", "replace"), ext)
        L = by_lang[LANG[ext]]
        L[0] += 1; L[1] += c; L[2] += cm; L[3] += b
        if ext in (".ts", ".js", ".mjs", ".css", ".html", ".py", ".sh", ".glsl"):
            A = by_area[area_of(path)]
            A[0] += 1; A[1] += c
    tests = sum(1 for p, _, _ in files if p.startswith("tests/") and p.endswith(".test.ts"))
    return {"by_lang": dict(by_lang), "by_area": dict(by_area), "test_files": tests, "tracked_files": len(files)}


def test_cases(sha):
    # Rough static count of it()/test() calls; the runtime count from `npm test` is authoritative.
    n = 0
    for path, obj, _ in tree_files(sha):
        if path.startswith("tests/") and path.endswith(".ts"):
            txt = git("cat-file", "blob", obj).decode("utf-8", "replace")
            n += sum(txt.count(k) for k in ("\n  it(", "\nit(", "\n    it(", "\n  test(", "\ntest(", "\n    test("))
    return n


def data_stats(sha):
    stats = {}
    for path, obj, size in tree_files(sha):
        if path.startswith("public/data/") and path.endswith(".json"):
            d = json.loads(git("cat-file", "blob", obj))
            name = os.path.basename(path)[:-5]
            if isinstance(d, list):
                counts = {"entries": len(d)}
            else:
                counts = {k: len(v) for k, v in d.items() if isinstance(v, (list, dict))}
                if name in ("items", "monsters", "terrain", "furniture", "item_groups", "monster_groups", "palettes"):
                    counts = {"entries": len(d)}
            stats[name] = {"bytes": size, "counts": counts}
    public = collections.Counter()
    for path, _obj, size in tree_files(sha):
        if path.startswith("public/"):
            public[path.split("/")[1]] += size
    return stats, dict(public)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", default="bn", help="git ref to measure (default: %(default)s)")
    ap.add_argument("--json", help="also write all numbers to this JSON file")
    ap.add_argument("--growth-csv", help="write the per-phase growth table to this CSV")
    args = ap.parse_args()

    sha = resolve(args.ref)
    m = measure(sha)
    out = {"ref": args.ref, "sha": sha[:10], **m, "test_cases_static": test_cases(sha)}
    out["data"], out["public_bytes"] = data_stats(sha)

    print(f"# Code stats at {args.ref} ({sha[:10]})\n")
    print("| language | files | code | comment | blank |\n|---|---:|---:|---:|---:|")
    for lang, (f, c, cm, b) in sorted(m["by_lang"].items(), key=lambda kv: -kv[1][1]):
        print(f"| {lang} | {f} | {c:,} | {cm:,} | {b:,} |")
    print("\n| area (code files) | files | code lines |\n|---|---:|---:|")
    for area, (f, c) in sorted(m["by_area"].items(), key=lambda kv: -kv[1][1]):
        print(f"| {area} | {f} | {c:,} |")
    print(f"\ntest files: {m['test_files']}, static it()/test() count: {out['test_cases_static']}, "
          f"tracked files (excl. public/vendor/notes): {m['tracked_files']}")
    print("\n| data file | bytes | counts |\n|---|---:|---|")
    for name, s in sorted(out["data"].items()):
        print(f"| {name}.json | {s['bytes']:,} | {', '.join(f'{k} {v:,}' for k, v in s['counts'].items())} |")
    print("\npublic/ bytes by folder:", {k: f"{v/1e6:.1f} MB" for k, v in out["public_bytes"].items()})

    # Git history numbers.
    all_commits = git("rev-list", "--all", "--count").decode().strip()
    bn_commits = git("rev-list", "--count", "bn").decode().strip()
    bn_merges = git("rev-list", "--merges", "--count", "bn").decode().strip()
    branches = git("for-each-ref", "--format=%(refname:short)", "refs/heads").decode().split()
    agent_branches = [b for b in branches if b.startswith("worktree-agent-")]
    out["git"] = {"commits_all_refs": int(all_commits), "commits_bn": int(bn_commits), "merges_bn": int(bn_merges),
                  "branches": len(branches), "agent_branches": len(agent_branches)}
    print(f"\ngit: {all_commits} commits across all refs, {bn_commits} on bn ({bn_merges} merges), "
          f"{len(branches)} local branches of which {len(agent_branches)} are subagent worktree branches")

    # Growth table.
    rows = []
    for label, ref in PHASES:
        s = resolve(ref)
        mm = measure(s)
        ts_code = sum(v[1] for k, v in mm["by_lang"].items() if k in ("TypeScript", "JavaScript"))
        src = sum(v[1] for k, v in mm["by_area"].items() if k.startswith("src"))
        tests = mm["by_area"].get("tests", [0, 0])[1]
        tools = mm["by_area"].get("tools", [0, 0])[1]
        docs = mm["by_lang"].get("Markdown", [0, 0, 0, 0])
        when = git("show", "-s", "--format=%ad", "--date=format:%Y-%m-%d %H:%M", s).decode().strip()
        ncommits = int(git("rev-list", "--count", s).decode())
        rows.append({"phase": label, "commit": s[:7], "date_pdt": when, "commits": ncommits,
                     "ts_js_code": ts_code, "src_code": src, "tests_code": tests, "tools_code": tools,
                     "test_files": mm["test_files"], "markdown_lines": docs[1] + docs[2] + docs[3]})
    out["growth"] = rows
    print("\n| phase | commit | date (PDT) | commits | TS/JS code | src | tests | tools | test files | markdown lines |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        print(f"| {r['phase']} | {r['commit']} | {r['date_pdt']} | {r['commits']} | {r['ts_js_code']:,} | "
              f"{r['src_code']:,} | {r['tests_code']:,} | {r['tools_code']:,} | {r['test_files']} | {r['markdown_lines']:,} |")
    if args.growth_csv:
        with open(args.growth_csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(out, fh, indent=1, default=list)


if __name__ == "__main__":
    main()

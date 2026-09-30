#!/usr/bin/env python3
"""Step 2 of 2: token / message / agent numbers from transcripts.sqlite.

Run load_transcripts.py first. Prints Markdown tables; --json writes the raw numbers
(used by the charts in index.html).

Phases are cut on wall-clock time (UTC) at the user's messages that started each push,
and every API call is assigned by its own timestamp, so a subagent that straddles a
boundary is split rather than lumped. Boundaries are documented in facts.md.

Usage:
  analyse.py [--db PATH] [--json out.json]
"""
import argparse
import datetime as dt
import json
import os
import sqlite3

DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "transcripts.sqlite")

PHASES = [
    # name, start (inclusive, UTC ISO). Each phase ends where the next starts.
    ("v1 autonomous build (DDA)", "2026-09-29T05:25:00"),
    ("v1 review + UX pass", "2026-09-29T14:09:00"),
    ("v2 Bright Nights push", "2026-09-29T15:37:00"),
    ("wave 3 overnight", "2026-09-30T05:43:00"),
    ("wave 4 interactive (gallery, vehicles, stairs, VR, perf, blog)", "2026-09-30T14:14:00"),
]
END = "2099-01-01"


def phase_of(ts):
    name = None
    for n, start in PHASES:
        if ts >= start:
            name = n
    if name is None:
        raise ValueError(f"timestamp {ts} predates the first phase")
    return name


def fmt(n):
    if n >= 1e9:
        return f"{n/1e9:.2f} B"
    if n >= 1e6:
        return f"{n/1e6:.1f} M"
    if n >= 1e3:
        return f"{n/1e3:.1f} k"
    return str(n)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--json", help="write raw numbers here")
    args = ap.parse_args()
    if not os.path.exists(args.db):
        raise SystemExit(f"{args.db} missing: run load_transcripts.py first")
    con = sqlite3.connect(args.db)
    con.create_function("phase", 1, phase_of)
    out = {}

    snap = con.execute("select max(ts) from api_calls").fetchone()[0]
    out["snapshot_last_api_call_utc"] = snap
    print(f"# Transcript numbers (snapshot: last API call {snap} UTC)\n")

    # Tokens per phase x role
    rows = con.execute("""
      select phase(a.ts) ph, f.kind, count(*), sum(input_tokens), sum(output_tokens), sum(cache_read),
             sum(cache_creation), sum(thinking_tokens)
      from api_calls a join files f using(file_id) group by ph, f.kind""").fetchall()
    tok = {}
    for ph, kind, n, i, o, cr, cc, th in rows:
        tok.setdefault(ph, {})[kind] = dict(api_calls=n, input=i, output=o, cache_read=cr, cache_creation=cc,
                                            thinking=th)
    out["tokens_by_phase"] = tok
    print("## Tokens by phase (lead + subagents)\n")
    print("| phase | API calls | input (uncached) | cache write | cache read | output | of which thinking |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    tot = dict(api_calls=0, input=0, output=0, cache_read=0, cache_creation=0, thinking=0)
    for ph, _ in PHASES:
        d = tok.get(ph, {})
        s = {k: sum(x[k] for x in d.values()) for k in tot}
        for k in tot:
            tot[k] += s[k]
        print(f"| {ph} | {s['api_calls']:,} | {fmt(s['input'])} | {fmt(s['cache_creation'])} | "
              f"{fmt(s['cache_read'])} | {fmt(s['output'])} | {fmt(s['thinking'])} |")
    print(f"| **total** | {tot['api_calls']:,} | {fmt(tot['input'])} | {fmt(tot['cache_creation'])} | "
          f"{fmt(tot['cache_read'])} | {fmt(tot['output'])} | {fmt(tot['thinking'])} |")
    out["tokens_total"] = tot
    exact = {k: v for k, v in tot.items()}
    print("\nexact totals:", json.dumps(exact))

    print("\n## Lead vs subagents\n\n| role | API calls | input | cache write | cache read | output |\n|---|---:|---:|---:|---:|---:|")
    for kind in ("lead", "subagent"):
        s = con.execute("""select count(*), sum(input_tokens), sum(cache_creation), sum(cache_read), sum(output_tokens)
                           from api_calls join files using(file_id) where kind=?""", (kind,)).fetchone()
        out[f"tokens_{kind}"] = s
        print(f"| {kind} | {s[0]:,} | {fmt(s[1])} | {fmt(s[2])} | {fmt(s[3])} | {fmt(s[4])} |")

    print("\n## Models\n")
    for m, n, o in con.execute("select model, count(*), sum(output_tokens) from api_calls group by model"):
        print(f"- {m}: {n:,} calls, {fmt(o)} output tokens")
        out.setdefault("models", {})[m] = n

    # Agents per phase (by the subagent's first timestamp)
    print("\n## Subagents spawned per phase (by start time)\n\n| phase | depth-1 agents | nested (forks / sub-subagents) |\n|---|---:|---:|")
    ag = {}
    for ph, depth, n in con.execute("""select phase(first_ts), spawn_depth, count(*) from files
                                        where kind='subagent' group by 1,2"""):
        ag.setdefault(ph, {})[depth] = n
    for ph, _ in PHASES:
        d = ag.get(ph, {})
        print(f"| {ph} | {d.get(1, 0)} | {d.get(2, 0)} |")
    out["agents_by_phase"] = ag
    n_agents = con.execute("select count(*) from files where kind='subagent'").fetchone()[0]
    print(f"\ntotal subagent transcripts: {n_agents}")

    # Biggest agents by output tokens
    print("\n## Top 12 subagents by output tokens\n\n| agent task | phase | wall time | API calls | output | cache read |\n|---|---|---:|---:|---:|---:|")
    for desc, ft, lt, n, o, cr in con.execute("""select description, first_ts, last_ts, count(*), sum(output_tokens), sum(cache_read)
            from api_calls join files using(file_id) where kind='subagent' group by file_id order by 5 desc limit 12"""):
        wall = dt.datetime.fromisoformat(lt[:19]) - dt.datetime.fromisoformat(ft[:19])
        print(f"| {desc} | {phase_of(ft)} | {wall.seconds//3600}h{(wall.seconds%3600)//60:02d} | {n:,} | {fmt(o)} | {fmt(cr)} |")

    # Agent-hours and concurrency: a subagent counts as "running" from its first to last message.
    spans = [(ft, lt) for ft, lt in con.execute("select first_ts, last_ts from files where kind='subagent'")]
    hours = sum((dt.datetime.fromisoformat(lt[:19]) - dt.datetime.fromisoformat(ft[:19])).total_seconds()
                for ft, lt in spans) / 3600
    events = sorted([(ft, 1) for ft, _ in spans] + [(lt, -1) for _, lt in spans])
    cur = peak = 0
    peak_at = None
    for ts, d in events:
        cur += d
        if cur > peak:
            peak, peak_at = cur, ts
    out["subagent_hours"] = hours
    out["peak_concurrent_subagents"] = [peak, peak_at]
    print(f"\nsubagent wall-clock hours (sum of first-to-last message spans): {hours:.1f} h; "
          f"peak concurrency {peak} agents at {peak_at}")
    rl = con.execute("select count(*), min(ts), max(ts) from api_calls where model='<synthetic>'").fetchone()
    out["rate_limit_messages"] = rl
    print(f"rate-limit (synthetic) messages: {rl[0]} between {rl[1]} and {rl[2]}")

    # Tool calls
    print("\n## Tool calls\n")
    tc = con.execute("select count(*) from tool_calls").fetchone()[0]
    out["tool_calls_total"] = tc
    print(f"total tool calls: {tc:,}\n\n| tool | calls |\n|---|---:|")
    tools = con.execute("select name, count(*) from tool_calls group by name order by 2 desc").fetchall()
    out["tool_calls"] = dict(tools)
    for name, n in tools[:15]:
        print(f"| {name} | {n:,} |")
    tcp = dict(con.execute("select phase(ts), count(*) from tool_calls group by 1").fetchall())
    out["tool_calls_by_phase"] = tcp

    # User messages
    print("\n## Messages from the person (lead sessions only)\n")
    um = con.execute("""select phase(u.ts), u.kind, count(*) from user_msgs u join files f using(file_id)
                        where f.kind='lead' and u.kind in ('human','queued_human') group by 1,2""").fetchall()
    asks = con.execute("""select phase(a.ts), count(*), a.questions from ask_answers a join files f using(file_id)
                          where f.kind='lead' group by a.ts""").fetchall()
    per = {}
    for ph, k, n in um:
        per.setdefault(ph, {})[k] = n
    for ph, _n, q in asks:
        d = per.setdefault(ph, {})
        d["ask_rounds"] = d.get("ask_rounds", 0) + 1
        d["ask_questions"] = d.get("ask_questions", 0) + len(json.loads(q)["questions"])
    print("| phase | typed messages | typed while busy (queued) | AskUserQuestion rounds | questions answered |")
    print("|---|---:|---:|---:|---:|")
    for ph, _ in PHASES:
        d = per.get(ph, {})
        print(f"| {ph} | {d.get('human', 0)} | {d.get('queued_human', 0)} | {d.get('ask_rounds', 0)} | {d.get('ask_questions', 0)} |")
    out["user_msgs_by_phase"] = per
    print("\n(The /clear command between sessions is excluded; it is a UI command, not a message.)")

    # Assistant messages / text blocks
    at = con.execute("select f.kind, count(*) from assistant_text a join files f using(file_id) group by 1").fetchall()
    out["assistant_text_blocks"] = dict(at)
    print("\nassistant text blocks:", dict(at))

    # Wall clock
    first = con.execute("select min(first_ts) from files").fetchone()[0]
    print(f"\nfirst message {first}, last API call {snap}")
    out["first_ts"] = first

    # Claude Code's own cost-state record (only written when a session ends / is cleared).
    for fid, raw in con.execute("select file_id, raw from cost_state"):
        d = json.loads(raw)
        out.setdefault("cost_state", []).append({k: d[k] for k in ("sessionId", "totalCostUSD", "totalAPIDuration",
                                                                    "totalDuration", "totalLinesAdded",
                                                                    "totalLinesRemoved", "modelUsage")})
        print(f"\ncost-state record for session {d['sessionId'][:8]}: lines +{d['totalLinesAdded']:,} "
              f"-{d['totalLinesRemoved']:,}, API time {d['totalAPIDuration']/3.6e6:.1f} h, "
              f"reported cost-equivalent ${d['totalCostUSD']:.0f}")

    if args.json:
        with open(args.json, "w") as fh:
            json.dump(out, fh, indent=1)


if __name__ == "__main__":
    main()

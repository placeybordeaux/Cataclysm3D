#!/usr/bin/env python3
"""Search agent prose in transcripts.sqlite and print short snippets with their source.

Searches what agents *said* (assistant text blocks, subagent hand-back reports, messages
between agents, and the person's own messages), not tool output, which is where quotable
commentary lives. Used to find and verify quotes for commentary.md.

Usage:
  grep_transcripts.py REGEX [--context 300] [--limit 40] [--where lead|subagent|user|report]
Examples:
  grep_transcripts.py 'snowstorm'
  grep_transcripts.py 'power_draw|milliwatt' --context 500
"""
import argparse
import json
import os
import re
import sqlite3

DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "transcripts.sqlite")


def sources(con):
    for fid_kind, desc, ts, text in con.execute(
            "select f.kind, f.description, a.ts, a.text from assistant_text a join files f using(file_id)"):
        yield ("lead" if fid_kind == "lead" else "subagent"), desc or "lead", ts, text
    for desc, ts, name, inp in con.execute(
            "select f.description, t.ts, t.name, t.input from tool_calls t join files f using(file_id)"
            " where t.name in ('SubagentHandback', 'SendMessage')"):
        try:
            d = json.loads(inp)
        except json.JSONDecodeError:
            continue
        yield "report", desc or "lead", ts, d.get("message") if isinstance(d.get("message"), str) else json.dumps(d)
    for kind, ts, text in con.execute(
            "select u.kind, u.ts, u.text from user_msgs u join files f using(file_id)"
            " where f.kind='lead' and u.kind in ('human','queued_human')"):
        yield "user", "the user", ts, text


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("regex")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--context", type=int, default=300, help="characters either side of the match")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--where", choices=["lead", "subagent", "user", "report"], help="only this source kind")
    args = ap.parse_args()
    rx = re.compile(args.regex, re.I)
    con = sqlite3.connect(args.db)
    n = 0
    for kind, desc, ts, text in sorted(sources(con), key=lambda r: r[2] or ""):
        if args.where and kind != args.where or not text:
            continue
        for m in rx.finditer(text):
            a, b = max(0, m.start() - args.context), min(len(text), m.end() + args.context)
            snippet = text[a:b].replace("\n", " ")
            print(f"--- [{kind}] {desc} @ {ts}\n…{snippet}…\n")
            n += 1
            if n >= args.limit:
                return
            break  # one snippet per text block keeps output readable


if __name__ == "__main__":
    main()

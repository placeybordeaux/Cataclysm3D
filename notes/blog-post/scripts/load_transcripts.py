#!/usr/bin/env python3
"""Stream Claude Code session transcripts for CDDA-3D into SQLite.

Step 1 of 2 (load). Step 2 is analyse.py, which only reads the SQLite file, so the
analysis can be changed and re-run in seconds without re-parsing ~1 GB of JSONL.

Sources (defaults):
  ~/.claude/projects/-home-peter-code-CDDA-3d/<session>.jsonl            lead sessions
  ~/.claude/projects/-home-peter-code-CDDA-3d/<session>/subagents/*.jsonl subagent transcripts
  ~/.claude/projects/-home-peter-code-CDDA-3d/<session>/subagents/*.meta.json  agent descriptions

Files are streamed line by line; nothing is read whole.

Usage:
  load_transcripts.py [--projects DIR] [--db PATH] [--dry-run]
"""
import argparse
import glob
import json
import os
import sqlite3
import sys
import time

DEFAULT_PROJECTS = os.path.expanduser("~/.claude/projects/-home-peter-code-CDDA-3d")
DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "transcripts.sqlite")

SCHEMA = """
CREATE TABLE files (
  file_id INTEGER PRIMARY KEY, path TEXT UNIQUE, session TEXT, agent_id TEXT,
  kind TEXT,                 -- 'lead' | 'subagent'
  description TEXT, agent_type TEXT, worktree_branch TEXT, spawn_depth INTEGER,
  first_ts TEXT, last_ts TEXT, lines INTEGER, bytes INTEGER
);
-- One row per API response. Claude Code writes one JSONL line per content block and
-- repeats the same usage on each, so rows are de-duplicated on (file, msg_id).
CREATE TABLE api_calls (
  file_id INTEGER, msg_id TEXT, ts TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_creation INTEGER,
  thinking_tokens INTEGER, PRIMARY KEY (file_id, msg_id)
);
CREATE TABLE tool_calls (
  file_id INTEGER, ts TEXT, tool_use_id TEXT, name TEXT, input TEXT
);
-- Text the assistant wrote (not tool calls), for mining commentary.
CREATE TABLE assistant_text (file_id INTEGER, ts TEXT, text TEXT);
-- Everything arriving on the user side that is not a tool result:
-- kind = human (typed by the person) | queued_human | agent_report | task_notification | other
CREATE TABLE user_msgs (
  file_id INTEGER, ts TEXT, kind TEXT, prompt_source TEXT, text TEXT
);
-- Answers to AskUserQuestion and tool-permission style results worth counting.
CREATE TABLE ask_answers (file_id INTEGER, ts TEXT, tool_use_id TEXT, questions TEXT, answers TEXT);
CREATE TABLE cost_state (file_id INTEGER, raw TEXT);
CREATE TABLE system_events (file_id INTEGER, ts TEXT, subtype TEXT, duration_ms INTEGER);
"""


def classify_user_text(text, origin):
    if origin and origin.get("kind") == "human":
        return "human"
    if text.startswith("<task-notification"):
        return "task_notification"
    if text.startswith("<agent-message") or (origin and origin.get("kind") == "peer"):
        return "agent_report"
    return "other"


def content_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts)


def load_file(cur, path, meta, kind, session, agent_id):
    size = os.path.getsize(path)
    cur.execute(
        "INSERT INTO files(path, session, agent_id, kind, description, agent_type, worktree_branch, spawn_depth, bytes)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (path, session, agent_id, kind, meta.get("description"), meta.get("agentType"),
         meta.get("worktreeBranch"), meta.get("spawnDepth"), size),
    )
    fid = cur.lastrowid
    first_ts = last_ts = None
    n = 0
    ask_ids = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            n += 1
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                # A truncated final line happens when a session is killed mid-write; count, don't hide.
                print(f"  warn: bad JSON at {os.path.basename(path)}:{n}", file=sys.stderr)
                continue
            t = d.get("type")
            ts = d.get("timestamp")
            if ts and t in ("user", "assistant"):
                first_ts = first_ts or ts
                last_ts = ts
            if t == "assistant":
                m = d.get("message", {})
                u = m.get("usage") or {}
                if m.get("id") and u:
                    # Streamed responses repeat the message id on every content-block line, and the
                    # early lines carry partial output counts; keep the max of each field.
                    cur.execute(
                        "INSERT INTO api_calls VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(file_id, msg_id) DO UPDATE SET"
                        " input_tokens=max(input_tokens, excluded.input_tokens),"
                        " output_tokens=max(output_tokens, excluded.output_tokens),"
                        " cache_read=max(cache_read, excluded.cache_read),"
                        " cache_creation=max(cache_creation, excluded.cache_creation),"
                        " thinking_tokens=max(thinking_tokens, excluded.thinking_tokens)",
                        (fid, m["id"], ts, m.get("model"), u.get("input_tokens", 0), u.get("output_tokens", 0),
                         u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0),
                         (u.get("output_tokens_details") or {}).get("thinking_tokens", 0)),
                    )
                for block in m.get("content") or []:
                    bt = block.get("type")
                    if bt == "text" and block.get("text", "").strip():
                        cur.execute("INSERT INTO assistant_text VALUES (?,?,?)", (fid, ts, block["text"]))
                    elif bt == "tool_use":
                        inp = json.dumps(block.get("input"))
                        # Reports and prompts between agents are the commentary we mine, so keep them whole;
                        # other tool inputs (file writes, long bash) are capped to keep the DB small.
                        if block.get("name") not in ("SubagentHandback", "Agent", "SendMessage", "AskUserQuestion"):
                            inp = inp[:20000]
                        cur.execute("INSERT INTO tool_calls VALUES (?,?,?,?,?)",
                                    (fid, ts, block.get("id"), block.get("name"), inp))
                        if block.get("name") == "AskUserQuestion":
                            ask_ids[block.get("id")] = inp
            elif t == "user":
                c = d.get("message", {}).get("content")
                if isinstance(c, list) and any(b.get("type") == "tool_result" for b in c):
                    for b in c:
                        if b.get("type") == "tool_result" and b.get("tool_use_id") in ask_ids:
                            res = d.get("toolUseResult")
                            cur.execute("INSERT INTO ask_answers VALUES (?,?,?,?,?)",
                                        (fid, ts, b["tool_use_id"], ask_ids[b["tool_use_id"]],
                                         json.dumps(res) if res is not None else json.dumps(b.get("content"))))
                    continue
                text = content_text(c or "")
                if d.get("isMeta"):
                    continue
                kind_u = classify_user_text(text, d.get("origin"))
                cur.execute("INSERT INTO user_msgs VALUES (?,?,?,?,?)",
                            (fid, ts, kind_u, d.get("promptSource"), text))
            elif t == "attachment":
                a = d.get("attachment", {})
                if a.get("type") == "queued_command":
                    p = a.get("prompt")
                    p = p if isinstance(p, str) else content_text(p or [])
                    k = classify_user_text(p, None)
                    # Messages typed while the agent was busy arrive as queued commands, not user lines.
                    cur.execute("INSERT INTO user_msgs VALUES (?,?,?,?,?)",
                                (fid, ts, "queued_human" if k == "other" else k, a.get("commandMode"), p))
            elif t == "cost-state":
                cur.execute("INSERT INTO cost_state VALUES (?,?)", (fid, json.dumps(d)))
            elif t == "system":
                cur.execute("INSERT INTO system_events VALUES (?,?,?,?)",
                            (fid, ts, d.get("subtype"), d.get("durationMs")))
    cur.execute("UPDATE files SET first_ts=?, last_ts=?, lines=? WHERE file_id=?", (first_ts, last_ts, n, fid))
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--projects", default=DEFAULT_PROJECTS, help="Claude Code project dir (default: %(default)s)")
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite output (recreated) (default: %(default)s)")
    ap.add_argument("--dry-run", action="store_true", help="list the files that would be loaded, write nothing")
    args = ap.parse_args()

    leads = sorted(glob.glob(os.path.join(args.projects, "*.jsonl")))
    if not leads:
        sys.exit(f"no session transcripts under {args.projects}")
    jobs = []
    for lead in leads:
        session = os.path.basename(lead)[:-6]
        jobs.append((lead, {}, "lead", session, None))
        for sub in sorted(glob.glob(os.path.join(args.projects, session, "subagents", "*.jsonl"))):
            agent_id = os.path.basename(sub)[len("agent-"):-6]
            meta_path = sub[:-6] + ".meta.json"
            meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
            jobs.append((sub, meta, "subagent", session, agent_id))

    total = sum(os.path.getsize(j[0]) for j in jobs)
    print(f"{len(jobs)} transcripts, {total/1e6:.0f} MB")
    if args.dry_run:
        for j in jobs:
            print(f"  would load {j[2]:8s} {os.path.getsize(j[0])/1e6:7.1f} MB  {j[1].get('description') or j[3]}")
        return

    if os.path.exists(args.db):
        os.remove(args.db)
    con = sqlite3.connect(args.db)
    con.executescript(SCHEMA)
    cur = con.cursor()
    done = 0
    t0 = time.time()
    for path, meta, kind, session, agent_id in jobs:
        load_file(cur, path, meta, kind, session, agent_id)
        done += os.path.getsize(path)
        bar = int(30 * done / total)
        print(f"\r  [{'#' * bar}{'.' * (30 - bar)}] {done/1e6:6.0f}/{total/1e6:.0f} MB", end="", flush=True)
    con.commit()
    print(f"\nloaded into {os.path.relpath(args.db)} in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Load Cataclysm3D perf dumps (Shift+F3, cdda3d-perf-*.json) into sqlite, then analyse hitches.

Two separable steps so the analysis can be changed and re-run without re-parsing:

    uv run tools/perf-traces.py ingest ~/Downloads/cdda3d-perf-*.json   # -> perf-traces.sqlite
    uv run tools/perf-traces.py report                                  # every trace, side by side
    uv run tools/perf-traces.py report --trace 2026-10-13 --hitches 20  # one trace, its worst frames
    uv run tools/perf-traces.py gc gc.txt                               # Firefox GC log (perf-bench --ff-gc)

The dump format is src/perf/analyze.ts PerfDump (frames are columns, oldest first; events
are chunk streaming events). `tools/perf-report.ts` explains one dump's streaming; this tool
is about *stutter*: where a long frame interval went when it was not inside our own loop.

Key derived column, per frame:
    outside = interval - (wait + loop of the previous frame)
the part of the frame interval spent neither in our rAF callback nor in the delay before it:
the browser presenting / waiting on the GPU, other tasks (idle callbacks, workers' messages,
timers, DOM layout) and GC between frames.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sqlite3
import sys

DEFAULT_DB = 'perf-traces.sqlite'
SECTIONS = ['sim', 'chunkCreate', 'chunkSig', 'chunkBuild', 'grass', 'skyline', 'decor', 'sprites',
            'beforeRender', 'lightmap', 'scene', 'draw', 'other']


def ingest(paths: list[str], db: str, dry_run: bool) -> None:
    con = sqlite3.connect(':memory:' if dry_run else db)
    con.execute('CREATE TABLE IF NOT EXISTS traces (id INTEGER PRIMARY KEY, name TEXT UNIQUE, date TEXT, browser TEXT, '
                'window TEXT, lowres TEXT, look TEXT, radius INTEGER, meta TEXT)')
    con.execute('CREATE TABLE IF NOT EXISTS tasks (trace INTEGER, t REAL, ms REAL, kind TEXT, src TEXT)')
    con.execute('CREATE TABLE IF NOT EXISTS events (trace INTEGER, t REAL, k TEXT, cx INTEGER, cy INTEGER, z INTEGER, '
                'ms REAL, wait REAL, pre INTEGER, omt TEXT, extra TEXT)')
    for path in paths:
        name = os.path.basename(path)
        with open(path) as fh:
            d = json.load(fh)
        if d.get('version') != 1 or 'frames' not in d:
            raise SystemExit(f'{path}: not a version-1 perf dump')
        cols = d['frames']
        n = len(cols['t'])
        for c, v in cols.items():
            if len(v) != n:
                raise SystemExit(f'{path}: column {c} has {len(v)} rows, t has {n}')
        # newer dumps may add columns: grow the frames table to the union of all columns
        have = {r[1] for r in con.execute('PRAGMA table_info(frames)')}
        if not have:
            con.execute('CREATE TABLE frames (trace INTEGER, i INTEGER, t REAL)')
            have = {'trace', 'i', 't'}
        for c in cols:
            if c not in have:
                con.execute(f'ALTER TABLE frames ADD COLUMN "{c}" REAL')
        m = d['meta']
        ua = str(m.get('userAgent', ''))
        browser = 'firefox' if 'Firefox' in ua else 'chromium' if 'Chrome' in ua else ua[:20]
        old = con.execute('SELECT id FROM traces WHERE name = ?', (name,)).fetchone()
        if old:
            con.execute('DELETE FROM frames WHERE trace = ?', old)
            con.execute('DELETE FROM events WHERE trace = ?', old)
            con.execute('DELETE FROM tasks WHERE trace = ?', old)
            con.execute('DELETE FROM traces WHERE id = ?', old)
        cur = con.execute('INSERT INTO traces (name, date, browser, window, lowres, look, radius, meta) VALUES (?,?,?,?,?,?,?,?)',
                          (name, m.get('date'), browser, m.get('window'), m.get('lowres'), m.get('look'), m.get('radius'), json.dumps(m)))
        tid = cur.lastrowid
        names = list(cols)
        q = f'INSERT INTO frames (trace, i, {", ".join(f"{chr(34)}{c}{chr(34)}" for c in names)}) VALUES ({", ".join("?" * (len(names) + 2))})'
        con.executemany(q, ([tid, i] + [cols[c][i] for c in names] for i in range(n)))
        known = {'t', 'k', 'cx', 'cy', 'z', 'ms', 'wait', 'pre', 'omt'}
        con.executemany('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                        ((tid, e.get('t'), e.get('k'), e.get('cx'), e.get('cy'), e.get('z'), e.get('ms'), e.get('wait'),
                          int(bool(e.get('pre'))), e.get('omt'), json.dumps({k: v for k, v in e.items() if k not in known}) or None)
                         for e in d.get('events', [])))
        con.executemany('INSERT INTO tasks VALUES (?,?,?,?,?)', ((tid, k['t'], k['ms'], k['kind'], k['src']) for k in d.get('tasks', [])))
        print(f'  {"(dry run) " if dry_run else ""}{name}: {n} frames, {len(d.get("events", []))} events, {browser} {m.get("window")} look {m.get("look")}')
    if not dry_run:
        con.commit()
        print(f'-> {db}')


def q(xs: list[float], p: float) -> float:
    s = sorted(x for x in xs if x is not None and math.isfinite(x))
    return s[min(len(s) - 1, int(len(s) * p))] if s else float('nan')


def bar(v: float, full: float, w: int = 20) -> str:
    return '█' * max(0, min(w, round(v / full * w))) if full > 0 and math.isfinite(v) else ''


def load(con: sqlite3.Connection, tid: int) -> dict[str, list]:
    cur = con.execute('SELECT * FROM frames WHERE trace = ? ORDER BY i', (tid,))
    names = [c[0] for c in cur.description]
    rows = cur.fetchall()
    return {c: [r[j] for r in rows] for j, c in enumerate(names)}


def num(v) -> float:
    return v if v is not None else float('nan')


def derive(f: dict[str, list]) -> None:
    n = len(f['t'])
    # interval[i] runs from frame i-1's rAF timestamp to frame i's, so it holds frame i-1's
    # wait + loop (not frame i's): a slow loop shows up as the *next* frame's long interval
    f['outside'] = [num(f['interval'][i]) - num(f['loop'][i - 1]) - num(f['wait'][i - 1]) if i else float('nan') for i in range(n)]
    for c in ['loop', 'wait'] + SECTIONS:
        if c in f:
            f['prev_' + c] = [f[c][i - 1] if i else None for i in range(n)]
    f['secsum'] = [sum(num(f[c][i]) if f.get(c) and f[c][i] is not None else 0 for c in SECTIONS) for i in range(n)]


def summary_row(con, tid, name) -> dict:
    f = load(con, tid)
    derive(f)
    iv = f['interval']
    n = len(iv)
    hitch = [i for i in range(n) if iv[i] is not None and iv[i] > 50]
    out = {
        'trace': name[12:31] if name.startswith('cdda3d-perf-') else name,
        'frames': n,
        'p50': q(iv, .5), 'p95': q(iv, .95), 'p99': q(iv, .99), 'max': q(iv, 1),
        '>33': sum(1 for v in iv if v is not None and v > 33.4), '>50': len(hitch), '>100': sum(1 for v in iv if v is not None and v > 100),
        'loop50': q(f['loop'], .5), 'loop99': q(f['loop'], .99),
        'sim99': q(f['sim'], .99), 'draw99': q(f['draw'], .99), 'bR99': q(f['beforeRender'], .99),
        'calls50': q(f['calls'], .5), 'tris50M': q(f['triangles'], .5) / 1e6, 'tris99M': q(f['triangles'], .99) / 1e6,
        # a hitch frame's interval split: our loop vs time outside it
        'hitchLoop': sum(num(f['prev_loop'][i]) for i in hitch) / max(1, len(hitch)),
        'hitchOut': sum(num(f['outside'][i]) for i in hitch) / max(1, len(hitch)),
        'progs+': max(0, (q(f['programs'], 1) - q(f['programs'], 0))) if any(v is not None for v in f['programs']) else float('nan'),
        'geo+': (f['geometries'][-1] or 0) - (f['geometries'][0] or 0) if f['geometries'][0] is not None else float('nan'),
    }
    return out


def fmt(v) -> str:
    if isinstance(v, float):
        return '-' if not math.isfinite(v) else f'{v:.0f}' if abs(v) >= 100 else f'{v:.1f}'
    return str(v)


def report(db: str, trace: str | None, hitches: int) -> None:
    if not os.path.exists(db):
        raise SystemExit(f'{db} does not exist: run `ingest` first')
    con = sqlite3.connect(db)
    traces = con.execute('SELECT id, name, browser, window, look FROM traces ORDER BY name').fetchall()
    if trace:
        traces = [t for t in traces if trace in t[1]]
        if not traces:
            raise SystemExit(f'no trace matches {trace!r}')
    rows = [(t, summary_row(con, t[0], t[1])) for t in traces]
    keys = list(rows[0][1].keys())
    print('frame interval (ms); hitch* = mean over frames > 50 ms of our loop vs time outside it')
    print('  '.join(f'{k:>8}' for k in keys) + '  browser look')
    for t, r in rows:
        print('  '.join(f'{fmt(r[k]):>8}' for k in keys) + f'  {t[2]} {t[3]} {t[4]}')
    if len(traces) != 1:
        return
    tid, name = traces[0][0], traces[0][1]
    f = load(con, tid)
    derive(f)
    n = len(f['t'])
    iv = f['interval']
    print(f'\n== {name}')
    # hitch vs normal frames: which channels differ
    hitch = [i for i in range(n) if iv[i] is not None and iv[i] > 50]
    calm = [i for i in range(n) if iv[i] is not None and iv[i] <= 20]
    print(f'\n{len(hitch)} frames > 50 ms vs {len(calm)} frames <= 20 ms (mean per frame)')
    for c in ['interval', 'outside', 'prev_wait', 'prev_loop'] + ['prev_' + c for c in SECTIONS] + ['mesh', 'trees', 'genSync', 'calls', 'triangles', 'speed', 'geometries', 'textures', 'heapMB', 'tasks', 'tasksN', 'monsters', 'charParts', 'spots', 'points', 'shadowMaps', 'uploads']:
        if c not in f:
            continue
        h = [num(f[c][i]) for i in hitch if f[c][i] is not None]
        k = [num(f[c][i]) for i in calm if f[c][i] is not None]
        if not h and not k:
            continue
        mh = sum(h) / max(1, len(h))
        mk = sum(k) / max(1, len(k))
        print(f'  {c:>14} {fmt(mh):>9} {fmt(mk):>9}  {bar(mh, max(mh, mk, 1e-9))}')
    # time series of hitch spacing: periodic stalls point at a timer
    ts = [f['t'][i] for i in hitch]
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    if gaps:
        print(f'\n  gaps between hitches (ms): p10 {fmt(q(gaps, .1))} p50 {fmt(q(gaps, .5))} p90 {fmt(q(gaps, .9))}')
    slow = con.execute('SELECT kind, src, COUNT(*), MAX(ms), SUM(ms) FROM tasks WHERE trace = ? GROUP BY kind, src ORDER BY SUM(ms) DESC LIMIT 10', (tid,)).fetchall()
    if slow:
        print('\nslow callbacks outside the main loop (>= 4 ms)')
        for kind, src, cnt, mx, tot in slow:
            print(f'  {kind:>8} n {cnt:4}  max {mx:6.1f}  total {tot:7.0f} ms  {src[:90]}')
    print(f'\nworst {hitches} frame intervals (ms) = previous frame\'s wait + loop (its sections) + outside')
    order = sorted((i for i in range(n) if iv[i] is not None), key=lambda i: -iv[i])[:hitches]
    for i in sorted(order):
        split = ' '.join(f'{c} {f["prev_" + c][i]:.0f}' for c in SECTIONS if f['prev_' + c][i] is not None and f['prev_' + c][i] >= 1)
        extra = ' '.join(f'{c} {f[c][i]:.0f}' for c in ('tasks', 'monsters', 'charParts', 'spots', 'points', 'shadowMaps', 'uploads') if c in f and f[c][i] is not None)
        t1 = f['t'][i]
        names = con.execute('SELECT kind, ms, src FROM tasks WHERE trace = ? AND t BETWEEN ? AND ?', (tid, t1 - iv[i] - 1, t1 + 1)).fetchall()
        if names:
            extra += ' | ' + '; '.join(f'{k} {ms:.0f} {src[:50]}' for k, ms, src in names[:3])
        print(f'  t {f["t"][i] / 1000:8.2f}s  {iv[i]:6.1f} = wait {num(f["prev_wait"][i]):4.0f} + loop {num(f["prev_loop"][i]):4.0f} + out {f["outside"][i]:5.0f} | {split} | '
              f'calls {fmt(num(f["calls"][i]))} tris {num(f["triangles"][i]) / 1e6:.1f}M speed {fmt(num(f["speed"][i]))} {extra}')


def gc_report(path: str, bucket: float, min_heap: float) -> None:
    """Firefox MOZ_GCTIMER log (perf-bench --ff-gc): GCs of the game's process per time bucket."""
    import re
    txt = open(path, errors='replace').read()
    rows: dict[int, list[float]] = {}
    for b in re.split(r'\n(?=GC\(T\+)', txt):
        m = re.match(r'GC\(T\+([\d.]+)s\)', b)
        if not m:
            continue
        heap = float((re.search(r'HeapSize: ([\d.]+)', b) or [0, 0])[1])
        # every Firefox process writes to the same stderr: the game's is the one with the big heap
        if heap < min_heap:
            continue
        k = int(float(m[1]) // bucket)
        r = rows.setdefault(k, [0, 0.0, 0.0, 0, 0.0, 0.0])
        r[0] += 1
        r[1] += float((re.search(r'Total Time: ([\d.]+)', b) or [0, 0])[1])
        r[2] = max(r[2], float((re.search(r'Max Pause: ([\d.]+)', b) or [0, 0])[1]))
        r[3] += sum(1 for x in re.findall(r'Pause: ([\d.]+)ms', b) if float(x) > 50)
        r[4] = max(r[4], heap)
        r[5] = max([r[5]] + [float(x) for x in re.findall(r'Trigger: ([\d.]+) MiB of [\d.]+ MiB threshold', b)])
    if not rows:
        raise SystemExit(f'{path}: no GC with a heap over {min_heap} MiB (is it a MOZ_GCTIMER log?)')
    print(f'{"time (s)":>13} {"GCs":>4} {"total ms":>9} {"max pause":>9} {"slices>50ms":>11} {"gc heap MiB":>11} {"malloc MiB":>10}')
    for k in sorted(rows):
        n, tot, mx, long, heap, mal = rows[k]
        print(f'{k * bucket:6.0f}-{(k + 1) * bucket:<6.0f} {n:4} {tot:9.0f} {mx:9.1f} {long:11} {heap:11.0f} {mal:10.0f}  {bar(mx, 200)}')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('ingest', help='parse dumps into the sqlite db (replaces traces of the same name)')
    a.add_argument('paths', nargs='+')
    a.add_argument('--db', default=DEFAULT_DB)
    a.add_argument('--dry-run', action='store_true', help='parse and validate, write nothing')
    r = sub.add_parser('report', help='summarise every trace; with --trace, one trace in detail')
    r.add_argument('--db', default=DEFAULT_DB)
    r.add_argument('--trace', help='substring of the trace file name')
    r.add_argument('--hitches', type=int, default=15, help='worst frames to list (single trace)')
    g = sub.add_parser('gc', help='summarise a Firefox MOZ_GCTIMER log (perf-bench --ff-gc) over time')
    g.add_argument('log')
    g.add_argument('--bucket', type=float, default=150, help='seconds per row (default 150)')
    g.add_argument('--min-heap', type=float, default=60, help='MiB: smaller heaps are other processes (default 60)')
    args = ap.parse_args()
    if args.cmd == 'ingest':
        paths = [p for x in args.paths for p in (glob.glob(os.path.expanduser(x)) or [x])]
        ingest(paths, args.db, args.dry_run)
    elif args.cmd == 'gc':
        gc_report(args.log, args.bucket, args.min_heap)
    else:
        report(args.db, args.trace, args.hitches)


if __name__ == '__main__':
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)

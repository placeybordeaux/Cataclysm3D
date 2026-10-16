#!/usr/bin/env python3
"""Where chunks first appear relative to the player (docs/FAR_LOD.md).

Reads telemetry dumps (tools/perf-bench.ts --save, or Shift+F3 in game) and bins every chunk's
first build by its nearest-edge distance from the player at that moment and by level, plus how
long upper storeys trailed their column's ground level. A chunk first shown well inside the fog
is a pop the player could see; one shown at the draw-distance edge is the skyline hand-off.

  python3 tools/pop-report.py shots/farlod-before/city40.json shots/farlod-before/citywalk.json
"""
import argparse
import bisect
import collections
import json
import math

CHUNK = 24


def report(path: str, skip_ms: float, bins: int) -> None:
    d = json.load(open(path))
    fr = d['frames']
    t, px, py = fr['t'], fr['px'], fr['py']
    if not t:
        raise SystemExit(f'{path}: no frames')
    fog_far = max(2, d['meta']['radius'] - 1) * CHUNK

    def pos(tt: float) -> tuple[float, float]:
        i = min(max(bisect.bisect_left(t, tt), 0), len(t) - 1)
        return px[i], py[i]

    shown: dict[tuple[int, int, int], tuple[float, float]] = {}
    for e in d['events']:
        key = (e['cx'], e['cy'], e['z'])
        if e['k'] != 'built' or key in shown:
            continue
        x, y = pos(e['t'])
        nx = min(max(x, e['cx'] * CHUNK), e['cx'] * CHUNK + CHUNK)
        ny = min(max(y, e['cy'] * CHUNK), e['cy'] * CHUNK + CHUNK)
        shown[key] = (e['t'], math.hypot(nx - x, ny - y))

    # the start area streams in before the run proper; it is not pop-in
    run = {k: v for k, v in shown.items() if v[0] > t[0] + skip_ms}
    level = lambda z: 'z0' if z == 0 else ('above' if z > 0 else 'below')
    hist = collections.Counter((min(int(dist // CHUNK), bins - 1), level(k[2])) for k, (_, dist) in run.items())
    moved = math.hypot(px[-1] - px[0], py[-1] - py[0])
    print(f'\n{path}: {len(run)} chunks first shown during the run ({len(shown)} in all), moved {moved:.0f} m, draw-distance fade ends at {fog_far} m')
    print('  nearest edge     z0  above  below')
    for b in range(bins):
        last = '+' if b == bins - 1 else ''
        print(f'  {b * CHUNK:4d}-{b * CHUNK + CHUNK:<4d}{last:1s} m {hist[(b, "z0")]:5d} {hist[(b, "above")]:6d} {hist[(b, "below")]:6d}')
    lag = sorted((tt - shown[(cx, cy, 0)][0], dist) for (cx, cy, z), (tt, dist) in run.items() if z > 0 and (cx, cy, 0) in shown)
    if lag:
        p = lambda q: lag[min(len(lag) - 1, int(len(lag) * q))][0]
        print(f'  upper storeys after their ground level: {len(lag)}, p50 {p(0.5):.0f} ms, p90 {p(0.9):.0f} ms, max {lag[-1][0]:.0f} ms')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('dumps', nargs='+', help='telemetry dump JSON files')
    ap.add_argument('--skip-ms', type=float, default=2000, help='ignore builds this soon after the first frame (default 2000)')
    ap.add_argument('--bins', type=int, default=10, help='distance bins of 24 m (default 10)')
    a = ap.parse_args()
    for path in a.dumps:
        report(path, a.skip_ms, a.bins)


if __name__ == '__main__':
    main()

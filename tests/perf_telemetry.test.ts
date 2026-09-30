import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telemetry, FrameRing, type TelemetrySource } from '../src/perf/telemetry';
import { ringToFrames, summarize } from '../src/perf/analyze';
import type { ChunkEntryView } from '../src/render/chunkManager';
import { CHUNK } from '../src/world/coords';

// Performance telemetry (docs/PERF.md): the rolling buffer, the streaming-health scan (holes
// in view, runway ahead of the player) and the dump analysis.

let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

/** A world of chunk entries around the origin; `unbuilt(cx, cy)` marks holes. */
function source(player: { x: number; y: number; z: number }, unbuilt: (cx: number, cy: number) => boolean): TelemetrySource {
  const R = 4;
  const entries: ChunkEntryView[] = [];
  const refresh = () => {
    entries.length = 0;
    const pcx = Math.floor(player.x / CHUNK), pcy = Math.floor(player.y / CHUNK);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) for (const z of [0, 1])
      entries.push({ cx: pcx + dx, cy: pcy + dy, z, shown: !unbuilt(pcx + dx, pcy + dy), wantT: 0, visible: true, job: null });
  };
  return {
    player: () => (refresh(), player),
    view: () => ({ fx: 1, fy: 0, hfov: Math.PI / 2 }),
    chunks: {
      radius: R, levelsBelow: 0, levelsAbove: 1, visibleDist: 60, budgetMs: 4, effBudgetMs: 4,
      levels: { radiusAt: (_cx: number, _cy: number, z: number, pz: number) => (z >= pz && z <= pz + 1 ? R : -1), span: (pz: number): [number, number] => [pz, pz + 1] },
      stats: { entries: 0, pending: 0, builtThisFrame: 0, meshMs: 0, treeMs: 0, frameCreateMs: 0, frameMs: 0, builds: 0 },
      forEachEntry: (fn) => entries.forEach(fn),
    },
    fogFar: () => 72,
  };
}

describe('FrameRing', () => {
  it('keeps the newest frames in order when it wraps', () => {
    const r = new FrameRing(4);
    for (let i = 0; i < 6; i++) {
      r.t[r.n % r.cap] = i;
      r.cols.work[r.n % r.cap] = i * 10;
      r.n++;
    }
    expect(r.size).toBe(4);
    const f = ringToFrames(r);
    expect(f.t).toEqual([2, 3, 4, 5]);
    expect(f.work).toEqual([20, 30, 40, 50]);
  });
});

describe('Telemetry', () => {
  it('measures speed, runway to the first unbuilt chunk ahead, and holes in view', () => {
    const p = { x: 12, y: 12, z: 0 };
    // everything east of chunk 2 is unbuilt: the first hole ahead starts at x = 72
    const tel = new Telemetry(source(p, (cx) => cx >= 3), { frames: 600 });
    for (let i = 0; i < 120; i++) {
      now = i * (1000 / 60);
      tel.sample(10, now, 8, { game: 1, chunks: 3, draw: 2 });
      p.x += 20 / 60; // 20 m/s east
    }
    const f = ringToFrames(tel.ring);
    const last = f.t.length - 1;
    expect(f.speed![last]).toBeCloseTo(20, 0);
    // player near x = 51: 72 - 51 = ~21 m of runway, ~1 s at 20 m/s (scan every 100 ms: held values)
    expect(f.runwayM![last]!).toBeGreaterThan(12);
    expect(f.runwayM![last]!).toBeLessThan(27);
    expect(f.runwayS![last]!).toBeCloseTo(f.runwayM![last]! / 20, 0);
    // chunks east are in view (camera looks east) and inside the visible range
    expect(f.holesVis![last]!).toBeGreaterThan(0);
    expect(f.sim![last]).toBe(1);
    expect(f.chunkBuild![last]).toBe(3);
  });

  it('counts nothing when everything is built, and summarize() reports no findings', () => {
    const p = { x: 12, y: 12, z: 0 };
    const tel = new Telemetry(source(p, () => false), { frames: 600 });
    for (let i = 0; i < 90; i++) {
      now = i * (1000 / 60);
      tel.sample(10, now, 8, { game: 1 });
      p.x += 10 / 60;
    }
    const s = summarize({ version: 1, meta: {}, frames: ringToFrames(tel.ring), events: tel.eventList() });
    expect(s.stream.holeSeconds).toBe(0);
    expect(s.stream.runwayMin).toBeGreaterThan(8);
    expect(s.findings.some((x) => /Unbuilt/.test(x))).toBe(false);
  });

  it('records chunk events and turns them into build latency and mapgen totals', () => {
    const tel = new Telemetry(source({ x: 0, y: 0, z: 0 }, () => false));
    now = 100;
    tel.want(1, 0, 0);
    tel.generated(1, 0, 0, 3.5, false, 'house_01_north');
    tel.generated(2, 0, 0, 1.5, true, 'house_01_east');
    now = 600;
    tel.built(1, 0, 0, true, 6, 400, 'full', 500);
    tel.built(1, 0, 0, false, 5, 30, 'full', 520);
    now = 700;
    tel.sample(10, 700, 8, {});
    const d = { version: 1 as const, meta: {}, frames: ringToFrames(tel.ring), events: tel.eventList() };
    const s = summarize(d);
    expect(s.stream.builds).toBe(1);
    expect(s.stream.rebuilds).toBe(1);
    expect(s.stream.buildWait.p50).toBe(500);
    expect(s.mapgen.syncN).toBe(1);
    expect(s.mapgen.preN).toBe(1);
    expect(s.mapgen.slowest[0]).toMatchObject({ omt: 'house_01', n: 2 });
  });

  it('is a no-op when recording is off', () => {
    const tel = new Telemetry(source({ x: 0, y: 0, z: 0 }, () => false));
    tel.recording = false;
    tel.sample(10, 16, 8, {});
    tel.want(0, 0, 0);
    expect(tel.ring.size).toBe(0);
    expect(tel.events.length).toBe(0);
  });
});

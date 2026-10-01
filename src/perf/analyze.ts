import { CHANNELS, type Channel, type FrameRing, type PerfEvent } from './telemetry';

// Pure analysis of a telemetry dump: shared by the overlay's summary line, `cdda.perf.summary()`,
// tools/perf-report.ts (a dump file from a player) and tools/perf-bench.ts (budgets). Node-safe.

export interface PerfDump {
  version: 1;
  meta: Record<string, unknown>;
  /** per-frame columns, oldest first; `t` = ms since the telemetry started */
  frames: { t: number[] } & Partial<Record<Channel, (number | null)[]>>;
  events: PerfEvent[];
}

/** Columns oldest-first from the ring (last `seconds` only when given). */
export function ringToFrames(ring: FrameRing, seconds?: number): PerfDump['frames'] {
  const n = ring.size;
  let start = 0;
  if (seconds !== undefined && n) {
    const tEnd = ring.t[ring.back(0)];
    while (start < n && ring.t[ring.back(n - 1 - start)] < tEnd - seconds * 1000) start++;
  }
  const idx: number[] = [];
  for (let i = n - 1 - start; i >= 0; i--) idx.push(ring.back(i));
  const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  const frames = { t: idx.map((i) => r2(ring.t[i]) ?? 0) } as PerfDump['frames'];
  for (const c of CHANNELS) frames[c] = idx.map((i) => r2(ring.cols[c][i]));
  return frames;
}

export function quantiles(xs: number[]): { n: number; p50: number; p95: number; p99: number; max: number; mean: number } {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s.length ? s[s.length - 1] : NaN), mean: r(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)) };
}

const col = (d: PerfDump, c: Channel): number[] => (d.frames[c] ?? []).map((v) => (v === null || v === undefined ? NaN : v));

export interface PerfSummary {
  seconds: number;
  frames: number;
  interval: ReturnType<typeof quantiles>;
  loop: ReturnType<typeof quantiles>;
  /** frames that missed a refresh: interval > 1.5x the median (a dropped vsync at any refresh rate) */
  missed: number;
  hitches33: number;
  hitches50: number;
  /** mean ms per frame by section */
  sections: Record<string, number>;
  speed: { mean: number; max: number; movingSeconds: number };
  stream: {
    /** seconds with at least one unbuilt chunk inside the clearly visible range in view */
    holeSeconds: number;
    /** longest continuous such stretch (s) */
    maxHoleSeconds: number;
    /** seconds with a hole in view inside the fog range (less visible) */
    fogHoleSeconds: number;
    /** runway (s of travel before the first unbuilt chunk) while moving > 4 m/s: min, p10, share of time under 2 s */
    runwayMin: number;
    runwayP10: number;
    runwayUnder2: number;
    /** wanted -> shown latency of first builds (ms) */
    buildWait: ReturnType<typeof quantiles>;
    builds: number;
    rebuilds: number;
    treeSwaps: number;
    /** entries dropped before they were ever shown (wanted, then out of range: wasted work) */
    droppedUnshown: number;
    oldestMax: number;
  };
  mapgen: {
    syncN: number;
    syncMs: number;
    preN: number;
    preMs: number;
    hooksMs: number;
    maxMs: number;
    slowest: { omt: string; n: number; mean: number; max: number; total: number }[];
  };
  /** longest single mesher/tree stretch visible in the event log (ms) */
  worstFrames: { t: number; interval: number; split: Record<string, number>; gens: string[]; builds: number; compiled: number }[];
  /** shader programs compiled during the window (each one a stall: ~0.1-1 s in Firefox) */
  compiles: number;
  findings: string[];
}

const SECTIONS: Channel[] = ['sim', 'chunkCreate', 'chunkSig', 'chunkBuild', 'grass', 'skyline', 'decor', 'sprites', 'beforeRender', 'lightmap', 'scene', 'draw', 'other', 'wait'];

export function summarize(d: PerfDump): PerfSummary {
  const t = d.frames.t;
  const n = t.length;
  const iv = col(d, 'interval');
  const loop = col(d, 'loop');
  const speed = col(d, 'speed');
  const holesVis = col(d, 'holesVis');
  const holesFog = col(d, 'holesFog');
  const runwayS = col(d, 'runwayS');
  const dtOf = (i: number) => (Number.isFinite(iv[i]) ? Math.min(iv[i], 250) / 1000 : 0);
  const sections: Record<string, number> = {};
  for (const c of [...SECTIONS, 'mesh', 'trees', 'genSync', 'genHooks', 'kModels', 'kSurfaces', 'kDressing', 'kRooms', 'gpu'] as Channel[]) {
    const xs = col(d, c).filter(Number.isFinite);
    if (xs.length) sections[c] = Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, n)) * 100) / 100;
  }
  let holeS = 0, fogHoleS = 0, run = 0, maxRun = 0, moving = 0;
  const runways: number[] = [];
  for (let i = 0; i < n; i++) {
    const dt = dtOf(i);
    if (holesVis[i] > 0) {
      holeS += dt;
      run += dt;
      maxRun = Math.max(maxRun, run);
    } else run = 0;
    if (holesFog[i] > 0) fogHoleS += dt;
    if (speed[i] > 4) {
      moving += dt;
      if (Number.isFinite(runwayS[i])) runways.push(runwayS[i]);
    }
  }
  runways.sort((a, b) => a - b);
  const ev = d.events;
  const builtWaits = ev.filter((e) => e.k === 'built').map((e) => e.wait ?? NaN);
  const gens = ev.filter((e) => e.k === 'gen');
  const byOmt = new Map<string, number[]>();
  for (const g of gens) {
    const k = (g.omt ?? '?').replace(/_(north|south|east|west)$/, '');
    let l = byOmt.get(k);
    if (!l) byOmt.set(k, (l = []));
    l.push(g.ms ?? 0);
  }
  const slowest = [...byOmt.entries()].map(([omt, xs]) => ({ omt, n: xs.length, mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), max: +Math.max(...xs).toFixed(1), total: +xs.reduce((a, b) => a + b, 0).toFixed(1) }))
    .sort((a, b) => b.total - a.total).slice(0, 10);
  // the worst frames and what happened during them
  const order = [...iv.keys()].filter((i) => Number.isFinite(iv[i])).sort((a, b) => iv[b] - iv[a]).slice(0, 10);
  const worstFrames = order.map((i) => {
    const split: Record<string, number> = {};
    for (const c of [...SECTIONS, 'mesh', 'trees', 'genSync', 'gpu'] as Channel[]) {
      const v = col(d, c)[i];
      if (Number.isFinite(v) && v >= 0.5) split[c] = Math.round(v * 10) / 10;
    }
    const t1 = t[i], t0 = t1 - iv[i];
    const inFrame = ev.filter((e) => e.t >= t0 && e.t <= t1 + 1);
    const pr = col(d, 'programs');
    return {
      t: Math.round(t1), interval: Math.round(iv[i] * 10) / 10, split, compiled: i > 0 && pr[i] > pr[i - 1] ? pr[i] - pr[i - 1] : 0,
      gens: inFrame.filter((e) => e.k === 'gen').map((e) => `${e.omt ?? '?'}${e.pre ? ' (prefetch)' : ''} ${e.ms}ms`),
      builds: inFrame.filter((e) => e.k === 'built' || e.k === 'rebuild').length,
    };
  });
  const sum = (c: Channel) => col(d, c).filter(Number.isFinite).reduce((a, b) => a + b, 0);
  const seconds = n > 1 ? (t[n - 1] - t[0]) / 1000 : 0;
  const s: PerfSummary = {
    seconds: Math.round(seconds * 10) / 10,
    frames: n,
    interval: quantiles(iv),
    loop: quantiles(loop),
    missed: 0,
    hitches33: iv.filter((v) => v > 33.4).length,
    hitches50: iv.filter((v) => v > 50).length,
    sections,
    speed: { mean: +(speed.filter((v) => v > 4).reduce((a, b) => a + b, 0) / Math.max(1, speed.filter((v) => v > 4).length)).toFixed(1), max: +Math.max(0, ...speed.filter(Number.isFinite)).toFixed(1), movingSeconds: +moving.toFixed(1) },
    stream: {
      holeSeconds: +holeS.toFixed(2),
      maxHoleSeconds: +maxRun.toFixed(2),
      fogHoleSeconds: +fogHoleS.toFixed(2),
      runwayMin: runways.length ? +runways[0].toFixed(2) : NaN,
      runwayP10: runways.length ? +runways[Math.floor(runways.length * 0.1)].toFixed(2) : NaN,
      runwayUnder2: runways.length ? +(runways.filter((r) => r < 2).length / runways.length).toFixed(3) : NaN,
      buildWait: quantiles(builtWaits),
      builds: builtWaits.length,
      rebuilds: ev.filter((e) => e.k === 'rebuild').length,
      treeSwaps: ev.filter((e) => e.k === 'trees').length,
      droppedUnshown: ev.filter((e) => e.k === 'drop' && !e.shown).length,
      oldestMax: Math.round(Math.max(0, ...col(d, 'oldestMs').filter(Number.isFinite))),
    },
    mapgen: {
      syncN: Math.round(sum('genSyncN')), syncMs: Math.round(sum('genSync')),
      preN: Math.round(sum('genPreN')), preMs: Math.round(sum('genPre')),
      hooksMs: Math.round(sum('genHooks')),
      maxMs: +Math.max(0, ...gens.map((g) => g.ms ?? 0)).toFixed(1),
      slowest,
    },
    worstFrames,
    compiles: (() => {
      const pr = col(d, 'programs');
      let n = 0;
      for (let i = 1; i < pr.length; i++) if (pr[i] > pr[i - 1]) n += pr[i] - pr[i - 1];
      return n;
    })(),
    findings: [],
  };
  s.missed = iv.filter((v) => v > 1.5 * s.interval.p50).length;
  s.findings = findings(s);
  return s;
}

/** Plain-language reading of a summary: where the time and the lag went. */
function findings(s: PerfSummary): string[] {
  const f: string[] = [];
  const st = s.stream, mg = s.mapgen;
  if (st.holeSeconds > 0.2) f.push(`Unbuilt chunks were in clear view for ${st.holeSeconds} s (longest ${st.maxHoleSeconds} s): streaming fell behind.`);
  if (Number.isFinite(st.runwayMin) && st.runwayMin < 2) f.push(`Runway dropped to ${st.runwayMin} s ahead of the player (under 2 s ${Math.round(st.runwayUnder2 * 100)}% of moving time).`);
  const total = mg.syncMs + mg.preMs;
  if (mg.syncN > 0 && s.seconds > 0) f.push(`Mapgen: ${mg.syncN} chunks generated inside frames (${mg.syncMs} ms, ${(mg.syncMs / s.seconds).toFixed(1)} ms/s), ${mg.preN} in idle time (${mg.preMs} ms).${total > 0 && mg.syncMs / total > 0.5 ? ' Prefetch is not keeping up.' : ''}`);
  if (st.rebuilds > st.builds && st.builds > 0) f.push(`${st.rebuilds} rebuilds vs ${st.builds} first builds: chunks are meshed more than once (LOD ring flips, neighbour changes).`);
  if (st.droppedUnshown > 5) f.push(`${st.droppedUnshown} chunks were dropped before they were ever shown (wanted then left behind).`);
  const sec = s.sections;
  const top = Object.entries(sec).filter(([k]) => !['mesh', 'trees', 'genSync', 'genHooks', 'kModels', 'kSurfaces', 'kDressing', 'kRooms', 'gpu', 'wait'].includes(k)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) f.push(`Main loop per frame: ${top.map(([k, v]) => `${k} ${v} ms`).join(', ')}.`);
  if (s.missed > s.frames * 0.05) f.push(`${s.missed} of ${s.frames} frames missed a refresh (over 1.5x the median ${s.interval.p50} ms).`);
  if (s.compiles > 0) f.push(`${s.compiles} shader programs compiled during the window (each stalls a frame; see worst frames).`);
  if (s.hitches50 > 0) f.push(`${s.hitches50} frames over 50 ms, ${s.hitches33} over 33 ms (worst ${s.interval.max} ms).`);
  if (!f.length) f.push('No streaming or frame-time problems in this window.');
  return f;
}

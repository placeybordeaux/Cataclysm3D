import type { DebugApi } from './debug';
import type { Game } from './game/game';
import { CHUNK } from './world/coords';

// Frame-time instrumentation + a reproducible "run through town" benchmark, so hitch fixes
// (chunk generation, meshing) can be measured before/after with tools/drive.ts --gpu.
//
//   await cdda.benchRun({ seconds: 40, speed: 7 })  -> { p50, p95, p99, max, over33, ... }
//
// The run moves the player in a straight line at `speed` tiles/s ignoring collision (a
// "ghost sprint"), so every run crosses the same chunks regardless of what's in the way;
// the rest of the game (monsters, lights, meshing) runs normally.

export class FrameStats {
  /** main-loop work per frame (game.frame + renderer.render), ms */
  work: number[] = [];
  /** requestAnimationFrame intervals, ms */
  interval: number[] = [];
  /** our own callback only (begin() to frame()), ms: `work` also counts the delay between
   *  the rAF timestamp and the callback, which is other tasks' time */
  loop: number[] = [];
  private beginT = 0;
  recording = false;
  /** Frames over `slowMs` of work with their per-section split (who caused the hitch). */
  slow: { ms: number; sec: Record<string, number> }[] = [];
  slowMs = 16;
  /** Cumulative per-section ms while recording (where the average frame goes). */
  totals: Record<string, number> = {};
  private last = 0;
  private sec: Record<string, number> = {};
  private lapT = 0;
  /** Start timing sections of a frame (called at the top of the main loop). */
  begin(rafNow?: number): void {
    this.lapT = this.beginT = performance.now();
    // time between the frame's rAF timestamp and our callback: other tasks (idle-time
    // mapgen, GC, input) that ran first and delayed this frame
    this.sec = rafNow !== undefined ? { wait: this.lapT - rafNow } : {};
  }
  /** Charge the time since the previous lap/begin to `name`. Cheap enough to leave on. */
  lap(name: string): void {
    const t = performance.now();
    this.sec[name] = (this.sec[name] ?? 0) + (t - this.lapT);
    this.lapT = t;
  }
  frame(workMs: number, now: number): void {
    if (this.recording) {
      this.work.push(workMs);
      if (this.beginT) this.loop.push(performance.now() - this.beginT);
      if (this.last) this.interval.push(now - this.last);
      for (const [k, v] of Object.entries(this.sec)) this.totals[k] = (this.totals[k] ?? 0) + v;
      if (workMs > this.slowMs && this.slow.length < 400) {
        const sec: Record<string, number> = {};
        for (const [k, v] of Object.entries(this.sec)) if (v >= 0.5) sec[k] = +v.toFixed(1);
        this.slow.push({ ms: +workMs.toFixed(1), sec });
      }
    }
    this.last = now;
  }
  reset(): void {
    this.work = [];
    this.interval = [];
    this.loop = [];
    this.slow = [];
    this.totals = {};
    this.last = 0;
  }
}

export const frameStats = new FrameStats();

export function summarize(ms: number[]): Record<string, number> {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(1);
  return {
    frames: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +(s[s.length - 1] ?? 0).toFixed(1),
    over33: s.filter((v) => v > 33).length, over50: s.filter((v) => v > 50).length,
    mean: +(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)).toFixed(2),
  };
}

export function installPerfDebug(api: DebugApi, game: Game, cities?: () => { x: number; y: number; name: string }[]): void {
  api.frameStats = frameStats;
  /**
   * Ghost-sprint `seconds` long at `speed` tiles/s toward `yawDeg` (default: the nearest
   * city centre) from the current position; returns frame-time percentiles.
   */
  api.benchRun = async (o: { seconds?: number; speed?: number; yawDeg?: number } = {}) => {
    const seconds = o.seconds ?? 40, speed = o.speed ?? 7;
    const p = game.player;
    let yaw: number;
    if (o.yawDeg !== undefined) yaw = (o.yawDeg * Math.PI) / 180;
    else {
      const px = p.x / CHUNK, py = p.y / CHUNK;
      const c = (cities?.() ?? []).sort((a, b) => Math.hypot(a.x - px, a.y - py) - Math.hypot(b.x - px, b.y - py))[0];
      yaw = c ? Math.atan2(c.x - px, -(c.y - py)) : 0;
    }
    p.yaw = yaw;
    p.pitch = 0;
    const heal = () => {
      for (const part of Object.values(p.hp)) part.cur = part.max;
      p.stamina = p.staminaMax();
    };
    const sys = {
      name: 'benchRun',
      update: (_g: Game, dt: number) => {
        p.x += Math.sin(yaw) * speed * dt;
        p.y += -Math.cos(yaw) * speed * dt;
        heal();
      },
    };
    game.systems.push(sys);
    frameStats.reset();
    frameStats.recording = true;
    const pf = api.prefetch?.stats;
    if (pf) Object.assign(pf, { prefetched: 0, sync: 0, maxMs: 0 });
    const x0 = p.x, y0 = p.y;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    frameStats.recording = false;
    game.systems.splice(game.systems.indexOf(sys), 1);
    const n = Math.max(1, frameStats.work.length);
    return {
      work: summarize(frameStats.work),
      loop: summarize(frameStats.loop),
      // mean ms/frame per section, and the slowest frames' splits
      sections: Object.fromEntries(Object.entries(frameStats.totals).map(([k, v]) => [k, +(v / n).toFixed(2)])),
      slowest: [...frameStats.slow].sort((a, b) => b.ms - a.ms).slice(0, 12),
      interval: summarize(frameStats.interval),
      tiles: Math.round(Math.hypot(p.x - x0, p.y - y0)),
      prefetch: pf ? { ...pf, maxMs: +pf.maxMs.toFixed(1) } : undefined,
    };
  };
}

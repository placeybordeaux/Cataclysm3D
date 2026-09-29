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
  recording = false;
  private last = 0;
  frame(workMs: number, now: number): void {
    if (this.recording) {
      this.work.push(workMs);
      if (this.last) this.interval.push(now - this.last);
    }
    this.last = now;
  }
  reset(): void {
    this.work = [];
    this.interval = [];
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
    return {
      work: summarize(frameStats.work),
      interval: summarize(frameStats.interval),
      tiles: Math.round(Math.hypot(p.x - x0, p.y - y0)),
      prefetch: pf ? { ...pf, maxMs: +pf.maxMs.toFixed(1) } : undefined,
    };
  };
}

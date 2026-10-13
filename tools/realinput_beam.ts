// Headlight beam flicker on buildings (beamMode.ts). At night a car's light on walls popped
// lit and dark as it drove past: the light map's beam stand-ins cast from whole tiles.
//
// `cdda.*` sets the scene only: midnight, the player on foot beside a north-south road, a
// building front (wall rows) along and across the road ahead, a lit car whose body is hidden
// (so only its light changes on screen). The car is stepped 0.2 m at a time and each step is
// photographed, in each beam mode. Light that follows the car continuously changes about
// linearly per step; a pop is a spike in the per-pixel second difference
// |I(k+1) - 2 I(k) + I(k-1)| summed over the frame. Shots go to shots/beam/.
// Plugged into tools/realinput.ts (--only beamflicker).

import type { Page } from 'puppeteer-core';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { XInput } from './lib/realinput';

export interface BeamCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

const OUT = 'shots/beam';
const STEPS = 40;
const STEP_M = 0.2;

export function beamScenarios(c: BeamCtx): Scenario[] {
  const { js, check, sleep } = c;
  const luma = async (): Promise<{ png: PNG; bytes: Uint8Array; l: Float32Array }> => {
    const bytes = await c.page().screenshot({ type: 'png' });
    const png = PNG.sync.read(Buffer.from(bytes));
    const l = new Float32Array(png.width * png.height);
    for (let i = 0; i < l.length; i++) l[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
    return { png, bytes, l };
  };
  return [
    ['beamflicker', "a car's headlight light on walls follows it smoothly (no tile pops) in the default beam mode", async () => {
      await c.toGameplay();
      const setup = await js<{ x: number; y: number } | null>(`(() => {
        const vs = cdda.vehicleSystem;
        const r = cdda.roadTrip('car'); if (!r) return null;
        const v = vs.driving;
        vs.releaseControls();
        for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 60) vs.remove(o);
        cdda.clearMonsters(80);
        cdda.setHour(0);
        cdda.renderer.timeScale = 0;
        v.addFuel('battery', 1e9);
        v.lightsOn = true;
        const m = cdda.game.map, z = v.z, x0 = Math.floor(v.x), y0 = Math.floor(v.y);
        // a building front 4 m west of the car's lane and a wall across the road 26 m ahead
        for (let y = y0 - 30; y <= y0 + 4; y++) m.setTer(x0 - 5, y, z, 't_wall');
        for (let x = x0 - 5; x <= x0 + 6; x++) m.setTer(x, y0 - 26, z, 't_wall');
        // stand east of the road, behind the car, looking up the road at both walls
        const p = cdda.game.player;
        // yaw as cdda.gotoVehicle: atan2(dx, -dy) toward (x0 - 3, y0 - 14)
        Object.assign(p, { x: x0 + 4.5, y: y0 + 6.5, yaw: Math.atan2(-7.5, 20.5), pitch: -0.12 });
        // rain streaks move every frame and would swamp the measure
        cdda.setWeather('clear');
        window.__beamCar = v.uid;
        return { x: v.x, y: v.y };
      })()`);
      if (!check('a lit car on a road at midnight with walls ahead', !!setup, setup)) return;
      await sleep(2500);
      const place = (k: number) => js<boolean>(`(async () => {
        const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === window.__beamCar);
        v.x = ${setup!.x}; v.y = ${setup!.y} - ${k * STEP_M};
        v.markTick?.();
        const e = cdda.renderer.vehicleView.entries?.get(v);
        if (e) e.lean.visible = false;
        for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
        return !!e;
      })()`);
      mkdirSync(resolve(OUT), { recursive: true });
      const results: Record<string, { mean: number; p90: number; max: number; spikes: number }> = {};
      for (const mode of ['tile', 'smooth', 'spot']) {
        await js(`cdda.setBeam('${mode}')`);
        await place(0);
        await sleep(400);
        const frames: Float32Array[] = [];
        let w = 0, h = 0;
        for (let k = 0; k <= STEPS; k++) {
          const hidden = await place(k);
          if (k === 0 && !check(`${mode}: car body hidden`, hidden)) return;
          const f = await luma();
          w = f.png.width; h = f.png.height;
          frames.push(f.l);
          if (k === 0 || k === STEPS / 2) writeFileSync(resolve(OUT, `${mode}_${String(k).padStart(2, '0')}.png`), f.bytes);
        }
        // rows 40..h-60: skip the HUD strips
        const jerk: number[] = [];
        for (let k = 1; k < STEPS; k++) {
          let sum = 0;
          for (let y = 40; y < h - 60; y++)
            for (let x = 0; x < w; x++) {
              const i = y * w + x;
              sum += Math.abs(frames[k + 1][i] - 2 * frames[k][i] + frames[k - 1][i]);
            }
          jerk.push(sum / ((h - 100) * w));
        }
        const sorted = [...jerk].sort((a, b) => a - b);
        const mean = jerk.reduce((a, b) => a + b, 0) / jerk.length;
        const med = sorted[Math.floor(sorted.length / 2)];
        results[mode] = {
          mean: +mean.toFixed(4), p90: +sorted[Math.floor(sorted.length * 0.9)].toFixed(4), max: +sorted[sorted.length - 1].toFixed(4),
          spikes: jerk.filter((j) => j > 3 * med + 0.01).length,
        };
        writeFileSync(resolve(OUT, `${mode}_jerk.json`), JSON.stringify(jerk.map((j) => +j.toFixed(4))));
        console.log(`    beam ${mode}:`, JSON.stringify(results[mode]));
      }
      check('tile mode shows the pops this fixes (a sanity check of the measure)', results.tile.max > 2 * results.spot.max, results);
      // the spot-only beam still changes a little per step (its dithered pool drifts), and so
      // does smooth's light-map glow; a pop is a frame far above the run's median
      check('smooth: no pop frames', results.smooth.spikes === 0, results);
      check('smooth: well under the tile pops', results.smooth.max < 0.5 * results.tile.max, results);
      await js(`(() => {
        const vs = cdda.vehicleSystem, v = vs.list.find((q) => q.uid === window.__beamCar);
        if (v) vs.remove(v);
        cdda.setBeam('smooth');
        cdda.renderer.timeScale = 1;
      })()`);
    }],
  ];
}

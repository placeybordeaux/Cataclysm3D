// Far LOD hand-off (docs/FAR_LOD.md, src/render/farLod.ts): what the player sees when chunks
// arrive at the draw-distance edge, per mode, with the camera still.
//
// `cdda.*` sets the scene only: the perf benchmark's city road (seed 1), the car at its start
// facing into town, noon, clear. Then per mode: let it settle, drop every chunk beyond 60 m
// (cdda.restreamEdge: they are wanted again at once and stream back in exactly as when you
// reach the edge) and photograph the view for a few seconds. Score: how abrupt the change is,
// the largest single-step image change as a share of the whole change (a pop puts nearly all of
// it in one step; a dissolve spreads it). Then a real-input drive (W) into town in the default
// mode, for screenshots. Shots and strips go to shots/farlod/. Plugged into tools/realinput.ts
// (--only farlod).

import type { Page } from 'puppeteer-core';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { XInput } from './lib/realinput';
import { PERF_PAGE } from './lib/perfRoutes';

export interface FarLodCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

const OUT = 'shots/farlod';
const SHOTS = 36;

export function farLodScenarios(c: FarLodCtx): Scenario[] {
  const { js, check, sleep } = c;
  const grab = async (): Promise<{ png: PNG; bytes: Uint8Array }> => {
    const bytes = await c.page().screenshot({ type: 'png' });
    return { png: PNG.sync.read(Buffer.from(bytes)), bytes };
  };
  const settled = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js<boolean>(`cdda.renderer.chunks.stats.pending === 0`)) return true;
      await sleep(250);
    }
    return false;
  };
  return [
    ['farlod', 'buildings arriving at the draw-distance edge dissolve in over far proxies instead of popping', async () => {
      await c.toGameplay();
      await js(PERF_PAGE);
      const route = await js<unknown>(`__perfBench.pick('city')`);
      if (!check('found the benchmark city road', !!route, route)) return;
      await js(`__perfBench.place(${JSON.stringify(route)})`);
      // (not renderer.timeScale = 0: the load gate times its debounce with that dt and would never open)
      await js(`cdda.loadGate('off')`);
      for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== 'third'; i++) {
        await c.x().key('v');
        await sleep(250);
      }
      mkdirSync(resolve(OUT), { recursive: true });
      const results: Record<string, { abrupt: number; maxStep: number; total: number; steps: number[] }> = {};
      for (const mode of ['current', 'dissolve', 'proxy', 'proxy-dissolve']) {
        await js(`cdda.setFarLod('${mode}')`);
        await sleep(1500);
        check(`${mode}: streamed in`, await settled(30_000));
        await sleep(2500);
        // 60 m: the street's buildings too, so the hand-offs happen large in view. Building is
        // held over the drop, so "before" is the view with them gone (covers up) and only the
        // arrivals are measured
        await js(`cdda.holdBuilds(true)`);
        const dropped = await js<number>(`cdda.restreamEdge(60)`);
        await sleep(1500);
        const before = await grab();
        writeFileSync(resolve(OUT, `${mode}_before.png`), before.bytes);
        await js(`cdda.holdBuilds(false)`);
        let prev = before.png;
        const steps: number[] = [];
        const { width: w, height: h } = before.png;
        for (let k = 0; k < SHOTS; k++) {
          const f = await grab();
          if (k % 6 === 0) writeFileSync(resolve(OUT, `${mode}_${String(k).padStart(2, '0')}.png`), f.bytes);
          // mean absolute change per pixel above the HUD rows
          let sum = 0;
          for (let y = 30; y < h * 0.55; y++)
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              sum += Math.abs(f.png.data[i] - prev.data[i]) + Math.abs(f.png.data[i + 1] - prev.data[i + 1]) + Math.abs(f.png.data[i + 2] - prev.data[i + 2]);
            }
          steps.push(sum / (w * (h * 0.55 - 30)));
          prev = f.png;
        }
        // grass sway and clouds change every step a little: measure above that floor
        const floor = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];
        const above = steps.map((v) => Math.max(0, v - floor));
        const total = above.reduce((a, b) => a + b, 0);
        const maxStep = Math.max(...above);
        results[mode] = { abrupt: +(maxStep / Math.max(total, 1e-6)).toFixed(3), maxStep: +maxStep.toFixed(3), total: +total.toFixed(3), steps: steps.map((s) => +s.toFixed(3)) };
        const st = await js<unknown>(`cdda.farLod()`);
        console.log(`    ${mode}: dropped ${dropped}, abrupt ${results[mode].abrupt} (max step ${results[mode].maxStep} of ${results[mode].total})`, JSON.stringify(st));
        writeFileSync(resolve(OUT, `${mode}_steps.json`), JSON.stringify(results[mode]));
      }
      check('current pops (most of the change in one step: the measure works)', results.current.abrupt > 0.3, results.current);
      check('proxy-dissolve: no step carries most of the change', results['proxy-dissolve'].abrupt < 0.5 * results.current.abrupt, { pd: results['proxy-dissolve'].abrupt, current: results.current.abrupt });
      check('dissolve: gentler than current', results.dissolve.abrupt < results.current.abrupt, { d: results.dissolve.abrupt, current: results.current.abrupt });

      // real input: drive into town in the default mode, a few shots on the way
      await js(`cdda.setFarLod('proxy-dissolve')`);
      await sleep(1500);
      await c.x().down('w');
      for (let k = 0; k < 4; k++) {
        await sleep(1500);
        writeFileSync(resolve(OUT, `drive_${k}.png`), (await grab()).bytes);
      }
      await c.x().up('w');
      const speed = await js<number>(`Math.abs(cdda.vehicleSystem.driving?.velocity ?? 0)`);
      check('W drove the car', speed > 2, speed);
      await js(`(() => { const v = cdda.vehicleSystem.driving; if (v) v.velocity = 0; })()`);
    }],
  ];
}

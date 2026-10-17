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
        // the HUD's toasts and messages pop in on their own: measure the world only
        await js(`for (const id of ['ui', 'ui2']) { const e = document.getElementById(id); if (e) e.style.visibility = 'hidden'; }`);
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
        await js(`for (const id of ['ui', 'ui2']) { const e = document.getElementById(id); if (e) e.style.visibility = ''; }`);
        const total = above.reduce((a, b) => a + b, 0);
        const maxStep = Math.max(...above);
        results[mode] = { abrupt: +(maxStep / Math.max(total, 1e-6)).toFixed(3), maxStep: +maxStep.toFixed(3), total: +total.toFixed(3), steps: steps.map((s) => +s.toFixed(3)) };
        const st = await js<unknown>(`cdda.farLod()`);
        console.log(`    ${mode}: dropped ${dropped}, abrupt ${results[mode].abrupt} (max step ${results[mode].maxStep} of ${results[mode].total})`, JSON.stringify(st));
        writeFileSync(resolve(OUT, `${mode}_steps.json`), JSON.stringify(results[mode]));
      }
      check('current pops (most of the change in one step: the measure works)', results.current.abrupt > 0.3, results.current);
      // the largest single-step change is the pop you see (a share of the total misleads when
      // proxies leave little to change at all)
      check('proxy-dissolve: the biggest jump is under a quarter of current\'s', results['proxy-dissolve'].maxStep < 0.25 * results.current.maxStep, { pd: results['proxy-dissolve'].maxStep, current: results.current.maxStep });
      check('dissolve: the biggest jump is under half of current\'s', results.dissolve.maxStep < 0.5 * results.current.maxStep, { d: results.dissolve.maxStep, current: results.current.maxStep });

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
    ['farlodleave', 'driving on, columns left behind fall back to their proxy instead of leaving holes', async () => {
      await c.toGameplay();
      await js(PERF_PAGE);
      const route = await js<unknown>(`__perfBench.pick('city')`);
      if (!check('found the benchmark city road', !!route, route)) return;
      await js(`__perfBench.place(${JSON.stringify(route)})`);
      await js(`cdda.loadGate('off')`);
      await js(`cdda.setFarLod('proxy-dissolve')`);
      check('streamed in', await settled(30_000));
      await sleep(3000);
      console.log('    proxies at the start:', JSON.stringify(await js(`cdda.farLod()`)));
      // tall buildings ahead (proxy over 9 m) to watch while closing on them
      const towers = await js<[number, number][]>(`(() => {
        const p = cdda.game.player, v = cdda.vehicleSystem.driving, out = [];
        const f = (v.facing * Math.PI) / 180, fx = Math.cos(f), fy = Math.sin(f);
        const pcx = Math.floor(p.x / 24), pcy = Math.floor(p.y / 24);
        for (let d = 5; d <= 14; d++) for (let s = -3; s <= 3; s++) {
          const cx = pcx + Math.round(fx * d - fy * s), cy = pcy + Math.round(fy * d + fx * s);
          const t = cdda.columnDrawnTop(cx, cy);
          if (t.full > 9 && !out.some(([x, y]) => x === cx && y === cy)) out.push([cx, cy]);
        }
        return out.slice(0, 12);
      })()`);
      check('tall buildings ahead to watch', towers.length > 0, towers);
      const worst = new Map<string, number>();
      /** the same from the chunks alone: how much a cap had to carry */
      const chunksOnly = new Map<string, number>();
      // 40 mph along the road (the benchmark's ghost car: no collisions)
      await js(`__perfBench.go(17.9)`);
      const samples: { all: number; inner: number }[] = [];
      for (let k = 0; k < 40; k++) {
        await sleep(250);
        samples.push((await js<{ uncovered: { all: number; inner: number } }>(`cdda.farLod()`)).uncovered);
        for (const [cx, cy] of towers) {
          const t = await js<{ chunks: number; proxy: number; full: number }>(`cdda.columnDrawnTop(${cx}, ${cy})`);
          if (!(t.full > 0)) continue; // dropped behind us
          const share = Math.max(t.chunks, t.proxy) / t.full;
          const key = `${cx},${cy}`;
          worst.set(key, Math.min(worst.get(key) ?? 1, share));
          if (t.chunks > 0) chunksOnly.set(key, Math.min(chunksOnly.get(key) ?? 1, t.chunks / t.full));
        }
        if (k === 20) writeFileSync(resolve(OUT, 'leave_mid.png'), (await grab()).bytes);
      }
      const minShare = Math.min(...worst.values());
      console.log('    …of which the chunks alone drew (least):', JSON.stringify(Object.fromEntries([...chunksOnly].map(([k, v]) => [k, +v.toFixed(2)]))));
      console.log('    tall buildings, least of their height drawn while closing in:', JSON.stringify(Object.fromEntries([...worst].map(([k, v]) => [k, +v.toFixed(2)]))));
      check('a tall building keeps (almost) all its height drawn as you drive towards it', minShare > 0.85, { minShare });
      await js(`__perfBench.stop()`);
      const maxInner = Math.max(...samples.map((s) => s.inner));
      console.log('    uncovered inner (per 250 ms):', samples.map((s) => s.inner).join(' '), '| all:', samples.map((s) => s.all).join(' '));
      check('no column inside the draw radius + 2 shows nothing while driving on', maxInner === 0, { maxInner });
    }],
    ['farlodshape', 'proxies have the buildings\' shapes: the same views with real chunks and with proxies only', async () => {
      await c.toGameplay();
      await js(PERF_PAGE);
      const route = await js<unknown>(`__perfBench.pick('city')`);
      if (!check('found the benchmark city road', !!route, route)) return;
      await js(`__perfBench.place(${JSON.stringify(route)})`);
      await js(`cdda.loadGate('off')`);
      await js(`cdda.setFarLod('proxy-dissolve')`);
      // into town a little, then four directions
      await js(`__perfBench.go(17.9)`);
      await sleep(5000);
      await js(`__perfBench.stop()`);
      check('streamed in', await settled(30_000));
      await sleep(3000);
      for (const [i, yaw] of [0, 90, 180, 270].entries()) {
        await js(`(() => { const p = cdda.game.player; p.yaw = ${(yaw * Math.PI) / 180} + Math.atan2(1, 0) * 0; })()`);
        await js(`cdda.renderer.rig.mode = 'first'`).catch(() => undefined);
        await sleep(600);
        writeFileSync(resolve(OUT, `shape_${i}_real.png`), (await grab()).bytes);
        await js(`cdda.proxyView(true)`);
        await sleep(600);
        writeFileSync(resolve(OUT, `shape_${i}_proxy.png`), (await grab()).bytes);
        await js(`cdda.proxyView(false)`);
        await sleep(300);
      }
      check('shots taken', true);
      const pc = await js<unknown>(`cdda.proxyCheck(6, 15)`);
      console.log('    proxy vs real tops:', JSON.stringify(pc));
      for (const w of (pc as { worst: { cx: number; cy: number }[] }).worst.slice(0, 4)) console.log('    ', w.cx, w.cy, JSON.stringify(await js(`cdda.proxyColumn(${w.cx}, ${w.cy})`)));
    }],
    ['farlodmast', 'a radio tower is a mast in its proxy too (it was drawn as a tall solid block)', async () => {
      await c.toGameplay();
      await js(`cdda.loadGate('off')`);
      await js(`cdda.setFarLod('proxy-dissolve')`);
      // seed 1's nearest radio tower: OMT (74, -64); stand 5.5 OMTs south of it, looking north
      const tx = 74 * 24 + 12, ty = -64 * 24 + 12;
      await js(`(() => { const vs = cdda.vehicleSystem; if (vs.driving) { vs.driving.velocity = 0; cdda.exitVehicle(); } cdda.godMode(true); cdda.setWeather('clear'); cdda.setHour(12); cdda.teleport(${tx}, ${ty + 132}, 0); Object.assign(cdda.game.player, { yaw: 0, pitch: 0.08 }); })()`);
      check('streamed in', await settled(40_000));
      await sleep(3000);
      writeFileSync(resolve(OUT, 'mast_real.png'), (await grab()).bytes);
      await js(`cdda.proxyView(true)`);
      await sleep(800);
      writeFileSync(resolve(OUT, 'mast_proxy.png'), (await grab()).bytes);
      await js(`cdda.proxyView(false)`);
      // from beyond the draw distance (the proxy is what you see there)
      await js(`(() => { cdda.teleport(${tx}, ${ty + 260}, 0); Object.assign(cdda.game.player, { yaw: 0, pitch: 0.06 }); })()`);
      check('streamed in far', await settled(40_000));
      await sleep(3000);
      writeFileSync(resolve(OUT, 'mast_far.png'), (await grab()).bytes);
      check('shots taken', true);
    }],
  ];
}

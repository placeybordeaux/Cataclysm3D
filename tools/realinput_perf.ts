// Real-input streaming check (docs/PERF.md): drive a real car down the densest city road with
// the keyboard — W to accelerate, C to lock the speed (cruise control) — with the F3 overlay up,
// then Shift+F3 to save the log, and judge what the telemetry saw: unbuilt chunks in view,
// runway ahead of the car, frame times. `cdda.*` only sets the scene (the car at the start of the
// road, a clear road ahead: parked cars and zombies would end the run in a crash). Plugged into
// tools/realinput.ts (run: --only perfdrive).
//
// PERF_MPH=30,40,60 drives each speed in turn (default 40); PERF_SECONDS (default 14) per speed;
// PERF_SAVE=<dir> writes each run's telemetry dump there (tools/perf-report.ts reads them).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { XInput } from './lib/realinput';
import { PERF_PAGE } from './lib/perfRoutes';
import { summarize, type PerfDump } from '../src/perf/analyze';
import { printReport } from './perf-report';

export interface PerfCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

export function perfScenarios(c: PerfCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const speeds = (process.env.PERF_MPH ?? '40').split(',').map(Number);
  if (speeds.some((v) => !(v > 0 && v < 120))) throw new Error(`PERF_MPH=${process.env.PERF_MPH}: expected mph like 30,40,60`);
  const seconds = Number(process.env.PERF_SECONDS ?? 14);
  const mph = () => js<number>(`Math.abs(cdda.vehicleSystem.driving?.velocity ?? 0) * 2.23694`);
  return [
    ['perfdrive', `drive through the city with the keyboard at ${speeds.join('/')} mph: F3 overlay, cruise control, Shift+F3 saves the log; the world streams in ahead of the car`, async () => {
      await js(PERF_PAGE);
      for (const target of speeds) {
        // the densest straight road of the biggest nearby city, starting on the road itself: the
        // benchmark's 10-OMT run-up crosses fields a real car can't drive through (long grass)
        const route = { ...(await js<{ x: number; y: number; town?: string; len: number }>(`__perfBench.pick('city')`)), lead: 0 };
        await js(`__perfBench.place(${JSON.stringify(route)})`);
        await js(`__perfBench.clearRoute(150)`);
        await c.toGameplay();
        const shown = await js<boolean>(`document.getElementById('perf-overlay')?.style.display === 'block'`);
        if (!shown) await c.x().key('F3');
        check(`F3 shows the performance overlay (${target} mph run)`, await js<boolean>(`document.getElementById('perf-overlay')?.style.display === 'block'`));
        // let the start stream in, then measure from a standing start
        for (let i = 0; i < 80 && (await js<number>(`cdda.renderer.chunks.stats.pending`)) > 0; i++) await sleep(250);
        await js(`(() => { Object.assign(cdda.renderer.chunks.stats, { maxStepMs: 0, maxStep: '' }); cdda.perf.reset(); })()`);
        const t0 = Date.now();
        await c.x().down('w');
        let v = 0;
        while (Date.now() - t0 < 25_000 && (v = await mph()) < target) await sleep(60);
        await c.x().up('w');
        check(`W accelerates the car to ${target} mph`, v >= target - 1, { mph: +v.toFixed(1), after: `${((Date.now() - t0) / 1000).toFixed(1)} s` });
        await c.x().key('c');
        const log = await js<string[]>(`cdda.ui.log().slice(-4)`);
        check(`C locks the speed (cruise control) at ${target} mph`, log.some((l) => /Cruise control set/.test(l)), log);
        await sleep(seconds * 1000);
        const held = await mph();
        check(`cruise holds ${target} mph down the road (no crash)`, Math.abs(held - v) < 6, { mph: +held.toFixed(1) });
        await shot(`perfdrive_${target}mph`);
        await c.x().down('Shift');
        await c.x().key('F3');
        await c.x().up('Shift');
        await sleep(300);
        const saved = await js<string[]>(`cdda.ui.log().slice(-3)`);
        check('Shift+F3 saves the performance log', saved.some((l) => /Performance log saved/.test(l)), saved);
        const dump = await js<PerfDump>(`cdda.perf.dump(${seconds + 30})`);
        const s = summarize(dump);
        printReport(dump, `real-input drive, ${target} mph`);
        if (process.env.PERF_SAVE) {
          mkdirSync(process.env.PERF_SAVE, { recursive: true });
          writeFileSync(join(process.env.PERF_SAVE, `perfdrive_${target}mph.json`), JSON.stringify(dump));
        }
        check(`${target} mph: no unbuilt chunk in clear view for more than 2.5 s`, s.stream.maxHoleSeconds <= 2.5, s.stream);
        // stop: brake, and hand the road back
        await c.x().hold('space', 1500);
        await js(`__perfBench.stopClear()`);
      }
    }],
  ];
}

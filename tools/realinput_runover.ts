// Real-input scenario for run-over bodies (src/game/runoverFling.ts, src/render/chars/ragdoll.ts,
// docs/VEHICLES.md "Run-over bodies"): a car on a straight road, a row of zombies ahead, and W
// held through xdotool until the car reaches ~20 / ~40 / ~70 km/h (released and pressed again to
// hold the speed, the way a player feathers the throttle). `cdda.*` only sets the scene and reads
// the result. Frames are captured in a burst through the hit (chase camera and first person) and
// tiled into strips with ImageMagick. Plugged into tools/realinput.ts (run: --only runover).
//
//   ~/claude-stuff/bin/heavy --kind gpu --vram 2 --mem 3 -- nix-shell --run \
//     'npx tsx tools/realinput.ts --gpu --only runover'
//   RUNOVER_OUT=docs/screenshots/runover RUNOVER_ONLY=70-third,40-first RUNOVER_PARAMS=runover=loose ...

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'puppeteer-core';
import type { XInput } from './lib/realinput';

export interface RunoverCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

const HELPERS = `(() => {
  if (window.__ro) return;
  const vs = cdda.vehicleSystem, ms = cdda.monsterSystem, g = cdda.game;
  /** A car on a long straight road (you at the wheel, facing north), noon, nothing else around. */
  const trip = () => {
    if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); }
    const r = cdda.roadTrip('car', 5); if (!r) return null;
    const v = vs.driving;
    for (const o of [...vs.list]) if (o !== v && Math.hypot(o.x - v.x, o.y - v.y) < 90) vs.remove(o);
    cdda.clearMonsters();
    g.clock.seconds = Math.floor(g.clock.seconds / 86400) * 86400 + 12.5 * 3600;
    cdda.godMode(true);
    return { x: v.x, y: v.y, facing: v.facing };
  };
  /** A row of zombies across the lane, \`d\` m ahead of the car (north), standing still. */
  const row = (d, ids) => {
    const v = vs.driving, p = g.player;
    const lat = [-0.7, 0.35, 1.3], back = [0, 1.6, 3.1];
    return ids.map((id, i) => {
      const uid = cdda.spawnMonster(id, v.x - p.x + lat[i % 3], v.y - p.y - d - back[i % 3]);
      const m = ms.all.find((q) => q.uid === uid);
      m.addEffect('stunned', 40);
      m.facing = Math.PI;
      return uid;
    });
  };
  const kmh = () => Math.abs(vs.driving?.velocity ?? 0) * 3.6;
  const state = (uids) => uids.map((u) => {
    const m = ms.all.find((q) => q.uid === u);
    const c = ms.corpses.filter((q) => q.fling).map((q) => ({ x: q.x, y: q.y }));
    return m ? { uid: u, dead: m.dead, hp: m.hp, flying: !!(m.fling && m.fling.t >= 0), downed: m.hasEffect('downed'), x: m.x, y: m.y } : { uid: u, gone: true, corpses: c.length };
  });
  window.__ro = { trip, row, kmh, state };
})()`;

export function runoverScenarios(c: RunoverCtx): Scenario[] {
  const { js, check, sleep } = c;
  const out = resolve(process.env.RUNOVER_OUT ?? 'shots/runover');
  const only = process.env.RUNOVER_ONLY ? new Set(process.env.RUNOVER_ONLY.split(',')) : null;
  const camera = async (mode: 'first' | 'third') => {
    for (let i = 0; i < 4 && (await js<string>(`cdda.renderer.rig.mode`)) !== mode; i++) {
      await c.x().key('v');
      await sleep(250);
    }
    return (await js<string>(`cdda.renderer.rig.mode`)) === mode;
  };

  /** Drive into the row at `kmh` with W (feathered), capturing a burst through the hit. */
  const run = async (label: string, kmh: number, mode: 'first' | 'third', ids: string[]) => {
    if (only && !only.has(label)) return;
    const x = c.x(), page = c.page();
    const t = await js<{ x: number; y: number } | null>(`(${HELPERS}, window.__ro.trip())`);
    if (!check(`${label}: a car on a straight road`, !!t, t)) return;
    await c.toGameplay();
    check(`${label}: ${mode === 'third' ? 'chase camera' : 'first person'}`, await camera(mode));
    // far enough to reach the speed with W held (the car pulls ~3 m/s²), plus a run-up
    const d = (kmh / 3.6) ** 2 / (2 * 2.6) + 10;
    const uids = await js<number[]>(`window.__ro.row(${d.toFixed(1)}, ${JSON.stringify(ids)})`);
    await sleep(400);
    const dir = resolve(out, 'frames', label);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let held = false, hitAt = -1, frames = 0, speedAtHit = 0;
    const hp0 = (await js<{ hp?: number }[]>(`window.__ro.state(${JSON.stringify(uids)})`)).map((q) => q.hp ?? 0);
    const t0 = Date.now();
    await x.down('w');
    held = true;
    try {
      while (Date.now() - t0 < 16000) {
        const s = await js<{ v: number; st: { dead?: boolean; hp?: number; flying?: boolean; gone?: boolean }[] }>(`({ v: window.__ro.kmh(), st: window.__ro.state(${JSON.stringify(uids)}) })`);
        // feather the throttle around the target speed, as a player would
        if (held && s.v >= kmh) (await x.up('w'), (held = false));
        else if (!held && s.v < kmh - 4 && hitAt < 0) (await x.down('w'), (held = true));
        const hit = s.st.some((q, i) => q.dead || q.gone || q.flying || (q.hp ?? 1e9) < hp0[i]);
        if (hit && hitAt < 0) {
          hitAt = Date.now();
          speedAtHit = s.v;
          if (held) (await x.up('w'), (held = false));
        }
        if (hitAt >= 0 || s.st.length === 0) {
          await page.screenshot({ path: resolve(dir, `f${String(frames++).padStart(3, '0')}.jpg`) as `${string}.jpg`, type: 'jpeg', quality: 85 });
          if (Date.now() - hitAt > 3200) break;
        } else await sleep(15);
      }
    } finally {
      if (held) await x.up('w');
    }
    const end = await js<unknown>(`window.__ro.state(${JSON.stringify(uids)})`);
    check(`${label}: hit at ~${kmh} km/h (${speedAtHit.toFixed(0)} km/h)`, hitAt >= 0 && Math.abs(speedAtHit - kmh) < Math.max(8, kmh * 0.25), { speedAtHit, end });
    check(`${label}: ${frames} frames through the hit`, frames >= 8);
    await js(`(() => { const v = cdda.vehicleSystem.driving; if (v) v.velocity = 0; })()`);
    // a strip: 10 frames over the first ~1.8 s after the hit (the throw, the tumble, the landing)
    const pick: string[] = [];
    const span = Math.min(frames - 1, Math.round((frames * 1.8) / 3.2));
    const n = Math.min(10, frames);
    for (let i = 0; i < n; i++) pick.push(resolve(dir, `f${String(Math.round((i * span) / Math.max(1, n - 1))).padStart(3, '0')}.jpg`));
    try {
      // two rows of five, half size (montage needs a font for its labels; plain appends don't)
      const rowOf = (fs: string[]) => ['(', ...fs, '-resize', '480x270', '-bordercolor', '#111', '-border', '2', '+append', ')'];
      execFileSync('convert', [...rowOf(pick.slice(0, 5)), ...(pick.length > 5 ? rowOf(pick.slice(5)) : []), '-append', '-quality', '85', resolve(out, `${label}.jpg`)]);
      console.log(`  strip: ${resolve(out, `${label}.jpg`)}`);
    } catch (e) {
      check(`${label}: strip montage`, false, String(e));
    }
  };

  return [
    ['runover', 'run-over bodies: real W into a row of zombies at ~20 / ~40 / ~70 km/h, frame strips from the chase camera and first person', async () => {
      await js(HELPERS);
      // Plain zombies (56 HP in play) survive ~20 km/h barely and are gibbed past ~60 km/h (BN's
      // pulverisation, no body): soldiers (70 HP, 11 bash armour) show the survivor and the
      // over-the-roof throw.
      const Z = ['mon_zombie', 'mon_zombie', 'mon_zombie'], S = ['mon_zombie_soldier', 'mon_zombie_soldier', 'mon_zombie_soldier'];
      await run('20-third', 22, 'third', S);
      await run('40-third', 40, 'third', Z);
      await run('70-third', 70, 'third', S);
      await run('40-first', 40, 'first', Z);
      await run('70-first', 70, 'first', S);
      await run('70-gib', 70, 'third', Z);
      await run('40-dogs', 40, 'third', ['mon_zombie_dog', 'mon_dog', 'mon_zombie_dog']);
    }],
  ];
}

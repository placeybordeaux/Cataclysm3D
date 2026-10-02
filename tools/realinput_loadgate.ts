// Real-input load gate + "never the inside before the outside" scenarios (src/loadgate,
// src/render/surroundings.ts), run from tools/realinput.ts:
//   --only loadgate   new game (title, real keys), a long jump with W held under the loading
//                     screen, walking upstairs into an apartment block with zombies on its upper
//                     floors, F5 + reload + title Load, and driving with the keyboard while the
//                     world streams slower than the car (the soft note, no flicker)
//
// Throughout, a per-frame page monitor counts frames where a creature is drawn while the chunk
// it stands in has no geometry on screen (the user's "zombies before the walls"): it must stay 0.
// cdda.* is used only for setup (teleports, spawning, a slow streaming budget to stand in for a
// slow machine) and for reading state. Seed 1 (the realinput default): the urban_18 apartment
// block at OMT 42,36-37 in Holden (three storeys, wooden stairs at 1020,885).

import type { Page } from 'puppeteer-core';
import type { XInput } from './lib/realinput';
import { PERF_PAGE } from './lib/perfRoutes';

export interface LoadGateCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  quickStart: () => Promise<unknown>;
  size: [number, number];
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** Page-side monitor (window.__lgm): per frame, drawn creatures whose chunk isn't on screen,
 *  frames with the gate closed, and the game clock / player position while it was closed. */
const MONITOR = `(() => {
  const st = window.__lgm = { frames: 0, floating: 0, floatFrames: 0, visible: 0, gateFrames: 0, clockWhileClosed: 0, movedWhileClosed: 0, styles: {}, closes: 0, opens: [], closesAt: [], last: null };
  let was = false, t0 = performance.now();
  const tick = () => {
    if (window.__lgm !== st) return;
    const c = window.cdda;
    if (c?.ready && c.monsterView && c.loadGate) {
      st.frames++;
      const g = c.loadGate(), p = c.game.player, now = { clock: c.game.clock.seconds, x: p.x, y: p.y, z: p.z };
      if (g.closed) {
        st.gateFrames++;
        st.styles[g.style] = (st.styles[g.style] || 0) + 1;
        if (was && st.last) {
          st.clockWhileClosed += Math.abs(now.clock - st.last.clock);
          if (now.z === st.last.z) st.movedWhileClosed += Math.hypot(now.x - st.last.x, now.y - st.last.y);
        }
        if (!was) { st.closes++; st.closesAt.push(performance.now() - t0); }
      } else if (was) st.opens.push(performance.now() - t0);
      was = g.closed;
      st.last = now;
      const ch = c.renderer.chunks;
      let f = 0;
      for (const [m, w] of c.monsterView.views) {
        const vis = w.c ? w.c.inst.visible : w.h ? w.h.visible : false;
        if (!vis) continue;
        st.visible++;
        if (ch.chunkState(Math.floor(m.x / 24), Math.floor(m.y / 24), m.z) !== 2) f++;
      }
      st.floating += f;
      if (f) st.floatFrames++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

interface Mon { frames: number; floating: number; floatFrames: number; visible: number; gateFrames: number; clockWhileClosed: number; movedWhileClosed: number; styles: Record<string, number>; closes: number; opens: number[]; closesAt: number[] }

/** Zombies on the apartment block's upper floors (z 1 and 2), standing on floor tiles. */
const SPAWN_UPSTAIRS = `(() => {
  const g = cdda.game, m = g.map, sys = g.monsters; let n = 0;
  for (const z of [1, 2]) {
    let k = 0;
    for (let y = 870; y < 905 && k < 5; y += 2) for (let x = 1014; x < 1031 && k < 5; x += 3) {
      const t = m.terAt(x, y, z);
      if (!m.passable(x, y, z) || t.id.includes('open_air') || t.id.includes('stairs')) continue;
      const mm = sys.spawnById('mon_zombie', x + 0.5, y + 0.5, z, {});
      if (mm) { mm.scripted = true; n++; k++; }
    }
  }
  return n;
})()`;

/** The HUD banner text mentioning the load gate ('' when none). */
const BANNER = `([...document.querySelectorAll('#ui2 *, #ui *')].map((e) => e.children.length ? '' : e.textContent || '').find((t) => /Loading surroundings/.test(t)) ?? '')`;

export function loadgateScenarios(c: LoadGateCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const [W, H] = c.size;
  const mon = () => js<Mon>(`(() => { const s = window.__lgm; return s && { frames: s.frames, floating: s.floating, floatFrames: s.floatFrames, visible: s.visible, gateFrames: s.gateFrames, clockWhileClosed: s.clockWhileClosed, movedWhileClosed: s.movedWhileClosed, styles: s.styles, closes: s.closes, opens: s.opens, closesAt: s.closesAt }; })()`);
  const gate = () => js<{ closed: boolean; style: string; mode: string; counts: { closes: number; timeouts: number }; closedSeconds: number; missing: { core: number; near: number; far: number } }>(`cdda.loadGate()`);
  const overlayOn = () => js<boolean>(`!!document.querySelector('.loadgate.on')`);
  const waitOpen = async (ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && (await gate()).closed) await sleep(100);
    return Date.now() - t0;
  };
  /** A fresh page (reload), the monitor installed as soon as the game is up. */
  const reload = async () => {
    const page = c.page();
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
    await js(MONITOR);
  };

  return [
    ['loadgate', 'load gate (new game, long jump with W held, upstairs with zombies, F5 + title Load, fast driving) and creatures never drawn before the walls around them', async () => {
      // ---- new game: title, Start, Enter (real keys); the gate arms with gameplay
      await reload();
      await c.quickStart();
      const ng = await mon();
      const g0 = await gate();
      check('new game: armed in the default mode (auto)', g0.mode === 'auto', g0);
      check('new game: no creature drawn before its chunk', ng.floatFrames === 0, ng);
      check('new game: the game clock stood still while the gate was closed', ng.clockWhileClosed === 0, ng);
      console.log(`    (new game: gate closed ${g0.counts.closes}x, ${g0.closedSeconds} s)`);
      await waitOpen();

      // ---- a long jump (teleport = setup) to the street by the apartment block, W held
      await js(`(() => { cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(); })()`);
      await js(`(() => { window.__lgm.floatFrames = 0; cdda.teleport(1046.5, 902.5, 0); cdda.look(-62, 14); })()`);
      await sleep(80);
      const n = await js<number>(SPAWN_UPSTAIRS);
      check('setup: zombies on the upper floors', n >= 6, n);
      const at = await js<{ x: number; y: number; clock: number }>(`({ x: cdda.game.player.x, y: cdda.game.player.y, clock: cdda.game.clock.seconds })`);
      await c.x().down('w');
      await sleep(300);
      const g1 = await gate();
      const ov = await overlayOn();
      await shot('loadgate_jump_loading_screen');
      check('after a long jump the loading screen is up (auto: full screen)', g1.closed && g1.style === 'block' && ov, { g1, ov });
      const held = await js<{ x: number; y: number; clock: number }>(`({ x: cdda.game.player.x, y: cdda.game.player.y, clock: cdda.game.clock.seconds })`);
      check('W held under the loading screen does not walk, the clock does not run', Math.hypot(held.x - at.x, held.y - at.y) < 0.01 && held.clock === at.clock, { at, held });
      const waited = await waitOpen();
      await sleep(400);
      const walked = await js<{ x: number; y: number }>(`({ x: cdda.game.player.x, y: cdda.game.player.y })`);
      await c.x().up('w');
      check('the gate opens once the surroundings are built (and the held W walks on)', !(await gate()).closed && Math.hypot(walked.x - at.x, walked.y - at.y) > 0.3, { waited, walked });
      check('the loading screen is gone', !(await overlayOn()));
      await shot('loadgate_jump_after');

      // ---- upstairs: the foot of the block's stairs (setup), climb with W, zombies upstairs
      await js(`(() => { window.__lgm.floatFrames = 0; window.__lgm.floating = 0; cdda.stairs.setVariant('flight'); cdda.teleport(1020.5, 885.5, 0); cdda.step(0.1); return cdda.stairs.standAt(1020, 885, 0, false); })()`);
      await waitOpen();
      await js(SPAWN_UPSTAIRS);
      await shot('loadgate_stairs_foot');
      const climb = async (z: number) => {
        await c.x().down('w');
        const t0 = Date.now();
        while (Date.now() - t0 < 9000 && (await js<number>(`cdda.game.player.z`)) !== z) await sleep(60);
        await sleep(600);
        await c.x().up('w');
        return js<number>(`cdda.game.player.z`);
      };
      const z1 = await climb(1);
      await shot('loadgate_stairs_z1');
      const up = await mon();
      check('walking upstairs (held W) reaches the first floor', z1 === 1, z1);
      check('upstairs: zombies on the upper floors are drawn (some visible frames)', up.visible > 0, up);
      check('upstairs: never a creature drawn before the walls around it', up.floatFrames === 0, up);
      await js(`cdda.clearMonsters()`);

      // ---- save (F5), reload, title Load (l, Enter): held until the city is built
      await c.toGameplay();
      await c.x().key('F5');
      await sleep(1500);
      const saved = await js<string[]>(`cdda.ui.log().slice(-3)`);
      check('F5 saves', saved.some((m) => /saved/i.test(m)), saved);
      await reload();
      await c.x().click(W / 2, 20);
      await c.x().key('l');
      await sleep(800);
      await c.x().key('Return');
      // the Load reloads the page with the save pending: wait for the new page
      await sleep(1500);
      await c.page().waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
      await js(MONITOR);
      await sleep(250);
      const gl = await gate();
      await shot('loadgate_load_screen');
      const loadWait = await waitOpen();
      const ld = await mon();
      const pz = await js<{ x: number; y: number; z: number }>(`({ x: cdda.game.player.x, y: cdda.game.player.y, z: cdda.game.player.z })`);
      check('title Load: back where the save was (first floor of the block)', pz.z === 1 && Math.hypot(pz.x - 1020, pz.y - 884) < 8, pz);
      check('after Load the game waited for its surroundings (gate closed at some point)', gl.closed || ld.gateFrames > 0 || gl.counts.closes > 0, { gl, ld });
      check('after Load: clock still while closed, no creature before its chunk', ld.clockWhileClosed === 0 && ld.floatFrames === 0, ld);
      console.log(`    (load: gate open ${loadWait} ms after ready+250 ms)`);
      await c.toGameplay();
      await shot('loadgate_load_after');

      // ---- driving with the keyboard while the world streams slower than the car (a slow machine)
      await js(PERF_PAGE);
      const route = { ...(await js<{ x: number; y: number; town?: string; len: number }>(`__perfBench.pick('town')`)), lead: 0 };
      await js(`__perfBench.place(${JSON.stringify(route)})`);
      await js(`__perfBench.clearRoute(150)`);
      await c.toGameplay();
      await waitOpen();
      await js(`(() => { const c = cdda.renderer.chunks; window.__lgBudget = [c.budgetMs, c.boostBudgetMs, c.settleBudgetMs, c.urgentBudgetMs, c.slackShare, c.boostSlackShare]; c.budgetMs = c.boostBudgetMs = c.settleBudgetMs = c.urgentBudgetMs = 0.6; c.slackShare = c.boostSlackShare = 0; cdda.prefetch.stop?.(); })()`);
      await js(MONITOR);
      await c.x().down('w');
      const t0 = Date.now();
      let mph = 0, softShot = false;
      while (Date.now() - t0 < 30_000) {
        await sleep(100);
        mph = await js<number>(`Math.abs(cdda.vehicleSystem.driving?.velocity ?? 0) * 2.23694`);
        // (gate, banner and overlay read in one go: a short close may be over by the next call)
        const { g, b, ov } = await js<{ g: { closed: boolean; style: string }; b: string; ov: boolean }>(`({ g: cdda.loadGate(), b: ${BANNER}, ov: !!document.querySelector('.loadgate.on') })`);
        if (g.closed && !softShot) {
          softShot = true;
          const pos0 = await js<{ x: number; y: number }>(`({ x: cdda.vehicleSystem.driving.x, y: cdda.vehicleSystem.driving.y })`);
          await shot('loadgate_drive_soft');
          await sleep(200);
          const pos1 = await js<{ x: number; y: number }>(`({ x: cdda.vehicleSystem.driving.x, y: cdda.vehicleSystem.driving.y })`);
          check('outrunning the world: the soft note shows over the frozen view', g.style === 'soft' && /Loading surroundings/.test(b) && !ov, { g, b, ov });
          check('the car waits where it is while the note is up', (await gate()).closed ? Math.hypot(pos1.x - pos0.x, pos1.y - pos0.y) < 0.01 : true, { pos0, pos1 });
        }
      }
      await c.x().up('w');
      const dr = await mon();
      await js(`(() => { const c = cdda.renderer.chunks, b = window.__lgBudget; [c.budgetMs, c.boostBudgetMs, c.settleBudgetMs, c.urgentBudgetMs, c.slackShare, c.boostSlackShare] = b; cdda.prefetch.start?.(); })()`);
      console.log(`    (drive: top ${mph.toFixed(0)} mph, gate closed ${dr.closes}x, ${(dr.gateFrames / Math.max(1, dr.frames) * 100).toFixed(0)}% of frames, styles ${JSON.stringify(dr.styles)})`);
      check('driving on a slow machine: the gate closed at least once', dr.closes > 0, dr);
      // no flicker: closes are at least a second apart (debounce, wider ring to open, reclose debounce)
      // (open i is followed by close i + 1)
      const gaps = dr.closesAt.slice(1).map((t, i) => t - (dr.opens[i] ?? -Infinity));
      check('driving: no flicker (never re-closed within a second)', dr.closes <= 1 || gaps.every((g) => g > 1000), { closes: dr.closes, gaps });
      check('driving: no creature before its chunk, clock still while closed', dr.floatFrames === 0 && dr.clockWhileClosed === 0, dr);
      await c.x().hold('space', 1500);
      await js(`__perfBench.stopClear()`);
      // out of the car: later scenarios walk with W
      await js(`cdda.exitVehicle?.()`);
    }],
  ];
}

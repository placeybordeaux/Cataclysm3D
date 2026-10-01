// Real-input fast-forward scenarios (src/game/timewarp.ts, docs/BALANCE.md "Fast-forward"),
// run from tools/realinput.ts:
//   --only fastforward  R opens the read menu, pick a book, + steps the speed ×2 → ×4 → ×8 (the
//                       line under the crosshair says so and the clock really runs ~8× faster),
//                       a zombie walks into view → the reading stops and the speed is back at ×1
//   --only fastrest     l opens the Rest window, + sets "Fast: ×4", 5 waits an hour at ×4; W stops it
//   --only ffmeasure    a long read at ×16 with each drawing mode: what the governor measures and
//                       caps on this machine (prints a table; run with --gpu --size 3440x1304)
//
// Keys are OS-level input; cdda.* only sets the hour, clears/spawns monsters, gives the book
// and reads state.

import type { XInput } from './lib/realinput';

export interface TimewarpCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];
interface TwState {
  available: boolean; requested: number; wanted: number; effective: number; simSpeed: number; cap: number; affordable: number;
  tickMs: number; otherMs: number; frameMs: number; dropped: string | null; keyMode: string; drawMode: string; drawsSkipped: number; line: string | null;
}

export function timewarpScenarios(c: TimewarpCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const tw = () => js<TwState>('cdda.timewarp.state()');
  const act = () => js<{ name: string; kind: string | null } | null>('(() => { const a = cdda.game.activities.current; return a ? { name: a.spec.name, kind: a.spec.kind ?? null } : null; })()');
  const clock = () => js<number>('cdda.game.clock.seconds');
  const logTail = (n = 4) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  /** Game seconds per real second over `ms`. */
  const rate = async (ms = 1000) => {
    const t0 = await clock(), r0 = Date.now();
    const eff: number[] = [];
    while (Date.now() - r0 < ms) {
      await sleep(100);
      eff.push((await tw()).effective);
    }
    return { r: ((await clock()) - t0) / ((Date.now() - r0) / 1000), eff: eff.reduce((a, b) => a + b, 0) / Math.max(1, eff.length) };
  };
  // Noon in an open field (a zombie 15 tiles away is in plain view), nothing hostile around.
  const safeSpot = () => js(`(() => { const f = cdda.findOmt('field', 40); if (!f) throw new Error('no field near the start');
    cdda.teleportOmt(f.x, f.y, 0); cdda.setHour(12); cdda.clearMonsters(200); cdda.godMode(false); cdda.step(0.3); })()`);

  /** R, then the menu letter of the entry whose label starts with `label`. */
  const readBook = async (label: string) => {
    await c.x().key('R');
    await sleep(400);
    const letter = await js<string | null>(`(() => {
      for (const row of document.querySelectorAll('.cdda-window .menu-entry[data-i]')) {
        const k = row.querySelector('.hotkey');
        if (k && (row.textContent || '').slice(k.textContent.length).trim().startsWith(${JSON.stringify(label)})) return k.textContent;
      }
      return null;
    })()`);
    check(`the read menu lists "${label}"`, !!letter, await js(`[...document.querySelectorAll('.cdda-window')].map((w) => w.textContent).join(' | ').slice(0, 300)`));
    await c.x().key(letter ?? 'Return');
    await sleep(500);
  };

  return [
    ['fastforward', 'reading: + steps ×2 → ×4 → ×8 on the line under the crosshair, the clock runs ~8× faster; a zombie in view stops it and drops to ×1', async () => {
      await toGameplay();
      await safeSpot();
      await js(`cdda.giveItem('mag_survival')`);
      await readBook('Outdoor Adventures');
      const a = await act();
      check('R + the book starts reading', a?.kind === 'read', a);
      if (a?.kind !== 'read') return;
      const r1 = (await rate()).r;
      let s = await tw();
      check('at ×1 the line shows the speed and the key', s.available && s.effective === 1 && /^Reading · ×1 · .* left/.test(s.line ?? '') && /\[\+\]/.test(s.line ?? ''), s);
      await c.x().key('plus');
      await sleep(150);
      s = await tw();
      check('+ → ×2', s.requested === 2 && s.simSpeed === Math.min(2, s.cap), s);
      await c.x().key('plus');
      await sleep(150);
      await c.x().key('plus');
      await sleep(300);
      s = await tw();
      check('+ + → ×8 (or the machine cap), shown on the line', s.requested === 8 && s.effective === Math.min(8, s.cap) && (s.line ?? '').includes(s.effective < 8 ? `×8 (capped ×${s.effective})` : '×8'), s);
      const dom = await js<string>(`document.querySelector('[data-testid="fast-forward"]')?.textContent ?? ''`);
      check('the speed line is in the page under the ring', /×8/.test(dom), dom);
      await shot('fastforward_x8');
      const { r: r8, eff: eff8 } = await rate();
      // against the speed actually running over the window (the cap may hold it lower)
      check('the clock runs as many times faster as the speed says (game s per real s vs ×1)', r8 / r1 > 0.75 * eff8 && r8 / r1 < 1.25 * eff8, { r1: +r1.toFixed(1), r8: +r8.toFixed(1), ratio: +(r8 / r1).toFixed(2), meanEffective: eff8, s: await tw() });
      check('still reading at ×8', (await act())?.kind === 'read', await act());
      // A zombie comes into view 15 tiles north (setup); the reading must stop and drop to ×1.
      await js(`cdda.spawnMonster('mon_zombie', 0, -15)`);
      let stopped = false;
      for (let i = 0; i < 40 && !stopped; i++) {
        await sleep(100);
        stopped = (await act()) === null;
      }
      s = await tw();
      const log = await logTail(3);
      check('a zombie in view stops the reading', stopped, { log, s });
      check('…and the speed is back at ×1, saying why', s.simSpeed === 1 && s.requested === 1 && /zombie/.test(s.dropped ?? ''), s);
      check('the log says "You see a zombie!"', log.some((l) => /You see a zombie|zombie spotted/i.test(l)), log);
      await shot('fastforward_stopped');
      await js('cdda.clearMonsters(200)');
    }],

    ['fastrest', 'Rest window: + sets Fast ×4, 5 waits an hour at ×4, W stops it', async () => {
      await toGameplay();
      await safeSpot();
      await c.x().key('l');
      await sleep(400);
      const btn = () => js<string>(`document.querySelector('.rest-fast')?.textContent ?? ''`);
      check('the Rest window has the Fast pick, off', /Fast: off/.test(await btn()), await btn());
      await c.x().key('plus');
      await sleep(120);
      await c.x().key('plus');
      await sleep(200);
      check('+ + → Fast: ×4', /Fast: ×4/.test(await btn()), await btn());
      await shot('fastrest_window');
      await c.x().key('5');
      await sleep(500);
      const a = await act();
      const s = await tw();
      check('5 waits an hour, at ×4 from the start', a?.name === 'waiting' && s.requested === 4 && s.simSpeed === Math.min(4, s.cap), { a, s });
      await c.x().hold('w', 300);
      await sleep(300);
      check('W stops the wait and the speed drops to ×1', (await act()) === null && (await tw()).simSpeed === 1, await tw());
    }],

    ['ffmeasure', 'a long read at ×16, Lighter and Full drawing: what the governor measures and caps on this machine', async () => {
      await toGameplay();
      const rows: Record<string, unknown>[] = [];
      for (const draw of ['lite', 'full'] as const) {
        await safeSpot();
        await js(`localStorage.setItem('cdda3d.ffDraw', '${draw}')`);
        // A business manual read until done (setup): ~40 chapters, minutes at ×1, long enough at
        // ×16 to measure (a wait is at most ~8 real s at ×1, half a second at ×16).
        await sleep(3000); // let the field stream in after the teleport
        check('reading How to Succeed in Business until done', await js<boolean>(`cdda.timewarp.read('manual_business')`));
        await sleep(1000);
        for (let i = 0; i < 4; i++) {
          await c.x().key('plus');
          await sleep(100);
        }
        await sleep(400);
        const { r } = await rate(1500);
        const s = await tw();
        const intervals = await js<number[]>(`(() => new Promise((res) => { const t = []; let l = performance.now(); const f = (n) => { t.push(n - l); l = n; if (t.length < 60) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); }))()`);
        intervals.sort((p, q) => p - q);
        const row = { draw, activity: (await act())?.name, requested: s.requested, cap: s.cap, effective: s.effective, tickMs: s.tickMs, drawMs: s.otherMs, frameMs: s.frameMs, p50: +intervals[30].toFixed(1), p95: +intervals[57].toFixed(1), gameSecPerRealSec: Math.round(r), stillWaiting: !!(await act()) };
        rows.push(row);
        console.log('   ', JSON.stringify(row));
        if (draw === 'lite') await shot('ffmeasure_x16');
        check(`${draw}: fast-forward ran (×${s.effective}) with frames p95 ${row.p95} ms`, s.effective >= 1 && row.stillWaiting, row);
        await c.x().hold('w', 250);
        await sleep(300);
      }
      await js(`localStorage.removeItem('cdda3d.ffDraw')`);
    }],
  ];
}

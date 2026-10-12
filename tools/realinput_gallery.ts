// Real-input check of the style gallery (docs/GALLERY.md), run from tools/realinput.ts:
//   --only gallery
// Opens /?gallery the way the Esc menu's dev entry does, then uses it like a person: clicks
// every scene in the list, clicks every value of every switch (and back), drags to look,
// walks with WASD, R resets the camera; A/B on four switches (Enter renders, Space flips, the
// view buttons switch side-by-side / flicker / slider); one Matrix (chips, Generate, click a
// thumbnail, arrows, Esc); "Copy these as my defaults" persists through Options storage.
// cdda.* is used for reading state, picking <select> values and the per-switch pixel-diff proof.

import type { Page } from 'puppeteer-core';
import type { XInput } from './lib/realinput';

export interface GalleryCtx {
  page: () => Page;
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  errors: () => string[];
  gameUrl: () => string;
  quickStart: () => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

interface GState {
  mode: string; scene: string | null; busy: number; errors: string[]; values: Record<string, string>; saved: Record<string, string>;
  ab: { sw: string; a: string; b: string; diff: number } | null; matrix: { scene: string; n: number }[];
}

export function galleryScenarios(c: GalleryCtx): Scenario[] {
  const { js, check, shot, sleep } = c;
  const st = () => js<GState>('cdda.gallery.state()');
  /** Wait for the gallery's serial queue to drain (scene setup, captures). */
  const idle = async (ms = 120_000) => {
    const end = Date.now() + ms;
    await sleep(150);
    while (Date.now() < end) {
      if ((await st()).busy === 0) return true;
      await sleep(120);
    }
    return false;
  };
  /** Centre of the first visible element matching `sel` (scrolled into its panel first, as a person would scroll). */
  const at = (sel: string) =>
    c.page().evaluate((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    }, sel);
  const click = async (sel: string, button = 1) => {
    const p = await at(sel);
    if (!p) throw new Error(`gallery: nothing on screen for ${sel}`);
    await c.x().click(p.x, p.y, button);
  };
  const pick = (selId: string, value: string) =>
    js(`(() => { const s = document.querySelector('[data-testid="${selId}"]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`);

  return [
    ['gallery', 'style gallery: every scene, every switch value live, drag-look/WASD/R, A/B on 4 switches, a Matrix, copy defaults', async () => {
      const x = c.x();
      // The dev-build entry in the Esc menu.
      await c.toGameplay();
      // (Firefox: the first Esc may only leave pointer lock; press again until the menu is up)
      const menuUp = () => js<boolean>(`!!document.querySelector('[data-testid="esc-menu"]')`);
      for (let i = 0; i < 3 && !(await menuUp()); i++) {
        await x.key('Escape');
        for (let k = 0; k < 10 && !(await menuUp()); k++) await sleep(150);
      }
      const entry = await js<boolean>(`[...document.querySelectorAll('[data-testid="esc-menu"] button')].some((b) => /Style gallery/.test(b.textContent ?? ''))`);
      check('Esc menu has the dev "Style gallery" entry', entry);
      if (await menuUp()) await x.key('Escape');
      await sleep(300);
      const storage = await js<string>('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))');
      const errs0 = c.errors().length;
      await c.page().goto(new URL('/?gallery', c.gameUrl()).href);
      await c.page().waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
      await idle();
      let s = await st();
      check('gallery opens on the street scene', s.scene === 'street' && s.mode === 'live', s);
      check('the game HUD is hidden in the gallery', await js<boolean>(`getComputedStyle(document.getElementById('ui')).display === 'none'`));
      await shot('gallery-open');

      // --- every scene, by clicking it in the list
      const scenes = await js<string[]>('cdda.gallery.scenes');
      const failed: string[] = [];
      for (const id of scenes) {
        await click(`.gal-scene[data-scene="${id}"]`);
        await idle();
        s = await st();
        if (s.scene !== id || s.errors.length) failed.push(`${id}: at ${s.scene} ${s.errors.slice(-1)}`);
      }
      check(`all ${scenes.length} scenes open by click, without errors`, failed.length === 0, failed);
      // ↑/↓ step through the list
      await click('.gal-scene[data-scene="street"]');
      await idle();
      await x.key('Down');
      await idle();
      check('↓ goes to the next scene', (await st()).scene === scenes[scenes.indexOf('street') + 1], (await st()).scene);
      await x.key('Up');
      await idle();

      // --- every value of every switch, by clicking the segmented control (Live)
      const sws = await js<{ id: string; values: string[]; value: string; proof: string }[]>('cdda.gallery.switches');
      const bad: string[] = [];
      for (const sw of sws) {
        const orig = (await st()).values[sw.id];
        for (const v of [...sw.values.filter((q) => q !== orig), orig]) {
          await click(`.gal-segbtn[data-switch="${sw.id}"][data-value="${v}"]`);
          await idle();
          s = await st();
          const on = await js<boolean>(`!!document.querySelector('.gal-segbtn[data-switch="${sw.id}"][data-value="${v}"].on')`);
          if (s.values[sw.id] !== v || !on || s.errors.length) bad.push(`${sw.id}=${v}: now ${s.values[sw.id]}, marked ${on} ${s.errors.slice(-1)}`);
        }
      }
      check('every switch value applies live on click and comes back', bad.length === 0, bad);

      // --- looking around: drag, WASD, R
      const pose = () => js<{ x: number; y: number; yaw: number }>('({ x: cdda.game.player.x, y: cdda.game.player.y, yaw: cdda.game.player.yaw })');
      const p0 = await pose();
      const v = await at('.gal-view');
      await x.moveTo(v!.x, v!.y);
      await x.buttonDown(1);
      await x.moveTo(v!.x + 160, v!.y, 10);
      await x.buttonUp(1);
      const p1 = await pose();
      check('dragging on the view turns the camera', Math.abs(p1.yaw - p0.yaw) > 0.2, { p0, p1 });
      await x.hold('w', 600);
      const p2 = await pose();
      check('W walks the camera forward', Math.hypot(p2.x - p1.x, p2.y - p1.y) > 0.8, { p1, p2 });
      await x.key('r');
      await sleep(200);
      const p3 = await pose();
      check('R puts the camera back', Math.abs(p3.yaw - p0.yaw) < 1e-6 && Math.hypot(p3.x - p0.x, p3.y - p0.y) < 1e-6, { p0, p3 });

      // --- A/B on four switches
      await x.key('2');
      await sleep(200);
      check('2 switches to A/B', (await st()).mode === 'ab');
      for (const [scene, sw] of [['street', 'look'], ['horde', 'chars'], ['kitchen', 'furniture'], ['fp_pistol', 'aim'], ['lineup', 'flora']] as const) {
        await js(`cdda.gallery.setMode('live')`);
        await click(`.gal-scene[data-scene="${scene}"]`);
        await idle();
        await x.key('2');
        await pick('ab-switch', sw);
        // B defaults to the value after the current one; for the aim model that can be sway vs
        // sway + timing, which draw the same path. Compare a path against dice (no path).
        if (sw === 'aim') {
          await pick('ab-a', 'sway');
          await pick('ab-b', 'dice');
        }
        await click('.gal-ab .ui2-btn.tone-accent');
        await idle();
        s = await st();
        // (the aim model shows only as a thin 2 s crosshair path: the 0.1% bar galleryproof uses)
        const minDiff = sw === 'aim' ? 0.001 : 0.002;
        check(`A/B ${sw} in ${scene}: two captures that differ`, !!s.ab && s.ab.sw === sw && s.ab.diff > minDiff && !s.errors.length, s.ab ?? s.errors);
        await shot(`gallery-ab-${sw}`);
      }
      await click('.gal-segbtn[data-abview="flicker"]');
      await sleep(150);
      const alt0 = await js<string>(`document.querySelector('.gal-single img')?.alt ?? ''`);
      await x.key('space');
      await sleep(150);
      const alt1 = await js<string>(`document.querySelector('.gal-single img')?.alt ?? ''`);
      check('flicker view: Space flips A and B', alt0 !== alt1 && !!alt0 && !!alt1, { alt0, alt1 });
      await click('.gal-segbtn[data-abview="slider"]');
      await sleep(150);
      check('slider view shows both frames', await js<boolean>(`document.querySelectorAll('.gal-wipe img').length === 2`));
      await click('.gal-segbtn[data-abview="side"]');

      // --- one Matrix: switch + two scenes, Generate, enlarge a thumbnail
      await x.key('3');
      await sleep(200);
      await pick('mx-switch', 'haze');
      await click('.gal-matrix .gal-controls .ui2-btn:nth-of-type(3)'); // Clear scenes
      await click('.gal-chip[data-chip="far"]');
      await click('.gal-chip[data-chip="forest"]');
      await click('.gal-matrix .ui2-btn.tone-accent');
      await sleep(500);
      await idle(300_000);
      s = await st();
      check('Matrix: 2 scenes x 3 haze values', s.matrix.length === 2 && s.matrix.every((r) => r.n === 3) && !s.errors.length, s.matrix);
      await shot('gallery-matrix');
      await click('.gal-thumb[data-row="0"][data-col="0"]');
      await sleep(200);
      const lbOpen = () => js<boolean>(`document.querySelector('.gal-lightbox').classList.contains('open')`);
      check('clicking a thumbnail enlarges it', await lbOpen());
      const src0 = await js<string>(`document.querySelector('.gal-lightbox img').src`);
      await x.key('Right');
      await sleep(150);
      check('→ shows the next value', (await js<string>(`document.querySelector('.gal-lightbox img').src`)) !== src0);
      await x.key('Escape');
      await sleep(150);
      check('Esc closes the enlarged view', !(await lbOpen()));
      await x.key('1');

      // --- copy defaults (through Options storage), then factory defaults
      await click('.gal-segbtn[data-switch="look"][data-value="crisp"]');
      await idle();
      await click('.gal-defaults .ui2-btn.tone-accent');
      await idle();
      const stored = await js<string | null>(`localStorage.getItem('cdda3d.look')`);
      check('Copy these as my defaults stores the visual style like Options does', stored === 'crisp', stored);
      await click('.gal-defaults .ui2-btn:nth-of-type(2)');
      await idle();
      check('Factory defaults puts the style back to the factory look (Voxel)', (await st()).values.look === 'voxel');
      s = await st();
      check('no gallery errors', s.errors.length === 0, s.errors);
      check('no page errors in the gallery', c.errors().length === errs0, c.errors().slice(errs0, errs0 + 3));

      // Back to the game, with the storage as it was (the copy wrote real Options).
      await js(`(() => { localStorage.clear(); for (const [k, v] of Object.entries(${storage})) localStorage.setItem(k, v); })()`);
      await c.page().goto(c.gameUrl());
      await c.page().waitForFunction('window.cdda?.ready', { timeout: 240_000 });
      await c.quickStart();
    }],
    ['galleryproof', 'style gallery: each switch changes the picture in its proof scene (pixel diff), no errors', async () => {
      await c.page().goto(new URL('/?gallery', c.gameUrl()).href);
      await c.page().waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
      await idle();
      const r = await js<{ id: string; scene: string; diffs: Record<string, number> }[]>('cdda.gallery.proof()');
      // 'sway' and 'sway + timing' draw the same 2 s crosshair path by design (the timing model only
      // adds the interactive games: breath flash, release ring, reload band), so a still capture
      // can only tell either of them from dice. Diffs are against the current value, so drop the
      // other one of the pair.
      const lookAlike: Record<string, string[]> = { aim: ['sway', 'timing'] };
      for (const p of r) {
        const vals = Object.entries(p.diffs).filter(([v]) => !lookAlike[p.id]?.includes(v)).map(([, d]) => d);
        const worst = Math.min(...vals);
        console.log(`    ${p.id.padEnd(10)} @${p.scene.padEnd(10)} ${JSON.stringify(p.diffs)}`);
        check(`${p.id} visibly changes the ${p.scene} scene (every value, >0.1% of pixels)`, worst > 0.1, p.diffs);
      }
      await c.page().goto(c.gameUrl());
      await c.page().waitForFunction('window.cdda?.ready', { timeout: 240_000 });
      await c.quickStart();
    }],
  ];
}

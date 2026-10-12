// Holistic playthrough for integration QA (docs/QA_WAVE3.md): the first evening a new player has,
// at the human's window size, with real OS input for everything the player does. cdda.* only
// sets scenes up (teleport to a street / a house / a forest, the hour, a zombie, a car on a road)
// and reads state. Each step takes a screenshot, samples frame times standing still (or while
// moving, for walk/drive), and collects console errors/warnings and page errors.
//
//   nix-shell --run '~/claude-stuff/bin/heavy --kind gpu --mem 2.5 --name qa-play -- npx tsx tools/qa-playthrough.ts --gpu'
//   options: --browser chromium|firefox   (Firefox renders WebGL in software under Xvfb: perf there is not the GPU's)
//            --size 3440x1304             viewport (default: the human's ultrawide)
//            --out shots/qa-play          screenshots (PNG) and report.json
//            --only title,shelter,...     run some steps (title always runs: it starts the game)
//            --params "look=classic"      extra URL parameters
//            --gpu                        Chromium on the real GPU (run via heavy --kind gpu)
//            --list / --dry-run           print the steps, start nothing
//
// Exit code 1 on page errors or a failed step.

import { createServer } from 'vite';
import type { Page } from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitWindow, launchBrowser, startXvfb, XInput, type BrowserKind } from './lib/realinput';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: tsx tools/qa-playthrough.ts [--gpu] [--browser chromium|firefox] [--size WxH] [--out dir] [--only a,b] [--params k=v] [--list] [--dry-run]  (see header)');
  process.exit(0);
}
const [W, H] = opt('--size', '3440x1304').split('x').map(Number);
const browserKind = opt('--browser', 'chromium') as BrowserKind;
if (browserKind !== 'chromium' && browserKind !== 'firefox') throw new Error(`--browser ${browserKind}: expected chromium or firefox`);
const gpu = argv.includes('--gpu');
const out = resolve(opt('--out', 'shots/qa-play'));
const only = argv.includes('--only') ? new Set(['title', ...opt('--only', '').split(',')]) : null;
const extraParams = opt('--params', '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let page: Page;
let x: XInput;
const js = <T>(code: string): Promise<T> => page.evaluate(code) as Promise<T>;
const report: { step: string; ok: boolean; notes: string[]; perf?: unknown; shots: string[]; errors: string[] }[] = [];
let cur: (typeof report)[number];
const note = (s: string) => (console.log(`    ${s}`), cur.notes.push(s));
const fail = (s: string) => ((cur.ok = false), note(`FAIL ${s}`));
const consoleLines: string[] = [];

async function shot(name: string): Promise<void> {
  await sleep(300);
  const f = `${String(report.length).padStart(2, '0')}_${name}.png`;
  await page.screenshot({ path: resolve(out, f) as `${string}.png` });
  cur.shots.push(f);
}
/** Frame intervals / work while the page runs for `ms` (standing still or moving). */
async function sample(ms: number): Promise<Record<string, unknown>> {
  await js(`(cdda.frameStats.reset(), cdda.frameStats.recording = true)`);
  await sleep(ms);
  return js(`(() => {
    const f = cdda.frameStats; f.recording = false;
    const q = (a) => { const s = [...a].sort((x, y) => x - y); const p = (k) => +(s[Math.min(s.length - 1, Math.floor(s.length * k))] ?? 0).toFixed(1); return { n: s.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: p(1) }; };
    const r = cdda.renderer.three.info.render;
    return { interval: q(f.interval), work: q(f.work), calls: r.calls, tris: r.triangles, look: cdda.renderer.lookName ?? undefined };
  })()`);
}
async function bench(label: string, ms = 4000): Promise<void> {
  const p = await sample(ms);
  const renderMs = await js<number | undefined>(`cdda.benchRender?.(30)?.msPerFrame`);
  cur.perf = { ...(cur.perf as object), [label]: { ...p, renderMs } };
  const i = p.interval as { p50: number; p99: number }, w = p.work as { p50: number; p99: number };
  note(`perf ${label}: interval p50 ${i.p50} / p99 ${i.p99} ms, work p50 ${w.p50} / p99 ${w.p99} ms, render ${renderMs?.toFixed?.(2)} ms, ${p.calls} calls, ${p.tris} tris`);
}
const state = () =>
  js<{ lock: boolean; panels: string[]; windows: string[]; x: number; y: number; hp: number; driving: boolean }>(`(() => ({
    lock: !!document.pointerLockElement,
    panels: [...document.querySelectorAll('#ui2 .ui2-win .ui2-title-text')].map((t) => t.textContent),
    windows: [...document.querySelectorAll('.cdda-window > .title')].map((t) => t.textContent),
    x: cdda.game.player.x, y: cdda.game.player.y, hp: cdda.game.player.hp?.torso?.cur ?? 0,
    driving: !!cdda.vehicleSystem?.driving,
  }))()`);
async function until(what: () => Promise<boolean>, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await what()) return true;
    await sleep(100);
  }
  return false;
}
/** Close whatever is open and recapture the mouse like a player (click the view). */
async function toGameplay(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const s = await state();
    if (!s.panels.length && !s.windows.length) break;
    await x.key('Escape');
    await sleep(250);
  }
  if (!(await state()).lock) {
    await sleep(1200);
    await x.click(W / 2, H / 2);
    await until(async () => (await state()).lock, 3000);
  }
}
/** The town nearest the start (look-views.js's choice, so shots compare with docs/LOOKS.md). */
const TOWN = `(() => { const c = cdda, s = c.startLocation(); return c.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0]; })()`;

type Step = [name: string, what: string, run: () => Promise<void>];
const steps: Step[] = [
  ['title', 'title screen → Start (quick start) with real keys → in the shelter, mouse captured', async () => {
    await shot('title');
    await x.click(W / 2, 20);
    await x.key('s');
    await sleep(800);
    await shot('start_picker');
    await x.key('Return');
    const ok = await until(async () => { const s = await state(); return !s.panels.length && s.lock; }, 10_000);
    if (!ok) fail(`quick start did not reach gameplay: ${JSON.stringify(await state())}`);
    await sleep(2500);
    await shot('shelter_first_view');
  }],
  ['shelter', 'the shelter: first-person hands idle, looking around with the mouse, bench', async () => {
    await x.move(-400, 0);
    await sleep(400);
    await x.move(0, 150);
    await sleep(600);
    await shot('shelter_hands');
    await x.move(0, -150);
    await bench('shelter');
  }],
  ['street', 'outside: a residential street at 15:30, walk with W, look around, bench', async () => {
    await js(`(() => { const c = cdda, t = ${TOWN}; c.clearMonsters(80); c.setHour(15.5); c.setWeather('clear'); c.teleportOmt(t.x, t.y); const h = c.findOmt('house', 40); c.teleportOmt(h.x, h.y, 0, 18, -1); c.look(-95, -2); })()`);
    await sleep(3000);
    await shot('street');
    const p0 = await state();
    await x.hold('w', 1500);
    const p1 = await state();
    if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 2) fail(`W for 1.5 s moved ${Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(1)} tiles`);
    await bench('town street');
    await x.move(900, 0);
    await sleep(500);
    await shot('street_turned');
  }],
  ['house', 'into a house: furniture, rooms, set dressing; g opens area loot; Take all by key', async () => {
    await js(`(() => {
      const c = cdda, t = ${TOWN}; c.setHour(11); c.teleportOmt(t.x, t.y); const h = c.findOmt('house', 20);
      const m = c.game.map, X0 = h.x * 24, Y0 = h.y * 24; c.teleportOmt(h.x, h.y, 0, 12, 12); c.settle();
      const indoor = (x, y) => { const q = m.terAt(x, y, 0); return c.renderer.chunks.covered(x, y, 0) && q.move_cost > 0 && !q.flags.includes('WINDOW') && !q.flags.includes('DOOR') && m.furnAt(x, y, 0).id === 'f_null'; };
      let best = null, bs = -1;
      for (let y = Y0 + 3; y < Y0 + 21; y++) for (let x = X0 + 3; x < X0 + 21; x++) { if (!indoor(x, y)) continue; let n = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (indoor(x + dx, y + dy)) n++; if (n > bs) { bs = n; best = [x, y]; } }
      c.teleport(best[0] + 0.5, best[1] + 0.5, 0); c.look(30, -10);
    })()`);
    await sleep(2500);
    await shot('house_room');
    await x.move(1200, 0);
    await sleep(500);
    await shot('house_room2');
    await bench('house');
    await x.key('g');
    await sleep(900);
    await shot('house_area_loot');
    const s = await state();
    if (!s.panels.length) note('g opened nothing here (no loot within reach?)');
    await x.key('r');
    await sleep(700);
    await toGameplay();
  }],
  ['fight', 'first zombie fight (default aim model) with the starting weapon, RMB readied + LMB by real mouse', async () => {
    await js(`(() => { const c = cdda, t = ${TOWN}; c.setHour(13); c.teleportOmt(t.x, t.y); const h = c.findOmt('house', 40); c.teleportOmt(h.x, h.y, 0, 18, -1); c.clearMonsters(60); c.godMode(false); })()`);
    await sleep(1500);
    const aim = await js<string>(`cdda.aimModel?.() ?? cdda.game.aimModel ?? '?'`);
    note(`aim model: ${aim}`);
    await js(`(() => { const uid = cdda.spawnMonster('mon_zombie', -3, 0); window.__z = cdda.game.monsters.all.find((m) => m.uid === uid); cdda.faceMonster?.(uid); })()`);
    await sleep(500);
    await shot('zombie_approach');
    const t0 = Date.now();
    let shots = 0;
    // RMB held through the fight: readies a melee weapon (the default melee control), aims a gun.
    await x.buttonDown(3);
    while (Date.now() - t0 < 20_000) {
      const dead = await js<boolean>(`!window.__z || window.__z.dead`);
      if (dead) break;
      await js(`(() => { const z = window.__z, p = cdda.game.player; p.yaw = Math.atan2(z.x - p.x, -(z.y - p.y)); p.pitch = -0.12; })()`); // aim only; the swing is real input
      await x.clickHere();
      await sleep(450);
      if (shots++ === 2) await shot('zombie_fight');
      if ((await state()).panels.length) await x.key('e');
    }
    await x.buttonUp(3);
    const dead = await js<boolean>(`!window.__z || window.__z.dead`);
    note(`zombie ${dead ? 'killed' : 'still up'} after ${((Date.now() - t0) / 1000).toFixed(1)} s, ${shots} clicks; log: ${(await js<string[]>(`cdda.ui.log().slice(-4)`)).join(' | ')}`);
    await shot('zombie_after');
    await js(`cdda.godMode(true)`);
  }],
  ['drive', 'a car on a road: get in with e, drive with W by key, headlights, chase cam, bench while moving', async () => {
    await js(`(() => { const c = cdda, t = ${TOWN}; c.setHour(17); c.teleportOmt(t.x, t.y); c.roadTrip('car', 4, 40); })()`);
    await sleep(2500);
    let s = await state();
    if (!s.driving) {
      note('roadTrip did not seat the player; walking up and pressing e');
      await js(`cdda.gotoVehicle(undefined, { dist: 0.6, angle: -90 })`);
      await sleep(800);
      await x.key('e');
      await sleep(1000);
      s = await state();
    }
    if (!s.driving) {
      fail('not driving');
      return;
    }
    await shot('car_seated');
    const p0 = await state();
    await js(`(cdda.frameStats.reset(), cdda.frameStats.recording = true)`);
    await x.down('w');
    await sleep(6000);
    await shot('driving');
    await sleep(2000);
    await x.up('w');
    const p = await js(`(() => { const f = cdda.frameStats; f.recording = false; const q = (a) => { const s = [...a].sort((x, y) => x - y); const k = (v) => +(s[Math.min(s.length - 1, Math.floor(s.length * v))] ?? 0).toFixed(1); return { n: s.length, p50: k(0.5), p95: k(0.95), p99: k(0.99), max: k(1) }; }; return { interval: q(f.interval), work: q(f.work) }; })()`);
    const p1 = await state();
    cur.perf = { driving: p };
    note(`drove ${Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(0)} tiles in 8 s; perf ${JSON.stringify(p)}`);
    await x.key('s');
    await x.hold('space', 3000);
    await x.hold('s', 2500);
    await sleep(1000);
    await shot('car_stopped');
  }],
  ['night', 'dusk then night on the street, F toggles the flashlight', async () => {
    const drv = await state();
    if (drv.driving) {
      await x.key('e');
      await sleep(1000);
    }
    await js(`(() => { const c = cdda, t = ${TOWN}; c.settle(); const dusk = c.renderer.sunT ? c.renderer.sunT.sunset - 0.25 : 19; c.setHour(dusk); c.teleportOmt(t.x, t.y); const h = c.findOmt('house', 40); c.teleportOmt(h.x, h.y, 0, 20, -1); c.look(-100, -8); c.flashlight(false); })()`);
    await sleep(2500);
    await shot('dusk');
    await js(`cdda.setHour(23.2)`);
    await sleep(2000);
    await shot('night_dark');
    await x.key('F');
    await sleep(800);
    const on = await js<boolean>(`cdda.renderer.flashlightOn`);
    note(`flashlight after F: ${on}`);
    await shot('night_flashlight');
    await bench('night flashlight');
    await x.key('F');
  }],
  ['forest', 'a forest at 15:00: trees, bushes, ground cover; walk in with W; bench', async () => {
    await js(`(() => { const c = cdda, t = ${TOWN}; c.setHour(15); c.flashlight(false); c.teleportOmt(t.x, t.y); const f = c.findOmt('forest', 60); c.teleportOmt(f.x, f.y, 0, 12, 22); c.look(-20, -3); })()`);
    await sleep(3500);
    await shot('forest');
    await x.hold('w', 1500);
    await bench('forest');
    await x.move(0, -250);
    await sleep(400);
    await shot('forest_up');
  }],
  ['save', 'F5 saves; reload the page; the title loads it (l, Enter); same place, same stuff', async () => {
    const before = await js<{ x: number; y: number; items: number; hour: number }>(`({ x: cdda.game.player.x, y: cdda.game.player.y, items: cdda.game.player.inv.topLevel().length, hour: +cdda.game.clock.hourOfDay.toFixed(2) })`);
    await x.key('F5');
    await sleep(2500);
    await page.goto(page.url().replace(/&?resume=\d/, ''));
    await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
    await sleep(1500);
    await x.click(W / 2, 20);
    await x.key('l');
    await sleep(800);
    await shot('load_menu');
    await x.key('Return');
    const ok = await until(async () => { const s = await state(); return !s.panels.length && !s.windows.length; }, 15_000);
    if (!ok) fail(`load did not reach gameplay: ${JSON.stringify(await state())}`);
    await sleep(3000);
    await toGameplay();
    const after = await js<typeof before>(`({ x: cdda.game.player.x, y: cdda.game.player.y, items: cdda.game.player.inv.topLevel().length, hour: +cdda.game.clock.hourOfDay.toFixed(2) })`);
    note(`before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    if (Math.hypot(after.x - before.x, after.y - before.y) > 1.5 || after.items !== before.items) fail('load did not restore position/items');
    await shot('after_load');
  }],
];

if (argv.includes('--list') || argv.includes('--dry-run')) {
  for (const [n, what] of steps) console.log(`${only && !only.has(n) ? '  (skip)' : '  run   '} ${n.padEnd(8)} ${what}`);
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const { display } = await startXvfb(W + 40, H + 200);
console.log(`Xvfb ${display}, ${browserKind}${gpu ? ' (GPU)' : ''} at ${W}x${H}`);
const vite = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await vite.listen();
const port = (vite.httpServer!.address() as { port: number }).port;
const browser = await launchBrowser(browserKind, W, H, { gpu });
page = (await browser.pages())[0] ?? (await browser.newPage());
x = new XInput(page);
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(String((e as Error).stack ?? e).split('\n').slice(0, 3).join(' ')));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn') consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 400));
});
page.on('dialog', (d) => void d.accept());
await page.goto(`http://127.0.0.1:${port}/?seed=1&realinput=1&menu=1${extraParams ? `&${extraParams}` : ''}`);
await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
await fitWindow(page, browserKind, W, H);
await page.evaluate(() => localStorage.clear());
const gl = await js<string>(`(() => { const g = cdda.renderer.three.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })()`);
console.log(`WebGL: ${gl}`);
for (const [name, what, run] of steps) {
  if (only && !only.has(name)) continue;
  cur = { step: name, ok: true, notes: [], shots: [], errors: [] };
  report.push(cur);
  console.log(`\n\x1b[1m${name}\x1b[0m — ${what}`);
  const e0 = pageErrors.length, c0 = consoleLines.length;
  try {
    await run();
  } catch (e) {
    fail(String((e as Error).stack ?? e).split('\n').slice(0, 3).join(' '));
  }
  cur.errors = [...pageErrors.slice(e0), ...consoleLines.slice(c0)];
  if (pageErrors.length > e0) cur.ok = false;
  for (const l of cur.errors.slice(0, 5)) console.log(`    ! ${l}`);
}
writeFileSync(resolve(out, 'report.json'), JSON.stringify({ browser: browserKind, gpu, size: [W, H], webgl: gl, report }, null, 1));
const bad = report.filter((r) => !r.ok);
console.log(`\n${report.length - bad.length}/${report.length} steps ok${bad.length ? `: failed ${bad.map((r) => r.step).join(', ')}` : ''}; ${pageErrors.length} page errors, ${consoleLines.length} console errors/warnings. ${out}/report.json`);
await browser.close();
await vite.close();
process.exit(bad.length || pageErrors.length ? 1 : 0);

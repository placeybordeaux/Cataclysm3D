// Real-input UX regression: plays the game the way a person does — OS-level keys and mouse
// through xdotool into a real (windowed) Chromium on a private Xvfb display — and checks the
// things that broke when QA only drove the debug API: pointer lock through menus, Esc,
// fullscreen, focus loss, held/stuck keys, key repeat, CapsLock, AZERTY, mouse in menus,
// rebinding. `cdda.*` is used only for setup (giving items) and for reading state.
//
//   nix-shell --run '~/claude-stuff/bin/heavy --mem 2.5 --name realinput -- npx tsx tools/realinput.ts'
//   options: --only title,esc,azerty   run some scenarios (names in the list at the bottom)
//            --shots shots/realinput   screenshot every menu it opens
//            --size 960x540            viewport (default)
//            --list                    print scenario names
//            --dry-run                 print what would run, start nothing
//
// Exit code 1 if any check fails. Needs Xvfb, xdotool, setxkbmap (shell.nix).

import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startXvfb, XInput } from './lib/realinput';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: tsx tools/realinput.ts [--only a,b] [--shots dir] [--size WxH] [--list] [--dry-run]  (see header)');
  process.exit(0);
}
const [W, H] = opt('--size', '960x540').split('x').map(Number);
const shotsDir = argv.includes('--shots') ? opt('--shots', 'shots/realinput') : '';
const only = argv.includes('--only') ? new Set(opt('--only', '').split(',')) : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ reporting
const results: { scenario: string; name: string; ok: boolean; detail: string }[] = [];
let scenario = '';
function check(name: string, ok: boolean, detail: unknown = ''): boolean {
  results.push({ scenario, name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok || !detail ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
}

// ------------------------------------------------------------------ page helpers
let page: Page;
let x: XInput;
interface State {
  lock: boolean; focus: boolean; fullscreen: boolean; windows: string[]; captured: boolean; held: string[];
  lockPaused: boolean; hint: boolean; x: number; y: number; yaw: number; running: boolean; deathScreen: boolean;
  /** ui2 window titles (progression's Start / New Game / Journal) and visible toast titles. */
  panels: string[]; toasts: string[];
  /** ui2 window ids (scr.character, scr.map, …) and whether the look card (x) is up. */
  panelIds: string[]; look: boolean;
}
const state = (): Promise<State> =>
  page.evaluate(() => {
    const g = (window as any).cdda?.game;
    const hint = document.querySelector('.resume-hint') as HTMLElement | null;
    return {
      lock: !!document.pointerLockElement, focus: document.hasFocus(), fullscreen: !!document.fullscreenElement,
      windows: [...document.querySelectorAll('.cdda-window > .title')].map((t) => t.textContent ?? ''),
      captured: !!g?.input.captured, held: g ? [...g.input.held] : [], lockPaused: !!g?.lockPaused,
      hint: !!hint && hint.style.display !== 'none',
      x: g?.player.x ?? 0, y: g?.player.y ?? 0, yaw: g?.player.yaw ?? 0, running: !!g?.player.running,
      deathScreen: !!document.querySelector('.death-screen'),
      panels: [...document.querySelectorAll('#ui2 .ui2-win .ui2-title-text')].map((t) => t.textContent ?? ''),
      toasts: [...document.querySelectorAll('#ui2 .ui2-toast:not(.leaving) .ui2-toast-title')].map((t) => t.textContent ?? ''),
      panelIds: [...document.querySelectorAll('#ui2 .ui2-win')].map((w) => (w as HTMLElement).dataset.id ?? ''),
      look: !!document.querySelector('#ui2 .lk-card.mode-look'),
    };
  });
const js = <T>(code: string): Promise<T> => page.evaluate(code) as Promise<T>;
const log = (): Promise<string[]> => js<string[]>('cdda.ui.log()');
let shotN = 0;
async function shot(name: string): Promise<void> {
  if (!shotsDir) return;
  mkdirSync(resolve(shotsDir), { recursive: true });
  await sleep(250);
  await page.screenshot({ path: resolve(shotsDir, `${String(++shotN).padStart(2, '0')}_${name.replace(/[^a-z0-9]+/gi, '_')}.png`) as `${string}.png` });
}
/** Wait until the page reports the condition (or time out). */
async function until(what: (s: State) => boolean, ms = 3000): Promise<State> {
  const end = Date.now() + ms;
  let s = await state();
  while (!what(s) && Date.now() < end) {
    await sleep(80);
    s = await state();
  }
  return s;
}
/** Back to plain gameplay with the mouse captured. Chrome refuses a re-lock for ~1 s after an Esc unlock. */
async function toGameplay(): Promise<State> {
  let s = await state();
  for (let i = 0; i < 8 && (s.windows.length || s.panels.length || s.look); i++) {
    const n = s.windows.length + s.panels.length + Number(s.look);
    await x.key(i % 2 ? 'Escape' : 'Backspace');
    s = await state();
    if (s.windows.length + s.panels.length + Number(s.look) === n && i % 2) check(`${[...s.windows, ...s.panels].pop()} closes on Backspace or Esc`, false, [s.windows, s.panels]);
  }
  if (!s.lock) {
    await sleep(1400);
    await x.click(W / 2, H / 2);
    s = await until((t) => t.lock);
  }
  return s;
}
const center = async (sel: string): Promise<[number, number] | null> =>
  page.evaluate((q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x + Math.min(40, r.width / 2)), Math.round(r.y + r.height / 2)] as [number, number];
  }, sel);

/** Title → Start → Enter: the quick start (named Evacuee). Returns the state in gameplay. */
async function quickStart(): Promise<State> {
  // The click gives the page keyboard focus (xdotool types into whatever has it).
  await x.click(W / 2, 20);
  await x.key('s');
  await until((t) => t.panels.includes('Start'), 3000);
  await x.key('Return');
  const s = await until((t) => !t.panels.length && t.lock, 8000);
  if (s.panels.length || !s.lock) console.log('quick start did not reach the game:', s);
  return s;
}

// ------------------------------------------------------------------ scenarios
type Scenario = [name: string, what: string, run: () => Promise<void>];
const scenarios: Scenario[] = [
  ['title', 'title screen → Start (quick start) → typed name → gameplay captures the mouse; first tip shows', async () => {
    let s = await state();
    check('title screen has a free cursor', !s.lock && s.captured, s);
    const nb = await center('.mm-item[data-i="0"]');
    await x.click(nb![0], nb![1]);
    s = await until((t) => t.panels.includes('Start'), 3000);
    check('clicking Start opens the quick start (no character creator)', s.panels.includes('Start') && !s.windows.includes('New Character'), s);
    await shot('quickstart');
    const focused = await js<boolean>(`document.activeElement?.dataset?.testid === 'name'`);
    check('the name field has focus', focused);
    await x.key('ctrl+a');
    await x.type('Ada Tester');
    await x.key('Return');
    s = await until((t) => !t.panels.length && t.lock, 8000);
    check('Enter starts the game and captures the mouse', !s.panels.length && s.lock, s);
    check('no hints popup in the way', !s.windows.length, s.windows);
    const name = await js<string>('cdda.game.player.name');
    check('the typed name is the survivor', name === 'Ada Tester', name);
    const kit = await js<string[]>('cdda.game.player.inv.allItems().map((i) => i.typeId)');
    check('the Evacuee kit is carried (pocket knife, lighter, bag)', ['pockknife', 'lighter', 'mbag'].every((k) => kit.includes(k)), kit);
    s = await until((t) => t.toasts.includes('Search for supplies'), 6000);
    check('the first discovery tip shows', s.toasts.includes('Search for supplies'), s.toasts);
    await shot('first_tip');
  }],
  ['onboarding', 'first minutes: tips wait out fights, unlock toast, craft nudge + badge, journal (J)', async () => {
    await toGameplay();
    await js(`cdda.godMode(true)`);
    // Setup: a zombie a few steps away (a fight: the tip must wait).
    // (hp lowered so a few fist blows finish it; the fight itself is the combat suites' job)
    await js(`(() => { const uid = cdda.spawnMonster('mon_zombie', 0, -3); const m = cdda.game.monsters.all.find((z) => z.uid === uid); if (m) m.hp = 6; return uid; })()`);
    await sleep(1500);
    const q = await js<{ queue: string[]; blocked: boolean }>('cdda.progression.queue()');
    check('a zombie close by blocks tips (queued, not shown)', q.blocked && !(await state()).toasts.includes('Zombie!'), q);
    // Kill it with real clicks (aiming is setup: face it).
    for (let i = 0; i < 60 && (await js<number>('cdda.game.monsters.visibleHostiles(8).length')) > 0; i++) {
      await js(`(() => { const m = cdda.game.monsters.visibleHostiles(8)[0]; if (m) { const p = cdda.game.player; p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = -0.1; } })()`);
      await x.click(W / 2, H / 2);
      await sleep(400);
    }
    const kills = await js<number>(`cdda.progression.stat('zombie_kills')`);
    check('killing a zombie counts toward unlocks', kills >= 1, kills);
    let s = await until((t) => t.toasts.some((m) => /Security Guard/.test(m)), 4000);
    check('the unlock toasts in-run', s.toasts.some((m) => /Security Guard/.test(m)), s.toasts);
    await shot('unlock_toast');
    // Setup: a long stick makes a recipe craftable; the nudge waits for calm and the 20 s gap.
    await js(`cdda.giveItem('stick_long')`);
    await js(`cdda.progression.checkCraftable()`);
    // Up to three 20 s gaps: other first-time tips (zombie, cold…) may be queued ahead.
    s = await until((t) => t.toasts.some((m) => /craft|recipes/i.test(m)), 75000);
    check('a "you could craft" nudge shows (after the calm/gap)', s.toasts.some((m) => /craft|recipes/i.test(m)), { toasts: s.toasts, q: await js('cdda.progression.queue()') });
    const badge = await js<number>('cdda.progression.queue().badge');
    check('the crafting key gets a badge', badge >= 1, badge);
    await shot('craft_nudge');
    await x.key('ampersand');
    s = await until((t) => t.windows.length > 0, 1500);
    check('& opens crafting', s.windows.includes('Crafting'), s.windows);
    check('…and clears the badge', (await js<number>('cdda.progression.queue().badge')) === 0);
    await x.key('ampersand');
    await until((t) => !t.windows.length, 1500);
    await x.key('J');
    s = await until((t) => t.panels.includes('Survival Journal'), 2000);
    check('J opens the survival journal', s.panels.includes('Survival Journal'), s.panels);
    const tips = await js<string>(`document.querySelector('[data-testid=journal-list]')?.textContent ?? ''`);
    check('the journal lists the tips met so far', /Search for supplies/.test(tips) && /Zombie!/.test(tips), tips.slice(0, 160));
    await shot('journal');
    await x.key('Right');
    await x.key('Right');
    await x.key('Right');
    await sleep(200);
    const unl = await js<string>(`document.querySelector('[data-testid=journal-list]')?.textContent ?? ''`);
    check('the Unlocks tab shows progress ("Kill 10 zombies 1/10")', /Kill 10 zombies/.test(unl) && /1\/10/.test(unl), unl.slice(0, 200));
    await shot('journal_unlocks');
    await x.key('J');
    s = await until((t) => !t.panels.length && t.lock, 2000);
    check('J closes it and mouse-look is back', !s.panels.length && s.lock, s);
    await js(`cdda.godMode(false)`);
  }],
  ['newgame', 'New Game: start picker, locked cards, Classic mode opens the full creator', async () => {
    // Setup only: a clean profile, back at the title.
    await js(`(() => { cdda.progression.reset(); localStorage.removeItem('cdda3d.achievements'); return 1; })()`);
    dialogs.length = 0;
    await page.goto(page.url());
    await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 });
    await x.click(W / 2, 20);
    await x.key('n');
    let s = await until((t) => t.panels.includes('New Game'), 3000);
    check('n opens the start picker', s.panels.includes('New Game'), s);
    await shot('picker');
    const cards = await js<{ id: string; locked: boolean }[]>(`[...document.querySelectorAll('#ui2 .pg-card')].map((c) => ({ id: c.dataset.unlock, locked: c.classList.contains('locked') }))`);
    check('only the Evacuee is open on a fresh profile', cards.filter((c) => !c.locked).map((c) => c.id).join() === 'start_evacuee', cards);
    check('locked starts are shown (what to aim for)', cards.filter((c) => c.locked).length > 10, cards.length);
    const cop = await center('#ui2 .pg-card[data-unlock="prof_cop"]');
    await x.click(cop![0], cop![1]);
    await sleep(200);
    const detail = await js<string>(`document.querySelector('#ui2 .pg-detail')?.textContent ?? ''`);
    check('a locked card shows its requirement with progress', /Kill 10 zombies/.test(detail) && /0\/10/.test(detail), detail.slice(0, 200));
    await x.key('Return');
    s = await state();
    check('Enter on a locked card does nothing', s.panels.includes('New Game'), s.panels);
    await x.key('Escape');
    s = await until((t) => !t.panels.length, 2000);
    check('Esc backs out to the title', !s.panels.length && !s.lock, s);
    // Setup: Classic mode through the profile (Options has the same toggle).
    await js(`cdda.progression.classic(true)`);
    await x.key('n');
    await until((t) => t.panels.includes('New Game'), 3000);
    const open = await js<number>(`document.querySelectorAll('#ui2 .pg-card:not(.locked)').length`);
    check('Classic mode opens every start', open >= 17, open);
    await x.key('End');
    await x.key('Return');
    s = await until((t) => t.windows.includes('New Character'), 3000);
    check('the Custom survivor card opens the full character creator', s.windows.includes('New Character'), s.windows);
    await shot('creator');
    await x.key('F');
    await until((t) => t.windows.includes('Confirm'), 3000);
    await x.key('y');
    await sleep(300);
    s = await state();
    if (s.windows.includes('Confirm')) await x.key('y');
    s = await until((t) => !t.windows.length && t.lock, 8000);
    check('finishing the creator starts the game with the mouse captured', !s.windows.length && s.lock, s);
    await js(`cdda.progression.classic(false)`);
  }],
  ['move', 'Shift+W runs (never opens Wear), mouse looks, WASD never trigger actions', async () => {
    await toGameplay();
    // Setup only: something to wear so the Wear menu *could* open.
    await js(`cdda.giveItem('jacket_light')`);
    let s0 = await state();
    await x.down('Shift');
    await x.hold('w', 700);
    let s = await state();
    await x.up('Shift');
    check('Shift+W moves forward while running', s.running && Math.hypot(s.x - s0.x, s.y - s0.y) > 0.3, { ran: s.running, moved: Math.hypot(s.x - s0.x, s.y - s0.y) });
    check('Shift+W opened no menu', !s.windows.length, s.windows);
    for (const k of ['Shift+a', 'Shift+s', 'Shift+d', 'a', 's', 'd', 'space']) await x.key(k, 40);
    s = await state();
    check('Shift/plain A S D and Space open nothing', !s.windows.length, s.windows);
    s0 = await state();
    await x.move(250, 0);
    s = await state();
    check('mouse motion turns the view when captured', Math.abs(s.yaw - s0.yaw) > 0.2, { yaw0: s0.yaw, yaw: s.yaw });
    await x.key('i');
    s0 = await state();
    await x.move(250, 0);
    s = await state();
    check('mouse motion is ignored while a menu is open', Math.abs(s.yaw - s0.yaw) < 1e-6 && s.windows.length > 0);
    await x.key('i');
  }],
  ['menus', 'every menu key opens its screen and the same key closes it, keeping the lock', async () => {
    await toGameplay();
    // Setup only: one of everything the pickers need.
    await js(`(() => { for (const id of ['granola', 'bandages', 'crowbar', 'manual_mechanics', 'rock']) cdda.giveItem(id); cdda.learnAll?.(); })()`);
    const keys: [string, string][] = [
      ['i', 'Inventory'], ['z', 'Wield what?'], ['O', 'Wear what?'], ['T', 'Take off what?'], ['E', 'Consume item'], ['u', 'Use item'],
      ['R', 'Read what?'], ['&', 'Crafting'], ['*', 'Construction'], ['(', 'Disassemble item:'], ['@', 'ui2:scr.character'], ['m', 'ui2:scr.map'],
      ['P', 'ui2:scr.log'], ['?', 'ui2:scr.help'], [')', ''], ['p', ''], ['[', ''], ['_', ''], ['M', ''], ['x', 'look'], ['q', 'Drop which items?'],
      ['|', ''], ['$', ''], ['C', ''], ['B', ''],
    ];
    // Legacy curses windows (.cdda-window), ui2 screens (title 'ui2:<window id>') and the look card.
    const opened = (t: State) => t.windows.length + t.panels.length + Number(t.look);
    for (const [k, title] of keys) {
      const before = (await log()).length;
      await x.key(k);
      let s = await until((t) => opened(t) > 0, 1200);
      const msgs = (await log()).slice(before);
      if (!opened(s)) {
        // Not every key opens a window (nothing to butcher here); it must at least say something.
        check(`${k}: no window, but a message says why`, msgs.length > 0, msgs.length ? msgs.join(' / ') : 'no window and no message');
        continue;
      }
      const ui2 = !s.windows.length;
      const top = s.look ? 'look' : ui2 ? `ui2:${s.panelIds[s.panelIds.length - 1]}` : s.windows[s.windows.length - 1];
      check(`${k} opens ${title || top}`, !title || top === title, [s.windows, s.panelIds, s.look]);
      if (ui2) check(`${k}: the cursor is free for pointing`, !s.lock, s);
      await shot(`menu_${top || k}`);
      if (!s.look) {
        const sel = ui2 ? '#ui2 .ui2-win' : '.cdda-window';
        const legend = await js<string>(`[...document.querySelectorAll('${ui2 ? '#ui2 .ui2-win .ui2-footer' : '.cdda-window .footer'}')].pop()?.textContent ?? ''`);
        check(`${k}: footer names the close keys`, /Esc/.test(legend), legend);
        const overflowX = await js<boolean>(`(() => { const w = [...document.querySelectorAll('${sel}')].pop(); const r = w.getBoundingClientRect(); return r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1; })()`);
        check(`${k}: window fits the ${W}x${H} screen`, !overflowX);
      }
      await x.key(k);
      s = await until((t) => !opened(t) && (!ui2 || t.lock), 1500);
      if (opened(s)) {
        // A second-level window (item action menu, confirm) — fall back to Backspace.
        check(`${k} closes ${top} again`, false, [s.windows, s.panelIds]);
        await toGameplay();
      } else check(`${k} closes ${top} again, mouse ${ui2 ? 'captured again' : 'still captured'}`, s.lock, s);
    }
  }],
  ['esc', 'Esc: pause menu, Esc in a menu, resuming by key and by click', async () => {
    await toGameplay();
    await x.key('Escape');
    let s = await until((t) => t.panelIds.includes('scr.esc'));
    check('Esc in gameplay opens the pause menu', s.panelIds.includes('scr.esc'), [s.windows, s.panelIds]);
    check('…and the cursor is free (browser Esc)', !s.lock);
    const t0 = await js<number>('cdda.game.clock.seconds');
    await sleep(600);
    check('the pause menu stops time', (await js<number>('cdda.game.clock.seconds')) === t0);
    const sel = await js<string>(`document.querySelector('#ui2 .esc-col .ui2-btn.sel')?.textContent ?? ''`);
    check('pause menu highlights Resume even with the cursor resting on it', /Resume/.test(sel), sel);
    await shot('esc_menu');
    await sleep(1400);
    await x.key('r');
    s = await until((t) => t.lock);
    check('r (Resume) closes it and recaptures the mouse', !s.panels.length && s.lock, { s, refusals: await js('cdda.game.input.lockRefusals'), now: await js('performance.now()') });
    await x.key('i');
    await x.key('Escape');
    s = await until((t) => !t.windows.length && t.hint);
    check('Esc inside a menu closes that menu (not the game)', !s.windows.length, s.windows);
    check('…and gameplay pauses behind the resume hint', s.hint && s.lockPaused, s);
    await sleep(1400);
    await x.key('w');
    s = await until((t) => t.lock);
    check('any key resumes mouse-look', s.lock && !s.hint, { s, refusals: await js('cdda.game.input.lockRefusals'), now: await js('performance.now()') });
    await x.key('Escape');
    await sleep(1400);
    await until((t) => t.panelIds.includes('scr.esc'));
    const r = await center('#ui2 .esc-col .ui2-btn[data-i="0"]');
    await x.click(r![0], r![1]);
    s = await until((t) => t.lock);
    check('clicking Resume closes the menu and recaptures', !s.panels.length && s.lock, s);
    await x.key('Escape');
    await until((t) => t.panelIds.includes('scr.esc'));
    await sleep(300);
    await x.key('Escape');
    s = await until((t) => !t.panels.length && t.hint);
    check('Esc twice: menu opens and closes; hint says how to resume', !s.panels.length && s.hint, s);
    await sleep(1400);
    await x.click(W / 2, H / 2);
    s = await until((t) => t.lock);
    const attacked = (await log()).slice(-2).join(' ');
    check('a click on the paused view only resumes (no attack)', s.lock && !/You (miss|hit|swing)/.test(attacked), attacked);
    // Chrome refuses a re-lock for 1.25 s after an Esc unlock; a key pressed sooner must still
    // resume once that's over (Input retries within the key's activation window).
    await x.key('i');
    await x.key('Escape');
    await until((t) => !t.windows.length);
    await x.key('w');
    s = await until((t) => t.lock, 2500);
    check('a key pressed right after Esc resumes once Chrome allows it', s.lock, { s, refusals: await js('cdda.game.input.lockRefusals') });
  }],
  ['keys', 'held keys, repeats, stuck keys, CapsLock', async () => {
    await toGameplay();
    await x.down('w');
    await sleep(250);
    await x.key('i');
    await x.up('w');
    await x.key('i');
    const s0 = await state();
    await sleep(500);
    let s = await state();
    check('W released inside a menu does not keep walking', Math.hypot(s.x - s0.x, s.y - s0.y) < 0.05 && !s.held.includes('KeyW'), { held: s.held, moved: Math.hypot(s.x - s0.x, s.y - s0.y) });
    await x.hold('i', 1200);
    s = await state();
    check('holding i keeps the inventory open (repeats ignored)', s.windows.includes('Inventory'), s.windows);
    await x.key('i');
    await x.key('Caps_Lock');
    await x.key('i');
    s = await until((t) => t.windows.length > 0, 800);
    check('CapsLock on: i still opens the inventory', s.windows.includes('Inventory'), s.windows);
    await x.key('i');
    await x.key('Caps_Lock');
    s = await state();
    check('back to gameplay', !s.windows.length, s.windows);
  }],
  ['focus', 'focus loss (tab switch) pauses without closing menus', async () => {
    await toGameplay();
    await x.key('i');
    await page.bringToFront();
    const other = await page.browser().newPage();
    await other.bringToFront();
    await sleep(800);
    await other.close();
    await page.bringToFront();
    let s = await state();
    check('menu still open after a tab switch', s.windows.includes('Inventory'), s.windows);
    await x.key('i');
    s = await state();
    check('closing it recaptures (or shows the resume hint)', s.lock || s.hint, s);
    await toGameplay();
    const o2 = await page.browser().newPage();
    await o2.bringToFront();
    await sleep(800);
    await o2.close();
    await page.bringToFront();
    s = await state();
    check('tab switch in gameplay: paused behind the hint, no menu forced open', s.hint && !s.windows.length, s);
  }],
  ['fullscreen', 'F11 fullscreen: Esc works in menus without losing the mouse; hold Esc leaves', async () => {
    await toGameplay();
    await x.key('F11');
    let s = await until((t) => t.fullscreen, 2000);
    check('F11 enters fullscreen', s.fullscreen, s);
    await x.key('Escape');
    s = await until((t) => t.windows.length > 0);
    check('Esc opens the pause menu and keeps the mouse captured', s.windows.length === 1 && s.lock, s);
    await x.key('Escape');
    s = await until((t) => !t.windows.length);
    check('Esc closes it, still captured', !s.windows.length && s.lock, s);
    await x.key('i');
    await x.key('Escape');
    s = await state();
    check('Esc closes the inventory, still captured', !s.windows.length && s.lock, s);
    await x.hold('Escape', 2700);
    s = await until((t) => !t.fullscreen, 1500);
    check('holding Esc leaves fullscreen (menu opened once, no flicker)', !s.fullscreen && s.windows.length === 1, s);
    await toGameplay();
  }],
  ['freecursor', 'Options > Menu cursor = free: menus show the cursor and take clicks', async () => {
    await toGameplay();
    await js(`cdda.game.input.menuCursor = 'free'`);
    await x.key('i');
    let s = await until((t) => !t.lock);
    check('opening a menu frees the cursor', !s.lock && s.windows.includes('Inventory'), s);
    check('…without pausing behind the hint or opening the pause menu', !s.hint && s.windows.length === 1, s);
    const row = await center('.cdda-window .menu-entry[data-i]');
    await x.click(row![0], row![1]);
    s = await state();
    check('clicking an item opens its action menu', s.windows.length === 2, s.windows);
    await x.key('Backspace');
    await x.key('i');
    s = await until((t) => t.lock);
    check('closing the last menu recaptures the mouse', !s.windows.length && s.lock, s);
    await js(`cdda.game.input.menuCursor = 'captured'`);
  }],
  ['azerty', 'AZERTY: ZQSD moves; stand-ins for wield/drop; hints say ZQSD', async () => {
    await toGameplay();
    x.layout('fr');
    try {
      const s0 = await state();
      await x.hold('z', 500); // physical W on AZERTY
      let s = await state();
      check('z (physical W) walks forward, opens nothing', Math.hypot(s.x - s0.x, s.y - s0.y) > 0.2 && !s.windows.length, s);
      await x.key('q');
      s = await state();
      check('q (physical A) strafes, does not open Drop', !s.windows.length, s.windows);
      await x.key('w'); // physical Z: wield stand-in
      s = await until((t) => t.windows.length > 0, 800);
      check('w (stand-in) opens Wield', s.windows.includes('Wield what?'), s.windows);
      await x.key('Backspace');
      await x.key('a'); // physical Q: drop stand-in
      s = await until((t) => t.windows.length > 0, 800);
      check('a (stand-in) opens Drop', s.windows.includes('Drop which items?'), s.windows);
      await x.key('Backspace');
      const label = await js<string>('cdda.game.keys.movementKeys()');
      check('movement is labelled ZQSD', label === 'ZQSD', label);
    } finally {
      x.layout('us');
    }
  }],
  ['craft', 'crafting: & closes it; nested groups back out with Esc', async () => {
    await toGameplay();
    await x.key('&');
    let s = await until((t) => t.windows.includes('Crafting'));
    check('& opens crafting', s.windows.includes('Crafting'), s.windows);
    await x.key('&');
    s = await state();
    check('& closes crafting', !s.windows.length, s.windows);
  }],
  ['rebind', 'Options > Key bindings: rebind wear to y; movement keys refused; reset', async () => {
    await toGameplay();
    await js(`cdda.giveItem('jacket_light')`); // setup: something the Wear menu can list
    await x.key('Escape');
    await until((t) => t.panelIds.includes('scr.esc'));
    await x.key('o');
    let s = await until((t) => t.panels.includes('Options'));
    check('pause menu → o opens Options', s.panels.includes('Options'), s.panels);
    await shot('options');
    await x.key('Enter'); // first entry: Key bindings…
    s = await until((t) => t.panels.includes('Key bindings'));
    check('Enter on the first entry opens Key bindings', s.panels.includes('Key bindings'), s.panels);
    await shot('keybindings');
    const idx = await js<number>(`cdda.game.keys.actionList().findIndex((a) => a.id === 'wear')`);
    await x.key(`Down*${idx}`, 30);
    await x.key('Enter');
    await x.key('Shift+w');
    const status = `document.querySelector('[data-testid=keys-status]')?.textContent ?? ''`;
    let flash = await js<string>(status);
    check('binding Shift+W is refused as a movement key', /moves you/.test(flash), flash);
    await x.key('Enter');
    await x.key('y');
    flash = await js<string>(status);
    check('wear is now y', await js<string>(`cdda.game.keys.label('wear')`) === 'y', flash);
    await x.key('Backspace');
    await x.key('Backspace');
    s = await state();
    check('Backspace steps back: Key bindings, then Options, leaving the pause menu', s.panelIds.join() === 'scr.esc', s.panelIds);
    await x.key('Backspace');
    s = await toGameplay();
    await x.key('y');
    s = await until((t) => t.windows.length > 0, 800);
    check('y opens the Wear menu in game', s.windows.includes('Wear what?'), s.windows);
    await x.key('y');
    s = await state();
    check('…and y closes it', !s.windows.length, s.windows);
    const stored = await js<string>(`localStorage.getItem('cdda3d.keys')`);
    check('the rebind is stored', /"wear":\["y"\]/.test(stored ?? ''), stored);
    await js(`cdda.game.keys.resetBindings()`);
  }],
  ['mouse', 'LMB attacks when captured; wheel zooms the top-down camera', async () => {
    await toGameplay();
    await js(`cdda.giveItem('crowbar', { wield: true })`);
    const before = (await log()).length;
    await x.clickHere(1);
    await sleep(600);
    const msgs = (await log()).slice(before);
    check('LMB swings the weapon', msgs.length > 0, msgs.join(' / ') || 'no message');
    await x.key('v');
    await x.key('v');
    const mode = await js<string>(`cdda.renderer?.cameraMode ?? ''`);
    const d0 = await js<number>(`cdda.renderer?.rig?.topDistance ?? -1`);
    await x.wheel('down', 3);
    await sleep(200);
    const d1 = await js<number>(`cdda.renderer?.rig?.topDistance ?? -1`);
    check('wheel zooms in top-down view', mode !== 'top' || d1 !== d0, { mode, d0, d1 });
    await x.key('v');
  }],
  ['ui2', 'ui2 preview: Tab frees the cursor (no resume hint), drag & drop, context menu, Tab re-captures', async () => {
    await toGameplay();
    type U = { surfaces: number; tacticalPause: boolean; locked: boolean; panels: string[]; menu: string[][] };
    const u = () => js<U>('cdda.ui2.state()');
    const where = (t: string) => js<string[]>(`(() => { const o = []; cdda.ui2.mock().model.store.walk((it, loc) => it.typeId === ${JSON.stringify(t)} && o.push(loc)); return o; })()`);
    await x.key('Tab');
    await sleep(500);
    let s = await state();
    let v = await u();
    check('Tab opens the ui2 inventory with a free cursor', v.panels.includes('inv.equip') && !s.lock, { v, lock: s.lock });
    check('…without the "click to resume" hint', !s.hint && !s.lockPaused, s);
    check('…and the tactical pause on (Accessible default)', v.tacticalPause, v);
    await shot('ui2_inventory');
    // Drag the first ground item into the backpack with real mouse down / move / up.
    const from = await center('[data-id="inv.ground"] .ui2-cell');
    const to = await center('[data-id="inv.back"] .ui2-container');
    const typeId = await js<string>(`cdda.ui2.mock().model.contents('ground')[0].typeId`);
    await x.moveTo(from![0], from![1], 2);
    await x.buttonDown(1);
    await x.moveTo(to![0], to![1], 12);
    await x.buttonUp(1);
    await sleep(200);
    const locs = await where(typeId);
    check(`dragging ${typeId} from the ground into the backpack moves it`, locs.length > 0 && locs.every((l) => l.startsWith('in:')), locs);
    // Right-click an item: context menu with timed actions; Esc closes only the menu.
    const cell = await center('[data-id="inv.back"] .ui2-cell');
    await x.click(cell![0], cell![1], 3);
    await sleep(200);
    v = await u();
    check('right-click opens the item context menu', v.menu.length === 1 && v.menu[0].length > 2, v.menu);
    await x.key('Escape');
    v = await u();
    check('Esc closes the menu, the windows stay', !v.menu.length && v.panels.includes('inv.equip'), v);
    await x.key('Tab');
    s = await until((t) => t.lock, 3000);
    v = await u();
    check('Tab closes it and re-captures the mouse', !v.surfaces && s.lock && !v.tacticalPause, { v, lock: s.lock });
    // Classic: time keeps running with the inventory open.
    await js('cdda.ui2.settings.pauseInInventory = false; cdda.ui2.saveSettings()');
    await x.key('Tab');
    const t0 = await js<number>('cdda.game.clock.seconds');
    await sleep(1200);
    const t1 = await js<number>('cdda.game.clock.seconds');
    v = await u();
    check('with Pause in inventory off, game time runs while it is open', v.surfaces > 0 && !v.tacticalPause && t1 > t0, { t0, t1, v });
    await x.key('Tab');
    await js('cdda.ui2.settings.pauseInInventory = true; cdda.ui2.saveSettings()');
    const p0 = await js<number>('cdda.game.clock.seconds');
    await x.key('Tab');
    await sleep(1200);
    const p1 = await js<number>('cdda.game.clock.seconds');
    check('with it on (default), game time stops', p1 === p0, { p0, p1 });
    await x.key('Tab');
    await until((t) => t.lock, 3000);
  }],
  ['save', 'F5 saves; leaving the page asks first; title Load/Memorial screens', async () => {
    await toGameplay();
    const before = (await log()).length;
    await x.key('F5');
    await sleep(1500);
    const msgs = (await log()).slice(before);
    check('F5 says the game was saved (and does not reload the page)', msgs.some((m) => /saved/i.test(m)), msgs);
    dialogs.length = 0;
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 });
    check('reloading mid-game asked "Leave site?" first', dialogs.includes('beforeunload'), dialogs);
    await x.click(W / 2, 20);
    await x.key('l');
    let s = await until((t) => t.windows.length > 0, 3000);
    check('title: l opens the Load menu', s.windows.includes('Load game'), s.windows);
    await shot('load_menu');
    await x.key('Backspace');
    s = await state();
    check('Backspace leaves it', !s.windows.length, s.windows);
    // Back into a game for the scenarios that follow.
    await quickStart();
  }],
  ['screens', 'modern HUD, map (drag, wheel, note, destination → compass), look card, character sheet tabs', async () => {
    await toGameplay();
    // --- HUD: needs light up only when they matter
    const need = (id: string) => js<string>(`document.querySelector('[data-testid=hud-needs] [data-need=${id}]')?.dataset.level ?? 'none'`);
    check('the modern HUD shows the vitals', await js<boolean>(`!!document.querySelector('[data-testid=hud-vitals]')?.offsetWidth`));
    check('thirst starts dim', (await need('thirst')) === '0', await need('thirst'));
    await js(`cdda.game.player.thirst = 700`); // setup: parched
    await sleep(600);
    check('parched: the thirst icon is an emergency', (await need('thirst')) === '3', await need('thirst'));
    await js(`cdda.game.player.thirst = 0`);
    // --- map
    await x.key('m');
    let s = await until((t) => t.panelIds.includes('scr.map'), 2000);
    check('m opens the map with a free cursor', s.panelIds.includes('scr.map') && !s.lock, s.panelIds);
    const view = () => js<string>(`document.querySelector('[data-id="scr.map"]')?.dataset.view ?? ''`);
    const v0 = await view();
    const r = await page.evaluate(() => {
      const e = document.querySelector('[data-testid=map-view]')!.getBoundingClientRect();
      return { x: Math.round(e.x + e.width / 2), y: Math.round(e.y + e.height / 2) };
    });
    await x.moveTo(r.x, r.y);
    await x.buttonDown(1);
    await x.moveTo(r.x + 120, r.y + 60, 6);
    await x.buttonUp(1);
    await sleep(200);
    const v1 = await view();
    check('dragging pans the map', v0.split(',')[0] !== v1.split(',')[0] && v0.split(',')[1] !== v1.split(',')[1], { v0, v1 });
    await x.wheel('down', 2);
    await sleep(200);
    const v2 = await view();
    check('the wheel zooms out', Number(v2.split(',')[3]) < Number(v1.split(',')[3]), { v1, v2 });
    await x.wheel('up', 2);
    await x.click(r.x, r.y, 3);
    await sleep(300);
    const add = await js<{ x: number; y: number } | null>(`cdda.ui2.textRect('Add note')`);
    check('right-click on the map offers a note', !!add, await js('cdda.ui2.state().menu'));
    if (add) {
      await x.click(add.x, add.y);
      await sleep(300);
      await x.type('safe house');
      await x.key('Return');
      await sleep(200);
    }
    const notes = await js<{ text: string }[]>(`cdda.ui.mapMarks().notes`);
    check('typing a note and Enter saves it', notes.some((n) => n.text === 'safe house'), notes);
    await x.click(r.x, r.y, 3);
    await sleep(300);
    const dest = await js<{ x: number; y: number } | null>(`cdda.ui2.textRect('Set as destination')`);
    if (dest) await x.click(dest.x, dest.y);
    await sleep(200);
    check('…and it can be the destination', (await js<{ label: string } | null>(`cdda.ui.mapMarks().destination`))?.label === 'safe house');
    await shot('map');
    await x.key('m');
    s = await until((t) => !t.panels.length && t.lock, 2000);
    check('m closes the map and mouse-look is back', !s.panels.length && s.lock, s);
    await sleep(300);
    check('the compass points at the destination', await js<boolean>(`!!document.querySelector('.hud2-poi.dest')`));
    // --- look card
    await x.key('x');
    s = await until((t) => t.look, 1500);
    check('x shows the look card anchored in the world, cursor free', s.look && !s.lock, s);
    const name = await js<string>(`document.querySelector('.lk-card.mode-look .lk-name')?.textContent ?? ''`);
    check('the card names what the crosshair points at', name.length > 0 && name.toLowerCase() === (await js<string>(`(cdda.lookCard?.target()?.name ?? '').toLowerCase()`)), name);
    await shot('look');
    await x.key('x');
    s = await until((t) => !t.look && t.lock, 1500);
    check('x again closes it and recaptures', !s.look && s.lock, s);
    // --- character sheet
    await x.key('at');
    s = await until((t) => t.panelIds.includes('scr.character'), 1500);
    const tab = await js<{ x: number; y: number } | null>(`cdda.ui2.textRect('Skills')`);
    if (tab) await x.click(tab.x, tab.y);
    await sleep(200);
    const content = await js<string>(`document.querySelector('[data-testid=charsheet-content]')?.textContent ?? ''`);
    check('clicking the Skills tab lists skills with progress', /Melee|Bashing/.test(content) && /%/.test(content), content.slice(0, 120));
    await shot('character_skills');
    await x.key('Right');
    await sleep(100);
    check('→ switches tabs', /good trait|bad trait|No traits/i.test(await js<string>(`document.querySelector('[data-testid=charsheet-content]')?.textContent ?? ''`)));
    await x.key('at');
    s = await until((t) => !t.panels.length && t.lock, 1500);
    check('@ closes it', !s.panels.length && s.lock, s);
  }],
  ['death', 'dying: menus close, the mouse is freed, last words can be typed at once', async () => {
    await toGameplay();
    await x.key('i');
    await js(`cdda.hurt('head', 500); cdda.hurt('torso', 500)`);
    let s = await until((t) => t.deathScreen, 4000);
    await sleep(1800);
    s = await state();
    check('the death screen shows, with no menu left on top', s.deathScreen && !s.windows.length, s);
    check('…and the mouse is free', !s.lock, s);
    await shot('death');
    await x.type('braaains');
    const words = await js<string>(`document.querySelector('.last-words')?.value ?? ''`);
    check('typing goes straight into the last words', words === 'braaains', words);
    dialogs.length = 0;
    await x.key('Enter');
    await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 }).catch(() => {});
    check('Enter returns to the title without a "Leave site?" prompt', !dialogs.includes('beforeunload'), dialogs);
  }],
];

if (argv.includes('--list') || argv.includes('--dry-run')) {
  for (const [n, what] of scenarios) console.log(`${only && !only.has(n) ? '  (skip)' : '  run   '} ${n.padEnd(11)} ${what}`);
  process.exit(0);
}

// ------------------------------------------------------------------ run
const { display } = await startXvfb(W + 40, H + 200);
console.log(`Xvfb ${display}`);
const vite = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await vite.listen();
const port = (vite.httpServer!.address() as { port: number }).port;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: false,
  defaultViewport: null,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${W},${H + 120}`, '--window-position=0,0', '--no-first-run'],
  protocolTimeout: 10 * 60_000,
});
page = (await browser.pages())[0] ?? (await browser.newPage());
x = new XInput(page);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String((e as Error).stack ?? e)));
const dialogs: string[] = [];
page.on('dialog', (d) => {
  dialogs.push(d.type());
  void d.accept();
});
await page.goto(`http://127.0.0.1:${port}/?seed=1&realinput=1&menu=1`);
await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
{
  const cdp = await page.createCDPSession();
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
  const d = await page.evaluate(() => ({ dw: window.outerWidth - window.innerWidth, dh: window.outerHeight - window.innerHeight }));
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: W + d.dw, height: H + d.dh } });
  await sleep(500);
}
await page.evaluate(() => localStorage.clear());
// The title scenario starts the game; running others alone needs a quick start instead.
const runTitle = !only || only.has('title');
for (const [name, what, run] of scenarios) {
  if (only && !only.has(name)) continue;
  if (name !== 'title' && !runTitle && !(await js<boolean>('!!cdda.game.input.wantLock'))) {
    // Setup only: the quick start (tested in the title scenario).
    await quickStart();
  }
  scenario = name;
  console.log(`\n\x1b[1m${name}\x1b[0m — ${what}`);
  try {
    await run();
  } catch (e) {
    check('scenario ran to the end', false, String((e as Error).stack ?? e).split('\n').slice(0, 3).join(' '));
  }
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed:` : ''}`);
for (const f of failed) console.log(`  ${f.scenario}: ${f.name}  ${f.detail}`);
await browser.close();
await vite.close();
process.exit(failed.length ? 1 : 0);

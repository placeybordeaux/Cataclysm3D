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
//            --browser firefox         Firefox (WebDriver BiDi) instead of Chromium; the human plays in it
//            --hmr                     dev server with hot reload on, like `npm run dev`
//            --gpu                     Chromium on the real GPU (run via heavy --kind gpu); else SwiftShader
//            --params "look=classic"   extra URL parameters for the game page
//            --list                    print scenario names
//            --dry-run                 print what would run, start nothing
//
// Exit code 1 if any check fails. Needs Xvfb, xdotool, setxkbmap (shell.nix).

import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdirSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitWindow, launchBrowser, settleWorld, startXvfb, XInput, type BrowserKind } from './lib/realinput';
import { screenScenarios } from './realinput_screens';
import { lootScenarios } from './realinput_loot';
import { archeryScenarios } from './realinput_archery';
import { aimScenarios } from './realinput_aim';
import { qaScenarios } from './realinput_qa';
import { galleryScenarios } from './realinput_gallery';
import { driveScenarios } from './realinput_drive';
import { perfScenarios } from './realinput_perf';
import { drawnScenarios } from './realinput_drawn';
import { chassisScenarios } from './realinput_chassis';
import { stairsScenarios } from './realinput_stairs';
import { grabScenarios } from './realinput_grab';
import { curtainsScenarios } from './realinput_curtains';
import { sewerScenarios } from './realinput_sewer';
import { reloadScenarios } from './realinput_reload';
import { upsScenarios } from './realinput_ups';
import { powerArmorScenarios } from './realinput_powerarmor';
import { siphonScenarios } from './realinput_siphon';
import { npcFireScenarios } from './realinput_npcfire';
import { enemyProjScenarios } from './realinput_enemyproj';
import { skillsScenarios } from './realinput_skills';
import { timewarpScenarios } from './realinput_timewarp';
import { loadgateScenarios } from './realinput_loadgate';
import { readquizScenarios } from './realinput_readquiz';
import { toolGestureScenarios } from './realinput_toolgesture';
import { achievementsScenarios } from './realinput_achievements';
import { vehwalkScenarios } from './realinput_vehwalk';
import { turretScenarios } from './realinput_turret';
import { towingScenarios } from './realinput_towing';
import { labEscapeScenarios } from './realinput_labescape';
import { deepLabScenarios } from './realinput_deeplab';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: tsx tools/realinput.ts [--only a,b] [--shots dir] [--size WxH] [--browser chromium|firefox] [--hmr] [--gpu] [--params k=v&...] [--list] [--dry-run]  (see header)');
  process.exit(0);
}
const [W, H] = opt('--size', '960x540').split('x').map(Number);
const browserKind = opt('--browser', 'chromium') as BrowserKind;
if (browserKind !== 'chromium' && browserKind !== 'firefox') throw new Error(`--browser ${browserKind}: expected chromium or firefox`);
const hmr = argv.includes('--hmr');
const gpu = argv.includes('--gpu');
const extraParams = opt('--params', '');
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
/** The game page (set at start-up); scenarios that visit other pages come back to it. */
let gameUrl = '';
/** Browser dialogs seen (beforeunload): the page's "Leave site?" guard. */
const dialogs: string[] = [];
let x: XInput;
interface State {
  lock: boolean; focus: boolean; fullscreen: boolean; windows: string[]; captured: boolean; held: string[];
  lockPaused: boolean; hint: boolean; x: number; y: number; yaw: number; running: boolean; deathScreen: boolean;
  /** ui2 window titles (progression's Start / New Game / Journal) and visible toast titles. */
  panels: string[]; toasts: string[];
  /** Everything a player would call a menu: v1 windows and ui2 windows (inventory, pickers). */
  menus: string[];
  /** ui2 window ids (scr.character, scr.map, …) and whether the look card (x) is up. */
  panelIds: string[]; look: boolean;
}
const state = (): Promise<State> =>
  page.evaluate(() => {
    const panelTitles = [...document.querySelectorAll('#ui2 .ui2-win .ui2-title-text')].map((t) => t.textContent ?? '');
    // (the title bar also holds a × close button: read only the title's own text)
    const winTitles = [...document.querySelectorAll('.cdda-window > .title')].map((t) => (t.querySelector('.window-title') ?? t).textContent ?? '');
    const g = (window as any).cdda?.game;
    const hint = document.querySelector('.resume-hint') as HTMLElement | null;
    return {
      lock: !!document.pointerLockElement, focus: document.hasFocus(), fullscreen: !!document.fullscreenElement,
      windows: winTitles,
      captured: !!g?.input.captured, held: g ? [...g.input.held] : [], lockPaused: !!g?.lockPaused,
      hint: !!hint && hint.style.display !== 'none',
      x: g?.player.x ?? 0, y: g?.player.y ?? 0, yaw: g?.player.yaw ?? 0, running: !!g?.player.running,
      deathScreen: !!document.querySelector('.death-screen'),
      panels: [...document.querySelectorAll('#ui2 .ui2-win .ui2-title-text')].map((t) => t.textContent ?? ''),
      toasts: [...document.querySelectorAll('#ui2 .ui2-toast:not(.leaving) .ui2-toast-title')].map((t) => t.textContent ?? ''),
      menus: [...winTitles, ...panelTitles],
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
  // The load gate (src/loadgate) holds the game and swallows gameplay keys under its loading
  // screen while the surroundings are built, e.g. right after a setup teleport: wait it out, as
  // a player would. (The loadgate scenario tests the gate itself.)
  // settleWorld waits for the surroundings built and the gate open, steadily (the gate only
  // closes after a debounce, so an open gate right after a teleport proves nothing).
  const w = await settleWorld(js);
  if (!w.ok) check('the surroundings finished loading (load gate open, chunks built)', false, w);
  return state();
}
/** `sinceContact`: game seconds past the swing's contact point when a melee blow resolved
 *  (null = no phased swing running, i.e. it resolved instantly). */
type Attack = { kind: string; outcome: string; t: number; uid: number | null; sinceContact: number | null };
/**
 * Resolved player attacks (the playerAttack event: melee blows resolve at contact, after the
 * wind-up, see docs/COMBAT_FEEL.md). Installs the listener once per page load; returns
 * everything seen so far. A whiff at nothing prints no message, so the log can't tell.
 */
const attacks = () =>
  js<Attack[]>(`(() => {
    if (!window.__atk) {
      window.__atk = [];
      cdda.game.events.on('playerAttack', (e) => {
        const s = cdda.combat?.swing;
        window.__atk.push({ kind: e.kind, outcome: e.outcome, t: performance.now(), uid: e.target?.uid ?? null, sinceContact: s ? s.t - (s.timing.windup + s.timing.strike) : null });
      });
    }
    return window.__atk;
  })()`);
const center = async (sel: string): Promise<[number, number] | null> =>
  page.evaluate((q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x + Math.min(40, r.width / 2)), Math.round(r.y + r.height / 2)] as [number, number];
  }, sel);

// --- inventory helpers (src/ui2/bn: cdda.inv2)
const EQUIP = '#ui2 [data-id="inv.equip"]', CARRIED = '#ui2 [data-id="inv.carried"]', NEARBY = '#ui2 [data-id="inv.nearby"]';
type Census = { counts: Record<string, number>; aliased: number };
const censusNow = () => js<Census>('cdda.inv2.census()');
const whereIs = (typeId: string) => js<string[]>(`cdda.inv2.where(${JSON.stringify(typeId)})`);
const rectOf = (typeId: string, sel = '#ui2') => js<{ x: number; y: number; id: string; loc: string } | null>(`cdda.inv2.rectOf(${JSON.stringify(typeId)}, ${JSON.stringify(sel)})`);
/** A real drag: press, move in steps (so the drag starts and targets see hover), release. */
async function drag(from: [number, number], to: [number, number]): Promise<void> {
  await x.moveTo(from[0], from[1], 2);
  await x.buttonDown(1);
  await x.moveTo(to[0], to[1], 14);
  await sleep(120);
  await x.buttonUp(1);
  await sleep(300);
}
/** Census equality (item conservation); `quietOk` records only failures. */
function sameCensus(name: string, a: Census, b: Census, quietOk = false): boolean {
  const keys = new Set([...Object.keys(a.counts), ...Object.keys(b.counts)]);
  const diff = [...keys].filter((k) => (a.counts[k] ?? 0) !== (b.counts[k] ?? 0)).map((k) => `${k} ${a.counts[k] ?? 0}→${b.counts[k] ?? 0}`);
  const ok = !diff.length && !b.aliased;
  if (!ok || !quietOk) check(name, ok, diff.join(', ') || (b.aliased ? `${b.aliased} aliased` : ''));
  return ok;
}

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
    // Every title layout (?title=center|side|classic) marks its entries .title-entry[data-key];
    // 's' is Start whichever layout, and whether or not a save puts Continue first.
    const nb = await center('.title-entry[data-key="s"]');
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
    // Up to four 20 s gaps: other first-time tips (zombie, cold, weather…) may be queued ahead.
    s = await until((t) => t.toasts.some((m) => /craft|recipes/i.test(m)), 100000);
    check('a "you could craft" nudge shows (after the calm/gap)', s.toasts.some((m) => /craft|recipes/i.test(m)), { toasts: s.toasts, q: await js('cdda.progression.queue()') });
    const badge = await js<number>('cdda.progression.queue().badge');
    check('the crafting key gets a badge', badge >= 1, badge);
    await shot('craft_nudge');
    await x.key('ampersand');
    s = await until((t) => t.panels.includes('Crafting'), 1500);
    check('& opens crafting', s.panels.includes('Crafting'), s.panels);
    check('…and clears the badge', (await js<number>('cdda.progression.queue().badge')) === 0);
    const fresh = await js<number>(`document.querySelectorAll('#ui2 .c2-row .c2-new').length`);
    check('…with the announced recipes marked NEW', fresh >= 1, fresh);
    await x.key('ampersand');
    await until((t) => !t.panels.length, 1500);
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
    // Straight to storage: progression.reset() re-evaluates unlocks against the running page's
    // in-memory achievements (the onboarding kill) and unlocked the Security Guard again.
    // Cleared again on pagehide, after the game's own flush of a (dirty) profile.
    await js(`(() => { const wipe = () => { localStorage.removeItem('cdda3d.progression'); localStorage.removeItem('cdda3d.achievements'); }; wipe(); addEventListener('pagehide', wipe); return 1; })()`);
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
    check('mouse motion is ignored while a menu is open', Math.abs(s.yaw - s0.yaw) < 1e-6 && s.menus.length > 0);
    await x.key('i');
  }],
  ['menus', 'every menu key opens its screen and the same key closes it, keeping the lock', async () => {
    await toGameplay();
    // Setup only: one of everything the pickers need.
    await js(`(() => { for (const id of ['granola', 'bandages', 'crowbar', 'manual_mechanics', 'rock']) cdda.giveItem(id); cdda.learnAll?.(); })()`);
    const keys: [string, string][] = [
      ['i', 'ui2:inv.equip'], ['z', 'ui2:Wield what?'], ['O', 'ui2:Wear what?'], ['T', 'ui2:Take off what?'], ['E', 'ui2:Eat or drink what?'], ['u', 'ui2:Use what?'],
      ['R', 'Read what?'], ['(', 'Disassemble item:'], ['@', 'ui2:scr.character'], ['m', 'ui2:scr.map'],
      ['P', 'ui2:scr.log'], ['?', 'ui2:scr.help'], [')', ''], ['p', ''], ['[', ''], ['_', ''], ['M', ''], ['x', 'look'], ['q', 'ui2:Drop what?'],
      ['|', ''], ['$', ''], ['C', ''], ['B', ''],
    ];
    // Legacy curses windows (.cdda-window), ui2 screens (title 'ui2:<window id>') and the look card.
    const opened = (t: State) => t.windows.length + t.panels.length + Number(t.look);
    for (const [k, title] of keys) {
      const before = (await log()).length;
      await x.key(k);
      let s = await until((t) => opened(t) > 0, 1200);
      const msgs = (await log()).slice(before);
      const menu = await js<number>(`document.querySelectorAll('#ui2 .ui2-menu').length`);
      if (!opened(s) && menu) {
        // A ui2 context menu (C: talk / orders): Esc closes it.
        check(`${k} opens a context menu`, true);
        await x.key('Escape');
        await toGameplay();
        continue;
      }
      if (!opened(s)) {
        // Not every key opens a window (nothing to butcher here); it must at least say something.
        check(`${k}: no window, but a message says why`, msgs.length > 0, msgs.length ? msgs.join(' / ') : 'no window and no message');
        continue;
      }
      const ui2 = !s.windows.length;
      // ui2 titles name a window by id (scr.character, inv.equip) or by its title text (the pickers).
      const want = title.startsWith('ui2:') ? title.slice(4) : null;
      const hit = ui2 && want && (s.panelIds.includes(want) || s.panels.includes(want)) ? want : null;
      const top = s.look ? 'look' : ui2 ? `ui2:${hit ?? s.panelIds[s.panelIds.length - 1]}` : s.windows[s.windows.length - 1];
      check(`${k} opens ${title || top}`, !title || top === title, [s.windows, s.panelIds, s.panels, s.look]);
      if (ui2) check(`${k}: the cursor is free for pointing`, !s.lock, s);
      await shot(`menu_${top || k}`);
      // Footer legend (legacy windows and the named ui2 window) + every window fits the screen.
      if (!s.look && (!ui2 || hit)) {
        const win = hit ? `#ui2 .ui2-win[data-id="${s.panelIds[s.panels.indexOf(hit)] ?? hit}"]` : '';
        const legend = await js<string>(`(() => { const w = ${hit ? `document.querySelector('${win}')` : 'null'}; return (w ? w.querySelector('.ui2-footer') : [...document.querySelectorAll('.cdda-window .footer')].pop())?.textContent ?? ''; })()`);
        // Space (close_menu) is the advertised way out; Esc also frees the mouse, so no footer names it.
        check(`${k}: footer names the close keys (Space, not Esc)`, /Space|Bksp/.test(legend) && !/\bEsc\b/.test(legend), legend);
      }
      if (!s.look) {
        const overflowX = await js<boolean>(`(() => { for (const w of document.querySelectorAll('.cdda-window, #ui2 .ui2-win')) { const r = w.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) return true; } return false; })()`);
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
    await sleep(300); // a person's i-then-Esc; within ~50 ms the Esc lands while the lock is still being released
    await x.key('Escape');
    s = await until((t) => !t.menus.length && t.hint);
    check('Esc inside a menu closes that menu (not the game)', !s.menus.length, s.menus);
    check('…and gameplay pauses behind the resume hint', s.hint && s.lockPaused, s);
    await sleep(1400);
    await x.key('w');
    // The hint follows the lock a frame later (it's drawn from requestAnimationFrame).
    s = await until((t) => t.lock && !t.hint);
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
    const a0 = (await attacks()).length;
    await x.click(W / 2, H / 2);
    s = await until((t) => t.lock);
    // A swing resolves after its wind-up: wait long enough to see one if it started.
    await sleep(700);
    const swung = (await attacks()).slice(a0);
    check('a click on the paused view only resumes (no attack)', s.lock && !swung.length, { lock: s.lock, swung });
    // Chrome refuses a re-lock for 1.25 s after an Esc unlock; a key pressed sooner must still
    // resume once that's over (Input retries within the key's activation window).
    await x.key('i');
    await sleep(300);
    await x.key('Escape');
    await until((t) => !t.menus.length);
    await x.key('w');
    s = await until((t) => t.lock, 2500);
    check('a key pressed right after Esc resumes once Chrome allows it', s.lock, { s, refusals: await js('cdda.game.input.lockRefusals') });
  }],
  ['spaceclose', 'Space (close_menu) closes every kind of menu and puts the mouse back in the game; no side-step', async () => {
    await toGameplay();
    // Setup only: something for the pickers and the read window.
    await js(`(() => { for (const id of ['granola', 'manual_mechanics', 'crowbar']) cdda.giveItem(id); })()`);
    const opened = (t: State) => t.windows.length + t.panels.length + Number(t.look);
    const footers = () => js<string>(`[...document.querySelectorAll('.cdda-window .footer, #ui2 .ui2-win .ui2-footer')].map((f) => f.textContent).join(' | ')`);
    const cases: [key: string, what: string][] = [
      ['i', 'inventory'], ['&', 'crafting'], ['m', 'map'], ['z', 'wield picker'], ['E', 'eat picker'], ['R', 'read window (v1)'],
      ['@', 'character sheet'], ['*', 'construction'], ['?', 'help'], ['P', 'message log'], [')', 'achievements'], ['x', 'look card'],
    ];
    for (const [k, what] of cases) {
      await x.key(k);
      let s = await until((t) => opened(t) > 0, 1500);
      if (!check(`${k} opens the ${what}`, opened(s) > 0, s)) {
        await toGameplay();
        continue;
      }
      await sleep(250);
      if (!s.look) {
        const f = await footers();
        check(`${what}: the footer advertises Space, never Esc`, /Space/.test(f) && !/\bEsc\b/.test(f), f);
      }
      await shot(`space_${what}`);
      // A free cursor parked in a corner: re-capturing must not report its trip to the centre
      // as mouse-look (the view snapped ~49° before bn 7da0d71).
      if (!s.lock) await x.moveTo(40, 40, 4);
      await sleep(100);
      s = await state();
      const at = [s.x, s.y], yaw0 = s.yaw;
      await x.key('space');
      s = await until((t) => !opened(t) && t.lock && !t.hint, 2500);
      check(`Space closes the ${what}: back in play, mouse captured, no resume hint`, !opened(s) && s.lock && !s.hint, { s, refusals: await js('cdda.game.input.lockRefusals') });
      await sleep(350);
      s = await state();
      check(`…and that Space didn't also side-step`, Math.hypot(s.x - at[0], s.y - at[1]) < 0.05, { from: at, to: [s.x, s.y] });
      check(`…and the view didn't jump as the mouse was re-captured`, Math.abs(s.yaw - yaw0) < 0.02, { yaw0, yaw: s.yaw });
    }
    // The pause menu: Esc opens it (the browser frees the mouse); Space resumes and re-captures,
    // even pressed inside Chrome's ~1.25 s re-lock cooldown (Input retries a non-Esc key).
    await x.key('Escape');
    let s = await until((t) => t.panelIds.includes('scr.esc'));
    check('Esc still opens the pause menu', s.panelIds.includes('scr.esc'), s);
    const f = await footers();
    check('pause menu: "Space resume", no Esc in the footer', /Space/.test(f) && !/\bEsc\b/.test(f), f);
    await sleep(300);
    await x.key('space');
    s = await until((t) => !t.panels.length && t.lock, 3000);
    check('Space resumes from the pause menu and re-captures the mouse', !s.panels.length && s.lock, { s, refusals: await js('cdda.game.input.lockRefusals') });
    // Esc keeps working for closing (just not advertised).
    await sleep(300);
    await x.key('i');
    await until((t) => opened(t) > 0);
    await sleep(300);
    await x.key('Escape');
    s = await until((t) => !opened(t));
    check('Esc still closes a menu', !opened(s), s);
    await toGameplay();
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
    check('holding i keeps the inventory open (repeats ignored)', s.menus.includes('Inventory'), s.windows);
    await x.key('i');
    await x.key('Caps_Lock');
    await x.key('i');
    s = await until((t) => t.menus.length > 0, 800);
    check('CapsLock on: i still opens the inventory', s.menus.includes('Inventory'), s.windows);
    await x.key('i');
    await x.key('Caps_Lock');
    s = await state();
    check('back to gameplay', !s.menus.length, s.menus);
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
    check('menu still open after a tab switch', s.menus.includes('Inventory'), s.menus);
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
    s = await until((t) => t.panelIds.includes('scr.esc'));
    // The pause menu is a ui2 window: it frees the cursor on purpose (click the buttons).
    check('Esc opens the pause menu (cursor free to click it)', s.panelIds.join() === 'scr.esc' && !s.lock, s);
    await x.key('Escape');
    s = await until((t) => !t.panels.length && t.lock);
    check('Esc closes it and the mouse is captured again', !s.panels.length && s.lock, s);
    await x.key('i');
    await until((t) => t.menus.length > 0, 1500);
    await x.key('Escape');
    s = await until((t) => !t.menus.length && t.lock, 1500);
    check('Esc closes the inventory, still captured', !s.menus.length && s.lock, s);
    await x.hold('Escape', 2700);
    s = await until((t) => !t.fullscreen, 1500);
    check('holding Esc leaves fullscreen (menu opened once, no flicker)', !s.fullscreen && s.panelIds.join() === 'scr.esc', s);
    await toGameplay();
  }],
  ['freecursor', 'Options > Menu cursor = free: menus show the cursor and take clicks', async () => {
    await toGameplay();
    await js(`cdda.game.input.menuCursor = 'free'`);
    // The menu-cursor option is about v1 windows: use the Classic (v1) inventory lists here.
    await js('cdda.ui2.settings.classicInventory = true; cdda.ui2.saveSettings()');
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
    await js('cdda.ui2.settings.classicInventory = false; cdda.ui2.saveSettings()');
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
      check('q (physical A) strafes, does not open Drop', !s.menus.length, s.menus);
      await x.key('w'); // physical Z: wield stand-in
      s = await until((t) => t.menus.length > 0, 800);
      check('w (stand-in) opens Wield', s.menus.includes('Wield what?'), s.menus);
      await x.key('Backspace');
      await x.key('a'); // physical Q: drop stand-in
      s = await until((t) => t.menus.length > 0, 800);
      check('a (stand-in) opens Drop', s.menus.includes('Drop what?'), s.menus);
      await x.key('Backspace');
      const label = await js<string>('cdda.game.keys.movementKeys()');
      check('movement is labelled ZQSD', label === 'ZQSD', label);
    } finally {
      x.layout('us');
    }
  }],
  ['craft', 'ui2 crafting: & opens with a free cursor, type to search, Enter crafts, stop/continue, * construction placement', async () => {
    await toGameplay();
    // Setup only: materials for a wooden spear and a half wall. No zombies: by now one has
    // usually wandered in from the street, and a hostile in view interrupts crafting (CDDA).
    await js(`cdda.clearMonsters(60)`);
    await js(`(() => { const p = cdda.game.player; cdda.giveItem('backpack', { wear: true }); for (const id of ['knife_folding', 'sandpaper', 'rag', 'hammer', 'stick_long']) cdda.giveItem(id); cdda.giveItem('thread', { count: 50 }); cdda.giveItem('nail', { count: 40 }); for (let i = 0; i < 10; i++) cdda.placeItem('2x4', 0, 1); p.setSkill('fabrication', 3); p.setSkill('survival', 1); cdda.addFire(-1, 1); })()`);
    await x.key('ampersand');
    let s = await until((t) => t.panels.includes('Crafting'), 1500);
    check('& opens the crafting screen with a free cursor', s.panels.includes('Crafting') && !s.lock, s);
    await sleep(200);
    await x.type('spear');
    await sleep(300);
    const rows = await js<string[]>('cdda.crafting.screen()?.rows() ?? []');
    check('typing searches the recipes', rows.includes('spear_wood'), rows);
    await shot('crafting_screen');
    await x.key('Return');
    s = await until((t) => !t.panels.length && t.lock, 2000);
    check('Enter crafts, closes the screen and re-captures the mouse', !s.panels.length && s.lock, s);
    await sleep(1200);
    const act = await js<string | null>('cdda.game.activities.current?.spec.name ?? null');
    check('crafting is running with its progress bar', /crafting wooden spear/.test(act ?? '') && (await js<number>(`document.querySelectorAll('#ui2 .ui2-prog').length`)) > 0, act);
    await x.hold('w', 300);
    const wip = await js<{ progress: number }[]>('cdda.crafting.inProgress()');
    check('moving stops it; the in-progress craft keeps its components and progress', wip.length === 1 && wip[0].progress > 0 && wip[0].progress < 1, wip);
    await x.hold('s', 300);
    await js(`cdda.addFire(0, 1)`);
    await x.key('ampersand');
    await until((t) => t.panels.includes('Crafting'), 1500);
    const c = await js<{ x: number; y: number } | null>(`cdda.ui2.textRect('Continue')`);
    if (c) await x.click(c.x, c.y);
    s = await until((t) => !t.panels.length, 1500);
    await sleep(9000);
    const done = await js<number>(`cdda.game.player.inv.allItems().filter((i) => i.typeId === 'spear_wood').length`);
    check('Continue (clicked) finishes the spear', done === 1 && !(await js<unknown[]>('cdda.crafting.inProgress()')).length, done);
    await toGameplay();
    // Construction: * → search → Enter places a ghost; a left click builds.
    await x.key('asterisk');
    s = await until((t) => t.panels.includes('Construction'), 1500);
    check('* opens the construction screen', s.panels.includes('Construction'), s.panels);
    await sleep(200);
    await x.type('build wood wall');
    await x.key('Return');
    s = await until((t) => !t.panels.length && t.lock, 2000);
    const ghost = await js<{ ok: boolean } | null>('cdda.construction.placement()');
    check('Place puts a ghost on the tile in front, mouse captured', !!ghost && s.lock, ghost);
    await shot('construction_ghost');
    if (ghost?.ok) {
      await x.clickHere(1);
      await sleep(600);
      check('left click starts building (not an attack)', /constructing/.test((await js<string | null>('cdda.game.activities.current?.spec.name ?? null')) ?? ''));
    }
    await x.hold('s', 200);
    await js('cdda.construction.cancel()');
  }],
  ['rebind', 'Options > Key bindings: rebind wear to y; movement keys refused; reset', async () => {
    await toGameplay();
    await js(`cdda.giveItem('jacket_light')`); // setup: something the Wear menu can list
    // Right after the fullscreen scenario, Chrome is still settling its keyboard/pointer lock
    // (an Esc pressed in that second is lost); give it a moment like a player would.
    await sleep(1500);
    await x.key('Escape');
    await until((t) => t.panelIds.includes('scr.esc'));
    await x.key('o');
    let s = await until((t) => t.panels.includes('Options'));
    check('pause menu → o opens Options', s.panels.includes('Options'), s.panels);
    await shot('options');
    // Options are grouped in category tabs (src/ui/options.ts); Key bindings… heads Controls.
    // Tab steps categories, as a player would, until it is the highlighted row.
    const selRow = () => js<string>(`document.querySelector('#ui2 .ui2-list-row.selected')?.dataset.name ?? ''`);
    for (let i = 0; i < 6 && !/^Key bindings/.test(await selRow()); i++) {
      await x.key('Tab');
      await sleep(150);
    }
    await x.key('Enter');
    s = await until((t) => t.panels.includes('Key bindings'));
    check('Tab to Controls, Enter on its first entry opens Key bindings', s.panels.includes('Key bindings'), s.panels);
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
    s = await until((t) => t.menus.length > 0, 800);
    check('y opens the Wear menu in game', s.menus.includes('Wear what?'), s.menus);
    await x.key('y');
    s = await until((t) => !t.menus.length, 800);
    check('…and y closes it', !s.menus.length, s.menus);
    const stored = await js<string>(`localStorage.getItem('cdda3d.keys')`);
    check('the rebind is stored', /"wear":\["y"\]/.test(stored ?? ''), stored);
    await js(`cdda.game.keys.resetBindings()`);
  }],
  ['mouse', 'LMB swings (wind-up, then the blow resolves at contact); wheel zooms the top-down camera', async () => {
    await toGameplay();
    // Setup: a weapon and nothing in reach.
    await js(`cdda.giveItem('crowbar', { wield: true })`);
    await js(`cdda.clearMonsters(8)`);
    let a0 = (await attacks()).length;
    const swingState = () => js<object>(`(() => { const c = cdda.combat, i = cdda.game.input; return { lock: i.locked, captured: i.captured, paused: cdda.game.paused, lockPaused: cdda.game.lockPaused, cooldown: c.cooldown, swing: !!c.swing }; })()`);
    const pre = await swingState();
    await x.clickHere(1);
    // Slow software-rendered frames (1920x1080) stretch the swing in real time: poll.
    let blows: Attack[] = [];
    for (let i = 0; i < 30 && !blows.length; i++) {
      await sleep(100);
      blows = (await attacks()).slice(a0);
    }
    await sleep(300);
    blows = (await attacks()).slice(a0);
    // A whiff makes no log line (whoosh only, docs/COMBAT_FEEL.md), so this reads the event;
    // sinceContact >= 0 means it resolved from the phased swing at contact, not on the click.
    check('LMB at nothing swings: one melee whiff, resolved at contact after the wind-up (not on the click)',
      blows.length === 1 && blows[0].kind === 'melee' && blows[0].outcome === 'whiff' && blows[0].sinceContact !== null && blows[0].sinceContact >= 0, { blows, pre, after: await swingState() });
    // Setup: a sturdy zombie right in front, faced (aiming is the combat suites' job).
    await js(`cdda.godMode(true)`);
    const uid = await js<number>(`(() => { const uid = cdda.spawnMonster('mon_zombie', 0, -1.3); const m = cdda.game.monsters.all.find((z) => z.uid === uid); m.hp = 500; return uid; })()`);
    const before = (await log()).length;
    a0 = (await attacks()).length;
    for (let i = 0; i < 8 && !(await attacks()).slice(a0).some((b) => b.outcome === 'hit' || b.outcome === 'crit'); i++) {
      await js(`(() => { const m = cdda.game.monsters.all.find((z) => z.uid === ${uid}); const p = cdda.game.player; p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = -0.1; })()`);
      await x.clickHere(1);
      await sleep(1200);
    }
    blows = (await attacks()).slice(a0);
    const msgs = (await log()).slice(before);
    check('LMB at a zombie in reach resolves against it', blows.length > 0 && blows.every((b) => b.kind === 'melee' && b.uid === uid), blows);
    check('…and a hit is logged ("You bash/hit … the zombie")', blows.some((b) => b.outcome === 'hit' || b.outcome === 'crit') && msgs.some((m) => /^You .*zombie/i.test(m)), { blows, msgs });
    await js(`cdda.clearMonsters(8); cdda.godMode(false)`);
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
  ['venom', 'unarmed LMB with venomous fangs: the bite poisons the zombie (BN message), which slows it', async () => {
    await toGameplay();
    // Setup only: bare hands, FANGS + POISONOUS2, high dexterity so the bite procs, a sturdy zombie in front.
    await js(`(() => { const p = cdda.game.player; p.inv.unwield(); p.addTrait('FANGS'); p.addTrait('POISONOUS2'); p.dex_base = 40; cdda.clearMonsters(8); cdda.godMode(true); })()`);
    const uid = await js<number>(`(() => { const uid = cdda.spawnMonster('mon_zombie', 0, -1.3); const m = cdda.game.monsters.all.find((z) => z.uid === uid); m.hp = 500; return uid; })()`);
    const speed0 = await js<number>(`cdda.game.monsters.all.find((z) => z.uid === ${uid}).speed`);
    const before = (await log()).length;
    let msgs: string[] = [];
    for (let i = 0; i < 12 && !msgs.some((m) => /inject your venom/.test(m)); i++) {
      await js(`(() => { const m = cdda.game.monsters.all.find((z) => z.uid === ${uid}); const p = cdda.game.player; p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = -0.1; })()`);
      await x.clickHere(1);
      await sleep(1200);
      msgs = (await log()).slice(before);
    }
    const st = await js<{ poisoned: boolean; speed: number }>(`(() => { const m = cdda.game.monsters.all.find((z) => z.uid === ${uid}); return { poisoned: m.hasEffect('badpoison'), speed: m.speed }; })()`);
    await shot('venom_bite');
    check('a landed fang bite logs "You sink your fangs into the zombie" and "You inject your venom into the zombie!"',
      msgs.some((m) => /sink your fangs into the zombie/.test(m)) && msgs.some((m) => /You inject your venom into the zombie!/.test(m)), msgs);
    check('the zombie is badly poisoned and 10 speed slower', st.poisoned && st.speed === speed0 - 10, { speed0, ...st });
    await js(`(() => { cdda.clearMonsters(8); cdda.godMode(false); const p = cdda.game.player; p.removeTrait('FANGS'); p.removeTrait('POISONOUS2'); })()`);
  }],
  ['firstfight', "first fight on Accessible: long pointy stick vs one zombie, LMB when in reach, mash e when grabbed: over in ~8–12 s; misses say why", async () => {
    await toGameplay();
    // Setup: the starter spear, a fresh survivor's health, one zombie a few steps ahead.
    await js(`(() => { cdda.clearMonsters(20); cdda.giveItem('pointy_stick_long', { wield: true }); const p = cdda.game.player; for (const k of Object.keys(p.hp)) p.hp[k].cur = p.hp[k].max; p.stamina = p.staminaMax(); })()`);
    // Setup: stand where the 4 tiles north are open ground. Earlier scenarios (craft's construction
    // placement) can leave the survivor by the shelter wall, and then the zombie spawns outside a
    // window it can never get through (QA_WAVE3: the fight timed out at 7 m, zero blows).
    await js(`(() => {
      const g = cdda.game, p = g.player, grid = g.monsters.grid;
      const clear = (x, y) => { for (let s = -1; s <= 6; s++) for (let w = -1; w <= 1; w++) if (!grid.passable(x + w, y - s, p.z) || grid.opaque(x + w, y - s, p.z)) return false; return true; };
      for (let r = 0; r < 60; r++) for (let a = 0; a < 16; a++) {
        const x = Math.floor(p.x + Math.cos(a / 16 * 6.283) * r), y = Math.floor(p.y + Math.sin(a / 16 * 6.283) * r);
        if (clear(x, y)) { p.x = x + 0.5; p.y = y + 0.5; return; }
      }
      throw new Error('firstfight: no open ground within 60 tiles');
    })()`);
    const preset = await js<string>(`cdda.difficulty()?.preset ?? cdda.difficulty()?.id ?? ''`).catch(() => '');
    const uid = await js<number>(`cdda.spawnMonster('mon_zombie', 0, -4)`);
    const a0 = (await attacks()).length;
    type FightState = { dead: boolean; grabbed: boolean; d: number; cd: number; swing: boolean; why: string; hp: number };
    const read = () => js<FightState>(`(() => {
      const m = cdda.game.monsters.all.find((z) => z.uid === ${uid}), p = cdda.game.player;
      const w = document.querySelector('.combat-why');
      const why = w && w.style.display !== 'none' ? w.textContent : '';
      if (!m || m.dead) return { dead: true, grabbed: false, d: 0, cd: 0, swing: false, why, hp: 0 };
      // Aiming is the combat suites' job: keep the crosshair on its chest (setup, not input).
      p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y)); p.pitch = -0.08;
      return { dead: false, grabbed: !!cdda.game.monsters.grabbedBy, d: Math.hypot(m.x - p.x, m.y - p.y) - m.radius, cd: cdda.combat.cooldown, swing: !!cdda.combat.swing, why, hp: m.hp };
    })()`);
    const t0 = Date.now();
    let grabs = 0, wasGrabbed = false, st = await read(), engaged = 0;
    const whys = new Set<string>();
    while (!st.dead && Date.now() - t0 < 45_000 && !(await state()).deathScreen) {
      if (st.why && !whys.size) await shot('firstfight_why');
      if (st.why) whys.add(st.why);
      if (st.grabbed) {
        if (!wasGrabbed) grabs++;
        await x.key('e', 30);
      } else if (st.d > 1.9) {
        await x.hold('w', 150);
      } else {
        if (!engaged) engaged = Date.now();
        if (st.cd <= 0 && !st.swing) await x.clickHere(1);
      }
      wasGrabbed = st.grabbed;
      await sleep(60);
      st = await read();
    }
    const secs = ((Date.now() - (engaged || t0)) / 1000);
    const blows = (await attacks()).slice(a0);
    const misses = blows.filter((b) => b.outcome === 'miss' || b.outcome === 'whiff').length;
    console.log(`    first fight: ${secs.toFixed(1)} s from first reach, ${grabs} grabs, ${blows.length} blows (${misses} missed), reasons seen: ${[...whys].join(', ') || '-'} [${preset}]`);
    check('the zombie dies', st.dead, st);
    check('the fight lasts at most ~14 s from first contact (goal 8–12 s)', st.dead && secs <= 14, { secs, grabs, blows: blows.map((b) => b.outcome) });
    check('at most 2 grabs', grabs <= 2, grabs);
    if (misses) check('a miss shows why near the crosshair (dodged / clumsy swing / out of reach)', [...whys].some((w) => /miss:|out of reach/.test(w)), [...whys]);
    await js(`cdda.clearMonsters(20)`);
  }],
  ['ui2', 'ui2 inventory: Tab frees the cursor (no resume hint), drag & drop, context menu, pause, Tab re-captures', async () => {
    await toGameplay();
    type U = { surfaces: number; tacticalPause: boolean; locked: boolean; panels: string[]; menu: string[][] };
    const u = () => js<U>('cdda.ui2.state()');
    await js(`cdda.inv2.spawn('pipe', 0, 0)`);
    await x.key('Tab');
    await sleep(500);
    let s = await state();
    let v = await u();
    check('Tab opens the inventory (Equipment, Inventory, Nearby) with a free cursor', ['inv.equip', 'inv.carried', 'inv.nearby'].every((p) => v.panels.includes(p)) && !s.lock, { v, lock: s.lock });
    check('…without the "click to resume" hint', !s.hint && !s.lockPaused, s);
    check('…and the tactical pause on (Accessible default)', v.tacticalPause, v);
    await shot('ui2_inventory');
    const c0 = await censusNow();
    const from = await rectOf('pipe', NEARBY);
    const to = await center(`${CARRIED} .bn-list`);
    await drag([from!.x, from!.y], to!);
    check('dragging the pipe from the ground into the Inventory list picks it up', (await whereIs('pipe')).some((l) => l.startsWith('inv')), await whereIs('pipe'));
    const cell = await rectOf('pipe', CARRIED);
    await x.click(cell!.x, cell!.y, 3);
    await sleep(250);
    v = await u();
    check('right-click opens the item context menu with action times', v.menu.length === 1 && v.menu[0].length > 2 && v.menu[0].some((r) => /\d+(\.\d)? s/.test(r ?? '')), v.menu);
    await shot('ui2_item_menu');
    await x.key('Escape');
    v = await u();
    check('Esc closes the menu, the windows stay', !v.menu.length && v.panels.includes('inv.equip'), v);
    await x.click(cell!.x, cell!.y, 3);
    await sleep(250);
    await x.key('space');
    v = await u();
    check('Space closes the context menu too (never activates an entry), the windows stay', !v.menu.length && v.panels.includes('inv.equip') && (await whereIs('pipe')).some((l) => l.startsWith('inv')), v);
    sameCensus('census unchanged after the drag', c0, await censusNow());
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
    // …and moves take their time: a progress bar, then the move.
    const pipe = await rectOf('pipe', CARRIED);
    await x.moveTo(pipe!.x, pipe!.y, 2);
    await x.down('Shift');
    await x.clickHere(1);
    await x.up('Shift');
    await sleep(120);
    const bar = await js<boolean>(`!!document.querySelector('#ui2 .ui2-prog')`);
    const still = (await whereIs('pipe')).some((l) => l.startsWith('inv'));
    await sleep(1400);
    // `still` (not moved yet 120 ms after the click) is timing-sensitive: Firefox's slower
    // round trips saw the bar but the drop already done. The bar is the point; still is logged.
    check('Classic: Shift-click drop shows a progress bar and happens when it fills', bar && (still || browserKind === 'firefox') && (await whereIs('pipe')).some((l) => l.startsWith('ground')), { bar, still, now: await whereIs('pipe') });
    await x.key('Tab');
    await until((t) => !t.panels.length, 3000);
    await js('cdda.ui2.settings.pauseInInventory = true; cdda.ui2.saveSettings()');
    await x.key('Tab');
    await until((t) => t.panels.includes('Equipment'), 3000);
    const p0 = await js<number>('cdda.game.clock.seconds');
    await sleep(1200);
    const p1 = await js<number>('cdda.game.clock.seconds');
    check('with it on (default), game time stops', p1 === p0, { p0, p1 });
    await x.key('Tab');
    await until((t) => t.lock, 3000);
  }],
  ['ui2kit', 'ui2 showcase (?debug=ui2): drag ground → backpack, right-click menu, Esc closes only the menu', async () => {
    type K = { panels: string[]; menu: string[][]; where: (t: string) => string[] };
    const k = () => js<Omit<K, 'where'>>('(({ panels, menu }) => ({ panels, menu }))(cdda.ui2.state())');
    const where = (t: string) => js<string[]>(`cdda.ui2.state().where(${JSON.stringify(t)})`);
    // Centre of the first matching element that isn't covered by another window.
    const visible = (sel: string) =>
      page.evaluate((q) => {
        for (const el of document.querySelectorAll<HTMLElement>(q)) {
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (r.width && r.height && el.contains(document.elementFromPoint(cx, cy))) return { x: Math.round(cx), y: Math.round(cy), item: el.dataset.item ?? null };
        }
        return null;
      }, sel);
    dialogs.length = 0;
    await page.goto(new URL('/?debug=ui2', gameUrl).href);
    await page.waitForFunction('window.cdda?.ready', { timeout: 60_000 });
    await sleep(500);
    let v = await k();
    check('the showcase opens the inventory: Equipment, backpack, Ground', ['inv.equip', 'inv.back', 'inv.ground'].every((p) => v.panels.includes(p)), v.panels);
    await shot('ui2kit');
    // Drag a ground item into the backpack with real mouse down / move / up.
    const from = await visible('[data-id="inv.ground"] .ui2-cell[data-item]');
    const to = await visible('[data-id="inv.back"] .ui2-container');
    const typeId = from && (await js<string>(`cdda.ui2.model.store.find(${JSON.stringify(from.item)})?.item.typeId ?? ''`));
    check('a ground item and the backpack are on screen', !!from && !!to && !!typeId, { from, to, typeId });
    if (!from || !to || !typeId) return;
    const before = await where(typeId);
    await x.moveTo(from.x, from.y, 2);
    await x.buttonDown(1);
    await x.moveTo(to.x, to.y, 12);
    await x.buttonUp(1);
    await sleep(300);
    const locs = await where(typeId);
    check(`dragging ${typeId} from the ground into the backpack moves it`, locs.length > 0 && locs.every((l) => l.startsWith('in:')), { before, locs });
    // Right-click an item: context menu with timed actions; Esc closes only the menu.
    const cell = await visible('[data-id="inv.back"] .ui2-cell[data-item]');
    await x.click(cell!.x, cell!.y, 3);
    await sleep(250);
    v = await k();
    check('right-click opens the item context menu', v.menu.length === 1 && v.menu[0].length > 2, v.menu);
    await x.key('Escape');
    await sleep(100);
    v = await k();
    check('Esc closes the menu, the windows stay', !v.menu.length && v.panels.includes('inv.back'), v);
    // Back to the game for the scenarios that follow.
    await page.goto(gameUrl);
    await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 });
    await quickStart();
  }],
  ['inv', 'inventory flows: wear by dropping on the doll, take off by dragging a layer off, shift-click, double-click eat, i closes', async () => {
    await toGameplay();
    await js(`cdda.inv2.spawn('hat_hard', 0, 0); cdda.inv2.spawn('crowbar', 0, 0); cdda.inv2.spawn('chocolate', 0, 0, { charges: 3 })`);
    await x.key('i');
    await until((t) => t.panels.includes('Equipment'), 3000);
    const c0 = await censusNow();
    let r = await rectOf('hat_hard', NEARBY);
    // The Nearby list can lag the window by a few frames on a slow page (Firefox's software GL,
    // headful 3440x1304): wait for the row instead of failing on a null rect (QA_WAVE3).
    for (let i = 0; i < 30 && !r; i++) {
      await sleep(100);
      r = await rectOf('hat_hard', NEARBY);
    }
    if (!check('the hard hat is listed in Nearby', !!r, await whereIs('hat_hard'))) return;
    await drag([r!.x, r!.y], (await center(`${EQUIP} [data-part="head"]`))!);
    check('dropping the hard hat on the head slot wears it', (await whereIs('hat_hard')).some((l) => l.startsWith('worn')), await whereIs('hat_hard'));
    await shot('inv_worn_hat');
    await drag((await center(`${EQUIP} [data-part="head"] .bn-stack`))!, (await center(`${NEARBY} .bn-list`))!);
    check('dragging it off the doll onto Nearby takes it off and puts it down', (await whereIs('hat_hard')).some((l) => l.startsWith('ground')), await whereIs('hat_hard'));
    r = await rectOf('crowbar', NEARBY);
    await drag([r!.x, r!.y], (await center(`${EQUIP} [data-part="hands"]`))!);
    check('dropping the crowbar on the hands wields it', (await whereIs('crowbar')).some((l) => l === 'hands×1'), await whereIs('crowbar'));
    r = await rectOf('chocolate', NEARBY);
    await x.moveTo(r!.x, r!.y, 2);
    await x.down('Shift');
    await x.clickHere(1);
    await x.up('Shift');
    await sleep(300);
    check('Shift-click on Nearby takes it (quick move)', (await whereIs('chocolate')).some((l) => l.startsWith('inv')), await whereIs('chocolate'));
    sameCensus('census unchanged after wear / take off / wield / quick move', c0, await censusNow());
    const before = (await censusNow()).counts.chocolate ?? 0;
    r = await rectOf('chocolate', CARRIED);
    await x.moveTo(r!.x, r!.y, 2);
    await x.clickHere(1);
    await sleep(60);
    await x.clickHere(1);
    await sleep(400);
    const after = (await censusNow()).counts.chocolate ?? 0;
    check('double-click eats one (the primary action)', after === before - 1, { before, after });
    await shot('inv_after_eat');
    await x.key('i');
    const s = await until((t) => t.lock && !t.panels.length, 3000);
    check('i closes it again and re-captures the mouse', s.lock && !s.panels.length, s);
  }],
  ['invbag', 'v1 duplication scenario: wield a bag, open it, unload it by hand to ground and inventory, refill, Empty: nothing duplicated or lost', async () => {
    await toGameplay();
    const bagKey = await js<string>(`cdda.giveItem('backpack', { wear: true }); cdda.inv2.spawn('bag_canvas', 0, 0, { contents: [['pipe', 6]] })`);
    await x.key('Tab');
    await until((t) => t.panels.includes('Nearby'), 3000);
    const c0 = await censusNow();
    const bag = await rectOf('bag_canvas', NEARBY);
    await drag([bag!.x, bag!.y], (await center(`${EQUIP} [data-part="hands"]`))!);
    check('the bag goes to your hands', (await whereIs('bag_canvas')).some((l) => l.startsWith('hands')), await whereIs('bag_canvas'));
    const tw = await center(`${EQUIP} [data-hands] .bn-twisty`);
    if (tw) await x.click(tw[0], tw[1]);
    await sleep(300);
    await shot('invbag_open');
    const inBag = () => whereIs('pipe').then((l) => l.filter((w) => w.startsWith(`in:${bagKey}`)));
    // Ctrl-click the pipes inside: "how many?" (Enter = half) → to the loot target (the ground).
    let p = await rectOf('pipe', `${EQUIP} [data-hands]`);
    await x.moveTo(p!.x, p!.y, 2);
    await x.down('Control');
    await x.clickHere(1);
    await x.up('Control');
    await sleep(300);
    await shot('invbag_count_prompt');
    await x.key('Return');
    await sleep(400);
    check('Ctrl-click → Enter moves half of the stack out of the bag', (await inBag()).join() === `in:${bagKey}×3`, await whereIs('pipe'));
    sameCensus('…census unchanged', c0, await censusNow());
    p = await rectOf('pipe', `${EQUIP} [data-hands]`);
    await drag([p!.x, p!.y], (await center(`${CARRIED} .bn-list`))!);
    check('dragging the rest into the Inventory list empties the bag', !(await inBag()).length, await whereIs('pipe'));
    sameCensus('…census unchanged', c0, await censusNow());
    await shot('invbag_emptied');
    // Refill it by dropping the carried pipes on the bag's row, then Empty it from its menu.
    p = await rectOf('pipe', CARRIED);
    const bagRow = await center(`${EQUIP} [data-hands] .bn-row`);
    await drag([p!.x, p!.y], bagRow!);
    check('dropping pipes on the bag row puts them in', (await inBag()).length === 1, await whereIs('pipe'));
    const bagRow2 = await center(`${EQUIP} [data-hands] .bn-row .ui2-row-name`);
    await x.click(bagRow2![0], bagRow2![1], 3);
    await sleep(300);
    const menu = await js<string[][]>('cdda.ui2.state().menu');
    await shot('invbag_menu');
    const empty = await js<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('#ui2 .ui2-menu-row')].find((r) => /^Empty/.test(r.textContent.trim())); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (empty) await x.click(empty.x, empty.y);
    await sleep(500);
    check('the Empty action (right-click menu) unloads it', !(await inBag()).length, { at: await whereIs('pipe'), menu });
    sameCensus('census unchanged after refill + Empty (the v1 bug duplicated here)', c0, await censusNow());
    await x.key('Tab');
    await until((t) => t.lock, 3000);
  }],
  ['invloot', 'looting: g opens the Nearby tab, Take all takes what fits and says what stayed and why', async () => {
    await toGameplay();
    await js(`cdda.inv2.spawn('pipe', 1, 0); cdda.inv2.spawn('rock', 1, 0); cdda.inv2.spawn('stepladder', 1, 0); cdda.inv2.spawn('bag_canvas', 1, 0)`);
    await x.key('g');
    await until((t) => t.panels.includes('Nearby'), 3000);
    const c0 = await censusNow();
    const tabs = await js<string[]>(`[...document.querySelectorAll('#ui2 [data-id="inv.nearby"] .ui2-tab')].map((t) => t.textContent)`);
    check('g opens the inventory on the Nearby places', tabs.length > 0, tabs);
    const east = await js<{ x: number; y: number } | null>(`(() => { const t = [...document.querySelectorAll('#ui2 [data-id="inv.nearby"] .ui2-tab')].find((e) => /^east/i.test(e.textContent.trim())); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (east) await x.click(east.x, east.y);
    await sleep(250);
    const take = await js<{ x: number; y: number } | null>('cdda.ui2.textRect("Take all")');
    await x.click(take!.x, take!.y);
    await sleep(400);
    const result = await js<string>(`document.querySelector('#ui2 .bn-result')?.textContent ?? ''`);
    check('Take all reports what it took and what stayed and why (the stepladder: no room)', /Took .*pipe/.test(result) && /stepladder.*room/i.test(result), result);
    await shot('invloot_takeall');
    sameCensus('census unchanged by Take all', c0, await censusNow());
    await x.key('Tab');
    await until((t) => t.lock, 3000);
  }],
  ['inve', 'e on a pile of loot a step away opens the inventory on that place', async () => {
    await toGameplay();
    await js(`cdda.inv2.spawn('pipe', 1, 0); cdda.inv2.spawn('rock', 1, 0)`);
    // This is the "Inventory tabs" looting style (the quick style takes with e: lootquick).
    await js(`cdda.loot.setStyle('tabs')`);
    // Setup: look down at the tile east of you (yaw east, pitch toward the floor a step away).
    await js('cdda.game.player.yaw = Math.PI / 2; cdda.game.player.pitch = -0.95');
    await sleep(200);
    await x.key('e');
    const s = await until((t) => t.panels.includes('Nearby'), 3000);
    const on = await js<string>(`document.querySelector('#ui2 [data-id="inv.nearby"] .ui2-tab.on')?.textContent ?? ''`);
    check('e on the pile opens the inventory with that place in front', s.panels.includes('Nearby') && /east/i.test(on), { panels: s.panels, on });
    await shot('inve_focus');
    await x.key('Tab');
    await until((t) => t.lock, 3000);
    await js(`cdda.loot.setStyle('quick')`);
  }],
  ['invliquid', 'liquids: drag a bottle of water onto a jar pours it; dropping water on the world asks before spilling', async () => {
    await toGameplay();
    await js(`cdda.giveItem('backpack', { wear: true }); cdda.inv2.spawn('bottle_plastic', 0, 0, { contents: [['water_clean', 2]] }); cdda.inv2.spawn('jar_glass', 0, 0)`);
    // Setup: look up, off the pile inve left east (Tab while the crosshair is on a pile opens the inventory on it).
    await js('cdda.game.player.pitch = 1.5');
    await sleep(300);
    await x.key('Tab');
    await until((t) => t.panels.includes('Nearby'), 3000);
    const c0 = await censusNow();
    const b = await rectOf('bottle_plastic', NEARBY);
    const j = await rectOf('jar_glass', NEARBY);
    await drag([b!.x, b!.y], [j!.x, j!.y]);
    const jarKey = (await rectOf('jar_glass', NEARBY))?.id ?? '';
    const inJar = () => whereIs('water_clean').then((l) => l.filter((w) => w.startsWith(`in:${jarKey}`)));
    check('dragging the bottle onto the jar pours the water in', (await inJar()).join() === `in:${jarKey}×2`, { at: await whereIs('water_clean'), jarKey });
    sameCensus('pouring conserves', c0, await censusNow());
    const tw = await js<{ x: number; y: number } | null>(`(() => { const row = document.querySelector('#ui2 [data-id="inv.nearby"] [data-item="${jarKey}"]'); const t = row?.querySelector('.bn-twisty'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (tw) await x.click(tw.x, tw.y);
    await sleep(300);
    await shot('invliquid_jar_open');
    let w = await rectOf('water_clean', NEARBY);
    await drag([w!.x, w!.y], (await center(`${CARRIED} .bn-list`))!);
    check('loose water is refused by the inventory (needs a container)', (await inJar()).length === 1, await whereIs('water_clean'));
    w = await rectOf('water_clean', NEARBY);
    await drag([w!.x, w!.y], (await center('canvas'))!);
    await sleep(300);
    const modal = await js<string>(`document.querySelector('#ui2 .ui2-layer-modal')?.textContent ?? ''`);
    check('dropping water on the world asks before spilling it', /Spill|Pour/i.test(modal), modal);
    await shot('invliquid_confirm');
    const ok = await js<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('#ui2 .ui2-layer-modal button')].find((b) => /Pour it out/.test(b.textContent)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (ok) await x.click(ok.x, ok.y);
    await sleep(400);
    const c1 = await censusNow();
    check('confirmed: the water left the jar for the ground', !(await inJar()).length, await whereIs('water_clean'));
    sameCensus('spilling conserves (it is on the ground now)', c0, c1);
    await x.key('Tab');
    await until((t) => t.lock, 3000);
  }],
  ['invkeys', 'accelerators: z / E open quick pickers; the hotbar binds by drag and 1…0 work in gameplay', async () => {
    await toGameplay();
    await js(`cdda.giveItem('backpack', { wear: true }); cdda.giveItem('knife_combat'); cdda.giveItem('chocolate')`);
    await x.key('z');
    let s = await until((t) => t.panels.includes('Wield what?'), 2000);
    check('z opens the "Wield what?" picker', s.panels.includes('Wield what?'), s.panels);
    await shot('invkeys_wield_picker');
    await x.key('space');
    s = await until((t) => !t.panels.length, 2000);
    check('Space closes it', !s.panels.length, s.panels);
    // Hungry again (earlier scenarios fed the survivor until "Your stomach is full").
    await js('cdda.game.player.stomach.kcal = 0; cdda.game.player.storedKcal = 5000');
    await x.key('E');
    s = await until((t) => t.panels.includes('Eat or drink what?'), 2000);
    check('E opens the eat picker', s.panels.includes('Eat or drink what?'), s.panels);
    const c0 = (await censusNow()).counts.chocolate ?? 0;
    const row = await js<{ x: number; y: number } | null>(`(() => { const r = [...document.querySelectorAll('#ui2 .bn-pick-row')].find((e) => /chocolate/i.test(e.textContent)); if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.left + 80), y: Math.round(b.top + b.height / 2) }; })()`);
    if (row) await x.click(row.x, row.y);
    // Time runs again once the picker closes: eating takes its moves.
    await sleep(2500);
    check('clicking chocolate in it eats one', ((await censusNow()).counts.chocolate ?? 0) === c0 - 1, { c0 });
    await toGameplay();
    await x.key('Tab');
    await until((t) => t.panels.includes('Inventory'), 2000);
    const k = await rectOf('knife_combat', CARRIED);
    await drag([k!.x, k!.y], (await center('#ui2 .ui2-hot-slot[data-slot="2"]'))!);
    const bound = await js<string | null>(`cdda.inv2.hotbar.binding(2)?.typeId ?? null`);
    check('dragging the knife onto hotbar slot 3 binds it', bound === 'knife_combat', bound);
    await x.key('Tab');
    await until((t) => t.lock, 3000);
    await x.key('3');
    await sleep(1500);
    check('3 in gameplay wields it', (await whereIs('knife_combat')).some((l) => l.startsWith('hands')), await whereIs('knife_combat'));
    const hb = await js<{ label: string; active: boolean; names: string[] }>(`(() => {
      const c = document.querySelector('#ui2 .ui2-hot-slot[data-slot="2"]');
      return { label: c?.querySelector('.ui2-hot-name')?.textContent ?? '', active: !!c?.classList.contains('active'),
        names: [...document.querySelectorAll('#ui2 .ui2-hot-slot.bound .ui2-hot-name')].map((e) => e.textContent) };
    })()`);
    check('bound slots carry a name label ("knife" under slot 3), and the wielded one is highlighted', hb.label === 'knife' && hb.active && hb.names.every(Boolean), hb);
    await x.key('3');
    await sleep(250);
    const flash = await js<string>(`document.querySelector('#ui2 .ui2-hot-flash.show')?.textContent ?? ''`);
    check('a number key says what it used above the slot ("3: combat knife")', /^3: .*knife/.test(flash), flash);
    await shot('invkeys_hotbar_flash');
    await sleep(1300);
    await x.key('9');
    await sleep(200);
    const empty = await js<string>(`document.querySelector('#ui2 .ui2-hot-flash.show')?.textContent ?? ''`);
    check('an empty slot says how to fill it', /^9: empty/.test(empty), empty);
    await x.key('3');
    await sleep(1500);
    check('3 wields it again', (await whereIs('knife_combat')).some((l) => l.startsWith('hands')), await whereIs('knife_combat'));
    await shot('invkeys_hotbar');
    await x.key('3');
    await sleep(1500);
    check('3 again puts it away', (await whereIs('knife_combat')).some((l) => l.startsWith('inv')), await whereIs('knife_combat'));
  }],
  ['pause', 'tactical pause: ` freezes time but not the view, works inside menus; Classic menus run, the Esc menu pauses', async () => {
    await toGameplay();
    await js(`cdda.setDifficulty('accessible')`);
    const clock = () => js<number>('cdda.game.clock.seconds');
    await x.key('grave');
    await sleep(300);
    let tp = await js<{ paused: boolean; manual: boolean }>('cdda.tacticalPause()');
    const banner = await js<string>(`document.querySelector('[data-banner=pause] .hud2-banner-text')?.textContent ?? 'missing'`);
    check('` pauses (manual) and shows the PAUSED banner', tp.paused && tp.manual && banner === 'PAUSED', { tp, banner });
    const c0 = await clock(), yaw0 = await js<number>('cdda.game.player.yaw');
    await x.move(250, 0);
    await sleep(800);
    const c1 = await clock(), yaw1 = await js<number>('cdda.game.player.yaw');
    check('…time stands still', c1 === c0, { c0, c1 });
    check('…but the mouse still turns the view', Math.abs(yaw1 - yaw0) > 0.05, { yaw0, yaw1 });
    await x.key('i');
    await sleep(400);
    await x.key('grave');
    await sleep(200);
    tp = await js('cdda.tacticalPause()');
    check('` inside the inventory toggles the pause off', !tp.manual, tp);
    await x.key('i');
    await sleep(300);
    // Accessible ui2 inventory holds the pause; a manual pause survives closing it.
    await x.key('Tab');
    await sleep(300);
    await x.key('grave');
    await x.key('Tab');
    await sleep(300);
    tp = await js('cdda.tacticalPause()');
    check('a pause started in the ui2 inventory survives closing it', tp.paused && tp.manual, tp);
    await x.key('grave');
    await until((t) => t.lock, 3000);
    // Classic: time runs in menus, the Esc menu still stops it.
    await js(`cdda.setDifficulty('classic')`);
    await x.key('i');
    await sleep(300);
    const m0 = await clock();
    await sleep(1000);
    const m1 = await clock();
    check('Classic: time runs with the inventory open', m1 > m0, { m0, m1 });
    await x.key('i');
    await sleep(300);
    await x.key('Escape');
    await until((t) => t.panelIds.includes('scr.esc'), 2000);
    const e0 = await clock();
    await sleep(1000);
    const e1 = await clock();
    // The ui2 Esc menu is a pauses: 'always' surface: a pause hold, not only the lost mouse.
    const paused = await js<boolean>('cdda.game.tacticalPause');
    check('Classic: the Esc menu stops time (a pause hold, not only the lost mouse)', e1 === e0 && paused, { e0, e1, paused, panels: (await state()).panelIds });
    await js(`cdda.setDifficulty('accessible')`);
    await toGameplay();
  }],
  ['save', 'F5 saves; leaving the page asks first; title Load/Memorial screens', async () => {
    await toGameplay();
    const before = (await log()).length;
    await js('window.__samePage = 1');
    await x.key('F5');
    await sleep(1500);
    const msgs = (await log()).slice(before);
    const same = await js<boolean>('window.__samePage === 1');
    check('F5 says the game was saved (and does not reload the page)', same && msgs.some((m) => /saved/i.test(m)), { same, msgs });
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
    const t = await atTitle();
    check('…and the title screen is up (not a resumed game)', t.title && !t.playing, t);
  }],
  ['quit', 'Esc > Quit to main menu reaches the title: after play, after driving, after a load (human report)', async () => {
    // From wherever the previous scenario left off (death leaves the title): a quick start.
    if (!(await js<boolean>('!!cdda.game.input.wantLock'))) await quickStart();
    await toGameplay();
    // Play a little: walk, open and close the inventory, look around.
    await x.hold('w', 800);
    await x.move(200, 0);
    await x.key('i');
    await until((t) => t.panels.includes('Equipment'), 2000);
    await x.key('i');
    await until((t) => t.lock, 3000);
    let r = await quitToMenu('after walking about');
    check('Quit to main menu → Quit: the title screen', r.title && !r.playing, r);
    // Driving: a car on a road, at the wheel (setup), then Esc > Quit.
    await quickStart();
    await toGameplay();
    await js(`JSON.stringify(cdda.roadTrip('car'))`);
    await x.hold('w', 1200);
    r = await quitToMenu('while driving');
    check('…while driving too', r.title && !r.playing, r);
    // After a load: F5 saves, title > Load > the save, then quit.
    await quickStart();
    await toGameplay();
    await x.key('F5');
    await sleep(1500);
    await x.hold('w', 500);
    r = await quitToMenu('before loading');
    await x.click(W / 2, 20);
    await x.key('l');
    await until((t) => t.windows.includes('Load game'), 3000);
    await x.key('Return');
    await page.waitForFunction('window.cdda?.ready && cdda.game.input.wantLock', { timeout: 240_000 }).catch(() => {});
    await sleep(800);
    const loaded = await js<boolean>('!!cdda.game.input.wantLock');
    check('title > Load > Enter loads the save into the game', loaded, await atTitle());
    if (loaded) {
      await toGameplay();
      r = await quitToMenu('after a load');
      check('…and quitting after a load reaches the title', r.title && !r.playing, r);
    }
    if (!hmr) return;
    // --hmr: a code edit mid-game (Vite full reload → the dev snapshot resumes the run), then quit.
    // The dev-only resume must not also swallow the deliberate quit.
    await quickStart();
    await toGameplay();
    await x.hold('w', 500);
    const name = await js<string>('cdda.game.player.name');
    await js('window.__beforeHot = 1');
    const now = new Date();
    utimesSync(resolve('src/main.ts'), now, now);
    await sleep(2500);
    await page.waitForFunction('window.cdda?.ready && cdda.game.input.wantLock', { timeout: 240_000 }).catch(() => {});
    await sleep(800);
    const resumed = await js<string>('cdda.game?.player.name ?? ""');
    const reloaded = await js<boolean>('!window.__beforeHot');
    check('a hot reload mid-game resumes the same survivor', reloaded && resumed === name, { reloaded, name, resumed });
    await toGameplay();
    r = await quitToMenu('after a hot reload');
    check('…and Quit to main menu after it reaches the title', r.title && !r.playing, r);
    // A newcomer's keyboard path: Q opens the confirm; Enter must not quit (destructive), y does.
    await quickStart();
    await toGameplay();
    await x.key('Escape');
    await until((t) => t.panelIds.includes('scr.esc'), 3000);
    await x.key('Q');
    await sleep(300);
    await x.key('Return');
    await sleep(600);
    const still = await js<boolean>('!!cdda.game.input.wantLock');
    const modal = await js<string>(`document.querySelector('#ui2 .ui2-layer-modal')?.textContent ?? ''`);
    await shot('quit_confirm_enter');
    check('Q then Enter keeps the confirm up (Enter never confirms a destructive choice)', still && /Quit to main menu\?/.test(modal), { still, modal });
    check('…and says how to confirm instead of doing nothing', /Press Y/.test(modal), modal);
    await x.key('y');
    await sleep(1500);
    await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 }).catch(() => {});
    await sleep(800);
    const t = await atTitle();
    check('…y quits to the title', t.title && !t.playing, t);
  }],
];

/** Is the title screen up, with no game being played behind it? */
async function atTitle(): Promise<{ title: boolean; playing: boolean; windows: string[]; panels: string[] }> {
  const s = await state();
  return {
    title: await js<boolean>(`!!document.querySelector('.main-menu .title-entry')`),
    playing: await js<boolean>('!!cdda.game?.input.wantLock'),
    windows: s.windows,
    panels: s.panels,
  };
}

/** Esc → pause menu → "Quit to main menu" (a real click) → Quit in the confirm (real click). */
async function quitToMenu(when: string): Promise<{ title: boolean; playing: boolean; windows: string[]; panels: string[]; dialogs: string[] }> {
  await x.key('Escape');
  let s = await until((t) => t.panelIds.includes('scr.esc'), 3000);
  if (!s.panelIds.includes('scr.esc')) {
    // Some state swallowed the first Esc (a menu was open): once more.
    await sleep(1400);
    await x.key('Escape');
    s = await until((t) => t.panelIds.includes('scr.esc'), 3000);
  }
  check(`${when}: Esc opens the pause menu`, s.panelIds.includes('scr.esc'), [s.panelIds, s.windows]);
  await shot(`quit_${when}`);
  const q = await js<{ x: number; y: number } | null>('cdda.ui2.textRect("Quit to main menu")');
  if (q) await x.click(q.x, q.y);
  await sleep(400);
  const modal = await js<string>(`document.querySelector('#ui2 .ui2-layer-modal')?.textContent ?? ''`);
  check(`${when}: it asks to confirm`, /Quit to main menu\?/.test(modal), modal);
  dialogs.length = 0;
  const ok = await js<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('#ui2 .ui2-layer-modal button')].find((b) => /^Quit/.test(b.textContent.trim())); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (ok) await x.click(ok.x, ok.y);
  // The page reloads to the title: wait for the new page to be up.
  await sleep(1500);
  await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 }).catch(() => {});
  await sleep(1000);
  return { ...(await atTitle()), dialogs: [...dialogs] };
}

// Looting (quick loot, area loot, the sweep comparison): before 'death'.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...lootScenarios({
  page: () => page, x: () => x, js, check, shot, toGameplay, sleep, size: [W, H],
  fresh: async () => {
    await page.goto(gameUrl);
    await page.waitForFunction('window.cdda?.ready', { timeout: 240_000 });
    await quickStart();
  },
}));

// Interaction screens (dialogue, trade, missions, vehicles, body, Autodoc, scores): before 'death'.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...screenScenarios({ page: () => page, x: () => x, js, check, shot, toGameplay, sleep }));
// Driving collision against the drawn body (roads, then the refugee center's lot): right after the vehicle screens.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...driveScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// The world is drawn at the default look/shadows, flashlight on and off (docs/PERF.md): early,
// right after the basic movement scenarios, so a blank world fails the smoke run.
scenarios.splice(scenarios.findIndex(([n]) => n === 'move') + 1, 0, ...drawnScenarios({ page: () => page, x: () => x, js, check, shot, toGameplay, sleep }));
// Streaming while driving through town (docs/PERF.md): real W / C / F3 / Shift+F3.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...perfScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Vehicles v3 chassis templates: a pickup, a box van and a bus driven through town.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...chassisScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));

// Archery (draw, loose, why-missed, arrow recovery): last before 'death' — it leaves a bow, arrows and
// a backpack in the inventory, which shifts the item lists the screen scenarios drag from.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...archeryScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Aim models (free aim vs classic dice, the timing games): also after the screen scenarios (it hands out weapons).
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...aimScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Every Options row cycles (wave-3 QA): after everything else, so its toggles can't shift earlier scenarios.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...qaScenarios({ x: () => x, js, check, shot, toGameplay, sleep, errors: () => errors }));
// The style gallery (docs/GALLERY.md): its own page; restores localStorage and comes back to a quick-started game.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...galleryScenarios({ page: () => page, x: () => x, js, check, shot, toGameplay, sleep, errors: () => errors, gameUrl: () => gameUrl, quickStart }));
// Walkable stairs (docs/STAIRS.md): the shelter flight, a zombie following, a spiral, the roof ladder.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...stairsScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// grab / drag (tools/realinput_grab.ts) and the hotbar's longbow
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...grabScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Curtained windows (docs/FURNITURE.md) and smash sounds (docs/AUDIO.md): e menu, light, sight, peek, doors heard.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...curtainsScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...sewerScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Reload help (src/game/reloadhelp.ts): a battery-less flashlight says what it takes and where you saw some.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...reloadScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Carried UPS charging (src/game/upsTransfer.ts): enable it from the item menu, wait, see it charge.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...upsScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Power armor (src/game/powerArmor.ts): Activate the worn exoskeleton, UPS then interface CBM draw, shutdown.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...powerArmorScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Siphoning and refilling (src/game/siphoning.ts, vehicleRefill.ts): the hose and pour drawn by src/render/hoseFx.ts.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...siphonScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// NPCs in the line of fire (pellets, the attack question, arrows): hands out its own weapons.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...npcFireScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Enemy arrows on the arc, lobbed grenades and their blasts, BN's projectile dodge (realinput_enemyproj.ts).
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...enemyProjScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Skills feedback (src/ui/practice_cue.ts): disassemble from the inventory, the practice cue, @ hints.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...skillsScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Fast-forward (reading, the Rest window's Fast pick, the cap measurement).
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...timewarpScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...readquizScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Load gate + creatures never before their walls (src/loadgate, render/surroundings.ts): reloads the page, ends in a car.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...loadgateScenarios({ page: () => page, x: () => x, js, check, shot, toGameplay, sleep, quickStart, size: [W, H] }));
// Deferred tool-use gestures (src/game/fire.ts, src/nature.ts, docs/CHARACTERS.md): an axe chop
// only animates once the activity actually finishes, never on open or cancel.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...toolGestureScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Achievements/scores (src/game/achievements.ts): a real kill and real walking tracked end to end.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...achievementsScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Moving around inside vehicles (src/game/vehwalk.ts): deck walking, seat hops, crew stations.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...vehwalkScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Vehicle turrets (src/turrets.ts): man the Abrams' 120 mm and M2, load from the rack, fire at zombies.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...turretScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// Tow cables (src/game/towing.ts): attach through the vehicle panel, a pickup and the Abrams tow a car through a turn.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...towingScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));
// The lab escape start (lab_chal through the picker, waking in a lab_escape_cells cell): reloads the page.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...labEscapeScenarios({ page: () => page, x: () => x, js, check, shot, toGameplay, sleep, size: [W, H] }));
// BN's full z range (docs/WORLD_TRANSPORT.md): down the classic lab to z-10 with real keys.
scenarios.splice(scenarios.findIndex(([n]) => n === 'death'), 0, ...deepLabScenarios({ x: () => x, js, check, shot, toGameplay, sleep }));

if (argv.includes('--list') || argv.includes('--dry-run')) {
  for (const [n, what] of scenarios) console.log(`${only && !only.has(n) ? '  (skip)' : '  run   '} ${n.padEnd(11)} ${what}`);
  process.exit(0);
}

// ------------------------------------------------------------------ run
const { display } = await startXvfb(W + 40, H + 200);
console.log(`Xvfb ${display}`);
// --hmr: the dev server as `npm run dev` runs it (hot reload on, the dev-only snapshot/resume
// code in src/save/install.ts active), which is what the human playtests against.
const vite = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: hmr ? undefined : false }, logLevel: 'error' });
await vite.listen();
const port = (vite.httpServer!.address() as { port: number }).port;
const browser = await launchBrowser(browserKind, W, H, { gpu });
page = (await browser.pages())[0] ?? (await browser.newPage());
x = new XInput(page);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String((e as Error).stack ?? e)));
page.on('dialog', (d) => {
  dialogs.push(d.type());
  void d.accept();
});
gameUrl = `http://127.0.0.1:${port}/?seed=1&realinput=1&menu=1${extraParams ? `&${extraParams}` : ''}`;
await page.goto(gameUrl);
await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
await fitWindow(page, browserKind, W, H);
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

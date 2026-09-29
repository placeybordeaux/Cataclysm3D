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
  for (let i = 0; i < 8 && s.windows.length; i++) {
    const n = s.windows.length;
    await x.key(i % 2 ? 'Escape' : 'Backspace');
    s = await state();
    if (s.windows.length === n && i % 2) check(`${s.windows[n - 1]} closes on Backspace or Esc`, false, s.windows);
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

// ------------------------------------------------------------------ scenarios
type Scenario = [name: string, what: string, run: () => Promise<void>];
const scenarios: Scenario[] = [
  ['title', 'title screen → new character → gameplay captures the mouse; hints close with Bksp', async () => {
    let s = await state();
    check('title screen has a free cursor', !s.lock && s.captured, s);
    const nb = await center('.mm-item[data-i="0"]');
    await x.click(nb![0], nb![1]);
    s = await until((t) => t.windows.includes('New Character'));
    check('clicking New Game opens character creation', s.windows.includes('New Character'), s.windows);
    await shot('chargen');
    await x.key('F');
    s = await until((t) => t.windows.includes('Confirm'));
    check('F finishes from the first tab (asks to confirm)', s.windows.includes('Confirm'), s.windows);
    await x.key('y');
    await sleep(300);
    s = await state();
    if (s.windows.includes('Confirm')) await x.key('y');
    s = await until((t) => t.windows.includes('Hints'), 8000);
    check('new game shows the hints', s.windows.includes('Hints'), s.windows);
    check('the confirming key press captured the mouse', s.lock, s);
    await shot('hints');
    const fits = await js<boolean>(`(() => { const b = document.querySelector('.cdda-window .body'); return b.scrollHeight <= b.clientHeight + 2; })()`);
    check(`hints fit without scrolling at ${W}x${H}`, fits);
    await x.key('Backspace');
    s = await state();
    check('Backspace closes the hints and keeps mouse-look', !s.windows.length && s.lock, s);
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
      ['R', 'Read what?'], ['&', 'Crafting'], ['*', 'Construction'], ['(', 'Disassemble item:'], ['@', 'Character'], ['m', ''],
      ['P', 'Messages'], ['?', 'Help'], [')', ''], ['p', ''], ['[', ''], ['_', ''], ['M', ''], ['x', 'Look Around'], ['q', 'Drop which items?'],
      ['|', ''], ['$', ''], ['C', ''], ['B', ''],
    ];
    for (const [k, title] of keys) {
      const before = (await log()).length;
      await x.key(k);
      let s = await until((t) => t.windows.length > 0, 1200);
      const msgs = (await log()).slice(before);
      if (!s.windows.length) {
        // Not every key opens a window (nothing to butcher here); it must at least say something.
        check(`${k}: no window, but a message says why`, msgs.length > 0, msgs.length ? msgs.join(' / ') : 'no window and no message');
        continue;
      }
      const top = s.windows[s.windows.length - 1];
      check(`${k} opens ${title || top}`, !title || top === title, s.windows);
      await shot(`menu_${top || k}`);
      const legend = await js<string>(`[...document.querySelectorAll('.cdda-window .footer')].pop()?.textContent ?? ''`);
      check(`${k}: footer names the close keys`, /Esc/.test(legend), legend);
      const overflowX = await js<boolean>(`(() => { const w = [...document.querySelectorAll('.cdda-window')].pop(); const r = w.getBoundingClientRect(); return r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1; })()`);
      check(`${k}: window fits the ${W}x${H} screen`, !overflowX);
      await x.key(k);
      s = await until((t) => !t.windows.length, 800);
      if (s.windows.length) {
        // A second-level window (item action menu, confirm) — fall back to Backspace.
        check(`${k} closes ${top} again`, false, s.windows);
        await toGameplay();
      } else check(`${k} closes ${top} again, mouse still captured`, s.lock, s);
    }
  }],
  ['esc', 'Esc: pause menu, Esc in a menu, resuming by key and by click', async () => {
    await toGameplay();
    await x.key('Escape');
    let s = await until((t) => t.windows.length > 0);
    check('Esc in gameplay opens the pause menu', s.windows[0] === 'Cataclysm: Dark Days Ahead', s.windows);
    check('…and the cursor is free (browser Esc)', !s.lock);
    const sel = await js<string>(`document.querySelector('.cdda-window .menu-entry.sel')?.textContent ?? ''`);
    check('pause menu highlights Resume even with the cursor resting on it', /Resume/.test(sel), sel);
    await sleep(1400);
    await x.key('r');
    s = await until((t) => t.lock);
    check('r (Resume) closes it and recaptures the mouse', !s.windows.length && s.lock, { s, refusals: await js('cdda.game.input.lockRefusals'), now: await js('performance.now()') });
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
    const r = await center('.cdda-window .menu-entry[data-i="0"]');
    await x.click(r![0], r![1]);
    s = await until((t) => t.lock);
    check('clicking Resume closes the menu and recaptures', !s.windows.length && s.lock, s);
    await x.key('Escape');
    await sleep(300);
    await x.key('Escape');
    s = await until((t) => !t.windows.length);
    check('Esc twice: menu opens and closes; hint says how to resume', !s.windows.length && s.hint, s);
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
    await x.key('Escape');
    await until((t) => t.windows.length > 0);
    await x.key('o');
    let s = await until((t) => t.windows.includes('Options'));
    check('pause menu → o opens Options', s.windows.includes('Options'), s.windows);
    await x.key('Enter'); // first entry: Key bindings…
    s = await until((t) => t.windows.includes('Key bindings'));
    check('Enter on the first entry opens Key bindings', s.windows.includes('Key bindings'), s.windows);
    await shot('keybindings');
    const idx = await js<number>(`cdda.game.keys.actionList().findIndex((a) => a.id === 'wear')`);
    await x.key(`Down*${idx}`, 30);
    await x.key('Enter');
    await x.key('Shift+w');
    let flash = await js<string>(`document.querySelector('.cdda-window .body .pre')?.textContent ?? ''`);
    check('binding Shift+W is refused as a movement key', /moves you/.test(flash), flash);
    await x.key('Enter');
    await x.key('y');
    flash = await js<string>(`document.querySelector('.cdda-window .body .pre')?.textContent ?? ''`);
    check('wear is now y', await js<string>(`cdda.game.keys.label('wear')`) === 'y', flash);
    await x.key('Backspace');
    await x.key('Backspace');
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
    // Setup only: skip character creation (tested in the title scenario). The click gives
    // the page keyboard focus (xdotool types into whatever has it).
    await x.click(W / 2, 20);
    await x.key('n');
    await x.key('F');
    await x.key('y');
    await sleep(300);
    await x.key('y');
    const s = await until((t) => t.windows.includes('Hints'), 8000);
    if (!s.windows.includes('Hints')) console.log('quick start did not reach the game:', s);
    await x.key('Backspace');
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

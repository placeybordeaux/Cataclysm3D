// Real-input check that what you carry survives a page reload: pick a rucksack up off the floor
// (g), put it on (O), wield the pocket knife (z), quicksave (F5); then pick up and wield a crowbar
// *without* saving (only the page-unload save has it); reload the page (an OS-level navigation,
// not the in-place cdda.save.load) and press Continue on the title screen. The setup uses
// `cdda.spawnItem` (items on the floor) and reads state; everything a player does is xdotool.
//
//   tsx tools/realinput_saveload.ts [--browser chromium|firefox] [--hmr] [--dist] [--gpu]
//                                   [--params look=classic] [--shots dir]
//
// --hmr runs the dev server with hot reload on (the dev snapshot/resume code in src/save/install.ts
// active, as `npm run dev` runs it) and adds a mid-game code edit (touches src/main.ts: a Vite full
// reload must resume the same kit from the dev snapshot); --dist serves dist/ through `vite preview` (build first).
// Run inside nix-shell, via ~/claude-stuff/bin/heavy (it holds a browser).
//
// Why this exists: a "lost item after reload" report turned out to be tools/drive.ts `load`
// without menu=1 — under automation the title is skipped and a *new* empty-handed character
// starts (src/ui/index.ts). A player always reaches the title and Continue, which this drives.

import { mkdirSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'puppeteer-core';
import { fitWindow, launchBrowser, startXvfb, XInput, type BrowserKind } from './lib/realinput';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: tsx tools/realinput_saveload.ts [--browser chromium|firefox] [--hmr] [--dist] [--gpu] [--params look=classic] [--shots dir]');
  process.exit(0);
}
const opt = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const browserKind = opt('--browser', 'chromium') as BrowserKind;
const hmr = argv.includes('--hmr');
const dist = argv.includes('--dist');
const gpu = argv.includes('--gpu');
const extra = opt('--params', 'look=classic');
const shotsDir = opt('--shots', '');
const [W, H] = [960, 540];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: unknown = ''): boolean {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  results.push({ name, ok, detail: d });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok || !d ? '' : `  — ${d}`}`);
  return ok;
}

let page: Page;
let x: XInput;
const js = <T>(code: string): Promise<T> => page.evaluate(code) as Promise<T>;
let shotN = 0;
async function shot(name: string): Promise<void> {
  if (!shotsDir) return;
  mkdirSync(resolve(shotsDir), { recursive: true });
  await sleep(250);
  await page.screenshot({ path: resolve(shotsDir, `${String(++shotN).padStart(2, '0')}_${name}.png`) as `${string}.png` });
}
async function until(code: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js<boolean>(code).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
const playing = '!!(window.cdda?.ready && cdda.game.input.wantLock)';
interface Kit { name: string; wielded: string | null; worn: string[]; carried: string[] }
const kit = () => js<Kit>(`(() => { const p = cdda.player(); return { name: cdda.game.player.name, wielded: p.wielded, worn: p.worn, carried: p.carried }; })()`);
const lastLog = () => js<string>(`cdda.ui.log().slice(-1)[0] ?? ''`);

/** Close whatever menu is up and get the mouse captured again. */
async function toGameplay(): Promise<void> {
  if (!(await js<boolean>('!!document.pointerLockElement'))) {
    await sleep(1200);
    await x.click(W / 2, H / 2);
    await until('!!document.pointerLockElement', 3000);
  }
  for (let i = 0; i < 300 && (await js<boolean>('!!window.cdda?.loadGate?.().closed')); i++) await sleep(100);
}
/** Spawn `id` at the survivor's feet (setup), pick it up with g. */
async function pickUp(id: string, name: string): Promise<boolean> {
  await js(`cdda.spawnItem(${JSON.stringify(id)}, 0, 0)`);
  await x.key('g');
  await sleep(1200);
  return check(`g picks the ${name} up off the floor`, /pick up/i.test(await lastLog()), await lastLog());
}
/** Open a picker (O wear, z wield) and choose the entry named `name` with the arrow keys. */
async function choose(key: string, name: string): Promise<void> {
  await x.key(key);
  await sleep(1000);
  const rows = await js<string[]>(`[...document.querySelectorAll('#ui2 .ui2-win')].pop()?.innerText.split('\\n') ?? []`);
  const entries = rows.filter((r) => r.trim() && !/what\?|Enter:|In your inventory|^×$/.test(r));
  const i = Math.max(0, entries.findIndex((r) => r.includes(name)));
  if (i) await x.key(`Down*${i}`);
  await x.key('Return');
  await sleep(1200);
  await toGameplay();
}

const { display } = await startXvfb(W + 40, H + 200);
console.log(`Xvfb ${display} · ${browserKind}${hmr ? ' · hmr' : ''}${dist ? ' · dist' : ''}`);
const vite = await import('vite');
const server = dist
  ? await vite.preview({ preview: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
  : await vite.createServer({ server: { port: 0, host: '127.0.0.1', hmr: hmr ? undefined : false }, logLevel: 'error' });
if (!dist) await (server as Awaited<ReturnType<typeof vite.createServer>>).listen();
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await launchBrowser(browserKind, W, H, { gpu });
page = (await browser.pages())[0] ?? (await browser.newPage());
x = new XInput(page);
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String((e as Error).stack ?? e)));
page.on('dialog', (d) => void d.accept());
const url = `http://127.0.0.1:${port}/?seed=1&realinput=1&menu=1${extra ? `&${extra}` : ''}`;
await page.goto(url);
await until('!!(window.cdda?.ready || window.cddaError)', 240_000);
await fitWindow(page, browserKind, W, H);

// --- a new survivor (title → Start → Enter)
await x.click(W / 2, 20);
await x.key('s');
await sleep(1500);
await x.key('Return');
await until(playing, 20_000);
await toGameplay();

// --- saved kit: rucksack worn, knife wielded, then F5
await pickUp('rucksack', 'rucksack');
await choose('O', 'rucksack');
await choose('z', 'pocket knife');
const savedKit = await kit();
check('the rucksack is worn and the knife wielded', savedKit.worn.includes('military rucksack') && savedKit.wielded === 'pocket knife', savedKit);
await x.key('F5');
await until(`/saved/i.test(cdda.ui.log().slice(-3).join(' '))`, 5000);
check('F5 saves', /saved/i.test((await js<string[]>('cdda.ui.log().slice(-3)')).join(' ')));
await shot('saved');

// --- after the save: a crowbar picked up and wielded (only the unload save has it)
await pickUp('crowbar', 'crowbar');
await choose('z', 'crowbar');
const unsavedKit = await kit();
check('the crowbar is wielded (knife back in the inventory)', unsavedKit.wielded === 'crowbar' && unsavedKit.carried.includes('pocket knife'), unsavedKit);

// --- reload the page (a navigation, as a player's F5/Ctrl+R in the browser) → title → Continue
await page.reload({ waitUntil: 'load' }).catch(() => {});
await until('!!(window.cdda?.ready || window.cddaError)', 240_000);
await sleep(1500);
const resumed = await js<boolean>(playing);
if (resumed) check('reload reached the title, not a resumed game', false, 'game resumed without the title');
await shot('title');
await x.click(W / 2, 20);
await x.key('c');
const continued = await until(playing, 240_000);
check('title → c (Continue) loads the save', continued);
await sleep(1500);
await shot('continued');
const after = await kit();
check('same survivor', after.name === unsavedKit.name, { before: unsavedKit.name, after: after.name });
check('the worn rucksack survived', after.worn.includes('military rucksack'), after);
check('the wielded crowbar survived (unload save)', after.wielded === 'crowbar', after);
check('the knife is still carried', after.carried.includes('pocket knife'), after);
const missing = [...unsavedKit.worn, ...unsavedKit.carried].filter((n) => ![...after.worn, ...after.carried].includes(n));
check('nothing carried before the reload is missing', missing.length === 0, missing);

if (hmr) {
  // --- a code edit mid-game: Vite full-reloads, the dev snapshot (IndexedDB) resumes the run
  await toGameplay();
  await pickUp('hammer', 'hammer');
  await choose('z', 'hammer');
  const hotKit = await kit();
  await js('window.__beforeHot = 1');
  const now = new Date();
  utimesSync(resolve('src/main.ts'), now, now);
  await sleep(2500);
  await until(`${playing} && !window.__beforeHot`, 240_000);
  await sleep(1500);
  await shot('hot_resumed');
  const hot = await kit();
  check('a hot reload resumes the same survivor', !(await js<boolean>('!!window.__beforeHot')) && hot.name === hotKit.name, { hotKit: hotKit.name, hot: hot.name });
  check('…still wielding the hammer, wearing the rucksack', hot.wielded === 'hammer' && hot.worn.includes('military rucksack'), hot);
  const lost = [...hotKit.worn, ...hotKit.carried].filter((n) => ![...hot.worn, ...hot.carried].includes(n));
  check('…with nothing missing', lost.length === 0, lost);
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
await server.close();
process.exit(failed.length ? 1 : 0);

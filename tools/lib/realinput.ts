// OS-level input for UX testing: a private Xvfb display and xdotool. Puppeteer's own input
// (CDP Input.dispatch*) is trusted by the page but skips the browser's shortcut handling, so
// its Escape never releases pointer lock or leaves fullscreen the way a player's Esc does.
// xdotool events go through X → Chromium like a real keyboard/mouse, so Esc, F11, key repeat
// and keyboard layouts behave exactly as they do for players.
//
// Used by tools/drive.ts --headful and tools/realinput.ts. Needs Xvfb, xdotool and setxkbmap
// (all in shell.nix).

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Page } from 'puppeteer-core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start Xvfb on the first free display from :90 and point DISPLAY at it. */
export async function startXvfb(width: number, height: number): Promise<{ display: string; proc: ChildProcess }> {
  for (let n = 90; n < 140; n++) {
    if (existsSync(`/tmp/.X${n}-lock`) || existsSync(`/tmp/.X11-unix/X${n}`)) continue;
    const proc = spawn('Xvfb', [`:${n}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
    for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
    if (proc.exitCode !== null) continue;
    process.env.DISPLAY = `:${n}`;
    process.on('exit', () => proc.kill());
    return { display: `:${n}`, proc };
  }
  throw new Error('no free X display between :90 and :139');
}

// Friendly names → X keysyms, so callers can write "&" or "Enter" like puppeteer tokens.
const KEYSYMS: Record<string, string> = {
  Enter: 'Return', Backspace: 'BackSpace', Esc: 'Escape', ' ': 'space', Space: 'space',
  '&': 'ampersand', '?': 'question', '*': 'asterisk', '(': 'parenleft', ')': 'parenright', '@': 'at',
  $: 'dollar', '|': 'bar', '^': 'asciicircum', _: 'underscore', '[': 'bracketleft', ']': 'bracketright',
  '<': 'less', '>': 'greater', ',': 'comma', '.': 'period', '/': 'slash', '+': 'plus', '-': 'minus',
  '!': 'exclam', '#': 'numbersign', '%': 'percent', '=': 'equal', ';': 'semicolon', ':': 'colon',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Shift: 'shift', Control: 'ctrl', Alt: 'alt',
};

// Function keys by X keycode: Xvfb's default keymap lists F1…F12 again on Alt+Ctrl levels
// (VT switching), and xdotool then sends a stray Alt with the key.
const FKEYS: Record<string, string> = { F1: '67', F2: '68', F3: '69', F4: '70', F5: '71', F6: '72', F7: '73', F8: '74', F9: '75', F10: '76', F11: '95', F12: '96' };

/** "Shift+w" / "&" / "Enter" / "k:25" (raw X keycode) → an xdotool key argument. */
export function keysym(tok: string): string {
  if (tok.startsWith('k:')) return tok.slice(2);
  if (FKEYS[tok]) return FKEYS[tok];
  return tok
    .split('+')
    .map((p, i, a) => (i < a.length - 1 ? (KEYSYMS[p] ?? p).toLowerCase() : KEYSYMS[p] ?? p))
    .join('+');
}

export class XInput {
  constructor(private page: Page) {}

  private x(...args: string[]): void {
    execFileSync('xdotool', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  /** Press keys in order: "i Escape Shift+w &". "ArrowDown*5" repeats. */
  async key(tokens: string, gapMs = 80): Promise<void> {
    const toks = tokens.trim().split(/\s+/).filter(Boolean).flatMap((t) => {
      const m = /^(.+)\*(\d+)$/.exec(t);
      return m ? Array<string>(Number(m[2])).fill(m[1]) : [t];
    });
    for (const t of toks) {
      this.x('key', '--delay', '30', keysym(t));
      await sleep(gapMs);
    }
  }
  async down(tok: string): Promise<void> {
    this.x('keydown', keysym(tok));
  }
  async up(tok: string): Promise<void> {
    this.x('keyup', keysym(tok));
  }
  /** Hold a key (X autorepeat applies, like a real keyboard). */
  async hold(tok: string, ms: number): Promise<void> {
    await this.down(tok);
    await sleep(ms);
    await this.up(tok);
  }
  async type(text: string): Promise<void> {
    this.x('type', '--delay', '40', text);
  }
  /** Relative mouse motion (what mouse-look reads under pointer lock). */
  async move(dx: number, dy: number, steps = 10): Promise<void> {
    for (let i = 0; i < steps; i++) {
      this.x('mousemove_relative', '--', String(Math.round(dx / steps)), String(Math.round(dy / steps)));
      await sleep(16);
    }
  }
  /** Page CSS coordinates → screen coordinates (the window's toolbar sits above the viewport). */
  private async screenXY(x: number, y: number): Promise<[number, number]> {
    const o = await this.page.evaluate(() => ({
      sx: window.screenX + (window.outerWidth - window.innerWidth) / 2,
      sy: window.screenY + window.outerHeight - window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    return [Math.round((o.sx + x) * o.dpr), Math.round((o.sy + y) * o.dpr)];
  }
  /** Click at page coordinates. button: 1 left, 2 middle, 3 right. */
  async click(x: number, y: number, button = 1): Promise<void> {
    const [sx, sy] = await this.screenXY(x, y);
    this.x('mousemove', String(sx), String(sy));
    await sleep(30);
    this.x('click', String(button));
  }
  /** Move the pointer to page coordinates (absolute), in `steps` hops so drags see motion. */
  async moveTo(x: number, y: number, steps = 1): Promise<void> {
    const [tx, ty] = await this.screenXY(x, y);
    const cur = execFileSync('xdotool', ['getmouselocation', '--shell'], { encoding: 'utf8' });
    const cx = Number(/X=(\d+)/.exec(cur)?.[1] ?? tx), cy = Number(/Y=(\d+)/.exec(cur)?.[1] ?? ty);
    for (let i = 1; i <= steps; i++) {
      this.x('mousemove', String(Math.round(cx + ((tx - cx) * i) / steps)), String(Math.round(cy + ((ty - cy) * i) / steps)));
      await sleep(16);
    }
  }
  /** Click wherever the pointer is (e.g. while locked: an attack). */
  async clickHere(button = 1): Promise<void> {
    this.x('click', String(button));
  }
  async buttonDown(button = 1): Promise<void> {
    this.x('mousedown', String(button));
  }
  async buttonUp(button = 1): Promise<void> {
    this.x('mouseup', String(button));
  }
  /** Mouse wheel: 4 = up, 5 = down (X buttons). */
  async wheel(dir: 'up' | 'down', n = 1): Promise<void> {
    for (let i = 0; i < n; i++) this.x('click', dir === 'up' ? '4' : '5');
  }
  /** Switch the X keyboard layout ("us", "fr" for AZERTY, "de" for QWERTZ). */
  layout(name: string): void {
    execFileSync('setxkbmap', [name]);
  }
}

export type BrowserKind = 'chromium' | 'firefox';
const FIREFOX = '/run/current-system/sw/bin/firefox';

/**
 * A windowed browser on the Xvfb display, placed at 0,0. Chromium through CDP (CHROME_PATH from
 * shell.nix); Firefox through WebDriver BiDi, because the human playtests in Firefox and its
 * pointer lock / Esc / WebSocket-on-unload behaviour differs from Chromium's.
 */
export async function launchBrowser(kind: BrowserKind, width: number, height: number, o: { gpu?: boolean } = {}): Promise<import('puppeteer-core').Browser> {
  const puppeteer = (await import('puppeteer-core')).default;
  if (kind === 'firefox') {
    const exe = process.env.FIREFOX_PATH ?? FIREFOX;
    if (!existsSync(exe)) throw new Error(`firefox not found at ${exe} (set FIREFOX_PATH)`);
    return puppeteer.launch({
      browser: 'firefox',
      executablePath: exe,
      headless: false,
      defaultViewport: null,
      args: [`--width=${width}`, `--height=${height + 120}`],
      extraPrefsFirefox: {
        // No "press Esc to leave" banners over the page, no first-run tabs.
        'full-screen-api.warning.timeout': 0,
        'full-screen-api.transition-duration.enter': '0 0',
        'full-screen-api.transition-duration.leave': '0 0',
        'browser.shell.checkDefaultBrowser': false,
        'browser.startup.homepage_override.mstone': 'ignore',
        'datareporting.policy.dataSubmissionEnabled': false,
      },
      protocolTimeout: 10 * 60_000,
    });
  }
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    headless: false,
    defaultViewport: null,
    // --gpu: the real GPU through ANGLE/Vulkan (works under Xvfb). SwiftShader renders on the CPU:
    // the default "full" look then runs at a few fps on a busy machine, and time-based checks
    // (walking, clocks) starve.
    args: ['--no-sandbox', ...(o.gpu ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']), `--window-size=${width},${height + 120}`, '--window-position=0,0', '--no-first-run'],
    protocolTimeout: 10 * 60_000,
    // REALINPUT_DUMPIO=1: Chromium's own stderr (a renderer crash's reason: V8 OOM, a CHECK) to ours.
    dumpio: !!process.env.REALINPUT_DUMPIO,
  });
}

/** Resize the real window so the page viewport is exactly w×h (the toolbar height varies). */
export async function fitWindow(page: Page, kind: BrowserKind, w: number, h: number): Promise<void> {
  const d = await page.evaluate(() => ({ dw: window.outerWidth - window.innerWidth, dh: window.outerHeight - window.innerHeight }));
  if (kind === 'chromium') {
    const cdp = await page.createCDPSession();
    const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: w + d.dw, height: h + d.dh } });
  } else {
    // No CDP: move the X window itself. Without a window manager every mapped firefox
    // top-level is the browser window.
    const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--class', 'firefox'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const id of ids) {
      execFileSync('xdotool', ['windowmove', id, '0', '0']);
      execFileSync('xdotool', ['windowsize', id, String(w + d.dw), String(h + d.dh)]);
    }
  }
  await sleep(500);
}

// ------------------------------------------------------------------ waiting on the game
// Scenarios used to sleep a fixed time after setup and hope the game had caught up; under load
// (SwiftShader, a busy machine) it often hadn't, and checks read the load-gate screen or a stale
// HUD prompt. These helpers wait on the condition itself instead.

/** Evaluates page code (tools/realinput.ts's `js`). */
export type PageJs = <T>(code: string) => Promise<T>;

/**
 * Poll a page expression until it is truthy (or `ms` passes). Returns the last value, so a
 * caller can check it: falsy means it timed out.
 */
export async function waitFor<T>(js: PageJs, expr: string, ms = 5000, every = 80): Promise<T> {
  const end = Date.now() + ms;
  let v = await js<T>(expr);
  while (!v && Date.now() < end) {
    await sleep(every);
    v = await js<T>(expr);
  }
  return v;
}

/** What `settleWorld` saw last: the gate and the chunk counts it read. */
export interface WorldSettle {
  ok: boolean;
  waitedMs: number;
  closed?: boolean;
  armed?: boolean;
  missing?: { core: number; near: number; far: number; wanted: number };
}

// The gate closes only after a hole has stood for its debounce (0.25 s, or 1 s just after it
// opened), so "the gate is open" right after a teleport means nothing yet. Settled = the gate
// open AND nothing within its far ring unbuilt, unchanged for `stableMs`.
const SETTLE_EXPR = `(() => {
  const g = window.cdda?.loadGate?.();
  if (!g) return { ready: true };
  const m = g.missing;
  return { ready: !g.armed || (!g.closed && m.core === 0 && m.near === 0 && m.far === 0), closed: g.closed, armed: g.armed, missing: m };
})()`;

/**
 * Wait until the world around the survivor is built and the load gate is open, and stays so for
 * `stableMs` (src/loadgate). Call it after any setup teleport, page load or level change before
 * reading what the player sees. Not armed (title screen) counts as settled.
 */
export async function settleWorld(js: PageJs, o: { timeoutMs?: number; stableMs?: number } = {}): Promise<WorldSettle> {
  const t0 = Date.now(), end = t0 + (o.timeoutMs ?? 30000), stable = o.stableMs ?? 400;
  let since = -1;
  let r: { ready: boolean; closed?: boolean; armed?: boolean; missing?: WorldSettle['missing'] } = { ready: false };
  // (a frame first: a teleport made just before this call is noticed on the next frame)
  await sleep(100);
  while (Date.now() < end) {
    r = await js<typeof r>(SETTLE_EXPR);
    if (!r.ready) since = -1;
    else if (since < 0) since = Date.now();
    else if (Date.now() - since >= stable) return { ok: true, waitedMs: Date.now() - t0, closed: r.closed, armed: r.armed, missing: r.missing };
    await sleep(80);
  }
  return { ok: false, waitedMs: Date.now() - t0, closed: r.closed, armed: r.armed, missing: r.missing };
}

/**
 * The next activity the game starts runs its clock at `warp` (24 game s per real s at 1) from
 * its first frame, so mid-activity checks can't miss it while the test is still closing menus.
 * One-shot: later activities keep their own warp. Returns at once; the hook waits in the page.
 */
export async function slowNextActivity(js: PageJs, warp: number): Promise<void> {
  if (!(warp > 0)) throw new Error(`slowNextActivity: bad warp ${warp}`);
  await js(`(() => {
    const acts = cdda.game.activities;
    if (!acts.__slowWrapped) {
      const start = acts.start.bind(acts);
      acts.start = (spec) => {
        const ok = start(spec);
        if (ok && window.__slowNextWarp) { cdda.game.clock.warp = window.__slowNextWarp; window.__slowNextWarp = 0; }
        return ok;
      };
      acts.__slowWrapped = true;
    }
    window.__slowNextWarp = ${warp};
  })()`);
}

/**
 * Setup: put the survivor on foot, out of any vehicle. A scenario that ends at the wheel or in
 * a seat (loadgate ends in a car) otherwise leaves the next one sitting there: teleports keep
 * you seated (src/game/vehwalk.ts re-places you at your station) and W hops seats instead of
 * walking. Returns what it did, for logs.
 */
export async function onFoot(js: PageJs): Promise<string> {
  const out: string[] = [];
  // Letting go of the wheel can seat you at the driver's station on the next frame (vehwalk), so
  // keep at it until a frame passes with you neither driving nor seated.
  for (let i = 0; i < 20; i++) {
    const r = await js<string>(`(() => {
      const vs = cdda.vehicleSystem, out = [];
      if (!vs) return 'done';
      if (vs.driving) { vs.driving.velocity = 0; vs.releaseControls(); out.push('released the controls'); }
      const at = vs.stations?.view();
      if (at) {
        at.v.velocity = 0;
        const msg = vs.stations.getOut();
        if (vs.stations.view()) vs.stations.leave();
        out.push('left the seat' + (msg ? ': ' + msg : ''));
      }
      return out.length ? out.join('; ') : 'done';
    })()`);
    if (r === 'done') {
      if (i > 0 || out.length) {
        // one more frame to be sure nothing re-seated us
        await sleep(100);
        if ((await js<boolean>(`!!(cdda.vehicleSystem?.driving || cdda.vehicleSystem?.stations?.view())`))) continue;
      }
      return out.join('; ') || 'already on foot';
    }
    out.push(r);
    await sleep(100);
  }
  throw new Error(`onFoot: still in a vehicle after 2 s (${out.join('; ')})`);
}

/**
 * Setup: nothing hostile within `r` tiles: monsters cleared and hostile NPCs removed (a
 * scenario that provoked a survivor leaves them hunting you, and a fight interrupts every
 * activity and drains checks into dodging), the clock at `hour` when given.
 */
export async function calmSurroundings(js: PageJs, o: { r?: number; hour?: number } = {}): Promise<{ npcs: number }> {
  const r = o.r ?? 60;
  return js<{ npcs: number }>(`(() => {
    cdda.clearMonsters(${r});
    ${o.hour !== undefined ? `cdda.setHour(${o.hour});` : ''}
    const ns = cdda.npcSystem, p = cdda.game.player;
    let npcs = 0;
    if (ns) for (const n of [...ns.npcs]) if (!n.dead && n.isEnemy() && Math.hypot(n.x - p.x, n.y - p.y) <= ${r}) { ns.remove(n); npcs++; }
    return { npcs };
  })()`);
}

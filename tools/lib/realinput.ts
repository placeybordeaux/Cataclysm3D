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

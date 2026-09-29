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

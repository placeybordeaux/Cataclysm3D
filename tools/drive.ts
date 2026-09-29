// Persistent driver for interactive playtesting: one Vite server + one headless Chromium page
// that stay up between commands, so a long play session doesn't pay the boot cost per step.
//
//   tsx tools/drive.ts serve [--port 9555] [--params "seed=1"] [--size 960x540] [--gpu]
//   tsx tools/drive.ts eval  "<js using cdda>"        # prints JSON result (async ok)
//   tsx tools/drive.ts shot  shots/x.png               # screenshot of the current frame
//   tsx tools/drive.ts load  "seed=2&menu=1"           # (re)load the page with new params
//   tsx tools/drive.ts log                             # page console/errors since last `log`
//   tsx tools/drive.ts key   "i Escape Shift+e"        # real key presses (puppeteer), space-separated
//   tsx tools/drive.ts hold  "w 1500"                  # hold a key for N ms (real keydown/keyup)
//   tsx tools/drive.ts click "480 270"                 # real mouse click at page coords
//   tsx tools/drive.ts type  "some text"               # type text into the focused element
//   tsx tools/drive.ts stop
//
// --headful runs a real Chromium window on a private Xvfb display and enables OS-level input
// through xdotool (see tools/lib/realinput.ts) — the only way to test pointer lock, Esc, F11
// and keyboard layouts the way a player hits them. Add realinput=1 to --params so the game's
// mouse-capture policy runs under automation. Extra commands in that mode:
//   xkey "i Escape Shift+w &"   xhold "w 1500"   xdown/xup "Shift"   xtype "text"
//   xmove "200 0" (relative)    xclick "480 270 [1|3]"   xhere "[1|3]" (click in place)
//   xwheel "up 3"               layout "fr"  (setxkbmap; "us" back)
//   xtab "1500"                 switch to a new tab for N ms and back (focus loss)
//   state                       lock/focus/fullscreen/open windows/player — a quick look
//
// `serve` must run inside nix-shell and via ~/claude-stuff/bin/heavy (it holds a browser).
// --gpu launches Chromium on the real GPU (ANGLE/Vulkan) instead of SwiftShader.
// --dist serves the production build in dist/ (run `npm run build` first) through `vite preview`,
// so asset paths are checked exactly as shipped.

import { createServer as createHttp } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const port = Number(opt('--port', process.env.DRIVE_PORT ?? '9555'));

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('usage: tsx tools/drive.ts serve|eval|shot|load|log|stop ... (see header comment)');
  process.exit(0);
}

if (cmd !== 'serve') {
  const body = argv[1] ?? '';
  const r = await fetch(`http://127.0.0.1:${port}/${cmd}`, { method: 'POST', body });
  const text = await r.text();
  console.log(text);
  process.exit(r.ok ? 0 : 1);
}

const { createServer } = await import('vite');
const puppeteer = (await import('puppeteer-core')).default;
const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');
const size = opt('--size', '960x540').split('x').map(Number);
const gpu = argv.includes('--gpu');
const useDist = argv.includes('--dist');
const headful = argv.includes('--headful');
const { startXvfb, XInput } = await import('./lib/realinput');
if (headful) console.log('Xvfb on', (await startXvfb(size[0] + 40, size[1] + 160)).display);
const vite = useDist
  ? await (await import('vite')).preview({ preview: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
  : await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
if (!useDist) await (vite as Awaited<ReturnType<typeof createServer>>).listen();
const vport = (vite.httpServer!.address() as { port: number }).port;
const gl = gpu
  ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: !headful,
  // Headful: the window's viewport is the real one (defaultViewport null), placed at 0,0.
  defaultViewport: headful ? null : undefined,
  args: ['--no-sandbox', ...gl, ...(headful ? [`--window-size=${size[0]},${size[1] + 120}`, '--window-position=0,0', '--no-first-run', '--no-default-browser-check'] : [`--window-size=${size[0]},${size[1]}`])],
  protocolTimeout: 30 * 60_000,
});
const page = headful ? (await browser.pages())[0] ?? (await browser.newPage()) : await browser.newPage();
if (!headful) await page.setViewport({ width: size[0], height: size[1] });
const xin = new XInput(page);
let logBuf: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'log') logBuf.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logBuf.push(`[EXCEPTION] ${(e as Error).stack ?? e}`));
// The game's "Leave site?" guard (src/core/unload.ts) would block `load`: accept it, logged.
page.on('dialog', (d) => {
  logBuf.push(`[dialog ${d.type()}] ${d.message()}`);
  void d.accept();
});
page.on('response', (r) => {
  if (r.status() >= 400) logBuf.push(`[HTTP ${r.status()}] ${r.url()}`);
});

// Page scripts can `await shot('shots/x.png')` mid-script (lets a few frames render first).
await page.exposeFunction('shot', async (path: string, waitMs = 300) => {
  await new Promise((r) => setTimeout(r, waitMs));
  const p = resolve(path);
  mkdirSync(dirname(p), { recursive: true });
  await page.screenshot({ path: p as `${string}.png` });
  return p;
});

async function load(params: string): Promise<string> {
  await page.goto(`http://127.0.0.1:${vport}/?${params}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
  const err = await page.evaluate('window.cddaError');
  return err ? `boot failed: ${err}` : 'ok';
}
console.log('load:', await load(opt('--params', 'seed=1')));
if (headful) await fitWindow(page, size[0], size[1]);

/** Resize the real window so the page viewport is exactly w×h (the toolbar height varies). */
async function fitWindow(p: typeof page, w: number, h: number): Promise<void> {
  const cdp = await p.createCDPSession();
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
  const d = await p.evaluate(() => ({ dw: window.outerWidth - window.innerWidth, dh: window.outerHeight - window.innerHeight }));
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: w + d.dw, height: h + d.dh } });
  await new Promise((r) => setTimeout(r, 300));
}

const http = createHttp(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const what = (req.url ?? '/').slice(1);
  try {
    let out: unknown;
    if (what === 'eval' || what === 'js') {
      // An expression returns its value; anything that doesn't parse as one runs as statements.
      out = await page.evaluate(
        `(async () => { const AF = (async () => {}).constructor; let f;
          try { f = new AF('cdda', 'return (' + ${JSON.stringify(body)} + '\\n)'); } catch { f = new AF('cdda', ${JSON.stringify(body)}); }
          return f(window.cdda); })()`,
      );
    } else if (what === 'shot') {
      const p = resolve(body || 'shots/drive.png');
      mkdirSync(dirname(p), { recursive: true });
      await page.screenshot({ path: p as `${string}.png` });
      out = p;
    } else if (what === 'key') {
      // "Shift+e" presses with a modifier; plain tokens are key names ("i", "Escape", "Enter").
      // "ArrowDown*12" repeats a token.
      const toks = body.trim().split(/\s+/).filter(Boolean).flatMap((t) => {
        const m = /^(.+)\*(\d+)$/.exec(t);
        return m ? Array(Number(m[2])).fill(m[1]) : [t];
      });
      for (const tok of toks) {
        const parts = tok.split('+');
        const key = parts.pop()!;
        for (const m of parts) await page.keyboard.down(m as never);
        await page.keyboard.press(key as never);
        for (const m of parts.reverse()) await page.keyboard.up(m as never);
        await new Promise((r) => setTimeout(r, 60));
      }
      out = 'ok';
    } else if (what === 'hold') {
      const [key, ms] = body.trim().split(/\s+/);
      await page.keyboard.down(key as never);
      await new Promise((r) => setTimeout(r, Number(ms ?? 500)));
      await page.keyboard.up(key as never);
      out = 'ok';
    } else if (what === 'click') {
      const [x, y, button] = body.trim().split(/\s+/);
      await page.mouse.click(Number(x), Number(y), { button: (button as 'left' | 'right') ?? 'left' });
      out = 'ok';
    } else if (what === 'type') {
      await page.keyboard.type(body);
      out = 'ok';
    } else if (what.startsWith('x') || what === 'layout' || what === 'state') {
      if (!headful && what !== 'state') throw new Error(`${what} needs serve --headful`);
      const a = body.trim().split(/\s+/);
      if (what === 'xkey') await xin.key(body);
      else if (what === 'xhold') await xin.hold(a[0], Number(a[1] ?? 500));
      else if (what === 'xdown') await xin.down(a[0]);
      else if (what === 'xup') await xin.up(a[0]);
      else if (what === 'xtype') await xin.type(body);
      else if (what === 'xmove') await xin.move(Number(a[0]), Number(a[1] ?? 0));
      else if (what === 'xclick') await xin.click(Number(a[0]), Number(a[1]), Number(a[2] ?? 1));
      else if (what === 'xhere') await xin.clickHere(Number(a[0] || 1));
      else if (what === 'xbdown') await xin.buttonDown(Number(a[0] || 1));
      else if (what === 'xbup') await xin.buttonUp(Number(a[0] || 1));
      else if (what === 'xwheel') await xin.wheel(a[0] as 'up' | 'down', Number(a[1] ?? 1));
      else if (what === 'layout') xin.layout(a[0]);
      else if (what === 'xtab') {
        // Switch to another tab and back after N ms (focus + visibility loss, like alt-tab).
        const other = await browser.newPage();
        await other.bringToFront();
        await new Promise((r) => setTimeout(r, Number(a[0] || 1000)));
        await other.close();
        await page.bringToFront();
      }
      else if (what !== 'state') throw new Error(`unknown command ${what}`);
      await new Promise((r) => setTimeout(r, 150));
      out = await page.evaluate(() => {
        const g = (window as any).cdda?.game;
        const wins = [...document.querySelectorAll('.cdda-window .title')].map((t) => t.textContent);
        const hint = document.querySelector('.resume-hint') as HTMLElement | null;
        return {
          lock: !!document.pointerLockElement, focus: document.hasFocus(), fullscreen: !!document.fullscreenElement,
          windows: wins, captured: g?.input.captured, held: g ? [...g.input.held] : [], lockPaused: g?.lockPaused,
          hint: hint ? hint.style.display !== 'none' : null,
          player: g && { x: +g.player.x.toFixed(2), y: +g.player.y.toFixed(2), yaw: +g.player.yaw.toFixed(3), running: g.player.running },
        };
      });
    } else if (what === 'seq') {
      out = await runSeq(body);
    } else if (what === 'load') {
      out = await load(body);
    } else if (what === 'log') {
      out = logBuf.join('\n');
      logBuf = [];
    } else if (what === 'stop') {
      res.end('bye');
      await browser.close();
      await vite.close();
      process.exit(0);
    } else throw new Error(`unknown command ${what}`);
    res.end(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  } catch (e) {
    res.statusCode = 500;
    res.end(String((e as Error).stack ?? e));
  }
});
http.listen(port, '127.0.0.1', () => console.log(`drive listening on ${port}`));

/**
 * Timed script for judging animation timing: one `<ms> <cmd> [args]` per line (or `;`), run at
 * those offsets from the start. Input commands (xkey xdown xup xbdown xbup xhere xmove eval) fire
 * on their own timeline; `shot <path>` requests queue on a second one, because a screenshot
 * takes tens of ms and would otherwise push later input late. `burst <n> <everyMs> <prefix>`
 * expands to n shots. Returns each shot's path with the time it was actually taken.
 *   drive.ts seq "0 burst 10 100 shots/swing; 50 xbdown 1; 120 xbup 1"
 */
async function runSeq(script: string): Promise<{ path: string; ms: number }[]> {
  const steps: { at: number; cmd: string; args: string[] }[] = [];
  for (const line of script.split(/[;\n]/).map((l) => l.trim()).filter(Boolean)) {
    const [at, cmd, ...args] = line.split(/\s+/);
    if (cmd === 'burst') {
      const [n, every, prefix] = args;
      for (let i = 0; i < Number(n); i++) steps.push({ at: Number(at) + i * Number(every), cmd: 'shot', args: [`${prefix}_${String(i).padStart(2, '0')}.png`] });
    } else steps.push({ at: Number(at), cmd, args });
  }
  const t0 = Date.now();
  const wait = (at: number) => new Promise((r) => setTimeout(r, Math.max(0, at - (Date.now() - t0))));
  const shots: { path: string; ms: number }[] = [];
  const shotLine = (async () => {
    for (const s of steps.filter((x) => x.cmd === 'shot').sort((a, b) => a.at - b.at)) {
      await wait(s.at);
      const p = resolve(s.args[0]);
      mkdirSync(dirname(p), { recursive: true });
      const ms = Date.now() - t0;
      await page.screenshot({ path: p as `${string}.png` });
      shots.push({ path: p, ms });
    }
  })();
  const inputLine = (async () => {
    for (const s of steps.filter((x) => x.cmd !== 'shot').sort((a, b) => a.at - b.at)) {
      await wait(s.at);
      const a = s.args;
      if (s.cmd === 'eval' || s.cmd === 'js') await page.evaluate(a.join(' '));
      else if (!headful) throw new Error(`${s.cmd} needs serve --headful`);
      else if (s.cmd === 'xkey') await xin.key(a.join(' '));
      else if (s.cmd === 'xdown') await xin.down(a[0]);
      else if (s.cmd === 'xup') await xin.up(a[0]);
      else if (s.cmd === 'xbdown') await xin.buttonDown(Number(a[0] || 1));
      else if (s.cmd === 'xbup') await xin.buttonUp(Number(a[0] || 1));
      else if (s.cmd === 'xhere') await xin.clickHere(Number(a[0] || 1));
      else if (s.cmd === 'xmove') await xin.move(Number(a[0]), Number(a[1] ?? 0), 1);
      else throw new Error(`seq: unknown command ${s.cmd}`);
    }
  })();
  await Promise.all([shotLine, inputLine]);
  return shots;
}

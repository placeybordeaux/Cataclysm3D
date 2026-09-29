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
  headless: true,
  args: ['--no-sandbox', ...gl, `--window-size=${size[0]},${size[1]}`],
  protocolTimeout: 30 * 60_000,
});
const page = await browser.newPage();
await page.setViewport({ width: size[0], height: size[1] });
let logBuf: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'log') logBuf.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logBuf.push(`[EXCEPTION] ${(e as Error).stack ?? e}`));
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

const http = createHttp(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const what = (req.url ?? '/').slice(1);
  try {
    let out: unknown;
    if (what === 'eval') {
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

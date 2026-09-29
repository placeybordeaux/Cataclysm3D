// Headless screenshot + scripted-check harness. Starts its own Vite server on a free port,
// opens the game in headless Chromium (SwiftShader WebGL, so no GPU needed), waits for
// window.cdda.ready, then for each --eval/--out pair evaluates JS and saves a PNG.
//
// Usage:
//   npm run shot -- --params "seed=1&gen=test" --eval "cdda.look(180)" --out shots/a.png \
//                   --eval "cdda.step(2)" --out shots/b.png [--size 960x540] [--keep-errors]
//   npm run shot -- --help
// Console errors from the page are printed; the process exits non-zero on page errors
// (unless --keep-errors) so agents notice breakage.
// Must be run inside `nix-shell` (needs $CHROME_PATH) and via ~/claude-stuff/bin/heavy.

import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`shot: headless screenshots of CDDA-3D
  --params <query>   URL query string (e.g. "seed=3&gen=test")
  --eval <js>        JS to run in page (may be async; cdda = window.cdda). Pairs with next --out
  --out <file.png>   save screenshot after preceding --eval (default shots/shot.png)
  --wait <sec>       real seconds to let frames render before each capture (default 0.5)
  --size WxH         viewport (default 960x540)
  --print <js>       evaluate and print JSON result (no screenshot)
  --reload           reload the page (same browser profile: IndexedDB/localStorage/sessionStorage
                     survive) and wait for window.cdda.ready again; later steps run on the new page.
                     An --eval that makes the page navigate (e.g. loading a save) also waits for it.
  --keep-errors      don't exit non-zero on page errors`);
  process.exit(0);
}

type Step = { kind: 'eval' | 'out' | 'print' | 'reload'; value: string };
const steps: Step[] = [];
let params = '';
let wait = 0.5;
let size = [960, 540];
let keepErrors = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const v = argv[i + 1];
  if (a === '--params') (params = v), i++;
  else if (a === '--eval') steps.push({ kind: 'eval', value: v }), i++;
  else if (a === '--out') steps.push({ kind: 'out', value: v }), i++;
  else if (a === '--print') steps.push({ kind: 'print', value: v }), i++;
  else if (a === '--reload') steps.push({ kind: 'reload', value: '' });
  else if (a === '--wait') (wait = Number(v)), i++;
  else if (a === '--size') (size = v.split('x').map(Number)), i++;
  else if (a === '--keep-errors') keepErrors = true;
  else throw new Error(`unknown arg ${a}`);
}
if (!steps.some((s) => s.kind === 'out' || s.kind === 'print')) steps.push({ kind: 'out', value: 'shots/shot.png' });

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const addr = server.httpServer!.address() as { port: number };
const url = `http://127.0.0.1:${addr.port}/?${params}`;

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${size[0]},${size[1]}`],
});
let errors = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    errors++;
    console.log(`[page exception] ${(e as Error).stack ?? e}`);
  });
  const waitReady = async () => {
    await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 120_000 });
    const err = await page.evaluate('window.cddaError');
    if (err) throw new Error(`game failed to boot:\n${err}`);
  };
  await page.goto(url, { waitUntil: 'load' });
  await waitReady();
  for (const s of steps) {
    if (s.kind === 'reload') {
      await page.reload({ waitUntil: 'load' });
      await waitReady();
      console.log('reloaded');
    } else if (s.kind === 'eval') {
      try {
        await page.evaluate(`(async () => { const cdda = window.cdda; ${s.value}; })()`);
      } catch (e) {
        // The page navigated away mid-eval (e.g. loading a save of another world reloads the
        // page): carry on with the new page once it's ready.
        if (!/Execution context was destroyed|navigat/i.test(String((e as Error).message))) throw e;
        await waitReady();
        console.log('page navigated during eval; continuing on the new page');
      }
    } else if (s.kind === 'print') {
      const r = await page.evaluate(`(async () => { const cdda = window.cdda; return (${s.value}); })()`);
      console.log(JSON.stringify(r, null, 2));
    } else {
      await new Promise((r) => setTimeout(r, wait * 1000));
      const out = resolve(s.value);
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out as `${string}.png` });
      console.log(`saved ${out}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors && !keepErrors) process.exit(1);

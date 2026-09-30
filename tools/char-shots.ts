// Screenshot the character comparison scenes (tools/char-views.js) into
// docs/screenshots/wave3/characters/<prefix>_<view>.png. Hosts its own Vite server and
// Chromium like tools/look-shots.ts (never touches another session's game). Run inside
// nix-shell, via heavy:
//
//   ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- npx tsx tools/char-shots.ts --gpu --prefix after
//   ... --params chars=billboard --prefix before        (the old camera-facing sprites)
//
// Options: --out <dir>, --views a,b (default all), --size WxH (default 1920x1080), --gpu,
// --prefix <name> (file prefix, default "shot"), --params '<query>' (extra URL params),
// --look <look> (default full), --js '<expr>' (after each view is set up), --bench
// (cdda.benchView per view), --dry-run, --help.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  if (i < 0) return d;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const out = opt('--out', 'docs/screenshots/wave3/characters');
const viewsArg = opt('--views', '');
const size = opt('--size', '1920x1080').split('x').map(Number);
const prefix = opt('--prefix', 'shot');
const params = opt('--params', '');
const look = opt('--look', 'full');
const extraJs = opt('--js', '');
const gpu = argv.includes('--gpu');
const bench = argv.includes('--bench');
const dry = argv.includes('--dry-run');
const allViews = ['horde_near', 'horde_mid', 'horde_far', 'horde_dusk', 'dog', 'npc', 'windup', 'critters', 'corpse'];
const views = viewsArg ? viewsArg.split(',') : allViews;
for (const v of views) if (!allViews.includes(v)) throw new Error(`unknown view ${v} (have ${allViews.join(', ')})`);
if (dry) {
  for (const v of views) console.log(`would capture ${out}/${prefix}_${v}.png at ${size.join('x')}${gpu ? ' (gpu)' : ''} params=${params}`);
  process.exit(0);
}
const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');
mkdirSync(out, { recursive: true });

const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const gl = gpu
  ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', ...(bench ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])]
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', ...gl, `--window-size=${size[0]},${size[1]}`] });
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
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&look=${look}${params ? '&' + params : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
  const err = await page.evaluate('window.cddaError');
  if (err) throw new Error(`game failed to boot:\n${err}`);
  await page.evaluate(readFileSync(resolve('tools/look-views.js'), 'utf8'));
  await page.evaluate(readFileSync(resolve('tools/char-views.js'), 'utf8'));
  for (const v of views) {
    const t0 = Date.now();
    const info = await page.evaluate(`charView(${JSON.stringify(v)})`);
    if (info && info !== v) console.log(`  ${v}: ${info}`);
    if (extraJs) await page.evaluate(`(async () => { const cdda = window.cdda; ${extraJs}; })()`);
    const file = resolve(`${out}/${prefix}_${v}.png`);
    await page.screenshot({ path: file as `${string}.png` });
    let b = '';
    if (bench) b = ' ' + JSON.stringify(await page.evaluate('cdda.benchView(4)'));
    console.log(`  ${v} ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${file}${b}`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors) process.exit(1);

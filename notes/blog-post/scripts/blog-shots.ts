// Render the blog-post image suite (notes/blog-post/images/) in the real engine.
//
// Hosts its own Vite server and a GPU Chromium (like tools/look-shots.ts), boots seed 1 with the
// factory defaults (the user's picked look), and for each shot in shots.js runs its setup JS
// (the doc screenshot views from tools/look-views.js, char-views.js and vehicle-views.js are
// loaded into the page, plus cdda.* debug setup), captures a 1920x1080 PNG into --raw, then
// writes a half-size JPEG (960x540, q82) to --out, and for `hero: true` shots also a full-size
// <id>-hero.jpg (q85). Run from the repo root inside nix-shell, via heavy (GPU lease):
//
//   ~/claude-stuff/bin/heavy --kind gpu --mem 2 --name "cdda3d blog shots" -- \
//     npx tsx notes/blog-post/scripts/blog-shots.ts [--only id1,id2] [--gpu]
//
// Options: --shots <file> (a shot list module, default shots.js; recreate-shots.js = the official-screenshot
// recreations), --only a,b (default: every shot), --out <dir> (default notes/blog-post/images),
// --raw <dir> (full-size PNGs, default $TMPDIR/cdda3d-blog-raw — scratch, kept out of the repo),
// --port N (default 5177), --size WxH (default 1920x1080), --gpu (ANGLE/Vulkan; without it
// SwiftShader renders at 1-3 fps and the "full" effects are slow), --probe '<js>' (evaluate
// after boot, print the JSON and exit: for picking viewpoints), --list, --dry-run, --help.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { shots as defaultShots, type Shot } from './shots.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i < 0 ? d : argv[i + 1];
};
const only = opt('--only', '');
const out = opt('--out', 'notes/blog-post/images');
const raw = opt('--raw', join(tmpdir(), 'cdda3d-blog-raw'));
const port = Number(opt('--port', '5177'));
const size = opt('--size', '1920x1080').split('x').map(Number);
const probe = opt('--probe', '');
const gpu = argv.includes('--gpu');
// --shots <module>: another shot list with the same shape (e.g. recreate-shots.js)
const shotsFile = opt('--shots', '');
const shots: Shot[] = shotsFile ? (await import(resolve(shotsFile))).shots : defaultShots;

const wanted: Shot[] = only ? only.split(',').map((id) => {
  const s = shots.find((x) => x.id === id);
  if (!s) throw new Error(`no shot ${id} (have: ${shots.map((x) => x.id).join(', ')})`);
  return s;
}) : shots;
if (argv.includes('--list') || argv.includes('--dry-run')) {
  for (const s of wanted) console.log(`${argv.includes('--dry-run') ? 'would render ' : ''}${s.id}${s.hero ? ' (+hero)' : ''}  ${s.params ?? ''}  ${s.note ?? ''}`);
  process.exit(0);
}
const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');
mkdirSync(out, { recursive: true });
mkdirSync(raw, { recursive: true });

const server = await createServer({ server: { port, strictPort: true, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const gl = gpu
  ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', ...gl, `--window-size=${size[0]},${size[1]}`] });
const viewJs = ['tools/look-views.js', 'tools/char-views.js', 'tools/vehicle-views.js', 'notes/blog-post/scripts/tiles-view.js', 'notes/blog-post/scripts/recreate-scenes.js'].map((f) => readFileSync(resolve(f), 'utf8')).join('\n;\n');
let failed = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('pageerror', (e) => console.log(`[page exception] ${(e as Error).message ?? e}`));
  page.on('dialog', (d) => void d.accept());
  let loaded: string | null = null;
  const boot = async (params: string) => {
    await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1${params ? '&' + params : ''}`, { waitUntil: 'load' });
    await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
    const err = await page.evaluate('window.cddaError');
    if (err) throw new Error(`game failed to boot:\n${err}`);
    await page.evaluate(viewJs);
    loaded = params;
  };
  if (probe) {
    await boot('');
    console.log(JSON.stringify(await page.evaluate(`(async () => { const c = window.cdda; ${probe} })()`), null, 1));
  } else {
    for (const s of wanted) {
      const t0 = Date.now();
      if (loaded !== (s.params ?? '') || s.fresh) await boot(s.params ?? '');
      try {
        // every shot starts with the DOM overlays visible again (lookView hides them)
        await page.evaluate(`for (const el of document.querySelectorAll('body *')) if (el.style && el.style.visibility === 'hidden') el.style.visibility = ''; window.cdda.ui?.closeAll?.(); window.tilesHide?.()`);
        const info = await page.evaluate(`(async () => { const c = window.cdda; ${s.js} })()`);
        await new Promise((r) => setTimeout(r, s.wait ?? 600));
        const png = resolve(`${raw}/${s.id}.png`);
        await page.screenshot({ path: png as `${string}.png` });
        execFileSync('magick', [png, '-resize', '960x540', '-quality', '82', '-strip', resolve(`${out}/${s.id}.jpg`)]);
        if (s.hero) execFileSync('magick', [png, '-quality', '85', '-strip', resolve(`${out}/${s.id}-hero.jpg`)]);
        console.log(`  ${s.id} ${((Date.now() - t0) / 1000).toFixed(1)}s ${info !== undefined ? JSON.stringify(info).slice(0, 200) : ''}`);
      } catch (e) {
        failed++;
        console.log(`  FAILED ${s.id}: ${(e as Error).message.split('\n')[0]}`);
        loaded = null;
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failed) process.exit(1);

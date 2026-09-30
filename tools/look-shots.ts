// Screenshot the comparison viewpoints (tools/look-views.js) for each visual style into
// docs/screenshots/looks/<look>_<view>.png. Hosts its own Vite server and Chromium (so no
// other session can drive it), like tools/shot.ts. Run inside nix-shell, via heavy:
//
//   ~/claude-stuff/bin/heavy --mem 2.5 -- npx tsx tools/look-shots.ts classic crisp full
//   ... --gpu --size 3440x1304 --bench full        (real GPU frame times: add --kind gpu)
//
// Options: --out <dir> (default docs/screenshots/looks), --views a,b (default all six),
// --size WxH (default 1920x1080), --gpu (ANGLE/Vulkan instead of SwiftShader), --bench
// (records cdda.benchView per view and prints a table), --tweak '<json>' (cdda.lookTweak
// before each view), --js '<expr>' (run after each view is set up), --print '<expr>' (log
// its JSON after each shot), --format png|jpg (default png; jpg = quality 88), --dry-run, --help.
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
const out = opt('--out', 'docs/screenshots/looks');
const viewsArg = opt('--views', '');
const size = opt('--size', '1920x1080').split('x').map(Number);
const tweak = opt('--tweak', '');
const extraJs = opt('--js', '');
const printJs = opt('--print', '');
const params = opt('--params', '');
const format = opt('--format', 'png');
if (format !== 'png' && format !== 'jpg') throw new Error(`--format must be png or jpg, got ${format}`);
const bench = argv.includes('--bench');
const dry = argv.includes('--dry-run');
const gpu = argv.includes('--gpu');
const looks = argv.filter((a) => !a.startsWith('--'));
if (!looks.length) throw new Error('name at least one look (classic crisp voxel terrain full)');
const views = viewsArg ? viewsArg.split(',') : ['shelter', 'street', 'house', 'forest', 'night', 'top'];
if (dry) {
  for (const l of looks) for (const v of views) console.log(`would capture ${out}/${l}_${v}.${format} at ${size.join('x')}${gpu ? ' (gpu)' : ''}`);
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
const views_js = readFileSync(resolve('tools/look-views.js'), 'utf8');
const results: Record<string, Record<string, unknown>> = {};
let errors = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[page error] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    errors++;
    console.log(`[page exception] ${(e as Error).stack ?? e}`);
  });
  page.on('dialog', (d) => void d.accept());
  for (const look of looks) {
    console.log(`== ${look}`);
    await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&look=${look}${params ? '&' + params : ''}`, { waitUntil: 'load' });
    await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
    const err = await page.evaluate('window.cddaError');
    if (err) throw new Error(`game failed to boot:\n${err}`);
    await page.evaluate(views_js);
    results[look] = {};
    for (const v of views) {
      const t0 = Date.now();
      if (tweak) await page.evaluate(`cdda.lookTweak(${tweak})`);
      await page.evaluate(`lookView(${JSON.stringify(v)})`);
      if (extraJs) await page.evaluate(`(async () => { const cdda = window.cdda; ${extraJs}; })()`);
      await new Promise((r) => setTimeout(r, 400));
      const file = resolve(`${out}/${look}_${v}.${format}`);
      if (format === 'jpg') await page.screenshot({ path: file as `${string}.jpeg`, type: 'jpeg', quality: 88 });
      else await page.screenshot({ path: file as `${string}.png` });
      if (printJs) console.log(`  ${look}/${v}: ${JSON.stringify(await page.evaluate(`(async () => { const cdda = window.cdda; return (${printJs}); })()`))}`);
      if (bench) {
        // let chunk builds / grass rebuilds triggered by the teleport finish first
        await new Promise((r) => setTimeout(r, 2500));
        results[look][v] = await page.evaluate('cdda.benchView(6)');
      }
      console.log(`  ${v} ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${file}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (bench) {
  console.log('look       view      fps(p50)  p50ms  p99ms  work50 work99  render  tris');
  for (const [l, r] of Object.entries(results))
    for (const [v, b] of Object.entries(r)) {
      const x = b as { interval: { p50: number; p99: number }; work: { p50: number; p99: number }; renderMs: number; stats: { triangles: number } };
      console.log(`${l.padEnd(10)} ${v.padEnd(9)} ${(1000 / x.interval.p50).toFixed(0).padStart(8)}  ${String(x.interval.p50).padStart(5)}  ${String(x.interval.p99).padStart(5)}  ${String(x.work.p50).padStart(6)} ${String(x.work.p99).padStart(6)}  ${String(x.renderMs).padStart(6)}  ${x.stats.triangles}`);
    }
  console.log(JSON.stringify(results));
}
if (errors) process.exit(1);

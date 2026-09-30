// Screenshot vehicle viewpoints (tools/vehicle-views.js) with each vehicle renderer into
// <out>/<renderer>_<view>.png. Hosts its own Vite server and Chromium like look-shots.ts.
// Run inside nix-shell, via heavy:
//
//   ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- npx tsx tools/vehicle-shots.ts --gpu model parts
//
// Views are names understood by vehicleView() (see tools/vehicle-views.js), e.g.
//   --views street,lineup:car,sedan,suv  (commas inside a view: separate views with ';')
// Options: --out <dir> (default docs/screenshots/wave3/vehicles), --views 'a;b' ,
// --size WxH (default 1600x900), --gpu, --look <look> (default full), --params '<query>',
// --bench (cdda.benchView per view), --js '<expr>' after each view, --print '<expr>',
// --dry-run, --help.
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
const out = opt('--out', 'docs/screenshots/wave3/vehicles');
const viewsArg = opt('--views', 'street;lineup:car,sedan,car_sports,suv,pickup;lineup:cube_van,ambulance,policecar,bus;solo:pickup;solo:bus:30;solo:motorcycle:70:0:2;drive;drivechase');
const size = opt('--size', '1600x900').split('x').map(Number);
const look = opt('--look', 'full');
const extraJs = opt('--js', '');
const printJs = opt('--print', '');
const params = opt('--params', '');
const bench = argv.includes('--bench');
const dry = argv.includes('--dry-run');
const gpu = argv.includes('--gpu');
const renderers = argv.filter((a) => !a.startsWith('--'));
if (!renderers.length) throw new Error('name at least one renderer (model parts)');
const views = viewsArg.split(';').filter(Boolean);
const fileName = (r: string, v: string) => `${r}_${v.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.png`;
if (dry) {
  for (const r of renderers) for (const v of views) console.log(`would capture ${out}/${fileName(r, v)} at ${size.join('x')}${gpu ? ' (gpu)' : ''}`);
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
const lookViews = readFileSync(resolve('tools/look-views.js'), 'utf8');
const vehicleViews = readFileSync(resolve('tools/vehicle-views.js'), 'utf8');
const results: Record<string, Record<string, unknown>> = {};
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
  for (const r of renderers) {
    console.log(`== ${r}`);
    await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&look=${look}&vehicles=${r}${params ? '&' + params : ''}`, { waitUntil: 'load' });
    await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
    const err = await page.evaluate('window.cddaError');
    if (err) throw new Error(`game failed to boot:\n${err}`);
    await page.evaluate(lookViews);
    await page.evaluate(vehicleViews);
    results[r] = {};
    for (const v of views) {
      const t0 = Date.now();
      try {
        await page.evaluate(`vehicleView(${JSON.stringify(v)})`);
      } catch (e) {
        errors++;
        console.log(`  ${v} FAILED: ${(e as Error).message}`);
        continue;
      }
      if (extraJs) await page.evaluate(`(async () => { const cdda = window.cdda; ${extraJs}; })()`);
      await new Promise((res) => setTimeout(res, 400));
      const file = resolve(`${out}/${fileName(r, v)}`);
      await page.screenshot({ path: file as `${string}.png` });
      if (printJs) console.log(`  ${r}/${v}: ${JSON.stringify(await page.evaluate(`(async () => { const cdda = window.cdda; return (${printJs}); })()`))}`);
      if (bench) {
        await new Promise((res) => setTimeout(res, 2500));
        results[r][v] = await page.evaluate('cdda.benchView(6)');
      }
      console.log(`  ${v} ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${file}`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (bench) {
  console.log('renderer   view                      fps(p50)  p50ms  p99ms  work50 work99  render  tris');
  for (const [l, r] of Object.entries(results))
    for (const [v, b] of Object.entries(r)) {
      const x = b as { interval: { p50: number; p99: number }; work: { p50: number; p99: number }; renderMs: number; stats: { triangles: number } };
      console.log(`${l.padEnd(10)} ${v.slice(0, 25).padEnd(25)} ${(1000 / x.interval.p50).toFixed(0).padStart(8)}  ${String(x.interval.p50).padStart(5)}  ${String(x.interval.p99).padStart(5)}  ${String(x.work.p50).padStart(6)} ${String(x.work.p99).padStart(6)}  ${String(x.renderMs).padStart(6)}  ${x.stats.triangles}`);
    }
  console.log(JSON.stringify(results));
}
if (errors) process.exit(1);

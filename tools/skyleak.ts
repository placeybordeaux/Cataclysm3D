// Sky-leak check (docs/PERF.md "Levels from the world"): from each viewpoint in
// tools/skyleak-views.ts — inside and on top of tall and deep buildings — render with the sky
// hidden (a sentinel colour behind everything) and raycast the tile map through every pixel;
// where the map has a wall, floor or roof within reach the render must not show the sentinel.
// A fixed window of levels around the player (the old rule) fails it: the fire station's roof
// three levels up was never built. Part of `npm run perf` (GPU). Hosts its own Vite server and
// Chromium on free ports.
//
//   ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/skyleak.ts'
//
// Options:
//   --only a,b        viewpoints by name (default all)
//   --params <q>      extra URL query (e.g. levels=window: the old rule, should fail)
//   --max <share>     allowed leaking share of structural pixels per look (default 0.02)
//   --shots <dir>     save a half-size JPEG per look (<view>_<i>.jpg)
//   --size WxH        viewport (default 1280x480)
//   --bench <sec>     after each viewpoint's checks, turn around for <sec> s there and print the
//                     cost (loop p50/p99, draw ms, draw calls, triangles, chunk entries by level)
//   --no-gpu          SwiftShader instead of the GPU (slow)
//   --list            print the viewpoints; --dry-run: what would run; --help
// Exit code 1 when a look leaks more than --max, or a viewpoint can't be found.
import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKYLEAK_VIEWS, type SkyLeakView } from './skyleak-views';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`${n} needs a value`);
  argv.splice(i, 2);
  return v;
};
const only = opt('--only', '');
const params = opt('--params', '');
const maxShare = Number(opt('--max', '0.02'));
const shots = opt('--shots', '');
const size = opt('--size', '1280x480').split('x').map(Number);
const bench = Number(opt('--bench', '0'));
const gpu = !argv.includes('--no-gpu');
const flags = ['--no-gpu', '--list', '--dry-run'];
for (const a of argv) if (!flags.includes(a)) throw new Error(`unknown argument ${a}`);
const views = only ? only.split(',').map((n) => SKYLEAK_VIEWS.find((v) => v.name === n) ?? (() => { throw new Error(`no viewpoint ${n} (--list)`); })()) : SKYLEAK_VIEWS;
if (argv.includes('--list') || argv.includes('--dry-run')) {
  for (const v of views) console.log(`${v.name.padEnd(24)} seed ${String(v.seed).padEnd(10)} ${JSON.stringify(v.at)}  ${v.looks.length} looks`);
  process.exit(0);
}

// In the page: put the player at the viewpoint. Returns the tile, or throws.
const PLACE = `async (v) => {
  const c = window.cdda, m = c.game.map, lv = c.renderer.chunks.levels ?? { columnTop: () => 5 };
  c.godMode(true);
  c.setWeather('clear');
  c.setCameraMode('first');
  c.setHour(v.hour ?? 12);
  const hide = (root) => { for (const el of root.children) { if (el.tagName === 'CANVAS') continue; if (el.querySelector('canvas')) hide(el); else el.style.visibility = 'hidden'; } };
  hide(document.body);
  if (v.at.tile) {
    const [x, y, z] = v.at.tile;
    c.teleport(x + 0.5, y + 0.5, z);
    return { x, y, z, omt: c.omtAt(Math.floor(x / 24), Math.floor(y / 24), z).id };
  }
  const s = c.startLocation();
  c.teleport(s.x + 0.5, s.y + 0.5, 0);
  const walk = (x, y, z) => { const t = m.terAt(x, y, z); return t.move_cost > 0 && m.hasFloor(x, y, z) && !t.flags.includes('GOES_UP') && !t.flags.includes('GOES_DOWN'); };
  // several candidates, nearest first: the first with a usable tile wins
  const seen = new Set();
  for (let tries = 0; tries < 6; tries++) {
    const o = c.findOmt(v.at.omt, 160);
    if (!o || seen.has(o.x + ',' + o.y)) break;
    seen.add(o.x + ',' + o.y);
    const X0 = o.x * 24, Y0 = o.y * 24;
    c.teleportOmt(o.x, o.y, 0);
    c.settle();
    let best = null;
    if (v.at.where === 'inside') {
      const z = v.at.z ?? 0;
      let bs = -1;
      for (let y = Y0 + 2; y < Y0 + 22; y++) for (let x = X0 + 2; x < X0 + 22; x++) {
        if (!walk(x, y, z) || !c.renderer.chunks.covered(x, y, z)) continue;
        let n = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (c.renderer.chunks.covered(x + dx, y + dy, z)) n++;
        if (n > bs) { bs = n; best = { x, y, z }; }
      }
    } else {
      for (let z = lv.columnTop(o.x, o.y); z >= 1 && !best; z--) {
        let bd = 1e9;
        for (let y = Y0 + 2; y < Y0 + 22; y++) for (let x = X0 + 2; x < X0 + 22; x++) {
          if (!walk(x, y, z) || c.renderer.chunks.covered(x, y, z)) continue;
          const d = Math.hypot(x - X0 - 12, y - Y0 - 12);
          if (d < bd) { bd = d; best = { x, y, z }; }
        }
      }
    }
    if (best) {
      c.teleport(best.x + 0.5, best.y + 0.5, best.z);
      return { ...best, omt: c.omtAt(o.x, o.y, best.z).id };
    }
    // look further: mark this one as used by stepping the search origin past it
    c.teleportOmt(o.x + 3, o.y + 3, 0);
  }
  throw new Error('skyleak: no ' + v.at.where + ' tile for ' + v.at.omt + ' (seed ' + v.seed + ')');
}`;

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');
if (shots) mkdirSync(shots, { recursive: true });
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const gl = gpu
  ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', ...gl, `--window-size=${size[0]},${size[1]}`] });
let failed = 0;
const rows: string[] = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('pageerror', (e) => { failed++; console.log(`[page exception] ${(e as Error).stack ?? e}`); });
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warn' && m.text().startsWith('[levels]'))) console.log(`  [page ${m.type()}] ${m.text()}`); });
  page.on('dialog', (d) => void d.accept());
  let seed = NaN;
  for (const v of views) {
    if (v.seed !== seed) {
      seed = v.seed;
      await boot(page, seed);
    }
    let at: { x: number; y: number; z: number; omt: string };
    try {
      at = (await page.evaluate(`(${PLACE})(${JSON.stringify(v)})`)) as typeof at;
    } catch (e) {
      failed++;
      console.log(`${v.name}: ${String((e as Error).message).split('\n')[0]}`);
      continue;
    }
    console.log(`${v.name}: ${at.omt} tile ${at.x},${at.y},${at.z}`);
    for (let i = 0; i < v.looks.length; i++) {
      const [yaw, pitch] = v.looks[i];
      await page.evaluate(`cdda.look(${yaw}, ${pitch}); cdda.renderer.flushChunks()`);
      await new Promise((r) => setTimeout(r, 350));
      // (a build without the probe — an old commit, for "before" shots — only gets pictures)
      const r = (await page.evaluate("typeof cdda.skyLeak === 'function' ? cdda.skyLeak({ width: 192 }) : { structural: 0, leaks: 0, share: 0, where: [] }")) as { structural: number; leaks: number; share: number; where: unknown[] };
      const ok = r.share <= maxShare;
      if (!ok) failed++;
      const line = `  look ${yaw}/${pitch}: ${r.structural} structural px, ${r.leaks} show the sky (${(r.share * 100).toFixed(1)} %) ${ok ? 'ok' : 'LEAK'}${!ok ? ' ' + JSON.stringify(r.where.slice(0, 3)) : ''}`;
      console.log(line);
      rows.push(`${v.name} ${yaw}/${pitch} ${(r.share * 100).toFixed(1)}%`);
      if (shots) {
        const file = resolve(`${shots}/${v.name}_${i}.jpg`);
        await page.screenshot({ path: file as `${string}.jpeg`, type: 'jpeg', quality: 85, clip: { x: 0, y: 0, width: size[0], height: size[1], scale: 0.5 } });
      }
    }
    if (bench > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      await page.evaluate('cdda.perf?.reset?.()');
      const t0 = Date.now();
      while (Date.now() - t0 < bench * 1000) {
        const f = (Date.now() - t0) / (bench * 1000);
        await page.evaluate(`cdda.look(${f} * 720, ${v.looks[0][1] > 0 ? 15 : -20})`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const b = await page.evaluate(`(() => { const s = cdda.perf.summary(); const st = cdda.renderStats(); const lv = {}; cdda.renderer.chunks.forEachEntry((e) => { lv[e.z] = (lv[e.z] ?? 0) + 1; }); return { loop: [s.loop.p50, s.loop.p99], interval: [s.interval.p50, s.interval.p99], draw: +s.sections.draw.toFixed(2), calls: st.calls, triangles: st.triangles, entries: lv }; })()`);
      console.log(`  bench ${bench}s: ${JSON.stringify(b)}`);
    }
    const misses = (await page.evaluate('cdda.renderer.chunks.levelMisses?.length ?? 0')) as number;
    if (misses) console.log(`  (chunk manager level guard: ${misses} miss(es) logged)`);
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `FAIL (${failed})` : 'PASS');
if (failed) process.exit(1);

async function boot(page: Page, seed: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/?seed=${seed}&skipmenu=1&look=voxel&radius=8${params ? '&' + params : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
  const err = await page.evaluate('window.cddaError');
  if (err) throw new Error(`game failed to boot:\n${err}`);
}

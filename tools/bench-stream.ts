// Streaming benchmark: ghost-sprint (cdda.benchRun) through town and print main-loop frame
// times with a per-section split of the slowest frames (who caused each hitch). Hosts its own
// Vite server and Chromium like tools/look-shots.ts, so no other session can drive it.
// Run inside nix-shell, on the GPU:
//
//   tools/heavy --kind gpu --mem 2 -- npx tsx tools/bench-stream.ts
//   ... --look full --speed 7 --seconds 30        (sprint; the default)
//   ... --speed 17.9                              (40 mph: driving through town)
//   ... --size 3440x1304 --runs sprint,drive
//
// Options: --look <name> (default full), --size WxH (default 1920x1080), --seconds N (per run,
// default 30), --runs sprint,drive (default both: 7 and 17.9 tiles/s), --speed N (one run at
// that speed instead), --yaw deg (default: along the street view), --params '<url params>',
// --view <look-views name> (default street; 'forest' + --yaw -20 runs through woods),
// --uncapped (no vsync/frame cap: leaves no idle time, so idle-time mapgen never runs),
// --json (print raw results), --dry-run, --help.
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i < 0 ? d : argv[i + 1];
};
const lookName = opt('--look', 'full');
const size = opt('--size', '1920x1080').split('x').map(Number);
const seconds = Number(opt('--seconds', '30'));
const speedArg = opt('--speed', '');
const yawArg = opt('--yaw', '');
const params = opt('--params', '');
const viewArg = opt('--view', 'street');
const runs: [string, number][] = speedArg
  ? [[`${speedArg} t/s`, Number(speedArg)]]
  : opt('--runs', 'sprint,drive').split(',').map((r) => {
    if (r === 'sprint') return ['sprint 7 t/s', 7] as [string, number];
    if (r === 'drive') return ['drive 40 mph', 17.9] as [string, number];
    throw new Error(`unknown run ${r} (sprint, drive)`);
  });
if (argv.includes('--dry-run')) {
  for (const [n] of runs) console.log(`would bench ${lookName} ${n} for ${seconds}s at ${size.join('x')} (gpu)`);
  process.exit(0);
}
const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');

const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true, protocolTimeout: 600_000,
  args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', ...(argv.includes('--uncapped') ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), `--window-size=${size[0]},${size[1]}`],
});
type Stat = { p50: number; p95: number; p99: number; max: number; over33: number; frames: number };
const out: Record<string, unknown> = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('pageerror', (e) => console.log(`[page exception] ${(e as Error).stack ?? e}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1&look=${lookName}${params ? '&' + params : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 180_000 });
  await page.evaluate(readFileSync(resolve('tools/look-views.js'), 'utf8'));
  for (const [name, speed] of runs) {
    // start every run from the same spot: the street view (or --view), running along it
    await page.evaluate(`lookView(${JSON.stringify(viewArg)})`);
    await new Promise((r) => setTimeout(r, 2000));
    const r = await page.evaluate(`(async () => {
      const c = window.cdda;
      Object.assign(c.renderer.chunks.stats, { maxBuildMs: 0, slowBuilds: 0, maxStepMs: 0, maxFrameMs: 0, builds: 0, meshMs: 0, treeMs: 0 }); Object.assign(c.voxelStats, { built: 0, buildMs: 0, placed: 0, placeMs: 0, verts: 0 });
      const res = await c.benchRun({ seconds: ${seconds}, speed: ${speed}, yawDeg: ${yawArg || -95} });
      res.chunks = { ...c.renderer.chunks.stats }; res.voxel = { ...c.voxelStats }; res.models = c.furnitureStats?.(); res.flora = c.floraStats?.();
      return res;
    })()`) as { work: Stat; loop: Stat; interval: Stat; sections: Record<string, number>; slowest: { ms: number; sec: Record<string, number> }[]; tiles: number; prefetch?: unknown; voxel: unknown; models?: unknown; chunks: Record<string, number | string> };
    out[name] = r;
    const w = r.work;
    console.log(`\n== ${lookName} ${name} ${size.join('x')}: ${r.tiles} tiles, ${w.frames} frames`);
    console.log(`   work ms  p50 ${w.p50}  p95 ${w.p95}  p99 ${w.p99}  max ${w.max}  >33ms ${w.over33}`);
    const lp = r.loop;
    console.log(`   loop ms  p50 ${lp.p50}  p95 ${lp.p95}  p99 ${lp.p99}  max ${lp.max}  >33ms ${lp.over33}`);
    const iv = r.interval;
    console.log(`   frame interval ms  p50 ${iv.p50}  p95 ${iv.p95}  p99 ${iv.p99}  max ${iv.max}  >33ms ${iv.over33}`);
    console.log(`   mean/section ${Object.entries(r.sections).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ')}`);
    if (r.prefetch) console.log(`   prefetch ${JSON.stringify(r.prefetch)}`);
    const ch = r.chunks as Record<string, number>;
    console.log(`   chunk builds: ${ch.builds}, slowest ${ch.maxBuildMs.toFixed(1)} ms (sliced), >8ms ${ch.slowBuilds}, mesh ${ch.meshMs.toFixed(0)} ms, trees ${ch.treeMs.toFixed(0)} ms, longest step ${ch.maxStepMs.toFixed(1)} ms (${ch.maxStep}), most meshing in a frame ${ch.maxFrameMs.toFixed(1)} ms`);
    console.log(`   voxel ${JSON.stringify(r.voxel)}`);
    if (r.models) console.log(`   models ${JSON.stringify(r.models)}`);
    if ((r as { flora?: unknown }).flora) console.log(`   flora ${JSON.stringify((r as { flora?: unknown }).flora)}`);
    for (const s of r.slowest.slice(0, 8)) console.log(`   ${String(s.ms).padStart(6)} ms  ${Object.entries(s.sec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (argv.includes('--json')) console.log(JSON.stringify(out));

// Streaming benchmark with pass/fail budgets (docs/PERF.md). Drives scripted routes at the
// default settings (whatever a fresh profile gets: voxel look, 168 m draw distance) in a car and
// measures what the player would notice: unbuilt chunks in clear view, seconds of built world
// ahead of the car ("runway"), frame-time p99, the longest single build step. Hosts its own
// Vite server and browser on free ports (never 5173). Run on the GPU:
//
//   ~/claude-stuff/bin/heavy --kind gpu --mem 2 --name "cdda3d perf" -- nix-shell --run 'npm run perf'
//
// The car is a "ghost": the real vehicle with you at the wheel, moved along a straight line at a
// fixed speed without collision, so every run crosses the same chunks. Real driving (keyboard,
// physics) is what tools/perf-drive.ts does; this is the repeatable regression check.
//
// Options:
//   --routes a,b       routes to run (default: all six); --list shows them
//   --size WxH         viewport (default 3440x1304, the user's ultrawide)
//   --seconds N        override every route's duration
//   --params '<q>'     extra URL params (e.g. 'radius=6', 'look=full')
//   --browser firefox  headless Firefox (also on the GPU) instead of Chromium
//   --save DIR         write each route's telemetry dump (tools/perf-report.ts reads them)
//   --shots DIR        JPEG screenshots at 1/3 and 2/3 of each route (<route>_<s>s.jpg)
//   --baseline FILE    budgets to compare with (default tools/perf-baseline.json, .firefox.json for Firefox)
//   --write-baseline   record this run as the new baseline (keeps the tolerances)
//   --report           print the full perf-report for each route
//   --detail           time the mesher by kind (furniture models, surfaces, dressing, rooms); costs time itself
//   --gpu-timer        GPU ms per frame (EXT_disjoint_timer_query; Chromium only)
//   --json             print raw results
//   --dry-run          print what would run
// Exit code 1 when a route breaks a budget.
import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { summarize, type PerfDump, type PerfSummary } from '../src/perf/analyze';
import { printReport } from './perf-report';
import { PERF_MONITOR, PERF_PAGE } from './lib/perfRoutes';

const argv = process.argv.slice(2);
const help = () => console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
if (argv.includes('--help') || argv.includes('-h')) {
  help();
  process.exit(0);
}
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i < 0 ? d : argv[i + 1];
};

/** mph -> m/s (1 tile = 1 m) */
const MPH = 0.44704;
interface Route {
  what: string;
  /** where: 'town' (longest straight road through the nearest town), 'rural' (longest straight road
   *  outside towns near the start), 'forest' (through the nearest thick forest) */
  kind: 'town' | 'city' | 'rural' | 'forest' | 'load' | 'loaddrive' | 'teleport';
  mph: number;
  seconds: number;
}
export const ROUTES: Record<string, Route> = {
  town40: { what: 'into and through the nearest town (Holden) at 40 mph, on the straight road with the most buildings along it', kind: 'town', mph: 40, seconds: 25 },
  town60: { what: 'the same road at 60 mph', kind: 'town', mph: 60, seconds: 25 },
  city40: { what: 'into and through the biggest town within ~100 OMTs (seed 1: Columbia Falls, size 18) at 40 mph', kind: 'city', mph: 40, seconds: 30 },
  city60: { what: 'the same city road at 60 mph', kind: 'city', mph: 60, seconds: 25 },
  forest: { what: 'straight through thick forest at 40 mph (3D trees, flora LOD rings)', kind: 'forest', mph: 40, seconds: 20 },
  rural: { what: 'the longest straight road outside town at 60 mph', kind: 'rural', mph: 60, seconds: 25 },
  // Loads and teleports (the user's "huge blip" after a hot reload, docs/PERF.md): time from the
  // game being ready (load) or the jump (teleport) to the player's 3x3 shown (curtain lifts) and
  // to nothing unbuilt in view, standing still; the longest frames before/after the curtain.
  load: { what: 'save in the city, reload the page (a hot reload / Load), stand still until everything in view is built', kind: 'load', mph: 0, seconds: 15 },
  loaddrive: { what: 'the same reload, then drive off at 40 mph the moment the curtain lifts', kind: 'loaddrive', mph: 40, seconds: 15 },
  teleport: { what: 'jump from the city to Holden (~150 OMTs), stand still until everything in view is built', kind: 'teleport', mph: 0, seconds: 15 },
};

if (argv.includes('--list')) {
  for (const [k, r] of Object.entries(ROUTES)) console.log(`${k.padEnd(8)} ${r.seconds}s  ${r.what}`);
  process.exit(0);
}
const routeNames = opt('--routes', 'town40,town60,city40,city60,forest,rural,teleport,load,loaddrive').split(',');
for (const r of routeNames) if (!ROUTES[r]) throw new Error(`unknown route ${r} (${Object.keys(ROUTES).join(', ')})`);
const size = opt('--size', '3440x1304').split('x').map(Number);
if (size.length !== 2 || size.some((v) => !(v > 0))) throw new Error(`--size ${opt('--size', '')}: expected WxH`);
const secondsArg = opt('--seconds', '');
const params = opt('--params', '');
const browserKind = opt('--browser', 'chromium');
if (browserKind !== 'chromium' && browserKind !== 'firefox') throw new Error(`--browser ${browserKind}: chromium or firefox`);
const saveDir = opt('--save', '');
// one baseline per browser: Firefox's timings (and its occasional long GC step) differ
const baselinePath = opt('--baseline', browserKind === 'firefox' ? 'tools/perf-baseline.firefox.json' : 'tools/perf-baseline.json');

// ---- budgets ---------------------------------------------------------------------------------
// Metrics per route, "lower is better" except runwayP10 (higher is better). A route fails when a
// metric is worse than its baseline beyond the tolerance (relative AND absolute: the shared
// machine's load moves timings by +-30 %), or breaks an absolute limit regardless of baseline.
export interface Metrics {
  /** longest continuous stretch with an unbuilt chunk in clear view (s) */
  maxHoleS?: number;
  /** total such time (s) */
  holeS?: number;
  /** 10th percentile of runway while moving (s of travel before the first unbuilt chunk) */
  runwayP10?: number;
  /** frame interval p99 (ms) */
  p99?: number;
  /** our main-loop p99 (ms) */
  loopP99?: number;
  /** longest single uninterrupted meshing step (ms): the time-slicing granularity */
  maxStepMs: number;
  /** mapgen inside frames (ms per second of driving) */
  genSyncMsPerS: number;
  /** load/teleport routes: ms from ready / the jump to the 3x3 shown, and to nothing unbuilt in view */
  nearMs?: number;
  fullMs?: number;
  /** load/teleport: longest frame after the curtain lifted (until full), and behind it (ms) */
  maxFrameMs?: number;
  curtainFrameMs?: number;
}
// Absolute limits: an unbuilt chunk may be in clear view for a moment (a side street swinging
// into the ultrawide view as you enter a city; the stand-in covers it), not for seconds.
const LIMITS: Partial<Record<keyof Metrics, number>> = { maxHoleS: 2.5, maxStepMs: 50, nearMs: 2000, fullMs: 10000, maxFrameMs: 250 };
const DEFAULT_TOL: Record<keyof Metrics, { rel: number; abs: number }> = {
  maxHoleS: { rel: 0.5, abs: 0.3 },
  holeS: { rel: 0.5, abs: 0.5 },
  runwayP10: { rel: 0.3, abs: 0.5 },
  p99: { rel: 0.35, abs: 6 },
  loopP99: { rel: 0.35, abs: 4 },
  maxStepMs: { rel: 0.5, abs: 8 },
  genSyncMsPerS: { rel: 0.5, abs: 20 },
  nearMs: { rel: 0.4, abs: 300 },
  fullMs: { rel: 0.4, abs: 1500 },
  maxFrameMs: { rel: 0.5, abs: 50 },
  curtainFrameMs: { rel: 1, abs: 200 },
};
interface Baseline {
  note: string;
  date: string;
  size: string;
  tolerance: Record<keyof Metrics, { rel: number; abs: number }>;
  routes: Record<string, Metrics>;
}

function metricsOf(s: PerfSummary, chunkStats: { maxStepMs: number }): Metrics {
  return {
    maxHoleS: s.stream.maxHoleSeconds,
    holeS: s.stream.holeSeconds,
    runwayP10: Number.isFinite(s.stream.runwayP10) ? s.stream.runwayP10 : 0,
    p99: s.interval.p99,
    loopP99: s.loop.p99,
    maxStepMs: +chunkStats.maxStepMs.toFixed(1),
    genSyncMsPerS: +(s.mapgen.syncMs / Math.max(1, s.seconds)).toFixed(1),
  };
}

function judge(name: string, m: Metrics, base: Baseline | null): string[] {
  const fails: string[] = [];
  for (const [k, lim] of Object.entries(LIMITS) as [keyof Metrics, number][]) if (m[k] !== undefined && m[k]! > lim) fails.push(`${name}: ${k} ${m[k]} over the limit ${lim}`);
  const b = base?.routes[name];
  if (!b) return fails;
  for (const k of Object.keys(m) as (keyof Metrics)[]) {
    const tol = base!.tolerance[k] ?? DEFAULT_TOL[k];
    if (b[k] === undefined || m[k] === undefined) continue;
    if (k === 'runwayP10') {
      const floor = Math.min(b[k] * (1 - tol.rel), b[k] - tol.abs);
      if (m[k]! < floor) fails.push(`${name}: ${k} ${m[k]} s < ${floor.toFixed(2)} (baseline ${b[k]})`);
    } else {
      const ceil = Math.max(b[k] * (1 + tol.rel), b[k] + tol.abs);
      if (m[k]! > ceil) fails.push(`${name}: ${k} ${m[k]} > ${ceil.toFixed(2)} (baseline ${b[k]})`);
    }
  }
  return fails;
}

if (argv.includes('--dry-run')) {
  for (const r of routeNames) console.log(`would drive ${r} (${ROUTES[r].what}) for ${secondsArg || ROUTES[r].seconds}s at ${size.join('x')} in ${browserKind}${params ? ` with ${params}` : ''}`);
  console.log(`compare with ${baselinePath}${argv.includes('--write-baseline') ? ' and overwrite it' : ''}`);
  process.exit(0);
}

type Mon = { ready: number | null; near: number | null; full: number | null; maxCurtain: number; maxAfter: number };
let loadMonitor = false;
/** Wait for the monitor to see the curtain lift ('near') or everything in view built ('full'). */
async function waitMon(page: Page, what: 'near' | 'full', maxMs: number): Promise<Mon> {
  const t0 = Date.now();
  for (;;) {
    const m = (await page.evaluate('window.__perfMon')) as Mon;
    if (m[what] !== null || Date.now() - t0 > maxMs) return m;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitStreamed(page: Page, maxMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const done = await page.evaluate(`(() => { const s = cdda.renderer.chunks.stats; return s.pending === 0; })()`);
    if (done) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---- run --------------------------------------------------------------------------------------
const chrome = process.env.CHROME_PATH;
if (browserKind === 'chromium' && !chrome) throw new Error('CHROME_PATH not set: run inside nix-shell');
const server = await createServer({ server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
// Headless Firefox renders WebGL on the real GPU (EGL surfaceless; it reports a sanitized
// "GeForce ..., or similar"), so both browsers run the same way. No timer queries in Firefox.
const browser = browserKind === 'firefox'
  ? await puppeteer.launch({
    browser: 'firefox', executablePath: process.env.FIREFOX_PATH ?? '/run/current-system/sw/bin/firefox', headless: true, protocolTimeout: 600_000,
    extraPrefsFirefox: { 'browser.shell.checkDefaultBrowser': false, 'datareporting.policy.dataSubmissionEnabled': false },
  })
  : await puppeteer.launch({
    executablePath: chrome, headless: true, protocolTimeout: 600_000,
    args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', `--window-size=${size[0]},${size[1]}`],
  });
const results: Record<string, { route: unknown; metrics: Metrics; summary: PerfSummary; chunks: unknown }> = {};
const failures: string[] = [];
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: size[0], height: size[1] });
  page.on('pageerror', (e) => console.log(`[page exception] ${(e as Error).stack ?? e}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1${params ? '&' + params : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
  const err = await page.evaluate('window.cddaError');
  if (err) throw new Error(String(err));
  await page.evaluate(PERF_PAGE);
  if (argv.includes('--detail')) await page.evaluate('cdda.perf.detail(true)');
  if (argv.includes('--gpu-timer')) await page.evaluate('cdda.perf.gpu(true)');
  for (const name of routeNames) {
    const r = ROUTES[name];
    const seconds = secondsArg ? Number(secondsArg) : r.seconds;
    const jump = r.kind === 'load' || r.kind === 'loaddrive' || r.kind === 'teleport';
    const route = await page.evaluate(`__perfBench.pick(${JSON.stringify(jump ? (r.kind === 'teleport' ? 'town' : 'city') : r.kind)})`);
    let mon: Mon | null = null;
    if (jump) {
      // start in the city, streamed in; then the jump
      const from = await page.evaluate(`__perfBench.pick('city')`);
      await page.evaluate(`__perfBench.place(${JSON.stringify(from)})`);
      await waitStreamed(page, 30_000);
      await new Promise((res) => setTimeout(res, 1500));
      if (r.kind === 'teleport') {
        await page.evaluate(PERF_MONITOR);
        await page.evaluate(`(() => { cdda.perf.reset(); __perfMonStart(); __perfBench.place(${JSON.stringify(route)}); })()`);
      } else {
        await page.evaluate(`(async () => { await cdda.save.save(); cdda.save.queueLoad(); })()`);
        if (!loadMonitor) {
          await page.evaluateOnNewDocument(PERF_MONITOR);
          loadMonitor = true;
        }
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
        await page.evaluate(PERF_PAGE);
      }
      mon = await waitMon(page, r.kind === 'loaddrive' ? 'near' : 'full', 20_000);
      if (r.kind === 'loaddrive') await page.evaluate(`(() => { __perfBench.place(${JSON.stringify(from)}); __perfBench.go(${r.mph * MPH}); })()`);
      else await page.evaluate(`__perfBench.stop = () => {}`);
    } else {
      await page.evaluate(`__perfBench.place(${JSON.stringify(route)})`);
      // let the start area stream in completely, then measure from standing start at full speed
      await waitStreamed(page, 30_000);
      await new Promise((res) => setTimeout(res, 1500));
      await page.evaluate(`(() => { Object.assign(cdda.renderer.chunks.stats, { maxStepMs: 0, maxStep: '', maxFrameMs: 0, maxBuildMs: 0, slowBuilds: 0 }); cdda.perf.reset(); __perfBench.go(${r.mph * MPH}); })()`);
    }
    const shotsDir = opt('--shots', '');
    if (jump && r.kind !== 'loaddrive') await new Promise((res) => setTimeout(res, 1000));
    else if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      for (const k of [1, 2]) {
        await new Promise((res) => setTimeout(res, (seconds * 1000) / 3));
        await page.screenshot({ path: join(shotsDir, `${name}_${Math.round((seconds * k) / 3)}s.jpg`) as `${string}.jpg`, type: 'jpeg', quality: 80 });
      }
      await new Promise((res) => setTimeout(res, (seconds * 1000) / 3));
    } else await new Promise((res) => setTimeout(res, seconds * 1000));
    const out = (await page.evaluate(`(() => { __perfBench.stop(); return { dump: cdda.perf.dump(${seconds + 5}), chunks: { ...cdda.renderer.chunks.stats } }; })()`)) as { dump: PerfDump; chunks: { maxStepMs: number; maxStep: string } };
    const s = summarize(out.dump);
    const m = metricsOf(s, out.chunks);
    if (mon) {
      if (r.kind === 'loaddrive') mon = await page.evaluate('window.__perfMon') as Mon;
      // standing through a load, unbuilt chunks in view are the point of the measurement
      if (r.kind !== 'loaddrive') Object.assign(m, { maxHoleS: undefined, holeS: undefined, runwayP10: undefined, p99: undefined, loopP99: undefined });
      Object.assign(m, {
        nearMs: mon.near === null ? 99999 : Math.round(mon.near - mon.ready!),
        fullMs: r.kind === 'loaddrive' ? undefined : mon.full === null ? 99999 : Math.round(mon.full - mon.ready!),
        maxFrameMs: Math.round(mon.maxAfter), curtainFrameMs: Math.round(mon.maxCurtain),
      });
      console.log(`\n== ${name}: 3x3 shown ${m.nearMs} ms, all in view ${m.fullMs ?? '(driving)'} ms after ${r.kind === 'teleport' ? 'the jump' : 'ready'}; longest frame behind the curtain ${m.curtainFrameMs} ms, after it ${m.maxFrameMs} ms`);
    }
    results[name] = { route, metrics: m, summary: s, chunks: out.chunks };
    const meta = out.dump.meta as Record<string, unknown>;
    console.log(`\n== ${name}: ${r.what} (${JSON.stringify(route)})`);
    console.log(`   ${meta.look} radius ${meta.radius} ${meta.canvas} ${browserKind}; ${s.seconds} s, ${s.frames} frames, ${s.speed.mean} m/s`);
    console.log(`   unbuilt in view: longest ${m.maxHoleS} s, total ${m.holeS} s | runway p10 ${m.runwayP10} s, min ${s.stream.runwayMin} s | frame p99 ${m.p99} ms (max ${s.interval.max}) | loop p99 ${m.loopP99} | longest step ${m.maxStepMs} ms (${out.chunks.maxStep}) | mapgen in frames ${m.genSyncMsPerS} ms/s`);
    if (argv.includes('--report')) printReport(out.dump, name);
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      writeFileSync(join(saveDir, `${name}.json`), JSON.stringify(out.dump));
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const base: Baseline | null = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline) : null;
for (const [name, r] of Object.entries(results)) failures.push(...judge(name, r.metrics, base));
if (argv.includes('--json')) console.log(JSON.stringify(results));
if (argv.includes('--write-baseline')) {
  const nb: Baseline = {
    note: 'tools/perf-bench.ts budgets: a route fails when a metric is worse than this by more than the tolerance (relative and absolute). Re-record with --write-baseline after an intended change; see docs/PERF.md.',
    date: new Date().toISOString().slice(0, 10),
    size: size.join('x'),
    tolerance: base?.tolerance ?? DEFAULT_TOL,
    routes: { ...(base?.routes ?? {}), ...Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.metrics])) },
  };
  writeFileSync(resolve(baselinePath), JSON.stringify(nb, null, 2) + '\n');
  console.log(`\nwrote ${baselinePath}`);
} else if (!base) console.log(`\n(no baseline at ${baselinePath}: only absolute limits checked)`);
if (failures.length) {
  console.log(`\nFAIL (${failures.length})`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nPASS');

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
//   --dpr N            simulated display pixel ratio (default 1; try 2 for HiDPI)
//   --seconds N        override every route's duration
//   --params '<q>'     extra URL params (e.g. 'radius=6', 'look=full')
//   --browser firefox  headless Firefox (also on the GPU) instead of Chromium
//   --save DIR         write each route's telemetry dump (tools/perf-report.ts reads them)
//   --heap-profile DIR Chromium: sampled allocations per route (<route>.heapprofile; includes collected objects)
//   --ff-profile FILE  Firefox: the Gecko profiler from startup, written to FILE (gzip JSON; open it at
//                      profiler.firefox.com) when the browser closes: GC/CC markers name stalls
//                      between frames that no page API can see
//   --ff-gc FILE       Firefox: every GC's timing (MOZ_GCTIMER on stderr: each process writes its own;
//                      a file path would be truncated by every process that starts) collected into
//                      FILE: reason, incremental or not, total and max pause. Says whether stalls
//                      between frames are GC
//   --heap-snapshots DIR  Chromium, soak route: a heap snapshot after the forced GC at the start and at
//                      the end (soak_start/end.heapsnapshot; compare them in DevTools > Memory)
//   --profile DIR      Chromium: a CPU profile per route (<route>.cpuprofile; DevTools > Performance loads it)
//   --shots DIR        JPEG screenshots at 1/3 and 2/3 of each route (<route>_<s>s.jpg)
//                      diagnostic only: screenshots can disturb presentation timing
//   --baseline FILE    budgets to compare with (default tools/perf-baseline.json, .firefox.json for Firefox)
//   --write-baseline   record this run as the new baseline (keeps the tolerances)
//   --report           print the full perf-report for each route
//   --detail           time the mesher by kind (furniture models, surfaces, dressing, rooms); costs time itself
//   --gpu-timer        GPU ms per frame (EXT_disjoint_timer_query; Chromium only)
//   --json             print raw results
//   --no-drawn         skip the "world is drawn" gate (tools/lib/worldDrawn.ts) that runs first
//   --dry-run          print what would run
// Exit code 1 when a route breaks a budget.
import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { summarize, type PerfDump, type PerfSummary } from '../src/perf/analyze';
import { printReport } from './perf-report';
import { PERF_MONITOR, PERF_PAGE } from './lib/perfRoutes';
import { WORLD_DRAWN_MIN, worldDrawn } from './lib/worldDrawn';

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
  kind: 'town' | 'city' | 'rural' | 'forest' | 'load' | 'loaddrive' | 'teleport' | 'stand' | 'horde' | 'soak';
  mph: number;
  seconds: number;
  /** absolute limits for this route instead of LIMITS' (merged over them) */
  limits?: Partial<Record<keyof Metrics, number>>;
}
export const ROUTES: Record<string, Route> = {
  town40: { what: 'into and through the nearest town (Holden) at 40 mph, on the straight road with the most buildings along it', kind: 'town', mph: 40, seconds: 25 },
  town60: { what: 'the same road at 60 mph', kind: 'town', mph: 60, seconds: 25 },
  city40: { what: 'into and through the biggest town within ~100 OMTs (seed 1: Columbia Falls, size 18) at 40 mph', kind: 'city', mph: 40, seconds: 30 },
  city60: { what: 'the same city road at 60 mph', kind: 'city', mph: 60, seconds: 25 },
  // On foot (a brisk walk): what pops in when streaming has all the time it needs (docs/FAR_LOD.md).
  citywalk: { what: 'the same city road at walking pace (3 mph)', kind: 'city', mph: 3, seconds: 40 },
  forest: { what: 'straight through thick forest at 40 mph (3D trees, flora LOD rings)', kind: 'forest', mph: 40, seconds: 20 },
  rural: { what: 'the longest straight road outside town at 60 mph', kind: 'rural', mph: 60, seconds: 25 },
  // Loads and teleports (the user's "huge blip" after a hot reload, docs/PERF.md): time from the
  // game being ready (load) or the jump (teleport) to the player's 3x3 shown (curtain lifts) and
  // to nothing unbuilt in view, standing still; the longest frames before/after the curtain.
  load: { what: 'save in the city, reload the page (a hot reload / Load), stand still until everything in view is built', kind: 'load', mph: 0, seconds: 15 },
  // Driving off into a dense city the moment the curtain lifts outruns the streaming for a few
  // seconds (stand-ins show; the fight is keeping the frames smooth): a looser hole limit, and
  // the first build of each tree species (cold caches, one step) may take ~100 ms once, and
  // Firefox pauses ~250-280 ms between two frames about a second after the curtain lifts,
  // outside our frame (no headless profiler to name it; a major GC is the likely one).
  loaddrive: { what: 'the same reload, then drive off at 40 mph the moment the curtain lifts', kind: 'loaddrive', mph: 40, seconds: 15, limits: { maxHoleS: 8, maxStepMs: 150, maxFrameMs: 350 } },
  // Standing in a dense city (the user's second dump: draw-bound, 9.5 ms/frame of WebGL calls in
  // Firefox): mean draw ms and calls, and the longest frame with the flashlight switched on and
  // off twice mid-run (its first use once recompiled every shader: a 0.8-1 s freeze).
  citystand: { what: 'stand in the city centre for 12 s, flashlight on/off twice', kind: 'stand', mph: 0, seconds: 12, limits: { maxFrameMs: 150 } },
  // The user's stutter trace (2026-10-13, Firefox): ~1 Hz stalls of 120-170 ms that land in
  // whichever section is running (GC-like), with zombies on 3D models around a car at night,
  // headlights on (two shadowed spots), idle sway and wind-ups. Night, headlights, 60 zombies
  // of mixed families ahead on the road, the car rolling at 12 mph; they turn and chase it.
  horde: { what: 'night in town, headlights on, 60 mixed zombies ahead, the car rolling through them at 12 mph', kind: 'horde', mph: 12, seconds: 20, limits: { maxHoleS: 8 } },
  // Long sessions: the user's stutter showed up 2.8 h into a session. Waves of zombies spawned
  // ahead, killed (corpses) and left behind while the car rolls on; Chromium reports the heap
  // after a forced GC at the start and the end (growth = something kept per wave or per chunk).
  soak: { what: 'horde waves every 15 s (spawn 30, kill them 8 s later) while rolling at 12 mph; retained heap growth', kind: 'soak', mph: 12, seconds: 150, limits: { maxHoleS: 8 } },
  teleport: { what: 'jump from the city to Holden (~150 OMTs), stand still until everything in view is built', kind: 'teleport', mph: 0, seconds: 15 },
};

if (argv.includes('--list')) {
  for (const [k, r] of Object.entries(ROUTES)) console.log(`${k.padEnd(8)} ${r.seconds}s  ${r.what}`);
  process.exit(0);
}
const routeNames = opt('--routes', 'town40,town60,city40,city60,forest,rural,citystand,horde,teleport,load,loaddrive').split(',');
// "the world is drawn" gate (tools/lib/worldDrawn.ts) runs first unless --no-drawn
for (const r of routeNames) if (!ROUTES[r]) throw new Error(`unknown route ${r} (${Object.keys(ROUTES).join(', ')})`);
const size = opt('--size', '3440x1304').split('x').map(Number);
const dpr = Number(opt('--dpr', '1'));
if (!(dpr > 0 && dpr <= 4)) throw new Error('--dpr must be greater than 0 and at most 4');
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
  /** standing routes: mean CPU ms of the draw section, and mean draw calls per frame */
  drawMs?: number;
  calls?: number;
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
  drawMs: { rel: 0.35, abs: 1.5 },
  calls: { rel: 0.25, abs: 100 },
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
  for (const [k, lim] of Object.entries({ ...LIMITS, ...ROUTES[name]?.limits }) as [keyof Metrics, number][]) if (m[k] !== undefined && m[k]! > lim) fails.push(`${name}: ${k} ${m[k]} over the limit ${lim}`);
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
    env: opt('--ff-profile', '')
      ? { ...process.env, MOZ_PROFILER_STARTUP: '1', MOZ_PROFILER_SHUTDOWN: resolve(opt('--ff-profile', '')), MOZ_PROFILER_STARTUP_INTERVAL: '1', MOZ_PROFILER_STARTUP_ENTRIES: '50000000', MOZ_PROFILER_STARTUP_FEATURES: 'js,stackwalk,cpu,markersallthreads', MOZ_PROFILER_STARTUP_FILTERS: 'GeckoMain,Compositor,Renderer,DOM Worker,CanvasRenderer' }
      : opt('--ff-gc', '') ? { ...process.env, MOZ_GCTIMER: 'stderr' } : process.env,
    dumpio: false,
    extraPrefsFirefox: { 'browser.shell.checkDefaultBrowser': false, 'datareporting.policy.dataSubmissionEnabled': false },
  })
  : await puppeteer.launch({
    executablePath: chrome, headless: true, protocolTimeout: 600_000,
    args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', `--window-size=${size[0]},${size[1]}`],
  });
// MOZ_GCTIMER=stderr: collect the browser processes' stderr into the --ff-gc file
const ffGc = browserKind === 'firefox' ? opt('--ff-gc', '') : '';
if (ffGc) {
  const proc = browser.process();
  if (!proc?.stderr) throw new Error('--ff-gc: no stderr from the Firefox process');
  mkdirSync(dirname(resolve(ffGc)), { recursive: true });
  writeFileSync(ffGc, '');
  proc.stderr.on('data', (b: Buffer) => appendFileSync(ffGc, b));
}
const results: Record<string, { route: unknown; metrics: Metrics; summary: PerfSummary; chunks: unknown; alloc?: Alloc }> = {};
/**
 * Chromium --heap-profile: the sampled allocation profile (collected objects included) summed
 * per allocation site. Allocation is what makes Firefox stop for 100+ ms GCs between frames;
 * Chromium's sampled numbers are the repeatable proxy (performance.memory is too coarse).
 */
type Alloc = { mbPerS: number; top: { site: string; mb: number }[] };
type HeapNode = { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: HeapNode[] };
function allocOf(head: HeapNode, seconds: number): Alloc {
  const by = new Map<string, number>();
  let total = 0;
  const walk = (n: HeapNode, ours: string) => {
    const cf = n.callFrame;
    const file = cf.url.split('/').pop()?.split('?')[0] ?? '';
    const here = `${cf.functionName || '(anonymous)'} ${file}:${cf.lineNumber + 1}`;
    // charge native/library frames (subarray, three.js) to the nearest frame of our own sources
    const site = /\/src\//.test(cf.url) ? here : ours ? `${here.split(' ')[0]} < ${ours}` : here;
    if (n.selfSize) {
      total += n.selfSize;
      by.set(site, (by.get(site) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, /\/src\//.test(cf.url) ? here : ours);
  };
  walk(head, '');
  const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([site, b]) => ({ site, mb: +(b / 1048576).toFixed(1) }));
  return { mbPerS: +(total / 1048576 / seconds).toFixed(1), top };
}
let heapStart: number | null = null;
/** Chromium: JS heap (MB) after a forced full GC (and a snapshot of it with --heap-snapshots); null elsewhere. */
const retainedMB = async (page: Page, snapshot?: string): Promise<number | null> => {
  if (browserKind !== 'chromium') return null;
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const u = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
    const dir = opt('--heap-snapshots', '');
    if (dir && snapshot) {
      mkdirSync(dir, { recursive: true });
      const parts: string[] = [];
      cdp.on('HeapProfiler.addHeapSnapshotChunk', (e: { chunk: string }) => void parts.push(e.chunk));
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      writeFileSync(join(dir, `${snapshot}.heapsnapshot`), parts.join(''));
    }
    return +(u.usedSize / 1048576).toFixed(1);
  } finally {
    await cdp.detach();
  }
};

const failures: string[] = [];
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: size[0], height: size[1], deviceScaleFactor: dpr });
  page.on('pageerror', (e) => console.log(`[page exception] ${(e as Error).stack ?? e}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1${params ? '&' + params : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
  const err = await page.evaluate('window.cddaError');
  if (err) throw new Error(String(err));
  await page.evaluate(PERF_PAGE);
  if (!argv.includes('--no-drawn')) {
    // The world must actually be drawn before any timing means anything (a shader/texture
    // binding error once made every lit draw fail with all checks green): fresh load, then the
    // flashlight on and off, every shadow mode, default look.
    const from = await page.evaluate(`__perfBench.pick('town')`);
    await page.evaluate(`(() => { __perfBench.place(${JSON.stringify(from)}); cdda.exitVehicle(); })()`);
    await waitStreamed(page, 30_000);
    const checks: [string, string][] = [['fresh load', ''], ['flashlight on', 'cdda.flashlight(true)'], ['flashlight off', 'cdda.flashlight(false)']];
    const modes = (await page.evaluate(`cdda.shadows ? ['legacy', 'stable', 'cascades', 'smooth'] : []`)) as string[];
    for (const m of modes) checks.push([`shadows ${m}`, `cdda.setShadows(${JSON.stringify(m)})`], [`shadows ${m} + flashlight`, 'cdda.flashlight(true)'], [`shadows ${m}, flashlight off`, 'cdda.flashlight(false)']);
    const line: string[] = [];
    for (const [label, js] of checks) {
      if (js) await page.evaluate(js);
      await new Promise((res) => setTimeout(res, 300));
      const d = await worldDrawn(page);
      line.push(`${label} ${Math.round(d.changed * 100)}%`);
      if (!d.ok) failures.push(`world not drawn: ${label} (hiding the chunks changed ${Math.round(d.changed * 100)}% of the image, need ${WORLD_DRAWN_MIN * 100}%)`);
    }
    console.log(`\n== drawn: ${line.join(', ')}`);
  }
  if (argv.includes('--detail')) await page.evaluate('cdda.perf.detail(true)');
  if (argv.includes('--gpu-timer')) await page.evaluate('cdda.perf.gpu(true)');
  for (const name of routeNames) {
    const r = ROUTES[name];
    const seconds = secondsArg ? Number(secondsArg) : r.seconds;
    const jump = r.kind === 'load' || r.kind === 'loaddrive' || r.kind === 'teleport';
    const route = await page.evaluate(`__perfBench.pick(${JSON.stringify(jump ? (r.kind === 'teleport' ? 'town' : 'city') : r.kind === 'stand' ? 'city' : r.kind === 'horde' || r.kind === 'soak' ? 'town' : r.kind)})`);
    let mon: Mon | null = null;
    const profDir = opt('--profile', '');
    const heapDir = opt('--heap-profile', '');
    const cdp = (profDir || heapDir) && browserKind === 'chromium' ? await page.createCDPSession() : null;
    if (cdp && profDir) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
    }
    const startProfiles = async () => {
      if (!cdp) return;
      if (profDir) await cdp.send('Profiler.start');
      if (heapDir) {
        await cdp.send('HeapProfiler.enable');
        await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      }
      // Starting DevTools profilers blocks the page. Let that artificial interval
      // pass before resetting telemetry or beginning a load/teleport measurement.
      await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    };
    if (jump) {
      // start in the city, streamed in; then the jump
      const from = await page.evaluate(`__perfBench.pick('city')`);
      await page.evaluate(`__perfBench.place(${JSON.stringify(from)})`);
      await waitStreamed(page, 30_000);
      await new Promise((res) => setTimeout(res, 1500));
      await startProfiles();
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
      // the save kept you at the wheel of the car placed before it (vehicles restore the driver)
      if (r.kind === 'loaddrive') await page.evaluate(`(() => { if (!cdda.vehicleSystem.driving) throw new Error('not at the wheel after the load'); __perfBench.go(${r.mph * MPH}); })()`);
      else await page.evaluate(`__perfBench.stop = () => {}`);
    } else if (r.kind === 'stand') {
      // on foot in the middle of the densest city road, looking along it
      await page.evaluate(`(() => { const r = ${JSON.stringify(route)}; __perfBench.place({ ...r, lead: -4 }); cdda.exitVehicle(); __perfBench.stop = () => {}; })()`);
      await waitStreamed(page, 30_000);
      await new Promise((res) => setTimeout(res, 8000)); // far blocks merge once settled
      await startProfiles();
      await page.evaluate(`(() => { cdda.perf.reset(); const fl = (on, ms) => setTimeout(() => cdda.flashlight(on), ms); fl(true, 3000); fl(false, 5000); fl(true, 7000); fl(false, 9000); })()`);
    } else if (r.kind === 'soak') {
      await page.evaluate(`__perfBench.place({ ...${JSON.stringify(route)}, lead: 0 })`);
      await waitStreamed(page, 30_000);
      await page.evaluate(`__perfBench.horde(30)`);
      await new Promise((res) => setTimeout(res, 4000));
      heapStart = await retainedMB(page, 'soak_start');
      await startProfiles();
      await page.evaluate(`(() => { cdda.perf.reset(); __perfBench.go(${r.mph * MPH}); __perfBench.waves = setInterval(() => { cdda.killAll(80); setTimeout(() => __perfBench.horde(30), 7000); }, 15000); })()`);
    } else if (r.kind === 'horde') {
      await page.evaluate(`__perfBench.place({ ...${JSON.stringify(route)}, lead: 0 })`);
      await waitStreamed(page, 30_000);
      await page.evaluate(`__perfBench.horde(60)`);
      // their skins paint and the first wind-ups compile before the measurement starts
      await new Promise((res) => setTimeout(res, 4000));
      await startProfiles();
      await page.evaluate(`(() => { Object.assign(cdda.renderer.chunks.stats, { maxStepMs: 0, maxStep: '', maxFrameMs: 0, maxBuildMs: 0, slowBuilds: 0 }); cdda.perf.reset(); __perfBench.go(${r.mph * MPH}); })()`);
    } else {
      await page.evaluate(`__perfBench.place(${JSON.stringify(route)})`);
      // let the start area stream in completely, then measure from standing start at full speed
      await waitStreamed(page, 30_000);
      await new Promise((res) => setTimeout(res, 1500));
      await startProfiles();
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
    let alloc: Alloc | undefined;
    if (cdp && heapDir) {
      const { profile } = await cdp.send('HeapProfiler.stopSampling');
      alloc = allocOf(profile.head as unknown as HeapNode, seconds);
      mkdirSync(heapDir, { recursive: true });
      writeFileSync(join(heapDir, `${name}.heapprofile`), JSON.stringify(profile));
    }
    if (r.kind === 'soak') {
      await page.evaluate('clearInterval(__perfBench.waves)');
      const end = await retainedMB(page, 'soak_end');
      if (heapStart !== null && end !== null) console.log(`\n== ${name}: retained heap after GC ${heapStart} MB -> ${end} MB (${(end - heapStart).toFixed(1)} MB in ${seconds} s)`);
    }
    const out = (await page.evaluate(`(() => { __perfBench.stop(); return { dump: cdda.perf.dump(${seconds + 5}), chunks: { ...cdda.renderer.chunks.stats } }; })()`)) as { dump: PerfDump; chunks: { maxStepMs: number; maxStep: string } };
    if (cdp && profDir) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
      mkdirSync(profDir, { recursive: true });
      writeFileSync(join(profDir, `${name}.cpuprofile`), JSON.stringify(profile));
    }
    if (cdp) await cdp.detach();
    const s = summarize(out.dump);
    const m = metricsOf(s, out.chunks);
    if (r.kind === 'stand') {
      Object.assign(m, { maxHoleS: undefined, holeS: undefined, runwayP10: undefined, maxFrameMs: Math.round(s.interval.max), drawMs: s.sections.draw, calls: Math.round(s.sections.calls ?? NaN) });
      const calls = (out.dump.frames.calls ?? []).filter((v): v is number => typeof v === 'number');
      m.calls = Math.round(calls.reduce((a, b) => a + b, 0) / Math.max(1, calls.length));
      console.log(`\n== ${name}: draw ${m.drawMs} ms/frame, ${m.calls} draw calls/frame, longest frame ${m.maxFrameMs} ms (flashlight toggled 4x), ${s.compiles} shader compiles`);
    }
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
    results[name] = { route, metrics: m, summary: s, chunks: out.chunks, alloc };
    if (alloc) {
      console.log(`\n== ${name}: JS allocation ${alloc.mbPerS} MB/s (sampled, collected objects included); top sites (MB over the run):`);
      for (const t of alloc.top) console.log(`   ${String(t.mb).padStart(7)}  ${t.site}`);
    }
    if (r.kind === 'horde') {
      const iv = (out.dump.frames.interval ?? []).filter((v): v is number => typeof v === 'number');
      console.log(`== ${name}: frames over 50 ms ${iv.filter((v) => v > 50).length}, over 100 ms ${iv.filter((v) => v > 100).length}; p50 ${s.interval.p50} p99 ${s.interval.p99} max ${s.interval.max}; ${s.compiles} shader compiles; sections ${JSON.stringify(s.sections)}`);
    }
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

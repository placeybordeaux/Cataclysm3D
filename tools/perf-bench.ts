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
//   --routes a,b       routes to run (default: town40,town60,forest,rural); --list shows them
//   --size WxH         viewport (default 3440x1304, the user's ultrawide)
//   --seconds N        override every route's duration
//   --params '<q>'     extra URL params (e.g. 'radius=6', 'look=full')
//   --browser firefox  Firefox instead of Chromium (software GL under Xvfb: CPU-side numbers only)
//   --save DIR         write each route's telemetry dump (tools/perf-report.ts reads them)
//   --baseline FILE    budgets to compare with (default tools/perf-baseline.json)
//   --write-baseline   record this run as the new baseline (keeps the tolerances)
//   --report           print the full perf-report for each route
//   --json             print raw results
//   --dry-run          print what would run
// Exit code 1 when a route breaks a budget.
import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { summarize, type PerfDump, type PerfSummary } from '../src/perf/analyze';
import { printReport } from './perf-report';
import { launchBrowser, startXvfb } from './lib/realinput';

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
  kind: 'town' | 'rural' | 'forest';
  mph: number;
  seconds: number;
}
export const ROUTES: Record<string, Route> = {
  town40: { what: 'through the nearest town on its longest straight road at 40 mph', kind: 'town', mph: 40, seconds: 25 },
  town60: { what: 'the same road at 60 mph', kind: 'town', mph: 60, seconds: 25 },
  forest: { what: 'straight through thick forest at 40 mph (3D trees, flora LOD rings)', kind: 'forest', mph: 40, seconds: 20 },
  rural: { what: 'the longest straight road outside town at 60 mph', kind: 'rural', mph: 60, seconds: 25 },
};

if (argv.includes('--list')) {
  for (const [k, r] of Object.entries(ROUTES)) console.log(`${k.padEnd(8)} ${r.seconds}s  ${r.what}`);
  process.exit(0);
}
const routeNames = opt('--routes', 'town40,town60,forest,rural').split(',');
for (const r of routeNames) if (!ROUTES[r]) throw new Error(`unknown route ${r} (${Object.keys(ROUTES).join(', ')})`);
const size = opt('--size', '3440x1304').split('x').map(Number);
if (size.length !== 2 || size.some((v) => !(v > 0))) throw new Error(`--size ${opt('--size', '')}: expected WxH`);
const secondsArg = opt('--seconds', '');
const params = opt('--params', '');
const browserKind = opt('--browser', 'chromium');
if (browserKind !== 'chromium' && browserKind !== 'firefox') throw new Error(`--browser ${browserKind}: chromium or firefox`);
const saveDir = opt('--save', '');
const baselinePath = opt('--baseline', 'tools/perf-baseline.json');

// ---- budgets ---------------------------------------------------------------------------------
// Metrics per route, "lower is better" except runwayP10 (higher is better). A route fails when a
// metric is worse than its baseline beyond the tolerance (relative AND absolute: the shared
// machine's load moves timings by +-30 %), or breaks an absolute limit regardless of baseline.
export interface Metrics {
  /** longest continuous stretch with an unbuilt chunk in clear view (s) */
  maxHoleS: number;
  /** total such time (s) */
  holeS: number;
  /** 10th percentile of runway while moving (s of travel before the first unbuilt chunk) */
  runwayP10: number;
  /** frame interval p99 (ms) */
  p99: number;
  /** our main-loop p99 (ms) */
  loopP99: number;
  /** longest single uninterrupted meshing step (ms): the time-slicing granularity */
  maxStepMs: number;
  /** mapgen inside frames (ms per second of driving) */
  genSyncMsPerS: number;
}
const LIMITS: Partial<Record<keyof Metrics, number>> = { maxHoleS: 1.0, maxStepMs: 40 };
const DEFAULT_TOL: Record<keyof Metrics, { rel: number; abs: number }> = {
  maxHoleS: { rel: 0.5, abs: 0.3 },
  holeS: { rel: 0.5, abs: 0.5 },
  runwayP10: { rel: 0.3, abs: 0.5 },
  p99: { rel: 0.35, abs: 6 },
  loopP99: { rel: 0.35, abs: 4 },
  maxStepMs: { rel: 0.5, abs: 8 },
  genSyncMsPerS: { rel: 0.5, abs: 20 },
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
  for (const [k, lim] of Object.entries(LIMITS) as [keyof Metrics, number][]) if (m[k] > lim) fails.push(`${name}: ${k} ${m[k]} over the limit ${lim}`);
  const b = base?.routes[name];
  if (!b) return fails;
  for (const k of Object.keys(m) as (keyof Metrics)[]) {
    const tol = base!.tolerance[k] ?? DEFAULT_TOL[k];
    if (b[k] === undefined) continue;
    if (k === 'runwayP10') {
      const floor = Math.min(b[k] * (1 - tol.rel), b[k] - tol.abs);
      if (m[k] < floor) fails.push(`${name}: ${k} ${m[k]} s < ${floor.toFixed(2)} (baseline ${b[k]})`);
    } else {
      const ceil = Math.max(b[k] * (1 + tol.rel), b[k] + tol.abs);
      if (m[k] > ceil) fails.push(`${name}: ${k} ${m[k]} > ${ceil.toFixed(2)} (baseline ${b[k]})`);
    }
  }
  return fails;
}

if (argv.includes('--dry-run')) {
  for (const r of routeNames) console.log(`would drive ${r} (${ROUTES[r].what}) for ${secondsArg || ROUTES[r].seconds}s at ${size.join('x')} in ${browserKind}${params ? ` with ${params}` : ''}`);
  console.log(`compare with ${baselinePath}${argv.includes('--write-baseline') ? ' and overwrite it' : ''}`);
  process.exit(0);
}

// ---- page side --------------------------------------------------------------------------------
// Route picking and the ghost car, evaluated in the page (cdda.* only sets the scene up).
const PAGE = `(() => {
  const c = window.cdda;
  const roadRun = (x, y, dx, dy, max) => {
    let n = 0;
    while (n < max && /^road_/.test(c.omtAt(x + dx * n, y + dy * n, 0).id)) n++;
    return n;
  };
  const DIRS = [[1, 0, 0], [-1, 0, 180], [0, 1, 90], [0, -1, 270]]; // dx, dy, vehicle facing (0 = east, clockwise)
  /** Longest straight road run starting within 'r' OMTs of (cx, cy): { x, y, facing, len }. */
  const longestRoad = (cx, cy, r, step, notIn) => {
    let best = null;
    for (let oy = -r; oy <= r; oy += step) for (let ox = -r; ox <= r; ox += step) {
      const x = cx + ox, y = cy + oy;
      if (!/^road_/.test(c.omtAt(x, y, 0).id)) continue;
      if (notIn && notIn(x, y)) continue;
      for (const [dx, dy, f] of DIRS) {
        // only starts of runs: the OMT behind is not road
        if (/^road_/.test(c.omtAt(x - dx, y - dy, 0).id)) continue;
        const len = roadRun(x, y, dx, dy, 60);
        if (!best || len > best.len) best = { x, y, facing: f, len, dx, dy };
      }
    }
    return best;
  };
  window.__perfBench = {
    pick(kind) {
      const s = c.startLocation();
      const cities = c.cities();
      if (kind === 'town') {
        const town = cities.filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
        const r = longestRoad(town.x, town.y, 8, 1);
        return { ...r, town: town.name };
      }
      if (kind === 'rural') {
        const inTown = (x, y) => cities.some((t) => Math.hypot(t.x - x, t.y - y) < t.size + 2);
        return longestRoad(s.omx, s.omy, 40, 2, inTown);
      }
      if (kind === 'forest') {
        const f = c.findOmt('forest_thick', 60);
        if (!f) throw new Error('no forest_thick near the start');
        // head away from the forest's edge: the direction with the most forest ahead
        let best = null;
        for (const [dx, dy, facing] of DIRS) {
          let n = 0;
          while (n < 30 && /forest/.test(c.omtAt(f.x + dx * n, f.y + dy * n, 0).id)) n++;
          if (!best || n > best.len) best = { x: f.x, y: f.y, facing, len: n, dx, dy };
        }
        return best;
      }
      throw new Error('unknown route kind ' + kind);
    },
    /** A car at the start of the route, facing along it, you at the wheel. */
    place(r) {
      const vs = c.vehicleSystem;
      if (vs.driving) { vs.driving.velocity = 0; c.exitVehicle(); }
      c.godMode(true);
      c.setWeather('clear');
      c.setHour(12);
      c.clearMonsters?.();
      // right-hand lane of the road, 2 OMTs back so the run starts at full view
      const X = (r.x - r.dx * 2) * 24 + 12, Y = (r.y - r.dy * 2) * 24 + 12;
      const lx = -r.dy * 3, ly = r.dx * 3;
      c.teleport(X + lx + 0.5, Y + ly + 0.5, 0);
      const v = vs.spawn('car', Math.floor(X + lx), Math.floor(Y + ly), 0, r.facing, { fuel: 100, status: 0, force: true });
      if (!v) throw new Error('could not spawn the car');
      c.enterVehicle(v.uid);
      return v.uid;
    },
    /** Move the car (and you in it) straight ahead at mps, no collision, until stop(). */
    go(mps) {
      const vs = c.vehicleSystem, v = vs.driving, p = c.game.player;
      const [plx, ply] = v.worldToMount(p.x, p.y);
      const rad = (v.facing * Math.PI) / 180;
      const sys = {
        name: 'perfGhost',
        update: (_g, dt) => {
          v.x += Math.cos(rad) * mps * dt;
          v.y += Math.sin(rad) * mps * dt;
          vs.reindex(v);
          const [wx, wy] = v.mountToWorld(plx, ply);
          p.x = wx;
          p.y = wy;
          for (const part of Object.values(p.hp)) part.cur = part.max;
        },
      };
      c.game.systems.push(sys);
      this.stop = () => c.game.systems.splice(c.game.systems.indexOf(sys), 1);
    },
  };
})()`;

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
// Firefox has no headless GPU path here: it runs windowed under a private Xvfb (startXvfb sets DISPLAY)
if (browserKind === 'firefox') await startXvfb(size[0] + 40, size[1] + 200);
const browser = browserKind === 'firefox'
  ? await launchBrowser('firefox', size[0], size[1])
  : await puppeteer.launch({
    executablePath: chrome, headless: true, protocolTimeout: 600_000,
    args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', `--window-size=${size[0]},${size[1]}`],
  });
const results: Record<string, { route: unknown; metrics: Metrics; summary: PerfSummary; chunks: unknown }> = {};
const failures: string[] = [];
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  if (browserKind === 'chromium') await page.setViewport({ width: size[0], height: size[1] });
  page.on('pageerror', (e) => console.log(`[page exception] ${(e as Error).stack ?? e}`));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`http://127.0.0.1:${port}/?seed=1&skipmenu=1${params ? '&' + params : ''}`, { waitUntil: 'load' });
  await page.waitForFunction('window.cdda?.ready || window.cddaError', { timeout: 240_000 });
  const err = await page.evaluate('window.cddaError');
  if (err) throw new Error(String(err));
  await page.evaluate(PAGE);
  for (const name of routeNames) {
    const r = ROUTES[name];
    const seconds = secondsArg ? Number(secondsArg) : r.seconds;
    const route = await page.evaluate(`__perfBench.pick(${JSON.stringify(r.kind)})`);
    await page.evaluate(`__perfBench.place(${JSON.stringify(route)})`);
    // let the start area stream in completely, then measure from standing start at full speed
    await waitStreamed(page, 30_000);
    await new Promise((res) => setTimeout(res, 1500));
    await page.evaluate(`(() => { Object.assign(cdda.renderer.chunks.stats, { maxStepMs: 0, maxStep: '', maxFrameMs: 0, maxBuildMs: 0, slowBuilds: 0 }); cdda.perf.reset(); __perfBench.go(${r.mph * MPH}); })()`);
    await new Promise((res) => setTimeout(res, seconds * 1000));
    const out = (await page.evaluate(`(() => { __perfBench.stop(); return { dump: cdda.perf.dump(${seconds + 5}), chunks: { ...cdda.renderer.chunks.stats } }; })()`)) as { dump: PerfDump; chunks: { maxStepMs: number; maxStep: string } };
    const s = summarize(out.dump);
    const m = metricsOf(s, out.chunks);
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

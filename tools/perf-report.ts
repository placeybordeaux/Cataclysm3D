// Explain a performance dump (Shift+F3 in game, `tsx tools/live.ts perf`, or tools/perf-bench.ts
// --save): where the frame time went, whether the world streamed in ahead of the player, what
// mapgen cost, and the worst frames with what happened in them. docs/PERF.md.
//
//   npx tsx tools/perf-report.ts <dump.json> [--json] [--last N]
//
// --json   print the summary object instead of the report
// --last N only the last N seconds of the dump
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { summarize, type PerfDump } from '../src/perf/analyze';

const bar = (v: number, max: number, w = 24) => '█'.repeat(Math.max(0, Math.round((v / Math.max(max, 1e-9)) * w)));
const NAMES: Record<string, string> = {
  sim: 'game simulation', chunkCreate: 'chunk entries (+ mapgen)', chunkSig: 'chunk bookkeeping', chunkBuild: 'chunk meshing',
  grass: 'grass', skyline: 'skyline', decor: 'decor', sprites: 'sprites', beforeRender: 'monsters/vehicles/fx', lightmap: 'light map',
  scene: 'sky/lights', draw: 'draw (CPU side)', other: 'other', wait: 'before our callback',
  mesh: '  of which mesh data', trees: '  of which 3D trees', genSync: '  of which mapgen in frame', genHooks: '  mapgen hooks',
  kModels: '  mesher: furniture models', kSurfaces: '  mesher: painted surfaces', kDressing: '  mesher: set dressing', kRooms: '  mesher: rooms', gpu: 'GPU (timer query)',
};

/** Slice a dump to its last `sec` seconds. */
export function lastSeconds(d: PerfDump, sec: number): PerfDump {
  const t = d.frames.t;
  const tEnd = t[t.length - 1] ?? 0;
  const i0 = t.findIndex((v) => v >= tEnd - sec * 1000);
  const frames = Object.fromEntries(Object.entries(d.frames).map(([k, v]) => [k, (v as unknown[]).slice(i0)])) as PerfDump['frames'];
  return { ...d, frames, events: d.events.filter((e) => e.t >= (t[i0] ?? 0)) };
}

export function printReport(d: PerfDump, name = 'dump'): void {
  const s = summarize(d);
  const m = d.meta as Record<string, unknown>;
  console.log(`\n== ${name}`);
  console.log(`   ${m.date ?? ''}  ${m.window ?? ''} (canvas ${m.canvas ?? '?'}, low-res ${m.lowres ?? '?'})  look ${m.look}  radius ${m.radius}  budget ${m.budgetMs}/${m.urgentBudgetMs} ms`);
  console.log(`   ${String(m.userAgent ?? '').slice(0, 110)}`);
  if (m.gpu) console.log(`   GPU ${m.gpu}`);
  console.log(`\n   ${s.seconds} s, ${s.frames} frames; moving ${s.speed.movingSeconds} s at mean ${s.speed.mean} m/s (${(s.speed.mean * 2.237).toFixed(0)} mph), max ${s.speed.max} m/s`);
  const iv = s.interval, lp = s.loop;
  console.log(`   frame interval ms  p50 ${iv.p50}  p95 ${iv.p95}  p99 ${iv.p99}  max ${iv.max}   >33 ms ${s.hitches33}  >50 ms ${s.hitches50}`);
  console.log(`   our loop ms        p50 ${lp.p50}  p95 ${lp.p95}  p99 ${lp.p99}  max ${lp.max}`);
  console.log('\n   where the main loop goes (mean ms per frame)');
  const max = Math.max(...Object.values(s.sections));
  for (const [k, v] of Object.entries(s.sections).sort((a, b) => (a[0].startsWith('k') || ['mesh', 'trees', 'genSync', 'genHooks'].includes(a[0]) ? 1 : 0) - (b[0].startsWith('k') || ['mesh', 'trees', 'genSync', 'genHooks'].includes(b[0]) ? 1 : 0) || b[1] - a[1])) {
    if (v < 0.01) continue;
    console.log(`   ${(NAMES[k] ?? k).padEnd(28)} ${v.toFixed(2).padStart(6)}  ${bar(v, max)}`);
  }
  const st = s.stream;
  console.log('\n   streaming');
  console.log(`   unbuilt chunks in clear view: ${st.holeSeconds} s (longest ${st.maxHoleSeconds} s); in the fog ${st.fogHoleSeconds} s`);
  console.log(`   runway while moving: min ${st.runwayMin} s, p10 ${st.runwayP10} s, under 2 s ${Number.isFinite(st.runwayUnder2) ? Math.round(st.runwayUnder2 * 100) : '–'}% of the time`);
  console.log(`   first builds ${st.builds} (wanted -> shown p50 ${st.buildWait.p50} ms, p95 ${st.buildWait.p95}, max ${st.buildWait.max}); rebuilds ${st.rebuilds}; tree swaps ${st.treeSwaps}; dropped unshown ${st.droppedUnshown}; oldest wait ${st.oldestMax} ms`);
  const mg = s.mapgen;
  console.log('\n   mapgen');
  console.log(`   in frames ${mg.syncN} chunks / ${mg.syncMs} ms;  idle-time prefetch ${mg.preN} / ${mg.preMs} ms;  hooks ${mg.hooksMs} ms;  slowest chunk ${mg.maxMs} ms`);
  for (const o of mg.slowest.slice(0, 8)) console.log(`     ${o.omt.padEnd(34)} n ${String(o.n).padStart(4)}  mean ${o.mean.toFixed(2).padStart(6)}  max ${o.max.toFixed(1).padStart(6)}  total ${o.total.toFixed(0).padStart(6)} ms`);
  console.log('\n   worst frames');
  for (const w of s.worstFrames.slice(0, 8)) {
    const split = Object.entries(w.split).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ');
    console.log(`   ${String(w.interval).padStart(6)} ms @${(w.t / 1000).toFixed(1)}s  ${split}${w.gens.length ? `  | gen: ${w.gens.slice(0, 3).join(', ')}${w.gens.length > 3 ? ` +${w.gens.length - 3}` : ''}` : ''}${w.builds ? `  | ${w.builds} builds done` : ''}`);
  }
  console.log('\n   findings');
  for (const f of s.findings) console.log(`   - ${f}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(argv.length ? 0 : 1);
  }
  const li = argv.indexOf('--last');
  const last = li >= 0 ? Number(argv[li + 1]) : undefined;
  const files = argv.filter((a, i) => !a.startsWith('--') && !(li >= 0 && i === li + 1));
  for (const f of files) {
    let d = JSON.parse(readFileSync(f, 'utf8')) as PerfDump;
    if (d.version !== 1) throw new Error(`${f}: not a perf dump (version ${String(d.version)})`);
    if (last) d = lastSeconds(d, last);
    if (argv.includes('--json')) console.log(JSON.stringify(summarize(d), null, 2));
    else printReport(d, f);
  }
}

// Probe BN mutable specials (genVersion 2): counts per special over a block of regions, open
// joins, and the oter types they produced.
// Usage: tsx tools/dev/probe_mutable.ts [--radius N] [--dump <special>] <seed> [seed...]
import { Overmap, REGION } from '../../src/world/overmap/overmap';
import { loadNodeData } from '../lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
  console.log('probe_mutable [--radius N (default 1: 3x3 regions)] [--dump <special id>] <seed>...');
  process.exit(0);
}
const opt = (n: string) => {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const radius = Number(opt('--radius') ?? 1);
const dump = opt('--dump');
const { wg } = loadNodeData();
for (const seed of argv.map(Number)) {
  const om = new Overmap(seed, wg.overmap);
  const t0 = performance.now();
  for (let ry = -radius; ry <= radius; ry++) for (let rx = -radius; rx <= radius; rx++) om.omtAt(rx * REGION, ry * REGION, 0);
  const ms = performance.now() - t0;
  const byDef = new Map<string, { n: number; omts: number; open: number }>();
  for (const r of om.mutableReports) {
    const e = byDef.get(r.def) ?? { n: 0, omts: 0, open: 0 };
    e.n++, (e.omts += r.pieces.length), (e.open += r.openMandatory ? 1 : 0);
    byDef.set(r.def, e);
  }
  const fixed = new Map<string, number>();
  for (const id of wg.overmap.mutableWildSpecials ?? []) if (!wg.overmap.mutables?.[id]) {
    let n = 0;
    for (let ry = -radius; ry <= radius; ry++) for (let rx = -radius; rx <= radius; rx++) {
      const s = om.findSpecial(id, { x: rx * REGION + 48, y: ry * REGION + 48 }, 0);
      if (s && Math.floor(s.x / REGION) === rx && Math.floor(s.y / REGION) === ry) n++;
    }
    fixed.set(id, n);
  }
  console.log(`seed ${seed}: ${(2 * radius + 1) ** 2} regions in ${ms.toFixed(0)} ms`);
  for (const [d, e] of byDef) console.log(`  ${d.padEnd(18)} ${String(e.n).padStart(3)} placed, ${(e.omts / e.n).toFixed(1)} OMTs avg, ${e.open} with open mandatory joins`);
  for (const [d, n] of fixed) console.log(`  ${d.padEnd(18)} ${String(n).padStart(3)} (fixed, >=; one counted per region)`);
  if (dump) {
    const r = om.mutableReports.find((x) => x.def === dump);
    if (!r) continue;
    const s = om.findSpecial(dump, { x: 0, y: 0 }, radius)!;
    for (let z = 0; z >= -4; z--) {
      console.log(`  -- ${dump} at ${s.x},${s.y} z${z}`);
      console.log(om.dump(s.x, s.y, 8, z).split('\n').map((l) => '    ' + l).join('\n'));
    }
  }
}

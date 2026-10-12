// Probe genVersion 3 lakes: lake / shore OMTs and their columns, and where sunken_lab placed.
// Sunken labs are rare (BN scales their count by the region's share of lake_surface, and our
// lakes are small), so finding one takes hundreds of regions: --scan prints every hit.
// Usage: tsx tools/dev/probe_lakes.ts [--radius N] [--scan] <seed> [seed...]
import { Overmap, REGION } from '../../src/world/overmap/overmap';
import { loadNodeData } from '../lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
  console.log('probe_lakes [--radius N (default 1: 3x3 regions)] [--scan (only print sunken_lab hits)] <seed>...');
  process.exit(0);
}
const opt = (n: string) => {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (n: string) => {
  const i = argv.indexOf(n);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const radius = Number(opt('--radius') ?? 1);
const scan = flag('--scan');
const { wg } = loadNodeData();
let regions = 0, hits = 0;
const t0 = performance.now();
for (const seed of argv.map(Number)) {
  const om = new Overmap(seed, wg.overmap);
  let surface = 0, shore = 0, labs = 0;
  for (let ry = -radius; ry <= radius; ry++)
    for (let rx = -radius; rx <= radius; rx++) {
      regions++;
      const s = om.findSpecial('sunken_lab', { x: rx * REGION + 48, y: ry * REGION + 48 }, 0);
      if (s && Math.floor(s.x / REGION) === rx && Math.floor(s.y / REGION) === ry) {
        labs++, hits++;
        let basement = 0;
        for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) for (const z of [-6, -7]) if (om.omtAt(s.x + dx, s.y + dy, z).type.startsWith('lab')) basement++;
        console.log(`sunken_lab seed ${seed} region ${rx},${ry} at ${s.x},${s.y} rot ${s.rot}: ${basement} lab OMTs at z-6/-7`);
      }
      if (scan) continue;
      for (let y = 0; y < REGION; y++)
        for (let x = 0; x < REGION; x++) {
          const t = om.omtAt(rx * REGION + x, ry * REGION + y, 0).type;
          if (t === 'lake_surface') surface++;
          else if (t === 'lake_shore') shore++;
        }
    }
  if (!scan) console.log(`seed ${seed}: lake_surface ${surface}, lake_shore ${shore}, sunken_lab ${labs}`);
}
console.log(`${regions} regions in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${hits} sunken labs`);

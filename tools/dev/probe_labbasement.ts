// Statistics and ASCII maps of generated classic-lab basements (BN lab_basement mutable).
// Usage: tsx tools/dev/probe_labbasement.ts [--seeds N] [--regions R] [--draw K] [--gen V]
//   --seeds N    seeds 1..N (default 20)
//   --regions R  regions -R..R square per seed (default 1)
//   --draw K     print the first K labs level by level (default 1)
//   --gen V      overmap genVersion (default latest)
import { Overmap, REGION, WORLDGEN_VERSION } from '../../src/world/overmap/overmap';
import { loadNodeData } from '../lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('tsx tools/dev/probe_labbasement.ts [--seeds N] [--regions R] [--draw K] [--gen V]');
  process.exit(0);
}
const num = (k: string, d: number) => (argv.includes(k) ? Number(argv[argv.indexOf(k) + 1]) : d);
const SEEDS = num('--seeds', 20), RAD = num('--regions', 1), DRAW = num('--draw', 1), GEN = num('--gen', WORLDGEN_VERSION);
const { wg } = loadNodeData();
const SYM: Record<string, string> = {
  lab: 'L', lab_filler: 'f', lab_stairs: '>', lab_core: '<', lab_finale: 'F', lab_escape_cells: 'C', lab_escape_entrance: 'e', lab_train_depot: 'T',
};

let labs = 0, withCells = 0, withDepot2 = 0, withDepot4 = 0, deep4 = 0, drawn = 0;
const depth: Record<number, number> = {}, sizes: number[] = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  const ov = new Overmap(seed, wg.overmap, GEN);
  for (let ry = -RAD; ry <= RAD; ry++)
    for (let rx = -RAD; rx <= RAD; rx++) {
      // generate the region, then find its classic labs
      ov.omtAt(rx * REGION, ry * REGION, 0);
      const specials = ov.citiesNear(rx * REGION, ry * REGION, 0) && (ov as any).region(rx, ry).specials as { def: string; uid: number; x: number; y: number }[];
      for (const sp of specials.filter((s) => s.def === 'Lab')) {
        labs++;
        const cells = new Map<string, string>();
        let minZ = 0;
        for (let z = -1; z >= -7; z--)
          for (let dy = -12; dy <= 12; dy++)
            for (let dx = -12; dx <= 12; dx++) {
              const o = ov.omtAt(sp.x + dx, sp.y + dy, z);
              if (o.special?.uid !== sp.uid) continue;
              cells.set(`${dx},${dy},${z}`, o.type);
              minZ = Math.min(minZ, z);
            }
        sizes.push(cells.size);
        depth[minZ] = (depth[minZ] ?? 0) + 1;
        if (minZ <= -4) deep4++;
        const types = [...cells.entries()];
        if (types.some(([, t]) => t === 'lab_escape_cells')) withCells++;
        if (types.some(([k, t]) => t === 'lab_train_depot' && k.endsWith(',-2'))) withDepot2++;
        if (types.some(([k, t]) => t === 'lab_train_depot' && k.endsWith(',-4'))) withDepot4++;
        if (drawn < DRAW) {
          drawn++;
          console.log(`\nseed ${seed} region ${rx},${ry} Lab at ${sp.x},${sp.y}: ${cells.size} OMTs, bottom z${minZ}`);
          for (let z = -1; z >= minZ; z--) {
            console.log(` z${z}`);
            for (let dy = -12; dy <= 12; dy++) {
              let row = '';
              for (let dx = -12; dx <= 12; dx++) row += SYM[cells.get(`${dx},${dy},${z}`) ?? ''] ?? (dx === 0 && dy === 0 ? '+' : '.');
              if (/[^.+]/.test(row)) console.log('   ' + row);
            }
          }
        }
      }
    }
}
const pct = (n: number) => `${((100 * n) / Math.max(1, labs)).toFixed(0)}%`;
sizes.sort((a, b) => a - b);
console.log(`\n${labs} labs (gen ${GEN}); OMTs median ${sizes[sizes.length >> 1]} (min ${sizes[0]}, max ${sizes[sizes.length - 1]})`);
console.log(`bottom level: ${Object.entries(depth).sort(([a], [b]) => Number(b) - Number(a)).map(([z, n]) => `z${z}:${n}`).join(' ')}`);
console.log(`reach z-4: ${pct(deep4)}  escape cells: ${pct(withCells)}  depot z-2: ${pct(withDepot2)}  depot z-4: ${pct(withDepot4)}`);

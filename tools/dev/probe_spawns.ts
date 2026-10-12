// Special-spawn monster groups (genVersion >= 3) over 3x3 regions around the start, per seed:
// which specials placed one, where, and the population they hold.
//   tsx tools/dev/probe_spawns.ts [seed ...]
import { Overmap, REGION } from '../../src/world/overmap/overmap';
import { loadNodeData } from '../lib/node_data';

if (process.argv.includes('--help')) {
  console.log('usage: tsx tools/dev/probe_spawns.ts [seed ...]   (default seeds 1 2 3 42 743667900)');
  process.exit(0);
}
const { wg } = loadNodeData();
const seeds = process.argv.slice(2).map(Number);
for (const seed of seeds.length ? seeds : [1, 2, 3, 42, 743667900]) {
  const om = new Overmap(seed, wg.overmap);
  const rows: string[] = [];
  let total = 0;
  for (let ry = -1; ry <= 1; ry++)
    for (let rx = -1; rx <= 1; rx++) {
      // any omtAt generates the region; specials are found through it
      om.omtAt(rx * REGION, ry * REGION, 0);
    }
  const seen = new Set<number>();
  for (let ry = -1; ry <= 1; ry++)
    for (let rx = -1; rx <= 1; rx++)
      for (let y = 0; y < REGION; y++)
        for (let x = 0; x < REGION; x++) {
          for (const z of [0]) {
            const s = om.omtAt(rx * REGION + x, ry * REGION + y, z).special;
            if (!s || seen.has(s.uid)) continue;
            seen.add(s.uid);
            const gs = om.monGroupsOf(s.uid);
            if (!gs.length) continue;
            const pop = gs.reduce((a, g) => a + g.population, 0);
            total += pop;
            rows.push(`  ${s.def.padEnd(18)} ${gs[0].group.padEnd(20)} at ${s.x},${s.y}  groups ${String(gs.length).padStart(4)}  population ${pop}`);
          }
        }
  console.log(`seed ${seed}: ${rows.length} specials with spawns, population ${total}`);
  for (const r of rows) console.log(r);
}

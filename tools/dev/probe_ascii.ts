// ASCII render of real tiles around an OMT: '.' passable, '#' blocked, '>' / '<' stairs/slopes.
// Usage: tsx tools/dev/probe_ascii.ts <seed> <omx> <omy> <z> [radiusOmts=1]
import { WorldGenerator } from '../../src/world/worldgen';
import { loadNodeData, makeMap } from '../lib/node_data';
import { hasFlag } from '../../src/world/registry';
import { CHUNK } from '../../src/world/coords';
const [seed, ox, oy, z, rad = 1] = process.argv.slice(2).map(Number);
const { game, wg } = loadNodeData();
const map = makeMap(game, seed);
const gen = new WorldGenerator(seed, wg, game);
gen.stats.quiet = true;
map.generator = gen;
for (let cy = oy - rad; cy <= oy + rad; cy++) {
  const ids: string[] = [];
  for (let cx = ox - rad; cx <= ox + rad; cx++) ids.push(gen.overmap.omtAt(cx, cy, z).id);
  console.log(ids.map((s) => s.padEnd(CHUNK + 1).slice(0, CHUNK + 1)).join(''));
  for (let ly = 0; ly < CHUNK; ly++) {
    let row = '';
    for (let cx = ox - rad; cx <= ox + rad; cx++) {
      map.chunk(cx, cy, z);
      for (let lx = 0; lx < CHUNK; lx++) {
        const X = cx * CHUNK + lx, Y = cy * CHUNK + ly;
        const t = map.terAt(X, Y, z);
        row += hasFlag(t, 'GOES_DOWN') ? '>' : hasFlag(t, 'GOES_UP') ? '<' : map.passable(X, Y, z) ? '.' : '#';
      }
      row += '|';
    }
    console.log(row);
  }
}

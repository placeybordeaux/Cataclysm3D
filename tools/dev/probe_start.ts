// What surrounds the evac shelter start: nearest cities and the OMT types in a 9x9 window.
//   tsx tools/dev/probe_start.ts <seed> [seed…]
import { loadNodeData, makeMap } from '../lib/node_data';
import { WorldGenerator } from '../../src/world/worldgen';

const { game, wg } = loadNodeData();
for (const seed of process.argv.slice(2).map(Number)) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
  const st = gen.findStartLocation('shelter', map);
  const cities = gen.overmap.citiesNear(st.omx, st.omy).map((c) => `${c.name} size ${c.size} at ${Math.hypot(c.x - st.omx, c.y - st.omy).toFixed(1)} OMT`);
  console.log(`seed ${seed}: start omt ${st.omx},${st.omy}; cities: ${cities.join('; ')}`);
  const rows: string[] = [];
  for (let dy = -4; dy <= 4; dy++) {
    let r = '';
    for (let dx = -4; dx <= 4; dx++) r += (gen.overmap.omtAt(st.omx + dx, st.omy + dy, 0).type.replace(/_(north|south|east|west)$/, '') + '            ').slice(0, 12) + ' ';
    rows.push(r);
  }
  console.log(rows.join('\n'));
}

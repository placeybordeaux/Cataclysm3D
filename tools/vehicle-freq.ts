// Which vehicles does mapgen actually put in front of the player? Generates the world around
// the start shelter for a few seeds (headless, like tools/furniture-freq.ts), resolves each
// vehicle request (groups are rolled like the game does, several times each) and ranks the
// prototypes with the body style the modelled look gives them, so styling work goes to what
// players see most. Also splits by where they stand (road / parking / other OMTs).
//
// Usage: npx tsx tools/vehicle-freq.ts [--seeds 1,2,3,4] [--radius 8] [--rolls 20] [--top 50]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Rng } from '../src/core/rng';
import { spawnVehicle } from '../src/game/vehicle';
import { pickVehicleProto, type VehicleDataFile } from '../src/game/vehicle_data';
import { classify } from '../src/render/vehicleLayout';
import { warnOnce } from '../src/data/warn';
import { WorldGenerator } from '../src/world/worldgen';
import { loadNodeData, makeMap } from './lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const get = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const seeds = (get('--seeds') ?? '1,2,3,4').split(',').map(Number);
const R = Number(get('--radius') ?? 8);
const rolls = Number(get('--rolls') ?? 20);
const top = Number(get('--top') ?? 50);
void warnOnce;

const { game, wg } = loadNodeData();
const vdata: VehicleDataFile = JSON.parse(readFileSync(resolve('public/data/vehicles.json'), 'utf8'));
const counts = new Map<string, { n: number; where: Record<string, number> }>();
let requests = 0;
for (const seed of seeds) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
  const start = gen.findStartLocation('shelter', map);
  const rng = new Rng(seed * 7919);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const cx = start.omx + dx, cy = start.omy + dy;
      const c = map.chunk(cx, cy, 0);
      if (!c) continue;
      const omt = gen.overmap.omtAt(cx, cy, 0).id;
      const where = /^road|bridge/.test(omt) ? 'road' : /parking|lot|garage|gas|dealership|car/.test(omt) ? 'parking' : 'other';
      for (const r of c.vehicles) {
        requests++;
        for (let k = 0; k < rolls; k++) {
          const proto = pickVehicleProto(vdata, r.id, rng);
          if (!proto) continue;
          const e = counts.get(proto) ?? { n: 0, where: {} };
          e.n += 1 / rolls;
          e.where[where] = (e.where[where] ?? 0) + 1 / rolls;
          counts.set(proto, e);
        }
      }
    }
}
const rows = [...counts].sort((a, b) => b[1].n - a[1].n);
const total = rows.reduce((s, r) => s + r[1].n, 0);
console.log(`${requests} vehicle spawns, ${seeds.length} seeds, radius ${R} OMTs`);
let acc = 0;
for (const [id, e] of rows.slice(0, top)) {
  acc += e.n;
  const v = spawnVehicle(vdata, game, id, { x: 0.5, y: 0.5, z: 0, facing: 0, rng: new Rng(1) });
  const w = Object.entries(e.where).map(([k, n]) => `${k} ${n.toFixed(1)}`).join(', ');
  console.log(`${e.n.toFixed(1).padStart(7)} ${((acc / total) * 100).toFixed(1).padStart(5)}%  ${id.padEnd(28)} ${classify(v).padEnd(10)} ${w}`);
}

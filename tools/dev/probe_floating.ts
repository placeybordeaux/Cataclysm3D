// Probe: generate the city around a world's start, every level up to each column's top (as the
// chunk manager does since levels.ts), and count monsters standing where they can't (no floor).
// Usage: npx tsx tools/dev/probe_floating.ts [--seed N] [--radius R]
import { Game } from '../../src/game/game';
import { WorldGenerator } from '../../src/world/worldgen';
import { MonsterSystem } from '../../src/game/monai';
import { Spawner } from '../../src/game/spawner';
import { VisibleLevels } from '../../src/world/levels';
import { loadNodeData } from '../lib/node_data';
import type { Input } from '../../src/core/input';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('npx tsx tools/dev/probe_floating.ts [--seed N] [--radius R]');
  process.exit(0);
}
const get = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const seed = Number(get('--seed', '443226190'));
const R = Number(get('--radius', '5'));
const { game: data, wg } = loadNodeData();
const game = new Game(data, seed, { held: new Set(), captured: false, mouseButtons: 0, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input);
const gen = new WorldGenerator(seed, wg, data);
gen.stats.quiet = true;
game.map.generator = gen;
const start = gen.findStartLocation('shelter', game.map);
game.player.x = start.x + 0.5;
game.player.y = start.y + 0.5;
const sys = new MonsterSystem(game);
// src/monsters.ts overmapView (not imported: it pulls in the UI's CSS)
const spawner = new Spawner(sys, {
  omtType: (x, y, z) => gen.overmap.omtAt(x, y, z).type,
  mondensity: (x, y) => gen.wg.overmap.terrains[gen.overmap.omtAt(x, y, 0).type]?.mondensity ?? 0,
  citiesNear: (x, y) => gen.overmap.citiesNear(x, y),
});
let cur = '';
const origin = new Map<unknown, string>();
const req = (spawner as any).request.bind(spawner);
(spawner as any).request = (c: any, r: any, rng: any) => {
  cur = `${c.omt?.id ?? '?'} ${r.kind}:${r.id}${r.area ? ' area' : ''}${r.density !== undefined ? ' d' : ''}${r.count !== undefined ? ' n' : ''}`;
  req(c, r, rng);
  cur = '';
};
const sp = sys.spawn.bind(sys);
sys.spawn = (def, x, y, z, o) => {
  const m = sp(def, x, y, z, o);
  origin.set(m, cur || 'horde');
  return m;
};
spawner.install();
const lv = new VisibleLevels(gen.overmap);
// --city: centre on the nearest city instead of the start shelter (where the tall buildings are)
let ox = start.omx, oy = start.omy;
if (argv.includes('--city')) {
  const cities = gen.overmap.citiesNear(start.omx, start.omy).sort((a, b) => Math.hypot(a.x - ox, a.y - oy) - Math.hypot(b.x - ox, b.y - oy));
  if (!cities.length) throw new Error('no city near the start');
  ({ x: ox, y: oy } = cities[0]);
  console.log('city', cities[0]);
  game.player.x = ox * 24 + 12;
  game.player.y = oy * 24 + 12;
}
for (let dy = -R; dy <= R; dy++)
  for (let dx = -R; dx <= R; dx++) {
    const cx = ox + dx, cy = oy + dy;
    const top = lv.columnTop(cx, cy);
    for (let z = -2; z <= top; z++) game.map.chunk(cx, cy, z);
  }
const byZ: Record<number, number> = {};
const bad: Record<string, number> = {};
let nBad = 0;
for (const m of sys.all) {
  byZ[m.z] = (byZ[m.z] ?? 0) + 1;
  if (m.has('FLIES')) continue;
  if (!game.map.hasFloor(m.tileX, m.tileY, m.z)) {
    nBad++;
    const k = `z${m.z} ${origin.get(m)}`;
    bad[k] = (bad[k] ?? 0) + 1;
  }
}
let corpseBad = 0;
for (const c of sys.corpses) if (!game.map.hasFloor(Math.floor(c.x), Math.floor(c.y), c.z)) corpseBad++;
console.log({ seed, monsters: sys.all.length, byZ, unsupported: nBad, unsupportedCorpses: corpseBad, corpses: sys.corpses.length });
console.log(Object.entries(bad).sort((a, b) => b[1] - a[1]).slice(0, 40));
if (argv.includes('--origins')) {
  const o: Record<string, number> = {};
  for (const m of sys.all) {
    if (m.z === 0) continue;
    const k = `z${m.z} ${origin.get(m)}`;
    o[k] = (o[k] ?? 0) + 1;
  }
  console.log(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 40));
}

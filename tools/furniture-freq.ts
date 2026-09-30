// Which furniture / fixtures / items are on screen most often? Generates the world around
// the start shelter for a few seeds (headless, like tools/worldgen.ts) and counts tile ids,
// so the modelled-furniture work (src/render/furniture/) goes to what players actually see.
//
// Usage: npx tsx tools/furniture-freq.ts [--seeds 1,2,3] [--radius 5] [--top 80]
//                                        [--kind furn|ter|item] [--json out.json]
//                                        [--unmapped]
//   --radius R   OMTs around each start (default 5 = 11x11 OMTs, z 0 and buildings' 1/-1)
//   --kind       what to rank (default furn); ter = only shaped terrain (doors, windows,
//                fences, shrubs), item = item categories + ids
//   --unmapped   furniture only: also report which archetype each id maps to and flag the
//                ones that would fall back to the voxel path
//   --json       write the full counts
import { readFileSync, writeFileSync } from 'node:fs';
import { WorldGenerator } from '../src/world/worldgen';
import { loadNodeData, makeMap } from './lib/node_data';
import { terrainShape } from '../src/render/tileKinds';
import { archetypeFor } from '../src/render/furniture/catalog';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const get = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const seeds = (get('--seeds') ?? '1,2,3').split(',').map(Number);
const R = Number(get('--radius') ?? 5);
const top = Number(get('--top') ?? 80);
const kind = get('--kind') ?? 'furn';
if (!['furn', 'ter', 'item'].includes(kind)) throw new Error(`--kind must be furn|ter|item, got ${kind}`);

const { game, wg } = loadNodeData();
const counts = new Map<string, number>();
const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
let chunks = 0;
for (const seed of seeds) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
  const start = gen.findStartLocation('shelter', map);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++)
      for (const z of [0, 1, -1]) {
        const cx = start.omx + dx, cy = start.omy + dy;
        if (z !== 0 && !gen.overmap.omtAt(cx, cy, z).special) continue;
        const c = map.chunk(cx, cy, z);
        if (!c) continue;
        chunks++;
        for (let i = 0; i < c.ter.length; i++) {
          if (kind === 'furn' && c.furn[i]) bump(map.furniture.get(c.furn[i]).id);
          if (kind === 'ter') {
            const t = map.terrain.get(c.ter[i]);
            const s = terrainShape(t);
            if (s !== 'floor' && s !== 'wall' && s !== 'none' && s !== 'tree') bump(`${s}\t${t.id}`);
          }
        }
        if (kind === 'item')
          for (const list of c.items.values()) for (const it of list) {
            const d = game.items[it.typeId];
            bump(`${(d?.category as string | undefined) ?? d?.type ?? '?'}\t${it.typeId}`);
          }
      }
}
const rows = [...counts].sort((a, b) => b[1] - a[1]);
const total = rows.reduce((s, r) => s + r[1], 0);
console.log(`${chunks} chunks, ${seeds.length} seeds, ${total} ${kind} tiles, ${rows.length} ids`);
let acc = 0;
const showMap = argv.includes('--unmapped') && kind === 'furn';
for (const [id, n] of rows.slice(0, top)) {
  acc += n;
  const extra = showMap ? `\t${archetypeFor(id, game.furniture[id])?.kind ?? '-- voxel --'}` : '';
  console.log(`${String(n).padStart(6)} ${((acc / total) * 100).toFixed(1).padStart(5)}%  ${id}${extra}`);
}
if (showMap) {
  let mapped = 0;
  for (const [id, n] of rows) if (archetypeFor(id, game.furniture[id])) mapped += n;
  console.log(`mapped to a model: ${((mapped / total) * 100).toFixed(1)}% of furniture tiles`);
  const miss = rows.filter(([id]) => !archetypeFor(id, game.furniture[id])).slice(0, 40);
  console.log('top unmapped:', miss.map(([id, n]) => `${id}(${n})`).join(' '));
}
if (kind === 'item') {
  const cats = new Map<string, number>();
  for (const [k, n] of rows) cats.set(k.split('\t')[0], (cats.get(k.split('\t')[0]) ?? 0) + n);
  console.log('categories:', [...cats].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', '));
}
const out = get('--json');
if (out) writeFileSync(out, JSON.stringify(Object.fromEntries(rows), null, 1));

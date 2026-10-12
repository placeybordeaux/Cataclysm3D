// How do weapons and tools lying on the ground look? For every item in the weapon/tool
// categories, and for the items actually generated around the start (like
// tools/furniture-freq.ts), report:
//   art      the tileset draws it (itself or via looks_like); else billboard looks show its glyph
//   model    its held mesh class (src/render/chars/held.ts) — 'generic' = no weapon model
//   ground   what the modelled looks bake on the floor (render/furniture/groundHeld.ts):
//            the held mesh, or one of the generic shapes (render/furniture/items.ts)
//
// Usage: npx tsx tools/ground-item-coverage.ts [--seeds 1,2,3] [--radius 5] [--top 30]
//   --top N    list the N most common world items in these categories that still get a
//              generic shape (the next ones worth modelling)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorldGenerator } from '../src/world/worldgen';
import { loadNodeData, makeMap } from './lib/node_data';
import { AtlasLookup } from '../src/render/atlasIndex';
import type { AtlasIndex } from '../src/render/atlasTypes';
import { itemShape } from '../src/render/furniture/items';
import { groundHeldClass } from '../src/render/furniture/groundHeld';
import type { ItemDef } from '../src/data/types';

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
const top = Number(get('--top') ?? 30);

const { game, wg } = loadNodeData();
const atlas = new AtlasLookup(JSON.parse(readFileSync(resolve('public/atlas/atlas.json'), 'utf8')) as AtlasIndex);
const looksLike = (id: string) => (game.items[id]?.looks_like as string | undefined) ?? game.furniture[id]?.looks_like ?? game.terrain[id]?.looks_like;
const hasArt = (id: string) => !!atlas.lookupWithLooksLike(id, looksLike)?.fg;

/** Report groups: BN categories, melee weapons split off the guns. */
const GROUPS: [string, (d: ItemDef) => boolean][] = [
  ['guns', (d) => d.category === 'guns'],
  ['melee (weapons)', (d) => d.category === 'weapons'],
  ['tools*', (d) => /^tools/.test(d.category ?? '')],
];

const world = new Map<string, number>();
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
        for (const list of c.items.values()) for (const it of list) world.set(it.typeId, (world.get(it.typeId) ?? 0) + 1);
      }
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : '-');
console.log(`world sample: ${seeds.length} seeds, radius ${R} OMTs, ${[...world.values()].reduce((s, n) => s + n, 0)} items\n`);
console.log('group              | ids  noArt  modelled  glyph-only after | world items  noArt  modelled  glyph-only after');
for (const [name, f] of GROUPS) {
  const ids = Object.values(game.items).filter(f);
  let noArt = 0, mod = 0, glyph = 0, wN = 0, wNoArt = 0, wMod = 0, wGlyph = 0;
  for (const d of ids) {
    const art = hasArt(d.id), m = groundHeldClass(d) !== null;
    if (!art) noArt++;
    if (m) mod++;
    if (!art && !m) glyph++;
    const n = world.get(d.id) ?? 0;
    wN += n;
    if (!art) wNoArt += n;
    if (m) wMod += n;
    if (!art && !m) wGlyph += n;
  }
  console.log(`${name.padEnd(18)} | ${String(ids.length).padStart(4)} ${pct(noArt, ids.length).padStart(6)} ${pct(mod, ids.length).padStart(9)} ${pct(glyph, ids.length).padStart(16)} | ${String(wN).padStart(11)} ${pct(wNoArt, wN).padStart(6)} ${pct(wMod, wN).padStart(9)} ${pct(wGlyph, wN).padStart(16)}`);
}
console.log('\nnoArt = no tileset sprite (billboard looks drew the glyph); modelled = gets the held mesh on the ground');
console.log('glyph-only after = still a glyph billboard in the billboard looks (no art, no model)\n');

const rows = [...world].filter(([id]) => game.items[id] && GROUPS.some(([, f]) => f(game.items[id])))
  .filter(([id]) => groundHeldClass(game.items[id]) === null)
  .sort((a, b) => b[1] - a[1]).slice(0, top);
console.log(`top ${rows.length} world weapons/tools still drawn as a generic shape:`);
for (const [id, n] of rows) console.log(`${String(n).padStart(6)}  ${id.padEnd(28)} ${(game.items[id].category ?? '').padEnd(16)} shape=${itemShape(game.items[id])}${hasArt(id) ? '' : '  (no art: glyph)'}`);

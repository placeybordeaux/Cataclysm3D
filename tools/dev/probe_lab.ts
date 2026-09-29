import { WorldGenerator } from '../../src/world/worldgen';
import { loadNodeData, makeMap } from '../lib/node_data';
import { hasFlag } from '../../src/world/registry';
import { CHUNK } from '../../src/world/coords';
const { game, wg } = loadNodeData();
const seed = Number(process.argv[2] ?? 1);
const special = process.argv[3] ?? 'lab_mutagen_6_level';
const map = makeMap(game, seed);
const gen = new WorldGenerator(seed, wg, game);
gen.stats.quiet = true;
map.generator = gen;
const start = gen.findStartLocation('shelter', map);
console.log('start', start.omx, start.omy);
const sp = gen.overmap.findSpecial(special, { x: start.omx, y: start.omy }, 3);
console.log('special', sp && { x: sp.x, y: sp.y, rot: sp.rot, d: Math.hypot(sp.x - start.omx, sp.y - start.omy) });
if (!sp) process.exit(1);
const cells: [number, number, number][] = [];
for (let z = 1; z >= -7; z--)
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const o = gen.overmap.omtAt(sp.x + dx, sp.y + dy, z);
      if (o.special?.uid === sp.uid) cells.push([sp.x + dx, sp.y + dy, z]);
    }
const byZ = new Map<number, string[]>();
let items = 0, spawns = 0;
const itemIds = new Map<string, number>();
const monIds = new Map<string, number>();
for (const [x, y, z] of cells) {
  const c = map.chunk(x, y, z)!;
  const o = gen.overmap.omtAt(x, y, z);
  (byZ.get(z) ?? byZ.set(z, []).get(z)!).push(`${x - sp.x},${y - sp.y} ${o.id} [${c.omt?.source}]`);
  const flat = (it: any): any[] => [it, ...((it.contents ?? []) as any[]).flatMap(flat)];
  for (const l of c.items.values()) for (const top of l as any[]) for (const it of flat(top)) { const id = it.typeId ?? it.id; items++; itemIds.set(id, (itemIds.get(id) ?? 0) + 1); }
  for (const s of c.spawns) { spawns++; monIds.set(s.id, (monIds.get(s.id) ?? 0) + 1); }
}
for (const [z, l] of byZ) console.log('z', z, '\n  ' + l.join('\n  '));
// stairs check
for (const [x, y, z] of cells) {
  for (let ly = 0; ly < CHUNK; ly++)
    for (let lx = 0; lx < CHUNK; lx++) {
      const X = x * CHUNK + lx, Y = y * CHUNK + ly;
      const t = map.terAt(X, Y, z);
      if (hasFlag(t, 'GOES_DOWN')) {
        const b = map.terAt(X, Y, z - 1);
        console.log(`down z${z} ${X - sp.x * CHUNK},${Y - sp.y * CHUNK} ${t.id} -> below ${b.id} ${hasFlag(b, 'GOES_UP') ? 'OK' : 'MISMATCH'}`);
      }
      if (t.id.includes('elevator')) console.log(`elev z${z} ${X - sp.x * CHUNK},${Y - sp.y * CHUNK} ${t.id}`);
    }
}
console.log('items', items, 'spawns', spawns);
console.log([...itemIds].sort((a, b) => b[1] - a[1]).slice(0, 60).map((e) => e.join(':')).join(' '));
console.log([...monIds].sort((a, b) => b[1] - a[1]).map((e) => e.join(':')).join(' '));
console.log(JSON.stringify(gen.stats.summary(), null, 1).slice(0, 4000));
{
  const cats = new Map<string, number>();
  for (const [id, n] of itemIds) {
    const d: any = (game.items as any)[id];
    const tag = d?.flags?.includes('CBM') ? 'CBM' : /mutagen|serum|iv_/.test(id) ? 'MUT' : '';
    if (tag) cats.set(`${tag}:${id}`, n);
  }
  console.log('special loot', [...cats].map((e) => e.join('=')).join(' '));
}
const dz = Number(process.argv[4] ?? NaN);
if (!Number.isNaN(dz)) for (const [x, y, z] of cells) if (z === dz) console.log(`${x - sp.x},${y - sp.y}\n` + gen.dumpChunk(map, x, y, z));

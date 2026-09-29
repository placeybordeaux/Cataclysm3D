// Flood-fill a lab special from outside: which tiles/levels are reachable walking through
// passable tiles, unlocked doors and stairs; which locked doors/card readers block the way.
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
const sp = gen.overmap.findSpecial(special, { x: start.omx, y: start.omy }, 3)!;
const inSp = (x: number, y: number, z: number) => {
  const o = gen.overmap.omtAt(Math.floor(x / CHUNK), Math.floor(y / CHUNK), z);
  return o.special?.uid === sp.uid;
};
for (let z = 1; z >= -7; z--) for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) if (z === 0 || gen.overmap.omtAt(sp.x + dx, sp.y + dy, z).special?.uid === sp.uid) map.chunk(sp.x + dx, sp.y + dy, z);
// start: a tile just outside the special at z0
let s: [number, number, number] | null = null;
for (let r = 5; r < 8 * CHUNK && !s; r++)
  for (let dx = -r; dx <= r && !s; dx++) {
    const x = sp.x * CHUNK + 12 + dx, y = sp.y * CHUNK + 12 + r;
    if (!inSp(x, y, 0) && map.passable(x, y, 0)) s = [x, y, 0];
  }
if (!s) throw new Error('no start');
const seen = new Set<string>();
const q: [number, number, number][] = [s];
const levels = new Map<number, number>();
const blockers = new Map<string, number>();
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
seen.add(key(...s));
while (q.length) {
  const [x, y, z] = q.pop()!;
  levels.set(z, (levels.get(z) ?? 0) + 1);
  const t = map.terAt(x, y, z);
  const nb: [number, number, number][] = [[x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z]];
  if (hasFlag(t, 'GOES_DOWN')) nb.push([x, y, z - 1]);
  if (hasFlag(t, 'GOES_UP')) nb.push([x, y, z + 1]);
  for (const [nx, ny, nz] of nb) {
    const k = key(nx, ny, nz);
    if (seen.has(k)) continue;
    if (!inSp(nx, ny, nz) && nz !== 0) continue;
    if (Math.abs(nx - s[0]) > 10 * CHUNK || Math.abs(ny - s[1]) > 10 * CHUNK) continue;
    let nt = map.terAt(nx, ny, nz);
    // stairs arrival: nearest matching stair like zlevels.stairDestination
    if (nz !== z) {
      const want = nz < z ? 'GOES_UP' : 'GOES_DOWN';
      let best: [number, number] | null = hasFlag(nt, want) ? [nx, ny] : null;
      for (let r = 1; r <= 24 && !best; r++)
        for (let dy = -r; dy <= r && !best; dy++)
          for (let dx = -r; dx <= r && !best; dx++)
            if (Math.max(Math.abs(dx), Math.abs(dy)) === r && hasFlag(map.terAt(nx + dx, ny + dy, nz), want)) best = [nx + dx, ny + dy];
      if (!best) continue;
      const k2 = key(best[0], best[1], nz);
      if (seen.has(k2)) continue;
      seen.add(k2);
      q.push([best[0], best[1], nz]);
      continue;
    }
    const f = map.furnAt(nx, ny, nz);
    const pass = map.passable(nx, ny, nz) || (process.argv[4] === 'keys' && (/door|gate/.test(nt.id) || hasFlag(nt, 'CLIMBABLE'))) || (nt.open && !hasFlag(nt, 'LOCKED') && !/locked/.test(nt.id)) || (f.open && map.terrain.has(nt.id));
    if (!pass) {
      if (inSp(nx, ny, nz)) blockers.set(`${nt.id}@z${nz}`, (blockers.get(`${nt.id}@z${nz}`) ?? 0) + 1);
      continue;
    }
    seen.add(k);
    q.push([nx, ny, nz]);
  }
}
console.log('special', sp.x, sp.y, 'start tile', s);
console.log('reachable tiles per z', JSON.stringify([...levels].sort((a, b) => b[0] - a[0])));
console.log('blockers', JSON.stringify([...blockers].sort((a, b) => b[1] - a[1])));

const per = new Map<string, number>();
for (const k of seen) {
  const [x, y, z] = k.split(',').map(Number);
  if (!inSp(x, y, z)) continue;
  const kk = `${Math.floor(x / CHUNK) - sp.x},${Math.floor(y / CHUNK) - sp.y},${z}`;
  per.set(kk, (per.get(kk) ?? 0) + 1);
}
console.log('in-special reach', JSON.stringify([...per]));

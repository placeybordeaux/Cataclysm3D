// Render + reachability check for BN mutable specials (genVersion 2): generates every chunk the
// specials own over a block of regions, tallies how each oter was drawn (json / builtin:* /
// uniform / fallback) and flood-fills each special from a walkable tile outside it (stairs and
// slopes followed like zlevels.stairDestination; doors and gates count as openable) to see
// which of its OMTs a player can walk into.
// Usage: tsx tools/dev/probe_mutable_render.ts [--radius N] [--only <special>] <seed>...
// Memory-hungry (generates hundreds of chunks): run it through ~/claude-stuff/bin/heavy.
import { WorldGenerator } from '../../src/world/worldgen';
import { REGION, type SpecialInstance } from '../../src/world/overmap/overmap';
import { loadNodeData, makeMap } from '../lib/node_data';
import { hasFlag } from '../../src/world/registry';
import { CHUNK } from '../../src/world/coords';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || !argv.length) {
  console.log('probe_mutable_render [--radius N (default 1)] [--only <special id>] [--verbose] <seed>...');
  process.exit(0);
}
const opt = (n: string) => {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const radius = Number(opt('--radius') ?? 1);
const only = opt('--only');
const verbose = argv.includes('--verbose') ? (argv.splice(argv.indexOf('--verbose'), 1), true) : false;
const { game, wg } = loadNodeData();
const MINES = new Set(['Mine Entrance', 'Spiral mine', 'Amigara mine', 'Wyrms mine']);
const sources = new Map<string, Map<string, number>>();
const summary = new Map<string, { n: number; omts: number; reached: number; levels: number; levelsReached: number }>();

for (const seed of argv.map(Number)) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
  const om = gen.overmap;
  for (let ry = -radius; ry <= radius; ry++) for (let rx = -radius; rx <= radius; rx++) om.omtAt(rx * REGION, ry * REGION, 0);
  // groups: each mutable special (except nested mine_tunnels) and each mine with its tunnel
  const insts: SpecialInstance[] = [];
  const all = new Map<number, SpecialInstance>();
  for (let ry = -radius; ry <= radius; ry++)
    for (let rx = -radius; rx <= radius; rx++)
      for (let y = 0; y < REGION; y++)
        for (let x = 0; x < REGION; x++) {
          for (const z of [0, -1, -2]) {
            const s = om.omtAt(rx * REGION + x, ry * REGION + y, z).special;
            if (s && !all.has(s.uid)) all.set(s.uid, s);
          }
        }
  for (const s of all.values()) if ((om.mutableReports.some((r) => r.uid === s.uid) && s.def !== 'mine_tunnel') || MINES.has(s.def)) insts.push(s);
  for (const sp of insts) {
    if (only && sp.def !== only) continue;
    const uids = new Set([sp.uid]);
    if (MINES.has(sp.def)) for (const s of all.values()) if (s.def === 'mine_tunnel' && s.x === sp.x && s.y === sp.y) uids.add(s.uid);
    const owned = (x: number, y: number, z: number) => uids.has(om.omtAt(x, y, z).special?.uid ?? 0);
    const omts: [number, number, number][] = [];
    for (let z = 1; z >= -10; z--)
      for (let dy = -20; dy <= 20; dy++)
        for (let dx = -20; dx <= 20; dx++) if (owned(sp.x + dx, sp.y + dy, z)) omts.push([sp.x + dx, sp.y + dy, z]);
    for (const [x, y, z] of omts) {
      const c = map.chunk(x, y, z);
      const id = om.omtAt(x, y, z).id;
      if (!c) throw new Error(`${sp.def} owns ${id} at z${z}, outside the map's z range`);
      const m = sources.get(id) ?? new Map<string, number>();
      const src = c.omt?.source ?? '?';
      m.set(src, (m.get(src) ?? 0) + 1);
      sources.set(id, m);
    }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) map.chunk(sp.x + dx, sp.y + dy, 0);
    // flood fill from outside
    const inSp = (x: number, y: number, z: number) => owned(Math.floor(x / CHUNK), Math.floor(y / CHUNK), z);
    let s: [number, number, number] | null = null;
    for (let r = 2; r < 2 * CHUNK && !s; r++)
      for (let d = -r; d <= r && !s; d++)
        for (const [x, y] of [[sp.x * CHUNK + 12 + d, sp.y * CHUNK + 12 + r], [sp.x * CHUNK + 12 + d, sp.y * CHUNK + 12 - r], [sp.x * CHUNK + 12 + r, sp.y * CHUNK + 12 + d], [sp.x * CHUNK + 12 - r, sp.y * CHUNK + 12 + d]])
          if (!s && !inSp(x, y, 0) && map.passable(x, y, 0)) s = [x, y, 0];
    if (!s) {
      console.log(`seed ${seed} ${sp.def}@${sp.x},${sp.y}: no walkable start outside`);
      continue;
    }
    const levelsOf = [...new Set(omts.map(([, , z]) => z))];
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const seen = new Set<string>([key(...s)]);
    const q: [number, number, number][] = [s];
    const reachedOmt = new Set<string>();
    while (q.length) {
      const [x, y, z] = q.pop()!;
      if (inSp(x, y, z)) reachedOmt.add(key(Math.floor(x / CHUNK), Math.floor(y / CHUNK), z));
      const t = map.terAt(x, y, z);
      const nb: [number, number, number][] = [[x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z]];
      if (hasFlag(t, 'GOES_DOWN')) nb.push([x, y, z - 1]);
      if (hasFlag(t, 'GOES_UP')) nb.push([x, y, z + 1]);
      // elevator cabs (the mines' shaft): assume powered, riding to the same spot on any level
      const elevator = /^t_elevator/.test(t.id);
      if (elevator) for (const ez of levelsOf) if (ez !== z && /^t_elevator/.test(map.terAt(x, y, ez).id)) nb.push([x, y, ez]);
      for (const [nx, ny, nz] of nb) {
        if (seen.has(key(nx, ny, nz))) continue;
        if (nz !== 0 && !inSp(nx, ny, nz)) continue;
        if (Math.abs(nx - s[0]) > 16 * CHUNK || Math.abs(ny - s[1]) > 16 * CHUNK) continue;
        if (nz !== z && elevator && /^t_elevator/.test(map.terAt(nx, ny, nz).id)) {
          seen.add(key(nx, ny, nz));
          q.push([nx, ny, nz]);
          continue;
        }
        if (nz !== z) {
          const want = nz < z ? 'GOES_UP' : 'GOES_DOWN';
          let best: [number, number] | null = hasFlag(map.terAt(nx, ny, nz), want) ? [nx, ny] : null;
          for (let r = 1; r <= 24 && !best; r++)
            for (let dy = -r; dy <= r && !best; dy++)
              for (let dx = -r; dx <= r && !best; dx++)
                if (Math.max(Math.abs(dx), Math.abs(dy)) === r && hasFlag(map.terAt(nx + dx, ny + dy, nz), want)) best = [nx + dx, ny + dy];
          if (!best && map.passable(nx, ny, nz) && map.hasFloor(nx, ny, nz)) best = [nx, ny];
          if (!best || seen.has(key(best[0], best[1], nz))) continue;
          seen.add(key(best[0], best[1], nz));
          q.push([best[0], best[1], nz]);
          continue;
        }
        const nt = map.terAt(nx, ny, nz);
        const f = map.furnAt(nx, ny, nz);
        const pass = map.passable(nx, ny, nz) || /door|gate/.test(nt.id) || (nt.open && !hasFlag(nt, 'LOCKED')) || (f.open && map.terrain.has(nt.id));
        if (!pass) continue;
        seen.add(key(nx, ny, nz));
        q.push([nx, ny, nz]);
      }
    }
    if (verbose) {
      const miss = new Map<string, number>();
      for (const [x, y, z] of omts) if (!reachedOmt.has(key(x, y, z))) miss.set(om.omtAt(x, y, z).id, (miss.get(om.omtAt(x, y, z).id) ?? 0) + 1);
      console.log(`  unreached: ${[...miss].map(([k, v]) => `${k} x${v}`).join(', ')}`);
    }
    const levels = new Set(omts.map(([, , z]) => z));
    const levelsReached = new Set([...reachedOmt].map((k) => Number(k.split(',')[2])));
    console.log(`seed ${seed} ${sp.def.padEnd(16)} @${sp.x},${sp.y} rot ${sp.rot}: ${reachedOmt.size}/${omts.length} OMTs walkable from outside; levels ${[...levels].sort((a, b) => b - a).join(',')} reached ${[...levelsReached].sort((a, b) => b - a).join(',')}`);
    const e = summary.get(sp.def) ?? { n: 0, omts: 0, reached: 0, levels: 0, levelsReached: 0 };
    e.n++, (e.omts += omts.length), (e.reached += reachedOmt.size), (e.levels += levels.size), (e.levelsReached += levelsReached.size);
    summary.set(sp.def, e);
  }
}
console.log('\nhow each oter was drawn:');
for (const [id, m] of [...sources].sort()) console.log(`  ${id.padEnd(36)} ${[...m].map(([k, v]) => `${k} x${v}`).join(', ')}`);
console.log('\nsummary:');
for (const [d, e] of summary) console.log(`  ${d.padEnd(16)} ${e.n} placed; ${e.reached}/${e.omts} OMTs walkable; ${e.levelsReached}/${e.levels} levels reached`);

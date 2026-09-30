// Survey of BN staircase layouts: for every GOES_UP tile in buildings around the start, which
// neighbours are free on the lower and upper level, what is above it, and how long a straight
// run of free floor there is in each direction. Feeds the stair-flight design (docs/STAIRS.md).
// Usage: tsx tools/dev/probe_stairs.ts [seeds=1,2,3] [radius=12] [examples=6]
import { WorldGenerator } from '../../src/world/worldgen';
import { loadNodeData, makeMap } from '../lib/node_data';
import { hasFlag } from '../../src/world/registry';
import { CHUNK } from '../../src/world/coords';
import { StairIndex, type StairVariant } from '../../src/game/stairs';

if (process.argv.includes('--help')) {
  console.log('tsx tools/dev/probe_stairs.ts [seeds=1,2,3] [radius=12] [examples=6]');
  process.exit(0);
}
const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
const R = Number(process.argv[3] ?? 12);
const EX = Number(process.argv[4] ?? 6);
const { game, wg } = loadNodeData();
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const stats = new Map<string, number>();
const bump = (k: string) => stats.set(k, (stats.get(k) ?? 0) + 1);
let shown = 0;
for (const seed of seeds) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
  const start = gen.findStartLocation('shelter', map);
  const idx: Record<string, StairIndex> = { flight: new StairIndex(map, 'flight'), compact: new StairIndex(map, 'compact') };
  for (let oy = start.omy - R; oy <= start.omy + R; oy++)
    for (let ox = start.omx - R; ox <= start.omx + R; ox++) {
      const o = gen.overmap.omtAt(ox, oy, 0);
      if (/^(field|forest|road|river|lake|open_air|empty_rock|solid_earth)/.test(o.id)) continue;
      for (const z of [-1, 0, 1]) {
        const c = map.chunk(ox, oy, z);
        if (!c) continue;
        for (let ly = 0; ly < CHUNK; ly++)
          for (let lx = 0; lx < CHUNK; lx++) {
            const x = ox * CHUNK + lx, y = oy * CHUNK + ly;
            const t = map.terAt(x, y, z);
            if (!hasFlag(t, 'GOES_UP')) continue;
            const up = map.terAt(x, y, z + 1);
            bump(`pair ${t.id} -> ${up.id}`);
            for (const v of ['flight', 'compact'] as StairVariant[]) {
              idx[v].ensureAround(x, y, z, 0);
              const l = idx[v].at(x, y, z);
              if (!l && idx[v].isPlain(x, y, z)) { bump(`${v}: plain tile of a wide spiral`); continue; }
              if (l && process.argv.includes('--where') && v === 'flight' && l.tiles[0][0] === x && l.tiles[0][1] === y) console.log(`WHERE ${o.id} ${x},${y},${z} ${l.shape} run ${l.run} w ${l.width}${l.spiral ? ` sweep ${Math.round(l.spiral.sweep * 57.3)}` : ''}`);
              bump(`${v}: ${l ? `${l.shape}${l.shape === 'straight' ? ` run ${l.run} w ${l.width}` : l.spiral ? ` ${Math.round(Math.abs(l.spiral.sweep) * 180 / Math.PI)}°` : ''}` : 'none (classic)'}`);
            }
            const free = (X: number, Y: number, Z: number) => map.passable(X, Y, Z) && map.furnAt(X, Y, Z).id === 'f_null' && !hasFlag(map.terAt(X, Y, Z), 'GOES_UP') && !hasFlag(map.terAt(X, Y, Z), 'GOES_DOWN') && map.hasFloor(X, Y, Z);
            // best straight approach run on the lower level (tiles you walk over before the stair tile)
            let bestLow = 0, bestBoth = 0, exitUp = 0, exitLow = 0;
            for (let d = 0; d < 4; d++) {
              let n = 0;
              while (n < 4 && free(x - DX[d] * (n + 1), y - DY[d] * (n + 1), z)) n++;
              if (n > 0) exitLow++;
              bestLow = Math.max(bestLow, n);
              // the upper exit beyond the stair tile in that direction is free floor
              const ex = free(x + DX[d], y + DY[d], z + 1);
              if (ex) exitUp++;
              if (ex) bestBoth = Math.max(bestBoth, n);
            }
            bump(`lowRun ${bestLow}`);
            bump(`lowRun+upExit(straight) ${bestBoth}`);
            bump(`upExits ${exitUp}`);
            bump(`lowExits ${exitLow}`);
            let twin = 0;
            for (let d = 0; d < 4; d++) if (hasFlag(map.terAt(x + DX[d], y + DY[d], z), 'GOES_UP')) twin++;
            bump(`upNeighbours ${twin}`);
            const noneHere = !idx.flight.at(x, y, z) && !idx.flight.isPlain(x, y, z);
            if ((shown < EX && (seed * 7 + x * 13 + y) % 3 === 0) || (process.argv.includes('--none') && noneHere)) {
              shown++;
              const rows: string[] = [];
              for (let dy = -3; dy <= 3; dy++) {
                let a = '', b = '';
                for (let dx = -3; dx <= 3; dx++) {
                  const sym = (Z: number) => {
                    const f = map.furnAt(x + dx, y + dy, Z), tt = map.terAt(x + dx, y + dy, Z);
                    return (f.id !== 'f_null' ? f.symbol : tt.symbol)?.slice(0, 1) || ' ';
                  };
                  a += sym(z); b += sym(z + 1);
                }
                rows.push(`${a}   ${b}`);
              }
              console.log(`seed ${seed} ${o.id} z${z} (${x},${y}) ${t.id} / above ${up.id}\n${rows.join('\n')}\n`);
            }
          }
      }
    }
}
for (const [k, v] of [...stats].sort()) console.log(k.padEnd(60), v);

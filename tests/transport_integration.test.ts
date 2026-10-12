// The overmap's sewer/subway networks (genVersion 2, overmap.ts + connections.ts) rendered by the
// real mapgen (bnbuiltin.ts sewer/subway ports). Each half has its own tests against fixtures;
// this checks the hand-off: tunnels open into the stations they reach, track runs across the
// shared edge, and every manhole has a climbable sewer under it.
import { describe, expect, it } from 'vitest';
import { WorldGenerator } from '../src/world/worldgen';
import { LINE_E, LINE_N, LINE_S, LINE_W } from '../src/world/overmap/oter';
import { CHUNK } from '../src/world/coords';
import { hasFlag } from '../src/world/registry';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

const { game, wg } = loadNodeData();
const DIRS = [[0, -1, LINE_N, LINE_S], [1, 0, LINE_E, LINE_W], [0, 1, LINE_S, LINE_N], [-1, 0, LINE_W, LINE_E]] as const;
const REGION = 96;

function world(seed: number) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
  return { map, gen, om: gen.overmap };
}

describe('sewer and subway networks, overmap to tiles', () => {
  for (const seed of [1, 42]) {
    it(`seed ${seed}: every station is entered by a tunnel whose track meets the platform`, () => {
      const { map, gen, om } = world(seed);
      const stations: [number, number][] = [];
      // a station walled in by a special placed before it (no rock or tunnel beside it) can't be
      // reached, in BN too (tests/overmap_transport.test.ts)
      const sealed = (x: number, y: number) => DIRS.every(([dx, dy]) => !/^(empty_rock|subway)$/.test(om.omtAt(x + dx, y + dy, -2).type));
      for (let y = 0; y < REGION; y++) for (let x = 0; x < REGION; x++) if (/sub_station/.test(om.omtAt(x, y, -2).type) && !sealed(x, y)) stations.push([x, y]);
      expect(stations.length).toBeGreaterThan(0);
      let checked = 0;
      for (const [x, y] of stations.slice(0, 6)) {
        const mouths = DIRS.filter(([dx, dy, , back]) => {
          const n = om.omtAt(x + dx, y + dy, -2);
          return n.type === 'subway' && (n.line & back) !== 0;
        });
        expect(mouths.length, `station at ${x},${y}`).toBeGreaterThan(0);
        const [dx, dy] = mouths[0];
        map.chunk(x, y, -2);
        map.chunk(x + dx, y + dy, -2);
        // Along the shared edge, a rail tile in the station touches a rail tile on the tunnel side,
        // straight across or diagonally (BN's subway tee enters on its stem with diagonal track
        // ending one tile off the station's track columns; rail joins diagonally too).
        let joined = 0;
        for (let k = 0; k < CHUNK; k++) {
          const sx = dx === 0 ? x * CHUNK + k : dx > 0 ? x * CHUNK + CHUNK - 1 : x * CHUNK;
          const sy = dy === 0 ? y * CHUNK + k : dy > 0 ? y * CHUNK + CHUNK - 1 : y * CHUNK;
          if (!hasFlag(map.terAt(sx, sy, -2), 'RAIL')) continue;
          const along = dx === 0 ? [[-1, 0], [0, 0], [1, 0]] : [[0, -1], [0, 0], [0, 1]];
          if (along.some(([ax, ay]) => hasFlag(map.terAt(sx + dx + ax, sy + dy + ay, -2), 'RAIL'))) joined++;
        }
        expect(joined, `track into station at ${x},${y}`).toBeGreaterThan(0);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
      expect([...gen.stats.unsupported.keys()].filter((k) => /builtin mapgen (sewer|subway)/.test(k))).toEqual([]);
    });

    it(`seed ${seed}: every manhole has a sewer below with a ladder up`, () => {
      const { map, gen, om } = world(seed);
      const holes: [number, number][] = [];
      for (let y = 0; y < REGION; y++) for (let x = 0; x < REGION; x++) if (om.omtAt(x, y, 0).type === 'road_nesw_manhole') holes.push([x, y]);
      expect(holes.length).toBeGreaterThan(0);
      for (const [x, y] of holes.slice(0, 8)) {
        expect(om.omtAt(x, y, -1).type, `under manhole ${x},${y}`).toBe('sewer');
        const c = map.chunk(x, y, -1)!;
        const ids = Array.from(c.ter, (t) => map.terrain.get(t).id);
        expect(ids, `ladder under manhole ${x},${y}`).toContain('t_ladder_up');
      }
      expect([...gen.stats.unsupported.keys()].filter((k) => /builtin mapgen (sewer|subway)/.test(k))).toEqual([]);
    });
  }
});

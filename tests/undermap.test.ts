// Underground transport chunks against real data (BN mapgen_subway / mapgen_sewer ports, the
// mx_sewer_* map extras, manhole ladders, the classic lab's sewer room). The overmap is a
// hand-built fixture so this doesn't depend on where overmap.ts puts sewers and subways.
import { describe, expect, it } from 'vitest';
import { WorldGenerator } from '../src/world/worldgen';
import type { OmtInfo } from '../src/world/overmap/overmap';
import { LINE_E, LINE_N, LINE_S, LINE_W, oterId } from '../src/world/overmap/oter';
import { CHUNK } from '../src/world/coords';
import type { GameMap } from '../src/world/map';
import { hasFlag } from '../src/world/registry';
import { stairDestination } from '../src/game/zlevels';
import type { Game } from '../src/game/game';
import { StairIndex } from '../src/game/stairs';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

const { game, wg } = loadNodeData();
const T = wg.overmap.terrains;

type Fixture = Record<string, { type: string; rot?: number; line?: number }>;

/** A world whose overmap is `fix` ("x,y,z" -> oter), field at z0 / rock below elsewhere. */
function world(seed: number, fix: Fixture) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  gen.overmap.omtAt = (x: number, y: number, z: number): OmtInfo => {
    const f = fix[`${x},${y},${z}`];
    const ref = f ? { type: f.type, rot: f.rot ?? 0, line: f.line ?? -1 } : z === 0 ? { type: 'field', rot: 0, line: -1 } : z > 0 ? { type: 'open_air', rot: 0, line: -1 } : { type: 'empty_rock', rot: 0, line: -1 };
    return { ...ref, id: oterId(ref, T) };
  };
  map.generator = gen;
  return { map, gen };
}

const idsOf = (map: GameMap, c: { ter: ArrayLike<number> }) => Array.from(c.ter, (t) => map.terrain.get(t).id);
const ter = (map: GameMap, x: number, y: number, z: number) => map.terAt(x, y, z);
const rail = (map: GameMap, x: number, y: number, z: number) => hasFlag(ter(map, x, y, z), 'RAIL');
const TRACK_COLS = [4, 8, 15, 19];
const DIRS = [[0, -1, LINE_N], [1, 0, LINE_E], [0, 1, LINE_S], [-1, 0, LINE_W]] as const;

/** Tile (local) on the edge of chunk (cx, cy) facing direction d, at offset k along it. */
function edgeTile(cx: number, cy: number, d: number, k: number, inset = 0): [number, number] {
  const X = cx * CHUNK, Y = cy * CHUNK;
  if (d === 0) return [X + k, Y + inset];
  if (d === 1) return [X + CHUNK - 1 - inset, Y + k];
  if (d === 2) return [X + k, Y + CHUNK - 1 - inset];
  return [X + inset, Y + k];
}

/** Flood fill over passable tiles of one chunk from `from`. */
function reachable(map: GameMap, cx: number, cy: number, z: number, from: [number, number][]): Set<string> {
  const seen = new Set<string>();
  const q = from.filter(([x, y]) => map.passable(x, y, z));
  for (const [x, y] of q) seen.add(`${x},${y}`);
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (Math.floor(nx / CHUNK) !== cx || Math.floor(ny / CHUNK) !== cy) continue;
      if (seen.has(`${nx},${ny}`) || !map.passable(nx, ny, z)) continue;
      seen.add(`${nx},${ny}`);
      q.push([nx, ny]);
    }
  }
  return seen;
}

describe('subway tunnels (mapgen_subway)', () => {
  it('every tunnel shape is BN track on rubble, never the dirt fallback', () => {
    for (let line = 1; line < 16; line++) {
      const { map } = world(3, { '10,10,-2': { type: 'subway', line } });
      const c = map.chunk(10, 10, -2)!;
      expect(c.omt?.source).toMatch(/^builtin:subway_/);
      const ids = new Set(idsOf(map, c));
      for (const bad of ['t_dirt', 't_grass', 't_soil', 't_region_groundcover']) expect(ids.has(bad), `${bad} in line ${line}`).toBe(false);
      expect(ids.has('t_railroad_rubble')).toBe(true);
    }
  });

  it('tracks leave every connected side on the shared columns 4/8/15/19 (diagonal entries within a tile)', () => {
    for (let line = 1; line < 16; line++) {
      const { map } = world(4, { '10,10,-2': { type: 'subway', line } });
      map.chunk(10, 10, -2);
      for (let d = 0; d < 4; d++) {
        if (!(line & DIRS[d][2])) continue;
        for (const k of TRACK_COLS) {
          // BN's tee arrives on its stem side with diagonal track one tile off the column.
          const hit = [k - 1, k, k + 1].some((kk) => rail(map, ...edgeTile(10, 10, d, kk), -2));
          expect(hit, `line ${line} side ${d} column ${k}`).toBe(true);
        }
      }
    }
  });

  it('a straight tunnel runs into a subway station platform and the track continues across the edge', () => {
    for (const [rot, d] of [[0, 2], [1, 3], [2, 0], [3, 1]] as const) {
      // tunnel on the station's track side: north of an unrotated station, and so on round
      const [dx, dy] = DIRS[d];
      const line = d % 2 === 0 ? LINE_N | LINE_S : LINE_E | LINE_W;
      const { map } = world(5, { '10,10,-2': { type: 'subway', line }, [`${10 + dx},${10 + dy},-2`]: { type: 'underground_sub_station', rot } });
      map.chunk(10, 10, -2);
      map.chunk(10 + dx, 10 + dy, -2);
      for (const k of TRACK_COLS) {
        expect(rail(map, ...edgeTile(10, 10, d, k), -2), `rot ${rot} tunnel ${k}`).toBe(true);
        expect(rail(map, ...edgeTile(10 + dx, 10 + dy, (d + 2) % 4, k), -2), `rot ${rot} station ${k}`).toBe(true);
      }
    }
  });

  it('lab cargo station and microlab station tracks meet the tunnel', () => {
    for (const station of ['underground_lab_cargo_stationA_sub_station', 'microlab_sub_station']) {
      const { map } = world(6, { '10,10,-2': { type: 'subway', line: LINE_S }, '10,11,-2': { type: station, rot: 0 } });
      map.chunk(10, 10, -2);
      map.chunk(10, 11, -2);
      for (const k of TRACK_COLS) {
        expect(rail(map, ...edgeTile(10, 10, 2, k), -2), `${station} tunnel ${k}`).toBe(true);
        const [sx, sy] = edgeTile(10, 11, 0, k);
        expect(rail(map, sx, sy, -2) || rail(map, sx, sy + 1, -2), `${station} station ${k}: ${ter(map, sx, sy, -2).id}`).toBe(true);
      }
    }
  });

  it('dead ends stop at buffer stops and sometimes hold a draisine; tunnels hold subway monsters', () => {
    let draisines = 0, groups = 0;
    for (let s = 1; s <= 40; s++) {
      const { map } = world(s, { '10,10,-2': { type: 'subway', line: LINE_N }, '11,10,-2': { type: 'subway', line: LINE_N | LINE_S } });
      const c = map.chunk(10, 10, -2)!;
      expect(idsOf(map, c).includes('t_buffer_stop')).toBe(true);
      if (c.vehicles.some((v) => v.id === 'trains_draisine')) draisines++;
      if (map.chunk(11, 10, -2)!.spawns.some((sp) => sp.id === 'GROUP_SUBWAY')) groups++;
    }
    expect(draisines).toBeGreaterThan(8);
    expect(draisines).toBeLessThan(32);
    // overmap_terrain subway: GROUP_SUBWAY 1-6 at 30 %
    expect(groups).toBeGreaterThan(3);
    expect(groups).toBeLessThan(25);
  }, 30_000);
});

describe('sewers (mapgen_sewer + mx_sewer_* extras)', () => {
  it('every sewer shape is rock and sewage with one of the BN sewer layouts on top', () => {
    const palette = new Set(['t_sewage_pipe', 't_sewage_pump', 't_bridge', 't_grate', 't_bars', 't_moss', 't_dirt', 't_dirtmound', 't_concrete_wall', 't_wall_metal', 't_metal_floor', 't_door_metal_c']);
    for (let line = 0; line < 16; line++) {
      const { map } = world(7 + line, { '10,10,-1': { type: 'sewer', line } });
      const c = map.chunk(10, 10, -1)!;
      expect(c.omt?.source).toMatch(/^builtin:sewer_/);
      const ids = idsOf(map, c);
      expect(ids.includes('t_sewage')).toBe(true);
      expect(ids.includes('t_soil')).toBe(false);
      // map_extras.sewer has chance 1: the extra always runs
      expect(ids.some((id) => palette.has(id)), `line ${line}`).toBe(true);
    }
  });

  it('the sewage channel reaches every connected side', () => {
    let open = 0, total = 0;
    for (let s = 1; s <= 30; s++) {
      const line = LINE_N | LINE_E | LINE_S | LINE_W;
      const { map } = world(s, { '10,10,-1': { type: 'sewer', line } });
      map.chunk(10, 10, -1);
      for (let d = 0; d < 4; d++) {
        total++;
        const ch = [10, 11, 12, 13].map((k) => edgeTile(10, 10, d, k));
        if (ch.some(([x, y]) => ['t_sewage', 't_bridge', 't_grate'].includes(ter(map, x, y, -1).id) || map.passable(x, y, -1))) open++;
      }
    }
    // a few mx_sewer_* layouts put a grate or pipe across one channel end, as in BN
    expect(open / total).toBeGreaterThan(0.85);
  });

  it('sewers hold GROUP_SEWER monsters (overmap_terrain spawns, 30 %)', () => {
    let n = 0;
    for (let s = 1; s <= 60; s++) {
      const { map } = world(s, { '10,10,-1': { type: 'sewer', line: LINE_E | LINE_W } });
      if (map.chunk(10, 10, -1)!.spawns.some((sp) => sp.id === 'GROUP_SEWER')) n++;
    }
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(32);
  }, 30_000);
});

describe('transport data', () => {
  it('sewer/subway chunks and their map extras name only known terrain, furniture and items', () => {
    for (let s = 1; s <= 48; s++) {
      const line = s % 16;
      const { map, gen } = world(s, { '10,10,-1': { type: 'sewer', line }, '10,10,-2': { type: 'subway', line: line || 15 } });
      map.chunk(10, 10, -1);
      map.chunk(10, 10, -2);
      expect([...gen.stats.unknownIds.keys()], `seed ${s}`).toEqual([]);
      // only BN's unported C++ subway extras (mx_portal_in) may be reported
      for (const k of gen.stats.unsupported.keys()) expect(k).toMatch(/^map_extra_function mx_/);
    }
  }, 30_000);
});

describe('manholes', () => {
  const town = (line: number): Fixture => ({
    '20,20,0': { type: 'road_nesw_manhole' },
    '20,19,0': { type: 'road', line: LINE_N | LINE_S }, '20,21,0': { type: 'road', line: LINE_N | LINE_S },
    '19,20,0': { type: 'road', line: LINE_E | LINE_W }, '21,20,0': { type: 'road', line: LINE_E | LINE_W },
    '20,20,-1': { type: 'sewer', line },
  });

  it('a ladder under every manhole cover, joined to the sewer, climbable both ways', () => {
    for (let s = 1; s <= 40; s++) {
      const line = s % 3 === 0 ? 0 : s % 3 === 1 ? LINE_N | LINE_S : LINE_N | LINE_E | LINE_S | LINE_W;
      const { map } = world(s, town(line));
      const top = map.chunk(20, 20, 0)!, below = map.chunk(20, 20, -1)!;
      const covers = idsOf(map, top).flatMap((id, i) => (id === 't_manhole_cover' ? [i] : []));
      expect(covers.length, `seed ${s}`).toBe(1);
      const i = covers[0];
      const x = 20 * CHUNK + (i % CHUNK), y = 20 * CHUNK + Math.floor(i / CHUNK);
      expect(map.terrain.get(below.ter[i]).id, `seed ${s}`).toBe('t_ladder_up');

      // the ladder reaches the sewer's openings (centre pool for an isolated sewer)
      const seeds: [number, number][] = [];
      for (let d = 0; d < 4; d++) if (line & DIRS[d][2]) for (const k of [10, 11, 12, 13]) seeds.push(edgeTile(20, 20, d, k));
      if (!line) for (const k of [11, 12]) for (const j of [10, 11, 12, 13]) seeds.push([20 * CHUNK + k, 20 * CHUNK + j]);
      expect(reachable(map, 20, 20, -1, seeds).has(`${x},${y}`), `seed ${s} line ${line}`).toBe(true);

      // up from the ladder lands on the cover; down through the opened manhole lands on the ladder
      const g = { map } as unknown as Game;
      expect(stairDestination(g, x, y, -1, 'up')).toEqual({ x, y, z: 0 });
      map.setTer(x, y, 0, 't_manhole');
      expect(stairDestination(g, x, y, 0, 'down')).toEqual({ x, y, z: -1 });
    }
  });

  it('the ladder becomes a walkable ladder link (docs/STAIRS.md)', () => {
    const { map } = world(2, town(LINE_N | LINE_S));
    const top = map.chunk(20, 20, 0)!;
    map.chunk(20, 20, -1);
    const i = idsOf(map, top).indexOf('t_manhole_cover');
    const x = 20 * CHUNK + (i % CHUNK), y = 20 * CHUNK + Math.floor(i / CHUNK);
    // Shut, the cover is not cut open into a stairwell (it reads as a cover from above).
    const shut = new StairIndex(map, 'flight');
    shut.ensureAround(x, y, -1, 1);
    expect(shut.isWell(x, y, 0)).toBe(false);
    expect(shut.at(x, y, -1)).toBeNull();
    map.setTer(x, y, 0, 't_manhole');
    const idx = new StairIndex(map, 'flight');
    idx.ensureAround(x, y, -1, 1);
    const link = idx.at(x, y, -1);
    const around = (z: number) => [-1, 0, 1].map((dy) => [-1, 0, 1].map((dx) => ter(map, x + dx, y + dy, z).id).join(' ')).join(' | ');
    expect(link?.kind, `below: ${around(-1)} / above: ${around(0)}`).toBe('ladder');
  });

  it('road_nesw_manhole is otherwise the plain four-way road', () => {
    const { map } = world(9, town(0));
    const ids = idsOf(map, map.chunk(20, 20, 0)!);
    expect(ids.filter((id) => id === 't_manhole_cover').length).toBe(1);
    expect(ids.filter((id) => id.startsWith('t_pavement')).length).toBeGreaterThan(200);
  });
});

describe("classic lab next to a sewer (lab.lua draw_sewer_room)", () => {
  it('a sewage channel behind bars crosses the lab OMT towards the sewer, and the stairs survive', () => {
    const { map } = world(11, {
      '30,30,0': { type: 'lab_stairs' },
      '30,30,-1': { type: 'lab_stairs' },
      '31,30,-1': { type: 'sewer', line: LINE_E | LINE_W },
      '30,30,-2': { type: 'lab' },
    });
    const c = map.chunk(30, 30, -1)!;
    expect(c.omt?.source).toBe('builtin:lua:lab');
    const at = (lx: number, ly: number) => map.terrain.get(c.ter[ly * CHUNK + lx]).id;
    for (const j of [10, 11, 12, 13]) {
      expect(at(23, j)).toBe('t_bars');
      expect(at(0, j)).toBe('t_bars');
      expect(at(12, j)).toBe('t_sewage');
    }
    // lab.lua insert_stairs: the OMT above is a stairs OMT, so this level gets the up stairs
    expect(idsOf(map, c).includes('t_stairs_up')).toBe(true);
    // and the sewer beside it lines its channel up with the bars
    map.chunk(31, 30, -1);
    expect([10, 11, 12, 13].every((j) => ter(map, 31 * CHUNK, 30 * CHUNK + j, -1).id !== 't_rock')).toBe(true);
  });
});

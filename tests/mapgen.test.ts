import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { MapBuffer, OMT } from '../src/world/mapgen/buffer';
import { Levels, MapgenDat, MapgenEnv, MapgenRunner } from '../src/world/mapgen/jsonmapgen';
import { GenStats } from '../src/world/mapgen/stats';
import { ArgStores, ParamCtx } from '../src/world/mapgen/values';
import { OmtRef } from '../src/world/overmap/oter';
import type { WorldgenData } from '../src/world/worldgen_data';
import { loadNodeData } from '../tools/lib/node_data';

const { game, wg: realWg } = loadNodeData();

function makeEnv(wg: WorldgenData): MapgenEnv {
  const stats = new GenStats();
  stats.quiet = true;
  return {
    seed: 1, data: wg, stats,
    terrainFlags: (id) => game.terrain[id]?.flags,
    furnitureKnown: (id) => !!game.furniture[id],
    furnitureFlags: (id) => game.furniture[id]?.flags,
    terFurnTransform: (id) => game.misc.ter_furn_transform?.[id],
    furnitureBashTo: () => undefined,
    terrainBashTo: (id) => game.terrain[id]?.bash?.ter_set,
    expandItems: () => [],
    snippets: (cat) => game.misc.snippet?.[cat],
    runPredecessor: () => {},
  };
}

function makeDat(env: MapgenEnv, oter: OmtRef, seed = 5, neighbors: (dx: number, dy: number, dz: number) => OmtRef = () => ({ type: 'field', rot: 0, line: -1 })): MapgenDat {
  const rng = new Rng(seed);
  const stores: ArgStores = { seed, specialKey: 1, special: new Map(), stackKey: 2, stack: new Map(), omtKey: 3, omt: new Map() };
  return {
    env, omx: 0, omy: 0, z: 0, oter, rotation: oter.rot, adjRotation: oter.rot, omtAt: neighbors, predecessors: [],
    params: new ParamCtx(stores, new Map(), rng), rng, cityName: 'Testville', names: { given: ['Ann'], family: ['Lee'] },
  };
}

/** Synthetic worldgen data around one mapgen object (and optional palettes / nested). */
function synth(obj: any, palettes: Record<string, any> = {}, nested: Record<string, any> = {}): WorldgenData {
  const objects = [obj, ...Object.values(nested)];
  return {
    mapgen: {
      omt: { test_omt: [{ w: 1000, o: 0 }] },
      nested: Object.fromEntries(Object.keys(nested).map((k, i) => [k, [{ w: 100, o: i + 1 }]])),
      objects,
    },
    palettes,
    overmap: realWg.overmap,
  };
}

function run(wg: WorldgenData, oter: OmtRef = { type: 'test_omt', rot: 0, line: -1 }, seed = 5, neighbors?: any): MapBuffer {
  const env = makeEnv(wg);
  const runner = new MapgenRunner(env);
  const levels: Levels = new Map([[0, new MapBuffer('t_dirt')]]);
  const ok = runner.runOmt(oter.type, makeDat(env, oter, seed, neighbors), levels);
  expect(ok).toBe(true);
  return levels.get(0)!;
}

const rows24 = (f: (x: number, y: number) => string) =>
  Array.from({ length: OMT }, (_, y) => Array.from({ length: OMT }, (_, x) => f(x, y)).join(''));

describe('rows and palettes', () => {
  it('maps row symbols through palettes; later palettes and the object override earlier ones', () => {
    const wg = synth(
      {
        fill_ter: 't_floor',
        rows: rows24((x, y) => (x === 0 ? '#' : y === 0 ? 'w' : x === 5 && y === 5 ? 'c' : x === 6 && y === 6 ? 'é' : '.')),
        palettes: ['p1', 'p2'],
        terrain: { w: 't_wall_wood' },
        furniture: { 'é': 'f_table' },
      },
      {
        p1: { terrain: { '#': 't_wall', w: 't_wall' }, furniture: { c: 'f_chair' } },
        p2: { terrain: { '#': 't_brick_wall' } },
      },
    );
    const b = run(wg);
    expect(b.ter[MapBuffer.idx(0, 10)]).toBe('t_brick_wall'); // p2 overrides p1
    expect(b.ter[MapBuffer.idx(10, 0)]).toBe('t_wall_wood'); // object overrides palettes
    expect(b.furn[MapBuffer.idx(5, 5)]).toBe('f_chair');
    expect(b.furn[MapBuffer.idx(6, 6)]).toBe('f_table'); // multi-byte symbol
    expect(b.ter[MapBuffer.idx(10, 10)]).toBe('t_floor'); // '.' falls back to fill_ter
  });

  it('resolves parameters, distribution palette ids and switch values consistently', () => {
    const wg = synth(
      {
        rows: rows24(() => 'a'),
        palettes: [{ distribution: [['pa', 1], ['pb', 1]] }],
        parameters: { wall: { type: 'ter_str_id', scope: 'omt', default: { distribution: [['t_wall', 1], ['t_brick_wall', 1]] } } },
        terrain: {
          b: { param: 'wall', fallback: 't_dirt' },
          c: { switch: { param: 'wall', fallback: 't_dirt' }, cases: { t_wall: 't_door_c', t_brick_wall: 't_door_locked' } },
        },
      },
      { pa: { terrain: { a: 't_grass' } }, pb: { terrain: { a: 't_sand' } } },
    );
    const seen = new Set<string>();
    for (let s = 1; s < 30; s++) {
      const b = run(wg, undefined, s);
      const first = b.ter[0];
      expect(['t_grass', 't_sand']).toContain(first);
      // a palette chosen by distribution applies to the whole OMT
      expect(b.ter.every((t) => t === first)).toBe(true);
      seen.add(first);
    }
    expect(seen.size).toBe(2);

    const wg2 = synth({ ...wg.mapgen.objects[0], rows: rows24((x) => (x < 12 ? 'b' : 'c')) }, wg.palettes);
    for (let s = 1; s < 10; s++) {
      const b = run(wg2, undefined, s);
      const wall = b.ter[0], door = b.ter[23];
      expect(wall === 't_wall' ? door === 't_door_c' : door === 't_door_locked').toBe(true);
    }
  });

  it('applies weighted alternatives, set lines/squares and place_* objects', () => {
    const wg = synth({
      fill_ter: 't_floor',
      terrain: { x: [['t_grass', 1], ['t_dirt', 3]] },
      rows: rows24((x, y) => (y === 23 ? 'x' : '.')),
      set: [
        { line: 'terrain', id: 't_wall', x: 0, y: 2, x2: 23, y2: 2 },
        { square: 'furniture', id: 'f_rubble', x: 3, y: 5, x2: 4, y2: 6 },
      ],
      place_furniture: [{ furn: 'f_bed', x: 10, y: 10 }],
      place_monster: [{ monster: 'mon_zombie', x: 12, y: 12 }],
      place_monsters: [{ monster: 'GROUP_ZOMBIE', x: [1, 5], y: [1, 5], density: 0.5 }],
      place_signs: [{ signage: 'Welcome to <city>', x: 20, y: 20 }],
    });
    const b = run(wg);
    for (let x = 0; x < OMT; x++) expect(b.ter[MapBuffer.idx(x, 2)]).toBe('t_wall');
    expect(b.furn[MapBuffer.idx(4, 6)]).toBe('f_rubble');
    expect(b.furn[MapBuffer.idx(10, 10)]).toBe('f_bed');
    const bottom = b.ter.slice(23 * OMT);
    expect(bottom.every((t) => t === 't_grass' || t === 't_dirt')).toBe(true);
    expect(bottom.filter((t) => t === 't_dirt').length).toBeGreaterThan(10);
    expect(b.spawns).toContainEqual(expect.objectContaining({ kind: 'monster', id: 'mon_zombie', x: 12, y: 12 }));
    expect(b.spawns).toContainEqual(expect.objectContaining({ kind: 'group', id: 'GROUP_ZOMBIE', x: 1, y: 1, x2: 5, y2: 5, density: 0.5 }));
    expect(b.signs.get(MapBuffer.idx(20, 20))).toBe('Welcome to Testville');
  });
});

describe('rotation', () => {
  it('MapBuffer.rotate turns clockwise like CDDA point::rotate', () => {
    const b = new MapBuffer('t_floor');
    b.ter[MapBuffer.idx(0, 0)] = 't_wall';
    b.ter[MapBuffer.idx(5, 1)] = 't_door_c';
    b.rotate(1);
    expect(b.ter[MapBuffer.idx(23, 0)]).toBe('t_wall');
    expect(b.ter[MapBuffer.idx(22, 5)]).toBe('t_door_c');
    b.rotate(3);
    expect(b.ter[MapBuffer.idx(5, 1)]).toBe('t_door_c');
  });

  it('a rotated OMT generates the north layout rotated (real house mapgen)', () => {
    const north = run(realWg, { type: 'house_01', rot: 0, line: -1 }, 42);
    const east = run(realWg, { type: 'house_01', rot: 1, line: -1 }, 42);
    const turned = new MapBuffer();
    north.ter.forEach((t, i) => (turned.ter[i] = t));
    north.furn.forEach((f, i) => (turned.furn[i] = f));
    turned.rotate(1);
    expect(east.ter).toEqual(turned.ter);
    expect(east.furn).toEqual(turned.furn);
  });

  it('house_01 walls match the JSON rows', () => {
    const obj = realWg.mapgen.objects[realWg.mapgen.omt.house_01.find((r) => r.w === 100)!.o];
    // force the "normal variant" (weight 100) by giving it the only entry
    const wg = { ...realWg, mapgen: { ...realWg.mapgen, omt: { ...realWg.mapgen.omt, house_01: [{ w: 1, o: realWg.mapgen.objects.indexOf(obj) }] } } };
    const b = run(wg, { type: 'house_01', rot: 0, line: -1 }, 3);
    const rows: string[] = obj.rows;
    for (let y = 0; y < OMT; y++)
      for (let x = 0; x < OMT; x++) {
        const ch = Array.from(rows[y])[x];
        const t = b.ter[MapBuffer.idx(x, y)];
        if (ch === '#') expect(game.terrain[t].flags).toContain('WALL');
        if (ch === '$') expect(t).toBe('t_privacy_fence');
      }
  });
});

describe('multi-OMT and nested mapgen', () => {
  it('each OMT of a 2D om_terrain takes its 24x24 slice', () => {
    const obj = {
      fill_ter: 't_floor',
      rows: Array.from({ length: 24 }, () => '#'.repeat(24) + 'o'.repeat(24)),
      terrain: { '#': 't_wall', o: 't_grass' },
      place_furniture: [{ furn: 'f_chair', x: 30, y: 4 }, { furn: 'f_table', x: 2, y: 4 }],
    };
    const wg: WorldgenData = {
      mapgen: { omt: { left: [{ w: 1, o: 0 }], right: [{ w: 1, o: 0, ox: 24 }] }, nested: {}, objects: [obj] },
      palettes: {}, overmap: realWg.overmap,
    };
    const l = run(wg, { type: 'left', rot: 0, line: -1 });
    const r = run(wg, { type: 'right', rot: 0, line: -1 });
    expect(l.ter.every((t) => t === 't_wall')).toBe(true);
    expect(r.ter.every((t) => t === 't_grass')).toBe(true);
    expect(r.furn[MapBuffer.idx(6, 4)]).toBe('f_chair');
    expect(l.furn[MapBuffer.idx(2, 4)]).toBe('f_table');
    expect(l.furn[MapBuffer.idx(6, 4)]).toBe('');
  });

  it('places nested chunks, honouring neighbour conditions', () => {
    const wg = synth(
      {
        fill_ter: 't_grass',
        place_nested: [
          { chunks: ['hut'], x: 5, y: 5 },
          { chunks: ['hut'], x: 15, y: 15, neighbors: { north: ['road'] } },
          { else_chunks: ['hut'], x: 15, y: 1, neighbors: { north: ['road'] } },
        ],
        rows: rows24(() => '.'),
        nested: undefined,
      },
      {},
      { hut: { mapgensize: [3, 3], rows: ['###', '#.#', '###'], terrain: { '#': 't_wall', '.': 't_floor' } } },
    );
    const b = run(wg);
    expect(b.ter[MapBuffer.idx(5, 5)]).toBe('t_wall');
    expect(b.ter[MapBuffer.idx(6, 6)]).toBe('t_floor');
    expect(b.ter[MapBuffer.idx(15, 15)]).toBe('t_grass'); // north neighbour is field, not road
    expect(b.ter[MapBuffer.idx(15, 1)]).toBe('t_wall'); // else_chunks
    const withRoad = run(wg, undefined, 5, (dx: number, dy: number) => ({ type: dy === -1 && dx === 0 ? 'road' : 'field', rot: 0, line: dy === -1 ? 5 : -1 }));
    expect(withRoad.ter[MapBuffer.idx(15, 15)]).toBe('t_wall');
  });

  it('real BN shelter mapgen builds walls, the basement stairs and its nested furniture', () => {
    const b = run(realWg, { type: 'shelter', rot: 0, line: -1 }, 9);
    const walls = b.ter.filter((t) => game.terrain[t]?.flags.includes('WALL')).length;
    expect(walls).toBeGreaterThan(30);
    expect(b.ter).toContain('t_stairs_down');
    expect(b.furn.filter(Boolean).length).toBeGreaterThan(10);
  });
});

describe('BN mapgen keys', () => {
  it('translate_ter swaps one terrain for another over the whole OMT; "add" places items', () => {
    const wg = synth({
      fill_ter: 't_floor',
      rows: rows24((x, y) => (x === 3 || y === 7 ? 'D' : '.')),
      terrain: { D: 't_door_metal_locked' },
      translate_ter: [{ from: 't_door_metal_locked', to: 't_door_metal_c', x: 0, y: 0 }],
      add: [{ item: 'rock', x: 5, y: 5, chance: 100 }],
    });
    const b = run(wg);
    expect(b.ter).not.toContain('t_door_metal_locked');
    expect(b.ter.filter((t) => t === 't_door_metal_c').length).toBe(47);
    expect(b.items.get(MapBuffer.idx(5, 5))?.[0].typeId).toBe('rock');
  });

  it('keeps combining marks with their base character in rows (utf8_display_split)', () => {
    const wg = synth({
      fill_ter: 't_floor',
      rows: rows24((x) => (x === 2 ? 'a\u0331' : '.')),
      terrain: { 'a\u0331': 't_wall' },
    });
    const b = run(wg);
    for (let y = 0; y < OMT; y++) expect(b.ter[MapBuffer.idx(2, y)]).toBe('t_wall');
    expect(b.ter[MapBuffer.idx(3, 0)]).toBe('t_floor');
  });

  // t_console / f_vending_o: BN terrain/furniture (runs once terrain.json is BN's).
  it.runIf(!!game.terrain.t_console)('computers are t_console terrain, vending machines are f_vending_c or broken open', () => {
    const wg = synth({
      fill_ter: 't_floor',
      rows: rows24(() => '.'),
      place_computers: [{ name: 'test', security: 0, x: 4, y: 4 }],
      place_vendingmachines: [{ x: 8, y: 8 }, { x: 10, y: 10, reinforced: true }],
    });
    const b = run(wg);
    expect(b.ter[MapBuffer.idx(4, 4)]).toBe('t_console');
    expect(b.furn[MapBuffer.idx(4, 4)]).toBe('');
    expect(['f_vending_c', 'f_vending_o']).toContain(b.furn[MapBuffer.idx(8, 8)]);
    expect(b.furn[MapBuffer.idx(10, 10)]).toBe('f_vending_reinforced');
  });
});

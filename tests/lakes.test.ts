// genVersion 3 lakes (docs/WORLD_TRANSPORT.md "Lakes in depth"): BN place_lakes' lake_shore ring
// and the columns under every lake OMT, their mapgen, sunken_lab with its lab_basement, and
// swimming between the levels (BN vertical_move's swimming branch). Real data, real seeds.
import { describe, expect, it } from 'vitest';
import { Overmap, REGION } from '../src/world/overmap/overmap';
import { LAKE_COLUMN_TYPES, LAKE_DEPTH, lakeColumn } from '../src/world/overmap/lakes';
import { WorldGenerator } from '../src/world/worldgen';
import { CHUNK } from '../src/world/coords';
import { hasFlag } from '../src/world/registry';
import { Game } from '../src/game/game';
import { goStairs } from '../src/game/zlevels';
import { swimState, updateSwimming } from '../src/game/water';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

const { game: data, wg } = loadNodeData();

/** Found with `tsx tools/dev/probe_lakes.ts --scan --radius 3 1..30` (3 in 1470 regions):
 *  seed 24's start region holds one, rotated south. */
const SUNKEN = { seed: 24, x: 21, y: 14 };

describe('lake columns (genVersion 3)', () => {
  const om = new Overmap(SUNKEN.seed, wg.overmap, 3);
  // generate the start region and its east neighbour (lakes cross region edges)
  om.omtAt(0, 0, 0);
  om.omtAt(REGION, 0, 0);
  const isLakeNoise = (x: number, y: number) => om.isLake(x, y) || om.isRiver(x, y);

  it('every lake OMT is lake_shore exactly when a neighbour is outside the lake, with BN columns under it', () => {
    let surface = 0, shore = 0;
    for (let y = 1; y < REGION - 1; y++)
      for (let x = 1; x < 2 * REGION - 1; x++) {
        const base = om.baseLand(x, y);
        if (base !== 'lake_surface' && base !== 'lake_shore') {
          for (let z = -1; z >= LAKE_DEPTH; z--) expect(LAKE_COLUMN_TYPES.has(om.omtAt(x, y, z).type), `${x},${y},${z} under ${base}`).toBe(false);
          continue;
        }
        let edge = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!isLakeNoise(x + dx, y + dy)) edge = true;
        expect(base).toBe(edge ? 'lake_shore' : 'lake_surface');
        base === 'lake_shore' ? shore++ : surface++;
        const col = lakeColumn(base);
        for (let z = -1; z >= LAKE_DEPTH; z--) {
          const o = om.omtAt(x, y, z);
          // the sunken lab replaces three levels of one column
          if (o.special?.def === 'sunken_lab') continue;
          expect(o.type, `${x},${y},${z}`).toBe(col[-z - 1]);
        }
        expect(LAKE_COLUMN_TYPES.has(om.omtAt(x, y, LAKE_DEPTH - 1).type)).toBe(false);
      }
    expect(surface).toBeGreaterThan(20);
    expect(shore).toBeGreaterThan(20);
    expect(lakeColumn('lake_surface')).toEqual(['lake_water_cube', 'lake_water_cube', 'lake_water_cube', 'lake_water_cube', 'lake_bed']);
    expect(lakeColumn('lake_shore')).toEqual(Array(5).fill('lake_underwater_shore'));
  });

  it('genVersion 2 keeps flat lakes: no shore ring, no columns', () => {
    const v2 = new Overmap(SUNKEN.seed, wg.overmap, 2);
    let lakes = 0;
    for (let y = 0; y < REGION; y++)
      for (let x = 0; x < REGION; x++) {
        const t = v2.omtAt(x, y, 0).type;
        expect(t).not.toBe('lake_shore');
        if (t !== 'lake_surface') continue;
        lakes++;
        for (let z = -1; z >= LAKE_DEPTH; z--) expect(LAKE_COLUMN_TYPES.has(v2.omtAt(x, y, z).type)).toBe(false);
      }
    expect(lakes).toBeGreaterThan(20);
    expect(v2.findSpecial('sunken_lab', { x: SUNKEN.x, y: SUNKEN.y }, 0)).toBeUndefined();
  });

  it('lakeColumnAt answers from the noise what placeLakeColumns lays', () => {
    for (let y = 0; y < REGION; y += 3)
      for (let x = 0; x < REGION; x += 3)
        for (const z of [-1, -2, -5]) {
          const o = om.omtAt(x, y, z);
          if (o.special) continue;
          expect(om.lakeColumnAt(x, y, z) ?? 'none').toBe(LAKE_COLUMN_TYPES.has(o.type) ? o.type : 'none');
        }
  });
});

describe('lake mapgen', () => {
  const gen = new WorldGenerator(SUNKEN.seed, wg, data);
  gen.stats.quiet = true;
  const map = makeMap(data, SUNKEN.seed);
  map.generator = gen;
  const om = gen.overmap;
  const tiles = (cx: number, cy: number, z: number) => {
    const out: string[] = [];
    for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) out.push(map.terAt(cx * CHUNK + x, cy * CHUNK + y, z).id);
    return out;
  };

  it('a lake_surface column: deep water over water cubes over the lake bed', () => {
    const p = om.findNearest((o) => o.type === 'lake_surface' && !o.special, { x: 30, y: 10 })!;
    expect(new Set(tiles(p.x, p.y, 0))).toEqual(new Set(['t_water_dp']));
    for (let z = -1; z > LAKE_DEPTH; z--) expect(new Set(tiles(p.x, p.y, z)), `z${z}`).toEqual(new Set(['t_water_cube']));
    const bed = tiles(p.x, p.y, LAKE_DEPTH);
    // the bed may hold a nested chunk (trees, safes, corpses) but is lake bed underneath
    expect(bed.filter((t) => /^t_lake_(bed|moss|trunk)$/.test(t)).length).toBeGreaterThan(CHUNK * CHUNK * 0.8);
  });

  it('a lake_shore column: water exactly under the surface deep water, rock under the bank', () => {
    let checked = 0;
    for (let k = 0; checked < 4 && k < 40; k++) {
      const p = om.findNearest((o) => o.type === 'lake_shore', { x: 10 + k * 7, y: 10 + (k % 5) * 15 });
      if (!p) continue;
      checked++;
      const top = tiles(p.x, p.y, 0);
      for (let z = -1; z >= LAKE_DEPTH; z--) {
        const below = tiles(p.x, p.y, z);
        below.forEach((t, i) => {
          const water = z === LAKE_DEPTH ? /^t_lake_(bed|moss)$/.test(t) : t === 't_water_cube';
          expect(water ? 'water' : t, `${p.x},${p.y},${z} tile ${i} under ${top[i]}`).toBe(top[i] === 't_water_dp' ? 'water' : 't_rock');
        });
      }
    }
    expect(checked).toBe(4);
  });

  it('every lake column OMT and the sunken lab draw without fallbacks', () => {
    for (let z = 0; z >= -6; z--) tiles(SUNKEN.x, SUNKEN.y, z);
    for (const z of [-1, LAKE_DEPTH]) {
      const p = om.findNearest((o) => o.type === 'lake_shore', { x: SUNKEN.x, y: SUNKEN.y })!;
      tiles(p.x, p.y, z);
    }
    expect([...gen.stats.sources.keys()].filter((s) => s === 'fallback' || s === 'uniform')).toEqual([]);
    expect([...gen.stats.unsupported.keys()]).toEqual([]);
    expect([...gen.stats.unknownIds.keys()]).toEqual([]);
  });
});

describe('sunken_lab', () => {
  const gen = new WorldGenerator(SUNKEN.seed, wg, data);
  gen.stats.quiet = true;
  const map = makeMap(data, SUNKEN.seed);
  map.generator = gen;
  const om = gen.overmap;

  it('sits in a lake column with BN levels and grows lab_basement around its airlock', () => {
    const s = om.findSpecial('sunken_lab', { x: SUNKEN.x, y: SUNKEN.y }, 0)!;
    expect(s && [s.x, s.y]).toEqual([SUNKEN.x, SUNKEN.y]);
    expect(om.omtAt(s.x, s.y, 0).type).toBe('lake_surface');
    for (let z = -1; z >= -3; z--) expect(om.omtAt(s.x, s.y, z).type).toBe('lake_water_cube');
    expect(om.omtAt(s.x, s.y, -4).type).toBe('lake_bed_lab_entrance_roof');
    expect(om.omtAt(s.x, s.y, -5).type).toBe('lake_bed_lab_entrance');
    expect(om.omtAt(s.x, s.y, -6).type).toBe('lake_bed_lab_entrance_airlock');
    const around = [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dx, dy]) => om.omtAt(s.x + dx, s.y + dy, -6).type);
    expect(around.some((t) => t === 'lab_core'), around.join()).toBe(true);
    expect(around.every((t) => t.startsWith('lab'))).toBe(true);
  });

  it('the entrance opens onto the lake bed and its stairs land in the airlock', () => {
    const X = SUNKEN.x * CHUNK, Y = SUNKEN.y * CHUNK;
    // flood the lake-bed level from the chunk corner through water, floor and (closed) doors
    const ok = (x: number, y: number) => map.passable(x, y, -5) || hasFlag(map.terAt(x, y, -5), 'DOOR');
    const seen = new Set<string>([`${X},${Y}`]);
    const q: [number, number][] = [[X, Y]];
    let stairs: [number, number] | null = null;
    while (q.length) {
      const [x, y] = q.pop()!;
      if (hasFlag(map.terAt(x, y, -5), 'GOES_DOWN')) stairs = [x, y];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < X || ny < Y || nx >= X + CHUNK || ny >= Y + CHUNK || seen.has(`${nx},${ny}`) || !ok(nx, ny)) continue;
        seen.add(`${nx},${ny}`);
        q.push([nx, ny]);
      }
    }
    expect(stairs).not.toBeNull();
    expect(hasFlag(map.terAt(stairs![0], stairs![1], -6), 'GOES_UP')).toBe(true);
    expect(map.terAt(X, Y, -5).id).toMatch(/^t_lake_/);
  });
});

describe('swimming between lake levels (BN vertical_move)', () => {
  const input: any = { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
  const game = new Game(data, SUNKEN.seed, input);
  game.map.generator = new WorldGenerator(SUNKEN.seed, wg, data);
  (game.map.generator as WorldGenerator).stats.quiet = true;
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  const p = game.player;
  const om = (game.map.generator as WorldGenerator).overmap;
  const lake = om.findNearest((o) => o.type === 'lake_surface' && !o.special, { x: 30, y: 10 })!;

  it('dive, swim down to the bed, refuse to go deeper, swim back up and surface', () => {
    p.x = lake.x * CHUNK + 12.5;
    p.y = lake.y * CHUNK + 12.5;
    p.z = 0;
    updateSwimming(game, 1 / 30);
    const st = swimState(game);
    expect(st.swimming).toBe(true);
    expect(st.underwater).toBe(false);
    expect(goStairs(game, 'up')).toBe(false);
    expect(log.at(-1)).toBe("You can't go up here!");
    expect(goStairs(game, 'down')).toBe(true);
    expect(log.at(-1)).toBe('You dive underwater!');
    expect([p.z, st.underwater]).toEqual([0, true]);
    // a dive is not a sinking: you stay under until you surface
    for (let i = 0; i < 10; i++) updateSwimming(game, 1 / 30);
    expect(st.underwater).toBe(true);
    for (let z = -1; z >= LAKE_DEPTH; z--) {
      expect(goStairs(game, 'down')).toBe(true);
      expect(log.at(-1)).toBe('You swim down.');
      expect(p.z).toBe(z);
      updateSwimming(game, 1 / 30);
      expect(st.underwater).toBe(true);
    }
    expect(goStairs(game, 'down')).toBe(false);
    expect(log.at(-1)).toBe('You are already underwater and there is no more water beneath you to swim down!');
    const o0 = st.oxygen;
    for (let i = 0; i < 30; i++) updateSwimming(game, 1 / 30);
    expect(st.oxygen).toBeLessThan(o0);
    for (let z = LAKE_DEPTH + 1; z <= 0; z++) {
      expect(goStairs(game, 'up')).toBe(true);
      expect(log.at(-1)).toBe('You swim up.');
      expect(p.z).toBe(z);
    }
    expect(goStairs(game, 'up')).toBe(true);
    expect(log.at(-1)).toBe('You surface.');
    expect([p.z, st.underwater]).toEqual([0, false]);
  });
});

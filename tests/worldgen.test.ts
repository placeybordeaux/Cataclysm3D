import { describe, expect, it } from 'vitest';
import { WorldGenerator } from '../src/world/worldgen';
import { Overmap, REGION } from '../src/world/overmap/overmap';
import { LINE_E, LINE_N, LINE_S, LINE_W, parseOterId, oterId, rotateLine } from '../src/world/overmap/oter';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

const { game, wg } = loadNodeData();

function world(seed: number) {
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
  return { map, gen };
}

describe('overmap', () => {
  it('parses and rebuilds oter ids with rotation and linear suffixes', () => {
    const t = wg.overmap.terrains;
    expect(parseOterId('house_01_east', t)).toEqual({ type: 'house_01', rot: 1, line: -1 });
    expect(oterId({ type: 'house_01', rot: 3, line: -1 }, t)).toBe('house_01_west');
    expect(oterId({ type: 'road', rot: 0, line: LINE_N | LINE_S }, t)).toBe('road_ns');
    expect(rotateLine(LINE_N | LINE_E, 1)).toBe(LINE_E | LINE_S);
    expect(oterId({ type: 'field', rot: 2, line: -1 }, t)).toBe('field');
  });

  it('places towns, roads with consistent connections, and an evac shelter near a town', () => {
    const om = new Overmap(1234, wg.overmap);
    const cities = om.citiesNear(REGION / 2, REGION / 2, 0);
    expect(cities.length).toBeGreaterThan(0);
    const shelter = om.findSpecial('Evac Shelter', { x: 0, y: 0 });
    expect(shelter).toBeDefined();
    // BN's Evac Shelter city_distance [3, 15] is measured from a town's edge
    const edge = Math.min(...om.citiesNear(shelter!.x, shelter!.y, 0).map((c) => Math.hypot(c.x - shelter!.x, c.y - shelter!.y) - c.size));
    expect(edge).toBeLessThanOrEqual(16);
    // road connections must be mutual
    let roads = 0, houses = 0;
    for (let y = 1; y < REGION - 1; y++)
      for (let x = 1; x < REGION - 1; x++) {
        const o = om.omtAt(x, y, 0);
        if (o.id.includes('house')) houses++;
        if (o.type !== 'road') continue;
        roads++;
        if (o.line & LINE_E) expect(om.omtAt(x + 1, y, 0).line & LINE_W).toBeTruthy();
        if (o.line & LINE_S) expect(om.omtAt(x, y + 1, 0).line & LINE_N).toBeTruthy();
      }
    expect(roads).toBeGreaterThan(20);
    expect(houses).toBeGreaterThan(5);
  });

  it('stacks multi-level buildings (roofs above, basements below)', () => {
    const om = new Overmap(7, wg.overmap);
    const s = om.findSpecial('Evac Shelter', { x: 0, y: 0 })!;
    expect(om.omtAt(s.x, s.y, 0).type).toBe('shelter');
    expect(om.omtAt(s.x, s.y, 1).type).toBe('shelter_roof');
    expect(om.omtAt(s.x, s.y, -1).type).toBe('shelter_under');
  });

  it('roads continue across region borders via shared portals', () => {
    const om = new Overmap(99, wg.overmap);
    let crossings = 0;
    for (let y = 0; y < REGION; y++) {
      const a = om.omtAt(REGION - 1, y, 0), b = om.omtAt(REGION, y, 0);
      if (a.type === 'road' && a.line & LINE_E) {
        crossings++;
        expect(b.type).toBe('road');
        expect(b.line & LINE_W).toBeTruthy();
      }
    }
    expect(crossings).toBeGreaterThan(0);
  });
});

describe('world generator', () => {
  it('is deterministic: same seed gives identical chunks, different seed differs', () => {
    const a = world(5), b = world(5), c = world(6);
    const sa = a.gen.findStartLocation('shelter', a.map);
    const sb = b.gen.findStartLocation('shelter', b.map);
    expect(sb).toEqual(sa);
    for (const [dx, dy, z] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [-1, -1, 0], [0, 0, 1], [0, 0, -1], [3, 2, 0]]) {
      const ca = a.map.chunk(sa.omx + dx, sa.omy + dy, z)!, cb = b.map.chunk(sa.omx + dx, sa.omy + dy, z)!;
      expect(Array.from(cb.ter)).toEqual(Array.from(ca.ter));
      expect(Array.from(cb.furn)).toEqual(Array.from(ca.furn));
      expect(cb.spawns).toEqual(ca.spawns);
    }
    const sc = c.gen.findStartLocation('shelter', c.map);
    const differs = [0, 1, 2].some((dx) => {
      const x = a.map.chunk(sa.omx + dx, sa.omy, 0)!, y = c.map.chunk(sc.omx + dx + 7, sc.omy + 5, 0)!;
      return Array.from(x.ter).join() !== Array.from(y.ter).join();
    });
    expect(differs).toBe(true);
  });

  it('does not depend on exploration order', () => {
    const a = world(8), b = world(8);
    // b explores two other regions first
    b.map.chunk(REGION * 2 + 5, 7, 0);
    b.map.chunk(-REGION + 3, REGION + 9, 0);
    const sa = a.gen.findStartLocation('shelter', a.map), sb = b.gen.findStartLocation('shelter', b.map);
    expect(sb).toEqual(sa);
    for (let dx = -3; dx <= 3; dx++) {
      const ca = a.map.chunk(sa.omx + dx, sa.omy - 4, 0)!, cb = b.map.chunk(sa.omx + dx, sa.omy - 4, 0)!;
      expect(Array.from(cb.ter)).toEqual(Array.from(ca.ter));
      expect(Array.from(cb.furn)).toEqual(Array.from(ca.furn));
    }
  });

  it('starts the player on a passable tile inside the shelter', () => {
    const { map, gen } = world(11);
    const s = gen.findStartLocation('shelter', map);
    expect(map.passable(s.x, s.y, 0)).toBe(true);
    // BN floors have no INDOORS flag; the shelter roof covers the start tile.
    expect(map.hasFloor(s.x, s.y, 1)).toBe(true);
    expect(gen.overmap.omtAt(s.omx, s.omy, 0).type).toBe('shelter');
  });

  it('generates 25 chunks around the start quickly and mostly from JSON mapgen', () => {
    const { map, gen } = world(21);
    const s = gen.findStartLocation('shelter', map);
    const t0 = performance.now();
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) map.chunk(s.omx + dx, s.omy + dy, 0);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
    // Every id BN mapgen uses must exist, once terrain.json is BN's (t_pd_border is BN-only).
    if (game.terrain.t_pd_border) expect([...gen.stats.unknownIds.keys()]).toEqual([]);
  });
});

describe('update_mapgen on live chunks', () => {
  /** The refugee center OMT with the locked roof stairs (evac_center_13) in world `seed`. */
  function roofStairs(seed: number) {
    const w = world(seed);
    const sp = w.gen.overmap.findSpecial('evac_center', { x: 0, y: 0 }, 3)!;
    expect(sp).toBeDefined();
    for (let dy = -18; dy < 18; dy++)
      for (let dx = -18; dx < 18; dx++) {
        const o = w.gen.overmap.omtAt(sp.x + dx, sp.y + dy, 0);
        if (o.type === 'evac_center_13' && o.special === sp) return { ...w, omx: sp.x + dx, omy: sp.y + dy, rot: o.rot };
      }
    throw new Error('no evac_center_13');
  }

  it("Dino Dave's refcenter_unlock_roofstairs opens the locked doors (translate_ter, version bumped, hooks fired)", () => {
    const { map, gen, omx, omy } = roofStairs(5);
    const c = map.chunk(omx, omy, 0)!;
    const count = (id: string) => Array.from(c.ter).filter((t) => map.terrain.get(t).id === id).length;
    const locked = count('t_door_metal_locked'), open = count('t_door_metal_c');
    expect(locked).toBeGreaterThan(0);
    const v = c.version;
    const updated: string[] = [];
    map.onChunkUpdated.push((ch) => updated.push(`${ch.cx},${ch.cy},${ch.z}`));
    expect(gen.applyUpdate(map, 'refcenter_unlock_roofstairs', omx, omy, 0)).toBe(true);
    expect(c.version).toBeGreaterThan(v);
    expect(count('t_door_metal_locked')).toBe(0);
    expect(count('t_door_metal_c')).toBe(open + locked);
    expect(updated).toEqual([`${omx},${omy},0`]);
    expect(gen.applyUpdate(map, 'no_such_update', omx, omy, 0)).toBe(false);
  });

  it('applies inline mission update_mapgen in the OMT rotation, keeping existing items', () => {
    const { map, gen, omx, omy, rot } = roofStairs(5);
    const c = map.chunk(omx, omy, 0)!;
    const items = [...c.items.values()].reduce((n, l) => n + l.length, 0);
    gen.applyUpdate(map, { set: [{ point: 'terrain', id: 't_floor_red', x: 1, y: 0 }], place_monster: [{ monster: 'mon_zombie', x: 5, y: 5, target: true }] }, omx, omy, 0, { dropMissionTargets: true });
    // (1, 0) in north coordinates, turned like MapBuffer.rotate
    let x = 1, y = 0;
    for (let t = 0; t < (rot & 3); t++) [x, y] = [23 - y, x];
    expect(map.terrain.get(c.ter[y * 24 + x]).id).toBe('t_floor_red');
    expect([...c.items.values()].reduce((n, l) => n + l.length, 0)).toBe(items);
    expect(c.spawns.length).toBe(0);
  });
});

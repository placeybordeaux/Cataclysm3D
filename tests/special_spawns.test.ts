// Overmap special spawns (genVersion >= 3): BN overmap_special_spawns placed as per-submap
// monster groups (src/world/overmap/mongroups.ts) and materialised near the survivor
// (src/game/mongroups.ts), against the real extracted data and world generator.
import { describe, expect, it } from 'vitest';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import { MonsterSystem } from '../src/game/monai';
import { Spawner } from '../src/game/spawner';
import { BUBBLE_SUBMAPS, installMonGroups, type MonGroupSpawner } from '../src/game/mongroups';
import { isOutside } from '../src/game/vision';
import { WorldGenerator } from '../src/world/worldgen';
import { Overmap, REGION } from '../src/world/overmap/overmap';
import { SM_SIZE, specialMonGroups, type MonGroup } from '../src/world/overmap/mongroups';
import { CHUNK } from '../src/world/coords';
import { registerCoreSaveables } from '../src/save/builtins';
import { applySave, serializeGame } from '../src/save/format';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data, wg } = loadNodeData();

function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}

describe('specialMonGroups (BN place_special + add_mon_group)', () => {
  const spawns = (pop: number, rad: number) => ({ group: 'GROUP_ANT', population: [pop, pop] as [number, number], radius: [rad, rad] as [number, number] });

  it('radius 1 is one group holding the whole population; radius 0 too', () => {
    for (const rad of [0, 1]) {
      const gs = specialMonGroups(1, 77, spawns(1234, rad), 10, -3, 0);
      expect(gs).toHaveLength(1);
      expect(gs[0]).toMatchObject({ sx: 20, sy: -6, z: 0, population: 1234, group: 'GROUP_ANT', special: 77 });
    }
  });

  it('splits a big group over the disc, denser at the centre, with BN totals', () => {
    const pop = 1500, rad = 20;
    const gs = specialMonGroups(5, 9, spawns(pop, rad), 40, 40, 0);
    const total = rad * rad * Math.PI + 1;
    let floorSum = 0, cells = 0;
    for (let dx = -rad; dx <= rad; dx++)
      for (let dy = -rad; dy <= rad; dy++) {
        const d = Math.trunc(Math.hypot(dx, dy));
        if (d > rad) continue;
        floorSum += Math.floor(((rad - d) / rad) * pop / total);
        cells++;
      }
    const sum = gs.reduce((a, g) => a + g.population, 0);
    // each submap rounds its fraction up at most once
    expect(sum).toBeGreaterThanOrEqual(floorSum);
    expect(sum).toBeLessThanOrEqual(floorSum + cells);
    // about a third of the population (the linear fall-off)
    expect(sum / pop).toBeGreaterThan(0.25);
    expect(sum / pop).toBeLessThan(0.42);
    for (const g of gs) {
      expect(Math.trunc(Math.hypot(g.sx - 80, g.sy - 80))).toBeLessThan(rad);
      expect(g.key).toBe(`${g.sx},${g.sy},0,9`);
    }
    // deterministic per (seed, special)
    expect(specialMonGroups(5, 9, spawns(pop, rad), 40, 40, 0)).toEqual(gs);
    expect(specialMonGroups(6, 9, spawns(pop, rad), 40, 40, 0)).not.toEqual(gs);
  });

  it('rolls population and radius inside their BN ranges', () => {
    const def = { group: 'GROUP_GOO', population: [100, 200] as [number, number], radius: [2, 10] as [number, number] };
    for (let uid = 1; uid < 40; uid++) {
      const gs = specialMonGroups(3, uid, def, 0, 0, 0);
      const reach = Math.max(...gs.map((g) => Math.max(Math.abs(g.sx), Math.abs(g.sy))));
      expect(reach).toBeLessThanOrEqual(10);
    }
  });
});

describe('overmap places special spawns (genVersion 3)', () => {
  /** Every special that placed groups in the 3x3 regions around the start. */
  function placed(om: Overmap) {
    const out = new Map<number, { def: string; x: number; y: number; groups: readonly MonGroup[] }>();
    for (let ry = -1; ry <= 1; ry++)
      for (let rx = -1; rx <= 1; rx++)
        for (let y = 0; y < REGION; y++)
          for (let x = 0; x < REGION; x++) {
            const s = om.omtAt(rx * REGION + x, ry * REGION + y, 0).special;
            if (s && !out.has(s.uid)) out.set(s.uid, { def: s.def, x: s.x, y: s.y, groups: om.monGroupsOf(s.uid) });
          }
    return out;
  }

  it('gives every placed special with BN spawns its group, at its origin, within its radius', () => {
    const om = new Overmap(2, wg.overmap);
    const defs = new Set<string>();
    for (const s of placed(om).values()) {
      const sp = wg.overmap.mutables[s.def]?.spawns ?? wg.overmap.specials[s.def]?.spawns;
      if (!sp) {
        expect(s.groups, s.def).toHaveLength(0);
        continue;
      }
      defs.add(s.def);
      expect(s.groups.length, s.def).toBeGreaterThan(0);
      for (const g of s.groups) {
        expect(g.group).toBe(sp.group);
        expect(g.z).toBe(0);
        expect(Math.trunc(Math.hypot(g.sx - s.x * 2, g.sy - s.y * 2))).toBeLessThanOrEqual(Math.max(1, sp.radius[1]));
        expect(om.monGroupsAt(g.sx, g.sy)).toContain(g);
      }
      const pop = s.groups.reduce((a, g) => a + g.population, 0);
      expect(pop).toBeLessThanOrEqual(sp.population[1]);
    }
    // seed 2 has anthills (fixed-root mutable), a lab anthill, slime pits and the city-park growths
    for (const d of ['Anthill', 'Lab with Anthill', 'Slime Pit', 'triffid_sprout', 'fungal_buds', 'mi-go_foward_camp']) expect(defs, d).toContain(d);
  }, 120_000);

  it('genVersion 2 worlds place none', () => {
    const om = new Overmap(2, wg.overmap, 2);
    for (const s of placed(om).values()) expect(s.groups, s.def).toHaveLength(0);
    const ant = om.findSpecial('Anthill', { x: 0, y: 0 }, 1)!;
    expect(ant).toBeDefined();
    for (let dy = -30; dy <= 30; dy++) for (let dx = -30; dx <= 30; dx++) expect(om.monGroupsAt(ant.x * 2 + dx, ant.y * 2 + dy)).toHaveLength(0);
  }, 120_000);

  it('ships BN spawns for every special that has them', () => {
    expect(wg.overmap.mutables.Anthill.spawns).toEqual({ group: 'GROUP_ANT', population: [1000, 2000], radius: [10, 30] });
    expect(wg.overmap.mutables['Acid Anthill'].spawns?.group).toBe('GROUP_ANT_ACID');
    expect(wg.overmap.mutables['Slime Pit'].spawns).toEqual({ group: 'GROUP_GOO', population: [100, 200], radius: [2, 10] });
    expect(wg.overmap.specials.fungal_buds.spawns).toEqual({ group: 'GROUP_FUNGI_BUDS', population: [200, 320], radius: [0, 20] });
    expect(wg.overmap.specials.triffid_sprout.spawns?.group).toBe('GROUP_TRIFFID_OUTER');
    expect(wg.overmap.specials['mi-go_foward_camp'].spawns?.group).toBe('GROUP_MI-GO_CAMP_OM');
    for (const s of [...Object.values(wg.overmap.specials), ...Object.values(wg.overmap.mutables)])
      if (s.spawns) expect(data.monsterGroups[s.spawns.group], `${s.id}: ${s.spawns.group}`).toBeDefined();
  });
});

interface World {
  game: Game;
  sys: MonsterSystem;
  spawner: Spawner;
  mg: MonGroupSpawner;
  worldgen: WorldGenerator;
}

function build(seed: number, genVersion?: number): World {
  const game = new Game(data, seed, fakeInput());
  const worldgen = new WorldGenerator(seed, wg, data, genVersion);
  worldgen.stats.quiet = true;
  game.map.generator = worldgen;
  const sys = new MonsterSystem(game);
  const spawner = new Spawner(sys, null);
  registerCoreSaveables(game, { monsters: { sys, spawner }, worldgen });
  const mg = installMonGroups(game, sys, worldgen.overmap, spawner);
  return { game, sys, spawner, mg, worldgen };
}

/** Put the survivor at a tile and generate the bubble's chunks (z0 and the level above). */
function standAt(w: World, x: number, y: number): void {
  const p = w.game.player;
  p.x = x + 0.5;
  p.y = y + 0.5;
  p.z = 0;
  const r = Math.ceil(((BUBBLE_SUBMAPS + 1) * SM_SIZE) / CHUNK);
  const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) for (const z of [0, 1]) w.game.map.chunk(cx + dx, cy + dy, z);
}

const ANTS = new Set(['mon_ant', 'mon_ant_larva', 'mon_ant_soldier', 'mon_ant_queen']);

describe('special spawn groups materialise near the survivor', () => {
  it('walking up to an anthill brings its colony out, ring by ring, and the population drains', () => {
    const w = build(2);
    const om = w.worldgen.overmap;
    const ant = om.findSpecial('Anthill', { x: 0, y: 0 }, 1)!;
    const groups = om.monGroupsOf(ant.uid);
    const unspent = () => groups.filter((g) => !w.mg.spent.has(g.key)).reduce((a, g) => a + g.population, 0);
    const start = unspent();
    // West of the hill with the bubble's east edge inside the colony's spread, then walk east onto it.
    const rad = Math.max(...groups.map((g) => Math.abs(g.sx - ant.x * 2)));
    expect(rad).toBeGreaterThanOrEqual(10);
    const off = Math.ceil((rad + 2) / 2);
    let x = (ant.x - off) * CHUNK + 12;
    const y = ant.y * CHUNK + 12;
    standAt(w, x, y);
    w.mg.scan();
    const first = new Set(w.mg.spent);
    let last = unspent();
    expect(last).toBeLessThan(start);
    // one submap per step, as walking crosses them
    for (let step = 0; step < 2 * off; step++) {
      x += SM_SIZE;
      standAt(w, x, y);
      const before = new Set(w.mg.spent);
      w.mg.scan();
      const now = unspent();
      expect(now).toBeLessThanOrEqual(last);
      last = now;
      // after the first scan, groups only spawn as their submap enters the bubble's edge
      const psx = Math.floor(x / SM_SIZE), psy = Math.floor(y / SM_SIZE);
      for (const k of w.mg.spent) {
        if (before.has(k)) continue;
        const [sx, sy] = k.split(',').map(Number);
        expect(Math.max(Math.abs(sx - psx), Math.abs(sy - psy))).toBe(BUBBLE_SUBMAPS);
      }
    }
    expect(w.mg.spent.size).toBeGreaterThan(first.size);
    const ants = w.sys.all.filter((m) => !m.dead && ANTS.has(m.type.id));
    expect(ants.length).toBeGreaterThan(20);
    expect(w.mg.stats.monsters).toBe(w.sys.all.length);
    for (const m of ants) {
      expect(m.z).toBe(0);
      expect(isOutside(w.game.map, m.tileX, m.tileY, 0)).toBe(true);
    }
    // standing on the hill, everything around has spawned: a rescan adds nothing
    expect(w.mg.scan()).toBe(0);
  }, 240_000);

  it('waits while spawns are held (title screen) and for ungenerated chunks', () => {
    const w = build(2);
    const ant = w.worldgen.overmap.findSpecial('Anthill', { x: 0, y: 0 }, 1)!;
    const p = w.game.player;
    p.x = ant.x * CHUNK + 12.5;
    p.y = ant.y * CHUNK + 12.5;
    // nothing generated yet: every group waits
    expect(w.mg.scan()).toBe(0);
    expect(w.mg.spent.size).toBe(0);
    standAt(w, ant.x * CHUNK + 12, ant.y * CHUNK + 12);
    w.spawner.hold();
    w.game.tick(1.1);
    expect(w.mg.spent.size).toBe(0);
    w.spawner.release();
    w.game.tick(1.1);
    expect(w.mg.spent.size).toBeGreaterThan(0);
    expect(w.sys.all.some((m) => ANTS.has(m.type.id))).toBe(true);
  }, 240_000);

  it('saves which groups are spent: a load spawns none of them again', () => {
    const A = build(2);
    const ant = A.worldgen.overmap.findSpecial('Anthill', { x: 0, y: 0 }, 1)!;
    standAt(A, ant.x * CHUNK + 12, ant.y * CHUNK + 12);
    A.mg.scan();
    const spentA = [...A.mg.spent].sort();
    const monsA = A.sys.all.filter((m) => !m.dead).length;
    expect(spentA.length).toBeGreaterThan(0);
    const file = serializeGame(A.game, { slot: 's', name: 'x', gen: 'world', genVersion: 3 });
    expect(file.sections.mongroups).toEqual(spentA);

    const B = build(2);
    applySave(B.game, JSON.parse(JSON.stringify(file)));
    expect([...B.mg.spent].sort()).toEqual(spentA);
    standAt(B, ant.x * CHUNK + 12, ant.y * CHUNK + 12);
    B.mg.scan();
    expect([...B.mg.spent].sort()).toEqual(spentA);
    expect(B.sys.all.filter((m) => !m.dead).length).toBe(monsA);

    // a save without the section (made before special spawns) has spent nothing
    const old = JSON.parse(JSON.stringify(file));
    delete old.sections.mongroups;
    const C = build(2);
    applySave(C.game, old);
    expect(C.mg.spent.size).toBe(0);
  }, 240_000);

  it('genVersion 2 worlds spawn nothing new', () => {
    const w = build(2, 2);
    const ant = w.worldgen.overmap.findSpecial('Anthill', { x: 0, y: 0 }, 1)!;
    standAt(w, ant.x * CHUNK + 12, ant.y * CHUNK + 12);
    expect(w.mg.scan()).toBe(0);
    expect(w.mg.spent.size).toBe(0);
    expect(w.sys.all).toHaveLength(0);
  }, 240_000);
});

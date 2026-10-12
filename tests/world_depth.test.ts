// BN's full z range (OVERMAP_DEPTH 10 / OVERMAP_HEIGHT 10, game_constants.h): the map holds
// z -10..10, genVersion 3 grows mutable specials (the classic lab's lab_basement first) down to
// -10, and genVersion 1/2 worlds keep generating exactly what they did when their z range was
// -7..5 (docs/WORLD_TRANSPORT.md "Full z range").
import { describe, expect, it } from 'vitest';
import { hashString } from '../src/core/rng';
import { CHUNK, MAX_Z, MIN_Z } from '../src/world/coords';
import { CLASSIC_LAB_SPECIAL, Overmap, REGION, genZRange } from '../src/world/overmap/overmap';
import { loadNodeData, makeMap } from '../tools/lib/node_data';
import { WorldGenerator } from '../src/world/worldgen';
import { hasFlag } from '../src/world/registry';
import { stairDestination } from '../src/game/zlevels';
import type { Game } from '../src/game/game';

const { game: data, wg } = loadNodeData();

/** Every OMT of a region over the whole z range, tagged with the special that owns it. */
function fullHash(om: Overmap, rx: number, ry: number): number {
  const parts: string[] = [];
  for (let z = -10; z <= 10; z++)
    for (let y = 0; y < REGION; y++)
      for (let x = 0; x < REGION; x++) {
        const o = om.omtAt(rx * REGION + x, ry * REGION + y, z);
        parts.push(o.special ? `${o.id}@${o.special.def}:${o.special.uid}` : o.id);
      }
  return hashString(parts.join('|'));
}

describe('z range', () => {
  it('is BN\'s -10..10 for the map; generation keeps -7..5 before genVersion 3', () => {
    expect([MIN_Z, MAX_Z]).toEqual([-10, 10]);
    expect(genZRange(1)).toEqual([-7, 5]);
    expect(genZRange(2)).toEqual([-7, 5]);
    expect(genZRange(3)).toEqual([-10, 10]);
  });

  // The genVersion 1/2 pins in overmap_genversion.test.ts cover z -7..1; these cover every level
  // the map can now ask for, so nothing new appears below -7 or above 5 in an old world. Recorded
  // on transport2-base (728c494) before the range widened.
  it('genVersion 1 and 2 generate the same OMTs on every level, z -10..10', () => {
    const got: Record<string, number> = {};
    for (const gen of [1, 2])
      for (const seed of [1, 42]) {
        const om = new Overmap(seed, wg.overmap, gen);
        for (const [rx, ry] of [[0, 0], [1, 0]]) got[`v${gen}:${seed}:${rx},${ry}`] = fullHash(om, rx, ry);
      }
    expect(got).toEqual(GOLDEN_FULL);
  }, 180_000);
});

const GOLDEN_FULL: Record<string, number> = {
  'v1:1:0,0': 2331024995, 'v1:1:1,0': 1638739679, 'v1:42:0,0': 1343859318, 'v1:42:1,0': 1085750145,
  'v2:1:0,0': 1997581478, 'v2:1:1,0': 2385806040, 'v2:42:0,0': 4137194368, 'v2:42:1,0': 3641182978,
};

// ------------------------------------------------------------------------------------------
// genVersion 3 labs reach their BN depth

interface LabOmt { x: number; y: number; z: number; type: string }
const regionOf = (ov: Overmap, rx: number, ry: number) => (ov as any).region(rx, ry) as { specials: { def: string; uid: number; x: number; y: number }[] };
function labOmts(ov: Overmap, sp: { x: number; y: number; uid: number }): LabOmt[] {
  const out: LabOmt[] = [];
  for (let z = -1; z >= -10; z--)
    for (let dy = -16; dy <= 16; dy++)
      for (let dx = -16; dx <= 16; dx++) {
        const o = ov.omtAt(sp.x + dx, sp.y + dy, z);
        if (o.special?.uid === sp.uid) out.push({ x: sp.x + dx, y: sp.y + dy, z, type: o.type });
      }
  return out;
}
function labsOf(gen: number): LabOmt[][] {
  const out: LabOmt[][] = [];
  for (let seed = 1; seed <= 6; seed++) {
    const ov = new Overmap(seed, wg.overmap, gen);
    for (const [rx, ry] of [[0, 0], [1, 0], [0, 1]])
      for (const sp of regionOf(ov, rx, ry).specials.filter((s) => s.def === CLASSIC_LAB_SPECIAL)) out.push(labOmts(ov, sp));
  }
  return out;
}

describe('genVersion 3 labs', () => {
  const v2 = labsOf(2), v3 = labsOf(3);
  /** Share of a lab's stair-over-core chunks on its bottom two levels (the pile-up). */
  const pile = (omts: LabOmt[]) => {
    const bottom = Math.min(...omts.map((o) => o.z));
    const stairs = omts.filter((o) => o.type === 'lab_stairs' || o.type === 'lab_core');
    return stairs.filter((o) => o.z <= bottom + 1).length / Math.max(1, stairs.length);
  };
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

  it('grow below z-7 down to BN\'s floor, never past it', () => {
    expect(v3.length).toBeGreaterThan(12);
    const bottoms = v3.map((l) => Math.min(...l.map((o) => o.z)));
    for (const b of bottoms) expect(b).toBeGreaterThanOrEqual(-10);
    expect(bottoms.filter((b) => b < -7).length / bottoms.length).toBeGreaterThan(0.5);
    // genVersion 2 is still clamped
    for (const l of v2) expect(Math.min(...l.map((o) => o.z))).toBeGreaterThanOrEqual(-7);
  });

  it('every lab_stairs is over a lab_core, finale on the bottom', () => {
    let finales = 0;
    for (const omts of v3) {
      const at = new Map(omts.map((o) => [`${o.x},${o.y},${o.z}`, o.type]));
      for (const o of omts) if (o.type === 'lab_stairs') expect(at.get(`${o.x},${o.y},${o.z - 1}`), `${o.x},${o.y},${o.z}`).toBe('lab_core');
      const bottom = Math.min(...omts.map((o) => o.z));
      if (omts.some((o) => o.type === 'lab_finale' && o.z === bottom)) finales++;
    }
    expect(finales / v3.length).toBeGreaterThan(0.9);
  });

  it('spread their stair chunks over more levels than the clamped genVersion 2 pile-up', () => {
    // v2: the leftover stair chunks crowd the two levels above the -7 floor
    expect(mean(v3.map(pile))).toBeLessThan(mean(v2.map(pile)));
  });
});

// ------------------------------------------------------------------------------------------
// the map at z -10

describe('z -10 chunks', () => {
  it('generate, and a deep lab\'s stairs lead down to its bottom level', () => {
    const ov = new Overmap(1, wg.overmap, 3);
    const labs = regionOf(ov, 0, 0).specials.filter((s) => s.def === CLASSIC_LAB_SPECIAL).map((sp) => labOmts(ov, sp));
    const deep = labs.find((l) => l.some((o) => o.z === -10));
    expect(deep, 'seed 1 region 0,0 has a lab down to z-10').toBeTruthy();
    const map = makeMap(data, 1);
    const gen = new WorldGenerator(1, wg, data, 3);
    gen.stats.quiet = true;
    map.generator = gen;
    // a stair chunk on z-9 and the core under it on z-10
    const st = deep!.find((o) => o.type === 'lab_stairs' && o.z === -9)!;
    expect(st).toBeTruthy();
    const below = map.chunk(st.x, st.y, -10)!;
    expect(below).not.toBeNull();
    expect(below.empty).toBe(false);
    const above = map.chunk(st.x, st.y, -9)!;
    expect(above.z).toBe(-9);
    // every staircase down in the stair chunk lands on stairs up on z-10 (zlevels' stair search)
    const game = { map } as unknown as Game;
    let down = 0, linked = 0;
    for (let ly = 0; ly < CHUNK; ly++)
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = st.x * CHUNK + lx, y = st.y * CHUNK + ly;
        if (!hasFlag(map.terAt(x, y, -9), 'GOES_DOWN')) continue;
        down++;
        const d = stairDestination(game, x, y, -9, 'down');
        if (d && d.z === -10 && hasFlag(map.terAt(d.x, d.y, d.z), 'GOES_UP')) linked++;
      }
    expect(down).toBeGreaterThan(0);
    expect(linked).toBe(down);
    // and nothing exists past BN's floor
    expect(map.chunk(st.x, st.y, -11)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------
// empty levels cost nothing: loops that read "every level above" stop at GameMap.topZ

import { Chunk } from '../src/world/map';
import { roomDependencySnapshot } from '../src/render/roomDependencies';

describe('GameMap.topZ', () => {
  it('tracks the highest populated level through generation, eviction, load and clear', () => {
    const map = makeMap(data, 1);
    map.generator = { generate: () => {} };
    expect(map.topZ()).toBe(MIN_Z - 1);
    map.chunk(0, 0, -3);
    expect(map.topZ()).toBe(-3);
    const c = map.chunk(0, 0, 2)!;
    expect(map.topZ()).toBe(2);
    map.evictChunk(c);
    expect(map.topZ()).toBe(-3);
    map.putChunk(new Chunk(1, 1, 7));
    map.putChunk(new Chunk(1, 1, 7)); // replacing a chunk doesn't count it twice
    expect(map.topZ()).toBe(7);
    map.evictChunk(map.chunk(1, 1, 7)!);
    expect(map.topZ()).toBe(-3);
    expect(() => map.putChunk(new Chunk(0, 0, MAX_Z + 1))).toThrow(/outside the map/);
    map.clearChunks();
    expect(map.topZ()).toBe(MIN_Z - 1);
  });

  it('a room snapshot still notices a chunk appearing above the old top', () => {
    const map = makeMap(data, 1);
    map.generator = { generate: () => {} };
    map.chunk(0, 0, 0);
    const valid = roomDependencySnapshot(map, 0, 5, 5);
    expect(valid()).toBe(true);
    map.chunk(4, 4, 6); // elsewhere: raises topZ, not this column
    expect(valid()).toBe(true);
    map.chunk(0, 0, 8); // a roof far above this column
    expect(valid()).toBe(false);
  });
});

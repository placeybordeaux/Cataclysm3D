import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { TerrainDef } from '../../src/data/types';
import { GameMap, type Chunk, type ChunkGenerator } from '../../src/world/map';
import { ChunkManager } from '../../src/render/chunkManager';
import { VisibleLevels, levelRadius, roofAbove, type OmtLookup } from '../../src/world/levels';
import type { SpriteLayer } from '../../src/render/sprites';
import type { TileFrame, TileTextureSource } from '../../src/render/textureSource';

// Which levels exist for the eye (src/world/levels.ts, docs/PERF.md "Levels from the world"):
// derived per column from what the world contains, never from a window around the player.
// The reports: from a z=3 roof the street was a flat pale sheet (only z-1 was built), and inside
// a fire station's two-storey engine bay the sky and the sun showed through the ceiling (the
// roof is at z+3, the window reached z+2).

/** The fire station column (seed 443226190, urban_32_*_south) and grass elsewhere. */
const FIRE: Record<number, string> = { [-1]: 'urban_32_2_south', 0: 'urban_32_6_south', 1: 'urban_32_10_south', 2: 'urban_32_14_south', 3: 'urban_32_18_south' };
const overmap: OmtLookup = {
  omtAt: (x, y, z) => ({ id: x === 0 && y === 0 && FIRE[z] ? FIRE[z] : z === 0 ? 'field' : z > 0 ? 'open_air' : 'empty_rock' }),
};

describe('levelRadius', () => {
  const R = 8;
  const set = (pz: number, top: number, below = 1, above = 2) => {
    const out: number[] = [];
    for (let z = -7; z <= 12; z++) if (levelRadius(z, pz, R, below, above, top) >= 0) out.push(z);
    return out;
  };

  it('on the surface in a field (top 1): the window, as before', () => {
    expect(set(0, 1)).toEqual([-1, 0, 1, 2]);
  });

  it('inside the fire station (top 4): up to the roof overlay, which the window (z+2) missed', () => {
    expect(set(0, 4)).toEqual([-1, 0, 1, 2, 3, 4]);
  });

  it('on a z=3 roof: the ground and every storey down to it', () => {
    expect(set(3, 4)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('underground: only the window, whatever is above (no surface through the ground)', () => {
    expect(set(-3, 4)).toEqual([-4, -3, -2, -1]);
  });

  it('no overmap (top unknown): the window, plus the ground from above', () => {
    expect(set(3, NaN)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(set(0, NaN)).toEqual([-1, 0, 1, 2]);
  });

  it('up a tall tower: the middle storeys at half radius, the ground and the window full', () => {
    expect(levelRadius(0, 12, R, 1, 2, 14)).toBe(R);
    expect(levelRadius(1, 12, R, 1, 2, 14)).toBe(R);
    expect(levelRadius(5, 12, R, 1, 2, 14)).toBe(4);
    expect(levelRadius(10, 12, R, 1, 2, 14)).toBe(R);
    expect(levelRadius(14, 12, R, 1, 2, 14)).toBe(R);
  });
});

describe('VisibleLevels', () => {
  it('reads a column top from the overmap: top OMT + the roof overlay', () => {
    const lv = new VisibleLevels(overmap);
    expect(lv.columnTop(0, 0)).toBe(4);
    expect(lv.columnTop(5, 5)).toBe(1);
  });

  it('a generated non-empty chunk above the overmap top raises it (a player-built floor)', () => {
    const lv = new VisibleLevels(overmap, { hasChunk: (cx, cy, z) => cx === 5 && cy === 5 && z === 3, chunk: () => ({ empty: false }) });
    lv.beginFrame();
    expect(lv.columnTop(5, 5)).toBe(3);
  });

  it("'window' mode is the old fixed window", () => {
    const lv = new VisibleLevels(overmap);
    lv.policy = { radius: 8, below: 1, above: 2, mode: 'window' };
    expect(lv.radiusAt(0, 0, 3, 0)).toBe(-1);
    lv.policy.mode = 'world';
    // above the window: R - 2 (far tower tops are deep in the haze)
    expect(lv.radiusAt(0, 0, 3, 0)).toBe(6);
    expect(lv.radiusAt(0, 0, 2, 0)).toBe(8);
  });

  it('drawn(): a zombie on the street is drawn from the roof; one in a far basement is not', () => {
    const lv = new VisibleLevels(overmap);
    lv.policy = { radius: 4, below: 1, above: 2, mode: 'world' };
    Object.assign(lv.eye, { x: 12, y: 12, z: 3 });
    expect(lv.drawn(30, 12, 0)).toBe(true);
    expect(lv.drawn(30, 12, -1)).toBe(false);
    expect(lv.drawn(24 * 9, 12, 0)).toBe(false); // outside the radius
  });
});

// ---- the chunk manager on a stub world with the fire station column at chunk (0, 0)

const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;
const frame: TileFrame = { texture: new THREE.Texture(), uv: [0, 0, 1, 1], w: 16, h: 16 };
const stubSource: TileTextureSource = { terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame };
const stubSprites = { addStatic: () => ({ setVisible() {}, dispose() {} }) } as unknown as SpriteLayer;

const FIRE_TER: Record<number, string> = { 0: 't_strconc_floor', 1: 't_open_air_rooved', 2: 't_grate', 3: 't_flat_roof' };
function world(): GameMap {
  const m = new GameMap(1);
  for (const t of Object.values(terrain)) m.terrain.add(t);
  const gen: ChunkGenerator = {
    generate(map, c: Chunk) {
      const fire = c.cx === 0 && c.cy === 0 && FIRE_TER[c.z];
      const id = fire || (c.z < 0 ? 't_rock' : c.z === 0 ? 't_grass' : 't_open_air');
      c.ter.fill(map.terrain.index(id));
      // (worldgen maintains `empty`; t_open_air_rooved is air you can see through, but not "nothing")
      c.empty = id === 't_open_air';
    },
  };
  m.generator = gen;
  return m;
}

function manager(): ChunkManager {
  const cm = new ChunkManager(world(), stubSprites, stubSource);
  cm.levels.overmap = overmap;
  cm.radius = 3;
  cm.levelsBelow = 1;
  cm.levelsAbove = 2;
  cm.audit = true;
  return cm;
}

const levelsBuilt = (cm: ChunkManager, cx: number, cy: number) => {
  const out: number[] = [];
  cm.forEachEntry((e) => void (e.cx === cx && e.cy === cy && e.shown && e.visible && out.push(e.z)));
  return out.sort((a, b) => a - b);
};

describe('ChunkManager levels', () => {
  it('inside the fire station bay the roof (z+3) and its overlay level are built', () => {
    const cm = manager();
    cm.update(12, 12, 0, () => true, true);
    expect(levelsBuilt(cm, 0, 0)).toEqual([-1, 0, 1, 2, 3, 4]);
    // a field column: just the window
    expect(levelsBuilt(cm, 2, 0)).toEqual([-1, 0, 1, 2]);
    expect(cm.levelMisses).toEqual([]);
  });

  it("on the roof: the ground under it too; underground: the surface isn't drawn (hysteresis may keep it, hidden)", () => {
    const cm = manager();
    cm.update(12, 12, 3, () => true, true);
    expect(levelsBuilt(cm, 0, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(levelsBuilt(cm, 2, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    cm.update(12, 12, -3, () => true, true);
    expect(levelsBuilt(cm, 0, 0)).toEqual([-4, -3, -2, -1]);
  });

  it('the guard: content on a level the extent misses is reported (the fixed-window bug)', () => {
    const cm = manager();
    // the old rule (window z-1..z+2) and nothing live: the roof at z3 exists and is never drawn
    cm.levels.policy.mode = 'window';
    cm.update(12, 12, 0, () => true, true);
    // content checks run only in 'world' mode (window mode is the known-broken A/B variant);
    // simulate a broken extent instead: an overmap that says the column is empty, no live map
    cm.levels.policy.mode = 'world';
    cm.levels.overmap = { omtAt: (_x, _y, z) => ({ id: z > 0 ? 'open_air' : 'field' }) };
    cm.levels.map = null;
    cm.auditLevels(12, 12, 0, false);
    expect(cm.levelMisses.filter((m) => m.why === 'content').map((m) => `${m.cx},${m.cy},${m.z}`)).toEqual(['0,0,3']);
  });
});

describe('roofAbove', () => {
  it('sees the fire station roof three levels up (the sky-light test)', () => {
    const m = world();
    // without a column top it reads only generated levels (no mapgen up to the sky)
    expect(roofAbove(m, 5, 5, 0)).toBe(false);
    expect(roofAbove(m, 5, 5, 0, 4)).toBe(true);
    for (let z = 0; z <= 4; z++) m.chunk(0, 0, z);
    expect(roofAbove(m, 5, 5, 0)).toBe(true);
    expect(roofAbove(m, 30, 5, 0)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { TerrainDef } from '../../src/data/types';
import { GameMap, type Chunk, type ChunkGenerator } from '../../src/world/map';
import { ChunkManager } from '../../src/render/chunkManager';
import { ChunkState, surroundingsDrawn } from '../../src/render/surroundings';
import type { OmtLookup } from '../../src/world/levels';
import type { SpriteLayer } from '../../src/render/sprites';
import type { TileFrame, TileTextureSource } from '../../src/render/textureSource';

// "Never draw the inside before the outside" (user report: zombies on the upper floors drawn
// before the walls around them). Creatures, corpses, vehicles, fire are drawn only once the
// chunk they stand in is built and on screen (src/render/surroundings.ts), not merely once their
// level "exists" for the eye (levels.ts drawn), which is true long before upper storeys are built.

type S = ChunkState;
const grid = (m: Record<string, S>) => (cx: number, cy: number, z: number): S => m[`${cx},${cy},${z}`] ?? ChunkState.None;

describe('surroundingsDrawn (the rule)', () => {
  it('own chunk: only when built and visible', () => {
    expect(surroundingsDrawn(grid({ '0,0,2': ChunkState.Shown }), 12, 12, 2)).toBe(true);
    expect(surroundingsDrawn(grid({ '0,0,2': ChunkState.Pending }), 12, 12, 2)).toBe(false);
    expect(surroundingsDrawn(grid({}), 12, 12, 2)).toBe(false); // no entry yet
    expect(surroundingsDrawn(grid({ '0,0,2': ChunkState.Hidden }), 12, 12, 2)).toBe(false); // top-down cutaway
  });

  it('near an edge, a neighbour still waiting for its first build holds it back (its walls enclose the entity)', () => {
    const m = { '0,0,0': ChunkState.Shown, '1,0,0': ChunkState.Pending } as Record<string, S>;
    expect(surroundingsDrawn(grid(m), 23.5, 12, 0)).toBe(false);
    expect(surroundingsDrawn(grid(m), 12, 12, 0)).toBe(true); // mid-chunk: the neighbour is not its surroundings
    expect(surroundingsDrawn(grid(m), 0.5, 12, 0)).toBe(true); // the west neighbour has no entry (beyond the radius)
    // corner: the diagonal counts too
    expect(surroundingsDrawn(grid({ '0,0,0': ChunkState.Shown, '1,1,0': ChunkState.Pending }), 23.5, 23.5, 0)).toBe(false);
    expect(surroundingsDrawn(grid({ '0,0,0': ChunkState.Shown, '1,0,0': ChunkState.Shown, '0,1,0': ChunkState.Hidden, '1,1,0': ChunkState.Shown }), 23.5, 23.5, 0)).toBe(true);
  });

  it('negative coordinates', () => {
    const m = { '-1,-1,0': ChunkState.Shown, '-2,-1,0': ChunkState.Pending } as Record<string, S>;
    expect(surroundingsDrawn(grid(m), -12, -12, 0)).toBe(true);
    expect(surroundingsDrawn(grid(m), -23.5, -12, 0)).toBe(false);
  });
});

// ---- the chunk manager on the fire-station world of tests/render/zlevels.test.ts

const FIRE: Record<number, string> = { [-1]: 'urban_32_2_south', 0: 'urban_32_6_south', 1: 'urban_32_10_south', 2: 'urban_32_14_south', 3: 'urban_32_18_south' };
const overmap: OmtLookup = {
  omtAt: (x, y, z) => ({ id: x === 0 && y === 0 && FIRE[z] ? FIRE[z] : z === 0 ? 'field' : z > 0 ? 'open_air' : 'empty_rock' }),
};
const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;
const frame: TileFrame = { texture: new THREE.Texture(), uv: [0, 0, 1, 1], w: 16, h: 16 };
const stubSource: TileTextureSource = { terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame };
const stubSprites = { addStatic: () => ({ setVisible() {}, dispose() {} }) } as unknown as SpriteLayer;
const FIRE_TER: Record<number, string> = { 0: 't_strconc_floor', 1: 't_open_air_rooved', 2: 't_grate', 3: 't_flat_roof' };

function manager(): ChunkManager {
  const m = new GameMap(1);
  for (const t of Object.values(terrain)) m.terrain.add(t);
  const gen: ChunkGenerator = {
    generate(map, c: Chunk) {
      const fire = c.cx === 0 && c.cy === 0 && FIRE_TER[c.z];
      const id = fire || (c.z < 0 ? 't_rock' : c.z === 0 ? 't_grass' : 't_open_air');
      c.ter.fill(map.terrain.index(id));
      c.empty = id === 't_open_air';
    },
  };
  m.generator = gen;
  const cm = new ChunkManager(m, stubSprites, stubSource);
  cm.levels.overmap = overmap;
  cm.radius = 4;
  cm.levelsBelow = 1;
  cm.levelsAbove = 1;
  cm.budgetMs = cm.boostBudgetMs = cm.urgentBudgetMs = cm.settleBudgetMs = cm.curtainBudgetMs = 0.5;
  return cm;
}

let now = 0;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => (now += 0.02));
});
afterEach(() => vi.restoreAllMocks());

describe('ChunkManager.drawnAt', () => {
  it('a zombie on the fire station catwalk (z 2, above the window) is never drawn before its chunk, though its level "exists" all along', () => {
    const cm = manager();
    // standing in the field next door, at the street level
    const px = 36, py = 12, pz = 0;
    let extentOnly = 0, drawn = 0;
    for (let f = 0; f < 400; f++) {
      cm.update(px, py, pz, () => true);
      now += 1000 / 60;
      const lv = cm.levels.drawn(12.5, 12.5, 2);
      const d = cm.drawnAt(12.5, 12.5, 2);
      // the invariant: drawn implies its geometry is on screen
      if (d) expect(cm.chunkState(0, 0, 2)).toBe(ChunkState.Shown);
      if (lv && !d) extentOnly++;
      if (d) drawn++;
    }
    // the old rule (levels.drawn) would have stood it in mid-air for these frames
    expect(extentOnly).toBeGreaterThan(0);
    expect(drawn).toBeGreaterThan(0);
  });

  it('entityRule false is the old rule (extent only)', () => {
    const cm = manager();
    cm.update(36, 12, 0, () => true);
    cm.entityRule = false;
    expect(cm.drawnAt(12.5, 12.5, 2)).toBe(cm.levels.drawn(12.5, 12.5, 2));
  });
});

describe('ChunkManager.missingAround (the load gate)', () => {
  it('everything missing before the first build, nothing after a flush; levels the column lacks are not wanted', () => {
    const cm = manager();
    cm.levels.eye.x = 12;
    cm.levels.eye.y = 12;
    const before = cm.missingAround(12, 12, 0, 40, 64);
    expect(before.core).toBe(9);
    expect(before.near).toBeGreaterThan(9);
    expect(before.far).toBe(before.wanted);
    cm.update(12, 12, 0, () => true, true);
    expect(cm.missingAround(12, 12, 0, 40, 64)).toMatchObject({ core: 0, near: 0, far: 0 });
    // 40 m reaches chunks 2 away (nearest point), 64 m three; 3 levels each
    expect(cm.missingAround(12, 12, 0, 40, 64).wanted).toBe(cm.missingAround(12, 12, 0, 64, 64).wanted);
  });

  it('climbing to a level never built: its chunks are missing again', () => {
    const cm = manager();
    cm.update(12, 12, 0, () => true, true);
    // radius 4 window [-1, 1]: z 2 of the field columns isn't built from z 0
    const up = cm.missingAround(36, 12, 1, 40, 64);
    expect(up.far).toBeGreaterThan(0);
    cm.update(36, 12, 1, () => true, true);
    expect(cm.missingAround(36, 12, 1, 40, 64).far).toBe(0);
  });
});

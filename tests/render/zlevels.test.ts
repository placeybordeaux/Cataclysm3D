import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { TerrainDef } from '../../src/data/types';
import { GameMap, type Chunk, type ChunkGenerator } from '../../src/world/map';
import { ChunkManager, levelRadius, lowestLevel } from '../../src/render/chunkManager';
import type { SpriteLayer } from '../../src/render/sprites';
import type { TileFrame, TileTextureSource } from '../../src/render/textureSource';

// Which levels are drawn, by the player's level (docs/PERF.md "Above ground"): from a rooftop
// the street below must be drawn (the report: "many z levels up it renders the ground as an
// odd white thing" — only one level below the player was built).

/** level -> radius for levels lowestLevel..pz+above (-1 = not drawn) */
function levels(pz: number, R = 8, below = 1, above = 2): Record<number, number> {
  const out: Record<number, number> = {};
  for (let z = lowestLevel(pz, below); z <= pz + above; z++) out[z] = levelRadius(z, pz, R, below, above);
  return out;
}

describe('levelRadius', () => {
  it('on the surface: one level below, the ones above (unchanged)', () => {
    expect(levels(0)).toEqual({ '-1': 8, 0: 8, 1: 8, 2: 8 });
  });

  it('on a z=3 roof: the ground and every storey down to it at full radius', () => {
    expect(levels(3)).toEqual({ 0: 8, 1: 8, 2: 8, 3: 8, 4: 8, 5: 8 });
  });

  it('never draws basements from above ground', () => {
    expect(levelRadius(-1, 3, 8, 1, 2)).toBe(-1);
    expect(levelRadius(-1, 1, 8, 1, 2)).toBe(-1);
    expect(lowestLevel(3, 1)).toBe(0);
  });

  it('up a tower: ground, z=1 and the storeys under the window full, the middle ones smaller', () => {
    const l = levels(12);
    expect(l[0]).toBe(8);
    expect(l[1]).toBe(8);
    for (const z of [9, 10, 11, 12, 13, 14]) expect(l[z]).toBe(8);
    for (let z = 2; z <= 8; z++) expect(l[z]).toBe(4);
  });

  it('in a basement: keeps the window, no surface through the ground', () => {
    expect(lowestLevel(-3, 1)).toBe(-4);
    expect(levels(-3)).toEqual({ '-4': 8, '-3': 8, '-2': 8, '-1': 8 });
    expect(levelRadius(0, -3, 8, 1, 2)).toBe(-1);
  });
});

// ---- the chunk manager on a stub world: grass at z 0, a building column at the origin

const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;
const frame: TileFrame = { texture: new THREE.Texture(), uv: [0, 0, 1, 1], w: 16, h: 16 };
const stubSource: TileTextureSource = { terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame };
const stubSprites = { addStatic: () => ({ setVisible() {}, dispose() {} }) } as unknown as SpriteLayer;

function manager(): ChunkManager {
  const m = new GameMap(1);
  for (const t of Object.values(terrain)) m.terrain.add(t);
  const gen: ChunkGenerator = {
    generate(map, c: Chunk) {
      const building = c.cx === 0 && c.cy === 0 && c.z >= 0 && c.z <= 3;
      c.ter.fill(map.terrain.index(c.z < 0 ? 't_rock' : c.z === 0 ? 't_grass' : building ? 't_floor' : 't_open_air'));
    },
  };
  m.generator = gen;
  const cm = new ChunkManager(m, stubSprites, stubSource);
  cm.radius = 3;
  cm.levelsBelow = 1;
  cm.levelsAbove = 1;
  return cm;
}

function entries(cm: ChunkManager): { z: number; shown: boolean; visible: boolean }[] {
  const out: { z: number; shown: boolean; visible: boolean }[] = [];
  cm.forEachEntry((e) => void out.push({ z: e.z, shown: !!e.shown, visible: e.visible }));
  return out;
}

describe('ChunkManager levels', () => {
  it('standing on a z=3 roof builds the ground level under it', () => {
    const cm = manager();
    cm.update(12, 12, 3, () => true, true);
    const e = entries(cm);
    const zs = [...new Set(e.map((x) => x.z))].sort((a, b) => a - b);
    expect(zs).toEqual([0, 1, 2, 3, 4]);
    const ground = e.filter((x) => x.z === 0);
    // the full circle of radius 3 around the player's chunk
    expect(ground.length).toBe(e.filter((x) => x.z === 3).length);
    expect(ground.every((x) => x.shown && x.visible)).toBe(true);
  });

  it('going back down drops the levels no longer wanted; going into a basement drops the surface', () => {
    const cm = manager();
    cm.update(12, 12, 3, () => true, true);
    cm.update(12, 12, 0, () => true, true);
    expect([...new Set(entries(cm).map((x) => x.z))].sort((a, b) => a - b)).toEqual([-1, 0, 1, 2]);
    cm.update(12, 12, -3, () => true, true);
    const zs = [...new Set(entries(cm).map((x) => x.z))].sort((a, b) => a - b);
    expect(zs.includes(0)).toBe(false);
  });

  it('a tower: the smaller middle storeys stay inside their radius', () => {
    const cm = manager();
    cm.radius = 6;
    cm.update(12, 12, 12, () => true, true);
    const R = levelRadius(5, 12, 6, 1, 1);
    expect(R).toBe(3);
    let far = 0;
    cm.forEachEntry((e) => {
      if (e.z === 5 && Math.hypot(e.cx, e.cy) > R + 0.5) far++;
    });
    expect(far).toBe(0);
    let ground = 0;
    cm.forEachEntry((e) => void (e.z === 0 && ground++));
    expect(ground).toBeGreaterThan(100);
  });
});

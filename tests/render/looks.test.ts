import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { FurnitureDef, TerrainDef } from '../../src/data/types';
import { GameMap, type Chunk, type ChunkGenerator } from '../../src/world/map';
import { CHUNK } from '../../src/world/coords';
import { lowResSize } from '../../src/render/grading';
import { GroundField, RAISE, hash2, vnoise } from '../../src/render/ground';
import { LOOKS, LOOK_NAMES, isLookName } from '../../src/render/look';
import { buildChunkMesh, ShapeTable } from '../../src/render/chunkMesh';
import type { TileFrame, TileTextureSource } from '../../src/render/textureSource';

const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;
const furniture = JSON.parse(readFileSync('public/data/furniture.json', 'utf8')) as Record<string, FurnitureDef>;

/** 3x3 chunks of grass at z=0 with a road column and a sidewalk column through chunk (0,0). */
function world(): GameMap {
  const m = new GameMap(1);
  for (const t of Object.values(terrain)) m.terrain.add(t);
  for (const f of Object.values(furniture)) m.furniture.add(f);
  const gen: ChunkGenerator = {
    generate(map, c: Chunk) {
      const fill = (id: string) => c.ter.fill(map.terrain.index(id));
      if (c.z !== 0) return fill(c.z < 0 ? 't_rock' : 't_open_air');
      fill('t_grass');
      if (c.cx !== 0 || c.cy !== 0) return;
      for (let y = 0; y < CHUNK; y++) {
        c.ter[y * CHUNK + 10] = map.terrain.index('t_pavement');
        c.ter[y * CHUNK + 11] = map.terrain.index('t_sidewalk');
      }
    },
  };
  m.generator = gen;
  for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) m.chunk(cx, cy, 0);
  return m;
}

describe('looks', () => {
  it('names are unique and valid', () => {
    expect(new Set(LOOK_NAMES).size).toBe(LOOK_NAMES.length);
    for (const n of LOOK_NAMES) expect(isLookName(n)).toBe(true);
    expect(isLookName('retro')).toBe(false);
  });
  it('full is the union of crisp, voxel and terrain', () => {
    const f = LOOKS.full;
    expect(f.autoRes && f.trees3d && f.voxelProps && f.archDetail && f.relief && f.grass && f.skyline).toBe(true);
    expect(LOOKS.classic.autoRes || LOOKS.classic.relief || LOOKS.classic.trees3d).toBe(false);
  });
});

describe('auto render resolution', () => {
  it('keeps the image 540-720 px tall with an integer upscale', () => {
    for (const [w, h, scale] of [[1920, 1080, 2], [2490, 1294, 2], [3440, 1304, 2], [2560, 1440, 2], [3840, 2160, 3]]) {
      const s = lowResSize(w, h, 0, 1);
      expect(s.scale).toBe(scale);
      expect(s.h - 2).toBeGreaterThanOrEqual(Math.min(540, h / 2));
      expect(s.h - 2).toBeLessThanOrEqual(720);
    }
  });
  it('an explicit height still wins', () => {
    expect(lowResSize(1920, 1080, 360, 1).scale).toBe(3);
  });
});

describe('ground field', () => {
  it('noise is deterministic and bounded', () => {
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    for (let i = 0; i < 50; i++) {
      const v = vnoise(i * 0.37, i * 0.91, 2);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('is flat when disabled', () => {
    const g = new GroundField(world());
    expect(g.heightAt(5.5, 5.5, 0)).toBe(0);
  });
  it('relief undulates on grass but never touches roads', () => {
    const g = new GroundField(world());
    g.relief = true;
    // road/sidewalk tiles and the corners they touch stay at 0
    for (let y = 0; y < CHUNK; y++) {
      expect(g.heightAt(10.5, y + 0.5, 0)).toBe(0);
      expect(g.corner(10, y, 0)).toBe(0);
      expect(g.corner(12, y, 0)).toBe(0);
    }
    // somewhere out in the field the ground is not flat
    let maxAbs = 0;
    for (let y = -20; y < 40; y++) for (let x = -20; x < 5; x++) maxAbs = Math.max(maxAbs, Math.abs(g.heightAt(x + 0.5, y + 0.5, 0)));
    expect(maxAbs).toBeGreaterThan(0.05);
    expect(maxAbs).toBeLessThan(0.7);
  });
  it('rural roads get a ditch one tile out', () => {
    const g = new GroundField(world());
    g.relief = true;
    // corner x=9 is one tile west of the road's west edge (x=10)
    let dips = 0;
    for (let y = 2; y < 22; y++) if (g.corner(9, y, 0) < -0.1) dips++;
    expect(dips).toBeGreaterThan(10);
  });
  it('curbs raise sidewalks', () => {
    const g = new GroundField(world());
    g.curbs = true;
    expect(g.heightAt(11.5, 3.5, 0)).toBe(RAISE);
    expect(g.heightAt(10.5, 3.5, 0)).toBe(0);
  });
});

describe('mesher with look extras', () => {
  const page = new THREE.Texture();
  const frame: TileFrame = { texture: page, uv: [0, 0, 1, 1], w: 16, h: 16 };
  const src: TileTextureSource = { terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame };
  it('draws curb skirts between the sidewalk and the road', () => {
    const m = world();
    const g = new GroundField(m);
    g.curbs = true;
    const plain = buildChunkMesh(m, new ShapeTable(m), src, m.chunk(0, 0, 0)!, 'summer');
    const curbed = buildChunkMesh(m, new ShapeTable(m), src, m.chunk(0, 0, 0)!, 'summer', undefined, {
      f: { ...LOOKS.classic, archDetail: true }, ground: g, white: frame, near: true,
    });
    const verts = (d: typeof plain) => [...d.pages.values()].reduce((n, b) => n + b.vertexCount, 0);
    // two skirts per sidewalk tile (road side and grass side), plus the two ends where the
    // sidewalk stops at the grass of the neighbouring chunks
    expect(verts(curbed) - verts(plain)).toBe((CHUNK * 2 + 2) * 4);
  });
});

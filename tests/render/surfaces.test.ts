import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { TerrainDef } from '../../src/data/types';
import { ceilMat, floorMat, paintFloor, paintInterior, paintShingles, paintWall, SurfacePainter, surfaceState, wallMat } from '../../src/render/surfaces';

const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;

describe('painted surfaces', () => {
  it('classifies the common walls, floors and ceilings', () => {
    expect(wallMat('t_brick_wall', [])).toBe('brick');
    expect(wallMat('t_wall', [])).toBe('stucco');
    expect(wallMat('t_wall_wood', [])).toBe('siding');
    expect(wallMat('t_concrete_wall', [])).toBe('concrete');
    expect(wallMat('t_wall_log', [])).toBe('log');
    expect(wallMat('t_rock', [])).toBe('rock');
    expect(floorMat('t_floor')).toBe('planks');
    expect(floorMat('t_carpet_red')).toBe('carpet');
    expect(floorMat('t_linoleum_white')).toBe('linoleum');
    expect(floorMat('t_thconc_floor')).toBe('concrete');
    expect(floorMat('t_pavement')).toBe('asphalt');
    // road markings and natural ground keep the tileset
    expect(floorMat('t_pavement_y')).toBeNull();
    expect(floorMat('t_grass')).toBeNull();
    expect(ceilMat('t_thconc_floor')).toBe('tiles');
    expect(ceilMat('t_floor')).toBe('plaster');
  });

  it('patterns tile at their frame size (brick bond parity survives the wrap)', () => {
    const img = paintWall('brick', [150, 60, 50], [200, 196, 186], 1);
    expect(img.w).toBe(32);
    expect((img.h / 3) % 2).toBe(0);
    for (const m of ['brick', 'adobe', 'stucco', 'siding', 'block', 'log', 'stone', 'metal', 'concrete', 'rock'] as const) {
      const w = paintWall(m, [120, 110, 100], [180, 176, 170], 2);
      expect(w.w, m).toBe(32);
      expect(w.data.every((v, i) => i % 4 !== 3 || v === 255), m).toBe(true);
    }
    for (const m of ['planks', 'carpet', 'linoleum', 'tile', 'concrete', 'asphalt', 'slabs', 'tar', 'metal'] as const) expect(paintFloor(m, [120, 100, 80], 1, 0).w).toBe(32);
    for (const m of ['paint', 'stripes', 'damask', 'wainscot', 'blockpaint'] as const) expect(paintInterior(m, [200, 196, 180], [150, 140, 130], 1).h).toBe(32);
    expect(paintShingles([90, 80, 70]).w).toBe(32);
  });

  it('paints every extracted terrain face without throwing, with or without a sprite', () => {
    surfaceState.enabled = true;
    surfaceState.style = 'painted';
    const p = new SurfacePainter(terrain);
    for (const id of Object.keys(terrain)) {
      for (const face of ['wall', 'floor', 'ceiling'] as const) {
        p.surface(id, face, undefined, () => null);
        if (face === 'wall') p.surface(id, face, { indoor: true, variantSeed: 12345 }, () => null);
      }
    }
    expect(p.active()).toBe(true);
    surfaceState.enabled = false;
    expect(p.active()).toBe(false);
  });
});

describe('fences', () => {
  it('kinds and every kind/connection builds', async () => {
    const { buildFence, buildGateLeaf, fenceKind } = await import('../../src/render/furniture/fences');
    const { ModelBuilder } = await import('../../src/render/furniture/mesh');
    const { ModelAtlas } = await import('../../src/render/furniture/atlas');
    expect(fenceKind('t_chainfence')).toBe('chain');
    expect(fenceKind('t_fence')).toBe('picket');
    expect(fenceKind('t_privacy_fence')).toBe('privacy');
    expect(fenceKind('t_metal_railing')).toBe('metal');
    expect(fenceKind('t_glass_railing')).toBe('glass');
    const atlas = new ModelAtlas();
    for (const k of ['picket', 'privacy', 'splitrail', 'chain', 'chicken', 'wire', 'metal', 'glass', 'concrete'] as const)
      for (const conn of [[false, false, false, false], [true, false, true, false], [true, true, true, true]]) {
        const b = new ModelBuilder(atlas);
        buildFence(b, k, conn, null);
        expect(b.done().quads, k).toBeGreaterThan(0);
        const g = new ModelBuilder(atlas);
        buildGateLeaf(g, k, null, 0.94);
        expect(g.done().quads).toBeGreaterThan(0);
      }
  });
});

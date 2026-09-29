import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { FurnitureDef, TerrainDef } from '../../src/data/types';
import { GameMap, type Chunk, type ChunkGenerator } from '../../src/world/map';
import { CHUNK, LEVEL_HEIGHT } from '../../src/world/coords';
import { buildChunkMesh, ShapeTable } from '../../src/render/chunkMesh';
import { furnitureShape, terrainShape } from '../../src/render/tileKinds';
import type { TileFrame, TileTextureSource } from '../../src/render/textureSource';

const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;
const furniture = JSON.parse(readFileSync('public/data/furniture.json', 'utf8')) as Record<string, FurnitureDef>;

describe('terrainShape', () => {
  const shape = (id: string) => terrainShape(terrain[id]);
  it('classifies common CDDA terrain', () => {
    expect(shape('t_grass')).toBe('floor');
    expect(shape('t_floor')).toBe('floor');
    expect(shape('t_wall')).toBe('wall');
    expect(shape('t_brick_wall')).toBe('wall');
    expect(shape('t_rock')).toBe('wall');
    expect(shape('t_window')).toBe('window');
    expect(shape('t_curtains')).toBe('window');
    expect(shape('t_door_c')).toBe('door');
    expect(shape('t_door_o')).toBe('door_open');
    expect(shape('t_fence')).toBe('fence');
    expect(shape('t_chainfence')).toBe('fence');
    expect(shape('t_tree')).toBe('tree');
    expect(shape('t_tree_young')).toBe('shrub');
    expect(shape('t_shrub')).toBe('shrub');
    expect(shape('t_water_sh')).toBe('liquid');
    expect(shape('t_water_dp')).toBe('liquid');
    expect(shape('t_open_air')).toBe('none');
    expect(shape('t_stairs_up')).toBe('stairs_up');
    expect(shape('t_stairs_down')).toBe('stairs_down');
  });
  it('classifies every extracted terrain without throwing', () => {
    for (const t of Object.values(terrain)) expect(typeof terrainShape(t)).toBe('string');
  });
  it('meshes box furniture and billboards the rest', () => {
    expect(furnitureShape(furniture.f_table)).toBe('table');
    expect(furnitureShape(furniture.f_counter)).toBe('counter');
    expect(furnitureShape(furniture.f_fridge)).toBe('cabinet');
    expect(furnitureShape(furniture.f_chair)).toBe('billboard');
    expect(furnitureShape(furniture.f_bed)).toBe('billboard');
  });
});

// --- mesher ------------------------------------------------------------------------------

const page = new THREE.Texture();
const frame: TileFrame = { texture: page, uv: [0, 0, 1, 1], w: 16, h: 16 };
const stubSource: TileTextureSource = {
  terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame,
};

/** Map from an ASCII plan at z=0 (rock below, open air above unless `roof`). */
function mapFrom(plan: string[], roof = false): GameMap {
  const legend: Record<string, string> = { '.': 't_grass', '#': 't_wall', '+': 't_door_c', '"': 't_window', ',': 't_floor', 'T': 't_tree', '~': 't_water_sh' };
  const m = new GameMap(1);
  for (const t of Object.values(terrain)) m.terrain.add(t);
  for (const f of Object.values(furniture)) m.furniture.add(f);
  const gen: ChunkGenerator = {
    generate(map, c: Chunk) {
      const fill = (id: string) => c.ter.fill(map.terrain.index(id));
      if (c.z < 0) return fill('t_rock');
      if (c.z > 0) return fill(roof && c.z === 1 ? 't_flat_roof' : 't_open_air');
      fill('t_grass');
      if (c.cx !== 0 || c.cy !== 0) return;
      plan.forEach((row, y) => [...row].forEach((ch, x) => (c.ter[y * CHUNK + x] = map.terrain.index(legend[ch]))));
    },
  };
  m.generator = gen;
  return m;
}

function build(plan: string[], roof = false) {
  const m = mapFrom(plan, roof);
  const data = buildChunkMesh(m, new ShapeTable(m), stubSource, m.chunk(0, 0, 0)!, 'summer');
  const g = data.pages.get(page)!.build();
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const cut = g.getAttribute('cut');
  return { data, g, quads: pos.count / 4, pos, nrm, cut };
}

describe('buildChunkMesh', () => {
  it('merges a whole chunk into one geometry per texture page', () => {
    const { data, quads } = build([]);
    expect(data.pages.size).toBe(1);
    // plain grass chunk: exactly one floor quad per tile, nothing else (rock below is solid)
    expect(quads).toBe(CHUNK * CHUNK);
  });

  it('emits only exposed wall faces', () => {
    const lone = build(['...', '.#.', '...']);
    // 575 floors + 4 sides + 1 cap
    expect(lone.quads).toBe(CHUNK * CHUNK - 1 + 5);
    const pair = build(['....', '.##.', '....']);
    // two walls sharing a face: 6 sides + 2 caps
    expect(pair.quads).toBe(CHUNK * CHUNK - 2 + 8);
  });

  it('builds walls up to the ceiling height with upward caps', () => {
    const { pos, nrm } = build(['...', '.#.', '...']);
    let maxY = -Infinity, caps = 0;
    for (let i = 0; i < pos.count; i++) {
      maxY = Math.max(maxY, pos.getY(i));
      if (nrm.getY(i) > 0.99 && pos.getY(i) > 1) caps++;
    }
    expect(maxY).toBeGreaterThan(LEVEL_HEIGHT - 0.2);
    expect(maxY).toBeLessThan(LEVEL_HEIGHT);
    expect(caps).toBe(4);
  });

  it('hides wall caps under a roof unless top-down cuts them (cut = 2)', () => {
    const { cut, nrm, pos } = build(['...', '.#.', '...'], true);
    let flagged = 0;
    for (let i = 0; i < pos.count; i++) if (nrm.getY(i) > 0.99 && pos.getY(i) > 1) expect(cut.getX(i)).toBe(2), flagged++;
    expect(flagged).toBe(4);
  });

  it('turns trees into sprites standing on a floor', () => {
    const { data } = build(['.T.']);
    const trees = data.sprites.filter((s) => s.kind === 'tree');
    expect(trees).toHaveLength(1);
    expect(trees[0].height).toBeGreaterThan(3);
  });

  it('sinks water below the ground with banks', () => {
    const { pos, nrm } = build(['...', '.~.', '...']);
    let water = 0;
    for (let i = 0; i < pos.count; i++) if (nrm.getY(i) > 0.99 && pos.getY(i) < -0.1) water++;
    expect(water).toBe(4);
  });
});

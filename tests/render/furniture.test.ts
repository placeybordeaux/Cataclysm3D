import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FurnitureDef, ItemDef } from '../../src/data/types';
import { ModelAtlas } from '../../src/render/furniture/atlas';
import { ARCHETYPE_KINDS, archetypeFor, terrainArchetype } from '../../src/render/furniture/catalog';
import { ModelBuilder } from '../../src/render/furniture/mesh';
import { flatPalette, spritePalette } from '../../src/render/furniture/palette';
import { faceKey, paintFace } from '../../src/render/furniture/paint';
import { buildItem, itemShape, itemSize } from '../../src/render/furniture/items';
import { buildDoorLeaf, buildWindow, doorKind, windowState } from '../../src/render/furniture/openings';
import { BACK, FRONT, LEFT, RIGHT, type Ctx } from '../../src/render/furniture/kit';

const furniture = JSON.parse(readFileSync('public/data/furniture.json', 'utf8')) as Record<string, FurnitureDef>;
const items = JSON.parse(readFileSync('public/data/items.json', 'utf8')) as Record<string, ItemDef>;

const ctx = (id: string, conn: boolean[] = [false, false, false, false]): Ctx => ({
  id, pal: flatPalette([140, 100, 70]), conn: conn as Ctx['conn'], wall: [true, false, false, false], seed: 7, p: archetypeFor(id)?.p ?? terrainArchetype(id)?.p ?? {},
});

/** Every vertex of a built model, for bounds checks. */
function verts(b: ModelBuilder): number[][] {
  const m = b.done();
  const out: number[][] = [];
  for (const pg of m.pages) for (let i = 0; i < pg.pos.length; i += 3) out.push([pg.pos[i], pg.pos[i + 1], pg.pos[i + 2]]);
  return out;
}

describe('furniture catalog', () => {
  it('maps the pieces seen most around the start to a model', () => {
    for (const id of ['f_table', 'f_chair', 'f_bench', 'f_bed', 'f_counter', 'f_sofa', 'f_cupboard', 'f_rack', 'f_desk', 'f_bookcase', 'f_sink', 'f_armchair',
      'f_dresser', 'f_bathtub', 'f_toilet', 'f_cardboard_box', 'f_coffee_table', 'f_floor_lamp', 'f_trashcan', 'f_entertainment_center', 'f_stool',
      'f_fridge', 'f_oven', 'f_wardrobe', 'f_locker', 'f_washer', 'f_mailbox', 'f_dumpster', 'f_shower', 'f_crate_c', 'f_street_light', 'f_boulder_small', 'f_grave_stone'])
      expect(archetypeFor(id), id).not.toBeNull();
    // plants stay on the voxel path (their sprites inflate well)
    expect(archetypeFor('f_dandelion')).toBeNull();
    expect(terrainArchetype('t_console')?.kind).toBe('console');
    expect(terrainArchetype('t_wall')).toBeNull();
  });

  it('every catalogued real furniture id builds a non-empty model inside its tile', () => {
    const atlas = new ModelAtlas();
    let n = 0;
    for (const id of Object.keys(furniture)) {
      const a = archetypeFor(id);
      if (!a) continue;
      for (const conn of [[false, false, false, false], [false, true, false, true], [true, true, true, true]]) {
        const b = new ModelBuilder(atlas);
        a.build(b, ctx(id, conn));
        const v = verts(b);
        expect(v.length, id).toBeGreaterThan(0);
        // tall street props reach over the street/yard on purpose
        if (['clothesline', 'pole', 'streetlight', 'flag'].includes(a.kind)) continue;
        for (const [x, , z] of v) {
          // pieces may overhang a hair (worktops, eaves of a mailbox) but never into the next tile
          expect(Math.abs(x), `${id} x`).toBeLessThanOrEqual(0.62);
          expect(Math.abs(z), `${id} z`).toBeLessThanOrEqual(1.5);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(ARCHETYPE_KINDS.length).toBeGreaterThan(40);
  });

  it('connected sides drop their end pieces (a sofa run has arms only at its ends)', () => {
    const atlas = new ModelAtlas();
    const count = (conn: boolean[]) => {
      const b = new ModelBuilder(atlas);
      archetypeFor('f_sofa')!.build(b, ctx('f_sofa', conn));
      return b.done().quads;
    };
    const single = count([false, false, false, false]);
    const middle = count([false, true, false, true]);
    expect(middle).toBeLessThan(single);
    void BACK; void FRONT; void LEFT; void RIGHT;
  });
});

describe('face painting', () => {
  it('is deterministic and keyed by material, size and decal', () => {
    const s = { mat: { kind: 'wood' as const, c: [120, 80, 50] as [number, number, number] } };
    const a = paintFace(s, 12, 20), b = paintFace(s, 12, 20);
    expect([...a.data]).toEqual([...b.data]);
    expect(faceKey(s, 12, 20)).not.toBe(faceKey(s, 20, 12));
    expect(faceKey(s, 12, 20)).not.toBe(faceKey({ ...s, bevel: false }, 12, 20));
  });

  it('the atlas memoises frames and keeps them inside the page', () => {
    const atlas = new ModelAtlas();
    const s = { mat: { kind: 'metal' as const, c: [120, 120, 120] as [number, number, number] } };
    const f1 = atlas.frame(faceKey(s, 10, 10), () => paintFace(s, 10, 10));
    const f2 = atlas.frame(faceKey(s, 10, 10), () => paintFace(s, 10, 10));
    expect(f1).toBe(f2);
    for (let i = 0; i < 3000; i++) atlas.frame(`k${i}`, () => paintFace(s, 5 + (i % 40), 3 + (i % 70)));
    expect(atlas.pageCount).toBeGreaterThanOrEqual(1);
    for (const v of f1.uv) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('sprite palette', () => {
  it('finds the top and front colours of a 3/4-view sprite and ignores outlines', () => {
    const w = 8, h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const edge = x === 0 || x === w - 1;
        const c = edge ? [5, 5, 5] : y < 4 ? [150, 150, 150] : [200, 180, 140];
        data.set([...c, 255], i);
      }
    const p = spritePalette({ w, h, data })!;
    expect(p.top[0]).toBeCloseTo(150, -1);
    expect(p.front[1]).toBeCloseTo(180, -1);
    expect(p.clusters.every((q) => q.c[0] > 20)).toBe(true);
  });
});

describe('windows and doors', () => {
  it('reads window states from ids', () => {
    expect(windowState('t_window_frame').glass).toBe('broken');
    expect(windowState('t_window_empty').glass).toBe('none');
    expect(windowState('t_window_domestic')).toMatchObject({ glass: 'intact', curtains: 'open' });
    expect(windowState('t_curtains').curtains).toBe('closed');
    expect(windowState('t_window_taped').taped).toBe(true);
    expect(windowState('t_window_bars').bars).toBe(true);
    expect(windowState('t_window_stained_red').glass).toBe('stained');
  });

  it('a broken window has shard geometry, an intact one glass', () => {
    const atlas = new ModelAtlas();
    const intact = new ModelBuilder(atlas);
    buildWindow(intact, windowState('t_window'), 1.2, [150, 60, 60]);
    expect(intact.done().glass?.pos.length).toBeGreaterThan(0);
    const broken = new ModelBuilder(atlas);
    buildWindow(broken, windowState('t_window_frame'), 1.2, [150, 60, 60]);
    const m = broken.done();
    expect(m.glass).toBeUndefined();
    expect(m.quads).toBeGreaterThan(8);
  });

  it('door kinds', () => {
    expect(doorKind('t_door_c')).toBe('wood');
    expect(doorKind('t_door_glass_c')).toBe('glass');
    expect(doorKind('t_door_metal_locked')).toBe('metal');
    expect(doorKind('t_door_b')).toBe('broken');
    expect(doorKind('t_door_frame')).toBe('frame');
    expect(doorKind('t_door_boarded')).toBe('boarded');
    const b = new ModelBuilder(new ModelAtlas());
    buildDoorLeaf(b, 'frame', 't_door_frame', null, 0.96, 2.1);
    expect(b.done().quads).toBe(0);
  });
});

describe('ground items', () => {
  it('picks a readable shape per item', () => {
    const shape = (id: string) => itemShape(items[id]);
    expect(shape('can_drink')).toBe('can');
    expect(shape('bottle_plastic')).toBe('bottle');
    expect(shape('stick')).toBe('stick');
    expect(shape('tshirt')).toBe('clothes');
    expect(shape('rock')).toBe('rock');
    expect(shape('knife_steak')).toBe('blade');
    expect(shape('jar_glass_sealed')).toBe('jar');
  });

  it('sizes small things up for readability and builds every shape', () => {
    expect(itemSize(250)).toBeGreaterThan(0.1);
    expect(itemSize(1e6)).toBeLessThanOrEqual(0.45);
    const atlas = new ModelAtlas();
    for (const s of ['box', 'bottle', 'can', 'jar', 'bag', 'clothes', 'book', 'paper', 'stick', 'blade', 'gun', 'rock', 'round', 'mug', 'device', 'blanket'] as const) {
      const b = new ModelBuilder(atlas);
      buildItem(b, s, 0.2, flatPalette([120, 60, 40]), 3);
      expect(b.done().quads, s).toBeGreaterThan(0);
    }
  });
});

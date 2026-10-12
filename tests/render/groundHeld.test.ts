import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ItemDef } from '../../src/data/types';
import { ModelAtlas } from '../../src/render/furniture/atlas';
import { ModelBuilder } from '../../src/render/furniture/mesh';
import { buildGroundHeld, groundHeldClass, groundItemState } from '../../src/render/furniture/groundHeld';
import { buildHeld } from '../../src/render/chars/held';
import { analyseSprite } from '../../src/render/chars/paint';
import { ModelFactory, modelStats } from '../../src/render/furniture/index';
import { GeomBuilder } from '../../src/render/geometry';
import { ProceduralTextureSource } from '../../src/render/proceduralSource';
import { loadNodeData } from '../../tools/lib/node_data';
import { Img } from '../../src/render/pixelArt';

// Dropped weapons drawn with their held mesh (docs/CHARACTERS.md "Held items", FURNITURE.md).

const items = JSON.parse(readFileSync('public/data/items.json', 'utf8')) as Record<string, ItemDef>;
const pal = analyseSprite({ w: 1, h: 1, data: new Uint8ClampedArray([120, 80, 50, 255]) }).pal;

function lay(id: string, side: 1 | -1 = 1) {
  const g = groundHeldClass(items[id]);
  if (!g) throw new Error(`${id} has no held class`);
  const b = new ModelBuilder(new ModelAtlas());
  const info = buildGroundHeld(b, buildHeld(g.cls, pal, items[id].volume, g.variant), side);
  const m = b.done();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const pg of m.pages) for (let i = 0; i < pg.pos.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], pg.pos[i]);
    hi[i % 3] = Math.max(hi[i % 3], pg.pos[i]);
  }
  return { info, quads: m.quads, lo, hi };
}

describe('dropped weapons: which items lie as their held mesh', () => {
  it('weapons and tools get their class and variant', () => {
    expect(groundHeldClass(items.marlin_1894c)).toEqual({ cls: 'rifle', variant: 'lever' });
    expect(groundHeldClass(items.glock_19)?.cls).toBe('pistol');
    expect(groundHeldClass(items.shotgun_d)).toEqual({ cls: 'shotgun', variant: 'double' });
    expect(groundHeldClass(items.katana)?.cls).toBe('sword');
    expect(groundHeldClass(items.fire_ax)).toEqual({ cls: 'axe', variant: 'fire' });
    expect(groundHeldClass(items.crowbar)).toEqual({ cls: 'pipe', variant: 'crowbar' });
    expect(groundHeldClass(items.pipe)?.cls).toBe('pipe');
    expect(groundHeldClass(items['2x4'])?.cls).toBe('bat');
    expect(groundHeldClass(items.flashlight)?.cls).toBe('flashlight');
  });

  it("heldClass's keyword accidents keep their generic shape", () => {
    // food, batteries, bows, phones, tobacco pipes: never a weapon mesh on the floor
    for (const id of ['chocolate', 'soap', 'light_battery_cell', 'longbow', 'smart_phone_flashlight', 'pipe_tobacco', 'electric_lantern', 'can_beans', 'golf_ball'])
      if (items[id]) expect(groundHeldClass(items[id]), id).toBeNull();
  });
});

describe('dropped weapons: the mesh at rest', () => {
  it('a rifle lies on its side on the surface, about its real length', () => {
    for (const side of [1, -1] as const) {
      const r = lay('marlin_1894c', side);
      expect(r.quads).toBeGreaterThan(60);
      expect(r.lo[1]).toBeCloseTo(0, 5);
      // lying down: low (a rifle on its side, lever loop and all), long
      expect(r.hi[1]).toBeLessThan(0.16);
      expect(r.info.len).toBeGreaterThan(0.85);
      expect(r.info.len).toBeLessThan(1.3);
      // centred on its footprint
      expect(Math.abs(r.lo[0] + r.hi[0])).toBeLessThan(1e-3);
      expect(Math.abs(r.lo[2] + r.hi[2])).toBeLessThan(1e-3);
    }
  });

  it('a knife lies on its flat, small things are scaled up, long ones fit a tile', () => {
    const k = lay('knife_combat');
    expect(k.hi[1]).toBeLessThan(0.06);
    expect(k.info.len).toBeGreaterThanOrEqual(0.33);
    const p = lay('glock_19');
    expect(p.info.s).toBeGreaterThan(1);
    expect(p.info.len).toBeGreaterThanOrEqual(0.33);
    const s = lay('spear_wood');
    expect(s.info.len).toBeLessThanOrEqual(1.3 + 1e-6);
  });
});

describe('dropped weapons: ModelFactory', () => {
  const { game } = loadNodeData();
  // item sprites: one brown frame for everything (the procedural glyphs need a DOM canvas)
  const proc = new ProceduralTextureSource(game);
  const brown = proc.custom('test-brown', () => {
    const im = new Img(8, 8);
    im.fill([120, 80, 50]);
    return im;
  });
  const src = new Proxy(proc, { get: (t, k) => (k === 'item' ? () => brown : Reflect.get(t, k)) });

  function bake(style: 'held' | 'shape', ids: string[]) {
    const prev = groundItemState.style;
    groundItemState.style = style;
    try {
      const mf = new ModelFactory();
      mf.itemDefs = game.items;
      const geo = new Map<unknown, GeomBuilder>();
      const get = (f: { texture: unknown }) => {
        let g = geo.get(f.texture);
        if (!g) geo.set(f.texture, (g = new GeomBuilder()));
        return g;
      };
      const before = modelStats.quads;
      ids.forEach((id, k) => expect(mf.item(get as never, src, id, 10, 10, 0, 0x5eed1234, k, false, ids.length - 1 - k)).toBe(true));
      return modelStats.quads - before;
    } finally {
      groundItemState.style = prev;
    }
  }

  it('bakes the held mesh by default and the generic shape on the v2 switch', () => {
    const held = bake('held', ['marlin_1894c']);
    const shape = bake('shape', ['marlin_1894c']);
    expect(held).toBeGreaterThan(shape * 4);
  });

  it('heldOnly (the billboard looks) declines items without a held mesh', () => {
    const mf = new ModelFactory();
    mf.itemDefs = game.items;
    const g = new GeomBuilder();
    expect(mf.item(() => g, src, 'can_beans', 0, 0, 0, 1, 0, true)).toBe(false);
    expect(mf.item(() => g, src, 'marlin_1894c', 0, 0, 0, 1, 0, true)).toBe(true);
  });

  it('a pile of guns bakes without error and each id is built once per side', () => {
    const mf = new ModelFactory();
    mf.itemDefs = game.items;
    const g = new GeomBuilder();
    const built = modelStats.built;
    for (let i = 0; i < 50; i++) mf.item(() => g, src, i % 2 ? 'ak47' : 'marlin_1894c', i % 7, i % 5, 0, 0x1234567 + i * 7919, i % 3, false, 2 - (i % 3));
    expect(modelStats.built - built).toBeLessThanOrEqual(4);
  });
});

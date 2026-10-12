import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ItemDef } from '../../src/data/types';
import { buildHeld } from '../../src/render/chars/held';
import { analyseSprite } from '../../src/render/chars/paint';
import { groundHeldClass } from '../../src/render/furniture/groundHeld';
import { heldIconPixels, type IconPixels } from '../../src/render/heldIcon';

// Inventory icons drawn from the held mesh for weapons the tileset never drew (heldIcon.ts).

const items = JSON.parse(readFileSync('public/data/items.json', 'utf8')) as Record<string, ItemDef>;
const pal = analyseSprite({ w: 1, h: 1, data: new Uint8ClampedArray([120, 80, 50, 255]) }).pal;

function icon(id: string): IconPixels {
  const g = groundHeldClass(items[id]);
  if (!g) throw new Error(`${id} has no held class`);
  return heldIconPixels(buildHeld(g.cls, pal, items[id].volume, g.variant));
}

/** Opaque bounding box [x0, y0, x1, y1] (exclusive) and pixel count. */
function bounds(img: IconPixels) {
  let x0 = img.w, y0 = img.h, x1 = 0, y1 = 0, n = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (!img.data[(y * img.w + x) * 4 + 3]) continue;
    n++;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  return { x0, y0, x1, y1, n };
}

describe('held-mesh icons', () => {
  it('a long gun is side-on, long and thin, inside the 32 px cell', () => {
    const img = icon('marlin_1894c');
    expect([img.w, img.h]).toEqual([32, 32]);
    const b = bounds(img);
    expect(b.x1 - b.x0).toBeGreaterThanOrEqual(24);
    expect(b.y1 - b.y0).toBeLessThanOrEqual(10);
    expect(b.x0).toBeGreaterThanOrEqual(0);
    expect(b.x1).toBeLessThanOrEqual(32);
  });

  it('pixels are hard: fully opaque or empty, with a dark outline', () => {
    const img = icon('marlin_1894c');
    let dark = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      expect([0, 255]).toContain(img.data[i + 3]);
      if (img.data[i + 3] && img.data[i] + img.data[i + 1] + img.data[i + 2] < 60) dark++;
    }
    expect(dark).toBeGreaterThan(20);
  });

  it('a pistol is shorter than a rifle but still readable', () => {
    const p = bounds(icon('glock_19')), r = bounds(icon('marlin_1894c'));
    expect(p.x1 - p.x0).toBeLessThan(r.x1 - r.x0);
    expect(p.x1 - p.x0).toBeGreaterThanOrEqual(10);
  });

  it('melee weapons lie on the diagonal, head top-right', () => {
    const img = icon('katana');
    const b = bounds(img);
    expect(Math.abs((b.x1 - b.x0) - (b.y1 - b.y0))).toBeLessThanOrEqual(6);
    // the top-right quadrant of the box holds the blade, the bottom-left the grip
    const at = (x: number, y: number) => img.data[(y * 32 + x) * 4 + 3] > 0;
    expect(at(b.x1 - 2, b.y0 + 1) || at(b.x1 - 1, b.y0 + 1) || at(b.x1 - 2, b.y0)).toBe(true);
    expect(at(b.x0 + 1, b.y1 - 2) || at(b.x0, b.y1 - 2) || at(b.x0 + 1, b.y1 - 1)).toBe(true);
  });

  it('is deterministic', () => {
    expect(Buffer.from(icon('ak47').data)).toEqual(Buffer.from(icon('ak47').data));
  });
});

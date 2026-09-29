import { describe, expect, it } from 'vitest';
import { buildLut, buildPalette, fromOklab, grade, lowResSize, nearest, toOklab, type RGBf } from '../../src/render/grading';

const hex = (h: number): RGBf => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const pal = buildPalette();
const lab = pal.map(toOklab);
const snap = (h: number) => nearest(lab, pal, grade(hex(h)));

describe('grading', () => {
  it('oklab round-trips', () => {
    for (const c of [hex(0x123456), hex(0xffffff), hex(0x000000), hex(0xc86432)]) {
      const r = fromOklab(toOklab(c));
      for (let i = 0; i < 3; i++) expect(r[i]).toBeCloseTo(c[i], 3);
    }
  });

  it('keeps sky blues blue (no pink horizon)', () => {
    for (const h of [0xb4c4d0, 0xa8b4bc, 0x9aa8c0, 0x4c78b0, 0xc0c8d0, 0x8898b0]) {
      const c = snap(h);
      expect(c[2], `#${h.toString(16)} -> ${c.map((v) => Math.round(v * 255))}`).toBeGreaterThanOrEqual(c[0]);
    }
  });

  it('keeps greens green and blood red red', () => {
    const g = snap(0x4f6a30);
    expect(g[1]).toBeGreaterThan(g[0]);
    expect(g[1]).toBeGreaterThan(g[2]);
    const r = snap(0x8a1010);
    expect(r[0]).toBeGreaterThan(r[1] * 1.5);
  });

  it('maps black to near-black and white to near-white', () => {
    expect(Math.max(...snap(0x000000))).toBeLessThan(0.08);
    expect(Math.min(...snap(0xffffff))).toBeGreaterThan(0.8);
  });

  it('builds LUTs of the right size', () => {
    expect(buildLut(8, 'smooth').length).toBe(8 * 8 * 8 * 4);
    expect(buildLut(4, 'palette').length).toBe(4 * 4 * 4 * 4);
  });

  it('picks an integer upscale that divides the screen', () => {
    expect(lowResSize(1920, 1080, 360, 0)).toEqual({ scale: 3, w: 640, h: 360 });
    expect(lowResSize(2560, 1440, 360, 0)).toEqual({ scale: 4, w: 640, h: 360 });
    expect(lowResSize(960, 540, 360, 1)).toEqual({ scale: 2, w: 482, h: 272 });
    expect(lowResSize(300, 200, 360, 0).scale).toBe(1);
  });
});

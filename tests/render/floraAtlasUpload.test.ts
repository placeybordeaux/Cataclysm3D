import { describe, expect, it } from 'vitest';
import { FloraAtlas } from '../../src/render/floraArt';
import { Img } from '../../src/render/pixelArt';

const PAGE = 2048;
const FULL_PAGE_BYTES = PAGE * PAGE * 4;

function solid(w: number, h: number, v: number): Img {
  const img = new Img(w, h);
  img.fill([v, v, v]);
  return img;
}

/** Sum of queued update-range byte counts (what WebGLTextures.updateTexture will actually
 *  texSubImage2D), or -1 if no ranges are queued (Three then re-uploads the whole page). */
function queuedBytes(atlas: FloraAtlas): number {
  const ranges = atlas.texture.updateRanges;
  if (ranges.length === 0) return -1;
  return ranges.reduce((sum, r) => sum + r.count, 0);
}

describe('flora atlas first-use upload', () => {
  it('requests only the painted rows, not the whole page', () => {
    const atlas = new FloraAtlas();
    atlas.frame('a', false, () => solid(32, 32, 10));
    const bytes = queuedBytes(atlas);
    expect(bytes).toBeGreaterThan(0);
    // Padded tile is 40x40; well under 1% of the 2048^2 page's bytes.
    expect(bytes).toBeLessThan(FULL_PAGE_BYTES * 0.01);
    atlas.texture.clearUpdateRanges();
  });

  it('never re-requests a cached key, and accumulates ranges across distinct paints', () => {
    const atlas = new FloraAtlas();
    atlas.frame('a', false, () => solid(32, 32, 10));
    const firstBytes = queuedBytes(atlas);
    atlas.texture.clearUpdateRanges();
    expect(atlas.frame('a', false, () => { throw new Error('should not repaint a cached key'); })).toBeDefined();
    expect(queuedBytes(atlas)).toBe(-1); // nothing queued: the cache hit never touched the texture
    atlas.frame('b', false, () => solid(16, 16, 20));
    const secondBytes = queuedBytes(atlas);
    expect(secondBytes).toBeGreaterThan(0);
    expect(secondBytes).toBeLessThan(firstBytes); // smaller tile, smaller request
  });

  it('matches the exact painted pixels through the resulting UV rect', () => {
    const atlas = new FloraAtlas();
    const img = new Img(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) img.set(x, y, [x * 10, y * 10, 99]);
    const f = atlas.frame('px', false, () => img);
    const [u0, v0] = f.uv;
    const col0 = Math.round(u0 * PAGE), row0 = Math.round(v0 * PAGE); // page rows run bottom-up
    const px = (atlas as unknown as { px: Uint8Array }).px;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const d = ((row0 + 3 - y) * PAGE + col0 + x) * 4;
      expect([px[d], px[d + 1], px[d + 2]]).toEqual([x * 10, y * 10, 99]);
    }
    expect(Math.round((f.uv[2] - u0) * PAGE)).toBe(4);
  });

  it('diagnostic partialUpload=false reproduces the pre-fix full-page request', () => {
    const atlas = new FloraAtlas();
    atlas.partialUpload = false;
    atlas.frame('a', false, () => solid(32, 32, 10));
    expect(queuedBytes(atlas)).toBe(-1); // no ranges queued -> Three uploads the whole page
  });

  it('a full new palette page (many distinct frames) stays far below one full-page re-upload per frame', () => {
    const atlas = new FloraAtlas();
    let total = 0;
    for (let i = 0; i < 40; i++) {
      atlas.frame(`k${i}`, false, () => solid(24, 24, i));
      total += queuedBytes(atlas);
      atlas.texture.clearUpdateRanges();
    }
    // 40 small palettes queued one at a time, summed, should still be a small fraction of
    // what 40 *separate full-page* uploads would have cost.
    expect(total).toBeLessThan(FULL_PAGE_BYTES * 0.1);
  });
});

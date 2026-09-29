import { describe, expect, it } from 'vitest';
import { asciiFontPx, GLYPH_H, logoScale, textBitmap } from '../src/ui/titlelogo';

describe('title logo (QA_V2 #21: the ASCII logo was hard to read)', () => {
  it('lays the words out on the pixel font: 7 rows, a column between letters, wider gaps for spaces', () => {
    const m = textBitmap('Cataclysm');
    expect(m.length).toBe(GLYPH_H);
    expect(m[0].length).toBe(9 * 5 + 8);
    // 12 letters (the two I's are 3 wide), a 2-column space, 12 separators
    expect(textBitmap('Bright Nights')[0].length).toBe(12 * 5 - 2 * 2 + 2 + 12);
    expect(() => textBitmap('Cataclysm: DDA')).toThrow(/no glyph/);
  });

  it('always draws at a whole-pixel scale that fits the window, never below 2', () => {
    const cols = textBitmap('Cataclysm')[0].length;
    for (const w of [640, 960, 1366, 1920, 3840]) {
      const s = logoScale(cols, w);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(2);
      if (s > 2) expect(s * cols).toBeLessThanOrEqual(w * 0.8);
    }
  });

  it('the ASCII option uses an integer font size that fits 80 columns', () => {
    for (const [w, h] of [[960, 540], [1920, 1080], [1280, 1024]]) {
      const px = asciiFontPx(w, h);
      expect(Number.isInteger(px)).toBe(true);
      expect(px * 0.5 * 80).toBeLessThanOrEqual(w * 0.9 + 1);
    }
  });
});

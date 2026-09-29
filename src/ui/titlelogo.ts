// The title screen's logo. QA: CDDA's ASCII-art logo (ui.json `title`, from BN's
// data/title/en.title) was hard to read at many window sizes: an 80-column drawing in a bitmap
// font scaled to fractional sizes, dim blue on a dark, moving backdrop. The default is now a
// pixel-art logo drawn at an integer scale (crisp at any size, big blocky letters with an
// outline and a drop shadow so it reads over the world behind it). The ASCII art stays one
// option away (Options > Title logo, or ?logo=ascii), drawn at an integer font size.

/** 5×7 glyphs (I is 3 wide), '#' = on. Only the letters the logo needs. */
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
};
export const GLYPH_H = 7;

/** A line of text as rows of booleans: 1 column between letters, a space 2 more. Throws on a letter the font lacks. */
export function textBitmap(text: string): boolean[][] {
  const rows: boolean[][] = Array.from({ length: GLYPH_H }, () => []);
  [...text.toUpperCase()].forEach((ch, i) => {
    if (i > 0) for (const r of rows) r.push(false);
    if (ch === ' ') {
      for (const r of rows) r.push(false, false);
      return;
    }
    const g = GLYPHS[ch];
    if (!g) throw new Error(`titlelogo: no glyph for "${ch}"`);
    g.forEach((line, y) => rows[y].push(...[...line].map((c) => c === '#')));
  });
  return rows;
}

/**
 * Integer pixel scale for a bitmap `cols` wide to take at most `frac` of a `width`-px window
 * (at least `min`, so it's never unreadably small, at most `max`).
 */
export function logoScale(cols: number, width: number, frac = 0.8, min = 2, max = 12): number {
  return Math.max(min, Math.min(max, Math.floor((width * frac) / Math.max(1, cols))));
}

interface LineStyle {
  text: string;
  top: string;
  bottom: string;
  /** Scale relative to the first line's. */
  rel: number;
}

const LINES: LineStyle[] = [
  { text: 'Cataclysm', top: '#b8fbff', bottom: '#2fb7c8', rel: 1 },
  { text: 'Bright Nights', top: '#c7cfff', bottom: '#5b68e0', rel: 0.6 },
];

/** Draw the logo into a canvas sized for a window `width` px wide. */
export function drawPixelLogo(canvas: HTMLCanvasElement, width: number): void {
  const maps = LINES.map((l) => textBitmap(l.text));
  const s0 = logoScale(Math.max(...maps.map((m, i) => m[0].length * LINES[i].rel)), width);
  const scales = LINES.map((l) => Math.max(1, Math.round(s0 * l.rel)));
  const gap = Math.max(2, Math.round(s0 * 2.2));
  // Outline + shadow need room around the letters.
  const pad = Math.max(2, Math.round(s0 * 0.8));
  const w = Math.max(...maps.map((m, i) => m[0].length * scales[i])) + pad * 2;
  const h = maps.reduce((a, _m, i) => a + GLYPH_H * scales[i], 0) + gap * (maps.length - 1) + pad * 2;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.imageRendering = 'pixelated';
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);
  let y0 = pad;
  maps.forEach((m, i) => {
    const s = scales[i];
    const x0 = Math.round((w - m[0].length * s) / 2);
    const on = (x: number, y: number) => y >= 0 && y < GLYPH_H && x >= 0 && x < m[0].length && m[y][x];
    const cells: [number, number][] = [];
    for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < m[0].length; x++) if (m[y][x]) cells.push([x, y]);
    // Drop shadow, then a dark outline one block-fraction wide, then the lit letters.
    const sh = Math.max(1, Math.round(s * 0.45)), ol = Math.max(1, Math.round(s * 0.25));
    g.fillStyle = 'rgba(0, 0, 0, 0.7)';
    for (const [x, y] of cells) g.fillRect(x0 + x * s + sh, y0 + y * s + sh, s, s);
    g.fillStyle = '#05070d';
    for (const [x, y] of cells) g.fillRect(x0 + x * s - ol, y0 + y * s - ol, s + ol * 2, s + ol * 2);
    const grad = g.createLinearGradient(0, y0, 0, y0 + GLYPH_H * s);
    grad.addColorStop(0, LINES[i].top);
    grad.addColorStop(1, LINES[i].bottom);
    for (const [x, y] of cells) {
      g.fillStyle = grad;
      g.fillRect(x0 + x * s, y0 + y * s, s, s);
      // A lit top edge on blocks with nothing above them: bevelled, like the UI's pixel panels.
      if (!on(x, y - 1) && s >= 3) {
        g.fillStyle = 'rgba(255, 255, 255, 0.45)';
        g.fillRect(x0 + x * s, y0 + y * s, s, Math.max(1, Math.round(s / 5)));
      }
    }
    y0 += GLYPH_H * s + gap;
  });
}

export type TitleLogoStyle = 'pixel' | 'ascii';
const KEY = 'cdda3d.titleLogo';

/** ?logo=ascii|pixel wins, then the stored choice, then pixel. */
export function titleLogoStyle(): TitleLogoStyle {
  const q = new URLSearchParams(location.search).get('logo');
  if (q === 'ascii' || q === 'pixel') return q;
  try {
    return localStorage.getItem(KEY) === 'ascii' ? 'ascii' : 'pixel';
  } catch {
    return 'pixel';
  }
}

export function setTitleLogoStyle(s: TitleLogoStyle): void {
  try {
    localStorage.setItem(KEY, s);
  } catch {
    // not persisted
  }
}

/**
 * Integer font size (px) for the 80-column ASCII art to fit `frac` of the window: a bitmap
 * font at a fractional size smears, which was half of what made the old logo hard to read.
 */
export function asciiFontPx(width: number, height: number, cols = 80, rows = 14): number {
  const byW = Math.floor((width * 0.9) / (cols * 0.5));
  const byH = Math.floor((height * 0.42) / rows);
  return Math.max(8, Math.min(byW, byH, 28));
}

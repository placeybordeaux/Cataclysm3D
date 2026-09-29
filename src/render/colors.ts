// CDDA curses color names -> RGB. Shared by UI and renderer (procedural textures, glyphs).
// Kept free of three.js so node-side tests and tools can import it.

export const CDDA_COLORS: Record<string, number> = {
  black: 0x000000, red: 0xff0000, green: 0x006e00, brown: 0x5c3317, blue: 0x0000c8,
  magenta: 0x8b3a62, cyan: 0x0096b4, light_gray: 0x969696, dark_gray: 0x636363,
  light_red: 0xff9696, light_green: 0x00ff00, yellow: 0xffff00, light_blue: 0x6464ff,
  pink: 0xfe00fe, light_cyan: 0x00f0ff, white: 0xffffff,
};

/** "c_light_red", "i_cyan", "h_white_red", "ltgray" ... -> 0xRRGGBB (foreground color). */
export function cddaColor(name: string | undefined): number {
  if (!name) return 0xffffff;
  let n = name.replace(/^[ci]_/, '').replace(/^h_/, '');
  // "white_red" style fg_bg pairs: CDDA writes the foreground first.
  n = n.split('_').filter((p) => p !== 'white' || n === 'white').join('_') || n;
  n = n.replace(/^lt/, 'light').replace(/^dk/, 'dark');
  return CDDA_COLORS[n] ?? CDDA_COLORS[n.split('_')[0]] ?? 0xcccccc;
}

export type RGB = [number, number, number];

export const hexToRgb = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
export const rgbToHex = (c: RGB): number =>
  (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

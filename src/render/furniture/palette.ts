import type { Pixels } from '../framePixels';
import type { RGB } from '../colors';

// Colours for a model, sampled from its UltiCa sprite (the sprite is the inspiration, the
// model is the thing). UltiCa draws furniture in 3/4 view: the upper part of the sprite is
// the piece's top surface, the lower part its front, so the two regions give a counter its
// worktop and cabinet colours and a fridge its door colour. Pure (no DOM), unit tested.

export interface SpritePalette {
  /** most common non-outline colour (sRGB 0..255) */
  main: RGB;
  /** most common colour clearly different from `main` (hue or value), else a shade of main */
  accent: RGB;
  /** average of the upper ~40% of opaque rows (the drawn top surface) */
  top: RGB;
  /** average of the lower ~45% of opaque rows (the drawn front) */
  front: RGB;
  /** darkest / lightest common colours */
  dark: RGB;
  light: RGB;
  /** distinct colour clusters, most common first */
  clusters: { c: RGB; n: number }[];
}

const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Opaque texels of `p` quantised into clusters (greedy, 5-bit buckets then merged). */
export function spritePalette(p: Pixels): SpritePalette | null {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let y0 = p.h, y1 = -1;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 4;
      if (p.data[i + 3] < 200) continue;
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  if (y1 < 0) return null;
  const H = y1 - y0 + 1;
  const topAcc = [0, 0, 0, 0], frontAcc = [0, 0, 0, 0];
  for (let y = y0; y <= y1; y++)
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 4;
      if (p.data[i + 3] < 200) continue;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      // outlines are near-black in UltiCa: they say nothing about the material
      if (r + g + b < 60) continue;
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const e = buckets.get(k);
      if (e) { e.r += r; e.g += g; e.b += b; e.n++; } else buckets.set(k, { r, g, b, n: 1 });
      const t = (y - y0) / H;
      const acc = t < 0.4 ? topAcc : t > 0.55 ? frontAcc : null;
      if (acc) { acc[0] += r; acc[1] += g; acc[2] += b; acc[3]++; }
    }
  const raw = [...buckets.values()].map((e) => ({ c: [e.r / e.n, e.g / e.n, e.b / e.n] as RGB, n: e.n })).sort((a, b) => b.n - a.n);
  if (!raw.length) return null;
  // merge buckets closer than a perceptual step into the more common one
  const clusters: { c: RGB; n: number }[] = [];
  for (const q of raw) {
    const hit = clusters.find((c) => dist(c.c, q.c) < 34);
    if (hit) {
      const n = hit.n + q.n;
      hit.c = [(hit.c[0] * hit.n + q.c[0] * q.n) / n, (hit.c[1] * hit.n + q.c[1] * q.n) / n, (hit.c[2] * hit.n + q.c[2] * q.n) / n];
      hit.n = n;
    } else clusters.push({ c: [...q.c] as RGB, n: q.n });
  }
  clusters.sort((a, b) => b.n - a.n);
  const main = clusters[0].c;
  const accent = clusters.find((c) => dist(c.c, main) > 60 && c.n >= clusters[0].n * 0.08)?.c ?? main.map((v) => v * 0.7) as RGB;
  const common = clusters.filter((c) => c.n >= clusters[0].n * 0.05);
  const dark = common.reduce((a, b) => (lum(b.c) < lum(a.c) ? b : a)).c;
  const light = common.reduce((a, b) => (lum(b.c) > lum(a.c) ? b : a)).c;
  const avg = (a: number[]) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] as RGB : main);
  return { main, accent, top: avg(topAcc), front: avg(frontAcc), dark, light, clusters };
}

/** Fallback palette from one colour (no sprite, or procedural source). */
export function flatPalette(c: RGB): SpritePalette {
  const k = (m: number) => c.map((v) => Math.min(255, v * m)) as RGB;
  return { main: c, accent: k(0.7), top: k(1.05), front: c, dark: k(0.55), light: k(1.25), clusters: [{ c, n: 1 }] };
}

export { lum as luminance };

// Pixel-art skins for the procedural characters, painted from the creature's UltiCa sprite.
// Pure (RGBA buffers in, RGBA buffers out; no DOM, no three.js), for tests.
//
// Every part is a box textured with a Minecraft-style net at TEXELS_PER_M (the project's
// ~32 texels per metre: UltiCa's 32 px tiles are 1 m). Box texel dims W×H×D (x, y, z):
//
//        +----D----+----W----+----W----+
//        |         |   top   | bottom  |   D rows
//        +---------+---------+---------+----W----+
//        | right   |  front  |  left   |  back   |   H rows
//        | (+x)    |  (-z)   |  (-x)   |  (+z)   |
//        +---------+---------+---------+---------+
//
// Each face is stored as seen from outside, left-to-right = the viewer's left-to-right,
// top row = up (top/bottom faces: top row = the front edge). The sprite is the source of
// truth for colour and detail: a part's `src.rect` (in the sprite's opaque bounding box) is
// projected onto its front face (people are drawn facing us) or right side (animals are
// drawn in profile, head to the right); the other faces reuse the crop mirrored and its
// edge columns/rows, so the back of a zombie is the same shirt and the far side of a dog is
// the same coat.

import type { PartSrc, Role } from './rig';

export const TEXELS_PER_M = 32;

export interface Img {
  w: number;
  h: number;
  /** RGBA, row-major, top-left origin */
  data: Uint8Array | Uint8ClampedArray;
}

export type RGB = [number, number, number];
export type Palette = Record<Role, RGB>;

export interface SpriteInfo {
  /** outline-cleaned copy of the sprite */
  img: Img;
  /** opaque bounding box, px: x0 y0 inclusive, x1 y1 exclusive */
  box: [number, number, number, number];
  pal: Palette;
  /** mean opaque width of the middle band relative to the box width (girth estimate) */
  midWidth: number;
  /** the sprite's main colours (up to 16): painted texels snap to these */
  ramp: RGB[];
}

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function opaque(img: Img, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return false;
  return img.data[(y * img.w + x) * 4 + 3] >= 128;
}

/**
 * UltiCa sprites are outlined in near-black. On a 2D sprite that outline is the silhouette;
 * wrapped around a box it would paint dark stripes down every face edge, so outline pixels
 * (dark, touching transparency) take the colour of the interior pixel next to them.
 */
function removeOutline(src: Img): Img {
  const out = { w: src.w, h: src.h, data: new Uint8ClampedArray(src.data) };
  const d = src.data;
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      if (d[i + 3] < 128) continue;
      const edge = !opaque(src, x - 1, y) || !opaque(src, x + 1, y) || !opaque(src, x, y - 1) || !opaque(src, x, y + 1);
      if (!edge || lum(d[i], d[i + 1], d[i + 2]) > 55) continue;
      // brightest interior neighbour (two steps in, so a 2px outline also goes)
      let best = -1, bl = -1;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const nx = x + dx, ny = y + dy;
        if (!opaque(src, nx, ny)) continue;
        const j = (ny * src.w + nx) * 4;
        const l = lum(d[j], d[j + 1], d[j + 2]);
        if (l > 55 && l > bl) (bl = l, best = j);
      }
      if (best >= 0) {
        // keep it a touch darker: edges still read as edges
        out.data[i] = d[best] * 0.8; out.data[i + 1] = d[best + 1] * 0.8; out.data[i + 2] = d[best + 2] * 0.8;
      }
    }
  }
  return out;
}

function palette(img: Img, box: [number, number, number, number]): Palette {
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  let n = 0;
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
    const i = (y * img.w + x) * 4;
    if (img.data[i + 3] < 128) continue;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = hist.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    hist.set(k, e);
    n++;
  }
  const bins = [...hist.values()].sort((a, b) => b.n - a.n).map((e) => ({ n: e.n, c: [e.r / e.n, e.g / e.n, e.b / e.n] as RGB }));
  const grey: RGB = [128, 128, 128];
  if (!bins.length) return { main: grey, dark: [40, 40, 40], light: [200, 200, 200], accent: [160, 60, 60], skin: grey, wing: [200, 200, 210] };
  const top = bins.slice(0, 8).filter((b) => b.n >= n * 0.02);
  const main = top[0].c;
  const byLum = [...top].sort((a, b) => lum(...a.c) - lum(...b.c));
  const dk = byLum[0].c;
  const dark: RGB = [dk[0] * 0.55, dk[1] * 0.55, dk[2] * 0.55];
  const light = byLum[byLum.length - 1].c;
  const sat = (c: RGB) => Math.max(...c) - Math.min(...c);
  const accent = [...top].sort((a, b) => sat(b.c) - sat(a.c))[0].c;
  const wing: RGB = [light[0] * 0.5 + 110, light[1] * 0.5 + 110, light[2] * 0.5 + 115];
  return { main, dark, light, accent, skin: main, wing };
}

/** Analyse a sprite once per frame: clean the outline, find its box and palette. */
export function analyseSprite(src: Img): SpriteInfo {
  let x0 = src.w, y0 = src.h, x1 = 0, y1 = 0;
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    if (!opaque(src, x, y)) continue;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  if (x1 <= x0) (x0 = 0, y0 = 0, x1 = src.w, y1 = src.h);
  const box: [number, number, number, number] = [x0, y0, x1, y1];
  const img = removeOutline(src);
  const pal = palette(img, box);
  // skin: most common colour of the head band (top fifth)
  const headBox: [number, number, number, number] = [x0, y0, x1, y0 + Math.max(1, Math.round((y1 - y0) * 0.2))];
  pal.skin = palette(img, headBox).main;
  let wsum = 0, rows = 0;
  for (let y = Math.round(y0 + (y1 - y0) * 0.3); y < y0 + (y1 - y0) * 0.5; y++) {
    let a = -1, b = -1;
    for (let x = x0; x < x1; x++) if (opaque(src, x, y)) { if (a < 0) a = x; b = x; }
    if (a >= 0) (wsum += b - a + 1, rows++);
  }
  return { img, box, pal, midWidth: rows ? wsum / rows / (x1 - x0) : 1, ramp: rampOf(img, box) };
}

/**
 * The sprite's own colours, most common first (4 bits per channel bins, their means). A box
 * face resamples the sprite at a different scale; snapping to these keeps the pixel-art
 * palette instead of inventing in-between shades.
 */
function rampOf(img: Img, box: [number, number, number, number]): RGB[] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let n = 0;
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
    const i = (y * img.w + x) * 4;
    if (img.data[i + 3] < 128) continue;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    bins.set(k, e);
    n++;
  }
  return [...bins.values()].filter((e) => e.n >= Math.max(1, n * 0.008)).sort((a, b) => b.n - a.n).slice(0, 16).map((e) => [e.r / e.n, e.g / e.n, e.b / e.n] as RGB);
}

function snap(ramp: RGB[], c: RGB): RGB {
  let best = c, bd = Infinity;
  for (const r of ramp) {
    const d = 3 * (r[0] - c[0]) ** 2 + 4 * (r[1] - c[1]) ** 2 + 2 * (r[2] - c[2]) ** 2;
    if (d < bd) (bd = d, best = r);
  }
  return best;
}

/** A sprite crop in pixel space, trimmed to its mostly-opaque core columns when asked. */
interface Crop {
  x0: number; y0: number; x1: number; y1: number;
  fallback: RGB;
}

function cropOf(s: SpriteInfo, src: PartSrc): Crop {
  const [bx0, by0, bx1, by1] = s.box;
  const r = src.rect ?? [0, 0, 1, 1];
  const bw = bx1 - bx0, bh = by1 - by0;
  let x0 = Math.floor(bx0 + r[0] * bw), x1 = Math.max(x0 + 1, Math.ceil(bx0 + r[2] * bw));
  const y0 = Math.floor(by0 + r[1] * bh), y1 = Math.max(y0 + 1, Math.ceil(by0 + r[3] * bh));
  if (src.edge) {
    // the body's core columns for these rows, then its outer quarter on the asked side
    const colFill = (x: number) => {
      let k = 0;
      for (let y = y0; y < y1; y++) if (opaque(s.img, x, y)) k++;
      return k / (y1 - y0);
    };
    let a = x0, b = x1;
    while (b - a > 2 && colFill(a) < 0.6) a++;
    while (b - a > 2 && colFill(b - 1) < 0.6) b--;
    const w = Math.max(2, Math.round((b - a) * 0.25));
    if (src.edge === 'left') (x0 = a, x1 = Math.min(b, a + w));
    else (x0 = Math.max(a, b - w), x1 = b);
  } else if (src.core) {
    const colFill = (x: number) => {
      let k = 0;
      for (let y = y0; y < y1; y++) if (opaque(s.img, x, y)) k++;
      return k / (y1 - y0);
    };
    const w0 = x1 - x0;
    while (x1 - x0 > Math.max(1, w0 * 0.3) && colFill(x0) < 0.45) x0++;
    while (x1 - x0 > Math.max(1, w0 * 0.3) && colFill(x1 - 1) < 0.45) x1--;
  }
  let n = 0, rr = 0, gg = 0, bb = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!opaque(s.img, x, y)) continue;
    const i = (y * s.img.w + x) * 4;
    rr += s.img.data[i]; gg += s.img.data[i + 1]; bb += s.img.data[i + 2]; n++;
  }
  return { x0, y0, x1, y1, fallback: n ? [rr / n, gg / n, bb / n] : s.pal.main };
}

/** Sprite pixels per texel of the face being painted (set per face by paintPart). */
const foot = { x: 1, y: 1 };

/**
 * Colour at (u, v) in 0..1 of a crop. When a texel covers several sprite pixels it takes
 * their most common (ramp-snapped) colour — a pixel-art downsample, not a blur — so a 16 px
 * shirt on an 11-texel torso keeps its stripes rather than aliasing into noise.
 */
function sample(s: SpriteInfo, c: Crop, u: number, v: number): RGB {
  const x = Math.min(c.x1 - 1, Math.max(c.x0, Math.floor(c.x0 + u * (c.x1 - c.x0))));
  const y = Math.min(c.y1 - 1, Math.max(c.y0, Math.floor(c.y0 + v * (c.y1 - c.y0))));
  if (foot.x > 1.3 || foot.y > 1.3) {
    const hx = Math.floor(foot.x / 2), hy = Math.floor(foot.y / 2);
    const counts = new Map<RGB, number>();
    let centre: RGB | null = null;
    for (let py = Math.max(c.y0, y - hy); py <= Math.min(c.y1 - 1, y + hy); py++) {
      for (let px = Math.max(c.x0, x - hx); px <= Math.min(c.x1 - 1, x + hx); px++) {
        if (!opaque(s.img, px, py)) continue;
        const i = (py * s.img.w + px) * 4;
        const q = snap(s.ramp, [s.img.data[i], s.img.data[i + 1], s.img.data[i + 2]]);
        counts.set(q, (counts.get(q) ?? 0) + (px === x && py === y ? 1.5 : 1));
        if (px === x && py === y) centre = q;
      }
    }
    let best: RGB | null = centre, bn = -1;
    for (const [q, k] of counts) if (k > bn) (bn = k, best = q);
    if (best) return best;
  }
  return snap(s.ramp, samplePoint(s, c, x, y));
}

/** Pixel (x, y) of the crop; transparent pixels borrow the nearest opaque one. */
function samplePoint(s: SpriteInfo, c: Crop, x: number, y: number): RGB {
  const d = s.img.data, w = s.img.w;
  for (let k = 0; k < 6; k++) {
    for (const [dx, dy] of k === 0 ? [[0, 0]] : [[k, 0], [-k, 0], [0, k], [0, -k]]) {
      const px = x + dx, py = y + dy;
      if (px < c.x0 - 1 || px > c.x1 || py < c.y0 - 1 || py > c.y1) continue;
      if (!opaque(s.img, px, py)) continue;
      const i = (py * w + px) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    }
  }
  return c.fallback;
}

export function texelDims(size: readonly [number, number, number]): [number, number, number] {
  return [Math.max(1, Math.round(size[0] * TEXELS_PER_M)), Math.max(1, Math.round(size[1] * TEXELS_PER_M)), Math.max(1, Math.round(size[2] * TEXELS_PER_M))];
}

export function netSize(W: number, H: number, D: number): [number, number] {
  return [2 * D + 2 * W, D + H];
}

export interface PaintOpts {
  /** eye colour override (hostile readability); null = the sprite's own darkest */
  eyes?: RGB | null;
}

/**
 * Paint one part's net at (ox, oy) of `dst`. `face` 0..5 = right(+x), front(-z), left(-x),
 * back(+z), top(+y), bottom(-y) — the shader uses the same order and layout.
 */
export function paintPart(dst: Img, ox: number, oy: number, dims: [number, number, number], src: PartSrc, s: SpriteInfo, opts: PaintOpts = {}): void {
  const [W, H, D] = dims;
  const put = (x: number, y: number, c: RGB, k = 1) => {
    const px = ox + x, py = oy + y;
    if (px < 0 || py < 0 || px >= dst.w || py >= dst.h) return;
    const i = (py * dst.w + px) * 4;
    dst.data[i] = Math.max(0, Math.min(255, c[0] * k));
    dst.data[i + 1] = Math.max(0, Math.min(255, c[1] * k));
    dst.data[i + 2] = Math.max(0, Math.min(255, c[2] * k));
    dst.data[i + 3] = 255;
  };
  // (u, v) on a face -> sprite colour. Role parts are a flat colour with a 2-tone dither.
  let col: (face: number, u: number, v: number) => RGB;
  if (src.role) {
    const base = s.pal[src.role];
    const alt: RGB = [base[0] * 0.82, base[1] * 0.82, base[2] * 0.82];
    col = (_f, u, v) => ((Math.floor(u * 97) + Math.floor(v * 89)) % 3 === 0 ? alt : base);
  } else {
    const c = cropOf(s, src);
    const side = src.proj === 'side';
    const E = 0.28; // share of the crop the perpendicular faces borrow from its edge
    const head = !!src.face;
    col = (face, u, v) => {
      // the back of a head is hair (the crop's top rows) over a strip of neck, not a mirrored face
      if (head && !side && face === 3) return v < 0.8 ? sample(s, c, 1 - u, 0.04 + 0.16 * (v / 0.8)) : sample(s, c, 1 - u, 0.92);
      if (!side) {
        switch (face) {
          case 1: return sample(s, c, u, v);
          case 3: return sample(s, c, 1 - u, v);
          case 0: return sample(s, c, E * (1 - u), v); // right side = the sprite's left edge
          case 2: return sample(s, c, 1 - E * u, v);
          case 4: return sample(s, c, 1 - u, 0.12 * v);
          default: return sample(s, c, 1 - u, 1 - 0.12 * v);
        }
      }
      // profile sprite, head to the right = the model's front (-z)
      switch (face) {
        case 0: return sample(s, c, u, v);
        case 2: return sample(s, c, 1 - u, v);
        case 1: return sample(s, c, 1 - E * (1 - u) * 0.5 - E * 0.25, v); // front: the head-side edge
        case 3: return sample(s, c, E * 0.5 * u + 0.05, v);
        case 4: return sample(s, c, 1 - v, 0.1 + 0.1 * u);
        default: return sample(s, c, 1 - v, 0.95);
      }
    };
  }
  // face rects in the net (x, y, w, h)
  const rects: [number, number, number, number][] = [
    [0, D, D, H], [D, D, W, H], [D + W, D, D, H], [2 * D + W, D, W, H], [D, 0, W, D], [D + W, 0, W, D],
  ];
  const crop = src.role ? null : cropOf(s, src);
  for (let f = 0; f < 6; f++) {
    const [fx, fy, fw, fh] = rects[f];
    if (crop) {
      foot.x = (crop.x1 - crop.x0) / fw;
      foot.y = (crop.y1 - crop.y0) / fh;
    }
    // a 1-texel darker rim on every face (pixel-art edge): boxes keep their shape against
    // same-coloured neighbours and at a distance
    const rim = fw >= 3 && fh >= 3 && f !== 4;
    for (let y = 0; y < fh; y++) {
      // baked form shading: tops a little brighter, the lower rows of the sides a little darker
      const k = f === 4 ? 1.1 : f === 5 ? 0.7 : 1.04 - 0.14 * (y / Math.max(1, fh - 1));
      for (let x = 0; x < fw; x++) {
        const edge = rim && (x === 0 || x === fw - 1 || y === fh - 1);
        put(fx + x, fy + y, col(f, (x + 0.5) / fw, (y + 0.5) / fh), edge ? k * 0.84 : k);
      }
    }
  }
  foot.x = foot.y = 1;
  if (src.face) {
    const eye = opts.eyes ?? s.pal.dark;
    if (src.proj === 'side') {
      // an eye on each side near the front-top, a dark nose/mouth on the front
      const ey = Math.max(0, Math.floor(H * 0.3));
      if (D >= 3) {
        put(D - 2, D + ey, eye);
        put(D + W + 1, D + ey, eye);
      }
      if (W >= 2) put(D + Math.floor(W / 2), D + Math.min(H - 1, Math.floor(H * 0.55)), s.pal.dark);
    } else if (opts.eyes && W >= 4 && H >= 4) {
      // front-facing heads keep the sprite's own face unless asked (readable hostile eyes)
      const ey = D + Math.floor(H * 0.42);
      put(D + Math.floor(W * 0.28), ey, eye);
      put(D + Math.ceil(W * 0.72) - 1, ey, eye);
    }
  }
}

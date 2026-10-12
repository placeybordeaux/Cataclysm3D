import * as THREE from 'three';
import type { HeldBuild } from './chars/held';
import type { RGB } from './chars/paint';
import { heldPartBoxes } from './furniture/groundHeld';
import { visualPreference } from './visualPreference';

// Inventory / pile / hotbar icons for weapons and tools the tileset never drew. UltiCa lacks
// some BN items (the Marlin 1894C, the AR-15 family...), and ui2/icons.ts fell back to the
// item's ASCII glyph: a "(" in a 32 px cell. Items that pass the dropped-weapon gate
// (groundHeld.ts groundHeldClass: weapons, tools, fightable scrap) get a picture of the held
// mesh instead, the same parts and sprite palette as in the hands and on the floor.
//
// It's a tiny software rasterizer, not a WebGL render: the parts are a few dozen boxes, the
// target is 32×32, and pixel art wants hard edges and a few flat shades, which a GPU render
// would have to be quantized back into anyway. It needs no GL context or render-state juggling,
// works before the world renderer is up, and is deterministic for tests. 4×4 supersampling
// with a coverage threshold keeps 2 cm barrels (half a pixel at icon scale) visible, the
// most common colour of a pixel's samples keeps the palette flat, and a dark outline matches
// UltiCa's sprites.
//
// Layout matches UltiCa: guns side-on, stock left, muzzle right; melee weapons and tools on
// the diagonal, grip bottom-left, head top-right.
//
// Switch: `?itemicons=model|glyph`, Options > Interface > Icons without art (heldIconInstall.ts).

export type ItemIconStyle = 'model' | 'glyph';
export const ITEM_ICON_STYLES: readonly ItemIconStyle[] = ['model', 'glyph'];
export const itemIconState = { style: visualPreference<ItemIconStyle>('itemicons', ITEM_ICON_STYLES, 'model') };

export interface IconPixels { w: number; h: number; data: Uint8ClampedArray<ArrayBuffer> }

const SIZE = 32;
const SS = 4;
/**
 * Icon length: px per metre of the item, clamped so a pistol still reads and a pike fits.
 * UltiCa draws pistols about 10 px long and long guns 20-24.
 */
const PX_PER_M = 24, MIN_PX_GUN = 10, MIN_PX = 13, MAX_PX = 28;
/** Fewer than this many of a pixel's 16 samples covered = transparent. */
const MIN_COVER = 3;
/** Light from the upper left, toward the viewer, in view space (u right, v up, d toward you). */
const LIGHT = new THREE.Vector3(-0.35, 0.8, 0.5).normalize();

/**
 * Rasterize `held` (item space: guns point -z with sights +y; melee weapons rise along +y) to
 * a SIZE×SIZE RGBA icon.
 */
export function heldIconPixels(held: HeldBuild): IconPixels {
  // view basis: u = -z (muzzle right), v = +y, d = +x (the viewer stands on the item's +x side);
  // right-handed, so face winding (and the outward normal) carries over
  const view = new THREE.Matrix4().set(
    0, 0, -1, 0,
    0, 1, 0, 0,
    1, 0, 0, 0,
    0, 0, 0, 1,
  );
  // melee: the length (+y) from bottom-left to top-right
  if (!held.gun) view.premultiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 4));
  const { boxes, lo, hi } = heldPartBoxes(held, view);
  const w = hi[0] - lo[0], h = hi[1] - lo[1];
  const len = Math.max(w, h, 1e-3);
  const px = Math.min(MAX_PX, Math.max(held.gun ? MIN_PX_GUN : MIN_PX, len * PX_PER_M));
  const k = (px / len) * SS;
  const N = SIZE * SS;
  // centre in the cell, a little above the middle like UltiCa's items
  const ox = N / 2 - ((lo[0] + hi[0]) / 2) * k, oy = (SIZE / 2 - 1) * SS + ((lo[1] + hi[1]) / 2) * k;
  const depth = new Float32Array(N * N).fill(-Infinity);
  const col = new Int32Array(N * N).fill(-1);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const bx of boxes) {
    for (const f of bx.pts) {
      a.fromArray(f[0]); b.fromArray(f[1]); c.fromArray(f[2]);
      n.subVectors(b, a).cross(c.sub(a));
      if (n.lengthSq() < 1e-14) continue;
      n.normalize();
      // seen from the back: the box's front faces cover it
      if (n.z <= 0) continue;
      // gunmetal and black polymer must still read on the dark list background, so the lit
      // faces go brighter than the part colour; a few flat shades per colour, not a gradient
      const lit = 0.75 + 0.6 * Math.max(0, n.dot(LIGHT));
      const q = Math.round(lit * 4) / 4;
      const packed = pack(bx.color, q);
      const S = f.map((p) => [ox + p[0] * k, oy - p[1] * k, p[2]] as const);
      tri(S[0], S[1], S[2], packed, N, depth, col);
      tri(S[0], S[2], S[3], packed, N, depth, col);
    }
  }
  return outline(downsample(col, N));
}

function pack(c: RGB, f: number): number {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return (ch(c[0]) << 16) | (ch(c[1]) << 8) | ch(c[2]);
}

type P = readonly [number, number, number];

/** Fill a screen triangle at sample centres, nearest (largest d) wins. */
function tri(p0: P, p1: P, p2: P, packed: number, N: number, depth: Float32Array, col: Int32Array): void {
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0]))), x1 = Math.min(N - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1]))), y1 = Math.min(N - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const sx = x + 0.5;
      const w0 = ((p1[0] - sx) * (p2[1] - sy) - (p1[1] - sy) * (p2[0] - sx)) / area;
      const w1 = ((p2[0] - sx) * (p0[1] - sy) - (p2[1] - sy) * (p0[0] - sx)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const d = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
      const i = y * N + x;
      if (d <= depth[i]) continue;
      depth[i] = d;
      col[i] = packed;
    }
  }
}

function downsample(col: Int32Array, N: number): IconPixels {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  const counts = new Map<number, number>();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    counts.clear();
    let cover = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = col[(y * SS + sy) * N + x * SS + sx];
      if (c < 0) continue;
      cover++;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    if (cover < MIN_COVER) continue;
    let best = -1, bn = 0;
    for (const [c, m] of counts) if (m > bn) (best = c, bn = m);
    const o = (y * SIZE + x) * 4;
    data[o] = best >> 16; data[o + 1] = (best >> 8) & 255; data[o + 2] = best & 255; data[o + 3] = 255;
  }
  return { w: SIZE, h: SIZE, data };
}

/** UltiCa-style outline: every empty pixel touching the silhouette gets a very dark shade of it. */
function outline(img: IconPixels): IconPixels {
  const { w, h, data } = img;
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (data[o + 3]) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const p = (ny * w + nx) * 4;
      if (!data[p + 3]) continue;
      out[o] = data[p] * 0.22; out[o + 1] = data[p + 1] * 0.22; out[o + 2] = data[p + 2] * 0.24; out[o + 3] = 255;
      break;
    }
  }
  return { w, h, data: out };
}

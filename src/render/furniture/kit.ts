import type { RGB } from '../colors';
import type { SpritePalette } from './palette';
import type { ModelBuilder } from './mesh';
import type { Decal, FaceSpec, MatKind } from './paint';

// Shared vocabulary for the archetype builders: the build context, face-spec shorthands and
// palette role pickers (which sprite colour is the wood, the upholstery, the metal...).

/** Local directions (model space, before rotation): 0 back (-z), 1 right (+x), 2 front (+z), 3 left (-x). */
export const BACK = 0, RIGHT = 1, FRONT = 2, LEFT = 3;

export interface Ctx {
  id: string;
  pal: SpritePalette;
  /** same-group neighbours in local directions (BACK, RIGHT, FRONT, LEFT) */
  conn: [boolean, boolean, boolean, boolean];
  /** walls in local directions */
  wall: [boolean, boolean, boolean, boolean];
  /** stable per-id number for small variations */
  seed: number;
  /** archetype parameters from the catalog */
  p: Record<string, number | string | boolean>;
}

export type Build = (b: ModelBuilder, c: Ctx) => void;

export const F = (kind: MatKind, c: RGB, decal?: Decal, bevel?: boolean): FaceSpec => ({ mat: { kind, c }, decal, bevel });

// --- colour helpers -------------------------------------------------------------------------

export function hsv(c: RGB): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
export const lumOf = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
export const shade = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
export const lerp = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const isWoodish = (c: RGB) => {
  const [h, s, v] = hsv(c);
  return h >= 10 && h <= 50 && s > 0.25 && v > 0.15 && v < 0.85;
};

/** A wood tone from the sprite (the most common brownish cluster), else `fallback`. */
export function woodOf(pal: SpritePalette, fallback: RGB = [120, 78, 46]): RGB {
  return pal.clusters.find((q) => isWoodish(q.c) && q.n >= pal.clusters[0].n * 0.1)?.c ?? fallback;
}

/** The upholstery / body colour: the most common saturated-enough cluster, else main. */
export function bodyOf(pal: SpritePalette): RGB {
  const top = pal.clusters[0].n;
  return pal.clusters.find((q) => hsv(q.c)[1] > 0.2 && q.n >= top * 0.25 && lumOf(q.c) > 30)?.c ?? pal.main;
}

/** A light neutral (appliance enamel, porcelain) from the sprite, else off-white. */
export function whiteOf(pal: SpritePalette, fallback: RGB = [214, 212, 204]): RGB {
  return pal.clusters.find((q) => lumOf(q.c) > 150 && hsv(q.c)[1] < 0.25 && q.n >= pal.clusters[0].n * 0.1)?.c ?? fallback;
}

/** A grey/metal tone from the sprite, else steel. */
export function metalOf(pal: SpritePalette, fallback: RGB = [120, 124, 128]): RGB {
  return pal.clusters.find((q) => hsv(q.c)[1] < 0.22 && lumOf(q.c) > 50 && lumOf(q.c) < 200 && q.n >= pal.clusters[0].n * 0.1)?.c ?? fallback;
}

export const BRASS: RGB = [196, 160, 72];
export const STEEL: RGB = [150, 154, 158];
export const DARK_METAL: RGB = [62, 64, 68];
export const PORCELAIN: RGB = [222, 222, 216];
export const BLACK_PLASTIC: RGB = [40, 40, 44];

// --- geometry helpers -----------------------------------------------------------------------

/** Four square legs under a rectangle, `inset` from its corners; `skip` leg indices (0 back-left, 1 back-right, 2 front-right, 3 front-left). */
export function legs(b: ModelBuilder, x0: number, z0: number, x1: number, z1: number, h: number, t: number, spec: FaceSpec, inset = 0, skip: number[] = [], y0 = 0): void {
  const pts: [number, number][] = [[x0 + inset, z0 + inset], [x1 - inset - t, z0 + inset], [x1 - inset - t, z1 - inset - t], [x0 + inset, z1 - inset - t]];
  pts.forEach(([x, z], i) => {
    if (!skip.includes(i)) b.box(x, y0, z, x + t, y0 + h, z + t, spec, 'ny');
  });
}

/** A horizontal cylinder-ish bar along x (handles, rails): a thin box. */
export function barX(b: ModelBuilder, x0: number, x1: number, y: number, z: number, t: number, spec: FaceSpec): void {
  b.box(x0, y - t / 2, z - t / 2, x1, y + t / 2, z + t / 2, spec);
}
export function barY(b: ModelBuilder, x: number, y0: number, y1: number, z: number, t: number, spec: FaceSpec): void {
  b.box(x - t / 2, y0, z - t / 2, x + t / 2, y1, z + t / 2, spec);
}
export function barZ(b: ModelBuilder, x: number, y: number, z0: number, z1: number, t: number, spec: FaceSpec): void {
  b.box(x - t / 2, y - t / 2, z0, x + t / 2, y + t / 2, z1, spec);
}

/** Extent of a piece along x, stretched to the tile edge on connected sides. */
export function spanX(c: Ctx, half: number): [number, number] {
  return [c.conn[LEFT] ? -0.5 : -half, c.conn[RIGHT] ? 0.5 : half];
}
export function spanZ(c: Ctx, half: number): [number, number] {
  return [c.conn[BACK] ? -0.5 : -half, c.conn[FRONT] ? 0.5 : half];
}

export const num = (c: Ctx, k: string, d: number) => (typeof c.p[k] === 'number' ? (c.p[k] as number) : d);

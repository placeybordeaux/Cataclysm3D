import * as THREE from 'three';
import { Rng, hashString } from '../core/rng';
import { LEVEL_HEIGHT } from '../world/coords';
import type { RGB } from './colors';
import { FloraAtlas, type LeafDots, paintBark, paintFringe, paintLeaves, paintNeedles, paintSnow, paintTwigs, type BarkKind, type Ramp4 } from './floraArt';
import { framePixels, frameKey } from './framePixels';
import { GeomBuilder, type V3 } from './geometry';
import type { GroundField } from './ground';
import { shared, worldMaterials } from './materials';
import { leafGlow, leafSun } from './trees';
import { Img } from './pixelArt';
import type { TileFrame } from './textureSource';
import type { TreeSpec } from './trees';

// Modelled trees and bushes (Trees option "models", the default with look `trees3d`).
//
// The v2 3D trees revolved the UltiCa sprite's silhouette and covered it with a few hundred
// camera-facing blob cards: square-ish trunks, camo-noise crowns, every species the same
// shape, and billboards past 43 m. Here every tree/bush terrain id maps to a *family* with
// its own layout, built as real geometry in the world material (toon bands, light map,
// shadows):
//
//   round    maple/oak/elm/walnut...: flared 8-sided trunk forking into limbs, a crown of
//            7-8 low-poly leaf lumps with ragged leaf-mass cards around them
//   conifer  pine/juniper: straight trunk, 5 stacked star-edged cones (snow caps in winter)
//   birch    white lenticelled bark, slim trunk, narrow tall crown, light leaves
//   fruit    apple/pear/cherry...: short trunk, wide low dome, blossom in spring, fruit dots
//   sapling  young trees: thin stem, two or three small lumps
//   dead     bare limbs and forks (also any deciduous tree whose seasonal sprite is bare:
//            winter), twig cutouts at the tips
//   bush     shrubs: lumps on the ground, flowers/berries as deliberate pixel dots
//
// Colours come from the tree's own seasonal UltiCa sprite (4-step ramp from its crown
// pixels, bark from its trunk), so species tint, autumn and winter carry over.
//
// LOD by chunk ring (chunkManager lodRadius / midRadius): full models near, a lighter build
// of the *same layout* in the middle ring (5-sided trunk, coarser lumps, no cards), and past
// that two crossed impostor cards painted from that same layout and palette — so a tree
// keeps its silhouette and colours at every distance and nothing pops but detail.

export type FloraName = 'models' | 'clumps';
export const FLORA_NAMES: FloraName[] = ['models', 'clumps'];
export const FLORA_DESC: Record<FloraName, string> = {
  models: 'Modelled trees and bushes per species (tapered trunks, leaf-lump crowns, conifer tiers, bare winter branches), with matching far LOD.',
  clumps: 'The v2 trees: the sprite revolved and covered in leaf-blob cards near you, flat billboards beyond.',
};
export const DEFAULT_FLORA: FloraName = 'models';
const STORAGE_KEY = 'cdda3d.flora';

export const flora = { name: DEFAULT_FLORA as FloraName };

export function isFloraName(s: string | null | undefined): s is FloraName {
  return !!s && (FLORA_NAMES as string[]).includes(s);
}

export function initialFlora(): FloraName {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const p = params.get('flora');
  if (p !== null) {
    if (!isFloraName(p)) throw new Error(`unknown flora "${p}" (expected ${FLORA_NAMES.join('|')})`);
    return p;
  }
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isFloraName(s)) return s;
  } catch {
    // storage blocked
  }
  return DEFAULT_FLORA;
}

export function setFlora(name: FloraName, persist = false): void {
  if (!isFloraName(name)) throw new Error(`unknown flora "${name}" (expected ${FLORA_NAMES.join('|')})`);
  flora.name = name;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // not persisted
    }
  }
}
setFlora(initialFlora());

/** chunkMesh: should this tree/bush be built in 3D (vs. a sprite billboard)? */
export function wantsFlora3d(trees3d: boolean, near: boolean, bare: boolean): boolean {
  if (!trees3d) return false;
  if (flora.name === 'models') return true;
  return near && !bare;
}

// --- species ----------------------------------------------------------------------------

export type Family = 'round' | 'willow' | 'conifer' | 'birch' | 'fruit' | 'sapling' | 'dead' | 'deadconifer' | 'bush' | 'underbrush' | 'fern';

export interface Species {
  family: Family;
  bark: BarkKind;
  /** height multiplier on the mesher's tree height */
  scale: number;
  /** pixel dots in the leaf texture by season (flowers, blossom, fruit, berries) */
  dots?: (season: string) => LeafDots | undefined;
}

const FRUIT: Record<string, RGB> = {
  apple: [196, 36, 30], pear: [196, 190, 70], cherry: [150, 12, 34], peach: [240, 146, 76], apricot: [240, 160, 56],
  plum: [96, 40, 110], mulberry: [60, 22, 52], elderberry: [42, 30, 64], coffee: [168, 30, 30], cacao: [176, 112, 40],
};
const BLOSSOM_PINK = /cherry|peach|almond|apricot/;
const SHRUB_DOTS: [RegExp, RGB[], 'flower' | 'berry'][] = [
  [/rose/, [[206, 30, 52], [236, 90, 110]], 'flower'],
  [/hydrangea/, [[120, 150, 232], [160, 180, 240], [150, 120, 220]], 'flower'],
  [/lilac/, [[172, 120, 210], [200, 160, 230]], 'flower'],
  [/blueberry|huckleberry/, [[60, 72, 160], [40, 50, 120]], 'berry'],
  [/raspberry|strawberry/, [[204, 30, 44]], 'berry'],
  [/blackberry/, [[34, 24, 44], [70, 30, 60]], 'berry'],
  [/grape/, [[84, 52, 112]], 'berry'],
];

export function speciesOf(id: string | undefined, shrub: boolean): Species {
  const s = id ?? '';
  const harvested = /harvested/.test(s);
  if (shrub || /^t_(shrub|underbrush|fern)/.test(s)) {
    if (/young/.test(s)) return { family: 'sapling', bark: 'smooth', scale: 1 };
    if (/underbrush/.test(s)) return { family: 'underbrush', bark: 'smooth', scale: 1 };
    if (/fern/.test(s)) return { family: 'fern', bark: 'smooth', scale: 1 };
    const hit = harvested ? undefined : SHRUB_DOTS.find(([re]) => re.test(s));
    return {
      family: 'bush', bark: 'smooth', scale: 1,
      dots: hit ? (season) => {
        const [, cols, kind] = hit;
        if (season === 'winter') return undefined;
        if (kind === 'flower' && season === 'autumn') return undefined;
        if (kind === 'berry' && season === 'spring') return { cols: [[240, 240, 232]], n: 10, size: 1 };
        // a few big floret clusters / berry pairs on a clean green base (dozens of 2-px dots
        // read as confetti)
        return kind === 'flower' ? { cols, n: 5, size: 3 } : { cols, n: 9, size: 2 };
      } : undefined,
    };
  }
  if (/deadpine/.test(s)) return { family: 'deadconifer', bark: 'plates', scale: 1.25 };
  if (/dead/.test(s)) return { family: 'dead', bark: 'furrow', scale: 1.05 };
  if (/pine|juniper|spruce|fir|cedar|hemlock/.test(s)) return { family: 'conifer', bark: 'plates', scale: /juniper/.test(s) ? 0.8 : 1.35 };
  if (/birch/.test(s)) return { family: 'birch', bark: 'birch', scale: 1.12 };
  const fruitKey = Object.keys(FRUIT).find((k) => s.includes(k));
  if (fruitKey || /almond|pistachio/.test(s)) {
    return {
      family: 'fruit', bark: 'smooth', scale: 0.8,
      dots: (season) => {
        if (season === 'spring') return { cols: BLOSSOM_PINK.test(s) ? [[240, 178, 200], [250, 214, 226]] : [[246, 242, 236], [230, 226, 222]], n: 9, size: 3 };
        if (harvested || !fruitKey || season === 'winter') return undefined;
        return { cols: [FRUIT[fruitKey]], n: season === 'summer' ? 6 : 9, size: 2 };
      },
    };
  }
  if (/young/.test(s)) return { family: 'sapling', bark: 'smooth', scale: 1 };
  if (/willow/.test(s)) return { family: 'willow', bark: 'furrow', scale: 1.05 };
  return { family: 'round', bark: /beech|maple/.test(s) ? 'smooth' : 'furrow', scale: 1 };
}

// --- layout ------------------------------------------------------------------------------
// Normalised: height 1 = the tree's height, x/z horizontal, origin at the trunk foot.

interface Tube { pts: V3[]; radii: number[] }
interface Lump { c: V3; r: V3 }
interface Cone { y0: number; y1: number; r: number }
export interface Layout {
  trunk: Tube | null;
  limbs: Tube[];
  lumps: Lump[];
  cones: Cone[];
  /** twig cutout cards (bare crowns): centre and size */
  twigs: Lump[];
  crown: V3;
}

const VARIANTS = 3;
const layoutCache = new Map<string, Layout>();

/** Deterministic per (family, variant, bare): the near, mid and far builds share it. */
export function layoutOf(family: Family, variant: number, bare: boolean): Layout {
  const key = `${family}|${variant}|${bare}`;
  let L = layoutCache.get(key);
  if (!L) layoutCache.set(key, (L = makeLayout(family, variant, bare)));
  return L;
}

function makeLayout(family: Family, variant: number, bare: boolean): Layout {
  const rng = new Rng(hashString(family) ^ (variant * 0x9e3779b1));
  const j = (a: number) => (rng.next() - 0.5) * 2 * a;
  const L: Layout = { trunk: null, limbs: [], lumps: [], cones: [], twigs: [], crown: [0, 0.65, 0] };
  const trunk = (top: number, r: number, lean = 0.03): V3 => {
    const lx = j(lean), lz = j(lean);
    const pts: V3[] = [[0, -0.03, 0], [0, 0.04, 0], [lx * 0.3, top * 0.45, lz * 0.3], [lx, top, lz]];
    // root flare at the foot, then a gentle taper
    L.trunk = { pts, radii: [r * 1.75, r * 1.18, r * 0.95, r * 0.66] };
    return pts[3];
  };
  const limb = (from: V3, to: V3, r: number) => {
    const mid: V3 = [from[0] + (to[0] - from[0]) * 0.5 + j(0.03), from[1] + (to[1] - from[1]) * 0.5 + 0.03, from[2] + (to[2] - from[2]) * 0.5 + j(0.03)];
    L.limbs.push({ pts: [from, mid, to], radii: [r, r * 0.7, r * 0.4] });
  };
  const crownOf = (c: V3, R: V3, n: number, lumpK: [number, number], squash = 0.85) => {
    L.crown = c;
    L.lumps.push({ c, r: [R[0] * 0.62, R[1] * 0.62, R[2] * 0.62] });
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + j(0.35);
      // three bands of lumps (low skirt, waist, top) so the outline is bumpy all round
      const e = -0.4 + (i % 3) * 0.5 + j(0.15);
      const d: V3 = [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)];
      const k = lumpK[0] + rng.next() * (lumpK[1] - lumpK[0]);
      L.lumps.push({ c: [c[0] + d[0] * R[0] * 0.58, c[1] + d[1] * R[1] * 0.58, c[2] + d[2] * R[2] * 0.58], r: [R[0] * k, R[1] * k * squash, R[2] * k] });
    }
  };
  const bareCrown = (top: V3, r: number, spread: number) => {
    // limbs to every lump position, each forking twice; twig cards at the tips
    for (const lp of L.lumps.slice(1)) {
      const tip: V3 = [lp.c[0] * 1.15, lp.c[1] + lp.r[1] * 0.5, lp.c[2] * 1.15];
      const st: V3 = [top[0] * 0.8, top[1] * (0.82 + rng.next() * 0.18), top[2] * 0.8];
      limb(st, tip, r * 0.42);
      for (let k = 0; k < 2; k++) {
        const t2: V3 = [tip[0] + j(spread), tip[1] + 0.05 + rng.next() * 0.08, tip[2] + j(spread)];
        L.limbs.push({ pts: [tip, t2], radii: [r * 0.14, r * 0.06] });
      }
      L.twigs.push({ c: tip, r: [lp.r[0] * 1.2, lp.r[1] * 1.2, lp.r[2] * 1.2] });
    }
    L.lumps = [];
  };
  switch (family) {
    case 'round': {
      const top = trunk(0.46, 0.042);
      crownOf([j(0.03), 0.66 + j(0.02), j(0.03)], [0.34 + j(0.03), 0.3 + j(0.03), 0.34 + j(0.03)], 10, [0.34, 0.48], 0.9);
      if (bare) bareCrown(top, 0.042, 0.1);
      else for (let i = 1; i < L.lumps.length; i += 2) limb(top, L.lumps[i].c, 0.02);
      break;
    }
    case 'willow': {
      // a low wide dome whose rim lumps hang down in long drooping tongues. (Hanging strand
      // cards were tried: magnified up close they were floating confetti.)
      const top = trunk(0.42, 0.05, 0.05);
      crownOf([0, 0.66, 0], [0.4, 0.24, 0.4], 9, [0.34, 0.44], 0.8);
      for (const l of L.lumps.slice(1)) if (l.c[1] < 0.7) {
        // (tongues hanging below ~2.5 m put the walker's head inside the crown)
        l.c = [l.c[0] * 1.12, l.c[1] - 0.05, l.c[2] * 1.12];
        l.r = [l.r[0] * 0.8, l.r[1] * 1.6, l.r[2] * 0.8];
      }
      if (bare) bareCrown(top, 0.05, 0.1);
      else for (let i = 1; i < L.lumps.length; i += 2) limb(top, L.lumps[i].c, 0.022);
      break;
    }
    case 'birch': {
      const top = trunk(0.78, 0.03, 0.02);
      crownOf([0, 0.66, 0], [0.22, 0.34, 0.22], 8, [0.38, 0.5], 0.95);
      if (bare) bareCrown(top, 0.03, 0.07);
      else for (let i = 1; i < L.lumps.length; i += 3) limb([top[0] * 0.6, 0.5, top[2] * 0.6], L.lumps[i].c, 0.014);
      break;
    }
    case 'fruit': {
      const top = trunk(0.36, 0.05, 0.05);
      crownOf([0, 0.62, 0], [0.48, 0.3, 0.48], 7, [0.42, 0.55], 0.8);
      if (bare) bareCrown(top, 0.05, 0.12);
      else for (let i = 1; i < L.lumps.length; i += 2) limb(top, [L.lumps[i].c[0] * 0.8, L.lumps[i].c[1] - 0.05, L.lumps[i].c[2] * 0.8], 0.025);
      break;
    }
    case 'sapling': {
      const top = trunk(0.6, 0.02, 0.04);
      L.crown = [top[0], 0.72, top[2]];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + j(0.4);
        L.lumps.push({ c: [top[0] + Math.cos(a) * 0.1, 0.66 + i * 0.09, top[2] + Math.sin(a) * 0.1], r: [0.16, 0.14, 0.16] });
      }
      if (bare) bareCrown(top, 0.02, 0.05);
      break;
    }
    case 'conifer': {
      trunk(0.97, 0.034, 0.015);
      L.crown = [0, 0.55, 0];
      const n = 5;
      for (let i = 0; i < n; i++) {
        const y0 = 0.13 + i * 0.165 + j(0.012);
        L.cones.push({ y0, y1: i === n - 1 ? 1.02 : y0 + 0.3, r: 0.29 * (1 - i * 0.17) + j(0.015) });
      }
      break;
    }
    case 'dead': {
      const top = trunk(0.7, 0.045, 0.05);
      L.crown = [0, 0.6, 0];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + j(0.5);
        const st: V3 = [top[0] * 0.7, 0.42 + i * 0.07, top[2] * 0.7];
        const tip: V3 = [Math.cos(a) * (0.24 + j(0.05)), st[1] + 0.2 + j(0.06), Math.sin(a) * (0.24 + j(0.05))];
        limb(st, tip, 0.022);
        for (let k = 0; k < 2; k++) L.limbs.push({ pts: [tip, [tip[0] * 1.3 + j(0.05), tip[1] + 0.08 + rng.next() * 0.06, tip[2] * 1.3 + j(0.05)]], radii: [0.008, 0.003] });
      }
      break;
    }
    case 'deadconifer': {
      const top = trunk(0.9, 0.03, 0.01);
      L.crown = [0, 0.6, 0];
      for (let i = 0; i < 9; i++) {
        const a = i * 2.4 + j(0.3), y = 0.25 + i * 0.07;
        const len = 0.14 * (1 - i / 11);
        L.limbs.push({ pts: [[top[0] * y, y, top[2] * y], [Math.cos(a) * len, y - 0.02, Math.sin(a) * len]], radii: [0.008, 0.003] });
      }
      break;
    }
    case 'bush':
    case 'underbrush':
    case 'fern': {
      const low = family !== 'bush';
      const n = low ? 4 : 3 + (variant % 2);
      L.crown = [0, 0.45, 0];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + j(0.5);
        const d = low ? 0.42 : 0.3;
        const rr = (low ? 0.36 : 0.42) + j(0.06);
        L.lumps.push({ c: [Math.cos(a) * d, rr * 0.8, Math.sin(a) * d], r: [rr, rr * 0.85, rr] });
      }
      if (!low) L.lumps.push({ c: [0, 0.55, 0], r: [0.42, 0.45, 0.42] });
      if (bare) {
        L.twigs = L.lumps.map((l) => ({ c: l.c, r: [l.r[0] * 1.1, l.r[1] * 1.1, l.r[2] * 1.1] }));
        L.lumps = [];
      }
      break;
    }
  }
  return L;
}

// --- palettes from the sprite ------------------------------------------------------------

const toS = (v: number) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
const toL = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lumS = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

interface Palette { leaf: Ramp4; bark: RGB; bare: boolean; pine: boolean; key: string }
const palCache = new Map<string, Palette | null>();

/** Crown ramp and bark colour from the tree's seasonal sprite. */
export function paletteOf(f: TileFrame): Palette | null {
  const key = frameKey(f);
  if (palCache.has(key)) return palCache.get(key)!;
  const p = framePixels(f);
  let out: Palette | null = null;
  if (p) {
    const { w, h, data } = p;
    const leaf: RGB[] = [], bark: RGB[] = [];
    let green = 0, filled = 0;
    let top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] >= 200) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    for (let y = top; y <= bottom; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 200) continue;
        const c: RGB = [data[i], data[i + 1], data[i + 2]];
        const mx = Math.max(...c), mn = Math.min(...c);
        // green, or saturated and bright (autumn, blossom); pale greys are snow, not leaves
        const leafy = (c[1] > c[0] * 0.95 && c[1] > c[2] && mx - mn > 12) || (mx - mn > 70 && mx > 110) || (mx > 200 && mx - mn > 40);
        if (y > bottom - (bottom - top) * 0.15) bark.push(c);
        else { filled++; if (leafy) { green++; leaf.push(c); } }
      }
    leaf.sort((a, b) => lumS(a) - lumS(b));
    bark.sort((a, b) => lumS(a) - lumS(b));
    const at = (arr: RGB[], t: number): RGB => arr[Math.min(arr.length - 1, Math.floor(arr.length * t))];
    const bare = green / Math.max(1, filled) < 0.22;
    const ramp: Ramp4 = leaf.length > 8
      // brightened: the sprite's colours are drawn with its own shading baked in, while the
      // model gets real (toon) shading on top; unbrightened, crowns read dark olive
      ? [darken(at(leaf, 0.2), 0.85), brighten(at(leaf, 0.45), 1.12), brighten(at(leaf, 0.75), 1.2), brighten(at(leaf, 0.96), 1.3)]
      : [[26, 40, 20], [52, 78, 34], [78, 108, 46], [118, 146, 64]];
    const barkC: RGB = bark.length ? at(bark, 0.5) : [70, 52, 38];
    const q = (c: RGB) => c.map((v) => Math.round(v / 20)).join('.');
    out = { leaf: ramp, bark: barkC, bare, pine: false, key: ramp.map(q).join('/') + '|' + q(barkC) };
  }
  palCache.set(key, out);
  return out;
}
const darken = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const brighten = (c: RGB, k: number): RGB => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];

// --- geometry ----------------------------------------------------------------------------

let atlas: FloraAtlas | null = null;
export function floraAtlas(): FloraAtlas {
  return (atlas ??= new FloraAtlas());
}

type Xf = (p: V3) => V3;
type Nf = (n: V3) => V3;
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const WHITE = [1, 1, 1];

/** quadEx, flipped if needed so its front faces along its normals (the world material
 *  culls back faces; lat-long and cone winding is easy to get backwards). */
function quadOut(g: GeomBuilder, a: V3, b: V3, c: V3, d: V3, ns: V3[], uv: number[], f: TileFrame, col: readonly number[]): void {
  // face normal from the diagonals, (c - a) x (d - b): robust to one degenerate edge
  // (cone apexes, sphere poles)
  const f1: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], f2: V3 = [d[0] - b[0], d[1] - b[1], d[2] - b[2]];
  const fn: V3 = [f1[1] * f2[2] - f1[2] * f2[1], f1[2] * f2[0] - f1[0] * f2[2], f1[0] * f2[1] - f1[1] * f2[0]];
  const avg = [ns[0][0] + ns[1][0] + ns[2][0] + ns[3][0], ns[0][1] + ns[1][1] + ns[2][1] + ns[3][1], ns[0][2] + ns[1][2] + ns[2][2] + ns[3][2]];
  if (fn[0] * avg[0] + fn[1] * avg[1] + fn[2] * avg[2] >= 0) g.quadEx(a, b, c, d, ns, uv, f, col);
  else g.quadEx(b, a, d, c, [ns[1], ns[0], ns[3], ns[2]], [uv[2], uv[1], uv[0], uv[3]], f,
    col.length === 12 ? [...col.slice(3, 6), ...col.slice(0, 3), ...col.slice(9, 12), ...col.slice(6, 9)] : col);
}

/** A tapered tube through `pts` (world metres) with radial normals; bark tiles at 1 m. */
function tube(g: GeomBuilder, f: TileFrame, pts: V3[], radii: number[], sides: number): void {
  let vAcc = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], b = pts[s + 1];
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const t0: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm([d[1] * t0[2] - d[2] * t0[1], d[2] * t0[0] - d[0] * t0[2], d[0] * t0[1] - d[1] * t0[0]]);
    const v: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    // a whole number of texture repeats around (no seam), ~1 per metre of circumference
    const circ = Math.max(1, Math.round(2 * Math.PI * Math.max(radii[s], radii[s + 1]) * 2) / 2);
    const dir = (i: number): V3 => {
      const t = (i / sides) * Math.PI * 2;
      return [u[0] * Math.cos(t) + v[0] * Math.sin(t), u[1] * Math.cos(t) + v[1] * Math.sin(t), u[2] * Math.cos(t) + v[2] * Math.sin(t)];
    };
    for (let i = 0; i < sides; i++) {
      const n0 = dir(i), n1 = dir(i + 1);
      const P = (c: V3, r: number, n: V3): V3 => [c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r];
      g.quadEx(P(a, radii[s], n0), P(a, radii[s], n1), P(b, radii[s + 1], n1), P(b, radii[s + 1], n0), [n0, n1, n1, n0],
        [(i / sides) * circ, vAcc, ((i + 1) / sides) * circ, vAcc + len], f, WHITE);
    }
    vAcc += len;
  }
}

/** A low-poly leaf lump: a wobbly spheroid whose normals lean toward the crown's volume
 *  normal, so the crown shades as one mass (lit top, dark underside) with lumps in it. */
function lump(g: GeomBuilder, f: TileFrame, c: V3, r: V3, crown: V3, seg: number, rings: number, seed: number): void {
  const rng = new Rng(seed);
  // each lump a slightly different value and hue (a younger/older leaf mass), like the v2
  // clumps coloured from different sprite pixels: one flat tint read as a plastic ball
  const tv = 0.86 + rng.next() * 0.24, th = (rng.next() - 0.5) * 0.12;
  const tint: V3 = [tv * (1 + th), tv, tv * (1 - th)];
  const wob: number[] = [];
  for (let i = 0; i < seg * (rings + 1); i++) wob.push(1 + (rng.next() - 0.5) * 0.26);
  const circ = Math.max(1, Math.round(2 * Math.PI * r[0]));
  // which way this lump faces out of the crown: its inner and lower sides are occluded
  const out = norm([c[0] - crown[0] + 1e-4, (c[1] - crown[1]) * 0.6, c[2] - crown[2]]);
  const P = (i: number, k: number): [V3, V3, number, number, number] => {
    const th = (i / seg) * Math.PI * 2, ph = -Math.PI / 2 + (k / rings) * Math.PI;
    const w = k === 0 || k === rings ? 1 : wob[(i % seg) * (rings + 1) + k];
    const d: V3 = [Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph)];
    const p: V3 = [c[0] + d[0] * r[0] * w, c[1] + d[1] * r[1] * w, c[2] + d[2] * r[2] * w];
    const vn = norm([p[0] - crown[0], (p[1] - crown[1]) * 1.2, p[2] - crown[2]]);
    // mostly the crown's sphere normal (smooth, one mass, no facets), a little of the lump's
    // own so lumps still read
    const n = norm([d[0] * 0.28 + vn[0] * 0.72, d[1] * 0.28 + vn[1] * 0.72, d[2] * 0.28 + vn[2] * 0.72]);
    // baked occlusion as vertex colour: faces toward the crown's inside and underneath are
    // darker, so neighbouring lumps separate by value (the v2 clumps' dark gaps) while the
    // lighting stays smooth
    const facing = 0.5 + 0.5 * (d[0] * out[0] + d[1] * out[1] + d[2] * out[2]);
    const up = 0.5 + 0.5 * d[1];
    const occ = 0.5 + 0.5 * Math.min(1, facing * 0.65 + up * 0.55);
    return [p, n, (i / seg) * circ, p[1], occ];
  };
  for (let k = 0; k < rings; k++)
    for (let i = 0; i < seg; i++) {
      const a = P(i, k), b = P(i + 1, k), cc = P(i + 1, k + 1), d = P(i, k + 1);
      // winding: outward-facing (i grows counter-clockwise seen from above)
      quadOut(g, a[0], b[0], cc[0], d[0], [a[1], b[1], cc[1], d[1]], [a[2], a[3], b[2], d[3]], f,
        [a, b, cc, d].flatMap((q) => [q[4] * tint[0], q[4] * tint[1], q[4] * tint[2]]));
    }
}

/** Star-edged cone tier (conifers): drooping skirt, needle texture, underside. */
function cone(g: GeomBuilder, f: TileFrame, base: V3, y0: number, y1: number, R: number, seg: number, seed: number, snow?: TileFrame): void {
  const rng = new Rng(seed);
  const h = y1 - y0;
  const apex: V3 = [base[0], y1, base[2]];
  const ring: V3[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const rr = R * (i % 2 ? 0.8 : 1) * (1 + (rng.next() - 0.5) * 0.1);
    ring.push([base[0] + Math.cos(t) * rr, y0 - (i % 2 ? 0 : h * 0.06), base[2] + Math.sin(t) * rr]);
  }
  ring[seg] = ring[0];
  const circ = Math.max(1, Math.round(2 * Math.PI * R));
  for (let i = 0; i < seg; i++) {
    const a = ring[i], b = ring[i + 1];
    const t = ((i + 0.5) / seg) * Math.PI * 2;
    const n = norm([Math.cos(t) * h, R * 0.9, Math.sin(t) * h]);
    quadOut(g, a, b, apex, apex, [n, n, n, n], [(i / seg) * circ, 0, ((i + 1) / seg) * circ, Math.hypot(h, R)], f, WHITE);
    // underside: the skirt folds back to the trunk, so the tier isn't a hollow shell
    const inner: V3 = [base[0], y0 + h * 0.22, base[2]];
    const dn = norm([Math.cos(t) * 0.3, -1, Math.sin(t) * 0.3]);
    quadOut(g, a, b, inner, inner, [dn, dn, dn, dn], [0, 0, 1, R], f, [0.8, 0.8, 0.8]);
    if (snow) {
      // a snow cap over the upper half of the tier, a touch outside the needles
      const k = 0.55;
      const sa: V3 = [base[0] + (a[0] - base[0]) * k * 1.04, y0 + h * (1 - k) + 0.02, base[2] + (a[2] - base[2]) * k * 1.04];
      const sb: V3 = [base[0] + (b[0] - base[0]) * k * 1.04, y0 + h * (1 - k) + 0.02, base[2] + (b[2] - base[2]) * k * 1.04];
      const ap: V3 = [apex[0], apex[1] + 0.03, apex[2]];
      quadOut(g, sa, sb, ap, ap, [n, n, n, n], [0, 0, 1, 1], snow, WHITE);
    }
  }
}

/** Crossed cutout cards (both faces), normals from the crown centre. */
function cards(g: GeomBuilder, f: TileFrame, c: V3, halfW: number, halfH: number, crown: V3, yaw: number, n = 3, dy = 0): void {
  for (let k = 0; k < n; k++) {
    const a = yaw + (k * Math.PI) / n;
    const ca = Math.cos(a), sa = Math.sin(a);
    const P = (u: number, v: number): V3 => [c[0] + ca * u, c[1] + v + dy, c[2] + sa * u];
    const corners = [P(-halfW, -halfH), P(halfW, -halfH), P(halfW, halfH), P(-halfW, halfH)];
    const ns = corners.map((p) => norm([p[0] - crown[0], (p[1] - crown[1]) + 0.4 * halfH, p[2] - crown[2]]));
    const uv = [0.001, 0.001, 0.999, 0.999];
    g.quadEx(corners[0], corners[1], corners[2], corners[3], ns, uv, f, WHITE);
    g.quadEx(corners[1], corners[0], corners[3], corners[2], [ns[1], ns[0], ns[3], ns[2]], [0.999, 0.001, 0.001, 0.999], f, WHITE);
  }
}

// --- far impostor ------------------------------------------------------------------------

const IMP_PX = 32; // texels per normalised unit (a 5 m tree: ~6 texels/m, >= a pixel at 70 m)

interface ImpBounds { hw: number; top: number; bot: number }
function boundsOf(L: Layout): ImpBounds {
  let hw = 0.05, top = 0.1;
  for (const l of L.lumps) { hw = Math.max(hw, Math.hypot(l.c[0], l.c[2]) + l.r[0]); top = Math.max(top, l.c[1] + l.r[1]); }
  for (const c of L.cones) { hw = Math.max(hw, c.r); top = Math.max(top, c.y1); }
  for (const t of L.twigs) { hw = Math.max(hw, Math.hypot(t.c[0], t.c[2]) + t.r[0]); top = Math.max(top, t.c[1] + t.r[1]); }
  for (const b of L.limbs) for (const p of b.pts) { hw = Math.max(hw, Math.hypot(p[0], p[2])); top = Math.max(top, p[1]); }
  if (L.trunk) for (const p of L.trunk.pts) top = Math.max(top, p[1]);
  return { hw: hw * 1.05, top: top * 1.02, bot: -0.03 };
}

/** The layout projected on one vertical plane (axis 0: x, 1: z), painted flat. */
function paintImpostor(L: Layout, axis: 0 | 1, pal: Palette, leafTex: Img, barkTex: Img, conifer: boolean): Img {
  const b = boundsOf(L);
  const W = Math.max(4, Math.ceil(b.hw * 2 * IMP_PX)), H = Math.max(4, Math.ceil((b.top - b.bot) * IMP_PX));
  const img = new Img(W, H);
  const X = (p: V3) => (p[axis === 0 ? 0 : 2] + b.hw) * IMP_PX;
  const Y = (y: number) => (b.top - y) * IMP_PX;
  const depth = (p: V3) => p[axis === 0 ? 2 : 0];
  const texAt = (t: Img, x: number, y: number): RGB => { const i = ((((y | 0) % 32 + 32) % 32) * 32 + (((x | 0) % 32 + 32) % 32)) * 4; return [t.data[i], t.data[i + 1], t.data[i + 2]]; };
  const line = (a: V3, c: V3, r0: number, r1: number) => {
    const n = Math.ceil(Math.hypot(X(c) - X(a), Y(c[1]) - Y(a[1]))) + 1;
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      const x = X(a) + (X(c) - X(a)) * t, y = Y(a[1]) + (Y(c[1]) - Y(a[1])) * t;
      const r = Math.max(0.5, (r0 + (r1 - r0) * t) * IMP_PX);
      for (let dx = -r; dx <= r; dx++) img.set(x + dx, y, dx < 0 ? darken(texAt(barkTex, x + dx, y), 0.8) : texAt(barkTex, x + dx, y));
    }
  };
  const tubes = [...(L.trunk ? [L.trunk] : []), ...L.limbs];
  for (const t of tubes) for (let s = 0; s < t.pts.length - 1; s++) line(t.pts[s], t.pts[s + 1], t.radii[s], t.radii[s + 1]);
  for (const c of L.cones) {
    const y0 = Y(c.y0), y1 = Y(c.y1), cx = X([0, 0, 0]);
    for (let y = Math.floor(y1); y <= y0; y++) {
      const t = (y - y1) / Math.max(1, y0 - y1), hw = c.r * IMP_PX * t;
      for (let x = Math.floor(cx - hw); x <= cx + hw; x++) {
        const col = texAt(leafTex, x, y);
        img.set(x, y, t > 0.8 ? darken(col, 0.75) : col);
      }
    }
  }
  const ls = [...L.lumps].sort((p, q) => depth(p.c) - depth(q.c));
  for (const l of ls) {
    const cx = X(l.c), cy = Y(l.c[1]), rx = l.r[axis === 0 ? 0 : 2] * IMP_PX, ry = l.r[1] * IMP_PX;
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const u = (x - cx) / rx, v = (y - cy) / ry;
        if (u * u + v * v > 1) continue;
        // baked only as a hint (the card's volume normals do the real lighting): the lower
        // rim of each lump is the darker leaf colour, like the modelled lumps' undersides
        img.set(x, y, v > 0.55 ? pal.leaf[0] : texAt(leafTex, x, y));
      }
  }
  for (const t of L.twigs) {
    const cx = X(t.c), cy = Y(t.c[1]), r = t.r[0] * IMP_PX;
    for (let k = 0; k < 6; k++) {
      const a = -Math.PI / 2 + (k - 2.5) * 0.4;
      for (let s = 0; s < r; s++) img.set(cx + Math.cos(a) * s, cy + Math.sin(a) * s, pal.bark);
    }
  }
  void conifer;
  return img;
}

// --- build -------------------------------------------------------------------------------

/** Build one chunk's modelled trees/bushes (one mesh on the flora page), a tree per step. */
export function* buildFloraSteps(specs: TreeSpec[], ground: GroundField | null): Generator<void, THREE.Object3D[]> {
  const A = floraAtlas();
  const g = new GeomBuilder(); // trunks, limbs, impostors: plain world material
  const fg = new GeomBuilder(); // leaves, needles, cards, snow: foliage material (sway, near fade)
  let first = true;
  for (const s of specs) {
    if (!first) yield;
    first = false;
    const pal = paletteOf(s.frame);
    if (!pal) continue;
    const sp = speciesOf(s.id, s.shrub);
    const season = s.season ?? 'summer';
    const lod = s.lod ?? 0;
    const variant = (s.seed >>> 3) % VARIANTS;
    // Bare crowns only when the season says so: a sparse sprite (saplings, some autumn
    // trees) otherwise read as bare and lost its leaves in summer
    const bare = pal.bare && season === 'winter' && sp.family !== 'conifer' && sp.family !== 'deadconifer';
    const fam = sp.family;
    const L = layoutOf(fam, variant, bare && fam !== 'dead');
    const shrubby = fam === 'bush' || fam === 'underbrush' || fam === 'fern';
    const H = shrubby ? Math.max(0.55, Math.min(1.3, s.height * (fam === 'bush' ? 1 : 0.75)))
      : fam === 'sapling' ? Math.max(1.6, Math.min(2.8, s.height * 1.6)) : s.height * sp.scale;
    const gy = s.z * LEVEL_HEIGHT + (ground ? ground.heightAt(s.x, s.y, s.z) : 0);
    const yaw = ((s.seed >>> 11) % 360) * (Math.PI / 180);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const X: Xf = (p) => [s.x + (p[0] * cy - p[2] * sy) * H, gy + p[1] * H, s.y + (p[0] * sy + p[2] * cy) * H];
    const crownW = X(L.crown);
    const dots = sp.dots?.(season);
    const dk = dots ? dots.cols.map((c) => c.join('.')).join('/') + dots.n : '';
    const conifer = fam === 'conifer';
    const leafF = A.frame(`leaf|${conifer}|${pal.key}|${dk}`, true, () => (conifer ? paintNeedles(pal.leaf, 11) : paintLeaves(pal.leaf, 7, dots)));
    const barkKind: BarkKind = fam === 'dead' || fam === 'deadconifer' ? 'furrow' : sp.bark;
    const barkBase: RGB = fam === 'dead' || fam === 'deadconifer' ? [pal.bark[0] * 0.8 + 20, pal.bark[1] * 0.8 + 18, pal.bark[2] * 0.8 + 18] : pal.bark;
    const barkF = A.frame(`bark|${barkKind}|${barkBase.map((v) => Math.round(v / 10)).join('.')}`, true, () => paintBark(barkKind, barkBase, 3));
    if (lod >= 2) {
      // far: two crossed cards painted from this same layout
      const b = boundsOf(L);
      for (const axis of [0, 1] as const) {
        const imp = A.frame(`imp|${fam}|${variant}|${bare}|${axis}|${pal.key}|${dk}`, false, () => paintImpostor(L, axis, pal,
          conifer ? paintNeedles(pal.leaf, 11) : paintLeaves(pal.leaf, 7, dots), paintBark(barkKind, barkBase, 3), conifer));
        const ax: V3 = axis === 0 ? [cy, 0, sy] : [-sy, 0, cy];
        const P = (u: number, v: number): V3 => [s.x + ax[0] * u * H, gy + v * H, s.y + ax[2] * u * H];
        const corners = [P(-b.hw, b.bot), P(b.hw, b.bot), P(b.hw, b.top), P(-b.hw, b.top)];
        const ns = corners.map((p) => norm([p[0] - crownW[0], p[1] - crownW[1] + H * 0.25, p[2] - crownW[2]]));
        g.quadEx(corners[0], corners[1], corners[2], corners[3], ns, [0.001, 0.001, 0.999, 0.999], imp, WHITE);
        g.quadEx(corners[1], corners[0], corners[3], corners[2], [ns[1], ns[0], ns[3], ns[2]], [0.999, 0.001, 0.001, 0.999], imp, WHITE);
      }
      continue;
    }
    const near = lod === 0;
    const Xs = (pts: V3[]) => pts.map(X);
    if (L.trunk) tube(g, barkF, Xs(L.trunk.pts), L.trunk.radii.map((r) => r * H), near ? 8 : 5);
    const limbs = near ? L.limbs : bare || fam === 'dead' ? L.limbs.filter((l) => l.radii[0] * H > 0.03) : [];
    for (const l of limbs) tube(g, barkF, Xs(l.pts), l.radii.map((r) => Math.max(0.012, r * H)), near ? 5 : 3);
    const snow = season === 'winter' && conifer ? A.frame('snow', true, () => paintSnow(5)) : undefined;
    for (let i = 0; i < L.cones.length; i++) {
      const c = L.cones[i];
      cone(fg, leafF, X([0, 0, 0]), gy + c.y0 * H, gy + c.y1 * H, c.r * H, near ? 12 : 8, s.seed + i, snow);
    }
    const fringeF = near && L.lumps.length ? A.frame(`fringe|${pal.key}|${dk}`, false, () => paintFringe(pal.leaf, 7, dots)) : null;
    for (let i = 0; i < L.lumps.length; i++) {
      const l = L.lumps[i];
      const c = X(l.c);
      const r: V3 = [l.r[0] * H, l.r[1] * H, l.r[2] * H];
      lump(fg, leafF, c, r, crownW, near ? 9 : 6, near ? 5 : 3, s.seed + i * 17);
      if (fringeF) {
        // ragged leaf-mass cards through the lump: only their rim shows outside it, and it
        // hides the lump's polygon outline; lumps on the crown's lower half also get a flat
        // card under them, where the underside silhouette is seen from below
        // pushed a little outward from the crown centre so the ragged rim covers the outline
        const o = norm([c[0] - crownW[0], (c[1] - crownW[1]) * 0.5, c[2] - crownW[2]]);
        cards(fg, fringeF, [c[0] + o[0] * r[0] * 0.3, c[1] + o[1] * r[1] * 0.3, c[2] + o[2] * r[2] * 0.3], r[0] * 1.6, r[1] * 1.6, crownW, yaw + i, 3);
        if (l.c[1] <= L.crown[1] + 0.02) hcard(fg, fringeF, [c[0], c[1] - r[1] * 0.45, c[2]], r[0] * 1.35, crownW, yaw + i);
      }
    }
    if (L.twigs.length) {
      const twigF = A.frame(`twig|${barkBase.map((v) => Math.round(v / 10)).join('.')}`, false, () => paintTwigs(barkBase, 9));
      for (const t of L.twigs) {
        const c = X(t.c);
        if (near || lod === 1) cards(fg, twigF, [c[0], c[1] + t.r[1] * H * 0.3, c[2]], t.r[0] * H, t.r[1] * H, crownW, yaw, near ? 3 : 2);
      }
    }
  }
  const out: THREE.Object3D[] = [];
  const { mat, depth } = worldMaterials(A.texture);
  for (const [b, material] of [[g, mat], [fg, foliageMaterial(A.texture)]] as const) {
    if (!b.vertexCount) continue;
    const m = new THREE.Mesh(b.build(), material);
    m.customDepthMaterial = depth;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.userData.flora = true;
    out.push(m);
  }
  return out;
}

// --- foliage material --------------------------------------------------------------------
// The world material plus three things only leaves want:
//  * near fade: within ~2 m of the eye leaves dissolve (screen-door on the pixel grid),
//    so walking into a crown or bush doesn't fill the screen with giant texels
//  * stepped wind: a small sway advanced in 4 keyframes per second (pixel-art animation
//    timing, and a still frame between steps doesn't shimmer), gone past ~25 m
//  * light through leaves: the v2 clumps' glow (undersides never go muddy) and backlit
//    translucency when looking toward the sun
let foliageMat: THREE.MeshLambertMaterial | null = null;
/** Sway amplitude in metres (0 = off); cdda.floraTweak can change it. */
export const floraWind = { value: 0.05 };

function foliageMaterial(tex: THREE.Texture): THREE.MeshLambertMaterial {
  if (foliageMat) return foliageMat;
  const base = worldMaterials(tex).mat;
  const m = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, alphaTest: 0.5, side: THREE.FrontSide });
  m.onBeforeCompile = (sh, r) => {
    base.onBeforeCompile(sh, r);
    Object.assign(sh.uniforms, { uTime: shared.uTime, uSway: floraWind, uLeafGlow: leafGlow, uSunW: leafSun.dir, uSunC: leafSun.color });
    const anchor = 'vSkyVis = skyVis;';
    if (!sh.vertexShader.includes(anchor)) throw new Error('flora: world vertex anchor missing');
    sh.vertexShader = 'uniform float uTime;\nuniform float uSway;\nuniform vec3 uSunW;\nvarying float vFolDist;\nvarying float vFolTrans;\n' + sh.vertexShader.replace(anchor, `${anchor}
{
  vec3 fw = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vFolDist = length(fw - cameraPosition);
  vFolTrans = pow(max(dot(normalize(fw - cameraPosition), uSunW), 0.0), 3.0);
  float st = floor(uTime * 4.0) * 0.25;
  float ph = fw.x * 0.31 + fw.z * 0.23 + fw.y * 0.4;
  vec2 sw = vec2(sin(st * 1.7 + ph), cos(st * 1.3 + ph * 1.3)) * uSway * (1.0 - smoothstep(12.0, 25.0, vFolDist));
  transformed.xz += sw;
}`);
    sh.fragmentShader = 'uniform float uLeafGlow;\nuniform vec3 uSunC;\nvarying float vFolDist;\nvarying float vFolTrans;\n' + sh.fragmentShader
      .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
if (vFolDist < 2.0) {
  ivec2 bi = ivec2(mod(gl_FragCoord.xy, 4.0));
  int bm[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  if ((float(bm[bi.x + bi.y * 4]) + 0.5) / 16.0 >= smoothstep(0.9, 2.0, vFolDist)) discard;
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * (uLeafGlow * 0.6 + uSunC * vFolTrans * 0.3);');
  };
  m.customProgramCacheKey = () => 'cdda-foliage';
  (m.userData as { mrt?: boolean }).mrt = true;
  foliageMat = m;
  return m;
}

/** A horizontal cutout card (both faces) under a lump: the crown's underside edge. */
function hcard(g: GeomBuilder, f: TileFrame, c: V3, half: number, crown: V3, yaw: number): void {
  const ca = Math.cos(yaw) * half, sa = Math.sin(yaw) * half;
  const corners: V3[] = [[c[0] - ca + sa, c[1], c[2] - sa - ca], [c[0] + ca + sa, c[1], c[2] + sa - ca], [c[0] + ca - sa, c[1], c[2] + sa + ca], [c[0] - ca - sa, c[1], c[2] - sa + ca]];
  const ns = corners.map((p) => norm([p[0] - crown[0], p[1] - crown[1], p[2] - crown[2]]));
  g.quadEx(corners[0], corners[1], corners[2], corners[3], ns, [0.001, 0.001, 0.999, 0.999], f, WHITE);
  g.quadEx(corners[1], corners[0], corners[3], corners[2], [ns[1], ns[0], ns[3], ns[2]], [0.999, 0.001, 0.001, 0.999], f, WHITE);
}

/** For tests/debug: painted leaf texture of a palette-less default. */
export function debugLeafImg(): Img {
  return paintLeaves([[26, 40, 20], [52, 78, 34], [78, 108, 46], [118, 146, 64]], 7);
}
void toL;

import type { TerrainDef } from '../data/types';
import type { RGB } from './colors';
import { hash2 } from './ground';
import { Img } from './pixelArt';
import { framePixels } from './framePixels';
import { ModelAtlas } from './furniture/atlas';
import { spritePalette, type SpritePalette } from './furniture/palette';
import type { SurfaceFace, SurfaceQuery, TileFrame } from './textureSource';

// Architectural surfaces for the modelled look (docs/FURNITURE.md "Surfaces"): walls,
// ceilings and man-made floors repainted procedurally at the project's 32 texels/m with
// real-world scale (bricks ~6 x 22 cm with mortar, 14 cm siding boards, 50 cm blocks, 12 cm
// floor boards, 25 cm tiles, 50 cm ceiling tiles), colours from each terrain's UltiCa sprite.
// The UltiCa wall sprites are top-down drawings: stretched over a 2.9 m wall face their
// bricks came out ~30 cm tall in big blotchy pixels.
//
// Interior faces of masonry and plastered walls get an interior finish (paint or wallpaper,
// chosen per building) instead of showing the outside material.
//
// Style: `?surfaces=painted|sprite`, Options > Surfaces, `cdda.setSurfaceStyle()`.
// A frame is one metre of surface (the mesher's UVs are metres, wrapping each 1.0), so every
// pattern tiles in its frame; frames may be taller than 32 texels to fit whole brick courses.

export type SurfaceStyle = 'painted' | 'sprite';
export const SURFACE_STYLES: SurfaceStyle[] = ['painted', 'sprite'];
const STORE_KEY = 'cdda3d.surfaceStyle';

function initialStyle(): SurfaceStyle {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('surfaces') : null;
  if (q) {
    if (!SURFACE_STYLES.includes(q as SurfaceStyle)) throw new Error(`?surfaces must be one of ${SURFACE_STYLES.join('|')}, got ${q}`);
    return q as SurfaceStyle;
  }
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    if (s && SURFACE_STYLES.includes(s as SurfaceStyle)) return s as SurfaceStyle;
  } catch { /* storage blocked */ }
  return 'painted';
}

export const surfaceState = { style: initialStyle(), enabled: false };

export function storeSurfaceStyle(s: SurfaceStyle): void {
  try {
    localStorage.setItem(STORE_KEY, s);
  } catch { /* storage blocked */ }
}

// --- materials ------------------------------------------------------------------------------

export type WallMat = 'brick' | 'adobe' | 'stucco' | 'siding' | 'block' | 'log' | 'stone' | 'metal' | 'concrete' | 'rock';
export type InteriorMat = 'paint' | 'stripes' | 'damask' | 'wainscot' | 'blockpaint';
export type FloorMat = 'planks' | 'carpet' | 'linoleum' | 'tile' | 'concrete' | 'asphalt' | 'slabs' | 'tar' | 'metal';
export type CeilMat = 'plaster' | 'tiles';

/** Exterior wall material from the id (and flags for rock). Pure; unit tested. */
export function wallMat(id: string, flags: readonly string[]): WallMat {
  const k = (re: RegExp) => re.test(id);
  if (k(/adobe/)) return 'adobe';
  if (k(/brick/)) return 'brick';
  if (k(/log/)) return 'log';
  if (k(/wood|board|plank|shack|siding/)) return 'siding';
  if (k(/metal|steel|scrap|bulkhead/)) return 'metal';
  if (k(/cinder|block/)) return 'block';
  if (k(/conc|sconc|strconc/)) return 'concrete';
  if (k(/^t_rock|cave|earth|dirt/) || flags.includes('NATURAL_UNDERGROUND')) return 'rock';
  if (k(/stone/)) return 'stone';
  return 'stucco';
}

/** Which exterior materials get a painted interior finish on their room-facing side. */
const FINISHED: Partial<Record<WallMat, true>> = { brick: true, adobe: true, stucco: true, siding: true, block: true, concrete: true };

/** Floor material, or null for natural ground and marked roads (the atlas sprite stays). */
export function floorMat(id: string): FloorMat | null {
  const k = (re: RegExp) => re.test(id);
  if (k(/_y$|_y_|stripe|zebra|parking|dashed|marking/)) return null;
  if (k(/carpet|rug/)) return 'carpet';
  if (k(/linoleum/)) return 'linoleum';
  if (k(/tile|marble|bathroom|kitchen|waxed|floor_(red|green|blue)$/)) return 'tile';
  if (k(/^t_floor(_noroof)?$|wood.*floor|floor.*wood|plank|barkfloor|floor_primitive/)) return 'planks';
  if (k(/thconc|strconc|concrete|conc_floor|floor_olight/)) return 'concrete';
  if (k(/^t_pavement$/)) return 'asphalt';
  if (k(/^t_sidewalk$/)) return 'slabs';
  if (k(/^t_flat_roof$|tar_roof|metal_flat_roof/)) return 'tar';
  if (k(/metal_floor|bulkhead_floor/)) return 'metal';
  return null;
}

export function ceilMat(id: string): CeilMat {
  // commercial slabs (concrete / tar roofs over shops) get a drop ceiling; houses plaster
  // (flat roofs cover houses as often as shops: plaster under them)
  return /thconc|strconc|metal_floor/.test(id) ? 'tiles' : 'plaster';
}

// --- painting -------------------------------------------------------------------------------

const clamp = (v: number) => Math.max(0, Math.min(255, v));
const sh = (c: RGB, k: number): RGB => [clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const q8 = (c: RGB): RGB => c.map((v) => Math.round(v / 8) * 8) as RGB;

/** Interior paint colours, picked per building. */
const PAINTS: RGB[] = [[214, 208, 192], [200, 196, 180], [186, 198, 196], [196, 186, 160], [176, 188, 168], [204, 190, 176], [180, 186, 200]];
const PAPERS: RGB[] = [[166, 150, 120], [140, 158, 150], [168, 132, 124], [150, 146, 170], [190, 176, 140]];

export function paintWall(m: WallMat, c: RGB, mortar: RGB, seed: number): Img {
  const H = (x: number, y: number, s = 0) => hash2(x, y, seed + s);
  switch (m) {
    case 'brick': case 'adobe': {
      // brick: 8 texels long (25 cm incl. joint) x 3 (2 brick + 1 mortar, 8 cm course);
      // adobe: big 16 x 6 blocks. 12 / 6 courses per frame keep the half-brick bond parity.
      const [bw, bh, rows] = m === 'brick' ? [8, 3, 12] : [16, 6, 6];
      const img = new Img(32, bh * rows);
      for (let y = 0; y < img.h; y++) {
        const row = Math.floor(y / bh), off = row & 1 ? bw / 2 : 0;
        for (let x = 0; x < 32; x++) {
          const bx = Math.floor((x + off) / bw) % (32 / bw);
          const joint = y % bh === bh - 1 || (x + off) % bw === bw - 1;
          if (joint) { img.set(x, y, H(x, y, 3) % 7 === 0 ? sh(mortar, 0.9) : mortar); continue; }
          const tone = H(bx, row, 1) % 9;
          let k = tone === 0 ? 0.78 : tone === 1 ? 0.88 : tone === 8 ? 1.1 : 1;
          if (m === 'brick' && y % bh === 0) k *= 1.06; // light top edge of each brick
          if (H(x, y, 2) % 23 === 0) k *= 0.9;
          img.set(x, y, sh(c, k));
        }
      }
      return img;
    }
    case 'siding': {
      // lap siding: 5-texel (14 cm) boards, a shadow line under each lap
      const img = new Img(32, 35);
      for (let y = 0; y < 35; y++) {
        const ly = y % 5;
        for (let x = 0; x < 32; x++) {
          let k = ly === 4 ? 0.7 : ly === 0 ? 1.08 : 1;
          if (H(x >> 3, Math.floor(y / 5), 4) % 11 === 0) k *= 0.93;
          img.set(x, y, sh(c, k));
        }
      }
      return img;
    }
    case 'block': {
      // concrete block 16 x 6 texels (50 x 17 cm) with mortar, half bond
      const img = new Img(32, 36);
      for (let y = 0; y < 36; y++) {
        const row = Math.floor(y / 6), off = row & 1 ? 8 : 0;
        for (let x = 0; x < 32; x++) {
          const joint = y % 6 === 5 || (x + off) % 16 === 15;
          const n = H(x, y, 5) % 13;
          img.set(x, y, joint ? mortar : sh(c, n === 0 ? 0.9 : n === 1 ? 1.06 : 1));
        }
      }
      return img;
    }
    case 'log': {
      const img = new Img(32, 32);
      for (let y = 0; y < 32; y++) {
        const ly = y & 7;
        const k = ly === 0 || ly === 7 ? 0.62 : ly < 3 ? 1.1 : ly < 5 ? 1 : 0.86;
        for (let x = 0; x < 32; x++) img.set(x, y, sh(c, k * (H(x >> 2, y >> 3, 6) % 7 === 0 ? 0.92 : 1)));
      }
      return img;
    }
    case 'metal': {
      // corrugated panels: 4-texel ribs
      const img = new Img(32, 32);
      for (let x = 0; x < 32; x++) {
        const k = [1.12, 1, 0.84, 0.94][x & 3];
        for (let y = 0; y < 32; y++) img.set(x, y, sh(c, k * (H(x, y, 7) % 29 === 0 ? 0.85 : 1)));
      }
      return img;
    }
    case 'stone': case 'rock': {
      const img = new Img(32, 32);
      img.fill(sh(c, 0.9));
      for (let i = 0; i < (m === 'stone' ? 10 : 16); i++) {
        const x0 = H(i, 0, 8) % 32, y0 = H(i, 1, 8) % 32, w = 4 + (H(i, 2, 8) % 7), h = 3 + (H(i, 3, 8) % 4);
        const k = 0.9 + (H(i, 4, 8) % 5) * 0.05;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set((x0 + x) % 32, (y0 + y) % 32, sh(c, y === 0 ? k * 1.12 : y === h - 1 ? k * 0.75 : k));
      }
      return img;
    }
    case 'concrete': case 'stucco': {
      // calm render: soft mottling, the odd pit; concrete gets form-tie holes
      const img = new Img(32, 32);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const n = (H(x >> 2, y >> 2, 9) % 3) * 0.01 + (H(x, y, 10) % 41 === 0 ? -0.05 : 0);
        img.set(x, y, sh(c, 0.97 + n));
      }
      if (m === 'concrete') for (const [x, y] of [[8, 8], [24, 8], [8, 24], [24, 24]]) img.set(x, y, sh(c, 0.7));
      return img;
    }
  }
}

/** Interior finish: `c` is the paint, `m` the kind; wainscot = paper above a painted dado. */
export function paintInterior(m: InteriorMat, c: RGB, accent: RGB, seed: number): Img {
  const H = (x: number, y: number, s = 0) => hash2(x, y, seed + s);
  const img = new Img(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    // drywall is flat: any texel variation (even 1-2 %) turns into blotches under the
    // renderer's luminance bump and dither
    let col = c;
    if (m === 'stripes' && (x % 8 === 0 || x % 8 === 1)) col = mix(col, accent, 0.35);
    if (m === 'damask' && ((x + (y >> 3) * 4) % 8 === 3) && y % 8 === 3) col = mix(col, accent, 0.5);
    if (m === 'damask' && ((x + (y >> 3) * 4) % 8 === 3) && (y % 8 === 2 || y % 8 === 4)) col = mix(col, accent, 0.25);
    if (m === 'blockpaint' && (y % 6 === 5 || (x + ((Math.floor(y / 6) & 1) ? 8 : 0)) % 16 === 15)) col = sh(c, 0.88);
    img.set(x, y, col);
  }
  return img;
}

export function paintFloor(m: FloorMat, c: RGB, seed: number, variant: number): Img {
  const H = (x: number, y: number, s = 0) => hash2(x, y, seed + s + variant * 101);
  const img = new Img(32, 32);
  switch (m) {
    case 'planks': {
      // 4-texel (12.5 cm) boards along x; butt joints staggered per board and variant
      for (let y = 0; y < 32; y++) {
        const b = y >> 2, joint = (H(b, 0, 12) % 24) + 4;
        const tone = [0.9, 1, 1.06, 0.95, 1.02][H(b, 1, 13) % 5];
        for (let x = 0; x < 32; x++) {
          let k = tone;
          if ((y & 3) === 3) k *= 0.72;
          else if (x === joint || x === (joint + 16) % 32 && H(b, 2, 14) % 2) k *= 0.7;
          else if (H(x >> 2, y, 15) % 9 === 0) k *= 0.93;
          img.set(x, y, sh(c, k));
        }
      }
      return img;
    }
    case 'carpet': {
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const n = H(x, y, 16) % 7;
        img.set(x, y, sh(c, n === 0 ? 0.9 : n === 1 ? 1.07 : 1));
      }
      return img;
    }
    case 'linoleum': case 'tile': {
      // 8-texel (25 cm) squares; linoleum faint seams, ceramic tile real grout
      const grout = m === 'tile' ? mix(c, [200, 196, 188], 0.55) : sh(c, 0.92);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const edge = x % 8 === 7 || y % 8 === 7;
        const cell = H(x >> 3, y >> 3, 17) % 6;
        const k = m === 'linoleum' ? (((x >> 3) + (y >> 3)) & 1 ? 0.96 : 1.02) : cell === 0 ? 0.95 : 1;
        let col = edge ? grout : sh(c, k);
        if (!edge && m === 'tile' && x % 8 === 0 && y % 8 === 0) col = sh(c, k * 1.08);
        if (!edge && H(x, y, 18) % 31 === 0) col = sh(col, 0.93);
        img.set(x, y, col);
      }
      return img;
    }
    case 'concrete': case 'slabs': {
      // troweled concrete: soft mottle, a joint line every metre (the frame edge)
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const n = (H(x >> 2, y >> 2, 19) % 5) * 0.015;
        let col = sh(c, 0.96 + n);
        if (H(x, y, 20) % 37 === 0) col = sh(c, 0.88);
        if (x === 0 || y === 0) col = sh(c, m === 'slabs' ? 0.78 : 0.88);
        img.set(x, y, col);
      }
      return img;
    }
    case 'asphalt': case 'tar': {
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const n = H(x, y, 21) % 13;
        img.set(x, y, n === 0 ? sh(c, 1.18) : n === 1 ? sh(c, 0.88) : n === 2 ? sh(c, 1.08) : c);
      }
      if (H(0, 0, 22) % 3 === 0) {
        // a hairline crack
        let x = H(1, 1, 23) % 32;
        for (let y = 0; y < 32; y++) { img.set(x, y, sh(c, 0.6)); x = (x + 32 + (H(x, y, 24) % 3) - 1) % 32; }
      }
      return img;
    }
    case 'metal': {
      // diamond plate
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const d = ((x + y) % 8 === 0 && (x >> 2) % 2 === 0) || ((x - y + 64) % 8 === 0 && (x >> 2) % 2 === 1);
        img.set(x, y, d ? sh(c, 1.2) : sh(c, H(x, y, 25) % 9 === 0 ? 0.92 : 1));
      }
      return img;
    }
  }
}

export function paintCeiling(m: CeilMat, c: RGB): Img {
  const img = new Img(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let col = c;
    if (m === 'tiles') {
      // 50 cm drop-ceiling tiles on a light grid, fissured
      if (x % 16 === 0 || y % 16 === 0) col = mix(c, [236, 236, 232], 0.6);
      else if (hash2(x, y, 32) % 9 === 0) col = sh(c, 0.9);
    }
    img.set(x, y, col);
  }
  return img;
}

/** Shingle rows at 32 texels/m (hipped roofs): staggered tabs, shadow line under each row. */
export function paintShingles(c: RGB): Img {
  const img = new Img(32, 32);
  for (let y = 0; y < 32; y++) {
    const row = y >> 3, ly = y & 7, off = row & 1 ? 5 : 0;
    for (let x = 0; x < 32; x++) {
      const tab = Math.floor((x + off) / 10);
      const tone = [0.92, 1, 1.07, 0.96][hash2(tab, row, 41) & 3];
      let k = ly === 7 ? 0.55 : ly === 6 ? 0.8 : ly === 0 ? 1.08 : tone;
      if ((x + off) % 10 === 0 && ly < 6) k = 0.62;
      if (hash2(x, y, 42) % 19 === 0 && ly < 6) k *= 0.88;
      img.set(x, y, sh(c, k));
    }
  }
  return img;
}

/** Painted trim (baseboards, crown): a calm 2-tone. */
export function paintTrim(c: RGB): Img {
  const img = new Img(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) img.set(x, y, sh(c, y === 0 ? 1.1 : y === 7 ? 0.8 : 1));
  return img;
}

// --- the painter ----------------------------------------------------------------------------

/** Room-facing request: SurfaceQuery.variantSeed carries the building seed for walls. */
export class SurfacePainter {
  readonly atlas: ModelAtlas;
  private frames = new Map<string, TileFrame>();
  private pals = new Map<string, SpritePalette | null>();

  constructor(private terrain: Record<string, TerrainDef>, atlas?: ModelAtlas) {
    this.atlas = atlas ?? new ModelAtlas();
  }

  active(): boolean {
    return surfaceState.enabled && surfaceState.style === 'painted';
  }

  private palette(key: string, frame: () => TileFrame | null): SpritePalette | null {
    if (this.pals.has(key)) return this.pals.get(key)!;
    const f = frame();
    const px = f ? framePixels(f) : null;
    const p = px ? spritePalette(px) : null;
    this.pals.set(key, p);
    return p;
  }

  private frame(key: string, paint: () => Img): TileFrame {
    let f = this.frames.get(key);
    if (!f) this.frames.set(key, (f = this.atlas.frame('s:' + key, paint)));
    return f;
  }

  /**
   * A painted frame for (id, face), or null to keep the atlas/procedural surface.
   * `sprite` gives the id's UltiCa sprite (for colours).
   */
  surface(id: string, face: SurfaceFace, q: (SurfaceQuery & { indoor?: boolean }) | undefined, sprite: () => TileFrame | null): TileFrame | null {
    const t = this.terrain[id];
    if (!t) return null;
    if (face === 'wall' || face === 'side') return this.wall(id, t, q, sprite);
    if (face === 'ceiling') {
      const m = ceilMat(id);
      const c: RGB = m === 'tiles' ? [196, 194, 186] : [206, 202, 192];
      return this.frame(`ceil:${m}`, () => paintCeiling(m, c));
    }
    if (face === 'floor') {
      const m = floorMat(id);
      if (!m) return null;
      const pal = this.palette('f:' + id, sprite);
      let c = q8(pal ? (m === 'carpet' || m === 'tile' || m === 'linoleum' ? pal.main : m === 'planks' ? woodTone(pal) : pal.main) : [120, 110, 100]);
      if (m === 'asphalt') c = q8(mix(c, [58, 58, 60], 0.5));
      if (m === 'tar') c = q8(mix(c, [70, 68, 66], 0.5));
      const variants = m === 'planks' || m === 'asphalt' || m === 'concrete' ? 3 : 1;
      const v = (q?.variantSeed ?? 0) % variants;
      return this.frame(`floor:${m}:${c.join(',')}:${v}`, () => paintFloor(m, c, 7, v));
    }
    return null;
  }

  private wall(id: string, t: TerrainDef, q: (SurfaceQuery & { indoor?: boolean }) | undefined, sprite: () => TileFrame | null): TileFrame | null {
    const m = wallMat(id, t.flags);
    const pal = this.palette('w:' + id, sprite);
    const main = pal?.main ?? [150, 140, 130];
    if (q?.indoor && FINISHED[m]) return this.interior(id, m, q.variantSeed ?? 0, pal);
    let c: RGB = main, mortar: RGB = pal ? pal.light : [190, 186, 176];
    if (m === 'brick') {
      // UltiCa brick sprites draw bricks in the main colour, mortar in the lightest
      if (lum(mortar) - lum(c) < 30) mortar = mix(c, [210, 204, 190], 0.6);
    } else if (m === 'block' || m === 'concrete') {
      c = mix(main, [150, 148, 142], 0.4);
      mortar = sh(c, 0.82);
    } else if (m === 'stucco') {
      c = mix(main, [196, 188, 170], 0.45);
    } else if (m === 'siding') {
      c = mix(main, [176, 150, 118], 0.2);
    }
    c = q8(c); mortar = q8(mortar);
    return this.frame(`wall:${m}:${c.join(',')}:${mortar.join(',')}`, () => paintWall(m, c, mortar, 5));
  }

  private interior(id: string, m: WallMat, seed: number, pal: SpritePalette | null): TileFrame {
    // coloured walls (t_wall_r/_y/_b...) keep their colour; plain ones pick per building
    const coloured = /_(r|y|b|g|p|w|red|yellow|blue|green|purple|white)$/.test(id) && pal;
    const h = hash2(seed, 0, 51);
    let kind: InteriorMat = m === 'block' || m === 'concrete' ? 'blockpaint' : (['paint', 'paint', 'stripes', 'damask', 'paint'] as InteriorMat[])[h % 5];
    let c = coloured ? q8(mix(pal!.main, [220, 216, 206], 0.35)) : PAINTS[(h >>> 4) % PAINTS.length];
    if (kind === 'stripes' || kind === 'damask') c = PAPERS[(h >>> 8) % PAPERS.length];
    if (coloured) kind = kind === 'blockpaint' ? kind : 'paint';
    const accent = sh(c, 0.78);
    return this.frame(`int:${kind}:${c.join(',')}`, () => paintInterior(kind, c, accent, 3));
  }

  /** Trim (baseboards, crown moulding) frame. */
  trim(c: RGB = [226, 222, 212]): TileFrame {
    return this.frame(`trim:${c.join(',')}`, () => paintTrim(c));
  }

  shingles(c: RGB = [92, 80, 74]): TileFrame {
    return this.frame(`shingle:${c.join(',')}`, () => paintShingles(c));
  }
}

function woodTone(p: SpritePalette): RGB {
  // floor sprites are drawn with light and dark boards: take a mid brown
  const woody = p.clusters.find((q) => q.c[0] > q.c[2] + 20 && lum(q.c) > 50 && lum(q.c) < 190);
  return woody?.c ?? p.main;
}

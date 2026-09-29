import { Rng, hashString } from '../core/rng';
import { type RGB, cddaColor, hexToRgb, mixRgb } from './colors';

// Procedural pixel-art stand-ins for CDDA terrain/furniture, used until the UltiCa atlas
// is wired in (and as a fallback for ids the tileset lacks). Everything here is pure
// (no DOM, no three.js) so it runs in unit tests.
//
// Art direction: 16 texels per metre, 3-4 value ramps per material, muted and slightly
// desaturated so the post-pass palette grading has room to work. CDDA's curses colors
// are garish (t_floor is cyan!), so they only *tint* a material's own ramp; painted walls
// and carpets take more of the tint than natural materials.

export const TEXELS_PER_M = 16;

export class Img {
  readonly data: Uint8ClampedArray;
  constructor(readonly w: number, readonly h: number) {
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  set(x: number, y: number, c: RGB, a = 255): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = a;
  }
  alpha(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[(y * this.w + x) * 4 + 3];
  }
  fill(c: RGB, a = 255): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c, a);
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB, a = 255): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c, a);
  }
  /** Dark 1px rim on every opaque pixel bordering transparency: sprites read at low res. */
  outline(c: RGB): void {
    const edge: number[] = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (this.alpha(x, y) !== 0) continue;
        if (this.alpha(x - 1, y) || this.alpha(x + 1, y) || this.alpha(x, y - 1) || this.alpha(x, y + 1)) edge.push(x, y);
      }
    for (let i = 0; i < edge.length; i += 2) this.set(edge[i], edge[i + 1], c);
  }
}

const H = hexToRgb;
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** A 4-step material ramp, darkest first. */
export type Ramp = [RGB, RGB, RGB, RGB];
const ramp = (a: number, b: number, c: number, d: number): Ramp => [H(a), H(b), H(c), H(d)];

export type Pattern =
  // floors
  | 'grass' | 'dirt' | 'sand' | 'gravel' | 'pavement' | 'sidewalk' | 'concrete' | 'planks'
  | 'carpet' | 'tiles' | 'water' | 'rock' | 'roof' | 'metal' | 'snow' | 'ceiling'
  // walls
  | 'plaster' | 'brick' | 'boards' | 'log' | 'blocks' | 'stone' | 'metalwall'
  // panes / special
  | 'door' | 'glass' | 'curtain' | 'picket' | 'chainlink' | 'bars' | 'stairs';

const RAMPS: Record<Pattern, Ramp> = {
  grass: ramp(0x26331c, 0x3a4a26, 0x4f5f30, 0x6b7a3c),
  dirt: ramp(0x32251b, 0x473526, 0x5a4431, 0x6e553d),
  sand: ramp(0x6b5d44, 0x7f6f51, 0x93825f, 0xa8966e),
  gravel: ramp(0x3c3a37, 0x524f4a, 0x69655e, 0x827c72),
  pavement: ramp(0x242528, 0x303134, 0x3b3c3f, 0x4a4a4c),
  sidewalk: ramp(0x4f4e4a, 0x62605b, 0x716f69, 0x807d76),
  concrete: ramp(0x46453f, 0x56554f, 0x64625b, 0x747168),
  planks: ramp(0x2f2016, 0x4a3322, 0x5c4029, 0x6e4e33),
  carpet: ramp(0x2c2626, 0x3a3232, 0x453c3b, 0x514745),
  tiles: ramp(0x5c5b55, 0x77756d, 0x86847b, 0x96948a),
  water: ramp(0x14283a, 0x1e3a50, 0x2b5068, 0x4a7890),
  rock: ramp(0x2c2a28, 0x3d3a37, 0x4e4a45, 0x625d56),
  roof: ramp(0x1f1f22, 0x29292c, 0x333336, 0x404043),
  metal: ramp(0x34383c, 0x444a4f, 0x555b60, 0x6a7176),
  snow: ramp(0x9aa2ac, 0xb4bcc4, 0xc8cfd6, 0xdce2e8),
  ceiling: ramp(0x5a564f, 0x68645c, 0x736f66, 0x7e796f),
  plaster: ramp(0x5e5a52, 0x6f6a61, 0x7c776c, 0x8a8479),
  brick: ramp(0x4a2a20, 0x5e3326, 0x70402f, 0x544a42),
  boards: ramp(0x33241a, 0x4b3525, 0x5b412d, 0x6b4d36),
  log: ramp(0x2e2016, 0x453022, 0x57402c, 0x6a5038),
  blocks: ramp(0x3e3d3a, 0x4d4c48, 0x5b5a55, 0x6a6862),
  stone: ramp(0x302e2c, 0x44413d, 0x57534d, 0x6b665e),
  metalwall: ramp(0x2e3236, 0x3f4449, 0x50565c, 0x646b71),
  door: ramp(0x2c1d13, 0x45301f, 0x57402a, 0x6b5036),
  glass: ramp(0x1a2a30, 0x5a7a86, 0x8fb2bd, 0xc8e0e6),
  curtain: ramp(0x3a2e2e, 0x4c3c3a, 0x5a4845, 0x6a5652),
  picket: ramp(0x4a4640, 0x6e6a62, 0x8a857b, 0xa39e92),
  chainlink: ramp(0x3a3e42, 0x5a6064, 0x767c80, 0x959a9c),
  bars: ramp(0x222426, 0x383b3e, 0x4c5054, 0x626669),
  stairs: ramp(0x2f2016, 0x4a3322, 0x5c4029, 0x6e4e33),
};

/** How strongly the CDDA color tints each material (painted surfaces take more). */
const TINT: Partial<Record<Pattern, number>> = {
  plaster: 0.35, carpet: 0.55, curtain: 0.5, tiles: 0.25, door: 0.15, blocks: 0.1, metalwall: 0.15,
  concrete: 0.08, planks: 0.08, boards: 0.12,
};

export function patternFor(id: string, flags: readonly string[], face: 'floor' | 'wall' | 'pane'): Pattern {
  const has = (f: string) => flags.includes(f);
  const k = (re: RegExp) => re.test(id);
  if (face === 'pane') {
    if (k(/curtain/) && !k(/open|no_curtain/)) return 'curtain';
    if (k(/chain|wire/)) return 'chainlink';
    if (k(/bars|rail|metal/)) return 'bars';
    if (k(/fence|picket|gate/)) return 'picket';
    if (k(/door/)) return k(/glass/) ? 'glass' : 'door';
    return 'glass';
  }
  if (face === 'wall') {
    if (k(/brick/)) return 'brick';
    if (k(/log/)) return 'log';
    if (k(/wood|board|plank|shack/)) return 'boards';
    if (k(/metal|steel|scrap|bulkhead/)) return 'metalwall';
    if (k(/conc|cinder|block|sconc|strconc/)) return 'blocks';
    if (k(/rock|stone|cave|earth|dirt/) || has('NATURAL_UNDERGROUND')) return 'stone';
    return 'plaster';
  }
  if (has('LIQUID') || k(/water/)) return 'water';
  if (k(/grass|lawn|moss|meadow/)) return 'grass';
  if (k(/sand|beach/)) return 'sand';
  if (k(/gravel|railroad|rubble/)) return 'gravel';
  if (k(/snow|ice/)) return 'snow';
  if (k(/sidewalk|curb/)) return 'sidewalk';
  if (k(/pavement|asphalt|road|parking/)) return 'pavement';
  if (k(/carpet|rug/) || has('RUG')) return 'carpet';
  if (k(/linoleum|tile|marble|bathroom|kitchen/)) return 'tiles';
  if (k(/roof/)) return 'roof';
  if (k(/metal|bulkhead|grate|scrap/)) return 'metal';
  if (k(/conc|thconc|sconc|strconc|cement/)) return 'concrete';
  if (k(/rock|stone|cave/)) return 'rock';
  if (k(/dirt|mud|clay|field|underbrush|forest|furrow|farm/)) return 'dirt';
  if (k(/floor|wood|plank|stairs/)) return 'planks';
  if (has('INDOORS')) return 'planks';
  if (has('ROAD')) return 'pavement';
  return 'dirt';
}

function tinted(p: Pattern, cdda: string): Ramp {
  const base = RAMPS[p];
  const t = TINT[p] ?? 0.05;
  if (t <= 0) return base;
  const tc = hexToRgb(cddaColor(cdda));
  // Tint in "value-preserving" fashion: move hue toward the CDDA color but keep each
  // step's brightness, otherwise yellow/white CDDA colors blow textures out.
  return base.map((c) => {
    const lum = (c[0] + c[1] + c[2]) / 3;
    const tl = Math.max(1, (tc[0] + tc[1] + tc[2]) / 3);
    const target: RGB = [tc[0] * lum / tl, tc[1] * lum / tl, tc[2] * lum / tl];
    return mixRgb(c, target, t).map((v) => Math.min(255, v)) as RGB;
  }) as Ramp;
}

/** A material ramp built around a sampled colour (e.g. a tileset sprite's average). */
export function rampAround(c: RGB, spread = 1): Ramp {
  const k = (m: number) => c.map((v) => Math.min(255, v * (1 + (m - 1) * spread))) as RGB;
  return [k(0.55), k(0.78), k(0.92), k(1.08)];
}

/** Paint a 16x16 (one tile) surface texture. `rampOverride` replaces the material colours. */
export function paintSurface(p: Pattern, cddaColorName: string, seed: number, rampOverride?: Ramp): Img {
  const S = TEXELS_PER_M;
  const img = new Img(S, S);
  const r = rampOverride ?? tinted(p, cddaColorName);
  const rng = new Rng(seed);
  const pick = (w: number[]) => r[rng.weighted(w.map((v, i) => [i, v] as const))];
  switch (p) {
    case 'grass': {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(x, y, pick([2, 5, 2, 0]));
      // blades: short vertical strokes with a highlight tip
      for (let i = 0; i < 14; i++) {
        const x = rng.int(0, S - 1), y = rng.int(1, S - 1);
        img.set(x, y, r[2]); img.set(x, y - 1, r[3]);
      }
      for (let i = 0; i < 6; i++) img.set(rng.int(0, S - 1), rng.int(0, S - 1), r[0]);
      break;
    }
    case 'dirt': case 'sand': case 'snow': {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(x, y, pick([1, 6, 3, 0]));
      for (let i = 0; i < 5; i++) {
        const x = rng.int(0, S - 2), y = rng.int(0, S - 2);
        img.set(x, y, r[3]); img.set(x + 1, y + 1, r[0]);
      }
      break;
    }
    case 'gravel': case 'rock': {
      img.fill(r[1]);
      for (let i = 0; i < 22; i++) {
        const x = rng.int(0, S - 1), y = rng.int(0, S - 1);
        img.set(x, y, r[2]); img.set(x + 1, y, r[2]); img.set(x, y + 1, r[0]);
        if (rng.oneIn(3)) img.set(x, y, r[3]);
      }
      break;
    }
    case 'pavement': case 'roof': {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(x, y, pick([1, 8, 3, 0.4]));
      if (rng.oneIn(3)) {
        // hairline crack wandering across the tile
        let x = rng.int(0, S - 1);
        for (let y = 0; y < S; y++) { img.set(x, y, r[0]); x += rng.int(-1, 1); }
      }
      break;
    }
    case 'sidewalk': case 'concrete': case 'ceiling': {
      // ceilings are big calm surfaces seen from up close: little speckle (it read as noise
      // once interiors were lit and rendered at higher resolution)
      const w = p === 'ceiling' ? [0.05, 1.2, 12, 0.4] : [0.3, 3, 8, 1];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(x, y, pick(w));
      if (p === 'sidewalk') for (let i = 0; i < S; i++) { img.set(i, 0, r[0]); img.set(0, i, r[0]); img.set(i, 8, r[1]); }
      if (p === 'ceiling') for (let i = 0; i < S; i++) img.set(i, 0, r[1]);
      break;
    }
    case 'planks': case 'stairs': {
      // 4 planks per tile, staggered butt joints
      for (let y = 0; y < S; y++) {
        const plank = y >> 2;
        for (let x = 0; x < S; x++) img.set(x, y, (y & 3) === 0 ? r[0] : rng.oneIn(7) ? r[3] : r[1 + ((plank + (x >> 3)) & 1)]);
      }
      for (let pl = 0; pl < 4; pl++) img.set((pl * 5 + seed) & 15, pl * 4 + 2, r[0]);
      break;
    }
    case 'carpet': {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(x, y, pick([0.5, 6, 3, 0.3]));
      break;
    }
    case 'tiles': {
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const grout = (x & 7) === 0 || (y & 7) === 0;
          img.set(x, y, grout ? r[0] : ((x >> 3) + (y >> 3)) & 1 ? r[2] : r[3]);
        }
      break;
    }
    case 'metal': {
      img.fill(r[1]);
      for (let y = 1; y < S; y += 4) for (let x = (y >> 2) & 1 ? 1 : 3; x < S; x += 4) { img.set(x, y, r[3]); img.set(x + 1, y + 1, r[0]); }
      break;
    }
    case 'water': {
      img.fill(r[1]);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (rng.oneIn(5)) img.set(x, y, r[0]);
      for (let i = 0; i < 4; i++) {
        const x = rng.int(0, S - 5), y = rng.int(0, S - 1);
        for (let j = 0; j < 4; j++) img.set(x + j, y, r[2 + (j === 1 ? 1 : 0)]);
      }
      break;
    }
    case 'plaster': {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(x, y, pick([0.1, 1.2, 10, 0.4]));
      if (rng.oneIn(2)) { const x = rng.int(2, S - 3), y = rng.int(2, S - 3); img.set(x, y, r[0]); img.set(x + 1, y, r[1]); }
      break;
    }
    case 'brick': {
      const mortar = r[3];
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const row = y >> 2;
          const off = row & 1 ? 4 : 0;
          if ((y & 3) === 3 || ((x + off) & 7) === 7) img.set(x, y, mortar);
          else img.set(x, y, rng.oneIn(9) ? r[0] : r[1 + ((row * 3 + ((x + off) >> 3)) % 2)]);
        }
      break;
    }
    case 'boards': case 'door': {
      // vertical boards
      for (let x = 0; x < S; x++)
        for (let y = 0; y < S; y++) img.set(x, y, (x & 3) === 0 ? r[0] : rng.oneIn(8) ? r[3] : r[1 + ((x >> 2) & 1)]);
      if (p === 'door') {
        for (let i = 0; i < S; i++) { img.set(0, i, r[0]); img.set(S - 1, i, r[0]); }
        img.rect(2, 3, 5, 4, r[2]); img.rect(9, 3, 5, 4, r[2]);
      }
      break;
    }
    case 'log': {
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const ly = y & 7;
        img.set(x, y, ly === 0 || ly === 7 ? r[0] : ly < 3 ? r[3] : ly < 5 ? r[2] : r[1]);
      }
      break;
    }
    case 'blocks': {
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const off = (y >> 3) & 1 ? 8 : 0;
          const seam = (y & 7) === 7 || ((x + off) & 15) === 15;
          img.set(x, y, seam ? r[0] : rng.oneIn(10) ? r[3] : r[2]);
        }
      break;
    }
    case 'stone': {
      img.fill(r[1]);
      for (let i = 0; i < 7; i++) {
        const x0 = rng.int(0, S - 1), y0 = rng.int(0, S - 1), w = rng.int(3, 6), h = rng.int(2, 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set((x0 + x) % S, (y0 + y) % S, y === 0 ? r[3] : y === h - 1 ? r[0] : r[2]);
      }
      break;
    }
    case 'metalwall': {
      for (let x = 0; x < S; x++) for (let y = 0; y < S; y++) img.set(x, y, [r[2], r[3], r[2], r[1]][x & 3]);
      break;
    }
    case 'glass': {
      // Mostly transparent: glints and grime are what make glass read in pixel art.
      img.fill(r[1], 0);
      for (let i = -S; i < S; i++) {
        const x = i + 5, y = S - 1 - i;
        if (i % 3 !== 0) { img.set(x, y - 4, r[3]); img.set(x + 1, y - 4, r[2]); }
      }
      for (let i = 0; i < 4; i++) img.set(rng.int(0, S - 1), rng.int(10, S - 1), r[1]);
      break;
    }
    case 'curtain': {
      for (let x = 0; x < S; x++) for (let y = 0; y < S; y++) img.set(x, y, [r[1], r[2], r[3], r[2], r[1], r[0]][x % 6]);
      break;
    }
    case 'picket': {
      img.fill(r[0], 0);
      for (let x = 0; x < S; x++) for (let y = 0; y < S; y++) {
        const post = (x & 3) < 2;
        if (post && y > 1) img.set(x, y, (x & 3) === 0 ? r[3] : r[2]);
        if (post && y === 1 && (x & 3) === 0) img.set(x, y, r[2]);
        if (y === 5 || y === 12) img.set(x, y, r[1]);
      }
      break;
    }
    case 'chainlink': {
      img.fill(r[0], 0);
      for (let x = 0; x < S; x++) for (let y = 0; y < S; y++) {
        if ((x + y) % 4 === 0 || (x - y + S) % 4 === 0) img.set(x, y, r[2]);
      }
      for (let x = 0; x < S; x++) img.set(x, 0, r[3]);
      break;
    }
    case 'bars': {
      img.fill(r[0], 0);
      for (let x = 1; x < S; x += 4) for (let y = 0; y < S; y++) { img.set(x, y, r[2]); img.set(x + 1, y, r[1]); }
      for (let x = 0; x < S; x++) img.set(x, 0, r[3]);
      break;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------
// Sprites (billboards). Anchored bottom-centre; texel density matches surfaces (16/m).

export function paintTree(seed: number, season: string, kind: 'tree' | 'shrub' | 'pine'): Img {
  const rng = new Rng(seed);
  const shrub = kind === 'shrub';
  const w = shrub ? 20 : 44, h = shrub ? 18 : 72;
  const img = new Img(w, h);
  const leaf: Ramp = season === 'autumn'
    ? ramp(0x3a1f10, 0x6a3418, 0x8a4a1c, 0xa8702a)
    : season === 'winter' && kind !== 'pine'
      ? ramp(0x2a2622, 0x3a342e, 0x4a423a, 0x5a5046)
      : kind === 'pine' ? ramp(0x14221a, 0x1f3326, 0x2a4430, 0x3a5638) : ramp(0x1a2a14, 0x2a4020, 0x3c5628, 0x557034);
  const bark: Ramp = ramp(0x1e150e, 0x2e2016, 0x3e2c1e, 0x4e3a28);
  const cx = w / 2;
  if (!shrub) {
    const tw = 3 + rng.int(0, 2);
    for (let y = Math.floor(h * 0.35); y < h; y++)
      for (let x = -tw; x < tw; x++) img.set(cx + x, y, x < -tw + 2 ? bark[1] : x > tw - 2 ? bark[0] : bark[2]);
    // root flare
    img.set(cx - tw - 1, h - 1, bark[1]); img.set(cx + tw, h - 1, bark[0]);
  }
  const blobs: [number, number, number][] = [];
  if (kind === 'pine') {
    for (let i = 0; i < 6; i++) {
      const y = 6 + i * 8, rr = 4 + i * 2.6;
      blobs.push([cx, y, rr]);
    }
  } else if (shrub) {
    blobs.push([cx, h - 8, 8], [cx - 4, h - 6, 5], [cx + 4, h - 6, 5]);
  } else {
    const n = 7 + rng.int(0, 4);
    for (let i = 0; i < n; i++) blobs.push([cx + rng.int(-12, 12), rng.int(10, 34), rng.int(7, 12)]);
    blobs.push([cx, 22, 14]);
  }
  const bare = season === 'winter' && kind !== 'pine';
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let inside = false, shadeV = 0;
      for (const [bx, by, br] of blobs) {
        const dx = x - bx, dy = (y - by) * (kind === 'pine' ? 2.2 : 1);
        const d = Math.sqrt(dx * dx + dy * dy) / br;
        if (d < 1) {
          inside = true;
          // light from upper left; lower-right part of each clump darker
          shadeV = Math.max(shadeV, 1 - d * 0.6 + (-dx - dy) / br * 0.35);
        }
      }
      if (!inside) continue;
      if (bare && rng.oneIn(2)) continue;
      const jitter = rng.next() * 0.35 - 0.17;
      const v = shadeV + jitter;
      img.set(x, y, leaf[v > 1.05 ? 3 : v > 0.75 ? 2 : v > 0.45 ? 1 : 0]);
    }
  img.outline(shade(leaf[0], 0.6));
  return img;
}

export function paintPlayer(): Img {
  // 16x28 survivor: hood, jacket, jeans. Deliberately low-detail; UltiCa replaces it.
  const img = new Img(16, 28);
  const skin = H(0xb08868), jacket = H(0x4a5a3a), jacketD = H(0x344028), jeans = H(0x2e3a52), boots = H(0x2a2018), hair = H(0x2a1e16);
  img.rect(5, 1, 6, 6, skin); img.rect(5, 0, 6, 2, hair); img.rect(5, 2, 1, 3, hair); img.rect(10, 2, 1, 3, hair);
  img.set(6, 4, H(0x201814)); img.set(9, 4, H(0x201814));
  img.rect(3, 7, 10, 9, jacket); img.rect(3, 7, 2, 9, jacketD); img.rect(7, 8, 1, 8, jacketD);
  img.rect(2, 8, 1, 7, jacketD); img.rect(13, 8, 1, 7, jacket); img.rect(2, 15, 1, 2, skin); img.rect(13, 15, 1, 2, skin);
  img.rect(4, 16, 8, 9, jeans); img.rect(7, 18, 2, 7, H(0x222c40));
  img.rect(4, 25, 3, 3, boots); img.rect(9, 25, 3, 3, boots);
  img.outline(H(0x0c0a08));
  return img;
}

/** Generic furniture billboard: a silhouette by keyword, colored by the CDDA color. */
export function paintFurniture(id: string, cdda: string): Img {
  const base = mixRgb(hexToRgb(cddaColor(cdda)), H(0x5a4a3a), 0.6);
  const d = shade(base, 0.65), l = shade(base, 1.2).map((v) => Math.min(255, v)) as RGB;
  const k = (re: RegExp) => re.test(id);
  let img: Img;
  if (k(/chair|stool|bench/)) {
    img = new Img(12, 18);
    img.rect(2, 0, 8, 8, base); img.rect(2, 0, 8, 1, l); img.rect(1, 8, 10, 2, l);
    img.rect(1, 10, 2, 8, d); img.rect(9, 10, 2, 8, d);
  } else if (k(/bed|mattress|cot/)) {
    img = new Img(32, 12);
    img.rect(0, 4, 32, 6, base); img.rect(1, 2, 8, 3, H(0xa8a090)); img.rect(0, 4, 32, 1, l);
    img.rect(0, 10, 2, 2, d); img.rect(30, 10, 2, 2, d); img.rect(0, 0, 2, 12, d);
  } else if (k(/sofa|couch|armchair/)) {
    img = new Img(28, 14);
    img.rect(2, 0, 24, 8, base); img.rect(0, 4, 4, 10, d); img.rect(24, 4, 4, 10, d); img.rect(2, 8, 24, 4, l);
  } else if (k(/lamp|light/)) {
    img = new Img(10, 28);
    img.rect(1, 0, 8, 6, H(0xc8b080)); img.rect(4, 6, 2, 20, H(0x3a3a3a)); img.rect(2, 26, 6, 2, H(0x2a2a2a));
  } else if (k(/toilet/)) {
    img = new Img(12, 14);
    img.rect(2, 0, 8, 6, H(0xc8c8c0)); img.rect(1, 6, 10, 3, H(0xe0e0d8)); img.rect(3, 9, 6, 5, H(0xb0b0a8));
  } else if (k(/tree|plant|flower|bush/)) {
    return paintTree(hashString(id), 'summer', 'shrub');
  } else if (k(/sign|board/)) {
    img = new Img(16, 20);
    img.rect(0, 0, 16, 10, base); img.rect(7, 10, 2, 10, d);
  } else {
    // crate / appliance
    img = new Img(14, 14);
    img.rect(0, 0, 14, 14, base); img.rect(0, 0, 14, 2, l); img.rect(0, 12, 14, 2, d); img.rect(6, 4, 2, 6, d);
  }
  img.outline(H(0x0c0a08));
  return img;
}

export function paintFire(seed: number): Img {
  const rng = new Rng(seed);
  const img = new Img(14, 16);
  const cols = [H(0x5a1a0a), H(0xb83a12), H(0xf07a1e), H(0xffc84a), H(0xfff0a0)];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 14; x++) {
      const dx = (x - 6.5) / 6.5, dy = (16 - y) / 16;
      const flame = 1 - Math.abs(dx) * (0.6 + dy * 1.6) - dy * 0.55 + rng.next() * 0.35;
      if (flame <= 0.05) continue;
      img.set(x, y, cols[Math.min(4, Math.floor(flame * 5))]);
    }
  // logs
  img.rect(1, 14, 12, 2, H(0x2e1e12));
  return img;
}

/** Liquid/debris splat for floor decals (blood, bile, acid...), 16x16. */
export function paintSplat(seed: number, color: number): Img {
  const rng = new Rng(seed);
  const img = new Img(16, 16);
  const base = H(color), dark = shade(base, 0.7), lite = shade(base, 1.15).map((v) => Math.min(255, v)) as RGB;
  const blobs: [number, number, number][] = [[8, 8, 3 + rng.int(0, 2)]];
  for (let i = 0; i < 5; i++) blobs.push([rng.int(3, 12), rng.int(3, 12), rng.int(1, 3)]);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      let v = 0;
      for (const [bx, by, br] of blobs) v = Math.max(v, 1 - Math.hypot(x - bx, y - by) / br);
      if (v <= 0) continue;
      img.set(x, y, v > 0.6 ? lite : v > 0.25 ? base : dark);
    }
  return img;
}

/** Soft cloud puff for smoke/gas billboards (drawn with dithered opacity), 16x16. */
export function paintCloud(seed: number, color: number): Img {
  const rng = new Rng(seed);
  const img = new Img(16, 16);
  const base = H(color), dark = shade(base, 0.8);
  const blobs: [number, number, number][] = [[8, 9, 5], [5, 8, 3], [11, 8, 3], [8, 5, 3]];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      let v = 0;
      for (const [bx, by, br] of blobs) v = Math.max(v, 1 - Math.hypot(x - bx, y - by) / (br + rng.next() * 0.8));
      if (v <= 0) continue;
      img.set(x, y, v > 0.4 ? base : dark);
    }
  return img;
}

/** Grass tuft billboard (ground clutter), 12x10, a few blades in the season's greens. */
export function paintTuft(seed: number, season: string, tall: boolean): Img {
  const rng = new Rng(seed);
  const h = tall ? 16 : 10;
  const img = new Img(12, h);
  const g: Ramp = season === 'autumn'
    ? ramp(0x3a2c14, 0x5a4420, 0x7a5a2a, 0x94743a)
    : season === 'winter'
      ? ramp(0x2e2a22, 0x423c30, 0x564e3e, 0x6a604c)
      : ramp(0x1c2c12, 0x2c4418, 0x3e5a22, 0x587430);
  const blades = 5 + rng.int(0, 3);
  for (let b = 0; b < blades; b++) {
    let x = 2 + rng.int(0, 7);
    const len = Math.floor(h * (0.45 + rng.next() * 0.55));
    const lean = rng.next() < 0.5 ? -1 : 1;
    for (let i = 0; i < len; i++) {
      const y = h - 1 - i;
      if (i > 2 && rng.oneIn(3)) x += lean;
      img.set(x, y, g[i < 2 ? 1 : i < len - 2 ? 2 : 3]);
    }
  }
  return img;
}

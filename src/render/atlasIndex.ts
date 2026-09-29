// Pure (no three.js / DOM) tile resolution over a compiled atlas.json. Mirrors CDDA's
// cata_tiles.cpp: find_tile_looks_like / find_tile_with_season, get_rotation_and_subtile,
// get_variant_seed's lookup3 mix, weighted_int_list::pick and draw_sprite_at's
// rotation-index selection. src/render/atlas.ts wraps this with textures.

import type { AtlasIndex, SubtileDef, SubtileKey, TileDef, Variant, VariantList } from './atlasTypes';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** Neighbour bits for `connections` / `rotateTo` masks (our convention, not CDDA's). */
export const CONN = { N: 1, E: 2, S: 4, W: 8 } as const;

export interface LookupOpts {
  season?: Season;
  /** CDDA sprite variant (item variants etc.): tries `${id}_var_${variant}` first, or
   *  `${id}${variant}` when it starts with '_'. */
  variant?: string;
  /** Any integer; picks among weighted variants deterministically. Use pointSeed(x, y) for
   *  map tiles (CDDA seeds terrain/fields/immovable furniture by absolute position). */
  variantSeed?: number;
  /** Rotation index for non-multitile rotating tiles (0=N,1=E,2=S,3=W as in CDDA). Ignored
   *  (forced to 0) when the tile doesn't rotate, unless `alwaysRotate`. */
  rotation?: number;
  /** CDDA doesn't zero rotation for the NONE and MONSTER categories; pass true for those. */
  alwaysRotate?: boolean;
  /** For multitile tiles: which of the 4 neighbours connect (CONN bits). Omit to draw the
   *  plain (non-connected) base tile. */
  connections?: number;
  /** For multitile tiles: neighbours this tile should rotate towards (CONN bits), i.e. CDDA
   *  `rotates_to`. Omit for "no rotation targets" (CDDA's CHAR_MAX). */
  rotateTo?: number;
  /** Milliseconds clock for `animated` tiles (default 0: first frame for seed 0). */
  timeMs?: number;
}

export interface FrameSel {
  /** Index into AtlasIndex.frames. */
  frame: number;
  /** Clockwise quarter turns the renderer should apply (CDDA rotates single-sprite tiles in
   *  software; tiles with pre-drawn rotations always get 0). Top-down, north-up space. */
  rotate: 0 | 1 | 2 | 3;
}

export interface LookupResult {
  /** The id actually found (may be a seasonal/variant/looks_like id). */
  id: string;
  /** Multitile subtile used, if any. */
  subtile?: SubtileKey;
  fg?: FrameSel;
  bg?: FrameSel;
}

// CDDA NEIGHBOUR enum: SOUTH=1, EAST=2, WEST=4, NORTH=8.
function toCddaMask(m: number): number {
  return (m & CONN.S ? 1 : 0) | (m & CONN.E ? 2 : 0) | (m & CONN.W ? 4 : 0) | (m & CONN.N ? 8 : 0);
}
const NO_ROTATION = -1;
const C = { N: 8, E: 2, W: 4, S: 1 };

function rotEdgeNS(r: number): number {
  const e = (r & C.E) !== 0, w = (r & C.W) !== 0;
  return e ? (w ? 2 : 1) : w ? 0 : 3;
}
function rotEdgeEW(r: number): number {
  const n = (r & C.N) !== 0, s = (r & C.S) !== 0;
  return n ? (s ? 2 : 1) : s ? 0 : 3;
}
function rotUnconnected(r: number): number {
  switch (r) {
    case 0: return 15;
    case 15: return 12;
    case C.N: return 2;
    case C.E: return 1;
    case C.S: return 0;
    case C.W: return 3;
    case 10: return 6;
    case 3: return 5;
    case 5: return 4;
    case 12: return 7;
    case 14: return 10;
    case 11: return 9;
    case 7: return 8;
    case 13: return 11;
    case 9: return 14;
    case 6: return 13;
  }
  return 0;
}

/** CDDA get_rotation_and_subtile. Masks are in CONN convention; rotateTo undefined means
 *  "no rotation targets". Returns CDDA's (subtile, rotation) pair. */
export function rotationAndSubtile(connections: number, rotateTo?: number): { subtile: SubtileKey; rotation: number } {
  const val = toCddaMask(connections);
  const rt = rotateTo === undefined ? NO_ROTATION : toCddaMask(rotateTo);
  const none = rt === NO_ROTATION;
  switch (val) {
    case 0: return { subtile: 'unconnected', rotation: none ? 0 : rotUnconnected(rt) };
    case 15: return { subtile: 'center', rotation: 0 };
    case 8: return { subtile: 'end_piece', rotation: none ? 2 : 2 + 4 * rotEdgeNS(rt) };
    case 4: return { subtile: 'end_piece', rotation: none ? 1 : 1 + 4 * rotEdgeEW(rt) };
    case 2: return { subtile: 'end_piece', rotation: none ? 3 : 3 + 4 * rotEdgeEW(rt) };
    case 1: return { subtile: 'end_piece', rotation: none ? 0 : 4 * rotEdgeNS(rt) };
    case 9: return { subtile: 'edge', rotation: none ? 0 : 2 * rotEdgeNS(rt) };
    case 6: return { subtile: 'edge', rotation: none ? 1 : 1 + 2 * rotEdgeEW(rt) };
    case 12: return { subtile: 'corner', rotation: 2 };
    case 10: return { subtile: 'corner', rotation: 3 };
    case 3: return { subtile: 'corner', rotation: 0 };
    case 5: return { subtile: 'corner', rotation: 1 };
    case 14: return { subtile: 't_connection', rotation: 2 };
    case 11: return { subtile: 't_connection', rotation: 3 };
    case 7: return { subtile: 't_connection', rotation: 0 };
    case 13: return { subtile: 't_connection', rotation: 1 };
  }
  throw new Error(`bad connection mask ${connections}`);
}

/** CDDA simple_point_hash: the variant seed for a map position. */
export function pointSeed(x: number, y: number): number {
  return (x + y * 65536) | 0;
}

const rot32 = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
/** lookup3 final mix used by cata_tiles::get_variant_seed (unsigned 32-bit). */
export function mixSeed(seed: number): number {
  let a = seed >>> 0;
  let b = (-seed) >>> 0;
  let c = Math.imul(seed, seed) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot32(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot32(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot32(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot32(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot32(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot32(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot32(b, 24)) >>> 0;
  return c;
}

const totalWeight = (l?: VariantList) => (l ? l.reduce((s, v) => s + v.weight, 0) : 0);

/** weighted_int_list::pick(randi). */
export function pickVariant(list: VariantList, randi: number): Variant | undefined {
  const total = totalWeight(list);
  if (total <= 0) return undefined;
  if (list.length === 1) return list[0];
  const picked = ((randi >>> 0) % total) + 1;
  let acc = 0;
  for (const v of list) {
    acc += v.weight;
    if (acc >= picked) return v;
  }
  return list[list.length - 1];
}

/** draw_sprite_at's sprite selection for a picked variant. */
function selectSprite(v: Variant, rota: number, isFg: boolean): FrameSel {
  const s = v.sprites;
  if (s.length === 1) {
    // Only foreground single sprites are rotated in software; rota -1 (flip) isn't used here.
    const q = isFg && rota > 0 ? rota % 4 : 0;
    return { frame: s[0], rotate: q as FrameSel['rotate'] };
  }
  return { frame: s[rota % s.length], rotate: 0 };
}

export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
const LOOKS_LIKE_JUMPS = 10;

export class AtlasLookup {
  constructor(readonly index: AtlasIndex) {}

  has(id: string): boolean {
    return id in this.index.tiles;
  }

  /** find_tile_with_season: a `_season_<s>` tile wins over the plain id. */
  findWithSeason(id: string, season?: Season): { id: string; tile: TileDef } | null {
    const tiles = this.index.tiles;
    if (season) {
      const sid = `${id}_season_${season}`;
      if (tiles[sid]) return { id: sid, tile: tiles[sid] };
    }
    const t = tiles[id];
    return t ? { id, tile: t } : null;
  }

  /** find_tile_looks_like minus the looks_like hop: variant, then season, then plain id. */
  find(id: string, opts: LookupOpts = {}): { id: string; tile: TileDef } | null {
    if (opts.variant) {
      const vid = opts.variant.startsWith('_') ? id + opts.variant : `${id}_var_${opts.variant}`;
      const r = this.findWithSeason(vid, opts.season);
      if (r) return r;
    }
    return this.findWithSeason(id, opts.season);
  }

  lookup(id: string, opts: LookupOpts = {}): LookupResult | null {
    const found = this.find(id, opts);
    return found ? this.resolve(found.id, found.tile, opts) : null;
  }

  /** Follows CDDA looks_like (up to 10 jumps) when the id itself has no tile. The variant is
   *  only tried on the original id, as in CDDA. */
  lookupWithLooksLike(id: string, getLooksLike: (id: string) => string | undefined, opts: LookupOpts = {}): LookupResult | null {
    let cur: string | undefined = id;
    let o = opts;
    for (let jumps = 0; cur && jumps < LOOKS_LIKE_JUMPS; jumps++) {
      const r = this.lookup(cur, o);
      if (r) return r;
      cur = getLooksLike(cur);
      o = { ...opts, variant: undefined };
    }
    return null;
  }

  private resolve(foundId: string, tile: TileDef, opts: LookupOpts): LookupResult {
    let def: TileDef | SubtileDef = tile;
    let rota = opts.rotation ?? 0;
    let rotates = !!tile.rotates || !!opts.alwaysRotate;
    let subtile: SubtileKey | undefined;
    if (tile.multitile && opts.connections !== undefined) {
      const rs = rotationAndSubtile(opts.connections, opts.rotateTo);
      rota = rs.rotation;
      const sub = tile.multitile[rs.subtile];
      if (sub) {
        def = sub;
        subtile = rs.subtile;
        rotates = true; // CDDA: subtiles always rotate
      }
    }
    if (!rotates) rota = 0;

    let randi = 0;
    if ((def.fg?.length ?? 0) > 1 || (def.bg?.length ?? 0) > 1 || def.animated) randi = mixSeed(opts.variantSeed ?? 0);
    if (def.animated) {
      // CDDA: 60 fps frame counter offset by the seed; weights are per-frame durations.
      let frames = totalWeight(def.fg);
      if (frames === 1) frames = totalWeight(def.bg);
      if (frames > 0) randi = ((Math.floor((opts.timeMs ?? 0) / 17) + randi) >>> 0) % frames;
    }
    const res: LookupResult = { id: subtile ? `${foundId}_${subtile}` : foundId };
    if (subtile) res.subtile = subtile;
    const bgV = def.bg && pickVariant(def.bg, randi);
    const fgV = def.fg && pickVariant(def.fg, randi);
    if (bgV && bgV.sprites.length) res.bg = selectSprite(bgV, rota, false);
    if (fgV && fgV.sprites.length) res.fg = selectSprite(fgV, rota, true);
    return res;
  }
}

// ---------------------------------------------------------------- ASCII fallback helpers

// CP437 as drawn in CDDA's fallback.png (index → character).
const CP437 =
  '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼' +
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂' +
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CP437_INDEX = new Map<string, number>();
for (let i = 0; i < 256; i++) if (!CP437_INDEX.has(CP437[i])) CP437_INDEX.set(CP437[i], i);
// CDDA's LINE_* symbol names (used verbatim in its JSON) → box-drawing glyphs.
const LINE_SYMBOLS: Record<string, string> = {
  LINE_XOXO: '│', LINE_OXOX: '─', LINE_XXOO: '└', LINE_OXXO: '┌', LINE_OOXX: '┐', LINE_XOOX: '┘',
  LINE_XXXO: '├', LINE_XXOX: '┴', LINE_XOXX: '┤', LINE_OXXX: '┬', LINE_XXXX: '┼',
};
/** Glyph index in the CP437 sheet for a CDDA symbol; '?' for unmapped characters. */
export function glyphIndex(symbol: string): number {
  const s = LINE_SYMBOLS[symbol] ?? symbol;
  const ch = String.fromCodePoint(s.codePointAt(0) ?? 63);
  return CP437_INDEX.get(ch) ?? 63;
}

// data/raw/colors.json defaults.
const BASE: Record<string, [number, number, number]> = {
  black: [0, 0, 0], red: [255, 0, 0], green: [0, 110, 0], brown: [97, 56, 28], blue: [51, 51, 255],
  magenta: [139, 58, 98], cyan: [0, 150, 180], light_gray: [150, 150, 150], dark_gray: [99, 99, 99],
  light_red: [255, 150, 150], light_green: [0, 255, 0], yellow: [255, 255, 0], light_blue: [100, 100, 255],
  pink: [254, 0, 254], light_cyan: [0, 240, 255], white: [255, 255, 255],
};
const ALIASES: Record<string, string> = {
  ltgray: 'light_gray', lt_gray: 'light_gray', gray: 'light_gray', grey: 'light_gray', light_grey: 'light_gray',
  dkgray: 'dark_gray', dk_gray: 'dark_gray', dark_grey: 'dark_gray', ltred: 'light_red', ltgreen: 'light_green',
  ltblue: 'light_blue', ltcyan: 'light_cyan', light_magenta: 'pink', lmagenta: 'pink',
};
/** CDDA color name (c_red, light_gray, h_white, c_white_red …) → foreground RGB. Unknown
 *  names throw: callers should know their colors. */
export function cddaColor(name: string): [number, number, number] {
  let n = name.toLowerCase().replace(/^[cih]_/, '');
  if (!BASE[n] && !ALIASES[n]) {
    // "white_red" style fg_bg pairs: try progressively shorter prefixes.
    const parts = n.split('_');
    for (let k = parts.length - 1; k > 0; k--) {
      const cand = parts.slice(0, k).join('_');
      if (BASE[cand] || ALIASES[cand]) {
        n = cand;
        break;
      }
    }
  }
  const c = BASE[ALIASES[n] ?? n];
  if (!c) throw new Error(`unknown CDDA color ${name}`);
  return c;
}

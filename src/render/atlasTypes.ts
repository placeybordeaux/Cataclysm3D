// Types for public/atlas/atlas.json, written by tools/atlas/index.ts (`npm run atlas`) and
// read by src/render/atlas.ts. Pure data — no three.js imports so tools/tests can use it.
//
// atlas.json format (version 1)
// -----------------------------
// {
//   "version": 1,
//   "tileset": "UltimateCataclysm",
//   "tileSize": 32,                 // CDDA grid cell in px; sprite offsets are relative to it
//   "pages": [{file:"atlas_0.png", w:4096, h:4096}, ...],  // file relative to atlas.json;
//                                   // w/h are powers of two (the last page may be shorter)
//   "padding": 1,                   // px of edge-extrusion around every frame on its page
//   "frames": [ {page, x, y, w, h, ox, oy}, ... ],
//       x/y/w/h: the sprite's pixel rect on its page (top-left origin, excluding padding).
//       ox/oy:   CDDA sprite_offset_x/y of the sheet the sprite came from, in px: where the
//                sprite's top-left sits relative to the top-left of the 32×32 cell it is
//                drawn for (e.g. tall 32×64 sprites have oy = -32, 64×64 "large" have
//                ox = -16, oy = -32). A sprite therefore stands on the cell's bottom edge
//                when h + oy == 32.
//   "tiles": { [id]: TileDef },     // compiled tile entries, see TileDef below
//   "glyphs": { file, cell, columns, codepage }  // ASCII fallback, see GlyphSheet
//   "layering": <raw layering.json>              // CDDA "sprite variants by context"; passthrough
// }
//
// A VariantList is CDDA's weighted_int_list<vector<int>>: each variant carries a weight and a
// list of frame indices. The list has 1, 2 or 4 entries:
//   1 → a single sprite (the renderer may rotate it in 90° steps if the tile `rotates`),
//   2 → [N/S, E/W] pre-drawn rotations, 4 → [N, E, S, W] pre-drawn rotations.
// For `animated` tiles the weights are instead frame durations in 1/60 s units and the
// variants are the animation frames in order.

export interface AtlasFrame {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
}

export interface AtlasPage {
  file: string;
  w: number;
  h: number;
}

export interface Variant {
  weight: number;
  sprites: number[];
}
export type VariantList = Variant[];

export const MULTITILE_KEYS = [
  'center',
  'corner',
  'edge',
  't_connection',
  'end_piece',
  'unconnected',
  'open',
  'broken',
] as const;
export type SubtileKey = (typeof MULTITILE_KEYS)[number];

export interface SubtileDef {
  fg?: VariantList;
  bg?: VariantList;
  animated?: boolean;
}

export interface TileDef {
  fg?: VariantList;
  bg?: VariantList;
  /** CDDA default: rotates = multitile. Only present when true. */
  rotates?: boolean;
  animated?: boolean;
  /** Present iff the entry is `"multitile": true`; keys are the defined subtiles. */
  multitile?: Partial<Record<SubtileKey, SubtileDef>>;
  /** CDDA height_3d (only meaningful in iso mode, kept for completeness). */
  height3d?: number;
}

export interface GlyphSheet {
  /** PNG (relative to atlas.json) holding 256 white-filled, black-outlined glyphs. */
  file: string;
  /** Glyph cell size in px (square). */
  cell: number;
  /** Glyphs per row in the PNG; glyph n is at ((n % columns) * cell, floor(n / columns) * cell). */
  columns: number;
  /** Glyph index → character mapping. Always "cp437" (what CDDA fallback.png uses). */
  codepage: 'cp437';
}

export interface AtlasIndex {
  version: 1;
  tileset: string;
  tileSize: number;
  pages: AtlasPage[];
  padding: number;
  frames: AtlasFrame[];
  tiles: Record<string, TileDef>;
  glyphs: GlyphSheet;
  layering?: unknown;
}

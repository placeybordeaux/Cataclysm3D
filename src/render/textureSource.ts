import type * as THREE from 'three';

// The seam between "what does tile X look like" and the 3D pipeline.
//
// The mesher, sprite layer and furniture code only ever ask a TileTextureSource for a
// TileFrame (a texture page + UV rect). Today that is ProceduralTextureSource (generated
// pixel-art stand-ins); the UltiCa atlas (src/render/atlas.ts) plugs in by implementing
// the same interface — see AtlasTextureSource notes in the renderer report / ARCHITECTURE.
//
// Frames may live on different texture pages; the mesher groups geometry per page, so a
// multi-page atlas costs one draw call per page per chunk, not per tile.

export interface TileFrame {
  texture: THREE.Texture;
  /** UV rect [u0, v0, u1, v1] in the page, v0 = bottom edge (three.js UV convention). */
  uv: readonly [number, number, number, number];
  /** Frame size in texels; sprites derive their aspect ratio from it. */
  w: number;
  h: number;
  /** Texels per metre for sprites (billboard size = h / ppm). Default 16. */
  ppm?: number;
  /** Clockwise quarter turns to apply to floor quads (CDDA rotated single sprites). */
  rotate?: 0 | 1 | 2 | 3;
}

/**
 * Which surface of a tile is being textured:
 *  - floor:   top of a walkable tile          - ceiling: underside of a floor slab
 *  - wall:    vertical face of a wall block   - top:     top of a wall/furniture block
 *  - side:    vertical face of box furniture  - sprite:  billboard (trees, furniture)
 *  - pane:    see-through panel (window glass/curtain, fence, door slab)
 */
export type SurfaceFace = 'floor' | 'ceiling' | 'wall' | 'top' | 'side' | 'sprite' | 'pane';

export interface SurfaceQuery {
  /** CDDA-style connection bitmask: 1=N, 2=E, 4=S, 8=W neighbors of the same group. */
  connections?: number;
  /** Stable per-tile hash for picking random variants (floors, grass). */
  variantSeed?: number;
  /** wall face looking into a room (painted surfaces give it an interior finish) */
  indoor?: boolean;
  season?: 'spring' | 'summer' | 'autumn' | 'winter';
}

export interface TileTextureSource {
  terrain(id: string, face: SurfaceFace, q?: SurfaceQuery): TileFrame;
  furniture(id: string, face: SurfaceFace, q?: SurfaceQuery): TileFrame;
  /** Small sprite for an item lying on the ground. */
  item(id: string): TileFrame;
  /** A CDDA glyph (symbol + color) as a sprite; fallback for anything without art. */
  glyph(symbol: string, color: string): TileFrame;
  /** Named misc sprites: 'player', 'zombie' ... sources may throw for unknown names. */
  sprite(name: string): TileFrame;
  /** Called once per frame before rendering: lazy sources upload newly packed frames. */
  flush?(): void;
}

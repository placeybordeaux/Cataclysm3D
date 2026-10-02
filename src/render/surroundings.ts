import { CHUNK } from '../world/coords';

// "Never draw the inside before the outside" (user report: zombies on the upper floors of a
// building drawn floating in the air before its walls). Per-entity things — creatures, corpses,
// NPCs, vehicles, fire, arrows, grass tufts — are not part of the chunk meshes, and every view
// used to decide visibility from the level extent alone (src/world/levels.ts `drawn`: "does
// this level of this column exist for the eye?"). The extent says a level *will* be drawn; the
// chunk manager builds it later, and storeys above the player's window are built last of all
// (the deferred 'high' class, and not started at all while driving), so a zombie on a third
// floor across the street stood in mid-air for seconds. The rule here: an entity is shown only
// once the geometry it stands in is shown (at any LOD), and the neighbouring chunk too when the
// entity is close enough to its edge for that chunk's walls to be what encloses it.

/** What the chunk manager has for one chunk (ChunkManager.chunkState). */
export const ChunkState = {
  /** no entry: outside the wanted set (beyond the radius, a level not drawn) */
  None: 0,
  /** wanted but never built: its walls and floors are not on screen yet */
  Pending: 1,
  /** built and visible */
  Shown: 2,
  /** built but hidden (top-down cutaway above the player, the hysteresis ring) */
  Hidden: 3,
} as const;
export type ChunkState = (typeof ChunkState)[keyof typeof ChunkState];

/** Tiles from a chunk edge within which the neighbour's walls count as the entity's surroundings. */
export const EDGE_TILES = 2;

/**
 * May an entity at tile position (x, y) on level z be drawn? Its own chunk must be built and
 * visible; a neighbouring chunk (sides and corners) whose edge is within EDGE_TILES must not be
 * waiting for its first build. A neighbour with no entry at all is outside the draw radius:
 * it will never be built, so it can't hold the entity back (the edge of the world is fogged).
 */
export function surroundingsDrawn(state: (cx: number, cy: number, z: number) => ChunkState, x: number, y: number, z: number, edge = EDGE_TILES): boolean {
  const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
  if (state(cx, cy, z) !== ChunkState.Shown) return false;
  const lx = x - cx * CHUNK, ly = y - cy * CHUNK;
  const sx = lx < edge ? -1 : lx > CHUNK - edge ? 1 : 0;
  const sy = ly < edge ? -1 : ly > CHUNK - edge ? 1 : 0;
  if (sx && state(cx + sx, cy, z) === ChunkState.Pending) return false;
  if (sy && state(cx, cy + sy, z) === ChunkState.Pending) return false;
  if (sx && sy && state(cx + sx, cy + sy, z) === ChunkState.Pending) return false;
  return true;
}

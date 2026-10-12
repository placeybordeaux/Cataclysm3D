// World coordinate conventions (match CDDA so JSON rows/rotations translate directly):
//   x grows east, y grows SOUTH, z is the z-level (0 = ground, +1 = first floor up).
//   One tile is 1 m. One chunk == one CDDA overmap terrain tile (OMT) == 24x24 tiles.
// Three.js conversion: world(x, y, z) -> THREE(x, z * LEVEL_HEIGHT, y).
// A tile (x,y) covers [x, x+1) x [y, y+1); creatures use float positions inside it.

export const CHUNK = 24;
export const LEVEL_HEIGHT = 2.6;
// BN's OVERMAP_DEPTH / OVERMAP_HEIGHT (game_constants.h): the map holds every level BN has. What
// overmap generation may place there depends on the world's genVersion (overmap.ts genZRange):
// worlds before genVersion 3 were generated against -7..5 and still are.
export const MIN_Z = -10;
export const MAX_Z = 10;

export interface TilePos {
  x: number;
  y: number;
  z: number;
}

export const chunkOf = (t: number) => Math.floor(t / CHUNK);
export const localOf = (t: number) => ((t % CHUNK) + CHUNK) % CHUNK;
export const chunkKey = (cx: number, cy: number, z: number) => `${cx},${cy},${z}`;
export const tileKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** CDDA's square_dist / trig_dist blend: we use Chebyshev for ranges like CDDA default. */
export const squareDist = (ax: number, ay: number, bx: number, by: number) =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));

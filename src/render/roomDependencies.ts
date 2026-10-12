import { chunkOf } from '../world/coords';
import type { Chunk, GameMap } from '../world/map';

/** A room touches floor/wall/furniture at z and may have a roof at any loaded height. */
export function roomDependencySnapshot(map: GameMap, z: number, x: number, y: number): () => boolean {
  const cx = chunkOf(x), cy = chunkOf(y);
  const read = (zz: number) => map.hasChunk(cx, cy, zz) ? map.chunk(cx, cy, zz) : null;
  // Identity catches eviction/replacement. Versions catch edits. Missing chunks count too.
  const snapshot: [number, Chunk | null, number][] = [];
  // Levels up to the map's highest populated one (GameMap.topZ, not MAX_Z: BN's 21 levels are
  // mostly empty); a chunk appearing above that later is caught by re-reading the levels between
  // the old and the new top.
  const top = Math.max(z, map.topZ());
  for (let zz = z; zz <= top; zz++) {
    const c = read(zz);
    snapshot.push([zz, c, c?.version ?? 0]);
  }
  return () => {
    for (let zz = top + 1, now = map.topZ(); zz <= now; zz++) if (map.hasChunk(cx, cy, zz)) return false;
    return snapshot.every(([zz, old, version]) => {
      const now = read(zz);
      return now === old && (now?.version ?? 0) === version;
    });
  };
}

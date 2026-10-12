import { chunkOf, MAX_Z } from '../world/coords';
import type { Chunk, GameMap } from '../world/map';

/** A room touches floor/wall/furniture at z and may have a roof at any loaded height. */
export function roomDependencySnapshot(map: GameMap, z: number, x: number, y: number): () => boolean {
  const cx = chunkOf(x), cy = chunkOf(y);
  const read = (zz: number) => map.hasChunk(cx, cy, zz) ? map.chunk(cx, cy, zz) : null;
  // Identity catches eviction/replacement. Versions catch edits. Missing chunks count too.
  const snapshot: [number, Chunk | null, number][] = [];
  for (let zz = z; zz <= MAX_Z; zz++) {
    const c = read(zz);
    snapshot.push([zz, c, c?.version ?? 0]);
  }
  return () => snapshot.every(([zz, old, version]) => {
    const now = read(zz);
    return now === old && (now?.version ?? 0) === version;
  });
}

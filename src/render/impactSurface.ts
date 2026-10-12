import { furnitureSolidHeight, raycastTiles, terrainSolidHeight, type RayMap, type RayHit } from '../game/raycast';
import { LEVEL_HEIGHT, chunkOf } from '../world/coords';

export interface ImpactSurface {
  x: number; y: number; h: number;
  /** Outward normal in tile-space x, y, up. */
  normal: [number, number, number];
}

export interface LoadedRayMap extends RayMap { hasChunk(cx: number, cy: number, z: number): boolean }
const UNLOADED = Symbol('unloaded cosmetic impact');

/** Cosmetic solid verification only; callers must reject creature/unknown attack facts. */
export function impactSurface(map: LoadedRayMap, from: { x: number; y: number; h: number }, to: { x: number; y: number; h: number }): ImpactSurface | null {
  const dir = { x: to.x - from.x, y: to.y - from.y, h: to.h - from.h };
  const distance = Math.hypot(dir.x, dir.y, dir.h);
  if (distance < 0.001) return null;
  const check = (x: number, y: number, z: number) => { if (!map.hasChunk(chunkOf(x), chunkOf(y), z)) throw UNLOADED; };
  const loaded: RayMap = {
    terAt: (x,y,z) => { check(x,y,z); return map.terAt(x,y,z); },
    furnAt: (x,y,z) => { check(x,y,z); return map.furnAt(x,y,z); },
    hasFloor: (x,y,z) => { check(x,y,z); return map.hasFloor(x,y,z); },
  };
  let hit: RayHit | null;
  try { hit = raycastTiles(loaded, from, dir, { maxDist: distance + 0.35, throughTransparent: true }); }
  catch (e) { if (e === UNLOADED) return null; throw e; }
  if (!hit) return null;
  // A cosmetic re-cast must not decorate a different obstacle earlier on the path.
  if (Math.hypot(hit.point.x - to.x, hit.point.y - to.y, hit.point.h - to.h) > 0.35) return null;
  let normal: [number, number, number];
  if (hit.kind === 'floor') normal = [0, 0, 1];
  else if (hit.kind === 'ceiling') normal = [0, 0, -1];
  else {
    const height = hit.kind === 'furniture' ? furnitureSolidHeight(hit.furniture) : terrainSolidHeight(hit.terrain);
    const p = hit.point;
    const faces: { distance: number; normal: [number, number, number] }[] = [
      { distance: Math.abs(p.x - hit.x), normal: [-1, 0, 0] },
      { distance: Math.abs(p.x - hit.x - 1), normal: [1, 0, 0] },
      { distance: Math.abs(p.y - hit.y), normal: [0, -1, 0] },
      { distance: Math.abs(p.y - hit.y - 1), normal: [0, 1, 0] },
      { distance: Math.abs(p.h - hit.z * LEVEL_HEIGHT - height), normal: [0, 0, 1] },
    ];
    faces.sort((a, b) => a.distance - b.distance);
    normal = faces[0].normal;
  }
  // A small outward offset prevents z fighting with the verified surface.
  return { x: hit.point.x + normal[0] * 0.008, y: hit.point.y + normal[1] * 0.008, h: hit.point.h + normal[2] * 0.008, normal };
}

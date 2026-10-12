import type { FurnitureDef, TerrainDef } from '../data/types';
import { LEVEL_HEIGHT } from '../world/coords';
import { furnitureShape, terrainShape } from '../render/tileKinds';

// Tile-grid raycasts: "what is the crosshair pointing at?" for look mode, interaction
// prompts ([e] Open door) and hitscan combat. The world is a voxel grid of 1 m × 1 m ×
// LEVEL_HEIGHT cells; we walk it with a 3D DDA (Amanatides & Woo) and, inside each cell,
// test a few coarse solids stacked on the cell floor:
//   creature   a 1.8 m column (provided by the caller: monsters live outside the map)
//   furniture  a box whose height depends on its render shape (table 0.8 m, shelf 1.9 m…)
//   terrain    full-height walls/doors/windows/trees, 1 m fences/half walls/shrubs
// plus the floor slab at the bottom of each level (and the underside of the level above).
// Heights are chosen to match what the renderer draws (src/render/tileKinds.ts), so what
// you see under the crosshair is what you get.
//
// Coordinates: x east, y south (tiles, floats), h = height in metres above z=0 (so
// h = z * LEVEL_HEIGHT + eye height). This is exactly three.js (X, Y, Z) = (x, h, y).

export interface RayMap {
  terAt(x: number, y: number, z: number): TerrainDef;
  furnAt(x: number, y: number, z: number): FurnitureDef;
  hasFloor(x: number, y: number, z: number): boolean;
}

export type RayHitKind = 'creature' | 'vehicle' | 'furniture' | 'terrain' | 'floor' | 'ceiling';

export interface RayHit<C = unknown> {
  kind: RayHitKind;
  /** Tile that was hit (for 'ceiling': the tile of the level above whose floor we hit). */
  x: number;
  y: number;
  z: number;
  /** Distance along the (normalized) ray, metres. */
  dist: number;
  /** Exact hit point. */
  point: { x: number; y: number; h: number };
  creature?: C;
  terrain: TerrainDef;
  furniture: FurnitureDef;
}

export interface RayOpts<C> {
  /** Metres; default 60. */
  maxDist?: number;
  /** Creature standing in tile (x, y, z), if any. Do not return the viewer. */
  creatureAt?: (x: number, y: number, z: number) => C | null | undefined;
  /**
   * Height (m) of a vehicle part column standing in tile (x, y, z), 0 = none. Vehicles are
   * a map overlay, not terrain/furniture, so the caller supplies them (game.vehicles).
   */
  vehicleAt?: (x: number, y: number, z: number) => number;
  /** Ignore solids in the cell the ray starts in (default true: you stand in an open door). */
  skipOrigin?: boolean;
  /** Treat see-through obstacles (fences, windows, railings, shrubs) as transparent. */
  throughTransparent?: boolean;
  /** Solid height to use for a furniture piece instead of furnitureSolidHeight(). */
  furnitureHeight?: (f: FurnitureDef) => number;
}

export const CREATURE_HEIGHT = 1.8;

/** Height of the solid part of a terrain tile, 0 = nothing to hit. */
export function terrainSolidHeight(t: TerrainDef): number {
  switch (terrainShape(t)) {
    case 'wall':
    case 'door':
    case 'window':
    case 'tree':
      return LEVEL_HEIGHT;
    case 'halfwall':
    case 'fence':
    case 'shrub':
      return 1.0;
    default:
      return 0;
  }
}

function seeThrough(t: TerrainDef): boolean {
  const s = terrainShape(t);
  return s === 'window' || s === 'fence' || s === 'shrub';
}

/** Height of the solid part of a furniture tile, 0 = none. */
export function furnitureSolidHeight(f: FurnitureDef): number {
  switch (furnitureShape(f)) {
    case 'none':
      return 0;
    case 'table':
      return 0.8;
    case 'counter':
      return 1.0;
    case 'cabinet':
      return 1.9;
    default:
      return 1.2;
  }
}

/** Box-shaped furniture (counters, tables, cupboards): solid pieces even when passable. */
export function isBoxFurniture(f: FurnitureDef): boolean {
  const s = furnitureShape(f);
  return s === 'table' || s === 'counter' || s === 'cabinet';
}

/** Unit view direction for a yaw/pitch pair (yaw 0 = north/-y, positive pitch = up). */
export function dirFromYawPitch(yaw: number, pitch: number): { x: number; y: number; h: number } {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: -Math.cos(yaw) * cp, h: Math.sin(pitch) };
}

/**
 * Walk the ray from `origin` along `dir` and return the first thing it hits, or null if it
 * travels `maxDist` metres through open air.
 */
export function raycastTiles<C = unknown>(
  map: RayMap,
  origin: { x: number; y: number; h: number },
  dir: { x: number; y: number; h: number },
  opts: RayOpts<C> = {},
): RayHit<C> | null {
  const maxDist = opts.maxDist ?? 60;
  const skipOrigin = opts.skipOrigin ?? true;
  const len = Math.hypot(dir.x, dir.y, dir.h);
  if (!(len > 0)) throw new Error('raycastTiles: zero direction');
  const dx = dir.x / len, dy = dir.y / len, dh = dir.h / len;
  const LH = LEVEL_HEIGHT;

  let cx = Math.floor(origin.x), cy = Math.floor(origin.y), cz = Math.floor(origin.h / LH);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dh > 0 ? 1 : -1;
  const tDelta = (d: number, size: number) => (d === 0 ? Infinity : size / Math.abs(d));
  const tdx = tDelta(dx, 1), tdy = tDelta(dy, 1), tdz = tDelta(dh, LH);
  const firstBoundary = (o: number, d: number, cell: number, size: number) => {
    if (d === 0) return Infinity;
    const edge = d > 0 ? (cell + 1) * size : cell * size;
    return (edge - o) / d;
  };
  let tmx = firstBoundary(origin.x, dx, cx, 1);
  let tmy = firstBoundary(origin.y, dy, cy, 1);
  let tmz = firstBoundary(origin.h, dh, cz, LH);

  const at = (t: number) => ({ x: origin.x + dx * t, y: origin.y + dy * t, h: origin.h + dh * t });
  const hit = (kind: RayHitKind, x: number, y: number, z: number, t: number, creature?: C): RayHit<C> => ({
    kind, x, y, z, dist: t, point: at(t), creature,
    terrain: map.terAt(x, y, z), furniture: map.furnAt(x, y, z),
  });

  /** First t in [t0, t1] where the ray is inside the slab [base, base+height], or null. */
  const slab = (t0: number, t1: number, base: number, height: number): number | null => {
    if (height <= 0) return null;
    const top = base + height;
    if (dh === 0) {
      const h = origin.h;
      return h >= base && h <= top ? t0 : null;
    }
    let a = (base - origin.h) / dh, b = (top - origin.h) / dh;
    if (a > b) [a, b] = [b, a];
    const lo = Math.max(a, t0), hi = Math.min(b, t1);
    return lo <= hi ? lo : null;
  };

  let tEnter = 0;
  let first = true;
  // Safety bound on steps: each step advances at least min(tdx, tdy, tdz) metres.
  for (let steps = 0; steps < 4096; steps++) {
    const tExit = Math.min(tmx, tmy, tmz, maxDist);
    if (first && skipOrigin) {
      // Counters, tables and cupboards are climbable (passable) in CDDA, so you can stand
      // over one. The origin cell is skipped (it's you, or the door you stand in), but not
      // box furniture you look down into: skipping it picked the piece next to it.
      const f = map.furnAt(cx, cy, cz);
      if (isBoxFurniture(f)) {
        const tf = slab(tEnter, tExit, cz * LH, furnitureSolidHeight(f));
        if (tf !== null) return hit('furniture', cx, cy, cz, tf);
      }
    } else {
      const base = cz * LH;
      const cands: [number, RayHitKind, C | undefined][] = [];
      const cr = opts.creatureAt?.(cx, cy, cz);
      if (cr) {
        const t = slab(tEnter, tExit, base, CREATURE_HEIGHT);
        if (t !== null) cands.push([t, 'creature', cr]);
      }
      const vh = opts.vehicleAt?.(cx, cy, cz) ?? 0;
      if (vh > 0) {
        const t = slab(tEnter, tExit, base, vh);
        if (t !== null) cands.push([t, 'vehicle', undefined]);
      }
      const f = map.furnAt(cx, cy, cz);
      const tf = slab(tEnter, tExit, base, opts.furnitureHeight ? opts.furnitureHeight(f) : furnitureSolidHeight(f));
      if (tf !== null) cands.push([tf, 'furniture', undefined]);
      const ter = map.terAt(cx, cy, cz);
      if (!(opts.throughTransparent && seeThrough(ter))) {
        const tt = slab(tEnter, tExit, base, terrainSolidHeight(ter));
        if (tt !== null) cands.push([tt, 'terrain', undefined]);
      }
      if (cands.length) {
        // Earliest wins; ties go to creature > vehicle > furniture > terrain (list order).
        let best = cands[0];
        for (const c of cands) if (c[0] < best[0] - 1e-9) best = c;
        return hit(best[1], cx, cy, cz, best[0], best[2]);
      }
    }
    first = false;
    if (tExit >= maxDist) return null;
    tEnter = tExit;
    if (tmx <= tmy && tmx <= tmz) {
      cx += sx;
      tmx += tdx;
    } else if (tmy <= tmz) {
      cy += sy;
      tmy += tdy;
    } else {
      // Crossing a level boundary: the floor slab of the upper level is in the way.
      if (sz < 0 && map.hasFloor(cx, cy, cz)) return hit('floor', cx, cy, cz, tEnter);
      if (sz > 0 && map.hasFloor(cx, cy, cz + 1)) return hit('ceiling', cx, cy, cz + 1, tEnter);
      cz += sz;
      tmz += tdz;
    }
  }
  return null;
}

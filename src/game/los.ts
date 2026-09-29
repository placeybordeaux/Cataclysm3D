import type { Chunk, GameMap } from '../world/map';
import { CHUNK, chunkOf, localOf, MAX_Z, MIN_Z } from '../world/coords';
import { hasFlag } from '../world/registry';
import type { FurnitureDef, TerrainDef } from '../data/types';

// Tile-grid queries for monster AI and hitscan. These are private minimal versions: the world
// agent's vision.ts (light + LOS) should replace `hasLOS` once merged (see report seams).
//
// Grid never *generates* chunks: AI must not trigger mapgen far from the player, so tiles in
// chunks that don't exist yet count as blocked/opaque. It also caches chunk lookups with
// numeric keys, because GameMap's string-keyed lookups dominate A*/LOS cost otherwise.

export class Grid {
  private cache = new Map<number, Chunk | null>();
  constructor(readonly map: GameMap) {}

  /** Forget cached misses (call once per tick: new chunks may have been generated). */
  reset(): void {
    this.cache.clear();
  }

  chunkAt(x: number, y: number, z: number): Chunk | null {
    if (z < MIN_Z || z > MAX_Z) return null;
    const cx = chunkOf(x), cy = chunkOf(y);
    const key = ((cx & 0x3ff) | ((cy & 0x3ff) << 10) | ((z - MIN_Z) << 20)) >>> 0;
    let c = this.cache.get(key);
    if (c === undefined) {
      c = this.map.hasChunk(cx, cy, z) ? this.map.chunk(cx, cy, z) : null;
      // Two chunks can share a key only when 1024 chunks apart; verify.
      this.cache.set(key, c);
    } else if (c && (c.cx !== cx || c.cy !== cy || c.z !== z)) {
      c = this.map.hasChunk(cx, cy, z) ? this.map.chunk(cx, cy, z) : null;
    }
    return c;
  }

  known(x: number, y: number, z: number): boolean {
    return this.chunkAt(x, y, z) !== null;
  }

  ter(x: number, y: number, z: number): TerrainDef | null {
    const c = this.chunkAt(x, y, z);
    return c ? this.map.terrain.get(c.ter[localOf(y) * CHUNK + localOf(x)]) : null;
  }
  furn(x: number, y: number, z: number): FurnitureDef | null {
    const c = this.chunkAt(x, y, z);
    return c ? this.map.furniture.get(c.furn[localOf(y) * CHUNK + localOf(x)]) : null;
  }

  /** CDDA move cost (0 impassable); unknown tiles are impassable. */
  moveCost(x: number, y: number, z: number): number {
    const c = this.chunkAt(x, y, z);
    if (!c) return 0;
    const i = localOf(y) * CHUNK + localOf(x);
    const t = this.map.terrain.get(c.ter[i]);
    if (t.move_cost <= 0) return 0;
    const f = this.map.furniture.get(c.furn[i]);
    if (f.move_cost_mod < 0) return 0;
    // Vehicles and other map overlays (GameMap.overlays) replace the tile's cost.
    for (const o of this.map.overlays) {
      const oc = o.moveCost?.(x, y, z);
      if (oc !== undefined) return oc;
    }
    return t.move_cost + f.move_cost_mod;
  }
  passable(x: number, y: number, z: number): boolean {
    return this.moveCost(x, y, z) > 0;
  }
  /** Mirrors GameMap.opaque; unknown tiles are opaque. */
  opaque(x: number, y: number, z: number): boolean {
    const c = this.chunkAt(x, y, z);
    if (!c) return true;
    for (const o of this.map.overlays) if (o.opaque?.(x, y, z)) return true;
    const i = localOf(y) * CHUNK + localOf(x);
    const t = this.map.terrain.get(c.ter[i]);
    if (t.id === 't_null') return false;
    if (!hasFlag(t, 'TRANSPARENT')) return true;
    const f = this.map.furniture.get(c.furn[i]);
    return f.id !== 'f_null' && !hasFlag(f, 'TRANSPARENT');
  }
}

/**
 * Bresenham from (x0,y0) to (x1,y1) inclusive; `visit` returning false stops early.
 * Returns true if the walk completed.
 */
export function walkLine(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number) => boolean): boolean {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0, y = y0;
  for (;;) {
    if (!visit(x, y)) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Can a viewer at tile a see tile b (both endpoints excluded from the opacity test)? */
export function hasLOS(grid: Grid, ax: number, ay: number, bx: number, by: number, z: number): boolean {
  return walkLine(ax, ay, bx, by, (x, y) => {
    if ((x === ax && y === ay) || (x === bx && y === by)) return true;
    return !grid.opaque(x, y, z);
  });
}

/**
 * Straight walkable corridor between two float positions for a circle of radius r:
 * samples the segment every half tile and checks the tiles under the circle's bounds.
 */
export function clearWalk(grid: Grid, ax: number, ay: number, bx: number, by: number, z: number, r: number): boolean {
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(len / 0.5));
  let lastX = NaN, lastY = NaN;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    // Skip resampling the same tile footprint (most steps stay within one tile).
    const fx = Math.floor(x * 4), fy = Math.floor(y * 4);
    if (fx === lastX && fy === lastY) continue;
    lastX = fx;
    lastY = fy;
    for (let k = 0; k < 4; k++) {
      const tx = Math.floor(x + (k & 1 ? r : -r)), ty = Math.floor(y + (k & 2 ? r : -r));
      if (!grid.passable(tx, ty, z)) return false;
    }
  }
  return true;
}

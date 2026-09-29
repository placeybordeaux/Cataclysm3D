import type { GameMap } from '../world/map';

// Creatures are circles moving on the tile grid. We resolve collisions axis-separately
// against impassable tiles, which gives smooth wall sliding without a physics engine.

export const CREATURE_RADIUS = 0.3;

function blocked(map: GameMap, x: number, y: number, z: number, r: number): boolean {
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (map.passable(tx, ty, z)) continue;
      // circle vs tile AABB
      const cx = Math.max(tx, Math.min(x, tx + 1));
      const cy = Math.max(ty, Math.min(y, ty + 1));
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
    }
  return false;
}

/** Move a circle by (dx, dy); returns the new position after sliding along walls. */
export function moveWithCollision(
  map: GameMap, x: number, y: number, z: number, dx: number, dy: number, r = CREATURE_RADIUS,
): [number, number] {
  // Sub-step so fast movers can't tunnel through 1-tile walls.
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (r * 0.9)));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    if (!blocked(map, x + sx, y, z, r)) x += sx;
    if (!blocked(map, x, y + sy, z, r)) y += sy;
  }
  return [x, y];
}

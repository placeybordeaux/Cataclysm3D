import type { GameMap } from '../world/map';

// Creatures are circles moving on the tile grid. We resolve collisions axis-separately
// against impassable tiles, which gives smooth wall sliding without a physics engine.

export const CREATURE_RADIUS = 0.3;

function blocked(map: GameMap, x: number, y: number, z: number, r: number): boolean {
  // Overlays with sub-tile shapes (vehicle bodies) first; their tiles skip the AABB test.
  if (map.collideShapes(x, y, z, r)) return true;
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (map.passable(tx, ty, z) || map.shapedTile(tx, ty, z)) continue;
      // circle vs tile AABB
      const cx = Math.max(tx, Math.min(x, tx + 1));
      const cy = Math.max(ty, Math.min(y, ty + 1));
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
    }
  return false;
}

/**
 * Blocked moving along one axis: if a sideways nudge of at most the step length (and at most
 * the overlap with a corner, `r`) lets the move through, take the nudge. Walls (a whole row of
 * blocked tiles) stay walls: no nudge frees the move there.
 */
function roundCorner(map: GameMap, x: number, y: number, z: number, r: number, sx: number, sy: number): [number, number] {
  const step = Math.abs(sx || sy);
  let best: { px: number; py: number; need: number } | null = null;
  for (const side of [1, -1]) {
    // perpendicular to the move direction
    const px = sy ? side : 0, py = sx ? side : 0;
    for (let k = 1; k <= 6; k++) {
      const need = (r * k) / 6;
      const nx = x + px * need, ny = y + py * need;
      if (blocked(map, nx, ny, z, r)) break;
      if (!blocked(map, nx + sx, ny + sy, z, r)) {
        if (!best || need < best.need) best = { px, py, need };
        break;
      }
    }
  }
  if (!best) return [x, y];
  // Side-step this frame at walking speed; the forward move resumes once clear.
  const n = Math.min(best.need, step);
  return [x + best.px * n, y + best.py * n];
}

/** Move a circle by (dx, dy); returns the new position after sliding along walls. */
export function moveWithCollision(
  map: GameMap, x: number, y: number, z: number, dx: number, dy: number, r = CREATURE_RADIUS,
): [number, number] {
  // Sub-step so fast movers can't tunnel through 1-tile walls.
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (r * 0.9)));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    let movedX = false, movedY = false;
    if (!blocked(map, x + sx, y, z, r)) (x += sx), (movedX = true);
    if (!blocked(map, x, y + sy, z, r)) (y += sy), (movedY = true);
    // Corner rounding: walking straight into the corner of a lone blocked tile (a tree in a
    // forest) stopped you dead, because axis-separated sliding has nothing to slide along when
    // the other axis doesn't move (wave-3 playtest: stuck on a willow's corner at 0.21 tiles
    // overlap). Side-step around it by up to the step length, toward whichever side is free.
    // "Mostly along one axis": players never walk at exactly 270°.
    if (sx && !movedX && Math.abs(sy) < Math.abs(sx) * 0.5) [x, y] = roundCorner(map, x, y, z, r, sx, 0);
    else if (sy && !movedY && Math.abs(sx) < Math.abs(sy) * 0.5) [x, y] = roundCorner(map, x, y, z, r, 0, sy);
  }
  return [x, y];
}

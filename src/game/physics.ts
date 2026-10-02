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
 * How far (x, y)'s circle pokes into the nearest impassable tile, and which way to push to
 * clear it (unit vector scaled by the penetration depth; [0, 0] if not overlapping). Used both
 * to resolve a bad landing spot instantly and to let movement escape an overlap gradually
 * (see `resolveOverlap` / the overlap-escape clause in `moveWithCollision`). Doesn't see
 * sub-tile shape overlays (vehicle bodies): those report blocked via `collideShapes` with no
 * penetration depth to push along, so they're left to `blocked`'s plain yes/no.
 */
function escapeVector(map: GameMap, x: number, y: number, z: number, r: number): [number, number] {
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  let bestPen = 0, pushX = 0, pushY = 0;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (map.passable(tx, ty, z) || map.shapedTile(tx, ty, z)) continue;
      const cx = Math.max(tx, Math.min(x, tx + 1));
      const cy = Math.max(ty, Math.min(y, ty + 1));
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      const pen = r - d;
      if (pen <= bestPen) continue;
      bestPen = pen;
      // Dead-centre on the tile (d = 0, e.g. exactly on a wall's tile after a teleport):
      // push toward whichever half of the tile we're already closer to.
      if (d > 1e-6) (pushX = dx / d), (pushY = dy / d);
      else (pushX = x < tx + 0.5 ? -1 : 1), (pushY = y < ty + 0.5 ? -1 : 1);
    }
  return bestPen > 0 ? [pushX * bestPen, pushY * bestPen] : [0, 0];
}

/** True if (x, y)'s collision circle overlaps impassable terrain/furniture (not shape overlays). */
export function overlapsSolid(map: GameMap, x: number, y: number, z: number, r = CREATURE_RADIUS): boolean {
  return blocked(map, x, y, z, r);
}

/**
 * Instantly resolve a position that must not overlap solid geometry — a level change that
 * carries the fractional position across (falling, an elevator) can land the player's edge
 * inside a wall that happens to sit under the tile above/below. Pushes clear of whatever tile
 * it's embedded in (iterating in case a corner wedges it between two), else gives up and snaps
 * to the centre of the tile it's on, which is always free when you can stand on that tile at all.
 */
export function resolveOverlap(map: GameMap, x: number, y: number, z: number, r = CREATURE_RADIUS): [number, number] {
  if (!blocked(map, x, y, z, r)) return [x, y];
  let nx = x, ny = y;
  for (let i = 0; i < 8; i++) {
    const [ex, ey] = escapeVector(map, nx, ny, z, r);
    if (ex === 0 && ey === 0) break;
    // A hair past the exact penetration depth so the next check reads clear, not tangent.
    nx += ex * 1.02;
    ny += ey * 1.02;
  }
  if (!blocked(map, nx, ny, z, r)) return [nx, ny];
  return [Math.floor(x) + 0.5, Math.floor(y) + 0.5];
}

/**
 * One frame of a passive "walk out of a wall" safety net (a save loaded into a since-changed
 * map, a door shut on you): creeps clear at a fixed, visually gentle speed rather than
 * teleporting. A no-op once clear.
 */
export function nudgeOutOfOverlap(map: GameMap, x: number, y: number, z: number, dt: number, r = CREATURE_RADIUS): [number, number] {
  const [ex, ey] = escapeVector(map, x, y, z, r);
  const d = Math.hypot(ex, ey);
  if (d === 0) return [x, y];
  const NUDGE_SPEED = 1.5; // tiles/s
  const maxStep = NUDGE_SPEED * dt;
  // When the remaining escape fits in this frame's budget, overshoot it a hair (as
  // resolveOverlap does) so the result reads as clear, not exactly tangent to the wall.
  const step = d <= maxStep ? d + 0.001 : maxStep;
  return [x + (ex / d) * step, y + (ey / d) * step];
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
  // If we start a step already overlapping solid geometry (stuck there by some other bug, a
  // door that shut on us, a save loaded into a since-edited map…), `blocked` alone would freeze
  // every move forever: the destination overlaps too, just less. Allow a move in that case when
  // it strictly reduces the penetration depth, so the player can always walk clear instead of
  // being wedged in place — never allow a move that overlaps solid ground otherwise. The escape
  // check only runs once the plain `blocked` test actually fails, so normal (non-overlapping)
  // movement costs no more than before.
  const canMoveTo = (fromX: number, fromY: number, toX: number, toY: number): boolean => {
    if (!blocked(map, toX, toY, z, r)) return true;
    const curOverlap = Math.hypot(...escapeVector(map, fromX, fromY, z, r));
    if (curOverlap <= 0) return false;
    return Math.hypot(...escapeVector(map, toX, toY, z, r)) < curOverlap - 1e-9;
  };
  for (let i = 0; i < steps; i++) {
    let movedX = false, movedY = false;
    if (canMoveTo(x, y, x + sx, y)) (x += sx), (movedX = true);
    if (canMoveTo(x, y, x, y + sy)) (y += sy), (movedY = true);
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

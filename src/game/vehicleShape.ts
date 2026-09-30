import type { Vehicle } from './vehicle';

// Collision against a vehicle's *drawn* body rather than its whole grid tiles.
//
// The modelled look (src/render/vehicleModel.ts) draws a car narrower and a little shorter
// than the 4 x 6 tiles it occupies. Blocking whole tiles left an invisible wall ~0.7 m
// beside the paint. Instead each obstacle mount's cell is clipped to the body's outline
// (an axis-aligned rectangle in mount space, so rotation is free: test in mount space).
// Pure: no renderer imports; the renderer supplies the rectangle through
// VehicleSystem.bodyShape. Headless (tests, sim) there is none and the grid rules.

/** The drawn body in mount space: x along the vehicle (tail x0 .. nose x1), y across. */
export interface BodyRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Mount (mx, my)'s solid area: its cell clipped to the body, or null if nothing is left. */
export function mountSolid(b: BodyRect, mx: number, my: number): BodyRect | null {
  const x0 = Math.max(mx - 0.5, b.x0), x1 = Math.min(mx + 0.5, b.x1);
  const y0 = Math.max(my - 0.5, b.y0), y1 = Math.min(my + 0.5, b.y1);
  return x0 < x1 && y0 < y1 ? { x0, x1, y0, y1 } : null;
}

/** Distance² from (x, y) to a rectangle (0 inside). */
function dist2(r: BodyRect, x: number, y: number): number {
  const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
  const dy = y < r.y0 ? r.y0 - y : y > r.y1 ? y - r.y1 : 0;
  return dx * dx + dy * dy;
}

/**
 * Does a circle at world (x, y) with radius r overlap any blocking part of `v`'s body?
 * Blocking = the mount has an obstacle (vehicle.obstacleAt: closed doors, boards, glass,
 * seats' neighbours...), clipped to the body. Open doors and aisles don't block.
 */
export function circleHitsBody(v: Vehicle, b: BodyRect, x: number, y: number, r: number): boolean {
  const [lx, ly] = v.worldToMount(x, y);
  if (lx < b.x0 - r || lx > b.x1 + r || ly < b.y0 - r || ly > b.y1 + r) return false;
  const r2 = r * r;
  for (let mx = Math.round(lx - r) - 1; mx <= Math.round(lx + r) + 1; mx++)
    for (let my = Math.round(ly - r) - 1; my <= Math.round(ly + r) + 1; my++) {
      if (!v.hasMount(mx, my) || !v.obstacleAt(mx, my)) continue;
      const s = mountSolid(b, mx, my);
      if (s && dist2(s, lx, ly) < r2) return true;
    }
  return false;
}

/** Is world point (x, y) within the body outline (grown by `pad`)? */
export function pointInBody(v: Vehicle, b: BodyRect, x: number, y: number, pad = 0): boolean {
  const [lx, ly] = v.worldToMount(x, y);
  return lx >= b.x0 - pad && lx <= b.x1 + pad && ly >= b.y0 - pad && ly <= b.y1 + pad;
}

/** Circle vs the whole body outline (any mount, blocking or not): for run-overs. */
export function circleTouchesBody(v: Vehicle, b: BodyRect, x: number, y: number, r: number, facing = v.facing, vx = v.x, vy = v.y): boolean {
  const [lx, ly] = v.worldToMount(x, y, facing, vx, vy);
  return dist2(b, lx, ly) < r * r;
}

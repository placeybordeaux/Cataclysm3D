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

// --- driving collision: oriented boxes ------------------------------------------------------
//
// Crashes (vehicle vs terrain, vehicle vs vehicle) test the moving vehicle's drawn body as an
// oriented box in world space against blocking tile squares and other vehicles' boxes. BN
// decides *what* a part collides with per tile; here only the geometry changes: the body
// touches a tile / another body, and the contact point picks the mount (and so the part) that
// takes the damage.

/** An oriented box in world space: centre, unit axis along the vehicle (u) and across (w), half extents. */
export interface Obb {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  wx: number;
  wy: number;
  hx: number;
  hy: number;
}

/** A mount-space rectangle of `v` placed at a (hypothetical) pose, as a world box. */
export function rectObb(v: Vehicle, b: BodyRect, facing = v.facing, x = v.x, y = v.y): Obb {
  const [cx, cy] = v.mountToWorld((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, facing, x, y);
  // Axes from the vehicle's own transform, so the handedness always matches mountToWorld.
  const [ox, oy] = v.mountToWorld(0, 0, facing, x, y);
  const [ax, ay] = v.mountToWorld(1, 0, facing, x, y);
  const [bx, by] = v.mountToWorld(0, 1, facing, x, y);
  return { cx, cy, ux: ax - ox, uy: ay - oy, wx: bx - ox, wy: by - oy, hx: (b.x1 - b.x0) / 2, hy: (b.y1 - b.y0) / 2 };
}

/** World bounding box [x0, y0, x1, y1]. */
export function obbBounds(o: Obb): [number, number, number, number] {
  const ex = Math.abs(o.ux) * o.hx + Math.abs(o.wx) * o.hy, ey = Math.abs(o.uy) * o.hx + Math.abs(o.wy) * o.hy;
  return [o.cx - ex, o.cy - ey, o.cx + ex, o.cy + ey];
}

export function obbCorners(o: Obb): [number, number][] {
  const out: [number, number][] = [];
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]])
    out.push([o.cx + o.ux * o.hx * sx + o.wx * o.hy * sy, o.cy + o.uy * o.hx * sx + o.wy * o.hy * sy]);
  return out;
}

/** Projected half-length of `o` on axis (nx, ny). */
function reach(o: Obb, nx: number, ny: number): number {
  return o.hx * Math.abs(o.ux * nx + o.uy * ny) + o.hy * Math.abs(o.wx * nx + o.wy * ny);
}

/**
 * Overlap depth tolerance: boxes that merely touch (or overlap by float noise) don't collide,
 * so a car stopped with its paint on a wall can still reverse or slide away.
 */
const TOUCH = 1e-4;

/** Separating-axis test: does `o` overlap tile square (tx, ty)..(tx+1, ty+1)? */
export function obbHitsTile(o: Obb, tx: number, ty: number): boolean {
  const dx = o.cx - (tx + 0.5), dy = o.cy - (ty + 0.5);
  for (const [nx, ny] of [[1, 0], [0, 1], [o.ux, o.uy], [o.wx, o.wy]])
    if (Math.abs(dx * nx + dy * ny) >= reach(o, nx, ny) + 0.5 * (Math.abs(nx) + Math.abs(ny)) - TOUCH) return false;
  return true;
}

/** Separating-axis test between two oriented boxes. */
export function obbHitsObb(a: Obb, b: Obb): boolean {
  const dx = a.cx - b.cx, dy = a.cy - b.cy;
  for (const [nx, ny] of [[a.ux, a.uy], [a.wx, a.wy], [b.ux, b.uy], [b.wx, b.wy]])
    if (Math.abs(dx * nx + dy * ny) >= reach(a, nx, ny) + reach(b, nx, ny) - TOUCH) return false;
  return true;
}

function inObb(o: Obb, x: number, y: number): boolean {
  const dx = x - o.cx, dy = y - o.cy;
  return Math.abs(dx * o.ux + dy * o.uy) <= o.hx + 1e-9 && Math.abs(dx * o.wx + dy * o.wy) <= o.hy + 1e-9;
}

/** Closest point of `o` to world (x, y). */
export function clampToObb(o: Obb, x: number, y: number): [number, number] {
  const dx = x - o.cx, dy = y - o.cy;
  const a = Math.max(-o.hx, Math.min(o.hx, dx * o.ux + dy * o.uy)), c = Math.max(-o.hy, Math.min(o.hy, dx * o.wx + dy * o.wy));
  return [o.cx + o.ux * a + o.wx * c, o.cy + o.uy * a + o.wy * c];
}

/**
 * Where two overlapping boxes touch (world): the mean of the corners of each inside the other.
 * Moving in small substeps the overlap is a sliver, so that's a corner or an edge's middle;
 * when edges cross with no corner inside, the point of `a` nearest `b`'s centre.
 */
export function obbContact(a: Obb, b: Obb): [number, number] {
  const pts = [...obbCorners(a).filter(([x, y]) => inObb(b, x, y)), ...obbCorners(b).filter(([x, y]) => inObb(a, x, y))];
  if (!pts.length) return clampToObb(a, b.cx, b.cy);
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

/** The mount of `v` nearest to mount-space point (lx, ly) (the part there takes the hit). */
export function nearestMount(v: Vehicle, lx: number, ly: number): [number, number] {
  let best: [number, number] = [0, 0], bd = Infinity;
  for (const p of v.parts) {
    const dx = Math.max(0, Math.abs(lx - p.mx) - 0.5), dy = Math.max(0, Math.abs(ly - p.my) - 0.5);
    // ties (a point inside a cell's edge) go to the mount whose centre is closer
    const d = dx * dx + dy * dy + 1e-3 * ((lx - p.mx) ** 2 + (ly - p.my) ** 2);
    if (d < bd) (bd = d), (best = [p.mx, p.my]);
  }
  if (bd === Infinity) throw new Error(`nearestMount: the ${v.name} has no parts`);
  return best;
}

/**
 * The boxes a vehicle collides with: its drawn body, or (no shape: parts look, frame builds)
 * one unit square per mount, i.e. its whole tiles.
 */
export function vehicleObbs(v: Vehicle, b: BodyRect | null, facing = v.facing, x = v.x, y = v.y): Obb[] {
  if (b) return [rectObb(v, b, facing, x, y)];
  const seen = new Set<string>(), out: Obb[] = [];
  for (const p of v.parts) {
    const k = `${p.mx},${p.my}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(rectObb(v, { x0: p.mx - 0.5, x1: p.mx + 0.5, y0: p.my - 0.5, y1: p.my + 0.5 }, facing, x, y));
  }
  return out;
}

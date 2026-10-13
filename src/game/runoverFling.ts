// Run-over flights (docs/VEHICLES.md "Run-over bodies"). Pure: no map, no three.js.
//
// A creature hit by a vehicle is launched along the vehicle's velocity with an up-kick and a
// spin, flies, bounces, skids and comes to rest. The simulation owns the trajectory (where the
// body is at every moment, against walls, under ceilings), so the corpse item lands where the
// body is drawn landing and a survivor gets up where it came down. The renderer
// (render/chars/ragdoll.ts) only adds the tumble and the flailing limbs on top of this path.
//
// The feel target is GTA 3 / Vice City, not BN: BN teleports the creature a few tiles
// (vehicle::fling_creature). Under `runoverMode = 'fall'` the vehicle system still does that.

/** Every tunable of the flight in one place (m, s, m/s, rad/s). */
export const RUNOVER = {
  /** horizontal launch speed as a share of the vehicle's: a slow hit throws the body clear ahead
   * of the bumper, a fast one lets the car run under it (up the bonnet and over the roof) */
  carryLow: 1.35,
  carryHigh: 0.7,
  /** ...blending from low to high between these impact speeds (m/s: 40 and 54 km/h); in
   * between the body rolls up onto the bonnet */
  carryRamp: [11, 15] as [number, number],
  /** sideways throw per unit of lateral offset across the vehicle's front, times impact speed */
  side: 0.32,
  /** up-kick below the ramp: base + per m/s of impact (2.7 m/s at 20 km/h: a hop) */
  upBase: 1.8,
  upPerMs: 0.16,
  /** up-kick above it: enough air for a car to pass under (a 1.75 m arc, ~0.95 s) */
  upOver: 7.5,
  /** somersault (legs swept out from under it, head toward the bumper) and spin from an
   * off-centre hit, per m/s of impact; roll is a small seeded jitter */
  pitchPerMs: 0.55,
  pitchMax: 11,
  yawPerMs: 0.6,
  yawMax: 9,
  rollJitter: 2.2,
  /** heavy creatures fly less: launch × clamp(sqrt(massRef / kg)) */
  massRef: 80,
  massK: [0.3, 1.2] as [number, number],
  /** arcade gravity: a little heavier than 9.8 so flights land with a thump instead of floating */
  gravity: 16,
  /** ground bounce: restitution, below this landing speed it skids instead, tangential keep */
  bounce: 0.36,
  bounceMin: 1.5,
  bounceKeep: 0.72,
  /** skid / roll to rest (m/s²) */
  slideDecel: 7.5,
  /** walls: restitution along the normal and how much of the scrape is kept */
  wallBounce: 0.35,
  wallKeep: 0.7,
  /** body radius against walls (tiles) */
  radius: 0.28,
  /** highest the body's underside goes under a roof (m above its floor) */
  ceiling: 1.4,
  maxTime: 4,
  /** path sample step (s) */
  dt: 1 / 60,
  /** seconds a thrown survivor lies on the ground after landing before it gets up */
  getUp: 1.1,
  /** a flight that would end on a taken tile slides to the nearest free one within this (tiles) */
  endSearch: 2,
};
export type RunoverTuning = typeof RUNOVER;

/** Sim switch: 'ragdoll' / 'loose' fly the body along a path (render tumble stiff / loose), 'fall' = BN's teleport. */
export type RunoverMode = 'ragdoll' | 'loose' | 'fall';
export const RUNOVER_MODES: readonly RunoverMode[] = ['ragdoll', 'loose', 'fall'];
export const isRunoverMode = (s: unknown): s is RunoverMode => typeof s === 'string' && (RUNOVER_MODES as readonly string[]).includes(s);

export interface RunoverImpact {
  /** where the creature stands (tiles) */
  x: number;
  y: number;
  /** the vehicle's planar velocity at the hit (tiles/s = m/s, x east, y south) */
  vx: number;
  vy: number;
  /** where across the vehicle's front it was hit: -1 left edge .. 0 centre .. 1 right edge */
  offset: number;
  /** creature mass (kg) */
  mass: number;
  /** 0..1, per creature: picks which way the small random parts go */
  seed: number;
}

export interface Launch {
  vx: number;
  vy: number;
  vz: number;
  /** rad/s: somersault about the horizontal axis across the travel, spin about vertical, roll along travel */
  pitch: number;
  yaw: number;
  roll: number;
  /** unit heading of the vehicle */
  dx: number;
  dy: number;
  speed: number;
}

export interface FlingContact {
  t: number;
  x: number;
  y: number;
  kind: 'ground' | 'wall';
  /** closing speed (m/s) */
  speed: number;
}

export interface FlingPlan {
  x0: number;
  y0: number;
  /** samples at i * dt: position (tiles) and the body's underside above its floor (m) */
  dt: number;
  xs: number[];
  ys: number[];
  hs: number[];
  duration: number;
  /** first touch of the ground (s) */
  landT: number;
  contacts: FlingContact[];
  launch: Launch;
  seed: number;
}

/** A plan being played out by the simulation (Monster.fling). `t` < 0: planned, not launched yet. */
export interface FlingRun {
  plan: FlingPlan;
  t: number;
  /** the map the plan was flown through (gibs.ts flies the pieces of a body gibbed by the hit through it too) */
  world?: FlingWorld;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** Deterministic 0..1 from a seed and a channel. */
function hash(seed: number, k: number): number {
  const x = Math.sin(seed * 9301.17 + k * 49.297) * 43758.5453;
  return x - Math.floor(x);
}

/** Launch velocity and spin from an impact. Pure. */
export function launchFromImpact(imp: RunoverImpact, K: RunoverTuning = RUNOVER): Launch {
  const speed = Math.hypot(imp.vx, imp.vy);
  if (!(speed > 1e-3)) throw new Error(`launchFromImpact: vehicle not moving (${imp.vx}, ${imp.vy})`);
  if (!(imp.mass > 0)) throw new Error(`launchFromImpact: bad mass ${imp.mass}`);
  const dx = imp.vx / speed, dy = imp.vy / speed;
  // the vehicle's right (y is south): heading east -> south
  const rx = -dy, ry = dx;
  const r = clamp((speed - K.carryRamp[0]) / (K.carryRamp[1] - K.carryRamp[0]), 0, 1);
  const mk = clamp(Math.sqrt(K.massRef / imp.mass), K.massK[0], K.massK[1]);
  const carry = (K.carryLow + (K.carryHigh - K.carryLow) * r) * speed * mk;
  const off = clamp(imp.offset, -1, 1);
  const side = (off * K.side + (hash(imp.seed, 1) - 0.5) * 0.08) * speed * mk;
  const vz = (K.upBase + K.upPerMs * speed + (K.upOver - K.upBase - K.upPerMs * speed) * r) * mk;
  const pitch = Math.min(K.pitchMax, K.pitchPerMs * speed) * mk;
  // an off-centre hit spins it about the vertical: struck on the right of the bonnet, the near
  // side is dragged along and it turns clockwise seen from above
  const yaw = clamp((off * 1.4 + (hash(imp.seed, 2) - 0.5) * 0.5) * K.yawPerMs * speed, -K.yawMax, K.yawMax) * mk;
  const roll = (hash(imp.seed, 3) - 0.5) * 2 * K.rollJitter * mk;
  return { vx: dx * carry + rx * side, vy: dy * carry + ry * side, vz, pitch, yaw, roll, dx, dy, speed };
}

export interface FlingWorld {
  /** the tile stops a flying body (walls, other vehicles, no floor to land on) */
  blocked(tx: number, ty: number): boolean;
  /** a roof over this tile (the body can't fly through the ceiling) */
  roofed?(tx: number, ty: number): boolean;
  /** the body may come to rest here (passable, no one standing in it, not under the vehicle) */
  free?(tx: number, ty: number): boolean;
}

function circleBlocked(w: FlingWorld, x: number, y: number, r: number): boolean {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++)
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (!w.blocked(tx, ty)) continue;
      const cx = clamp(x, tx, tx + 1), cy = clamp(y, ty, ty + 1);
      if ((cx - x) ** 2 + (cy - y) ** 2 < r * r) return true;
    }
  return false;
}

/**
 * Fly a body from (x, y) with `launch` through `world`: ballistic flight under arcade gravity,
 * axis-separated wall bounces, a ceiling under roofs, ground bounces, then a skid to rest. The
 * end is moved to the nearest free tile within RUNOVER.endSearch; null if there is none (the
 * vehicle has pinned it, as BN's fling does). `h0`: starting height of the underside (m; the
 * pieces of a gibbed body leave from where they were on it).
 */
export function planFling(x: number, y: number, launch: Launch, world: FlingWorld, seed = 0, K: RunoverTuning = RUNOVER, h0 = 0): FlingPlan | null {
  const dt = K.dt;
  const r = K.radius;
  let vx = launch.vx, vy = launch.vy, vz = launch.vz, h = h0;
  let air = vz > 0 || h0 > 0;
  const xs = [x], ys = [y], hs = [h0];
  const contacts: FlingContact[] = [];
  let landT = -1;
  const n = Math.ceil(K.maxTime / dt);
  for (let i = 1; i <= n; i++) {
    const t = i * dt;
    if (air) vz -= K.gravity * dt;
    // walls, one axis at a time so a body scrapes along a wall instead of sticking to it
    const nx = x + vx * dt;
    if (circleBlocked(world, nx, y, r)) {
      contacts.push({ t, x, y, kind: 'wall', speed: Math.abs(vx) });
      vx = -vx * K.wallBounce;
      vy *= K.wallKeep;
    } else x = nx;
    const ny = y + vy * dt;
    if (circleBlocked(world, x, ny, r)) {
      contacts.push({ t, x, y, kind: 'wall', speed: Math.abs(vy) });
      vy = -vy * K.wallBounce;
      vx *= K.wallKeep;
    } else y = ny;
    if (air) {
      h += vz * dt;
      if (vz > 0 && h > K.ceiling && world.roofed?.(Math.floor(x), Math.floor(y))) {
        h = K.ceiling;
        vz = -vz * 0.3;
      }
      if (h <= 0) {
        h = 0;
        if (landT < 0) landT = t;
        contacts.push({ t, x, y, kind: 'ground', speed: -vz });
        if (-vz > K.bounceMin) {
          vz = -vz * K.bounce;
          vx *= K.bounceKeep;
          vy *= K.bounceKeep;
        } else {
          vz = 0;
          air = false;
        }
      }
    }
    if (!air) {
      const s = Math.hypot(vx, vy), dec = K.slideDecel * dt;
      if (s <= dec) vx = vy = 0;
      else (vx *= (s - dec) / s), (vy *= (s - dec) / s);
    }
    xs.push(x);
    ys.push(y);
    hs.push(h);
    if (!air && vx === 0 && vy === 0) break;
  }
  if (landT < 0) landT = (xs.length - 1) * dt;
  // come to rest on a tile something can lie on
  if (world.free && !world.free(Math.floor(x), Math.floor(y))) {
    let best: [number, number] | null = null, bd = Infinity;
    const R = K.endSearch;
    for (let oy = -R; oy <= R; oy++)
      for (let ox = -R; ox <= R; ox++) {
        const tx = Math.floor(x) + ox, ty = Math.floor(y) + oy;
        if (world.blocked(tx, ty) || !world.free(tx, ty)) continue;
        const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
        if (d < bd) (bd = d), (best = [tx + 0.5, ty + 0.5]);
      }
    if (!best) return null;
    // a short slide over (0.15 s) rather than a pop
    const steps = Math.max(1, Math.round(0.15 / dt));
    const sx = x, sy = y;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      xs.push(sx + (best[0] - sx) * k);
      ys.push(sy + (best[1] - sy) * k);
      hs.push(0);
    }
  }
  return { x0: xs[0], y0: ys[0], dt, xs, ys, hs, duration: (xs.length - 1) * dt, landT, contacts, launch, seed };
}

/** Where the plan puts the body at time t (clamped to the flight). */
export function sampleFling(p: FlingPlan, t: number): { x: number; y: number; h: number } {
  const f = clamp(t / p.dt, 0, p.xs.length - 1);
  const i = Math.min(p.xs.length - 2, Math.floor(f));
  if (i < 0) return { x: p.xs[0], y: p.ys[0], h: p.hs[0] };
  const k = f - i;
  return { x: p.xs[i] + (p.xs[i + 1] - p.xs[i]) * k, y: p.ys[i] + (p.ys[i + 1] - p.ys[i]) * k, h: p.hs[i] + (p.hs[i + 1] - p.hs[i]) * k };
}

export function flingEnd(p: FlingPlan): [number, number] {
  return [p.xs[p.xs.length - 1], p.ys[p.ys.length - 1]];
}

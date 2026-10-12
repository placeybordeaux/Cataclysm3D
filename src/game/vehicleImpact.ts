import type { Vehicle } from './vehicle';
import type { BodyRect, Obb } from './vehicleShape';

// Vehicle-vs-vehicle (and vehicle-vs-wall) momentum, and how heavy vehicles handle.
//
// A vehicle's driven state is 1-D: `velocity` along its facing, turned by the bicycle model
// (src/game/vehicles.ts simulate). That leaves nowhere to put a sideways shove or a spin, so
// crashes used to treat the other vehicle as an immovable wall: a 18 t Abrams clipping an
// ambulance stopped dead and its driver took the whole 30 mph as a jolt (playtest, 2026-10).
//
// Here every vehicle also gets a transient `Motion`: a world-space slide velocity and a spin
// (deg/s about the body centre). Contacts exchange an impulse along the contact normal (rigid
// bodies with mass and a box's moment of inertia, restitution, Coulomb friction along the
// tangent), so the heavy one barely slows, the light one is shoved and spun, off-centre hits
// add spin and glancing hits slide. The slide then decays like tyres: weakly along the wheels
// (they roll) and hard across them. Pure maths and per-vehicle state; VehicleSystem does the
// geometry and integrates through its collision-checked `move`.
//
// Feel target (docs/VEHICLES.md "Momentum crashes"): GTA 3 / Vice City arcade, not BN numbers.

/** 'momentum' (default): impulses push and spin both vehicles. 'immovable': the pre-2026-10
 *  model, another vehicle is a heavy obstacle that stops you (light ones are teleport-shoved). */
export const CRASH_MODELS = ['momentum', 'immovable'] as const;
export type CrashModel = (typeof CRASH_MODELS)[number];
export const isCrashModel = (s: unknown): s is CrashModel => (CRASH_MODELS as readonly unknown[]).includes(s);

/** 'weighty' (default): heavy / tracked vehicles rev, steer and pivot slowly and have a governed
 *  top speed. 'light': every vehicle handles on the car tuning (the old feel). */
export const HANDLING_MODES = ['weighty', 'light'] as const;
export type HandlingMode = (typeof HANDLING_MODES)[number];
export const isHandlingMode = (s: unknown): s is HandlingMode => (HANDLING_MODES as readonly unknown[]).includes(s);

// --- tuning ---------------------------------------------------------------------------------

/** Vehicle-vs-vehicle bounce. Low: crashes crumple, they don't ping-pong. */
export const VEHICLE_RESTITUTION = 0.25;
/** Sliding friction between two bodies: glancing hits scrape along rather than grab. */
export const VEHICLE_FRICTION = 0.3;
/** Walls: no bounce (you stop at the paint), some scrape, so you slide along at an angle. */
export const WALL_RESTITUTION = 0;
export const WALL_FRICTION = 0.35;
/**
 * Moment of inertia scale over a uniform box's m(L²+W²)/12. Under 1 spins struck vehicles a
 * bit more than real ones (arcade: a clipped car swaps ends), without making a tank twitchy
 * (its own inertia is what keeps it straight).
 */
export const INERTIA_SCALE = 0.5;
/** Slide decay, m/s² (constant, Coulomb) + 1/s (proportional): across the wheels / tracks. */
export const SLIDE_DECEL_SIDE = 7;
/** ...along the wheels when nobody is holding the vehicle (parked: gear / handbrake). */
export const SLIDE_DECEL_PARKED = 2.5;
export const SLIDE_DAMP = 1;
/** Spin decay: deg/s² + 1/s. */
export const SPIN_DECEL = 60;
export const SPIN_DAMP = 1;
/**
 * Spun out: a vehicle struck at more than SKID_MIN_MPH (closing) and left spinning, that you
 * aren't driving, breaks its tyres loose for SKID_TIME s. GTA's rear-quarter hit swaps a car's ends; with the
 * plain decay above it turned 20-30 deg, because the parked brake (1/s proportional) stopped it
 * within metres and the rammer's nose caught its swinging tail and pushed the spin back out.
 * While skidding it slides on (SKID_* decay, Coulomb with little proportional drag) and a
 * vehicle contact can only take SKID_COUNTER of any impulse torque that would oppose its spin
 * (0: it shoves the car, it never checks the spin).
 */
export const SKID_MIN_MPH = 8;
/** ...and left spinning faster than this (deg/s): a square shunt is braked as before. */
export const SKID_MIN_SPIN = 45;
export const SKID_TIME = 1.6;
export const SKID_SPIN_DECEL = 70;
export const SKID_SPIN_DAMP = 0.35;
export const SKID_SLIDE_DECEL = 4.5;
export const SKID_SLIDE_DAMP = 0.25;
export const SKID_COUNTER = 0;
/** Caps so a bad contact can never launch anything absurd. */
export const MAX_SLIDE = 35;
export const MAX_SPIN = 360;
/**
 * Crash damage per unit of kinetic energy lost: CDDA's d_E / 400 (velocities in mph, as the
 * terrain loop in vehicle.ts resolveCollision), times this. The energy is what the impulse
 * actually removed, so glancing hits and heavy-vs-light hits do what they should.
 */
export const CRASH_DAMAGE_SCALE = 1.2;

// --- per-vehicle transient motion ------------------------------------------------------------

export interface Motion {
  /** World slide velocity, m/s (on top of `velocity` along the facing). */
  sx: number;
  sy: number;
  /** Spin, deg/s about the body centre (+ = clockwise from above, the way facing grows). */
  spin: number;
  /** Skid-steer pivot rate actually reached, deg/s (spools toward the held key). */
  pivot: number;
  /** The drive model's own yaw rate this frame (steering + pivot), deg/s; contact velocities. */
  yaw: number;
  /** Seconds left spun out (tyres broken loose by a crash, SKID_TIME); 0 = gripping. */
  skid: number;
}

const motions = new WeakMap<Vehicle, Motion>();

/** The vehicle's transient motion (created at rest). Not saved: a load ends any slide. */
export function motionOf(v: Vehicle): Motion {
  let m = motions.get(v);
  if (!m) motions.set(v, (m = { sx: 0, sy: 0, spin: 0, pivot: 0, yaw: 0, skid: 0 }));
  return m;
}

/** Nothing left to integrate (slide and spin settled). */
export function settled(m: Motion): boolean {
  return Math.abs(m.sx) < 0.02 && Math.abs(m.sy) < 0.02 && Math.abs(m.spin) < 0.3;
}

/** Drop any slide / spin (teleports, being placed). */
export function stopMotion(v: Vehicle): void {
  const m = motions.get(v);
  if (m) m.sx = m.sy = m.spin = m.pivot = m.skid = 0;
}

/**
 * Let the slide and spin decay for `dt` s. `rolling` = someone is driving it or it's rolling
 * on its own: the along-the-wheels part of the slide then goes into `v.velocity` (the wheels
 * just roll; the drive model owns that speed), else it's braked like a parked car.
 * `tracked`: tracks bite sideways harder than tyres. `towed`: on a tow cable (towing.ts), the
 * sideways slide and spin are left to its axles' grip.
 */
export function decayMotion(v: Vehicle, m: Motion, dt: number, rolling: boolean, tracked: boolean, towed = false): void {
  const rad = (v.facing * Math.PI) / 180;
  const fx = Math.cos(rad), fy = Math.sin(rad);
  let along = m.sx * fx + m.sy * fy;
  let side = -m.sx * fy + m.sy * fx;
  const tr = tracked ? 1.5 : 1;
  if (m.skid > 0) {
    // Spun out: the wheels aren't pointing where it's going, so it neither rolls nor brakes;
    // it scrubs off speed and spin alike, and slowly.
    m.skid = Math.max(0, m.skid - dt);
    along = decay(along, SKID_SLIDE_DECEL * tr, SKID_SLIDE_DAMP, dt);
    side = decay(side, SKID_SLIDE_DECEL * tr, SKID_SLIDE_DAMP, dt);
    m.spin = decay(m.spin, SKID_SPIN_DECEL * tr, SKID_SPIN_DAMP, dt);
  } else {
    if (rolling) {
      v.velocity += along;
      along = 0;
    } else along = decay(along, SLIDE_DECEL_PARKED, SLIDE_DAMP, dt);
    // On a tow cable the tyres themselves hold it (towing.ts grips each axle): this flat
    // decay at the centre would pin it straight and it would never swing in behind the tower.
    if (!towed) {
      side = decay(side, SLIDE_DECEL_SIDE * tr, SLIDE_DAMP, dt);
      m.spin = decay(m.spin, SPIN_DECEL * tr, SPIN_DAMP, dt);
    }
  }
  m.sx = along * fx - side * fy;
  m.sy = along * fy + side * fx;
  if (settled(m)) m.sx = m.sy = m.spin = m.skid = 0;
}

/** Toward zero by `c`·dt + k·|x|·dt, never past it. */
function decay(x: number, c: number, k: number, dt: number): number {
  const d = (c + k * Math.abs(x)) * dt;
  return Math.abs(x) <= d ? 0 : x - Math.sign(x) * d;
}

// --- rigid-body contact ----------------------------------------------------------------------

/** A body for one contact: world velocity of its centre, spin (rad/s), mass, inertia, centre. */
export interface ContactBody {
  m: number;
  /** Moment of inertia, kg·m²; Infinity = can't turn (and m Infinity = a wall). */
  I: number;
  cx: number;
  cy: number;
  /** Velocity of the contact point (includes rotation), m/s. */
  pvx: number;
  pvy: number;
}

export interface ImpulseResult {
  /** Impulse on `a` (N·s, world); `b` gets the opposite. */
  jx: number;
  jy: number;
  /** Normal approach speed before (m/s, > 0 = closing). */
  closing: number;
  /** Kinetic energy the contact removed, J (bounce loss + scraping). */
  lost: number;
}

/**
 * Impulse between `a` and `b` touching at (px, py) with unit normal (nx, ny) pointing from b
 * into a. Separating contacts get none. Restitution `e` on the normal, Coulomb friction `mu`
 * on the tangent (capped at what stops the sliding there).
 */
export function contactImpulse(a: ContactBody, b: ContactBody, px: number, py: number, nx: number, ny: number, e: number, mu: number): ImpulseResult {
  const rax = px - a.cx, ray = py - a.cy, rbx = px - b.cx, rby = py - b.cy;
  const rvx = a.pvx - b.pvx, rvy = a.pvy - b.pvy;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return { jx: 0, jy: 0, closing: 0, lost: 0 };
  const inv = (m: number) => (Number.isFinite(m) ? 1 / m : 0);
  const k = (tx: number, ty: number) => {
    const ca = rax * ty - ray * tx, cb = rbx * ty - rby * tx;
    return inv(a.m) + inv(b.m) + ca * ca * inv(a.I) + cb * cb * inv(b.I);
  };
  const jn = (-(1 + e) * vn) / k(nx, ny);
  let tx = rvx - vn * nx, ty = rvy - vn * ny;
  const vt = Math.hypot(tx, ty);
  let jt = 0;
  if (vt > 1e-6) {
    tx /= vt;
    ty /= vt;
    jt = -Math.min(mu * jn, vt / k(tx, ty));
  }
  const jx = jn * nx + jt * tx, jy = jn * ny + jt * ty;
  // Energy removed: the normal part loses (1 - e²) of its relative KE, friction does work
  // jt·(slip). Close enough for a damage figure; exact for centred hits.
  const lostN = 0.5 * (1 - e * e) * (vn * vn) / k(nx, ny);
  const lostT = vt > 1e-6 ? Math.abs(jt) * vt * 0.5 : 0;
  return { jx, jy, closing: -vn, lost: lostN + lostT };
}

/** Moment of inertia of a vehicle's body box (mount-space rect, metres). */
export function boxInertia(mass: number, b: BodyRect): number {
  const L = b.x1 - b.x0, W = b.y1 - b.y0;
  return (mass * (L * L + W * W) / 12) * INERTIA_SCALE;
}

/**
 * Share of crash damage the part of a `mass` vehicle takes against a `mass2` one (0.05..0.95):
 * in proportion to its own velocity change, i.e. the other's share of the total mass. Equal
 * cars split it evenly; a tank clipping an ambulance takes ~10% and the ambulance the rest.
 * (CDDA's weight factor in vehicle.ts resolveCollision is logarithmic, 44/56 for that pair,
 * which wrecked a tank's front plating on an ambulance: not the arcade brief.)
 */
export function damageShare(mass: number, mass2: number): number {
  return Math.max(0.05, Math.min(0.95, mass2 / (mass + mass2)));
}

/** Total crash damage (both sides) for `lostJ` joules: CDDA's d_E / 400 in mph² units. */
export function crashDamage(lostJ: number, mphPerMs: number): number {
  return ((lostJ * mphPerMs * mphPerMs) / 400) * CRASH_DAMAGE_SCALE;
}

/**
 * Separating-axis contact normal between two boxes: the axis of least overlap (or, if they're
 * apart, most separation), as a unit vector pointing from `b` toward `a`.
 */
export function obbNormal(a: Obb, b: Obb): [number, number] {
  const dx = a.cx - b.cx, dy = a.cy - b.cy;
  const reach = (o: Obb, nx: number, ny: number) => o.hx * Math.abs(o.ux * nx + o.uy * ny) + o.hy * Math.abs(o.wx * nx + o.wy * ny);
  let best: [number, number] = [1, 0], bestOverlap = Infinity;
  for (const [nx, ny] of [[a.ux, a.uy], [a.wx, a.wy], [b.ux, b.uy], [b.wx, b.wy]]) {
    const d = dx * nx + dy * ny;
    const overlap = reach(a, nx, ny) + reach(b, nx, ny) - Math.abs(d);
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      best = d >= 0 ? [nx, ny] : [-nx, -ny];
    }
  }
  return best;
}

/** A map tile as a box (for obbNormal against a vehicle). */
export function tileObb(tx: number, ty: number): Obb {
  return { cx: tx + 0.5, cy: ty + 0.5, ux: 1, uy: 0, wx: 0, wy: 1, hx: 0.5, hy: 0.5 };
}

// --- heavy handling ----------------------------------------------------------------------------

/** Below this a vehicle handles like a car; heft grows with log mass up to HEFT_MASS_FULL. */
const HEFT_MASS_FROM = 3000;
const HEFT_MASS_FULL = 20000;

/**
 * How heavy a vehicle should feel, 0 (a car) .. 1 (a main battle tank): log mass between 3 and
 * 20 t, at full weight for tracked vehicles and half for wheeled ones (a semi is heavy, but a
 * truck engine and road tyres still feel like a truck). From parts data, never the vehicle id.
 */
export function heftOf(mass: number, tracked: boolean): number {
  const h = Math.max(0, Math.min(1, Math.log(mass / HEFT_MASS_FROM) / Math.log(HEFT_MASS_FULL / HEFT_MASS_FROM)));
  return tracked ? h : h * 0.5;
}

export interface Handling {
  heft: number;
  /** Multipliers on the car tuning in vehicles.ts. */
  throttleRamp: number;
  accel: number;
  brake: number;
  coast: number;
  steerIn: number;
  steerOut: number;
  latAcc: number;
  /** Governed top speed on tracks, m/s on road (Infinity: CDDA's power/drag limit only). */
  topSpeed: number;
  /** Skid-steer pivot at a standstill, deg/s, and the seconds it takes to spool to it (0 = instant). */
  pivotRate: number;
  pivotSpool: number;
}

/** Pivot rate of the reference MBT (55 W/kg, BN's Abrams), deg/s: ~11 s for a full turn. */
export const PIVOT_REF_DEG_S = 32;
const PIVOT_REF_PW = 55;
/** The old flat pivot (HandlingMode 'light'). */
export const PIVOT_LIGHT_DEG_S = 40;

/**
 * Handling for a vehicle of `mass` kg, engine `power` W, on tracks or not. `light` = the old
 * car tuning for everything (factors 1, flat 40 deg/s pivot, no governor).
 */
export function handlingFor(mass: number, power: number, tracked: boolean, mode: HandlingMode): Handling {
  if (mode === 'light') return { heft: 0, throttleRamp: 1, accel: 1, brake: 1, coast: 1, steerIn: 1, steerOut: 1, latAcc: 1, topSpeed: Infinity, pivotRate: PIVOT_LIGHT_DEG_S, pivotSpool: 0 };
  const h = heftOf(mass, tracked);
  const pw = power > 0 ? power / mass : 0;
  const pwRel = Math.max(0, Math.min(1, pw / PIVOT_REF_PW));
  return {
    heft: h,
    // A turbine or a big diesel takes its time to wind up: ~0.7 s to full pedal on an MBT.
    throttleRamp: 1 - 0.8 * h,
    accel: 1 - 0.45 * h,
    brake: 1 - 0.4 * h,
    // Less engine braking: it plows on when you lift.
    coast: 1 - 0.5 * h,
    steerIn: 1 + 1.5 * h,
    steerOut: 1 + h,
    latAcc: 1 - 0.3 * h,
    // Tracks are geared and governed (an M1 does ~45 mph on a road, an M113 ~40, an M60 30):
    // 27 mph plus up to 18 more for power-to-weight (BN's Abrams 45, M60 36, M113 34, Bradley
    // 33). CDDA's 150 mph tank comes from car drag maths applied to a turbine.
    topSpeed: tracked ? (27 + 18 * pwRel) / 2.2369363 : Infinity,
    pivotRate: tracked ? PIVOT_REF_DEG_S * Math.max(0.45, Math.min(1.3, Math.sqrt(pw / PIVOT_REF_PW))) : PIVOT_LIGHT_DEG_S,
    pivotSpool: 0.3 + 1.0 * h,
  };
}

/** Governed top speed off road: tracks lose less than tyres (offroad is 1 on road .. 4). */
export function trackTopSpeed(h: Handling, offroad: number): number {
  return h.topSpeed / (1 + 0.15 * (offroad - 1));
}

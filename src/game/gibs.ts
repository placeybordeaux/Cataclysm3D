// Gibbed bodies break into pieces (docs/VEHICLES.md "Gibs"). Pure: no three.js; the map only
// through a FlingWorld.
//
// BN's rule is untouched: a monster pulverised by the killing blow (mondeath.ts overflowDamage,
// or a SPLATTER death) leaves no corpse, only its drops and the gib/blood fields. What changes
// is how it looks: instead of vanishing, the body comes apart into a torso, a head and limbs,
// each thrown from where it was on the body along the blow (a vehicle's throw at speed: over the
// bonnet and roof), bouncing and skidding through the map like a run-over body (runoverFling.ts
// planFling) and lying where it stops. The simulation plans the flights, so the blood they
// leave on the ground is ordinary, deterministic map fields; render/chars/gibs.ts draws the
// pieces from the creature's own rig parts.

import type { Rng } from '../core/rng';
import { planFling, RUNOVER, type FlingPlan, type FlingWorld, type Launch, type RunoverTuning } from './runoverFling';
import type { CreatureSize } from './combat';

/** 'pieces' = the body comes apart (default); 'splat' = the old look (it vanishes into the splatter). */
export type GibMode = 'pieces' | 'splat';
export const GIB_MODES: readonly GibMode[] = ['pieces', 'splat'];
export const isGibMode = (s: unknown): s is GibMode => typeof s === 'string' && (GIB_MODES as readonly string[]).includes(s);

/** How many pieces: some = head, an arm and a leg off; lots = every limb; max = limbs split at the elbow and knee too. */
export type GibGore = 'some' | 'lots' | 'max';
export const GIB_GORES: readonly GibGore[] = ['some', 'lots', 'max'];
export const isGibGore = (s: unknown): s is GibGore => typeof s === 'string' && (GIB_GORES as readonly string[]).includes(s);

/**
 * Piece slots. Slot 0 is whatever is left of the trunk; every other slot is cut off at a rig
 * part (render/chars/gibs.ts GIB_CUTS: a humanoid's head, upper arm, thigh, forearm, shin; a
 * dog's head and legs). The simulation only knows where each slot sits on a body.
 */
export const GIB_SLOTS = ['torso', 'head', 'armR', 'armL', 'legR', 'legL', 'fArmR', 'fArmL', 'shinR', 'shinL'] as const;
export type GibSlot = (typeof GIB_SLOTS)[number];
export const GIB_GORE_SLOTS: Record<GibGore, readonly GibSlot[]> = {
  some: ['torso', 'head', 'armR', 'legL'],
  lots: ['torso', 'head', 'armR', 'armL', 'legR', 'legL'],
  max: GIB_SLOTS,
};

/** Every tunable of the pieces' flights in one place (m, s, m/s, rad/s). */
export const GIBS = {
  /** where a slot leaves from: underside height as a share of standing height, and sideways (m at 1.75 m tall, + = the body's right) */
  at: {
    torso: [0.42, 0], head: [0.84, 0], armR: [0.55, 0.22], armL: [0.55, -0.22], legR: [0.08, 0.1], legL: [0.08, -0.1],
    fArmR: [0.4, 0.26], fArmL: [0.4, -0.26], shinR: [0.03, 0.1], shinL: [0.03, -0.1],
  } as Record<GibSlot, [number, number]>,
  /** standing height by size class (m); the share above is of this */
  height: { tiny: 0.4, small: 0.75, medium: 1.75, large: 2.3, huge: 3.2 } as Record<CreatureSize, number>,
  /**
   * vehicle hits: each piece's throw is the whole body's launch (runoverFling.ts) times a spread.
   * Never much faster than the body: at speed the car runs under the body (carried at 0.7x), and
   * a piece kept at the car's own speed rides on (and sinks into) its roof.
   */
  carrySpread: [0.55, 1.0] as [number, number],
  /** ...plus a sideways throw (share of the impact speed; limbs fly out to their own side) */
  sideSpread: 0.17,
  /** ...and its own up-kick (x the body's) */
  upSpread: [1.0, 1.45] as [number, number],
  /** light bits fly further (x on the spreads above) */
  light: { torso: 0.6, head: 1.25 } as Partial<Record<GibSlot, number>>,
  /** other kills (a gun, a blade, a blast): speed along the blow from the overkill share, clamped */
  hitSpeed: [2.5, 9] as [number, number],
  hitPerOverkill: 1.6,
  hitUp: [1.5, 4.5] as [number, number],
  /** ...in a fan this wide about the blow (rad, either side) */
  hitFan: 1.1,
  /** tumbling spin of a piece (rad/s, each axis) */
  spin: [6, 18] as [number, number],
  /** pieces are smaller than a body: they come closer to walls, bounce livelier and fit under a higher ceiling */
  tuning: { radius: 0.14, bounce: 0.42, bounceMin: 1.2, bounceKeep: 0.75, slideDecel: 9, ceiling: 2.1 } as Partial<RunoverTuning>,
  /** blood left on the ground where each piece first lands and where it stops (field intensity) */
  blood: 1,
};

export interface GibPiece {
  slot: GibSlot;
  plan: FlingPlan;
}

export interface GibBurst {
  /** where the body was hit (tiles) */
  x: number;
  y: number;
  z: number;
  /** the body's facing when it came apart (Monster.facing) */
  facing: number;
  /** 0..1 per body: the renderer's per-piece jitter */
  seed: number;
  pieces: GibPiece[];
  /** a vehicle's throw (the body's launch spread out), or any other killing blow */
  cause: 'vehicle' | 'blow';
}

export interface GibSource {
  x: number;
  y: number;
  z: number;
  facing: number;
  size: CreatureSize;
  /** a vehicle's launch of the whole body (runoverFling.ts) */
  launch?: Launch;
  /** otherwise: the unit direction of the killing blow (null = none known: a blast, a fall), and overkill / max hp */
  dir?: [number, number] | null;
  overkill?: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** The flights of a gibbed body's pieces, one per slot of the gore level (deterministic with `rng`). */
export function planGibs(src: GibSource, gore: GibGore, world: FlingWorld, rng: Rng): GibBurst {
  const K: RunoverTuning = { ...RUNOVER, ...GIBS.tuning };
  const H = GIBS.height[src.size];
  // the body's right (Monster.facing: 0 north, clockwise; y is south)
  const fx = Math.sin(src.facing), fy = -Math.cos(src.facing);
  const rx = -fy, ry = fx;
  const pieces: GibPiece[] = [];
  const blow = src.launch ? null : src.dir ?? null;
  const blowA = blow ? Math.atan2(blow[1], blow[0]) : rng.next() * Math.PI * 2;
  const hitS = clamp(GIBS.hitSpeed[0] + GIBS.hitPerOverkill * (src.overkill ?? 0), GIBS.hitSpeed[0], GIBS.hitSpeed[1]);
  for (const slot of GIB_GORE_SLOTS[gore]) {
    const [hk, side] = GIBS.at[slot];
    const lat = side * (H / 1.75);
    const x = src.x + rx * lat, y = src.y + ry * lat;
    const light = GIBS.light[slot] ?? 1;
    const sideSign = Math.sign(side) || (rng.next() < 0.5 ? -1 : 1);
    let vx: number, vy: number, vz: number, speed: number, dx: number, dy: number;
    const L = src.launch;
    if (L) {
      // around the whole body's throw: some pieces carried further, some dropped, limbs out to
      // their own side, all with their own kick up (over the roof at speed)
      const carry = lerp(GIBS.carrySpread[0], GIBS.carrySpread[1], rng.next()) * (1 + (light - 1) * 0.5);
      const sideV = (sideSign * (0.4 + rng.next() * 0.6) * GIBS.sideSpread * light + (rng.next() - 0.5) * 0.1) * L.speed;
      const lx = -L.dy, ly = L.dx;
      vx = L.vx * carry + lx * sideV;
      vy = L.vy * carry + ly * sideV;
      // (the heavy torso still clears the roof: lightness only ever adds height)
      vz = Math.max(0.5, L.vz * lerp(GIBS.upSpread[0], GIBS.upSpread[1], rng.next()) * Math.sqrt(Math.max(1, light)));
      speed = L.speed;
      dx = L.dx;
      dy = L.dy;
    } else {
      const a = blowA + (rng.next() - 0.5) * 2 * (blow ? GIBS.hitFan : Math.PI);
      const s = hitS * lerp(0.6, 1.2, rng.next()) * light;
      vx = Math.cos(a) * s;
      vy = Math.sin(a) * s;
      vz = lerp(GIBS.hitUp[0], GIBS.hitUp[1], rng.next()) * Math.sqrt(light);
      speed = s;
      dx = Math.cos(a);
      dy = Math.sin(a);
    }
    const spin = () => (rng.next() < 0.5 ? -1 : 1) * lerp(GIBS.spin[0], GIBS.spin[1], rng.next()) * light;
    const launch: Launch = { vx, vy, vz, pitch: spin(), yaw: spin() * 0.6, roll: spin() * 0.8, dx, dy, speed };
    // never null: pieces don't need a free tile to lie on (no `free` in the world)
    const plan = planFling(x, y, launch, { blocked: world.blocked, roofed: world.roofed }, rng.next(), K, hk * H);
    if (!plan) throw new Error(`planGibs: ${slot} found nowhere to land`);
    pieces.push({ slot, plan });
  }
  return { x: src.x, y: src.y, z: src.z, facing: src.facing, seed: rng.next(), pieces, cause: src.launch ? 'vehicle' : 'blow' };
}

/** Where a piece left blood: its first touch of the ground and where it stopped (tiles). */
export function gibStains(p: FlingPlan): { t: number; x: number; y: number }[] {
  const first = p.contacts.find((c) => c.kind === 'ground');
  const out = first ? [{ t: first.t, x: first.x, y: first.y }] : [];
  const n = p.xs.length - 1;
  out.push({ t: p.duration, x: p.xs[n], y: p.ys[n] });
  return out;
}

/** The map as a flight sees it (walls, blocking furniture, no floor to land on, roofs): the same rules as a vehicle's throw. */
export interface FlingMap {
  terAt(x: number, y: number, z: number): { move_cost: number };
  furnAt(x: number, y: number, z: number): { move_cost_mod: number };
  hasFloor(x: number, y: number, z: number): boolean;
}
export function mapFlingWorld(map: FlingMap, z: number): FlingWorld {
  return {
    blocked: (tx, ty) => map.terAt(tx, ty, z).move_cost <= 0 || map.furnAt(tx, ty, z).move_cost_mod < 0 || !map.hasFloor(tx, ty, z),
    roofed: (tx, ty) => map.hasFloor(tx, ty, z + 1),
  };
}

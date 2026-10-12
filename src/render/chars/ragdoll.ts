import * as THREE from 'three';
import { charSettings } from './index';
import type { CharInstance, CharLayer, Skin } from './charLayer';
import { newPoseOut, quirk, type PoseIn, type PoseOut, type Rig } from './rig';
import { sampleFling, type FlingPlan } from '../../game/runoverFling';

// The run-over rag doll (docs/CHARACTERS.md "Run-over rag doll"). The simulation owns where the
// body is (game/runoverFling.ts: the flight, bounces, walls, the spot it comes to rest); this
// adds what you see on top: the whole body tumbling (a rigid somersault and spin from the hit,
// knocked about by every bounce, toppling flat when it skids), limbs flailing on stiff damped
// springs around the corpse's spread pose, and at the end a blend into exactly the pose the
// lying body has (FallingBody for a corpse, the downed CreatureModel for a survivor), so the
// hand-over doesn't pop. Not a physics engine: one rigid tumble + spring offsets per limb.

/** Feel of the limbs and the tumble. 'stiff' is the default; 'loose' the floppier variant. */
export const RAGDOLL = {
  stiff: {
    /** joint spring (1/s²) and damping ratio: stiff and well damped, the body keeps its shape */
    k: 240,
    zeta: 0.55,
    /** limb kick on the hit and on bounces (rad/s at full weight, per unit of impact) */
    kick: 9,
    bounceKick: 6,
    /** airborne flailing: amplitude (rad) and rate (Hz) the limbs are driven at */
    flail: 0.22,
    flailHz: 2.2,
    /** furthest a limb strays from the pose (rad) */
    max: 0.85,
    /** spin kept through a ground bounce, and how fast spin dies while skidding (1/s) */
    bounceSpin: 0.35,
    groundSpin: 6,
    /** rate (1/s) at which a body on the ground flops toward lying flat */
    flop: 9,
  },
  loose: {
    k: 70,
    zeta: 0.25,
    kick: 15,
    bounceKick: 11,
    flail: 0.55,
    flailHz: 1.6,
    max: 1.7,
    bounceSpin: 0.5,
    groundSpin: 4,
    flop: 6,
  },
  /** seconds of blending into the lying pose at the end of the flight */
  settle: 0.4,
  /** candidate lying headings tried when choosing the nearest (16 = every 22.5°) */
  headings: 16,
};
export type RagdollFeel = typeof RAGDOLL.stiff;

/** How much each named part flails (0 = it moves with the trunk). */
function limbWeight(name: string): number {
  if (/^(uArm|thigh|leg|tail|wing|ant[LR]|antenna|whip|tendril|fang)/.test(name)) return 1;
  if (/^(fArm|shin)/.test(name)) return 0.7;
  if (/^(head|neck|jaw)$/.test(name)) return 0.45;
  if (/^(hand|foot)/.test(name)) return 0.35;
  return 0;
}

const UP = new THREE.Vector3(0, 1, 0);
const tq = new THREE.Quaternion();
const tq2 = new THREE.Quaternion();
/** lieQuat's own scratch (its callers pass tq / tq2 as `out`) */
const tqYaw = new THREE.Quaternion();
const tv = new THREE.Vector3();
const tv2 = new THREE.Vector3();

/**
 * The lying orientation (world rotation) for a body facing `facing` (Monster.facing: 0 north,
 * clockwise), exactly as charLayer builds it from fall/fallDx/fallDy/yaw. `side` is the way an
 * animal rolls: FallingBody picks it by seed, a downed live creature always rolls +1.
 */
export function lieQuat(rig: Rig, facing: number, side: 1 | -1, out = new THREE.Quaternion()): THREE.Quaternion {
  const ang = rig.lie.side ? facing + side * Math.PI / 2 : facing + Math.PI;
  const fdx = Math.sin(ang), fdy = -Math.cos(ang);
  out.setFromAxisAngle(tv2.set(fdy, 0, -fdx).normalize(), rig.lie.angle);
  return out.multiply(tqYaw.setFromAxisAngle(UP, -facing));
}

/** The facing whose lying orientation is nearest to q (the body settles the short way round). */
export function nearestLie(rig: Rig, q: THREE.Quaternion, side: 1 | -1, n = RAGDOLL.headings): number {
  let best = 0, bd = -1;
  for (let i = 0; i < n; i++) {
    const f = (i / n) * Math.PI * 2;
    const d = Math.abs(q.dot(lieQuat(rig, f, side, tq)));
    if (d > bd) (bd = d), (best = f);
  }
  return best;
}

export interface RagdollEvent {
  kind: 'land' | 'bounce' | 'wall';
  x: number;
  y: number;
  /** closing speed (m/s) */
  speed: number;
}

export interface RagdollOpts {
  feel: RagdollFeel;
  /** a survivor (lands in the downed pose, rolls the live way) rather than a corpse */
  live: boolean;
}

export class RagdollBody {
  readonly inst: CharInstance;
  t = 0;
  /** the facing it settles at (chosen when the settle starts; the corpse / monster takes it) */
  facing: number | null = null;
  done = false;
  private readonly q = new THREE.Quaternion();
  private readonly w = new THREE.Vector3();
  private readonly target = new THREE.Quaternion();
  private readonly flight: PoseOut;
  private readonly final: PoseOut;
  private readonly weights: number[];
  private readonly off: Float32Array;
  private readonly vel: Float32Array;
  private readonly shown: Float32Array;
  private readonly corners: THREE.Vector3[] = [];
  private readonly side: 1 | -1;
  private nextContact = 0;
  private landed = false;
  private poseStep = -1;
  private readonly settleAt: number;

  constructor(layer: CharLayer, readonly rig: Rig, skin: Skin, readonly seed: number, readonly plan: FlingPlan, readonly z: number, facing: number, readonly opts: RagdollOpts) {
    this.inst = layer.add(rig, skin);
    const n = rig.parts.length;
    this.side = opts.live ? 1 : seed < 0.5 ? 1 : -1;
    // the flight pose is the corpse's spread-eagle; the end pose is what takes over afterwards
    const pin: PoseIn = { t: seed * 3, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 1, flinch: 0, dead: true, seed };
    this.flight = newPoseOut(n);
    rig.pose(pin, this.flight);
    this.final = newPoseOut(n);
    rig.pose(opts.live ? { ...pin, dead: false } : pin, this.final);
    this.weights = rig.parts.map((p) => limbWeight(p.name));
    this.off = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.shown = new Float32Array(n * 3);
    this.measure();
    // starts upright, facing where it stood
    this.q.setFromAxisAngle(UP, -facing);
    const L = plan.launch;
    // somersault: legs swept forward by the bumper, the top goes back over it (axis = travel × up)
    this.w.set(-L.dy, 0, L.dx).multiplyScalar(L.pitch);
    this.w.y += -L.yaw;
    this.w.addScaledVector(tv.set(L.dx, 0, L.dy), L.roll);
    this.kick(opts.feel.kick * Math.min(1.5, L.speed / 10), 0);
    this.settleAt = Math.max(plan.landT, plan.duration - RAGDOLL.settle);
    this.inst.z = z;
    this.apply(0);
  }

  /** Lowest box corner below the centre (m, ≤ 0) with the body turned by q. */
  private low(q: THREE.Quaternion): number {
    let low = Infinity;
    for (const v of this.corners) low = Math.min(low, tv.copy(v).applyQuaternion(q).y);
    return low;
  }

  /** Every box corner of the posed body about its centre (model space), for keeping it on the floor. */
  private measure(): void {
    const c = this.inst;
    this.writePose(0);
    c.x = c.y = c.z = c.lift = c.fall = 0;
    c.yaw = 0;
    c.tumble = null;
    c.build(null);
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.rig.parts.length; i++) {
      m.fromArray(c.mats, i * 16);
      // hidden parts (scale 0: a crawler's missing legs, a stowed weapon) don't touch the floor
      if (Math.abs(m.determinant()) < 1e-12) continue;
      for (let k = 0; k < 8; k++) {
        tv.set(k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5).applyMatrix4(m);
        if (!Number.isFinite(tv.x)) continue;
        lo.min(tv);
        hi.max(tv);
        this.corners.push(tv.clone());
      }
    }
    c.tumbleCenter.copy(lo).add(hi).multiplyScalar(0.5);
    for (const v of this.corners) v.sub(c.tumbleCenter);
    c.tumble = new THREE.Quaternion();
  }

  /** Throw every limb (deterministic per body): rad/s at full weight. */
  private kick(amount: number, salt: number): void {
    for (let i = 0; i < this.weights.length; i++) {
      const wgt = this.weights[i];
      if (!wgt) continue;
      for (let a = 0; a < 3; a++) this.vel[i * 3 + a] += (quirk(this.seed, 40 + salt * 97 + i * 3 + a) * 2 - 1) * amount * wgt * (a === 1 ? 0.4 : 1);
    }
  }

  /** Advance by dt; returns the impacts that happened (sound, dust, blood). */
  update(dt: number): RagdollEvent[] {
    const ev: RagdollEvent[] = [];
    if (this.done) return ev;
    const F = this.opts.feel;
    this.t += dt;
    const p = this.plan;
    while (this.nextContact < p.contacts.length && p.contacts[this.nextContact].t <= this.t) {
      const c = p.contacts[this.nextContact++];
      const first = c.kind === 'ground' && !this.landed;
      if (first) this.landed = true;
      ev.push({ kind: first ? 'land' : c.kind === 'wall' ? 'wall' : 'bounce', x: c.x, y: c.y, speed: c.speed });
      const s = Math.min(1.5, c.speed / 5);
      if (c.kind === 'ground') {
        this.w.multiplyScalar(F.bounceSpin);
        // a hard landing knocks it over some more, about a seeded horizontal axis
        const a = quirk(this.seed, 300 + this.nextContact) * Math.PI * 2;
        this.w.addScaledVector(tv.set(Math.cos(a), 0, Math.sin(a)), s * 1.5);
      } else {
        // off a wall: the spin about the vertical reverses and it's knocked over
        this.w.y = -this.w.y * 0.6;
        this.w.x += (quirk(this.seed, 400 + this.nextContact) - 0.5) * 4 * s;
      }
      this.kick(F.bounceKick * s, this.nextContact);
    }
    const here = sampleFling(p, this.t);
    const grounded = this.t >= p.landT && here.h <= 1e-4;
    // tumble
    const wl = this.w.length();
    if (wl > 1e-5) {
      tq.setFromAxisAngle(tv.copy(this.w).divideScalar(wl), wl * dt);
      this.q.premultiply(tq).normalize();
    }
    if (grounded) {
      this.w.multiplyScalar(Math.exp(-F.groundSpin * dt));
      // skidding along the ground it flops flat (onto whichever lying side is nearest)
      lieQuat(this.rig, nearestLie(this.rig, this.q, this.side), this.side, tq2);
      this.q.slerp(tq2, 1 - Math.exp(-F.flop * dt));
    }
    if (this.t >= this.settleAt && this.facing === null) {
      this.facing = nearestLie(this.rig, this.q, this.side);
      lieQuat(this.rig, this.facing, this.side, this.target);
    }
    this.springs(dt, !grounded);
    this.apply(this.t);
    if (this.t >= p.duration + 1e-9 && this.facing !== null) this.done = true;
    return ev;
  }

  private springs(dt: number, air: boolean): void {
    const F = this.opts.feel;
    const k = F.k, c = 2 * F.zeta * Math.sqrt(k);
    const steps = Math.max(1, Math.ceil(dt * Math.sqrt(k) / 0.35));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      const tt = this.t - dt + h * (s + 1);
      for (let i = 0; i < this.weights.length; i++) {
        const wgt = this.weights[i];
        if (!wgt) continue;
        for (let a = 0; a < 3; a++) {
          const j = i * 3 + a;
          // airborne, the limbs windmill a little about the pose (each its own phase)
          const goal = air ? F.flail * wgt * Math.sin(tt * F.flailHz * Math.PI * 2 + quirk(this.seed, 500 + j) * 6.283) * (a === 1 ? 0.3 : 1) : 0;
          this.vel[j] += (-k * (this.off[j] - goal) - c * this.vel[j]) * h;
          this.off[j] = Math.max(-F.max * wgt, Math.min(F.max * wgt, this.off[j] + this.vel[j] * h));
        }
      }
    }
  }

  /** Blend share of the lying end: 0 in flight .. 1 at rest. */
  private settleK(t: number): number {
    if (this.facing === null) return 0;
    const span = Math.max(1e-3, this.plan.duration - this.settleAt);
    const x = Math.min(1, Math.max(0, (t - this.settleAt) / span));
    return x * x * (3 - 2 * x);
  }

  private writePose(k: number): void {
    const o = this.inst.pose, A = this.flight, B = this.final;
    // limbs move at the characters' stepped pose rate (Shadowglass), the trunk smoothly
    const f = charSettings.fps;
    const stepI = f > 0 ? Math.floor(this.t * f) : -2;
    if (stepI !== this.poseStep || k >= 1) {
      this.poseStep = stepI;
      this.shown.set(this.off);
    }
    for (let j = 0; j < o.rot.length; j++) {
      o.rot[j] = A.rot[j] + (B.rot[j] - A.rot[j]) * k + this.shown[j] * (1 - k);
      o.scl[j] = A.scl[j] + (B.scl[j] - A.scl[j]) * k;
    }
    for (let a = 0; a < 3; a++) {
      o.pos[a] = A.pos[a] + (B.pos[a] - A.pos[a]) * k;
      o.lean[a] = A.lean[a] + (B.lean[a] - A.lean[a]) * k;
    }
  }

  private apply(t: number): void {
    const c = this.inst;
    const p = this.plan;
    const k = this.settleK(t);
    const s = sampleFling(p, t);
    this.writePose(k);
    const q = c.tumble!.copy(this.q);
    if (k > 0) q.slerp(this.target, k);
    // centre height that keeps the lowest corner on the floor
    const ground = s.h - this.low(q);
    let x = s.x, y = s.y, lift = ground;
    if (k > 0) {
      // the lying body's centre: its feet on the end of the flight (where the corpse item is)
      const [ex, ey] = [p.xs[p.xs.length - 1], p.ys[p.ys.length - 1]];
      tv.copy(c.tumbleCenter).applyQuaternion(this.target);
      x += (ex + tv.x - x) * k;
      y += (ey + tv.z - y) * k;
      const lieLift = this.rig.lie.lift + tv.y;
      lift += (lieLift - lift) * k;
      // never through the floor on the way: no deeper than the lying pose itself sinks (corpses
      // lie with a hand or a rag a little into the ground, docs/CHARACTERS.md)
      lift = Math.max(lift, ground + (lieLift + this.low(this.target)) * k);
    }
    c.x = x;
    c.y = y;
    c.lift = lift;
    c.dirty = true;
  }

  remove(): void {
    this.inst.remove();
  }
}

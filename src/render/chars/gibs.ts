import * as THREE from 'three';
import { charSettings } from './index';
import type { CharInstance, CharLayer, Skin } from './charLayer';
import { newPoseOut, quirk, type PoseIn, type PoseOut, type Rig } from './rig';
import { limbWeight, springLimbs, type RagdollEvent, type RagdollFeel } from './ragdoll';
import { sampleFling, type FlingPlan } from '../../game/runoverFling';
import { LEVEL_HEIGHT } from '../../world/coords';
import type { GibSlot } from '../../game/gibs';

// The pieces of a gibbed body (docs/CHARACTERS.md "Gibbed bodies"). The simulation plans each
// piece's flight (game/gibs.ts); a piece here is the creature's own rig drawn with only that
// piece's parts (CharInstance.hidden), so it keeps the body's skin, its spread corpse pose and
// whatever it wore or held, for every rig and zombie style. On top of the planned path it
// tumbles (a rigid spin knocked about by bounces), its remaining joints flop on the rag doll's
// springs (a leg's shin, a torso's arms), it flops onto its long side when it touches the
// ground, and it bleeds a little while it flies. Pieces lie where they stop for a while, then
// sink into the ground and dissolve; too many, and the oldest go first.

/** Where a slot is cut off a rig (the first part matching; its descendants go with it). */
export const GIB_CUTS: Record<Exclude<GibSlot, 'torso'>, RegExp> = {
  head: /^head$/,
  armR: /^(uArmR|legFR|wingR)$/,
  armL: /^(uArmL|legFL|wingL)$/,
  legR: /^(thighR|legBR|legR)$/,
  legL: /^(thighL|legBL|legL)$/,
  fArmR: /^fArmR$/,
  fArmL: /^fArmL$/,
  shinR: /^shinR$/,
  shinL: /^shinL$/,
};

/** Lifetime and budget of the pieces (s, counts). */
export const GIB_VIEW = {
  /** seconds a piece lies before it sinks away */
  life: 120,
  /** seconds it takes to sink and dissolve */
  sink: 2.5,
  /** most pieces at once; past it the oldest sink early (quickly) */
  cap: 72,
  capSink: 0.6,
  /** gone at once beyond this distance from the survivor (m): the area is being left */
  far: 110,
  /** blood drips while it flies: for this long after the hit, every this often (s) */
  trail: 0.9,
  trailEvery: 0.05,
  /** after the flight: seconds more of flopping flat before it freezes */
  settle: 0.5,
};

/**
 * Which piece each rig part belongs to for the given slots (parts are listed parent first): a
 * part matching a slot's cut starts that piece, everything else goes with its parent, and the
 * root with the torso. Returns per slot the parts it does NOT show (CharInstance.hidden) and
 * its cut part; slots the rig has no part for are left out (their part stays on the torso).
 */
export function gibPieces(rig: Rig, slots: readonly GibSlot[]): Map<GibSlot, { hidden: Uint8Array; root: number }> {
  const n = rig.parts.length;
  const owner: GibSlot[] = new Array(n);
  const root = new Map<GibSlot, number>([['torso', 0]]);
  for (let i = 0; i < n; i++) {
    const p = rig.parts[i];
    const cut = slots.find((s) => s !== 'torso' && GIB_CUTS[s].test(p.name) && !root.has(s));
    if (cut) {
      owner[i] = cut;
      root.set(cut, i);
    } else owner[i] = p.parent < 0 || p.parent >= i ? 'torso' : owner[p.parent];
  }
  const out = new Map<GibSlot, { hidden: Uint8Array; root: number }>();
  for (const s of slots) {
    if (!root.has(s)) continue;
    const hidden = new Uint8Array(n);
    for (let i = 0; i < n; i++) hidden[i] = owner[i] === s ? 0 : 1;
    out.set(s, { hidden, root: root.get(s)! });
  }
  return out;
}

export type GibEvent = RagdollEvent | { kind: 'drip'; x: number; y: number; h: number };

const UP = new THREE.Vector3(0, 1, 0);
const tq = new THREE.Quaternion();
const tv = new THREE.Vector3();
const tv2 = new THREE.Vector3();
const tm = new THREE.Matrix4();
const CUBE = [...Array(8)].map((_, k) => new THREE.Vector3(k & 1 ? 0.5 : -0.5, k & 2 ? 0.5 : -0.5, k & 4 ? 0.5 : -0.5));

export class GibBody {
  readonly inst: CharInstance;
  t = 0;
  /** flight over and settled: the instance no longer changes (until it sinks) */
  done = false;
  /** seconds since it came to rest */
  age = 0;
  /** sinking away: seconds in, and over how long (null = lying) */
  sinkT: number | null = null;
  sinkDur = GIB_VIEW.sink;
  gone = false;
  private readonly q = new THREE.Quaternion();
  private readonly w = new THREE.Vector3();
  private readonly pose: PoseOut;
  private readonly weights: number[];
  private readonly off: Float32Array;
  private readonly vel: Float32Array;
  private readonly corners: THREE.Vector3[] = [];
  /** the piece's longest extent (model axis) and its size along it (m) */
  private readonly long = new THREE.Vector3();
  readonly size: number;
  private nextContact = 0;
  private landed = false;
  private poseStep = -1;
  private nextDrip = 0;
  private restLift = 0;

  constructor(layer: CharLayer, readonly rig: Rig, skin: Skin, readonly seed: number, readonly plan: FlingPlan, readonly z: number, facing: number, hidden: Uint8Array, root: number, readonly feel: RagdollFeel) {
    this.inst = layer.add(rig, skin);
    this.inst.hidden = hidden;
    const n = rig.parts.length;
    const pin: PoseIn = { t: seed * 3, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 1, flinch: 0, dead: true, seed };
    this.pose = newPoseOut(n);
    rig.pose(pin, this.pose);
    // the cut part itself turns with the tumble; only joints further down flop
    this.weights = rig.parts.map((p, i) => (hidden[i] || i === root ? 0 : limbWeight(p.name)));
    this.off = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.size = this.measure(hidden);
    if (!this.corners.length) throw new Error(`GibBody: a piece with no visible part (root ${rig.parts[root]?.name})`);
    // it leaves the body upright, the way it stood
    this.q.setFromAxisAngle(UP, -facing);
    const L = plan.launch;
    this.w.set(-L.dy, 0, L.dx).multiplyScalar(L.pitch);
    this.w.y += -L.yaw;
    this.w.addScaledVector(tv.set(L.dx, 0, L.dy), L.roll);
    this.kick(feel.kick * Math.min(1.5, L.speed / 8), 0);
    this.inst.z = z;
    this.apply();
  }

  /** Box corners of the shown parts about their centre; returns the longest extent (m). */
  private measure(hidden: Uint8Array): number {
    const c = this.inst;
    this.writePose();
    c.x = c.y = c.z = c.lift = c.fall = 0;
    c.yaw = 0;
    c.tumble = null;
    c.build(null);
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.rig.parts.length; i++) {
      if (hidden[i]) continue;
      m.fromArray(c.mats, i * 16);
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
    const ext = tv2.copy(hi).sub(lo);
    const big = Math.max(ext.x, ext.y, ext.z);
    this.long.set(ext.x === big ? 1 : 0, ext.x !== big && ext.y === big ? 1 : 0, ext.x !== big && ext.y !== big ? 1 : 0);
    return Number.isFinite(big) ? big : 0;
  }

  private kick(amount: number, salt: number): void {
    for (let i = 0; i < this.weights.length; i++) {
      const wgt = this.weights[i];
      if (!wgt) continue;
      for (let a = 0; a < 3; a++) this.vel[i * 3 + a] += (quirk(this.seed, 40 + salt * 97 + i * 3 + a) * 2 - 1) * amount * wgt * (a === 1 ? 0.4 : 1);
    }
  }

  /** Advance by dt; returns landings, bounces and blood drips. */
  update(dt: number): GibEvent[] {
    const ev: GibEvent[] = [];
    if (this.gone) return ev;
    if (this.done) {
      if (this.sinkT === null) this.age += dt;
      else this.sinkStep(dt);
      return ev;
    }
    const F = this.feel;
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
        const a = quirk(this.seed, 300 + this.nextContact) * Math.PI * 2;
        this.w.addScaledVector(tv.set(Math.cos(a), 0, Math.sin(a)), s * 3);
      } else {
        this.w.y = -this.w.y * 0.6;
        this.w.x += (quirk(this.seed, 400 + this.nextContact) - 0.5) * 6 * s;
      }
      this.kick(F.bounceKick * s, this.nextContact);
    }
    const here = sampleFling(p, this.t);
    const grounded = this.t >= p.landT && here.h <= 1e-4;
    const wl = this.w.length();
    if (wl > 1e-5) {
      tq.setFromAxisAngle(tv.copy(this.w).divideScalar(wl), wl * dt);
      this.q.premultiply(tq).normalize();
    }
    if (grounded) {
      this.w.multiplyScalar(Math.exp(-F.groundSpin * dt));
      this.flop(dt);
    } else if (this.t < GIB_VIEW.trail && this.t >= this.nextDrip) {
      this.nextDrip = this.t + GIB_VIEW.trailEvery;
      ev.push({ kind: 'drip', x: here.x, y: here.y, h: here.h + this.size * 0.3 });
    }
    springLimbs(F, this.weights, this.off, this.vel, this.seed, this.t, dt, !grounded);
    this.apply();
    if (this.t >= p.duration + GIB_VIEW.settle) {
      this.done = true;
      this.restLift = this.inst.lift;
    }
    return ev;
  }

  /** On the ground a piece rolls onto its long side (an arm lies along the ground, not on its end). */
  private flop(dt: number): void {
    const a = tv.copy(this.long).applyQuaternion(this.q);
    const ah = tv2.set(a.x, 0, a.z);
    if (ah.lengthSq() < 1e-6) {
      const ang = quirk(this.seed, 77) * Math.PI * 2;
      ah.set(Math.cos(ang), 0, Math.sin(ang));
    }
    ah.normalize();
    tq.setFromUnitVectors(a.normalize(), ah).multiply(this.q);
    this.q.slerp(tq, 1 - Math.exp(-this.feel.flop * dt));
  }

  private writePose(): void {
    const o = this.inst.pose, A = this.pose;
    const f = charSettings.fps;
    const stepI = f > 0 ? Math.floor(this.t * f) : -2;
    const step = stepI !== this.poseStep;
    this.poseStep = stepI;
    // limbs move at the characters' stepped pose rate (Shadowglass), the tumble smoothly
    if (step || this.t === 0) for (let j = 0; j < o.rot.length; j++) o.rot[j] = A.rot[j] + this.off[j];
    o.scl.set(A.scl);
    for (let a = 0; a < 3; a++) {
      o.pos[a] = A.pos[a];
      o.lean[a] = A.lean[a];
    }
  }

  private apply(): void {
    const c = this.inst;
    const s = sampleFling(this.plan, this.t);
    this.writePose();
    c.tumble!.copy(this.q);
    c.x = s.x;
    c.y = s.y;
    // the lowest corner on the floor (or the flight's height above it), measured on the posed
    // boxes: a loose shin or arm swings well past the rest pose's outline
    c.lift = 0;
    c.build(null);
    c.lift = s.h - (this.lowestBuilt() - c.z * LEVEL_HEIGHT);
    c.dirty = true;
  }

  /** Lowest corner of the shown boxes as last built (world m). */
  private lowestBuilt(): number {
    const c = this.inst, hid = c.hidden!;
    let lo = Infinity;
    for (let i = 0; i < this.rig.parts.length; i++) {
      if (hid[i]) continue;
      tm.fromArray(c.mats, i * 16);
      if (Math.abs(tm.determinant()) < 1e-12) continue;
      for (const v of CUBE) lo = Math.min(lo, tv.copy(v).applyMatrix4(tm).y);
    }
    return Number.isFinite(lo) ? lo : c.z * LEVEL_HEIGHT;
  }

  /** Start sinking away over `dur` seconds (no-op if already sinking faster). */
  sink(dur: number): void {
    if (this.sinkT !== null && this.sinkDur <= dur) return;
    if (!this.done) this.restLift = this.inst.lift;
    this.sinkT = 0;
    this.sinkDur = dur;
    this.done = true;
  }

  private sinkStep(dt: number): void {
    this.sinkT! += dt;
    const k = Math.min(1, this.sinkT! / this.sinkDur);
    const c = this.inst;
    c.lift = this.restLift - (this.size * 0.6 + 0.05) * k;
    c.fade = k;
    c.dirty = true;
    if (k >= 1) this.remove();
  }

  remove(): void {
    this.gone = true;
    this.inst.remove();
  }
}

/** Every piece in the world: ages them, sinks the old ones, keeps to the cap. */
export class GibSet {
  readonly pieces: GibBody[] = [];

  add(b: GibBody): void {
    this.pieces.push(b);
  }

  /** Advance every piece; `near(x, y)` false = it's out where the area is unloaded (drop it at once). */
  update(dt: number, near: (x: number, y: number, z: number) => boolean, each: (b: GibBody, ev: GibEvent[]) => void): void {
    for (const b of this.pieces) {
      if (b.gone) continue;
      if (!near(b.inst.x, b.inst.y, b.z)) {
        b.remove();
        continue;
      }
      if (b.done && b.sinkT === null && b.age >= GIB_VIEW.life) b.sink(GIB_VIEW.sink);
      each(b, b.update(dt));
    }
    for (let i = this.pieces.length - 1; i >= 0; i--) if (this.pieces[i].gone) this.pieces.splice(i, 1);
    // over the cap: the oldest lying ones go quickly (never a pop; flying ones finish first)
    let over = this.live - GIB_VIEW.cap;
    for (const b of this.pieces) {
      if (over <= 0) break;
      if (!b.done || b.sinkT !== null) continue;
      b.sink(GIB_VIEW.capSink);
      over--;
    }
  }

  clear(): void {
    for (const b of this.pieces) b.remove();
    this.pieces.length = 0;
  }

  /** Live pieces (lying or flying, not sinking). */
  get live(): number {
    let n = 0;
    for (const b of this.pieces) if (!b.gone && b.sinkT === null) n++;
    return n;
  }
}

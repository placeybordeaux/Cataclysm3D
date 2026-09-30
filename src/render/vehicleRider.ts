import * as THREE from 'three';
import type { V3 } from './geometry';
import type { CharInstance } from './chars/charLayer';
import { HUM, type PoseIn, type Rig } from './chars/rig';
import type { RideIn } from './chars/ridePose';

// The survivor drawn in the seat they occupy while driving outside first person (chase and
// top-down cameras): hips on the saddle / seat, hands on the grips or the steering wheel's rim,
// feet on the pedals / pegs / floor, all solved every frame in the vehicle's own frame (its
// lean pivot), so the body follows position, yaw and a bike's lean with no lag.
// The vehicle models say where those things are (RideAnchors, filled by vehicleBikes.ts,
// vehicleModel.ts and vehicleFrame.ts); VehicleRenderer.update places the rider last.

/** Where a rider's body goes on a vehicle, in its mount space (drawn x forward, y up incl. the level's base, z right). */
export interface RideAnchors {
  kind: 'bicycle' | 'motorcycle' | 'seat';
  /** The rig's hips joint. */
  hip: V3;
  /** Torso pitch (rad): + over the bars, - back against a seat. */
  lean: number;
  /** Hand centres, right then left (bikes: the grips; cars without a cockpit rig: a fixed rim). */
  grips: [V3, V3];
  /** Ankles, right then left (pegs, the floor under the pedals). */
  feet: [V3, V3];
  /** Bicycles: the crank the feet pedal round (centre, arm length, pedal distance from the centre line). */
  crank?: { c: V3; r: number; half: number };
}

/**
 * Crank turns per metre ridden: ~5 m a turn, a middle gear on a 700c wheel (a bike pedalled at
 * ~60 rpm does ~18 km/h).
 */
export const CRANK_M_PER_TURN = 5;
/** Pedal ball to ankle: the ankle sits behind and above the pedal spindle (m). */
const PEDAL_TO_ANKLE: [number, number] = [-0.08, 0.075];

const tmpM = new THREE.Matrix4();
const tmpR = new THREE.Matrix4().makeRotationY(-Math.PI / 2);

/**
 * Generic anchors for a seat when the model didn't provide any (the parts look, odd grids):
 * sitting upright on the tile, hands forward, feet on the floor.
 */
export function genericAnchors(mx: number, my: number, base: number): RideAnchors {
  const hy = base + 0.62;
  return {
    kind: 'seat', hip: [mx - 0.1, hy, my], lean: 0,
    grips: [[mx + 0.3, hy + 0.3, my + 0.18], [mx + 0.3, hy + 0.3, my - 0.18]],
    feet: [[mx + 0.45, base + 0.12, my + 0.12], [mx + 0.45, base + 0.12, my - 0.12]],
  };
}

/**
 * Hand centres at ten-to-two on a steering wheel rim tilted `tilt` back toward the driver
 * (the steeringWheel / Cockpit rim: u up the rim's plane, w across the car), right then left.
 * Same angle as the cockpit's own grips (vehicleCockpit.ts), just inside the rim.
 */
export function rimGrips(x: number, y: number, z: number, r: number, tilt: number): [V3, V3] {
  const at = (s: number): V3 => {
    const ang = (s * Math.PI) / 3.4, u = Math.cos(ang) * r * 0.92, w = Math.sin(ang) * r * 0.92;
    return [x - u * Math.sin(tilt), y + u * Math.cos(tilt), z + w];
  };
  return [at(1), at(-1)];
}

/** Where a pedal is at crank angle `a` (rad; the same angle the crank mesh is turned about +z). */
export function pedalAt(c: NonNullable<RideAnchors['crank']>, a: number, side: 1 | -1): V3 {
  const t = side > 0 ? a : a + Math.PI;
  return [c.c[0] + Math.cos(t) * c.r, c.c[1] + Math.sin(t) * c.r, c.c[2] + side * c.half];
}

export class Rider {
  private readonly ride: RideIn = { lean: 0, hands: [[0, 0, 0], [0, 0, 0]], feet: [[0, 0, 0], [0, 0, 0]] };
  private readonly pin: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.37, ride: this.ride };
  private readonly root = new THREE.Matrix4();
  /** Last placement, for check(): the vehicle frame and the mount-space targets. */
  private readonly frame = new THREE.Matrix4();
  private readonly targets: V3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  kind: RideAnchors['kind'] | null = null;
  placedAt = 0;

  constructor(readonly inst: CharInstance, readonly rig: Rig) {
    if (!rig.dims) throw new Error('Rider needs a humanoid rig (rig.dims)');
  }

  /**
   * Pose and place the body. `frame`: mount space -> world (the vehicle's lean pivot, already
   * updated this frame). `grips`: the hands' targets this frame (a cockpit wheel turning with
   * the steering) or null for the anchors' fixed ones. `pedal`: the crank angle shown.
   */
  place(a: RideAnchors, frame: THREE.Matrix4, grips: [V3, V3] | null, pedal: number, t: number, world: { x: number; y: number; z: number }): void {
    const dm = this.rig.dims!;
    const r = this.ride;
    r.lean = a.lean;
    // mount point -> the rig's model space: hips joint at `hip`, facing +x (mount forward)
    const toModel = (p: V3, out: V3) => {
      out[0] = p[2] - a.hip[2];
      out[1] = p[1] - a.hip[1] + dm.hipY;
      out[2] = -(p[0] - a.hip[0]);
    };
    const g = grips ?? a.grips;
    const T = this.targets;
    T[0] = [...g[0]];
    T[1] = [...g[1]];
    if (a.crank) {
      for (const [i, side] of [[2, 1], [3, -1]] as const) {
        const q = pedalAt(a.crank, pedal, side);
        q[0] += PEDAL_TO_ANKLE[0];
        q[1] += PEDAL_TO_ANKLE[1];
        T[i] = q;
      }
    } else {
      T[2] = [...a.feet[0]];
      T[3] = [...a.feet[1]];
    }
    toModel(T[0], r.hands[0]);
    toModel(T[1], r.hands[1]);
    toModel(T[2], r.feet[0]);
    toModel(T[3], r.feet[1]);
    this.frame.copy(frame);
    this.kind = a.kind;
    this.placedAt = performance.now();
    this.pin.t = t;
    this.inst.setPose(this.pin);
    // root: frame · T(hip) · turn to face mount +x · drop to the feet origin
    this.root.copy(frame).multiply(tmpM.makeTranslation(a.hip[0], a.hip[1], a.hip[2])).multiply(tmpR).multiply(tmpM.makeTranslation(0, -dm.hipY, 0));
    this.inst.rootOverride = this.root;
    this.inst.x = world.x;
    this.inst.y = world.y;
    this.inst.z = world.z;
    this.inst.far = 0;
    this.inst.setVisible(true);
    this.inst.dirty = true;
  }

  /**
   * For tools/tests: how far the built body's hand centres and ankles are from the grips and
   * pedals / pegs they reach for (m, world), and whether it's drawn.
   */
  check(): { kind: string | null; visible: boolean; alive: boolean; handErr: number; footErr: number; hip: V3 } {
    const i = this.inst;
    i.build(null);
    const m = new THREE.Matrix4();
    const at = (part: number, y: number) => new THREE.Vector3(0, y, 0).applyMatrix4(m.fromArray(i.mats, part * 16));
    const want = this.targets.map((t) => new THREE.Vector3(...t).applyMatrix4(this.frame));
    const got = [at(HUM.handR, 0), at(HUM.handL, 0), at(HUM.shinR, -0.5), at(HUM.shinL, -0.5)];
    const d = got.map((g, k) => g.distanceTo(want[k]));
    const hip = at(HUM.hips, 0);
    return { kind: this.kind, visible: i.visible, alive: i.alive, handErr: Math.max(d[0], d[1]), footErr: Math.max(d[2], d[3]), hip: [hip.x, hip.y, hip.z] };
  }

  /** Back on foot: hand the instance back to its normal placement. */
  release(): void {
    this.inst.rootOverride = null;
    this.inst.dirty = true;
  }
}

/**
 * Who sits in the driven vehicle's seat, per renderer: the player model (chars/playerModel.ts)
 * sets `rider` while you drive outside first person, VehicleRenderer places it each frame.
 */
const slots = new WeakMap<object, { rider: Rider | null }>();
export function riderSlot(renderer: object): { rider: Rider | null } {
  let s = slots.get(renderer);
  if (!s) slots.set(renderer, (s = { rider: null }));
  return s;
}

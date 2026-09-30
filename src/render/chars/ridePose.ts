// Seated / riding pose for the humanoid rig (rig.ts): the hips sit on a saddle or seat, the
// hands reach handlebar grips or a steering wheel's rim and the feet reach pedals, pegs or the
// floor, by two-bone IK per limb. Pure (no three.js) for tests. The targets are in the rig's
// model space (feet origin, +y up, facing -z, right hand +x); vehicleRider.ts converts the
// vehicle's anchors (mount space) into it every frame.

export type V3 = [number, number, number];

export interface RideIn {
  /** Torso pitch (rad): + leans forward over the bars, - reclines against a seat back. */
  lean: number;
  /** Hand-centre targets, right then left (model space). */
  hands: [V3, V3];
  /** Ankle targets, right then left (model space). */
  feet: [V3, V3];
}

/** The humanoid's joint layout (scaled metres), as humanoid() in rig.ts builds it. */
export interface HumanDims {
  /** hips joint height above the feet (model origin) */
  hipY: number;
  /** thigh joints: ±hipX, hipY + thighDy */
  hipX: number;
  thighDy: number;
  /** torso joint above the hips joint */
  torsoDy: number;
  /** shoulders in the torso frame: ±shoulderX, shoulderY */
  shoulderX: number;
  shoulderY: number;
  /** shoulder -> elbow, elbow -> hand centre, hip -> knee, knee -> ankle */
  upperArm: number;
  foreArm: number;
  thigh: number;
  shin: number;
}

/** (y, z) rotated about +x by a (right-hand rule, as the rig's Euler x). */
function rotX(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

export interface LimbAngles {
  /** root segment: sideways splay (Euler z) and swing (Euler x, + = forward) */
  z: number;
  x: number;
  /** second segment's swing relative to the first (Euler x) */
  bend: number;
}

/**
 * Two-bone IK for a limb hanging along -y from its joint: `d` is the target relative to the
 * joint in the parent's frame. `knee` bends the middle joint backwards (a leg: the shin folds
 * back) instead of forwards (an arm: the forearm folds up). Out-of-reach targets straighten
 * the limb toward them rather than failing: a rider slightly off the saddle still reads.
 */
export function twoBone(d: V3, l1: number, l2: number, knee: boolean): LimbAngles {
  const D = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-3, Math.hypot(d[0], d[1], d[2])));
  // the middle joint's angle from the reach alone (law of cosines)
  const beta = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - D * D) / (2 * l1 * l2))));
  const bend = knee ? -(Math.PI - beta) : Math.PI - beta;
  // The chain in the first segment's frame before its own rotation: (0, Y, Z). Euler XYZ
  // applies z (splay) first, then x (swing): Rz moves part of Y sideways, Rx then turns what
  // is left in the y-z plane onto the target's direction.
  const Y = -(l1 + l2 * Math.cos(bend)), Z = -l2 * Math.sin(bend);
  const z = Math.asin(Math.max(-1, Math.min(1, d[0] / Math.max(1e-4, -Y))));
  let x = Math.atan2(d[2], d[1]) - Math.atan2(Z, Y * Math.cos(z));
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return { z, x, bend };
}

/** Humanoid part indices this pose writes (rig.ts HUM). */
export interface RideParts {
  torso: number; head: number; uArmR: number; fArmR: number; uArmL: number; fArmL: number;
  thighR: number; shinR: number; thighL: number; shinL: number; footR: number; footL: number;
}

/**
 * Write the riding pose as rotations to add to the rest pose (`rot` is PoseOut.rot: x, y, z
 * per part). Everything below the torso hangs off the (unrotated) hips.
 */
export function ridePose(r: RideIn, dm: HumanDims, H: RideParts, rot: Float32Array): void {
  const set = (i: number, x: number, z = 0) => {
    rot[i * 3] += x;
    rot[i * 3 + 2] += z;
  };
  // torso: Euler -x leans an upright torso forward
  set(H.torso, -r.lean);
  // keep the eyes on the road: the head tips back most of the lean
  set(H.head, r.lean * 0.75);
  const torsoJ: V3 = [0, dm.hipY + dm.torsoDy, 0];
  for (const [side, up, fore, target] of [[1, H.uArmR, H.fArmR, r.hands[0]], [-1, H.uArmL, H.fArmL, r.hands[1]]] as const) {
    const sh = rotX([side * dm.shoulderX, dm.shoulderY, 0], -r.lean);
    const shoulder: V3 = [torsoJ[0] + sh[0], torsoJ[1] + sh[1], torsoJ[2] + sh[2]];
    // into the torso's frame (undo its lean) for the arm, which hangs off it
    const d = rotX([target[0] - shoulder[0], target[1] - shoulder[1], target[2] - shoulder[2]], r.lean);
    const a = twoBone(d, dm.upperArm, dm.foreArm, false);
    set(up, a.x, a.z);
    set(fore, a.bend);
  }
  for (const [side, th, sn, ft, target] of [[1, H.thighR, H.shinR, H.footR, r.feet[0]], [-1, H.thighL, H.shinL, H.footL, r.feet[1]]] as const) {
    const hip: V3 = [side * dm.hipX, dm.hipY + dm.thighDy, 0];
    const a = twoBone([target[0] - hip[0], target[1] - hip[1], target[2] - hip[2]], dm.thigh, dm.shin, true);
    set(th, a.x, a.z);
    set(sn, a.bend);
    // sole flat on the pedal / floor
    set(ft, -(a.x + a.bend));
  }
}

/**
 * Forward kinematics for tests and the rider's sanity check: where the rig's hand centres and
 * ankles end up for a set of limb angles (same conventions as ridePose).
 */
export function limbEnd(joint: V3, parentLean: number, a: LimbAngles, l1: number, l2: number): V3 {
  // segment direction after Euler XYZ (Rx·Rz on -y), then the second segment bent about the
  // first segment's local x (Rx·Rz·Rx(bend) on -y)
  const dir1 = rotX([Math.sin(a.z), -Math.cos(a.z), 0], a.x);
  const cz = Math.cos(a.z), sz = Math.sin(a.z);
  const loc2 = rotX([0, -1, 0], a.bend);
  // Rz then Rx on loc2
  const rz: V3 = [loc2[0] * cz - loc2[1] * sz, loc2[0] * sz + loc2[1] * cz, loc2[2]];
  const dir2 = rotX(rz, a.x);
  const p: V3 = [dir1[0] * l1 + dir2[0] * l2, dir1[1] * l1 + dir2[1] * l2, dir1[2] * l1 + dir2[2] * l2];
  const w = rotX(p, -parentLean);
  return [joint[0] + w[0], joint[1] + w[1], joint[2] + w[2]];
}

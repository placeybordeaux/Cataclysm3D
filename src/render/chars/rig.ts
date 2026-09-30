// Rigid-part skeletons for the procedural characters, and their poses. Pure (no three.js),
// for tests. A rig is a list of boxes, parent first; each hangs off its parent's joint:
//
//   joint (m, parent joint frame) -> rotation (rest + pose, Euler XYZ, radians) -> the box,
//   `size` (w along x, h along y, d along z) centred at `center` in the joint frame.
//
// Model space: +y up, the creature faces -z, its right hand is +x (a viewer facing it sees
// that on their left, like the sprite). Rotations follow the right-hand rule: +x rotation
// swings a hanging limb forward, a -x rotation leans an upright torso forward.
//
// `src` says where on the UltiCa sprite the part's texture comes from (paint.ts): a rect in
// the sprite's opaque bounding box (0..1, v down) projected onto the part's front (people:
// sprites are drawn facing us) or right side (animals: drawn in profile, head to the right),
// or a flat palette role for thin bits (insect legs, wings).

import type { BodyShape } from './archetype';

export type Proj = 'front' | 'side';
export type Role = 'dark' | 'main' | 'light' | 'accent' | 'skin' | 'wing';

export interface PartSrc {
  rect?: [number, number, number, number];
  proj?: Proj;
  /** flat palette colour instead of a sprite crop */
  role?: Role;
  /** trim the crop to the columns that are mostly opaque (drop outstretched arms etc.) */
  core?: boolean;
  /** paint eyes on the front face (heads) */
  face?: boolean;
}

export interface PartDef {
  name: string;
  parent: number;
  joint: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
  rest?: [number, number, number];
  src: PartSrc;
  /** 'limb' parts get fattened for far readability; 'core' parts less */
  kind?: 'core' | 'limb' | 'thin';
}

export interface PoseIn {
  /** seconds, already stepped by the caller */
  t: number;
  /** walk cycle phase in strides (1 = one full left+right cycle), stepped */
  phase: number;
  /** 0 standing still .. 1 walking .. 2 running */
  gait: number;
  /** telegraph progress 0..1 (null = none) */
  windup: number | null;
  windKind: 'melee' | 'heavy' | 'leap';
  /** strike follow-through 1 (just landed) .. 0 */
  strike: number;
  /** 0 standing .. 1 lying (downed) */
  down: number;
  /** 0..1 hit flinch */
  flinch: number;
  /** a corpse: limp spread pose */
  dead: boolean;
  /** per-creature seed 0..1 (desyncs idles in a horde) */
  seed: number;
}

export interface PoseOut {
  /** per part: euler x, y, z added to rest */
  rot: Float32Array;
  /** per part: extra scale multiplier (x, y, z) */
  scl: Float32Array;
  /** root offset (m, model frame) */
  pos: [number, number, number];
  /** root rotation (euler x, y, z), applied at the feet */
  lean: [number, number, number];
}

export interface Rig {
  shape: BodyShape;
  parts: PartDef[];
  /** standing height (m) to the top of the head/body */
  height: number;
  /** extra hover height (m) for flyers */
  hover: number;
  /**
   * How the body lies when downed or dead: topple angle (rad, about the feet), lift (m) so
   * the fallen body rests on the floor instead of sinking into it, and whether it falls on
   * its side (animals, bugs) rather than forward/back along the killing blow (people).
   */
  lie: { angle: number; lift: number; side: boolean };
  pose(p: PoseIn, out: PoseOut): void;
}

export function newPoseOut(n: number): PoseOut {
  const scl = new Float32Array(n * 3).fill(1);
  return { rot: new Float32Array(n * 3), scl, pos: [0, 0, 0], lean: [0, 0, 0] };
}

export function resetPose(o: PoseOut): void {
  o.rot.fill(0);
  o.scl.fill(1);
  o.pos[0] = o.pos[1] = o.pos[2] = 0;
  o.lean[0] = o.lean[1] = o.lean[2] = 0;
}

const TAU = Math.PI * 2;
const sin = Math.sin, cos = Math.cos;
const ease = (k: number) => { const x = Math.min(1, Math.max(0, k)); return x * x * (3 - 2 * x); };

function setRot(o: PoseOut, i: number, x: number, y = 0, z = 0): void {
  o.rot[i * 3] += x;
  o.rot[i * 3 + 1] += y;
  o.rot[i * 3 + 2] += z;
}

/** Scale every length in a part list (built at the archetype's reference size). */
function scaleParts(parts: PartDef[], s: number): PartDef[] {
  const m = (v: [number, number, number]): [number, number, number] => [v[0] * s, v[1] * s, v[2] * s];
  return parts.map((p) => ({ ...p, joint: m(p.joint), size: m(p.size), center: m(p.center) }));
}

// ------------------------------------------------------------------ humanoid

/** Humanoid part indices (order of the parts list in humanoid()). */
export const HUM = {
  hips: 0, torso: 1, head: 2, uArmR: 3, fArmR: 4, uArmL: 5, fArmL: 6,
  thighR: 7, shinR: 8, thighL: 9, shinL: 10, footR: 11, footL: 12, wingR: 13, wingL: 14,
} as const;

function humanoid(sh: BodyShape): Rig {
  const g = sh.girth, hd = sh.head;
  const legLen = 0.87, hipY = 0.92;
  const torsoW = 0.38 * g, torsoD = 0.22 * Math.sqrt(g) * (g > 1.3 ? 1.25 : 1);
  const armW = 0.11 * Math.sqrt(g);
  const legW = 0.15 * Math.sqrt(g), legD = 0.16 * Math.sqrt(g);
  // hip joint at hipY - 0.06: thigh + shin + foot reach the floor
  const upperArm = 0.32, foreArm = 0.33, thigh = 0.41, shin = 0.38, footH = 0.07;
  const hipX = 0.095 * Math.min(g, 1.3);
  const shoulderX = torsoW / 2 + armW / 2;
  // Two-segment limbs (shoulder/elbow, hip/knee) plus feet: bent elbows and knees and a foot
  // pointing where the body faces read far better than Minecraft planks. Indices are H.* below.
  const parts: PartDef[] = [
    { name: 'hips', parent: -1, joint: [0, hipY, 0], size: [torsoW * 0.92, 0.16, torsoD * 0.95], center: [0, -0.02, 0], src: { rect: [0.2, 0.5, 0.8, 0.6], proj: 'front', core: true }, kind: 'core' },
    { name: 'torso', parent: 0, joint: [0, 0.06, 0], size: [torsoW, 0.46, torsoD], center: [0, 0.23, 0], src: { rect: [0.15, 0.22, 0.85, 0.52], proj: 'front', core: true }, kind: 'core' },
    { name: 'head', parent: 1, joint: [0, 0.47, 0], size: [0.25 * hd, 0.27 * hd, 0.25 * hd], center: [0, 0.135 * hd, 0], src: { rect: [0.2, 0, 0.8, 0.22], proj: 'front', core: true, face: true }, kind: 'core' },
    { name: 'uArmR', parent: 1, joint: [shoulderX, 0.42, 0], size: [armW, upperArm, armW], center: [0, -upperArm / 2 + 0.03, 0], src: { rect: [0, 0.22, 0.25, 0.4], proj: 'front' }, kind: 'limb' },
    { name: 'fArmR', parent: 3, joint: [0, -upperArm + 0.04, 0], size: [armW * 0.92, foreArm, armW * 0.92], center: [0, -foreArm / 2, 0], src: { rect: [0, 0.38, 0.25, 0.56], proj: 'front' }, kind: 'limb' },
    { name: 'uArmL', parent: 1, joint: [-shoulderX, 0.42, 0], size: [armW, upperArm, armW], center: [0, -upperArm / 2 + 0.03, 0], src: { rect: [0.75, 0.22, 1, 0.4], proj: 'front' }, kind: 'limb' },
    { name: 'fArmL', parent: 5, joint: [0, -upperArm + 0.04, 0], size: [armW * 0.92, foreArm, armW * 0.92], center: [0, -foreArm / 2, 0], src: { rect: [0.75, 0.38, 1, 0.56], proj: 'front' }, kind: 'limb' },
    { name: 'thighR', parent: 0, joint: [hipX, -0.06, 0], size: [legW, thigh, legD], center: [0, -thigh / 2, 0], src: { rect: [0.1, 0.56, 0.5, 0.76], proj: 'front', core: true }, kind: 'limb' },
    { name: 'shinR', parent: 7, joint: [0, -thigh, 0], size: [legW * 0.9, shin, legD * 0.9], center: [0, -shin / 2, 0], src: { rect: [0.1, 0.74, 0.5, 0.94], proj: 'front', core: true }, kind: 'limb' },
    { name: 'thighL', parent: 0, joint: [-hipX, -0.06, 0], size: [legW, thigh, legD], center: [0, -thigh / 2, 0], src: { rect: [0.5, 0.56, 0.9, 0.76], proj: 'front', core: true }, kind: 'limb' },
    { name: 'shinL', parent: 9, joint: [0, -thigh, 0], size: [legW * 0.9, shin, legD * 0.9], center: [0, -shin / 2, 0], src: { rect: [0.5, 0.74, 0.9, 0.94], proj: 'front', core: true }, kind: 'limb' },
    { name: 'footR', parent: 8, joint: [0, -shin, 0], size: [legW * 0.95, footH, 0.26], center: [0, -footH / 2 + 0.005, -0.05], src: { rect: [0.1, 0.9, 0.5, 1], proj: 'front', core: true }, kind: 'limb' },
    { name: 'footL', parent: 10, joint: [0, -shin, 0], size: [legW * 0.95, footH, 0.26], center: [0, -footH / 2 + 0.005, -0.05], src: { rect: [0.5, 0.9, 0.9, 1], proj: 'front', core: true }, kind: 'limb' },
  ];
  if (sh.wings !== 'none') {
    parts.push(
      { name: 'wingR', parent: 1, joint: [0.08, 0.38, 0.12], size: [0.7, 0.5, 0.03], center: [0.35, 0.05, 0], rest: [0, -0.4, 0.3], src: { role: 'wing' }, kind: 'thin' },
      { name: 'wingL', parent: 1, joint: [-0.08, 0.38, 0.12], size: [0.7, 0.5, 0.03], center: [-0.35, 0.05, 0], rest: [0, 0.4, -0.3], src: { role: 'wing' }, kind: 'thin' },
    );
  }
  const s = sh.scale;
  const height = (hipY + 0.06 + 0.47 + 0.27 * hd) * s;
  const zombie = sh.zombie;
  return {
    shape: sh, parts: scaleParts(parts, s), height, hover: sh.flies ? 0.6 * s : 0, lie: { angle: Math.PI / 2, lift: torsoD * 0.5 * s, side: false },
    pose(p, o) {
      const H = HUM;
      const ph = p.phase * TAU;
      const walk = Math.min(1, p.gait);
      const run = Math.max(0, p.gait - 1);
      const amp = walk * 0.45 + run * 0.35;
      const lean = zombie ? 0.1 : 0.0;
      // legs: opposite swing, the knee folds while the leg swings through, the foot stays
      // roughly flat; the body dips at each foot fall
      for (const [thighI, shinI, footI, off] of [[H.thighR, H.shinR, H.footR, 0], [H.thighL, H.shinL, H.footL, Math.PI]] as const) {
        const a = sin(ph + off) * amp;
        const knee = -Math.max(0, cos(ph + off)) * (amp * 1.3 + run * 0.4);
        setRot(o, thighI, a);
        setRot(o, shinI, knee);
        setRot(o, footI, -(a + knee) * 0.7);
      }
      o.pos[1] -= Math.abs(sin(ph)) * 0.04 * walk * s;
      // idle: slow breathing sway (zombies loll their heads)
      const idle = sin(p.t * 1.7 + p.seed * TAU);
      setRot(o, H.torso, -lean - 0.03 * idle * (zombie ? 1 : 0.4) - run * 0.25, 0, zombie ? 0.05 * sin(ph * 0.5 + p.seed * 6) : 0);
      setRot(o, H.head, zombie ? 0.18 + 0.08 * idle : 0.02 * idle, zombie ? 0.1 * sin(p.t * 0.9 + p.seed * 9) : 0, zombie ? 0.2 * sin(p.seed * 20) : 0);
      // arms: zombies reach out, uneven, hands drooping; people swing them against the legs
      const reachR = zombie ? 1.3 + 0.12 * sin(ph + 1) + 0.06 * idle : 0;
      const reachL = zombie ? 1.15 + 0.12 * sin(ph + 2.2) - 0.05 * idle : 0;
      if (zombie) {
        setRot(o, H.uArmR, reachR, 0, -0.08);
        setRot(o, H.uArmL, reachL, 0, 0.1);
        setRot(o, H.fArmR, -0.25 + 0.1 * sin(p.t * 1.3 + p.seed * 4));
        setRot(o, H.fArmL, -0.35 + 0.1 * sin(p.t * 1.1 + p.seed * 7));
      } else {
        setRot(o, H.uArmR, -sin(ph) * amp * 0.9 + run * 0.2, 0, 0.06);
        setRot(o, H.uArmL, sin(ph) * amp * 0.9 + run * 0.2, 0, -0.06);
        setRot(o, H.fArmR, 0.15 + walk * 0.25 + run * 0.9);
        setRot(o, H.fArmL, 0.15 + walk * 0.25 + run * 0.9);
      }
      if (sh.wings !== 'none') {
        const f = sin(p.t * 9 + p.seed * 5) * 0.6;
        setRot(o, H.wingR, 0, 0, f);
        setRot(o, H.wingL, 0, 0, -f);
        o.pos[1] += (0.08 * sin(p.t * 4.5)) * s;
      }
      if (p.windup !== null) {
        const u = ease(p.windup);
        if (p.windKind === 'leap') {
          // crouch to spring: torso folds, knees bend, hips drop
          setRot(o, H.torso, -0.5 * u);
          setRot(o, H.thighR, 0.9 * u);
          setRot(o, H.thighL, 0.9 * u);
          setRot(o, H.shinR, -1.3 * u);
          setRot(o, H.shinL, -1.3 * u);
          setRot(o, H.footR, 0.4 * u);
          setRot(o, H.footL, 0.4 * u);
          o.pos[1] -= 0.22 * u * s;
          setRot(o, H.uArmR, (0.5 - reachR) * u);
          setRot(o, H.uArmL, (0.5 - reachL) * u);
        } else {
          // both arms swing up and back over the head, elbows cocked, torso rears back
          const heavy = p.windKind === 'heavy' ? 1 : 0;
          const armsUp = 2.6 + 0.35 * heavy;
          setRot(o, H.uArmR, (armsUp - reachR) * u, 0, -0.15 * u);
          setRot(o, H.uArmL, (armsUp - reachL) * u * (heavy ? 1 : 0.85), 0, 0.15 * u);
          // (+x continues the arm's swing: past straight up the hands go behind the head)
          setRot(o, H.fArmR, 0.8 * u);
          setRot(o, H.fArmL, 0.8 * u);
          setRot(o, H.torso, (0.28 + 0.12 * heavy) * u);
          setRot(o, H.head, -0.2 * u);
          o.pos[2] += 0.1 * u * s;
        }
      }
      if (p.strike > 0) {
        const k = p.strike;
        // follow-through: arms slam down and forward, elbows straight, torso pitches in
        setRot(o, H.uArmR, (1.0 - reachR) * k);
        setRot(o, H.uArmL, (0.9 - reachL) * k);
        setRot(o, H.fArmR, 0.25 * k);
        setRot(o, H.fArmL, 0.25 * k);
        setRot(o, H.torso, -0.45 * k);
        setRot(o, H.head, 0.15 * k);
        o.pos[2] -= 0.12 * k * s;
      }
      if (p.flinch > 0) {
        setRot(o, H.torso, 0.25 * p.flinch);
        setRot(o, H.head, 0.35 * p.flinch, 0, 0.2 * p.flinch * (p.seed > 0.5 ? 1 : -1));
        setRot(o, H.fArmR, 0.3 * p.flinch);
        setRot(o, H.fArmL, 0.3 * p.flinch);
      }
      if (p.dead) {
        // a corpse forgets the reach/walk pose (zombie arms would point at the sky): limp,
        // arms flung out, one knee up
        o.rot.fill(0);
        setRot(o, H.head, 0, 0.5 * (p.seed - 0.5), 0.4 * (p.seed - 0.5));
        setRot(o, H.uArmR, 0.3 + p.seed, 0, -0.5);
        setRot(o, H.fArmR, -0.4 * p.seed);
        setRot(o, H.uArmL, 1.2 - p.seed, 0, 0.6);
        setRot(o, H.fArmL, -0.5);
        setRot(o, p.seed > 0.5 ? H.thighR : H.thighL, 0.5);
        setRot(o, p.seed > 0.5 ? H.shinR : H.shinL, -0.8);
        setRot(o, H.thighR, 0, 0, 0.12);
        setRot(o, H.thighL, 0, 0, -0.12);
        setRot(o, H.footR, 0.9);
        setRot(o, H.footL, 0.9);
      } else if (p.down > 0) {
        // lying on the back: limbs relax outward
        const d = p.down;
        setRot(o, H.uArmR, -reachR * d, 0, -0.5 * d);
        setRot(o, H.uArmL, -reachL * d, 0, 0.5 * d);
        setRot(o, H.thighR, 0, 0, 0.15 * d);
        setRot(o, H.thighL, 0, 0, -0.15 * d);
        setRot(o, H.footR, 0.8 * d);
        setRot(o, H.footL, 0.8 * d);
      }
    },
  };
}

// ------------------------------------------------------------------ four-legged animals

function quadruped(sh: BodyShape, critter: boolean): Rig {
  const g = sh.girth, L = sh.legs, hd = sh.head;
  // reference: a 30 L dog (critter: a 1.5 L rabbit)
  const bw = (critter ? 0.12 : 0.25) * g, bh = (critter ? 0.12 : 0.28) * Math.sqrt(g), bl = critter ? 0.26 : 0.7;
  const leg = (critter ? 0.07 : 0.32) * L;
  const legW = (critter ? 0.035 : 0.085) * Math.sqrt(g);
  const hs = (critter ? 0.11 : 0.2) * hd;
  const bodyY = leg + bh / 2 - 0.02;
  const parts: PartDef[] = [
    { name: 'body', parent: -1, joint: [0, bodyY, 0], size: [bw, bh, bl], center: [0, 0, 0], src: { rect: [0.15, 0.2, 0.8, 0.65], proj: 'side', core: true }, kind: 'core' },
    { name: 'head', parent: 0, joint: [0, bh * 0.35, -bl / 2], size: [hs * 0.9, hs, hs * 1.25], center: [0, hs * 0.35, -hs * 0.45], src: { rect: [0.68, 0, 1, 0.45], proj: 'side', core: true, face: true }, kind: 'core' },
    { name: 'legFR', parent: 0, joint: [bw / 2 - legW / 2, -bh / 2 + 0.02, -bl / 2 + legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.6, 0.55, 0.85, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'legFL', parent: 0, joint: [-bw / 2 + legW / 2, -bh / 2 + 0.02, -bl / 2 + legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.6, 0.55, 0.85, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'legBR', parent: 0, joint: [bw / 2 - legW / 2, -bh / 2 + 0.02, bl / 2 - legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.1, 0.55, 0.4, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'legBL', parent: 0, joint: [-bw / 2 + legW / 2, -bh / 2 + 0.02, bl / 2 - legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.1, 0.55, 0.4, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'tail', parent: 0, joint: [0, bh * 0.3, bl / 2], size: [legW * 0.7, legW * 0.7, bl * 0.4], center: [0, 0, bl * 0.2], rest: [0.6, 0, 0], src: { rect: [0, 0.15, 0.2, 0.45], proj: 'side' }, kind: 'thin' },
    { name: 'earR', parent: 1, joint: [hs * 0.3, hs * 0.8, -hs * 0.1], size: [hs * 0.22, hs * (critter && L > 1.1 ? 1.2 : 0.4), hs * 0.12], center: [0, hs * 0.2, 0], rest: [-0.2, 0, -0.2], src: { rect: [0.7, 0, 0.95, 0.2], proj: 'side' }, kind: 'thin' },
    { name: 'earL', parent: 1, joint: [-hs * 0.3, hs * 0.8, -hs * 0.1], size: [hs * 0.22, hs * (critter && L > 1.1 ? 1.2 : 0.4), hs * 0.12], center: [0, hs * 0.2, 0], rest: [-0.2, 0, 0.2], src: { rect: [0.7, 0, 0.95, 0.2], proj: 'side' }, kind: 'thin' },
  ];
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: (bodyY + bh * 0.35 + hs * 1.1) * s, hover: 0, lie: { angle: Math.PI / 2, lift: bw * 0.5 * s, side: true },
    pose(p, o) {
      const ph = p.phase * TAU;
      const amp = Math.min(1, p.gait) * 0.5 + Math.max(0, p.gait - 1) * 0.3;
      // trot: diagonal pairs together; gallop blends toward front/back pairs
      const gal = Math.max(0, Math.min(1, p.gait - 1));
      setRot(o, 2, sin(ph) * amp);
      setRot(o, 5, sin(ph) * amp);
      setRot(o, 3, -sin(ph + gal * Math.PI) * amp);
      setRot(o, 4, -sin(ph + gal * Math.PI) * amp);
      o.lean[0] += sin(ph * 2) * 0.05 * amp;
      o.pos[1] += Math.abs(sin(ph)) * 0.03 * amp * s;
      const idle = sin(p.t * 2.1 + p.seed * TAU);
      setRot(o, 1, 0.05 * idle + (p.gait > 0.1 ? 0.12 : 0), 0.12 * sin(p.t * 0.8 + p.seed * 7));
      setRot(o, 6, 0, 0.5 * sin(p.t * (p.gait > 0 ? 9 : 4) + p.seed * 3));
      if (p.windup !== null) {
        const u = ease(p.windup);
        if (p.windKind === 'heavy') {
          // rear up on the hind legs
          o.lean[0] += 0.45 * u;
          setRot(o, 2, 0.8 * u);
          setRot(o, 3, 0.8 * u);
          setRot(o, 1, -0.3 * u);
        } else {
          // crouch, head low, ready to spring
          o.pos[1] -= leg * 0.3 * u * s;
          o.pos[2] += 0.1 * u * s;
          // (head +x = nose up)
          setRot(o, 1, -0.35 * u);
          setRot(o, 2, 0.35 * u);
          setRot(o, 3, 0.35 * u);
          setRot(o, 4, -0.35 * u);
          setRot(o, 5, -0.35 * u);
        }
      }
      if (p.strike > 0) {
        const k = p.strike;
        o.pos[2] -= 0.22 * k * s;
        o.lean[0] -= 0.15 * k;
        setRot(o, 1, 0.25 * k);
        setRot(o, 2, 0.6 * k);
        setRot(o, 3, 0.6 * k);
      }
      if (p.flinch > 0) {
        setRot(o, 1, -0.4 * p.flinch, 0.3 * p.flinch);
        o.lean[2] += 0.12 * p.flinch;
      }
      if (p.down > 0 || p.dead) {
        const d = p.dead ? 1 : p.down;
        for (let i = 2; i < 6; i++) setRot(o, i, 0.2 * d * (i % 2 ? 1 : -1), 0, 0.25 * d);
        setRot(o, 1, 0.2 * d, 0, 0.3 * d);
      }
    },
  };
}

// ------------------------------------------------------------------ insects, spiders, crabs

function insect(sh: BodyShape): Rig {
  const g = sh.girth;
  const n = sh.legCount;
  const spider = n === 8;
  const tw = 0.28 * g, th = 0.14, tl = 0.28;
  const aw = (spider ? 0.4 : 0.32) * g, ah = spider ? 0.3 : 0.14, al = spider ? 0.42 : 0.5;
  const upper = spider ? 0.36 : 0.24, lower = spider ? 0.42 : 0.28;
  // upper leg rises 0.55 rad, lower leg splays 0.25 rad out: feet land on the floor
  const bodyY = lower * Math.cos(0.25) - upper * Math.sin(0.55);
  const parts: PartDef[] = [
    { name: 'thorax', parent: -1, joint: [0, bodyY, 0], size: [tw, th, tl], center: [0, 0, 0], src: { rect: [0.3, 0.25, 0.7, 0.7], proj: 'side', core: true }, kind: 'core' },
    { name: 'abdomen', parent: 0, joint: [0, 0.02, tl / 2], size: [aw, ah, al], center: [0, ah * 0.3, al / 2], rest: [spider ? 0.25 : 0.05, 0, 0], src: { rect: [0, 0.15, 0.55, 0.8], proj: 'side', core: true }, kind: 'core' },
    { name: 'head', parent: 0, joint: [0, 0.01, -tl / 2], size: [tw * 0.7, th * 0.9, 0.16], center: [0, 0, -0.08], src: { rect: [0.65, 0.2, 1, 0.7], proj: 'side', core: true, face: true }, kind: 'core' },
  ];
  const pairs = n / 2;
  for (let i = 0; i < pairs; i++) {
    const z = -tl / 2 + (tl * (i + 0.5)) / pairs;
    for (const side of [1, -1]) {
      const up = parts.length;
      // angle the pairs fore and aft like a real bug
      const yaw = ((i - (pairs - 1) / 2) / pairs) * 1.2 * side;
      parts.push({ name: `leg${i}${side > 0 ? 'R' : 'L'}u`, parent: 0, joint: [side * tw / 2, 0, z], size: [upper, 0.05, 0.05], center: [side * upper / 2, 0, 0], rest: [0, yaw, side * 0.55], src: { role: 'dark' }, kind: 'thin' });
      parts.push({ name: `leg${i}${side > 0 ? 'R' : 'L'}l`, parent: up, joint: [side * upper, 0, 0], size: [0.045, lower, 0.045], center: [0, -lower / 2, 0], rest: [0, 0, side * (0.25 - 0.55)], src: { role: 'dark' }, kind: 'thin' });
    }
  }
  if (!spider) {
    parts.push(
      { name: 'antR', parent: 2, joint: [0.04, 0.03, -0.14], size: [0.015, 0.015, 0.3], center: [0, 0, -0.15], rest: [0.5, -0.3, 0], src: { role: 'dark' }, kind: 'thin' },
      { name: 'antL', parent: 2, joint: [-0.04, 0.03, -0.14], size: [0.015, 0.015, 0.3], center: [0, 0, -0.15], rest: [0.5, 0.3, 0], src: { role: 'dark' }, kind: 'thin' },
    );
  } else {
    parts.push(
      { name: 'fangR', parent: 2, joint: [0.04, -0.03, -0.14], size: [0.04, 0.08, 0.04], center: [0, -0.04, 0], rest: [-0.3, 0, 0], src: { role: 'accent' }, kind: 'thin' },
      { name: 'fangL', parent: 2, joint: [-0.04, -0.03, -0.14], size: [0.04, 0.08, 0.04], center: [0, -0.04, 0], rest: [-0.3, 0, 0], src: { role: 'accent' }, kind: 'thin' },
    );
  }
  const s = sh.scale;
  const legStart = 3;
  return {
    shape: sh, parts: scaleParts(parts, s), height: (bodyY + ah) * s, hover: 0, lie: { angle: Math.PI, lift: (bodyY + ah * 0.8) * s, side: true },
    pose(p, o) {
      const ph = p.phase * TAU * 1.5;
      const amp = Math.min(1.5, p.gait) * 0.35;
      // alternating tripods: legs lift (z) and sweep (y) in two groups
      for (let i = 0; i < pairs; i++) {
        for (let sI = 0; sI < 2; sI++) {
          const side = sI === 0 ? 1 : -1;
          const grp = (i + sI) % 2 ? 0 : Math.PI;
          const k = legStart + (i * 2 + sI) * 2;
          setRot(o, k, 0, sin(ph + grp) * amp * side, Math.max(0, cos(ph + grp)) * amp * 0.8 * side);
        }
      }
      o.pos[1] += Math.abs(sin(ph)) * 0.015 * amp * s;
      const idle = sin(p.t * 3 + p.seed * TAU);
      setRot(o, 1, 0.04 * idle);
      if (!spider) {
        const n2 = parts.length;
        setRot(o, n2 - 2, 0.15 * sin(p.t * 5 + p.seed * 4), 0.2 * sin(p.t * 3.1));
        setRot(o, n2 - 1, 0.15 * sin(p.t * 5.3 + 1), 0.2 * sin(p.t * 2.7 + 2));
      }
      if (p.windup !== null) {
        const u = ease(p.windup);
        // rear the front up, front legs raised
        o.lean[0] += 0.5 * u;
        o.pos[2] += 0.08 * u * s;
        setRot(o, legStart, 0, 0, 0.9 * u);
        setRot(o, legStart + 2, 0, 0, -0.9 * u);
        setRot(o, 1, -0.3 * u);
      }
      if (p.strike > 0) {
        o.lean[0] -= 0.3 * p.strike;
        o.pos[2] -= 0.2 * p.strike * s;
      }
      if (p.flinch > 0) o.lean[2] += 0.2 * p.flinch;
      if (p.down > 0 || p.dead) {
        // on its back, legs curled
        const d = p.dead ? 1 : p.down;
        for (let j = 0; j < n; j++) {
          const side = j % 2 === 0 ? 1 : -1;
          setRot(o, legStart + j * 2, 0, 0, 0.5 * d * side);
          setRot(o, legStart + j * 2 + 1, 0, 0, -0.9 * d * side);
        }
      }
    },
  };
}

// ------------------------------------------------------------------ birds, bats, wasps, drones

function flyer(sh: BodyShape): Rig {
  const insectW = sh.wings === 'insect';
  const bw = insectW ? 0.08 : 0.12, bh = insectW ? 0.08 : 0.12, bl = insectW ? 0.14 : 0.24;
  const hs = insectW ? 0.08 : 0.1;
  const parts: PartDef[] = [
    { name: 'body', parent: -1, joint: [0, 0.14, 0], size: [bw, bh, bl], center: [0, 0, 0], rest: [-0.15, 0, 0], src: { rect: [0.2, 0.25, 0.8, 0.8], proj: 'side', core: true }, kind: 'core' },
    { name: 'head', parent: 0, joint: [0, bh * 0.3, -bl / 2], size: [hs, hs, hs], center: [0, hs * 0.2, -hs * 0.4], src: { rect: [0.6, 0, 1, 0.45], proj: 'side', core: true, face: true }, kind: 'core' },
  ];
  if (sh.wings !== 'none') {
    const ww = insectW ? 0.22 : 0.32, wd = insectW ? 0.08 : 0.16;
    parts.push(
      { name: 'wingR', parent: 0, joint: [bw / 2, bh * 0.3, -bl * 0.1], size: [ww, 0.015, wd], center: [ww / 2, 0, wd * 0.3], src: insectW ? { role: 'wing' } : { rect: [0.25, 0.1, 0.75, 0.5], proj: 'side' }, kind: 'thin' },
      { name: 'wingL', parent: 0, joint: [-bw / 2, bh * 0.3, -bl * 0.1], size: [ww, 0.015, wd], center: [-ww / 2, 0, wd * 0.3], src: insectW ? { role: 'wing' } : { rect: [0.25, 0.1, 0.75, 0.5], proj: 'side' }, kind: 'thin' },
    );
  }
  if (insectW) parts.push({ name: 'abdomen', parent: 0, joint: [0, 0, bl / 2], size: [bw * 1.3, bh * 1.2, bl * 1.3], center: [0, -bh * 0.2, bl * 0.6], rest: [0.3, 0, 0], src: { rect: [0, 0.3, 0.55, 1], proj: 'side', core: true }, kind: 'core' });
  else if (sh.wings !== 'none') parts.push({ name: 'tail', parent: 0, joint: [0, 0, bl / 2], size: [bw * 0.9, 0.02, bl * 0.6], center: [0, 0, bl * 0.3], rest: [-0.2, 0, 0], src: { role: 'dark' }, kind: 'thin' });
  const s = sh.scale;
  const hasWings = sh.wings !== 'none';
  return {
    shape: sh, parts: scaleParts(parts, s), height: (0.14 + bh) * s, hover: sh.flies ? 1.2 : 0, lie: { angle: Math.PI / 2, lift: bw * 0.5 * s, side: true },
    pose(p, o) {
      // wing beat: fast for bugs, slower for birds; perched birds fold their wings
      const flying = sh.flies || p.gait > 0.1;
      const rate = insectW ? 26 : sh.wings === 'membrane' ? 11 : 8;
      const beat = sin(p.t * rate + p.seed * TAU);
      if (hasWings) {
        const a = flying ? 0.9 * beat : 0.05;
        setRot(o, 2, 0, 0, a);
        setRot(o, 3, 0, 0, -a);
        if (!flying) { setRot(o, 2, 0, -0.9, -0.2); setRot(o, 3, 0, 0.9, 0.2); }
      }
      if (flying) o.pos[1] += 0.12 * sin(p.t * 3 + p.seed * 5) * s;
      else o.pos[1] += Math.abs(sin(p.phase * TAU * 2)) * 0.03 * s;
      setRot(o, 1, 0.1 * sin(p.t * 2.5 + p.seed * 9), 0.3 * sin(p.t * 1.3 + p.seed * 3));
      if (p.windup !== null) {
        const u = ease(p.windup);
        o.pos[1] += 0.3 * u * s;
        o.pos[2] += 0.2 * u * s;
        o.lean[0] += 0.4 * u;
      }
      if (p.strike > 0) {
        o.pos[1] -= 0.3 * p.strike * s;
        o.pos[2] -= 0.3 * p.strike * s;
        o.lean[0] -= 0.5 * p.strike;
      }
      if (p.flinch > 0) o.lean[2] += 0.4 * p.flinch;
    },
  };
}

// ------------------------------------------------------------------ blobs and slugs

function blob(sh: BodyShape): Rig {
  const parts: PartDef[] = [
    { name: 'mass', parent: -1, joint: [0, 0, 0], size: [0.8, 0.5, 0.8], center: [0, 0.25, 0], src: { rect: [0, 0.2, 1, 1], proj: 'front', core: true }, kind: 'core' },
    { name: 'top', parent: 0, joint: [0, 0.5, 0.05], size: [0.5, 0.25, 0.5], center: [0, 0.1, 0], src: { rect: [0.2, 0, 0.8, 0.5], proj: 'front', core: true, face: true }, kind: 'core' },
    { name: 'lumpR', parent: 0, joint: [0.35, 0.15, 0.1], size: [0.3, 0.3, 0.35], center: [0.05, 0, 0], src: { rect: [0, 0.4, 0.4, 1], proj: 'front', core: true }, kind: 'core' },
    { name: 'lumpL', parent: 0, joint: [-0.35, 0.12, -0.1], size: [0.28, 0.26, 0.3], center: [-0.05, 0, 0], src: { rect: [0.6, 0.4, 1, 1], proj: 'front', core: true }, kind: 'core' },
  ];
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: 0.85 * s, hover: 0, lie: { angle: 0, lift: 0, side: false },
    pose(p, o) {
      // everything is squash and stretch
      const w = sin(p.t * 3 + p.seed * TAU) * 0.06 + sin(p.phase * TAU * 2) * 0.12 * Math.min(1, p.gait);
      o.scl[0] = 1 - w * 0.5; o.scl[1] = 1 + w; o.scl[2] = 1 - w * 0.5;
      o.scl[3] = 1 + w * 0.4; o.scl[4] = 1 - w * 0.6; o.scl[5] = 1 + w * 0.4;
      setRot(o, 2, 0, 0, 0.1 * sin(p.t * 2.3 + p.seed * 3));
      setRot(o, 3, 0, 0, -0.1 * sin(p.t * 2.7 + p.seed * 5));
      if (p.windup !== null) {
        const u = ease(p.windup);
        o.scl[1] *= 1 + 0.45 * u; o.scl[0] *= 1 - 0.2 * u; o.scl[2] *= 1 - 0.2 * u;
        o.pos[2] += 0.1 * u * s;
      }
      if (p.strike > 0) {
        o.scl[1] *= 1 - 0.4 * p.strike; o.scl[0] *= 1 + 0.3 * p.strike; o.scl[2] *= 1 + 0.3 * p.strike;
        o.pos[2] -= 0.25 * p.strike * s;
      }
      if (p.dead || p.down > 0) { const d = p.dead ? 1 : p.down; o.scl[1] *= 1 - 0.55 * d; o.scl[0] *= 1 + 0.3 * d; o.scl[2] *= 1 + 0.3 * d; }
    },
  };
}

// ------------------------------------------------------------------ snakes, fish

function serpent(sh: BodyShape): Rig {
  const n = 7;
  const parts: PartDef[] = [];
  const seg = 0.2;
  parts.push({ name: 'head', parent: -1, joint: [0, 0.07, -seg * 2.5], size: [0.13, 0.1, 0.17], center: [0, 0.01, -0.06], src: { rect: [0.65, 0, 1, 0.6], proj: 'side', core: true, face: true }, kind: 'core' });
  for (let i = 0; i < n; i++) {
    const t = 1 - i / n;
    parts.push({ name: `seg${i}`, parent: i === 0 ? 0 : i, joint: [0, i === 0 ? -0.01 : 0, i === 0 ? 0 : seg], size: [0.11 * (0.5 + 0.5 * t), 0.09 * (0.5 + 0.5 * t), seg + 0.02], center: [0, 0, seg / 2], src: { rect: [0.1 + 0.1 * (i % 3), 0.3, 0.6 + 0.1 * (i % 3), 1], proj: 'side', core: true }, kind: 'core' });
  }
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: 0.15 * s, hover: 0, lie: { angle: 0, lift: 0, side: true },
    pose(p, o) {
      const ph = p.phase * TAU * 1.5 + p.t * 0.8;
      for (let i = 1; i <= n; i++) setRot(o, i, 0, 0.35 * sin(ph - i * 0.9) * (0.3 + Math.min(1, p.gait)), 0);
      setRot(o, 0, 0, 0.15 * sin(p.t * 1.5 + p.seed * 5));
      if (p.windup !== null) {
        const u = ease(p.windup);
        // coil and raise the head
        o.pos[1] += 0.25 * u * s;
        o.pos[2] += 0.15 * u * s;
        setRot(o, 0, 0.2 * u);
        setRot(o, 1, -0.8 * u);
      }
      if (p.strike > 0) {
        o.pos[2] -= 0.35 * p.strike * s;
        setRot(o, 1, 0.4 * p.strike);
      }
      if (p.dead) for (let i = 1; i <= n; i++) setRot(o, i, 0, 0.25 * sin(i * 1.7 + p.seed * 9), 0);
    },
  };
}

// ------------------------------------------------------------------ triffids, fungaloids

function plant(sh: BodyShape): Rig {
  const parts: PartDef[] = [
    { name: 'base', parent: -1, joint: [0, 0, 0], size: [0.42, 0.12, 0.42], center: [0, 0.06, 0], src: { rect: [0.1, 0.85, 0.9, 1], proj: 'front', core: true }, kind: 'core' },
    { name: 'stalk', parent: 0, joint: [0, 0.1, 0], size: [0.18, 0.95, 0.18], center: [0, 0.47, 0], src: { rect: [0.3, 0.4, 0.7, 0.9], proj: 'front', core: true }, kind: 'core' },
    { name: 'bulb', parent: 1, joint: [0, 0.92, 0], size: [0.42, 0.38, 0.42], center: [0, 0.18, 0], src: { rect: [0.15, 0, 0.85, 0.4], proj: 'front', core: true, face: true }, kind: 'core' },
    { name: 'leafR', parent: 1, joint: [0.08, 0.45, 0], size: [0.4, 0.03, 0.14], center: [0.2, 0, 0], rest: [0, 0.3, 0.4], src: { role: 'accent' }, kind: 'thin' },
    { name: 'leafL', parent: 1, joint: [-0.08, 0.6, 0.02], size: [0.4, 0.03, 0.14], center: [-0.2, 0, 0], rest: [0, -0.5, -0.4], src: { role: 'accent' }, kind: 'thin' },
    { name: 'leafB', parent: 1, joint: [0, 0.3, 0.08], size: [0.14, 0.03, 0.38], center: [0, 0, 0.19], rest: [-0.4, 0, 0], src: { role: 'accent' }, kind: 'thin' },
  ];
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: 1.4 * s, hover: 0, lie: { angle: Math.PI / 2, lift: 0.09 * s, side: false },
    pose(p, o) {
      const sw = sin(p.t * 1.4 + p.seed * TAU);
      setRot(o, 1, 0.05 * sw, 0, 0.05 * sin(p.t * 1.1 + p.seed * 3) + 0.1 * Math.min(1, p.gait) * sin(p.phase * TAU));
      setRot(o, 2, 0.1 * sw);
      setRot(o, 3, 0, 0, 0.2 * sin(p.t * 2 + 1));
      setRot(o, 4, 0, 0, -0.2 * sin(p.t * 2.2 + 2));
      if (p.windup !== null) {
        const u = ease(p.windup);
        setRot(o, 1, 0.5 * u);
        setRot(o, 2, 0.4 * u);
      }
      if (p.strike > 0) {
        setRot(o, 1, -0.7 * p.strike);
        setRot(o, 2, -0.3 * p.strike);
      }
      if (p.dead) setRot(o, 1, 1.4, 0, 0.3);
    },
  };
}

// ------------------------------------------------------------------ robots

function machine(sh: BodyShape, turret: boolean): Rig {
  const parts: PartDef[] = turret
    ? [
      { name: 'base', parent: -1, joint: [0, 0, 0], size: [0.5, 0.35, 0.5], center: [0, 0.175, 0], src: { rect: [0.1, 0.55, 0.9, 1], proj: 'front', core: true }, kind: 'core' },
      { name: 'head', parent: 0, joint: [0, 0.35, 0], size: [0.4, 0.3, 0.45], center: [0, 0.15, 0], src: { rect: [0.1, 0, 0.9, 0.55], proj: 'front', core: true, face: true }, kind: 'core' },
      { name: 'barrel', parent: 1, joint: [0, 0.15, -0.2], size: [0.07, 0.07, 0.45], center: [0, 0, -0.22], src: { role: 'dark' }, kind: 'thin' },
    ]
    : [
      { name: 'body', parent: -1, joint: [0, 0.35, 0], size: [0.55, 0.45, 0.7], center: [0, 0.1, 0], src: { rect: [0.1, 0.3, 0.9, 0.8], proj: 'front', core: true }, kind: 'core' },
      { name: 'head', parent: 0, joint: [0, 0.33, -0.05], size: [0.32, 0.24, 0.36], center: [0, 0.12, 0], src: { rect: [0.2, 0, 0.8, 0.35], proj: 'front', core: true, face: true }, kind: 'core' },
      { name: 'trackR', parent: 0, joint: [0.33, -0.2, 0], size: [0.14, 0.3, 0.8], center: [0, 0, 0], src: { role: 'dark' }, kind: 'limb' },
      { name: 'trackL', parent: 0, joint: [-0.33, -0.2, 0], size: [0.14, 0.3, 0.8], center: [0, 0, 0], src: { role: 'dark' }, kind: 'limb' },
    ];
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: (turret ? 0.65 : 0.92) * s, hover: 0, lie: { angle: 0.25, lift: 0, side: true },
    pose(p, o) {
      setRot(o, 1, 0, 0.25 * sin(p.t * 0.7 + p.seed * TAU));
      if (!turret) o.pos[1] += (p.gait > 0.1 ? 0.012 * sin(p.t * 30) : 0) * s;
      if (p.windup !== null) setRot(o, 1, -0.15 * ease(p.windup));
      if (p.strike > 0) o.pos[2] += 0.08 * p.strike * s;
      if (p.dead) { setRot(o, 1, 0.3, 0.4, 0.3); }
    },
  };
}

// ------------------------------------------------------------------ fallback

function lump(sh: BodyShape): Rig {
  const parts: PartDef[] = [
    { name: 'body', parent: -1, joint: [0, 0.2, 0], size: [0.6, 0.75, 0.45], center: [0, 0.37, 0], src: { rect: [0, 0.2, 1, 0.9], proj: 'front', core: true }, kind: 'core' },
    { name: 'head', parent: 0, joint: [0, 0.72, -0.05], size: [0.34, 0.3, 0.32], center: [0, 0.15, 0], src: { rect: [0.2, 0, 0.8, 0.3], proj: 'front', core: true, face: true }, kind: 'core' },
    { name: 'legR', parent: 0, joint: [0.16, 0, 0], size: [0.16, 0.22, 0.16], center: [0, -0.1, 0], src: { rect: [0, 0.8, 0.5, 1], proj: 'front', core: true }, kind: 'limb' },
    { name: 'legL', parent: 0, joint: [-0.16, 0, 0], size: [0.16, 0.22, 0.16], center: [0, -0.1, 0], src: { rect: [0.5, 0.8, 1, 1], proj: 'front', core: true }, kind: 'limb' },
  ];
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: 1.22 * s, hover: sh.flies ? 0.8 : 0, lie: { angle: Math.PI / 2, lift: 0.22 * s, side: false },
    pose(p, o) {
      const ph = p.phase * TAU;
      const amp = Math.min(1, p.gait) * 0.4;
      setRot(o, 2, sin(ph) * amp);
      setRot(o, 3, -sin(ph) * amp);
      o.lean[2] += 0.06 * sin(ph) * amp;
      setRot(o, 1, 0.06 * sin(p.t * 1.6 + p.seed * TAU));
      if (p.windup !== null) { const u = ease(p.windup); setRot(o, 0, 0.3 * u); o.scl[1] = 1 + 0.15 * u; }
      if (p.strike > 0) { setRot(o, 0, -0.4 * p.strike); o.pos[2] -= 0.15 * p.strike * s; }
    },
  };
}

export function makeRig(sh: BodyShape, opts: { turret?: boolean } = {}): Rig {
  switch (sh.arch) {
    case 'humanoid': return humanoid(sh);
    case 'quadruped': return quadruped(sh, false);
    case 'critter': return quadruped(sh, true);
    case 'insect': return insect(sh);
    case 'flyer': return flyer(sh);
    case 'blob': return blob(sh);
    case 'serpent': return serpent(sh);
    case 'plant': return plant(sh);
    case 'machine': return machine(sh, !!opts.turret);
    case 'lump': return lump(sh);
  }
}

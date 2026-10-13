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

import type { HeldBuild } from './held';
import type { BodyShape, Weapon } from './archetype';
import { CRAWL_HEIGHT, type CrawlPlan } from '../../game/crawl';
import { ridePose, type HumanDims, type RideIn } from './ridePose';
import type { Shape } from './shapes';
import type { ZombieLook } from './zombieFamily';
import { zombieRig, type ZStyle } from './zombie';

export type Proj = 'front' | 'side';
/** Painted surface detail for close-up items. */
export type Detail = 'grain' | 'serration' | 'knurl' | 'tape' | 'port' | 'vent' | 'bevel' | 'metal' | 'stripes';
export type Role = 'dark' | 'main' | 'light' | 'accent' | 'skin' | 'wing';
export type Region = 'head' | 'neck' | 'torso' | 'hips' | 'upperArm' | 'foreArm' | 'hand' | 'thigh' | 'shin' | 'foot'
  | 'fpSleeveLower' | 'fpSleeveUpper' | 'fpBack' | 'fpPalm' | 'fpFinger' | 'fpThumb' | 'hair' | 'hat';
/**
 * Zombie-only surfaces (zombieSkin.ts): a hanging jaw, torn cloth, uniform pieces, glowing acid
 * sacs, bone, plant matter, smoke, electric arcs, raw flesh, necromancer tendrils.
 */
export type ZRegion = 'jaw' | 'belly' | 'rag' | 'gear' | 'visor' | 'sac' | 'bone' | 'plant' | 'thorn' | 'smoke' | 'arc' | 'flesh' | 'tendril';

export interface PartSrc {
  rect?: [number, number, number, number];
  proj?: Proj;
  /** flat palette colour instead of a sprite crop */
  role?: Role;
  /** a fixed colour (weapons) */
  color?: [number, number, number];
  /** surface detail painted over a flat colour (held items seen up close, paint.ts) */
  detail?: Detail;
  /**
   * What this part is on a person (styled painting, paint.ts paintStyled): the sprite gives
   * a semantic palette (skin, hair, shirt, pants, shoes, blood) and each region is painted
   * deliberately from it.
   */
  region?: Region;
  /** trim the crop to the columns that are mostly opaque (drop outstretched arms etc.) */
  core?: boolean;
  /** paint eyes on the front face (heads) */
  face?: boolean;
  /** paint a dark nose on the front face (muzzles) */
  nose?: boolean;
  /**
   * Arms: take the outer quarter of the mostly-opaque core of these rows, on this side of
   * the image (the model's right arm is the sprite's left). Outstretched sprite arms and
   * wielded-item overlays don't count as the body, so sleeves come from the shirt's edge.
   */
  edge?: 'left' | 'right';
  /** a zombie surface (zombieSkin.ts); painted with the person palette + the zombie look */
  zr?: ZRegion;
  /** 0..1: share of the painted colour the part emits (glowing sacs, eyes, arcs; charLayer) */
  glow?: number;
}

export interface PartDef {
  name: string;
  parent: number;
  joint: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
  rest?: [number, number, number];
  src: PartSrc;
  /**
   * Taper: cross-section scale at the box's -axis end (x, z for the y axis; x, y for z) and
   * its +axis end. [0.7, 0.7, 1, 1] on a hanging limb = narrower at the wrist/ankle.
   */
  taper?: [number, number, number, number];
  taperAxis?: 'y' | 'z';
  /** 'limb' parts get fattened for far readability; 'core' parts less */
  kind?: 'core' | 'limb' | 'thin';
  /** unit shape the box is drawn with (shapes.ts); default 'box' */
  shape?: Shape;
  /**
   * `zstyle=sprite3d`: a Blender-built mesh (`<model>/<part>`, chars/spriteModels.ts) drawn in
   * the box instead of the unit shape. It is authored in the box's unit frame, so the box (and
   * everything that reads it: poses, aim picking, rag dolls) is unchanged.
   */
  mesh?: string;
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
  /** Seated in a vehicle (humanoids): IK targets for hands and feet (ridePose.ts). */
  ride?: RideIn | null;
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
  /** skin texel density multiplier (1 = 32 texels/m); the first-person rig uses more */
  texels?: number;
  /** Humanoids: the joint layout the seated / riding pose solves against (ridePose.ts). */
  dims?: HumanDims;
  /** Zombie bodies (zombie.ts): the look the skin is painted for. */
  zlook?: ZombieLook;
  /** Extra skin-cache key: rigs whose parts paint differently with the same sizes. */
  skinTag?: string;
  /** `zstyle=sprite3d`: the Blender model the parts' `mesh` keys come from. */
  meshModel?: string;
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
export const ease = (k: number) => { const x = Math.min(1, Math.max(0, k)); return x * x * (3 - 2 * x); };

export function setRot(o: PoseOut, i: number, x: number, y = 0, z = 0): void {
  o.rot[i * 3] += x;
  o.rot[i * 3 + 1] += y;
  o.rot[i * 3 + 2] += z;
}

/** Scale every length in a part list (built at the archetype's reference size). */
export function scaleParts(parts: PartDef[], s: number): PartDef[] {
  const m = (v: [number, number, number]): [number, number, number] => [v[0] * s, v[1] * s, v[2] * s];
  return parts.map((p) => ({ ...p, joint: m(p.joint), size: m(p.size), center: m(p.center) }));
}

// ------------------------------------------------------------------ humanoid

/** Humanoid part indices (order of the parts list in humanoid()). Wings and a weapon follow. */
export const HUM = {
  hips: 0, torso: 1, head: 2, uArmR: 3, fArmR: 4, uArmL: 5, fArmL: 6,
  thighR: 7, shinR: 8, thighL: 9, shinL: 10, footR: 11, footL: 12, neck: 13, handR: 14, handL: 15,
} as const;

/** Per-individual 0..1 values from one seed (posture quirks in a horde). */
export function quirk(seed: number, k: number): number {
  const x = Math.sin(seed * 91.7 + k * 17.3) * 43758.5453;
  return x - Math.floor(x);
}

/** Weapon mesh lengths (m) by kind; held in the right fist, along the forearm's axis. */
const WEAPON: Record<Exclude<Weapon, 'none'>, { len: number; w: number; d: number; color: [number, number, number] }> = {
  pistol: { len: 0.2, w: 0.04, d: 0.12, color: [44, 46, 50] },
  rifle: { len: 0.85, w: 0.05, d: 0.1, color: [52, 50, 46] },
  long: { len: 0.8, w: 0.05, d: 0.05, color: [120, 88, 56] },
  short: { len: 0.3, w: 0.03, d: 0.05, color: [150, 152, 158] },
};

function humanoid(sh: BodyShape, held?: HeldBuild): Rig {
  const g = sh.girth, hd = sh.head;
  const hipY = 0.92;
  const torsoW = 0.38 * g, torsoD = 0.22 * Math.sqrt(g) * (g > 1.3 ? 1.25 : 1);
  const armW = 0.11 * Math.sqrt(g);
  const legW = 0.15 * Math.sqrt(g), legD = 0.16 * Math.sqrt(g);
  // hip joint at hipY - 0.06: thigh + shin + foot reach the floor
  const upperArm = 0.3, foreArm = 0.25, hand = 0.09, thigh = 0.41, shin = 0.38, footH = 0.07;
  const hipX = 0.095 * Math.min(g, 1.3);
  const shoulderX = torsoW / 2 + armW / 2 - 0.01;
  // a head is ~1/7.5 of a person's height (0.23 m of 1.75): bigger read as bobbleheads up close
  const headH = 0.23 * hd, headW = 0.2 * hd;
  // Two-segment limbs, fists and feet, a neck, tapered segments (wrists and ankles narrower,
  // shoulders wider than the waist): reads as a person, not a stack of planks. Indices: HUM.
  const parts: PartDef[] = [
    { name: 'hips', parent: -1, joint: [0, hipY, 0], size: [torsoW * 0.9, 0.16, torsoD * 0.95], center: [0, -0.02, 0], src: { rect: [0.2, 0.5, 0.8, 0.6], proj: 'front', core: true, region: 'hips' }, kind: 'core' },
    { name: 'torso', parent: 0, joint: [0, 0.06, 0], size: [torsoW, 0.46, torsoD], center: [0, 0.23, 0], taper: [0.8, 0.92, 1, 1], src: { rect: [0.15, 0.22, 0.85, 0.52], proj: 'front', core: true, region: 'torso' }, kind: 'core' },
    { name: 'head', parent: 1, joint: [0, 0.49, 0], size: [headW, headH, headW * 1.12], center: [0, headH / 2, 0], taper: [0.82, 0.88, 1, 1], src: { rect: [0.2, 0, 0.8, 0.22], proj: 'front', core: true, face: true, region: 'head' }, kind: 'core' },
    { name: 'uArmR', parent: 1, joint: [shoulderX, 0.42, 0], size: [armW, upperArm, armW], center: [0, -upperArm / 2 + 0.03, 0], taper: [0.85, 0.85, 1, 1], src: { rect: [0, 0.22, 1, 0.4], proj: 'front', edge: 'left', region: 'upperArm' }, kind: 'limb' },
    { name: 'fArmR', parent: 3, joint: [0, -upperArm + 0.04, 0], size: [armW * 0.88, foreArm, armW * 0.88], center: [0, -foreArm / 2, 0], taper: [0.78, 0.78, 1, 1], src: { rect: [0, 0.38, 1, 0.56], proj: 'front', edge: 'left', region: 'foreArm' }, kind: 'limb' },
    { name: 'uArmL', parent: 1, joint: [-shoulderX, 0.42, 0], size: [armW, upperArm, armW], center: [0, -upperArm / 2 + 0.03, 0], taper: [0.85, 0.85, 1, 1], src: { rect: [0, 0.22, 1, 0.4], proj: 'front', edge: 'right', region: 'upperArm' }, kind: 'limb' },
    { name: 'fArmL', parent: 5, joint: [0, -upperArm + 0.04, 0], size: [armW * 0.88, foreArm, armW * 0.88], center: [0, -foreArm / 2, 0], taper: [0.78, 0.78, 1, 1], src: { rect: [0, 0.38, 1, 0.56], proj: 'front', edge: 'right', region: 'foreArm' }, kind: 'limb' },
    { name: 'thighR', parent: 0, joint: [hipX, -0.06, 0], size: [legW, thigh, legD], center: [0, -thigh / 2, 0], taper: [0.82, 0.85, 1, 1], src: { rect: [0.1, 0.56, 0.5, 0.76], proj: 'front', core: true, region: 'thigh' }, kind: 'limb' },
    { name: 'shinR', parent: 7, joint: [0, -thigh, 0], size: [legW * 0.86, shin, legD * 0.86], center: [0, -shin / 2, 0], taper: [0.75, 0.8, 1, 1], src: { rect: [0.1, 0.74, 0.5, 0.94], proj: 'front', core: true, region: 'shin' }, kind: 'limb' },
    { name: 'thighL', parent: 0, joint: [-hipX, -0.06, 0], size: [legW, thigh, legD], center: [0, -thigh / 2, 0], taper: [0.82, 0.85, 1, 1], src: { rect: [0.5, 0.56, 0.9, 0.76], proj: 'front', core: true, region: 'thigh' }, kind: 'limb' },
    { name: 'shinL', parent: 9, joint: [0, -thigh, 0], size: [legW * 0.86, shin, legD * 0.86], center: [0, -shin / 2, 0], taper: [0.75, 0.8, 1, 1], src: { rect: [0.5, 0.74, 0.9, 0.94], proj: 'front', core: true, region: 'shin' }, kind: 'limb' },
    { name: 'footR', parent: 8, joint: [0, -shin, 0], size: [legW * 0.92, footH, 0.25], center: [0, -footH / 2 + 0.005, -0.05], taper: [1, 0.75, 1, 1.1], taperAxis: 'z', src: { rect: [0.1, 0.9, 0.5, 1], proj: 'front', core: true, region: 'foot' }, kind: 'limb' },
    { name: 'footL', parent: 10, joint: [0, -shin, 0], size: [legW * 0.92, footH, 0.25], center: [0, -footH / 2 + 0.005, -0.05], taper: [1, 0.75, 1, 1.1], taperAxis: 'z', src: { rect: [0.5, 0.9, 0.9, 1], proj: 'front', core: true, region: 'foot' }, kind: 'limb' },
    { name: 'neck', parent: 1, joint: [0, 0.45, 0], size: [0.1 * Math.sqrt(g), 0.07, 0.1 * Math.sqrt(g)], center: [0, 0.03, 0], src: { rect: [0.4, 0.18, 0.6, 0.24], proj: 'front', region: 'neck' }, kind: 'core' },
    { name: 'handR', parent: 4, joint: [0, -foreArm, 0], size: [armW * 0.95, hand, armW * 1.05], center: [0, -hand / 2 + 0.01, 0], taper: [0.85, 0.85, 1, 1], src: { rect: [0, 0.5, 0.2, 0.58], proj: 'front', region: 'hand' }, kind: 'limb' },
    { name: 'handL', parent: 6, joint: [0, -foreArm, 0], size: [armW * 0.95, hand, armW * 1.05], center: [0, -hand / 2 + 0.01, 0], taper: [0.85, 0.85, 1, 1], src: { rect: [0.8, 0.5, 1, 0.58], proj: 'front', region: 'hand' }, kind: 'limb' },
  ];
  let wingR = -1, wingL = -1, weaponI = -1;
  if (sh.wings !== 'none') {
    wingR = parts.length;
    wingL = parts.length + 1;
    parts.push(
      { name: 'wingR', parent: 1, joint: [0.08, 0.38, 0.12], size: [0.7, 0.5, 0.03], center: [0.35, 0.05, 0], rest: [0, -0.4, 0.3], src: { role: 'wing' }, kind: 'thin' },
      { name: 'wingL', parent: 1, joint: [-0.08, 0.38, 0.12], size: [0.7, 0.5, 0.03], center: [-0.35, 0.05, 0], rest: [0, 0.4, -0.3], src: { role: 'wing' }, kind: 'thin' },
    );
  }
  const weapon = sh.weapon ?? 'none';
  if (weapon !== 'none') {
    const wd = WEAPON[weapon];
    weaponI = parts.length;
    // along the fist's -y (the forearm's line): a gun held out points forward, a bat hangs
    if (held) {
      // Separate grip pivot keeps the complete item under the existing weapon pose/stow
      // transform. Guns point -z; melee items grow +y, unlike the old hanging -y box.
      const gunPose = weapon === 'rifle' || weapon === 'pistol';
      parts.push({ name: 'weapon', parent: HUM.handR, joint: [0, -hand * 0.6, 0], size: [0.005, 0.005, 0.005], center: [0, 0, 0], rest: [gunPose ? -Math.PI / 2 : Math.PI, 0, 0], src: { color: wd.color }, kind: 'thin' });
      const offset = parts.length;
      for (const part of held.parts) parts.push({ ...part, name: `weapon:${part.name}`, parent: part.parent < 0 ? weaponI : offset + part.parent });
    } else {
      parts.push({ name: 'weapon', parent: HUM.handR, joint: [0, -hand * 0.6, 0], size: [wd.w, wd.len, wd.d], center: [0, -wd.len / 2 + (weapon === 'long' ? 0.15 : 0.04), 0], src: { color: wd.color }, kind: 'thin' });
    }
  }
  // Zombie variants that should read at a glance (docs/CHARACTERS.md round 6)
  const feat = sh.variant ?? '';
  if (feat === 'bloated') {
    // a boomer: a huge distended belly and a bloated neck
    parts.push({ name: 'belly', parent: HUM.torso, joint: [0, 0.12, -torsoD * 0.3], size: [torsoW * 1.25, 0.42, torsoD * 1.4], center: [0, 0, -torsoD * 0.25], taper: [0.8, 0.85, 1, 1], src: { region: 'torso' }, kind: 'core' });
    parts.push({ name: 'jowls', parent: HUM.neck, joint: [0, 0.03, -0.02], size: [0.2, 0.08, 0.17], center: [0, 0, 0], src: { region: 'neck' }, kind: 'core' });
  } else if (feat === 'hulk') {
    // hunched mass of muscle: a hump behind the head, forearms like logs, huge fists
    parts.push({ name: 'hump', parent: HUM.torso, joint: [0, 0.42, torsoD * 0.35], size: [torsoW * 0.85, 0.22, torsoD * 0.7], center: [0, 0, 0], src: { region: 'torso' }, kind: 'core' });
    for (const [fa, hand] of [[HUM.fArmR, HUM.handR], [HUM.fArmL, HUM.handL]] as const) {
      parts[fa] = { ...parts[fa], size: [parts[fa].size[0] * 1.6, parts[fa].size[1] * 1.15, parts[fa].size[2] * 1.6], center: [0, -parts[fa].size[1] * 0.575, 0], taper: [1.2, 1.2, 0.9, 0.9] };
      parts[hand] = { ...parts[hand], joint: [0, -foreArm * 1.15, 0], size: [parts[hand].size[0] * 1.8, parts[hand].size[1] * 1.6, parts[hand].size[2] * 1.8] };
    }
  } else if (feat === 'skeletal') {
    // thin as bone: limbs pared down, a narrow torso with the ribs showing (bone-coloured bars)
    for (const i of [HUM.uArmR, HUM.fArmR, HUM.uArmL, HUM.fArmL, HUM.thighR, HUM.shinR, HUM.thighL, HUM.shinL]) parts[i] = { ...parts[i], size: [parts[i].size[0] * 0.6, parts[i].size[1], parts[i].size[2] * 0.6] };
    parts[HUM.torso] = { ...parts[HUM.torso], size: [torsoW * 0.8, 0.46, torsoD * 0.75] };
    for (let r = 0; r < 4; r++) parts.push({ name: `rib${r}`, parent: HUM.torso, joint: [0, 0.18 + r * 0.065, -torsoD * 0.39], size: [torsoW * 0.78, 0.022, 0.02], center: [0, 0, 0], src: { color: [206, 196, 170] }, kind: 'thin' });
  } else if (feat === 'acid') {
    // glowing green pustules on the shoulders and back
    const pus: [number, number, number, number][] = [[0.14, 0.44, 0.05, 0.08], [-0.12, 0.4, 0.08, 0.07], [0.02, 0.3, 0.12, 0.09], [-0.1, 0.18, 0.11, 0.06], [0.12, 0.2, 0.1, 0.05]];
    for (const [i, [x, y, z, r]] of pus.entries()) parts.push({ name: `pustule${i}`, parent: HUM.torso, joint: [x * g, y, z], size: [r, r, r], center: [0, 0, 0], rest: [0.5, 0.7, 0], src: { color: [150, 230, 60] }, kind: 'thin' });
  } else if (feat === 'shocker') {
    // crackling blue spines along the head and spine
    for (let i = 0; i < 4; i++) parts.push({ name: `spine${i}`, parent: i === 0 ? HUM.head : HUM.torso, joint: i === 0 ? [0, headH * 0.95, 0] : [0, 0.46 - i * 0.12, torsoD * 0.5], size: [0.02, 0.1, 0.02], center: [0, 0.05, 0], rest: [i === 0 ? -0.2 : 0.7, 0, 0], taper: [1, 1, 0.2, 0.2], src: { color: [120, 200, 255] }, kind: 'thin' });
  } else if (feat === 'charred') {
    // burnt: black crusted flakes stand off the body
    for (let i = 0; i < 5; i++) parts.push({ name: `char${i}`, parent: i < 3 ? HUM.torso : HUM.head, joint: [((i * 37) % 7 - 3) * 0.04, 0.1 + ((i * 13) % 5) * 0.08, -torsoD * 0.5], size: [0.07, 0.05, 0.02], center: [0, 0, 0], rest: [0, 0, i * 0.7], src: { color: [26, 22, 20] }, kind: 'thin' });
  }
  // hair and headgear (NPC variety): pieces on the head, painted in the person's hair/hat colour
  const hw = headW, hh = headH, hd2 = headW * 1.12;
  switch (sh.hair) {
    case 'long':
      parts.push({ name: 'headHairBack', parent: HUM.head, joint: [0, hh * 0.85, hd2 * 0.45], size: [hw * 1.08, hh * 1.25, 0.05], center: [0, -hh * 0.55, 0], rest: [0.12, 0, 0], src: { region: 'hair' }, kind: 'thin' });
      parts.push({ name: 'headHairTop', parent: HUM.head, joint: [0, hh, 0.01], size: [hw * 1.08, 0.04, hd2 * 1.04], center: [0, 0, 0], src: { region: 'hair' }, kind: 'thin' });
      break;
    case 'ponytail':
      parts.push({ name: 'headHairTop', parent: HUM.head, joint: [0, hh, 0.01], size: [hw * 1.06, 0.035, hd2 * 1.02], center: [0, 0, 0], src: { region: 'hair' }, kind: 'thin' });
      parts.push({ name: 'headTail', parent: HUM.head, joint: [0, hh * 0.75, hd2 * 0.5], size: [0.05, 0.2, 0.05], center: [0, -0.09, 0.02], rest: [0.3, 0, 0], taper: [0.6, 0.6, 1, 1], src: { region: 'hair' }, kind: 'thin' });
      break;
    case 'short':
      parts.push({ name: 'headHairTop', parent: HUM.head, joint: [0, hh, 0.012], size: [hw * 1.06, 0.04, hd2 * 1.02], center: [0, 0, 0], src: { region: 'hair' }, kind: 'thin' });
      break;
    case 'cap':
      parts.push({ name: 'headCap', parent: HUM.head, joint: [0, hh * 0.92, 0], size: [hw * 1.08, hh * 0.3, hd2 * 1.06], center: [0, 0.02, 0], taper: [1, 1, 0.9, 0.9], src: { region: 'hat' }, kind: 'thin' });
      parts.push({ name: 'headBrim', parent: HUM.head, joint: [0, hh * 0.86, -hd2 * 0.5], size: [hw * 0.95, 0.015, 0.08], center: [0, 0, -0.035], rest: [-0.1, 0, 0], src: { region: 'hat' }, kind: 'thin' });
      break;
    case 'hat':
      parts.push({ name: 'headCrown', parent: HUM.head, joint: [0, hh * 0.9, 0], size: [hw * 1.02, hh * 0.45, hd2 * 1.0], center: [0, 0.05, 0], taper: [1, 1, 0.85, 0.85], src: { region: 'hat' }, kind: 'thin' });
      parts.push({ name: 'headBrim', parent: HUM.head, joint: [0, hh * 0.9, 0], size: [hw * 1.9, 0.015, hd2 * 1.8], center: [0, 0, 0], src: { region: 'hat' }, kind: 'thin' });
      break;
    case 'helmet':
      parts.push({ name: 'headHelmet', parent: HUM.head, joint: [0, hh * 0.55, 0], size: [hw * 1.18, hh * 0.62, hd2 * 1.16], center: [0, hh * 0.25, 0], taper: [1, 1, 0.8, 0.8], src: { region: 'hat' }, kind: 'thin' });
      break;
  }
  const s = sh.scale;
  const crawl = sh.crawl ?? null;
  const height = (hipY + 0.06 + 0.49 + headH) * s * (crawl ? CRAWL_HEIGHT[crawl] : 1);
  const zombie = sh.zombie;
  // (hand centre: the fist's box is centred hand/2 - 0.01 past the wrist)
  const dims: HumanDims = {
    hipY: hipY * s, hipX: hipX * s, thighDy: -0.06 * s, torsoDy: 0.06 * s, shoulderX: shoulderX * s, shoulderY: 0.42 * s,
    upperArm: (upperArm - 0.04) * s, foreArm: (foreArm + hand / 2 - 0.01) * s, thigh: thigh * s, shin: shin * s,
  };
  return {
    shape: sh, parts: scaleParts(parts, s), height, hover: sh.flies ? 0.6 * s : 0, dims,
    // a crawler is already on the ground: downed or dead, it slumps a little onto its side
    // (its pose is the prone body) instead of toppling a standing one
    lie: crawl ? { angle: 0.3, lift: 0, side: true } : { angle: Math.PI / 2, lift: torsoD * 0.5 * s, side: false },
    pose(p, o) {
      const H = HUM;
      if (crawl && !p.ride) {
        crawlPose(crawl, p, o, s, hipY, weaponI);
        if (weaponI >= 0) o.scl.fill(0, weaponI * 3, (weaponI + 1 + (held?.parts.length ?? 0)) * 3);
        return;
      }
      if (p.ride) {
        ridePose(p.ride, dims, H, o.rot);
        // both hands are on the controls: the weapon is stowed (not drawn) while riding
        if (weaponI >= 0) o.scl.fill(0, weaponI * 3, (weaponI + 1 + (held?.parts.length ?? 0)) * 3);
        return;
      }
      const ph = p.phase * TAU;
      const walk = Math.min(1, p.gait);
      const run = Math.max(0, p.gait - 1);
      const amp = walk * 0.45 + run * 0.35;
      if (p.dead) {
        // a corpse: limp, arms flung out sideways, legs a little apart, head lolled. Nothing
        // points at the sky (a lying body's "forward" is up).
        setRot(o, H.head, 0.1, 0.6 * (p.seed - 0.5), 0.5 * (p.seed - 0.5));
        setRot(o, H.uArmR, 0.1, 0, 0.9 + 0.5 * p.seed);
        setRot(o, H.fArmR, 0.2 * p.seed);
        setRot(o, H.uArmL, 0.15 * (1 - p.seed), 0, -(0.7 + 0.6 * (1 - p.seed)));
        setRot(o, H.fArmL, 0.25);
        setRot(o, H.thighR, -0.05, 0, 0.14);
        setRot(o, H.thighL, 0.05, 0, -0.1);
        setRot(o, H.shinR, -0.1);
        // feet pointed along the legs (a lying body's toes would otherwise stand up 25 cm)
        setRot(o, H.footR, 1.1, 0, 0.2);
        setRot(o, H.footL, 1.1, 0, -0.2);
        return;
      }
      // zombie quirks, fixed per individual: a hunch, a head tilt, a dragging arm
      const hunch = zombie ? 0.1 + 0.2 * quirk(p.seed, 1) : 0;
      const tilt = zombie ? (quirk(p.seed, 2) - 0.5) * 0.6 : 0;
      const drag = zombie && quirk(p.seed, 3) < 0.35;
      const limp = zombie ? 0.15 * quirk(p.seed, 4) : 0;
      // legs: opposite swing, the knee folds while the leg swings through, the foot stays
      // roughly flat; the body dips at each foot fall
      for (const [thighI, shinI, footI, off, k] of [[H.thighR, H.shinR, H.footR, 0, 1], [H.thighL, H.shinL, H.footL, Math.PI, 1 - limp * 2]] as const) {
        const a = sin(ph + off) * amp * k;
        const knee = -Math.max(0, cos(ph + off)) * (amp * 1.3 + run * 0.4) * k;
        setRot(o, thighI, a);
        setRot(o, shinI, knee);
        setRot(o, footI, -(a + knee) * 0.7);
      }
      o.pos[1] -= Math.abs(sin(ph)) * 0.04 * walk * s;
      if (zombie && walk > 0) {
        // a shamble, not a walk: the body lurches onto the good leg and sways side to side,
        // by an amount that differs per zombie
        const lurch = 0.06 + 0.1 * quirk(p.seed, 6);
        o.lean[2] += sin(ph) * lurch * walk;
        o.pos[0] += sin(ph) * 0.03 * walk * s;
        setRot(o, H.head, 0, 0, -sin(ph) * lurch * 0.8 * walk);
      }
      // idle: slow breathing sway (zombies loll their heads)
      const idle = sin(p.t * 1.7 + p.seed * TAU);
      setRot(o, H.torso, -hunch - 0.03 * idle * (zombie ? 1 : 0.4) - run * 0.25, 0, zombie ? 0.05 * sin(ph * 0.5 + p.seed * 6) + (quirk(p.seed, 5) - 0.5) * 0.12 : 0);
      setRot(o, H.head, zombie ? 0.12 + 0.08 * idle : 0.02 * idle, zombie ? 0.1 * sin(p.t * 0.9 + p.seed * 9) : 0, tilt);
      // arms: zombies reach out, uneven, hands drooping (one may hang and drag); people swing
      // them against the legs; armed people hold their weapon
      let reachR = zombie ? 1.3 + 0.12 * sin(ph + 1) + 0.06 * idle : 0;
      let reachL = zombie ? (drag ? 0.15 + 0.1 * sin(ph + 2.2) : 1.15 + 0.12 * sin(ph + 2.2) - 0.05 * idle) : 0;
      if (zombie) {
        setRot(o, H.uArmR, reachR, 0, -0.08);
        setRot(o, H.uArmL, reachL, 0, drag ? -0.08 : 0.1);
        setRot(o, H.fArmR, -0.25 + 0.1 * sin(p.t * 1.3 + p.seed * 4));
        setRot(o, H.fArmL, drag ? 0.1 : -0.35 + 0.1 * sin(p.t * 1.1 + p.seed * 7));
      } else if (weapon === 'rifle' || weapon === 'pistol') {
        // weapon at the ready: right forearm level, left hand supporting
        reachR = 1.0;
        setRot(o, H.uArmR, 0.35, 0, 0.1);
        setRot(o, H.fArmR, 1.1);
        setRot(o, H.uArmL, weapon === 'rifle' ? 0.6 : 0.4, 0, -0.35);
        setRot(o, H.fArmL, 0.9);
        setRot(o, weaponI, -0.1);
      } else {
        setRot(o, H.uArmR, -sin(ph) * amp * 0.9 + run * 0.2, 0, 0.06);
        setRot(o, H.uArmL, sin(ph) * amp * 0.9 + run * 0.2, 0, -0.06);
        setRot(o, H.fArmR, 0.15 + walk * 0.25 + run * 0.9);
        setRot(o, H.fArmL, 0.15 + walk * 0.25 + run * 0.9);
        if (weaponI >= 0) setRot(o, weaponI, weapon === 'long' ? 1.2 : 1.4);
      }
      if (wingR >= 0) {
        const f = sin(p.t * 9 + p.seed * 5) * 0.6;
        setRot(o, wingR, 0, 0, f);
        setRot(o, wingL, 0, 0, -f);
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
          setRot(o, H.torso, (0.28 + 0.12 * heavy + hunch) * u);
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
      if (p.down > 0) {
        // lying on the back: arms fall to the sides
        const d = p.down;
        setRot(o, H.uArmR, -reachR * d, 0, 0.5 * d);
        setRot(o, H.uArmL, -reachL * d, 0, -0.5 * d);
        setRot(o, H.thighR, 0, 0, 0.15 * d);
        setRot(o, H.thighL, 0, 0, -0.15 * d);
        setRot(o, H.footR, 1.1 * d);
        setRot(o, H.footL, 1.1 * d);
      }
    },
  };
}

// ------------------------------------------------------------------ crawling humanoids

/**
 * A humanoid that crawls (archetype.ts `crawl`, from game/crawl.ts). Same parts as the walker
 * (so the sprite-painted skin still fits), posed prone: the hips pitch the whole body forward,
 * which lays the torso along the ground with the legs trailing behind; the root drops so the
 * belly is just off the floor and moves back so the body is centred on the creature's tile.
 *
 *  - 'drag': arms reach forward in turn, plant the forearm, and pull the body up to it (a
 *    surge and a roll per stroke); the legs drag limp.
 *  - 'legless': the same with no legs (the half-corpse pupa).
 *  - 'fours': on hands and knees, diagonal limbs together like a trot (the creepy crawler).
 *
 * Rotations: +x on a hanging limb swings it forward; in the pitched torso "forward" is down,
 * so an arm at +θ (θ = the hip pitch) hangs straight down and at ~2.9 lies along the ground
 * ahead (docs/MONSTER_PLACEMENT.md "Crawlers").
 */
export function crawlPose(plan: CrawlPlan, p: PoseIn, o: PoseOut, s: number, hipY: number, weaponI: number): void {
  const H = HUM;
  const fours = plan === 'fours';
  // body pitch: drag/legless nearly flat with the chest a little raised; fours a level back
  const th = fours ? 1.25 : 1.36;
  // hip joint height off the floor (m, before scale): fours on the knees, else at belly height
  const hipH = fours ? 0.47 : 0.17;
  const ph = p.phase * TAU;
  // slow movers still crawl visibly: a crawler's 0.3 m/s is a full stroke, not a 0.2 gait
  const move = Math.min(1, p.gait * 3);
  const idle = sin(p.t * 1.3 + p.seed * TAU);
  setRot(o, H.hips, -th);
  o.pos[1] -= (hipY - hipH) * s;
  // centre the torso (not the hips) over the creature's spot
  o.pos[2] += (fours ? 0.15 : 0.32) * s;
  // head up to look ahead (it is on the pitched torso)
  setRot(o, H.head, th * (fours ? 0.75 : 0.85) + 0.08 * idle, 0.15 * sin(p.t * 0.7 + p.seed * 5), (quirk(p.seed, 2) - 0.5) * 0.4);
  setRot(o, H.neck, 0.2);
  if (plan === 'legless') for (const i of [H.thighR, H.shinR, H.footR, H.thighL, H.shinL, H.footL]) o.scl.fill(0, i * 3, i * 3 + 3);
  if (weaponI >= 0) o.scl.fill(0, weaponI * 3, weaponI * 3 + 3);

  if (p.dead) {
    // flat on its face (no chest raised), arms flung forward and out, head turned aside
    setRot(o, H.hips, -(Math.PI / 2 - th));
    o.pos[1] -= (fours ? 0.33 : 0.03) * s;
    setRot(o, H.head, -0.7, 0.9 * (p.seed - 0.5) * 2, 0);
    setRot(o, H.uArmR, 2.95, 0, 0.6);
    setRot(o, H.uArmL, 2.85, 0, -0.7);
    setRot(o, H.fArmR, 0.1);
    setRot(o, H.fArmL, 0.05);
    setRot(o, H.thighR, 0, 0, 0.12);
    setRot(o, H.thighL, 0, 0, -0.1);
    setRot(o, H.footR, -1.45);
    setRot(o, H.footL, -1.45);
    return;
  }

  if (fours) {
    // hands and knees: arms and thighs straight down (+θ), shins folded back along the floor;
    // diagonal pairs swing together
    const a = 0.35 * move;
    setRot(o, H.uArmR, th + sin(ph) * a, 0, -0.05);
    setRot(o, H.uArmL, th - sin(ph) * a, 0, 0.05);
    setRot(o, H.fArmR, 0.1 + Math.max(0, cos(ph)) * 0.4 * move);
    setRot(o, H.fArmL, 0.1 + Math.max(0, -cos(ph)) * 0.4 * move);
    setRot(o, H.thighR, th - sin(ph) * a, 0, 0.06);
    setRot(o, H.thighL, th + sin(ph) * a, 0, -0.06);
    // (shins stay level with the floor as the thighs swing: knees slide, shins don't dig in)
    setRot(o, H.shinR, -Math.PI / 2 - 0.05 + sin(ph) * a);
    setRot(o, H.shinL, -Math.PI / 2 - 0.05 - sin(ph) * a);
    // toes back along the shins, flat on the floor
    setRot(o, H.footR, -1.45);
    setRot(o, H.footL, -1.45);
    // a scuttle: hips sway, a jerky bob
    setRot(o, H.torso, 0, 0, sin(ph) * 0.08 * move);
    o.pos[1] += Math.abs(sin(ph)) * 0.025 * move * s;
  } else {
    // two strokes per cycle, one per arm. Each: reach (forearm lifted, arm swinging forward),
    // plant, pull (upper arm sweeps back under the chest while the forearm stays flat, the
    // body surging forward and rolling toward the pulling arm)
    for (const [ua, fa, off, side] of [[H.uArmR, H.fArmR, 0, 1], [H.uArmL, H.fArmL, Math.PI, -1]] as const) {
      const u = ((ph + off) / TAU) % 1;
      // 0..0.6 pull: alpha 2.7 -> 2.1; 0.6..1 reach: back to 2.7 with the forearm raised
      const pull = u < 0.6;
      const k = pull ? u / 0.6 : (u - 0.6) / 0.4;
      const restA = 2.45 + 0.1 * sin(p.t * 0.9 + p.seed * 4 + off);
      const alpha = move > 0 ? restA + move * (pull ? 0.25 - 0.6 * k : -0.35 + 0.6 * k) : restA;
      // forearm flat on the floor (alpha + beta ~ 3.05: a touch down, hands on the floor)
      // while pulling; lifted while reaching
      const lift = !pull ? sin(k * Math.PI) * 0.6 * move : 0;
      setRot(o, ua, alpha, 0, -0.18 * side);
      setRot(o, fa, 3.05 - alpha + lift);
      setRot(o, ua === H.uArmR ? H.handR : H.handL, -0.4);
    }
    // surge forward twice per cycle (one per stroke) and roll toward the pulling side
    o.pos[2] -= (Math.abs(sin(ph)) - 0.5) * 0.06 * move * s;
    o.lean[2] += sin(ph) * 0.07 * move + 0.02 * idle;
    // the legs drag: limp, splayed a little, twitching with the pulls; toes trail down
    if (plan === 'drag') {
      const tw = sin(ph * 2) * 0.05 * move;
      setRot(o, H.thighR, -0.06 + tw, 0, 0.12 + 0.05 * quirk(p.seed, 4));
      setRot(o, H.thighL, -0.08 - tw, 0, -0.1);
      setRot(o, H.shinR, -0.1);
      setRot(o, H.shinL, -0.1 - 0.2 * quirk(p.seed, 3));
      setRot(o, H.footR, -1.45);
      setRot(o, H.footL, -1.45);
    }
  }
  if (p.windup !== null) {
    // rear up on the arms, head back, ready to lunge and bite
    const u = ease(p.windup);
    setRot(o, H.hips, 0.35 * u);
    // (the legs stay on the floor: undo the hip rotation on them)
    setRot(o, H.thighR, -0.35 * u);
    setRot(o, H.thighL, -0.35 * u);
    setRot(o, H.uArmR, -0.5 * u);
    setRot(o, H.uArmL, -0.5 * u);
    setRot(o, H.head, -0.3 * u);
    o.pos[2] += 0.08 * u * s;
  }
  if (p.strike > 0) {
    // the lunge: chest thrown forward and down, both hands grabbing ahead
    const k = p.strike;
    setRot(o, H.uArmR, 0.3 * k);
    setRot(o, H.uArmL, 0.3 * k);
    setRot(o, H.hips, -0.1 * k);
    o.pos[2] -= 0.2 * k * s;
  }
  if (p.flinch > 0) {
    setRot(o, H.head, -0.4 * p.flinch, 0, 0.3 * p.flinch * (p.seed > 0.5 ? 1 : -1));
    o.lean[2] += 0.15 * p.flinch;
  }
  if (p.down > 0) {
    // knocked flat: arms out, face on the floor
    const d = p.down;
    setRot(o, H.hips, 0.15 * d);
    setRot(o, H.uArmR, 0.2 * d, 0, 0.5 * d);
    setRot(o, H.uArmL, 0.2 * d, 0, -0.5 * d);
    setRot(o, H.head, -0.5 * d);
  }
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
    // deep chest, narrow loins (taper along the body)
    { name: 'body', parent: -1, joint: [0, bodyY, 0], size: [bw, bh, bl], center: [0, 0, 0], taper: [1.05, 1.08, 0.82, 0.84], taperAxis: 'z', src: { rect: [0.15, 0.2, 0.8, 0.65], proj: 'side', core: true }, kind: 'core' },
    { name: 'head', parent: 0, joint: [0, bh * 0.35, -bl / 2], size: [hs * 0.9, hs, hs * 0.95], center: [0, hs * 0.35, -hs * 0.35], taper: [0.85, 0.85, 1, 1], taperAxis: 'z', src: { rect: [0.68, 0, 1, 0.45], proj: 'side', core: true, face: true }, kind: 'core' },
    { name: 'legFR', parent: 0, taper: [0.75, 0.75, 1, 1], joint: [bw / 2 - legW / 2, -bh / 2 + 0.02, -bl / 2 + legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.6, 0.55, 0.85, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'legFL', parent: 0, taper: [0.75, 0.75, 1, 1], joint: [-bw / 2 + legW / 2, -bh / 2 + 0.02, -bl / 2 + legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.6, 0.55, 0.85, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'legBR', parent: 0, taper: [0.75, 0.75, 1, 1], joint: [bw / 2 - legW / 2, -bh / 2 + 0.02, bl / 2 - legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.1, 0.55, 0.4, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'legBL', parent: 0, taper: [0.75, 0.75, 1, 1], joint: [-bw / 2 + legW / 2, -bh / 2 + 0.02, bl / 2 - legW], size: [legW, leg, legW], center: [0, -leg / 2, 0], src: { rect: [0.1, 0.55, 0.4, 1], proj: 'side', core: true }, kind: 'limb' },
    { name: 'tail', parent: 0, joint: [0, bh * 0.3, bl / 2], size: [legW * 0.8, legW * 0.8, bl * 0.42], center: [0, 0, bl * 0.2], rest: [0.6, 0, 0], taper: [1, 1, 0.45, 0.45], taperAxis: 'z', src: { rect: [0, 0.15, 0.2, 0.45], proj: 'side' }, kind: 'thin' },
    { name: 'earR', parent: 1, joint: [hs * 0.3, hs * 0.8, -hs * 0.1], size: [hs * 0.22, hs * (critter && L > 1.1 ? 1.2 : 0.4), hs * 0.12], center: [0, hs * 0.2, 0], rest: [-0.2, 0, -0.2], src: { rect: [0.7, 0, 0.95, 0.2], proj: 'side' }, kind: 'thin' },
    { name: 'earL', parent: 1, joint: [-hs * 0.3, hs * 0.8, -hs * 0.1], size: [hs * 0.22, hs * (critter && L > 1.1 ? 1.2 : 0.4), hs * 0.12], center: [0, hs * 0.2, 0], rest: [-0.2, 0, 0.2], src: { rect: [0.7, 0, 0.95, 0.2], proj: 'side' }, kind: 'thin' },
    // a tapered muzzle with a dark nose (dogs, deer, bears; short on critters)
    { name: 'snout', parent: 1, joint: [0, hs * 0.18, -hs * 0.8], size: [hs * 0.55, hs * 0.5, hs * (critter ? 0.35 : 0.6)], center: [0, 0, -hs * (critter ? 0.17 : 0.3)], taper: [0.7, 0.75, 1, 1], taperAxis: 'z', src: { rect: [0.85, 0.12, 1, 0.45], proj: 'side', core: true, nose: true }, kind: 'core' },
  ];
  const family = critter ? '' : sh.variant;
  const append = (name: string, parent: number, joint: PartDef['joint'], size: PartDef['size'], center: PartDef['center'], opts: Partial<PartDef> = {}) => {
    parts.push({ name, parent, joint, size, center, src: { rect: [0.15, 0.2, 0.8, 0.65], proj: 'side', core: true }, kind: 'core', ...opts });
  };
  if (family === 'equine' || family === 'cervid') {
    const equine = family === 'equine';
    const neck = equine ? 0.20 : 0.15;
    parts[1].joint = [0, bh * 0.35 + neck, -bl / 2 - 0.06];
    parts[1].size = [hs * 0.72, hs * (equine ? 1.2 : 0.95), hs * 1.15];
    append('neck', 0, [0, bh * 0.3, -bl * 0.46], [bw * 0.65, neck + 0.1, 0.19], [0, neck * 0.5, -0.015], { rest: [-0.3, 0, 0] });
    for (const i of [7,8]) parts[i] = { ...parts[i], size: [hs * 0.25, hs * 0.65, hs * 0.12], center: [0, hs * 0.32, 0], taper: [0.1, 0.3, 1, 1], taperAxis: 'y' };
    parts[6] = { ...parts[6], size: [legW * 0.65, legW * 0.65, equine ? 0.42 : 0.10], center: [0, 0, equine ? 0.19 : 0.04], rest: [equine ? 1.15 : 0.45,0,0] };
    if (equine) append('mane', 0, [0, bh * 0.38, -bl * 0.38], [0.065, neck + 0.1, 0.05], [0, neck * 0.5, 0.02], { src: { color: [48,42,34] }, rest: [-0.3,0,0], kind: 'thin' });
  } else if (family === 'bear') {
    parts[6] = { ...parts[6], size: [0.045,0.045,0.07], center: [0,0,0.03], rest: [0.2,0,0] };
    for (const i of [7,8]) parts[i] = { ...parts[i], size: [hs * 0.36,hs * 0.32,hs * 0.24], center: [0,hs * 0.12,0], rest: [0,0,0] };
    append('shoulderHump',0,[0,bh * 0.42,-bl * 0.20],[bw * 0.92,0.16,0.26],[0,0.02,0],{ taper: [0.8,0.8,1,1], taperAxis:'y' });
  } else if (family === 'pig') {
    parts[9] = { ...parts[9], size:[hs * 0.85,hs * 0.6,hs * 0.5], center:[0,0,-hs * 0.22] };
    append('nosePad',9,[0,0,-hs * 0.50],[hs * 0.86,hs * 0.55,0.015],[0,0,0],{src:{color:[170,112,102]}});
    parts[6] = { ...parts[6], size:[0.028,0.028,0.075], center:[0,0,0.035], rest:[0.2,0,0] };
    append('tailCurl',6,[0,0,0.07],[0.025,0.07,0.025],[0,0.025,0],{kind:'thin'});
  } else if (family === 'reptile') {
    parts[1] = { ...parts[1], joint:[0,bh * 0.10,-bl * 0.48], size:[hs * 1.05,hs * 0.50,hs * 1.5], center:[0,0,-hs * 0.5] };
    parts[9] = { ...parts[9], joint:[0,-hs * 0.05,-hs * 1.1], size:[hs * 0.85,hs * 0.35,hs * 1.2], center:[0,0,-hs * 0.55] };
    for (const i of [7,8]) parts[i].size = [0.001,0.001,0.001];
    parts[6] = { ...parts[6], joint:[0,0,bl / 2], size:[bw * 0.75,bh * 0.7,bl * 0.7], center:[0,0,bl * 0.32], rest:[0,0,0] };
    append('tailTip',6,[0,0,bl * 0.64],[bw * 0.30,bh * 0.3,bl * 0.5],[0,0,bl * 0.22],{taper:[1,1,0.05,0.05],taperAxis:'z',kind:'thin'});
    for (let i=2;i<6;i++) parts[i].joint[0] *= 1.35;
    for (let i=0;i<5;i++) append(`backPlate${i}`,0,[0,bh * 0.55,-bl * 0.35+i * bl * 0.16],[bw * 0.6,0.045,0.045],[0,0,0],{taper:[0.2,0.3,1,1],taperAxis:'y',kind:'thin'});
  } else if (family === 'feline') {
    parts[9] = { ...parts[9], size:[hs * 0.6,hs * 0.4,hs * 0.22], center:[0,0,-hs * 0.10] };
    parts[6] = { ...parts[6], size:[legW * 0.45,legW * 0.45,bl * 0.65], center:[0,0,bl * 0.31], rest:[0.1,0,0] };
  }
  const hooved = family === 'equine' || family === 'cervid' || family === 'pig';
  if (hooved || family === 'bear' || family === 'feline') for (let i=2;i<6;i++) {
    const split = family === 'cervid' || family === 'pig';
    for (const side of split ? [-1,1] : [0]) append(`${split ? 'clovenHoof' : hooved ? 'hoof' : 'paw'}${i}:${side}`,i,[side * legW * 0.23,-leg+0.028,-0.025],[legW * (split ? 0.4 : 1.1),0.055,legW * 1.3],[0,0,0],hooved ? {src:{color:[48,44,38]}} : {});
  }
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: (bodyY + parts[1].joint[1] + hs * 1.1) * s, hover: 0, lie: { angle: Math.PI / 2, lift: bw * 0.5 * s, side: true },
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
  const antR = parts.length, antL = parts.length + 1;
  if (!spider) {
    parts.push(
      { name: 'antR', parent: 2, joint: [0.04, 0.03, -0.14], size: [0.015, 0.015, 0.3], center: [0, 0, -0.15], rest: [0.5, -0.3, 0], src: { role: 'dark' }, kind: 'thin' },
      { name: 'antL', parent: 2, joint: [-0.04, 0.03, -0.14], size: [0.015, 0.015, 0.3], center: [0, 0, -0.15], rest: [0.5, 0.3, 0], src: { role: 'dark' }, kind: 'thin' },
    );
    if (sh.variant === 'ant') {
      // ants: a pinched waist and round gaster, big head with mandibles, elbowed antennae
      parts[1] = { ...parts[1], joint: [0, 0.03, tl / 2 + 0.07], size: [aw * 1.05, ah * 1.9, al * 0.8], center: [0, ah * 0.5, al * 0.4], rest: [-0.25, 0, 0], taper: [0.6, 0.6, 0.7, 0.7], taperAxis: 'z' };
      parts[2] = { ...parts[2], size: [tw * 1.0, th * 1.4, 0.18] };
      parts.push({ name: 'waist', parent: 0, joint: [0, 0.02, tl / 2 + 0.03], size: [0.05, 0.06, 0.06], center: [0, 0, 0], src: { role: 'dark' }, kind: 'thin' });
      for (const sd of [1, -1]) parts.push({ name: `headMand${sd}`, parent: 2, joint: [sd * 0.05, -0.03, -0.17], size: [0.08, 0.025, 0.03], center: [-sd * 0.03, 0, -0.01], rest: [0, sd * 0.5, 0], taper: [1, 1, 1, 1], src: { role: 'dark' }, kind: 'thin' });
      for (const [i, sd] of [[antR, 1], [antL, -1]] as const) parts.push({ name: `antTip${sd}`, parent: i, joint: [0, 0, -0.3], size: [0.013, 0.013, 0.22], center: [0, 0, -0.11], rest: [-1.1, sd * -0.3, 0], src: { role: 'dark' }, kind: 'thin' });
    } else {
      // roaches and beetles: wing cases over a flat back, a pronotum shield over the head
      for (const sd of [1, -1]) parts.push({ name: `elytron${sd}`, parent: 1, joint: [sd * aw * 0.25, ah * 0.55, 0], size: [aw * 0.52, 0.02, al * 0.95], center: [0, 0, al / 2], rest: [0, 0, sd * -0.12], src: { role: 'accent' }, kind: 'thin' });
      parts.push({ name: 'shield', parent: 0, joint: [0, th * 0.55, -tl * 0.2], size: [tw * 1.1, 0.02, tl * 0.8], center: [0, 0, 0], src: { role: 'main' }, kind: 'thin' });
    }
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
        setRot(o, antR, 0.15 * sin(p.t * 5 + p.seed * 4), 0.2 * sin(p.t * 3.1));
        setRot(o, antL, 0.15 * sin(p.t * 5.3 + 1), 0.2 * sin(p.t * 2.7 + 2));
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
    const ww = insectW ? 0.22 : sh.variant === 'bat' ? 0.42 : 0.32, wd = insectW ? 0.08 : 0.16;
    parts.push(
      { name: 'wingR', parent: 0, joint: [bw / 2, bh * 0.3, -bl * 0.1], size: [ww, 0.015, wd], center: [ww / 2, 0, wd * 0.3], src: insectW ? { role: 'wing' } : { rect: [0.25, 0.1, 0.75, 0.5], proj: 'side' }, kind: 'thin' },
      { name: 'wingL', parent: 0, joint: [-bw / 2, bh * 0.3, -bl * 0.1], size: [ww, 0.015, wd], center: [-ww / 2, 0, wd * 0.3], src: insectW ? { role: 'wing' } : { rect: [0.25, 0.1, 0.75, 0.5], proj: 'side' }, kind: 'thin' },
    );
  }
  const v = sh.variant ?? '';
  if (insectW) {
    // abdomen: striped and tapering to a sting (wasps, bees), long and thin (dragonflies,
    // mosquitoes), stubby (flies)
    const long = v === 'dragonfly' ? 3.2 : v === 'mosquito' ? 1.7 : v === 'fly' ? 0.9 : 1.3;
    const fat = v === 'bee' ? 1.6 : v === 'dragonfly' || v === 'mosquito' ? 0.7 : v === 'fly' ? 1.3 : 1.2;
    const striped = v === 'wasp' || v === 'bee';
    const ab = parts.length;
    parts.push({ name: 'abdomen', parent: 0, joint: [0, 0, bl / 2 + (v === 'wasp' ? 0.02 : 0)], size: [bw * fat, bh * fat, bl * long], center: [0, -bh * 0.2, bl * long * 0.5], rest: [v === 'dragonfly' ? 0.05 : 0.3, 0, 0], taper: striped ? [0.85, 0.85, 0.4, 0.4] : [1, 1, 0.7, 0.7], taperAxis: 'z', src: striped ? { color: v === 'bee' ? [200, 150, 40] : [214, 180, 40], detail: 'stripes' } : { rect: [0, 0.3, 0.55, 1], proj: 'side', core: true }, kind: 'core' });
    if (striped) parts.push({ name: 'sting', parent: ab, joint: [0, -bh * 0.2, bl * long], size: [0.012, 0.012, 0.05], center: [0, 0, 0.025], taper: [1, 1, 0.2, 0.2], taperAxis: 'z', src: { color: [30, 26, 22] }, kind: 'thin' });
    // a second, smaller pair of wings; dragonflies: two long equal pairs
    const ww2 = v === 'dragonfly' ? 0.32 : 0.14;
    for (const sd of [1, -1]) parts.push({ name: `wingHind${sd}`, parent: 0, joint: [sd * bw / 2, bh * 0.3, bl * 0.25], size: [ww2, 0.012, 0.06], center: [sd * ww2 / 2, 0, 0.02], rest: [0, sd * -0.25, 0], src: { role: 'wing' }, kind: 'thin' });
    if (v === 'dragonfly') { parts[2] = { ...parts[2], size: [0.32, 0.012, 0.06] }; parts[3] = { ...parts[3], size: [0.32, 0.012, 0.06] }; }
    // dangling legs: long for mosquitoes
    const leg = v === 'mosquito' ? 0.2 : 0.09;
    for (let i = 0; i < 3; i++) for (const sd of [1, -1]) parts.push({ name: `leg${i}${sd}`, parent: 0, joint: [sd * bw * 0.4, -bh * 0.4, -bl * 0.3 + i * bl * 0.3], size: [0.008, leg, 0.008], center: [0, -leg / 2, 0], rest: [0.3 - i * 0.3, 0, sd * 0.4], src: { role: 'dark' }, kind: 'thin' });
    // heads: compound eyes on flies, a proboscis on mosquitoes
    if (v === 'fly' || v === 'dragonfly') for (const sd of [1, -1]) parts.push({ name: `headEye${sd}`, parent: 1, joint: [sd * hs * 0.45, hs * 0.2, -hs * 0.3], size: [hs * 0.5, hs * 0.6, hs * 0.6], center: [0, 0, 0], src: { color: v === 'fly' ? [170, 30, 26] : [60, 110, 150] }, kind: 'thin' });
    if (v === 'mosquito') parts.push({ name: 'headProboscis', parent: 1, joint: [0, 0, -hs * 0.8], size: [0.008, 0.008, 0.16], center: [0, 0, -0.08], rest: [0.5, 0, 0], src: { color: [40, 34, 30] }, kind: 'thin' });
  } else if (sh.wings !== 'none') {
    parts.push({ name: 'tail', parent: 0, joint: [0, 0, bl / 2], size: [bw * (v === 'bird' ? 1.5 : 0.9), 0.02, bl * 0.6], center: [0, 0, bl * 0.3], rest: [-0.2, 0, 0], taper: v === 'bird' ? [0.7, 1, 1.4, 1] : undefined, taperAxis: 'z', src: { role: 'dark' }, kind: 'thin' });
    if (v === 'bird') {
      parts.push({ name: 'headBeak', parent: 1, joint: [0, hs * 0.1, -hs * 0.9], size: [hs * 0.35, hs * 0.3, hs * 0.55], center: [0, 0, -hs * 0.27], taper: [1, 1, 0.1, 0.2], taperAxis: 'z', src: { color: [40, 36, 30] }, kind: 'thin' });
      for (const sd of [1, -1]) parts.push({ name: `foot${sd}`, parent: 0, joint: [sd * bw * 0.25, -bh / 2, 0], size: [0.01, 0.06, 0.01], center: [0, -0.03, 0], src: { color: [60, 50, 40] }, kind: 'thin' });
      for (const sd of [1, -1]) parts.push({ name: `headEye${sd}`, parent: 1, joint: [sd * hs * 0.5, hs * 0.25, -hs * 0.45], size: [0.004, 0.02, 0.02], center: [0, 0, 0], src: { color: [240, 230, 180] }, kind: 'thin' });
    }
    if (v === 'bat') {
      // tall ears, a snub face, wide membrane wings with finger struts
      for (const sd of [1, -1]) parts.push({ name: `ear${sd}`, parent: 1, joint: [sd * hs * 0.3, hs * 0.6, 0], size: [hs * 0.3, hs * 0.8, hs * 0.1], center: [0, hs * 0.4, 0], rest: [0, 0, sd * -0.25], taper: [1, 1, 0.3, 1], src: { role: 'dark' }, kind: 'thin' });
      parts[2] = { ...parts[2], size: [0.42, 0.012, 0.2] };
      parts[3] = { ...parts[3], size: [0.42, 0.012, 0.2] };
      for (const [w, sd] of [[2, 1], [3, -1]] as const) for (let f = 0; f < 3; f++) parts.push({ name: `wingStrut${w}${f}`, parent: w, joint: [sd * 0.05, 0.008, 0.02], size: [0.3 - f * 0.05, 0.008, 0.008], center: [sd * (0.15 - f * 0.025), 0, 0], rest: [0, sd * (0.15 + f * 0.35), 0], src: { color: [40, 30, 34] }, kind: 'thin' });
    }
  }
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
  // A triffid-like stalker: root tendrils, a bending two-part stalk, a bulb head that opens in
  // four petals around a dark maw, a whip, drooping leaves. Fungaloids get the same body in
  // their own colours.
  const parts: PartDef[] = [
    { name: 'base', parent: -1, joint: [0, 0, 0], size: [0.4, 0.14, 0.4], center: [0, 0.07, 0], taper: [1.25, 1.25, 0.7, 0.7], src: { rect: [0.1, 0.85, 0.9, 1], proj: 'front', core: true }, kind: 'core' },
    { name: 'stalk1', parent: 0, joint: [0, 0.12, 0], size: [0.2, 0.5, 0.2], center: [0, 0.25, 0], taper: [1, 1, 0.8, 0.8], src: { rect: [0.3, 0.55, 0.7, 0.9], proj: 'front', core: true }, kind: 'core' },
    { name: 'stalk2', parent: 1, joint: [0, 0.48, 0], size: [0.16, 0.46, 0.16], center: [0, 0.23, 0], rest: [0.12, 0, 0], taper: [1, 1, 0.7, 0.7], src: { rect: [0.3, 0.4, 0.7, 0.6], proj: 'front', core: true }, kind: 'core' },
    { name: 'bulb', parent: 2, joint: [0, 0.44, 0], size: [0.36, 0.32, 0.36], center: [0, 0.16, 0], taper: [0.55, 0.55, 1, 1], src: { rect: [0.15, 0, 0.85, 0.4], proj: 'front', core: true }, kind: 'core' },
    { name: 'maw', parent: 3, joint: [0, 0.31, 0], size: [0.2, 0.04, 0.2], center: [0, 0, 0], src: { color: [48, 16, 20] }, kind: 'thin' },
  ];
  // petals around the maw, opening outward
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    parts.push({ name: `petal${i}`, parent: 3, joint: [Math.sin(a) * 0.14, 0.3, Math.cos(a) * 0.14], size: [0.16, 0.2, 0.03], center: [0, 0.09, 0], rest: [Math.cos(a) * 0.5, a, 0], taper: [1, 1, 0.4, 0.4], src: { role: 'accent' }, kind: 'thin' });
  }
  const leaf = (name: string, y: number, yaw: number): PartDef => ({ name, parent: 1, joint: [Math.sin(yaw) * 0.08, y, Math.cos(yaw) * 0.08], size: [0.05, 0.03, 0.42], center: [0, 0, 0.2], rest: [-0.35, yaw, 0], taper: [1.4, 1, 0.5, 1], taperAxis: 'z', src: { role: 'main' }, kind: 'thin' });
  parts.push(leaf('leaf0', 0.3, 0.6), leaf('leaf1', 0.42, 2.7), leaf('leaf2', 0.2, 4.4));
  const whip = parts.length;
  parts.push({ name: 'whip', parent: 3, joint: [0, 0.12, -0.16], size: [0.03, 0.03, 0.55], center: [0, 0, -0.27], rest: [0.7, 0, 0], taper: [0.5, 0.5, 1, 1], taperAxis: 'z', src: { role: 'accent' }, kind: 'thin' });
  for (let i = 0; i < 3; i++) {
    const a = (i * TAU) / 3 + 0.4;
    parts.push({ name: `root${i}`, parent: 0, joint: [Math.sin(a) * 0.18, 0.03, Math.cos(a) * 0.18], size: [0.05, 0.04, 0.24], center: [0, 0, 0.1], rest: [0, a, 0], taper: [1, 1, 0.4, 0.4], taperAxis: 'z', src: { role: 'dark' }, kind: 'thin' });
  }
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: 1.68 * s, hover: 0, lie: { angle: Math.PI / 2, lift: 0.1 * s, side: false },
    pose(p, o) {
      const sw = sin(p.t * 1.4 + p.seed * TAU);
      setRot(o, 1, 0.05 * sw, 0, 0.05 * sin(p.t * 1.1 + p.seed * 3) + 0.1 * Math.min(1, p.gait) * sin(p.phase * TAU));
      setRot(o, 2, 0.08 * sw);
      setRot(o, 3, 0.06 * sw);
      for (let i = 0; i < 4; i++) setRot(o, 5 + i, 0.1 * sin(p.t * 2 + i));
      setRot(o, whip, 0.2 * sin(p.t * 3 + p.seed * 4), 0.3 * sin(p.t * 2.1));
      if (p.windup !== null) {
        const u = ease(p.windup);
        // rear back, petals flare open, the whip coils up
        setRot(o, 1, 0.3 * u);
        setRot(o, 2, 0.4 * u);
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          setRot(o, 5 + i, Math.cos(a) * 0.5 * u, 0, -Math.sin(a) * 0.5 * u);
        }
        setRot(o, whip, -1.0 * u);
      }
      if (p.strike > 0) {
        setRot(o, 1, -0.4 * p.strike);
        setRot(o, 2, -0.5 * p.strike);
        setRot(o, whip, 0.8 * p.strike);
      }
      if (p.dead) { setRot(o, 1, 1.2, 0, 0.3); setRot(o, 2, 0.3); }
    },
  };
}

// ------------------------------------------------------------------ robots

function machine(sh: BodyShape, turret: boolean): Rig {
  const parts: PartDef[] = turret
    ? [
      // tripod, a slim post, a slewing head with a sensor eye and twin barrels
      { name: 'post', parent: -1, joint: [0, 0, 0], size: [0.12, 0.5, 0.12], center: [0, 0.25, 0], src: { role: 'dark' }, kind: 'core' },
      { name: 'head', parent: 0, joint: [0, 0.5, 0], size: [0.34, 0.26, 0.46], center: [0, 0.12, 0.02], taper: [0.7, 0.8, 1, 1], taperAxis: 'z', src: { rect: [0.1, 0, 0.9, 0.55], proj: 'front', core: true }, kind: 'core' },
      { name: 'barrelR', parent: 1, joint: [0.06, 0.1, -0.2], size: [0.05, 0.05, 0.42], center: [0, 0, -0.2], src: { color: [40, 42, 46] }, kind: 'thin' },
      { name: 'barrelL', parent: 1, joint: [-0.06, 0.1, -0.2], size: [0.05, 0.05, 0.42], center: [0, 0, -0.2], src: { color: [40, 42, 46] }, kind: 'thin' },
      { name: 'eye', parent: 1, joint: [0, 0.2, -0.2], size: [0.1, 0.06, 0.04], center: [0, 0, 0], src: { color: [235, 60, 40] }, kind: 'thin' },
      { name: 'legA', parent: 0, joint: [0, 0.2, 0], size: [0.05, 0.3, 0.05], center: [0, -0.13, 0], rest: [0.6, 0, 0], src: { role: 'dark' }, kind: 'thin' },
      { name: 'legB', parent: 0, joint: [0, 0.2, 0], size: [0.05, 0.3, 0.05], center: [0, -0.13, 0], rest: [0.6, 2.1, 0], src: { role: 'dark' }, kind: 'thin' },
      { name: 'legC', parent: 0, joint: [0, 0.2, 0], size: [0.05, 0.3, 0.05], center: [0, -0.13, 0], rest: [0.6, 4.2, 0], src: { role: 'dark' }, kind: 'thin' },
    ]
    : [
      // a sloped hull on tracks, a domed sensor head with a red eye and an antenna
      { name: 'body', parent: -1, joint: [0, 0.35, 0], size: [0.55, 0.45, 0.7], center: [0, 0.1, 0], taper: [0.8, 0.7, 1, 1], taperAxis: 'z', src: { rect: [0.1, 0.3, 0.9, 0.8], proj: 'front', core: true }, kind: 'core' },
      { name: 'head', parent: 0, joint: [0, 0.33, -0.05], size: [0.32, 0.22, 0.36], center: [0, 0.11, 0], taper: [1, 1, 0.7, 0.7], src: { rect: [0.2, 0, 0.8, 0.35], proj: 'front', core: true }, kind: 'core' },
      { name: 'trackR', parent: 0, joint: [0.33, -0.2, 0], size: [0.14, 0.3, 0.8], center: [0, 0, 0], src: { role: 'dark' }, kind: 'limb' },
      { name: 'trackL', parent: 0, joint: [-0.33, -0.2, 0], size: [0.14, 0.3, 0.8], center: [0, 0, 0], src: { role: 'dark' }, kind: 'limb' },
      { name: 'eye', parent: 1, joint: [0, 0.1, -0.18], size: [0.2, 0.05, 0.03], center: [0, 0, 0], src: { color: [235, 60, 40] }, kind: 'thin' },
      { name: 'antenna', parent: 1, joint: [0.1, 0.2, 0.08], size: [0.02, 0.35, 0.02], center: [0, 0.17, 0], rest: [0.2, 0, -0.15], src: { role: 'dark' }, kind: 'thin' },
    ];
  const s = sh.scale;
  return {
    shape: sh, parts: scaleParts(parts, s), height: (turret ? 0.76 : 0.92) * s, hover: 0, lie: { angle: 0.25, lift: 0, side: true },
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

/**
 * `zstyle`: zombie bodies (zombie.ts) — 'shamble' (default), 'caricature', 'sprite3d' (Blender
 * meshes in the boxes, chars/spriteModels.ts), or 'boxy' for the
 * round-6 person rig; `variant` picks one of a zombie type's torn/asymmetric individuals.
 */
export function makeRig(sh: BodyShape, opts: { turret?: boolean; held?: HeldBuild; zstyle?: ZStyle; variant?: number } = {}): Rig {
  switch (sh.arch) {
    case 'humanoid':
      if (sh.zlook && (opts.zstyle ?? 'shamble') !== 'boxy' && !sh.weapon) return zombieRig(sh, sh.zlook, opts.zstyle === 'caricature' || opts.zstyle === 'sprite3d' ? opts.zstyle : 'shamble', opts.variant ?? 0);
      return humanoid(sh, opts.held);
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

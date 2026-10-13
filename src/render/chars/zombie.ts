// Zombie bodies (docs/CHARACTERS.md "Zombie readability"). Pure (no three.js), for tests.
//
// The round-6 person rig made every zombie an upright mannequin that differed mostly by colour.
// The UltiCa sprites don't: zombies are hunched with the head thrust forward and the arms
// reaching out at chest height, torn and lopsided, and every kind of special has its own
// outline. This builds the zombie from the same 16 person parts (HUM order, so the hit zones,
// the crawl poses and the sprite-painted skins keep working) drawn with bevelled / octagonal
// unit shapes (shapes.ts), plus what makes the family read at 25 m: a hanging jaw, deltoids
// and a hump, a belly, rags, uniform pieces, and small animated features (acid sacs, electric
// arcs, smoke, tendrils, thorns).
//
// Poses are blended between named states in "world" terms (how far the torso leans, where an
// arm points relative to straight down), then turned into the part rotations: an idle shamble,
// a big rear-back with the arms over the head (melee / heavy), a deep coiled crouch before a
// lunge (leap) and the lunge-grab that follows it, flinch, downed, dead.
//
// Styles: 'shamble' follows the sprites; 'caricature' pushes every family's proportions and
// posture further (bigger hands and heads, deeper hunch, more belly, bigger fists); 'sprite3d'
// is the shamble rig with the sprites' chunkier proportions (big head and hands, short legs)
// whose body parts are drawn with low-poly Blender meshes (tools/blender, chars/spriteModels.ts)
// instead of painted boxes.
//
// NOTE: this module and rig.ts import each other; nothing here may touch rig.ts values at the
// top level (only inside functions).

import { CRAWL_HEIGHT } from '../../game/crawl';
import type { BodyShape } from './archetype';
import { HUM, crawlPose, ease, quirk, scaleParts, setRot, type PartDef, type PoseIn, type PoseOut, type Rig } from './rig';
import type { ZBuild, ZombieLook } from './zombieFamily';

export type ZStyle = 'shamble' | 'caricature' | 'boxy' | 'sprite3d';
export const ZSTYLES: readonly ZStyle[] = ['shamble', 'caricature', 'boxy', 'sprite3d'];

// ------------------------------------------------------------------ sprite3d mesh contract

/** The Blender-built zombie models (tools/blender/zombies.py writes one GLB per id). */
export type SpriteModelId = 'walker' | 'fat' | 'brute' | 'runner' | 'cop' | 'soldier' | 'boomer' | 'spitter' | 'child' | 'skeleton';
export const SPRITE_MODELS: readonly SpriteModelId[] = ['walker', 'fat', 'brute', 'runner', 'cop', 'soldier', 'boomer', 'spitter', 'child', 'skeleton'];

/**
 * Parts every model draws as a mesh (the 16 person parts and the silhouette pieces every zombie
 * gets). Optional ones (hump, belly) only exist on some builds; the GLB must still have them so
 * any family can borrow a model.
 */
export const SPRITE_CORE_PARTS: readonly string[] = [
  'hips', 'torso', 'head', 'uArmR', 'fArmR', 'uArmL', 'fArmL', 'thighR', 'shinR', 'thighL', 'shinL', 'footR', 'footL', 'neck', 'handR', 'handL',
  'headJaw', 'uArmDeltR', 'uArmDeltL', 'torsoHump', 'torsoBelly',
];
/** Gear parts a model draws as meshes too (the rest keep their painted unit shape). */
export const SPRITE_MODEL_GEAR: Record<SpriteModelId, readonly string[]> = {
  walker: [], fat: [], brute: [], runner: [], boomer: [], child: [],
  // every acid sac zombie.ts can grow (corrosive: all eight) and the drool
  spitter: ['sac0', 'sac1', 'sac2', 'sac3', 'sac4', 'uArmSac5', 'thighSac6', 'sac7', 'fxDrool'],
  cop: ['headHelmet', 'headVisor', 'torsoBadge'],
  soldier: ['headHelmet', 'torsoVest', 'torsoPouch0', 'torsoPouch1', 'torsoPouch2'],
  skeleton: ['torsoRib0', 'torsoRib1', 'torsoRib2', 'torsoRib3'],
};

/**
 * Which model a zombie borrows: its own when the pipeline built one for its kind, else the
 * plain walker's parts stretched into its boxes (a hulk is walker meshes in hulk proportions).
 */
export function spriteModelOf(look: ZombieLook): SpriteModelId {
  if (look.bone) return 'skeleton';
  if (look.gear === 'cop' || look.gear === 'swat') return 'cop';
  if (look.gear === 'soldier') return 'soldier';
  switch (look.family) {
    case 'boomer': return 'boomer';
    case 'fat': return 'fat';
    case 'brute': return 'brute';
    case 'acid': return 'spitter';
    case 'child': return 'child';
    case 'runner': case 'feral': return 'runner';
    default: return 'walker';
  }
}

/** Torn / asymmetric individuals per zombie type (picked from the creature's seed). */
export const ZVARIANTS = 3;

/**
 * Proportions and resting posture per build. Geometry fields are multipliers on the person rig
 * (1 = a 1.75 m adult); posture fields are radians in world terms:
 *   hunch    torso lean forward          headComp share of the lean the head lifts back
 *   reach    arm angle from hanging (1.57 = straight out)   armOut  arms spread sideways
 *   elbow    forearm bend                wrist    hand droop (negative = limp)
 *   knee     resting crouch              stance   feet apart
 *   lurch    shamble sway                swing    arm swing while walking (brutes, runners)
 *   stride   resting stride: one foot forward, one back (the sprites' stance; sprite3d)
 */
export interface Build {
  girth: number; chestD: number; shoulder: number; arm: number; fore: number; fist: number; armLen: number;
  leg: number; legLen: number; head: number; neck: number; belly: number; hump: number; height: number;
  hunch: number; headComp: number; reach: number; armOut: number; elbow: number; wrist: number;
  knee: number; stance: number; lurch: number; swing: number; stride: number;
}

const WALKER: Build = {
  girth: 1, chestD: 1, shoulder: 1, arm: 1, fore: 1, fist: 1.1, armLen: 1.05, leg: 1, legLen: 1, head: 1, neck: 1, belly: 0, hump: 0.35, height: 1.04,
  hunch: 0.62, headComp: 0.8, reach: 1.25, armOut: 0.12, elbow: 0.2, wrist: -0.55, knee: 0.32, stance: 0.08, lurch: 1, swing: 0, stride: 0,
};

export const BUILDS: Record<ZBuild, Build> = {
  walker: WALKER,
  fat: { ...WALKER, girth: 1.3, chestD: 1.25, arm: 1.25, fore: 1.15, leg: 1.25, belly: 0.6, hump: 0.2, hunch: 0.25, reach: 1.15, armOut: 0.32, lurch: 1.25 },
  bloated: {
    ...WALKER, girth: 1.3, chestD: 1.25, arm: 1.15, fore: 1.05, fist: 1, armLen: 0.9, leg: 1.35, legLen: 0.82, head: 0.86, neck: 0.4, belly: 1, hump: 0, height: 1,
    hunch: 0.1, headComp: 0.5, reach: 0.8, armOut: 0.62, elbow: 0.35, wrist: -0.3, knee: 0.25, stance: 0.24, lurch: 1.6,
  },
  brute: {
    ...WALKER, girth: 1.3, chestD: 1.25, shoulder: 1.7, arm: 1.55, fore: 1.75, fist: 1.85, armLen: 1.12, leg: 1.3, head: 0.86, neck: 0.35, hump: 0.75, height: 1.08,
    hunch: 0.5, headComp: 0.9, reach: 0.45, armOut: 0.3, elbow: 0.45, wrist: -0.1, knee: 0.3, stance: 0.16, lurch: 0.8, swing: 0.35,
  },
  hulk: {
    ...WALKER, girth: 1.5, chestD: 1.4, shoulder: 2.3, arm: 2.0, fore: 2.6, fist: 2.7, armLen: 1.25, leg: 1.65, legLen: 0.95, head: 0.72, neck: 0.1, belly: 0.25, hump: 1.25, height: 1,
    hunch: 0.55, headComp: 0.95, reach: 0.35, armOut: 0.42, elbow: 0.55, wrist: 0, knee: 0.32, stance: 0.3, lurch: 0.6, swing: 0.25,
  },
  gaunt: {
    ...WALKER, girth: 0.78, chestD: 0.8, shoulder: 0.8, arm: 0.65, fore: 0.65, fist: 1.05, armLen: 1.15, leg: 0.7, legLen: 1.02, head: 1.02, neck: 1.7, hump: 0.5, height: 1.06,
    hunch: 1.1, headComp: 1.1, reach: 0.2, armOut: 0.22, elbow: 0.3, wrist: -0.4, knee: 1.25, stance: 0.22, lurch: 1.2,
  },
  runner: {
    ...WALKER, girth: 0.9, chestD: 0.9, arm: 0.85, fore: 0.85, fist: 1, armLen: 1, leg: 0.9, legLen: 1.04, head: 0.97, hump: 0.15, height: 1.02,
    hunch: 0.5, headComp: 0.9, reach: 0.55, armOut: 0.18, elbow: 1.15, wrist: -0.3, knee: 0.35, stance: 0.12, lurch: 0.3, swing: 1,
  },
  child: { ...WALKER, head: 1.3, height: 1, hunch: 0.3, reach: 1.2 },
  necro: {
    ...WALKER, girth: 0.85, chestD: 0.85, shoulder: 1.05, arm: 0.8, fore: 0.8, fist: 1.15, armLen: 1.18, leg: 0.85, legLen: 1.08, head: 0.95, neck: 1.2, hump: 0.3, height: 1.08,
    hunch: 0.3, headComp: 0.8, reach: 1.0, armOut: 0.32, elbow: 0.35, wrist: -0.9, knee: 0.1, stance: 0.1, lurch: 0.5,
  },
  grabber: { ...WALKER, arm: 0.9, fore: 0.95, fist: 1.35, armLen: 1.4, hunch: 0.5, reach: 1.45, elbow: 0.05, wrist: -0.35 },
};

/** Geometry fields a style exaggerates (multipliers pushed away from 1). */
const GEOM: (keyof Build)[] = ['girth', 'chestD', 'shoulder', 'arm', 'fore', 'fist', 'armLen', 'leg', 'legLen', 'neck'];

/** The build a look gets in a style: family degree blends from a plain walker. */
export function buildOf(look: ZombieLook, style: Exclude<ZStyle, 'boxy'>): Build {
  const base = BUILDS[look.build];
  const d = look.build === 'bloated' ? 1 : look.degree;
  const b = { ...base };
  for (const k of Object.keys(base) as (keyof Build)[]) b[k] = WALKER[k] + (base[k] - WALKER[k]) * d;
  // a boomer's belly; the huge boomer is nearly a ball with a head on it
  if (look.build === 'bloated') (b.belly = 0.3 + 1.15 * look.degree, b.legLen = 0.95 - 0.2 * look.degree, b.neck = 0.6 - 0.5 * look.degree);
  if (look.bone) for (const k of ['arm', 'fore', 'leg'] as const) b[k] *= 0.62;
  if (look.bone) (b.girth *= 0.85, b.chestD *= 0.8, b.belly = 0);
  if (style === 'caricature') {
    for (const k of GEOM) b[k] = 1 + (b[k] - 1) * 1.7;
    b.head *= 1.15;
    b.fist *= 1.2;
    b.belly *= 1.3;
    b.hump *= 1.4;
    b.hunch *= 1.25;
    b.reach = Math.min(1.6, b.reach * 1.08);
    b.lurch *= 1.3;
  }
  if (style === 'sprite3d') {
    // UltiCa zombies are ~29 px tall with an 8 px head, mitt hands, thick limbs and short legs:
    // chibi, not realistic. Matching those ratios is most of what makes the far figure read as
    // the sprite (tools/blender comparison sheets, docs/SPRITE3D.md). Limbs have to be 2-3 px
    // wide at sprite scale, or they vanish into the outline.
    b.head *= 1.6;
    b.fist *= 1.4;
    b.girth *= 1.18;
    b.chestD *= 1.35;
    b.arm *= 1.55;
    b.fore *= 1.55;
    b.leg *= 1.45;
    b.legLen *= 0.8;
    b.armLen *= 0.9;
    b.neck *= 0.5;
    b.stance += 0.06;
    // the sprites hold their arms out in front and a little down, hands drooping, and stand
    // in a stride
    b.reach = Math.min(Math.max(b.reach, 0.9), 1.1);
    b.elbow = Math.min(b.elbow, 0.2);
    b.wrist = Math.min(b.wrist, -0.5);
    b.armOut = Math.max(b.armOut, 0.26);
    b.stride = 0.32;
    b.belly *= 1.5;
    // a gentler hunch: the sprites stand fairly upright with the head on top, not thrust out
    b.hunch *= 0.6;
  }
  return b;
}

// ------------------------------------------------------------------ pose states

/** A pose in world terms (see the file comment); blended, then turned into part rotations. */
interface ZState {
  lean: number; roll: number; twist: number;
  head: number; headTurn: number; headRoll: number;
  armR: number; armL: number; outR: number; outL: number; elbR: number; elbL: number; wriR: number; wriL: number;
  knee: number; jaw: number;
  /** root offset (m before scale): +z = back, away from what it faces */
  dx: number; dy: number; dz: number;
  /** legs: extra thigh swing per side (lunge: one leg trails) */
  legR: number; legL: number;
}

const STATE_KEYS: (keyof ZState)[] = ['lean', 'roll', 'twist', 'head', 'headTurn', 'headRoll', 'armR', 'armL', 'outR', 'outL', 'elbR', 'elbL', 'wriR', 'wriL', 'knee', 'jaw', 'dx', 'dy', 'dz', 'legR', 'legL'];

function blend(a: ZState, b: Partial<ZState>, u: number): void {
  if (u <= 0) return;
  for (const k of STATE_KEYS) if (b[k] !== undefined) a[k] += (b[k]! - a[k]) * u;
}

// ------------------------------------------------------------------ build

interface Gear {
  name: string; parent: number; joint: [number, number, number]; size: [number, number, number]; center?: [number, number, number];
  rest?: [number, number, number]; shape?: PartDef['shape']; color: [number, number, number]; glow?: number; taper?: PartDef['taper']; zr?: 'gear' | 'visor' | 'rag';
}

export function zombieRig(sh: BodyShape, look: ZombieLook, style: Exclude<ZStyle, 'boxy'>, variant: number): Rig {
  const sprite3d = style === 'sprite3d';
  const H = HUM;
  const B = buildOf(look, style);
  const v = ((variant % ZVARIANTS) + ZVARIANTS) % ZVARIANTS;
  // individuals of one type differ a little in size, as well as in what is torn off
  const jitter = [1, 0.97, 1.03][v];
  const s = sh.scale * B.height * jitter;
  const crawl = sh.crawl ?? null;

  const thigh = 0.41 * B.legLen, shin = 0.38 * B.legLen, footH = 0.07;
  const hipY = thigh + shin + footH + 0.06;
  const torsoW = 0.37 * B.girth, torsoD = 0.22 * B.chestD, torsoH = 0.46;
  // open, clawing hands (flat and long) rather than the person rig's fists; brutes keep fists
  const armW = 0.105 * B.arm, foreW = 0.095 * B.fore, handW = 0.088 * B.fist, hand = 0.13 * Math.sqrt(B.fist);
  const handD = handW * (B.fist > 1.5 ? 1.1 : 0.55);
  const upperArm = 0.3 * B.armLen, foreArm = 0.26 * B.armLen;
  const legW = 0.15 * B.leg, legD = 0.16 * B.leg;
  // (a ball-shaped skull loses its corners: a little bigger than the person rig's box head)
  const headW = 0.21 * B.head, headD = 0.23 * B.head, craniumH = 0.185 * B.head, jawH = 0.08 * B.head;
  const neckL = 0.08 * B.neck;
  const hipX = 0.09 * Math.min(B.girth, 1.4);
  const delt = armW * 1.25 * (0.75 + 0.25 * B.shoulder);
  const shoulderX = torsoW / 2 + armW / 2 - 0.015 + (B.shoulder - 1) * 0.04;
  const stump = v === 1 && (look.build === 'walker' || look.build === 'fat' || look.build === 'runner' || look.build === 'grabber' || look.build === 'child');
  const hulkArms = look.build === 'hulk' || look.build === 'brute';
  const skin = (region: PartDef['src']['region'], extra: Partial<PartDef['src']> = {}): PartDef['src'] => ({ region, ...extra });

  // The 16 person parts, HUM order (hit zones, crawl poses and sprite rects depend on it).
  const parts: PartDef[] = [
    { name: 'hips', parent: -1, joint: [0, hipY, 0], size: [torsoW * 0.92, 0.17, torsoD * 0.98], center: [0, -0.02, 0], shape: 'oct', src: skin('hips', { rect: [0.2, 0.5, 0.8, 0.6], proj: 'front', core: true }), kind: 'core' },
    { name: 'torso', parent: 0, joint: [0, 0.06, 0], size: [torsoW, torsoH, torsoD], center: [0, torsoH / 2, 0], taper: [0.78, 0.88, 1, 1], shape: 'oct', src: skin('torso', { rect: [0.15, 0.22, 0.85, 0.52], proj: 'front', core: true }), kind: 'core' },
    { name: 'head', parent: 1, joint: [0, torsoH + neckL * 0.6, -torsoD * 0.3], size: [headW, craniumH, headD], center: [0, jawH * 0.45 + craniumH / 2, -0.005], taper: [0.9, 0.92, 1, 1], shape: 'ball', src: skin('head', { rect: [0.2, 0, 0.8, 0.22], proj: 'front', core: true, face: true }), kind: 'core' },
    { name: 'uArmR', parent: 1, joint: [shoulderX, torsoH - 0.05, 0], size: [armW, upperArm, armW * 1.05], center: [0, -upperArm / 2 + 0.03, 0], taper: [0.8, 0.82, 1, 1], shape: 'oct', src: skin('upperArm', { rect: [0, 0.22, 1, 0.4], proj: 'front', edge: 'left' }), kind: 'limb' },
    { name: 'fArmR', parent: 3, joint: [0, -upperArm + 0.04, 0], size: [foreW, foreArm, foreW], center: [0, -foreArm / 2, 0], taper: hulkArms ? [1.1, 1.1, 0.85, 0.85] : [0.72, 0.72, 1, 1], shape: 'oct', src: skin('foreArm', { rect: [0, 0.38, 1, 0.56], proj: 'front', edge: 'left' }), kind: 'limb' },
    { name: 'uArmL', parent: 1, joint: [-shoulderX, torsoH - 0.05, 0], size: [armW, upperArm, armW * 1.05], center: [0, -upperArm / 2 + 0.03, 0], taper: [0.8, 0.82, 1, 1], shape: 'oct', src: skin('upperArm', { rect: [0, 0.22, 1, 0.4], proj: 'front', edge: 'right' }), kind: 'limb' },
    { name: 'fArmL', parent: 5, joint: [0, -upperArm + 0.04, 0], size: [foreW, stump ? foreArm * 0.55 : foreArm, foreW], center: [0, -(stump ? foreArm * 0.55 : foreArm) / 2, 0], taper: hulkArms ? [1.1, 1.1, 0.85, 0.85] : [0.72, 0.72, 1, 1], shape: 'oct', src: skin('foreArm', { rect: [0, 0.38, 1, 0.56], proj: 'front', edge: 'right' }), kind: 'limb' },
    { name: 'thighR', parent: 0, joint: [hipX, -0.06, 0], size: [legW, thigh, legD], center: [0, -thigh / 2, 0], taper: [0.8, 0.85, 1, 1], shape: 'oct', src: skin('thigh', { rect: [0.1, 0.56, 0.5, 0.76], proj: 'front', core: true }), kind: 'limb' },
    { name: 'shinR', parent: 7, joint: [0, -thigh, 0], size: [legW * 0.84, shin, legD * 0.84], center: [0, -shin / 2, 0], taper: [0.72, 0.78, 1, 1], shape: 'oct', src: skin('shin', { rect: [0.1, 0.74, 0.5, 0.94], proj: 'front', core: true }), kind: 'limb' },
    { name: 'thighL', parent: 0, joint: [-hipX, -0.06, 0], size: [legW, thigh, legD], center: [0, -thigh / 2, 0], taper: [0.8, 0.85, 1, 1], shape: 'oct', src: skin('thigh', { rect: [0.5, 0.56, 0.9, 0.76], proj: 'front', core: true }), kind: 'limb' },
    { name: 'shinL', parent: 9, joint: [0, -thigh, 0], size: [legW * 0.84, shin, legD * 0.84], center: [0, -shin / 2, 0], taper: [0.72, 0.78, 1, 1], shape: 'oct', src: skin('shin', { rect: [0.5, 0.74, 0.9, 0.94], proj: 'front', core: true }), kind: 'limb' },
    { name: 'footR', parent: 8, joint: [0, -shin, 0], size: [legW * 0.95, footH, 0.26], center: [0, -footH / 2 + 0.005, -0.05], taper: [1, 0.7, 1, 1.1], taperAxis: 'z', shape: 'bevel', src: skin('foot', { rect: [0.1, 0.9, 0.5, 1], proj: 'front', core: true }), kind: 'limb' },
    { name: 'footL', parent: 10, joint: [0, -shin, 0], size: [legW * 0.95, footH, 0.26], center: [0, -footH / 2 + 0.005, -0.05], taper: [1, 0.7, 1, 1.1], taperAxis: 'z', shape: 'bevel', src: skin('foot', { rect: [0.5, 0.9, 0.9, 1], proj: 'front', core: true }), kind: 'limb' },
    { name: 'neck', parent: 1, joint: [0, torsoH - 0.03, -torsoD * 0.15], size: [0.085 * Math.sqrt(B.girth), neckL + 0.04, 0.085 * Math.sqrt(B.girth)], center: [0, (neckL + 0.04) / 2, 0], taper: [1.1, 1.1, 0.9, 0.9], shape: 'oct', src: skin('neck', { rect: [0.4, 0.18, 0.6, 0.24], proj: 'front' }), kind: 'core' },
    { name: 'handR', parent: 4, joint: [0, -foreArm, 0], size: [handW, hand, handD], center: [0, -hand / 2 + 0.01, 0], taper: [1.05, 0.8, 1, 1], shape: 'bevel', src: skin('hand', { rect: [0, 0.5, 0.2, 0.58], proj: 'front' }), kind: 'limb' },
    stump
      // torn off below the elbow: a bloody end of bone where the hand was
      ? { name: 'handL', parent: 6, joint: [0, -foreArm * 0.55, 0], size: [foreW * 0.8, 0.035, foreW * 0.8], center: [0, -0.012, 0], shape: 'bevel', src: { zr: 'flesh' }, kind: 'limb' }
      : { name: 'handL', parent: 6, joint: [0, -foreArm, 0], size: [handW, hand, handD], center: [0, -hand / 2 + 0.01, 0], taper: [1.05, 0.8, 1, 1], shape: 'bevel', src: skin('hand', { rect: [0.8, 0.5, 1, 0.58], proj: 'front' }), kind: 'limb' },
  ];
  const add = (p: PartDef) => (parts.push(p), parts.length - 1);

  // ---- silhouette pieces every zombie gets
  const jaw = add({ name: 'headJaw', parent: H.head, joint: [0, jawH * 0.55, headD * 0.18], size: [headW * 0.84, jawH, headD * 0.8], center: [0, -jawH / 2 + 0.01, -headD * 0.24], taper: [0.8, 0.85, 1, 1], shape: 'bevel', src: { zr: 'jaw' }, kind: 'core' });
  add({ name: 'uArmDeltR', parent: H.torso, joint: [shoulderX - armW * 0.1, torsoH - 0.06, 0], size: [delt, delt * 0.9, delt * 1.05], center: [0, 0, 0], shape: 'ball', src: { region: 'upperArm' }, kind: 'limb' });
  add({ name: 'uArmDeltL', parent: H.torso, joint: [-shoulderX + armW * 0.1, torsoH - 0.06, 0], size: [delt, delt * 0.9, delt * 1.05], center: [0, 0, 0], shape: 'ball', src: { region: 'upperArm' }, kind: 'limb' });
  if (B.hump > 0.05) add({ name: 'torsoHump', parent: H.torso, joint: [0, torsoH - 0.1, torsoD * 0.26], size: [torsoW * (0.55 + 0.25 * B.hump), 0.14 + 0.14 * B.hump, torsoD * (0.45 + 0.35 * B.hump)], center: [0, 0, 0], shape: 'ball', src: { region: 'torso' }, kind: 'core' });
  if (B.belly > 0.05) {
    const b = B.belly;
    add({ name: 'torsoBelly', parent: H.torso, joint: [0, 0.12 + 0.03 * b, -torsoD * 0.15], size: [torsoW * (0.95 + 0.55 * b), 0.3 + 0.32 * b, torsoD * (0.9 + 1.6 * b)], center: [0, 0, -torsoD * 0.3 * b], shape: 'ball', src: { region: 'torso', zr: 'belly' }, kind: 'core' });
  }
  if (look.bone) {
    // a ribcage in front of a narrow torso, a pelvis band
    for (let r = 0; r < 4; r++) add({ name: `torsoRib${r}`, parent: H.torso, joint: [0, 0.15 + r * 0.07, -torsoD * 0.5], size: [torsoW * (0.92 - r * 0.04), 0.025, 0.03], center: [0, 0, 0], shape: 'oct', src: { zr: 'bone' }, kind: 'thin' });
  }

  // ---- rags: torn cloth hanging off the body, different for each individual
  const rags: { i: number; on: 'torso' | 'arm'; arm?: 'R' | 'L' }[] = [];
  const rag = (name: string, parent: number, joint: [number, number, number], w: number, h: number, on: 'torso' | 'arm', arm?: 'R' | 'L', region: PartDef['src']['region'] = 'torso') => {
    rags.push({ i: add({ name, parent, joint, size: [w, h, 0.014], center: [0, -h / 2 + 0.01, 0], shape: 'box', src: { zr: 'rag', region }, kind: 'thin' }), on, arm });
  };
  // (sprite3d: the meshes model their own torn hems and sleeves)
  const ragged = !sprite3d && !look.bone && look.gear !== 'hazmat' && look.gear !== 'bioop' && look.build !== 'bloated';
  if (ragged || (look.bone && !sprite3d)) {
    if (v === 0) {
      rag('ragFront', H.torso, [torsoW * 0.18, 0.03, -torsoD / 2 - 0.006], torsoW * 0.4, 0.24, 'torso');
      rag('uArmRagR', H.uArmR, [0, -upperArm + 0.06, 0], armW * 1.25, 0.13, 'arm', 'R', 'upperArm');
    } else if (v === 1) {
      rag('ragBack', H.torso, [-torsoW * 0.12, 0.03, torsoD / 2 + 0.006], torsoW * 0.55, 0.28, 'torso');
      rag('ragSide', H.torso, [-torsoW / 2 - 0.006, 0.05, 0], torsoD * 0.6, 0.2, 'torso');
    } else {
      rag('ragFront', H.torso, [-torsoW * 0.2, 0.03, -torsoD / 2 - 0.006], torsoW * 0.35, 0.3, 'torso');
      rag('ragBack', H.torso, [torsoW * 0.15, 0.03, torsoD / 2 + 0.006], torsoW * 0.35, 0.2, 'torso');
      rag('uArmRagL', H.uArmL, [0, -upperArm + 0.06, 0], armW * 1.25, 0.15, 'arm', 'L', 'upperArm');
    }
  }

  // ---- gear: the uniform pieces that change the outline
  const hW = headW, hD = headD, cY = jawH * 0.45 + craniumH; // crown height in the head frame
  const gear: Gear[] = [];
  switch (look.gear) {
    case 'cop':
      // the sprite's riot helmet with a raised clear visor, a dark navy uniform
      gear.push({ name: 'headHelmet', parent: H.head, joint: [0, cY - 0.065, 0.005], size: [hW * 1.26, 0.14, hD * 1.24], shape: 'ball', color: [30, 36, 58] });
      gear.push({ name: 'headVisor', parent: H.head, joint: [0, cY - 0.02, -hD * 0.6], size: [hW * 1.1, 0.06, 0.02], rest: [-0.5, 0, 0], color: [150, 170, 190], glow: 0.05, zr: 'visor' });
      gear.push({ name: 'torsoBadge', parent: H.torso, joint: [torsoW * 0.22, torsoH * 0.72, -torsoD / 2 - 0.008], size: [0.04, 0.05, 0.015], color: [214, 186, 90], glow: 0.15 });
      break;
    case 'swat':
      gear.push({ name: 'headHelmet', parent: H.head, joint: [0, cY - 0.07, 0.005], size: [hW * 1.28, 0.15, hD * 1.25], shape: 'ball', color: [30, 32, 38] });
      gear.push({ name: 'headVisor', parent: H.head, joint: [0, cY - 0.075, -hD * 0.58], size: [hW * 1.05, 0.07, 0.025], color: [40, 52, 70], glow: 0.08, zr: 'visor' });
      gear.push({ name: 'torsoVest', parent: H.torso, joint: [0, torsoH * 0.55, 0], size: [torsoW * 1.12, torsoH * 0.62, torsoD * 1.3], shape: 'bevel', color: [34, 36, 42] });
      break;
    case 'soldier':
      gear.push({ name: 'headHelmet', parent: H.head, joint: [0, cY - 0.06, 0.01], size: [hW * 1.3, 0.12, hD * 1.3], shape: 'ball', taper: [1.08, 1.08, 0.82, 0.82], color: [78, 84, 56] });
      gear.push({ name: 'torsoVest', parent: H.torso, joint: [0, torsoH * 0.55, 0], size: [torsoW * 1.1, torsoH * 0.6, torsoD * 1.28], shape: 'bevel', color: [86, 90, 60] });
      for (let i = 0; i < 3; i++) gear.push({ name: `torsoPouch${i}`, parent: H.torso, joint: [(i - 1) * torsoW * 0.3, torsoH * 0.38, -torsoD * 0.66], size: [torsoW * 0.22, 0.09, 0.05], shape: 'bevel', color: [70, 74, 48] });
      break;
    case 'hazmat':
      // a big rounded hood over the head and a window, the suit colour from the sprite
      gear.push({ name: 'headHood', parent: H.head, joint: [0, cY * 0.5, 0.01], size: [hW * 1.45, cY + 0.11, hD * 1.4], shape: 'ball', color: [212, 184, 52] });
      gear.push({ name: 'headWindow', parent: H.head, joint: [0, cY * 0.55, -hD * 0.68], size: [hW * 0.95, 0.11, 0.03], shape: 'bevel', color: [120, 150, 190], glow: 0.18, zr: 'visor' });
      break;
    case 'fireman':
      gear.push({ name: 'headHelmet', parent: H.head, joint: [0, cY - 0.04, 0], size: [hW * 1.22, 0.1, hD * 1.2], shape: 'ball', color: [210, 170, 40] });
      gear.push({ name: 'headBrim', parent: H.head, joint: [0, cY - 0.07, 0.03], size: [hW * 1.55, 0.02, hD * 1.75], center: [0, 0, 0.03], rest: [0.12, 0, 0], color: [190, 150, 30] });
      gear.push({ name: 'torsoCoat', parent: H.torso, joint: [0, 0.02, 0], size: [torsoW * 1.12, 0.22, torsoD * 1.18], center: [0, -0.08, 0], taper: [1.12, 1.12, 1, 1], color: [196, 168, 60], zr: 'rag' });
      break;
    case 'bioop':
      gear.push({ name: 'headHelmet', parent: H.head, joint: [0, cY * 0.55, 0], size: [hW * 1.2, cY + 0.06, hD * 1.18], shape: 'bevel', color: [26, 28, 34] });
      gear.push({ name: 'headVisor', parent: H.head, joint: [0, cY * 0.62, -hD * 0.6], size: [hW * 0.95, 0.045, 0.025], color: [60, 220, 240], glow: 0.9, zr: 'visor' });
      gear.push({ name: 'torsoPlate', parent: H.torso, joint: [0, torsoH * 0.55, -torsoD * 0.1], size: [torsoW * 1.05, torsoH * 0.55, torsoD * 1.15], shape: 'bevel', color: [34, 36, 44] });
      break;
    case 'survivor':
      gear.push({ name: 'headHelmet', parent: H.head, joint: [0, cY - 0.06, 0.005], size: [hW * 1.25, 0.12, hD * 1.25], shape: 'ball', color: [40, 44, 70] });
      gear.push({ name: 'torsoPack', parent: H.torso, joint: [0, torsoH * 0.55, torsoD * 0.62], size: [torsoW * 0.8, torsoH * 0.6, 0.14], shape: 'bevel', color: [74, 62, 44] });
      break;
    case 'armored':
      gear.push({ name: 'torsoPlate', parent: H.torso, joint: [0, torsoH * 0.55, 0], size: [torsoW * 1.18, torsoH * 0.7, torsoD * 1.35], shape: 'bevel', color: [92, 96, 84] });
      gear.push({ name: 'uArmPadR', parent: H.torso, joint: [shoulderX, torsoH - 0.02, 0], size: [delt * 1.35, 0.08, delt * 1.3], shape: 'bevel', rest: [0, 0, -0.35], color: [86, 90, 78] });
      gear.push({ name: 'uArmPadL', parent: H.torso, joint: [-shoulderX, torsoH - 0.02, 0], size: [delt * 1.35, 0.08, delt * 1.3], shape: 'bevel', rest: [0, 0, 0.35], color: [86, 90, 78] });
      break;
    case 'miner':
      gear.push({ name: 'headHardhat', parent: H.head, joint: [0, cY - 0.035, 0], size: [hW * 1.3, 0.09, hD * 1.32], shape: 'ball', color: [222, 196, 50] });
      gear.push({ name: 'headLamp', parent: H.head, joint: [0, cY - 0.02, -hD * 0.68], size: [0.05, 0.04, 0.03], shape: 'bevel', color: [255, 244, 190], glow: 1, zr: 'visor' });
      break;
    case 'beekeeper':
      gear.push({ name: 'headBrim', parent: H.head, joint: [0, cY + 0.01, 0], size: [hW * 2.1, 0.016, hD * 2], color: [220, 214, 190] });
      gear.push({ name: 'headVeil', parent: H.head, joint: [0, cY + 0.01, 0], size: [hW * 1.5, 0.22, hD * 1.45], center: [0, -0.11, 0], shape: 'oct', color: [200, 196, 180], zr: 'rag' });
      break;
    case 'scientist':
      // lab coat tails flapping round the thighs
      gear.push({ name: 'ragCoatR', parent: H.torso, joint: [torsoW * 0.27, 0.03, 0], size: [torsoW * 0.5, 0.36, torsoD * 1.15], center: [0, -0.17, 0], shape: 'box', color: [214, 216, 210], zr: 'rag' });
      gear.push({ name: 'ragCoatL', parent: H.torso, joint: [-torsoW * 0.27, 0.03, 0], size: [torsoW * 0.5, 0.36, torsoD * 1.15], center: [0, -0.17, 0], shape: 'box', color: [214, 216, 210], zr: 'rag' });
      break;
    case 'medic':
      gear.push({ name: 'headMask', parent: H.head, joint: [0, jawH * 0.6, -hD * 0.47], size: [hW * 1.0, 0.075, 0.03], color: [150, 196, 186] });
      break;
  }
  const gearI: number[] = [];
  for (const g of gear) {
    const i = add({ name: g.name, parent: g.parent, joint: g.joint, size: g.size, center: g.center ?? [0, 0, 0], rest: g.rest, shape: g.shape ?? 'box', taper: g.taper, src: { zr: g.zr ?? 'gear', color: g.color, glow: g.glow }, kind: g.zr === 'rag' ? 'thin' : 'core' });
    gearI.push(i);
    if (g.zr === 'rag') rags.push({ i, on: 'torso' });
  }

  // ---- features (fx): small animated meshes. 'fx' names are cosmetic: aim picking skips them.
  const fx = new Set(look.fx);
  const sacs: number[] = [], arcs: number[] = [], puffs: { i: number; y: number; r: number; a: number }[] = [], tendrils: number[][] = [], thorns: number[] = [];
  let drool = -1;
  const deg = look.degree;
  if (fx.has('acid')) {
    // glowing yellow-green sacs on the shoulders, back and neck; more and bigger on a corrosive
    const spots: [number, number, number, number, number][] = [
      [0.14, 0.42, 0.06, 0.1, H.torso], [-0.12, 0.38, 0.09, 0.085, H.torso], [0.02, 0.28, 0.12, 0.11, H.torso], [-0.06, 0.12, -0.1, 0.08, H.torso],
      [0.05, 0.03, 0.03, 0.06, H.neck], [0, -0.1, 0.03, 0.07, H.uArmR], [0, -0.06, -0.02, 0.06, H.thighL], [0.1, 0.18, -0.11, 0.075, H.torso],
    ];
    const n = Math.round(4 + 4 * deg);
    for (let k = 0; k < n; k++) {
      const [x, y, z, r, par] = spots[k];
      const rr = r * (0.8 + 0.6 * deg);
      sacs.push(add({ name: par === H.uArmR ? `uArmSac${k}` : par === H.thighL ? `thighSac${k}` : `sac${k}`, parent: par, joint: [x * B.girth, y, z * B.chestD], size: [rr, rr * 0.9, rr], center: [0, 0, 0], shape: 'ball', src: { zr: 'sac', glow: 0.65 }, kind: 'core' }));
    }
    drool = add({ name: 'fxDrool', parent: jaw, joint: [0.01, -jawH * 0.8, -headD * 0.5], size: [0.022, 0.16, 0.022], center: [0, -0.08, 0], taper: [0.4, 0.4, 1, 1], shape: 'oct', src: { zr: 'sac', glow: 0.8 }, kind: 'thin' });
  }
  if (fx.has('arcs')) {
    // electric arcs: thin glowing bolts that jump between joints, re-drawn every pose step
    const at: [number, [number, number, number]][] = [[H.handR, [0, -hand * 0.6, 0]], [H.handL, [0, -hand * 0.6, 0]], [H.torso, [torsoW * 0.4, torsoH * 0.8, 0]], [H.torso, [-torsoW * 0.45, torsoH * 0.3, 0]], [H.head, [0, cY, 0]], [H.shinR, [0, -shin * 0.8, 0]], [H.shinL, [0, -shin * 0.6, 0]], [H.fArmR, [0, -foreArm * 0.5, 0]]];
    const n = Math.round(6 + 4 * deg);
    for (let k = 0; k < n; k++) {
      const [par, j] = at[k % at.length];
      arcs.push(add({ name: `fxArc${k}`, parent: par, joint: j, size: [0.03, 0.38, 0.03], center: [0, 0.18, 0], taper: [1, 1, 0.4, 0.4], shape: 'box', src: { zr: 'arc', glow: 1 }, kind: 'thin' }));
    }
  }
  if (fx.has('smoke')) {
    // a cloud of dithered smoke puffs turning slowly round the body (plus BN's own smoke fields)
    for (let k = 0; k < 10; k++) {
      const y = 0.3 + (k % 5) * 0.32, r = 0.22 + 0.08 * (k % 3), a = k * 2.39;
      puffs.push({ i: add({ name: `fxSmoke${k}`, parent: -1, joint: [0, y, 0], size: [0.5, 0.42, 0.5], center: [r, 0, 0], rest: [0, a, 0], shape: 'ball', src: { zr: 'smoke' }, kind: 'thin' }), y, r, a });
    }
  }
  if (fx.has('tendrils')) {
    // writhing black tendrils out of the upper back, four segments each
    const roots: [number, number, number][] = [[0.1, 0.4, 0.08], [-0.1, 0.38, 0.08], [0.05, 0.24, 0.1], [-0.07, 0.2, 0.1], [0, 0.44, 0.06]];
    for (let t = 0; t < roots.length; t++) {
      const chain: number[] = [];
      let par: number = H.torso;
      let joint: [number, number, number] = [roots[t][0] * B.girth, roots[t][1], roots[t][2]];
      for (let k = 0; k < 4; k++) {
        const len = 0.2 - k * 0.025, w = 0.045 - k * 0.009;
        const i = add({ name: `fxTendril${t}_${k}`, parent: par, joint, size: [w, len, w], center: [0, len / 2, 0], taper: [1, 1, 0.65, 0.65], shape: 'oct', src: { zr: 'tendril' }, kind: 'thin' });
        chain.push(i);
        par = i;
        joint = [0, len * 0.95, 0];
      }
      tendrils.push(chain);
    }
  }
  if (fx.has('thorns')) {
    // a plant mass: leafy clumps over the shoulders and head, yellow-tipped thorns sticking out
    add({ name: 'torsoPlant', parent: H.torso, joint: [0, torsoH * 0.55, 0], size: [torsoW * 1.35, torsoH * 0.95, torsoD * 1.7], center: [0, 0, 0], shape: 'ball', src: { zr: 'plant' }, kind: 'core' });
    add({ name: 'headPlant', parent: H.head, joint: [0, cY * 0.75, 0.02], size: [hW * 1.5, cY * 0.9, hD * 1.45], center: [0, 0, 0], shape: 'ball', src: { zr: 'plant' }, kind: 'core' });
    add({ name: 'uArmPlantR', parent: H.uArmR, joint: [0, -0.08, 0], size: [armW * 2, upperArm * 0.8, armW * 2], center: [0, 0, 0], shape: 'ball', src: { zr: 'plant' }, kind: 'limb' });
    add({ name: 'uArmPlantL', parent: H.uArmL, joint: [0, -0.08, 0], size: [armW * 2, upperArm * 0.8, armW * 2], center: [0, 0, 0], shape: 'ball', src: { zr: 'plant' }, kind: 'limb' });
    for (let k = 0; k < 12; k++) {
      const yaw = k * 2.4, pitch = -0.9 + (k % 4) * 0.55;
      const par = k < 8 ? H.torso : H.head;
      thorns.push(add({ name: `fxThorn${k}`, parent: par, joint: par === H.torso ? [Math.sin(yaw) * torsoW * 0.45, torsoH * (0.2 + (k % 4) * 0.22), Math.cos(yaw) * torsoD * 0.6] : [Math.sin(yaw) * hW * 0.5, cY * 0.8, Math.cos(yaw) * hD * 0.5], size: [0.03, 0.22 + 0.06 * (k % 3), 0.03], center: [0, 0.1, 0], rest: [pitch + 1.57 * Math.cos(yaw) * 0.6, 0, -1.57 * Math.sin(yaw) * 0.7], taper: [1, 1, 0.15, 0.15], shape: 'oct', src: { zr: 'thorn' }, kind: 'thin' }));
    }
  }
  if (fx.has('redEyes')) {
    // eyes that burn red out of a black face: separate glowing pips so they read past 10 m
    for (const x of [-1, 1]) add({ name: x > 0 ? 'headEyeR' : 'headEyeL', parent: H.head, joint: [x * headW * 0.22, jawH * 0.45 + craniumH * 0.45, -headD * 0.47], size: [0.032, 0.022, 0.02], center: [0, 0, 0], shape: 'box', src: { zr: 'arc', color: [255, 40, 30], glow: 1 }, kind: 'thin' });
  }
  if (fx.has('charred')) {
    for (let k = 0; k < 6; k++) add({ name: `torsoChar${k}`, parent: k < 4 ? H.torso : H.head, joint: k < 4 ? [((k * 37) % 7 - 3) * 0.035 * B.girth, 0.1 + ((k * 13) % 5) * 0.08, -torsoD * 0.52] : [((k * 5) % 3 - 1) * 0.05, cY * 0.7, -hD * 0.5], size: [0.07, 0.05, 0.02], center: [0, 0, 0], rest: [0, 0, k * 0.7], shape: 'bevel', src: { color: [26, 22, 20], zr: 'gear' }, kind: 'thin' });
  }

  // wings (BN FLIES): the person rig's membrane wings on the back
  let wingR = -1, wingL = -1;
  if (sh.wings !== 'none') {
    wingR = add({ name: 'wingR', parent: H.torso, joint: [0.08, 0.38, torsoD * 0.5], size: [0.75, 0.55, 0.03], center: [0.37, 0.05, 0], rest: [0, -0.4, 0.3], shape: 'box', src: { role: 'wing', zr: 'rag', region: 'torso' }, kind: 'thin' });
    wingL = add({ name: 'wingL', parent: H.torso, joint: [-0.08, 0.38, torsoD * 0.5], size: [0.75, 0.55, 0.03], center: [-0.37, 0.05, 0], rest: [0, 0.4, -0.3], shape: 'box', src: { role: 'wing', zr: 'rag', region: 'torso' }, kind: 'thin' });
  }

  let meshModel: SpriteModelId | undefined;
  if (sprite3d) {
    meshModel = spriteModelOf(look);
    const want = new Set([...SPRITE_CORE_PARTS, ...SPRITE_MODEL_GEAR[meshModel]]);
    for (const p of parts) {
      // a torn-off forearm's bloody stump keeps its painted shape (it is not a hand)
      if (!want.has(p.name) || p.src.zr === 'flesh') continue;
      p.mesh = `${meshModel}/${p.name}`;
      // the mesh is modelled tapered; the per-instance taper would squeeze it twice
      delete p.taper;
    }
  }
  const scaled = scaleParts(parts, s);
  /** floor contact correction (m), from the idle pose below */
  let ground = 0;
  const legLen = thigh + shin;
  // standing height: computed from the idle pose below (the hunch changes it a lot)
  const rig: Rig = {
    shape: sh, parts: scaled, height: 1, hover: sh.flies ? 0.6 * s : 0, zlook: look,
    skinTag: `z:${look.family}:${look.build}:${look.gear}:${look.fx.join('+')}:${look.bone ? 'b' : ''}:${style}:${v}`,
    ...(meshModel ? { meshModel } : {}),
    lie: crawl ? { angle: 0.3, lift: 0, side: true } : { angle: Math.PI / 2, lift: torsoD * (B.belly > 0.3 ? 0.5 + 0.8 * B.belly : 0.5) * s, side: false },
    pose(p, o) {
      if (crawl && !p.ride) {
        crawlPose(crawl, p, o, s, hipY, -1);
        jawAndFx(p, o, 0.25, true);
        return;
      }
      if (p.dead) {
        deadPose(p, o);
        jawAndFx(p, o, 0.35, true);
        return;
      }
      const st = baseState(p);
      walk(p, o, st);
      telegraph(p, st);
      apply(o, st);
      o.pos[1] += ground;
      jawAndFx(p, o, st.jaw, false);
      ragsHang(p, o, st);
      if (wingR >= 0) {
        const f = sin(p.t * 9 + p.seed * 5) * 0.6;
        setRot(o, wingR, 0, 0, f);
        setRot(o, wingL, 0, 0, -f);
        o.pos[1] += 0.08 * sin(p.t * 4.5) * s;
      }
    },
  };

  const sin = Math.sin, cos = Math.cos, TAU = Math.PI * 2;

  /** Resting posture of this individual (quirks from its seed), idle breathing on top. */
  function baseState(p: PoseIn): ZState {
    const q = (k: number) => quirk(p.seed, k);
    const idle = sin(p.t * 1.7 + p.seed * TAU);
    // one arm hangs dead in about a third of a horde (never on the brutes' fists)
    // (not in sprite3d: every UltiCa zombie holds both arms out)
    const dangle = !sprite3d && !hulkArms && look.build !== 'bloated' && q(3) < 0.33;
    const hunch = B.hunch * (0.8 + 0.4 * q(1));
    const reachR = B.reach + 0.12 * (q(7) - 0.5) + 0.05 * idle;
    const stride = B.stride * Math.max(0, 1 - p.gait);
    const reachL = dangle ? 0.15 + 0.08 * sin(p.t * 1.1 + p.seed * 3) : B.reach + 0.12 * (q(8) - 0.5) - 0.05 * idle;
    return {
      lean: hunch + 0.03 * idle, roll: (q(5) - 0.5) * 0.14, twist: (q(9) - 0.5) * 0.2,
      head: -hunch * (1 - B.headComp) + 0.05 * idle, headTurn: 0.12 * sin(p.t * 0.9 + p.seed * 9), headRoll: (q(2) - 0.5) * 0.5,
      armR: reachR, armL: reachL, outR: B.armOut, outL: dangle ? 0.05 : B.armOut,
      elbR: B.elbow + 0.1 * sin(p.t * 1.3 + p.seed * 4), elbL: dangle ? 0.05 : B.elbow + 0.1 * sin(p.t * 1.1 + p.seed * 7),
      wriR: B.wrist, wriL: dangle ? -0.1 : B.wrist,
      knee: B.knee * (0.85 + 0.3 * q(4)), jaw: 0.12 + 0.1 * Math.max(0, sin(p.t * 2.3 + p.seed * 11)),
      // (the resting stride gives way to the walk cycle)
      dx: 0, dy: 0, dz: 0, legR: stride * (q(11) < 0.5 ? 1 : -0.8), legL: stride * (q(11) < 0.5 ? -0.8 : 1),
    };
  }

  /** Walk cycle: a lurching shamble (a dragged leg, sway onto the good one) or a run. */
  function walk(p: PoseIn, o: PoseOut, st: ZState): void {
    const ph = p.phase * TAU;
    const walkK = Math.min(1, p.gait), run = Math.max(0, p.gait - 1);
    if (walkK <= 0) return;
    const amp = walkK * 0.42 + run * 0.4;
    const drag = look.build === 'runner' ? 0 : 0.5 * quirk(p.seed, 4);
    for (const [thighI, shinI, footI, off, k] of [[H.thighR, H.shinR, H.footR, 0, 1], [H.thighL, H.shinL, H.footL, Math.PI, 1 - drag]] as const) {
      const a = sin(ph + off) * amp * k;
      const knee = -Math.max(0, cos(ph + off)) * (amp * 1.3 + run * 0.5) * k;
      setRot(o, thighI, a);
      setRot(o, shinI, knee);
      setRot(o, footI, -(a + knee) * 0.7);
    }
    o.pos[1] -= Math.abs(sin(ph)) * 0.035 * walkK * s;
    const lurch = (0.07 + 0.08 * quirk(p.seed, 6)) * B.lurch * walkK;
    o.lean[2] += sin(ph) * lurch;
    o.pos[0] += sin(ph) * 0.035 * B.lurch * walkK * s;
    st.headRoll -= sin(ph) * lurch * 0.8;
    // running pitches the whole body into the stride
    st.lean += run * 0.3;
    if (B.swing > 0) {
      // brutes and runners swing their arms against the legs instead of reaching
      const sw = (0.5 + 0.5 * run) * B.swing * walkK;
      st.armR += -sin(ph) * 0.9 * sw - B.reach * 0.3 * sw;
      st.armL += sin(ph) * 0.9 * sw - B.reach * 0.3 * sw;
    } else {
      st.armR += 0.1 * sin(ph + 1) * walkK;
      st.armL += 0.1 * sin(ph + 2.2) * walkK;
    }
  }

  /** Wind-ups and follow-throughs: unmistakable at a glance. */
  function telegraph(p: PoseIn, st: ZState): void {
    if (p.windup !== null) {
      const u = ease(p.windup);
      if (p.windKind === 'leap') {
        // crouch before a lunge: coiled low, chest over the knees, arms swept back, eyes up
        blend(st, { lean: 1.05, head: -0.15, headRoll: 0, armR: -0.75, armL: -0.65, outR: 0.4, outL: 0.4, elbR: 0.7, elbL: 0.7, wriR: -0.5, wriL: -0.5, knee: 1.6, jaw: 0.55, dz: 0.18, legR: 0.25, legL: -0.15 }, u);
      } else if (p.windKind === 'heavy' || hulkArms) {
        // a double-fisted overhead hammer: both fists high and together, rocked back
        blend(st, { lean: -0.45, head: 0.45, headRoll: 0, armR: 2.95, armL: 2.95, outR: 0.3, outL: 0.3, elbR: 1.35, elbL: 1.35, wriR: 0.3, wriL: 0.3, knee: 0.5, jaw: 0.8, dz: 0.22, dy: 0.02 }, u);
      } else {
        // rear back: torso arched, both arms thrown up and back over the head, maw open
        blend(st, { lean: -0.32, head: 0.35, headRoll: 0, armR: 2.7, armL: 2.55, outR: 0.3, outL: 0.3, elbR: 0.95, elbL: 0.95, wriR: -0.2, wriL: -0.2, knee: 0.3, jaw: 0.8, dz: 0.14 }, u);
      }
    }
    if (p.strike > 0) {
      const k = p.strike;
      if (p.windKind === 'leap') {
        // the lunge-grab: body flung forward, both arms straight out and open, a leg trailing
        blend(st, { lean: 1.2, head: -0.65, headRoll: 0, armR: 1.62, armL: 1.55, outR: 0.28, outL: 0.28, elbR: 0.1, elbL: 0.1, wriR: 0.25, wriL: 0.25, knee: 0.35, jaw: 0.9, dz: -0.45, dy: 0.04, legR: 0.6, legL: -0.7 }, k);
      } else {
        // follow-through: arms slammed down and forward, torso pitched in
        blend(st, { lean: B.hunch + 0.5, head: -0.2, armR: 1.15, armL: 1.05, outR: 0.05, outL: 0.05, elbR: 0.1, elbL: 0.1, jaw: 0.5, dz: -0.15 }, k);
      }
    }
    if (p.flinch > 0) {
      const f = p.flinch;
      st.lean -= 0.35 * f;
      st.head += 0.4 * f;
      st.headRoll += 0.25 * f * (p.seed > 0.5 ? 1 : -1);
      st.elbR += 0.3 * f;
      st.elbL += 0.3 * f;
      st.jaw += 0.3 * f;
    }
    if (p.down > 0) {
      // lying on the back (the topple is the root's): arms fall to the sides, legs straighten
      const d = p.down;
      blend(st, { lean: 0, head: 0, armR: 0.1, armL: 0.1, outR: 0.6, outL: 0.6, elbR: 0.2, elbL: 0.2, knee: 0, dz: 0 }, d);
    }
  }

  /** World-terms state -> part rotations. */
  function apply(o: PoseOut, st: ZState): void {
    // torso lean (-x leans forward); everything on the torso inherits it, so arms and head
    // add the lean back to reach their world angles
    setRot(o, H.torso, -st.lean, st.twist, st.roll);
    // the neck juts forward out of the hunch toward the head
    setRot(o, H.neck, -0.35 + st.lean * 0.2);
    setRot(o, H.head, st.head + st.lean, st.headTurn, st.headRoll);
    setRot(o, H.uArmR, st.armR + st.lean, 0, st.outR);
    setRot(o, H.uArmL, st.armL + st.lean, 0, -st.outL);
    setRot(o, H.fArmR, st.elbR);
    setRot(o, H.fArmL, st.elbL);
    setRot(o, H.handR, st.wriR);
    setRot(o, H.handL, st.wriL);
    // knees: thigh forward, shin back twice as far, foot level; the hips drop to keep the feet
    // on the floor (ankle below the hip = leg length · cos of the thigh angle)
    const a = 0.6 * st.knee;
    for (const [t, sn, f, sp, side] of [[H.thighR, H.shinR, H.footR, st.legR, 1], [H.thighL, H.shinL, H.footL, st.legL, -1]] as const) {
      setRot(o, t, a + sp, 0, side * B.stance);
      setRot(o, sn, -2 * a - Math.max(0, sp) * 0.6);
      setRot(o, f, a - sp * 0.4 + Math.max(0, sp) * 0.6);
    }
    const sp = Math.max(Math.abs(st.legR), Math.abs(st.legL));
    o.pos[1] -= (legLen * (1 - cos(a)) + legLen * (1 - cos(sp)) * 0.5) * s;
    // a hunched body carries its hips back over the feet
    o.pos[2] += (st.lean * 0.08 + st.dz) * s;
    o.pos[0] += st.dx * s;
    o.pos[1] += st.dy * s;
  }

  /** The jaw, the features' animation (sacs pulse, arcs jump, smoke turns, tendrils writhe). */
  function jawAndFx(p: PoseIn, o: PoseOut, jawOpen: number, dead: boolean): void {
    const maw = fx.has('maw') ? 0.45 : 0;
    // (-x drops the chin: +x would swing the jaw's front up into the skull)
    setRot(o, jaw, -Math.min(1.1, jawOpen + maw));
    for (const [k, i] of sacs.entries()) {
      const pulse = 1 + 0.14 * sin(p.t * 3.1 + k * 1.7);
      o.scl[i * 3] = o.scl[i * 3 + 1] = o.scl[i * 3 + 2] = pulse;
    }
    if (drool >= 0) o.scl[drool * 3 + 1] = 0.6 + 0.4 * ((p.t * 0.7 + p.seed) % 1);
    const frame = Math.floor(p.t * 10);
    for (const [k, i] of arcs.entries()) {
      const h = (n: number) => { const x = Math.sin((frame * 7.13 + k * 3.7 + n * 1.31) * 12.9898) * 43758.5453; return x - Math.floor(x); };
      // dead bodies stop crackling
      const on = !dead && h(0) > 0.25;
      setRot(o, i, (h(1) - 0.5) * 5, (h(2) - 0.5) * 5, (h(3) - 0.5) * 5);
      o.scl[i * 3 + 1] = on ? 0.35 + 1.1 * h(4) : 0.04;
    }
    for (const [k, pf] of puffs.entries()) {
      const ph = (p.t * 0.18 + k / puffs.length) % 1;
      setRot(o, pf.i, 0, p.t * 0.5 + k * 0.3, 0);
      const g = (0.65 + 0.7 * ph) * (ph > 0.85 ? 1 - (ph - 0.85) / 0.15 * 0.7 : 1);
      o.scl[pf.i * 3] = o.scl[pf.i * 3 + 1] = o.scl[pf.i * 3 + 2] = g;
    }
    for (const [t, chain] of tendrils.entries()) {
      for (const [k, i] of chain.entries()) {
        const w = dead ? 0.15 : 1;
        // the root points up and back, each segment curls further
        setRot(o, i, (k === 0 ? 0.9 : 0.35) * w + 0.45 * sin(p.t * 1.9 + t * 1.3 + k * 0.9) * w, 0, (k === 0 ? (t % 2 ? 0.6 : -0.6) : 0) + 0.4 * sin(p.t * 1.4 + t * 2.1 + k * 1.1) * w);
      }
    }
    for (const [k, i] of thorns.entries()) setRot(o, i, 0.05 * sin(p.t * 1.2 + k), 0, 0);
  }

  /** Rags hang under gravity (their parents lean and reach) and sway with the walk. */
  function ragsHang(p: PoseIn, o: PoseOut, st: ZState): void {
    const sway = 0.12 * sin(p.phase * TAU * 2 + p.seed * 5) * Math.min(1, p.gait) + 0.04 * sin(p.t * 1.3 + p.seed * 3);
    for (const r of rags) {
      if (r.on === 'torso') setRot(o, r.i, st.lean + sway - 0.05);
      else setRot(o, r.i, -(r.arm === 'R' ? st.armR : st.armL) + sway);
    }
  }

  /** A corpse: limp, arms flung out, jaw slack (nothing points at the sky). */
  function deadPose(p: PoseIn, o: PoseOut): void {
    setRot(o, H.head, 0.1, 0.6 * (p.seed - 0.5), 0.5 * (p.seed - 0.5));
    setRot(o, H.uArmR, 0.1, 0, 0.9 + 0.5 * p.seed);
    setRot(o, H.fArmR, 0.2 * p.seed);
    setRot(o, H.uArmL, 0.15 * (1 - p.seed), 0, -(0.7 + 0.6 * (1 - p.seed)));
    setRot(o, H.fArmL, 0.25);
    setRot(o, H.thighR, -0.05, 0, 0.14);
    setRot(o, H.thighL, 0.05, 0, -0.1);
    setRot(o, H.shinR, -0.1);
    setRot(o, H.footR, 1.1, 0, 0.2);
    setRot(o, H.footL, 1.1, 0, -0.2);
    for (const r of rags) setRot(o, r.i, r.on === 'torso' ? -1.2 : 0);
  }

  // Standing height and floor contact from the idle pose itself (the hunch, the crouch, a hump
  // or a raised helmet all change them): forward kinematics of the scaled parts.
  const idle: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.5 };
  const [lo] = poseBounds(rig, idle);
  // the lowest point at rest (a toe) touches the floor
  ground = -lo;
  const [, hi] = poseBounds(rig, idle);
  rig.height = crawl ? (hipY + 0.06 + 0.49 + craniumH + jawH) * s * CRAWL_HEIGHT[crawl] : hi;
  return rig;
}

// ------------------------------------------------------------------ tiny forward kinematics

type M4 = Float64Array;
function mul(a: M4, b: M4): M4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + rr] * b[c * 4 + k];
    r[c * 4 + rr] = v;
  }
  return r;
}
/** Column-major T(t) · R(euler XYZ) · S(s), like three.js Matrix4.compose. */
function compose(t: readonly number[], e: readonly number[], s: readonly number[] = [1, 1, 1]): M4 {
  const [x, y, z] = e;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), ee = Math.cos(z), f = Math.sin(z);
  const ae = a * ee, af = a * f, be = b * ee, bf = b * f;
  const m = new Float64Array(16);
  // three.js Matrix4.makeRotationFromEuler, order XYZ
  m[0] = c * ee; m[4] = -c * f; m[8] = d;
  m[1] = af + be * d; m[5] = ae - bf * d; m[9] = -b * c;
  m[2] = bf - ae * d; m[6] = be + af * d; m[10] = a * c;
  for (let i = 0; i < 3; i++) (m[i] *= s[0], m[4 + i] *= s[1], m[8 + i] *= s[2]);
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}

/** Lowest and highest y (m) of a rig's part boxes in a pose, at the origin with no yaw. */
export function poseBounds(rig: Rig, p: PoseIn): [number, number] {
  const n = rig.parts.length;
  const o = { rot: new Float32Array(n * 3), scl: new Float32Array(n * 3).fill(1), pos: [0, 0, 0] as [number, number, number], lean: [0, 0, 0] as [number, number, number] };
  rig.pose(p, o);
  const root = mul(compose([0, 0, 0], o.lean), compose(o.pos, [0, 0, 0]));
  const J: M4[] = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const pd = rig.parts[i];
    const r = pd.rest ?? [0, 0, 0];
    J[i] = mul(pd.parent < 0 ? root : J[pd.parent], compose(pd.joint, [r[0] + o.rot[i * 3], r[1] + o.rot[i * 3 + 1], r[2] + o.rot[i * 3 + 2]]));
    // fx parts (smoke, arcs) don't count toward the body's height
    if (pd.name.startsWith('fx')) continue;
    const sc = [pd.size[0] * o.scl[i * 3], pd.size[1] * o.scl[i * 3 + 1], pd.size[2] * o.scl[i * 3 + 2]];
    const M = mul(J[i], compose([pd.center[0] * o.scl[i * 3], pd.center[1] * o.scl[i * 3 + 1], pd.center[2] * o.scl[i * 3 + 2]], [0, 0, 0], sc));
    for (const cx of [-0.5, 0.5]) for (const cy of [-0.5, 0.5]) for (const cz of [-0.5, 0.5]) {
      const y = M[1] * cx + M[5] * cy + M[9] * cz + M[13];
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  return [lo, hi];
}

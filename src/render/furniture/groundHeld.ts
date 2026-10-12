import * as THREE from 'three';
import type { ItemDef } from '../../data/types';
import type { RGB } from '../colors';
import type { V3 } from '../geometry';
import { heldClass, heldVariant, type HeldBuild, type HeldClass, type HeldItemLike } from '../chars/held';
import type { Detail } from '../chars/rig';
import { visualPreference, storeVisualPreference } from '../visualPreference';
import type { ModelBuilder } from './mesh';
import type { MatKind } from './paint';
import { F } from './kit';

// Weapons and tools lying on the ground, drawn with the same parts as when they're held
// (render/chars/held.ts) instead of a generic stand-in: a dropped Marlin was a brown plank
// (items.ts 'gun': a box with a stock block), a rifle without UltiCa art a "(" glyph in the
// billboard looks. The part list is baked into the chunk geometry like any furniture model
// (ModelBuilder: per-face pixel textures at 32 texels/m, merged into the chunk's draw), so a
// loot room of fifty guns costs quads, not draw calls, and each item id is built once.
//
// Switch: `?grounditems=held|shape`, Options > World > Dropped weapons, gallery "Dropped
// weapons"; 'shape' is the v2 look (generic shapes only).

export type GroundItemStyle = 'held' | 'shape';
export const GROUND_ITEM_STYLES: readonly GroundItemStyle[] = ['held', 'shape'];
export const groundItemState = { style: visualPreference<GroundItemStyle>('grounditems', GROUND_ITEM_STYLES, 'held') };
export const storeGroundItemStyle = (s: GroundItemStyle) => storeVisualPreference('grounditems', s);

/** An ItemDef as heldClass/heldVariant read it (on the ground there's no Item instance). */
export function heldItemLike(d: ItemDef): HeldItemLike {
  const sub = (d as { subtypes?: string[] }).subtypes;
  const gun = d.type === 'GUN' || !!sub?.includes('GUN');
  return { typeId: d.id, isGun: () => gun, def: d as HeldItemLike['def'] };
}

/**
 * Categories whose items may lie as a held mesh. heldClass is written for what someone wields,
 * so its keywords catch plenty that is never wielded (a "bar" of soap, a light_battery_cell's
 * "_bat", a tobacco pipe); on the ground every item passes through it, so only weapons, tools
 * and the scrap people pick up to fight with (pipes, rebar, sticks, 2x4s) qualify, minus the
 * keyword accidents below.
 */
const HELD_CATEGORIES = /^(guns|weapons|tools.*|scrap_metal|scrap_wood|other|electronics)$/;
const NOT_HELD = /lantern|phone|jackhammer|oxy_torch|batter|pipe_cleaner|crackpipe|pipe_glass|pipe_tobacco|bagpipe|balance|razor_blade|chopstick|golf_tee|golf_ball|disc_golf|baseball$|spiked_boxing|^l-stick/;

/** The held class and variant to lay on the ground, or null (generic: keep the item shape). */
export function groundHeldClass(d: ItemDef): { cls: HeldClass; variant: string } | null {
  if (!HELD_CATEGORIES.test(d.category ?? '') || NOT_HELD.test(d.id)) return null;
  const like = heldItemLike(d);
  const cls = heldClass(like);
  if (cls === 'generic') return null;
  // bows, slings and throwing guns fall through heldClass's skill table to a rifle or pistol:
  // a recurve bow lying as an AR is worse than the generic shape
  const skill = (d as { skill?: string }).skill;
  if (like.isGun!() && cls !== 'crossbow' && (skill === 'archery' || skill === 'throw')) return null;
  return { cls, variant: heldVariant(like, cls) };
}

/** Furniture-painter material for a held part's detail (wood grain, knurled polymer, steel...). */
function matFor(detail: Detail | undefined, c: RGB): MatKind {
  switch (detail) {
    case 'grain': return 'wood';
    case 'knurl': return 'rubber';
    case 'tape': return 'fabric';
    case 'bevel': return 'chrome';
    case 'metal': case 'serration': case 'port': case 'vent': return 'metal';
  }
  // undetailed parts: sights, pins, caps, beads. Grey reads as metal, colour as plastic
  const sat = Math.max(...c) - Math.min(...c);
  return sat < 30 ? 'metal' : 'plastic';
}

// The unit cube's faces, as ModelBuilder.box orders them (counter-clockwise from outside;
// a = bottom-left of the texture).
const FACES: [V3, V3, V3, V3][] = [
  [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
  [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]],
  [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]],
  [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]],
  [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]],
  [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]],
];

/** Longest horizontal extent (m) a dropped item is drawn at, before and after readability scaling. */
const MIN_LEN = 0.34, MAX_LEN = 1.3, MAX_UPSCALE = 1.6;

export interface GroundHeldInfo {
  /** height of the model's top above the surface (m) */
  h: number;
  /** longest horizontal extent (m) */
  len: number;
  /** readability scale applied */
  s: number;
}

/** One held part's box as six face quads in the root frame, with its colour and paint detail. */
export interface HeldBox { pts: V3[][]; color: RGB; detail?: Detail }

/**
 * The parts of `held` as face quads under `root` (the item's own frame, then root), and their
 * bounds. Mirrors charLayer's rig evaluation: part frame = parent * T(joint) * R(rest, XYZ),
 * box = frame * T(center) * S(size) of a unit cube whose cross-section is tapered along y (or
 * z). Shared by the ground bake below and the inventory icons (heldIcon.ts).
 */
export function heldPartBoxes(held: HeldBuild, root: THREE.Matrix4): { boxes: HeldBox[]; lo: number[]; hi: number[] } {
  const frames: THREE.Matrix4[] = [];
  const e = new THREE.Euler(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  const boxes: HeldBox[] = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of held.parts) {
    const r = p.rest ?? [0, 0, 0];
    e.set(r[0], r[1], r[2]);
    q.setFromEuler(e);
    const J = new THREE.Matrix4().compose(v.set(p.joint[0], p.joint[1], p.joint[2]), q, one);
    J.premultiply(p.parent < 0 ? root : frames[p.parent]);
    frames.push(J);
    const M = new THREE.Matrix4().makeScale(p.size[0], p.size[1], p.size[2]).setPosition(p.center[0], p.center[1], p.center[2]).premultiply(J);
    const t = p.taper ?? [1, 1, 1, 1];
    const zAxis = p.taperAxis === 'z';
    const pts = FACES.map((f) => f.map(([x, y, z]) => {
      const k = (zAxis ? z : y) + 0.5;
      const sa = t[0] + (t[2] - t[0]) * k, sb = t[1] + (t[3] - t[1]) * k;
      v.set(x * sa, zAxis ? y * sb : y, zAxis ? z : z * sb).applyMatrix4(M);
      for (let i = 0; i < 3; i++) {
        const c = v.getComponent(i);
        if (c < lo[i]) lo[i] = c;
        if (c > hi[i]) hi[i] = c;
      }
      return [v.x, v.y, v.z] as V3;
    }));
    const src = p.src as { color?: RGB; detail?: Detail };
    boxes.push({ pts, color: src.color ?? [128, 128, 128], detail: src.detail });
  }
  return { boxes, lo, hi };
}

/**
 * Bake `held` lying at rest into `b`, origin = the centre of its footprint on the surface.
 * Guns lie on one side (sights sideways), melee weapons and tools flat (the thin axis up: a
 * knife on its flat, not its edge). `side` (+1 / -1) picks which side faces up. Small things
 * are scaled up toward MIN_LEN, like the generic shapes (items.ts itemSize), so a pistol on a
 * table reads past arm's length; a spear longer than a tile is shrunk to MAX_LEN.
 */
export function buildGroundHeld(b: ModelBuilder, held: HeldBuild, side: 1 | -1): GroundHeldInfo {
  // lie down: roll a quarter turn about the item's length axis (z for guns; melee weapons
  // stand along y, so the same roll about z lays them along x, thin side up)
  const ground = new THREE.Matrix4().makeRotationZ((side * Math.PI) / 2);
  const { boxes, lo, hi } = heldPartBoxes(held, ground);
  const len0 = Math.max(hi[0] - lo[0], hi[2] - lo[2], 1e-3);
  let s = Math.min(MAX_UPSCALE, Math.max(1, MIN_LEN / len0));
  if (len0 * s > MAX_LEN) s = MAX_LEN / len0;
  const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
  const put = (p: V3): V3 => [(p[0] - cx) * s, (p[1] - lo[1]) * s, (p[2] - cz) * s];
  b.aoHeight = 0.02;
  for (const bx of boxes) {
    const spec = F(matFor(bx.detail, bx.color), bx.color, undefined, false);
    for (const f of bx.pts) b.quad(put(f[0]), put(f[1]), put(f[2]), put(f[3]), spec);
  }
  return { h: (hi[1] - lo[1]) * s, len: len0 * s, s };
}

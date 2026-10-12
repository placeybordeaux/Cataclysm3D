import * as THREE from 'three';
import type { Vec3 } from '../game/aimmodel';

// Exact ray picking against a drawn 3D character (render/chars): every body part is a box, the
// unit cube (−0.5..0.5) under that part's world matrix (CharInstance.mats, rebuilt each frame
// it changed — so this tests exactly the pose the player saw). Used by src/aim.ts for the
// free-aim hit zones (aimHooks.pick). Coordinates in and out are the game's (x east, y south,
// h up); three.js is (x, h, y).

export interface PickableModel {
  readonly rig: { parts: readonly { name: string }[] };
  readonly mats: Float32Array;
  readonly visible: boolean;
}

/**
 * Cosmetic effect parts (zombie smoke, arcs, tendrils, drool: chars/zombie.ts names them 'fx…')
 * are not body: shots pass through them, and their flicker (scaled near zero) never makes a
 * model unpickable.
 */
const isFx = (name: string) => name.startsWith('fx');

const M = new THREE.Matrix4();
const O = new THREE.Vector3();
const D = new THREE.Vector3();
const M3 = new THREE.Matrix3();

/** Slab test of a ray against the unit cube; returns the entry parameter (≥ 0) or null. */
export function rayUnitBox(o: THREE.Vector3, d: THREE.Vector3): number | null {
  let lo = 0, hi = Infinity;
  for (const k of ['x', 'y', 'z'] as const) {
    const ok = o[k], dk = d[k];
    if (Math.abs(dk) < 1e-12) {
      if (ok < -0.5 || ok > 0.5) return null;
      continue;
    }
    let a = (-0.5 - ok) / dk, b = (0.5 - ok) / dk;
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a);
    hi = Math.min(hi, b);
    if (lo > hi) return null;
  }
  return lo;
}

/**
 * Many rays against one model (a melee swing's fan): invert each part's matrix once, then test
 * rays cheaply. Undefined when the model can't be tested (see pickModel).
 */
export function prepareModel(model: PickableModel): ((o: Vec3, d: Vec3) => { t: number; part: string } | null) | undefined {
  if (!model.visible) return undefined;
  const parts = model.rig.parts;
  const inv: { m: THREE.Matrix4; l: THREE.Matrix3; name: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (isFx(parts[i].name)) continue;
    const m = new THREE.Matrix4().fromArray(model.mats, i * 16);
    if (Math.abs(m.determinant()) < 1e-12) return undefined;
    m.invert();
    inv.push({ m, l: new THREE.Matrix3().setFromMatrix4(m), name: parts[i].name });
  }
  return (o, d) => {
    let best: { t: number; part: string } | null = null;
    for (const p of inv) {
      O.set(o.x, o.h, o.y).applyMatrix4(p.m);
      D.set(d.x, d.h, d.y).applyMatrix3(p.l);
      const t = rayUnitBox(O, D);
      if (t !== null && (!best || t < best.t)) best = { t, part: p.name };
    }
    return best;
  };
}

/**
 * The first part of `model` the ray `o + t·d` enters (d a unit vector): its name and t (metres
 * along d). Null when it misses every part. Undefined when the model can't be tested (hidden,
 * or its matrices were never built).
 */
export function pickModel(model: PickableModel, o: Vec3, d: Vec3): { t: number; part: string } | null | undefined {
  if (!model.visible) return undefined;
  const parts = model.rig.parts;
  let best: { t: number; part: string } | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (isFx(parts[i].name)) continue;
    M.fromArray(model.mats, i * 16);
    // An unbuilt (all-zero) or degenerate matrix: the model hasn't been drawn yet.
    if (Math.abs(M.determinant()) < 1e-12) return undefined;
    M.invert();
    O.set(o.x, o.h, o.y).applyMatrix4(M);
    // The linear part only, unnormalised, so the local parameter t is still world metres along d.
    D.set(d.x, d.h, d.y).applyMatrix3(M3.setFromMatrix4(M));
    const t = rayUnitBox(O, D);
    if (t !== null && (!best || t < best.t)) best = { t, part: parts[i].name };
  }
  return best;
}

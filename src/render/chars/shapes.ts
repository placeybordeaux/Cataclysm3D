import * as THREE from 'three';

// Unit shapes for the instanced characters (charLayer.ts). Every shape fits the unit cube
// (-0.5..0.5) and keeps the cube's six-face texturing: each triangle belongs to one of the six
// box faces (paint.ts net order: right +x, front -z, left -x, back +z, top +y, bottom -y) and
// takes its uv by projecting onto that face's plane. So a chamfer or a bevel samples the edge
// strip of the face it leans toward, and any rig part can switch shape without repainting.
// The per-instance taper (charLayer TAPER) works unchanged: it only scales the cross-section.
//
//   box    the plain cube (12 triangles)
//   oct    an octagonal prism along y: limbs, necks, torsos (36)
//   bevel  every edge chamfered a little: heads, hands, feet, hips (108)
//   ball   chamfered to a rhombicuboctahedron: bellies, sacs, skulls, shoulders (108)

export type Shape = 'box' | 'oct' | 'bevel' | 'ball';
export const SHAPES: readonly Shape[] = ['box', 'oct', 'bevel', 'ball'];

type V3 = [number, number, number];

/** Face id -> outward normal, u axis (viewer's right), v axis (down); same as the old cube. */
const FACES: [V3, V3, V3][] = [
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
];

/** Face id of the box face along axis a (0 x, 1 y, 2 z) on side s (+1/-1). */
function faceOf(a: number, s: number): number {
  if (a === 0) return s > 0 ? 0 : 2;
  if (a === 1) return s > 0 ? 4 : 5;
  return s > 0 ? 3 : 1;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mid = (...ps: V3[]): V3 => {
  const r: V3 = [0, 0, 0];
  for (const p of ps) (r[0] += p[0] / ps.length, r[1] += p[1] / ps.length, r[2] += p[2] / ps.length);
  return r;
};

class Builder {
  P: number[] = [];
  N: number[] = [];
  F: number[] = [];
  UV: number[] = [];
  I: number[] = [];
  /**
   * A planar convex polygon belonging to box face `face`. Wound outward whatever order it is
   * given in (every shape here is convex around the origin), flat-shaded with its own normal
   * so bevels catch the banded light as facets.
   */
  poly(pts: V3[], face: number): void {
    let n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    if (dot(n, mid(...pts)) < 0) {
      pts = [...pts].reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    const [, u, v] = FACES[face];
    const base = this.P.length / 3;
    for (const p of pts) {
      this.P.push(p[0], p[1], p[2]);
      this.N.push(n[0], n[1], n[2]);
      const a = dot(p, u) + 0.5, b = dot(p, v) + 0.5;
      this.F.push(face, a, b);
      this.UV.push(a, b);
    }
    for (let i = 1; i + 1 < pts.length; i++) this.I.push(base, base + i, base + i + 1);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setAttribute('cFace', new THREE.Float32BufferAttribute(this.F, 3));
    g.setIndex(this.I);
    return g;
  }
}

/** A point with coordinate `va` on axis a, `vb` on b, `vc` on the remaining axis c. */
function at(a: number, va: number, b: number, vb: number, c: number, vc: number): V3 {
  const p: V3 = [0, 0, 0];
  p[a] = va;
  p[b] = vb;
  p[c] = vc;
  return p;
}

function box(B: Builder): void {
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const b = (a + 1) % 3, c = (a + 2) % 3;
    B.poly([at(a, s / 2, b, -0.5, c, -0.5), at(a, s / 2, b, 0.5, c, -0.5), at(a, s / 2, b, 0.5, c, 0.5), at(a, s / 2, b, -0.5, c, 0.5)], faceOf(a, s));
  }
}

/** Octagonal prism along y; `c` = how far each vertical edge is cut back (0.293: regular). */
function oct(B: Builder, c: number): void {
  const h = 0.5, k = 0.5 - c;
  // the octagon in xz, going round; even edges are chamfers, odd edges main sides
  const ring: [number, number][] = [[h, -k], [k, -h], [-k, -h], [-h, -k], [-h, k], [-k, h], [k, h], [h, k]];
  // which box side a ring point lies on
  const sideFace = ([x, z]: [number, number]) => (Math.abs(x) === h ? faceOf(0, Math.sign(x)) : faceOf(2, Math.sign(z)));
  B.poly(ring.map(([x, z]): V3 => [x, h, z]), 4);
  B.poly(ring.map(([x, z]): V3 => [x, -h, z]), 5);
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const [x0, z0] = ring[i], [x1, z1] = ring[j];
    if (i % 2 === 0) {
      // a chamfer: split down the middle, each half textured from the side it leans toward
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      B.poly([[x0, h, z0], [mx, h, mz], [mx, -h, mz], [x0, -h, z0]], sideFace(ring[i]));
      B.poly([[mx, h, mz], [x1, h, z1], [x1, -h, z1], [mx, -h, mz]], sideFace(ring[j]));
    } else {
      B.poly([[x0, h, z0], [x1, h, z1], [x1, -h, z1], [x0, -h, z0]], sideFace(ring[i]));
    }
  }
}

/** Every edge chamfered by `c` (0.293: a rhombicuboctahedron). */
function bevel(B: Builder, c: number): void {
  const h = 0.5, k = 0.5 - c;
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const b = (a + 1) % 3, d = (a + 2) % 3;
    B.poly([at(a, s * h, b, -k, d, -k), at(a, s * h, b, k, d, -k), at(a, s * h, b, k, d, k), at(a, s * h, b, -k, d, k)], faceOf(a, s));
  }
  // edge strips between face (a, sa) and face (b, sb), split lengthwise between the two
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
    const c3 = 3 - a - b;
    for (const sa of [1, -1]) for (const sb of [1, -1]) {
      const A1 = at(a, sa * h, b, sb * k, c3, -k), A2 = at(a, sa * h, b, sb * k, c3, k);
      const B1 = at(a, sa * k, b, sb * h, c3, -k), B2 = at(a, sa * k, b, sb * h, c3, k);
      const M1 = mid(A1, B1), M2 = mid(A2, B2);
      B.poly([A1, A2, M2, M1], faceOf(a, sa));
      B.poly([M1, M2, B2, B1], faceOf(b, sb));
    }
  }
  // corner triangles, split three ways (one quad per adjoining face)
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const px: V3 = [sx * h, sy * k, sz * k], py: V3 = [sx * k, sy * h, sz * k], pz: V3 = [sx * k, sy * k, sz * h];
    const g = mid(px, py, pz), mxy = mid(px, py), mxz = mid(px, pz), myz = mid(py, pz);
    B.poly([px, mxy, g, mxz], faceOf(0, sx));
    B.poly([py, myz, g, mxy], faceOf(1, sy));
    B.poly([pz, mxz, g, myz], faceOf(2, sz));
  }
}

const cache = new Map<Shape, THREE.BufferGeometry>();

/** Shared geometry for a unit shape (position, normal, uv, cFace = face id + face uv). */
export function shapeGeometry(s: Shape): THREE.BufferGeometry {
  let g = cache.get(s);
  if (g) return g;
  const B = new Builder();
  if (s === 'box') box(B);
  else if (s === 'oct') oct(B, 0.293);
  else if (s === 'bevel') bevel(B, 0.16);
  else bevel(B, 0.293);
  g = B.geometry();
  cache.set(s, g);
  return g;
}

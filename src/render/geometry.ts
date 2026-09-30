import * as THREE from 'three';
import type { TileFrame } from './textureSource';

// Growable vertex soup for one texture page of one chunk mesh. Attributes:
//   position, normal, uv (tile units, wrapped in the shader), uvRect (atlas frame rect),
//   color (baked AO), cut (1 = lowered in top-down mode), skyVis (ambient multiplier).
// Quads are given as 4 corners counter-clockwise when seen from the front.

export type V3 = [number, number, number];

/** Growable typed array (chunk meshing pushes millions of floats; plain arrays + a copy
 *  into Float32Array at build time were a large share of the meshing cost). */
class Grow<T extends Float32Array | Uint32Array> {
  a: T;
  length = 0;
  constructor(private make: (n: number) => T, cap = 1024) {
    this.a = make(cap);
  }
  private ensure(n: number): void {
    if (this.length + n <= this.a.length) return;
    const b = this.make(Math.max(this.a.length * 2, this.length + n));
    b.set(this.a.subarray(0, this.length));
    this.a = b;
  }
  push1(x: number): void {
    this.ensure(1);
    this.a[this.length++] = x;
  }
  push2(x: number, y: number): void {
    this.ensure(2);
    const a = this.a, i = this.length;
    a[i] = x; a[i + 1] = y;
    this.length = i + 2;
  }
  push3(x: number, y: number, z: number): void {
    this.ensure(3);
    const a = this.a, i = this.length;
    a[i] = x; a[i + 1] = y; a[i + 2] = z;
    this.length = i + 3;
  }
  push4(x: number, y: number, z: number, w: number): void {
    this.ensure(4);
    const a = this.a, i = this.length;
    a[i] = x; a[i + 1] = y; a[i + 2] = z; a[i + 3] = w;
    this.length = i + 4;
  }
  view(): T {
    return this.a.slice(0, this.length) as T;
  }
}
const f32 = (n: number) => new Float32Array(n);

export class GeomBuilder {
  private pos = new Grow(f32);
  private nrm = new Grow(f32);
  private uv = new Grow(f32);
  private rect = new Grow(f32);
  private col = new Grow(f32);
  private cut = new Grow(f32, 256);
  private sky = new Grow(f32, 256);
  private idx = new Grow((n) => new Uint32Array(n));
  /** Sky visibility (ambient multiplier) stamped on subsequent quads: 1 outdoors, less
   *  under a roof. Stateful to keep quad()/box() signatures short. */
  skyVis = 1;
  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /**
   * a,b,c,d: corners CCW from the front (a = bottom-left). uv = [u0, v0, u1, v1] in tile
   * units (wrap every 1.0). ao = per-corner brightness (a,b,c,d).
   */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, uv: readonly number[], f: TileFrame, ao?: readonly number[], cut = 0): void {
    const base = this.vertexCount;
    const corners = [a, b, c, d];
    const uvs = [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]];
    const du = f.uv[2] - f.uv[0], dv = f.uv[3] - f.uv[1];
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      this.pos.push3(p[0], p[1], p[2]);
      this.nrm.push3(n[0], n[1], n[2]);
      this.uv.push2(uvs[i * 2], uvs[i * 2 + 1]);
      this.rect.push4(f.uv[0], f.uv[1], du, dv);
      const k = ao ? ao[i] : 1;
      this.col.push3(k, k, k);
      this.cut.push1(cut);
      this.sky.push1(this.skyVis);
    }
    this.idx.push3(base, base + 1, base + 2);
      this.idx.push3(base, base + 2, base + 3);
  }

  /**
   * Quad with per-corner normals (`n` = 4 normals) and per-corner linear RGB colours
   * (`col` = 12 floats, or 3 for one colour). Used for relief ground, roofs and voxel props.
   */
  quadEx(a: V3, b: V3, c: V3, d: V3, n: readonly V3[], uv: readonly number[], f: TileFrame, col: readonly number[], cut = 0): void {
    const base = this.vertexCount;
    const corners = [a, b, c, d];
    const uvs = [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]];
    const du = f.uv[2] - f.uv[0], dv = f.uv[3] - f.uv[1];
    const one = col.length === 3;
    for (let i = 0; i < 4; i++) {
      const p = corners[i], nn = n[i];
      this.pos.push3(p[0], p[1], p[2]);
      this.nrm.push3(nn[0], nn[1], nn[2]);
      this.uv.push2(uvs[i * 2], uvs[i * 2 + 1]);
      this.rect.push4(f.uv[0], f.uv[1], du, dv);
      if (one) this.col.push3(col[0], col[1], col[2]);
      else this.col.push3(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
      this.cut.push1(cut);
      this.sky.push1(this.skyVis);
    }
    this.idx.push3(base, base + 1, base + 2);
      this.idx.push3(base, base + 2, base + 3);
  }

  /** One triangle; `uv` = 6 floats (tile units), one normal and one linear RGB colour. */
  tri(a: V3, b: V3, c: V3, n: V3, uv: readonly number[], f: TileFrame, col: readonly number[], cut = 0): void {
    const base = this.vertexCount;
    const du = f.uv[2] - f.uv[0], dv = f.uv[3] - f.uv[1];
    const corners = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const p = corners[i];
      this.pos.push3(p[0], p[1], p[2]);
      this.nrm.push3(n[0], n[1], n[2]);
      this.uv.push2(uv[i * 2], uv[i * 2 + 1]);
      this.rect.push4(f.uv[0], f.uv[1], du, dv);
      this.col.push3(col[0], col[1], col[2]);
      this.cut.push1(cut);
      this.sky.push1(this.skyVis);
    }
    this.idx.push3(base, base + 1, base + 2);
  }

  /**
   * Raw pre-built geometry (voxel meshes): positions/normals/colours already in world space,
   * drawn with frame `f` (a white texel). One quad = 4 vertices, quads only.
   */
  quads(pos: ArrayLike<number>, nrm: ArrayLike<number>, col: ArrayLike<number>, f: TileFrame, cut = 0): void {
    const nv = pos.length / 3;
    const du = f.uv[2] - f.uv[0], dv = f.uv[3] - f.uv[1];
    for (let q = 0; q < nv; q += 4) {
      const base = this.vertexCount;
      for (let i = q; i < q + 4; i++) {
        this.pos.push3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        this.nrm.push3(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
        this.uv.push2(0.5, 0.5);
        this.rect.push4(f.uv[0], f.uv[1], du, dv);
        this.col.push3(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]);
        this.cut.push1(cut);
        this.sky.push1(this.skyVis);
      }
      this.idx.push3(base, base + 1, base + 2);
      this.idx.push3(base, base + 2, base + 3);
    }
  }

  /**
   * Raw textured quads (voxel props): world-space positions/normals, UVs relative to frame
   * `f` (0..1 across it) and a per-vertex grey shade. 4 vertices per quad.
   */
  quadsTex(pos: ArrayLike<number>, nrm: ArrayLike<number>, uv: ArrayLike<number>, shade: ArrayLike<number>, f: TileFrame, cut = 0,
    xf?: { x: number; y: number; z: number; yaw: number }): void {
    const nv = pos.length / 3;
    const du = f.uv[2] - f.uv[0], dv = f.uv[3] - f.uv[1];
    // optional placement: rotate about Y by yaw, then translate
    const c = xf ? Math.cos(xf.yaw) : 1, sn = xf ? Math.sin(xf.yaw) : 0;
    const tx = xf?.x ?? 0, ty = xf?.y ?? 0, tz = xf?.z ?? 0;
    for (let q = 0; q < nv; q += 4) {
      const base = this.vertexCount;
      for (let i = q; i < q + 4; i++) {
        const x = pos[i * 3], z = pos[i * 3 + 2], nx = nrm[i * 3], nz = nrm[i * 3 + 2];
        this.pos.push3(tx + x * c + z * sn, ty + pos[i * 3 + 1], tz - x * sn + z * c);
        this.nrm.push3(nx * c + nz * sn, nrm[i * 3 + 1], -nx * sn + nz * c);
        this.uv.push2(uv[i * 2], uv[i * 2 + 1]);
        this.rect.push4(f.uv[0], f.uv[1], du, dv);
        const k = shade[i];
        this.col.push3(k, k, k);
        this.cut.push1(cut);
        this.sky.push1(this.skyVis);
      }
      this.idx.push3(base, base + 1, base + 2);
      this.idx.push3(base, base + 2, base + 3);
    }
  }

  /**
   * Raw quads with a per-vertex atlas rect (modelled furniture: every face has its own
   * frame): `rect` = 4 floats per vertex [u0, v0, du, dv], uv 0..1 across that frame.
   * Optional placement: uniform scale `s`, rotation about Y by `yaw`, then translation.
   */
  quadsRect(pos: ArrayLike<number>, nrm: ArrayLike<number>, uv: ArrayLike<number>, rect: ArrayLike<number>, shade: ArrayLike<number>,
    xf?: { x: number; y: number; z: number; yaw: number; s?: number }, cut = 0): void {
    const nv = pos.length / 3;
    const c = xf ? Math.cos(xf.yaw) : 1, sn = xf ? Math.sin(xf.yaw) : 0, k = xf?.s ?? 1;
    const tx = xf?.x ?? 0, ty = xf?.y ?? 0, tz = xf?.z ?? 0;
    for (let q = 0; q < nv; q += 4) {
      const base = this.vertexCount;
      for (let i = q; i < q + 4; i++) {
        const x = pos[i * 3] * k, z = pos[i * 3 + 2] * k, nx = nrm[i * 3], nz = nrm[i * 3 + 2];
        this.pos.push3(tx + x * c + z * sn, ty + pos[i * 3 + 1] * k, tz - x * sn + z * c);
        this.nrm.push3(nx * c + nz * sn, nrm[i * 3 + 1], -nx * sn + nz * c);
        this.uv.push2(uv[i * 2], uv[i * 2 + 1]);
        this.rect.push4(rect[i * 4], rect[i * 4 + 1], rect[i * 4 + 2], rect[i * 4 + 3]);
        const s = shade[i];
        this.col.push3(s, s, s);
        this.cut.push1(cut);
        this.sky.push1(this.skyVis);
      }
      this.idx.push3(base, base + 1, base + 2);
      this.idx.push3(base, base + 2, base + 3);
    }
  }

  /**
   * Axis-aligned box in three.js coordinates. `faces` bitmask: 1=+x 2=-x 4=+y 8=-y 16=+z
   * 32=-z. `side`/`top` frames texture vertical and horizontal faces. `vBase` is the world
   * Y that maps to v=0 so stacked boxes continue the texture pattern.
   */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, faces: number,
    side: TileFrame, top: TileFrame, vBase: number, cut = 0, bottom: TileFrame = top): void {
    const v0 = y0 - vBase, v1 = y1 - vBase;
    if (faces & 1) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [-z1, v0, -z0, v1], side, WALL_AO, cut);
    if (faces & 2) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [z0, v0, z1, v1], side, WALL_AO, cut);
    if (faces & 4) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [x0, -z1, x1, -z0], top, undefined, cut);
    if (faces & 8) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [x0, z0, x1, z1], bottom, undefined, cut);
    if (faces & 16) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [x0, v0, x1, v1], side, WALL_AO, cut);
    if (faces & 32) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [-x1, v0, -x0, v1], side, WALL_AO, cut);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.view(), 2));
    g.setAttribute('uvRect', new THREE.BufferAttribute(this.rect.view(), 4));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.view(), 3));
    g.setAttribute('cut', new THREE.BufferAttribute(this.cut.view(), 1));
    g.setAttribute('skyVis', new THREE.BufferAttribute(this.sky.view(), 1));
    const n = this.vertexCount;
    const idx = this.idx.view();
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(idx, 1) : new THREE.BufferAttribute(Uint16Array.from(idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Vertical faces: slightly darker at the foot, like contact shadow / dirt build-up. */
const WALL_AO = [0.78, 0.78, 1, 1];

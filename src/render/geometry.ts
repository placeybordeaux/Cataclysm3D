import * as THREE from 'three';
import type { TileFrame } from './textureSource';

// Growable vertex soup for one texture page of one chunk mesh. Attributes:
//   position, normal, uv (tile units, wrapped in the shader), uvRect (atlas frame rect),
//   color (baked AO), cut (1 = lowered in top-down mode), skyVis (ambient multiplier).
// Quads are given as 4 corners counter-clockwise when seen from the front.

export type V3 = [number, number, number];

export class GeomBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private rect: number[] = [];
  private col: number[] = [];
  private cut: number[] = [];
  private sky: number[] = [];
  private idx: number[] = [];
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
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      this.rect.push(f.uv[0], f.uv[1], du, dv);
      const k = ao ? ao[i] : 1;
      this.col.push(k, k, k);
      this.cut.push(cut);
      this.sky.push(this.skyVis);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('uvRect', new THREE.Float32BufferAttribute(this.rect, 4));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('cut', new THREE.Float32BufferAttribute(this.cut, 1));
    g.setAttribute('skyVis', new THREE.Float32BufferAttribute(this.sky, 1));
    const n = this.vertexCount;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Vertical faces: slightly darker at the foot, like contact shadow / dirt build-up. */
const WALL_AO = [0.78, 0.78, 1, 1];

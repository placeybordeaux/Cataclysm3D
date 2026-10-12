import * as THREE from 'three';
import { setupPixelTexture } from './atlas';
import { GeomBuilder, type V3 } from './geometry';
import type { TileFrame } from './textureSource';

// Geometry helpers shared by the vehicle renderers (vehicleMesh.ts "parts", vehicleModel.ts
// "model"): tint-batched GeomBuilders, a hand-rolled geometry merge, and a small page of
// grey-scale pixel-art swatches (tinted per vertex) for the non-body bits: tyres, rims,
// seats, dashboards, chrome, floors.

export function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Geometry batches keyed by tint so the colour can be baked into vertex colours. */
export class Batches {
  private map = new Map<number, GeomBuilder>();
  sky = 1;
  get(tint: number): GeomBuilder {
    let g = this.map.get(tint);
    if (!g) this.map.set(tint, (g = new GeomBuilder()));
    g.skyVis = this.sky;
    return g;
  }
  build(): THREE.BufferGeometry | null {
    const parts: THREE.BufferGeometry[] = [];
    for (const [tint, g] of this.map) {
      if (!g.vertexCount) continue;
      const geo = g.build();
      const col = geo.getAttribute('color') as THREE.BufferAttribute;
      // Used as a plain multiplier (not sRGB-decoded): the swatches are already dark-ish
      // and decoding would crush saturated paints to near black under banded lighting.
      const c = new THREE.Color().setRGB(((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255, THREE.LinearSRGBColorSpace);
      for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * c.r, col.getY(i) * c.g, col.getZ(i) * c.b);
      parts.push(geo);
    }
    if (!parts.length) return null;
    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts);
    if (parts.length > 1) for (const p of parts) p.dispose();
    return merged;
  }
}

/**
 * Concatenate indexed geometries with identical attribute layouts (GeomBuilder output).
 * Hand-rolled instead of BufferGeometryUtils so no extra three/examples module is pulled
 * into the dev server's dependency pre-bundle.
 */
export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = Object.keys(geos[0].attributes);
  let verts = 0, idx = 0;
  for (const g of geos) {
    verts += g.getAttribute('position').count;
    idx += g.getIndex()!.count;
  }
  for (const n of names) {
    const size = geos[0].getAttribute(n).itemSize;
    const arr = new Float32Array(verts * size);
    let o = 0;
    for (const g of geos) {
      const a = g.getAttribute(n).array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  const index = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let io = 0, vo = 0;
  for (const g of geos) {
    const ia = g.getIndex()!.array;
    for (let i = 0; i < ia.length; i++) index[io++] = ia[i] + vo;
    vo += g.getAttribute('position').count;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// --- parts swatches ------------------------------------------------------------------

export type PartSwatch = 'tread' | 'sidewall' | 'rim' | 'spokes' | 'fabric' | 'dark' | 'floor' | 'chrome' | 'light' | 'metal' | 'ribbed' | 'leather' | 'fins' | 'armor';
const PART_SWATCHES: PartSwatch[] = ['tread', 'sidewall', 'rim', 'spokes', 'fabric', 'dark', 'floor', 'chrome', 'light', 'metal', 'ribbed', 'leather', 'fins', 'armor'];
const SW = 32;

function paintPart(kind: PartSwatch, x: number, y: number): number {
  const n = hash(x, y, PART_SWATCHES.indexOf(kind) + 40);
  const d = Math.hypot(x - 15.5, y - 15.5);
  switch (kind) {
    case 'tread':
      // chunky blocks across the tyre, stepped: dark rubber with lighter lugs
      return 46 + ((x >> 2) % 2 === ((y >> 3) % 2) ? 20 : 0) + (y % 8 === 0 ? -10 : 0) + Math.floor(n * 6);
    case 'sidewall':
      return 52 + Math.floor(n * 6) + (x % 16 === 3 && y > 12 && y < 20 ? 14 : 0);
    case 'rim': {
      // five-spoke alloy: bright spokes from a hub to the rim, dark gaps, tyre-dark beyond
      if (d > 15) return 58;
      if (d > 13) return 150;
      if (d < 3.5) return 120;
      if (d < 5) return 200;
      const a = Math.atan2(y - 15.5, x - 15.5);
      const spoke = Math.abs(((a / (Math.PI * 2)) * 5 + 10) % 1 - 0.5) > 0.3;
      return spoke ? 196 + Math.floor(n * 16) : 44;
    }
    case 'spokes': {
      // wire wheel (bikes): thin spokes, hub, rim
      if (d > 15) return 40;
      if (d > 13.5) return 170;
      if (d < 2.5) return 180;
      const a = Math.atan2(y - 15.5, x - 15.5);
      const s = Math.abs(((a / (Math.PI * 2)) * 16 + 10) % 1 - 0.5) > 0.42;
      return s ? 190 : 0;
    }
    case 'fabric':
      return 150 + (((x >> 1) + (y >> 1)) % 2 ? 22 : 0) + Math.floor(n * 10) - (y % 8 === 0 ? 30 : 0);
    case 'leather':
      return 140 + Math.floor(n * 12) - (y % 10 === 0 || x % 16 === 0 ? 34 : 0);
    case 'dark':
      return 70 + Math.floor(n * 14) - (x % 8 === 0 ? 10 : 0);
    case 'floor':
      return 70 + Math.floor(n * 22) - ((x ^ y) % 5 === 0 ? 12 : 0);
    case 'chrome':
      return 180 + (y < 10 ? 50 : y < 14 ? 20 : 0) + Math.floor(n * 10);
    case 'light':
      return 255;
    case 'metal':
      return 140 + Math.floor(n * 20) - (x % 16 === 0 || y % 16 === 0 ? 30 : 0);
    case 'ribbed':
      return x % 4 < 2 ? 150 : 110;
    case 'fins':
      // engine cooling fins: horizontal ridges
      return y % 4 < 2 ? 170 + Math.floor(n * 12) : 84;
    case 'armor': {
      // Painted armour plate (render/vehicleTank.ts): 'metal' has a seam every 16 px both ways,
      // a 0.5 m grid that read as the sidewalk's paving slabs under a tank. One weld seam per
      // metre along the plate, soft paint mottling in 4 px blocks, a highlight bead over the
      // seam and a row of bolt heads: a plate, not a tile.
      const blk = hash(x >> 2, y >> 2, 91);
      const seam = x % 32 === 0 ? -34 : x % 32 === 1 ? 14 : 0;
      const bolt = x % 32 === 4 && y % 16 === 6 ? 26 : x % 32 === 4 && y % 16 === 7 ? -18 : 0;
      return 156 + Math.floor((blk - 0.5) * 18) + Math.floor(n * 6) + seam + bolt;
    }
  }
}

let partPage: { tex: THREE.Texture; frames: Record<PartSwatch, TileFrame> } | null = null;

/** Canvas page of part swatches (browser only). */
export function partSwatchPage(): { tex: THREE.Texture; frames: Record<PartSwatch, TileFrame> } {
  if (partPage) return partPage;
  const w = SW * PART_SWATCHES.length;
  const data = new Uint8Array(w * SW * 4);
  PART_SWATCHES.forEach((k, i) => {
    for (let y = 0; y < SW; y++)
      for (let x = 0; x < SW; x++) {
        const v = Math.max(0, Math.min(255, paintPart(k, x, y)));
        const o = (y * w + i * SW + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = v;
        // Wire wheels: the gaps between spokes are see-through (the world material's alpha test).
        data[o + 3] = k === 'spokes' && v === 0 ? 0 : 255;
      }
  });
  const tex = new THREE.DataTexture(data, w, SW, THREE.RGBAFormat);
  setupPixelTexture(tex);
  const frames = Object.fromEntries(PART_SWATCHES.map((k, i) => [k, { texture: tex, uv: [(i * SW) / w, 0, ((i + 1) * SW) / w, 1], w: SW, h: SW, ppm: 32 } as TileFrame])) as Record<PartSwatch, TileFrame>;
  partPage = { tex, frames };
  return partPage;
}

/** Frames only (for geometry built in node tests, where no texture is needed). */
export function partFrames(): Record<PartSwatch, TileFrame> {
  if (partPage) return partPage.frames;
  const w = SW * PART_SWATCHES.length;
  return Object.fromEntries(PART_SWATCHES.map((k, i) => [k, { texture: null as unknown as THREE.Texture, uv: [(i * SW) / w, 0, ((i + 1) * SW) / w, 1], w: SW, h: SW, ppm: 32 } as TileFrame])) as Record<PartSwatch, TileFrame>;
}

// --- primitives ------------------------------------------------------------------------

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function faceNormal(a: V3, b: V3, c: V3): V3 {
  const n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** A quad from 4 CCW corners with its own face normal and a (0..1) swatch mapping. */
export function quad4(g: GeomBuilder, a: V3, b: V3, c: V3, d: V3, f: TileFrame, uv: readonly number[] = [0, 0, 1, 1]): void {
  g.quad(a, b, c, d, faceNormal(a, b, c), uv, f);
}

/**
 * Box with chamfered vertical edges (an octagon in plan), for bumpers, seat cushions,
 * tanks: reads rounder than a box at the same cost. Axis-aligned in the local frame.
 */
export function chamferBox(g: GeomBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number, side: TileFrame, top: TileFrame): void {
  c = Math.min(c, (x1 - x0) / 2.01, (z1 - z0) / 2.01);
  const ring: [number, number][] = [[x1 - c, z0], [x1, z0 + c], [x1, z1 - c], [x1 - c, z1], [x0 + c, z1], [x0, z1 - c], [x0, z0 + c], [x0 + c, z0]];
  for (let i = 0; i < 8; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % 8];
    const len = Math.hypot(bx - ax, bz - az);
    quad4(g, [bx, y0, bz], [ax, y0, az], [ax, y1, az], [bx, y1, bz], side, [0, y0, len, y1]);
  }
  // top and bottom as fans of the octagon (degenerate quads)
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  for (let i = 0; i < 8; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % 8];
    g.tri([cx, y1, cz], [bx, y1, bz], [ax, y1, az], [0, 1, 0], [cx, cz, bx, bz, ax, az], top, [1, 1, 1]);
    g.tri([cx, y0, cz], [ax, y0, az], [bx, y0, bz], [0, -1, 0], [cx, cz, ax, az, bx, bz], top, [0.6, 0.6, 0.6]);
  }
}

/** A cylinder between two points (tubes: frames, exhausts, forks, handlebars). */
export function tube(g: GeomBuilder, a: V3, b: V3, r: number, f: TileFrame, sides = 6): void {
  const d = sub(b, a);
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const w: V3 = [d[0] / len, d[1] / len, d[2] / len];
  const up: V3 = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = cross(up, w);
  const ul = Math.hypot(...u);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v = cross(w, u);
  const ring = (c: V3, i: number): V3 => {
    const t = (i / sides) * Math.PI * 2;
    const cs = Math.cos(t) * r, sn = Math.sin(t) * r;
    return [c[0] + u[0] * cs + v[0] * sn, c[1] + u[1] * cs + v[1] * sn, c[2] + u[2] * cs + v[2] * sn];
  };
  for (let i = 0; i < sides; i++) {
    const p0 = ring(a, i), p1 = ring(a, i + 1), p2 = ring(b, i + 1), p3 = ring(b, i);
    quad4(g, p0, p1, p2, p3, f, [0, 0, 1, len]);
  }
}

/**
 * A wheel around an axle along Z at (x, h, zc): tyre tread band, sidewall rings and a rim
 * disc (the `rim` swatch mapped radially, so spokes read as spokes). `flat` squashes the
 * bottom of a destroyed tyre.
 */
export function wheel(g: GeomBuilder, x: number, h: number, zc: number, r: number, width: number, F: Record<PartSwatch, TileFrame>, opts: { sides?: number; rimFrac?: number; rim?: PartSwatch; flat?: boolean; spin?: number } = {}): void {
  const N = opts.sides ?? 14;
  const rimR = r * (opts.rimFrac ?? 0.62);
  const z0 = zc - width / 2, z1 = zc + width / 2;
  const spin = opts.spin ?? 0;
  const pt = (i: number, rr: number): [number, number] => {
    const a = (i / N) * Math.PI * 2 + spin;
    let yy = h + Math.sin(a) * rr;
    if (opts.flat) yy = Math.max(yy, h - r * 0.55);
    return [x + Math.cos(a) * rr, yy];
  };
  // Tread: the tyre's outer band, bevelled at both edges (the sidewall bulge).
  const bev = Math.min(width * 0.18, r * 0.12);
  for (let i = 0; i < N; i++) {
    const [ax, ay] = pt(i, r), [bx, by] = pt(i + 1, r);
    const [aix, aiy] = pt(i, r - bev), [bix, biy] = pt(i + 1, r - bev);
    quad4(g, [ax, ay, z1 - bev], [ax, ay, z0 + bev], [bx, by, z0 + bev], [bx, by, z1 - bev], F.tread, [0, 0, 1, width]);
    quad4(g, [aix, aiy, z1], [ax, ay, z1 - bev], [bx, by, z1 - bev], [bix, biy, z1], F.sidewall);
    quad4(g, [ax, ay, z0 + bev], [aix, aiy, z0], [bix, biy, z0], [bx, by, z0 + bev], F.sidewall);
  }
  for (const [z, sgn] of [[z1, 1], [z0, -1]] as const) {
    const zr = z - sgn * width * 0.12;
    for (let i = 0; i < N; i++) {
      const [ax, ay] = pt(i, r - bev), [bx, by] = pt(i + 1, r - bev);
      const [aix, aiy] = pt(i, rimR), [bix, biy] = pt(i + 1, rimR);
      // sidewall annulus, then the rim dished in a little
      if (sgn > 0) quad4(g, [aix, aiy, zr], [ax, ay, z], [bx, by, z], [bix, biy, zr], F.sidewall);
      else quad4(g, [ax, ay, z], [aix, aiy, zr], [bix, biy, zr], [bx, by, z], F.sidewall);
      const c: V3 = [x, h, zr];
      const a: V3 = [aix, aiy, zr], b: V3 = [bix, biy, zr];
      // Radial UVs: the rim swatch is a round wheel face, centre at (0.5, 0.5).
      const ua = (i / N) * Math.PI * 2 + spin, ub = ((i + 1) / N) * Math.PI * 2 + spin;
      const uv = (t: number, s: number) => [0.5 + Math.cos(t) * 0.5 * s * 0.94, 0.5 + Math.sin(t) * 0.5 * s * 0.94];
      const f = F[opts.rim ?? 'rim'];
      if (sgn > 0) g.tri(c, a, b, [0, 0, 1], [0.5, 0.5, ...uv(ua, 1), ...uv(ub, 1)], f, [1, 1, 1]);
      else g.tri(c, b, a, [0, 0, -1], [0.5, 0.5, ...uv(ub, 1), ...uv(ua, 1)], f, [1, 1, 1]);
    }
  }
}

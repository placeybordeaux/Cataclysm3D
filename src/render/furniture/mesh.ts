import type * as THREE from 'three';
import type { GeomBuilder, V3 } from '../geometry';
import type { TileFrame } from '../textureSource';
import type { ModelAtlas } from './atlas';
import { faceKey, paintFace, TPM, type FaceSpec } from './paint';

// Low-poly model construction in a piece's local space (metres; origin = tile centre on the
// floor; +x east, +y up, +z = the piece's front, i.e. south before rotation). Parts are
// boxes, prisms and free quads; every face gets its own atlas frame painted at the face's
// size in texels (paint.ts), so the model is textured at a consistent 32 texels/m.
//
// A built model is a ModelMesh (flat arrays per atlas page, cached per furniture id and
// variant) that `placeModel` bakes into the chunk's GeomBuilders with a translation and a
// rotation about Y.

export interface PageArrays {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  rect: Float32Array;
  shade: Float32Array;
  /** any frame on this page (GeomBuilder lookup key for the chunk mesher) */
  frame: TileFrame;
}

export interface ModelMesh {
  pages: PageArrays[];
  /** see-through glass quads (positions + normals, 4 vertices per quad); drawn with the
   *  chunk's glass material, not the atlas */
  glass?: { pos: Float32Array; nrm: Float32Array };
  quads: number;
}

type Acc = { pos: number[]; nrm: number[]; uv: number[]; rect: number[]; shade: number[]; frame: TileFrame };

export type FaceSel = FaceSpec | null | ((face: BoxFace) => FaceSpec | null);
/** px = +x (east), nx, py = top, ny = bottom, pz = front (+z), nz = back */
export type BoxFace = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

const E = 0.002;
const texels = (m: number) => Math.max(1, Math.round(m * TPM));

export class ModelBuilder {
  private acc = new Map<THREE.Texture, Acc>();
  private glassPos: number[] = [];
  private glassNrm: number[] = [];
  private nq = 0;
  /** faces lower than this (m) are darkened toward the floor (contact AO) */
  aoHeight = 0.25;

  constructor(private atlas: ModelAtlas) {}

  frameFor(spec: FaceSpec, w: number, h: number): TileFrame {
    return this.atlas.frame(faceKey(spec, w, h), () => paintFace(spec, w, h));
  }

  /**
   * Quad a,b,c,d counter-clockwise seen from the front (a = bottom-left of the texture).
   * The frame is painted at |ab| x |ad| metres unless `size` overrides it (in texels).
   */
  quad(a: V3, b: V3, c: V3, d: V3, spec: FaceSpec, size?: [number, number], shade?: [number, number, number, number]): void {
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const ad = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    const w = size?.[0] ?? texels(ab), h = size?.[1] ?? texels(ad);
    const f = this.frameFor(spec, w, h);
    let e = this.acc.get(f.texture);
    if (!e) this.acc.set(f.texture, (e = { pos: [], nrm: [], uv: [], rect: [], shade: [], frame: f }));
    const n = normal(a, b, d);
    // just inside 0..1: the world shader wraps with fract(), and fract(1.0) is the left edge
    const uvs = [E, E, 1 - E, E, 1 - E, 1 - E, E, 1 - E];
    const du = f.uv[2] - f.uv[0], dv = f.uv[3] - f.uv[1];
    const P = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      const p = P[i];
      e.pos.push(p[0], p[1], p[2]);
      e.nrm.push(n[0], n[1], n[2]);
      e.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      e.rect.push(f.uv[0], f.uv[1], du, dv);
      e.shade.push(shade ? shade[i] : this.ao(p[1], n[1]));
    }
    this.nq++;
  }

  /** Contact darkening near the floor; undersides are darker still. */
  private ao(y: number, ny: number): number {
    const k = ny < -0.5 ? 0.62 : 1;
    if (y >= this.aoHeight) return k;
    return k * (0.74 + 0.26 * (y / this.aoHeight));
  }

  /** Axis-aligned box. `faces` picks a spec per face (null = no face). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, sel: FaceSel, skip = ''): void {
    const pick = (f: BoxFace) => (skip.includes(f) ? null : typeof sel === 'function' ? sel(f) : sel);
    let s: FaceSpec | null;
    if ((s = pick('pz'))) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], s);
    if ((s = pick('nz'))) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], s);
    if ((s = pick('px'))) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], s);
    if ((s = pick('nx'))) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], s);
    if ((s = pick('py'))) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], s);
    if ((s = pick('ny'))) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], s);
  }

  /** Vertical prism (cylinder stand-in) with `n` sides; caps optional. */
  prism(cx: number, cz: number, y0: number, y1: number, r: number, n: number, side: FaceSpec | null, top: FaceSpec | null = side, bottom: FaceSpec | null = null, rz = r, phase = 0): void {
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * rz]);
    }
    if (side) for (let i = 0; i < n; i++) {
      const [ax, az] = pts[(i + 1) % n], [bx, bz] = pts[i];
      this.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], side);
    }
    const cap = (y: number, s: FaceSpec, up: boolean) => {
      // fan as quads (pairs of rim points + centre twice) keeps everything quads
      const size: [number, number] = [texels(r * 2), texels(rz * 2)];
      for (let i = 0; i < n; i += 2) {
        const p0 = pts[i], p1 = pts[(i + 1) % n], p2 = pts[(i + 2) % n];
        const c: V3 = [cx, y, cz];
        if (up) this.quad(c, [p2[0], y, p2[1]], [p1[0], y, p1[1]], [p0[0], y, p0[1]], s, size);
        else this.quad(c, [p0[0], y, p0[1]], [p1[0], y, p1[1]], [p2[0], y, p2[1]], s, size);
      }
    };
    if (top) cap(y1, top, true);
    if (bottom) cap(y0, bottom, false);
  }

  /** Tapered/leaning box: bottom rect (x0..x1, z0..z1) at y0 to top rect offset/scaled. */
  frustum(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, tx0: number, tz0: number, tx1: number, tz1: number, sel: FaceSel, skip = ''): void {
    const pick = (f: BoxFace) => (skip.includes(f) ? null : typeof sel === 'function' ? sel(f) : sel);
    let s: FaceSpec | null;
    if ((s = pick('pz'))) this.quad([x0, y0, z1], [x1, y0, z1], [tx1, y1, tz1], [tx0, y1, tz1], s);
    if ((s = pick('nz'))) this.quad([x1, y0, z0], [x0, y0, z0], [tx0, y1, tz0], [tx1, y1, tz0], s);
    if ((s = pick('px'))) this.quad([x1, y0, z1], [x1, y0, z0], [tx1, y1, tz0], [tx1, y1, tz1], s);
    if ((s = pick('nx'))) this.quad([x0, y0, z0], [x0, y0, z1], [tx0, y1, tz1], [tx0, y1, tz0], s);
    if ((s = pick('py'))) this.quad([tx0, y1, tz1], [tx1, y1, tz1], [tx1, y1, tz0], [tx0, y1, tz0], s);
    if ((s = pick('ny'))) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], s);
  }

  /**
   * Box rotated about the X axis by `tilt` radians around its bottom-back edge (chair backs,
   * reclined deckchairs): local box (x0..x1, 0..h, 0..d) placed at (y0, z0).
   */
  tiltedBox(x0: number, x1: number, y0: number, z0: number, h: number, d: number, tilt: number, sel: FaceSel, skip = ''): void {
    const c = Math.cos(tilt), s = Math.sin(tilt);
    // local (y, z) -> world: y' = y0 + y*c + z*s, z' = z0 - y*s + z*c  (tilt > 0 leans back, toward -z)
    const P = (x: number, y: number, z: number): V3 => [x, y0 + y * c + z * s, z0 - y * s + z * c];
    const pick = (f: BoxFace) => (skip.includes(f) ? null : typeof sel === 'function' ? sel(f) : sel);
    let q: FaceSpec | null;
    if ((q = pick('pz'))) this.quad(P(x0, 0, d), P(x1, 0, d), P(x1, h, d), P(x0, h, d), q);
    if ((q = pick('nz'))) this.quad(P(x1, 0, 0), P(x0, 0, 0), P(x0, h, 0), P(x1, h, 0), q);
    if ((q = pick('px'))) this.quad(P(x1, 0, d), P(x1, 0, 0), P(x1, h, 0), P(x1, h, d), q);
    if ((q = pick('nx'))) this.quad(P(x0, 0, 0), P(x0, 0, d), P(x0, h, d), P(x0, h, 0), q);
    if ((q = pick('py'))) this.quad(P(x0, h, d), P(x1, h, d), P(x1, h, 0), P(x0, h, 0), q);
    if ((q = pick('ny'))) this.quad(P(x0, 0, 0), P(x1, 0, 0), P(x1, 0, d), P(x0, 0, d), q);
  }

  /** A see-through glass quad (both sides are drawn by the glass material). */
  glass(a: V3, b: V3, c: V3, d: V3): void {
    const n = normal(a, b, d);
    for (const p of [a, b, c, d]) {
      this.glassPos.push(p[0], p[1], p[2]);
      this.glassNrm.push(n[0], n[1], n[2]);
    }
  }

  done(): ModelMesh {
    const pages: PageArrays[] = [];
    for (const e of this.acc.values())
      pages.push({ pos: new Float32Array(e.pos), nrm: new Float32Array(e.nrm), uv: new Float32Array(e.uv), rect: new Float32Array(e.rect), shade: new Float32Array(e.shade), frame: e.frame });
    const m: ModelMesh = { pages, quads: this.nq };
    if (this.glassPos.length) m.glass = { pos: new Float32Array(this.glassPos), nrm: new Float32Array(this.glassNrm) };
    return m;
  }
}

function normal(a: V3, b: V3, d: V3): V3 {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** uniform scale (items) */
  s?: number;
}

/** Bake a model into the chunk geometry (and glass builder) at a placement. */
export function placeModel(geo: (f: TileFrame) => GeomBuilder, m: ModelMesh, p: Placement, glass?: () => GeomBuilder): void {
  for (const pg of m.pages) geo(pg.frame).quadsRect(pg.pos, pg.nrm, pg.uv, pg.rect, pg.shade, p);
  if (m.glass && glass) {
    const g = glass();
    const n = m.glass.pos.length / 3;
    const uv = new Float32Array(n * 2), rect = new Float32Array(n * 4), shade = new Float32Array(n).fill(1);
    g.quadsRect(m.glass.pos, m.glass.nrm, uv, rect, shade, p);
  }
}

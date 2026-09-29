import type { GeomBuilder } from './geometry';
import { framePixels, frameKey, type Pixels } from './framePixels';
import type { TileFrame, TileTextureSource } from './textureSource';

// Voxel volumes from UltiCa sprites (look.ts `voxelProps`): furniture and ground items stop
// being cardboard billboards.
//
//  * standing furniture (chairs, toilets, bins, plants...): the sprite is "inflated" — each
//    opaque pixel becomes a column of voxels whose depth grows with its distance from the
//    silhouette edge, mirrored front/back. Seen head-on it is the original pixel art; from
//    the side it has a rounded body and edge colours carry around.
//  * lying furniture (beds, mattresses, rugs, rubble): the sprite is laid on the floor and
//    extruded up to the piece's height, so a bed is a bed-shaped block with its art on top.
//  * ground items: the icon lies flat as a thin slab at a random angle, like a dropped object.
// Faces are merged along runs of equal colour/depth; meshes are cached per sprite and baked
// (transformed) into the chunk geometry with a white texel and vertex colours.

type Geo = (f: TileFrame) => GeomBuilder;

export interface VoxelProps {
  furniture(geo: Geo, white: TileFrame, src: TileTextureSource, id: string, x: number, y: number, base: number, seed: number, yaw?: number): boolean;
  item(geo: Geo, white: TileFrame, f: TileFrame, x: number, y: number, base: number, seed: number, k: number): boolean;
}

interface VoxMesh {
  pos: Float32Array;
  nrm: Float32Array;
  col: Float32Array;
}

const toLin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Opaque-pixel mask cropped to its bounds; alpha >= 200 (UltiCa drop shadows are faint). */
function mask(p: Pixels): { w: number; h: number; x0: number; y0: number; on: Uint8Array } | null {
  let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++)
      if (p.data[(y * p.w + x) * 4 + 3] >= 200) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) on[y * w + x] = p.data[((y + y0) * p.w + x + x0) * 4 + 3] >= 200 ? 1 : 0;
  return { w, h, x0, y0, on };
}

/** Chamfer distance (in px) from each opaque pixel to the nearest transparent one. */
function distance(w: number, h: number, on: Uint8Array): Float32Array {
  const INF = 1e6;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = on[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!on[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!on[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
    }
  return d;
}

class MeshOut {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], rgb: number[]): void {
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(rgb[0], rgb[1], rgb[2]);
    }
  }
  done(): VoxMesh {
    return { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), col: new Float32Array(this.col) };
  }
}

/**
 * Generic height-field voxel mesher over a pixel grid. For pixel (i, j) (j = 0 top row) the
 * solid spans depth [lo, hi] along the "depth" axis; `P(i, j, dz)` maps grid coords + depth
 * to local metres. Emits the two caps (hi, lo) and the side walls where neighbours differ.
 */
function heightMesh(w: number, h: number, on: Uint8Array, lo: Float32Array, hi: Float32Array, rgb: (i: number) => number[],
  P: (i: number, j: number, d: number) => number[], nHi: number[], nLo: number[], sideN: (dir: number) => number[], out: MeshOut, doLo: boolean): void {
  const idx = (i: number, j: number) => j * w + i;
  const colEq = (a: number, b: number) => {
    const x = rgb(a), y = rgb(b);
    return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
  };
  // caps: merge runs along i with equal colour and depth
  for (const top of [true, false]) {
    if (!top && !doLo) continue;
    const D = top ? hi : lo;
    for (let j = 0; j < h; j++) {
      let i = 0;
      while (i < w) {
        const a = idx(i, j);
        if (!on[a]) { i++; continue; }
        let e = i + 1;
        while (e < w && on[idx(e, j)] && D[idx(e, j)] === D[a] && colEq(idx(e, j), a)) e++;
        const d = D[a];
        const c = rgb(a);
        if (top) out.quad(P(i, j + 1, d), P(e, j + 1, d), P(e, j, d), P(i, j, d), nHi, c);
        else out.quad(P(e, j + 1, d), P(i, j + 1, d), P(i, j, d), P(e, j, d), nLo, c);
        i = e;
      }
    }
  }
  // side walls: toward each neighbour, from max(neighbour hi, own lo) up to own hi, and
  // (below) from own lo down to... handled by symmetric lo spans
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const a = idx(i, j);
      if (!on[a]) continue;
      const c = rgb(a);
      const shade = [c[0] * 0.86, c[1] * 0.86, c[2] * 0.86];
      for (let k = 0; k < 4; k++) {
        const ni = i + dirs[k][0], nj = j + dirs[k][1];
        const inside = ni >= 0 && nj >= 0 && ni < w && nj < h && on[idx(ni, nj)];
        const nhi = inside ? hi[idx(ni, nj)] : -1e9, nlo = inside ? lo[idx(ni, nj)] : 1e9;
        // exposed spans of [lo, hi] not covered by the neighbour's [nlo, nhi]
        const spans: [number, number][] = [];
        if (!inside || nhi <= lo[a] || nlo >= hi[a]) spans.push([lo[a], hi[a]]);
        else {
          if (hi[a] > nhi) spans.push([nhi, hi[a]]);
          if (lo[a] < nlo) spans.push([lo[a], nlo]);
        }
        const n = sideN(k);
        for (const [s0, s1] of spans) {
          if (s1 - s0 < 1e-6) continue;
          // edge endpoints of pixel (i, j) toward neighbour k
          let e0: [number, number], e1: [number, number];
          if (k === 0) { e0 = [i, j + 1]; e1 = [i, j]; }
          else if (k === 1) { e0 = [i + 1, j]; e1 = [i + 1, j + 1]; }
          else if (k === 2) { e0 = [i, j]; e1 = [i + 1, j]; }
          else { e0 = [i + 1, j + 1]; e1 = [i, j + 1]; }
          out.quad(P(e1[0], e1[1], s0), P(e0[0], e0[1], s0), P(e0[0], e0[1], s1), P(e1[0], e1[1], s1), n, shade);
        }
      }
    }
}

const meshCache = new Map<string, VoxMesh | null>();

type Mode = 'stand' | 'lie' | 'item';

/**
 * Build (cached) the voxel mesh of a frame. Local space: metres, origin at the bottom centre
 * (stand) / centre of the floor footprint (lie, item); +z = the sprite's front (south).
 */
function voxMesh(f: TileFrame, mode: Mode, param: number): VoxMesh | null {
  const key = `${frameKey(f)}|${mode}|${param}`;
  if (meshCache.has(key)) return meshCache.get(key)!;
  let res: VoxMesh | null = null;
  const p = framePixels(f);
  const m = p ? mask(p) : null;
  if (p && m) {
    const { w, h, x0, y0, on } = m;
    const ppm = f.ppm ?? 16;
    const s = 1 / ppm;
    const cols: number[][] = [];
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const q = ((j + y0) * p.w + i + x0) * 4;
        cols.push([toLin(p.data[q]), toLin(p.data[q + 1]), toLin(p.data[q + 2])]);
      }
    const rgb = (i: number) => cols[i];
    const out = new MeshOut();
    // centre on the frame's own centre column, so a sprite's placement matches its billboard
    const cxPix = p.w / 2 - x0;
    if (mode === 'stand') {
      const dist = distance(w, h, on);
      const cap = param;
      const hi = new Float32Array(w * h), lo = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (!on[i]) continue;
        const d = Math.min(cap, Math.max(1, Math.round(Math.sqrt(dist[i]) * cap * 0.55)));
        hi[i] = d * s;
        lo[i] = -d * s;
      }
      // sprite rows from the bottom of the *frame* (billboards anchor at the frame's bottom)
      const bottomPad = p.h - (y0 + h);
      const P = (i: number, j: number, d: number) => [(i - cxPix) * s, (h - j + bottomPad) * s, d];
      heightMesh(w, h, on, lo, hi, rgb, P, [0, 0, 1], [0, 0, -1], (k) => [[-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]][k], out, true);
    } else {
      // laid flat: sprite column -> x, row -> z (top row = north = -z), extruded up
      const H = param;
      const hi = new Float32Array(w * h).fill(H), lo = new Float32Array(w * h);
      const cyPix = p.h / 2 - y0;
      const sc = mode === 'item' ? 0.5 * s : s;
      const P = (i: number, j: number, d: number) => [(i - cxPix) * sc, d, (j - cyPix) * sc];
      heightMesh(w, h, on, lo, hi, rgb, P, [0, 1, 0], [0, -1, 0], (k) => [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]][k], out, false);
    }
    res = out.done();
    if (!res.pos.length) res = null;
  }
  meshCache.set(key, res);
  return res;
}

/** Push a cached mesh rotated by `yaw` about Y and translated. */
function place(g: GeomBuilder, white: TileFrame, m: VoxMesh, tx: number, ty: number, tz: number, yaw: number): void {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const n = m.pos.length;
  const pos = new Float32Array(n), nrm = new Float32Array(n);
  for (let i = 0; i < n; i += 3) {
    const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2];
    pos[i] = tx + x * c + z * sn;
    pos[i + 1] = ty + y;
    pos[i + 2] = tz - x * sn + z * c;
    const nx = m.nrm[i], nz = m.nrm[i + 2];
    nrm[i] = nx * c + nz * sn;
    nrm[i + 1] = m.nrm[i + 1];
    nrm[i + 2] = -nx * sn + nz * c;
  }
  g.quads(pos, nrm, m.col, white);
}

/** Furniture drawn lying down, with its height in metres; anything else stands. */
function lyingHeight(id: string): number | null {
  if (/mattress|futon|bedroll|sleeping_bag/.test(id)) return 0.22;
  if (/bed|cot|hospital_bed|bunk/.test(id)) return 0.5;
  if (/rug|carpet|mat$|_mat_|towel/.test(id)) return 0.02;
  if (/pool_table|billiard/.test(id)) return 0.8;
  if (/coffin|casket/.test(id)) return 0.5;
  if (/rubble|ash|leaves|pile|debris|hay|straw|pallet|glass_shard|scrap/.test(id)) return 0.18;
  return null;
}

export class VoxelFactory implements VoxelProps {
  furniture(geo: Geo, white: TileFrame, src: TileTextureSource, id: string, x: number, y: number, base: number, _seed: number, yaw = 0): boolean {
    const f = src.furniture(id, 'sprite');
    const lie = lyingHeight(id);
    const m = lie !== null ? voxMesh(f, 'lie', lie) : voxMesh(f, 'stand', 6);
    if (!m) return false;
    place(geo(white), white, m, x + 0.5, base, y + 0.5, lie !== null ? 0 : yaw);
    return true;
  }

  item(geo: Geo, white: TileFrame, f: TileFrame, x: number, y: number, base: number, seed: number, k: number): boolean {
    const m = voxMesh(f, 'item', 0.035);
    if (!m) return false;
    const a = ((seed >>> (k * 3)) & 7) * 0.785 + k * 2.1;
    const r = k === 0 ? 0 : 0.2;
    const yaw = (((seed >>> (5 + k * 4)) & 15) / 16) * Math.PI * 2;
    place(geo(white), white, m, x + 0.5 + Math.cos(a) * r, base + k * 0.004, y + 0.5 + Math.sin(a) * r, yaw);
    return true;
  }
}

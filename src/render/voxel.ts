import type { GeomBuilder } from './geometry';
import { framePixels, frameKey, type Pixels } from './framePixels';
import type { TileFrame, TileTextureSource } from './textureSource';
import type { Season } from './atlasIndex';

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
  /** `season`: furniture whose tileset art exists only per season (UltiCa's f_dandelion has no
   *  plain tile) otherwise misses the atlas and inflates the fallback colour block. */
  furniture(geo: Geo, white: TileFrame, src: TileTextureSource, id: string, x: number, y: number, base: number, seed: number, yaw?: number, season?: Season): boolean;
  item(geo: Geo, white: TileFrame, f: TileFrame, x: number, y: number, base: number, seed: number, k: number): boolean;
}

interface VoxMesh {
  pos: Float32Array;
  nrm: Float32Array;
  /** frame-relative UV (0..1 across the sprite frame, v = 0 at its bottom) */
  uv: Float32Array;
  /** per-vertex shade (1 caps, darker walls) */
  shade: Float32Array;
}

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
  uv: number[] = [];
  shade: number[] = [];
  /** corners a..d as [x, y, z, u, v] */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], k: number): void {
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.uv.push(p[3], p[4]);
      this.shade.push(k);
    }
  }
  done(): VoxMesh {
    return { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), uv: new Float32Array(this.uv), shade: new Float32Array(this.shade) };
  }
}

/**
 * Height-field voxel mesher over a pixel grid, textured with the sprite itself. For pixel
 * (i, j) (j = 0 top row) the solid spans depth [lo, hi]. `P(i, j, d)` maps a pixel-grid
 * corner + depth to [x, y, z] metres; `UV(i, j)` gives the frame UV of that corner. Caps are
 * merged into rectangles of equal depth (the texture carries the pixel colours, so colour
 * never splits a quad); walls are merged along runs with the same exposed span and take
 * their colour from the edge pixel's texel, stretched along the depth.
 */
function heightMesh(w: number, h: number, on: Uint8Array, lo: Float32Array, hi: Float32Array,
  P: (i: number, j: number, d: number) => number[], UV: (i: number, j: number) => [number, number],
  nHi: number[], nLo: number[], sideN: (dir: number) => number[], out: MeshOut, doLo: boolean): void {
  const idx = (i: number, j: number) => j * w + i;
  const V = (i: number, j: number, d: number, uvI = i, uvJ = j) => [...P(i, j, d), ...UV(uvI, uvJ)];
  for (const top of [true, false]) {
    if (!top && !doLo) continue;
    const D = top ? hi : lo;
    const done = new Uint8Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const a = idx(i, j);
        if (!on[a] || done[a]) continue;
        const d = D[a];
        let e = i + 1;
        while (e < w && on[idx(e, j)] && !done[idx(e, j)] && D[idx(e, j)] === d) e++;
        let f = j + 1;
        grow: while (f < h) {
          for (let x = i; x < e; x++) if (!on[idx(x, f)] || done[idx(x, f)] || D[idx(x, f)] !== d) break grow;
          f++;
        }
        for (let y = j; y < f; y++) for (let x = i; x < e; x++) done[idx(x, y)] = 1;
        if (top) out.quad(V(i, f, d), V(e, f, d), V(e, j, d), V(i, j, d), nHi, 1);
        else out.quad(V(e, f, d), V(i, f, d), V(i, j, d), V(e, j, d), nLo, 1);
      }
  }
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  // exposed spans of pixel a's [lo, hi] toward neighbour k, as a key for merging
  const spans = (i: number, j: number, k: number): [number, number][] => {
    const a = idx(i, j);
    const ni = i + dirs[k][0], nj = j + dirs[k][1];
    const inside = ni >= 0 && nj >= 0 && ni < w && nj < h && on[idx(ni, nj)];
    const nhi = inside ? hi[idx(ni, nj)] : -1e9, nlo = inside ? lo[idx(ni, nj)] : 1e9;
    const r: [number, number][] = [];
    if (!inside || nhi <= lo[a] || nlo >= hi[a]) r.push([lo[a], hi[a]]);
    else {
      if (hi[a] > nhi) r.push([nhi, hi[a]]);
      if (lo[a] < nlo) r.push([lo[a], nlo]);
    }
    return r.filter(([s0, s1]) => s1 - s0 > 1e-6);
  };
  const same = (x: [number, number][], y: [number, number][]) => x.length === y.length && x.every((s, q) => s[0] === y[q][0] && s[1] === y[q][1]);
  for (let k = 0; k < 4; k++) {
    const vertical = k < 2; // left/right walls run along j
    const n = sideN(k);
    const lines = vertical ? w : h, len = vertical ? h : w;
    for (let L = 0; L < lines; L++) {
      let t = 0;
      while (t < len) {
        const [i, j] = vertical ? [L, t] : [t, L];
        if (!on[idx(i, j)]) { t++; continue; }
        const sp = spans(i, j, k);
        if (!sp.length) { t++; continue; }
        let u = t + 1;
        while (u < len) {
          const [i2, j2] = vertical ? [L, u] : [u, L];
          if (!on[idx(i2, j2)] || !same(spans(i2, j2, k), sp)) break;
          u++;
        }
        // run covers pixels t..u-1 along the line; wall on the pixel edge toward k,
        // texel = the run's pixels (centre across the edge)
        for (const [s0, s1] of sp) {
          if (k === 0) {
            const a = V(L, u, s0, L + 0.5, u), b = V(L, t, s0, L + 0.5, t), c = V(L, t, s1, L + 0.5, t), d = V(L, u, s1, L + 0.5, u);
            out.quad(b, a, d, c, n, 0.86);
          } else if (k === 1) {
            const a = V(L + 1, t, s0, L + 0.5, t), b = V(L + 1, u, s0, L + 0.5, u), c = V(L + 1, u, s1, L + 0.5, u), d = V(L + 1, t, s1, L + 0.5, t);
            out.quad(b, a, d, c, n, 0.86);
          } else if (k === 2) {
            const a = V(t, L, s0, t, L + 0.5), b = V(u, L, s0, u, L + 0.5), c = V(u, L, s1, u, L + 0.5), d = V(t, L, s1, t, L + 0.5);
            out.quad(b, a, d, c, n, 0.86);
          } else {
            const a = V(u, L + 1, s0, u, L + 0.5), b = V(t, L + 1, s0, t, L + 0.5), c = V(t, L + 1, s1, t, L + 0.5), d = V(u, L + 1, s1, u, L + 0.5);
            out.quad(b, a, d, c, n, 0.86);
          }
        }
        t = u;
      }
    }
  }
}

const meshCache = new Map<string, VoxMesh | null>();
/** Cost counters (cdda perf checks): new meshes built / time, placements / time, vertices. */
export const voxelStats = { built: 0, buildMs: 0, placed: 0, placeMs: 0, verts: 0 };

type Mode = 'stand' | 'lie' | 'item';

/**
 * Build (cached) the voxel mesh of a frame. Local space: metres, origin at the bottom centre
 * (stand) / centre of the floor footprint (lie, item); +z = the sprite's front (south).
 */
function voxMesh(f: TileFrame, mode: Mode, param: number): VoxMesh | null {
  const key = `${frameKey(f)}|${mode}|${param}`;
  if (meshCache.has(key)) return meshCache.get(key)!;
  const t0 = performance.now();
  let res: VoxMesh | null = null;
  const p = framePixels(f);
  const m = p ? mask(p) : null;
  if (p && m) {
    const { w, h, x0, y0, on } = m;
    const ppm = f.ppm ?? 16;
    const s = 1 / ppm;
    const out = new MeshOut();
    const UV = (i: number, j: number): [number, number] => [(i + x0) / p.w, 1 - (j + y0) / p.h];
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
      heightMesh(w, h, on, lo, hi, P, UV, [0, 0, 1], [0, 0, -1], (k) => [[-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]][k], out, true);
    } else {
      // laid flat: sprite column -> x, row -> z (top row = north = -z), extruded up
      const H = param;
      const hi = new Float32Array(w * h).fill(H), lo = new Float32Array(w * h);
      const cyPix = p.h / 2 - y0;
      const sc = mode === 'item' ? 0.5 * s : s;
      const P = (i: number, j: number, d: number) => [(i - cxPix) * sc, d, (j - cyPix) * sc];
      heightMesh(w, h, on, lo, hi, P, UV, [0, 1, 0], [0, -1, 0], (k) => [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]][k], out, false);
    }
    res = out.done();
    if (!res.pos.length) res = null;
  }
  meshCache.set(key, res);
  voxelStats.built++;
  voxelStats.buildMs += performance.now() - t0;
  return res;
}

/** Push a cached mesh rotated by `yaw` about Y and translated. */
function place(g: GeomBuilder, f: TileFrame, m: VoxMesh, tx: number, ty: number, tz: number, yaw: number): void {
  const t0 = performance.now();
  const n = m.pos.length;
  g.quadsTex(m.pos, m.nrm, m.uv, m.shade, f, 0, { x: tx, y: ty, z: tz, yaw });
  voxelStats.placed++;
  voxelStats.verts += n / 3;
  voxelStats.placeMs += performance.now() - t0;
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
  furniture(geo: Geo, white: TileFrame, src: TileTextureSource, id: string, x: number, y: number, base: number, _seed: number, yaw = 0, season?: Season): boolean {
    const f = src.furniture(id, 'sprite', { season });
    const lie = lyingHeight(id);
    const m = lie !== null ? voxMesh(f, 'lie', lie) : voxMesh(f, 'stand', 6);
    if (!m) return false;
    place(geo(f), f, m, x + 0.5, base, y + 0.5, lie !== null ? 0 : yaw);
    return true;
  }

  item(geo: Geo, white: TileFrame, f: TileFrame, x: number, y: number, base: number, seed: number, k: number): boolean {
    const m = voxMesh(f, 'item', 0.035);
    if (!m) return false;
    const a = ((seed >>> (k * 3)) & 7) * 0.785 + k * 2.1;
    const r = k === 0 ? 0 : 0.2;
    const yaw = (((seed >>> (5 + k * 4)) & 15) / 16) * Math.PI * 2;
    place(geo(f), f, m, x + 0.5 + Math.cos(a) * r, base + k * 0.004, y + 0.5 + Math.sin(a) * r, yaw);
    return true;
  }
}

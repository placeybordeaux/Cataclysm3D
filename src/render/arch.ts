import type { GeomBuilder, V3 } from './geometry';
import { Img, rampAround } from './pixelArt';
import type { TileFrame } from './textureSource';
import { hash2 } from './ground';

// Architectural detail for look.ts `archDetail`: the things that make a box read as a
// building — window frames, mullions and sills, door casings, a plinth at the foot of
// outside walls and a cornice under the roof, fences built from posts/rails/pickets, flat
// roofs with parapets and hipped roofs with eaves over shingle roofs. Pure geometry helpers
// called by the chunk mesher (which knows the neighbourhood); all detail is visual only.

/** Frames the detail needs (procedural, painted once). */
export interface ArchFrames {
  white: TileFrame;
  trim: TileFrame;
  plinth: TileFrame;
  shingle: TileFrame;
}

export type Geo = (f: TileFrame) => GeomBuilder;
type RGB = [number, number, number];

const srgbToLin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const lin = (r: number, g: number, b: number): RGB => [srgbToLin(r), srgbToLin(g), srgbToLin(b)];
export const TRIM = lin(196, 188, 170);
export const DARK_WOOD = lin(74, 54, 38);
export const METAL = lin(64, 68, 72);
export const FASCIA = lin(52, 46, 42);

/** Axis-aligned vertex-coloured box on the white texel (faces: GeomBuilder.box bits). */
export function cbox(g: GeomBuilder, white: TileFrame, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: RGB, faces = 63, cut = 0): void {
  const q = (a: V3, b: V3, c: V3, d: V3, n: V3, k: number) => g.quadEx(a, b, c, d, [n, n, n, n], [0, 0, 1, 1], white, [col[0] * k, col[1] * k, col[2] * k], cut);
  if (faces & 1) q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 0.9);
  if (faces & 2) q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 0.9);
  if (faces & 4) q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], 1);
  if (faces & 8) q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], 0.7);
  if (faces & 16) q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0.95);
  if (faces & 32) q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], 0.95);
}

/** Box spanning (a, b) on the wall axis (x if alongX else z) and (c, d) across it. */
function axBox(g: GeomBuilder, white: TileFrame, alongX: boolean, a: number, b: number, y0: number, y1: number, c: number, d: number, col: RGB): void {
  if (alongX) cbox(g, white, a, y0, c, b, y1, d, col);
  else cbox(g, white, c, y0, a, d, y1, b, col);
}

/**
 * Window in the tile (x, y): frame around the opening, a cross mullion, and sills
 * sticking out of both wall faces. `alongX`: the wall runs along x (pane faces +-z).
 */
export function windowDetail(geo: Geo, F: ArchFrames, x: number, y: number, alongX: boolean, sill: number, head: number, wood: boolean): void {
  const g = geo(F.white);
  const col = wood ? DARK_WOOD : TRIM;
  const [s0, s1] = alongX ? [x, x + 1] : [y, y + 1];
  const c = alongX ? y + 0.5 : x + 0.5;
  const fw = 0.07, fd = 0.06;
  axBox(g, F.white, alongX, s0, s0 + fw, sill, head, c - fd, c + fd, col);
  axBox(g, F.white, alongX, s1 - fw, s1, sill, head, c - fd, c + fd, col);
  axBox(g, F.white, alongX, s0, s1, sill, sill + fw, c - fd, c + fd, col);
  axBox(g, F.white, alongX, s0, s1, head - fw, head, c - fd, c + fd, col);
  // mullions (thin cross)
  const m = (s0 + s1) / 2, mid = (sill + head) / 2 + 0.1;
  axBox(g, F.white, alongX, m - 0.025, m + 0.025, sill, head, c - 0.03, c + 0.03, col);
  axBox(g, F.white, alongX, s0, s1, mid - 0.025, mid + 0.025, c - 0.03, c + 0.03, col);
  // sills proud of both faces (the wall block spans the whole tile)
  const [f0, f1] = alongX ? [y, y + 1] : [x, x + 1];
  axBox(g, F.white, alongX, s0 - 0.05, s1 + 0.05, sill - 0.06, sill, f0 - 0.09, f0 + 0.02, TRIM);
  axBox(g, F.white, alongX, s0 - 0.05, s1 + 0.05, sill - 0.06, sill, f1 - 0.02, f1 + 0.09, TRIM);
  // head trim over the opening on both faces
  axBox(g, F.white, alongX, s0 - 0.06, s1 + 0.06, head, head + 0.08, f0 - 0.04, f0 + 0.01, TRIM);
  axBox(g, F.white, alongX, s0 - 0.06, s1 + 0.06, head, head + 0.08, f1 - 0.01, f1 + 0.04, TRIM);
}

/** Door casing: jambs and a head on both faces, overlapping the neighbouring walls. */
export function doorCasing(geo: Geo, F: ArchFrames, x: number, y: number, alongX: boolean, base: number, head: number): void {
  const g = geo(F.white);
  const [s0, s1] = alongX ? [x, x + 1] : [y, y + 1];
  const [f0, f1] = alongX ? [y, y + 1] : [x, x + 1];
  const w = 0.1, p = 0.045;
  for (const [a, b] of [[f0 - p, f0 + 0.01], [f1 - 0.01, f1 + p]]) {
    axBox(g, F.white, alongX, s0 - w + 0.02, s0 + 0.02, base, head + 0.1, a, b, TRIM);
    axBox(g, F.white, alongX, s1 - 0.02, s1 + w - 0.02, base, head + 0.1, a, b, TRIM);
    axBox(g, F.white, alongX, s0 - w + 0.02, s1 + w - 0.02, head, head + 0.12, a, b, TRIM);
  }
  // threshold
  axBox(g, F.white, alongX, s0, s1, base, base + 0.025, f0 - 0.03, f1 + 0.03, DARK_WOOD);
}

/**
 * A horizontal band on the outside of wall tile (x, y)'s face toward direction d
 * (0 N, 1 E, 2 S, 3 W): plinth or cornice. Extends a little past the tile so bands of
 * adjacent tiles close the outer corners.
 */
export function wallBand(g: GeomBuilder, f: TileFrame, x: number, y: number, d: number, y0: number, y1: number, out: number, vBase: number, cut = 0): void {
  const e = out;
  // faces bits: N = -z (32), E = +x (1), S = +z (16), W = -x (2); plus top (4)
  if (d === 0) g.box(x - e, y0, y - out, x + 1 + e, y1, y, 32 | 1 | 2 | 4 | 8, f, f, vBase, cut);
  else if (d === 2) g.box(x - e, y0, y + 1, x + 1 + e, y1, y + 1 + out, 16 | 1 | 2 | 4 | 8, f, f, vBase, cut);
  else if (d === 1) g.box(x + 1, y0, y - e, x + 1 + out, y1, y + 1 + e, 1 | 16 | 32 | 4 | 8, f, f, vBase, cut);
  else g.box(x - out, y0, y - e, x, y1, y + 1 + e, 2 | 16 | 32 | 4 | 8, f, f, vBase, cut);
}

// Direction tables: N, E, S, W in tile space (y south).
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/**
 * Fence built from parts. `conn[d]`: connects toward direction d. Kinds: 'wood' (posts,
 * two rails, pickets), 'metal' (posts, top/bottom rail, balusters), 'chain' (posts + top
 * rail; the mesh pane stays).
 */
export function fence(geo: Geo, F: ArchFrames, x: number, y: number, base: number, h: number, kind: 'wood' | 'metal' | 'chain', conn: boolean[], col: RGB): void {
  const g = geo(F.white);
  const cx = x + 0.5, cz = y + 0.5;
  const post = kind === 'wood' ? 0.06 : 0.035;
  cbox(g, F.white, cx - post, base, cz - post, cx + post, base + h + (kind === 'wood' ? 0.06 : 0.04), cz + post, col);
  const any = conn.some((c) => c);
  for (let d = 0; d < 4; d++) {
    if (!conn[d] && !(!any && (d === 1 || d === 3))) continue;
    const ex = cx + DX[d] * 0.5, ez = cz + DY[d] * 0.5;
    const x0 = Math.min(cx, ex), x1 = Math.max(cx, ex), z0 = Math.min(cz, ez), z1 = Math.max(cz, ez);
    const rails = kind === 'chain' ? [h - 0.02] : kind === 'metal' ? [0.08, h - 0.04] : [0.25, h - 0.25];
    const rt = kind === 'wood' ? 0.025 : 0.018;
    for (const ry of rails) {
      if (DX[d]) cbox(g, F.white, x0, base + ry - rt, cz - rt, x1, base + ry + rt, cz + rt, col);
      else cbox(g, F.white, cx - rt, base + ry - rt, z0, cx + rt, base + ry + rt, z1, col);
    }
    if (kind === 'chain') continue;
    const step = kind === 'wood' ? 0.125 : 0.11;
    for (let t = step / 2; t < 0.5; t += step) {
      const px = cx + DX[d] * t, pz = cz + DY[d] * t;
      const w = kind === 'wood' ? 0.045 : 0.012;
      const dep = kind === 'wood' ? 0.018 : 0.012;
      const top = kind === 'wood' ? h - 0.02 + (hash2(Math.round(px * 16), Math.round(pz * 16), 3) & 1) * 0.04 : h - 0.04;
      if (DX[d]) cbox(g, F.white, px - w, base, cz - dep - 0.03, px + w, base + top, cz + dep - 0.03, col);
      else cbox(g, F.white, cx - dep - 0.03, base, pz - w, cx + dep - 0.03, base + top, pz + w, col);
    }
  }
}

export const ROOF_SLOPE = 0.5;
const EAVE = 0.38;

/**
 * Hipped roof over one tile of a pitched roof region. `dist(X, Y)`: tiles from corner
 * (X, Y) to the region's edge (0 on the edge); `inRoof(tx, ty)`. Heights are dist *
 * slope; edge corners reach out over the walls as eaves, with fascia and soffit.
 * `cut` hides the roof while the player is on that level (materials.ts uPlayerLevel).
 */
export function hipRoofTile(geo: Geo, F: ArchFrames, x: number, y: number, base: number, dist: (X: number, Y: number) => number,
  inRoof: (tx: number, ty: number) => boolean, cut: number): void {
  const corners: [number, number][] = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
  const P: V3[] = corners.map(([X, Y]) => {
    const d = dist(X, Y);
    let ox = 0, oz = 0;
    if (d === 0) {
      // outward: away from the roof tiles touching this corner
      let sx = 0, sz = 0;
      for (const [tx, ty] of [[X - 1, Y - 1], [X, Y - 1], [X - 1, Y], [X, Y]]) if (inRoof(tx, ty)) { sx += X - (tx + 0.5); sz += Y - (ty + 0.5); }
      ox = Math.sign(sx) * EAVE;
      oz = Math.sign(sz) * EAVE;
    }
    return [X + ox, base + (d === 0 ? -EAVE * ROOF_SLOPE : Math.min(d, 6) * ROOF_SLOPE), Y + oz];
  });
  const g = geo(F.shingle);
  // split along the diagonal whose ends differ more: follows hips and valleys
  const h = P.map((p) => p[1]);
  const diag02 = Math.abs(h[0] - h[2]) >= Math.abs(h[1] - h[3]);
  const tris: [number, number, number][] = diag02 ? [[0, 2, 1], [0, 3, 2]] : [[0, 3, 1], [1, 3, 2]];
  for (const [ia, ib, ic] of tris) {
    let a = P[ia], b = P[ib], c = P[ic];
    let n = tnormal(a, b, c);
    if (n[1] < 0) { [b, c] = [c, b]; n = [-n[0], -n[1], -n[2]]; }
    // shingle rows run along the eave: u across the slope
    const uv = (p: V3) => (Math.abs(n[0]) > Math.abs(n[2]) ? [p[2], p[0] * 1.3] : [p[0], p[2] * 1.3]);
    const k = 0.85 + 0.15 * n[1];
    g.tri(a, b, c, n, [...uv(a), ...uv(b), ...uv(c)], F.shingle, [k, k, k], cut);
  }
  // fascia + soffit along edges that face out of the roof region
  const w = geo(F.white);
  for (let d = 0; d < 4; d++) {
    if (inRoof(x + DX[d], y + DY[d])) continue;
    // corners of that edge, CCW seen from outside: N edge = (1,0)->(0,0) etc.
    const [i0, i1] = d === 0 ? [1, 0] : d === 1 ? [2, 1] : d === 2 ? [3, 2] : [0, 3];
    const a = P[i0], b = P[i1];
    const n: V3 = [DX[d], 0, DY[d]];
    w.quadEx([a[0], a[1] - 0.16, a[2]], [b[0], b[1] - 0.16, b[2]], [b[0], b[1] + 0.02, b[2]], [a[0], a[1] + 0.02, a[2]], [n, n, n, n], [0, 0, 1, 1], F.white, FASCIA, cut);
    // soffit: from the eave edge back to the wall line, facing down
    const wa: V3 = [corners[i0][0], base - 0.02, corners[i0][1]], wb: V3 = [corners[i1][0], base - 0.02, corners[i1][1]];
    const dn: V3 = [0, -1, 0];
    w.quadEx([b[0], b[1] - 0.16, b[2]], [a[0], a[1] - 0.16, a[2]], wa, wb, [dn, dn, dn, dn], [0, 0, 1, 1], F.white, [TRIM[0] * 0.6, TRIM[1] * 0.6, TRIM[2] * 0.6], cut);
  }
}

function tnormal(a: V3, b: V3, c: V3): V3 {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

// --- painted frames ---------------------------------------------------------------------

/** 16x16 shingle rows: staggered tabs, shadow line under each row. */
export function paintShingle(base: [number, number, number]): Img {
  const S = 16;
  const r = rampAround(base, 1);
  const img = new Img(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const row = y >> 2;
      const off = row & 1 ? 2 : 0;
      const tab = ((x + off) >> 2) & 3;
      const ly = y & 3;
      const hsh = hash2(x, y, 91) & 7;
      let c = ly === 3 ? r[0] : r[1 + ((tab + row) % 3 === 0 ? 1 : 0) + (ly === 0 ? 1 : 0)];
      if (((x + off) & 3) === 0 && ly < 3) c = r[0];
      if (hsh === 0 && ly < 3) c = r[Math.max(0, r.indexOf(c) - 1)] ?? c;
      img.set(x, y, c);
    }
  return img;
}

/** Plain painted trim (a subtle 2-tone so it isn't a flat blob at low res). */
export function paintSolid(c: [number, number, number], spread = 0.25): Img {
  const S = 8;
  const r = rampAround(c, spread);
  const img = new Img(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(x, y, y === 0 ? r[3] : y === S - 1 ? r[1] : r[2]);
  return img;
}

import type { V3 } from '../geometry';
import type { ModelBuilder } from '../furniture/mesh';
import type { FaceSpec } from '../furniture/paint';
import { F, woodOf } from '../furniture/kit';
import type { SpritePalette } from '../furniture/palette';
import type { RGB } from '../colors';
import { LEVEL_HEIGHT } from '../../world/coords';
import { DX, DY, type StairLink } from '../../game/stairs';
import { riserCount } from '../../game/stairwalk';
import { SLAB } from '../chunkMesh';

// Modelled staircases (docs/STAIRS.md), in the furniture kit's style: low-poly parts with
// per-face pixel textures at 32 texels/m (furniture/paint.ts), colours from the stair's UltiCa
// sprite. A link is modelled twice:
//   lower  the flight itself — treads, risers, stringers, the soffit and spandrel under it,
//          banisters on open sides / a wall rail against walls; spiral: centre post, wedge
//          treads, helical rail; ladder: rails and rungs
//   upper  the stairwell cut into the floor above — a fascia on the slab edge (and a band
//          closing the gap between the wall tops below and the walls above), a railing
//          round the opening except where the flight arrives
// Both are built in the link's frame: origin = the anchor tile's corner (x, y) on the lower
// floor; builder x = east, y = up (0 = lower floor), z = south.

const H = LEVEL_HEIGHT;
const WALL_TOP = H - SLAB;
const RAIL_H = 0.92;

export interface StairStyle {
  name: 'wood' | 'concrete' | 'metal';
  tread: FaceSpec;
  riser: FaceSpec;
  stringer: FaceSpec;
  rail: FaceSpec;
  baluster: FaceSpec;
  post: FaceSpec;
  trim: FaceSpec;
  plaster: FaceSpec;
  /** close the space under a flight with a panel (house stairs, concrete) */
  spandrel: boolean;
}

const WHITE_PAINT: RGB = [226, 222, 210];

/** Style from the stair terrain, its sprite and the floor it starts from. */
export function stairStyle(link: StairLink, pal: SpritePalette | null, floorId: string): StairStyle {
  const wood = woodOf(pal ?? { clusters: [], main: [120, 78, 46] } as unknown as SpritePalette, [128, 84, 50]);
  const dark: RGB = [wood[0] * 0.62, wood[1] * 0.58, wood[2] * 0.55];
  if (link.kind === 'ladder') {
    const steel = F('metal', [104, 108, 112]);
    return { name: 'metal', tread: steel, riser: steel, stringer: steel, rail: steel, baluster: steel, post: steel, trim: F('metal', [96, 98, 100]), plaster: F('paint', WHITE_PAINT, undefined, false), spandrel: false };
  }
  const woody = /wood/.test(link.terId) || /carpet|wood|parquet|^t_floor$|linoleum|_rug/.test(floorId);
  if (woody || link.kind === 'slope') {
    return {
      name: 'wood', tread: F('wood', wood), riser: F('paint', WHITE_PAINT), stringer: F('paint', WHITE_PAINT), rail: F('wood', dark),
      baluster: F('paint', WHITE_PAINT, undefined, false), post: F('wood', dark), trim: F('paint', WHITE_PAINT), plaster: F('paint', WHITE_PAINT, undefined, false), spandrel: true,
    };
  }
  const conc: RGB = [150, 148, 142];
  const steel: RGB = [92, 98, 104];
  return {
    name: 'concrete', tread: F('stone', conc), riser: F('stone', [138, 136, 130]), stringer: F('stone', [132, 130, 124]), rail: F('metal', steel),
    baluster: F('metal', steel, undefined, false), post: F('metal', steel), trim: F('stone', [140, 138, 132]), plaster: F('paint', [200, 198, 190], undefined, false), spandrel: true,
  };
}

// ---------------------------------------------------------------------------------- helpers

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** Quad a,b,c,d whose face points along `n` (the winding is fixed up to match). */
function quadN(b: ModelBuilder, a: V3, bb: V3, c: V3, d: V3, spec: FaceSpec, n: V3): void {
  const f = cross(sub(bb, a), sub(d, a));
  if (dot(f, n) >= 0) b.quad(a, bb, c, d, spec);
  else b.quad(bb, a, d, c, spec);
}

/** A square-section bar from p0 to p1 (handrails, sloped strings of balusters). */
function beam(b: ModelBuilder, p0: V3, p1: V3, w: number, h: number, spec: FaceSpec, caps = true): void {
  const t = norm(sub(p1, p0));
  let s = cross(t, [0, 1, 0]);
  if (Math.hypot(s[0], s[1], s[2]) < 1e-4) s = [1, 0, 0];
  s = norm(s);
  const u = norm(cross(s, t));
  const c = (p: V3, i: number, j: number): V3 => add(add(p, s, (i * w) / 2), u, (j * h) / 2);
  const faces: [number, number, number, number, V3][] = [
    [-1, 1, 1, 1, u], [1, -1, -1, -1, [-u[0], -u[1], -u[2]]], [1, 1, 1, -1, s], [-1, -1, -1, 1, [-s[0], -s[1], -s[2]]],
  ];
  for (const [i0, j0, i1, j1, n] of faces) quadN(b, c(p0, i0, j0), c(p0, i1, j1), c(p1, i1, j1), c(p1, i0, j0), spec, n);
  if (caps) {
    quadN(b, c(p0, -1, -1), c(p0, 1, -1), c(p0, 1, 1), c(p0, -1, 1), spec, [-t[0], -t[1], -t[2]]);
    quadN(b, c(p1, -1, -1), c(p1, 1, -1), c(p1, 1, 1), c(p1, -1, 1), spec, t);
  }
}

/** Is there something solid (a wall) at tile (x, y) on level z? */
export type SolidAt = (x: number, y: number, z: number) => boolean;

// ---------------------------------------------------------------------------------- flights

/** The flight (lower level) of a link. */
export function buildLower(b: ModelBuilder, L: StairLink, st: StairStyle, solid: SolidAt): void {
  if (L.shape === 'straight') straight(b, L, st, solid);
  else if (L.shape === 'spiral') spiral(b, L, st);
  else ladder(b, L, st);
}

function straight(b: ModelBuilder, L: StairLink, st: StairStyle, solid: SolidAt): void {
  const [ax, ay] = L.tiles[0];
  const d = L.dIn;
  const vx = DX[d], vy = DY[d];
  const lx = vx === 0 ? 1 : 0, ly = vx === 0 ? 0 : 1;
  const ox = L.ex - ax, oz = L.ey - ay;
  const R = L.run, W = L.width;
  // flight space (u along, v across, h up) -> builder space
  const P = (u: number, v: number, h: number): V3 => [ox + vx * u + lx * v, h, oz + vy * u + ly * v];
  const U: V3 = [vx, 0, vy], Vv: V3 = [lx, 0, ly];
  const box = (u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, spec: FaceSpec | ((f: string) => FaceSpec | null), skip = '') => {
    const a = P(u0, v0, h0), c = P(u1, v1, h1);
    b.box(Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2]), Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2]), spec as never, skip);
  };
  const N = riserCount(L);
  const rise = H / N, t = R / N, slope = H / R;
  const steep = R <= 1;
  const sT = 0.045;
  // which long sides are against walls (on the lower level, beside the flight's tiles)
  const sideWall = (side: 0 | 1) => {
    let n = 0;
    for (let k = 0; k < R; k++) {
      const u = k + 0.5, v = side === 0 ? -0.5 : W + 0.5;
      const x = Math.floor(ax + ox + vx * u + lx * v), y = Math.floor(ay + oz + vy * u + ly * v);
      if (solid(x, y, L.z)) n++;
    }
    return n * 2 >= R;
  };
  const wall = [sideWall(0), sideWall(1)];

  // treads (with a nosing) and risers
  for (let k = 0; k < N; k++) {
    const h1 = (k + 1) * rise, h0 = h1 - (steep ? 0.035 : 0.04);
    const u0 = Math.max(0, k * t - (k ? 0.025 : 0)), u1 = (k + 1) * t;
    box(u0, u1, sT, W - sT, h0, h1, st.tread);
    if (!steep) {
      // closed risers: the board under each nosing
      const f = P(k * t, sT, k * rise), g = P(k * t, W - sT, h0);
      quadN(b, f, P(k * t, W - sT, k * rise), g, P(k * t, sT, h0), st.riser, [-vx, 0, -vy]);
    }
  }
  // stringers: sloped boards on both sides, and the soffit under the treads
  const top = (u: number) => Math.min(H + 0.06, u * slope + 0.2);
  const bot = (u: number) => Math.max(0, u * slope - 0.3);
  for (const side of [0, 1] as const) {
    const v0 = side === 0 ? 0 : W - sT, v1 = side === 0 ? sT : W;
    const out: V3 = side === 0 ? [-lx, 0, -ly] : [lx, 0, ly];
    const inn: V3 = [-out[0], 0, -out[2]];
    const us = [0, R];
    for (const [vv, n] of [[side === 0 ? v0 : v1, out], [side === 0 ? v1 : v0, inn]] as [number, V3][])
      quadN(b, P(us[0], vv, bot(0)), P(us[1], vv, bot(R)), P(us[1], vv, top(R)), P(us[0], vv, top(0)), st.stringer, n);
    // top and bottom edges
    const nt = norm([-vx * slope, 1, -vy * slope]);
    quadN(b, P(0, v0, top(0)), P(0, v1, top(0)), P(R, v1, top(R)), P(R, v0, top(R)), st.stringer, nt);
    quadN(b, P(0, v0, bot(0)), P(0, v1, bot(0)), P(R, v1, bot(R)), P(R, v0, bot(R)), st.stringer, [-nt[0], -nt[1], -nt[2]]);
    quadN(b, P(0, v0, 0), P(0, v1, 0), P(0, v1, top(0)), P(0, v0, top(0)), st.stringer, [-vx, 0, -vy]);
    // spandrel: close the triangle under an open side (a wall panel under the stairs)
    if (st.spandrel && !wall[side] && !steep) {
      // a triangle (the last corner doubled; the builder's normal comes from a, b and d)
      const sv = side === 0 ? 0 : W;
      quadN(b, P(0.02, sv, 0), P(R, sv, 0), P(R, sv, bot(R)), P(R, sv, bot(R)), st.stringer, out);
    }
  }
  // soffit: the underside of the flight, seen from below
  quadN(b, P(0, sT, 0), P(0, W - sT, 0), P(R, W - sT, bot(R)), P(R, sT, bot(R)), st.stringer, norm([vx * slope, -1, vy * slope]));
  // the end under the top (facing the room below, when it isn't against a wall)
  quadN(b, P(R, sT, 0), P(R, W - sT, 0), P(R, W - sT, bot(R)), P(R, sT, bot(R)), st.stringer, U);

  // banisters on open sides, a wall rail against walls
  for (const side of [0, 1] as const) {
    const v = side === 0 ? sT / 2 : W - sT / 2;
    if (wall[side]) {
      if (steep) continue;
      const vw = side === 0 ? 0.07 : W - 0.07;
      beam(b, P(0.25, vw, 0.25 * slope + RAIL_H - 0.04), P(R - 0.05, vw, (R - 0.05) * slope + RAIL_H - 0.04), 0.045, 0.045, st.rail);
      for (const u of [0.4, R / 2, R - 0.3]) box(u - 0.015, u + 0.015, side === 0 ? 0 : vw, side === 0 ? vw : W, u * slope + RAIL_H - 0.07, u * slope + RAIL_H - 0.05, st.post);
      continue;
    }
    // newel post at the foot, handrail up to the stairwell railing, a baluster per tread
    const pw = steep ? 0.05 : 0.085;
    box(0.02, 0.02 + pw, v - pw / 2, v + pw / 2, 0, RAIL_H + 0.12, st.post);
    box(0.005, 0.035 + pw, v - pw / 2 - 0.015, v + pw / 2 + 0.015, RAIL_H + 0.12, RAIL_H + 0.16, st.post);
    const r0 = P(0.02 + pw / 2, v, RAIL_H), r1 = P(R, v, H + RAIL_H);
    beam(b, r0, r1, 0.05, 0.055, st.rail);
    const bw = 0.026;
    for (let k = 0; k < N; k++) {
      const uc = (k + 0.5) * t;
      if (uc < 0.02 + pw + 0.04) continue;
      const h0 = (k + 1) * rise;
      box(uc - bw / 2, uc + bw / 2, v - bw / 2, v + bw / 2, h0, uc * slope + RAIL_H - 0.02, st.baluster);
    }
  }
}

function spiral(b: ModelBuilder, L: StairLink, st: StairStyle): void {
  const [ax, ay] = L.tiles[0];
  const sp = L.spiral!;
  const cx = sp.cx - ax, cz = sp.cy - ay;
  const N = riserCount(L);
  const rise = H / N, dA = sp.sweep / N, sg = Math.sign(sp.sweep);
  const rin = 0.06, rout = 0.47, thick = 0.04;
  const at = (a: number, r: number, h: number): V3 => [cx + Math.cos(a) * r, h, cz + Math.sin(a) * r];
  // centre post, running up to the railing above
  b.prism(cx, cz, 0, H + RAIL_H + 0.1, 0.055, 8, st.post, st.post);
  b.prism(cx, cz, H + RAIL_H + 0.1, H + RAIL_H + 0.16, 0.075, 8, st.post, st.post, st.post);
  const railPts: V3[] = [];
  for (let k = 0; k < N; k++) {
    // each tread overlaps the one below by a little, like real spiral treads
    const a0 = sp.a0 + k * dA - dA * 0.12, a1 = sp.a0 + (k + 1) * dA;
    const h1 = (k + 1) * rise, h0 = h1 - thick;
    const i0 = at(a0, rin, h1), o0 = at(a0, rout, h1), o1 = at(a1, rout, h1), i1 = at(a1, rin, h1);
    quadN(b, i0, o0, o1, i1, st.tread, [0, 1, 0]);
    quadN(b, at(a0, rin, h0), at(a0, rout, h0), at(a1, rout, h0), at(a1, rin, h0), st.tread, [0, -1, 0]);
    // leading edge (what you step onto) and the outer arc
    const back: V3 = [Math.sin(a0) * sg, 0, -Math.cos(a0) * sg];
    quadN(b, at(a0, rin, h0), at(a0, rout, h0), o0, i0, st.tread, back);
    const mid = (a0 + a1) / 2;
    quadN(b, at(a0, rout, h0), at(a1, rout, h0), o1, o0, st.tread, [Math.cos(mid), 0, Math.sin(mid)]);
    const fwd: V3 = [-Math.sin(a1) * sg, 0, Math.cos(a1) * sg];
    quadN(b, at(a1, rin, h0), at(a1, rout, h0), o1, i1, st.tread, fwd);
    // a baluster at each tread's outer edge, carrying the helical rail
    const ab = (a0 + a1) / 2 + dA * 0.06;
    const p = at(ab, rout - 0.03, h1);
    b.box(p[0] - 0.013, h1, p[2] - 0.013, p[0] + 0.013, h1 + RAIL_H - 0.02, p[2] + 0.013, st.baluster);
    railPts.push(at(ab, rout - 0.03, h1 + RAIL_H));
  }
  // rail from the foot to the landing; a newel at the foot
  const foot = at(sp.a0 - dA * 0.4, rout - 0.03, 0);
  b.box(foot[0] - 0.035, 0, foot[2] - 0.035, foot[0] + 0.035, RAIL_H + 0.1, foot[2] + 0.035, st.post);
  railPts.unshift([foot[0], RAIL_H + 0.06, foot[2]]);
  for (let i = 0; i + 1 < railPts.length; i++) beam(b, railPts[i], railPts[i + 1], 0.045, 0.045, st.rail, i === 0);
}

function ladder(b: ModelBuilder, L: StairLink, st: StairStyle): void {
  const [ax, ay] = L.tiles[0];
  const s = L.ladderSide!;
  const cx = ax + 0.5 - ax, cz = ay + 0.5 - ay;
  const nx = DX[s], nz = DY[s];
  const tx = -nz, tz = nx;
  const plane = 0.42;
  const P = (along: number, h: number, off = 0): V3 => [cx + nx * (plane + off) + tx * along, h, cz + nz * (plane + off) + tz * along];
  const top = H + 1.0;
  for (const side of [-0.23, 0.23]) {
    const a = P(side, 0), c = P(side, top);
    b.box(Math.min(a[0], c[0]) - 0.025, 0, Math.min(a[2], c[2]) - 0.025, Math.max(a[0], c[0]) + 0.025, top, Math.max(a[2], c[2]) + 0.025, st.rail);
  }
  for (let h = 0.28; h < top - 0.1; h += 0.3) {
    const a = P(-0.21, h), c = P(0.21, h);
    b.box(Math.min(a[0], c[0]) - 0.014, h - 0.014, Math.min(a[2], c[2]) - 0.014, Math.max(a[0], c[0]) + 0.014, h + 0.014, Math.max(a[2], c[2]) + 0.014, st.rail);
  }
  // wall brackets holding it off the wall
  for (const h of [0.6, H - 0.4]) for (const side of [-0.23, 0.23]) {
    const a = P(side, h), c = P(side, h, 0.08);
    b.box(Math.min(a[0], c[0]) - 0.015, h - 0.02, Math.min(a[2], c[2]) - 0.015, Math.max(a[0], c[0]) + 0.015, h + 0.02, Math.max(a[2], c[2]) + 0.015, st.trim);
  }
}

// ---------------------------------------------------------------------------------- stairwell

/**
 * The opening in the floor above (upper level): fascia on the slab edges, a band closing the
 * gap between the walls below and above, a railing round the open edges except where the
 * flight arrives. Ladders get a hatch curb instead of a railing.
 */
export function buildUpper(b: ModelBuilder, L: StairLink, st: StairStyle, solid: SolidAt): void {
  const [ax, ay] = L.tiles[0];
  const well = new Set(L.upper.map(([x, y]) => `${x},${y}`));
  const top = new Set(L.top.map(([x, y]) => `${x},${y}`));
  const z1 = L.z + 1;
  for (const [x, y] of L.upper) {
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (well.has(`${nx},${ny}`)) continue;
      // the edge of tile (x, y) toward d, in builder space; `n` points into the well
      const X0 = x - ax, Z0 = y - ay;
      const e: [V3, V3] = d === 0 ? [[X0, 0, Z0], [X0 + 1, 0, Z0]] : d === 1 ? [[X0 + 1, 0, Z0], [X0 + 1, 0, Z0 + 1]] : d === 2 ? [[X0 + 1, 0, Z0 + 1], [X0, 0, Z0 + 1]] : [[X0, 0, Z0 + 1], [X0, 0, Z0]];
      const n: V3 = [-DX[d], 0, -DY[d]];
      const at = (p: V3, h: number, off = 0): V3 => [p[0] - n[0] * off, h, p[2] - n[2] * off];
      const wallUp = solid(nx, ny, z1), wallDown = solid(nx, ny, L.z);
      // close the slab edge / the gap in the wall between the storeys
      quadN(b, at(e[0], WALL_TOP - 0.01, -0.004), at(e[1], WALL_TOP - 0.01, -0.004), at(e[1], H + (wallUp ? 0.01 : 0.02), -0.004), at(e[0], H + (wallUp ? 0.01 : 0.02), -0.004), wallUp && wallDown ? st.plaster : st.trim, n);
      if (wallUp) continue;
      // a nosing lip on the floor edge
      const lip0 = at(e[0], H, 0.0), lip1 = at(e[1], H, 0.0);
      const q0 = at(e[0], H + 0.02, 0.045), q1 = at(e[1], H + 0.02, 0.045);
      quadN(b, lip0, lip1, q1, q0, st.trim, [0, 1, 0]);
      if (top.has(`${nx},${ny}`)) continue;
      if (L.kind === 'ladder') {
        // hatch curb
        const c0 = at(e[0], H, 0.05), c1 = at(e[1], H, 0.05);
        beam(b, [c0[0], H + 0.04, c0[2]], [c1[0], H + 0.04, c1[2]], 0.06, 0.08, st.trim);
        continue;
      }
      railing(b, at(e[0], H, 0.04), at(e[1], H, 0.04), st);
    }
  }
}

/** A balustrade along the floor from p0 to p1: posts at the ends, balusters, top rail. */
function railing(b: ModelBuilder, p0: V3, p1: V3, st: StairStyle): void {
  const len = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  const dx = (p1[0] - p0[0]) / len, dz = (p1[2] - p0[2]) / len;
  const y = p0[1];
  const post = (p: V3, w: number) => b.box(p[0] - w / 2, y, p[2] - w / 2, p[0] + w / 2, y + RAIL_H + 0.1, p[2] + w / 2, st.post);
  post(p0, 0.075);
  post(p1, 0.075);
  beam(b, [p0[0], y + RAIL_H, p0[2]], [p1[0], y + RAIL_H, p1[2]], 0.05, 0.055, st.rail);
  beam(b, [p0[0], y + 0.07, p0[2]], [p1[0], y + 0.07, p1[2]], 0.035, 0.03, st.post);
  const n = Math.max(1, Math.round(len / 0.12));
  for (let i = 1; i < n; i++) {
    const t = (i / n) * len;
    const x = p0[0] + dx * t, z = p0[2] + dz * t;
    b.box(x - 0.013, y + 0.085, z - 0.013, x + 0.013, y + RAIL_H - 0.025, z + 0.013, st.baluster);
  }
}


import type { RGB } from '../colors';
import type { ModelBuilder } from './mesh';
import type { Decal, FaceSpec } from './paint';
import type { SpritePalette } from './palette';
import { F, STEEL, hsv, lumOf, shade, woodOf } from './kit';

// Fences, railings and gates for the modelled look: posts, rails, pickets and boards as
// textured geometry (the arch.ts versions were flat vertex-coloured sticks), chain-link as a
// see-through mesh texture. World-aligned (no rotation): `conn[d]` = connects toward
// direction d (0 N, 1 E, 2 S, 3 W) like arch.ts.

export type FenceKind = 'picket' | 'privacy' | 'splitrail' | 'chain' | 'chicken' | 'wire' | 'metal' | 'glass' | 'concrete';

/** Fence kind from a terrain id. Pure; unit tested. */
export function fenceKind(id: string): FenceKind {
  const k = (re: RegExp) => re.test(id);
  if (k(/privacy/)) return 'privacy';
  if (k(/splitrail/)) return 'splitrail';
  if (k(/chickenwire/)) return 'chicken';
  if (k(/chain/)) return 'chain';
  if (k(/barbed|fence_wire|rope/)) return 'wire';
  if (k(/glass_railing/)) return 'glass';
  if (k(/concrete_railing/)) return 'concrete';
  if (k(/metal|railing|_bars|^t_bars|iron|steel/)) return 'metal';
  return 'picket';
}

/** Height of a fence kind (m). */
export function fenceHeight(kind: FenceKind): number {
  return kind === 'chain' ? 2.0 : kind === 'privacy' ? 1.8 : kind === 'chicken' ? 1.4 : kind === 'metal' || kind === 'glass' || kind === 'concrete' ? 1.05 : kind === 'splitrail' ? 1.1 : kind === 'wire' ? 1.2 : 1.1;
}

/** See-through diamond mesh (chain-link, chicken wire): texels outside the wires are clear. */
function mesh(period: number): Decal {
  return {
    k: `mesh${period}`,
    draw(img, r, w, h) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const on = (x + y) % period === 0 || (x - y + 1000 * period) % period === 0;
          if (on) img.set(x, y, (x + y) % (period * 2) === 0 ? r[3] : r[2]);
          else img.set(x, y, [0, 0, 0], 0);
        }
    },
  };
}

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/** Paint-ish colour for wood fences: the sprite's wood, lifted (weathered pale boards). */
function fenceWood(pal: SpritePalette | null, kind: FenceKind): RGB {
  const w = pal ? woodOf(pal, [150, 120, 84]) : [150, 120, 84] as RGB;
  if (kind === 'picket' && pal && pal.clusters.some((q) => lumOf(q.c) > 170 && hsv(q.c)[1] < 0.2)) return [218, 214, 202]; // white pickets
  return w;
}

/**
 * One fence tile in world-aligned local space (origin = tile centre on the ground). Double-
 * sided parts are closed boxes; mesh panes are two back-to-back quads.
 */
export function buildFence(b: ModelBuilder, kind: FenceKind, conn: boolean[], pal: SpritePalette | null): void {
  const h = fenceHeight(kind);
  const any = conn.some((c) => c);
  const dirs = [0, 1, 2, 3].filter((d) => conn[d] || (!any && (d === 1 || d === 3)));
  const woodC = fenceWood(pal, kind);
  const W = F('wood', woodC), Wd = F('wood', shade(woodC, 0.85));
  const galv: RGB = [150, 156, 160];
  const metalC: RGB = pal ? (pal.clusters.find((q) => hsv(q.c)[1] < 0.25 && lumOf(q.c) < 120)?.c ?? [52, 54, 58]) : [52, 54, 58];
  const M = F('metal', metalC), G = F('chrome', galv);
  // centre post
  switch (kind) {
    case 'chain': case 'chicken': case 'wire':
      b.prism(0, 0, 0, h + 0.05, 0.03, 6, kind === 'wire' ? W : G, kind === 'wire' ? W : G);
      break;
    case 'metal':
      b.box(-0.025, 0, -0.025, 0.025, h + 0.03, 0.025, M);
      break;
    case 'glass': case 'concrete':
      b.box(-0.05, 0, -0.05, 0.05, h + 0.04, 0.05, kind === 'concrete' ? F('stone', [170, 166, 158]) : G);
      break;
    default:
      b.box(-0.05, 0, -0.05, 0.05, h + (kind === 'privacy' ? 0.05 : 0.08), 0.05, Wd);
      if (kind === 'picket') b.frustum(-0.05, -0.05, 0.05, 0.05, h + 0.08, h + 0.13, -0.01, -0.01, 0.01, 0.01, Wd, 'ny');
  }
  for (const d of dirs) {
    // segment from the post to the tile edge: along x for E/W, along z for N/S
    const alongX = DX[d] !== 0;
    const s0 = 0, s1 = 0.5 * (DX[d] + DY[d]); // signed
    const a = Math.min(s0, s1), e = Math.max(s0, s1);
    const bx = (u0: number, u1: number, y0: number, y1: number, t0: number, t1: number, f: FaceSpec) =>
      alongX ? b.box(u0, y0, t0, u1, y1, t1, f) : b.box(t0, y0, u0, t1, y1, u1, f);
    const pane = (y0: number, y1: number, f: FaceSpec) => {
      const P = (u: number, y: number, t: number): [number, number, number] => (alongX ? [u, y, t] : [t, y, u]);
      // both faces; winding picked so each quad faces outward from the fence line
      if (alongX) {
        b.quad(P(a, y0, 0.002), P(e, y0, 0.002), P(e, y1, 0.002), P(a, y1, 0.002), f);
        b.quad(P(e, y0, -0.002), P(a, y0, -0.002), P(a, y1, -0.002), P(e, y1, -0.002), f);
      } else {
        b.quad(P(e, y0, 0.002), P(a, y0, 0.002), P(a, y1, 0.002), P(e, y1, 0.002), f);
        b.quad(P(a, y0, -0.002), P(e, y0, -0.002), P(e, y1, -0.002), P(a, y1, -0.002), f);
      }
    };
    switch (kind) {
      case 'picket': {
        for (const y of [0.28, h - 0.22]) bx(a, e, y - 0.04, y + 0.04, 0.03, 0.06, Wd);
        for (let u = 0.07; u < 0.5; u += 0.12) {
          const c = s1 > 0 ? u : -u;
          // pickets in front of the rails, each with a pointed top
          bx(c - 0.04, c + 0.04, 0.05, h, 0.008, 0.03, W);
          if (alongX) b.frustum(c - 0.04, 0.008, c + 0.04, 0.03, h, h + 0.06, c - 0.004, 0.012, c + 0.004, 0.026, W, 'ny');
          else b.frustum(0.008, c - 0.04, 0.03, c + 0.04, h, h + 0.06, 0.012, c - 0.004, 0.026, c + 0.004, W, 'ny');
        }
        break;
      }
      case 'privacy': {
        for (const y of [0.3, h - 0.3]) bx(a, e, y - 0.04, y + 0.04, 0.03, 0.07, Wd);
        for (let u = 0.0; u < 0.5; u += 0.125) {
          const c0 = s1 > 0 ? u : -u - 0.125, c1 = c0 + 0.12;
          bx(c0, c1, 0.03, h, -0.015, 0.03, F('wood', shade(woodC, 0.94 + ((Math.round(u * 8) & 1) * 0.08))));
        }
        break;
      }
      case 'splitrail':
        for (const y of [0.45, 0.9]) bx(a, e, y - 0.05, y + 0.05, -0.04, 0.04, W);
        break;
      case 'chain': case 'chicken':
        bx(a, e, h - 0.03, h + 0.01, -0.02, 0.02, G);
        pane(0.03, h - 0.03, F('metal', galv, mesh(kind === 'chain' ? 4 : 3), false));
        break;
      case 'wire':
        for (const y of [0.35, 0.7, 1.05]) bx(a, e, y - 0.006, y + 0.006, -0.006, 0.006, F('metal', [120, 120, 118]));
        break;
      case 'metal':
        for (const y of [0.08, h - 0.04]) bx(a, e, y - 0.02, y + 0.02, -0.02, 0.02, M);
        for (let u = 0.1; u < 0.5; u += 0.11) {
          const c = s1 > 0 ? u : -u;
          bx(c - 0.01, c + 0.01, 0.08, h - 0.04, -0.01, 0.01, M);
        }
        break;
      case 'glass':
        bx(a, e, h - 0.03, h + 0.03, -0.03, 0.03, G);
        bx(a, e, 0.0, 0.08, -0.03, 0.03, G);
        {
          const P = (u: number, y: number): [number, number, number] => (alongX ? [u, y, 0] : [0, y, u]);
          b.glass(P(a, 0.08), P(e, 0.08), P(e, h - 0.03), P(a, h - 0.03));
        }
        break;
      case 'concrete':
        bx(a, e, h - 0.08, h, -0.06, 0.06, F('stone', [176, 172, 164]));
        bx(a, e, 0, 0.12, -0.06, 0.06, F('stone', [160, 156, 148]));
        for (let u = 0.12; u < 0.5; u += 0.18) {
          const c = s1 > 0 ? u : -u;
          bx(c - 0.035, c + 0.035, 0.12, h - 0.08, -0.035, 0.035, F('stone', [170, 166, 158]));
        }
        break;
    }
  }
  void STEEL;
}

/** Gate leaf in hinge space (hinge at x = 0, leaf along +x to `w`), for fence gates. */
export function buildGateLeaf(b: ModelBuilder, kind: FenceKind, pal: SpritePalette | null, w: number): void {
  const h = kind === 'chain' || kind === 'chicken' ? 1.95 : kind === 'privacy' ? 1.75 : 1.05;
  const woodC = fenceWood(pal, kind);
  const W = F('wood', woodC);
  if (kind === 'chain' || kind === 'chicken' || kind === 'metal') {
    const fr = F('chrome', [150, 156, 160]);
    b.box(0, 0.05, -0.02, 0.04, h, 0.02, fr);
    b.box(w - 0.04, 0.05, -0.02, w, h, 0.02, fr);
    b.box(0.04, h - 0.04, -0.02, w - 0.04, h, 0.02, fr);
    b.box(0.04, 0.05, -0.02, w - 0.04, 0.09, 0.02, fr);
    b.box(0.04, h * 0.5 - 0.02, -0.02, w - 0.04, h * 0.5 + 0.02, 0.02, fr);
    if (kind === 'metal') for (let x = 0.12; x < w - 0.05; x += 0.1) b.box(x - 0.01, 0.09, -0.01, x + 0.01, h - 0.04, 0.01, fr);
    else {
      const m = F('metal', [150, 156, 160], mesh(kind === 'chain' ? 4 : 3), false);
      b.quad([0.04, 0.09, 0.002], [w - 0.04, 0.09, 0.002], [w - 0.04, h - 0.04, 0.002], [0.04, h - 0.04, 0.002], m);
      b.quad([w - 0.04, 0.09, -0.002], [0.04, 0.09, -0.002], [0.04, h - 0.04, -0.002], [w - 0.04, h - 0.04, -0.002], m);
    }
    return;
  }
  // wooden gates: rails, a diagonal brace, boards / pickets
  for (const y of [0.25, h - 0.2]) b.box(0, y - 0.04, 0.02, w, y + 0.04, 0.05, F('wood', shade(woodC, 0.85)));
  const step = kind === 'privacy' ? 0.125 : 0.12;
  for (let x = 0; x + 0.08 <= w; x += step) b.box(x + 0.01, 0.05, -0.02, x + (kind === 'privacy' ? step - 0.005 : 0.09), h, 0.02, W);
}

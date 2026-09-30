import type { TileFrame } from './textureSource';

// Fixed-orientation "cards" for props that used to be camera-facing billboards (docs/
// CHARACTERS.md round 5). A billboard that turns to follow you is what reads as "2D sprites
// mixed with voxels"; the same art on a few crossed, world-fixed quads stays put as you walk
// round it, like the rest of the world:
//  - crossCards: 2-3 upright quads through the tile centre (fire, far furniture billboards)
//  - flatCard: the item sprite lying on the floor/furniture top (loose loot)
// Emitted into the chunk's merged geometry (alpha-tested world material), so they cost no
// draw calls and get the light map, shadows and outlines like walls.
//
//   ?props=billboard   the old camera-facing billboards (for comparison)

type V3 = [number, number, number];
interface QuadSink {
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, uv: readonly number[], f: TileFrame, ao?: readonly number[]): void;
}

function initialMode(): 'cards' | 'billboard' {
  const p = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('props') : null;
  if (p === 'cards' || p === 'billboard') return p;
  if (p) throw new Error(`?props=${p}: expected cards or billboard`);
  return 'cards';
}

/** fireLive: chars/fireView.ts draws animated fires, so the mesher leaves them out */
export const cardSettings = { mode: initialMode(), fireLive: false };

export function cardsOn(): boolean {
  return cardSettings.mode === 'cards';
}

/**
 * `count` upright quads crossing at the tile point (cx, cy) (tile coords), `height` metres
 * tall from `base` (three.js y), rotated by a per-tile `seed` angle. Both sides are emitted
 * (the world material is single-sided); from behind the art is mirrored, as it would be.
 */
export function crossCards(geo: (f: TileFrame) => QuadSink, f: TileFrame, cx: number, cy: number, base: number, height: number, seed: number, count = 2, lift = 0): void {
  const w = height * (f.w / Math.max(1, f.h));
  const a0 = ((seed & 255) / 256) * Math.PI;
  const g = geo(f);
  const y0 = base + lift, y1 = base + lift + height;
  for (let i = 0; i < count; i++) {
    const a = a0 + (i * Math.PI) / count;
    const ux = Math.cos(a) * w * 0.5, uz = Math.sin(a) * w * 0.5;
    const n: V3 = [-Math.sin(a), 0, Math.cos(a)];
    const A: V3 = [cx - ux, y0, cy - uz], B: V3 = [cx + ux, y0, cy + uz], C: V3 = [cx + ux, y1, cy + uz], D: V3 = [cx - ux, y1, cy - uz];
    g.quad(A, B, C, D, n, [0, 0, 1, 1], f);
    g.quad(B, A, D, C, [-n[0], 0, -n[2]], [0, 0, 1, 1], f);
  }
}

/**
 * An item lying on a surface at (cx, cy), `size` metres along its long side, turned by
 * `angle`, a hair above `top` so it doesn't z-fight the floor.
 */
export function flatCard(geo: (f: TileFrame) => QuadSink, f: TileFrame, cx: number, cy: number, top: number, size: number, angle: number): void {
  const aspect = f.w / Math.max(1, f.h);
  const hw = (aspect >= 1 ? size : size * aspect) * 0.5, hh = (aspect >= 1 ? size / aspect : size) * 0.5;
  const c = Math.cos(angle), s = Math.sin(angle);
  const P = (u: number, v: number): V3 => [cx + u * c - v * s, top + 0.012, cy + u * s + v * c];
  // image "up" points away along -v (north when angle = 0)
  geo(f).quad(P(-hw, hh), P(hw, hh), P(hw, -hh), P(-hw, -hh), [0, 1, 0], [0, 0, 1, 1], f);
}

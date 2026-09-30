import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { RGB } from './colors';
import { Img } from './pixelArt';
import type { TileFrame } from './textureSource';

// Pixel-art textures for the modelled trees and bushes (flora.ts), painted at 32 texels
// per metre from a 4-step ramp sampled out of the tree's UltiCa sprite (so species, season
// and autumn colours carry over). Pure painters (no DOM) + a private atlas page.
//
//   leaves   tileable leaf clusters: a dark gap colour, leaves 3 px long with a lit tip,
//            optional deliberate dots (flowers, blossom, fruit, berries)
//   needles  tileable drooping needle strokes (conifers)
//   fringe   a ragged leaf-mass cutout: crossed cards break a lump's polygon outline
//   twigs    a cutout of forking twigs (bare/dead crowns)
//   bark     tileable: furrowed, birch (white + dark lenticels), plated (pine), smooth
//   impostor far LOD: the tree's own layout projected and painted flat (flora.ts), so the
//            distant card has the near model's silhouette and colours

/** Dark gap, mid, light, highlight (sRGB 0-255). */
export type Ramp4 = [RGB, RGB, RGB, RGB];

const T = 32;
const wrap = (v: number) => ((v % T) + T) % T;

/** Flower/fruit/berry dots: `size` 1 = single pixels, 2 = 2x2 fruit, 3 = 5-px florets. */
export interface LeafDots { cols: RGB[]; n: number; size: 1 | 2 | 3 }

/**
 * Tileable foliage in four clean steps: overlapping scalloped leaf clusters (~7 px, like
 * scales) painted back to front, each lit on its upper-left edge (r[3]), a light body (r[2]),
 * a mid inner leaf mark (r[1]) and a dark lower-right rim (r[0]) that also fills the gaps.
 * Deliberate, readable shapes at 1:1 (v3 was 3-px noise that turned to mush), and a clean
 * two-tone mottling at distance.
 */
export function paintLeaves(r: Ramp4, seed: number, dots?: LeafDots): Img {
  const img = new Img(T, T);
  const rng = new Rng(seed);
  img.fill(r[0]);
  const setW = (x: number, y: number, c: RGB) => img.set(wrap(x), wrap(y), c);
  const clusters: [number, number, number][] = [];
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 4; col++) {
      const cx = col * 8 + (row % 2) * 4 + rng.int(-1, 1), cy = row * 6.4 + rng.int(-1, 1);
      clusters.push([cx, cy, 3.6 + rng.next() * 1.2]);
    }
  clusters.sort((a, b) => a[1] - b[1]);
  for (const [cx, cy, rad] of clusters) {
    // scalloped outline: three overlapping lobes
    const lobes = [[0, 0, rad], [-rad * 0.5, rad * 0.25, rad * 0.7], [rad * 0.5, rad * 0.25, rad * 0.7]];
    const inside = (x: number, y: number) => lobes.some(([lx, ly, lr]) => (x - cx - lx) ** 2 + (y - cy - ly) ** 2 <= lr * lr);
    for (let y = Math.floor(cy - rad - 1); y <= cy + rad + 1; y++)
      for (let x = Math.floor(cx - rad * 1.3); x <= cx + rad * 1.3; x++) {
        if (!inside(x, y)) continue;
        let c = r[2];
        if (!inside(x + 1, y + 1)) c = r[0];
        else if (!inside(x - 1, y - 1) || !inside(x, y - 1)) c = r[3];
        setW(x, y, c);
      }
    // one mid-tone leaf mark per cluster (a vein / the next leaf behind)
    setW(cx, cy + 1, r[1]); setW(cx + 1, cy + 2, r[1]);
  }
  if (dots) {
    for (let k = 0; k < dots.n; k++) {
      const x = rng.int(0, T - 1), y = rng.int(0, T - 1);
      const c = dots.cols[k % dots.cols.length];
      const hi: RGB = [Math.min(255, c[0] + 60), Math.min(255, c[1] + 60), Math.min(255, c[2] + 60)];
      const lo: RGB = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6];
      if (dots.size === 1) setW(x, y, c);
      else if (dots.size === 2) {
        // a fruit: 2x2 with one highlight pixel and a darker underside
        setW(x, y, hi); setW(x + 1, y, c); setW(x, y + 1, c); setW(x + 1, y + 1, lo);
      } else {
        // a floret cluster (hydrangea head, rose): a 5-px rounded blob, lit top-left
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > 3) continue;
            setW(x + dx, y + dy, dx + dy <= -2 ? hi : dx + dy >= 2 ? lo : c);
          }
      }
    }
  }
  return img;
}

export function paintNeedles(r: Ramp4, seed: number): Img {
  const img = new Img(T, T);
  const rng = new Rng(seed);
  img.fill(r[0]);
  for (let k = 0; k < 70; k++) {
    let x = rng.int(0, T - 1), y = rng.int(0, T - 1);
    const dir = rng.next() < 0.5 ? -1 : 1;
    const len = rng.int(3, 6);
    const c = rng.next() < 0.4 ? r[2] : r[1];
    for (let i = 0; i < len; i++) {
      img.set(wrap(x), wrap(y), i === 0 && rng.next() < 0.5 ? r[3] : c);
      x += dir;
      if (i % 2 === 1) y += 1; // needles droop
    }
  }
  return img;
}

/** Ragged leaf-mass cutout (transparent outside); interior uses the leaf pattern. */
export function paintFringe(r: Ramp4, seed: number, dots?: LeafDots): Img {
  const leaves = paintLeaves(r, seed, dots);
  const img = new Img(T, T);
  const rng = new Rng(seed ^ 0x51f);
  const blobs: [number, number, number][] = [[15.5, 15.5, 9]];
  for (let k = 0; k < 9; k++) {
    const a = rng.next() * Math.PI * 2, d = 6 + rng.next() * 5;
    blobs.push([15.5 + Math.cos(a) * d, 15.5 + Math.sin(a) * d, 2.5 + rng.next() * 2.5]);
  }
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      if (!blobs.some(([bx, by, br]) => (x - bx) ** 2 + (y - by) ** 2 <= br * br)) continue;
      const i = (y * T + x) * 4;
      img.set(x, y, [leaves.data[i], leaves.data[i + 1], leaves.data[i + 2]]);
    }
  // (single leaves poking out were tried: magnified up close they hung in the air as
  // detached squares; the blob union alone gives the ragged edge)
  return img;
}

/** Forking twigs (bare crowns): cutout, bark-coloured. */
export function paintTwigs(bark: RGB, seed: number): Img {
  const img = new Img(T, T);
  const rng = new Rng(seed);
  const dark: RGB = [bark[0] * 0.6, bark[1] * 0.6, bark[2] * 0.6];
  const grow = (x: number, y: number, a: number, len: number, depth: number) => {
    for (let i = 0; i < len; i++) {
      x += Math.cos(a);
      y -= Math.sin(a);
      img.set(Math.round(x), Math.round(y), i < len / 2 ? dark : bark);
    }
    if (depth <= 0) return;
    grow(x, y, a + 0.5 + rng.next() * 0.3, len * 0.65, depth - 1);
    grow(x, y, a - 0.5 - rng.next() * 0.3, len * 0.65, depth - 1);
  };
  for (let k = 0; k < 3; k++) grow(15.5 + (k - 1) * 5, 31, Math.PI / 2 + (rng.next() - 0.5) * 0.6, 9, 3);
  return img;
}

export type BarkKind = 'furrow' | 'birch' | 'plates' | 'smooth';

export function paintBark(kind: BarkKind, base: RGB, seed: number): Img {
  const img = new Img(T, T);
  const rng = new Rng(seed);
  const k = (m: number): RGB => [Math.min(255, base[0] * m), Math.min(255, base[1] * m), Math.min(255, base[2] * m)];
  if (kind === 'birch') {
    img.fill([214, 208, 192]);
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (rng.next() < 0.12) img.set(x, y, [192, 186, 172]);
    // dark horizontal lenticels and a few black scars
    for (let n = 0; n < 16; n++) {
      const x = rng.int(0, T - 1), y = rng.int(0, T - 1), w = rng.int(2, 6);
      for (let i = 0; i < w; i++) img.set(wrap(x + i), y, [40, 36, 34]);
    }
    for (let n = 0; n < 3; n++) {
      const x = rng.int(0, T - 1), y = rng.int(0, T - 1);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) if (rng.next() < 0.7) img.set(wrap(x + i), wrap(y + j), [30, 28, 26]);
    }
    return img;
  }
  img.fill(k(0.9));
  if (kind === 'furrow') {
    // wavy vertical furrows (dark) between lit ridges
    for (let c = 0; c < 6; c++) {
      let x = c * (T / 6) + rng.int(0, 3);
      for (let y = 0; y < T; y++) {
        img.set(wrap(x), y, k(0.5));
        img.set(wrap(x + 1), y, k(0.68));
        img.set(wrap(x + 3), y, k(1.12));
        if (rng.next() < 0.25) x += rng.next() < 0.5 ? -1 : 1;
      }
    }
  } else if (kind === 'plates') {
    // irregular plates with dark cracks (pine)
    for (let y = 0; y < T; y += rng.int(4, 6)) for (let x = 0; x < T; x++) img.set(x, y, k(0.5));
    for (let n = 0; n < 22; n++) {
      const x = rng.int(0, T - 1);
      let y = rng.int(0, T - 1);
      for (let i = 0; i < rng.int(3, 6); i++) img.set(x, wrap(y++), k(0.55));
    }
    for (let n = 0; n < 40; n++) img.set(rng.int(0, T - 1), rng.int(0, T - 1), k(1.15));
  } else {
    for (let n = 0; n < 90; n++) img.set(rng.int(0, T - 1), rng.int(0, T - 1), rng.next() < 0.5 ? k(0.78) : k(1.1));
    for (let n = 0; n < 4; n++) {
      const x = rng.int(0, T - 1), y = rng.int(0, T - 1);
      for (let i = 0; i < 3; i++) img.set(wrap(x + i), y, k(0.6));
    }
  }
  return img;
}

export function paintSnow(seed: number): Img {
  const img = new Img(T, T);
  const rng = new Rng(seed);
  img.fill([226, 232, 240]);
  for (let n = 0; n < 60; n++) img.set(rng.int(0, T - 1), rng.int(0, T - 1), rng.next() < 0.5 ? [200, 210, 226] : [246, 248, 252]);
  return img;
}

// --- atlas -------------------------------------------------------------------------------

const PAGE = 2048;
/** Wrapped (tiling) or transparent (cutout) border around each frame: mips up to level 2
 *  never read a neighbour. */
const PAD = 4;

/**
 * A texture page of its own for flora (the shared procedural page is small and full of
 * surfaces). Frames are memoised by key; the page re-uploads after new paints.
 */
export class FloraAtlas {
  readonly texture: THREE.DataTexture;
  private px = new Uint8Array(PAGE * PAGE * 4);
  private frames = new Map<string, TileFrame>();
  private sx = 0;
  private sy = 0;
  private sh = 0;

  constructor() {
    this.texture = new THREE.DataTexture(this.px, PAGE, PAGE, THREE.RGBAFormat);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;
  }

  get used(): number {
    return (this.sy + this.sh) / PAGE;
  }

  frame(key: string, tile: boolean, paint: () => Img): TileFrame {
    let f = this.frames.get(key);
    if (f) return f;
    const img = paint();
    const W = img.w + PAD * 2, H = img.h + PAD * 2;
    if (this.sx + W > PAGE) {
      this.sx = 0;
      this.sy += this.sh;
      this.sh = 0;
    }
    if (this.sy + H > PAGE) throw new Error('FloraAtlas: page full (too many tree palettes?)');
    const x0 = this.sx, y0 = this.sy;
    this.sx += W;
    this.sh = Math.max(this.sh, H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let ix = x - PAD, iy = y - PAD;
        if (tile) { ix = ((ix % img.w) + img.w) % img.w; iy = ((iy % img.h) + img.h) % img.h; }
        else if (ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) continue;
        const s = (iy * img.w + ix) * 4;
        // image rows are top-down, the page bottom-up
        const d = ((y0 + H - 1 - y) * PAGE + x0 + x) * 4;
        this.px[d] = img.data[s]; this.px[d + 1] = img.data[s + 1]; this.px[d + 2] = img.data[s + 2]; this.px[d + 3] = img.data[s + 3];
      }
    this.texture.needsUpdate = true;
    f = {
      texture: this.texture,
      uv: [(x0 + PAD) / PAGE, (y0 + PAD) / PAGE, (x0 + PAD + img.w) / PAGE, (y0 + PAD + img.h) / PAGE],
      w: img.w, h: img.h,
    };
    this.frames.set(key, f);
    return f;
  }
}

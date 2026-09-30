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

export function paintLeaves(r: Ramp4, seed: number, dots?: { cols: RGB[]; n: number; size: 1 | 2 }): Img {
  const img = new Img(T, T);
  const rng = new Rng(seed);
  img.fill(r[0]);
  const setW = (x: number, y: number, c: RGB) => img.set(wrap(x), wrap(y), c);
  // leaf clusters: 3-5 leaves around a centre, each a 3-px blade with a lit tip, so the
  // pattern reads as leaves at 1:1 and as a mottled mass further out
  for (let k = 0; k < 64; k++) {
    const cx = rng.int(0, T - 1), cy = rng.int(0, T - 1);
    const n = rng.int(3, 5);
    const light = rng.next() < 0.5;
    for (let l = 0; l < n; l++) {
      const a = (l / n) * Math.PI * 2 + rng.next();
      const dx = Math.round(Math.cos(a) * 1.6), dy = Math.round(Math.sin(a) * 1.6);
      const x = cx + dx, y = cy + dy;
      const base = light ? r[2] : r[1];
      setW(x, y, base);
      setW(x + Math.sign(dx || 1), y + Math.sign(dy), base);
      setW(x + 2 * Math.sign(dx || 1), y + 2 * Math.sign(dy), rng.next() < 0.5 ? r[1] : r[0]);
      // light from above: the upper pixel of a leaf catches it
      setW(x, y - 1, light && rng.next() < 0.6 ? r[3] : base);
    }
  }
  if (dots) {
    for (let k = 0; k < dots.n; k++) {
      const x = rng.int(0, T - 1), y = rng.int(0, T - 1);
      const c = dots.cols[k % dots.cols.length];
      const hi: RGB = [Math.min(255, c[0] + 60), Math.min(255, c[1] + 60), Math.min(255, c[2] + 60)];
      if (dots.size === 1) {
        setW(x, y, c);
      } else {
        // a flower / fruit: 2x2 with one highlight pixel and a darker underside
        setW(x, y, hi); setW(x + 1, y, c); setW(x, y + 1, c);
        setW(x + 1, y + 1, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6]);
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
export function paintFringe(r: Ramp4, seed: number, dots?: { cols: RGB[]; n: number; size: 1 | 2 }): Img {
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

/** Hanging strands of leaves (willow): cutout, strands of varying length from the top. */
export function paintDrape(r: Ramp4, seed: number): Img {
  const img = new Img(T, T);
  const rng = new Rng(seed);
  for (let x = 0; x < T; x += rng.int(1, 3)) {
    const len = rng.int(14, T - 1);
    for (let y = 0; y < len; y++) {
      const c = y % 3 === 0 ? r[2] : rng.next() < 0.3 ? r[0] : r[1];
      img.set(x + (y > len * 0.6 && rng.next() < 0.3 ? 1 : 0), y, c);
    }
    img.set(x, len, r[3]);
  }
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

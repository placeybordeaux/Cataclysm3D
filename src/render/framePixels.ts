import * as THREE from 'three';
import type { TileFrame } from './textureSource';

// CPU access to a TileFrame's pixels (voxel extrusion, tree analysis, grass colours).
// Atlas pages are images (flipY textures, uv v0 = bottom); procedural pages are
// DataTextures stored bottom-up. Returns RGBA rows top-down, memoised per frame rect.

export interface Pixels {
  w: number;
  h: number;
  /** RGBA, row 0 = top of the sprite */
  data: Uint8ClampedArray;
}

const cache = new Map<string, Pixels | null>();
let canvas: HTMLCanvasElement | null = null;

export function frameKey(f: TileFrame): string {
  return `${f.texture.id}:${f.uv.join(',')}`;
}

export function framePixels(f: TileFrame): Pixels | null {
  const key = frameKey(f);
  if (cache.has(key)) return cache.get(key)!;
  let out: Pixels | null = null;
  const img = f.texture.image as { width: number; height: number; data?: Uint8Array } | undefined;
  if (img && img.width && img.height) {
    const W = img.width, H = img.height;
    const x0 = Math.round(f.uv[0] * W), x1 = Math.round(f.uv[2] * W);
    const w = x1 - x0;
    if ((f.texture as THREE.DataTexture).isDataTexture && img.data) {
      // bottom-up rows, v0 = bottom
      const y0 = Math.round(f.uv[1] * H), y1 = Math.round(f.uv[3] * H);
      const h = y1 - y0;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r++) {
        const src = ((y1 - 1 - r) * W + x0) * 4;
        data.set(img.data.subarray(src, src + w * 4), r * w * 4);
      }
      out = { w, h, data };
    } else if (typeof document !== 'undefined') {
      const top = Math.round((1 - f.uv[3]) * H), bot = Math.round((1 - f.uv[1]) * H);
      const h = bot - top;
      canvas ??= document.createElement('canvas');
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img as unknown as CanvasImageSource, x0, top, w, h, 0, 0, w, h);
      out = { w, h, data: ctx.getImageData(0, 0, w, h).data };
    }
  }
  cache.set(key, out);
  return out;
}

const avgCache = new Map<string, [number, number, number]>();
/** Average opaque colour, linear RGB (0..1). Grey when unreadable. */
export function frameAverage(f: TileFrame): [number, number, number] {
  const key = frameKey(f);
  let a = avgCache.get(key);
  if (a) return a;
  const p = framePixels(f);
  let r = 0, g = 0, b = 0, n = 0;
  if (p) for (let i = 0; i < p.data.length; i += 4) {
    if (p.data[i + 3] < 128) continue;
    r += p.data[i]; g += p.data[i + 1]; b += p.data[i + 2]; n++;
  }
  const c = new THREE.Color();
  if (n) c.setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
  else c.setRGB(0.3, 0.3, 0.3);
  a = [c.r, c.g, c.b];
  avgCache.set(key, a);
  return a;
}

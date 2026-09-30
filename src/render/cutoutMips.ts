import * as THREE from 'three';

// Stable cutout mips for alpha-tested pixel-art cards (grass blades, leaf clumps).
//
// Without mips, a 1-texel grass blade or a leaf-clump edge a few metres away is smaller than
// a screen pixel: whether a pixel lands on it changes with every sub-pixel camera move, so
// lawns and crowns sparkled while walking (the flicker heat maps in docs/READABILITY.md).
// Hardware mips average alpha, which the alpha test then thins into dotted holes. These
// mips are built for the test instead: each 2x2 block becomes one opaque texel if at least
// `minCover` of its four are opaque (colour = the average of those), else fully transparent.
// Sampled with NearestMipmapNearest the far cutout is a coarser, fixed pixel pattern on the
// card: still hard-edged pixel art, but it no longer crawls.

/**
 * Replace a square power-of-two RGBA8 DataTexture's sampling with cutout mips.
 * `minCover` 1 keeps thin features (blades) present at distance, 2 keeps blob silhouettes
 * (leaf clumps) about the same size.
 */
export function applyCutoutMips(t: THREE.DataTexture, minCover: 1 | 2 | 3 = 2): THREE.DataTexture {
  const img = t.image as { data: Uint8Array; width: number; height: number };
  const { width: w0, height: h0 } = img;
  if (w0 !== h0 || (w0 & (w0 - 1)) !== 0) throw new Error(`cutout mips need a square power-of-two texture, got ${w0}x${h0}`);
  const levels = buildCutoutMips(img.data, w0, minCover);
  t.mipmaps = levels.map((data, i) => ({ data, width: w0 >> i, height: w0 >> i })) as unknown as THREE.DataTexture['mipmaps'];
  t.generateMipmaps = false;
  t.minFilter = THREE.NearestMipmapNearestFilter;
  t.needsUpdate = true;
  registerCutout(t);
  return t;
}

/** Level 0 (the input) down to 1x1. Pure, for tests. */
export function buildCutoutMips(data: Uint8Array, size: number, minCover: number): Uint8Array[] {
  const out = [data];
  let prev = data, s = size;
  while (s > 1) {
    const n = s >> 1;
    const d = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let r = 0, g = 0, b = 0, k = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const i = ((y * 2 + dy) * s + x * 2 + dx) * 4;
            if (prev[i + 3] < 128) continue;
            r += prev[i]; g += prev[i + 1]; b += prev[i + 2]; k++;
          }
        const o = (y * n + x) * 4;
        if (k >= minCover) {
          d[o] = Math.round(r / k); d[o + 1] = Math.round(g / k); d[o + 2] = Math.round(b / k); d[o + 3] = 255;
        }
      }
    out.push(d);
    prev = d;
    s = n;
  }
  return out;
}

const registered: THREE.Texture[] = [];
/** Textures using cutout mips (so `setCutoutMips` can switch them for comparison). */
export function registerCutout(t: THREE.Texture): void {
  registered.push(t);
}
/** A/B switch (cdda.cutoutMips(false) = the old unmipped sampling). */
export function setCutoutMips(on: boolean): void {
  for (const t of registered) {
    t.minFilter = on ? THREE.NearestMipmapNearestFilter : THREE.NearestFilter;
    t.needsUpdate = true;
  }
}

// Colour grading + palette for the post pass. Pure (no three.js) so it is unit-testable;
// post.ts uploads the resulting tables as 3D LUT textures.
//
// Two grading modes share the same "look" function:
//   palette: grade, then snap to the nearest colour of a fixed ~90-colour palette
//            (OKLab distance). Ordered dithering before the lookup turns gradients into
//            classic pixel-art dither patterns.
//   smooth:  grade only, then per-channel posterize in the shader (softer, more colours).

export type RGBf = [number, number, number];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function toOklab(c: RGBf): RGBf {
  const r = srgbToLinear(c[0]), g = srgbToLinear(c[1]), b = srgbToLinear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function fromOklab(c: RGBf): RGBf {
  const l = (c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2]) ** 3;
  const m = (c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2]) ** 3;
  const s = (c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2]) ** 3;
  const lin: RGBf = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (v: number) => {
    v = Math.min(1, Math.max(0, v));
    return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
}

const hex = (h: number): RGBf => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/** Hue ramps, dark -> light, with the hue shift baked into the endpoints (cool darks,
 *  warm lights) the way pixel artists build ramps. */
const RAMPS: [number, number][] = [
  [0x07080c, 0xe8e4d8], // neutral
  [0x120c0a, 0xd8c4a8], // warm stone
  [0x160c06, 0xc89868], // wood
  [0x180608, 0xe88870], // rust / blood
  [0x0a0e06, 0xc0c888], // olive
  [0x06100c, 0x98c098], // moss
  [0x040e14, 0x90c8c8], // teal
  [0x060818, 0xa8c0e0], // steel blue
  [0x100818, 0xb4a4c8], // dusk purple
  [0x0a1428, 0xd0dcea], // pale sky
  [0x140e02, 0xf8e0a0], // ochre / lamplight
];
const ACCENTS = [0xff9a3c, 0xffd060, 0xffffff, 0xc82828, 0x4a90e8, 0x60d070, 0x000000, 0xff5020];
export const RAMP_STEPS = 9;

export function buildPalette(): RGBf[] {
  const out: RGBf[] = [];
  for (const [a, b] of RAMPS) {
    const la = toOklab(hex(a)), lb = toOklab(hex(b));
    for (let i = 0; i < RAMP_STEPS; i++) {
      // More steps in the darks: night scenes live there.
      const t = (i / (RAMP_STEPS - 1)) ** 1.25;
      out.push(fromOklab([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t]));
    }
  }
  for (const h of ACCENTS) out.push(hex(h));
  return out;
}

/** The "look": slight desaturation, cool shadows / warm highlights, gentle S-curve. sRGB in/out. */
export function grade(c: RGBf, saturation = 0.8): RGBf {
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  let r = L + (c[0] - L) * saturation, g = L + (c[1] - L) * saturation, b = L + (c[2] - L) * saturation;
  const sh = (1 - L) ** 2, hi = L * L;
  r *= 1 + sh * -0.06 + hi * 0.03;
  g *= 1 + sh * -0.01 + hi * 0.0;
  b *= 1 + sh * 0.1 + hi * -0.03;
  const curve = (v: number) => {
    v = Math.min(1, Math.max(0, v));
    const s = v * v * (3 - 2 * v);
    return v + (s - v) * 0.25;
  };
  return [curve(r), curve(g), curve(b)];
}

export function nearest(palLab: RGBf[], pal: RGBf[], c: RGBf): RGBf {
  const q = toOklab(c);
  let best = 0, bd = Infinity;
  for (let i = 0; i < palLab.length; i++) {
    const p = palLab[i];
    // Chroma weighted up: with ~100 colours, lightness steps are coarse and would otherwise
    // always win, turning every desaturated blue/green into neutral grey (dithering then
    // mixes in neighbouring hues, e.g. a pink horizon). Ordered dither restores lightness.
    const dl = q[0] - p[0], da = (q[1] - p[1]) * 2.2, db = (q[2] - p[2]) * 2.2;
    const d = dl * dl + da * da + db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return pal[best];
}

/** size^3 RGBA8 LUT indexed [b][g][r] (WebGL 3D texture layout). */
export function buildLut(size: number, mode: 'palette' | 'smooth', saturation = 0.8): Uint8Array {
  const out = new Uint8Array(size * size * size * 4);
  const pal = buildPalette();
  const palLab = pal.map(toOklab);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        let c = grade([r / (size - 1), g / (size - 1), b / (size - 1)], saturation);
        if (mode === 'palette') c = nearest(palLab, pal, c);
        out[i++] = Math.round(c[0] * 255);
        out[i++] = Math.round(c[1] * 255);
        out[i++] = Math.round(c[2] * 255);
        out[i++] = 255;
      }
  return out;
}

/** Tallest low-res image the "auto" render resolution picks (see lowResSize). */
export const AUTO_MAX_H = 720;

/**
 * Low-res render size for a drawing buffer of w x h device pixels: the largest integer
 * upscale factor that keeps the low-res height >= ~targetHeight, so every low-res pixel
 * becomes an exact scale x scale block. `margin` extra pixels on each side allow sub-pixel
 * camera compensation without exposing edges.
 */
export function lowResSize(w: number, h: number, targetHeight: number, margin = 1): { scale: number; w: number; h: number } {
  // targetHeight <= 0 is "auto": the smallest integer upscale that keeps the image at most
  // AUTO_MAX_H tall, i.e. 540 px at 1080p, ~650 px at 1300p, 720 px at 1440p/2160p. Big
  // screens stop being 3.6x-chunky while every low-res pixel stays an exact square block.
  const scale = targetHeight <= 0 ? Math.max(1, Math.ceil(h / AUTO_MAX_H)) : Math.max(1, Math.round(h / targetHeight));
  return { scale, w: Math.ceil(w / scale) + margin * 2, h: Math.ceil(h / scale) + margin * 2 };
}

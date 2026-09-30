import { Img } from '../pixelArt';
import type { RGB } from '../colors';
import { hash2 } from '../ground';

// Pixel textures for modelled furniture: one frame per face, painted at the face's size in
// texels (TPM per metre, the project's texel density). A face = a material pattern (wood
// grain along the long axis, fabric weave, brushed metal...) + a 1px bevel (light top edge,
// dark bottom edge, so parts separate at low res like hand-drawn pixel art) + an optional
// decal (drawer lines, handles, book spines, burners...) drawn in the face's own texels.
// Pure (no DOM / three.js): unit tested and deterministic, so frames can be memoised.

export const TPM = 32;

export type MatKind =
  | 'wood' | 'paint' | 'fabric' | 'leather' | 'metal' | 'enamel' | 'plastic' | 'stone' | 'felt'
  | 'cardboard' | 'rubber' | 'chrome' | 'sheet' | 'mattress' | 'screen' | 'foliage' | 'dark' | 'brick' | 'paper' | 'soil' | 'glow';

export interface Mat {
  kind: MatKind;
  /** base colour, sRGB 0..255 */
  c: RGB;
}

/** A decal painted over a face's material; `k` is its identity for the frame cache. */
export interface Decal {
  k: string;
  draw(img: Img, r: Ramp4, w: number, h: number): void;
}

export type Ramp4 = [RGB, RGB, RGB, RGB];

const clamp = (v: number) => Math.max(0, Math.min(255, v));
export const scale = (c: RGB, k: number): RGB => [clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k)];
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Four values around the base: shadow, dark, base, light. Contrast per material. */
export function ramp(m: Mat): Ramp4 {
  const s = SPREAD[m.kind] ?? 1;
  const k = (f: number) => scale(m.c, 1 + (f - 1) * s);
  return [k(0.6), k(0.82), k(1), k(1.16)];
}
const SPREAD: Partial<Record<MatKind, number>> = { paint: 0.6, plastic: 0.55, enamel: 0.45, fabric: 0.7, felt: 0.5, sheet: 0.45, metal: 0.8, chrome: 1.3, screen: 1, glow: 0.3 };

const matKey = (m: Mat) => `${m.kind}:${m.c.map((v) => Math.round(v)).join(',')}`;

export interface FaceSpec {
  mat: Mat;
  decal?: Decal;
  /** light top / dark bottom 1px rim (default true) */
  bevel?: boolean;
}

export function faceKey(s: FaceSpec, w: number, h: number): string {
  return `${matKey(s.mat)}|${w}x${h}|${s.bevel === false ? 0 : 1}|${s.decal?.k ?? ''}`;
}

/** Paint one face: `w` x `h` texels, row 0 = the face's top edge. */
export function paintFace(s: FaceSpec, w: number, h: number): Img {
  const img = new Img(w, h);
  const r = ramp(s.mat);
  const seed = hash2(w * 31 + h, s.mat.c[0] * 7 + s.mat.c[1] * 3 + s.mat.c[2], KIND_SEED[s.mat.kind] ?? 1);
  pattern(img, s.mat.kind, r, w, h, seed);
  if (s.bevel !== false && w >= 3 && h >= 3) {
    for (let x = 0; x < w; x++) {
      img.set(x, 0, mix(get(img, x, 0), r[3], 0.6));
      img.set(x, h - 1, mix(get(img, x, h - 1), r[0], 0.6));
    }
    for (let y = 1; y < h - 1; y++) {
      img.set(0, y, mix(get(img, 0, y), r[3], 0.25));
      img.set(w - 1, y, mix(get(img, w - 1, y), r[0], 0.35));
    }
  }
  s.decal?.draw(img, r, w, h);
  return img;
}
const KIND_SEED: Partial<Record<MatKind, number>> = { wood: 3, fabric: 5, metal: 7, stone: 11, leather: 13, cardboard: 17 };

export function get(img: Img, x: number, y: number): RGB {
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function pattern(img: Img, kind: MatKind, r: Ramp4, w: number, h: number, seed: number): void {
  const H = (x: number, y: number, s = 0) => hash2(x, y, seed + s);
  switch (kind) {
    case 'wood': {
      // grain runs along the face's long axis; each "board line" has its own tone
      const alongX = w >= h;
      const L = alongX ? h : w;
      for (let a = 0; a < L; a++) {
        const tone = H(a, 0, 1) % 5;
        for (let b = 0; b < (alongX ? w : h); b++) {
          const [x, y] = alongX ? [b, a] : [a, b];
          let c = tone === 0 ? r[1] : tone === 4 ? mix(r[2], r[3], 0.5) : r[2];
          const streak = H(Math.floor(b / 5), a, 2) % 9;
          if (streak === 0) c = r[1];
          if (streak === 1 && H(b, a, 3) % 3 === 0) c = mix(r[1], r[0], 0.5);
          img.set(x, y, c);
        }
      }
      // a knot now and then on bigger faces
      if (w * h > 200 && H(1, 1, 4) % 3 === 0) {
        const kx = 2 + (H(2, 2, 5) % Math.max(1, w - 4)), ky = 2 + (H(3, 3, 6) % Math.max(1, h - 4));
        img.set(kx, ky, r[0]); img.set(kx + 1, ky, r[1]); img.set(kx, ky + 1, r[1]);
      }
      break;
    }
    case 'fabric': case 'felt': case 'sheet': {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const weave = kind === 'fabric' ? ((x + y) & 1 ? r[2] : mix(r[2], r[1], 0.45)) : r[2];
        const fleck = H(x, y) % 23;
        img.set(x, y, fleck === 0 ? r[3] : fleck === 1 ? r[1] : weave);
      }
      break;
    }
    case 'mattress': {
      // quilted: diamond seams
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const seam = (x + y) % 8 === 0 || (x - y + 800) % 8 === 0;
        img.set(x, y, seam ? r[1] : H(x, y) % 17 === 0 ? r[3] : r[2]);
      }
      break;
    }
    case 'leather': {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const n = H(x >> 1, y >> 1) % 11;
        img.set(x, y, n === 0 ? r[1] : n === 1 ? r[3] : r[2]);
      }
      break;
    }
    case 'metal': {
      // brushed vertical streaks, sparse
      for (let x = 0; x < w; x++) {
        const col = H(x, 0, 7) % 6;
        for (let y = 0; y < h; y++) img.set(x, y, col === 0 ? r[1] : col === 1 ? mix(r[2], r[3], 0.5) : r[2]);
      }
      for (let i = 0; i < (w * h) / 60; i++) img.set(H(i, 1) % w, H(i, 2) % h, r[1]);
      break;
    }
    case 'chrome': {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = (x + y * 2) % 9;
        img.set(x, y, d < 2 ? r[3] : d < 5 ? r[2] : r[1]);
      }
      break;
    }
    case 'enamel': case 'plastic': case 'paint': case 'rubber': case 'glow': {
      img.fill(r[2]);
      if (kind === 'enamel') {
        // a soft diagonal sheen
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + y) % 23 < 2 && (x + y) % 46 < 23) img.set(x, y, r[3]);
      }
      for (let i = 0; i < (w * h) / 45; i++) img.set(H(i, 3) % w, H(i, 4) % h, kind === 'rubber' ? r[1] : mix(r[2], r[1], 0.5));
      break;
    }
    case 'stone': case 'brick': case 'soil': {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const n = H(x, y) % 10;
        img.set(x, y, n < 2 ? r[1] : n === 9 ? r[3] : n === 8 ? r[0] : r[2]);
      }
      if (kind === 'brick') for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const row = Math.floor(y / 3), off = row & 1 ? 4 : 0;
        if (y % 3 === 2 || (x + off) % 8 === 7) img.set(x, y, r[3]);
      }
      break;
    }
    case 'cardboard': {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set(x, y, H(x, y) % 13 === 0 ? r[1] : r[2]);
      break;
    }
    case 'paper': {
      img.fill(r[3]);
      for (let y = 2; y < h - 1; y += 2) for (let x = 1; x < w - 1; x++) if (H(x >> 2, y) % 3) img.set(x, y, r[1]);
      break;
    }
    case 'screen': {
      img.fill(r[0]);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - y + 200) % 13 < 2) img.set(x, y, r[1]);
      break;
    }
    case 'foliage': {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const n = H(x >> 1, y >> 1) % 7;
        img.set(x, y, n === 0 ? r[0] : n < 3 ? r[1] : n === 6 ? r[3] : r[2]);
      }
      break;
    }
    case 'dark': {
      img.fill(r[1]);
      break;
    }
  }
}

// --- decals ---------------------------------------------------------------------------------
// Decals take their own colours (handles, knobs) and draw relative to the face size.

const line = (img: Img, x0: number, y0: number, x1: number, y1: number, c: RGB) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) img.set(x, y, c);
};

/** Drawer fronts: `rows` x `cols` drawers with a dark gap and a handle each. */
export function drawers(rows: number, cols: number, handle: RGB, knob = false): Decal {
  return {
    k: `drw${rows}x${cols}${knob ? 'k' : ''}:${handle.map(Math.round).join(',')}`,
    draw(img, r, w, h) {
      for (let i = 1; i < rows; i++) line(img, 1, Math.round((h * i) / rows), w - 2, Math.round((h * i) / rows), r[0]);
      for (let j = 1; j < cols; j++) line(img, Math.round((w * j) / cols), 1, Math.round((w * j) / cols), h - 2, r[0]);
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) {
          const cy = Math.round((h * (i + 0.5)) / rows), cx = Math.round((w * (j + 0.5)) / cols);
          if (knob) { img.set(cx, cy, handle); img.set(cx, cy + 1, scale(handle, 0.6)); }
          else {
            const hw = Math.max(1, Math.round(w / cols / 6));
            line(img, cx - hw, cy, cx + hw - 1, cy, handle);
            line(img, cx - hw, cy + 1, cx + hw - 1, cy + 1, scale(handle, 0.55));
          }
        }
    },
  };
}

/** Cabinet doors: `n` side-by-side doors with inset panel lines and handles near the split. */
export function doors(n: number, handle: RGB, panel = true, vHandle = true): Decal {
  return {
    k: `drs${n}${panel ? 'p' : ''}${vHandle ? 'v' : ''}:${handle.map(Math.round).join(',')}`,
    draw(img, r, w, h) {
      for (let j = 1; j < n; j++) line(img, Math.round((w * j) / n), 1, Math.round((w * j) / n), h - 2, r[0]);
      for (let j = 0; j < n; j++) {
        const x0 = Math.round((w * j) / n), x1 = Math.round((w * (j + 1)) / n) - 1;
        if (panel && x1 - x0 > 6 && h > 8) {
          const px0 = x0 + 2, px1 = x1 - 2, py0 = 2, py1 = h - 3;
          line(img, px0, py0, px1, py0, r[1]); line(img, px0, py0, px0, py1, r[1]);
          line(img, px0, py1, px1, py1, r[3]); line(img, px1, py0, px1, py1, r[3]);
        }
        const hx = n === 1 ? x1 - 2 : j % 2 === 0 ? x1 - 1 : x0 + 1;
        const hy = Math.round(h * 0.4);
        if (vHandle) line(img, hx, hy - Math.max(1, Math.round(h / 10)), hx, hy + Math.max(1, Math.round(h / 10)), handle);
        else img.set(hx, hy, handle);
      }
    },
  };
}

/** Rows of book spines on a shelf back (bookcases); `c` = seed for colours. */
export function books(shelves: number, seed: number): Decal {
  return {
    k: `bks${shelves}:${seed}`,
    draw(img, r, w, h) {
      const cols: RGB[] = [[122, 38, 34], [40, 62, 104], [52, 88, 50], [150, 122, 60], [96, 60, 86], [180, 170, 150], [60, 56, 52], [150, 70, 40]];
      for (let s = 0; s < shelves; s++) {
        const y0 = Math.round((h * s) / shelves) + 1, y1 = Math.round((h * (s + 1)) / shelves) - 2;
        line(img, 0, y1 + 1, w - 1, y1 + 1, r[3]);
        let x = 1;
        while (x < w - 1) {
          const bw = 1 + (hash2(x, s, seed) % 3);
          const top = y0 + 1 + (hash2(x, s, seed + 1) % 3);
          if (hash2(x, s, seed + 2) % 9 === 0) { x += 2; continue; }
          const c = cols[hash2(x, s, seed + 3) % cols.length];
          line(img, x, top, Math.min(w - 2, x + bw - 1), y1, c);
          img.set(x, top, scale(c, 1.3));
          x += bw;
        }
      }
    },
  };
}

/** Generic horizontal slats / vents: `n` dark lines across the face. */
export function slats(n: number, margin = 2): Decal {
  return {
    k: `slt${n}:${margin}`,
    draw(img, r, w, h) {
      for (let i = 0; i < n; i++) {
        const y = Math.round(margin + ((h - margin * 2) * (i + 0.5)) / n);
        line(img, margin, y, w - 1 - margin, y, r[0]);
      }
    },
  };
}

/** Rectangular window/screen inset: fraction box (x0,y0,x1,y1 of the face) in colour c. */
export function inset(fx0: number, fy0: number, fx1: number, fy1: number, c: RGB, frame = true, glint = true): Decal {
  return {
    k: `ins${[fx0, fy0, fx1, fy1].join(',')}:${c.map(Math.round).join(',')}${frame ? 'f' : ''}${glint ? 'g' : ''}`,
    draw(img, r, w, h) {
      const x0 = Math.round(fx0 * w), x1 = Math.round(fx1 * w) - 1, y0 = Math.round(fy0 * h), y1 = Math.round(fy1 * h) - 1;
      line(img, x0, y0, x1, y1, c);
      if (glint) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x - x0) - (y - y0) * 1 === 2 || (x - x0) - (y - y0) === 3) img.set(x, y, mix(c, [255, 255, 255], 0.35));
      if (frame) {
        line(img, x0 - 1, y0 - 1, x1 + 1, y0 - 1, r[0]);
        line(img, x0 - 1, y1 + 1, x1 + 1, y1 + 1, r[3]);
      }
    },
  };
}

/** Knobs / buttons in a row near the top of the face (stoves, washers, radios). */
export function knobs(n: number, c: RGB, fy = 0.2): Decal {
  return {
    k: `knb${n}:${fy}:${c.map(Math.round).join(',')}`,
    draw(img, _r, w, h) {
      const y = Math.round(h * fy);
      for (let i = 0; i < n; i++) {
        const x = Math.round((w * (i + 1)) / (n + 1));
        img.set(x, y, c);
        img.set(x, y + 1, scale(c, 0.6));
      }
    },
  };
}

/** Round door (front loaders), centred at (fx, fy), radius fraction of min(w, h). */
export function porthole(fx: number, fy: number, fr: number, glass: RGB): Decal {
  return {
    k: `prt${fx},${fy},${fr}:${glass.map(Math.round).join(',')}`,
    draw(img, r, w, h) {
      const cx = fx * w, cy = fy * h, R = fr * Math.min(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < R - 1.2) img.set(x, y, (x - y + 100) % 5 === 0 ? mix(glass, [255, 255, 255], 0.3) : glass);
        else if (d < R) img.set(x, y, r[3]);
        else if (d < R + 1) img.set(x, y, r[0]);
      }
    },
  };
}

/** Stove top: four burner rings. */
export function burners(c: RGB): Decal {
  return {
    k: `brn:${c.map(Math.round).join(',')}`,
    draw(img, _r, w, h) {
      for (const [fx, fy] of [[0.28, 0.3], [0.72, 0.3], [0.28, 0.72], [0.72, 0.72]]) {
        const cx = fx * w, cy = fy * h, R = Math.min(w, h) * 0.17;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (d < R && d > R - 1.5) img.set(x, y, c);
          else if (d <= R - 1.5 && d > R - 2.5) img.set(x, y, scale(c, 0.5));
        }
      }
    },
  };
}

/** Several decals on one face. */
export function combo(...ds: (Decal | undefined)[]): Decal | undefined {
  const list = ds.filter((d): d is Decal => !!d);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  return { k: list.map((d) => d.k).join('+'), draw: (img, r, w, h) => { for (const d of list) d.draw(img, r, w, h); } };
}

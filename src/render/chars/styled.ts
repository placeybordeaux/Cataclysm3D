// "Styled" skins for people (humanoid monsters, NPCs, the survivor): instead of projecting the
// 32x48 sprite onto box faces (which turns a detailed sprite into speckled camo at 8-12
// texels per face), the sprite is read for a small semantic palette — skin, hair, shirt,
// jacket, pants, shoes, sleeve length, how bloody — and each body region is painted
// deliberately in the Shadowglass manner: flat colour, 3 stepped shade bands with a top-lit
// highlight row, and a few details (collar, placket, belt and buckle, cuffs, seams, laces),
// a hand-authored pixel face tinted by the skin, and blood as placed splatter decals.
// Pure (RGBA arrays), for tests.

import type { Region } from './rig';
import type { Img, RGB, SpriteInfo } from './paint';

export interface PersonPalette {
  skin: RGB;
  hair: RGB;
  bald: boolean;
  /** outer torso colour (shirt, or jacket when there is an undershirt) */
  shirt: RGB;
  /** a second clear torso colour (undershirt/open jacket), or null */
  inner: RGB | null;
  /** second colour of a patterned (check) shirt, for sleeves up close; null = plain */
  check: RGB | null;
  upperArm: RGB;
  foreArm: RGB;
  pants: RGB;
  shoes: RGB;
  /** 0..1 how much red gore the sprite has */
  blood: number;
  zombie: boolean;
}

const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const dist = (a: RGB, b: RGB) => Math.sqrt(3 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 2 * (a[2] - b[2]) ** 2) / 3;
const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const isBlood = (r: number, g: number, b: number) => r > 80 && r > g * 1.8 && r > b * 1.6;

/** Dominant colours of a rect of the sprite box (fractions), most common first. */
function dominant(s: SpriteInfo, u0: number, v0: number, u1: number, v1: number, skipBlood = true): { c: RGB; n: number }[] {
  const [bx0, by0, bx1, by1] = s.box;
  const bw = bx1 - bx0, bh = by1 - by0;
  const x0 = Math.floor(bx0 + u0 * bw), x1 = Math.max(x0 + 1, Math.ceil(bx0 + u1 * bw));
  const y0 = Math.floor(by0 + v0 * bh), y1 = Math.max(y0 + 1, Math.ceil(by0 + v1 * bh));
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  if (skipBlood) {
    // a red shirt is not gore: only skip red when it's a minority of the region
    let red = 0, all = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * s.img.w + x) * 4;
      if (s.img.data[i + 3] < 128) continue;
      all++;
      if (isBlood(s.img.data[i], s.img.data[i + 1], s.img.data[i + 2])) red++;
    }
    if (red > all * 0.4) skipBlood = false;
  }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * s.img.w + x) * 4;
    const d = s.img.data;
    if (d[i + 3] < 128) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (skipBlood && isBlood(r, g, b)) continue;
    if (r + g + b < 45) continue; // outline leftovers
    const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = bins.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    bins.set(k, e);
  }
  // merge near-identical bins so a shaded shirt counts as one colour
  const list = [...bins.values()].map((e) => ({ c: [e.r / e.n, e.g / e.n, e.b / e.n] as RGB, n: e.n })).sort((a, b) => b.n - a.n);
  const out: { c: RGB; n: number }[] = [];
  for (const e of list) {
    const m = out.find((o) => dist(o.c, e.c) < 22);
    if (m) m.n += e.n;
    else out.push({ ...e });
  }
  return out.sort((a, b) => b.n - a.n);
}

const palCache = new WeakMap<SpriteInfo, PersonPalette>();

/** Read the sprite for a person's colours (rows follow UltiCa's 32x48 people). */
export function personPalette(s: SpriteInfo, zombie: boolean): PersonPalette {
  const hit = palCache.get(s);
  if (hit && hit.zombie === zombie) return hit;
  const top = dominant(s, 0.25, 0, 0.75, 0.07, zombie);
  const face = dominant(s, 0.3, 0.08, 0.7, 0.2, zombie);
  const hair = top[0]?.c ?? s.pal.dark;
  // UltiCa skin comes in a light tone and a shade: take the lightest skin-like colour of the face
  const faceN = face.reduce((a, e) => a + e.n, 0) || 1;
  const skinLike = face.filter((e) => e.n / faceN > 0.12 && e.c[0] + e.c[1] > e.c[2] * 2.1 && lum(e.c) > 50);
  const skin = skinLike.sort((a, b) => lum(b.c) - lum(a.c))[0]?.c ?? face[0]?.c ?? s.pal.skin;
  const torso = dominant(s, 0.3, 0.26, 0.7, 0.5, zombie);
  const shirt = torso[0]?.c ?? s.pal.main;
  const total = torso.reduce((a, e) => a + e.n, 0) || 1;
  const second = torso.find((e) => dist(e.c, shirt) > 40 && dist(e.c, skin) > 25 && e.n / total > 0.18);
  const pants = dominant(s, 0.3, 0.62, 0.7, 0.86, zombie)[0]?.c ?? s.pal.dark;
  const shoes = dominant(s, 0.15, 0.93, 0.85, 1, zombie)[0]?.c ?? mul(pants, 0.6);
  // sleeves: the colour at the body's outer columns, upper and lower arm, snapped to skin or cloth
  const armAt = (v0: number, v1: number): RGB => {
    const c = [...dominant(s, 0, v0, 0.22, v1, zombie), ...dominant(s, 0.78, v0, 1, v1, zombie)].sort((a, b) => b.n - a.n)[0]?.c;
    if (!c) return shirt;
    const cands: RGB[] = [skin, shirt, ...(second ? [second.c] : [])];
    return cands.sort((a, b) => dist(a, c) - dist(b, c))[0];
  };
  let red = 0, n = 0;
  const [bx0, by0, bx1, by1] = s.box;
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
    const i = (y * s.img.w + x) * 4;
    if (s.img.data[i + 3] < 128) continue;
    n++;
    if (isBlood(s.img.data[i], s.img.data[i + 1], s.img.data[i + 2])) red++;
  }
  // A patterned shirt (flannel check): its two main colours each cover a good share
  const third = torso.find((e) => e !== torso[0] && dist(e.c, shirt) > 40 && dist(e.c, skin) > 25 && e.n / total > 0.12);
  const pp: PersonPalette = {
    skin, hair, bald: dist(hair, skin) < 45, shirt, inner: second ? second.c : null,
    upperArm: armAt(0.24, 0.36), foreArm: armAt(0.38, 0.5), pants, shoes,
    // lots of red is red clothing, not a bloodbath
    // only the undead come bloody; a survivor's red is their clothes
    blood: !zombie ? 0 : red / Math.max(1, n) > 0.25 ? 0.15 : Math.min(1, (red / Math.max(1, n)) * 7), zombie,
    check: third ? third.c : null,
  };
  palCache.set(s, pp);
  return pp;
}

// ------------------------------------------------------------------ faces

// Hand-authored 8x8 faces, scaled to the head's front face. h hair, s skin, b brow, w eye
// white, E eye, D sunken socket, n nose shade, m lips, M open mouth, T teeth, j jaw shade.
const FACE_HUMAN = [
  'hhhhhhhh',
  'hhhhhhhh',
  'hssssssh',
  'sbbssbbs',
  'swEssEws',
  'ssssnsss',
  'sssmmsss',
  'jssssssj',
];
const FACE_ZOMBIE = [
  'hhhhhhhh',
  'hshhshhh',
  'ssssssss',
  'sDDssDDs',
  'sDEssEDs',
  'sssnnsss',
  'sMTTTTMs',
  'sjMMMMjs',
];

function faceColour(code: string, pp: PersonPalette): RGB {
  const sk = pp.skin, hair = pp.bald ? mul(sk, 0.92) : pp.hair;
  switch (code) {
    case 'h': return hair;
    case 'b': return pp.bald ? mul(sk, 0.6) : mul(pp.hair, 0.7);
    case 'w': return [225, 220, 205];
    case 'E': return pp.zombie ? [225, 205, 110] : [34, 28, 30];
    case 'D': return mul(sk, 0.32);
    case 'n': return mul(sk, 0.78);
    case 'm': return mix(mul(sk, 0.6), [150, 50, 50], 0.4);
    case 'M': return [48, 12, 14];
    case 'T': return [205, 195, 150];
    case 'j': return mul(sk, 0.82);
    default: return sk;
  }
}

/**
 * A sleeve colour that reads up close: UltiCa's dark cloth (a 69,23,8 flannel) would be a
 * black slab filling a quarter of the screen, so lift dark cloth to a readable level keeping
 * its hue.
 */
function sleeveCloth(pp: PersonPalette, c: RGB): RGB {
  if (dist(c, pp.skin) <= 20) return c;
  const l = lum(c);
  const want = 78;
  if (l >= want) return c;
  const k = want / Math.max(8, l);
  const lifted: RGB = [Math.min(235, c[0] * k), Math.min(235, c[1] * k), Math.min(235, c[2] * k)];
  // near-black cloth has no hue to lift: make it a charcoal instead of noise
  return l < 18 ? [70, 72, 78] : lifted;
}

// ------------------------------------------------------------------ painting

/** Tiny deterministic RNG for decal placement. */
function rng(seed: number): () => number {
  let x = Math.floor(seed * 2147483647) | 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

const BLOOD: RGB[] = [[122, 18, 20], [92, 12, 14], [150, 30, 28]];

/**
 * Paint one person part's net (paint.ts layout: faces right, front, left, back, top, bottom)
 * from the semantic palette. `side` is +1 for the model's right limbs, -1 left, 0 centre.
 */
export function paintStyled(dst: Img, ox: number, oy: number, dims: [number, number, number], region: Region, pp: PersonPalette, seed: number, side = 0): void {
  const [W, H, D] = dims;
  const put = (x: number, y: number, c: RGB) => {
    const px = ox + x, py = oy + y;
    if (px < 0 || py < 0 || px >= dst.w || py >= dst.h) return;
    const i = (py * dst.w + px) * 4;
    dst.data[i] = Math.max(0, Math.min(255, c[0]));
    dst.data[i + 1] = Math.max(0, Math.min(255, c[1]));
    dst.data[i + 2] = Math.max(0, Math.min(255, c[2]));
    dst.data[i + 3] = 255;
  };
  const rects: [number, number, number, number][] = [
    [0, D, D, H], [D, D, W, H], [D + W, D, D, H], [2 * D + W, D, W, H], [D, 0, W, D], [D + W, 0, W, D],
  ];
  // Stepped shading: highlight top row, then 3 bands; sides a touch darker, underside dark.
  const band = (f: number, y: number, fh: number): number => {
    if (f === 4) return 1.12;
    if (f === 5) return 0.66;
    const t = y / Math.max(1, fh);
    const k = y === 0 && fh >= 4 ? 1.12 : t < 0.45 ? 1 : t < 0.8 ? 0.9 : 0.8;
    return f === 1 || f === 3 ? k : k * 0.94;
  };
  const r = rng(seed + region.length * 0.013 + side * 0.07);
  // base colour + details per face texel
  const base = (f: number, x: number, y: number, fw: number, fh: number): RGB => {
    const u = (x + 0.5) / fw, v = (y + 0.5) / fh;
    switch (region) {
      case 'head': {
        const hair = pp.bald ? mul(pp.skin, 0.92) : pp.hair;
        if (f === 4) return hair;
        if (f === 5) return mul(pp.skin, 0.8);
        if (f === 1) {
          const t = pp.zombie ? FACE_ZOMBIE : FACE_HUMAN;
          return faceColour(t[Math.min(7, Math.floor(v * 8))][Math.min(7, Math.floor(u * 8))], pp);
        }
        if (f === 3) return v < 0.72 ? hair : pp.skin;
        // sides: hair above and toward the back (u small = back on the right face, large on
        // the left), an ear
        const back = f === 0 ? 1 - u : u;
        if (v < 0.28 || (back > 0.45 && v < 0.62)) return hair;
        if (Math.abs(back - 0.45) < 0.5 / fw + 0.01 && v > 0.35 && v < 0.6) return mul(pp.skin, 0.78);
        return pp.skin;
      }
      case 'neck':
        return mul(pp.skin, 0.86);
      // ---- first-person arms (fpView.ts), seen from 30 cm: fabric and knuckles, not plank
      case 'fpSleeveLower':
      case 'fpSleeveUpper': {
        const cloth = sleeveCloth(pp, region === 'fpSleeveLower' ? pp.foreArm : pp.upperArm);
        const lower = region === 'fpSleeveLower';
        // the wrist end (+y, top rows): bare skin, then a darker cuff with a seam line
        if (lower && dist(pp.foreArm, pp.skin) > 20) {
          if (v < 0.09) return mul(pp.skin, 0.95);
          if (v < 0.17) return v < 0.1 + 0.5 / fh ? mul(cloth, 0.6) : mul(cloth, 0.78);
        }
        if (lower && dist(pp.foreArm, pp.skin) <= 20) return pp.skin;
        let c = cloth;
        // woven fabric: a faint grid, darker every few texels (reads as flannel/denim up close)
        if (x % 4 === 0 || y % 5 === 0) c = mul(c, 0.9);
        // folds: soft diagonal creases that drift along the sleeve
        const fold = Math.sin(v * 22 + u * 3 + side) + Math.sin(v * 9 - u * 5);
        if (fold > 1.45) c = mul(c, 0.78);
        else if (fold > 1.2) c = mul(c, 1.1);
        // seam down the underside
        if (f === 5 || ((f === 0 || f === 2) && Math.abs(u - 0.5) < 0.5 / fw)) c = mul(c, 0.82);
        return c;
      }
      case 'fpBack': {
        // the back of the hand: tendon lines toward each knuckle, a little lighter on top
        const c = f === 4 ? mul(pp.skin, 1.06) : pp.skin;
        if (f === 4 && fw >= 8 && (x === Math.round(fw * 0.25) || x === Math.round(fw * 0.5) || x === Math.round(fw * 0.75)) && v < 0.75) return mul(c, 0.9);
        return c;
      }
      case 'fpPalm':
        return f === 5 ? mul(pp.skin, 0.85) : mul(pp.skin, 0.94);
      case 'fpFinger': {
        // knuckle on top, a crease across the front, dark separation on the sides
        if (f === 0 || f === 2) return mul(pp.skin, 0.72);
        if (f === 4) return v < 0.5 ? mul(pp.skin, 1.12) : pp.skin;
        if (f === 1 && Math.abs(v - 0.55) < 0.5 / fh) return mul(pp.skin, 0.75);
        return pp.skin;
      }
      case 'fpThumb': {
        if (f === 1 && u > 0.78) return mix(pp.skin, [235, 205, 190], 0.4); // the nail
        if (f === 5) return mul(pp.skin, 0.8);
        return mul(pp.skin, 1.02);
      }
      case 'hand': {
        if (f === 1 && y === fh - 1) return mul(pp.skin, 0.8);
        return pp.skin;
      }
      case 'torso': {
        let c = pp.shirt;
        if (f === 1) {
          // open jacket over an undershirt, else a shirt placket
          const mid = Math.abs(u - 0.5);
          if (pp.inner && mid < 0.2) c = pp.inner;
          else if (pp.inner && mid < 0.2 + 1 / fw) c = mul(pp.shirt, 0.72);
          else if (!pp.inner && fw >= 7 && mid < 0.5 / fw && y > 0) c = mul(pp.shirt, 0.82);
          // collar / neckline
          if (y === 0 && mid < 0.2) c = mul(pp.skin, 0.9);
          if (y === 1 && mid < 0.08 && !pp.inner) c = mul(pp.skin, 0.85);
        }
        if (f === 3 && pp.inner && y === 0) c = mul(pp.shirt, 0.8); // collar at the back
        // torn hem on the undead
        if (pp.zombie && y === fh - 1 && f !== 4 && f !== 5 && (x * 7 + f * 3) % 3 === 0) c = pp.skin;
        return c;
      }
      case 'hips': {
        if (f !== 5 && y === 0) {
          // belt with a buckle on the front
          if (f === 1 && Math.abs(u - 0.5) < 0.12) return [196, 170, 90];
          return [52, 40, 30];
        }
        return pp.pants;
      }
      case 'upperArm': {
        const c = pp.upperArm;
        return f === 4 ? mix(c, pp.shirt, 0.3) : c;
      }
      case 'foreArm': {
        const cloth = dist(pp.foreArm, pp.skin) > 20;
        if (cloth && y === fh - 1 && f !== 4 && f !== 5) return mul(pp.foreArm, 0.75); // cuff
        return pp.foreArm;
      }
      case 'thigh': {
        // side seams
        if ((f === 0 || f === 2) && Math.abs(u - 0.5) < 0.5 / fw) return mul(pp.pants, 0.8);
        return pp.pants;
      }
      case 'shin': {
        if (y === fh - 1 && f !== 4 && f !== 5) return mul(pp.pants, 0.72); // hem
        if ((f === 0 || f === 2) && Math.abs(u - 0.5) < 0.5 / fw) return mul(pp.pants, 0.8);
        return pp.pants;
      }
      case 'foot': {
        if (f === 5) return mul(pp.shoes, 0.45);
        if (y === fh - 1) return mul(pp.shoes, 0.6); // sole
        if (f === 4 && v > 0.35 && v < 0.75 && (x + y) % 2 === 0) return mix(pp.shoes, [220, 220, 210], 0.35); // laces
        return pp.shoes;
      }
    }
    return pp.shirt;
  };
  for (let f = 0; f < 6; f++) {
    const [fx, fy, fw, fh] = rects[f];
    for (let y = 0; y < fh; y++) {
      const k = band(f, y, fh);
      for (let x = 0; x < fw; x++) {
        let c = mul(base(f, x, y, fw, fh), k);
        // a darker rim on the vertical edges keeps the box shape readable
        if ((f < 4) && fw >= 4 && (x === 0 || x === fw - 1)) c = mul(c, 0.9);
        put(fx + x, fy + y, c);
      }
    }
  }
  // Blood: placed splatters (a few clustered drops), heaviest on the chest, hands and mouth.
  const gore = pp.blood + (pp.zombie ? 0.15 : 0);
  if (gore <= 0.05) return;
  const splat = (f: number, cx: number, cy: number, size: number) => {
    const [fx, fy, fw, fh] = rects[f];
    for (let i = 0; i < size; i++) {
      const x = Math.min(fw - 1, Math.max(0, cx + Math.round((r() - 0.5) * size)));
      const y = Math.min(fh - 1, Math.max(0, cy + Math.round(r() * size * 0.8)));
      put(fx + x, fy + y, BLOOD[Math.floor(r() * BLOOD.length)]);
    }
  };
  const [, , fw1, fh1] = rects[1];
  if (region === 'torso') {
    const n = Math.round(gore * 5);
    for (let i = 0; i < n; i++) splat(1, Math.floor(fw1 * (0.25 + 0.5 * r())), Math.floor(fh1 * 0.6 * r()), 2 + Math.floor(r() * 4));
    if (gore > 0.4) splat(r() < 0.5 ? 0 : 2, 1, Math.floor(fh1 * 0.3), 3);
  } else if (region === 'head' && pp.zombie && fw1 >= 6) {
    // a drip from the mouth down the chin
    const mx = Math.floor(fw1 * (0.3 + 0.4 * r()));
    put(D + mx, D + fh1 - 1, BLOOD[1]);
  } else if (region === 'hand' || region === 'foreArm') {
    if (r() < gore) splat(1, Math.floor(fw1 * r()), Math.floor(fh1 * 0.3), 2);
  } else if ((region === 'thigh' || region === 'shin') && r() < gore * 0.6) {
    splat(1, Math.floor(fw1 * r()), Math.floor(fh1 * r() * 0.7), 2 + Math.floor(r() * 2));
  }
}

// Skins for the zombie bodies (zombie.ts): the styled person painting (styled.ts) pushed toward
// the UltiCa zombie sprites — grey-green skin, sunken dark sockets with a glint, a hanging jaw
// of teeth, torn clothes showing skin, more blood — plus the zombie-only surfaces: rags with
// cut-out torn edges, uniform pieces, glowing acid sacs, bone, plant matter, dithered smoke,
// electric arcs, raw flesh and necromancer tendrils. Pure (RGBA arrays), for tests.
//
// Alpha is not transparency here (charLayer.ts): 0 cuts the texel out, 1..254 makes it glow
// (1 - a/255 of its colour is emitted), 255 is plain.

import type { PartSrc, Region } from './rig';
import type { Img, RGB } from './paint';
import { paintStyled, type PersonPalette } from './styled';
import type { ZombieLook } from './zombieFamily';

const mul = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/** The rotten grey-green of the sprites' zombie skin. */
const ROT: RGB = [116, 132, 98];
const BONE: RGB = [206, 196, 166];
const BLOOD: RGB[] = [[122, 18, 20], [92, 12, 14], [150, 30, 28]];
const NECRO: RGB = [22, 20, 26];

function rng(seed: number): () => number {
  let x = Math.floor(seed * 2147483647) | 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

function lift(c: RGB, want: number): RGB {
  const l = lum(c);
  if (l >= want) return c;
  if (l < 14) return [want * 0.9, want * 0.92, want];
  const k = want / l;
  return [Math.min(235, c[0] * k), Math.min(235, c[1] * k), Math.min(235, c[2] * k)];
}

/** The person palette read off the sprite, turned undead for this look. */
export function zombiePalette(pp: PersonPalette, look: ZombieLook): PersonPalette {
  const z = { ...pp };
  if (look.undead) {
    // the sprites' skin is already greenish; pull every tone toward one rotten grey-green so a
    // horde reads as zombies before it reads as clothes
    z.skin = mix(pp.skin, ROT, 0.45);
    z.blood = Math.max(pp.blood, 0.35);
  }
  if (look.bone) {
    z.skin = BONE;
    z.bald = true;
    z.hair = BONE;
  }
  if (look.fx.includes('tendrils')) {
    // jet black, clothes and all
    z.skin = NECRO;
    z.hair = NECRO;
    z.bald = true;
    for (const k of ['shirt', 'upperArm', 'foreArm', 'pants', 'shoes'] as const) z[k] = mix(pp[k], NECRO, 0.82);
    z.inner = null;
    z.check = null;
    z.blood = 0;
  }
  if (look.fx.includes('charred')) {
    z.skin = [74, 42, 28];
    for (const k of ['shirt', 'upperArm', 'foreArm', 'pants'] as const) z[k] = mix(pp[k], [40, 26, 20], 0.6);
  }
  if (look.fx.includes('thorns')) z.skin = mix(pp.skin, [96, 140, 70], 0.5);
  // UltiCa's dark cloth turns into a black slab on a body lit from one side: lift it to a
  // readable level keeping its hue (the sprites' shirts and jeans read as colours)
  if (!look.fx.includes('tendrils')) for (const k of ['shirt', 'upperArm', 'foreArm', 'pants'] as const) z[k] = lift(z[k], 62);
  if (z.inner) z.inner = lift(z.inner, 62);
  return z;
}

// 8x6 cranium face, one row per texel of a zombie's ~6-texel skull (a seventh row would get
// skipped by the nearest-row sampling, and with it the eyes): h hair, b brow ridge, D socket,
// E eye glint, n nostril, s skin, T upper teeth, k cheek hollow. The jaw is its own part.
const CRANIUM = [
  'hhhhhhhh',
  'sbbssbbs',
  'DEDssDED',
  'kDDssDDk',
  'sksnnsks',
  'sTTTTTTs',
];
const SKULL = [
  'ssssssss',
  'sbbssbbs',
  'DDDssDDD',
  'DDDssDDD',
  'sssnnsss',
  'sTTTTTTs',
];

/**
 * Paint one zombie part's net (paint.ts layout: right, front, left, back, top, bottom).
 * `name` is the rig part's name; `side` +1 right limbs, -1 left, 0 centre.
 */
export function paintZombiePart(dst: Img, ox: number, oy: number, dims: [number, number, number], src: PartSrc, name: string, pp0: PersonPalette, look: ZombieLook, seed: number, side = 0): void {
  const [W, H, D] = dims;
  const pp = zombiePalette(pp0, look);
  const r = rng(seed + name.length * 0.0131 + side * 0.071 + (name.charCodeAt(name.length - 1) % 7) * 0.01);
  const rects: [number, number, number, number][] = [
    [0, D, D, H], [D, D, W, H], [D + W, D, D, H], [2 * D + W, D, W, H], [D, 0, W, D], [D + W, 0, W, D],
  ];
  const put = (f: number, x: number, y: number, c: RGB, glow = 0, cut = false) => {
    const [fx, fy, fw, fh] = rects[f];
    if (x < 0 || y < 0 || x >= fw || y >= fh) return;
    const px = ox + fx + x, py = oy + fy + y;
    if (px < 0 || py < 0 || px >= dst.w || py >= dst.h) return;
    const i = (py * dst.w + px) * 4;
    dst.data[i] = Math.max(0, Math.min(255, c[0]));
    dst.data[i + 1] = Math.max(0, Math.min(255, c[1]));
    dst.data[i + 2] = Math.max(0, Math.min(255, c[2]));
    dst.data[i + 3] = cut ? 0 : glow > 0 ? Math.max(1, Math.round(255 * (1 - Math.min(1, glow)))) : 255;
  };
  const get = (f: number, x: number, y: number): RGB => {
    const [fx, fy] = rects[f];
    const i = ((oy + fy + y) * dst.w + ox + fx + x) * 4;
    return [dst.data[i], dst.data[i + 1], dst.data[i + 2]];
  };
  // stepped shading like styled.ts: lit top row, three bands, darker sides and underside
  const shade = (f: number, y: number, fh: number) => {
    if (f === 4) return 1.12;
    if (f === 5) return 0.62;
    const t = y / Math.max(1, fh);
    const k = y === 0 && fh >= 4 ? 1.12 : t < 0.45 ? 1 : t < 0.8 ? 0.88 : 0.78;
    return f === 1 || f === 3 ? k : k * 0.92;
  };
  const fill = (col: (f: number, x: number, y: number, fw: number, fh: number) => RGB, glow = 0) => {
    for (let f = 0; f < 6; f++) {
      const [, , fw, fh] = rects[f];
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
        let c = mul(col(f, x, y, fw, fh), shade(f, y, fh));
        if (f < 4 && fw >= 4 && (x === 0 || x === fw - 1)) c = mul(c, 0.88);
        put(f, x, y, c, glow);
      }
    }
  };
  const splat = (f: number, cx: number, cy: number, size: number) => {
    for (let i = 0; i < size; i++) put(f, cx + Math.round((r() - 0.5) * size), cy + Math.round(r() * size * 0.8), BLOOD[Math.floor(r() * BLOOD.length)]);
  };

  if (src.zr) {
    paintSurface(src, pp, look, { W, H, D, rects, put, fill, r, name });
    return;
  }
  const region = src.region as Region;
  paintStyled(dst, ox, oy, dims, region, pp, seed, side);
  const [, , fw1, fh1] = rects[1];
  switch (region) {
    case 'head': {
      // sunken sockets and a glint: red and glowing on a necromancer, a dull yellow otherwise
      const tpl = look.bone ? SKULL : CRANIUM;
      const red = look.fx.includes('redEyes');
      const hair = pp.bald ? mul(pp.skin, 0.9) : pp.hair;
      for (let y = 0; y < fh1; y++) for (let x = 0; x < fw1; x++) {
        const code = tpl[Math.min(tpl.length - 1, Math.floor(((y + 0.5) / fh1) * tpl.length))][Math.min(7, Math.floor(((x + 0.5) / fw1) * 8))];
        const k = shade(1, y, fh1);
        switch (code) {
          case 'h': put(1, x, y, mul(hair, k)); break;
          case 'b': put(1, x, y, mul(pp.skin, 0.72 * k)); break;
          case 'D': put(1, x, y, look.bone ? [34, 28, 24] : mul(pp.skin, 0.28)); break;
          case 'E': put(1, x, y, red ? [255, 40, 30] : look.bone ? [34, 28, 24] : [222, 200, 96], red ? 1 : look.bone ? 0 : 0.3); break;
          case 'n': put(1, x, y, mul(pp.skin, 0.35)); break;
          case 'k': put(1, x, y, mul(pp.skin, 0.8 * k)); break;
          case 'T': put(1, x, y, look.bone ? [214, 204, 172] : [196, 184, 132]); break;
          default: put(1, x, y, mul(pp.skin, k));
        }
      }
      // a gash across the scalp on some
      if (look.undead && !look.bone && r() < 0.5) for (let x = 0; x < Math.min(3, fw1); x++) put(4, Math.floor(fw1 * 0.3) + x, Math.floor(D * 0.4 + x * 0.5), BLOOD[1]);
      break;
    }
    case 'torso': {
      if (look.bone) {
        // the shadowy inside of a ribcage behind the rib bars, a spine down the back
        fill((f, x, _y, fw) => (f === 3 && Math.abs(x - fw / 2) < 1 ? BONE : f === 4 || f === 5 ? [50, 44, 38] : [46, 38, 32]));
        break;
      }
      if (look.undead) {
        // torn: holes through the shirt showing grey skin (dark rims, sometimes raw)
        const n = 2 + Math.floor(r() * 2);
        for (let h = 0; h < n; h++) {
          const f = r() < 0.6 ? 1 : r() < 0.5 ? 0 : 3;
          const [, , fw, fh] = rects[f];
          const hw = 1 + Math.floor(r() * Math.max(1, fw * 0.3)), hh = 1 + Math.floor(r() * Math.max(1, fh * 0.25));
          const cx = Math.floor(r() * Math.max(1, fw - hw)), cy = Math.floor(fh * 0.25 + r() * fh * 0.6);
          for (let y = cy; y < cy + hh; y++) for (let x = cx; x < cx + hw; x++) {
            const edge = y === cy || x === cx || x === cx + hw - 1;
            put(f, x, y, edge ? mul(pp.shirt, 0.5) : r() < 0.25 ? BLOOD[0] : mul(pp.skin, 0.95));
          }
        }
        // ragged hem: skin teeth along the bottom rows
        for (let f = 0; f < 4; f++) {
          const [, , fw, fh] = rects[f];
          for (let x = 0; x < fw; x++) if (r() < 0.4) put(f, x, fh - 1 - Math.floor(r() * 2), mul(pp.skin, 0.9));
        }
        for (let i = 0; i < 2 + Math.round(pp.blood * 4); i++) splat(1, Math.floor(fw1 * r()), Math.floor(fh1 * 0.5 * r()), 3);
      }
      uniformDetail(look, 'torso', rects, put, get, r);
      if (look.fx.includes('acid')) blotch(rects, put, r, [170, 214, 64], 5, 0.35);
      break;
    }
    case 'upperArm':
    case 'foreArm': {
      // a torn sleeve: below a jagged line the arm is bare grey skin
      if (look.undead && !look.bone && pp.upperArm !== pp.skin && r() < 0.55) {
        const cutAt = region === 'upperArm' ? 0.55 + r() * 0.3 : r() * 0.5;
        for (let f = 0; f < 4; f++) {
          const [, , fw, fh] = rects[f];
          for (let x = 0; x < fw; x++) {
            const y0 = Math.floor(fh * cutAt + (r() - 0.5) * 2);
            for (let y = Math.max(0, y0); y < fh; y++) put(f, x, y, mul(pp.skin, shade(f, y, fh)));
          }
        }
      }
      if (look.bone) fill((f, x, y, fw, fh) => (y === 0 || y === fh - 1 ? mul(BONE, 0.85) : BONE));
      uniformDetail(look, region, rects, put, get, r);
      break;
    }
    case 'thigh':
    case 'shin': {
      if (look.bone) {
        fill(() => BONE);
        // rags of trousers still clinging round the thighs
        if (region === 'thigh') for (let f = 0; f < 4; f++) {
          const [, , fw, fh] = rects[f];
          for (let x = 0; x < fw; x++) for (let y = 0; y < Math.floor(fh * (0.3 + 0.4 * r())); y++) put(f, x, y, mul(pp.pants, shade(f, y, fh)));
        }
        break;
      }
      if (look.undead && r() < 0.6) {
        // a rip in the trousers
        const f = r() < 0.7 ? 1 : 0;
        const [, , fw, fh] = rects[f];
        const cx = Math.floor(r() * Math.max(1, fw - 2)), cy = Math.floor(fh * (0.2 + 0.5 * r()));
        for (let y = cy; y < Math.min(fh, cy + 3); y++) for (let x = cx; x < Math.min(fw, cx + 2); x++) put(f, x, y, mul(pp.skin, 0.9));
      }
      if (look.undead && pp.blood > 0.2) splat(1, Math.floor(fw1 * r()), Math.floor(fh1 * r() * 0.7), 2);
      uniformDetail(look, region, rects, put, get, r);
      break;
    }
    case 'hand': {
      if (look.bone) {
        fill((f, x) => (x % 2 && f < 4 ? mul(BONE, 0.8) : BONE));
        break;
      }
      // fingers: dark gaps down the lower half of the palm and back, dark nails / dried blood
      for (let f = 0; f < 4; f++) {
        const [, , fw, fh] = rects[f];
        for (let x = 0; x < fw; x++) {
          if ((f === 1 || f === 3) && fw >= 3 && x % 2 === 1) for (let y = Math.floor(fh * 0.45); y < fh - 1; y++) put(f, x, y, mul(pp.skin, 0.62));
          put(f, x, fh - 1, look.undead ? (r() < 0.5 ? BLOOD[1] : mul(pp.skin, 0.45)) : mul(pp.skin, 0.75));
        }
      }
      // charged hands: a blue cast and a faint glow, the arcs do the rest
      if (look.fx.includes('arcs')) fill((f) => mix(pp.skin, [120, 180, 255], f === 5 ? 0.7 : 0.45), 0.18);
      break;
    }
    case 'neck':
      if (look.bone) fill((f, x) => (x % 2 ? mul(BONE, 0.75) : BONE));
      else if (look.undead) for (let f = 0; f < 4; f++) if (r() < 0.4) put(f, Math.floor(r() * rects[f][2]), Math.floor(r() * rects[f][3]), BLOOD[1]);
      break;
    case 'hips':
      if (look.bone) fill((f) => (f === 4 ? [50, 44, 38] : mul(BONE, 0.92)));
      break;
    case 'foot':
      if (look.bone && r() < 0.5) fill((f, x) => (x % 2 && f === 4 ? mul(BONE, 0.8) : BONE));
      break;
  }
}

interface Ctx {
  W: number; H: number; D: number;
  rects: [number, number, number, number][];
  put: (f: number, x: number, y: number, c: RGB, glow?: number, cut?: boolean) => void;
  fill: (col: (f: number, x: number, y: number, fw: number, fh: number) => RGB, glow?: number) => void;
  r: () => number;
  name: string;
}

/** Zombie-only surfaces. */
function paintSurface(src: PartSrc, pp: PersonPalette, look: ZombieLook, c: Ctx): void {
  const { rects, put, fill, r } = c;
  switch (src.zr) {
    case 'jaw': {
      // front: a row of lower teeth over a dark mouth, then the chin; a maw is raw inside
      const raw = look.fx.includes('maw');
      fill((f, x, y, fw, fh) => {
        if (f === 1) {
          const v = (y + 0.5) / fh;
          if (v < 0.34) return look.bone ? [214, 204, 172] : x % 2 ? [176, 164, 118] : [200, 188, 138];
          if (v < 0.6 && !look.bone) return raw ? [120, 24, 30] : [44, 12, 14];
          return mul(pp.skin, 0.86);
        }
        // the top of the jaw shows inside the open mouth: tongue and gums
        if (f === 4) return look.bone ? [40, 34, 30] : raw ? [150, 40, 46] : [96, 30, 32];
        return mul(pp.skin, f === 5 ? 0.7 : 0.85);
      });
      if (look.undead && !look.bone && !look.fx.includes('tendrils')) {
        const [, , fw, fh] = rects[1];
        put(1, Math.floor(fw * (0.3 + 0.4 * r())), fh - 1, BLOOD[0]);
        put(1, Math.floor(fw * (0.3 + 0.4 * r())), fh - 2, BLOOD[1]);
      }
      break;
    }
    case 'belly': {
      // a belly bursting out of the shirt: pale stretched skin, a band of shirt over the top,
      // dark veins and stretch marks, a navel; a boomer's is blotched with bile
      const bloat = look.build === 'bloated';
      const sk = look.bone ? BONE : mix(pp.skin, [196, 200, 176], bloat ? 0.35 : 0.2);
      fill((f, x, y, fw, fh) => {
        const v = (y + 0.5) / fh, u = (x + 0.5) / fw;
        if (f === 4 || (f < 4 && v < (bloat ? 0.16 : 0.3))) return pp.shirt;
        if (f === 1 && Math.abs(u - 0.5) < 0.6 / fw && Math.abs(v - 0.62) < 0.6 / fh) return mul(sk, 0.45);
        if ((x * 5 + y * 3) % 11 === 0) return mul(sk, 0.78);
        if (bloat && Math.sin(x * 1.7 + y * 0.9) + Math.sin(y * 1.3 - x * 0.6) > 1.5) return [150, 96, 136];
        return sk;
      });
      if (look.undead) for (let i = 0; i < 3; i++) put(1, Math.floor(r() * rects[1][2]), Math.floor(rects[1][3] * (0.3 + 0.6 * r())), BLOOD[1]);
      break;
    }
    case 'rag': {
      // torn cloth: the shirt (or sleeve, or the part's own colour), a frayed bottom edge cut
      // out column by column, a few holes
      const base: RGB = src.color ?? (src.role === 'wing' ? [74, 62, 60] : src.region === 'upperArm' ? pp.upperArm : look.gear === 'scientist' ? [214, 216, 210] : pp.shirt);
      const stripe = look.gear === 'fireman';
      for (let f = 0; f < 6; f++) {
        const [, , fw, fh] = rects[f];
        const cutDepth = f < 4 ? Array.from({ length: fw }, () => Math.floor(r() * fh * 0.45)) : [];
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
          let col = mul(base, 0.95 + 0.1 * ((x * 7 + y * 3) % 3 === 0 ? -1 : 0) - 0.12 * (y / fh));
          let glow = 0;
          if (stripe && Math.abs(y / fh - 0.62) < 0.08) (col = [226, 220, 150], glow = 0.25);
          const cut = f < 4 && (y >= fh - cutDepth[x] || r() < 0.04);
          put(f, x, y, col, glow, cut);
        }
      }
      break;
    }
    case 'gear': {
      const base: RGB = src.color ?? [70, 72, 78];
      fill((f, x, y, fw, fh) => {
        // a 1-texel lighter edge on top surfaces reads as a hard shell
        if (f < 4 && y === 0) return mul(base, 1.25);
        if (f === 4 && (x === 0 || x === fw - 1)) return mul(base, 1.1);
        void fh;
        return base;
      }, src.glow ?? 0);
      break;
    }
    case 'visor': {
      const base: RGB = src.color ?? [40, 50, 70];
      fill((f, x, y, fw, fh) => (f === 1 && x === y + Math.floor(fw / 3) ? mix(base, [255, 255, 255], 0.5) : f === 1 ? base : mul(base, 0.6 + 0.0 * fh)), src.glow ?? 0);
      break;
    }
    case 'sac': {
      // glowing acid: a bright core, darker veins
      const [, , fw1, fh1] = rects[1];
      fill((f, x, y, fw, fh) => {
        const cx = Math.abs((x + 0.5) / fw - 0.5), cy = Math.abs((y + 0.5) / fh - 0.5);
        if ((x * 3 + y * 5) % 7 === 0) return [112, 150, 34];
        return cx + cy < 0.35 ? [232, 255, 120] : [176, 222, 56];
      }, src.glow ?? 0.6);
      void fw1; void fh1;
      break;
    }
    case 'bone':
      fill((f, x, y, fw) => (f < 4 && (x === 0 || x === fw - 1) ? mul(BONE, 0.8) : BONE));
      break;
    case 'plant': {
      const greens: RGB[] = [[86, 140, 60], [120, 172, 80], [60, 100, 44], [150, 194, 92], [44, 72, 34]];
      fill(() => greens[Math.floor(r() * greens.length)]);
      break;
    }
    case 'thorn':
      // green at the root, a yellow-brown point (the tip is the +y end: the top rows)
      fill((f, _x, y, _fw, fh) => (f === 4 || (f < 4 && y < fh * 0.35) ? [212, 178, 64] : [92, 132, 58]));
      break;
    case 'smoke': {
      // dithered grey: half the texels cut out, so the puff reads as thin smoke over the body
      for (let f = 0; f < 6; f++) {
        const [, , fw, fh] = rects[f];
        for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
          // light grey, a third of the texels missing at random: a ragged puff, not a checker
          const g = 118 + Math.floor(r() * 40);
          put(f, x, y, [g, g, g + 4], 0, r() < 0.38);
        }
      }
      break;
    }
    case 'arc':
      if (src.color) fill(() => src.color!, src.glow ?? 1);
      else fill((f, x) => (x % 2 && f < 4 ? [235, 245, 255] : [140, 196, 255]), src.glow ?? 1);
      break;
    case 'flesh':
      // a torn-off limb end: raw meat round a bone stub
      fill((f, x, y, fw, fh) => (f === 5 && Math.abs(x - fw / 2) < 1.2 && Math.abs(y - fh / 2) < 1.2 ? BONE : r() < 0.3 ? BLOOD[1] : [150, 40, 40]));
      break;
    case 'tendril':
      fill((f, x, y) => ((x + y * 2) % 5 === 0 ? [62, 34, 70] : NECRO));
      break;
  }
  void lum;
}

/** Uniform details painted over the clothes (camo blotches, reflective stripes). */
function uniformDetail(look: ZombieLook, region: Region, rects: [number, number, number, number][], put: Ctx['put'], get: (f: number, x: number, y: number) => RGB, r: () => number): void {
  if (look.gear === 'soldier') {
    // woodland camo blotches over the sprite's olive
    for (let f = 0; f < 4; f++) {
      const [, , fw, fh] = rects[f];
      for (let i = 0; i < Math.max(1, Math.round((fw * fh) / 10)); i++) {
        const x = Math.floor(r() * fw), y = Math.floor(r() * fh);
        const c = get(f, x, y);
        const k = r() < 0.5 ? 0.62 : 1.25;
        put(f, x, y, mul(c, k));
        put(f, Math.min(fw - 1, x + 1), y, mul(c, k));
      }
    }
  } else if (look.gear === 'fireman' && (region === 'torso' || region === 'foreArm' || region === 'shin')) {
    // reflective bands
    for (let f = 0; f < 4; f++) {
      const [, , fw, fh] = rects[f];
      const y = Math.floor(fh * (region === 'torso' ? 0.72 : 0.5));
      for (let x = 0; x < fw; x++) put(f, x, y, [228, 222, 160], 0.25);
    }
  }
}

/** Glowing blotches (acid seeping through the skin and clothes). */
function blotch(rects: [number, number, number, number][], put: Ctx['put'], r: () => number, c: RGB, n: number, glow: number): void {
  for (let i = 0; i < n; i++) {
    const f = Math.floor(r() * 4);
    const [, , fw, fh] = rects[f];
    const x = Math.floor(r() * fw), y = Math.floor(r() * fh);
    put(f, x, y, c, glow);
    if (fw > 3) put(f, x + (x < fw - 1 ? 1 : -1), y, mul(c, 0.85), glow);
  }
}

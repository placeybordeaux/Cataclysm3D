import type { RGB } from '../colors';
import { hash2 } from '../ground';
import { inset, slats } from './paint';
import { DARK_METAL, F, STEEL, barX, barY, bodyOf, hsv, lumOf, metalOf, num, shade, woodOf, type Build } from './kit';

// Street furniture, yard and roof props, graves and rocks.

/** Curbside mailbox: post + rounded-top box with a flag. */
export const mailbox: Build = (b, c) => {
  const body: RGB = c.pal.clusters.find((q) => hsv(q.c)[1] > 0.3 && lumOf(q.c) > 40)?.c ?? [60, 70, 110];
  b.box(-0.04, 0, -0.04, 0.04, 1.0, 0.04, F('wood', woodOf(c.pal, [110, 80, 50])), 'ny');
  b.box(-0.12, 1.0, -0.25, 0.12, 1.16, 0.25, F('paint', body));
  // rounded top: a half prism along z
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI, a1 = ((i + 1) / n) * Math.PI;
    const p = (a: number, z: number): [number, number, number] => [Math.cos(a) * 0.12, 1.16 + Math.sin(a) * 0.1, z];
    b.quad(p(a0, 0.25), p(a0, -0.25), p(a1, -0.25), p(a1, 0.25), F('paint', shade(body, 1.05)));
    b.quad(p(a1, 0.25), [0, 1.16, 0.25], [0, 1.16, 0.25], p(a0, 0.25), F('paint', shade(body, 0.95)));
    b.quad(p(a0, -0.25), [0, 1.16, -0.25], [0, 1.16, -0.25], p(a1, -0.25), F('paint', shade(body, 0.9)));
  }
  b.box(0.12, 1.08, 0.0, 0.14, 1.36, 0.04, F('paint', [200, 50, 40]));
};

/** Street light: tall tapered pole, an arm over the road, a lamp head. */
export const streetLight: Build = (b, c) => {
  const col = metalOf(c.pal, [90, 96, 100]);
  const M = F('metal', col);
  b.prism(0, 0, 0, 0.3, 0.16, 8, F('stone', [130, 128, 122]));
  b.frustum(-0.08, -0.08, 0.08, 0.08, 0.3, 6.5, -0.05, -0.05, 0.05, 0.05, M, 'ny');
  b.box(-0.04, 6.3, -0.04, 0.04, 6.38, 1.2, M);
  b.box(-0.14, 6.22, 0.9, 0.14, 6.36, 1.45, M);
  b.box(-0.12, 6.2, 0.93, 0.12, 6.22, 1.42, F('glow', [250, 236, 190]), 'py');
};

/** Traffic light: pole with a signal head. */
export const trafficLight: Build = (b, c) => {
  const M = F('metal', metalOf(c.pal, [70, 74, 70]));
  b.prism(0, 0, 0, 3.2, 0.08, 8, M);
  b.box(-0.16, 2.2, -0.12, 0.16, 3.1, 0.12, (f) => (f === 'pz' || f === 'nz' ? F('paint', [40, 42, 40], lights3()) : F('paint', [40, 42, 40])));
};
function lights3() {
  return {
    k: 'tl3',
    draw(img: { w: number; h: number; set: (x: number, y: number, c: RGB) => void }) {
      const cols: RGB[] = [[200, 50, 40], [220, 170, 40], [60, 190, 90]];
      for (let i = 0; i < 3; i++) {
        const cy = ((i + 0.5) / 3) * img.h, cx = img.w / 2, R = img.w * 0.3;
        for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < R) img.set(x, y, cols[i]);
      }
    },
  };
}

/** Wooden utility pole with a cross arm. */
export const utilityPole: Build = (b, c) => {
  const wood = woodOf(c.pal, [96, 74, 52]);
  b.prism(0, 0, 0, 8, 0.13, 8, F('wood', wood), F('wood', shade(wood, 0.8)));
  b.box(-0.9, 7.3, -0.06, 0.9, 7.42, 0.06, F('wood', wood));
  for (const x of [-0.8, -0.3, 0.3, 0.8]) b.box(x - 0.03, 7.42, -0.03, x + 0.03, 7.55, 0.03, F('enamel', [210, 210, 200]), 'ny');
};

/** Sign on a post (the sprite's colours on the board). */
export const sign: Build = (b, c) => {
  const board = bodyOf(c.pal);
  b.box(-0.03, 0, -0.03, 0.03, 1.5, 0.03, F('metal', [130, 134, 136]), 'ny');
  b.box(-0.35, 1.3, 0.03, 0.35, 1.9, 0.06, (f) => (f === 'pz' ? F('paint', board, inset(0.1, 0.2, 0.9, 0.8, shade(board, 0.6), false, false)) : F('paint', shade(board, 0.9))));
};

/** Headstone: slab with a rounded top on a plinth; `old` leans and is weathered. */
export const gravestone: Build = (b, c) => {
  const stone: RGB = metalOf(c.pal, [128, 128, 124]);
  const old = c.p.old === true;
  const S = F('stone', old ? shade(stone, 0.85) : stone);
  b.box(-0.3, 0, -0.12, 0.3, 0.08, 0.14, F('stone', shade(stone, 0.8)), 'ny');
  const tilt = old ? ((c.seed & 3) - 1.5) * 0.06 : 0;
  b.tiltedBox(-0.24, 0.24, 0.08, -0.06, 0.62, 0.12, tilt, (f) => (f === 'pz' ? F('stone', old ? shade(stone, 0.85) : stone, inset(0.25, 0.3, 0.75, 0.36, shade(stone, 0.6), false, false)) : S));
  if (!old) b.tiltedBox(-0.18, 0.18, 0.7, -0.06, 0.08, 0.12, tilt, S);
};

/** Grave monument: obelisk on a base. */
export const monument: Build = (b, c) => {
  const stone = metalOf(c.pal, [150, 148, 140]);
  b.box(-0.35, 0, -0.35, 0.35, 0.3, 0.35, F('stone', shade(stone, 0.85)), 'ny');
  b.frustum(-0.2, -0.2, 0.2, 0.2, 0.3, 1.9, -0.12, -0.12, 0.12, 0.12, F('stone', stone), 'ny');
  b.frustum(-0.12, -0.12, 0.12, 0.12, 1.9, 2.1, 0, 0, 0, 0, F('stone', stone), 'nypy');
};

/** Grave mound / head: a low earth mound. */
export const graveMound: Build = (b, c) => {
  b.frustum(-0.4, -0.45, 0.4, 0.45, 0, 0.18, -0.3, -0.36, 0.3, 0.36, F('soil', [96, 74, 52]), 'ny');
  void c;
};

/**
 * Boulder / rock: a few jittered frustums, rotated by seed, stone from the sprite. `r` sets
 * the size (small / medium / large).
 */
export const boulder: Build = (b, c) => {
  const stone = metalOf(c.pal, [118, 116, 110]);
  const r = num(c, 'r', 0.3);
  const H = (k: number) => (hash2(c.seed, k, 77) % 1000) / 1000;
  const lumps = r > 0.4 ? 3 : 2;
  for (let i = 0; i < lumps; i++) {
    const cx = (H(i * 3) - 0.5) * r * 0.6, cz = (H(i * 3 + 1) - 0.5) * r * 0.6;
    const rr = r * (0.65 + H(i * 3 + 2) * 0.35) * (i ? 0.75 : 1);
    const h = rr * (1.0 + H(i + 9) * 0.5);
    const w = rr * (0.8 + H(i + 20) * 0.4);
    b.frustum(cx - w, cz - rr, cx + w, cz + rr, 0, h * 0.55, cx - w * 1.05, cz - rr * 1.02, cx + w * 1.02, cz + rr * 1.05, F('stone', shade(stone, 0.9 + H(i + 30) * 0.15)), 'ny');
    b.frustum(cx - w * 1.05, cz - rr * 1.02, cx + w * 1.02, cz + rr * 1.05, h * 0.55, h, cx - w * 0.45, cz - rr * 0.4, cx + w * 0.5, cz + rr * 0.45, F('stone', shade(stone, 1.0 + H(i + 40) * 0.1)), 'ny');
  }
};

/** Loose rubble: a scatter of small chunks. */
export const rubble: Build = (b, c) => {
  const stone = metalOf(c.pal, [120, 116, 108]);
  for (let i = 0; i < 9; i++) {
    const x = ((hash2(c.seed, i, 1) % 100) / 100 - 0.5) * 0.8, z = ((hash2(c.seed, i, 2) % 100) / 100 - 0.5) * 0.8;
    const s = 0.05 + (hash2(c.seed, i, 3) % 100) / 100 * 0.12;
    b.frustum(x - s, z - s, x + s, z + s, 0, s * 1.2, x - s * 0.5, z - s * 0.6, x + s * 0.4, z + s * 0.5, F('stone', shade(stone, 0.8 + (i % 3) * 0.12)), 'ny');
  }
};

/** Birdbath: pedestal and a shallow bowl. */
export const birdbath: Build = (b, c) => {
  const stone = metalOf(c.pal, [160, 158, 150]);
  b.prism(0, 0, 0, 0.08, 0.2, 8, F('stone', stone));
  b.prism(0, 0, 0.08, 0.7, 0.08, 8, F('stone', stone), null);
  b.frustum(-0.12, -0.12, 0.12, 0.12, 0.7, 0.85, -0.32, -0.32, 0.32, 0.32, F('stone', stone), 'py');
  b.box(-0.28, 0.83, -0.28, 0.28, 0.84, 0.28, F('glow', [120, 150, 170]), 'ny');
};

/** Rotary clothesline: pole with four arms and lines. */
export const clothesline: Build = (b, c) => {
  const M = F('chrome', STEEL);
  b.box(-0.025, 0, -0.025, 0.025, 1.9, 0.025, M, 'ny');
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    b.box(Math.min(0, dx * 0.9) - 0.01, 1.85, Math.min(0, dz * 0.9) - 0.01, Math.max(0, dx * 0.9) + 0.01, 1.87, Math.max(0, dz * 0.9) + 0.01, M);
  }
  void c;
};

/** Roof vent pipe / chimney stack / turbine vent / antenna / dish. */
export const roofProp: Build = (b, c) => {
  const kind = c.p.kind;
  if (kind === 'chimney') {
    const brick: RGB = [130, 70, 54];
    b.box(-0.3, 0, -0.3, 0.3, 1.2, 0.3, F('brick', brick), 'ny');
    b.box(-0.34, 1.2, -0.34, 0.34, 1.28, 0.34, F('stone', [110, 106, 100]));
  } else if (kind === 'turbine') {
    b.prism(0, 0, 0, 0.3, 0.12, 8, F('metal', STEEL), null);
    b.prism(0, 0, 0.3, 0.55, 0.22, 10, F('chrome', [180, 184, 186], slats(6, 0)), F('chrome', [190, 192, 194]));
  } else if (kind === 'antenna') {
    const M = F('metal', [120, 124, 126]);
    b.box(-0.02, 0, -0.02, 0.02, 2.2, 0.02, M, 'ny');
    for (let i = 0; i < 5; i++) b.box(-0.35 + i * 0.04, 1.6 + i * 0.12, -0.01, 0.35 - i * 0.04, 1.62 + i * 0.12, 0.01, M);
  } else if (kind === 'dish') {
    b.box(-0.02, 0, -0.02, 0.02, 0.6, 0.02, F('metal', [120, 124, 126]), 'ny');
    b.tiltedBox(-0.25, 0.25, 0.4, 0.05, 0.5, 0.04, -0.5, F('enamel', [210, 210, 206]));
  } else {
    b.prism(0, 0, 0, num(c, 'h', 0.6), 0.06, 8, F('metal', [80, 84, 88]), F('dark', DARK_METAL));
  }
};

/** Solar panel on a frame. */
export const solarPanel: Build = (b, c) => {
  b.box(-0.03, 0, -0.03, 0.03, 0.5, 0.03, F('metal', STEEL), 'ny');
  b.tiltedBox(-0.45, 0.45, 0.45, 0.4, 0.8, 0.03, 0.6, (f) => (f === 'pz' || f === 'py' ? F('screen', [40, 60, 110], slats(5, 0)) : F('metal', STEEL)));
  void c;
};

/** Flagpole with a flag in the sprite's colours. */
export const flagpole: Build = (b, c) => {
  b.prism(0, 0, 0, 6, 0.04, 6, F('chrome', STEEL));
  const col = bodyOf(c.pal);
  b.box(0.04, 5.1, -0.005, 0.95, 5.7, 0.005, F('fabric', col));
};

/** A standing wooden target / punching bag / generic post. */
export const post: Build = (b, c) => {
  barY(b, 0, 0, num(c, 'h', 1.2), 0, 0.1, F('wood', woodOf(c.pal, [110, 80, 50])));
};

/** Metal dive block / generic stepped pedestal. */
export const pedestal: Build = (b, c) => {
  const col = bodyOf(c.pal);
  b.box(-0.3, 0, -0.35, 0.3, num(c, 'h', 0.7), 0.35, F('paint', col), 'ny');
  barX(b, -0.3, 0.3, 0.72, -0.35, 0.03, F('chrome', STEEL));
};

/** Stone slab / plinth block. */
export const slab: Build = (b, c) => {
  const stone = metalOf(c.pal, [140, 138, 132]);
  b.box(-0.45, 0, -0.45, 0.45, num(c, 'h', 0.5), 0.45, F('stone', stone), 'ny');
};

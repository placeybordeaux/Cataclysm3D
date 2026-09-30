import type { RGB } from '../colors';
import type { ModelBuilder } from './mesh';
import { books, doors, drawers, slats } from './paint';
import {
  BACK, BLACK_PLASTIC, BRASS, DARK_METAL, F, FRONT, LEFT, RIGHT, STEEL, barX, barY, bodyOf, hsv, legs, lerp, lumOf, metalOf, num, shade, spanX, spanZ, whiteOf, woodOf,
  type Build, type Ctx,
} from './kit';

// Archetypes for rooms: seating, tables, beds, storage. Each builds one tile's piece in
// local space (front = +z), using the palette of its UltiCa sprite for materials.

// --- seating --------------------------------------------------------------------------------

/** Dining/kitchen chair: four legs, seat, slatted back. p.material 'metal' = folding/steel. */
export const chair: Build = (b, c) => {
  const metal = c.p.material === 'metal';
  const wood = metal ? metalOf(c.pal) : woodOf(c.pal, c.pal.main);
  const legS = metal ? F('metal', shade(wood, 0.8)) : F('wood', shade(wood, 0.85));
  const seatC = c.p.cushion ? bodyOf(c.pal) : wood;
  const sy = 0.45, half = 0.21, t = metal ? 0.025 : 0.04;
  legs(b, -half, -half, half, half, sy - 0.04, t, legS, 0.01);
  b.box(-half, sy - 0.04, -half, half, sy, half, (f) => (f === 'py' && c.p.cushion ? F('fabric', seatC) : metal ? F('metal', wood) : F('wood', seatC)));
  // back: two posts continuing the rear legs, a top rail and slats
  const by0 = sy, by1 = 0.95;
  b.box(-half + 0.01, by0, -half + 0.01, -half + 0.01 + t, by1, -half + 0.01 + t, legS, 'ny');
  b.box(half - 0.01 - t, by0, -half + 0.01, half - 0.01, by1, -half + 0.01 + t, legS, 'ny');
  b.box(-half + 0.01, by1 - 0.1, -half + 0.012, half - 0.01, by1, -half + 0.01 + t - 0.002, metal ? F('metal', wood) : F('wood', wood));
  if (!metal) for (const x of [-0.08, 0, 0.08]) b.box(x - 0.016, by0 + 0.06, -half + 0.018, x + 0.016, by1 - 0.1, -half + 0.01 + t - 0.008, F('wood', shade(wood, 0.95)), 'nypy');
  // stretcher
  b.box(-half + 0.02, 0.12, -0.01, half - 0.02, 0.15, 0.01, legS);
};

/** Bar/kitchen stool: round seat on four splayed-ish legs with a foot ring. */
export const stool: Build = (b, c) => {
  const wood = woodOf(c.pal, c.pal.main);
  const legS = F('wood', shade(wood, 0.8));
  const h = num(c, 'h', 0.62);
  for (const [x, z] of [[-0.15, -0.15], [0.12, -0.15], [0.12, 0.12], [-0.15, 0.12]]) b.frustum(x, z, x + 0.035, z + 0.035, 0, h - 0.03, x * 0.6 + 0.006, z * 0.6 + 0.006, x * 0.6 + 0.035, z * 0.6 + 0.035, legS, 'ny');
  b.prism(0, 0, h - 0.04, h, 0.17, 10, F('wood', wood));
  b.box(-0.14, 0.22, -0.14, 0.14, 0.245, 0.14, legS, 'py');
};

/** Log stool / stump seat. */
export const logStool: Build = (b, c) => {
  const bark = woodOf(c.pal, [92, 64, 40]);
  b.prism(0, 0, 0, 0.45, 0.22, 8, F('wood', shade(bark, 0.8)), F('wood', lerp(bark, [200, 170, 120], 0.45)));
};

/** Sofa / armchair / couch: base, seat cushions, back, arms on unconnected ends. */
export const sofa: Build = (b, c) => {
  const up = bodyOf(c.pal);
  const leather = c.p.leather === true;
  const cloth = (col: RGB) => (leather ? F('leather', col) : F('fabric', col));
  const wood = woodOf(c.pal, [70, 48, 32]);
  const [x0, x1] = spanX(c, 0.46);
  const z0 = -0.42, z1 = 0.42;
  // short feet
  const feet: [number, number][] = [];
  if (!c.conn[LEFT]) feet.push([x0 + 0.03, z0 + 0.03], [x0 + 0.03, z1 - 0.07]);
  if (!c.conn[RIGHT]) feet.push([x1 - 0.07, z0 + 0.03], [x1 - 0.07, z1 - 0.07]);
  for (const [x, z] of feet) b.box(x, 0, z, x + 0.04, 0.08, z + 0.04, F('wood', wood), 'ny');
  // base frame
  b.box(x0, 0.08, z0, x1, 0.3, z1, cloth(shade(up, 0.85)), (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : '') + 'ny');
  // back
  const armW = 0.14;
  const bx0 = c.conn[LEFT] ? -0.5 : x0, bx1 = c.conn[RIGHT] ? 0.5 : x1;
  b.box(bx0, 0.3, z0, bx1, 0.82, z0 + 0.2, cloth(up), (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
  // rounded top roll of the back
  b.box(bx0 + (c.conn[LEFT] ? 0 : 0.01), 0.82, z0 + 0.01, bx1 - (c.conn[RIGHT] ? 0 : 0.01), 0.87, z0 + 0.19, cloth(shade(up, 1.08)), (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : '') + 'ny');
  // seat cushion(s)
  const sx0 = c.conn[LEFT] ? -0.5 : x0 + armW, sx1 = c.conn[RIGHT] ? 0.5 : x1 - armW;
  const gap = 0.012;
  b.box(sx0 + (c.conn[LEFT] ? gap : 0), 0.3, z0 + 0.2, sx1 - (c.conn[RIGHT] ? gap : 0), 0.44, z1 - 0.01, cloth(shade(up, 1.04)));
  // back cushion leaning on the back
  b.tiltedBox(sx0 + 0.02, sx1 - 0.02, 0.42, z0 + 0.2, 0.36, 0.11, 0.18, cloth(up), 'ny');
  // arms
  if (!c.conn[LEFT]) b.box(x0, 0.3, z0, x0 + armW, 0.62, z1, cloth(shade(up, 0.95)), 'ny');
  if (!c.conn[RIGHT]) b.box(x1 - armW, 0.3, z0, x1, 0.62, z1, cloth(shade(up, 0.95)), 'ny');
};

/** Park/church bench: slatted seat and back on metal or wooden ends. */
export const bench: Build = (b, c) => {
  const wood = woodOf(c.pal, [128, 88, 52]);
  const metal = c.p.material === 'metal';
  const frameC = metal ? metalOf(c.pal, [58, 62, 58]) : shade(wood, 0.75);
  const frame = metal ? F('metal', frameC) : F('wood', frameC);
  const slat = metal ? F('metal', metalOf(c.pal, [120, 124, 128])) : F('wood', wood);
  const [x0, x1] = [c.conn[LEFT] ? -0.5 : -0.47, c.conn[RIGHT] ? 0.5 : 0.47];
  const back = c.p.back !== false;
  // ends (a leg frame at each unconnected end, and every tile's centre for long benches)
  const ends: number[] = [];
  if (!c.conn[LEFT]) ends.push(x0 + 0.03);
  if (!c.conn[RIGHT]) ends.push(x1 - 0.07);
  if (c.conn[LEFT] && c.conn[RIGHT]) ends.push(-0.02);
  for (const x of ends) {
    b.box(x, 0, -0.2, x + 0.04, 0.44, -0.16, frame, 'ny');
    b.box(x, 0, 0.14, x + 0.04, 0.44, 0.18, frame, 'ny');
    b.box(x, 0.36, -0.2, x + 0.04, 0.4, 0.18, frame);
    if (back) b.tiltedBox(x, x + 0.04, 0.44, -0.2, 0.45, 0.04, 0.2, frame);
  }
  for (let i = 0; i < 4; i++) {
    const z = -0.2 + i * 0.1;
    b.box(x0, 0.43, z, x1, 0.46, z + 0.075, slat, (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
  }
  if (back) for (let i = 0; i < 3; i++) b.tiltedBox(x0, x1, 0.52 + i * 0.13, -0.2 - (0.08 + i * 0.13) * Math.sin(0.2) + 0.04, 0.09, 0.025, 0.2, slat, (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
};

/** Folding camp chair: fabric sling on an X frame. */
export const campChair: Build = (b, c) => {
  const cloth = bodyOf(c.pal);
  const frame = F('metal', [70, 72, 76]);
  for (const x of [-0.22, 0.2]) {
    b.tiltedBox(x, x + 0.02, 0, 0.18, 0.5, 0.02, 0.5, frame);
    b.tiltedBox(x, x + 0.02, 0, -0.2, 0.5, 0.02, -0.5, frame);
    b.box(x, 0.42, -0.2, x + 0.02, 0.44, 0.2, frame);
  }
  b.box(-0.22, 0.36, -0.18, 0.22, 0.4, 0.18, F('fabric', cloth));
  b.tiltedBox(-0.22, 0.22, 0.38, -0.2, 0.45, 0.02, 0.25, F('fabric', shade(cloth, 0.9)));
  b.tiltedBox(-0.22, 0.22, 0.38, -0.178, 0.45, 0.002, 0.25, F('fabric', shade(cloth, 0.8)), 'pz');
};

/** Reclining deck chair / sun lounger. */
export const deckChair: Build = (b, c) => {
  const cloth = bodyOf(c.pal);
  const wood = woodOf(c.pal, [150, 110, 70]);
  legs(b, -0.25, -0.45, 0.25, 0.45, 0.3, 0.04, F('wood', shade(wood, 0.85)), 0.02);
  b.box(-0.25, 0.3, -0.1, 0.25, 0.34, 0.45, F('fabric', cloth));
  b.tiltedBox(-0.25, 0.25, 0.3, -0.1, 0.55, 0.04, 0.9, F('fabric', shade(cloth, 0.95)));
};

// --- tables & desks -------------------------------------------------------------------------

/**
 * Table: top + apron + legs. Connected neighbours (4-way) merge into one long table: the top
 * reaches the tile edge and legs only stand at the outer corners.
 */
export const table: Build = (b, c) => {
  const wood = c.p.top === 'metal' ? metalOf(c.pal) : woodOf(c.pal, c.pal.top);
  const topC = c.p.cloth ? bodyOf(c.pal) : wood;
  const h = num(c, 'h', 0.76);
  const half = num(c, 'half', 0.47);
  const [x0, x1] = spanX(c, half);
  const [z0, z1] = spanZ(c, num(c, 'halfZ', half));
  const th = 0.045;
  const skip = (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : '') + (c.conn[BACK] ? 'nz' : '') + (c.conn[FRONT] ? 'pz' : '');
  const woodK = c.p.top === 'metal' ? 'metal' : 'wood';
  b.box(x0, h - th, z0, x1, h, z1, (f) => (f === 'py' ? F(c.p.cloth ? 'fabric' : woodK, topC) : F(woodK, shade(wood, 0.9))), skip);
  // apron under the top
  const ai = 0.07;
  const ax0 = c.conn[LEFT] ? -0.5 : x0 + ai, ax1 = c.conn[RIGHT] ? 0.5 : x1 - ai;
  const az0 = c.conn[BACK] ? -0.5 : z0 + ai, az1 = c.conn[FRONT] ? 0.5 : z1 - ai;
  const ap = F(woodK, shade(wood, 0.78));
  if (!c.conn[BACK]) b.box(ax0, h - th - 0.09, az0, ax1, h - th, az0 + 0.025, ap, 'py' + (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
  if (!c.conn[FRONT]) b.box(ax0, h - th - 0.09, az1 - 0.025, ax1, h - th, az1, ap, 'py' + (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
  if (!c.conn[LEFT]) b.box(ax0, h - th - 0.09, az0, ax0 + 0.025, h - th, az1, ap, 'py' + (c.conn[BACK] ? 'nz' : '') + (c.conn[FRONT] ? 'pz' : ''));
  if (!c.conn[RIGHT]) b.box(ax1 - 0.025, h - th - 0.09, az0, ax1, h - th, az1, ap, 'py' + (c.conn[BACK] ? 'nz' : '') + (c.conn[FRONT] ? 'pz' : ''));
  // legs at outer corners only
  const t = num(c, 'leg', 0.055);
  const legS = F(woodK, shade(wood, 0.72));
  const corner = (x: number, z: number) => b.box(x, 0, z, x + t, h - th, z + t, legS, 'nypy');
  if (!c.conn[LEFT] && !c.conn[BACK]) corner(x0 + 0.05, z0 + 0.05);
  if (!c.conn[RIGHT] && !c.conn[BACK]) corner(x1 - 0.05 - t, z0 + 0.05);
  if (!c.conn[RIGHT] && !c.conn[FRONT]) corner(x1 - 0.05 - t, z1 - 0.05 - t);
  if (!c.conn[LEFT] && !c.conn[FRONT]) corner(x0 + 0.05, z1 - 0.05 - t);
};

/** Desk: top, a drawer pedestal on one side, a modesty panel at the back. */
export const desk: Build = (b, c) => {
  const wood = woodOf(c.pal, c.pal.top);
  const metal = c.p.material === 'metal';
  const body = metal ? metalOf(c.pal, [110, 116, 112]) : shade(wood, 0.9);
  const K = metal ? 'metal' : 'wood';
  const h = 0.76;
  const [x0, x1] = spanX(c, 0.48);
  const z0 = -0.36, z1 = 0.36;
  b.box(x0, h - 0.04, z0, x1, h, z1, (f) => (f === 'py' ? F('wood', wood) : F('wood', shade(wood, 0.85))), (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
  // pedestal (on the right unless the right is connected)
  const pr = !c.conn[RIGHT];
  const pl = !pr && !c.conn[LEFT];
  if (pr || pl) {
    const px0 = pr ? x1 - 0.4 : x0, px1 = pr ? x1 : x0 + 0.4;
    b.box(px0, 0, z0 + 0.02, px1, h - 0.04, z1 - 0.02, (f) => (f === 'pz' ? F(K, body, drawers(3, 1, BRASS)) : F(K, shade(body, 0.92))), 'py');
    // the opposite side: a panel leg
    const lx0 = pr ? (c.conn[LEFT] ? null : x0) : (c.conn[RIGHT] ? null : x1 - 0.04);
    if (lx0 !== null) b.box(lx0, 0, z0 + 0.02, lx0 + 0.04, h - 0.04, z1 - 0.02, F(K, shade(body, 0.85)), 'py');
  }
  b.box(c.conn[LEFT] ? -0.5 : x0 + 0.04, 0.3, z0 + 0.03, c.conn[RIGHT] ? 0.5 : x1 - 0.04, h - 0.04, z0 + 0.05, F(K, shade(body, 0.8)), 'py');
};

/** Coffee table: low top on short legs with a lower shelf. */
export const coffeeTable: Build = (b, c) => {
  const wood = woodOf(c.pal, c.pal.top);
  const [x0, x1] = spanX(c, 0.42);
  const z0 = -0.28, z1 = 0.28;
  b.box(x0, 0.4, z0, x1, 0.44, z1, F('wood', wood), (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
  b.box(x0 + 0.05, 0.1, z0 + 0.05, x1 - 0.05, 0.12, z1 - 0.05, F('wood', shade(wood, 0.85)));
  legs(b, x0, z0, x1, z1, 0.4, 0.045, F('wood', shade(wood, 0.75)), 0.02, [...(c.conn[LEFT] ? [0, 3] : []), ...(c.conn[RIGHT] ? [1, 2] : [])]);
};

/** Pool table: green felt, wooden rails, pockets, thick legs. Connects into a long table. */
export const poolTable: Build = (b, c) => {
  const wood = woodOf(c.pal, [92, 52, 30]);
  const felt: RGB = c.pal.clusters.find((q) => hsv(q.c)[0] > 80 && hsv(q.c)[0] < 170 && hsv(q.c)[1] > 0.3)?.c ?? [40, 110, 60];
  const [x0, x1] = spanX(c, 0.48);
  const [z0, z1] = spanZ(c, 0.45);
  const h = 0.8;
  b.box(x0, h - 0.12, z0, x1, h - 0.04, z1, F('wood', shade(wood, 0.8)), (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : '') + (c.conn[BACK] ? 'nz' : '') + (c.conn[FRONT] ? 'pz' : ''));
  b.box(x0, h - 0.04, z0, x1, h - 0.035, z1, F('felt', felt), 'nynxpxnzpz');
  const r = 0.07;
  const rail = F('wood', wood);
  if (!c.conn[BACK]) b.box(x0, h - 0.04, z0, x1, h + 0.04, z0 + r, rail);
  if (!c.conn[FRONT]) b.box(x0, h - 0.04, z1 - r, x1, h + 0.04, z1, rail);
  if (!c.conn[LEFT]) b.box(x0, h - 0.04, z0, x0 + r, h + 0.04, z1, rail);
  if (!c.conn[RIGHT]) b.box(x1 - r, h - 0.04, z0, x1, h + 0.04, z1, rail);
  const pocket = F('dark', [20, 20, 20]);
  const P = (x: number, z: number) => b.box(x - 0.03, h - 0.03, z - 0.03, x + 0.03, h - 0.028, z + 0.03, pocket, 'ny');
  if (!c.conn[LEFT] && !c.conn[BACK]) P(x0 + r + 0.03, z0 + r + 0.03);
  if (!c.conn[RIGHT] && !c.conn[BACK]) P(x1 - r - 0.03, z0 + r + 0.03);
  if (!c.conn[LEFT] && !c.conn[FRONT]) P(x0 + r + 0.03, z1 - r - 0.03);
  if (!c.conn[RIGHT] && !c.conn[FRONT]) P(x1 - r - 0.03, z1 - r - 0.03);
  const legS = F('wood', shade(wood, 0.7));
  if (!c.conn[LEFT] && !c.conn[BACK]) b.box(x0 + 0.06, 0, z0 + 0.06, x0 + 0.16, h - 0.12, z0 + 0.16, legS, 'ny');
  if (!c.conn[RIGHT] && !c.conn[BACK]) b.box(x1 - 0.16, 0, z0 + 0.06, x1 - 0.06, h - 0.12, z0 + 0.16, legS, 'ny');
  if (!c.conn[RIGHT] && !c.conn[FRONT]) b.box(x1 - 0.16, 0, z1 - 0.16, x1 - 0.06, h - 0.12, z1 - 0.06, legS, 'ny');
  if (!c.conn[LEFT] && !c.conn[FRONT]) b.box(x0 + 0.06, 0, z1 - 0.16, x0 + 0.16, h - 0.12, z1 - 0.06, legS, 'ny');
};

// --- beds -----------------------------------------------------------------------------------

/**
 * Bed: frame, mattress, sheet/blanket, pillow at the head (back, against the wall). Beds
 * that continue forward (2-tile beds) drop the foot board on the head tile and the pillow and
 * headboard on the foot tile; side-by-side beds merge into a double.
 */
export const bed: Build = (b, c) => {
  const wood = woodOf(c.pal, [110, 70, 40]);
  const sheet = whiteOf(c.pal, [214, 210, 196]);
  // blanket: a saturated sprite colour if there is one, else a muted blue
  const blanket: RGB = c.pal.clusters.find((q) => hsv(q.c)[1] > 0.35 && !(hsv(q.c)[0] > 10 && hsv(q.c)[0] < 45) && lumOf(q.c) > 40)?.c ?? [70, 88, 120];
  const head = !c.conn[BACK], foot = !c.conn[FRONT];
  const [x0, x1] = spanX(c, 0.46);
  const z0 = head ? -0.48 : -0.5, z1 = foot ? 0.47 : 0.5;
  const sk = (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : '');
  const frame = F('wood', shade(wood, 0.85));
  b.box(x0, 0.12, z0, x1, 0.3, z1, frame, sk + (head ? '' : 'nz') + (foot ? '' : 'pz'));
  legs(b, x0, z0, x1, z1, 0.12, 0.06, F('wood', shade(wood, 0.7)), 0.02, [...(c.conn[LEFT] ? [0, 3] : []), ...(c.conn[RIGHT] ? [1, 2] : []), ...(head ? [] : [0, 1]), ...(foot ? [] : [2, 3])]);
  // mattress
  const mx0 = c.conn[LEFT] ? -0.5 : x0 + 0.02, mx1 = c.conn[RIGHT] ? 0.5 : x1 - 0.02;
  const mz0 = head ? z0 + 0.06 : -0.5, mz1 = foot ? z1 - 0.03 : 0.5;
  const bare = c.p.frameOnly === true;
  if (bare) {
    // a bed frame without bedding: slats across the rails
    for (let z = mz0 + 0.05; z < mz1 - 0.04; z += 0.16) b.box(mx0, 0.27, z, mx1, 0.3, z + 0.08, F('wood', shade(wood, 0.95)), sk + 'ny');
  } else b.box(mx0, 0.3, mz0, mx1, 0.46, mz1, F('mattress', sheet), sk + (head ? '' : 'nz') + (foot ? '' : 'pz') + 'ny');
  // blanket over the foot 2/3 (on 2-tile beds: all of the foot tile, a bit of the head tile)
  const bz0 = head && foot ? mz0 + 0.32 : head ? mz0 + 0.55 : -0.5;
  if (!bare) b.box(mx0 - (c.conn[LEFT] ? 0 : 0.015), 0.35, bz0, mx1 + (c.conn[RIGHT] ? 0 : 0.015), 0.475, mz1 + (foot ? 0.015 : 0), F('fabric', blanket), sk + (foot ? '' : 'pz') + 'ny');
  // turned-down sheet edge (on the head tile: on the foot tile of a 2-tile bed it would
  // cross the blanket at the tile seam)
  if (head && !bare) b.box(mx0 - (c.conn[LEFT] ? 0 : 0.016), 0.44, bz0 - 0.001, mx1 + (c.conn[RIGHT] ? 0 : 0.016), 0.478, bz0 + 0.07, F('sheet', sheet), sk + 'ny');
  if (head) {
    // headboard + pillow(s)
    b.box(x0, 0.12, z0, x1, 0.95, z0 + 0.06, (f) => (f === 'pz' ? F('wood', wood, slats(3, 4)) : F('wood', shade(wood, 0.9))), sk);
    const pw = c.conn[LEFT] || c.conn[RIGHT] ? 0.36 : 0.5;
    const pcx = c.conn[RIGHT] && !c.conn[LEFT] ? mx0 + 0.25 : c.conn[LEFT] && !c.conn[RIGHT] ? mx1 - 0.25 : (mx0 + mx1) / 2;
    if (!bare) b.box(pcx - pw / 2, 0.46, mz0 + 0.04, pcx + pw / 2, 0.56, mz0 + 0.3, F('sheet', shade(sheet, 1.05)), 'ny');
  }
  if (foot && c.p.footboard !== false) b.box(x0, 0.12, z1 - 0.05, x1, 0.62, z1, F('wood', wood), sk);
};

/** Bunk bed: two stacked single beds on posts with a ladder. */
export const bunkBed: Build = (b, c) => {
  const wood = woodOf(c.pal, [110, 70, 40]);
  const sheet = whiteOf(c.pal);
  const blanket: RGB = [72, 92, 70];
  const frame = F('wood', shade(wood, 0.85));
  const levels = c.p.triple ? [0.2, 0.95, 1.7] : [0.2, 1.15];
  const top = levels[levels.length - 1] + 0.55;
  for (const [x, z] of [[-0.47, -0.47], [0.41, -0.47], [0.41, 0.41], [-0.47, 0.41]]) b.box(x, 0, z, x + 0.06, top, z + 0.06, frame, 'ny');
  for (const y of levels) {
    b.box(-0.45, y, -0.45, 0.45, y + 0.1, 0.45, frame);
    b.box(-0.43, y + 0.1, -0.43, 0.43, y + 0.24, 0.43, F('mattress', sheet), 'ny');
    b.box(-0.44, y + 0.18, -0.1, 0.44, y + 0.26, 0.44, F('fabric', blanket), 'ny');
    b.box(-0.2, y + 0.24, -0.4, 0.2, y + 0.32, -0.2, F('sheet', sheet), 'ny');
  }
  // guard rail on the upper bunk(s), ladder at the right end of the front
  for (const y of levels.slice(1)) b.box(-0.41, y + 0.3, 0.42, 0.2, y + 0.36, 0.46, frame);
  for (let y = 0.35; y < top - 0.3; y += 0.3) b.box(0.24, y, 0.44, 0.41, y + 0.03, 0.47, frame);
  b.box(0.22, 0, 0.44, 0.25, top - 0.2, 0.47, frame, 'ny');
};

/** Mattress / bedroll / straw bed lying on the floor. */
export const floorBed: Build = (b, c) => {
  const col = c.p.straw ? ([196, 170, 96] as RGB) : bodyOf(c.pal);
  const h = num(c, 'h', 0.18);
  const [x0, x1] = spanX(c, 0.45);
  const [z0, z1] = spanZ(c, 0.47);
  b.box(x0, 0, z0, x1, h, z1, F(c.p.straw ? 'soil' : 'mattress', col), 'ny');
  if (!c.conn[BACK] && !c.p.straw) b.box(-0.2, h, z0 + 0.04, 0.2, h + 0.08, z0 + 0.28, F('sheet', whiteOf(c.pal)), 'ny');
};

// --- storage --------------------------------------------------------------------------------

/** Chest of drawers. */
export const dresser: Build = (b, c) => {
  const wood = woodOf(c.pal, c.pal.front);
  const w = 0.46, d = 0.24, h = num(c, 'h', 0.92);
  b.box(-w, 0.06, -d, w, h - 0.03, d, (f) => (f === 'pz' ? F('wood', wood, drawers(num(c, 'rows', 3), num(c, 'cols', 2), BRASS)) : F('wood', shade(wood, 0.9))), 'py');
  b.box(-w - 0.015, h - 0.03, -d - 0.01, w + 0.015, h, d + 0.02, F('wood', shade(wood, 1.05)));
  b.box(-w + 0.02, 0, -d + 0.02, w - 0.02, 0.06, d - 0.02, F('wood', shade(wood, 0.65)), 'ny');
};

/** Tall cabinet with doors: wardrobe, glass cabinet, gun cabinet... */
export const wardrobe: Build = (b, c) => {
  const wood = woodOf(c.pal, c.pal.front);
  const w = 0.47, d = num(c, 'd', 0.29), h = num(c, 'h', 1.95);
  b.box(-w, 0.08, -d, w, h - 0.05, d, (f) => (f === 'pz' ? F('wood', wood, doors(num(c, 'doors', 2), BRASS)) : F('wood', shade(wood, 0.9))), 'py');
  b.box(-w - 0.02, h - 0.05, -d - 0.02, w + 0.02, h, d + 0.03, F('wood', shade(wood, 1.05)));
  b.box(-w + 0.01, 0, -d + 0.01, w - 0.01, 0.08, d - 0.01, F('wood', shade(wood, 0.65)), 'ny');
};

/** Bookcase: open front, shelves with rows of books. */
export const bookcase: Build = (b, c) => {
  const wood = woodOf(c.pal, [100, 66, 40]);
  const w = 0.46, d = 0.17, h = num(c, 'h', 1.9);
  const shelvesN = Math.round(h / 0.38);
  const side = F('wood', shade(wood, 0.9));
  b.box(-w, 0, -d, -w + 0.03, h, d, side, 'ny');
  b.box(w - 0.03, 0, -d, w, h, d, side, 'ny');
  b.box(-w, h - 0.03, -d, w, h, d, F('wood', wood), 'nxpx');
  // back panel with books painted on it, shelves as boards in front of it
  b.quad([-w + 0.03, 0.05, -d + 0.1], [w - 0.03, 0.05, -d + 0.1], [w - 0.03, h - 0.03, -d + 0.1], [-w + 0.03, h - 0.03, -d + 0.1], c.p.empty ? F('wood', shade(wood, 0.6)) : F('wood', shade(wood, 0.55), books(shelvesN, c.seed & 255)));
  b.box(-w, h - 0.03, -d - 0.01, w, h, -d, F('wood', wood), 'nxpxpy');
  for (let i = 0; i < shelvesN; i++) {
    const y = 0.05 + ((h - 0.08) * i) / shelvesN;
    b.box(-w + 0.03, y - 0.025, -d + 0.1, w - 0.03, y, d, F('wood', wood), 'nxpxnz');
  }
  b.box(-w + 0.03, 0, d - 0.02, w - 0.03, 0.05, d, F('wood', shade(wood, 0.7)), 'nxpx');
};

/**
 * Open shelving: metal rack / utility shelf / wooden rack / warehouse shelf. Items on the
 * tile are drawn on its middle shelf (see catalog `top`).
 */
export const shelving: Build = (b, c) => {
  const metal = c.p.material !== 'wood';
  const col = metal ? metalOf(c.pal, [128, 132, 136]) : woodOf(c.pal, [128, 90, 54]);
  const K = metal ? 'metal' : 'wood';
  const h = num(c, 'h', 1.8), d = num(c, 'd', 0.3);
  const [x0, x1] = spanX(c, 0.46);
  const post = metal ? 0.035 : 0.05;
  const postS = F(K, shade(col, metal ? 0.75 : 0.85));
  const posts: number[] = [];
  if (!c.conn[LEFT]) posts.push(x0);
  if (!c.conn[RIGHT]) posts.push(x1 - post);
  for (const x of posts) for (const z of [-d, d - post]) b.box(x, 0, z, x + post, h, z + post, postS, 'ny');
  const n = num(c, 'shelves', 4);
  for (let i = 0; i < n; i++) {
    const y = 0.08 + ((h - 0.1) * i) / (n - 1);
    b.box(x0, y - 0.03, -d, x1, y, d, F(K, col), (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : ''));
  }
  if (metal) {
    // diagonal-ish cross brace at the back (thin bars)
    b.box(x0 + 0.02, 0.1, -d, x1 - 0.02, 0.13, -d + 0.01, postS);
  }
};

/** Metal locker bank: three narrow doors with vents and handles. */
export const locker: Build = (b, c) => {
  const col = bodyOf(c.pal);
  const paint: RGB = hsv(col)[1] > 0.15 ? col : metalOf(c.pal, [96, 110, 120]);
  const w = 0.47, d = 0.25, h = 1.85;
  const doorsN = num(c, 'doors', 3);
  b.box(-w, 0.05, -d, w, h, d, (f) => (f === 'pz' ? F('paint', paint) : F('metal', shade(paint, 0.9))));
  for (let i = 0; i < doorsN; i++) {
    const dx0 = -w + 0.01 + ((2 * w - 0.02) * i) / doorsN, dx1 = -w + 0.01 + ((2 * w - 0.02) * (i + 1)) / doorsN - 0.012;
    b.box(dx0, 0.08, d, dx1, h - 0.03, d + 0.012, (f) => (f === 'pz' ? F('paint', shade(paint, 1.06), slats(4, 3)) : F('metal', paint)), 'ny');
    b.box(dx1 - 0.05, h * 0.5, d + 0.012, dx1 - 0.03, h * 0.5 + 0.1, d + 0.03, F('chrome', STEEL));
  }
  b.box(-w + 0.02, 0, -d + 0.02, w - 0.02, 0.05, d - 0.02, F('dark', DARK_METAL), 'ny');
};

/** Filing cabinet: metal drawers. */
export const filingCabinet: Build = (b, c) => {
  const col = metalOf(c.pal, [118, 122, 118]);
  const w = num(c, 'w', 0.24), d = 0.3, h = num(c, 'h', 1.3);
  const n = Math.max(2, Math.round(h / 0.32));
  b.box(-w, 0, -d, w, h, d, (f) => (f === 'pz' ? F('paint', col, drawers(n, 1, [200, 200, 196])) : F('metal', shade(col, 0.92))), 'ny');
};

/** Foot locker / chest: a lidded box. */
export const chest: Build = (b, c) => {
  const col = c.p.material === 'metal' ? metalOf(c.pal, [70, 90, 70]) : woodOf(c.pal, c.pal.main);
  const K = c.p.material === 'metal' ? 'metal' : 'wood';
  b.box(-0.4, 0, -0.25, 0.4, 0.4, 0.25, F(K, col), 'ny');
  b.box(-0.41, 0.4, -0.26, 0.41, 0.46, 0.26, F(K, shade(col, 1.1)));
  b.box(-0.05, 0.3, 0.26, 0.05, 0.4, 0.28, F('chrome', BRASS));
};

/** Coat rack: pole on a cross base with pegs and a couple of coats. */
export const coatRack: Build = (b, c) => {
  const wood = woodOf(c.pal, [96, 64, 38]);
  const s = F('wood', wood);
  b.box(-0.2, 0, -0.025, 0.2, 0.04, 0.025, s);
  b.box(-0.025, 0, -0.2, 0.025, 0.04, 0.2, s);
  b.box(-0.025, 0.04, -0.025, 0.025, 1.75, 0.025, s);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const x = Math.cos(a) * 0.1, z = Math.sin(a) * 0.1;
    b.box(Math.min(0, x) - 0.012, 1.62, Math.min(0, z) - 0.012, Math.max(0, x) + 0.012, 1.645, Math.max(0, z) + 0.012, s);
  }
  const coat: RGB = c.pal.clusters.find((q) => hsv(q.c)[1] > 0.3 && !(hsv(q.c)[0] > 15 && hsv(q.c)[0] < 45))?.c ?? [70, 60, 90];
  b.frustum(0.03, -0.12, 0.13, 0.12, 0.85, 1.62, 0.03, -0.08, 0.1, 0.08, F('fabric', coat));
};

/** Clothing rail with hanging garments (shops). */
export const clothingRail: Build = (b, c) => {
  const metal = F('chrome', STEEL);
  const [x0, x1] = spanX(c, 0.45);
  if (!c.conn[LEFT]) { barY(b, x0 + 0.02, 0, 1.5, 0, 0.03, metal); b.box(x0 - 0.05, 0, -0.2, x0 + 0.09, 0.03, 0.2, metal); }
  if (!c.conn[RIGHT]) { barY(b, x1 - 0.02, 0, 1.5, 0, 0.03, metal); b.box(x1 - 0.09, 0, -0.2, x1 + 0.05, 0.03, 0.2, metal); }
  barX(b, x0, x1, 1.48, 0, 0.025, metal);
  const cols: RGB[] = [[150, 60, 50], [60, 80, 130], [200, 190, 160], [70, 110, 70], [50, 50, 56], [160, 120, 60]];
  for (let i = 0; i < 6; i++) {
    const x = x0 + 0.08 + ((x1 - x0 - 0.16) * i) / 5;
    const col = cols[(c.seed + i * 7) % cols.length];
    b.frustum(x - 0.035, -0.2, x + 0.035, 0.2, 0.75 + ((c.seed >> i) & 1) * 0.2, 1.44, x - 0.03, -0.16, x + 0.03, 0.16, F('fabric', col));
  }
};

/** Entertainment centre: low cabinet with a TV on top. */
export const tvStand: Build = (b, c) => {
  const wood = woodOf(c.pal, [74, 52, 36]);
  b.box(-0.46, 0, -0.24, 0.46, 0.5, 0.2, (f) => (f === 'pz' ? F('wood', wood, doors(2, BRASS, true, false)) : F('wood', shade(wood, 0.9))), 'ny');
  // TV: a dark slab with a screen face and a small stand
  b.box(-0.08, 0.5, -0.12, 0.08, 0.53, 0.0, F('plastic', BLACK_PLASTIC));
  b.box(-0.02, 0.53, -0.07, 0.02, 0.6, -0.05, F('plastic', BLACK_PLASTIC));
  b.box(-0.42, 0.58, -0.1, 0.42, 1.08, -0.04, (f) => (f === 'pz' ? F('screen', [40, 48, 60]) : F('plastic', BLACK_PLASTIC)));
};

/** Upright piano / organ. */
export const piano: Build = (b, c) => {
  const wood = woodOf(c.pal, [48, 30, 24]);
  b.box(-0.48, 0, -0.3, 0.48, 1.25, -0.02, F('wood', wood), 'ny');
  b.box(-0.48, 0.62, -0.02, 0.48, 0.72, 0.28, F('wood', shade(wood, 0.9)));
  // keys: white strip with black-key marks
  b.box(-0.44, 0.72, 0.02, 0.44, 0.74, 0.22, (f) => (f === 'py' ? F('enamel', [226, 222, 208], slatsV(22)) : F('enamel', [226, 222, 208])), 'ny');
  b.box(-0.48, 0, 0.18, -0.44, 0.62, 0.24, F('wood', wood), 'ny');
  b.box(0.44, 0, 0.18, 0.48, 0.62, 0.24, F('wood', wood), 'ny');
  b.box(-0.35, 0.95, -0.02, 0.35, 1.05, 0.02, F('wood', shade(wood, 1.2)), 'ny');
};

/** Vertical dark lines across a face (piano keys, grilles). */
function slatsV(n: number) {
  return {
    k: `sltv${n}`,
    draw(img: { w: number; h: number; set: (x: number, y: number, c: RGB) => void }, r: RGB[], w: number, h: number) {
      for (let i = 1; i < n; i++) {
        const x = Math.round((w * i) / n);
        for (let y = 0; y < h; y++) img.set(x, y, i % 7 === 3 || i % 7 === 0 ? r[0] : shade(r[1], 0.8));
      }
    },
  };
}

export { slatsV };

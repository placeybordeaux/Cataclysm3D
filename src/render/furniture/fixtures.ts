import type { RGB } from '../colors';
import { burners, doors, drawers, inset, knobs, porthole, slats } from './paint';
import {
  BACK, BRASS, DARK_METAL, F, FRONT, LEFT, PORCELAIN, RIGHT, STEEL, barX, barY, bodyOf, hsv, legs, lumOf, metalOf, num, shade, spanX, whiteOf, woodOf,
  type Build, type Ctx,
} from './kit';
import type { ModelBuilder } from './mesh';

// Kitchen, bathroom and appliance archetypes, plus boxes and bins.

const skipConn = (c: Ctx) => (c.conn[LEFT] ? 'nx' : '') + (c.conn[RIGHT] ? 'px' : '');

/** Worktop colour: the sprite's top region if it reads as stone/laminate, else a warm grey. */
function worktop(c: Ctx): RGB {
  const t = c.pal.top;
  return hsv(t)[1] < 0.35 ? t : [150, 146, 138];
}
/** Cabinet body colour: the sprite's front region. */
function cabinet(c: Ctx): RGB {
  return c.pal.front;
}

/**
 * Base cabinet run: plinth, carcass with a door/drawer front, overhanging worktop; the side
 * panels between connected neighbours are left out so runs read as one counter.
 */
function baseCabinet(b: ModelBuilder, c: Ctx, front: 'doors' | 'drawers' | 'mixed' | 'plain', h = 0.92, hole?: [number, number, number, number]): void {
  const body = cabinet(c);
  const woodish = hsv(body)[0] > 10 && hsv(body)[0] < 50 && hsv(body)[1] > 0.25;
  const K = woodish ? 'wood' : 'paint';
  const [x0, x1] = spanX(c, 0.5);
  // corner of an L-shaped run: the counter in front runs along the other wall; fill the tile
  // to its front edge (plain side, no doors facing into the other run's side)
  const corner = !!c.connAll?.[FRONT];
  if (corner) front = 'plain';
  const z0 = -0.3, z1 = corner ? 0.5 : 0.28;
  b.box(x0, 0, z0, x1, 0.09, z1 - 0.06, F('dark', shade(body, 0.45)), skipConn(c) + 'ny');
  const handle: RGB = lumOf(body) > 140 ? [90, 90, 96] : BRASS;
  const deco = front === 'doors' ? doors(2, handle, true, true) : front === 'drawers' ? drawers(3, 1, handle) : front === 'mixed' ? drawers(1, 2, handle) : undefined;
  b.box(x0, 0.09, z0, x1, h - 0.04, z1, (f) => (f === 'pz' ? F(K, body, front === 'mixed' ? undefined : deco) : F(K, shade(body, 0.9))), skipConn(c) + 'py');
  if (front === 'mixed') {
    // top drawer row + doors below as separate front panels (reads as a real kitchen unit)
    const [fx0, fx1] = [x0 + 0.015, x1 - 0.015];
    b.box(fx0, h - 0.2, z1, fx1, h - 0.06, z1 + 0.012, (f) => (f === 'pz' ? F(K, shade(body, 1.05), drawers(1, 1, handle)) : F(K, body)), 'ny');
    b.box(fx0, 0.11, z1, fx1, h - 0.215, z1 + 0.012, (f) => (f === 'pz' ? F(K, shade(body, 1.05), doors(1, handle, true, true)) : F(K, body)), 'ny');
  }
  const top = worktop(c);
  const tx0 = c.conn[LEFT] ? -0.5 : x0 - 0.01, tx1 = c.conn[RIGHT] ? 0.5 : x1 + 0.01, tz0 = z0 - 0.01, tz1 = corner ? 0.5 : z1 + 0.035;
  const ws = (f: string) => (f === 'py' ? F('laminate', top) : F('laminate', shade(top, 0.85)));
  if (!hole) {
    b.box(tx0, h - 0.04, tz0, tx1, h, tz1, ws, skipConn(c));
    return;
  }
  // worktop as a frame around a cut-out (sink basin)
  const [hx0, hz0, hx1, hz1] = hole;
  b.box(tx0, h - 0.04, tz0, tx1, h, hz0, ws, skipConn(c) + 'pz');
  b.box(tx0, h - 0.04, hz1, tx1, h, tz1, ws, skipConn(c) + 'nz');
  b.box(tx0, h - 0.04, hz0, hx0, h, hz1, ws, (c.conn[LEFT] ? 'nx' : '') + 'nzpzpx');
  b.box(hx1, h - 0.04, hz0, tx1, h, hz1, ws, (c.conn[RIGHT] ? 'px' : '') + 'nzpznx');
}

export const counter: Build = (b, c) => baseCabinet(b, c, (c.p.front as 'doors') ?? 'mixed');

/** Kitchen cupboard: base unit plus (against a wall) a wall cabinet above. */
export const cupboard: Build = (b, c) => {
  baseCabinet(b, c, 'doors');
  if (!c.wall[BACK]) return;
  const body = cabinet(c);
  const K = hsv(body)[1] > 0.25 ? 'wood' : 'paint';
  const [x0, x1] = spanX(c, 0.5);
  const handle: RGB = lumOf(body) > 140 ? [90, 90, 96] : BRASS;
  b.box(x0, 1.45, -0.5, x1, 2.1, -0.16, (f) => (f === 'pz' ? F(K, body, doors(2, handle, true, true)) : F(K, shade(body, 0.9))), skipConn(c));
};

/** Sink unit: base cabinet with a steel basin sunk into the worktop and a faucet. */
export const sink: Build = (b, c) => {
  const bx0 = -0.3, bx1 = 0.3, bz0 = -0.2, bz1 = 0.18, depth = 0.16;
  baseCabinet(b, c, 'doors', 0.92, [bx0 - 0.03, bz0 - 0.03, bx1 + 0.03, bz1 + 0.03]);
  const h = 0.92;
  const steel = F('metal', [170, 174, 178]);
  // basin: steel rim in the worktop cut-out, walls and floor facing inward
  b.box(bx0 - 0.03, h - 0.001, bz0 - 0.03, bx1 + 0.03, h + 0.006, bz0, steel, 'ny');
  b.box(bx0 - 0.03, h - 0.001, bz1, bx1 + 0.03, h + 0.006, bz1 + 0.03, steel, 'ny');
  b.box(bx0 - 0.03, h - 0.001, bz0, bx0, h + 0.006, bz1, steel, 'ny');
  b.box(bx1, h - 0.001, bz0, bx1 + 0.03, h + 0.006, bz1, steel, 'ny');
  b.quad([bx0, h - depth, bz1], [bx1, h - depth, bz1], [bx1, h - depth, bz0], [bx0, h - depth, bz0], F('metal', [120, 124, 128]));
  b.quad([bx1, h - depth, bz1], [bx0, h - depth, bz1], [bx0, h + 0.007, bz1], [bx1, h + 0.007, bz1], F('metal', [140, 144, 148]));
  b.quad([bx0, h - depth, bz0], [bx1, h - depth, bz0], [bx1, h + 0.007, bz0], [bx0, h + 0.007, bz0], F('metal', [150, 154, 158]));
  b.quad([bx0, h - depth, bz1], [bx0, h - depth, bz0], [bx0, h + 0.007, bz0], [bx0, h + 0.007, bz1], F('metal', [130, 134, 138]));
  b.quad([bx1, h - depth, bz0], [bx1, h - depth, bz1], [bx1, h + 0.007, bz1], [bx1, h + 0.007, bz0], F('metal', [130, 134, 138]));
  const faucet = F('chrome', STEEL);
  b.box(-0.02, h, -0.27, 0.02, h + 0.24, -0.23, faucet, 'ny');
  b.box(-0.02, h + 0.2, -0.27, 0.02, h + 0.24, -0.1, faucet);
  b.box(-0.1, h, -0.27, -0.06, h + 0.05, -0.23, faucet, 'ny');
  b.box(0.06, h, -0.27, 0.1, h + 0.05, -0.23, faucet, 'ny');
};

/** Stove / range oven: enamel body, oven door with window, burners, back panel with knobs. */
export const oven: Build = (b, c) => {
  const body = whiteOf(c.pal, [220, 218, 210]);
  const w = 0.42, z0 = -0.3, z1 = 0.28, h = 0.92;
  b.box(-w, 0, z0, w, h - 0.02, z1, (f) => (f === 'pz' ? F('enamel', body, inset(0.15, 0.3, 0.85, 0.7, [40, 36, 34])) : F('enamel', shade(body, 0.92))), 'ny');
  b.box(-w + 0.04, h - 0.18, z1, w - 0.04, h - 0.15, z1 + 0.04, F('chrome', STEEL));
  b.box(-w, h - 0.02, z0, w, h, z1, (f) => (f === 'py' ? F('dark', [44, 44, 48], burners([96, 96, 100])) : F('enamel', body)));
  b.box(-w, h, z0, w, h + 0.18, z0 + 0.06, (f) => (f === 'pz' ? F('enamel', shade(body, 0.95), knobs(4, [40, 40, 44], 0.5)) : F('enamel', body)));
};

/** Fridge / freezer (upright): enamel box with a freezer split and bar handles. */
export const fridge: Build = (b, c) => {
  const body = c.p.color === 'metal' ? metalOf(c.pal, [180, 184, 186]) : whiteOf(c.pal, [224, 224, 218]);
  const w = num(c, 'w', 0.42), z0 = -0.34, z1 = 0.3, h = num(c, 'h', 1.8);
  const split = c.p.split === false ? 0 : h * 0.68;
  b.box(-w, 0.03, z0, w, h, z1, F('enamel', shade(body, 0.95)), 'ny');
  const doorS = F('enamel', body);
  if (split) {
    b.box(-w + 0.01, 0.05, z1, w - 0.01, split - 0.01, z1 + 0.04, doorS, 'ny');
    b.box(-w + 0.01, split + 0.01, z1, w - 0.01, h - 0.02, z1 + 0.04, doorS, 'ny');
    barY(b, w - 0.08, split - 0.45, split - 0.1, z1 + 0.06, 0.025, F('chrome', STEEL));
    barY(b, w - 0.08, split + 0.08, split + 0.3, z1 + 0.06, 0.025, F('chrome', STEEL));
  } else {
    b.box(-w + 0.01, 0.05, z1, w - 0.01, h - 0.02, z1 + 0.04, doorS, 'ny');
    barY(b, w - 0.08, h * 0.45, h * 0.7, z1 + 0.06, 0.025, F('chrome', STEEL));
  }
  b.box(-w + 0.03, 0, z0 + 0.03, w - 0.03, 0.03, z1 - 0.03, F('dark', DARK_METAL, slats(1, 0)), 'ny');
};

/** Small appliances at counter height (minifridge, dishwasher) = counter unit look-alikes. */
export const underCounter: Build = (b, c) => {
  const body = whiteOf(c.pal, [214, 214, 208]);
  const h = num(c, 'h', 0.86);
  b.box(-0.42, 0.02, -0.3, 0.42, h, 0.28, (f) => (f === 'pz' ? F('enamel', body, c.p.kind === 'dishwasher' ? knobs(3, [60, 60, 64], 0.08) : undefined) : F('enamel', shade(body, 0.92))), 'ny');
  barX(b, -0.3, 0.3, h - 0.1, 0.31, 0.02, F('chrome', STEEL));
};

/** Store display fridge/freezer: metal frame, glass door, shelves of products. */
export const glassFridge: Build = (b, c) => {
  const frameC = metalOf(c.pal, [60, 64, 70]);
  const w = 0.46, z0 = -0.36, z1 = 0.32, h = 1.95;
  const frame = F('metal', frameC);
  b.box(-w, 0, z0, w, h, z0 + 0.05, frame, 'ny');
  b.box(-w, 0, z0, -w + 0.05, h, z1, frame, 'ny');
  b.box(w - 0.05, 0, z0, w, h, z1, frame, 'ny');
  b.box(-w, h - 0.2, z0, w, h, z1, (f) => (f === 'pz' ? F('glow', [200, 220, 230]) : frame));
  b.box(-w, 0, z0, w, 0.18, z1, (f) => (f === 'pz' ? F('dark', DARK_METAL, slats(2, 3)) : frame), 'ny');
  // interior: product rows on shelves (bright boxes)
  const cols: RGB[] = [[200, 60, 50], [230, 200, 80], [60, 120, 190], [240, 240, 240], [80, 160, 80], [220, 120, 40]];
  for (let s = 0; s < 4; s++) {
    const y = 0.22 + s * 0.38;
    b.box(-w + 0.05, y, z0 + 0.05, w - 0.05, y + 0.02, z1 - 0.06, F('metal', [150, 154, 158]), 'ny');
    for (let i = 0; i < 6; i++) {
      const x = -w + 0.08 + i * 0.135;
      const col = cols[(c.seed + s * 5 + i * 3) % cols.length];
      const ph = 0.16 + ((c.seed >> (i + s)) & 1) * 0.08;
      b.box(x, y + 0.02, z0 + 0.12, x + 0.1, y + 0.02 + ph, z1 - 0.12, F('plastic', col), 'ny');
    }
  }
  // glass door + handle
  b.glass([-w + 0.05, 0.18, z1 - 0.02], [w - 0.05, 0.18, z1 - 0.02], [w - 0.05, h - 0.2, z1 - 0.02], [-w + 0.05, h - 0.2, z1 - 0.02]);
  barY(b, w - 0.1, 0.8, 1.3, z1 + 0.01, 0.025, F('chrome', STEEL));
};

/** Washer / dryer: front loader with a porthole door and a control strip. */
export const washer: Build = (b, c) => {
  const body = whiteOf(c.pal, [222, 222, 216]);
  const w = 0.32, z0 = -0.3, z1 = 0.3, h = 0.88;
  const glass: RGB = c.p.dryer ? [50, 50, 56] : [70, 100, 130];
  b.box(-w, 0.02, z0, w, h, z1, (f) => (f === 'pz' ? F('enamel', body, porthole(0.5, 0.55, 0.33, glass)) : F('enamel', shade(body, 0.92))), 'ny');
  b.box(-w, h - 0.14, z1, w, h, z1 + 0.02, (f) => (f === 'pz' ? F('enamel', shade(body, 0.9), knobs(3, [60, 60, 70], 0.5)) : F('enamel', body)), 'ny');
};

/** Toilet: pedestal, bowl, seat, tank against the back. */
export const toilet: Build = (b, c) => {
  const white = whiteOf(c.pal, PORCELAIN);
  const P = F('enamel', white);
  b.frustum(-0.1, -0.16, 0.1, 0.1, 0, 0.3, -0.16, -0.18, 0.16, 0.2, P, 'ny');
  b.prism(0, 0.06, 0.3, 0.4, 0.19, 10, P, null, null, 0.23);
  // seat ring (lid up would be too fiddly: lid down)
  b.prism(0, 0.06, 0.4, 0.43, 0.195, 10, F('enamel', shade(white, 0.97)), F('enamel', shade(white, 1.02)), null, 0.235);
  b.box(-0.2, 0.3, -0.42, 0.2, 0.78, -0.2, P);
  b.box(-0.21, 0.78, -0.43, 0.21, 0.81, -0.19, F('enamel', shade(white, 1.03)));
  b.box(0.12, 0.72, -0.2, 0.16, 0.74, -0.18, F('chrome', STEEL), 'ny');
};

/**
 * Bathtub: rim, inner basin (dark water-less recess), clawfeet or panel. Connects along its
 * length (2-tile tubs) — ends only on unconnected sides.
 */
export const bathtub: Build = (b, c) => {
  const white = whiteOf(c.pal, PORCELAIN);
  const P = F('enamel', white);
  const [x0, x1] = spanX(c, 0.47);
  const z0 = -0.36, z1 = 0.36, h = 0.55, t = 0.06;
  const sk = skipConn(c);
  // outer shell (on small feet)
  b.box(x0, 0.08, z0, x1, h, z1, P, sk + 'py');
  for (const x of [...(c.conn[LEFT] ? [] : [x0 + 0.06]), ...(c.conn[RIGHT] ? [] : [x1 - 0.12])]) for (const z of [z0 + 0.04, z1 - 0.1]) b.box(x, 0, z, x + 0.06, 0.08, z + 0.06, F('chrome', BRASS), 'ny');
  // rim: four boxes around the opening
  const ix0 = c.conn[LEFT] ? -0.5 : x0 + t, ix1 = c.conn[RIGHT] ? 0.5 : x1 - t;
  b.box(x0, h, z0, x1, h + 0.03, z0 + t, P, sk);
  b.box(x0, h, z1 - t, x1, h + 0.03, z1, P, sk);
  if (!c.conn[LEFT]) b.box(x0, h, z0 + t, x0 + t, h + 0.03, z1 - t, P);
  if (!c.conn[RIGHT]) b.box(x1 - t, h, z0 + t, x1, h + 0.03, z1 - t, P);
  // inner basin: bottom + walls facing in
  const iy = 0.2;
  const I = F('enamel', shade(white, 0.88));
  b.quad([ix0, iy, z1 - t], [ix1, iy, z1 - t], [ix1, iy, z0 + t], [ix0, iy, z0 + t], F('enamel', shade(white, 0.8)));
  b.quad([ix1, iy, z1 - t], [ix0, iy, z1 - t], [ix0, h + 0.03, z1 - t], [ix1, h + 0.03, z1 - t], I);
  b.quad([ix0, iy, z0 + t], [ix1, iy, z0 + t], [ix1, h + 0.03, z0 + t], [ix0, h + 0.03, z0 + t], I);
  if (!c.conn[LEFT]) b.quad([ix0, iy, z1 - t], [ix0, iy, z0 + t], [ix0, h + 0.03, z0 + t], [ix0, h + 0.03, z1 - t], I);
  if (!c.conn[RIGHT]) b.quad([ix1, iy, z0 + t], [ix1, iy, z1 - t], [ix1, h + 0.03, z1 - t], [ix1, h + 0.03, z0 + t], I);
  if (!c.conn[LEFT] && !c.conn[RIGHT] || !c.conn[LEFT]) {
    const fx = x0 + 0.03;
    b.box(fx, h + 0.03, -0.03, fx + 0.03, h + 0.2, 0.03, F('chrome', STEEL), 'ny');
    b.box(fx, h + 0.17, -0.03, fx + 0.14, h + 0.2, 0.03, F('chrome', STEEL));
  }
};

/** Shower: tiled tray, glass on the open sides, a riser pipe and head on the back wall. */
export const shower: Build = (b, c) => {
  const tile: RGB = c.pal.clusters.find((q) => lumOf(q.c) > 120)?.c ?? [180, 200, 210];
  b.box(-0.48, 0, -0.48, 0.48, 0.08, 0.48, (f) => (f === 'py' ? F('enamel', tile) : F('enamel', shade(tile, 0.9))), 'ny');
  b.box(-0.05, 0.079, -0.05, 0.05, 0.082, 0.05, F('dark', DARK_METAL), 'ny');
  const chrome = F('chrome', STEEL);
  const h = 1.95;
  // riser + head on the back
  b.box(-0.02, 0.9, -0.48, 0.02, 1.9, -0.44, chrome, 'ny');
  b.box(-0.02, 1.86, -0.46, 0.02, 1.9, -0.3, chrome);
  b.prism(0, -0.28, 1.8, 1.86, 0.06, 8, chrome, chrome, chrome);
  b.box(-0.06, 1.05, -0.48, 0.06, 1.12, -0.45, chrome);
  // glass walls where there is no wall, with a thin frame on top
  const g = (x0: number, z0: number, x1: number, z1: number) => {
    b.glass([x0, 0.08, z0], [x1, 0.08, z1], [x1, h, z1], [x0, h, z0]);
    b.glass([x1, 0.08, z1], [x0, 0.08, z0], [x0, h, z0], [x1, h, z1]);
    if (x0 === x1) b.box(x0 - 0.015, h, Math.min(z0, z1), x0 + 0.015, h + 0.03, Math.max(z0, z1), chrome);
    else b.box(Math.min(x0, x1), h, z0 - 0.015, Math.max(x0, x1), h + 0.03, z0 + 0.015, chrome);
  };
  if (!c.wall[FRONT]) g(-0.48, 0.48, 0.48, 0.48);
  if (!c.wall[LEFT]) g(-0.48, -0.48, -0.48, 0.48);
  if (!c.wall[RIGHT]) g(0.48, 0.48, 0.48, -0.48);
  if (!c.wall[BACK]) g(0.48, -0.48, -0.48, -0.48);
};

/** Display case (shop counter with glass top/front) or glass cabinet. */
export const displayCase: Build = (b, c) => {
  const wood = woodOf(c.pal, [90, 60, 40]);
  const [x0, x1] = spanX(c, 0.48);
  const z0 = -0.3, z1 = 0.3;
  const sk = skipConn(c);
  b.box(x0, 0, z0, x1, 0.45, z1, F('wood', wood), sk + 'ny');
  b.box(x0 + 0.01, 0.45, z0 + 0.01, x1 - 0.01, 0.47, z1 - 0.01, F('felt', [110, 40, 44]), sk + 'ny');
  // glass box on top: posts at the unconnected corners, glass front/top/sides
  const top = 0.98;
  const frame = F('chrome', [170, 160, 120]);
  if (!c.conn[LEFT]) { barY(b, x0 + 0.015, 0.45, top, z1 - 0.015, 0.03, frame); barY(b, x0 + 0.015, 0.45, top, z0 + 0.015, 0.03, frame); }
  if (!c.conn[RIGHT]) { barY(b, x1 - 0.015, 0.45, top, z1 - 0.015, 0.03, frame); barY(b, x1 - 0.015, 0.45, top, z0 + 0.015, 0.03, frame); }
  barX(b, x0, x1, top, z1 - 0.015, 0.03, frame);
  barX(b, x0, x1, top, z0 + 0.015, 0.03, frame);
  b.glass([x0, 0.47, z1], [x1, 0.47, z1], [x1, top, z1], [x0, top, z1]);
  b.glass([x0, top, z1], [x1, top, z1], [x1, top, z0], [x0, top, z0]);
  b.glass([x1, 0.47, z0], [x0, 0.47, z0], [x0, top, z0], [x1, top, z0]);
  if (!c.conn[LEFT]) b.glass([x0, 0.47, z0], [x0, 0.47, z1], [x0, top, z1], [x0, top, z0]);
  if (!c.conn[RIGHT]) b.glass([x1, 0.47, z1], [x1, 0.47, z0], [x1, top, z0], [x1, top, z1]);
};

/** Vending machine: tall box, glass product window, button panel, delivery slot. */
export const vending: Build = (b, c) => {
  const col = bodyOf(c.pal);
  const w = 0.46, z0 = -0.4, z1 = 0.36, h = 1.85;
  b.box(-w, 0, z0, w, h, z1, F('paint', col), 'ny');
  const cols: RGB[] = [[200, 50, 40], [240, 210, 60], [50, 110, 200], [230, 230, 230], [60, 170, 70]];
  for (let s = 0; s < 5; s++)
    for (let i = 0; i < 5; i++) {
      const x = -w + 0.08 + i * 0.12, y = 0.55 + s * 0.24;
      b.box(x, y, z1 - 0.2, x + 0.08, y + 0.14, z1 - 0.05, F('plastic', cols[(s * 2 + i + c.seed) % cols.length]), 'ny');
    }
  b.quad([-w + 0.05, 0.5, z1 - 0.21], [w - 0.25, 0.5, z1 - 0.21], [w - 0.25, h - 0.1, z1 - 0.21], [-w + 0.05, h - 0.1, z1 - 0.21], F('dark', [30, 30, 34]));
  b.glass([-w + 0.05, 0.5, z1 - 0.01], [w - 0.25, 0.5, z1 - 0.01], [w - 0.25, h - 0.1, z1 - 0.01], [-w + 0.05, h - 0.1, z1 - 0.01]);
  // the glass is inset in the front face: draw the frame around it as front strips
  const fr = F('paint', shade(col, 0.9));
  b.box(-w, 0, z1, w, 0.5, z1 + 0.01, (f) => (f === 'pz' ? F('paint', shade(col, 0.85), inset(0.12, 0.35, 0.55, 0.7, [20, 20, 22], true, false)) : fr), 'ny');
  b.box(w - 0.25, 0.5, z1 - 0.2, w, h - 0.1, z1 + 0.01, (f) => (f === 'pz' ? F('paint', shade(col, 0.95), knobs(3, [220, 220, 220], 0.35)) : fr));
  b.box(-w, h - 0.1, z1 - 0.2, w, h, z1 + 0.01, F('glow', shade(col, 1.3)));
  b.box(-w, 0.5, z1 - 0.2, -w + 0.05, h - 0.1, z1 + 0.01, fr);
};

// --- boxes, bins ------------------------------------------------------------------------------

export const crate: Build = (b, c) => {
  const wood = woodOf(c.pal, [150, 112, 70]);
  const open = c.p.open === true;
  const s = 0.4, h = 0.75;
  b.box(-s, 0, -s, s, h, s, (f) => (f === 'py' ? null : F('wood', wood, slats(4, 0))), 'ny');
  if (open) {
    b.quad([-s + 0.03, h - 0.3, s - 0.03], [s - 0.03, h - 0.3, s - 0.03], [s - 0.03, h - 0.3, -s + 0.03], [-s + 0.03, h - 0.3, -s + 0.03], F('dark', shade(wood, 0.35)));
    // inner walls
    const I = F('wood', shade(wood, 0.6));
    b.quad([s - 0.03, h - 0.3, s - 0.03], [-s + 0.03, h - 0.3, s - 0.03], [-s + 0.03, h, s - 0.03], [s - 0.03, h, s - 0.03], I);
    b.quad([-s + 0.03, h - 0.3, -s + 0.03], [s - 0.03, h - 0.3, -s + 0.03], [s - 0.03, h, -s + 0.03], [-s + 0.03, h, -s + 0.03], I);
    b.quad([-s + 0.03, h - 0.3, s - 0.03], [-s + 0.03, h - 0.3, -s + 0.03], [-s + 0.03, h, -s + 0.03], [-s + 0.03, h, s - 0.03], I);
    b.quad([s - 0.03, h - 0.3, -s + 0.03], [s - 0.03, h - 0.3, s - 0.03], [s - 0.03, h, s - 0.03], [s - 0.03, h, -s + 0.03], I);
    // rim
    for (const [x0, z0, x1, z1] of [[-s, -s, s, -s + 0.03], [-s, s - 0.03, s, s], [-s, -s, -s + 0.03, s], [s - 0.03, -s, s, s]]) b.box(x0, h - 0.001, z0, x1, h + 0.01, z1, F('wood', shade(wood, 1.1)), 'ny');
  } else {
    b.box(-s, h, -s, s, h + 0.01, s, F('wood', shade(wood, 1.05), slats(4, 0)), 'ny');
    // corner battens
    for (const [x, z] of [[-s - 0.01, -s - 0.01], [s - 0.05, -s - 0.01], [s - 0.05, s - 0.05], [-s - 0.01, s - 0.05]]) b.box(x, 0, z, x + 0.06, h + 0.01, z + 0.06, F('wood', shade(wood, 0.8)), 'ny');
  }
};

export const cardboardBox: Build = (b, c) => {
  const found = c.pal.clusters.find((q) => hsv(q.c)[0] > 18 && hsv(q.c)[0] < 42 && hsv(q.c)[1] > 0.25)?.c;
  // cardboard is a brown, whatever yellow the sprite leans to
  const col: RGB = found ? [Math.min(found[0], 190), Math.min(found[1], found[0] * 0.78), Math.min(found[2], found[0] * 0.55)] : [176, 136, 92];
  const s = 0.32, h = 0.5;
  const tape: RGB = [214, 196, 150];
  b.box(-s, 0, -s + 0.03, s, h, s - 0.03, (f) => (f === 'py' ? F('cardboard', col, inset(0, 0.44, 1, 0.56, tape, false, false)) : F('cardboard', shade(col, f === 'pz' ? 1 : 0.94))), 'ny');
  // a second, smaller box on top at an angle-free offset reads as "stacked boxes"
  if (c.seed & 1) b.box(-0.2, h, -0.18, 0.16, h + 0.26, 0.18, (f) => (f === 'py' ? F('cardboard', shade(col, 1.05), inset(0, 0.44, 1, 0.56, tape, false, false)) : F('cardboard', shade(col, 0.95))), 'ny');
};

/** Round bin with a lid (trash can, recycle bin). */
export const trashcan: Build = (b, c) => {
  const col = c.p.color === 'blue' ? [50, 90, 150] as RGB : metalOf(c.pal, bodyOf(c.pal));
  const r = 0.24, h = 0.72;
  b.prism(0, 0, 0, h, r, 12, F('metal', col, slats(3, 3)), null, null);
  b.prism(0, 0, h, h + 0.05, r + 0.02, 12, F('metal', shade(col, 1.1)), F('metal', shade(col, 1.05)));
  b.box(-0.06, h + 0.05, -0.015, 0.06, h + 0.09, 0.015, F('metal', shade(col, 0.8)));
};

/** Dumpster: big steel bin with slanted lids and side pockets. */
export const dumpster: Build = (b, c) => {
  const col: RGB = c.pal.clusters.find((q) => hsv(q.c)[1] > 0.3 && lumOf(q.c) > 40)?.c ?? [50, 100, 60];
  const w = 0.49, z0 = -0.46, z1 = 0.4;
  b.frustum(-w + 0.04, z0 + 0.06, w - 0.04, z1 - 0.1, 0.12, 1.15, -w, z0, w, z1, (f) => (f === 'py' ? null : F('paint', col, f === 'pz' ? slats(1, 6) : undefined)), 'ny');
  // lids: two dark plastic panels sloping to the front
  b.tiltedBox(-w, 0, 1.15, z0 - 0.02, 0.9, 0.03, -Math.PI / 2 + 0.12, F('plastic', [40, 44, 40]));
  b.tiltedBox(0.005, w, 1.15, z0 - 0.02, 0.9, 0.03, -Math.PI / 2 + 0.12, F('plastic', [40, 44, 40]));
  for (const x of [-w + 0.08, w - 0.16]) for (const z of [z0 + 0.1, z1 - 0.2]) b.box(x, 0, z, x + 0.08, 0.12, z + 0.08, F('rubber', [30, 30, 30]), 'ny');
  barX(b, -w - 0.03, w + 0.03, 0.9, z1 + 0.02, 0.05, F('metal', shade(col, 0.8)));
};

/** Rolling road barricade / sawhorse with striped boards. */
export const barricade: Build = (b, c) => {
  const wood = F('wood', [160, 130, 90]);
  for (const x of [-0.42, 0.38]) {
    b.tiltedBox(x, x + 0.04, 0, 0.1, 0.95, 0.04, 0.2, wood);
    b.tiltedBox(x, x + 0.04, 0, -0.1, 0.95, 0.04, -0.2, wood);
  }
  const stripe = { k: 'stripe', draw: (img: { w: number; h: number; set: (x: number, y: number, c: RGB) => void }) => { for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) img.set(x, y, Math.floor((x + y) / 5) % 2 ? [230, 120, 30] : [236, 236, 230]); } };
  b.box(-0.48, 0.72, -0.02, 0.48, 0.9, 0.02, F('paint', [236, 236, 230], stripe as never));
  b.box(-0.48, 0.35, -0.02, 0.48, 0.5, 0.02, F('paint', [236, 236, 230], stripe as never));
  void c;
};

/** Sandbag wall: rows of rounded bags. */
export const sandbags: Build = (b, c) => {
  const col: RGB = [150, 136, 100];
  const rows = c.p.full ? 5 : 3;
  const [x0, x1] = spanX(c, 0.5);
  for (let r = 0; r < rows; r++) {
    const off = r & 1 ? 0.25 : 0;
    for (let x = x0 - off; x < x1; x += 0.5) {
      const a = Math.max(x0, x), e = Math.min(x1, x + 0.48);
      if (e - a < 0.1) continue;
      b.frustum(a, -0.3, e, 0.3, r * 0.2, r * 0.2 + 0.2, a + 0.02, -0.26, e - 0.02, 0.26, F('fabric', shade(col, 0.9 + ((r + Math.round(x * 4)) & 1) * 0.1)), 'ny');
    }
  }
};

/** Kitchen water heater / tank: a tall cylinder. */
export const tank: Build = (b, c) => {
  const col = whiteOf(c.pal, [200, 200, 196]);
  const r = num(c, 'r', 0.28), h = num(c, 'h', 1.5);
  b.prism(0, 0, 0.05, h, r, 12, F('enamel', col), F('enamel', shade(col, 1.05)));
  b.box(-0.03, h, -0.03, 0.03, h + 0.25, 0.03, F('metal', [150, 110, 70]));
  for (const a of [0, 2.1, 4.2]) b.box(Math.cos(a) * r * 0.8 - 0.02, 0, Math.sin(a) * r * 0.8 - 0.02, Math.cos(a) * r * 0.8 + 0.02, 0.05, Math.sin(a) * r * 0.8 + 0.02, F('metal', DARK_METAL), 'ny');
};

/** Generic machine box (air conditioner, furnace, generator...): body with a grille. */
export const machine: Build = (b, c) => {
  const col = metalOf(c.pal, bodyOf(c.pal));
  const w = num(c, 'w', 0.42), d = num(c, 'd', 0.36), h = num(c, 'h', 0.9);
  b.box(-w, 0.04, -d, w, h, d, (f) => (f === 'pz' ? F('paint', col, c.p.fan ? porthole(0.5, 0.5, 0.38, [40, 42, 46]) : slats(Math.round(h * 12), 4)) : f === 'py' && c.p.fan ? F('paint', col, porthole(0.5, 0.5, 0.4, [40, 42, 46])) : F('metal', shade(col, 0.92))), 'ny');
  b.box(-w + 0.03, 0, -d + 0.03, w - 0.03, 0.04, d - 0.03, F('dark', DARK_METAL), 'ny');
};

/** Fireplace: brick surround, dark firebox, mantel shelf. */
export const fireplace: Build = (b, c) => {
  const brick: RGB = c.pal.clusters.find((q) => hsv(q.c)[0] < 20 && hsv(q.c)[1] > 0.3)?.c ?? [140, 70, 50];
  const B = F('brick', brick);
  b.box(-0.5, 0, -0.5, -0.3, 1.1, 0.1, B, 'ny');
  b.box(0.3, 0, -0.5, 0.5, 1.1, 0.1, B, 'ny');
  b.box(-0.3, 0.75, -0.5, 0.3, 1.1, 0.1, B, 'ny');
  b.box(-0.3, 0, -0.5, 0.3, 0.75, -0.3, F('dark', [28, 24, 22]), 'ny');
  b.box(-0.3, 0, -0.3, 0.3, 0.05, 0.1, F('stone', [70, 66, 62]), 'ny');
  b.box(-0.55, 1.1, -0.5, 0.55, 1.16, 0.18, F('wood', woodOf(c.pal, [90, 60, 40])));
  b.box(-0.55, 0, 0.1, 0.55, 0.04, 0.4, F('stone', [110, 104, 96]), 'ny');
};

/** Wood stove: black box on legs with a flue pipe. */
export const woodStove: Build = (b, c) => {
  const col: RGB = [44, 44, 46];
  legs(b, -0.3, -0.25, 0.3, 0.25, 0.15, 0.05, F('metal', col));
  b.box(-0.3, 0.15, -0.25, 0.3, 0.75, 0.25, (f) => (f === 'pz' ? F('metal', col, inset(0.2, 0.25, 0.8, 0.7, [120, 50, 20])) : F('metal', col)));
  b.prism(0, -0.1, 0.75, 2.4, 0.07, 8, F('metal', shade(col, 1.2)), null);
  void c;
};

/** Floor lamp: weighted base, pole, fabric shade that glows a little. */
export const floorLamp: Build = (b, c) => {
  const shadeC = whiteOf(c.pal, [226, 210, 170]);
  b.prism(0, 0, 0, 0.03, 0.15, 8, F('metal', [60, 58, 54]));
  b.box(-0.015, 0.03, -0.015, 0.015, 1.4, 0.015, F('chrome', [150, 140, 110]));
  b.frustum(-0.18, -0.18, 0.18, 0.18, 1.3, 1.62, -0.12, -0.12, 0.12, 0.12, F('glow', shadeC), 'nypy');
  // inside of the shade (seen from below/above)
  b.quad([-0.12, 1.62, -0.12], [0.12, 1.62, -0.12], [0.12, 1.62, 0.12], [-0.12, 1.62, 0.12], F('glow', shade(shadeC, 1.1)));
};

/** Pot plant: tapered pot, soil, clumps of leaves. */
export const pottedPlant: Build = (b, c) => {
  const leaf: RGB = c.pal.clusters.find((q) => hsv(q.c)[0] > 60 && hsv(q.c)[0] < 170 && hsv(q.c)[1] > 0.25)?.c ?? [70, 120, 60];
  const pot: RGB = c.pal.clusters.find((q) => hsv(q.c)[0] < 40 && hsv(q.c)[1] > 0.3 && lumOf(q.c) > 50)?.c ?? [160, 90, 60];
  b.frustum(-0.12, -0.12, 0.12, 0.12, 0, 0.3, -0.16, -0.16, 0.16, 0.16, F('stone', pot), 'ny');
  b.box(-0.15, 0.27, -0.15, 0.15, 0.29, 0.15, F('soil', [60, 44, 32]), 'ny');
  const L = F('foliage', leaf);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + (c.seed & 7);
    const r = 0.12, x = Math.cos(a) * r, z = Math.sin(a) * r, y = 0.35 + (i % 2) * 0.15;
    b.box(x - 0.09, y, z - 0.09, x + 0.09, y + 0.2, z + 0.09, L);
  }
  b.box(-0.08, 0.55, -0.08, 0.08, 0.85, 0.08, L);
};


// --- machines, consoles, fitness, misc ------------------------------------------------------

/** Computer console / terminal desk: a desk with a monitor and keyboard (terrain t_console). */
export const consoleDesk: Build = (b, c) => {
  const body = metalOf(c.pal, [150, 154, 150]);
  const broken = c.p.broken === true;
  b.box(-0.45, 0, -0.3, 0.45, 0.72, 0.28, (f) => (f === 'pz' ? F('paint', body, doors(2, [80, 80, 80], true, false)) : F('metal', shade(body, 0.92))), 'ny');
  b.box(-0.47, 0.72, -0.32, 0.47, 0.76, 0.3, F('plastic', shade(body, 0.8)));
  b.box(-0.3, 0.76, -0.25, 0.3, 1.18, -0.05, (f) => (f === 'pz' ? F('screen', broken ? [40, 30, 30] : [40, 80, 70], broken ? undefined : inset(0.1, 0.12, 0.9, 0.85, [60, 150, 110], false, true)) : F('plastic', [70, 72, 76])));
  b.box(-0.25, 0.76, 0.02, 0.25, 0.79, 0.2, (f) => (f === 'py' ? F('plastic', [60, 62, 66], slats(4, 1)) : F('plastic', [60, 62, 66])));
};

/** ATM: a lit screen and keypad in a steel box. */
export const atm: Build = (b, c) => {
  const body = metalOf(c.pal, [120, 126, 132]);
  b.box(-0.35, 0, -0.35, 0.35, 1.7, 0.3, (f) => (f === 'pz' ? F('metal', body, inset(0.2, 0.18, 0.8, 0.4, [60, 110, 170], true, true)) : F('metal', shade(body, 0.9))), 'ny');
  b.tiltedBox(-0.28, 0.28, 1.0, 0.3, 0.2, 0.12, -1.1, F('plastic', [50, 52, 56], slats(3, 2)));
  b.box(-0.35, 1.7, -0.36, 0.35, 1.85, 0.34, F('glow', bodyOf(c.pal)));
};

/** Gas pump: tall cabinet, price display, nozzle and hose, on a concrete island. */
export const gasPump: Build = (b, c) => {
  const col: RGB = c.pal.clusters.find((q) => hsv(q.c)[1] > 0.35 && lumOf(q.c) > 50)?.c ?? [190, 50, 40];
  b.box(-0.45, 0, -0.45, 0.45, 0.12, 0.45, F('stone', [150, 146, 138]), 'ny');
  b.box(-0.32, 0.12, -0.22, 0.32, 1.7, 0.22, (f) => (f === 'pz' || f === 'nz' ? F('paint', col, inset(0.15, 0.1, 0.85, 0.32, [30, 34, 30], true, false)) : F('paint', shade(col, 0.85))));
  b.box(-0.34, 1.7, -0.24, 0.34, 1.85, 0.24, F('glow', [236, 232, 220]));
  b.box(0.32, 0.9, -0.05, 0.4, 1.1, 0.05, F('dark', [30, 30, 32]));
  b.box(0.38, 0.4, -0.02, 0.41, 0.95, 0.02, F('rubber', [30, 30, 32]));
};

/** Metal tank on legs (propane / gas tank). */
export const gasTank: Build = (b, c) => {
  const col = whiteOf(c.pal, [210, 210, 206]);
  legs(b, -0.4, -0.25, 0.4, 0.25, 0.35, 0.05, F('metal', DARK_METAL));
  b.box(-0.48, 0.35, -0.3, 0.48, 0.95, 0.3, F('enamel', col));
  b.prism(0, 0, 0.95, 1.05, 0.08, 6, F('chrome', STEEL));
};

/** Planter: a wooden raised bed with soil and sprouts (grows with the growth stage). */
export const planter: Build = (b, c) => {
  const wood = woodOf(c.pal, [120, 84, 52]);
  b.box(-0.46, 0, -0.46, 0.46, 0.35, 0.46, (f) => (f === 'py' ? null : F('wood', wood, slats(2, 0))), 'ny');
  b.box(-0.42, 0.3, -0.42, 0.42, 0.32, 0.42, F('soil', [74, 54, 38]), 'ny');
  const stage = num(c, 'stage', 1);
  if (stage <= 0) return;
  const leaf: RGB = [70 + stage * 10, 130, 60];
  const h = 0.08 + stage * 0.12;
  for (let i = 0; i < 6; i++) {
    const x = -0.28 + (i % 3) * 0.28, z = -0.18 + Math.floor(i / 3) * 0.36;
    const r = 0.07 + stage * 0.02;
    b.frustum(x - 0.02, z - 0.02, x + 0.02, z + 0.02, 0.32, 0.32 + h, x - r, z - r, x + r, z + r, F('foliage', leaf), 'ny');
    if (stage >= 3) b.box(x - 0.03, 0.32 + h, z - 0.03, x + 0.03, 0.38 + h, z + 0.03, F('plastic', [200, 60, 50]), 'ny');
  }
};

/** Standing mirror in a frame. */
export const mirror: Build = (b, c) => {
  const wood = woodOf(c.pal, [110, 76, 44]);
  b.box(-0.35, 0, -0.2, 0.35, 0.05, 0.2, F('wood', wood));
  b.box(-0.35, 0.05, -0.04, 0.35, 1.9, 0.04, (f) => (f === 'pz' ? F('wood', wood, inset(0.1, 0.05, 0.9, 0.95, c.p.broken ? [70, 80, 90] : [170, 196, 206], false, true)) : F('wood', shade(wood, 0.9))));
};

/** Arcade cabinet / pinball: tall cabinet with a screen and control deck. */
export const arcade: Build = (b, c) => {
  const col = bodyOf(c.pal);
  if (c.p.pinball) {
    legs(b, -0.3, -0.45, 0.3, 0.45, 0.7, 0.05, F('metal', STEEL));
    b.box(-0.3, 0.7, -0.45, 0.3, 0.85, 0.45, F('paint', col));
    b.box(-0.3, 0.85, -0.45, 0.3, 1.5, -0.35, (f) => (f === 'pz' ? F('glow', shade(col, 1.2), inset(0.1, 0.1, 0.9, 0.9, [40, 40, 60], false, true)) : F('paint', col)));
    return;
  }
  b.box(-0.32, 0, -0.35, 0.32, 1.8, 0.2, (f) => (f === 'nx' || f === 'px' ? F('paint', col, inset(0.1, 0.2, 0.9, 0.6, shade(col, 1.4), false, false)) : F('paint', shade(col, 0.6))), 'ny');
  b.box(-0.3, 1.1, 0.2, 0.3, 1.55, 0.21, F('screen', [30, 40, 60], inset(0.1, 0.1, 0.9, 0.9, [60, 120, 160], false, true)));
  b.tiltedBox(-0.32, 0.32, 0.95, 0.2, 0.05, 0.22, -1.3, F('plastic', [30, 30, 34], knobs(3, [220, 60, 50], 0.5)));
  b.box(-0.32, 1.6, 0.18, 0.32, 1.8, 0.22, F('glow', [240, 220, 120]));
};

/** Treadmill / exercise machine / weight bench. */
export const fitness: Build = (b, c) => {
  const frame = F('metal', [60, 62, 66]);
  if (c.p.kind === 'treadmill') {
    b.box(-0.3, 0, -0.45, 0.3, 0.18, 0.48, (f) => (f === 'py' ? F('rubber', [34, 34, 36]) : frame), 'ny');
    for (const x of [-0.28, 0.24]) b.tiltedBox(x, x + 0.04, 0.18, -0.4, 1.1, 0.04, 0.12, frame);
    b.box(-0.3, 1.2, -0.52, 0.3, 1.3, -0.36, F('plastic', [40, 40, 44], inset(0.2, 0.2, 0.8, 0.8, [90, 150, 90], false, false)));
    return;
  }
  // weight bench with a bar on uprights
  b.box(-0.15, 0.4, -0.45, 0.15, 0.48, 0.3, F('leather', [40, 40, 44]), 'ny');
  legs(b, -0.15, -0.45, 0.15, 0.3, 0.4, 0.04, frame);
  for (const x of [-0.3, 0.26]) b.box(x, 0, -0.5, x + 0.04, 1.1, -0.46, frame, 'ny');
  b.box(-0.5, 1.08, -0.5, 0.5, 1.11, -0.47, F('chrome', STEEL));
  for (const x of [-0.46, 0.42]) b.box(x, 0.96, -0.6, x + 0.04, 1.24, -0.37, F('metal', [30, 30, 32]));
};

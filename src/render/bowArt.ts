// Procedural first-person pixel art for drawn weapons (render/viewmodel.ts): a bow held upright
// in the left hand with the right hand drawing the string back toward the cheek, or a
// slingshot's fork with its band pulled back. UltiCa only has a small item icon for these, and a
// bow held like a pistol (the icon pointed at the crosshair) is what made a longbow read as a gun.
//
// One canvas per draw stage (0..1) and nocked/empty, all the same size with the grip at the same
// pixel, so the viewmodel swaps textures without moving the pivot. Coordinates are low-res
// pixels, y down; `grip` is the left hand / arrow rest, `head` where the arrowhead (or stone)
// sits at that draw, so the viewmodel can put the arrowhead on the crosshair at full draw.

export type DrawnKind = 'bow' | 'slingshot';

export interface BowFrame {
  canvas: HTMLCanvasElement;
  grip: { x: number; y: number };
  head: { x: number; y: number };
}

const OUT = '#1c130c';
const WOOD = '#7a4a22', WOOD_LIGHT = '#a8703a', WOOD_DARK = '#4e2e14';
const WRAP = '#3a2c20';
const STRING = '#e2dac4';
const SHAFT = '#9a7648', SHAFT_DARK = '#5e4428';
const FLETCH_A = '#e8e4dc', FLETCH_B = '#b8322a';
const STEEL = '#b4b8c0';
const BAND = '#6a3a2a';
const STONE = '#8c8a84', STONE_LIGHT = '#b0aea6';

function dot(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, s = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), s, s);
}

/** A pixel line of width `w` (square brush), outlined when `outline` is set. */
function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string, w: number, outline?: string): void {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  if (outline) for (let i = 0; i <= n; i++) dot(ctx, outline, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, w + 2);
  for (let i = 0; i <= n; i++) dot(ctx, color, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, w);
}

/** Quadratic curve from a through control c to b, as a tapered outlined pixel stroke. */
function limb(ctx: CanvasRenderingContext2D, a: [number, number], c: [number, number], b: [number, number], w0: number, w1: number): void {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 1.2);
  const pt = (t: number): [number, number] => [
    (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
    (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1],
  ];
  for (const pass of [0, 1, 2]) {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [x, y] = pt(t);
      const w = Math.max(1, Math.round(w0 + (w1 - w0) * t));
      if (pass === 0) dot(ctx, OUT, x, y, w + 2);
      else if (pass === 1) dot(ctx, WOOD, x, y, w);
      else if (w >= 3) dot(ctx, WOOD_LIGHT, x - 1, y, 1);
    }
  }
}

/**
 * One frame. `lowH` = low-res screen height (sizes scale with it), `draw` 0..1, `hand` = the
 * fist sprite (fist top-left, sleeve running down-right) at the viewmodel's hand scale.
 */
export function bowFrame(kind: DrawnKind, lowH: number, draw: number, nocked: boolean, hand: HTMLCanvasElement, hs: number): BowFrame {
  const H = Math.round(lowH * 1.05), W = Math.round(lowH * 0.95);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const g = { x: Math.round(W * 0.3), y: Math.round(H * 0.5) };
  const d = Math.max(0, Math.min(1, draw));
  // Nock point: on the string at rest, pulled down-right toward the cheek as the draw grows.
  const rest = { x: g.x + lowH * 0.035, y: g.y + lowH * 0.01 };
  const full = { x: g.x + lowH * 0.5, y: g.y + lowH * 0.36 };
  const n = { x: rest.x + (full.x - rest.x) * d, y: rest.y + (full.y - rest.y) * d };
  let head: { x: number; y: number };
  if (kind === 'bow') {
    const L = lowH * 0.48;
    // The top leans a little left (a canted grip); the limbs bend more as the draw grows.
    const bend = lowH * (0.035 + 0.05 * d);
    const top: [number, number] = [g.x - lowH * 0.06 + lowH * 0.02 * d, g.y - L];
    const bot: [number, number] = [g.x + lowH * 0.03 + lowH * 0.02 * d, g.y + L];
    const gp: [number, number] = [g.x, g.y];
    // String first (the bow's limbs are in front of it where they cross near the tips).
    line(ctx, top[0] + 1, top[1] + 2, n.x, n.y, STRING, 1);
    line(ctx, bot[0] + 1, bot[1] - 2, n.x, n.y, STRING, 1);
    limb(ctx, gp, [g.x - bend, g.y - L * 0.55], top, 5, 2);
    limb(ctx, gp, [g.x - bend * 0.8, g.y + L * 0.55], bot, 5, 2);
    // Leather grip wrap.
    line(ctx, g.x, g.y - lowH * 0.04, g.x, g.y + lowH * 0.04, WRAP, 5, OUT);
    dot(ctx, WOOD_DARK, top[0], top[1], 3);
    dot(ctx, WOOD_DARK, bot[0], bot[1], 3);
  } else {
    // Slingshot: a Y fork, the grip below, bands from the prong tips to the pouch.
    const prongL = { x: g.x - lowH * 0.07, y: g.y - lowH * 0.16 }, prongR = { x: g.x + lowH * 0.07, y: g.y - lowH * 0.14 };
    const fork = { x: g.x, y: g.y - lowH * 0.04 };
    line(ctx, prongL.x, prongL.y, n.x, n.y, BAND, 2);
    line(ctx, g.x, g.y + lowH * 0.18, fork.x, fork.y, WOOD, 5, OUT);
    line(ctx, fork.x, fork.y, prongL.x, prongL.y, WOOD, 4, OUT);
    line(ctx, fork.x, fork.y, prongR.x, prongR.y, WOOD, 4, OUT);
    line(ctx, prongR.x, prongR.y, n.x, n.y, BAND, 2);
  }
  // The arrow (or stone), from the nock through the rest.
  const ux = g.x - n.x, uy = g.y - n.y, ul = Math.hypot(ux, uy) || 1;
  head = kind === 'bow' ? { x: g.x + (ux / ul) * lowH * 0.12, y: g.y + (uy / ul) * lowH * 0.12 } : { x: n.x, y: n.y };
  if (nocked && kind === 'bow') {
    line(ctx, n.x, n.y, head.x, head.y, SHAFT, 2, OUT);
    line(ctx, n.x, n.y, head.x - (ux / ul) * 2, head.y - (uy / ul) * 2, SHAFT_DARK, 1);
    // Fletching: three vanes just in front of the nock.
    for (let i = 0; i < 3; i++) {
      const t = 6 + i * 3, px = n.x + (ux / ul) * t, py = n.y + (uy / ul) * t;
      dot(ctx, i === 1 ? FLETCH_B : FLETCH_A, px - (uy / ul) * 2, py + (ux / ul) * 2, 2);
      dot(ctx, FLETCH_A, px + (uy / ul) * 2, py - (ux / ul) * 2, 2);
    }
    dot(ctx, OUT, head.x, head.y, 6);
    dot(ctx, STEEL, head.x, head.y, 4);
    dot(ctx, '#e0e4ea', head.x + (ux / ul), head.y + (uy / ul), 1);
  } else if (nocked) {
    dot(ctx, OUT, n.x, n.y, 7);
    dot(ctx, STONE, n.x, n.y, 5);
    dot(ctx, STONE_LIGHT, n.x - 1, n.y - 1, 2);
  }
  // Left hand on the grip (mirrored: sleeve off to the lower left), right hand at the nock.
  const fist = 6 * hs;
  ctx.save();
  ctx.translate(g.x + fist, g.y - fist);
  ctx.scale(-1, 1);
  ctx.drawImage(hand, 0, 0);
  ctx.restore();
  // At rest the drawing hand is off the string (it would sit on top of the grip hand).
  if (d > 0.08) ctx.drawImage(hand, Math.round(n.x - fist), Math.round(n.y - fist));
  return { canvas: c, grip: g, head };
}

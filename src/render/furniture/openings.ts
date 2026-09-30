import type { RGB } from '../colors';
import type { ModelBuilder } from './mesh';
import type { SpritePalette } from './palette';
import { doors, inset, type Decal } from './paint';
import { BRASS, F, STEEL, bodyOf, hsv, lumOf, shade, woodOf } from './kit';

// Window infills and door leaves for the modelled look. The mesher keeps the wall around
// the opening (sill, lintel, arch.ts frame and mullions); these replace the flat textured
// pane that used to fill it — whose broken-glass texture floated in the hole as loose blue
// squares — with real glass (glass.ts), shards, tape, bars, curtains and panelled doors.

export interface WindowState {
  glass: 'intact' | 'broken' | 'none' | 'stained';
  curtains: 'none' | 'open' | 'closed';
  taped: boolean;
  bars: boolean;
  boarded: boolean;
  /** lower sash raised */
  open: boolean;
  stain?: RGB;
}

/** Window state from a terrain id. Pure; unit tested. */
export function windowState(id: string): WindowState {
  const k = (re: RegExp) => re.test(id);
  const glass: WindowState['glass'] = k(/stained/) ? 'stained'
    : k(/window_frame|frame_domestic/) ? 'broken'
      : k(/empty|noglass|grate_window(_with_curtain(_open)?)?_noglass/) ? 'none' : 'intact';
  let curtains: WindowState['curtains'] = 'none';
  if (id === 't_curtains' || k(/with_curtain$|with_curtain_open_window_closed$|bars_curtains|_with_curtain_noglass$/)) curtains = 'closed';
  else if (k(/window_domestic|with_curtain_open|frame_domestic|empty_domestic/)) curtains = 'open';
  if (k(/open_window_closed$/)) curtains = 'open';
  const stain: Record<string, RGB> = { blue: [70, 110, 200], green: [70, 160, 90], red: [190, 60, 60] };
  return {
    glass,
    curtains,
    taped: k(/taped/),
    bars: k(/bars|grate/),
    boarded: k(/boarded/),
    open: k(/window_open$|no_curtains_open$|plastic_window_open$|window_with_curtain_open$|_with_curtain_open$/) && !k(/open_window_closed/),
    stain: stain[/stained_(blue|green|red)/.exec(id)?.[1] ?? ''],
  };
}

/** Curtain fabric colour: the most saturated common colour of the window sprite. */
export function curtainColour(pal: SpritePalette | null): RGB {
  const c = pal?.clusters.find((q) => hsv(q.c)[1] > 0.3 && lumOf(q.c) > 40 && !(hsv(q.c)[0] > 170 && hsv(q.c)[0] < 230));
  return c?.c ?? [150, 64, 60];
}

// Local space: the wall runs along x (-0.5..0.5), the pane plane is z = 0, +z = inside,
// y = 0 at the sill up to `H` at the head.
const FW = 0.07; // frame width drawn by arch.ts windowDetail

export function buildWindow(b: ModelBuilder, s: WindowState, H: number, curtain: RGB): void {
  const x0 = -0.5 + FW, x1 = 0.5 - FW, y0 = FW, y1 = H - FW;
  const mx = 0, my = H / 2 + 0.1; // mullion cross (arch.ts: mid = (sill+head)/2 + 0.1)
  const panes: [number, number, number, number][] = [[x0, y0, mx - 0.025, my - 0.025], [mx + 0.025, y0, x1, my - 0.025], [x0, my + 0.025, mx - 0.025, y1], [mx + 0.025, my + 0.025, x1, y1]];
  if (s.glass === 'intact') {
    for (const [a, c, e, g] of panes) {
      // raised lower sash: the bottom panes are open (the upper sash doubles behind the top)
      if (s.open && c < my) continue;
      b.glass([a, c, 0], [e, c, 0], [e, g, 0], [a, g, 0]);
    }
    if (s.taped) for (const [a, c, e, g] of panes) tapeX(b, a, c, e, g);
  } else if (s.glass === 'broken') {
    // jagged shards left in each pane's frame: triangles from the edges pointing inward
    let n = 0;
    for (const [a, c, e, g] of panes) {
      const w = e - a, h = g - c;
      const H2 = (i: number) => ((Math.imul(n * 97 + i * 31, 2654435761) >>> 0) % 1000) / 1000;
      n++;
      // bottom edge: 2-3 teeth
      b.glass([a, c, 0], [a + w * 0.45, c, 0], [a + w * (0.15 + H2(1) * 0.2), c + h * (0.25 + H2(2) * 0.3), 0], [a + w * (0.15 + H2(1) * 0.2), c + h * (0.25 + H2(2) * 0.3), 0]);
      b.glass([a + w * 0.55, c, 0], [e, c, 0], [e - w * 0.12, c + h * (0.15 + H2(3) * 0.25), 0], [e - w * 0.12, c + h * (0.15 + H2(3) * 0.25), 0]);
      // top edge
      b.glass([e, g, 0], [a + w * 0.3, g, 0], [a + w * (0.55 + H2(4) * 0.2), g - h * (0.3 + H2(5) * 0.35), 0], [a + w * (0.55 + H2(4) * 0.2), g - h * (0.3 + H2(5) * 0.35), 0]);
      // a sliver along one side
      if (H2(6) > 0.4) b.glass([a, g, 0], [a, c + h * 0.35, 0], [a + w * 0.18, g - h * 0.2, 0], [a + w * 0.18, g - h * 0.2, 0]);
    }
  } else if (s.glass === 'stained') {
    const col = s.stain ?? [120, 120, 180];
    for (const [a, c, e, g] of panes) b.quad([a, c, 0.004], [e, c, 0.004], [e, g, 0.004], [a, g, 0.004], F('glow', col, leaded(col)));
    for (const [a, c, e, g] of panes) b.quad([e, c, -0.004], [a, c, -0.004], [a, g, -0.004], [e, g, -0.004], F('glow', shade(col, 0.8), leaded(col)));
  }
  if (s.bars) {
    const bar = F('metal', [58, 60, 62]);
    for (let i = 0; i < 6; i++) {
      const x = -0.5 + 0.1 + i * 0.16;
      b.box(x - 0.012, 0, -0.14, x + 0.012, H, -0.116, bar);
    }
    for (const y of [0.1, H - 0.1]) b.box(-0.5, y - 0.015, -0.145, 0.5, y + 0.015, -0.11, bar);
  }
  if (s.curtains !== 'none') curtains(b, s.curtains === 'closed', H, curtain);
}

/** Masking tape X over a pane, on both faces. */
function tapeX(b: ModelBuilder, a: number, c: number, e: number, g: number): void {
  const tape = F('paper', [200, 190, 150], undefined, false);
  const t = 0.018;
  for (const z of [0.004, -0.004]) {
    const fwd = z > 0;
    const q = (p: [number, number], r: [number, number]) => {
      const dx = r[0] - p[0], dy = r[1] - p[1], L = Math.hypot(dx, dy), nx = (-dy / L) * t, ny = (dx / L) * t;
      if (fwd) b.quad([p[0] - nx, p[1] - ny, z], [r[0] - nx, r[1] - ny, z], [r[0] + nx, r[1] + ny, z], [p[0] + nx, p[1] + ny, z], tape);
      else b.quad([r[0] - nx, r[1] - ny, z], [p[0] - nx, p[1] - ny, z], [p[0] + nx, p[1] + ny, z], [r[0] + nx, r[1] + ny, z], tape);
    };
    q([a, c], [e, g]);
    q([a, g], [e, c]);
  }
}

/** Curtains on the inside: gathered at the sides (open) or drawn across (closed), with a rod. */
function curtains(b: ModelBuilder, closed: boolean, H: number, col: RGB): void {
  const z = 0.16;
  b.box(-0.56, H + 0.04, z - 0.012, 0.56, H + 0.065, z + 0.012, F('wood', [90, 64, 44]));
  const folds = closed ? 10 : 3;
  const strip = (xa: number, xb: number, i: number, drop: number) => {
    const dz = i % 2 ? 0.035 : 0;
    const c = i % 2 ? shade(col, 0.82) : col;
    b.box(xa, drop, z - 0.012 + dz, xb, H + 0.04, z + 0.012 + dz, F('fabric', c), 'ny');
  };
  if (closed) {
    for (let i = 0; i < folds; i++) strip(-0.54 + (1.08 * i) / folds, -0.54 + (1.08 * (i + 1)) / folds, i, -0.05);
  } else {
    for (let i = 0; i < folds; i++) {
      strip(-0.56 + i * 0.055, -0.56 + (i + 1) * 0.055, i, -0.05);
      strip(0.56 - (i + 1) * 0.055, 0.56 - i * 0.055, i, -0.05);
    }
  }
}

/** Lead came grid over stained glass. */
function leaded(col: RGB): Decal {
  return {
    k: `lead:${col.join(',')}`,
    draw(img, r, w, h) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (x % 6 === 0 || y % 7 === 0 || (x + y) % 11 === 0) img.set(x, y, [40, 38, 36]);
        else if ((x * 7 + y * 3) % 13 === 0) img.set(x, y, shade(r[3], 1.1));
      }
    },
  };
}

// --- doors --------------------------------------------------------------------------------

export type DoorKind = 'wood' | 'paint' | 'glass' | 'metal' | 'broken' | 'frame' | 'boarded' | 'curtain' | 'screen';

export function doorKind(id: string): DoorKind {
  const k = (re: RegExp) => re.test(id);
  if (k(/_frame$|door_frame/)) return 'frame';
  if (k(/_b$|_b_peep$|door_b\b/)) return 'broken';
  if (k(/boarded/)) return 'boarded';
  if (k(/curtain|beaded/)) return 'curtain';
  if (k(/screen/)) return 'screen';
  if (k(/glass|door_window/)) return 'glass';
  if (k(/metal|bulkhead|mdoor|rdoor|reinforced|bar_|secretdoor|lab_c|lab_o|lab_b/)) return 'metal';
  if (k(/door_(red|white|gray|green)/)) return 'paint';
  return 'wood';
}

const PAINT: Record<string, RGB> = { red: [150, 50, 44], white: [214, 212, 204], gray: [120, 124, 128], green: [60, 110, 70] };

/**
 * Door leaf in hinge space: hinge edge at x = 0, leaf along +x to `W`, faces ±z, y from 0
 * to `H`. `pal` is the door sprite's palette.
 */
export function buildDoorLeaf(b: ModelBuilder, kind: DoorKind, id: string, pal: SpritePalette | null, W: number, H: number): void {
  const T = 0.045;
  const wood = pal ? woodOf(pal, [120, 80, 48]) : [120, 80, 48] as RGB;
  const paintC = PAINT[/door_(red|white|gray|green)/.exec(id)?.[1] ?? ''] ?? (pal ? bodyOf(pal) : [150, 150, 150]);
  const handle = (z: number, c: RGB) => {
    b.box(W - 0.1, 1.0, z > 0 ? T / 2 : -T / 2 - 0.05, W - 0.07, 1.03, z > 0 ? T / 2 + 0.05 : -T / 2, F('chrome', c));
    b.box(W - 0.16, 1.0, z > 0 ? T / 2 + 0.035 : -T / 2 - 0.05, W - 0.07, 1.03, z > 0 ? T / 2 + 0.05 : -T / 2 - 0.035, F('chrome', c));
  };
  switch (kind) {
    case 'frame':
      return;
    case 'wood': case 'paint': case 'boarded': {
      const col = kind === 'paint' ? paintC : wood;
      const K = kind === 'paint' ? 'paint' : 'wood';
      b.box(0, 0, -T / 2, W, H, T / 2, (f) => (f === 'pz' || f === 'nz' ? F(K, col, doorPanels()) : F(K, shade(col, 0.85))));
      handle(1, BRASS); handle(-1, BRASS);
      if (kind === 'boarded') {
        const plank = F('wood', [140, 108, 70]);
        for (const [y, tilt] of [[0.4, 0.05], [1.05, -0.04], [1.7, 0.06]] as const) b.tiltedBox(-0.02, W + 0.02, y, -T / 2 - 0.03, 0.14, 0.025, tilt, plank);
      }
      return;
    }
    case 'metal': {
      const col = pal ? shade(bodyOf(pal), 1) : [110, 116, 120] as RGB;
      const c: RGB = hsv(col)[1] > 0.3 ? col : [118, 124, 128];
      b.box(0, 0, -T / 2, W, H, T / 2, (f) => (f === 'pz' || f === 'nz' ? F('metal', c, inset(0.15, 0.1, 0.85, 0.35, shade(c, 0.85), true, false)) : F('metal', shade(c, 0.85))));
      handle(1, STEEL); handle(-1, STEEL);
      return;
    }
    case 'glass': case 'screen': {
      const fc: RGB = kind === 'screen' ? wood : lumOf(paintC) > 150 ? [200, 200, 196] : [70, 74, 78];
      const fr = kind === 'screen' ? F('wood', fc) : F('metal', fc);
      const r = 0.09;
      b.box(0, 0, -T / 2, r, H, T / 2, fr);
      b.box(W - r, 0, -T / 2, W, H, T / 2, fr);
      b.box(r, H - r, -T / 2, W - r, H, T / 2, fr);
      b.box(r, 0, -T / 2, W - r, 0.25, T / 2, fr);
      if (kind === 'glass') {
        b.glass([r, 0.25, 0], [W - r, 0.25, 0], [W - r, H - r, 0], [r, H - r, 0]);
      } else {
        const mesh = F('dark', [40, 40, 40], screenMesh(), false);
        b.quad([r, 0.25, 0.003], [W - r, 0.25, 0.003], [W - r, H - r, 0.003], [r, H - r, 0.003], mesh);
        b.quad([W - r, 0.25, -0.003], [r, 0.25, -0.003], [r, H - r, -0.003], [W - r, H - r, -0.003], mesh);
        b.box(r, 1.0, -T / 2, W - r, 1.08, T / 2, fr);
      }
      handle(1, STEEL); handle(-1, STEEL);
      return;
    }
    case 'broken': {
      // what's left on the hinges: a narrow strip with a jagged free edge (stepped boxes)
      const col = kind === 'broken' && /red|white|gray|green/.test(id) ? paintC : wood;
      const S = F('wood', col);
      const steps = [0.34, 0.22, 0.4, 0.18, 0.3, 0.12, 0.26];
      for (let i = 0; i < steps.length; i++) {
        const y0 = (H * i) / steps.length, y1 = (H * (i + 1)) / steps.length;
        b.box(0, y0, -T / 2, steps[i], y1, T / 2, S);
      }
      return;
    }
    case 'curtain': {
      const col = pal ? bodyOf(pal) : [140, 60, 60] as RGB;
      for (let i = 0; i < 8; i++) b.box((W * i) / 8, 0.05, -0.01 + (i % 2) * 0.02, (W * (i + 1)) / 8, H, 0.01 + (i % 2) * 0.02, F('fabric', i % 2 ? shade(col, 0.85) : col), 'ny');
      return;
    }
  }
}

function doorPanels(): Decal {
  return {
    k: 'dpan6',
    draw(img, r, w, h) {
      // six-panel door: 2 columns x 3 rows of raised panels
      const cols = 2, rows = 3;
      for (let j = 0; j < cols; j++)
        for (let i = 0; i < rows; i++) {
          const x0 = Math.round(w * (0.12 + j * 0.42)), x1 = Math.round(w * (0.46 + j * 0.42)) - 1;
          const y0 = Math.round(h * [0.06, 0.4, 0.62][i]), y1 = Math.round(h * [0.36, 0.58, 0.94][i]) - 1;
          for (let x = x0; x <= x1; x++) { img.set(x, y0, r[3]); img.set(x, y1, r[0]); }
          for (let y = y0; y <= y1; y++) { img.set(x0, y, r[3]); img.set(x1, y, r[0]); }
          for (let y = y0 + 2; y <= y1 - 2; y++) for (let x = x0 + 2; x <= x1 - 2; x++) if ((x + y) % 9 === 0) img.set(x, y, r[1]);
        }
    },
  };
}

function screenMesh(): Decal {
  return {
    k: 'scrmesh',
    draw(img) {
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if ((x & 1) && (y & 1)) img.set(x, y, [0, 0, 0], 0);
    },
  };
}

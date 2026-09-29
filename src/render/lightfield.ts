// CDDA-style tile light map for one z-level around the player (pure logic, no three.js).
//
// Mirrors the shape of CDDA's lightmap.cpp:
//  * natural light: tiles with open sky above ("outside") get full daylight; light enters
//    buildings through transparent boundary tiles (windows, open doors, porches) as a
//    90-degree directional cone cast inward from each boundary tile (apply_directional_light),
//    everything else indoors gets a small constant ambient share (CDDA's inside_light_level).
//  * artificial light: every source is shadowcast (recursive shadowcasting per octant, like
//    CDDA castLight) with CDDA's falloff  lum / (exp(t * d) * d),  so walls stop lamps and
//    fires instead of the light bleeding through them.
// Natural light is stored as a fraction of the current outdoor light (0..1) so it does not
// depend on the time of day; the shader multiplies it with the sky state. Artificial light
// is stored as raw CDDA luminance per RGB channel.

/** CDDA LIGHT_TRANSPARENCY_OPEN_AIR (2.3 / MAX_VIEW_DISTANCE). */
export const OPEN_AIR = 2.3 / 60;
/** Stop casting a source once its light falls below this many luminance units. */
export const LIGHT_CUTOFF = 1.2;
export const MAX_LIGHT_RADIUS = 24;
/** Directional (window) light reach in tiles. */
export const NATURAL_RADIUS = 12;
/** Bounce approximation: natural light also spreads tile to tile (around corners, through
 *  doorways) keeping this share per step, for this many steps. */
export const BOUNCE_DECAY = 0.72;
export const BOUNCE_STEPS = 6;

export interface LightSource {
  x: number; // tile coords (integer)
  y: number;
  /** CDDA luminance */
  lum: number;
  /** colour multipliers 0..1 */
  r: number;
  g: number;
  b: number;
}

/** CDDA light_calc: light reaching distance d (tiles) from a source of luminance lum. */
export function lightFalloff(lum: number, d: number): number {
  if (d < 1) return lum;
  return lum / (Math.exp(OPEN_AIR * d) * d);
}

export function lightRadius(lum: number): number {
  // lum / d >= cutoff, ignoring the (small) exp term
  return Math.min(MAX_LIGHT_RADIUS, Math.max(1, Math.ceil(lum / LIGHT_CUTOFF)));
}

/** Octant transforms (xx, xy, yx, yy); a cell is (ox + dx*xx + dy*xy, oy + dx*yx + dy*yy)
 *  with dy = -row, dx in [-row, 0]. Pairs of octants form the 4 axis cones below. */
export const OCTANTS: readonly [number, number, number, number][] = [
  [1, 0, 0, 1], [-1, 0, 0, 1], // north (y-)
  [0, -1, 1, 0], [0, -1, -1, 0], // east (x+)
  [1, 0, 0, -1], [-1, 0, 0, -1], // south (y+)
  [0, 1, 1, 0], [0, 1, -1, 0], // west (x-)
];
/** Direction index (0 N, 1 E, 2 S, 3 W) -> the two octants making its 90-degree cone. */
export const CONE: readonly [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7]];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/**
 * Recursive shadowcasting (Bergstrom) over one octant. `visit` receives every tile that
 * receives light, including the opaque tiles that stop it (their faces are lit).
 * `opaque` must return true outside the area of interest so recursion is bounded.
 */
export function castOctant(
  opaque: (x: number, y: number) => boolean, ox: number, oy: number, radius: number,
  oct: readonly [number, number, number, number], visit: (x: number, y: number, d: number) => void,
): void {
  const [xx, xy, yx, yy] = oct;
  const r2 = radius * radius;
  const cast = (row: number, start: number, end: number): void => {
    if (start < end) return;
    let newStart = 0;
    for (let i = row; i <= radius; i++) {
      let blocked = false;
      const dy = -i;
      for (let dx = -i; dx <= 0; dx++) {
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);
        if (start < rSlope) continue;
        if (end > lSlope) break;
        const X = ox + dx * xx + dy * xy, Y = oy + dx * yx + dy * yy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) visit(X, Y, Math.sqrt(d2));
        const op = opaque(X, Y);
        if (blocked) {
          if (op) { newStart = rSlope; continue; }
          blocked = false;
          start = newStart;
        } else if (op && i < radius) {
          blocked = true;
          cast(i + 1, start, lSlope);
          newStart = rSlope;
        }
      }
      if (blocked) break;
    }
  };
  cast(1, 1, 0);
}

export class LightField {
  /** World tile of cell (0, 0). */
  ox = 0;
  oy = 0;
  readonly opaque: Uint8Array;
  /** 1 = nothing overhead (open sky) */
  readonly outside: Uint8Array;
  /** fraction of outdoor light, 0..1 */
  readonly natural: Float32Array;
  /** raw CDDA luminance, RGB interleaved (gameplay: lightAt) */
  readonly art: Float32Array;
  /** same light with inverse-square falloff, for display: CDDA's 1/d falloff is right for
   *  "can I see there" but paints far too wide and flat a pool on screen */
  readonly disp: Float32Array;
  /** Share of outdoor light that reaches deep interiors (CDDA inside_light_level). */
  indoorAmbient = 0.07;
  private stamp: Int32Array;
  private stampId = 0;

  constructor(readonly size: number) {
    const n = size * size;
    this.opaque = new Uint8Array(n);
    this.outside = new Uint8Array(n);
    this.natural = new Float32Array(n);
    this.art = new Float32Array(n * 3);
    this.disp = new Float32Array(n * 3);
    this.stamp = new Int32Array(n);
  }

  /** Cell index of world tile (x, y), or -1 outside the field. */
  index(x: number, y: number): number {
    const lx = x - this.ox, ly = y - this.oy;
    if (lx < 0 || ly < 0 || lx >= this.size || ly >= this.size) return -1;
    return ly * this.size + lx;
  }

  /** Opaque, with everything beyond the field counting as opaque (bounds the casts). */
  readonly blocks = (x: number, y: number): boolean => {
    const i = this.index(x, y);
    return i < 0 || this.opaque[i] === 1;
  };

  computeNatural(): void {
    const S = this.size;
    const nat = this.natural;
    const out = this.outside;
    const op = this.opaque;
    for (let i = 0; i < nat.length; i++) nat[i] = out[i] ? 1 : this.indoorAmbient;
    // Light enters through transparent covered tiles that touch open sky.
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (out[i] || op[i]) continue;
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const j = ny * S + nx;
          if (!out[j] || op[j]) continue;
          nat[i] = 1;
          // Cone points away from the open neighbour, into the building.
          const inward = (d + 2) & 3;
          const wx = x + this.ox, wy = y + this.oy;
          for (const o of CONE[inward]) {
            castOctant(this.blocks, wx, wy, NATURAL_RADIUS, OCTANTS[o], (tx, ty, dist) => {
              const k = this.index(tx, ty);
              if (k < 0) return;
              const v = lightFalloff(1, dist);
              if (v > nat[k]) nat[k] = v;
            });
          }
        }
      }
    this.bounce();
  }

  /** Spread natural light between open covered tiles (CDDA has no bounce light; without it
   *  a room is pitch black one step outside a window's cone). Sweeps alternate direction so
   *  the in-place update doesn't favour one side. */
  private bounce(): void {
    const S = this.size, nat = this.natural, op = this.opaque, out = this.outside;
    for (let step = 0; step < BOUNCE_STEPS; step++) {
      const fwd = (step & 1) === 0;
      for (let n = 0; n < S * S; n++) {
        const i = fwd ? n : S * S - 1 - n;
        if (op[i] || out[i]) continue;
        const x = i % S;
        let m = 0;
        if (x > 0 && !op[i - 1]) m = Math.max(m, nat[i - 1]);
        if (x < S - 1 && !op[i + 1]) m = Math.max(m, nat[i + 1]);
        if (i >= S && !op[i - S]) m = Math.max(m, nat[i - S]);
        if (i < S * S - S && !op[i + S]) m = Math.max(m, nat[i + S]);
        const v = m * BOUNCE_DECAY;
        if (v > nat[i]) nat[i] = v;
      }
    }
  }

  computeArtificial(sources: readonly LightSource[]): void {
    const art = this.art, disp = this.disp;
    art.fill(0);
    disp.fill(0);
    for (const s of sources) {
      const si = this.index(s.x, s.y);
      if (si < 0) continue;
      const id = ++this.stampId;
      const stamp = this.stamp;
      const add = (k: number, v: number, dv: number) => {
        art[k * 3] += v * s.r;
        art[k * 3 + 1] += v * s.g;
        art[k * 3 + 2] += v * s.b;
        disp[k * 3] += dv * s.r;
        disp[k * 3 + 1] += dv * s.g;
        disp[k * 3 + 2] += dv * s.b;
      };
      stamp[si] = id;
      add(si, s.lum, s.lum);
      const R = lightRadius(s.lum);
      // Adjacent octants share their axis/diagonal cells; the stamp keeps each cell lit once.
      const visit = (tx: number, ty: number, dist: number) => {
        const k = this.index(tx, ty);
        if (k < 0 || stamp[k] === id) return;
        stamp[k] = id;
        add(k, lightFalloff(s.lum, dist), s.lum / Math.max(1, dist * dist));
      };
      // A source inside an opaque tile (lamp furniture, a wall light) still lights around
      // itself: casting starts from the source cell, which castOctant never tests.
      for (const o of OCTANTS) castOctant(this.blocks, s.x, s.y, R, o, visit);
    }
  }

  /** Raw CDDA luminance of the brightest artificial channel at a tile. */
  artificialAt(x: number, y: number): number {
    const i = this.index(x, y);
    if (i < 0) return 0;
    return Math.max(this.art[i * 3], this.art[i * 3 + 1], this.art[i * 3 + 2]);
  }

  naturalAt(x: number, y: number): number {
    const i = this.index(x, y);
    return i < 0 ? -1 : this.natural[i];
  }
}

/**
 * Display curve: CDDA luminance -> irradiance for the shader. Logarithmic like perceived
 * brightness, so a candle (5) reads, a lamp at arm's length (40) is about daylight-ambient
 * bright, and overlapping sources saturate instead of blowing out.
 */
export function displayIrradiance(lum: number, scale = 3.2, knee = 12): number {
  if (lum <= 0) return 0;
  return (scale * Math.log(1 + lum / knee)) / Math.log(1 + 100 / knee);
}

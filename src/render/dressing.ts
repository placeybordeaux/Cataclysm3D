import type { GeomBuilder, V3 } from './geometry';
import type { RGB } from './colors';
import { hash2 } from './ground';
import { Img } from './pixelArt';
import type { TileFrame } from './textureSource';
import type { ModelAtlas } from './furniture/atlas';
import { ModelBuilder, placeModel, type ModelMesh } from './furniture/mesh';
import { F } from './furniture/kit';
import type { Room } from './rooms';

// Set dressing for the painted look (docs/FURNITURE.md "Lived-in and abandoned"): render-only,
// deterministic from room / building seeds, a handful of alpha-tested quads per wall. The base
// paint stays flat (the luminance bump turns texture noise into blotches); these are the
// deliberate marks — pictures, posters, calendars, clocks, water stains, grime at the foot
// and head of walls, peeling paint, blood and handprints by doors in some houses, graffiti
// outside — plus rugs, light switches, outlets, ceiling lamps, house numbers, porch lights.

type Geo = (f: TileFrame) => GeomBuilder;

// Wall face frames, per direction d (0 N, 1 E, 2 S, 3 W) of tile (x, y): A = the face's
// bottom-left corner seen from outside (on the ground plane), T = along the face.
const AX = [1, 1, 0, 0], AY = [0, 1, 1, 0];
const TX = [-1, 0, 1, 0], TY = [0, -1, 0, 1];
const NX = [0, 1, 0, -1], NY = [-1, 0, 1, 0];
/** Direction of the along-wall neighbour at the face's s = 0 and s = 1 ends. */
export const FACE_ENDS: [number, number][] = [[1, 3], [2, 0], [3, 1], [0, 2]];

const clamp = (v: number) => Math.max(0, Math.min(255, v));
const sh = (c: RGB, k: number): RGB => [clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k)];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

// --- decal painters (all pure; alpha 0 = clear) ---------------------------------------------

const ART: RGB[][] = [
  [[110, 150, 190], [90, 130, 80], [70, 100, 60], [150, 130, 90]],
  [[220, 150, 90], [150, 90, 70], [90, 60, 60], [60, 50, 50]],
  [[170, 190, 210], [210, 210, 200], [90, 110, 140], [60, 70, 90]],
  [[200, 180, 120], [170, 120, 60], [120, 80, 40], [80, 60, 40]],
];

export function paintPicture(w: number, h: number, seed: number): Img {
  const img = new Img(w, h);
  const art = ART[seed % ART.length];
  const frame: RGB = [[96, 64, 36], [180, 150, 70], [40, 38, 36], [210, 206, 196]][(seed >> 3) & 3] as RGB;
  const horizon = Math.floor(h * (0.4 + ((seed >> 5) & 3) * 0.06));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const border = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
      let c: RGB;
      if (border) c = x === 0 || y === 0 ? sh(frame, 1.2) : x === w - 1 || y === h - 1 ? sh(frame, 0.7) : frame;
      else if (y < horizon) c = sh(art[0], 1 + (y / horizon) * 0.2);
      else {
        const hill = horizon + Math.round(Math.sin((x + seed) * 0.5) * 1.5);
        c = y < hill + 2 ? art[1] : y < h * 0.8 ? art[2] : art[3];
      }
      img.set(x, y, c);
    }
  return img;
}

export function paintPoster(w: number, h: number, seed: number): Img {
  const img = new Img(w, h);
  const bg: RGB = [[200, 60, 50], [40, 60, 110], [230, 200, 80], [30, 30, 34], [60, 140, 90]][seed % 5] as RGB;
  const fg: RGB = [[240, 236, 220], [230, 190, 60], [30, 30, 34], [220, 60, 50]][(seed >> 3) & 3] as RGB;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = bg;
      if (y > h * 0.15 && y < h * 0.55 && Math.hypot(x - w / 2, y - h * 0.35) < w * 0.3) c = fg; // the "photo" disc
      if (y > h * 0.65 && y < h * 0.9 && (y % 3 === 0) && x > 2 && x < w - 3 - (hash2(y, seed, 1) % 4)) c = fg; // text lines
      // torn corner, sun-bleached edge
      if (x + y < ((seed >> 5) & 3)) { img.set(x, y, [0, 0, 0], 0); continue; }
      img.set(x, y, y === 0 ? sh(c, 1.1) : c);
    }
  return img;
}

export function paintCalendar(w: number, h: number, seed: number): Img {
  const img = new Img(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c: RGB = [226, 222, 212];
      if (y < h * 0.45) c = y < 2 ? [200, 60, 50] : ART[seed % ART.length][y < h * 0.3 ? 0 : 2];
      else if ((x % 3 === 0 || (y - Math.floor(h * 0.45)) % 3 === 0)) c = [170, 166, 158];
      img.set(x, y, c);
    }
  return img;
}

export function paintClock(s: number): Img {
  const img = new Img(s, s);
  const c = (s - 1) / 2;
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d > c + 0.3) { img.set(x, y, [0, 0, 0], 0); continue; }
      img.set(x, y, d > c - 1 ? [40, 40, 44] : [232, 228, 218]);
    }
  // hands (stopped at some hour)
  for (let t = 0; t < c * 0.7; t++) img.set(Math.round(c), Math.round(c - t), [30, 30, 30]);
  for (let t = 0; t < c * 0.5; t++) img.set(Math.round(c + t * 0.8), Math.round(c + t * 0.6), [30, 30, 30]);
  return img;
}

/** Irregular blotch (water stain, peeling patch, blood smear): alpha-cut noise disc. */
export function paintBlotch(w: number, h: number, seed: number, kind: 'stain' | 'peel' | 'blood'): Img {
  const img = new Img(w, h);
  const cx = w / 2, cy = kind === 'stain' ? h * 0.25 : h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = (x - cx) / (w / 2), ny = (y - cy) / (h / 2);
      let r = Math.hypot(nx, ny) + ((hash2(x >> 1, y >> 1, seed) % 100) / 100 - 0.5) * 0.45;
      if (kind === 'stain') r = Math.hypot(nx, (y - cy) / h) + ((hash2(x >> 1, y >> 1, seed) % 100) / 100 - 0.5) * 0.4; // runs downward
      if (kind === 'blood' && y > cy && hash2(x, 0, seed) % 5 === 0 && Math.abs(nx) < 0.6) r = Math.min(r, 0.8 - ((y - cy) / h) * 0.2); // drips
      if (r > 0.95) { img.set(x, y, [0, 0, 0], 0); continue; }
      // stains and blood are dithered toward their edge, peeling is solid with a dark rim
      if (kind !== 'peel' && r > 0.55 && bayer(x, y) < (r - 0.55) / 0.4) { img.set(x, y, [0, 0, 0], 0); continue; }
      let c: RGB;
      if (kind === 'stain') c = r > 0.75 ? [96, 76, 50] : [132, 112, 80];
      else if (kind === 'blood') c = r > 0.7 ? [70, 12, 10] : [104, 20, 16];
      else c = r > 0.8 ? [120, 116, 104] : [210, 204, 188];
      img.set(x, y, c);
    }
  return img;
}

export function paintHandprint(seed: number): Img {
  const w = 8, h = 10;
  const img = new Img(w, h);
  img.fill([0, 0, 0], 0);
  const c: RGB = [96, 18, 14];
  for (let y = 5; y < 10; y++) for (let x = 1; x < 7; x++) if (!(y === 9 && (x === 1 || x === 6))) img.set(x, y, c);
  for (const [fx, top] of [[1, 2], [3, 0], [4, 0], [6, 1]]) for (let y = top; y < 5; y++) img.set(fx, y, c);
  img.set(0, 6, c); img.set(0, 7, c);
  if (seed & 1) for (let y = 7; y < 10; y++) img.set(3 + (y & 1), y, [0, 0, 0], 0);
  return img;
}

export function paintGraffiti(w: number, h: number, seed: number): Img {
  const img = new Img(w, h);
  img.fill([0, 0, 0], 0);
  const col: RGB = [[40, 40, 44], [200, 40, 40], [40, 90, 200], [60, 170, 70], [230, 200, 60], [220, 220, 220]][seed % 6] as RGB;
  const out = sh(col, 0.5);
  // a tag: a few thick strokes of a random walk
  let x = 3, y = Math.floor(h / 2);
  for (let i = 0; i < w * 3; i++) {
    const r = hash2(i, seed, 7);
    x += (r & 3) === 0 ? 0 : 1;
    y += ((r >> 2) % 3) - 1;
    y = Math.max(2, Math.min(h - 3, y));
    if (x >= w - 2) break;
    for (let dy = -1; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) img.set(x + dx, y + dy, col);
    img.set(x, y - 2, out); img.set(x, y + 2, out);
  }
  return img;
}

/** Grime band: dithered darkening toward one edge (`fromTop` = ceiling corner). */
export function paintGrime(level: number, variant: number, fromTop: boolean): Img {
  const w = 32, h = 16;
  const img = new Img(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = fromTop ? y / h : 1 - y / h; // 0 at the corner edge
      const wob = ((hash2(x >> 2, 0, variant) % 100) / 100) * 0.25;
      const p = Math.max(0, (1 - t - wob)) * (0.25 + level * 0.25);
      if (bayer(x, y) < p) img.set(x, y, [58, 50, 42]);
      else img.set(x, y, [0, 0, 0], 0);
    }
  return img;
}

export function paintRug(w: number, h: number, seed: number): Img {
  const img = new Img(w, h);
  const base: RGB = [[130, 50, 44], [60, 70, 110], [150, 120, 70], [70, 100, 80], [120, 100, 110]][seed % 5] as RGB;
  const edge: RGB = [210, 196, 160];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const b = Math.min(x, y, w - 1 - x, h - 1 - y);
      let c = base;
      if (b === 0) c = sh(base, 0.6);
      else if (b === 2) c = edge;
      else if (b > 3 && ((x + y) % 6 === 0 || (x - y + 600) % 6 === 0)) c = sh(base, 1.25);
      if (hash2(x, y, seed) % 13 === 0) c = sh(c, 0.9);
      img.set(x, y, c);
    }
  return img;
}

/** Wall tiles for a bathroom / kitchen splash: 12 cm squares with grout, 1 m repeat. */
export function paintWallTile(c: RGB): Img {
  const img = new Img(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) img.set(x, y, x % 4 === 3 || y % 4 === 3 ? sh(c, 0.82) : x % 4 === 0 && y % 4 === 0 ? sh(c, 1.08) : c);
  return img;
}

// --- placement ------------------------------------------------------------------------------

export interface FaceInfo {
  x: number;
  y: number;
  d: number;
  base: number;
  wallTop: number;
  room: Room;
  buildingSeed: number;
  /** door / open door at the along-wall neighbour at s = 0 / s = 1 */
  doorEnd: [boolean, boolean];
  /** tall furniture (wardrobe, bookcase, fridge...) stands in front of this face */
  blocked: boolean;
}

/** How run-down a building is: 0 kept, 1 dirty, 2 wrecked; and whether something happened. */
export function buildingState(seed: number): { level: number; violent: boolean } {
  const h = hash2(seed & 0xffff, seed >>> 16, 61);
  return { level: [0, 1, 1, 2, 2][h % 5], violent: (h >>> 8) % 7 === 0 };
}

export class Dresser {
  private frames = new Map<string, TileFrame>();
  private lamp: ModelMesh | null = null;
  private porch: ModelMesh | null = null;

  constructor(private atlas: ModelAtlas) {}

  frame(key: string, paint: () => Img): TileFrame {
    let f = this.frames.get(key);
    if (!f) this.frames.set(key, (f = this.atlas.frame('dr:' + key, paint)));
    return f;
  }

  /** Quad on face (x, y, d): s along the face 0..1, h metres above base, `off` out from the wall. */
  private faceQuad(geo: Geo, f: TileFrame, x: number, y: number, d: number, base: number, s0: number, s1: number, h0: number, h1: number, off: number, uv: readonly number[] = [0.001, 0.001, 0.999, 0.999]): void {
    const P = (s: number, h: number): V3 => [x + AX[d] + TX[d] * s + NX[d] * off, base + h, y + AY[d] + TY[d] * s + NY[d] * off];
    geo(f).quad(P(s0, h0), P(s1, h0), P(s1, h1), P(s0, h1), [NX[d], 0, NY[d]], uv, f);
  }

  /** Dress a room-facing wall face. */
  wallFace(geo: Geo, fi: FaceInfo): void {
    const { x, y, d, base, room } = fi;
    const H = (k: number) => hash2(x * 7 + d, y * 13 + k, room.seed) % 1000 / 1000;
    const st = buildingState(fi.buildingSeed);
    const wt = fi.wallTop;
    // bathroom / kitchen tiling (1.2 m splash) — continuous around the room
    if (room.kind === 'bathroom' || (room.kind === 'kitchen' && (room.seed & 3) === 0)) {
      const tc: RGB = [[214, 220, 222], [190, 206, 200], [222, 214, 196], [176, 192, 210]][(room.seed >> 4) & 3] as RGB;
      const tf = this.frame(`wtile:${tc.join(',')}`, () => paintWallTile(tc));
      const u0 = d === 0 ? -x - 1 : d === 1 ? -y - 1 : d === 2 ? x : y;
      this.faceQuad(geo, tf, x, y, d, base, 0, 1, 0.1, 1.25, 0.004, [u0, 0.1, u0 + 1, 1.25]);
    }
    // grime at the foot and head of walls in run-down houses
    if (st.level > 0) {
      const g = this.frame(`grime:${st.level}:${Math.floor(H(1) * 4)}:b`, () => paintGrime(st.level, Math.floor(H(1) * 4), false));
      this.faceQuad(geo, g, x, y, d, base, 0, 1, 0.0, 0.5, 0.018);
      const gt = this.frame(`grime:${st.level}:${Math.floor(H(2) * 4)}:t`, () => paintGrime(st.level - 1, Math.floor(H(2) * 4) + 4, true));
      this.faceQuad(geo, gt, x, y, d, base, 0, 1, wt - 0.45, wt - 0.02, 0.025);
    }
    // light switch next to a door, an outlet now and then
    const door0 = fi.doorEnd[0], door1 = fi.doorEnd[1];
    if (door0 || door1) {
      const s = door0 ? 0.12 : 0.88;
      const plate = this.frame('switch', () => { const i = new Img(3, 4); i.fill([226, 222, 212]); i.set(1, 1, [150, 146, 136]); i.set(1, 2, [150, 146, 136]); return i; });
      this.faceQuad(geo, plate, x, y, d, base, s - 0.04, s + 0.04, 1.1, 1.22, 0.008);
      if (st.violent && H(3) < 0.6) {
        const hp = this.frame(`hand:${Math.floor(H(4) * 2)}`, () => paintHandprint(Math.floor(H(4) * 2)));
        const hs = door0 ? 0.25 + H(5) * 0.2 : 0.55 + H(5) * 0.2;
        this.faceQuad(geo, hp, x, y, d, base, hs, hs + 0.2, 0.95 + H(6) * 0.4, 1.2 + H(6) * 0.4, 0.009);
        if (H(7) < 0.5) {
          const bl = this.frame(`blood:${Math.floor(H(8) * 3)}`, () => paintBlotch(20, 24, Math.floor(H(8) * 3) + 11, 'blood'));
          this.faceQuad(geo, bl, x, y, d, base, 0.3, 0.9, 0.4, 1.15, 0.01);
        }
      }
    } else if (H(9) < 0.12) {
      const o = this.frame('outlet', () => { const i = new Img(3, 4); i.fill([226, 222, 212]); i.set(1, 1, [60, 56, 50]); i.set(1, 2, [60, 56, 50]); return i; });
      const s = 0.2 + H(10) * 0.6;
      this.faceQuad(geo, o, x, y, d, base, s - 0.04, s + 0.04, 0.26, 0.38, 0.016);
    }
    // wall art (not behind wardrobes and fridges)
    const r = H(11);
    if (!fi.blocked) {
      if (r < 0.1) {
        const tall = H(12) < 0.4, w = tall ? 0.4 : 0.55, h = tall ? 0.55 : 0.4;
        const seed = Math.floor(H(13) * 64);
        const p = this.frame(`pic:${tall ? 1 : 0}:${seed}`, () => paintPicture(Math.round(w * 32), Math.round(h * 32), seed));
        const s = 0.5 + (H(14) - 0.5) * 0.3, tilt = st.level === 2 && H(15) < 0.4 ? 0.06 : 0;
        this.faceQuad(geo, p, x, y, d, base, s - w / 2, s + w / 2, 1.35 + tilt, 1.35 + h - tilt, 0.012);
      } else if (r < 0.15 || (room.kind === 'bedroom' && r < 0.2) || (room.kind === 'shop' && r < 0.3)) {
        const seed = Math.floor(H(16) * 64);
        const p = this.frame(`poster:${seed}`, () => paintPoster(15, 20, seed));
        const s = 0.5 + (H(17) - 0.5) * 0.3;
        this.faceQuad(geo, p, x, y, d, base, s - 0.23, s + 0.23, 1.2, 1.82, 0.01);
      } else if (r < 0.19 && room.kind === 'kitchen') {
        const seed = Math.floor(H(18) * 8);
        const p = this.frame(`cal:${seed}`, () => paintCalendar(10, 14, seed));
        this.faceQuad(geo, p, x, y, d, base, 0.4, 0.71, 1.3, 1.74, 0.01);
      } else if (r < 0.21 && (room.kind === 'kitchen' || room.kind === 'living')) {
        const p = this.frame('clock', () => paintClock(10));
        this.faceQuad(geo, p, x, y, d, base, 0.35, 0.66, 1.95, 2.26, 0.012);
      }
    }
    // water stains and peeling paint in run-down houses (over everything but trim)
    if (st.level > 0 && H(19) < 0.1 * st.level) {
      const seed = Math.floor(H(20) * 8);
      const p = this.frame(`stain:${seed}`, () => paintBlotch(22, 30, seed, 'stain'));
      const s = 0.2 + H(21) * 0.6;
      this.faceQuad(geo, p, x, y, d, base, s - 0.35, s + 0.35, wt - 1.0, wt - 0.05, 0.014);
    }
    if (st.level === 2 && H(22) < 0.12) {
      const seed = Math.floor(H(23) * 8);
      const p = this.frame(`peel:${seed}`, () => paintBlotch(16, 12, seed + 30, 'peel'));
      const s = 0.2 + H(24) * 0.6, h = 0.6 + H(25) * 1.4;
      this.faceQuad(geo, p, x, y, d, base, s - 0.25, s + 0.25, h, h + 0.37, 0.013);
    }
  }

  /** Graffiti on an exterior wall face now and then. */
  exteriorFace(geo: Geo, x: number, y: number, d: number, base: number, seed: number): void {
    const h = hash2(x * 3 + d, y, seed ^ 0x5151) % 1000 / 1000;
    if (h > 0.035) return;
    const s = Math.floor(h * 1000) % 6;
    const p = this.frame(`graf:${s}`, () => paintGraffiti(36, 18, s));
    this.faceQuad(geo, p, x, y, d, base, 0.0, 1.0, 0.7, 1.25, 0.012);
  }

  /** A rug under a group of beds / tables: world rect on the floor. */
  rug(geo: Geo, x0: number, z0: number, x1: number, z1: number, y: number, seed: number): void {
    const w = Math.max(4, Math.round((x1 - x0) * 32)), h = Math.max(4, Math.round((z1 - z0) * 32));
    // sizes vary; quantise so rugs of one room kind share frames
    const qw = Math.min(96, w), qh = Math.min(96, h);
    const f = this.frame(`rug:${qw}x${qh}:${seed % 5}`, () => paintRug(qw, qh, seed % 5));
    geo(f).quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], [0.001, 0.001, 0.999, 0.999], f);
  }

  /** Flush ceiling lamp (unlit: the power is out) at (x, z) under a ceiling at `y`. */
  ceilingLamp(geo: Geo, x: number, z: number, y: number): void {
    if (!this.lamp) {
      const b = new ModelBuilder(this.atlas);
      b.prism(0, 0, -0.03, 0, 0.1, 8, F('metal', [160, 156, 148]), null, null);
      b.prism(0, 0, -0.11, -0.03, 0.17, 8, F('glow', [226, 222, 206]), null, F('glow', [236, 232, 216]));
      this.lamp = b.done();
    }
    placeModel(geo, this.lamp, { x, y, z, yaw: 0 });
  }

  /**
   * Porch light and house number on the outside face of an exterior door's head: `d` = the
   * direction the outside lies in from door tile (x, y).
   */
  frontDoor(geo: Geo, x: number, y: number, d: number, base: number, seed: number, lampSide: boolean): void {
    const n = 1 + (seed % 97) * 2 + ((seed >> 8) & 1);
    const digits = String(n);
    const pw = digits.length * 4 + 2;
    const plaque = this.frame(`num:${digits}`, () => paintNumber(digits, pw));
    // face of the door tile toward d is the lintel's outer face (door head, 2.1-2.88 m)
    this.faceQuad(geo, plaque, x, y, d, base, 0.5 - pw / 64, 0.5 + pw / 64, 2.25, 2.25 + 8 / 32, 0.02);
    // porch lamp at one side of the door, facing out
    if (!lampSide) return;
    if (!this.porch) {
      const b = new ModelBuilder(this.atlas);
      b.box(-0.03, -0.02, 0, 0.03, 0.2, 0.03, F('metal', [44, 44, 46]));
      b.box(-0.06, 0.0, 0.03, 0.06, 0.2, 0.13, (fc) => (fc === 'py' || fc === 'ny' ? F('metal', [44, 44, 46]) : F('glow', [250, 234, 176])));
      b.box(-0.07, 0.2, 0.02, 0.07, 0.23, 0.14, F('metal', [44, 44, 46]));
      this.porch = b.done();
    }
    // on the wall beside the opening (s < 0 is the along-wall neighbour at the s = 0 end)
    const s = -0.16;
    const YAW = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];
    placeModel(geo, this.porch, { x: x + AX[d] + TX[d] * s, y: base + 1.95, z: y + AY[d] + TY[d] * s, yaw: YAW[d] });
  }
}

const DIGITS: Record<string, string[]> = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'], 2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'], 8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

function paintNumber(digits: string, w: number): Img {
  const img = new Img(w, 8);
  img.fill([40, 40, 44]);
  for (let i = 0; i < digits.length; i++) {
    const g = DIGITS[digits[i]];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (g[y][x] === '1') img.set(2 + i * 4 + x, 1 + y + 1, [220, 200, 130]);
  }
  return img;
}

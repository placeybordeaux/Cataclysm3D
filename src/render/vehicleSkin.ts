import type { DoorInfo, Layout } from './vehicleLayout';

// Per-vehicle pixel-art body texture ("skin"), painted procedurally at 32 texels per metre
// (the project's texel density; UltiCa tiles are 32 px per 1 m tile) and drawn with nearest
// filtering. The body geometry (vehicleModel.ts) projects every face onto one of five sheets
// by its normal: the two sides (x, y), the top (x, z), the front and the rear (z, y). The
// painter knows the layout (doors, wheels, windows, lamps) so panel seams, handles, trim,
// rust and grime land where the geometry has them, Shadowglass style: stepped shading,
// hard-edged detail, a limited palette derived from the body colour.
//
// Pure: paints into a Uint8Array (RGBA, row 0 = bottom = v 0), so it runs in node tests and
// in a worker (vehicleSkinWorker.ts: the game paints skins off the main thread). Inputs are
// plain structured-cloneable data (SkinLayoutInfo, SkinInput); VehicleRenderer wraps the
// result in a THREE.DataTexture.

/** The parts of a Layout the painter reads (no functions, no vehicle parts: clone-safe). */
export type SkinLayoutInfo = Pick<Layout, 'style' | 'livery' | 'p' | 'xNose' | 'xTail' | 'yc' | 'hw' | 'xCowl' | 'cabin' | 'wear' | 'sections'> & {
  doors: Omit<DoorInfo, 'part'>[];
};

export function skinLayoutInfo(L: Layout): SkinLayoutInfo {
  const { style, livery, p, xNose, xTail, yc, hw, xCowl, cabin, wear, sections } = L;
  return { style, livery, p, xNose, xTail, yc, hw, xCowl, cabin, wear, sections, doors: L.doors.map(({ side, x0, x1, window }) => ({ side, x0, x1, window })) };
}

export const SKIN_PPM = 32;

export interface Sheet {
  /** Texel origin of the sheet in the page (bottom-left). */
  u0: number;
  v0: number;
  w: number;
  h: number;
  /** World coordinate at the sheet's texel (0, 0) along its two axes. */
  a0: number;
  b0: number;
}

export type SheetName = 'right' | 'left' | 'top' | 'front' | 'rear' | 'under';

export interface SkinLayout {
  width: number;
  height: number;
  sheets: Record<SheetName, Sheet>;
}

/** Sheet placement for a layout: sides (x, y), top (x, z), front/rear (z, y), a grime swatch. */
export function skinLayout(L: SkinLayoutInfo, yMax: number): SkinLayout {
  const ppm = SKIN_PPM;
  const x0 = L.xTail - 0.25, x1 = L.xNose + 0.25;
  const z0 = L.yc - L.hw - 0.3, z1 = L.yc + L.hw + 0.3;
  const lw = Math.ceil((x1 - x0) * ppm), hh = Math.ceil((yMax + 0.3) * ppm), ww = Math.ceil((z1 - z0) * ppm);
  const width = Math.max(lw, 2 * ww + 8);
  const sheets: Record<SheetName, Sheet> = {
    right: { u0: 0, v0: 0, w: lw, h: hh, a0: x0, b0: 0 },
    left: { u0: 0, v0: hh, w: lw, h: hh, a0: x0, b0: 0 },
    top: { u0: 0, v0: 2 * hh, w: lw, h: ww, a0: x0, b0: z0 },
    front: { u0: 0, v0: 2 * hh + ww, w: ww, h: hh, a0: z0, b0: 0 },
    rear: { u0: ww, v0: 2 * hh + ww, w: ww, h: hh, a0: z0, b0: 0 },
    under: { u0: 2 * ww, v0: 2 * hh + ww, w: 8, h: 8, a0: 0, b0: 0 },
  };
  return { width, height: 3 * hh + ww, sheets };
}

/** Texel coordinates (fractional) of world (a, b) on a sheet, normalised to the page. */
export function sheetUv(s: SkinLayout, name: SheetName, a: number, b: number): [number, number] {
  const sh = s.sheets[name];
  if (name === 'under') return [(sh.u0 + 4) / s.width, (sh.v0 + 4) / s.height];
  const u = Math.min(sh.w - 0.01, Math.max(0.01, (a - sh.a0) * SKIN_PPM));
  const v = Math.min(sh.h - 0.01, Math.max(0.01, (b - sh.b0) * SKIN_PPM));
  return [(sh.u0 + u) / s.width, (sh.v0 + v) / s.height];
}

// --- colour helpers ------------------------------------------------------------------

type RGB = [number, number, number];
const rgb = (c: number): RGB => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const lerpC = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function hash2(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Noise comes from small tiling tables built once: painting a skin samples noise for every
// texel (~100k), and hashing per sample made a car's skin cost ~15 ms.
const NT = 128; // table size in texels: 32 cells of 4, a power of two so `& NM` wraps
const NM = NT - 1;
let valueTable: Float32Array | null = null, whiteTable: Float32Array | null = null;
function tables(): [Float32Array, Float32Array] {
  if (valueTable && whiteTable) return [valueTable, whiteTable];
  const vt = new Float32Array(NT * NT), wt = new Float32Array(NT * NT);
  const cells = NT / 4;
  const h = (i: number, j: number) => hash2(i % cells, j % cells, 11);
  for (let y = 0; y < NT; y++)
    for (let x = 0; x < NT; x++) {
      const cx = x >> 2, cy = y >> 2;
      const fx = (x & 3) / 4, fy = (y & 3) / 4;
      const a = h(cx, cy), b = h(cx + 1, cy), c = h(cx, cy + 1), d = h(cx + 1, cy + 1);
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      vt[y * NT + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
      wt[y * NT + x] = hash2(x, y, 7);
    }
  valueTable = vt;
  whiteTable = wt;
  return [vt, wt];
}

/** Everything the painter needs to know beyond the layout. */
export interface SkinInput {
  paint: number;
  /** Seed for noise (vehicle uid). */
  seed: number;
  /** Silhouette top height at x (for pillar / roof bands), glass panes per side, wheel arches. */
  panes: Record<-1 | 1, { x0: number; x1: number; pts: [number, number][]; kind: 'glass' | 'open' }[]>;
  arches: { x: number; y: number; r: number }[];
  /** Blood per mount row (0..), damaged rows (0 intact .. 1 destroyed). */
  rowBlood: Map<number, number>;
  rowDamage: Map<number, number>;
  /** Lamps on the front / rear faces: centre z, y, half w, half h. */
  headlamps: { z: number; y: number; w: number; h: number }[];
  taillamps: { z: number; y: number; w: number; h: number }[];
  /** Top edge of the side walls (below it: pillars / window frames, above: roof side),
   * sampled every `step` m from x0. */
  wallTop: { x0: number; step: number; values: Float32Array };
  yMax: number;
}

export interface Skin {
  layout: SkinLayout;
  data: Uint8Array;
}

/** The body colour a livery paints (for parts tinted to match, e.g. mirrors). */
export function liveryBody(L: SkinLayoutInfo, paint: number): number {
  const [r, g, b] = liveryColors(L, paint).body;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** Livery base: body colour(s) by livery (plain uses the spawn paint). */
function liveryColors(L: SkinLayoutInfo, paint: number): { body: RGB; lower?: RGB; stripe?: RGB; roof?: RGB } {
  switch (L.livery) {
    case 'police': return { body: rgb(0x1c1d22), lower: rgb(0x1c1d22), stripe: rgb(0xe8e8e2), roof: rgb(0xe8e8e2) };
    case 'fbi': return { body: rgb(0x16171b) };
    case 'swat': return { body: rgb(0x23262c), stripe: rgb(0x3a3f48) };
    case 'ambulance': return { body: rgb(0xe8e6de), stripe: rgb(0xb02020) };
    case 'school': return { body: rgb(0xe0a21a), stripe: rgb(0x1c1c1c), roof: rgb(0xe8e6dc) };
    case 'prison': return { body: rgb(0xd9d7cf), stripe: rgb(0x2a2a30) };
    case 'fire': return { body: rgb(0xa8201c), stripe: rgb(0xe8e6de) };
    case 'military': return { body: rgb(0x4b5234) };
    case 'security': return { body: rgb(0x4a4d52), stripe: rgb(0xb8962e) };
    case 'icecream': return { body: rgb(0xf0ece0), stripe: rgb(0xe07aa0) };
    case 'hippie': return { body: rgb(0x3f8fa8), lower: rgb(0xe8e2cc) };
    case 'hazmat': return { body: rgb(0xe8e6de), stripe: rgb(0xd8a818) };
    case 'transit': return { body: rgb(0xdcdad2), lower: rgb(0x2c4a86), stripe: rgb(0x2c4a86) };
    default: return { body: rgb(paint) };
  }
}

/** Side-wall top at x from the sampled table (nearest sample, clamped). */
export function wallTopAt(w: SkinInput['wallTop'], x: number): number {
  const i = Math.round((x - w.x0) / w.step);
  return w.values[Math.max(0, Math.min(w.values.length - 1, i))];
}

export function paintSkin(L: SkinLayoutInfo, inp: SkinInput): Skin {
  const lay = skinLayout(L, inp.yMax);
  const W = lay.width, H = lay.height;
  // Clamped: brightening (x1.25 creases) saturates instead of wrapping.
  const data = new Uint8ClampedArray(W * H * 4);
  const [VT, WT] = tables();
  const p = L.p;
  const ppm = SKIN_PPM;
  const col = liveryColors(L, inp.paint);
  // Burnt-out wrecks: the paint is mostly gone, scorched toward rust and soot.
  if (L.wear > 0.6) {
    const t = Math.min(0.75, (L.wear - 0.6) * 2.5);
    const burn = (c: RGB | undefined): RGB | undefined => (c ? lerpC(c, [70, 48, 36], t) : c);
    col.body = burn(col.body)!;
    col.lower = burn(col.lower);
    col.stripe = burn(col.stripe);
    col.roof = burn(col.roof);
  }
  const wear = L.wear;
  const seed = inp.seed;
  const trim: RGB = [26, 27, 30];
  const chrome: RGB = [168, 172, 178];
  const rust: RGB = [118, 62, 34];
  const rustDark: RGB = [74, 40, 26];
  const dirt: RGB = [92, 82, 66];

  const put = (u: number, v: number, c: RGB) => {
    if (u < 0 || v < 0 || u >= W || v >= H) return;
    const o = (v * W + u) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = 255;
  };
  const get = (u: number, v: number): RGB => {
    const o = (v * W + u) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };

  /** Rust, dirt and blood on top of a painted texel; (x, y) world coords for noise. */
  // Weathering is driven by `wear` (share of broken / damaged parts) and per-row damage: an
  // intact car gets a faint band of road grime, an abandoned one rust along the sills and
  // arches, a wreck blotches everywhere. vnoise is 0..1, so thresholds near 1 are rare spots.
  // Hot loops paint into this scratch colour (no per-texel arrays: allocation dominated).
  const C: RGB = [0, 0, 0];
  const setC = (c: RGB) => {
    C[0] = c[0];
    C[1] = c[1];
    C[2] = c[2];
  };
  const mulC = (k: number) => {
    C[0] *= k;
    C[1] *= k;
    C[2] *= k;
  };
  const mixC = (c: RGB, t: number) => {
    C[0] += (c[0] - C[0]) * t;
    C[1] += (c[1] - C[1]) * t;
    C[2] += (c[2] - C[2]) * t;
  };
  const blood: RGB = [96, 12, 10];
  const band = 0.12 + wear * 0.3;
  // Per-paint noise offsets (the tables tile; the seed shifts where each vehicle samples).
  const oV = (seed * 29) & NM, oVy = (seed * 13) & NM, oW = (seed * 17 + 7) & NM, oWy = (seed * 7 + 3) & NM;
  let colDmg = 0, colBlood = 0, colRust = 0;
  /** Set the per-column damage / blood (mount row) before emitting a column. */
  const column = (row: number) => {
    colDmg = inp.rowDamage.get(row) ?? 0;
    colBlood = inp.rowBlood.get(row) ?? 0;
    colRust = Math.max(0, Math.min(1, wear * 1.1 + colDmg * 0.6 - 0.2));
  };
  /** Weather the scratch colour C (grime, rust, dents, blood), then write it at (u, v).
   * tx / ty: texel coordinates in world space (so both sides / sheets differ). */
  const emit = (u: number, v: number, tx: number, ty: number, low: number) => {
    const ix = Math.floor(tx), iy = Math.floor(ty);
    const n2 = WT[((iy + oWy) & NM) * NT + ((ix + oW) & NM)];
    const g = (band - low) / band;
    if (g > 0 && n2 < g * 0.7) mixC(dirt, 0.18 + 0.2 * g);
    if (colRust > 0) {
      const n = VT[((iy + oVy) & NM) * NT + ((ix + oV) & NM)];
      const bias = low < 0.25 ? 1.4 : low < 0.6 ? 0.8 : 0.5;
      const t = 1 - 0.42 * colRust * bias;
      if (n > t + 0.06) mixC(n2 < 0.5 ? rust : rustDark, 0.7);
      else if (n > t && n2 < 0.55) mixC(rust, 0.4);
    }
    // Dents: darker blotches on hard-hit rows.
    if (colDmg > 0.5 && VT[((iy + 37) & NM) * NT + ((ix + oV + 50) & NM)] > 1.15 - colDmg * 0.4) mulC(0.75);
    if (colBlood > 0 && VT[((iy * 2 + 99) & NM) * NT + ((ix * 2 + oW) & NM)] > 1 - Math.min(0.55, colBlood / 900)) mixC(blood, 0.8);
    const o = (v * W + u) * 4;
    data[o] = C[0];
    data[o + 1] = C[1];
    data[o + 2] = C[2];
    data[o + 3] = 255;
  };

  const shoulder = p.belt - 0.12;
  // --- sides ---
  for (const side of [1, -1] as const) {
    const sh = lay.sheets[side > 0 ? 'right' : 'left'];
    const panes = inp.panes[side];
    for (let tu = 0; tu < sh.w; tu++) {
      const x = sh.a0 + (tu + 0.5) / ppm;
      const wallTop = wallTopAt(inp.wallTop, x);
      const policeDoor = L.livery === 'police' && L.doors.some((d) => d.side === side && x <= d.x0 && x >= d.x1);
      column(Math.round(x));
      const tx = x * side * ppm;
      for (let tv = 0; tv < sh.h; tv++) {
        const y = sh.b0 + (tv + 0.5) / ppm;
        setC(col.lower && y < p.belt - 0.28 ? col.lower : col.body);
        // stepped shading: highlight band under the shoulder, darker rocker
        if (y > shoulder - 0.1 && y < shoulder) mulC(1.1);
        else if (y < p.sill + 0.16) mulC(0.78);
        else if (y < p.sill + 0.3) mulC(0.9);
        if (y > p.belt + 0.02 && y < wallTop - 0.01) {
          if (p.blackPillars) setC(trim);
          else mulC(0.95);
        }
        // crease lines
        if (Math.abs(y - shoulder) < 0.5 / ppm) {
          setC(col.body);
          mulC(1.25);
        }
        if (Math.abs(y - (p.sill + 0.3)) < 0.5 / ppm) mulC(0.7);
        // livery stripes
        if (col.stripe && L.livery !== 'police' && Math.abs(y - (p.belt - 0.3)) < 0.06) setC(col.stripe);
        if (L.livery === 'school' && (Math.abs(y - (p.belt - 0.08)) < 0.03 || Math.abs(y - (p.sill + 0.45)) < 0.03)) setC(col.stripe!);
        if (policeDoor && y > p.sill + 0.25 && y < p.belt) setC(col.stripe!);
        emit(sh.u0 + tu, sh.v0 + tv, tx, tv, y - p.sill);
      }
    }
    // window trims: a dark frame 2 texels around each pane (the pane itself is a hole)
    for (const pane of panes) {
      for (const [px, py] of outlineTexels(pane.pts, ppm)) {
        for (let d = -2; d <= 2; d++)
          for (let e = -2; e <= 2; e++) {
            const tu = Math.floor((px - sh.a0) * ppm) + d, tv = Math.floor(py * ppm) + e;
            put(sh.u0 + tu, sh.v0 + tv, p.blackPillars ? trim : chrome);
          }
      }
    }
    // door seams (1 texel dark lines) and handles
    for (const d of L.doors.filter((q) => q.side === side)) {
      for (const xe of [d.x0, d.x1]) {
        const tu = Math.round((xe - sh.a0) * ppm);
        for (let tv = Math.floor((p.sill + 0.06) * ppm); tv < Math.floor((p.belt + 0.02) * ppm); tv++) {
          put(sh.u0 + tu, sh.v0 + tv, scale(get(sh.u0 + tu, sh.v0 + tv), 0.45));
          put(sh.u0 + tu + 1, sh.v0 + tv, scale(get(sh.u0 + tu + 1, sh.v0 + tv), 1.15));
        }
      }
      // handle near the rear edge, just under the shoulder
      const hu = Math.round((d.x1 + 0.2 - sh.a0) * ppm), hv = Math.round((shoulder - 0.06) * ppm);
      for (let i = 0; i < 4; i++) {
        put(sh.u0 + hu + i, sh.v0 + hv, [30, 30, 32]);
        put(sh.u0 + hu + i, sh.v0 + hv + 1, chrome);
      }
    }
    // wheel arch lips: a dark rim around each arch
    for (const a of inp.arches) {
      for (let tv = 0; tv < Math.ceil((a.y + a.r + 0.1) * ppm); tv++)
        for (let tu = Math.floor((a.x - a.r - 0.12 - sh.a0) * ppm); tu < Math.ceil((a.x + a.r + 0.12 - sh.a0) * ppm); tu++) {
          const x = sh.a0 + (tu + 0.5) / ppm, y = (tv + 0.5) / ppm;
          const dd = Math.hypot(x - a.x, y - a.y);
          if (dd > a.r - 0.02 && dd < a.r + 0.07 && y > p.sill - 0.05) put(sh.u0 + tu, sh.v0 + tv, scale(get(sh.u0 + tu, sh.v0 + tv), dd < a.r + 0.03 ? 0.35 : 0.7));
        }
    }
    // box bodies: vertical stiffening ribs every half metre on the cargo box sides
    for (const bx of L.sections.filter((q) => q.kind === 'box')) {
      for (let x = bx.x1 + 0.5; x < bx.x0 - 0.2; x += 0.5) {
        const tu = Math.round((x - sh.a0) * ppm);
        for (let tv = Math.floor((p.belt - 0.1) * ppm); tv < Math.floor((p.box - 0.1) * ppm); tv++) {
          put(sh.u0 + tu, sh.v0 + tv, scale(get(sh.u0 + tu, sh.v0 + tv), 0.82));
          put(sh.u0 + tu + 1, sh.v0 + tv, scale(get(sh.u0 + tu + 1, sh.v0 + tv), 1.08));
        }
      }
    }
    // side markers: amber near the nose, red near the tail
    const mv = Math.round((p.belt - 0.28) * ppm);
    for (let i = 0; i < 3; i++) {
      put(sh.u0 + Math.round((L.xNose - 0.35 - sh.a0) * ppm) + i, sh.v0 + mv, [226, 140, 30]);
      put(sh.u0 + Math.round((L.xTail + 0.25 - sh.a0) * ppm) + i, sh.v0 + mv, [180, 30, 26]);
    }
    // fuel filler on the right rear quarter
    if (side > 0 && L.style !== 'bus') {
      const fu = Math.round((L.xTail + 0.9 - sh.a0) * ppm), fv = Math.round((p.belt - 0.22) * ppm);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) put(sh.u0 + fu + i, sh.v0 + fv + j, scale(get(sh.u0 + fu + i, sh.v0 + fv + j), i === 0 || j === 3 ? 0.6 : 0.95));
    }
    // livery emblems
    if (L.livery === 'ambulance' || L.livery === 'police' || L.livery === 'fire' || L.livery === 'security' || L.livery === 'hippie' || L.livery === 'military') emblem(L, sh, side, col, put, get);
  }

  // --- top: hood / roof / trunk lid panel lines ---
  {
    const sh = lay.sheets.top;
    const cab = L.cabin;
    const rg = L.sections.find((q) => q.kind === 'rearglass');
    const bed = L.sections.find((q) => q.kind === 'bed');
    const boxes = L.sections.filter((q) => q.kind === 'box');
    const bedFloor: RGB = [60, 60, 62];
    for (let tu = 0; tu < sh.w; tu++) {
      const x = sh.a0 + (tu + 0.5) / ppm;
      const onRoof = !!cab && x < cab.x0 - p.rake + 0.05 && x > cab.x1 - 0.1;
      const roofPaint = !!col.roof && (onRoof || boxes.some((q) => x <= q.x0 && x >= q.x1));
      const cowlSeam = L.xCowl !== null && Math.abs(x - (L.xCowl + 0.08)) < 0.5 / ppm;
      const onHood = L.xCowl !== null && x > L.xCowl + 0.1;
      const rib = (L.style === 'bus' || L.style === 'van' || L.style === 'truck') && onRoof && Math.floor(x * ppm) % 24 === 0;
      const trunkSeam = !!rg && Math.abs(x - (rg.x0 - p.rearRake - 0.04)) < 0.5 / ppm;
      const inBed = !!bed && x < bed.x0 && x > bed.x1 + 0.02;
      column(Math.round(x));
      for (let tv = 0; tv < sh.h; tv++) {
        const z = sh.b0 + (tv + 0.5) / ppm;
        const zl = Math.abs(z - L.yc) / L.hw;
        setC(roofPaint ? col.roof! : col.body);
        mulC(roofPaint ? 0.9 : 0.88);
        // a sheen band along the centre line and darker edges (stepped, no gradients)
        if (zl < 0.18) mulC(1.06);
        else if (zl > 0.82) mulC(0.86);
        // hood seam at the cowl and hood centre crease
        if (cowlSeam) mulC(0.5);
        if (onHood && Math.abs(z - L.yc) < 0.5 / ppm) mulC(0.85);
        // roof rails on SUVs and minivans, ribs on bus / van / truck roofs
        if (onRoof && (L.style === 'suv' || L.style === 'minivan') && Math.abs(zl - 0.72) < 0.03) setC(trim);
        if (rib) mulC(0.8);
        if (trunkSeam) mulC(0.5);
        if (inBed) {
          if (zl > 0.86) {
            setC(col.body);
            mulC(0.8);
          } else setC(bedFloor);
        }
        emit(sh.u0 + tu, sh.v0 + tv, tu + 300, tv, 0.5);
      }
    }
  }

  // --- front and rear faces ---
  const bumperBlack: RGB = [40, 41, 44], seamDark: RGB = [20, 20, 22], slatGrey: RGB = [70, 72, 76], gap: RGB = [18, 18, 20], busVent: RGB = [30, 30, 32];
  const plateRim: RGB = [30, 30, 34], plateInk: RGB = [40, 50, 90], plate: RGB = [214, 212, 200], bezel: RGB = [24, 24, 26];
  const headCore: RGB = [236, 234, 220], headLens: RGB = [176, 178, 172], tailCore: RGB = [210, 60, 44], tailLens: RGB = [140, 24, 20];
  const hasBox = L.sections.some((q) => q.kind === 'box');
  for (const end of ['front', 'rear'] as const) {
    const sh = lay.sheets[end];
    const lamps = end === 'front' ? inp.headlamps : inp.taillamps;
    const gTop = L.style === 'truck' ? p.nose - 0.08 : Math.min(p.nose - 0.1, p.lampY + p.lampH + 0.04), gBot = p.sill + 0.26;
    const lampZ = lamps.length ? Math.min(...lamps.map((l) => Math.abs(l.z - L.yc) - l.w)) : L.hw * 0.5;
    const plateY = p.sill + (end === 'front' ? 0.14 : 0.36);
    const wx0 = end === 'front' ? 900 : 600;
    column(Math.round(end === 'front' ? L.xNose : L.xTail));
    for (let tu = 0; tu < sh.w; tu++) {
      const z = sh.a0 + (tu + 0.5) / ppm;
      const zl = (z - L.yc) / L.hw, dzc = Math.abs(z - L.yc);
      for (let tv = 0; tv < sh.h; tv++) {
        const y = (tv + 0.5) / ppm;
        setC(col.lower && y < p.belt - 0.28 ? col.lower : col.body);
        mulC(0.95);
        if (y > p.belt + 0.02 && L.style !== 'bus' && p.blackPillars) setC(trim);
        if (y < p.sill + 0.24) {
          if (p.bumper === 'chrome') setC(chrome);
          else if (p.bumper === 'black') setC(bumperBlack);
          else mulC(0.8);
        }
        if (Math.abs(y - (p.sill + 0.24)) < 0.5 / ppm) setC(seamDark);
        if (end === 'front') {
          // grille between the headlamps, horizontal slats
          if (L.style !== 'bus' && y > gBot && y < gTop && dzc < lampZ - 0.05) {
            const slat = Math.floor((y - gBot) * ppm) % 3 === 0;
            setC(slat ? (p.bumper === 'chrome' ? chrome : slatGrey) : gap);
            if (dzc < 0.05 && Math.abs(y - (gBot + gTop) / 2) < 0.04) setC(chrome);
          }
          if (L.style === 'bus' && y > p.sill + 0.3 && y < p.sill + 0.5 && Math.abs(zl) < 0.5 && Math.floor(y * ppm) % 2 === 0) setC(busVent);
        } else {
          // trunk / tailgate seam and handle; box vans get split rear doors with a latch bar
          if (hasBox && dzc < 0.5 / ppm && y > p.sill + 0.25 && y < p.box - 0.1) mulC(0.5);
          if (hasBox && Math.abs(dzc - 0.08) < 0.5 / ppm && y > p.sill + 0.5 && y < p.box - 0.4) setC(chrome);
          if (Math.abs(y - (p.sill + 0.4)) < 0.5 / ppm && Math.abs(zl) < 0.7) mulC(0.6);
          if (Math.abs(y - (p.belt - 0.1)) < 0.03 && dzc < 0.12) setC(chrome);
        }
        // licence plate
        if (dzc < 0.16 && Math.abs(y - plateY) < 0.07) setC(dzc > 0.14 || Math.abs(y - plateY) > 0.05 ? plateRim : Math.floor((z - L.yc) * ppm) % 2 === 0 && Math.abs(y - plateY) < 0.02 ? plateInk : plate);
        // lamps: lens with a bright core and a dark bezel (the emissive lamp mesh sits on top)
        for (const l of lamps) {
          const dz = Math.abs(z - l.z), dy = Math.abs(y - l.y);
          if (dz < l.w + 0.02 && dy < l.h + 0.02) setC(dz < l.w && dy < l.h ? (end === 'front' ? (dz < l.w * 0.5 ? headCore : headLens) : dy < l.h * 0.4 ? tailCore : tailLens) : bezel);
        }
        emit(sh.u0 + tu, sh.v0 + tv, tu + wx0, tv, y - p.sill);
      }
    }
  }

  // --- underside swatch: dark oily grime ---
  {
    const sh = lay.sheets.under;
    for (let tv = 0; tv < sh.h; tv++) for (let tu = 0; tu < sh.w; tu++) put(sh.u0 + tu, sh.v0 + tv, [28 + ((tu + tv) % 3) * 4, 27, 26]);
  }
  return { layout: lay, data: new Uint8Array(data.buffer) };
}

/** Points along a closed polyline, one per texel step. */
function outlineTexels(pts: [number, number][], ppm: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * ppm));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** Livery marks on the side sheets: crosses, stars, flowers, stencils. */
function emblem(L: SkinLayoutInfo, sh: Sheet, side: -1 | 1, col: { body: RGB; stripe?: RGB }, put: (u: number, v: number, c: RGB) => void, get: (u: number, v: number) => RGB): void {
  const p = L.p, ppm = SKIN_PPM;
  // centre of the biggest flat panel: the box on vans, else the rear door / quarter
  const box = L.sections.find((s) => s.kind === 'box');
  const cx = box ? (box.x0 + box.x1) / 2 : L.cabin ? (L.cabin.x1 + L.xTail) / 2 + 0.3 : (L.xNose + L.xTail) / 2;
  const cy = box ? (p.belt + p.box) / 2 : (p.sill + p.belt) / 2 + 0.05;
  const U = Math.round((cx - sh.a0) * ppm), V = Math.round(cy * ppm);
  const px = (i: number, j: number, c: RGB) => put(sh.u0 + U + i, sh.v0 + V + j, c);
  if (L.livery === 'ambulance' || L.livery === 'fire') {
    // Star of life / cross: a plus sign
    const c: RGB = L.livery === 'ambulance' ? [40, 80, 170] : [230, 228, 220];
    const s = box ? 9 : 5, t = box ? 3 : 2;
    for (let i = -s; i <= s; i++) for (let j = -t; j <= t; j++) { px(i, j, c); px(j, i, c); }
  } else if (L.livery === 'police' || L.livery === 'security') {
    // a gold star badge on the front doors
    const d = L.doors.find((q) => q.side === side);
    if (!d) return;
    const bu = Math.round(((d.x0 + d.x1) / 2 - sh.a0) * ppm), bv = Math.round((p.belt - 0.3) * ppm);
    const star = ['..#..', '.###.', '#####', '.###.', '##.##'];
    star.forEach((row, j) => [...row].forEach((ch, i) => ch === '#' && put(sh.u0 + bu + i - 2, sh.v0 + bv - j + 2, [208, 170, 60])));
  } else if (L.livery === 'hippie') {
    // flowers along the lower body
    for (let k = 0; k < 6; k++) {
      const fx = L.xTail + 0.6 + k * ((L.xNose - L.xTail - 1.2) / 5), fy = p.sill + 0.35 + (k % 2) * 0.22;
      const u = Math.round((fx - sh.a0) * ppm), v = Math.round(fy * ppm);
      const petal: RGB = k % 3 === 0 ? [230, 120, 40] : k % 3 === 1 ? [220, 70, 140] : [240, 210, 60];
      for (const [i, j] of [[0, 2], [2, 0], [0, -2], [-2, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) put(sh.u0 + u + i, sh.v0 + v + j, petal);
      put(sh.u0 + u, sh.v0 + v, [250, 240, 200]);
    }
  } else if (L.livery === 'military') {
    // a white stencil star in a circle on the doors / box
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
      const r = Math.hypot(i, j);
      if (r > 5 && r < 6.2) px(i, j, [200, 200, 186]);
    }
    const star = ['...#...', '..###..', '#######', '.#####.', '.##.##.', '#.....#'];
    star.forEach((row, j) => [...row].forEach((ch, i) => ch === '#' && px(i - 3, 3 - j, [200, 200, 186])));
    void get;
  }
}

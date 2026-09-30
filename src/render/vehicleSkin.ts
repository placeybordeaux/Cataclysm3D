import type { Layout } from './vehicleLayout';

// Per-vehicle pixel-art body texture ("skin"), painted procedurally at 32 texels per metre
// (the project's texel density; UltiCa tiles are 32 px per 1 m tile) and drawn with nearest
// filtering. The body geometry (vehicleModel.ts) projects every face onto one of five sheets
// by its normal: the two sides (x, y), the top (x, z), the front and the rear (z, y). The
// painter knows the layout (doors, wheels, windows, lamps) so panel seams, handles, trim,
// rust and grime land where the geometry has them, Shadowglass style: stepped shading,
// hard-edged detail, a limited palette derived from the body colour.
//
// Pure: paints into a Uint8Array (RGBA, row 0 = bottom = v 0), so it runs in node tests;
// vehicleModel.ts wraps it in a THREE.DataTexture.

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
export function skinLayout(L: Layout, yMax: number): SkinLayout {
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
/** Blocky value noise (cells of `cell` texels) for rust / grime patches. */
function vnoise(x: number, y: number, cell: number, seed: number): number {
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  const fx = x / cell - cx, fy = y / cell - cy;
  const a = hash2(cx, cy, seed), b = hash2(cx + 1, cy, seed), c = hash2(cx, cy + 1, seed), d = hash2(cx + 1, cy + 1, seed);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
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
  /** Top edge of the side walls at x (below it: pillars / window frames, above: roof side). */
  wallTop: (x: number) => number;
  yMax: number;
}

export interface Skin {
  layout: SkinLayout;
  data: Uint8Array;
}

/** The body colour a livery paints (for parts tinted to match, e.g. mirrors). */
export function liveryBody(L: Layout, paint: number): number {
  const [r, g, b] = liveryColors(L, paint).body;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** Livery base: body colour(s) by livery (plain uses the spawn paint). */
function liveryColors(L: Layout, paint: number): { body: RGB; lower?: RGB; stripe?: RGB; roof?: RGB } {
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
    default: return { body: rgb(paint) };
  }
}

export function paintSkin(L: Layout, inp: SkinInput): Skin {
  const lay = skinLayout(L, inp.yMax);
  const W = lay.width, H = lay.height;
  const data = new Uint8Array(W * H * 4);
  const p = L.p;
  const ppm = SKIN_PPM;
  const col = liveryColors(L, inp.paint);
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
    data[o] = Math.max(0, Math.min(255, c[0]));
    data[o + 1] = Math.max(0, Math.min(255, c[1]));
    data[o + 2] = Math.max(0, Math.min(255, c[2]));
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
  const weather = (c: RGB, wx: number, wy: number, low: number, row: number): RGB => {
    const n2 = hash2(Math.floor(wx * ppm), Math.floor(wy * ppm), seed + 7);
    const dmg = inp.rowDamage.get(row) ?? 0;
    const band = 0.12 + wear * 0.3;
    const g = Math.max(0, band - low) / band;
    if (g > 0 && n2 < g * 0.7) c = lerpC(c, dirt, 0.18 + 0.2 * g);
    const rustAmt = Math.max(0, Math.min(1, wear * 1.1 + dmg * 0.6 - 0.2));
    if (rustAmt > 0) {
      const n = vnoise(wx * ppm, wy * ppm, 3, seed);
      const bias = low < 0.25 ? 1.4 : low < 0.6 ? 0.8 : 0.5;
      const t = 1 - 0.42 * rustAmt * bias;
      if (n > t + 0.06) c = lerpC(c, n2 < 0.5 ? rust : rustDark, 0.7);
      else if (n > t && n2 < 0.55) c = lerpC(c, rust, 0.4);
    }
    // Dents: darker blotches on hard-hit rows.
    if (dmg > 0.5 && vnoise(wx * ppm + 50, wy * ppm, 3, seed + 3) > 1.15 - dmg * 0.4) c = scale(c, 0.75);
    const blood = inp.rowBlood.get(row) ?? 0;
    if (blood > 0 && vnoise(wx * ppm, wy * ppm + 99, 2, seed + 5) > 1 - Math.min(0.55, blood / 900)) c = lerpC(c, [96, 12, 10], 0.8);
    return c;
  };

  const shoulder = p.belt - 0.12;
  // --- sides ---
  for (const side of [1, -1] as const) {
    const sh = lay.sheets[side > 0 ? 'right' : 'left'];
    const panes = inp.panes[side];
    for (let tv = 0; tv < sh.h; tv++)
      for (let tu = 0; tu < sh.w; tu++) {
        const x = sh.a0 + (tu + 0.5) / ppm, y = sh.b0 + (tv + 0.5) / ppm;
        let c: RGB = col.body;
        if (col.lower && y < p.belt - 0.28) c = col.lower;
        // stepped shading: highlight band under the shoulder, darker rocker
        if (y > shoulder - 0.1 && y < shoulder) c = scale(c, 1.1);
        else if (y < p.sill + 0.16) c = scale(c, 0.78);
        else if (y < p.sill + 0.3) c = scale(c, 0.9);
        if (y > p.belt + 0.02 && y < inp.wallTop(x) - 0.01) c = p.blackPillars ? trim : scale(c, 0.95);
        // crease lines
        if (Math.abs(y - shoulder) < 0.5 / ppm) c = scale(col.body, 1.25);
        if (Math.abs(y - (p.sill + 0.3)) < 0.5 / ppm) c = scale(c, 0.7);
        // livery stripes
        if (col.stripe && L.livery !== 'police' && Math.abs(y - (p.belt - 0.3)) < 0.06) c = col.stripe;
        if (L.livery === 'school' && (Math.abs(y - (p.belt - 0.08)) < 0.03 || Math.abs(y - (p.sill + 0.45)) < 0.03)) c = col.stripe!;
        if (L.livery === 'police' && y > p.sill + 0.25 && y < p.belt && L.doors.some((d) => d.side === side && x <= d.x0 && x >= d.x1)) c = col.stripe!;
        put(sh.u0 + tu, sh.v0 + tv, c);
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
    // weathering pass
    for (let tv = 0; tv < sh.h; tv++)
      for (let tu = 0; tu < sh.w; tu++) {
        const x = sh.a0 + (tu + 0.5) / ppm, y = (tv + 0.5) / ppm;
        put(sh.u0 + tu, sh.v0 + tv, weather(get(sh.u0 + tu, sh.v0 + tv), x * side, y, y - p.sill, Math.round(x)));
      }
  }

  // --- top: hood / roof / trunk lid panel lines ---
  {
    const sh = lay.sheets.top;
    const cab = L.cabin;
    for (let tv = 0; tv < sh.h; tv++)
      for (let tu = 0; tu < sh.w; tu++) {
        const x = sh.a0 + (tu + 0.5) / ppm, z = sh.b0 + (tv + 0.5) / ppm;
        const zl = Math.abs(z - L.yc) / L.hw;
        let c: RGB = scale(col.body, 0.88);
        const onRoof = cab && x < cab.x0 - p.rake + 0.05 && x > cab.x1 - 0.1;
        if (col.roof && (onRoof || L.sections.some((s) => s.kind === 'box' && x <= s.x0 && x >= s.x1))) c = scale(col.roof, 0.9);
        // a sheen band along the centre line and darker edges (stepped, no gradients)
        if (zl < 0.18) c = scale(c, 1.06);
        else if (zl > 0.82) c = scale(c, 0.86);
        // hood seam at the cowl and hood centre crease
        if (L.xCowl !== null && Math.abs(x - (L.xCowl + 0.08)) < 0.5 / ppm) c = scale(c, 0.5);
        if (L.xCowl !== null && x > L.xCowl + 0.1 && Math.abs(z - L.yc) < 0.5 / ppm) c = scale(c, 0.85);
        // roof rack / rails on SUVs and vans
        if (onRoof && (L.style === 'suv' || L.style === 'minivan') && Math.abs(zl - 0.72) < 0.03) c = trim;
        // bus / van roof ribs
        if ((L.style === 'bus' || L.style === 'van' || L.style === 'truck') && onRoof && Math.floor(x * ppm) % 24 === 0) c = scale(c, 0.8);
        // trunk lid seam
        const rg = L.sections.find((s) => s.kind === 'rearglass');
        if (rg && Math.abs(x - (rg.x0 - p.rearRake - 0.04)) < 0.5 / ppm) c = scale(c, 0.5);
        const bed = L.sections.find((s) => s.kind === 'bed');
        if (bed && x < bed.x0 && x > bed.x1 + 0.02) c = zl > 0.86 ? scale(col.body, 0.8) : [60, 60, 62];
        put(sh.u0 + tu, sh.v0 + tv, weather(c, x, z, 0.5, Math.round(x)));
      }
  }

  // --- front and rear faces ---
  for (const end of ['front', 'rear'] as const) {
    const sh = lay.sheets[end];
    const lamps = end === 'front' ? inp.headlamps : inp.taillamps;
    for (let tv = 0; tv < sh.h; tv++)
      for (let tu = 0; tu < sh.w; tu++) {
        const z = sh.a0 + (tu + 0.5) / ppm, y = (tv + 0.5) / ppm;
        const zl = (z - L.yc) / L.hw;
        let c: RGB = scale(col.lower && y < p.belt - 0.28 ? col.lower : col.body, 0.95);
        if (y > p.belt + 0.02 && L.style !== 'bus') c = p.blackPillars ? trim : c;
        if (y < p.sill + 0.24) c = p.bumper === 'chrome' ? chrome : p.bumper === 'black' ? [40, 41, 44] : scale(c, 0.8);
        if (Math.abs(y - (p.sill + 0.24)) < 0.5 / ppm) c = [20, 20, 22];
        if (end === 'front') {
          // grille between the headlamps, horizontal slats
          const gTop = Math.min(p.nose - 0.1, p.lampY + p.lampH + 0.04), gBot = p.sill + 0.26;
          const lampZ = lamps.length ? Math.min(...lamps.map((l) => Math.abs(l.z - L.yc) - l.w)) : L.hw * 0.5;
          if (L.style !== 'bus' && y > gBot && y < gTop && Math.abs(z - L.yc) < lampZ - 0.05) {
            const slat = Math.floor((y - gBot) * ppm) % 3 === 0;
            c = slat ? (p.bumper === 'chrome' ? chrome : [70, 72, 76]) : [18, 18, 20];
            if (Math.abs(z - L.yc) < 0.05 && Math.abs(y - (gBot + gTop) / 2) < 0.04) c = chrome;
          }
          if (L.style === 'bus' && y > p.sill + 0.3 && y < p.sill + 0.5 && Math.abs(zl) < 0.5 && Math.floor(y * ppm) % 2 === 0) c = [30, 30, 32];
        } else {
          // trunk / tailgate seam and handle
          if (Math.abs(y - (p.sill + 0.4)) < 0.5 / ppm && Math.abs(zl) < 0.7) c = scale(c, 0.6);
          if (Math.abs(y - (p.belt - 0.1)) < 0.03 && Math.abs(z - L.yc) < 0.12) c = chrome;
        }
        // licence plate
        const plateY = p.sill + (end === 'front' ? 0.14 : 0.36);
        if (Math.abs(z - L.yc) < 0.16 && Math.abs(y - plateY) < 0.07) c = Math.abs(z - L.yc) > 0.14 || Math.abs(y - plateY) > 0.05 ? [30, 30, 34] : (Math.floor((z - L.yc) * ppm) % 2 === 0 && Math.abs(y - plateY) < 0.02 ? [40, 50, 90] : [214, 212, 200]);
        // lamps: lens with a bright core and a dark bezel (the emissive lamp mesh sits on top)
        for (const l of lamps) {
          const dz = Math.abs(z - l.z), dy = Math.abs(y - l.y);
          if (dz < l.w + 0.02 && dy < l.h + 0.02) c = dz < l.w && dy < l.h ? (end === 'front' ? (dz < l.w * 0.5 ? [236, 234, 220] : [176, 178, 172]) : (dy < l.h * 0.4 ? [210, 60, 44] : [140, 24, 20])) : [24, 24, 26];
        }
        put(sh.u0 + tu, sh.v0 + tv, weather(c, z + (end === 'front' ? 30 : -30), y, y - p.sill, Math.round(end === 'front' ? L.xNose : L.xTail)));
      }
  }

  // --- underside swatch: dark oily grime ---
  {
    const sh = lay.sheets.under;
    for (let tv = 0; tv < sh.h; tv++) for (let tu = 0; tu < sh.w; tu++) put(sh.u0 + tu, sh.v0 + tv, [28 + ((tu + tv) % 3) * 4, 27, 26]);
  }
  return { layout: lay, data };
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
function emblem(L: Layout, sh: Sheet, side: -1 | 1, col: { body: RGB; stripe?: RGB }, put: (u: number, v: number, c: RGB) => void, get: (u: number, v: number) => RGB): void {
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

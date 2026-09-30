import { has, type Vehicle, type VehiclePart } from '../vehicle';
import { templateParams, type BodyStyle, type ChassisTemplate, type RowKind, type StyleParams, type TemplateId } from './templates';

// A template placed on one vehicle's part grid (CDDA mount points, +x forward, +y right):
// the body's extent in mount space (nose, tail, half width), where the grid puts the things
// the body must honour (hood / windscreen / cabin / bed / box rows, wheels, doors, side
// windows), and the row -> body mapping (xOf / zOf). Pure data: no three.js. The chassis
// (index.ts) caches one per vehicle; the renderer draws it (vehicleModel.ts), collision uses
// its outline (vehicleShape.ts), sockets and seats are placed with it (mapping.ts).
//
// This is an adaptation, not a simulation: a CDDA car is 4 tiles wide, which drawn to scale
// is a 4 m wide pancake. The template's body is narrower (widthPerCol): the side walls, doors
// and wheels move in from the outer columns, while seats keep their grid positions (`zOf()`).
// (Moved here from src/render/vehicleLayout.ts in vehicles v3 phase 1.)

export type { BodyStyle, RowKind, StyleParams } from './templates';
export { STYLE_PARAMS } from './templates';

export type Livery = 'plain' | 'police' | 'ambulance' | 'school' | 'fire' | 'military' | 'fbi' | 'swat' | 'security' | 'icecream' | 'hippie' | 'prison' | 'hazmat' | 'transit' | 'motorhome' | 'food';

export function liveryFromId(id: string): Livery {
  const s = id.toLowerCase();
  if (/fbi/.test(s)) return 'fbi';
  if (/swat/.test(s)) return 'swat';
  if (/police|k9/.test(s)) return 'police';
  if (/ambulance|medevac/.test(s)) return 'ambulance';
  if (/schoolbus/.test(s)) return 'school';
  if (/prison/.test(s)) return 'prison';
  if (/fire/.test(s)) return 'fire';
  if (/humvee|jltv|military|apc|whillys|armored|tank|patton|abrams|bradley|aapc/.test(s)) return 'military';
  if (/security/.test(s)) return 'security';
  if (/icecream|ice_cream/.test(s)) return 'icecream';
  if (/hippie/.test(s)) return 'hippie';
  if (/hazmat/.test(s)) return 'hazmat';
  if (/^bus($|_tour)/.test(s)) return 'transit';
  if (/(^|_)rv$/.test(s)) return 'motorhome';
  if (/food_truck/.test(s)) return 'food';
  return 'plain';
}

/** What one row (all mounts with the same x) of the grid holds. */
export interface RowInfo {
  x: number;
  /** Columns (my) with a mount in this row. */
  cols: number[];
  /** Windscreen / window parts on inner columns (a windscreen or rear glass row). */
  innerGlass: boolean;
  roof: boolean;
  seat: boolean;
  fullBoard: boolean;
  halfBoard: boolean;
  cargo: boolean;
  /** Per side (-1 left, +1 right): the outermost part that forms the wall at this row. */
  side: Record<-1 | 1, SideWall>;
  /** An OPENABLE part across the rear / front row (trunk lid, tailgate, rear doors, shutter). */
  endDoor: VehiclePart | null;
}

/** What stands on one side of a row: decides doors, window panes and holes in the body. */
export interface SideWall {
  kind: 'door' | 'glass' | 'board' | 'half' | 'none';
  part: VehiclePart | null;
}

export interface Section {
  kind: RowKind;
  /** Front and rear edges, mount x units (x0 > x1). */
  x0: number;
  x1: number;
  rows: number[];
}

export interface WheelInfo {
  part: VehiclePart;
  /** Visual centre along the vehicle (mount x units, may be pulled in from the row centre). */
  x: number;
  /** Visual centre across (three.js Z, mount y units). */
  z: number;
  r: number;
  width: number;
  /** -1 left, +1 right, 0 centre (bikes). */
  side: -1 | 0 | 1;
  steer: boolean;
}

export interface DoorInfo {
  part: VehiclePart;
  side: -1 | 1;
  /** Visual front / rear edge (x0 > x1). */
  x0: number;
  x1: number;
  window: boolean;
}

export interface Layout {
  /** The chassis template this layout places (templates.ts). */
  template: TemplateId;
  /** 'frame' templates collide with their cells; 'body' / 'bike' with the outline. */
  family: ChassisTemplate['family'];
  style: BodyStyle;
  livery: Livery;
  p: StyleParams;
  /** Visual nose / tail (mount x units). */
  xNose: number;
  xTail: number;
  /** Grid centre across (mount y) and the visual half width (m). */
  yc: number;
  hw: number;
  /** Mount column -> visual Z. */
  zOf: (my: number) => number;
  /** Mount x -> visual x (the body is shortened around the grid's middle, `lengthScale`). */
  xOf: (mx: number) => number;
  rows: RowInfo[];
  sections: Section[];
  wheels: WheelInfo[];
  doors: DoorInfo[];
  /** Front edge of the windscreen row (the cowl), or null when there is no windscreen. */
  xCowl: number | null;
  /** Cabin extent (front / rear edges). */
  cabin: { x0: number; x1: number } | null;
  /** Fraction of parts broken or badly damaged: drives grime, rust and sag. */
  wear: number;
  /** Body columns (mount y) the template's shell spans; parts beyond them are off the body. */
  yMin: number;
  yMax: number;
  /** Grid rows (mount x) the body spans, inclusive. */
  xMin: number;
  xMax: number;
}

const INNER_GLASS = (p: VehiclePart) => has(p, 'WINDSHIELD') || (has(p, 'WINDOW') && !has(p, 'OPENABLE'));

/** Wheel radius (m) from BN's wheel part: `diameter` is the rim in cm (vpart_info::wheel_info,
 * "425 mm" -> 42.5), plus a sidewall. Bicycle "diameters" already include the tyre. */
export function wheelRadius(p: VehiclePart, scale = 1): number {
  const d = p.def.wheel?.diameter ?? 40;
  const bike = has(p, 'NEEDS_WHEEL_MOUNT_LIGHT') && d >= 60;
  const r = bike ? d / 200 : d / 200 + (d >= 30 ? 0.12 : 0.04);
  return Math.max(0.08, Math.min(0.85, r * scale));
}

function sideWall(parts: VehiclePart[]): SideWall {
  const door = parts.find((p) => has(p, 'OPENABLE') && (has(p, 'OBSTACLE') || has(p, 'WINDOW')));
  if (door) return { kind: 'door', part: door };
  const glass = parts.find((p) => has(p, 'WINDSHIELD') || (has(p, 'WINDOW') && has(p, 'OBSTACLE')));
  if (glass) return { kind: 'glass', part: glass };
  const board = parts.find((p) => has(p, 'FULL_BOARD'));
  if (board) return { kind: 'board', part: board };
  const half = parts.find((p) => has(p, 'HALF_BOARD'));
  if (half) return { kind: 'half', part: half };
  return { kind: 'none', part: null };
}

/** Columns (mount y) holding structure, protrusions (rams, mirrors) excluded: the body's width. */
export function bodyColumns(v: Vehicle): number[] {
  const cols = new Set<number>();
  for (const p of v.parts) if (p.def.location === 'structure' && !has(p, 'PROTRUSION') && !has(p, 'PROTUSION')) cols.add(p.my);
  if (!cols.size) for (const p of v.parts) cols.add(p.my);
  return [...cols].sort((a, b) => a - b);
}

/**
 * How wide bodies are drawn: 'real' squeezes toward real-car proportions (a car ~2.6 m on
 * its 4-tile grid; you bump into air beside it, collision is the grid), 'fill' draws them
 * close to the grid footprint (~0.3 m short of each side: collision agrees, proportions are
 * chunkier). `?vehiclewidth=real|fill`, Options > Vehicle width, `cdda.vehicleWidth()`.
 */
export type VehicleWidth = 'real' | 'fill';
export const VEHICLE_WIDTHS: VehicleWidth[] = ['real', 'fill'];
let widthMode: VehicleWidth = 'real';
/** Bumped on every width change: cached layouts (index.ts) are keyed on it. */
export let widthEpoch = 0;
export function setVehicleWidth(w: VehicleWidth): void {
  if (!VEHICLE_WIDTHS.includes(w)) throw new Error(`unknown vehicle width ${w}`);
  if (w !== widthMode) widthEpoch++;
  widthMode = w;
}
export function vehicleWidth(): VehicleWidth {
  return widthMode;
}

/**
 * Place template `t` on `v`'s grid. Uncached: use layoutOf (index.ts), which also picks the
 * vehicle's template.
 */
export function placeTemplate(v: Vehicle, t: ChassisTemplate): Layout {
  const style = t.style;
  const p = templateParams(t);
  const livery = liveryFromId(v.protoId);
  // Motorhomes: a taller box that runs forward over the cab.
  if (style === 'van' && /(^|_)rv$|motorhome|camper_rv/.test(v.protoId)) Object.assign(p, { overcab: true, box: 2.85 });
  // School buses are the conventional kind: a bonnet ahead of the windscreen.
  if (style === 'bus' && livery === 'school') Object.assign(p, { flatFront: false, hood: 1.4, nose: 1.25, rake: 0.35, lampY: 1.02 });
  // An empty prototype (BN's "none") still gets a (degenerate) layout at mount (0, 0).
  const cols = v.parts.length ? bodyColumns(v) : [0];
  const yMin = cols[0], yMax = cols[cols.length - 1];
  const yc = (yMin + yMax) / 2;
  const ncols = yMax - yMin + 1;
  const [bx0, , bx1] = v.parts.length ? v.bounds() : [0, 0, 0, 0];

  // Visual width: squeezed (see the header); bikes are narrow whatever their grid says.
  let hw = style === 'motorcycle' ? 0.4 : style === 'bicycle' ? 0.3 : Math.max(0.5, (ncols * p.widthPerCol) / 2);
  if (style === 'bus' || style === 'truck' || style === 'van') hw = Math.min(hw, 1.6);
  if (widthMode === 'fill' && style !== 'motorcycle' && style !== 'bicycle') hw = Math.max(hw, ncols / 2 - 0.3);
  // Inner columns (seats) stay where the grid has them, so a passenger's eye and the seat
  // they sit in agree; only columns that would land outside the body are pulled in.
  const lim = Math.max(0, hw - 0.3);
  const zOf = (my: number) => yc + Math.max(-lim, Math.min(lim, my - yc));

  // Rows, front to back.
  const rowMap = new Map<number, VehiclePart[][]>();
  for (const key of v.mounts()) {
    const mx = Math.floor(key / 1024) - 512, my = (key % 1024) - 512;
    let r = rowMap.get(mx);
    if (!r) rowMap.set(mx, (r = []));
    r.push(v.partsAt(mx, my));
  }
  const rows: RowInfo[] = [];
  for (let x = bx1; x >= bx0; x--) {
    const mounts = rowMap.get(x) ?? [];
    const all = mounts.flat();
    const colsHere = [...new Set(all.map((q) => q.my))].sort((a, b) => a - b);
    const lo = colsHere.filter((c) => c >= yMin)[0] ?? yMin, hi = colsHere.filter((c) => c <= yMax).pop() ?? yMax;
    const inner = all.filter((q) => q.my > lo && q.my < hi);
    const atCol = (c: number) => all.filter((q) => q.my === c);
    const endDoor = (x === bx0 || x === bx1) ? all.find((q) => has(q, 'OPENABLE') && q.my > lo && q.my < hi) ?? null : null;
    rows.push({
      x,
      cols: colsHere,
      innerGlass: inner.some(INNER_GLASS) || (colsHere.length <= 2 && all.some(INNER_GLASS)),
      roof: all.some((q) => has(q, 'ROOF')),
      seat: all.some((q) => has(q, 'SEAT') || has(q, 'BED')),
      fullBoard: all.some((q) => has(q, 'FULL_BOARD')),
      halfBoard: all.some((q) => has(q, 'HALF_BOARD')),
      cargo: all.some((q) => has(q, 'CARGO')),
      side: { [-1]: sideWall(atCol(lo)), [1]: sideWall(atCol(hi)) } as Record<-1 | 1, SideWall>,
      endDoor,
    });
  }

  const kx = widthMode === 'fill' ? 1 : p.lengthScale;
  const xc = (bx0 + bx1) / 2;
  const xOf = (mx: number) => xc + (mx - xc) * kx;
  const sections = style === 'motorcycle' || style === 'bicycle' || style === 'frame' ? [] : buildSections(rows, style, p);
  const shieldRaw = sections.find((s) => s.kind === 'shield');
  const doors = findDoors(rows, sections, shieldRaw ? shieldRaw.x0 : null);
  for (const d of doors) {
    d.x0 = xOf(d.x0);
    d.x1 = xOf(d.x1);
  }
  for (const s of sections) {
    s.x0 = xOf(s.x0);
    s.x1 = xOf(s.x1);
  }
  const shield = sections.find((s) => s.kind === 'shield');
  const xCowl = shield ? shield.x0 : null;
  const cabSecs = sections.filter((s) => s.kind === 'shield' || s.kind === 'cabin' || s.kind === 'rearglass');
  const cabin = cabSecs.length ? { x0: cabSecs[0].x0, x1: cabSecs[cabSecs.length - 1].x1 } : null;

  // Wheels: pulled in from the very ends so the bumpers overhang them like a real car's.
  const xNose = xOf(bx1 + 0.5) - 0.04, xTail = xOf(bx0 - 0.5) + 0.04;
  const wheels: WheelInfo[] = [];
  const wheelCols = new Map<number, number[]>();
  for (const w of v.wheels) {
    const list = wheelCols.get(w.mx) ?? [];
    list.push(w.my);
    wheelCols.set(w.mx, list);
  }
  for (const w of v.wheels) {
    const r = wheelRadius(w, p.wheelScale);
    const width = Math.max(0.05, Math.min(0.5, ((w.def.wheel?.width ?? 20) / 100) * 1.1));
    let x = xOf(w.mx);
    if (style !== 'motorcycle' && style !== 'bicycle' && style !== 'frame') {
      if (w.mx === bx1) x = Math.min(x, xNose - r - 0.42);
      if (w.mx === bx0) x = Math.max(x, xTail + r + 0.42);
    }
    const colsHere = wheelCols.get(w.mx)!;
    let side: -1 | 0 | 1 = w.my < yc - 0.01 ? -1 : w.my > yc + 0.01 ? 1 : 0;
    let z = yc;
    if (style === 'motorcycle' || style === 'bicycle') {
      // A sidecar wheel sits off to the side; the bike's own wheels are on the centre line.
      z = w.my === cols[0] || ncols === 1 ? yc : zOf(w.my);
      if (ncols > 1 && w.my === yMin) { z = yMin; side = 0; }
    } else if (side !== 0) {
      // Dual wheels: count columns in from the outermost wheel on this side.
      const same = colsHere.filter((c) => (c - yc) * side > 0).sort((a, b) => (b - a) * side);
      const rank = same.indexOf(w.my);
      z = yc + side * (hw - width / 2 + 0.03 - rank * (width + 0.03));
    }
    // steering comes from the wheel's mount (wheel_mount_*_steerable) or a steerable wheel part
    const steer = v.partsAt(w.mx, w.my).some((q) => has(q, 'STEERABLE') || /steerable/.test(q.def.id));
    wheels.push({ part: w, x, z, r, width, side, steer });
  }

  const broken = v.parts.filter((q) => q.hp <= 0).length;
  const hurt = v.parts.reduce((a, q) => a + (q.def.durability > 0 ? 1 - Math.max(0, q.hp) / q.def.durability : 0), 0);
  const wear = v.parts.length ? Math.min(1, (broken * 1.5 + hurt) / v.parts.length / 1.2) : 0;

  return { template: t.id, family: t.family, style, livery, p, xNose, xTail, yc, hw, zOf, xOf, rows, sections, wheels, doors, xCowl, cabin, wear, yMin, yMax, xMin: bx0, xMax: bx1 };
}

/**
 * Group rows into body sections. The windscreen row splits hood (ahead) from cabin
 * (behind); behind the cabin come boxes (full boards + roof), beds (pickups: side walls,
 * open top) or decks (trunk lids, flatbeds).
 */
export function buildSections(rows: RowInfo[], style: BodyStyle, p: StyleParams): Section[] {
  const kinds: RowKind[] = [];
  const shieldIdx = rows.findIndex((r) => r.innerGlass);
  const front = shieldIdx >= 0 && shieldIdx < rows.length - 1 ? shieldIdx : -1;
  let phase: 'front' | 'cabin' | 'after' = 'front';
  let sawSeat = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (front < 0) {
      // No windscreen: everything with a roof is cabin, the rest deck. A truck-class grid
      // without seats (a semi trailer) is one cargo box.
      const boxy = (style === 'truck' || style === 'van') && !rows.some((q) => q.seat);
      kinds.push(boxy && (r.fullBoard || r.cargo || r.roof) ? 'box' : r.roof || r.seat ? 'cabin' : r.fullBoard ? 'box' : 'deck');
      continue;
    }
    if (i < front) {
      kinds.push('hood');
      continue;
    }
    if (i === front) {
      kinds.push('shield');
      phase = 'cabin';
      continue;
    }
    if (phase === 'cabin') {
      if (r.innerGlass && sawSeat) {
        // Glass across a limousine's cabin is the chauffeur's partition, not a rear window.
        if (rows.slice(i + 1).some((q) => q.seat && q.roof)) {
          kinds.push('cabin');
          continue;
        }
        kinds.push('rearglass');
        phase = 'after';
        continue;
      }
      // Vans and trucks: a full-board row behind the seats starts the box body (an RV's
      // living area, a food truck's kitchen, a fire engine's lockers), roofed or not.
      if ((style === 'van' || style === 'truck') && sawSeat && r.fullBoard && !r.seat) {
        phase = 'after';
        const boxRun = rows.slice(i).findIndex((q) => !q.fullBoard && !q.roof);
        // a single board row closing a truck cab (the sleeper's back wall) stays cab
        if (style === 'truck' && boxRun === 1) {
          kinds.push('cabin');
          continue;
        }
      }
      // A full-board partition without a roof ends the cab (cube van row behind the seats).
      if (phase === 'after') {
        // (set just above)
      } else if (r.fullBoard && !r.roof && !r.seat) {
        phase = 'after';
      } else if (style === 'sedan' && sawSeat && !r.seat && r.roof && i < rows.length - 1) {
        // A roofed cargo row behind the rear seats (BN's generic "car"): draw a sedan's
        // rear window and trunk instead of a wagon roof running to the tail.
        kinds.push('rearglass');
        phase = 'after';
        continue;
      } else if (r.seat || (r.roof && (style !== 'pickup' || !sawSeat))) {
        if (r.seat) sawSeat = true;
        kinds.push('cabin');
        continue;
      } else phase = 'after';
    }
    // behind the cabin
    if (style === 'pickup') kinds.push('bed');
    else if (r.fullBoard && (r.roof || p.box > 0)) kinds.push('box');
    // a van's box has windows too (an RV's living area): roofed rows stay box
    else if (style === 'van' && r.roof && kinds.includes('box')) kinds.push('box');
    // behind a sedan's real rear window it's all trunk
    else if (r.roof && (style === 'sedan' || style === 'sports') && kinds.includes('rearglass')) kinds.push('deck');
    else if (r.roof && (style === 'suv' || style === 'hatch' || style === 'minivan' || style === 'bus' || style === 'sedan' || style === 'sports')) kinds.push('cabin');
    else if (r.halfBoard && r.cargo && !r.roof && r.side[-1].kind !== 'none' && style === 'truck') kinds.push('bed');
    else if (r.halfBoard || r.endDoor || r.roof) kinds.push('deck');
    else kinds.push('flat');
  }
  // Boxes need a box height; a style without one treats them as cabin (a raised roof).
  const out: Section[] = [];
  rows.forEach((r, i) => {
    let kind = kinds[i];
    if (kind === 'box' && p.box <= 0) kind = 'cabin';
    // Buses and vans are one volume: rows behind a van's cab partition are box, not deck.
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind !== 'shield' && kind !== 'rearglass') {
      last.x1 = r.x - 0.5;
      last.rows.push(r.x);
    } else out.push({ kind, x0: r.x + 0.5, x1: r.x - 0.5, rows: [r.x] });
  });
  return out;
}

function findDoors(rows: RowInfo[], sections: Section[], xCowl: number | null): DoorInfo[] {
  const out: DoorInfo[] = [];
  const cabinRow = (x: number) => sections.some((s) => (s.kind === 'cabin' || s.kind === 'box') && s.rows.includes(x));
  for (const r of rows) {
    for (const side of [-1, 1] as const) {
      const w = r.side[side];
      if (w.kind !== 'door' || !w.part) continue;
      let x0 = r.x + 0.5, x1 = r.x - 0.5;
      // A front door reaches forward to the A-pillar when the windscreen row is just ahead.
      if (xCowl !== null && Math.abs(x0 - (xCowl - 1)) < 0.01 && cabinRow(r.x)) x0 = xCowl - 0.12;
      out.push({ part: w.part, side, x0, x1, window: has(w.part, 'WINDOW') });
    }
  }
  return out;
}

/**
 * The body outline collision uses (vehicleShape.ts BodyRect, mount space): the template's
 * shell, or null for frame templates (they collide with their cells). Wheels sit a few cm
 * proud of the sides, so they count.
 */
export function layoutBodyRect(L: Layout): { x0: number; x1: number; y0: number; y1: number } | null {
  if (L.family === 'frame' || (L.family === 'body' && !L.sections.length)) return null;
  const w = L.hw + 0.04;
  return { x0: L.xTail, x1: L.xNose, y0: L.yc - w, y1: L.yc + w };
}

/** Seat cushion top above the floor level (m): what the renderer draws and riders sit on. */
export function seatTopOf(L: Layout): number {
  if (L.family === 'frame') return 0.62;
  if (L.family === 'bike') {
    const r = Math.max(0.2, ...L.wheels.map((w) => w.r));
    return r + (L.style === 'bicycle' ? 0.5 : 0.6);
  }
  const floorY = L.p.sill + 0.1;
  return Math.max(floorY + 0.2, L.p.belt - 0.45);
}

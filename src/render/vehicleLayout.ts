import { has, type Vehicle, type VehiclePart } from '../game/vehicle';

// Reads a vehicle's part grid (CDDA mount points, +x forward, +y right) and decides how its
// body should look: a body style (sedan, pickup, bus...), style dimensions, and where the
// grid puts the things the model must honour (hood / windscreen / cabin / bed / box rows,
// wheels, doors, side windows). Pure data: no three.js, unit-tested in
// tests/vehicleModel.test.ts. vehicleModel.ts turns a Layout into geometry.
//
// This is an adaptation, not a simulation: a CDDA car is 4 tiles wide, which drawn to scale
// is a 4 m wide pancake. The model squeezes the width (widthPerCol): the side walls, doors
// and wheels move in from the outer columns, while seats keep their grid positions (`zOf()`)
// and collision and interaction keep using the grid.

export type BodyStyle = 'sedan' | 'hatch' | 'sports' | 'suv' | 'pickup' | 'van' | 'minivan' | 'bus' | 'truck' | 'motorcycle' | 'bicycle' | 'frame';
export type Livery = 'plain' | 'police' | 'ambulance' | 'school' | 'fire' | 'military' | 'fbi' | 'swat' | 'security' | 'icecream' | 'hippie' | 'prison' | 'hazmat' | 'transit';

/** Style dimensions, metres above the ground (z-level floor) unless noted. */
export interface StyleParams {
  /** Underside of the body (ground clearance). */
  sill: number;
  /** Beltline: bottom of the side windows, top of the doors. */
  belt: number;
  /** Bonnet height at the windscreen and at the nose. */
  hood: number;
  nose: number;
  /** Roof of the cabin. */
  roof: number;
  /** Trunk lid / bed rail / flat deck height behind the cabin. */
  deck: number;
  /** Cargo box / sleeper roof (0 = no box). */
  box: number;
  /** Horizontal run of the windscreen (m): long = raked (sports), short = upright (bus). */
  rake: number;
  /** Horizontal run of the rear glass (sedans / fastbacks). */
  rearRake: number;
  /** Bulge of hood / roof / nose across the width (m). */
  crown: number;
  /** Radius of the rounded edge between the sides and the top (m). */
  shoulder: number;
  /** How much narrower the greenhouse is at the roof than at the beltline (fraction of width). */
  tumble: number;
  /** Visual width per grid column (m). */
  widthPerCol: number;
  /** Nose face goes straight up into the windscreen (bus, cab-over van). */
  flatFront: boolean;
  /** Tyre sidewall added to the rim radius, and an extra scale for chunky off-roaders. */
  wheelScale: number;
  bumper: 'chrome' | 'black' | 'body';
  /** Pillars and window frames painted black (modern) or body colour (older / utility). */
  blackPillars: boolean;
  /** Headlamp centre height and half-size (m). */
  lampY: number;
  lampW: number;
  lampH: number;
  /** Interior trim colour. */
  interior: number;
}

const BASE: StyleParams = {
  sill: 0.3, belt: 0.98, hood: 0.98, nose: 0.78, roof: 1.55, deck: 1.02, box: 0, rake: 0.95, rearRake: 0.85,
  crown: 0.06, shoulder: 0.12, tumble: 0.14, widthPerCol: 0.64, flatFront: false, wheelScale: 1, bumper: 'black',
  blackPillars: true, lampY: 0.7, lampW: 0.2, lampH: 0.06, interior: 0x3a3a3e,
};

export const STYLE_PARAMS: Record<BodyStyle, StyleParams> = {
  sedan: { ...BASE },
  hatch: { ...BASE, roof: 1.58, rake: 0.9 },
  sports: { ...BASE, sill: 0.22, belt: 0.8, hood: 0.78, nose: 0.58, roof: 1.2, deck: 0.84, rake: 1.25, rearRake: 1.3, crown: 0.07, shoulder: 0.14, tumble: 0.2, lampY: 0.55, lampW: 0.22, lampH: 0.05 },
  suv: { ...BASE, sill: 0.42, belt: 1.16, hood: 1.14, nose: 1.0, roof: 1.92, deck: 1.16, rake: 0.8, crown: 0.05, shoulder: 0.1, tumble: 0.1, wheelScale: 1.15, lampY: 0.9, lampW: 0.22, lampH: 0.08 },
  pickup: { ...BASE, sill: 0.44, belt: 1.18, hood: 1.2, nose: 1.08, roof: 1.92, deck: 1.18, rake: 0.75, crown: 0.04, shoulder: 0.08, tumble: 0.08, wheelScale: 1.15, bumper: 'chrome', lampY: 0.95, lampW: 0.2, lampH: 0.09 },
  van: { ...BASE, sill: 0.4, belt: 1.25, hood: 1.28, nose: 1.1, roof: 2.2, deck: 1.25, box: 2.6, rake: 0.55, crown: 0.03, shoulder: 0.08, tumble: 0.06, widthPerCol: 0.62, wheelScale: 1.05, lampY: 0.95, lampW: 0.18, lampH: 0.1, blackPillars: false },
  minivan: { ...BASE, sill: 0.34, belt: 1.12, hood: 1.08, nose: 0.92, roof: 2.02, deck: 1.1, rake: 0.7, crown: 0.05, shoulder: 0.16, tumble: 0.06, lampY: 0.85, lampW: 0.18, lampH: 0.09 },
  bus: { ...BASE, sill: 0.34, belt: 1.35, hood: 1.35, nose: 1.2, roof: 2.55, deck: 1.35, rake: 0.3, crown: 0.04, shoulder: 0.14, tumble: 0.03, widthPerCol: 0.6, flatFront: true, wheelScale: 1.1, lampY: 0.75, lampW: 0.16, lampH: 0.1, blackPillars: true },
  truck: { ...BASE, sill: 0.5, belt: 1.5, hood: 1.55, nose: 1.4, roof: 2.45, deck: 1.1, box: 2.6, rake: 0.45, crown: 0.03, shoulder: 0.08, tumble: 0.05, widthPerCol: 0.58, wheelScale: 1.1, bumper: 'chrome', lampY: 1.0, lampW: 0.18, lampH: 0.11, blackPillars: false },
  motorcycle: { ...BASE },
  bicycle: { ...BASE },
  frame: { ...BASE, blackPillars: false },
};

/** Map a prototype id to a style; null = decide from the grid. */
export function styleFromId(id: string): BodyStyle | null {
  const s = id.toLowerCase();
  if (/motorcycle|scooter|superbike|motorbike/.test(s)) return 'motorcycle';
  if (/dukw/.test(s)) return 'truck';
  if (/wreck|plane|heli|tractor|hopper|chassis|golf|boat|kayak|canoe|raft|ship|jetski|blimp|airship|flier|cutter|barge|sail|scuba|tank_|apc|ifv|howitzer|train|draisine|trolley|tram|loco|test|cart|chair|bed$|skateboard|wheelbarrow|wagon|harness|dogsled|sled|generator|work_light|turret|ballista|cannon|gatling|swivel|excavator|forklift|crane|roller|trencher|roadheader|autosweeper|handjack|unicycle|hovercraft|hover|reactor|split_test|none|custom/.test(s)) return 'frame';
  if (/bicycle|tandem|tricycle/.test(s)) return 'bicycle';
  if (/motorcycle|scooter|superbike|motorbike|quad_bike/.test(s)) return /quad/.test(s) ? 'frame' : 'motorcycle';
  if (/bus/.test(s)) return 'bus';
  if (/semi_truck|tatra|military_cargo|flatbed|fire_engine|fire_truck|hazmat|tanker|truck_trailer/.test(s)) return 'truck';
  if (/cube_van|ambulance|food_truck|icecream_truck|security_van|meth_lab|animalctrl|truck_swat|blinkie|wienermobile|rv$|surv_rv|lux_rv/.test(s)) return 'van';
  if (/hippie|camper_van|minivan/.test(s)) return 'minivan';
  if (/pickup/.test(s)) return 'pickup';
  if (/suv|humvee|jltv|4x4|whillys|armored_car|policesuv/.test(s)) return 'suv';
  if (/sports|racing|formula|muscle|rara|roadwarrior|bubble/.test(s)) return 'sports';
  if (/hatch|mini|beetle|golf/.test(s)) return 'hatch';
  if (/car|sedan|police|fbi|limo|hearse|taxi/.test(s)) return 'sedan';
  return null;
}

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

export type RowKind = 'hood' | 'shield' | 'cabin' | 'rearglass' | 'box' | 'bed' | 'deck' | 'flat';

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

function bodyColumns(v: Vehicle): number[] {
  const cols = new Set<number>();
  for (const p of v.parts) if (p.def.location === 'structure' && !has(p, 'PROTRUSION') && !has(p, 'PROTUSION')) cols.add(p.my);
  if (!cols.size) for (const p of v.parts) cols.add(p.my);
  return [...cols].sort((a, b) => a - b);
}

/** Decide the style from the id, falling back to the grid's shape. */
export function classify(v: Vehicle): BodyStyle {
  const byId = styleFromId(v.protoId);
  if (byId) return byId;
  const cols = bodyColumns(v);
  const ncols = cols.length;
  const [x0, , x1] = v.bounds();
  const len = x1 - x0 + 1;
  const wheels = v.wheels.length;
  if (ncols === 1 && wheels >= 2) return wheels >= 2 && v.wheels.every((w) => (w.def.wheel?.diameter ?? 0) >= 60) ? 'bicycle' : 'motorcycle';
  const shield = v.parts.some((p) => has(p, 'WINDSHIELD'));
  if (!shield || ncols < 3 || wheels < 3) return 'frame';
  const boxes = v.parts.filter((p) => has(p, 'FULL_BOARD')).length;
  if (len >= 10) return 'bus';
  if (boxes >= 6) return 'van';
  return 'sedan';
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
export function setVehicleWidth(w: VehicleWidth): void {
  if (!VEHICLE_WIDTHS.includes(w)) throw new Error(`unknown vehicle width ${w}`);
  widthMode = w;
}
export function vehicleWidth(): VehicleWidth {
  return widthMode;
}

export function analyze(v: Vehicle, forceStyle?: BodyStyle): Layout {
  const style = forceStyle ?? classify(v);
  const p = { ...STYLE_PARAMS[style] };
  const livery = liveryFromId(v.protoId);
  // School buses are the conventional kind: a bonnet ahead of the windscreen.
  if (style === 'bus' && livery === 'school') Object.assign(p, { flatFront: false, hood: 1.4, nose: 1.25, rake: 0.35, lampY: 1.02 });
  const cols = bodyColumns(v);
  const yMin = cols[0], yMax = cols[cols.length - 1];
  const yc = (yMin + yMax) / 2;
  const ncols = yMax - yMin + 1;
  const [bx0, , bx1] = v.bounds();

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

  const sections = style === 'motorcycle' || style === 'bicycle' || style === 'frame' ? [] : buildSections(rows, style, p);
  const shield = sections.find((s) => s.kind === 'shield');
  const xCowl = shield ? shield.x0 : null;
  const cabSecs = sections.filter((s) => s.kind === 'shield' || s.kind === 'cabin' || s.kind === 'rearglass');
  const cabin = cabSecs.length ? { x0: cabSecs[0].x0, x1: cabSecs[cabSecs.length - 1].x1 } : null;

  // Wheels: pulled in from the very ends so the bumpers overhang them like a real car's.
  const xNose = bx1 + 0.5 - 0.04, xTail = bx0 - 0.5 + 0.04;
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
    let x = w.mx;
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

  const doors = findDoors(rows, sections, xCowl);
  const broken = v.parts.filter((q) => q.hp <= 0).length;
  const hurt = v.parts.reduce((a, q) => a + (q.def.durability > 0 ? 1 - Math.max(0, q.hp) / q.def.durability : 0), 0);
  const wear = v.parts.length ? Math.min(1, (broken * 1.5 + hurt) / v.parts.length / 1.2) : 0;

  return { style, livery, p, xNose, xTail, yc, hw, zOf, rows, sections, wheels, doors, xCowl, cabin, wear };
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
      // No windscreen: everything with a roof is cabin, the rest deck.
      kinds.push(r.roof || r.seat ? 'cabin' : r.fullBoard ? 'box' : 'deck');
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
        kinds.push('rearglass');
        phase = 'after';
        continue;
      }
      // A full-board partition without a roof ends the cab (cube van row behind the seats).
      if (r.fullBoard && !r.roof && !r.seat) {
        phase = 'after';
      } else if (r.seat || (r.roof && (style !== 'pickup' || !sawSeat))) {
        if (r.seat) sawSeat = true;
        kinds.push('cabin');
        continue;
      } else phase = 'after';
    }
    // behind the cabin
    if (style === 'pickup') kinds.push('bed');
    else if (r.fullBoard && (r.roof || p.box > 0)) kinds.push('box');
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
 * The body outline collision should use (vehicleShape.ts BodyRect, mount space), or null
 * when the drawing fills the grid (frame-style builds). Wheels sit a few cm proud of the
 * sides, so they count.
 */
export function bodyRectFor(v: Vehicle): { x0: number; x1: number; y0: number; y1: number } | null {
  const L = analyze(v);
  if (L.style === 'frame' || (!L.sections.length && L.style !== 'motorcycle' && L.style !== 'bicycle')) return null;
  const w = L.hw + 0.04;
  return { x0: L.xTail, x1: L.xNose, y0: L.yc - w, y1: L.yc + w };
}

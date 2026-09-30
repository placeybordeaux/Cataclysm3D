import { has, type Vehicle, type VehiclePart } from '../vehicle';
import { bodyColumns, placeTemplate, type Layout } from './layout';
import { FITTING_LOCATIONS, SOCKET_LOCATIONS, templateOf, TEMPLATES, type ChassisTemplate, type RowKind, type SocketKind, type TemplateId } from './templates';

// Mapping a BN vehicle (a free grid of parts) onto a chassis template: choose the template,
// then give every installed part a socket. BN part data, condition, faults, fuel and cargo are
// untouched: the part objects themselves go into sockets (nothing is copied or rebuilt), so
// conservation holds by construction and tests/chassis.test.ts checks it over all 257 BN
// prototypes. A part the template has no socket for is kept, working, in `overflow` with the
// reason, and reported (VehicleSystem.add); the frame family accepts everything.

export type SocketSide = 'left' | 'right' | 'front' | 'rear';

export interface Socket {
  /** Stable within a vehicle: `${kind}@${mx},${my}` (+ `:${side}` for panels). */
  id: string;
  kind: SocketKind;
  side: SocketSide | null;
  /** The BN cell this socket stands for (crash, seat and cargo still resolve through it). */
  mx: number;
  my: number;
  /** BN locations the socket takes (templates.ts SOCKET_LOCATIONS); fittings ride along. */
  accepts: readonly string[];
  /** Installed BN parts: one per location, plus any fittings. */
  parts: VehiclePart[];
}

export interface OverflowPart {
  part: VehiclePart;
  reason: string;
}

export interface VehicleChassis {
  template: TemplateId;
  sockets: Socket[];
  /** Parts with no socket on this template: kept on the vehicle and still working. */
  overflow: OverflowPart[];
  socketOf: Map<VehiclePart, Socket>;
  /** v.parts.length when mapped: a changed part list re-maps (chassisOf). */
  partCount: number;
  /** How the template was chosen, for reports: 'id', 'grid', 'saved', 'forced', or a fallback note. */
  why: string;
}

// --- choosing a template ------------------------------------------------------------------

/**
 * Template named by the prototype id, or null to decide from the grid. The id rules are the
 * wave-3 body styles' (render/vehicleLayout.ts styleFromId), split into the ladder's rungs.
 */
export function templateFromId(v: Vehicle): TemplateId | null {
  const s = v.protoId.toLowerCase();
  // Whatever it's called, a grid with wings, rotors or balloons is an aircraft build (BN's
  // flying motorcycle): road templates have nowhere to put them.
  if (v.parts.some((p) => has(p, 'WING') || has(p, 'ROTOR') || has(p, 'BALLOON') || has(p, 'PROPELLER'))) return frameFamily(v);
  if (/sea_scooter/.test(s)) return frameFamily(v);
  if (/scooter/.test(s)) return 'scooter';
  if (/motorcycle|superbike|motorbike/.test(s)) return 'motorcycle';
  if (/dukw/.test(s)) return 'heavy_truck';
  if (/wreck|plane|heli|tractor|hopper|chassis|golf|boat|kayak|canoe|raft|ship|jetski|blimp|airship|flier|cutter|barge|sail|scuba|tank_|apc|ifv|howitzer|train|draisine|trolley|tram|loco|test|cart|chair|bed$|skateboard|wheelbarrow|wagon|harness|dogsled|sled|generator|work_light|turret|ballista|cannon|gatling|swivel|excavator|forklift|crane|roller|trencher|roadheader|autosweeper|handjack|unicycle|hovercraft|hover|reactor|split_test|none|custom|quad_bike|catamaran|minijet|airliner|airboat/.test(s)) return frameFamily(v);
  if (/bicycle|tandem|tricycle/.test(s)) return 'bicycle';
  if (/bus/.test(s)) return 'bus';
  if (/semi_truck/.test(s)) return 'semi_cab';
  // Tankers without a cab (BN afs_*_tanker) are trailers like the box trailer.
  if (/trailer/.test(s) || (/tanker/.test(s) && !v.parts.some((p) => has(p, 'CONTROLS')))) return 'trailer';
  if (/tatra|military_cargo|flatbed|fire_engine|fire_truck|hazmat|tanker/.test(s)) return 'heavy_truck';
  if (/cube_van|ambulance|food_truck|icecream_truck|security_van|meth_lab|animalctrl|truck_swat|blinkie|wienermobile|rv$|surv_rv|lux_rv/.test(s)) return bodyColumns(v).length <= 4 ? 'van' : 'box_truck';
  if (/hippie|camper_van|minivan/.test(s)) return 'minivan';
  if (/pickup/.test(s)) return 'pickup';
  if (/suv|humvee|jltv|4x4|whillys|armored_car|policesuv/.test(s)) return 'suv';
  if (/sports|racing|formula|muscle|rara|roadwarrior|bubble/.test(s)) return 'sports';
  if (/hatch|mini|beetle/.test(s)) return 'hatch';
  if (/car|sedan|police|fbi|limo|hearse|taxi/.test(s)) return 'sedan';
  return null;
}

/** Which frame template an odd grid gets: by what it's built from, not its name. */
export function frameFamily(v: Vehicle): TemplateId {
  const any = (f: string) => v.parts.some((p) => has(p, f));
  if (any('FLOATS')) return 'frame_boat';
  if (any('WING') || any('ROTOR') || any('BALLOON') || any('PROPELLER')) return 'frame_air';
  if (any('TRACKED') || v.parts.filter((p) => p.def.location === 'armor').length >= 12) return 'frame_tracked';
  if (!v.parts.length) return 'frame';
  const [x0, y0, x1, y1] = v.bounds();
  if (x1 - x0 + 1 <= 2 && y1 - y0 + 1 <= 2) return 'frame_small';
  return 'frame';
}

/** Grid fallback (the wave-3 classify): what an unnamed grid looks like. */
function templateFromGrid(v: Vehicle): TemplateId {
  const ncols = bodyColumns(v).length;
  const [x0, , x1] = v.bounds();
  const len = x1 - x0 + 1;
  const wheels = v.wheels.length;
  if (ncols === 1 && wheels >= 2) return v.wheels.every((w) => (w.def.wheel?.diameter ?? 0) >= 60) ? 'bicycle' : 'motorcycle';
  const shield = v.parts.some((p) => has(p, 'WINDSHIELD'));
  if (!shield || ncols < 3 || wheels < 3) return frameFamily(v);
  const boxes = v.parts.filter((p) => has(p, 'FULL_BOARD')).length;
  if (len >= 10) return 'bus';
  if (boxes >= 6) return ncols <= 4 ? 'van' : 'box_truck';
  return 'sedan';
}

/** Does `v`'s grid fit template `t`'s envelope (body columns x rows)? */
export function fitsEnvelope(v: Vehicle, t: ChassisTemplate): boolean {
  if (t.family === 'frame') return true;
  if (!v.parts.length) return false;
  const ncols = bodyColumns(v).length;
  const [x0, , x1] = v.bounds();
  const len = x1 - x0 + 1;
  return ncols >= t.cols[0] && ncols <= t.cols[1] && len >= t.rows[0] && len <= t.rows[1];
}

/** The template a vehicle maps onto, and why. Grids outside the named template's envelope fall back to the frame family. */
export function pickTemplate(v: Vehicle): { template: TemplateId; why: string } {
  const byId = templateFromId(v);
  const want = byId ?? templateFromGrid(v);
  const why = byId ? 'id' : 'grid';
  if (fitsEnvelope(v, TEMPLATES[want])) return { template: want, why };
  const f = frameFamily(v);
  return { template: f, why: `${why}: ${want} envelope ${TEMPLATES[want].cols.join('-')} cols x ${TEMPLATES[want].rows.join('-')} rows doesn't fit, ${f}` };
}

// --- sockets ------------------------------------------------------------------------------

/** Shell parts: what makes a side of the body (doors, glass, boards, anything that blocks). */
function isShellPart(p: VehiclePart): boolean {
  return has(p, 'OPENABLE') || has(p, 'WINDOW') || has(p, 'WINDSHIELD') || has(p, 'FULL_BOARD') || has(p, 'HALF_BOARD')
    || (has(p, 'OBSTACLE') && !has(p, 'SEAT') && !has(p, 'BED') && !has(p, 'CARGO'));
}

const CABIN_ROWS: RowKind[] = ['shield', 'cabin', 'rearglass'];

/**
 * Map `v` onto template `templateId` (default: pickTemplate). Pure: reads the grid, returns
 * the sockets; `v` isn't modified (chassisOf stores the result on the vehicle).
 */
export function mapChassis(v: Vehicle, templateId?: TemplateId, why = templateId ? 'forced' : ''): VehicleChassis {
  let tid = templateId;
  if (!tid) {
    const pick = pickTemplate(v);
    tid = pick.template;
    why = pick.why;
  }
  const t = templateOf(tid);
  const L = placeTemplate(v, t);
  const sockets = new Map<string, Socket>();
  const socketOf = new Map<VehiclePart, Socket>();
  const overflow: OverflowPart[] = [];
  const socket = (kind: SocketKind, mx: number, my: number, side: SocketSide | null = null): Socket => {
    const id = `${kind}@${mx},${my}${side ? `:${side}` : ''}`;
    let s = sockets.get(id);
    if (!s) sockets.set(id, (s = { id, kind, side, mx, my, accepts: SOCKET_LOCATIONS[kind], parts: [] }));
    return s;
  };
  // BN allows one part per location per tile when installing (vehicle::can_mount), but its
  // prototypes are force-installed and a few stack two (a second frame, two centre parts):
  // those share the socket as they share the tile. Installing (phase 3) enforces the rule.
  const put = (p: VehiclePart, s: Socket): void => {
    const loc = p.def.location ?? '';
    if (!FITTING_LOCATIONS.includes(loc) && !s.accepts.includes(loc)) throw new Error(`chassis mapping bug: ${p.def.id} (${loc}) into ${s.id} of the ${v.name}`);
    s.parts.push(p);
    socketOf.set(p, s);
  };

  const rowOf = new Map(L.rows.map((r) => [r.x, r]));
  const sectionOf = new Map<number, RowKind>();
  for (const s of L.sections) for (const x of s.rows) sectionOf.set(x, s.kind);
  const bay = (mx: number) => t.engineBay === 'any' || (t.engineBay as RowKind[]).includes(sectionOf.get(mx) ?? 'flat');
  const onBody = (my: number) => t.family === 'frame' || (my >= L.yMin && my <= L.yMax);
  /** The side of the shell a cell is on (body family), or null for inner cells. */
  const shellSide = (mx: number, my: number): SocketSide | null => {
    if (t.family !== 'body') return null;
    const r = rowOf.get(mx);
    const cols = (r?.cols ?? []).filter((c) => c >= L.yMin && c <= L.yMax);
    if (cols.length >= 2) {
      if (my === cols[0]) return 'left';
      if (my === cols[cols.length - 1]) return 'right';
    }
    const sec = sectionOf.get(mx);
    if (mx === L.xMax || sec === 'shield') return 'front';
    if (mx === L.xMin || sec === 'rearglass') return 'rear';
    return null;
  };
  /** Where a centre-location part that isn't shell goes: cabin, engine bay or load space. */
  const roomFor = (mx: number, my: number): Socket => {
    if (t.family !== 'body') return socket('cabin', mx, my);
    const sec = sectionOf.get(mx);
    if (sec === 'hood' && bay(mx)) return socket('engine', mx, my);
    if (!sec || CABIN_ROWS.includes(sec)) return socket('cabin', mx, my);
    return socket('interior', mx, my);
  };

  const fittings: VehiclePart[] = [];
  for (const p of v.parts) {
    const loc = p.def.location ?? '';
    if (FITTING_LOCATIONS.includes(loc)) {
      fittings.push(p);
      continue;
    }
    const { mx, my } = p;
    // Side-mounted protrusions (wing mirrors, side rams) stand in the column just outside
    // the body: they hang on that side's panel.
    if (!onBody(my) && t.family === 'body' && has(p, 'PROTRUSION') && (my === L.yMin - 1 || my === L.yMax + 1)) {
      put(p, socket('panel', mx, my, my < L.yMin ? 'left' : 'right'));
      continue;
    }
    if (!onBody(my)) {
      overflow.push({ part: p, reason: `column ${my} is off the ${t.name.toLowerCase()} body (${L.yMin}..${L.yMax})` });
      continue;
    }
    const side = shellSide(mx, my);
    switch (loc) {
      case 'structure':
        put(p, socket('frame', mx, my));
        break;
      case 'axle':
        put(p, socket('wheel', mx, my));
        break;
      case 'under':
        put(p, socket(has(p, 'WHEEL') ? 'wheel' : 'frame', mx, my));
        break;
      case 'roof':
      case 'on_roof':
      case 'on_ceiling':
        put(p, socket('roof', mx, my));
        break;
      case 'engine_block':
        if (bay(mx)) put(p, socket('engine', mx, my));
        else overflow.push({ part: p, reason: `engine outside the ${t.name.toLowerCase()}'s engine bay (${sectionOf.get(mx) ?? 'no section'} row ${mx})` });
        break;
      case 'fuel_source':
        // In the engine bay a tank sits by the engine; anywhere else it's strapped to the frame.
        put(p, t.family === 'body' && sectionOf.get(mx) === 'hood' && bay(mx) ? socket('engine', mx, my) : socket('frame', mx, my));
        break;
      case 'armor':
        put(p, side ? socket('panel', mx, my, side) : socket('frame', mx, my));
        break;
      case 'on_windshield':
        put(p, side ? socket('panel', mx, my, side) : roomFor(mx, my));
        break;
      case 'center':
        put(p, side && isShellPart(p) ? socket('panel', mx, my, side) : roomFor(mx, my));
        break;
      default:
        overflow.push({ part: p, reason: `unknown BN location "${loc}"` });
    }
  }
  // Fittings (lights, horns, batteries, seatbelts, alarms...) ride on the socket that hosts
  // their cell: whatever holds the cell's centre part, else its frame, else anything there.
  const HOST_ORDER: SocketKind[] = ['cabin', 'engine', 'interior', 'panel', 'frame', 'wheel', 'roof'];
  for (const p of fittings) {
    const here = [...sockets.values()].filter((s) => s.mx === p.mx && s.my === p.my);
    const host = HOST_ORDER.map((k) => here.find((s) => s.kind === k)).find((s) => s);
    if (host) put(p, host);
    else overflow.push({ part: p, reason: `nothing on its cell (${p.mx}, ${p.my}) to attach to` });
  }
  return { template: tid, sockets: [...sockets.values()], overflow, socketOf, partCount: v.parts.length, why };
}

/** A socket's position on the body (mount space, x along / y across) at layout `L`. */
export function socketPos(L: Layout, s: Socket): [number, number] {
  if (s.kind === 'wheel') {
    const w = L.wheels.find((q) => q.part.mx === s.mx && q.part.my === s.my);
    if (w) return [w.x, w.z];
  }
  if (L.family === 'frame') return [s.mx, s.my];
  const x = L.xOf(s.mx), y = L.zOf(s.my);
  switch (s.side) {
    case 'left':
      return [x, L.yc - L.hw];
    case 'right':
      return [x, L.yc + L.hw];
    case 'front':
      return [s.mx === L.xMax ? L.xNose : x + 0.5 * L.p.lengthScale, y];
    case 'rear':
      return [s.mx === L.xMin ? L.xTail : x - 0.5 * L.p.lengthScale, y];
    default:
      return [x, y];
  }
}

import { has, type Vehicle, type VehiclePart } from '../vehicle';
import type { BodyRect } from '../vehicleShape';
import { layoutBodyRect, placeTemplate, seatTopOf, widthEpoch, type Layout } from './layout';
import { fitsEnvelope, mapChassis, pickTemplate, socketPos, type Socket, type VehicleChassis } from './mapping';
import { templateOf, TEMPLATES, type TemplateId } from './templates';

// The chassis of a vehicle (vehicles v3 phase 1): the one place the game, the renderer and
// other systems ask "what body is this vehicle": its template, the parts' sockets, the placed
// layout (body outline = collision, seats, doors, wheels) and where a hit lands.
//
//   chassisOf(v)       template + sockets + overflow (maps the grid on first use)
//   layoutOf(v)        the template placed on the grid (cached per vehicle version / width)
//   chassisBodyRect(v) the collision outline in mount space, null for frame templates
//   chassisSeats(v)    every seat with its drawn position and height (riders, boarding)
//   hitMount(v, x, y)  body point -> the socket on that side -> the BN cell that takes a hit

export * from './templates';
export { mapChassis, pickTemplate, fitsEnvelope, socketPos, templateFromId, frameFamily, type Socket, type SocketSide, type OverflowPart, type VehicleChassis } from './mapping';
export { liveryFromId, placeTemplate, seatTopOf, setVehicleWidth, vehicleWidth, VEHICLE_WIDTHS, wheelRadius, buildSections, bodyColumns, layoutBodyRect, type Layout, type Livery, type RowInfo, type Section, type SideWall, type WheelInfo, type DoorInfo, type VehicleWidth } from './layout';

/**
 * The vehicle's chassis mapping, kept current: mapped on first use (and whenever its part list
 * changed) onto `v.template`, which is picked then and kept. A saved template whose envelope
 * the grid no longer fits (the BN data changed under a save) is re-picked, and says so.
 */
export function chassisOf(v: Vehicle): VehicleChassis {
  const c = v.chassis;
  if (c && c.template === v.template && c.partCount === v.parts.length) return c;
  let why: string | undefined;
  if (v.template && !fitsEnvelope(v, TEMPLATES[v.template])) {
    const pick = pickTemplate(v);
    why = `saved ${v.template} no longer fits, ${pick.template}`;
    v.template = pick.template;
  }
  const mapped = v.template ? mapChassis(v, v.template, why ?? 'saved') : mapChassis(v);
  v.template = mapped.template;
  v.chassis = mapped;
  return mapped;
}

const layouts = new WeakMap<Vehicle, { version: number; epoch: number; template: TemplateId; n: number; L: Layout }>();

/**
 * `v`'s template placed on its grid: the body the renderer draws and collision uses. Cached
 * per vehicle until it changes (version: doors, damage), the width mode or its template does.
 */
export function layoutOf(v: Vehicle): Layout {
  const ch = chassisOf(v);
  const c = layouts.get(v);
  if (c && c.version === v.version && c.epoch === widthEpoch && c.template === ch.template && c.n === v.parts.length) return c.L;
  const L = placeTemplate(v, templateOf(ch.template));
  layouts.set(v, { version: v.version, epoch: widthEpoch, template: ch.template, n: v.parts.length, L });
  return L;
}

/** The collision outline (mount space), or null: frame templates collide with their cells. */
export function chassisBodyRect(v: Vehicle): BodyRect | null {
  return layoutBodyRect(layoutOf(v));
}

export interface ChassisSeat {
  part: VehiclePart;
  /** The BN cell (crash, seatbelt and cargo still resolve through it). */
  mx: number;
  my: number;
  /** Drawn position in mount space (x along the vehicle, y across): inside the cell. */
  x: number;
  y: number;
  /** Cushion top above the vehicle's floor level (z-level floor), m. */
  h: number;
  /** The controls are on this seat's cell. */
  driver: boolean;
  bed: boolean;
  socket: Socket;
}

/** Every seat (SEAT or BED part) with where it's drawn: for riders, boarding and the camera. */
export function chassisSeats(v: Vehicle): ChassisSeat[] {
  const ch = chassisOf(v);
  const L = layoutOf(v);
  const h = seatTopOf(L);
  const ctrl = v.controls();
  const out: ChassisSeat[] = [];
  for (const p of v.parts) {
    if (!has(p, 'SEAT') && !has(p, 'BED')) continue;
    const s = ch.socketOf.get(p);
    if (!s) continue;
    const [x, y] = L.family === 'frame' ? [p.mx, p.my] : [L.xOf(p.mx), L.zOf(p.my)];
    out.push({ part: p, mx: p.mx, my: p.my, x, y, h, driver: !!ctrl && ctrl.mx === p.mx && ctrl.my === p.my, bed: has(p, 'BED'), socket: s });
  }
  return out;
}

/** Where a seat at mount (mx, my) is drawn (mount space), or the cell centre when there's no seat there. */
export function seatPoint(v: Vehicle, mx: number, my: number): [number, number] {
  const s = chassisSeats(v).find((q) => q.mx === mx && q.my === my);
  return s ? [s.x, s.y] : [mx, my];
}

/**
 * The BN cell that takes a hit at body point (lx, ly) (mount space): the side of the outline
 * the point is on picks that side's panel sockets, the nearest one along the side wins (a
 * front-quarter hit dents the front door, not the seat behind it). Frame templates, and points
 * with no panel on that side, fall back to the nearest cell.
 */
export function hitMount(v: Vehicle, lx: number, ly: number): [number, number] {
  const L = layoutOf(v);
  const ch = chassisOf(v);
  const b = layoutBodyRect(L);
  if (b) {
    const d = { front: Math.abs(b.x1 - lx), rear: Math.abs(lx - b.x0), left: Math.abs(ly - b.y0), right: Math.abs(b.y1 - ly) };
    const side = (Object.keys(d) as (keyof typeof d)[]).reduce((a, k) => (d[k] < d[a] ? k : a), 'front');
    let best: Socket | null = null, bd = Infinity;
    for (const s of ch.sockets) {
      if (s.kind !== 'panel' || s.side !== side) continue;
      const [sx, sy] = socketPos(L, s);
      const dd = (sx - lx) ** 2 + (sy - ly) ** 2;
      if (dd < bd) (bd = dd), (best = s);
    }
    if (best) return [best.mx, best.my];
  }
  return nearestCell(v, lx, ly);
}

/**
 * The BN cell under mount-space point (lx, ly) on the body (the crosshair on the paint): the
 * cell containing it, else the nearest one (the paint of a narrow body can sit over a cell
 * the grid leaves empty, e.g. a rounded corner).
 */
export function cellAtPoint(v: Vehicle, lx: number, ly: number): [number, number] {
  const mx = Math.round(lx), my = Math.round(ly);
  return v.hasMount(mx, my) ? [mx, my] : nearestCell(v, lx, ly);
}

/** The cell of `v` nearest mount-space point (lx, ly) (vehicleShape.nearestMount's rule). */
function nearestCell(v: Vehicle, lx: number, ly: number): [number, number] {
  let best: [number, number] = [0, 0], bd = Infinity;
  for (const p of v.parts) {
    const dx = Math.max(0, Math.abs(lx - p.mx) - 0.5), dy = Math.max(0, Math.abs(ly - p.my) - 0.5);
    const d = dx * dx + dy * dy + 1e-3 * ((lx - p.mx) ** 2 + (ly - p.my) ** 2);
    if (d < bd) (bd = d), (best = [p.mx, p.my]);
  }
  if (bd === Infinity) throw new Error(`hitMount: the ${v.name} has no parts`);
  return best;
}

/** Nose of the body along the vehicle (mount x): headlights and "ahead of the vehicle". */
export function noseX(v: Vehicle): number {
  const L = layoutOf(v);
  return L.family === 'frame' ? L.xMax + 0.5 : L.xNose;
}

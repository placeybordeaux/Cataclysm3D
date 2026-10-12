import { LEVEL_HEIGHT } from '../world/coords';
import { has, type Vehicle, type VehiclePart } from './vehicle';
import { chassisBodyRect, chassisOf, chassisSeats, layoutOf } from './chassis';
import type { VehicleSystem } from './vehicles';

// Being *inside* a vehicle (docs/VEHICLES.md "Inside vehicles"). On foot the player walks the
// vehicle's cells like any floor, at BN's move costs: every seat / board cell costs 8 (400
// moves, 4x flat ground), the eye stays at the road's eye height whatever the drawn floor,
// and nothing knows what a seat is. In real time that reads as floating slowly through the
// car. So inside a vehicle you don't free-walk any more; what you get depends on the vehicle:
//
//  - 'wheel'  cars, pickups, bikes: you're at the wheel or outside. Getting in takes the
//             controls (or, walking in an open door, the nearest seat); `e` gets out.
//  - 'deck'   RVs, buses, vans with a walkable aisle: a coherent interior of *stations*
//             (driver's seat, seats, beds, aisle spots, doors). W/A/S/D hop to the next station
//             that way with a short animated step; doors are where you get out.
//  - 'crew'   armoured hulls (tanks, APCs): crew stations only (driver, gunner / commander
//             seats, hatches), no deck to stand on; you leave through a hatch.
//
// Which one a vehicle gets comes from its data (chassis template, armour, aisle cells), never
// its id. Options > Inside vehicles / `?vehwalk=` switch between this ('stations', default),
// 'allstations' (cars hop seat to seat too) and the old free walk ('free').

export type VehWalkMode = 'stations' | 'allstations' | 'free';
export const VEHWALK_MODES: VehWalkMode[] = ['stations', 'allstations', 'free'];
export const VEHWALK_DESC: Record<VehWalkMode, string> = {
  stations: 'cars: at the wheel or outside; RVs, buses, tanks: move between seats, aisle spots, doors and hatches',
  allstations: 'as stations, but cars and pickups also hop between their seats',
  free: 'the old free walk through the cells at BN move costs',
};
export function isVehWalkMode(m: unknown): m is VehWalkMode {
  return typeof m === 'string' && (VEHWALK_MODES as string[]).includes(m);
}

export type CabinKind = 'wheel' | 'deck' | 'crew';
export type StationKind = 'driver' | 'gunner' | 'seat' | 'bed' | 'deck' | 'door' | 'hatch';
/** How the body is held there: the camera's eye height follows it (render/vehicleMesh.ts). */
export type Posture = 'seated' | 'standing' | 'hatch';

export interface Station {
  kind: StationKind;
  posture: Posture;
  /** The BN cell (cargo, examine, doors resolve through it). */
  mx: number;
  my: number;
  /** Where you are in mount space: the drawn seat, or the cell inside the drawn body. */
  x: number;
  y: number;
  /** A turret (or its mount) is on this cell: `e` there mans the gun (src/turrets.ts). */
  turret: boolean;
  /** The door / hatch you leave by (door and hatch stations). */
  door: VehiclePart | null;
  /**
   * Outside doors right beside this station (the driver's door by the driver's seat, the bus
   * door by its front aisle spot): a step toward one gets you out through it.
   * `out` is the way through it, outward (mount space, unit).
   */
  exits: { door: VehiclePart; out: [number, number] }[];
}

/** Armoured hulls on a frame template (what render/vehicleTank.ts draws as a tank / APC hull). */
const HULL_TEMPLATES = new Set(['frame_tracked', 'frame_air', 'frame_boat']);
/** An aisle this long or longer is a deck you can stand on (car 0, humvee 1, cube van 3, RV 7, bus 12). */
const DECK_AISLES = 3;
/** An outside door this close (m) to a station is that station's way out (no door station of its own). */
const EXIT_REACH = 0.75;

/** A door or hatch you can climb through (BN OPENABLE in the cell's centre; not curtains / shutters on windows). */
function isDoor(p: VehiclePart): boolean {
  return has(p, 'OPENABLE') && !has(p, 'CURTAIN') && p.def.location === 'center';
}

function cells(v: Vehicle): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const p of v.parts) {
    const k = `${p.mx},${p.my}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push([p.mx, p.my]);
    }
  }
  return out;
}

/** Which interior model `v` gets (see the header). From the data, never the prototype id. */
export function cabinKind(v: Vehicle): CabinKind {
  const all = cells(v);
  // Same rule as render/vehicleTank.ts armourHull: plated over most of its cells on a frame hull.
  const armoured = all.filter(([mx, my]) => v.partsAt(mx, my).some((p) => p.def.location === 'armor')).length;
  if (HULL_TEMPLATES.has(chassisOf(v).template) && armoured >= 12 && armoured >= all.length * 0.5) return 'crew';
  const aisles = all.filter(([mx, my]) => v.partsAt(mx, my).some((p) => p.hp > 0 && has(p, 'AISLE'))).length;
  return aisles >= DECK_AISLES ? 'deck' : 'wheel';
}

const stationCache = new WeakMap<Vehicle, { key: string; list: Station[] }>();

/** The stations of `v` for its cabin kind (cached until the vehicle changes). */
export function stationsOf(v: Vehicle, cabin: CabinKind = cabinKind(v)): Station[] {
  const key = `${v.version}:${v.parts.length}:${cabin}`;
  const c = stationCache.get(v);
  if (c && c.key === key) return c.list;
  const list = buildStations(v, cabin);
  stationCache.set(v, { key, list });
  return list;
}

function buildStations(v: Vehicle, cabin: CabinKind): Station[] {
  const L = layoutOf(v);
  const body = chassisBodyRect(v);
  // A point inside the drawn body (playerOn and riding along both need you inside it).
  const inside = (x: number, y: number, m = 0.25): [number, number] => {
    if (!body) return [x, y];
    return [Math.max(body.x0 + m, Math.min(body.x1 - m, x)), Math.max(body.y0 + m, Math.min(body.y1 - m, y))];
  };
  const cellPt = (mx: number, my: number, m?: number): [number, number] => {
    const [x, y] = L.family === 'frame' ? [mx, my] : [L.xOf(mx), L.zOf(my)];
    return inside(x, y, m);
  };
  const turretAt = (mx: number, my: number) => v.partsAt(mx, my).some((p) => has(p, 'TURRET') || has(p, 'TURRET_MOUNT'));
  const out: Station[] = [];
  const used = new Set<string>();
  const add = (s: Station) => {
    const k = `${s.mx},${s.my}`;
    if (used.has(k)) return;
    used.add(k);
    out.push(s);
  };
  // Seats (driver's first: it's where the controls are).
  const seats = chassisSeats(v).sort((a, b) => Number(b.driver) - Number(a.driver));
  for (const s of seats) {
    if (s.part.hp <= 0) continue;
    const seat = has(s.part, 'SEAT') || v.partsAt(s.mx, s.my).some((p) => has(p, 'SEAT') && p.hp > 0);
    // Beds count in a deck (the RV's bunks); a car's reclining seats are just seats.
    if (!seat && cabin !== 'deck') continue;
    const turret = turretAt(s.mx, s.my);
    const kind: StationKind = s.driver ? 'driver' : !seat ? 'bed' : turret ? 'gunner' : 'seat';
    // A main gun's gunner looks through a sight beside the gun (the M1's is on its left), not
    // from straight above the barrel, which would hide whatever it's laid on.
    const mainGun = kind === 'gunner' && v.partsAt(s.mx, s.my).some((p) => has(p, 'TURRET') && p.def.weight >= 80_000);
    add({ kind, posture: 'seated', mx: s.mx, my: s.my, ...xy(inside(s.x, mainGun ? s.y - 0.7 : s.y)), turret, door: null, exits: [] });
  }
  if (cabin === 'wheel') return out;
  // A deck's floor: one spot per aisle cell.
  if (cabin === 'deck') {
    for (const [mx, my] of cells(v)) {
      if (!v.partsAt(mx, my).some((p) => p.hp > 0 && has(p, 'AISLE'))) continue;
      add({ kind: 'deck', posture: 'standing', mx, my, ...xy(cellPt(mx, my)), turret: false, door: null, exits: [] });
    }
  }
  // A hull's hatches (on its roof, among other cells): stations where you turn out, then leave.
  if (cabin === 'crew') {
    for (const p of v.parts) {
      if (!isDoor(p) || p.hp <= 0) continue;
      add({ kind: 'hatch', posture: 'hatch', mx: p.mx, my: p.my, ...xy(cellPt(p.mx, p.my)), turret: false, door: p, exits: [] });
    }
    return out;
  }
  // A deck's outside doors (a cell with a neighbour off the grid: the RV's door_internal between
  // cab and living space is just a way through). The drawn body squeezes a side door's column
  // into the wall, so most doors are right beside a seat or an aisle spot: that station gets the
  // door as its exit. A door with no station next to it is a station of its own (standing in it).
  const inner = out.slice();
  for (const p of v.parts) {
    if (!isDoor(p) || p.hp <= 0) continue;
    const off = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => !v.hasMount(p.mx + dx, p.my + dy));
    if (!off) continue;
    const [dx, dy] = cellPt(p.mx, p.my, 0.1);
    const near = inner.map((q) => [q, Math.hypot(q.x - dx, q.y - dy)] as const).sort((a, b) => a[1] - b[1])[0];
    const exit = { door: p, out: [off[0], off[1]] as [number, number] };
    if (near && near[1] < EXIT_REACH) near[0].exits.push(exit);
    else add({ kind: 'door', posture: 'standing', mx: p.mx, my: p.my, x: dx, y: dy, turret: false, door: p, exits: [exit] });
  }
  return out;
}

function xy([x, y]: [number, number]): { x: number; y: number } {
  return { x, y };
}

/** The gun on a station's cell (heaviest first), if any. */
function gunAt(v: Vehicle, s: Station): VehiclePart | undefined {
  return v.partsAt(s.mx, s.my).filter((p) => has(p, 'TURRET')).sort((a, b) => b.def.weight - a.def.weight)[0];
}

/**
 * Crew roles for an armoured hull, the way a tank crew is named: the seat with the heaviest
 * gun is the Gunner, the next the Commander, the rest Loaders; a hatch belongs to the crew
 * station nearest it ("Commander's hatch"). BN has none of this (its seats are just seats on
 * turret cells): it's here so you can tell where you are.
 */
function crewRoles(v: Vehicle, list: Station[]): Map<Station, string> {
  const roles = new Map<Station, string>();
  const guns = list.filter((s) => s.kind === 'gunner').sort((a, b) => (gunAt(v, b)?.def.weight ?? 0) - (gunAt(v, a)?.def.weight ?? 0));
  const names = guns.length === 1 ? ['Gunner'] : ['Gunner', 'Commander'];
  guns.forEach((s, i) => roles.set(s, names[i] ?? 'Loader'));
  for (const s of list) {
    if (s.kind === 'driver') roles.set(s, 'Driver');
    else if (s.kind === 'seat') roles.set(s, 'Passenger');
  }
  const owner = new Map<Station, Station | null>();
  for (const s of list) {
    if (s.kind !== 'hatch') continue;
    const near = list.filter((q) => q.kind !== 'hatch').sort((a, b) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(b.x - s.x, b.y - s.y))[0];
    owner.set(s, near && Math.hypot(near.x - s.x, near.y - s.y) < 2.5 ? near : null);
  }
  for (const [s, o] of owner) {
    const base = o ? `${roles.get(o)}'s hatch` : 'Hatch';
    // Two hatches by one station (the Abrams driver has two): say which side it's on.
    const twins = [...owner].filter(([, q]) => q === o).length > 1;
    const dx = o ? s.x - o.x : s.x, dy = o ? s.y - o.y : s.y;
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'ahead' : 'behind') : dy > 0 ? 'right' : 'left';
    roles.set(s, twins ? `${base} (${side})` : base);
  }
  return roles;
}

/** What a station is, for the HUD: a short role name and what you do there. */
export function stationRole(v: Vehicle, s: Station, list: Station[]): { title: string; detail: string } {
  const crew = list.some((q) => q.kind === 'hatch') && !list.some((q) => q.kind === 'deck' || q.kind === 'door');
  if (crew) {
    const role = crewRoles(v, list).get(s) ?? 'Crew seat';
    const gun = gunAt(v, s);
    if (s.kind === 'driver') return { title: role, detail: 'drives the vehicle' };
    if (s.kind === 'gunner') return { title: gun ? `${role} (${gun.def.name})` : role, detail: gun ? 'mans the gun' : 'a turret seat (no gun mounted)' };
    if (s.kind === 'hatch') return { title: role, detail: 'head out of the hatch; climb out from here' };
    return { title: role, detail: 'a seat inside the hull' };
  }
  switch (s.kind) {
    case 'driver': return { title: "Driver's seat", detail: 'drive from here' };
    case 'gunner': { const gun = gunAt(v, s); return { title: gun ? `Gunner (${gun.def.name})` : 'Turret seat', detail: gun ? 'mans the gun' : 'no gun mounted' }; }
    case 'bed': return { title: cap(stationName(v, s).replace(/^the /, '')), detail: 'lie down to sleep' };
    case 'deck': return { title: 'Aisle', detail: 'standing room' };
    case 'door': return { title: cap(stationName(v, s).replace(/^the /, '')), detail: 'the way out' };
    default: return { title: cap(stationName(v, s).replace(/^the /, '')), detail: s.exits.length ? 'a seat by the door' : 'a seat' };
  }
}

/** Human names for the prompt. */
export function stationName(v: Vehicle, s: Station): string {
  // Crew vehicles: the crew role ("the Commander's hatch"), so you know which hatch it is.
  if (cabinKind(v) === 'crew') {
    const list = stationsOf(v, 'crew');
    if (list.includes(s)) return `the ${stationRole(v, s, list).title}`;
  }
  switch (s.kind) {
    case 'driver':
      return "the driver's seat";
    case 'gunner': {
      const gun = v.partsAt(s.mx, s.my).find((p) => has(p, 'TURRET'));
      return gun ? `the ${gun.def.name}` : 'the turret seat';
    }
    case 'bed':
      return `the ${v.partsAt(s.mx, s.my).find((p) => has(p, 'BED'))?.def.name ?? 'bed'}`;
    case 'deck':
      return 'the aisle';
    case 'door':
    case 'hatch':
      return `the ${s.door?.def.name ?? s.kind}`;
    default:
      return `the ${v.partsAt(s.mx, s.my).find((p) => has(p, 'SEAT'))?.def.name ?? 'seat'}`;
  }
}

/**
 * Extra things to do at a station (src/turrets.ts: a gunner station returns { label: 'Man the
 * 120mm tank gun', run }). First non-null wins over the station's own `e`.
 */
export const stationActions: ((vs: VehicleSystem, v: Vehicle, s: Station) => { label: string; run: () => string | null } | null)[] = [];

/**
 * The eye at a station (absolute metres) without a renderer (tests, the sim, before the model
 * is built): the same postures as render/vehicleMesh.ts stationEye with typical drawn heights
 * (a car seat 0.55 m deck + 0.75; the M1's 1.45 m deck, 2.35 m turret roof, driver head-out
 * at 1.8 m). The renderer's exact value (rig.stationEye) wins when there is one.
 */
export function stationEyeEstimate(view: StationView): number {
  const crew = view.cabin === 'crew';
  const deck = crew ? 1.45 : 0.55, turretTop = 2.35;
  const s = view.station;
  let h: number;
  if (s.posture === 'hatch') h = turretTop + 0.9;
  else if (crew) h = s.turret ? turretTop + 0.75 : deck + 0.35;
  else if (s.posture === 'standing') h = deck + 1.6;
  else if (s.kind === 'bed') h = deck + 0.6;
  else h = deck + 0.75;
  return view.v.z * LEVEL_HEIGHT + h;
}

/** Movement keys as (right, forward) steps. */
const MOVE_KEYS: Record<string, [number, number]> = { KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };

/** Seconds a hop takes: a step or two at walking pace, never a teleport nor a crawl. */
const HOP_MIN = 0.22;
const HOP_MAX = 0.8;
/** Steps from one station to the next pick the nearest within this angle of the key's direction. */
const HOP_CONE = Math.cos((60 * Math.PI) / 180);

export interface StationView {
  v: Vehicle;
  cabin: CabinKind;
  station: Station;
  /** While hopping: where from, and how far along (0..1). */
  from: Station | null;
  t: number;
}

/**
 * The player at a vehicle's stations (VehicleSystem.stations). Holds movement while you're at
 * one (VehicleSystem's movementOverride), reads W/A/S/D itself for hops, and keeps you on the
 * station as the vehicle moves.
 */
export class VehicleStations {
  mode: VehWalkMode = 'stations';
  /** Where you are (null = not at a station: on foot, or driving). */
  at: { v: Vehicle; i: number } | null = null;
  private hop: { from: Station; to: number; t: number; dur: number } | null = null;
  /** Inside a vehicle last tick (walking in through a door boards; being there already doesn't). */
  private wasIn: Vehicle | null = null;
  /** A held direction that found nowhere to go: not retried every tick until the keys change. */
  private blockedDir = '';
  private hinted = false;
  /**
   * Movement keys pressed since the last tick. A quick tap can go down and up between two
   * ticks (a slow frame), so the held set alone would miss it: every press is one hop.
   */
  private presses: string[] = [];
  private listening = false;

  constructor(private readonly vs: VehicleSystem) {}

  /** The vehicle's interior model in the current mode, or null = free walk. */
  cabin(v: Vehicle): CabinKind | null {
    if (this.mode === 'free') return null;
    const c = cabinKind(v);
    return c === 'wheel' && this.mode === 'allstations' ? 'deck' : c;
  }

  stations(v: Vehicle): Station[] {
    const c = this.cabin(v);
    // allstations: a car's seats as a 'deck' (no aisle, so just its seats and doors)
    return c ? stationsOf(v, c) : [];
  }

  current(): Station | null {
    return this.at ? this.stations(this.at.v)[this.at.i] ?? null : null;
  }

  view(): StationView | null {
    const s = this.current();
    if (!this.at || !s) return null;
    return { v: this.at.v, cabin: this.cabin(this.at.v)!, station: s, from: this.hop?.from ?? null, t: this.hop ? Math.min(1, this.hop.t / this.hop.dur) : 1 };
  }

  enter(v: Vehicle, i: number): void {
    // A missing vehicle or station would otherwise error every frame (cells(null)) from the HUD and aim code.
    if (!v || !this.stations(v)[i]) throw new Error(`VehicleStations.enter: no station ${i} on ${v?.protoId ?? v}`);
    this.at = { v, i };
    this.hop = null;
    this.hinted = false;
    this.vs.claimMovement();
    this.place();
  }

  leave(): void {
    this.at = null;
    this.hop = null;
  }

  /** Index of the station of `v` nearest world (x, y) (optionally of some kinds). */
  nearest(v: Vehicle, x: number, y: number, kinds?: StationKind[]): number {
    const [lx, ly] = v.worldToMount(x, y);
    let best = -1, bd = Infinity;
    this.stations(v).forEach((s, i) => {
      if (kinds && !kinds.includes(s.kind)) return;
      const d = Math.hypot(s.x - lx, s.y - ly);
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  }

  /** At the wheel -> at the driver's station (deck / crew vehicles keep you inside). */
  seatDriver(v: Vehicle): boolean {
    const i = this.stations(v).findIndex((s) => s.kind === 'driver');
    if (i < 0) return false;
    this.enter(v, i);
    return true;
  }

  update(dt: number): void {
    const g = this.vs.game;
    const p = g.player;
    if (!this.listening) {
      this.listening = true;
      g.input.onPress((e) => {
        if (this.at && !e.repeat && MOVE_KEYS[e.code]) this.presses.push(e.code);
      });
    }
    if (!this.at) this.presses.length = 0;
    if (this.mode === 'free' || p.dead) {
      this.leave();
      this.wasIn = null;
      return;
    }
    if (this.vs.driving) {
      this.leave();
      this.wasIn = this.vs.driving;
      return;
    }
    if (this.at && (!this.vs.list.includes(this.at.v) || this.at.v.z !== p.z || !this.current())) {
      // the vehicle was removed / changed under you: re-find the nearest station or stand down
      const v = this.at.v;
      this.leave();
      if (this.vs.list.includes(v) && v.z === p.z) {
        const i = this.nearest(v, p.x, p.y);
        if (i >= 0) this.enter(v, i);
      }
    }
    if (!this.at) {
      const on = this.vs.playerOn();
      const v = on?.v ?? null;
      const boarding = !!v && this.wasIn !== v;
      this.wasIn = v;
      if (!v || !this.cabin(v)) return;
      const i = this.nearest(v, p.x, p.y);
      if (i < 0) return;
      const s = this.stations(v)[i];
      // Walking in an open car door: straight to the wheel when that's the seat you reach.
      if (boarding && this.cabin(v) === 'wheel' && s.kind === 'driver' && this.vs.getInReason(v) === null && v.controls()?.hp) {
        const r = this.vs.takeControls(v);
        g.message(r.msg);
        if (r.ok) return;
      }
      this.enter(v, i);
      if (boarding) g.message(`You get into the ${v.name}: ${stationName(v, s)}.`, 'c_light_gray');
      return;
    }
    this.wasIn = this.at.v;
    if (this.hop) {
      this.hop.t += dt;
      if (this.hop.t >= this.hop.dur) this.hop = null;
    }
    this.readKeys();
    this.place();
  }

  /**
   * Where a hop toward world direction (wx, wy) would go, without going: another station, out
   * through a door beside you, or nowhere. The HUD's key hints use this.
   */
  pickHop(wx: number, wy: number): { to: number } | { exit: VehiclePart } | null {
    const at = this.at;
    const cur = this.current();
    if (!at || !cur) return null;
    const v = at.v;
    const list = this.stations(v);
    const reach = this.cabin(v) === 'deck' ? reachable(v, cur.mx, cur.my) : null;
    // direction in mount space (the vehicle may be turned)
    const [ox, oy] = v.worldToMount(0, 0), [dx1, dy1] = v.worldToMount(wx, wy);
    const mx = dx1 - ox, my = dy1 - oy;
    let best = -1, score = Infinity;
    list.forEach((s, i) => {
      if (i === at.i) return;
      if (reach && !reach.has(`${s.mx},${s.my}`)) return;
      const ex = s.x - cur.x, ey = s.y - cur.y, d = Math.hypot(ex, ey);
      if (d < 1e-3) return;
      const cos = (ex * mx + ey * my) / d;
      if (cos < HOP_CONE) return;
      const sc = d * (1 + 2 * (1 - cos));
      if (sc < score) (score = sc), (best = i);
    });
    // A door right beside you that way: step out through it (preferred when it's dead ahead).
    let exit: VehiclePart | null = null, exitCos = HOP_CONE;
    for (const e of cur.exits) {
      const cos = (e.out[0] * mx + e.out[1] * my) / (Math.hypot(...e.out) * Math.hypot(mx, my) || 1);
      if (cos >= exitCos) (exitCos = cos), (exit = e.door);
    }
    if (exit && (best < 0 || exitCos > 0.9)) return { exit };
    return best < 0 ? null : { to: best };
  }

  /** Hop toward world direction (wx, wy) (unit). Returns false when there's nowhere that way. */
  hopToward(wx: number, wy: number): boolean {
    const at = this.at;
    const cur = this.current();
    const pick = this.pickHop(wx, wy);
    if (!at || !cur || !pick) return false;
    if ('exit' in pick) {
      const msg = this.getOut(pick.exit);
      if (msg) this.vs.game.message(msg);
      return true;
    }
    const best = pick.to;
    const list = this.stations(at.v);
    const to = list[best];
    const p = this.vs.game.player;
    const dist = Math.hypot(to.x - cur.x, to.y - cur.y);
    const pace = Math.max(0.8, p.moveSpeed(100));
    this.hop = { from: cur, to: best, t: 0, dur: Math.max(HOP_MIN, Math.min(HOP_MAX, dist / pace)) };
    at.i = best;
    // stamina and aim as a walk of that length (BN: you did cross those cells)
    p.onMoved(dist, 100);
    return true;
  }

  /** Screen-relative key direction (fx right, fy forward) -> world unit vector, by where you look. */
  keyDir(fx: number, fy: number): [number, number] {
    const p = this.vs.game.player;
    const len = Math.hypot(fx, fy) || 1;
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    return [(fy * sin + fx * cos) / len, (-fy * cos + fx * sin) / len];
  }

  /** For the HUD: where W, A, S and D would take you from here, as you're looking now. */
  keyTargets(): { key: 'W' | 'A' | 'S' | 'D'; to: number | 'out' }[] {
    const out: { key: 'W' | 'A' | 'S' | 'D'; to: number | 'out' }[] = [];
    for (const [key, code] of [['W', 'KeyW'], ['A', 'KeyA'], ['S', 'KeyS'], ['D', 'KeyD']] as const) {
      const [fx, fy] = MOVE_KEYS[code];
      const pick = this.pickHop(...this.keyDir(fx, fy));
      if (pick) out.push({ key, to: 'exit' in pick ? 'out' : pick.to });
    }
    return out;
  }

  /** W/A/S/D: one hop per press; held, the next as soon as the last one lands. */
  private readKeys(): void {
    const g = this.vs.game;
    if (g.input.captured && !g.input.menuWalk) return;
    const k = g.input.held;
    let fx = 0, fy = 0;
    // a fresh press (even one already let go) first, else what's held (hops repeat while held)
    const pressed = this.hop ? undefined : this.presses.shift();
    if (pressed) [fx, fy] = MOVE_KEYS[pressed];
    else {
      if (k.has('KeyW')) fy += 1;
      if (k.has('KeyS')) fy -= 1;
      if (k.has('KeyD')) fx += 1;
      if (k.has('KeyA')) fx -= 1;
    }
    const dir = `${fx},${fy}`;
    if (!fx && !fy) {
      this.blockedDir = '';
      return;
    }
    if (this.hop || (!pressed && dir === this.blockedDir)) return;
    const v = this.at!.v;
    if (this.cabin(v) === 'wheel') {
      // Cars have no inside to walk: say how to get out (once per sitting).
      if (!this.hinted) {
        this.hinted = true;
        const e = g.keys.keyFor('interact'), c = g.keys.keyFor('control_vehicle');
        g.message(`You're sitting in the ${v.name}. [${e}] get out, [${c}] take the wheel.`, 'c_light_gray');
      }
      return;
    }
    const [wx, wy] = this.keyDir(fx, fy);
    const moved = this.hopToward(wx, wy);
    this.blockedDir = moved ? '' : dir;
  }

  /** Put the player on the station (mid-hop: between the two). */
  private place(): void {
    const at = this.at, s = this.current();
    if (!at || !s) return;
    let x = s.x, y = s.y;
    if (this.hop) {
      const t = Math.min(1, this.hop.t / this.hop.dur);
      const e = t * t * (3 - 2 * t);
      x = this.hop.from.x + (s.x - this.hop.from.x) * e;
      y = this.hop.from.y + (s.y - this.hop.from.y) * e;
    }
    const p = this.vs.game.player;
    [p.x, p.y] = at.v.mountToWorld(x, y);
    p.z = at.v.z;
  }

  /**
   * `e` at the station: the registered action (man the turret), else drive at the driver's
   * seat, get out at a door / hatch or anywhere in a car. Returns null when `e` should fall
   * through to the crosshair (examining a seat's cargo from an aisle spot).
   */
  action(): { label: string; run: () => string | null } | null {
    const at = this.at, s = this.current();
    if (!at || !s) return null;
    const v = at.v;
    for (const f of stationActions) {
      const a = f(this.vs, v, s);
      if (a) return a;
    }
    if (s.kind === 'driver' && this.cabin(v) !== 'wheel')
      return { label: `Drive the ${v.name}`, run: () => {
        const r = this.vs.takeControls(v);
        return r.msg;
      } };
    if (s.kind === 'door' || s.kind === 'hatch' || s.exits.length || this.cabin(v) === 'wheel')
      return { label: s.kind === 'hatch' ? `Climb out of the ${v.name}` : `Get out of the ${v.name}`, run: () => this.getOut() };
    return null;
  }

  /** Leave the vehicle from where you are: through your door / hatch, else the nearest one. */
  getOut(through?: VehiclePart): string | null {
    const at = this.at, s = this.current();
    if (!at || !s) return null;
    const v = at.v;
    if (Math.abs(v.velocity) > 1) return `Not while the ${v.name} is moving.`;
    const g = this.vs.game, p = g.player;
    // A car door: the tested climb-out (walks to the nearest door, opens it, steps outside).
    if (!s.door && !s.exits.length && !through) {
      const msg = this.vs.climbOut(v);
      if (msg) {
        this.leave();
        this.wasIn = null;
        return msg;
      }
    }
    // Doors / hatches (and doorless vehicles: bikes, open frames): the nearest free tile
    // outside the vehicle near the way out (a hatch on a hull roof can be 2 tiles from the road).
    const doors = through ? [through] : s.door ? [s.door] : s.exits.length ? s.exits.map((e) => e.door) : v.parts.filter((q) => isDoor(q) && q.hp > 0);
    const from = doors.length ? doors.sort((a, b) => Math.hypot(a.mx - s.mx, a.my - s.my) - Math.hypot(b.mx - s.mx, b.my - s.my))[0] : null;
    const [ox, oy] = v.mountToWorld(from ? from.mx : s.mx, from ? from.my : s.my);
    const tx = Math.floor(ox), ty = Math.floor(oy);
    let best: [number, number] | null = null, bd = Infinity;
    for (let r = 1; r <= 4 && !best; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx, y = ty + dy;
          if (this.vs.at(x, y, p.z) || !g.map.passable(x, y, p.z)) continue;
          const d = Math.hypot(x + 0.5 - ox, y + 0.5 - oy);
          if (d < bd) (bd = d), (best = [x, y]);
        }
    if (!best) return `There's no room to get out of the ${v.name} here.`;
    const opened = from && !from.open ? this.vs.toggleDoor(v, from.mx, from.my) : null;
    this.leave();
    this.wasIn = null;
    p.x = best[0] + 0.5;
    p.y = best[1] + 0.5;
    const how = s.kind === 'hatch' ? `climb out of the ${from?.def.name ?? 'hatch'} and down off the ${v.name}` : `climb out of the ${v.name}`;
    return opened ? `${opened.replace(/\.$/, '')} and ${how}.` : `You ${how}.`;
  }

  /** The prompt line at a station (null = not at one). */
  prompt(interactKey: string): string | null {
    const at = this.at, s = this.current();
    if (!at || !s) return null;
    const a = this.action();
    const move = this.cabin(at.v) === 'wheel' ? '' : s.exits.length && s.kind === 'driver' ? '  [W/A/S/D] move (toward the door: out)' : '  [W/A/S/D] move';
    const role = stationRole(at.v, s, this.stations(at.v));
    return `${role.title}: ${role.detail}${a ? `  [${interactKey}] ${a.label}` : ''}${move}`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Cells you can get to from (mx, my) inside `v` without going outside: BN's walkable cells
 * (move cost > 0) plus doors (you open them on the way). 4-neighbour.
 */
export function reachable(v: Vehicle, mx: number, my: number): Set<string> {
  const ok = (x: number, y: number) => v.hasMount(x, y) && (v.moveCostAt(x, y) > 0 || v.partsAt(x, y).some(isDoor));
  const seen = new Set<string>([`${mx},${my}`]);
  const queue: [number, number][] = [[mx, my]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y + dy}`;
      if (seen.has(k) || !ok(x + dx, y + dy)) continue;
      seen.add(k);
      queue.push([x + dx, y + dy]);
    }
  }
  return seen;
}

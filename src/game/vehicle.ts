import type { Rng } from '../core/rng';
import type { GameData } from '../data/types';
import { expandItemGroup } from '../data/itemgroups';
import { warnOnce } from '../data/warn';
import { createItem, fromSpawned, Item, type ItemJSON } from './item';
import { L, spawnItem } from './moves';
import type { VehicleDataFile, VPartDef } from './vehicle_data';
import type { VehicleChassis } from './chassis/mapping';
import { CHASSIS_VERSION, TEMPLATES, type TemplateId } from './chassis/templates';

// A CDDA vehicle: parts installed on a grid of mount points, placed in the world at a
// position + facing. Pure simulation (no map, DOM or three.js): the VehicleSystem
// (src/game/vehicles.ts) moves vehicles through the map and resolves collisions.
//
// Coordinates:
//   mount (mx, my)  CDDA mount grid: +x = forward, +y = the vehicle's right side; the
//                   driver's seat is normally (0, 0).
//   world (x, y)    tiles, x east, y south. `vehicle.x/y` is the centre of mount (0,0).
//   facing          degrees, CDDA convention: 0 = east, 90 = south (clockwise).
//
// CDDA itself snaps rotated vehicles onto the tile grid with a Bresenham "tileray" shear
// (vehicle::precalc_mounts). We render vehicles as real rotated 3D meshes, so occupancy is
// computed the other way round: a world tile belongs to the mount its centre falls into in
// the vehicle's local frame. At multiples of 90 deg both agree exactly; at other angles
// this matches what is drawn (and a 1-tile-thick body still has no diagonal leaks for a
// round creature, see physics.ts).

/** Physics constants (vehicle.cpp). */
export const AIR_DENSITY = 1.29;
export const ACCEL_G = 9.8;
export const MPH_PER_MS = 2.23694;
/** CDDA keeps vehicle speeds in integer 1/100 mph ("vmiph"). */
export const VMIPH_PER_MS = 100 * MPH_PER_MS;
/** CDDA pldrive: one accelerate/brake keypress moves the cruise target by 4 mph. */
export const CRUISE_STEP_VMIPH = 400;

/**
 * CDDA vehicle::cruise_thrust, in vmiph. The target snaps to the safe velocity when a step
 * would cross it, otherwise moves by `amount` rounded toward zero to a multiple of it, and is
 * clamped to [maxRev, max]. All arguments are integers like CDDA's.
 */
export function cruiseThrust(cruise: number, amount: number, safe: number, max: number, maxRev: number): number {
  if (amount === 0) return cruise;
  if ((cruise < safe && safe < cruise + amount) || (cruise > safe && safe > cruise + amount)) {
    cruise = safe;
  } else {
    if (amount < 0 && (cruise === safe || cruise === max)) cruise -= 1;
    else if (amount > 0 && cruise === maxRev) cruise += 1;
    else cruise += amount;
    // C++ integer division truncates toward zero.
    cruise = Math.trunc(cruise / Math.abs(amount)) * Math.abs(amount);
  }
  return Math.max(maxRev, Math.min(max, cruise));
}

export interface VehiclePart {
  def: VPartDef;
  mx: number;
  my: number;
  variant?: string;
  /** 0 = broken. Max = def.durability. */
  hp: number;
  /** OPENABLE parts (doors, trunk lids). */
  open: boolean;
  /** Lights, engines, alarms... (CDDA vehicle_part::enabled). */
  enabled: boolean;
  /** Tanks: liquid item id; batteries: 'battery'. */
  fuelType?: string;
  /** Tank ml / battery kJ (charges of fuelType). */
  charges: number;
  /** CARGO parts: items stored inside. */
  items: Item[];
  /** Engines: a maintenance fault (CDDA "engine_maintenance"); hard to start, less power. */
  fault?: boolean;
  /** CDDA blood level (0..600): the renderer tints bloody parts. */
  blood: number;
}

export interface VehiclePartJSON {
  id: string;
  mx: number;
  my: number;
  variant?: string;
  hp: number;
  open?: boolean;
  enabled?: boolean;
  fuelType?: string;
  charges?: number;
  items?: ItemJSON[];
  fault?: boolean;
  blood?: number;
}

export interface VehicleJSON {
  uid: number;
  proto: string;
  name: string;
  x: number;
  y: number;
  z: number;
  facing: number;
  velocity: number;
  engineOn: boolean;
  lightsOn: boolean;
  locked: boolean;
  alarmOn?: boolean;
  /** CDDA cruise_velocity, vmiph (absent in older saves = 0). */
  cruise?: number;
  paint: number;
  parts: VehiclePartJSON[];
  /**
   * The chassis template the grid is mapped onto (vehicles v3). Absent in saves from before
   * it: VehicleSystem maps those once on load (the save migration).
   */
  chassis?: { template: string; v: number };
}

export const mountKey = (mx: number, my: number): number => (mx + 512) * 1024 + (my + 512);

let nextUid = 1;

export class Vehicle {
  uid = nextUid++;
  name: string;
  x = 0;
  y = 0;
  z = 0;
  /** degrees, 0 = east, clockwise */
  facing = 0;
  /** m/s along the facing (negative = reversing). */
  velocity = 0;
  /** Current front-wheel angle, radians (+ = turning right). */
  steer = 0;
  /** CDDA cruise_velocity: the speed the engine drives toward, integer vmiph (1/100 mph). */
  cruiseVelocity = 0;
  engineOn = false;
  lightsOn = false;
  /** CDDA is_locked: no keys, security system present. Controls need hotwiring. */
  locked = false;
  /** Security system sounding (failed hotwiring, CDDA is_alarm_on). */
  alarmOn = false;
  /** Body paint (0xRRGGBB) chosen at spawn, for the renderer. */
  paint = 0x8a8f96;
  readonly parts: VehiclePart[] = [];
  /** mount key -> indices into parts, in install order. */
  private byMount = new Map<number, number[]>();
  /** Bumped when anything the renderer draws changes (doors, damage, lights). */
  version = 0;
  /**
   * Chassis template (src/game/chassis): authoritative once set, and saved, so a stripped
   * vehicle keeps its body. null = not mapped yet (chassisOf maps it on first use).
   */
  template: TemplateId | null = null;
  /** The parts' sockets on `template` (derived from the grid, not saved; chassisOf keeps it current). */
  chassis: VehicleChassis | null = null;

  constructor(readonly vdata: VehicleDataFile, readonly protoId: string) {
    const proto = vdata.vehicles[protoId];
    if (!proto) throw new Error(`unknown vehicle prototype ${protoId}`);
    this.name = proto.name;
  }

  addPart(def: VPartDef, mx: number, my: number, variant?: string): VehiclePart {
    const p: VehiclePart = { def, mx, my, variant, hp: def.durability, open: false, enabled: false, charges: 0, items: [], blood: 0 };
    if (def.flags.includes('BATTERY')) p.fuelType = 'battery';
    const k = mountKey(mx, my);
    let list = this.byMount.get(k);
    if (!list) this.byMount.set(k, (list = []));
    list.push(this.parts.length);
    this.parts.push(p);
    return p;
  }

  // --- geometry ------------------------------------------------------------------------

  mounts(): IterableIterator<number> {
    return this.byMount.keys();
  }
  hasMount(mx: number, my: number): boolean {
    return this.byMount.has(mountKey(mx, my));
  }
  partsAt(mx: number, my: number): VehiclePart[] {
    return (this.byMount.get(mountKey(mx, my)) ?? []).map((i) => this.parts[i]);
  }
  /** Mount bounds [minX, minY, maxX, maxY]. */
  bounds(): [number, number, number, number] {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of this.parts) {
      a = Math.min(a, p.mx); b = Math.min(b, p.my); c = Math.max(c, p.mx); d = Math.max(d, p.my);
    }
    return [a, b, c, d];
  }

  /** World position of a (continuous) mount coordinate. */
  mountToWorld(mx: number, my: number, facing = this.facing, x = this.x, y = this.y): [number, number] {
    const [dx, dy] = rotate(mx, my, facing);
    return [x + dx, y + dy];
  }
  /** Continuous mount coordinate of a world point. */
  worldToMount(wx: number, wy: number, facing = this.facing, x = this.x, y = this.y): [number, number] {
    return rotate(wx - x, wy - y, -facing);
  }
  /** Mount occupying world tile (tx, ty), if any: the mount containing the tile centre. */
  mountAtTile(tx: number, ty: number, facing = this.facing, x = this.x, y = this.y): [number, number] | null {
    const [lx, ly] = this.worldToMount(tx + 0.5, ty + 0.5, facing, x, y);
    const mx = Math.round(lx), my = Math.round(ly);
    return this.byMount.has(mountKey(mx, my)) ? [mx, my] : null;
  }

  /** Every world tile the vehicle covers (at a hypothetical pose), with its mount. */
  occupiedTiles(facing = this.facing, x = this.x, y = this.y): { tx: number; ty: number; mx: number; my: number }[] {
    const out: { tx: number; ty: number; mx: number; my: number }[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of this.byMount.keys()) {
      const [wx, wy] = this.mountToWorld(Math.floor(k / 1024) - 512, (k % 1024) - 512, facing, x, y);
      x0 = Math.min(x0, wx); y0 = Math.min(y0, wy); x1 = Math.max(x1, wx); y1 = Math.max(y1, wy);
    }
    for (let ty = Math.floor(y0 - 1); ty <= Math.floor(y1 + 1); ty++)
      for (let tx = Math.floor(x0 - 1); tx <= Math.floor(x1 + 1); tx++) {
        const m = this.mountAtTile(tx, ty, facing, x, y);
        if (m) out.push({ tx, ty, mx: m[0], my: m[1] });
      }
    return out;
  }

  // --- per-tile properties (map.cpp / vpart_position) --------------------------------------

  /** The part blocking movement at a mount (vpart_position::obstacle_at_part). */
  obstacleAt(mx: number, my: number): VehiclePart | null {
    const list = this.partsAt(mx, my);
    const obs = list.find((p) => p.hp > 0 && has(p, 'OBSTACLE'));
    if (!obs) return null;
    // An open door anywhere on the mount unblocks it (door + frame share the tile).
    if (list.some((p) => has(p, 'OPENABLE') && p.open)) return null;
    return obs;
  }
  /** CDDA move cost at a mount: 0 = impassable, 2 = aisle, 8 = clambering over seats. */
  moveCostAt(mx: number, my: number): number {
    if (this.obstacleAt(mx, my)) return 0;
    return this.partsAt(mx, my).some((p) => p.hp > 0 && has(p, 'AISLE')) ? 2 : 8;
  }
  opaqueAt(mx: number, my: number): boolean {
    const list = this.partsAt(mx, my);
    if (!list.some((p) => p.hp > 0 && has(p, 'OPAQUE'))) return false;
    return !list.some((p) => has(p, 'OPENABLE') && p.open);
  }
  /** Has an intact roof (keeps the rain off; interiors are darker). */
  roofAt(mx: number, my: number): boolean {
    return this.partsAt(mx, my).some((p) => p.hp > 0 && has(p, 'ROOF'));
  }

  // --- parts by feature -------------------------------------------------------------------

  withFlag(flag: string, intact = false): VehiclePart[] {
    return this.parts.filter((p) => has(p, flag) && (!intact || p.hp > 0));
  }
  get engines(): VehiclePart[] {
    return this.withFlag('ENGINE');
  }
  get wheels(): VehiclePart[] {
    return this.withFlag('WHEEL');
  }
  controls(): VehiclePart | null {
    return this.parts.find((p) => has(p, 'CONTROLS')) ?? null;
  }
  /** The seat the driver sits in: the SEAT on the controls' mount (or the controls tile). */
  driverSeat(): { mx: number; my: number } | null {
    const c = this.controls();
    return c ? { mx: c.mx, my: c.my } : null;
  }

  // --- mass, power, velocity (vehicle.cpp) ---------------------------------------------------

  /** Total mass in kg: parts + cargo + fuel. */
  mass(): number {
    let g = 0;
    for (const p of this.parts) {
      g += p.def.weight;
      for (const it of p.items) g += it.weight();
      // Liquids: ~0.75-1 kg/L; batteries' charge weighs nothing.
      if (p.fuelType && p.fuelType !== 'battery') g += p.charges * (p.fuelType.startsWith('water') ? 1 : 0.8);
    }
    return Math.max(50, g / 1000);
  }

  /** Fuel still available for an engine (muscle engines are fuelled by the driver). */
  engineHasFuel(e: VehiclePart): boolean {
    const ft = e.def.fuel_type;
    if (!ft || ft === 'muscle' || ft === 'animal' || ft === 'wind') return true;
    return this.fuelLeft(ft) > 0;
  }

  /** CDDA part_vpower_w: damaged engines lose power down to damaged_power_factor. */
  partPower(e: VehiclePart): number {
    let pwr = e.def.power ?? 0;
    if (e.hp <= 0) return 0;
    const dpf = e.def.damaged_power_factor ?? 0;
    const health = e.hp / e.def.durability;
    if (health < 1 && pwr > 0) pwr *= dpf + (1 - dpf) * health;
    if (e.fault) pwr *= 0.6;
    return pwr;
  }

  /** CDDA total_power (W): running engines with fuel, minus alternators; `safe` = m2c share. */
  totalPower(safe = false): number {
    if (!this.engineOn) return 0;
    let pwr = 0, count = 0;
    for (const e of this.engines) {
      if (!e.enabled || e.hp <= 0 || !this.engineHasFuel(e)) continue;
      pwr += (this.partPower(e) * (safe ? e.def.m2c ?? 100 : 100)) / 100;
      count++;
    }
    for (const a of this.withFlag('ALTERNATOR', true)) if (count) pwr += a.def.power ?? 0;
    pwr = Math.max(0, pwr);
    if (count > 1) pwr = (pwr * 4) / (4 + count - 1);
    return pwr;
  }

  /** Simplified CDDA coeff_air_drag: per-column base + penalties, times cross section. */
  coeffAirDrag(): number {
    const [x0, y0, x1, y1] = this.bounds();
    const width = y1 - y0 + 1;
    const length = x1 - x0 + 1;
    let c = 0, height = 0;
    for (let my = y0; my <= y1; my++) {
      let shield = false, seat = false, fboard = false, roof = false, aisle = false, exposed = false;
      for (let mx = x0; mx <= x1; mx++)
        for (const p of this.partsAt(mx, my)) {
          if (has(p, 'WINDSHIELD') && p.hp > 0) shield = true;
          if (has(p, 'SEAT') || has(p, 'BED')) seat = true;
          if (has(p, 'FULL_BOARD')) fboard = true;
          if (has(p, 'ROOF')) roof = true;
          if (has(p, 'AISLE')) aisle = true;
          if (p.def.location === 'center' && !has(p, 'NO_ROOF_NEEDED') && !has(p, 'WINDSHIELD') && !has(p, 'OPENABLE') && !this.roofAt(p.mx, p.my)) exposed = true;
        }
      let cc = 0.25;
      if (seat && !shield) cc += 0.3;
      if (exposed) cc += 0.3;
      if (length >= 2 * width) cc -= 0.1;
      c += cc;
      height += 1.4 + (roof ? 0.1 : 0) + (aisle ? 0.6 : 0) + (fboard ? 0.5 : 0);
    }
    c /= width;
    height /= width;
    const crossArea = height * tileToWidth(width);
    return Math.max(0.1, c * crossArea * 0.5 * AIR_DENSITY);
  }

  /** CDDA coeff_rolling_drag (N per m/s), `offroad` scales wheel resistance. */
  coeffRollingDrag(offroad = 1): number {
    const wheels = this.wheels.filter((w) => w.hp > 0);
    let factor: number;
    if (!wheels.length) factor = 50;
    else {
      // Rolling resistance ~1 per road tyre (CDDA wheel rolling_resistance defaults).
      factor = wheels.length;
      factor *= 1.25 / (4 * 1.25 - 4 + wheels.length);
    }
    return ACCEL_G * 0.000225 * factor * offroad * this.mass();
  }

  /** Top speed in m/s (CDDA max_ground_velocity; safe = within the engines' m2c). */
  maxVelocity(safe = false, offroad = 1): number {
    const p = this.totalPower(safe);
    if (p <= 0) return 0;
    const cr = this.coeffRollingDrag(offroad);
    return simpleCubicSolution(this.coeffAirDrag(), cr, cr * 33.3, -p);
  }

  /** Top reverse speed in m/s, negative (CDDA max_reverse_velocity: electric motors reverse at full speed). */
  maxReverseVelocity(offroad = 1): number {
    const electric = this.engines.some((e) => e.enabled && e.hp > 0 && e.def.fuel_type === 'battery');
    return -this.maxVelocity(false, offroad) * (electric ? 1 : 0.25);
  }

  /** Press accelerate (+) / brake (-) once: CDDA cruise_thrust by `amount` vmiph. */
  cruiseThrust(amount: number, offroad = 1): void {
    const vm = (ms: number) => Math.trunc(ms * VMIPH_PER_MS);
    this.cruiseVelocity = cruiseThrust(this.cruiseVelocity, amount, vm(this.maxVelocity(true, offroad)), vm(this.maxVelocity(false, offroad)), vm(this.maxReverseVelocity(offroad)));
  }

  /** Engine acceleration at speed v (m/s^2), CDDA ground_acceleration. */
  acceleration(v: number, offroad = 1): number {
    const p = this.totalPower();
    if (p <= 0) return 0;
    const vref = Math.max(Math.abs(v), 4.47, this.maxVelocity(false, offroad) / 4);
    return p / (this.mass() * vref);
  }

  /** Enough intact wheels to drive on (simplified vehicle::valid_wheel_config). */
  validWheelConfig(): boolean {
    const all = this.wheels;
    if (!all.length) return false;
    const ok = all.filter((w) => w.hp > 0).length;
    return ok >= Math.max(1, Math.ceil(all.length * 0.75));
  }

  /** A working security system (CDDA has_security_working). */
  hasSecurity(): boolean {
    return this.parts.some((p) => has(p, 'SECURITY') && p.hp > 0);
  }

  steerable(): boolean {
    return this.parts.some((p) => has(p, 'STEERABLE') && p.hp > 0) || this.wheels.length <= 2;
  }

  /** Distance between steering and fixed axles, tiles (bicycle model). */
  wheelbase(): number {
    const steer = this.parts.filter((p) => has(p, 'STEERABLE'));
    const wheels = this.wheels;
    if (!wheels.length) return 2;
    const xs = wheels.map((w) => w.mx);
    const fx = steer.length ? steer.reduce((a, p) => a + p.mx, 0) / steer.length : Math.max(...xs);
    const rest = wheels.filter((w) => !steer.some((s) => s.mx === w.mx && s.my === w.my));
    const rx = rest.length ? rest.reduce((a, p) => a + p.mx, 0) / rest.length : Math.min(...xs);
    return Math.max(1, Math.abs(fx - rx));
  }

  // --- fuel & electricity ------------------------------------------------------------------

  fuelLeft(type: string): number {
    let n = 0;
    for (const p of this.parts) if (p.fuelType === type && p.hp > 0) n += p.charges;
    return n;
  }
  fuelCapacity(type: string): number {
    let n = 0;
    for (const p of this.parts) if (p.fuelType === type && p.hp > 0) n += p.def.capacity ?? 0;
    return n;
  }
  /** Remove up to `charges` of a fuel; returns how much was drained. */
  drainFuel(type: string, charges: number): number {
    let left = charges;
    for (const p of this.parts) {
      if (left <= 0) break;
      if (p.fuelType !== type || p.hp <= 0) continue;
      const d = Math.min(p.charges, left);
      p.charges -= d;
      left -= d;
    }
    return charges - left;
  }
  /** Add up to `charges`; returns how much fitted. */
  addFuel(type: string, charges: number): number {
    let left = charges;
    for (const p of this.parts) {
      if (left <= 0) break;
      if (p.fuelType !== type || p.hp <= 0) continue;
      const d = Math.min((p.def.capacity ?? 0) - p.charges, left);
      if (d <= 0) continue;
      p.charges += d;
      left -= d;
    }
    return charges - left;
  }
  /** Fuel types this vehicle's engines burn. */
  engineFuels(): string[] {
    return [...new Set(this.engines.map((e) => e.def.fuel_type).filter((f): f is string => !!f))];
  }

  /**
   * Burn fuel for `dt` seconds at engine `load` (0..1 of full power), CDDA consume_fuel:
   * energy = energy_consumption W x load x dt, converted to charges by fuel energy density.
   * Returns charges burnt per fuel type.
   */
  consumeFuel(dt: number, load: number): Record<string, number> {
    const used: Record<string, number> = {};
    if (!this.engineOn) return used;
    for (const e of this.engines) {
      const ft = e.def.fuel_type;
      if (!e.enabled || e.hp <= 0 || !ft || ft === 'muscle' || ft === 'animal' || ft === 'wind') continue;
      const kjPer = this.vdata.fuels[ft]?.kjPerCharge;
      if (!kjPer) continue;
      const kj = ((e.def.energy_consumption ?? e.def.power ?? 0) * load * dt) / 1000;
      const want = kj / kjPer;
      used[ft] = (used[ft] ?? 0) + this.drainFuel(ft, want);
    }
    return used;
  }

  /**
   * Electrical balance for dt seconds: enabled consumers (lights, dashboard) drain, running
   * alternators charge. Returns net kJ (negative = drained).
   */
  updateElectrics(dt: number): number {
    let w = 0;
    for (const p of this.parts) {
      if (p.hp <= 0) continue;
      if (has(p, 'ENABLED_DRAINS_EPOWER') && (p.enabled || (has(p, 'CONE_LIGHT') && this.lightsOn))) w += p.def.epower ?? 0;
      if (has(p, 'ALTERNATOR') && this.engineOn) w += p.def.epower ?? 0;
    }
    const kj = (w * dt) / 1000;
    if (kj > 0) this.addFuel('battery', kj);
    else if (kj < 0) this.drainFuel('battery', -kj);
    return kj;
  }

  /** Engine noise (CDDA noise_factor x load + base), for sound events. */
  engineNoise(load: number): number {
    if (!this.engineOn) return 0;
    let n = 0;
    for (const e of this.engines) {
      if (!e.enabled || e.hp <= 0) continue;
      const ft = e.def.fuel_type;
      if (ft === 'muscle' || ft === 'battery') continue;
      n += (e.def.noise_factor ?? 0) * (0.3 + load);
    }
    // Mufflers reduce combustion noise by their bonus %.
    const muff = this.withFlag('MUFFLER', true).reduce((a, p) => Math.max(a, p.def.bonus ?? 0), 0);
    return Math.round(n * (1 - muff / 100));
  }

  // --- serialization -----------------------------------------------------------------------

  toJSON(): VehicleJSON {
    return {
      uid: this.uid, proto: this.protoId, name: this.name, x: this.x, y: this.y, z: this.z, facing: this.facing,
      velocity: this.velocity, engineOn: this.engineOn, lightsOn: this.lightsOn, locked: this.locked, alarmOn: this.alarmOn, paint: this.paint,
      ...(this.cruiseVelocity ? { cruise: this.cruiseVelocity } : {}),
      ...(this.template ? { chassis: { template: this.template, v: CHASSIS_VERSION } } : {}),
      parts: this.parts.map((p) => {
        const j: VehiclePartJSON = { id: p.def.id, mx: p.mx, my: p.my, hp: p.hp };
        if (p.variant) j.variant = p.variant;
        if (p.open) j.open = true;
        if (p.enabled) j.enabled = true;
        if (p.fuelType) j.fuelType = p.fuelType;
        if (p.charges) j.charges = p.charges;
        if (p.items.length) j.items = p.items.map((i) => i.toJSON());
        if (p.fault) j.fault = true;
        if (p.blood) j.blood = p.blood;
        return j;
      }),
    };
  }

  /**
   * Rebuild from toJSON output. Unknown part ids are dropped with `opts.warn`; cargo goes
   * through `opts.loadItem` (the save system's unknown-id-tolerant loader) when given.
   */
  static fromJSON(vdata: VehicleDataFile, data: GameData, j: VehicleJSON, opts: { warn?: (msg: string) => void; loadItem?: (j: ItemJSON) => Item | null } = {}): Vehicle {
    const v = new Vehicle(vdata, j.proto);
    v.uid = j.uid;
    nextUid = Math.max(nextUid, j.uid + 1);
    Object.assign(v, { name: j.name, x: j.x, y: j.y, z: j.z, facing: j.facing, velocity: j.velocity, engineOn: j.engineOn, lightsOn: j.lightsOn, locked: j.locked, alarmOn: !!j.alarmOn, paint: j.paint, cruiseVelocity: j.cruise ?? 0 });
    if (j.chassis) {
      if (j.chassis.v > CHASSIS_VERSION) throw new Error(`vehicle ${j.proto}: chassis data v${j.chassis.v} is newer than this build reads (v${CHASSIS_VERSION})`);
      if (TEMPLATES[j.chassis.template as TemplateId]) v.template = j.chassis.template as TemplateId;
      // A template this build doesn't know: re-mapped from the grid on load (nothing is lost).
      else (opts.warn ?? console.warn)(`vehicle ${j.proto}: unknown chassis template ${j.chassis.template}, re-mapped`);
    }
    for (const pj of j.parts) {
      const def = vdata.parts[pj.id];
      if (!def) {
        if (opts.warn) opts.warn(`vehicle ${j.proto}: dropped unknown part ${pj.id}`);
        else warnOnce('vehicle_part', pj.id);
        continue;
      }
      const p = v.addPart(def, pj.mx, pj.my, pj.variant);
      p.hp = pj.hp;
      p.open = !!pj.open;
      p.enabled = !!pj.enabled;
      p.fuelType = pj.fuelType ?? p.fuelType;
      p.charges = pj.charges ?? 0;
      p.items = (pj.items ?? []).map((ij) => (opts.loadItem ? opts.loadItem(ij) : Item.fromJSON(data, ij))).filter((it): it is Item => !!it);
      p.fault = pj.fault;
      p.blood = pj.blood ?? 0;
    }
    return v;
  }
}

export function has(p: VehiclePart, flag: string): boolean {
  return p.def.flags.includes(flag);
}

/** Rotate a mount offset by `facingDeg` (clockwise in tile space, y south). */
export function rotate(x: number, y: number, facingDeg: number): [number, number] {
  const a = (facingDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // Snap tiny float noise so axis-aligned vehicles land exactly on tile centres.
  const r = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v);
  // (+ 0 turns -0 into 0)
  return [r(x * c - y * s) + 0, r(x * s + y * c) + 0];
}

/** vehicle.cpp tile_to_width: body width in metres for a width in tiles. */
export function tileToWidth(tiles: number): number {
  if (tiles < 1) return 0.1;
  if (tiles < 6) return tiles * 0.5 + 0.4;
  return tiles * 0.5;
}

/** vehicle.cpp simple_cubic_solution (real root of a v^3 + b v^2 + c v + d). */
export function simpleCubicSolution(a: number, b: number, c: number, d: number): number {
  const p = -b / (3 * a);
  const q = p * p * p + (b * c - 3 * a * d) / (6 * a * a);
  const r = c / (3 * a);
  const t = r - p * p;
  const tricky = q * q + t * t * t;
  if (tricky < 0) {
    // Three real roots: take the largest via the trigonometric form (the positive speed).
    const m = 2 * Math.sqrt(-t);
    const th = Math.acos(Math.max(-1, Math.min(1, q / Math.sqrt(-t * t * t)))) / 3;
    return p + m * Math.cos(th);
  }
  const f = Math.sqrt(tricky);
  return p + Math.cbrt(q + f) + Math.cbrt(q - f);
}

/** CDDA normal_roll via Box-Muller on our deterministic rng. */
function normalRoll(rng: Rng, mean: number, sd: number): number {
  const u = Math.max(1e-9, rng.next()), v = rng.next();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- collisions (vehicle_move.cpp part_collision) ---------------------------------------------

export interface CollisionInput {
  /** kg */
  mass: number;
  /** m/s, signed along the direction of travel */
  velocity: number;
  /** Mass of what we hit, kg (terrain: (bash str_min + str_max) / 2; walls 1000). */
  mass2: number;
  /** Elasticity (0.3 bodies/bashables, 0.1 unbreakable). */
  e: number;
  /** Density of the obstacle (terrain: bash str_min, bodies 15, walls 80). */
  partDens: number;
  /** Density of the colliding vehicle part's material (steel ~ 8, CDDA material densities). */
  vpartDens?: number;
  /** Hitting a creature: it gets pushed along instead of absorbing the impact. */
  body?: boolean;
  /**
   * Called with the damage available to the object after each impact step; return true
   * when it was smashed/pushed away so the vehicle keeps going.
   */
  smash?: (objDmg: number) => boolean;
}

export interface CollisionResult {
  /** Damage to the vehicle part. */
  partDmg: number;
  /** Total damage dealt to the object. */
  objDmg: number;
  /** Vehicle velocity after the collision, m/s. */
  velocity: number;
  smashed: boolean;
}

/**
 * CDDA's collision loop: repeated partially-elastic impacts until the obstacle is smashed
 * or the vehicle's velocity changes sign. Energy lost in each impact becomes damage
 * (d_E / 400 with velocities in mph, as in CDDA), split between part and object by
 * relative mass and density.
 */
export function resolveCollision(inp: CollisionInput): CollisionResult {
  const { mass, e, partDens } = inp;
  let mass2 = Math.max(1, inp.mass2);
  const vpartDens = inp.vpartDens ?? 8;
  const materialFactor = Math.max(-25, Math.min(25, (partDens - vpartDens) * 0.5));
  const weightFactor = mass >= mass2
    ? (-25 * (Math.log(mass) - Math.log(mass2))) / Math.log(mass)
    : (25 * (Math.log(mass2) - Math.log(mass))) / Math.log(mass2);
  const k = Math.max(10, Math.min(90, 50 + materialFactor + weightFactor));
  let vel = inp.velocity * MPH_PER_MS;
  const sign = Math.sign(vel);
  // CDDA keeps velocity in integer 1/100 mph: the loop ends once it rounds to zero.
  const stopped = (x: number) => Math.trunc(x * 100) === 0 || Math.sign(x) !== sign;
  let vel2 = 0, dmg = 0, partDmg = 0, objTotal = 0;
  let smashed = false;
  for (let guard = 0; guard < 500; guard++) {
    const vel1 = vel;
    const vel1a = (mass * vel1 + mass2 * vel2 + e * mass2 * (vel2 - vel1)) / (mass + mass2);
    const vel2a = (mass * vel1 + mass2 * vel2 + e * mass * (vel1 - vel2)) / (mass + mass2);
    const dE = 0.5 * mass * vel1 * vel1 + 0.5 * mass2 * vel2 * vel2 - (0.5 * mass * vel1a * vel1a + 0.5 * mass2 * vel2a * vel2a);
    if (dE <= 0) {
      if (Math.abs(vel1a) < Math.abs(vel1)) vel = vel1a * 0.9;
      if (Math.abs(vel2a) > Math.abs(vel2)) vel2 = vel2a;
      if (stopped(vel) || vel === vel1) break;
      continue;
    }
    dmg += dE / 400;
    partDmg = (dmg * k) / 100;
    const objDmg = (dmg * (100 - k)) / 100;
    objTotal = objDmg;
    smashed = inp.smash ? inp.smash(objDmg) : false;
    // Only bodies get pushed along (vel2); terrain stays put and absorbs the energy.
    if (inp.body && !smashed) {
      if (Math.abs(vel2a) > Math.abs(vel2)) vel2 = vel2a;
      else {
        // The vehicle's momentum isn't big enough to push the critter.
        vel = 0;
        break;
      }
    }
    vel = vel1a;
    if (smashed || stopped(vel)) break;
  }
  return { partDmg, objDmg: objTotal, velocity: vel / MPH_PER_MS, smashed };
}

/** BN vehicle_move.cpp imp_conv_const: damage per newton-second of impulse. */
export const IMPULSE_TO_DAMAGE = 0.1;

export interface BodyCollisionInput {
  /** Vehicle mass, kg. */
  mass: number;
  /** Vehicle velocity, m/s (signed). */
  velocity: number;
  /** The creature's mass, kg. */
  mass2: number;
  /** The colliding part's damage_modifier (percent, BN `dmg_mod`). */
  damageModifier?: number;
  /** The creature's max HP: BN caps the part damage from one body at it. */
  hpMax: number;
  /**
   * Called with the damage BN deals to the creature for this impact step (before its armor,
   * which the owner of the creature applies); returns whether it died or was knocked clear.
   */
  hit: (objDmg: number) => boolean;
}

/**
 * BN's body branch of vehicle::part_collision. Unlike DDA (and our terrain loop above, which
 * turns lost kinetic energy in mph² into damage), BN converts the **impulse** each side takes
 * into damage (0.1 per N·s). DDA's numbers gave a zombie ~10 damage at 20 mph and no car
 * ever killed one (QA: "Kills 0" after ramming six); BN's give ~90, so an ordinary zombie
 * (80 HP, bash armor 0–2) dies when run over at 20 mph, as players expect.
 */
export function resolveBodyCollision(inp: BodyCollisionInput): CollisionResult {
  const { mass, mass2 } = inp;
  const e = 0.3;
  // BN pre-divides dmg_mod by 100 in integer maths (50 and 80 -> 0 -> 1, 150 -> 1).
  const dmgMod = Math.trunc((inp.damageModifier ?? 100) / 100) || 1;
  let vel = inp.velocity;
  const sign = Math.sign(vel);
  let vel2 = 0, partTotal = 0, objTotal = 0;
  let smashed = false;
  for (let guard = 0; guard < 100 && !smashed && Math.sign(vel) === sign && Math.round(vel * 100) !== 0; guard++) {
    const vel1 = vel;
    let vel1a = (mass * vel1 + mass2 * vel2 + e * mass2 * (vel2 - vel1)) / (mass + mass2);
    const vel2a = (mass * vel1 + mass2 * vel2 + e * mass * (vel1 - vel2)) / (mass + mass2);
    const impulseVeh = Math.abs(mass * (vel1a - vel1));
    const impulseObj = Math.abs(mass2 * (vel2a - vel2));
    // Part damage is capped by what the body can absorb, and unspent momentum is given back.
    const partDmg = Math.min(inp.hpMax / dmgMod, impulseVeh * IMPULSE_TO_DAMAGE);
    const objDmg = impulseObj * IMPULSE_TO_DAMAGE * dmgMod;
    partTotal += partDmg;
    objTotal += objDmg;
    const recovered = vel1 - Math.sign(vel1) * (partDmg / IMPULSE_TO_DAMAGE) / mass;
    if (Math.abs(recovered) < Math.abs(vel1)) vel1a = recovered;
    smashed = inp.hit(objDmg);
    if (!smashed) {
      if (Math.abs(vel2a) > Math.abs(vel2)) vel2 = vel2a;
      else {
        // The vehicle's momentum isn't big enough to push the critter.
        vel = 0;
        break;
      }
    }
    const next = vel1a * (smashed ? 1 : 0.9);
    // BN: rounding must not keep the loop going without slowing down.
    vel = !smashed && Math.abs(next) >= Math.abs(vel1) ? 0 : next;
  }
  return { partDmg: partTotal, objDmg: objTotal, velocity: vel, smashed };
}

/** Passenger impact (vehicle_move.cpp throw_passenger): bash damage to the torso, or 0. */
export function passengerImpactDamage(dVelMph: number, seatbeltBonus: number, rng: Rng): number {
  const d = Math.floor(Math.abs(dVelMph));
  let dmg = Math.floor(d * (1 + rng.next()));
  dmg -= seatbeltBonus;
  if (dmg <= 0) return 0;
  return 10 * d > 6 * rng.int(25, 50) ? dmg : 0;
}

// --- spawning (vehicle.cpp init_state, place_spawn_items) --------------------------------------

export interface SpawnOpts {
  x: number;
  y: number;
  z: number;
  facing: number;
  /** CDDA init_veh_fuel: -1 random (~30%), 0 empty, 1..99 percent, >= 100 full. */
  fuel?: number;
  /** CDDA veh_spawn_status: -1 light damage (default), 0 undamaged, 1 disabled, 2 pristine. */
  status?: number;
  rng: Rng;
  /** Spawn cargo items (vehicle prototype "items"). Default true. */
  items?: boolean;
}

const PAINTS = [0x8a2c28, 0x2c4a86, 0xc9c9c0, 0x2a2a2e, 0x6c6f76, 0x305e3c, 0xb8973a, 0xdedcd2, 0x5a3a28, 0x7a1e4a];

export function spawnVehicle(vdata: VehicleDataFile, data: GameData, protoId: string, o: SpawnOpts): Vehicle {
  const proto = vdata.vehicles[protoId];
  if (!proto) throw new Error(`unknown vehicle prototype ${protoId}`);
  const v = new Vehicle(vdata, protoId);
  v.x = o.x;
  v.y = o.y;
  v.z = o.z;
  v.facing = ((o.facing % 360) + 360) % 360;
  const rng = o.rng;
  v.paint = rng.pick(PAINTS);
  for (const pp of proto.parts) {
    const def = vdata.parts[pp.part];
    if (!def) continue;
    const p = v.addPart(def, pp.x, pp.y, pp.variant);
    if (pp.fuel) p.fuelType = pp.fuel;
  }
  initState(v, o.fuel ?? -1, o.status ?? -1, rng);
  if (o.items !== false) placeSpawnItems(v, data, rng);
  return v;
}

/** vehicle::init_state: fuel levels, wear and tear, locks, lights left on. */
export function initState(v: Vehicle, fuel: number, status: number, rng: Rng): void {
  for (const p of v.parts) p.enabled = has(p, 'ENGINE');
  let destroySeats = false, destroyControls = false, destroyTank = false, destroyEngine = false, destroyTires = false;
  const undamaged = status === 0 || status === 2;
  if (status === 1) {
    switch (rng.int(1, 5)) {
      case 1: destroySeats = true; break;
      case 2: destroyControls = true; break;
      case 3: destroyTank = true; break;
      case 4: destroyEngine = true; break;
      case 5: destroyTires = true; break;
    }
  }
  let hasNoKey = rng.oneIn(3);
  let destroyAlarm = !rng.oneIn(3);
  destroyEngine = destroyEngine || rng.oneIn(3);
  if (status === 2) {
    hasNoKey = false;
    destroyAlarm = false;
    destroyEngine = false;
  }
  if (!undamaged) {
    // Day 0 of the cataclysm: 1 in 4 abandoned cars still idle where they were left.
    if (fuel !== 0 && v.engines.length && rng.oneIn(4) && !destroyEngine && !hasNoKey && v.engines.some((e) => e.def.fuel_type !== 'muscle')) v.engineOn = true;
    const lightHead = rng.oneIn(20);
    if (lightHead) v.lightsOn = true;
    const dome = rng.oneIn(16);
    for (const p of v.parts) if (has(p, 'DOME_LIGHT')) p.enabled = dome;
  }
  // Tanks of the same fuel get the same random fill (the "fuels" map in init_state).
  const rolls = new Map<string, number>();
  const fill = (p: VehiclePart) => {
    const t = p.fuelType;
    const max = p.def.capacity ?? 0;
    if (!t || !max) return;
    if (fuel < 0) {
      let r = rolls.get(t);
      if (r === undefined) rolls.set(t, (r = normalRoll(rng, 0.3, 0.15)));
      p.charges = max * Math.max(0.05, Math.min(0.95, r));
    } else if (fuel === 0) p.charges = 0;
    else if (fuel < 100) p.charges = (max * fuel) / 100;
    else p.charges = max;
  };
  for (const p of v.parts) {
    if (has(p, 'BATTERY') || has(p, 'FLUIDTANK')) fill(p);
    if (has(p, 'OPENABLE') && rng.oneIn(4)) p.open = true;
    if (undamaged) p.hp = p.def.durability;
    else {
      const roll = rng.dice(4, 8);
      if (roll < 20) {
        if (roll <= 8) {
          p.hp = 0;
          p.charges = 0;
        } else p.hp = Math.round(((roll - 8) / 12) * p.def.durability);
      } else p.hp = p.def.durability;
      if (has(p, 'ENGINE')) {
        // Prefer a maintenance fault over a wrecked engine (engines always have potential faults).
        if (destroyEngine) p.fault = true;
      } else if ((destroySeats && (has(p, 'SEAT') || has(p, 'SEATBELT'))) || (destroyControls && (has(p, 'CONTROLS') || has(p, 'SECURITY'))) || (destroyAlarm && has(p, 'SECURITY'))) {
        p.hp = 0;
      }
      if (destroyTank && has(p, 'FLUIDTANK')) {
        p.hp = 0;
        p.charges = 0;
      }
    }
    if (has(p, 'SECURITY') && hasNoKey && p.hp > 0) v.locked = true;
  }
  if (destroyTires) {
    const wheels = v.wheels;
    for (let tries = 0; tries < 100 && v.validWheelConfig(); tries++) rng.pick(wheels).hp = 0;
  }
  if (status === 1 && rng.oneIn(2)) for (const p of v.parts) p.hp = Math.round(p.hp * 0.5);
  if (v.engineOn && !v.engines.some((e) => e.hp > 0 && v.engineHasFuel(e))) v.engineOn = false;
  v.version++;
}

/** vehicle::place_spawn_items: prototype item spawns go into the CARGO part at the mount. */
export function placeSpawnItems(v: Vehicle, data: GameData, rng: Rng): void {
  const proto = v.vdata.vehicles[v.protoId];
  for (const sp of proto.items) {
    if (rng.int(1, 100) > sp.chance) continue;
    const cargo = v.partsAt(sp.x, sp.y).find((p) => has(p, 'CARGO'));
    if (!cargo) continue;
    for (const id of sp.items ?? []) {
      if (!data.items[id]) {
        warnOnce('item', id);
        continue;
      }
      spawnItem(createItem(data, id), L.cargo(cargo), { force: true, quiet: true });
    }
    for (const g of sp.item_groups ?? []) {
      if (!data.itemGroups[g]) {
        warnOnce('item_group', g);
        continue;
      }
      for (const s of expandItemGroup(data, g, rng)) for (const it of fromSpawned(data, s)) spawnItem(it, L.cargo(cargo), { force: true, quiet: true });
    }
  }
}

/** Cargo volume used / capacity (ml) of a CARGO part. */
export function cargoVolume(p: VehiclePart): [number, number] {
  let used = 0;
  for (const it of p.items) used += it.volume();
  return [used, p.def.size ?? 0];
}

import { hashSeed, Rng } from '../core/rng';
import { bash } from './bash';
import { ACTION_SCALE } from '../core/time';
import type { MonsterSystem } from './monai';
import type { Monster } from './monster';
import { emitSound, type SoundCategory } from './sound';
import { MAIN_PARTS, type BodyPartId } from './bodyparts';
import type { GameData, TerrainDef, FurnitureDef } from '../data/types';
import type { Chunk, GameMap, MapOverlay, VehicleRequest } from '../world/map';
import { hasFlag } from '../world/registry';
import { chunkKey, chunkOf } from '../world/coords';
import { registerSaveable } from '../save/registry';
import { chunkTracker } from '../save/tracking';
import { loadItemSafe } from '../save/items';
import type { Item, ItemJSON } from './item';
import type { Game, GameSystem } from './game';
import {
  has, MPH_PER_MS, passengerImpactDamage, resolveCollision, spawnVehicle, Vehicle, type VehicleJSON, type VehiclePart,
} from './vehicle';
import { pickVehicleProto, type VehicleDataFile } from './vehicle_data';

// The vehicle system: owns every vehicle in the world, spawns mapgen vehicle requests,
// keeps a tile index the map consults for passability/sight (GameMap.overlays), and runs
// driving physics + collisions each tick (CDDA vehicle_move.cpp, simplified to real time).
//
// Integration seams (see ARCHITECTURE.md "Vehicles"):
//   game.vehicles                       this system (set by installVehicles)
//   vehicles.at(x, y, z)                vehicle + mount occupying a tile
//   vehicles.creatureHooks              how run-overs damage/fling monsters (monster system)
//   vehicles.onBash                     terrain smashing by a moving vehicle (bash.ts)

export interface DriveInput {
  /** -1..1: W accelerates, S brakes then reverses */
  throttle: number;
  /** -1..1: A left, D right */
  steer: number;
  /** handbrake (Space) */
  brake: boolean;
}

export interface CreatureHooks {
  /** Creature standing in a tile (not the player). Defaults to game.creatureAt. */
  at(x: number, y: number, z: number): unknown | null;
  /** kg, for the collision maths (CDDA monster weight). */
  mass(c: unknown): number;
  /** Apply run-over damage; return true if it died. */
  damage(c: unknown, dmg: number, v: Vehicle): boolean;
  /** Put a flung creature down at world point (x, y) (the system picks a free spot). */
  place(c: unknown, x: number, y: number): void;
  name(c: unknown): string;
}

export interface VehicleOccupant {
  v: Vehicle;
  mx: number;
  my: number;
}

const tileKey = (x: number, y: number, z: number): number => ((x + 1048576) * 2097152 + (y + 1048576)) * 64 + (z + 32);

/** Speed at which a vehicle is considered stopped, m/s. */
const STOP_EPS = 0.05;
/** Max front-wheel angle, rad. */
const MAX_STEER = 0.6;
/** Brake deceleration, m/s^2 (CDDA brakes shed ~30% of max speed per turn). */
const BRAKE_DECEL = 7;

export class VehicleSystem implements GameSystem, MapOverlay {
  readonly name = 'vehicles';
  readonly list: Vehicle[] = [];
  private index = new Map<number, VehicleOccupant>();
  private tilesOf = new Map<Vehicle, number[]>();
  private pending: VehicleRequest[] = [];
  /** Vehicle the player is driving (at the controls), if any. */
  driving: Vehicle | null = null;
  /** Latest driving input (read from held keys each tick while driving; tests set it). */
  input: DriveInput = { throttle: 0, steer: 0, brake: false };
  /** When true, `input` is not overwritten from the keyboard (cdda.drive, tests). */
  scriptedInput = false;
  readonly rng: Rng;
  creatureHooks: CreatureHooks;
  /** Bash a tile with `strength`; return true if it broke (default: bash.ts, CDDA map::bash). */
  onBash: (x: number, y: number, z: number, strength: number) => boolean;
  /** Listeners: vehicle added/removed (renderer). */
  readonly onAdded: ((v: Vehicle) => void)[] = [];
  readonly onRemoved: ((v: Vehicle) => void)[] = [];
  private soundAcc = new Map<Vehicle, number>();
  /** Last engine load per vehicle (0..1), for sound/fuel/HUD. */
  readonly load = new Map<Vehicle, number>();

  constructor(readonly game: Game, readonly vdata: VehicleDataFile) {
    this.rng = new Rng(hashSeed(game.seed, 0x7e41c1e5));
    const map = game.map;
    map.overlays.push(this);
    this.creatureHooks = {
      at: (x, y, z) => game.creatureAt(x, y, z),
      mass: (c) => {
        const o = c as { weightKg?: number; weight?: number | (() => number) };
        if (typeof o.weightKg === 'number') return o.weightKg;
        return 80;
      },
      damage: (c, dmg) => {
        // Duck-typed until the monster system provides a hook.
        const o = c as { applyDamage?: (d: number, src?: unknown) => void; takeDamage?: (d: number) => void; hp?: number; dead?: boolean };
        if (o.applyDamage) o.applyDamage(dmg, game.player);
        else if (o.takeDamage) o.takeDamage(dmg);
        else if (typeof o.hp === 'number') o.hp -= dmg;
        return !!o.dead || (typeof o.hp === 'number' && o.hp <= 0);
      },
      place: (c, x, y) => {
        const o = c as { x?: number; y?: number };
        o.x = x;
        o.y = y;
      },
      name: (c) => (c as { name?: string }).name ?? 'something',
    };
    // CDDA part_collision -> map::bash with the object's share of the impact damage.
    this.onBash = (x, y, z, strength) => bash(game, x, y, z, Math.round(strength), { source: this }).success;
    map.onChunkGenerated.push((c) => this.queueChunk(c));
    for (const c of map.loadedChunks()) this.queueChunk(c);
  }

  // --- MapOverlay -----------------------------------------------------------------------

  moveCost(x: number, y: number, z: number): number | undefined {
    const o = this.index.get(tileKey(x, y, z));
    return o ? o.v.moveCostAt(o.mx, o.my) : undefined;
  }
  opaque(x: number, y: number, z: number): boolean | undefined {
    const o = this.index.get(tileKey(x, y, z));
    return o ? o.v.opaqueAt(o.mx, o.my) : undefined;
  }

  // --- registry -----------------------------------------------------------------------

  at(x: number, y: number, z: number): VehicleOccupant | null {
    return this.index.get(tileKey(x, y, z)) ?? null;
  }

  add(v: Vehicle): void {
    this.list.push(v);
    this.reindex(v);
    for (const f of this.onAdded) f(v);
  }

  remove(v: Vehicle): void {
    const i = this.list.indexOf(v);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.unindex(v);
    if (this.driving === v) this.driving = null;
    for (const f of this.onRemoved) f(v);
  }

  private unindex(v: Vehicle): void {
    for (const k of this.tilesOf.get(v) ?? []) if (this.index.get(k)?.v === v) this.index.delete(k);
    this.tilesOf.delete(v);
  }

  /** Recompute the tiles a vehicle covers (after it moved or turned). */
  reindex(v: Vehicle): void {
    this.unindex(v);
    const keys: number[] = [];
    for (const t of v.occupiedTiles()) {
      const k = tileKey(t.tx, t.ty, v.z);
      keys.push(k);
      this.index.set(k, { v, mx: t.mx, my: t.my });
    }
    this.tilesOf.set(v, keys);
  }

  /**
   * Create a vehicle of prototype `protoId` with mount (0,0) at tile (tx, ty). Returns null
   * (and logs why) if it doesn't fit: CDDA's add_vehicle_to_map refuses to place a vehicle
   * over walls or another vehicle (we don't merge wrecks).
   */
  spawn(protoId: string, tx: number, ty: number, z: number, facing: number, opts: { fuel?: number; status?: number; rng?: Rng; force?: boolean } = {}): Vehicle | null {
    const rng = opts.rng ?? this.rng;
    const v = spawnVehicle(this.vdata, this.game.data, protoId, { x: tx + 0.5, y: ty + 0.5, z, facing, fuel: opts.fuel, status: opts.status, rng });
    if (!opts.force && !this.fits(v)) return null;
    this.add(v);
    return v;
  }

  /** True if no structure tile lands on impassable terrain/furniture or another vehicle. */
  fits(v: Vehicle, requireGenerated = false): boolean {
    const map = this.game.map;
    for (const t of v.occupiedTiles()) {
      if (this.index.has(tileKey(t.tx, t.ty, v.z))) return false;
      // Don't force generation of neighbouring chunks from inside generation.
      if (!map.hasChunk(chunkOf(t.tx), chunkOf(t.ty), v.z)) {
        if (requireGenerated) return false;
        continue;
      }
      const ter = map.terAt(t.tx, t.ty, v.z), furn = map.furnAt(t.tx, t.ty, v.z);
      if (ter.move_cost <= 0 || furn.move_cost_mod < 0) return false;
    }
    return true;
  }

  /**
   * Chunks whose vehicle requests were consumed in an earlier session (set by the save
   * hook): regenerating such a chunk must not spawn its vehicles again, they're in the save.
   */
  skipChunk: ((c: Chunk) => boolean) | null = null;

  private queueChunk(c: Chunk): void {
    if (!c.vehicles.length) return;
    const reqs = c.vehicles;
    // Requests are one-shot (like CDDA's mapgen placing the vehicle): clear them so a saved
    // dirty chunk doesn't carry them into the next session.
    c.vehicles = [];
    if (this.skipChunk?.(c)) return;
    this.pending.push(...reqs);
  }

  private rescanAcc = 0;
  /** Late z-level overlays can add requests to chunks after generation; pick those up. */
  private rescan(): void {
    for (const c of this.game.map.loadedChunks()) if (c.vehicles.length) this.queueChunk(c);
  }

  /** Spawn queued mapgen requests (outside chunk generation, so neighbours can be checked). */
  flushPending(): number {
    let n = 0;
    while (this.pending.length) {
      const r = this.pending.shift()!;
      const rng = new Rng(hashSeed(this.game.seed, r.x, r.y, r.z, 0x5eed));
      const proto = pickVehicleProto(this.vdata, r.id, rng);
      if (!proto) continue;
      // "fuel"/"status" follow jmapgen_vehicle's defaults (-1 = random fill / light damage).
      const v = spawnVehicle(this.vdata, this.game.data, proto, {
        x: r.x + 0.5, y: r.y + 0.5, z: r.z, facing: r.rotation ?? 0, fuel: r.fuel ?? -1, status: r.status ?? -1, rng,
      });
      if (!this.fits(v)) continue;
      this.add(v);
      n++;
    }
    return n;
  }

  // --- player control -----------------------------------------------------------------

  /** The vehicle + mount the player stands on, if any. */
  playerOn(): VehicleOccupant | null {
    const p = this.game.player;
    return this.at(p.tileX, p.tileY, p.z);
  }

  /** Controls within reach of the player (on the controls tile or next to it, inside the vehicle). */
  reachableControls(): Vehicle | null {
    const p = this.game.player;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = this.at(p.tileX + dx, p.tileY + dy, p.z);
        if (!o) continue;
        const c = o.v.controls();
        if (!c || c.mx !== o.mx || c.my !== o.my) continue;
        // From outside you'd have to climb over a closed door/window first.
        if (dx !== 0 || dy !== 0) {
          const here = this.at(p.tileX, p.tileY, p.z);
          if (!here || here.v !== o.v) continue;
        }
        return o.v;
      }
    return null;
  }

  takeControls(v: Vehicle): { ok: boolean; msg: string } {
    const c = v.controls();
    if (!c) return { ok: false, msg: `The ${v.name} has no controls.` };
    if (c.hp <= 0) return { ok: false, msg: `The ${v.name}'s controls are broken.` };
    this.driving = v;
    this.seatPlayer(v);
    this.game.movementOverride = () => this.driving !== null;
    const msg = v.locked ? `You take the controls of the ${v.name}. It's locked: you'll need to hotwire it.` : `You take the controls of the ${v.name}.`;
    return { ok: true, msg };
  }

  releaseControls(): string {
    const v = this.driving;
    if (!v) return 'You are not driving.';
    this.driving = null;
    this.input = { throttle: 0, steer: 0, brake: false };
    return Math.abs(v.velocity) > 1 ? `You let go of the controls of the moving ${v.name}!` : `You let go of the controls of the ${v.name}.`;
  }

  private seatPlayer(v: Vehicle): void {
    const s = v.driverSeat();
    if (!s) return;
    const [wx, wy] = v.mountToWorld(s.mx, s.my);
    const p = this.game.player;
    p.x = wx;
    p.y = wy;
    p.z = v.z;
  }

  // --- engine & accessories -----------------------------------------------------------

  /** CDDA start_engines: needs intact engines, fuel, battery charge to crank, and keys. */
  startEngine(v: Vehicle): { ok: boolean; msg: string } {
    if (v.engineOn) return { ok: true, msg: `The ${v.name}'s engine is already running.` };
    const engines = v.engines.filter((e) => e.enabled);
    if (!engines.length) return { ok: false, msg: `The ${v.name} doesn't have an engine!` };
    if (v.locked) return { ok: false, msg: `The ${v.name} is locked. You'll need to hotwire it first.` };
    const working = engines.filter((e) => e.hp > 0);
    if (!working.length) return { ok: false, msg: `The ${v.name}'s engine is destroyed.` };
    const fueled = working.filter((e) => v.engineHasFuel(e));
    if (!fueled.length) {
      const ft = working[0].def.fuel_type ?? 'fuel';
      return { ok: false, msg: `Looks like the ${working[0].def.name} is out of ${this.vdata.fuels[ft]?.name ?? ft}.` };
    }
    // Cranking a combustion engine costs battery (CDDA: start energy ~ power x start time).
    const needsCrank = fueled.some((e) => !has(e, 'E_STARTS_INSTANTLY') && e.def.fuel_type !== 'muscle' && e.def.fuel_type !== 'battery');
    const crankKj = needsCrank ? fueled.reduce((a, e) => a + (e.def.power ?? 0), 0) * 0.0002 : 0;
    if (crankKj > 0 && v.fuelLeft('battery') < crankKj) {
      this.emitSound(v, 5, 'the engine clicking');
      return { ok: false, msg: `The ${v.name}'s engine clicks: the battery is dead.` };
    }
    v.drainFuel('battery', crankKj);
    // Maintenance faults (init_state destroyEngine) make it unreliable.
    if (fueled.some((e) => e.fault) && !this.rng.oneIn(3)) {
      this.emitSound(v, 20, 'the engine sputtering');
      return { ok: false, msg: `The ${v.name}'s engine sputters but doesn't start.` };
    }
    v.engineOn = true;
    v.version++;
    this.emitSound(v, Math.max(20, v.engineNoise(0.3)), 'the engine starting', 'engine_start');
    return { ok: true, msg: `The ${v.name}'s engine starts up.` };
  }

  /**
   * CDDA hotwire_car_activity_actor::finish: mechanics vs rng; a botched attempt sets off
   * the alarm (unless it's already wailing, in which case you find the wire by elimination).
   */
  finishHotwire(v: Vehicle, mechanics: number): string {
    const skill = Math.round(mechanics);
    if (skill > this.rng.int(1, 6)) {
      v.locked = false;
      return 'You found the wire that starts the engine.';
    }
    if (skill > this.rng.int(0, 4)) {
      v.alarmOn = v.hasSecurity();
      v.locked = false;
      return 'You found a wire that looks like the right one.';
    }
    if (!v.alarmOn) {
      v.alarmOn = v.hasSecurity();
      return "The red wire always starts the engine, doesn't it?";
    }
    v.locked = false;
    return 'By process of elimination, you found the wire that starts the engine.';
  }

  /** Hotwiring time, game seconds (vehicle_use.cpp: 6000 s / mechanics). */
  hotwireTime(mechanics: number): number {
    return 6000 / Math.max(1, mechanics);
  }

  stopEngine(v: Vehicle): string {
    if (!v.engineOn) return `The ${v.name}'s engine isn't running.`;
    v.engineOn = false;
    v.version++;
    this.emitSound(v, 10, 'the engine stopping', 'engine_stop');
    return `You turn the ${v.name}'s engine off.`;
  }

  toggleEngine(v: Vehicle): { ok: boolean; msg: string } {
    return v.engineOn ? { ok: true, msg: this.stopEngine(v) } : this.startEngine(v);
  }

  toggleHeadlights(v: Vehicle): string {
    if (!v.withFlag('CONE_LIGHT').length) return `The ${v.name} has no headlights.`;
    if (!v.lightsOn && v.fuelLeft('battery') <= 0) return `The ${v.name}'s battery is dead.`;
    v.lightsOn = !v.lightsOn;
    v.version++;
    return v.lightsOn ? 'Headlights turned on.' : 'Headlights turned off.';
  }

  honk(v: Vehicle): string {
    const horns = v.withFlag('HORN', true);
    if (!horns.length) return `The ${v.name} has no horn.`;
    if (v.fuelLeft('battery') <= 0) return `The ${v.name}'s horn is silent: the battery is dead.`;
    const vol = Math.max(...horns.map((h) => h.def.bonus ?? 40));
    this.emitSound(v, vol, 'honking!', 'horn_car', 'alert');
    return 'You honk the horn!';
  }

  /** Door/lid at a mount: open or close (CDDA vehicle::open / close). */
  toggleDoor(v: Vehicle, mx: number, my: number): string | null {
    const door = v.partsAt(mx, my).find((p) => has(p, 'OPENABLE'));
    if (!door) return null;
    // Multi-tile doors (trunk lids) open and close together (MULTISQUARE).
    const group = has(door, 'MULTISQUARE') ? v.parts.filter((p) => p.def.id === door.def.id && Math.abs(p.mx - mx) + Math.abs(p.my - my) <= 3) : [door];
    const opening = !door.open;
    if (!opening) {
      // Something standing in the doorway blocks it (CDDA "there's something in the way").
      for (const p of group) {
        const [wx, wy] = v.mountToWorld(p.mx, p.my);
        const pl = this.game.player;
        if (Math.floor(wx) === pl.tileX && Math.floor(wy) === pl.tileY) return `There's something in the way of the ${door.def.name}.`;
      }
    }
    for (const p of group) p.open = opening;
    v.version++;
    this.emitSound(v, 3, opening ? 'a door opening' : 'a door closing', opening ? 'vehicle_open' : 'vehicle_close');
    return `You ${opening ? 'open' : 'close'} the ${v.name}'s ${door.def.name}.`;
  }

  /**
   * Noise for monsters/audio. `cddaSfx` names the CDDA sound_effect this corresponds to;
   * the soundpack build excludes engine/vehicle effects for now, so events carry sfxId ''
   * (audio stays quiet, monsters still hear it). Wire cddaSfx through once they exist.
   */
  emitSound(v: Vehicle, volume: number, description: string, cddaSfx?: string, category: SoundCategory = 'movement'): void {
    if (volume <= 0) return;
    void cddaSfx;
    // The driver doesn't need "You hear vroom!" every second: engine/door noises are ambient.
    const ambient = category === 'movement' || this.driving === v;
    emitSound(this.game, { x: v.x, y: v.y, z: v.z }, volume, description, { source: v, category, sfxId: '', ambient });
  }

  // --- simulation ---------------------------------------------------------------------

  update(game: Game, realDt: number): void {
    this.simTime += realDt;
    if ((this.rescanAcc += realDt) > 2) {
      this.rescanAcc = 0;
      this.rescan();
    }
    if (this.pending.length) this.flushPending();
    if (this.driving && !this.scriptedInput) this.readKeys();
    for (const v of this.list) this.simulate(v, realDt);
  }

  private readKeys(): void {
    const k = this.game.input.held;
    const cap = this.game.input.captured;
    const f = (code: string) => (!cap && k.has(code) ? 1 : 0);
    this.input = { throttle: f('KeyW') - f('KeyS'), steer: f('KeyD') - f('KeyA'), brake: !!f('Space') };
  }

  /** Terrain drag multiplier under the vehicle's wheels (CDDA wheel_terrain_modifiers, simplified). */
  private offroad(v: Vehicle): number {
    const map = this.game.map;
    let rough = 0, n = 0;
    for (const w of v.wheels) {
      const [wx, wy] = v.mountToWorld(w.mx, w.my);
      const t = map.terAt(Math.floor(wx), Math.floor(wy), v.z);
      n++;
      if (!hasFlag(t, 'FLAT') && !hasFlag(t, 'ROAD')) rough++;
    }
    return n ? 1 + (3 * rough) / n : 1;
  }

  /** One physics step for a vehicle: forces, steering, movement with collisions, fuel. */
  simulate(v: Vehicle, dt: number): void {
    const driven = this.driving === v;
    const inp = driven ? this.input : { throttle: 0, steer: 0, brake: false };
    const hasPower = v.totalPower() > 0;
    // Electrics first: lights and dashboard drain even when parked.
    if (v.engineOn || v.lightsOn || v.parts.some((p) => p.enabled && has(p, 'ENABLED_DRAINS_EPOWER'))) {
      v.updateElectrics(dt);
      if (v.lightsOn && v.fuelLeft('battery') <= 0) {
        v.lightsOn = false;
        v.version++;
      }
    }
    if (v.alarmOn) {
      // CDDA: the alarm wails every turn at its part's loudness until it's disabled.
      const acc = (this.soundAcc.get(v) ?? 0) + dt;
      if (acc >= 1 && !v.engineOn) {
        const alarm = v.withFlag('SECURITY', true)[0];
        if (alarm && v.fuelLeft('battery') > 0) this.emitSound(v, alarm.def.bonus ?? 60, 'WHOOP WHOOP', 'alarm', 'alarm');
        else v.alarmOn = false;
        this.soundAcc.set(v, 0);
      } else if (!v.engineOn) this.soundAcc.set(v, acc);
    }
    if (!v.engineOn && Math.abs(v.velocity) < STOP_EPS && inp.throttle === 0 && inp.steer === 0) {
      v.velocity = 0;
      return;
    }

    const offroad = this.offroad(v);
    const mass = v.mass();
    const wheelsOk = v.validWheelConfig();
    let a = 0;
    let load = 0.05;
    const vel = v.velocity;
    if (wheelsOk && hasPower && inp.throttle > 0) {
      if (vel >= -0.5) {
        const acc = v.acceleration(vel, offroad);
        a += inp.throttle * acc;
        load = Math.min(1, inp.throttle);
      } else a += BRAKE_DECEL;
    } else if (inp.throttle < 0) {
      if (vel > 0.5) a -= BRAKE_DECEL;
      else if (wheelsOk && hasPower) {
        // Combustion engines are weak in reverse (max_reverse_velocity = max / 4).
        const electric = v.engines.every((e) => e.def.fuel_type === 'battery' || e.def.fuel_type === 'muscle');
        const maxRev = v.maxVelocity(false, offroad) * (electric ? 1 : 0.25);
        if (-vel < maxRev) a -= v.acceleration(vel, offroad) * 0.6;
        load = 0.5;
      }
    }
    if (inp.brake) a -= Math.sign(vel) * BRAKE_DECEL * 1.3;
    // Drag: CDDA's F = c_air v^2 + c_roll (33.3 + v); without intact wheels the vehicle
    // scrapes along on its frame and stops almost at once.
    const cAir = v.coeffAirDrag();
    const cRoll = wheelsOk ? v.coeffRollingDrag(offroad) : v.coeffRollingDrag(offroad) * 20;
    const drag = (cAir * vel * vel + cRoll * (33.3 + Math.abs(vel))) / mass;
    // Brakes (and the handbrake) only ever bring the vehicle to a stop, never reverse it.
    const braking = inp.brake || (inp.throttle < 0 && vel > 0.5) || (inp.throttle > 0 && vel < -0.5);
    let nv = vel + a * dt;
    const dragDv = drag * dt;
    if (nv > 0) nv = Math.max(0, nv - dragDv);
    else if (nv < 0) nv = Math.min(0, nv + dragDv);
    if (braking && vel !== 0 && Math.sign(nv) !== Math.sign(vel)) nv = 0;
    if (Math.abs(nv) < STOP_EPS && inp.throttle === 0) nv = 0;
    if (hasPower && Math.abs(nv) > 0.1) load = Math.max(load, Math.min(1, ((cAir * nv * nv + cRoll * (33.3 + Math.abs(nv))) * Math.abs(nv)) / v.totalPower()));
    v.velocity = nv;

    // Steering: bicycle model; the wheel angle eases toward the input and narrows with speed.
    const steerable = v.steerable() && wheelsOk;
    const maxSteer = MAX_STEER * Math.min(1, 9 / Math.max(1, Math.abs(nv)));
    const target = steerable ? inp.steer * maxSteer : 0;
    const rate = 2.5 * dt;
    v.steer += Math.max(-rate, Math.min(rate, target - v.steer));
    const yawRate = (nv * Math.tan(v.steer)) / v.wheelbase();
    const dFacing = (yawRate * dt * 180) / Math.PI;

    if (nv !== 0 || dFacing !== 0) this.move(v, nv * dt, dFacing);

    // Fuel: CDDA consume_fuel at the engine load; idling burns a little.
    if (v.engineOn) {
      v.consumeFuel(dt, load);
      this.load.set(v, load);
      if (!v.engines.some((e) => e.enabled && e.hp > 0 && v.engineHasFuel(e))) {
        v.engineOn = false;
        v.version++;
        if (driven) this.game.message(`The ${v.name}'s engine dies!`, 'c_red');
      }
      // Engine noise every second, like CDDA's per-turn vehicle sound.
      const acc = (this.soundAcc.get(v) ?? 0) + dt;
      if (acc >= 1) {
        const noise = v.engineNoise(load);
        this.emitSound(v, noise, engineSoundMsg(noise), 'engine_working_external');
        this.soundAcc.set(v, 0);
      } else this.soundAcc.set(v, acc);
    }
  }

  /**
   * Move/turn a vehicle by `dist` metres along its facing and `dFacing` degrees, in
   * substeps, colliding with anything in the tiles it newly enters. The driver (and anyone
   * standing inside) moves along.
   */
  move(v: Vehicle, dist: number, dFacing: number): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dist) / 0.3, Math.abs(dFacing) / 8)));
    const p = this.game.player;
    for (let i = 0; i < steps; i++) {
      const rad = (v.facing * Math.PI) / 180;
      const d = dist / steps;
      const nx = v.x + Math.cos(rad) * d, ny = v.y + Math.sin(rad) * d;
      const nf = v.facing + dFacing / steps;
      const before = new Set(this.tilesOf.get(v) ?? []);
      const riding = this.driving === v || before.has(tileKey(p.tileX, p.tileY, p.z));
      const [plx, ply] = riding ? v.worldToMount(p.x, p.y) : [0, 0];
      const stopped = this.collide(v, nx, ny, nf, before, riding);
      if (stopped) break;
      const oldFacing = v.facing;
      v.x = nx;
      v.y = ny;
      v.facing = ((nf % 360) + 360) % 360;
      this.reindex(v);
      if (riding) {
        const [wx, wy] = v.mountToWorld(plx, ply);
        p.x = wx;
        p.y = wy;
        // The view turns with the vehicle (yaw 0 = north; facing 0 = east, both clockwise).
        p.yaw += ((v.facing - oldFacing + 540) % 360 - 180) * (Math.PI / 180);
      }
    }
  }

  /**
   * Check the tiles a pose would newly occupy. Returns true if the vehicle was stopped
   * (it keeps its old pose); smashed obstacles and knocked-down creatures let it through.
   */
  private collide(v: Vehicle, nx: number, ny: number, nf: number, before: Set<number>, riding: boolean): boolean {
    const map = this.game.map;
    const p = this.game.player;
    const z = v.z;
    const mass = v.mass();
    const velBefore = v.velocity;
    let stopped = false;
    const pose = v.occupiedTiles(nf, nx, ny);
    const poseKeys = new Set(pose.map((t) => tileKey(t.tx, t.ty, z)));
    // Where a knocked-away body can land: off the vehicle's new footprint, walkable, empty.
    const free = (x: number, y: number) => !poseKeys.has(tileKey(x, y, z)) && !before.has(tileKey(x, y, z)) && map.passable(x, y, z) && !this.creatureHooks.at(x, y, z);
    for (const t of pose) {
      const k = tileKey(t.tx, t.ty, z);
      if (before.has(k)) continue;
      const part = collisionPart(v, t.mx, t.my);
      const dir = Math.sign(v.velocity) || 1;
      const rad = (nf * Math.PI) / 180;
      const fdx = Math.cos(rad) * dir, fdy = Math.sin(rad) * dir;
      // Another vehicle: treat as a heavy obstacle (no momentum transfer yet).
      const other = this.index.get(k);
      if (other && other.v !== v) {
        const r = resolveCollision({ mass, velocity: v.velocity, mass2: other.v.mass(), e: 0.3, partDens: 80 });
        this.damagePart(v, part, r.partDmg);
        const op = collisionPart(other.v, other.mx, other.my);
        this.damagePart(other.v, op, r.objDmg);
        this.impactMessage(v, part, `the ${other.v.name}`, 'smash!');
        this.emitSound(v, 50, 'smash!', 'smash_success', 'combat');
        v.velocity = Math.abs(r.velocity) < 0.3 ? 0 : r.velocity;
        stopped = true;
        break;
      }
      // The player standing in the way (not riding along).
      if (!riding && p.tileX === t.tx && p.tileY === t.ty && p.z === z && !p.dead) {
        const res = this.hitBody(v, part, {
          name: 'you', mass: 70, damage: (dmg) => {
            for (const bp of MAIN_PARTS) p.takeHit(bp as BodyPartId, [{ type: 'bash', amount: Math.round(dmg * (0.6 + this.rng.next() * 0.8)) }]);
            return p.dead;
          },
          fling: (force) => {
            const spot = this.flingSpot(t.tx + 0.5, t.ty + 0.5, fdx, fdy, force, free);
            if (!spot) return false;
            [p.x, p.y] = spot;
            return true;
          },
        });
        if (!res) {
          stopped = true;
          break;
        }
        continue;
      }
      const c = this.creatureHooks.at(t.tx, t.ty, z);
      if (c) {
        const h = this.creatureHooks;
        const res = this.hitBody(v, part, {
          name: `the ${h.name(c)}`, mass: h.mass(c), damage: (dmg) => h.damage(c, dmg, v),
          fling: (force) => {
            const spot = this.flingSpot(t.tx + 0.5, t.ty + 0.5, fdx, fdy, force, free);
            if (!spot) return false;
            h.place(c, spot[0], spot[1]);
            return true;
          },
        });
        if (!res) {
          stopped = true;
          break;
        }
        continue;
      }
      // Terrain / furniture (CDDA: bashable things that aren't flat floor, then walls).
      const ob = obstacleAt(map, t.tx, t.ty, z, v.partsAt(t.mx, t.my).some((q) => has(q, 'WHEEL')));
      if (!ob) continue;
      const name = ob.name;
      let smashedAny = false;
      const r = resolveCollision({
        mass, velocity: v.velocity, mass2: ob.mass2, e: ob.e, partDens: ob.dens,
        smash: ob.bashable ? (objDmg) => {
          if (!this.onBash(t.tx, t.ty, z, objDmg)) return false;
          smashedAny = true;
          // Whatever the bash left behind may still be in the way (wall -> broken wall).
          return !obstacleAt(map, t.tx, t.ty, z, false);
        } : undefined,
      });
      this.damagePart(v, part, r.partDmg);
      this.impactMessage(v, part, name, 'smash!');
      this.emitSound(v, r.smashed ? 80 : 50, 'smash!', 'smash_success', 'combat');
      v.velocity = r.velocity;
      if (!r.smashed) {
        if (Math.abs(v.velocity) < 0.5 || Math.sign(v.velocity) !== Math.sign(velBefore)) v.velocity = 0;
        stopped = true;
        if (smashedAny) v.version++;
        break;
      }
    }
    // The driver feels the jolt (vehicle_move.cpp throw_passenger).
    const dVel = Math.abs(velBefore - v.velocity) * MPH_PER_MS;
    if (dVel > 1 && this.driving === v) this.jolt(v, dVel);
    return stopped;
  }

  /**
   * CDDA fling_creature: thrown ahead at up to +-60 deg from the direction of travel, a
   * distance growing with the impact speed; the first free landing spot wins (null = pinned
   * against something, the vehicle has to stop).
   */
  private flingSpot(x: number, y: number, dx: number, dy: number, forceMph: number, free: (tx: number, ty: number) => boolean): [number, number] | null {
    const dist = Math.max(1, Math.min(6, Math.round(forceMph / 10)));
    const side = this.rng.oneIn(2) ? 1 : -1;
    for (const deg of [30 * side, -30 * side, 60 * side, -60 * side, 90 * side, -90 * side]) {
      const a = (deg * Math.PI) / 180;
      const ux = dx * Math.cos(a) - dy * Math.sin(a), uy = dx * Math.sin(a) + dy * Math.cos(a);
      for (let d = dist; d >= 1; d--) {
        const px = x + ux * (d + 0.6), py = y + uy * (d + 0.6);
        if (free(Math.floor(px), Math.floor(py))) return [Math.floor(px) + 0.5, Math.floor(py) + 0.5];
      }
    }
    return null;
  }

  private hitBody(v: Vehicle, part: VehiclePart, target: { name: string; mass: number; damage: (dmg: number) => boolean; fling: (force: number) => boolean }): boolean {
    let dead = false, flung = false;
    const r = resolveCollision({
      mass: v.mass(), velocity: v.velocity, mass2: target.mass, e: 0.3, partDens: 15, body: true,
      smash: (objDmg) => {
        const dam = Math.round((objDmg * (part.def.damage_modifier ?? 100)) / 100);
        if (dam > 0) dead = target.damage(dam) || dead;
        // Fling when the vehicle hits hard enough (CDDA: |vel2_a| > 10 mph or momentum).
        const vmph = Math.abs(v.velocity) * MPH_PER_MS;
        if (!dead && vmph > 5) flung = target.fling(vmph);
        return dead || flung;
      },
    });
    this.damagePart(v, part, r.partDmg);
    if (r.objDmg > 20) part.blood = Math.min(600, part.blood + 50 + r.objDmg * 2.5);
    if (this.driving === v) this.say(`Your ${v.name}'s ${part.def.name} rams into ${target.name}!`, 'c_yellow');
    this.emitSound(v, 20, 'smash!', 'hit_vehicle', 'combat');
    v.velocity = r.velocity;
    if (!(dead || flung)) {
      v.velocity = 0;
      return false;
    }
    return true;
  }

  private impactMessage(v: Vehicle, part: VehiclePart, what: string, snd: string): void {
    if (this.driving === v) this.say(`Your ${v.name}'s ${part.def.name} rams into ${what} with a ${snd}`, 'c_yellow');
  }

  private lastSaid = { text: '', t: -Infinity };
  private simTime = 0;
  /** Driver messages, minus repeats of the same text within a second (pushing into a tree). */
  private say(text: string, color?: string): void {
    if (text === this.lastSaid.text && this.simTime - this.lastSaid.t < 1) return;
    this.lastSaid = { text, t: this.simTime };
    this.game.message(text, color);
  }

  private jolt(v: Vehicle, dVelMph: number): void {
    const seat = v.driverSeat();
    const belt = seat ? v.partsAt(seat.mx, seat.my).find((q) => has(q, 'SEATBELT') && q.hp > 0) : undefined;
    const dmg = passengerImpactDamage(dVelMph, belt?.def.bonus ?? 0, this.rng);
    if (dmg > 0) {
      this.game.player.takeHit('torso', [{ type: 'bash', amount: dmg }]);
      this.game.message(`You take ${dmg} damage by the power of the impact!`, 'c_red');
    }
  }

  /** CDDA vehicle::damage_direct: reduced by the part's damage_reduction, may break it. */
  damagePart(v: Vehicle, part: VehiclePart, dmg: number): void {
    const dr = part.def.damage_reduction?.bash ?? part.def.damage_reduction?.all ?? 0;
    const d = Math.round(dmg - dr);
    if (d <= 0 || part.hp <= 0) return;
    part.hp = Math.max(0, part.hp - d);
    v.version++;
    if (part.hp === 0) {
      if (this.driving === v) this.game.message(`The ${v.name}'s ${part.def.name} is destroyed!`, 'c_red');
      // A destroyed tank spills its fuel; a dead engine stalls.
      if (has(part, 'FLUIDTANK') || has(part, 'BATTERY')) part.charges = 0;
      if (has(part, 'ENGINE') && !v.engines.some((e) => e.hp > 0)) v.engineOn = false;
      // Cargo of a destroyed part falls to the ground.
      if (part.items.length) {
        const [wx, wy] = v.mountToWorld(part.mx, part.my);
        for (const it of part.items) this.game.map.addItem(Math.floor(wx), Math.floor(wy), v.z, it);
        part.items = [];
      }
    }
  }

  // --- persistence ----------------------------------------------------------------------

  toJSON(): VehicleSaveJSON {
    return { vehicles: this.list.map((v) => v.toJSON()), driving: this.driving?.uid ?? null, pending: [...this.pending] };
  }

  /** Replace all vehicle state (save/load). Unknown prototypes/parts are dropped via `warn`. */
  fromJSON(data: GameData, j: VehicleSaveJSON, opts: { warn?: (msg: string) => void; loadItem?: (j: ItemJSON) => Item | null } = {}): void {
    this.clear();
    for (const vj of j.vehicles ?? []) {
      if (!this.vdata.vehicles[vj.proto]) {
        (opts.warn ?? console.warn)(`dropped vehicle of unknown prototype ${vj.proto}`);
        continue;
      }
      this.add(Vehicle.fromJSON(this.vdata, data, vj, opts));
    }
    this.pending = [...(j.pending ?? [])];
    this.driving = this.list.find((v) => v.uid === j.driving) ?? null;
    if (this.driving) this.game.movementOverride = () => this.driving !== null;
  }

  /** Remove every vehicle and forget queued requests. */
  clear(): void {
    for (const v of [...this.list]) this.remove(v);
    this.pending = [];
    this.driving = null;
    this.input = { throttle: 0, steer: 0, brake: false };
    this.soundAcc.clear();
    this.load.clear();
  }
}

/**
 * Run-over hooks backed by the monster system (src/game/monai.ts): CDDA part_collision's
 * body branch applies torso damage, may stun, and flings the critter away.
 */
export function monsterCreatureHooks(ms: MonsterSystem): CreatureHooks {
  return {
    at: (x, y, z) => ms.monsterAt(x, y, z),
    mass: (c) => Math.max(1, ((c as Monster).type.weight ?? 80000) / 1000),
    damage: (c, dmg) => {
      const m = c as Monster;
      const stun = (m.rng.int(0, dmg) > 10 ? 1 : 0) + (m.rng.int(0, dmg) > 40 ? 1 : 0);
      if (stun) m.addEffect('stunned', stun / ACTION_SCALE);
      ms.hurt(m, dmg, 'player');
      return m.dead;
    },
    place: (c, x, y) => {
      const m = c as Monster;
      m.x = x;
      m.y = y;
      m.addEffect('downed', 1);
    },
    name: (c) => (c as Monster).displayName(),
  };
}

export interface VehicleSaveJSON {
  vehicles: VehicleJSON[];
  /** uid of the vehicle the player is driving */
  driving: number | null;
  /** mapgen requests queued but not yet placed */
  pending: VehicleRequest[];
}

/**
 * Plug vehicles into save/load (src/save/registry.ts). Order 30: after the map (0) and the
 * player (10), since the driver is restored into the seat they were saved in.
 */
export function registerVehicleSave(game: Game, vs: VehicleSystem): void {
  vs.skipChunk = (c) => chunkTracker(game)?.priorGenerated.has(chunkKey(c.cx, c.cy, c.z)) ?? false;
  registerSaveable<VehicleSaveJSON>(game, 'vehicles', {
    order: 30,
    // Round-trip through JSON so the section is plain data (Item.toJSON etc.).
    save: () => JSON.parse(JSON.stringify(vs.toJSON())),
    load: (data, ctx) => vs.fromJSON(ctx.data, data, { warn: ctx.warn, loadItem: (j) => loadItemSafe(ctx.data, j, ctx.warn) }),
    missing: () => vs.clear(),
  });
}

// CDDA vehicle.cpp engine sound messages by noise level.
const ENGINE_MSGS = ['hmm', 'hummm!', 'whirrr!', 'vroom!', 'roarrr!', 'ROARRR!', 'BRRROARRR!', 'BRUMBRUMBRUMBRUM!'];
function engineSoundMsg(noise: number): string {
  const lvl = Math.max(0, Math.min(ENGINE_MSGS.length - 1, Math.floor(noise / 10)));
  return ENGINE_MSGS[lvl];
}

/** Which part takes the hit at a mount: armor first, then whatever blocks, then the frame. */
function collisionPart(v: Vehicle, mx: number, my: number): VehiclePart {
  const list = v.partsAt(mx, my);
  return list.find((p) => has(p, 'ARMOR') && p.hp > 0)
    ?? list.find((p) => has(p, 'OBSTACLE') && p.hp > 0)
    ?? list.find((p) => p.def.location === 'structure')
    ?? list[0];
}

export interface Obstacle {
  name: string;
  bashable: boolean;
  mass2: number;
  dens: number;
  e: number;
}

/**
 * What a vehicle part hits in a tile (vehicle_move.cpp part_collision): bashable terrain/
 * furniture that isn't flat floor (tiny things only under wheels), else impassable things.
 */
export function obstacleAt(map: GameMap, x: number, y: number, z: number, wheel: boolean): Obstacle | null {
  const t = map.terAt(x, y, z), f = map.furnAt(x, y, z);
  const moveCost = t.move_cost <= 0 || f.move_cost_mod < 0 ? 0 : t.move_cost + Math.max(0, f.move_cost_mod);
  const flags = (d: TerrainDef | FurnitureDef, fl: string) => hasFlag(d, fl);
  const tiny = flags(t, 'TINY') || (f.id !== 'f_null' && flags(f, 'TINY'));
  const nocollide = flags(t, 'NOCOLLIDE') || (f.id !== 'f_null' && flags(f, 'NOCOLLIDE'));
  const bashDef = f.id !== 'f_null' && wallBash(f) ? f : wallBash(t) ? t : null;
  if (bashDef && bashDef.bash && moveCost !== 2 && (wheel || !tiny) && !nocollide) {
    const b = bashDef.bash;
    return { name: `the ${bashDef.name}`, bashable: true, mass2: (b.str_min + b.str_max) / 2, dens: b.str_min, e: 0.3 };
  }
  if (moveCost === 0) return { name: `the ${f.id !== 'f_null' && f.move_cost_mod < 0 ? f.name : t.name}`, bashable: false, mass2: 1000, dens: 80, e: 0.1 };
  return null;
}

/**
 * CDDA is_bashable_ter_furn(p, allow_floor = false): floor-only bashes (grass, pavement,
 * "bash_below") don't count. The extractor currently drops bash_below, so FLAT terrain
 * (walkable ground) stands in for it.
 */
function wallBash(d: TerrainDef | FurnitureDef): boolean {
  if (!d.bash || d.bash.bash_below) return false;
  return !('move_cost' in d && hasFlag(d, 'FLAT'));
}

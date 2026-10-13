import { hashSeed, Rng } from '../core/rng';
import { BALANCE } from './balance';
import { bash } from './bash';
import { ACTION_SCALE } from '../core/time';
import type { MonsterSystem } from './monai';
import { turnsToEffectSeconds, type Monster } from './monster';
import type { Npc } from './npc';
import type { NpcSystem } from './npcai';
import { emitSound, type SoundCategory } from './sound';
import { EngineSounds, engineVariant, hornVariant, pickVariant } from '../audio/vehicleAudio';
import { MAIN_PARTS, type BodyPartId } from './bodyparts';
import type { GameData, TerrainDef, FurnitureDef } from '../data/types';
import type { Chunk, GameMap, MapOverlay, VehicleRequest } from '../world/map';
import {
  circleHitsBody, circleTouchesBody, clampToObb, mountSolid, nearestMount, obbBounds, obbContact, obbHitsObb, obbHitsTile, pointInBody, rectObb, vehicleObbs, type BodyRect, type Obb,
} from './vehicleShape';
import { CREATURE_RADIUS } from './physics';
import { hasFlag } from '../world/registry';
import { chunkKey, chunkOf } from '../world/coords';
import { registerSaveable } from '../save/registry';
import { chunkTracker } from '../save/tracking';
import { loadItemSafe } from '../save/items';
import { L, moveItem } from './moves';
import type { Item, ItemJSON } from './item';
import type { Game, GameSystem } from './game';
import {
  CRUISE_STEP_VMIPH, has, MPH_PER_MS, passengerImpactDamage, VMIPH_PER_MS, resolveBodyCollision, resolveCollision, spawnVehicle, Vehicle, type VehicleJSON, type VehiclePart,
} from './vehicle';
import { pickVehicleProto, type VehicleDataFile } from './vehicle_data';
import { chassisOf, hitMount, seatPoint } from './chassis';
import { VehicleStations, type Station } from './vehwalk';
import { warnOnce } from '../data/warn';
import { launchFromImpact, planFling, RUNOVER, type FlingWorld, type RunoverImpact, type RunoverMode } from './runoverFling';
import { updateVehiclePower } from './vehiclePower';

/** Game seconds of vehicle power upkeep batched together (0.2 real s at CLOCK_SCALE 24). */
const POWER_STEP = 5;
import { TowSystem, type TowLinkJSON } from './towing';
import {
  boxInertia, contactImpulse, crashDamage, SKID_COUNTER, SKID_MIN_MPH, SKID_MIN_SPIN, SKID_TIME, damageShare, decayMotion, handlingFor, MAX_SLIDE, MAX_SPIN, motionOf, obbNormal, settled, stopMotion, tileObb, trackTopSpeed,
  VEHICLE_FRICTION, VEHICLE_RESTITUTION, WALL_FRICTION, WALL_RESTITUTION, type ContactBody, type CrashModel, type Handling, type HandlingMode,
} from './vehicleImpact';

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

/**
 * How W/S drive. 'direct' (the default) is a plain accelerator pedal: W accelerates while
 * held, releasing it coasts, S brakes then reverses, and the cruise-control key locks the
 * current speed. 'cruise' is CDDA's model: each press moves the cruise target by 4 mph and
 * the engine accelerates/brakes toward it (vehicle::cruise_thrust + thrust). In real time
 * CDDA's model felt indirect and laggy (the target lags the key), so it's an option only.
 */
export type DriveMode = 'cruise' | 'direct';

// --- direct-driving feel ----------------------------------------------------------------
// CDDA's ground_acceleration is power / (mass * v): turn-based it never mattered that a car
// hits 30 mph in ~2 s and a sports car in 0.5 s, but in real time that's a slingshot. The
// launch acceleration is compressed toward a car-like figure (0-30 mph in ~4 s) keeping the
// ordering between vehicles and the CDDA falloff with speed.
/** Felt launch acceleration (m/s^2) of a CDDA reference car (CDDA acceleration ~6.5 at rest). */
const FELT_ACC_REF = 3.4;
const CDDA_ACC_REF = 6.5;
/** Throttle pedal ramp (per second): quick, but not a step. */
const THROTTLE_RAMP_UP = 6;
const THROTTLE_RAMP_DOWN = 10;
/** Off-throttle deceleration (engine braking + drivetrain), m/s^2, on top of CDDA drag. */
const COAST_DECEL = 0.8;
/** S held at a standstill this long before it engages reverse (so braking to a stop doesn't
 *  shoot straight into reverse). */
const REVERSE_DELAY = 0.25;
/** Lateral acceleration the steering allows (m/s^2): caps the wheel angle at speed. */
const LAT_ACC_MAX = 5.5;
/** Seconds to reach full available lock / to recentre. */
const STEER_IN_TIME = 0.45;
const STEER_OUT_TIME = 0.25;
/**
 * Skid-steer pivot for tracked vehicles. BN only turns a vehicle as it moves; a tank that
 * can't spin on the spot feels broken (and the driving brief is arcade feel over fidelity),
 * so tracks add a pivot that fades out by PIVOT_FADE m/s, where the bicycle model's turning
 * takes over. Its rate and spool-up come from power-to-weight and mass (vehicleImpact.ts
 * handlingFor: ~32 deg/s after ~1.3 s on an Abrams; a flat 40 deg/s with handling 'light').
 */
const PIVOT_FADE = 6;

/**
 * Launch acceleration the driver feels for a vehicle whose CDDA acceleration at rest is
 * `cddaAcc` (m/s^2): a gentle power curve through the reference car, clamped so a semi
 * isn't hopeless and a sports car isn't a catapult.
 */
export function feltAcceleration(cddaAcc: number): number {
  if (cddaAcc <= 0) return 0;
  return Math.max(1.2, Math.min(5, FELT_ACC_REF * Math.pow(cddaAcc / CDDA_ACC_REF, 0.3)));
}

/** Largest front-wheel angle (rad) at `speed` m/s for a wheelbase: full lock when slow,
 *  narrowing so the lateral acceleration stays under LAT_ACC_MAX (no twitchiness at speed). */
export function maxSteerAt(speed: number, wheelbase: number, latScale = 1): number {
  const v2 = speed * speed;
  if (v2 < 1e-6) return MAX_STEER;
  return Math.min(MAX_STEER, Math.atan((LAT_ACC_MAX * latScale * Math.max(0.5, wheelbase)) / v2));
}

/**
 * Held W/S repeat the cruise step after this delay, then every CRUISE_REPEAT seconds (8 mph/s):
 * slow enough that a held key can't outrun the driver's reactions.
 */
const CRUISE_REPEAT_DELAY = 0.4;
const CRUISE_REPEAT = 0.5;

export interface CreatureHooks {
  /** Creature standing in a tile (not the player). Defaults to game.creatureAt. */
  at(x: number, y: number, z: number): unknown | null;
  /** kg, for the collision maths (CDDA monster weight). */
  mass(c: unknown): number;
  /** Max HP (BN caps a part's damage from one body at it); default 100. */
  hpMax?(c: unknown): number;
  /** Apply run-over damage (before the creature's own armor); return true if it died. */
  damage(c: unknown, dmg: number, v: Vehicle): boolean;
  /** Put a flung creature down at world point (x, y) (the system picks a free spot). */
  place(c: unknown, x: number, y: number): void;
  name(c: unknown): string;
  /** How messages refer to it ("the zombie", "Bernard Andrews"); default `the ${name}`. */
  title?(c: unknown): string;
  /**
   * Run-over flights (runoverFling.ts, `runoverMode` 'ragdoll' / 'loose'): plan the throw before
   * the damage lands, so a body the hit kills comes down where the flight ends. false = this
   * creature can't be thrown that way (BN's teleport `place` is used instead).
   */
  planFling?(c: unknown, impact: RunoverImpact, world: FlingWorld): boolean;
  /** The hit threw it and it lived: start the planned flight. */
  launch?(c: unknown): void;
  /** The planned throw didn't happen (too slow to fling: it stopped the vehicle). */
  cancelFling?(c: unknown): void;
}

export interface VehicleOccupant {
  v: Vehicle;
  mx: number;
  my: number;
}

/** A vehicle's whole grid as a mount-space box (its cells' outer edges). */
function gridRect(v: Vehicle): BodyRect {
  const [x0, y0, x1, y1] = v.bounds();
  return { x0: x0 - 0.5, x1: x1 + 0.5, y0: y0 - 0.5, y1: y1 + 0.5 };
}

/** The body outline shrunk to one mount's cell (so circleHitsBody tests only that door). */
function doorOnly(b: BodyRect, mx: number, my: number): BodyRect {
  return mountSolid(b, mx, my) ?? { x0: mx, x1: mx, y0: my, y1: my };
}

const tileKey = (x: number, y: number, z: number): number => ((x + 1048576) * 2097152 + (y + 1048576)) * 64 + (z + 32);

/** Speed at which a vehicle is considered stopped, m/s. */
const STOP_EPS = 0.05;
/** Max front-wheel angle, rad. */
const MAX_STEER = 0.6;
/**
 * Shaped bodies: longest substep (m) and largest turn per substep (deg). The thinnest body a
 * car can meet is a bicycle's (~0.6 m across), so 0.25 m steps can't skip over one at any
 * speed; 4 deg swings a 5.6 m car's corner ~0.2 m.
 */
const BODY_STEP = 0.25;
const BODY_TURN_STEP = 4;
/** A vehicle pushing another aside with its drawn body at the pose it's moving to. */
interface Pusher {
  v: Vehicle;
  obb: Obb;
}
/** Brake deceleration, m/s^2 (CDDA brakes shed ~30% of max speed per turn; 30 mph to 0 in ~1.7 s). */
const BRAKE_DECEL = 8;
/** Momentum crashes: a contact closing slower than this (m/s) is resting, not a hit. */
const CLOSING_MIN = 0.05;
/** Momentum crashes: share of a crash's spin the vehicle you drive actually takes. */
const DRIVER_SPIN_SCALE = 0.5;
/** Momentum crashes: closing slower than this (mph) is pushing, not a crash: no message or bang. */
const PUSH_QUIET_MPH = 4;
/** Momentum crashes: below this change in your own speed (mph) a jolt never kills. */
const LETHAL_JOLT_MPH = 35;

/** How far from the driver's seat "take the controls" still climbs you in (tiles). */
export const GET_IN_RANGE = 3.2;

export class VehicleSystem implements GameSystem, MapOverlay {
  /**
   * The body outline of a vehicle in mount space (vehicleShape.ts): its chassis template's
   * (chassisBodyRect, src/game/chassis), which is also what the modelled look draws. The
   * renderer sets it for the modelled look; null = collide with whole grid tiles (the parts
   * look, headless). Bump `shapeEpoch` when the answer changes for reasons other than
   * vehicle.version.
   */
  bodyShape: ((v: Vehicle) => BodyRect | null) | null = null;
  shapeEpoch = 0;
  private shapeCache = new WeakMap<Vehicle, { version: number; epoch: number; rect: BodyRect | null }>();
  readonly name = 'vehicles';
  readonly list: Vehicle[] = [];
  /**
   * Tile -> the vehicles whose grids cover it. Usually one; with drawn bodies (narrower than
   * their grids) two cars can park or pass with their paint apart but their grids overlapping.
   */
  private index = new Map<number, VehicleOccupant[]>();
  private tilesOf = new Map<Vehicle, number[]>();
  private pending: VehicleRequest[] = [];
  /** Vehicle the player is driving (at the controls), if any. */
  driving: Vehicle | null = null;
  /** Inside a vehicle without driving it: its seats / aisle / doors / hatches (src/game/vehwalk.ts). */
  readonly stations = new VehicleStations(this);
  /** Tow cables between vehicles (src/game/towing.ts): a rope constraint applied after every vehicle moves. */
  readonly towing = new TowSystem(this);
  /** WASD doesn't walk while driving or at a station (the stations read the keys for hops). */
  private readonly holdMove = () => this.driving !== null || this.stations.at !== null;
  /** Latest driving input (read from held keys each tick while driving; tests set it). */
  input: DriveInput = { throttle: 0, steer: 0, brake: false };
  /** When true, `input` is not overwritten from the keyboard (cdda.drive, tests). */
  scriptedInput = false;
  /** Driving model (options screen "Driving controls"). */
  driveMode: DriveMode = 'direct';
  /** Direct driving: cruise control engaged (the cruise key); holds v.cruiseVelocity. */
  cruiseOn = false;
  /** Direct driving: the pedal position, ramping toward the held W. */
  private pedal = 0;
  /** Direct driving: seconds S has been held at a standstill (reverse engages after REVERSE_DELAY). */
  private reverseHeld = 0;
  /** Cruise-key state: sign of the held W/S and seconds until it repeats. */
  private cruiseHeld = 0;
  private cruiseRepeatIn = 0;
  /** A held key stops repeating at the safe speed; a fresh press is needed to go past it. */
  private cruiseHeldAtSafe = false;
  readonly rng: Rng;
  creatureHooks: CreatureHooks;
  /** Bash a tile with `strength`; return true if it broke (default: bash.ts, CDDA map::bash). */
  onBash: (x: number, y: number, z: number, strength: number) => boolean;
  /** Listeners: vehicle added/removed (renderer). */
  readonly onAdded: ((v: Vehicle) => void)[] = [];
  readonly onRemoved: ((v: Vehicle) => void)[] = [];
  private soundAcc = new Map<Vehicle, number>();
  /**
   * Game seconds of power/cargo upkeep (vehiclePower.ts) owed per vehicle. Upkeep walks every
   * part and cargo item; done each frame for every parked car in town it cost ~0.35 ms/frame
   * (perf-bench horde, Chromium). It integrates any span exactly (1 s steps inside), so it runs
   * once POWER_STEP game seconds are owed, staggered by uid so the cars don't all pay in the
   * same frame. Long waits (time warp) owe more than a step at once and run at once.
   */
  private powerOwed = new WeakMap<Vehicle, number>();
  /** Running-engine loops that follow the vehicles (no-op without audio). */
  readonly engineSounds = new EngineSounds((v) => this.speedLimits(v as Vehicle).safe);
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
    // The driver's own crash isn't narrated back as "You hear whump!" (the impact message says it).
    this.onBash = (x, y, z, strength) => bash(game, x, y, z, Math.round(strength), { source: this.driving ? game.player : this }).success;
    map.onChunkGenerated.push((c) => this.queueChunk(c));
    // update_mapgen on a live chunk: its new vehicles are new even if the chunk is from a save.
    map.onChunkUpdated.push((c) => {
      this.pending.push(...c.vehicles);
      c.vehicles = [];
    });
    for (const c of map.loadedChunks()) this.queueChunk(c);
  }

  // --- MapOverlay -----------------------------------------------------------------------

  moveCost(x: number, y: number, z: number): number | undefined {
    const list = this.index.get(tileKey(x, y, z));
    if (!list) return undefined;
    let c = 0;
    for (const o of list) {
      const m = o.v.moveCostAt(o.mx, o.my);
      if (m === 0) return 0;
      c = Math.max(c, m);
    }
    return c;
  }
  opaque(x: number, y: number, z: number): boolean | undefined {
    const list = this.index.get(tileKey(x, y, z));
    return list ? list.some((o) => o.v.opaqueAt(o.mx, o.my)) : undefined;
  }

  /**
   * What driving crashes (vehicle vs terrain / vehicle) test: 'body' = the drawn body where
   * there is one (default), 'tiles' = CDDA's whole tiles even in the modelled look (the
   * pre-wave-3 behaviour, kept for comparison: cdda.vehicleCrashes('tiles')). Creatures,
   * run-overs and `playerOn` follow the body either way.
   */
  crashGeometry: 'body' | 'tiles' = 'body';
  /**
   * What a vehicle-vs-vehicle crash does (vehicleImpact.ts): 'momentum' (default) exchanges an
   * impulse, pushing and spinning both; 'immovable' is the old model (the other vehicle stops
   * you like a wall; light ones are teleport-shoved). Options > Vehicle crashes, ?vehcrash=.
   */
  crashModel: CrashModel = 'momentum';
  /** Heavy / tracked handling (vehicleImpact.ts handlingFor): Options > Heavy vehicles, ?vehheft=. */
  handlingMode: HandlingMode = 'weighty';
  /**
   * What a run-over does to the body (runoverFling.ts): 'loose' (default) / 'ragdoll' throw it
   * along a planned flight (the renderer tumbles it loosely / stiffly), 'fall' is BN's teleport to a
   * free tile a few tiles ahead. Options > Run-over bodies, ?runover=.
   */
  runoverMode: RunoverMode = 'loose';
  /** Vehicles already moved this frame (a crash can move the one it hit early: advanceStruck). */
  private moved = new Set<Vehicle>();
  /** This frame's dt (s), for moving a struck vehicle out of the way mid-frame. */
  private frameDt = 1 / 60;
  /** The normal of the momentum contact that just stopped a substep (move slides along it). */
  private contactN: [number, number] | null = null;
  private crashBody(v: Vehicle): BodyRect | null {
    if (this.crashGeometry !== 'body') return null;
    const b = this.bodyRect(v);
    if (b || !this.bodyShape || this.crashModel !== 'momentum') return b;
    // No drawn outline (tanks, APCs, frame builds collide on their cells): momentum crashes
    // still want a box to bisect to the touch and take contact normals from, so a grid that's
    // nearly full (armoured hulls ~0.85-0.95) crashes as its outline. Sparse ones (aircraft,
    // L-shaped rigs) keep whole tiles rather than hit with empty corners.
    let full = this.fullGrid.get(v);
    if (!full || full.version !== v.version) {
      const [x0, y0, x1, y1] = v.bounds();
      const cells = new Set<number>();
      for (const p of v.parts) cells.add((p.mx + 512) * 1024 + p.my + 512);
      this.fullGrid.set(v, (full = { version: v.version, full: cells.size >= 0.8 * (x1 - x0 + 1) * (y1 - y0 + 1) }));
    }
    return full.full ? gridRect(v) : null;
  }
  private fullGrid = new WeakMap<Vehicle, { version: number; full: boolean }>();

  /** The body outline collision uses for `v`, or null for whole tiles. */
  bodyRect(v: Vehicle): BodyRect | null {
    if (!this.bodyShape) return null;
    const c = this.shapeCache.get(v);
    if (c && c.version === v.version && c.epoch === this.shapeEpoch) return c.rect;
    const rect = this.bodyShape(v);
    this.shapeCache.set(v, { version: v.version, epoch: this.shapeEpoch, rect });
    return rect;
  }
  shaped(x: number, y: number, z: number): boolean {
    const list = this.index.get(tileKey(x, y, z));
    return !!list && list.every((o) => this.bodyRect(o.v) !== null);
  }
  collide(x: number, y: number, z: number, r: number): boolean {
    if (!this.bodyShape || !this.list.length) return false;
    // A rotated body pokes a little past its tiles: look one tile further out.
    const seen = new Set<Vehicle>();
    for (let ty = Math.floor(y - r) - 1; ty <= Math.floor(y + r) + 1; ty++)
      for (let tx = Math.floor(x - r) - 1; tx <= Math.floor(x + r) + 1; tx++) {
        for (const o of this.index.get(tileKey(tx, ty, z)) ?? []) {
          if (seen.has(o.v)) continue;
          seen.add(o.v);
          const b = this.bodyRect(o.v);
          if (b && circleHitsBody(o.v, b, x, y, r)) return true;
        }
      }
    return false;
  }
  /**
   * The vehicle a creature at world (x, y) is *in* (standing on a walkable mount, or inside
   * the drawn body), not merely in a tile of: with shaped bodies you can stand in the edge
   * of a door's tile, outside the car.
   */
  occupantAt(x: number, y: number, z: number): VehicleOccupant | null {
    const list = this.index.get(tileKey(Math.floor(x), Math.floor(y), z)) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const b = this.bodyRect(list[i].v);
      if (!b || pointInBody(list[i].v, b, x, y)) return list[i];
    }
    return null;
  }

  // --- registry -----------------------------------------------------------------------

  /**
   * The vehicle + mount at a tile. Where two grids share the tile (shaped bodies side by
   * side), the one whose drawn body covers the tile centre.
   */
  at(x: number, y: number, z: number): VehicleOccupant | null {
    const list = this.index.get(tileKey(x, y, z));
    if (!list) return null;
    // Latest indexed first (the vehicle that moved or spawned there last), as when one entry
    // per tile was simply overwritten.
    if (list.length > 1)
      for (let i = list.length - 1; i >= 0; i--) {
        const b = this.bodyRect(list[i].v);
        if (b && pointInBody(list[i].v, b, x + 0.5, y + 0.5)) return list[i];
      }
    return list[list.length - 1];
  }

  /** Grid vehicles mapped onto a template on load (saves from before vehicles v3). */
  migrated = 0;

  add(v: Vehicle): void {
    // Every vehicle entering the world is on a chassis template (mapgen spawns, saves,
    // debug spawns). Parts the template has no socket for stay on (and in) the vehicle.
    const ch = chassisOf(v);
    if (ch.overflow.length) warnOnce('chassis_overflow', v.protoId, `[chassis] ${v.protoId} on ${ch.template}: ${ch.overflow.length} part(s) off-template, kept: ${ch.overflow.map((o) => `${o.part.def.id} (${o.reason})`).join('; ')}`);
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
    for (const k of this.tilesOf.get(v) ?? []) {
      const list = this.index.get(k);
      if (!list) continue;
      const rest = list.filter((o) => o.v !== v);
      if (rest.length) this.index.set(k, rest);
      else this.index.delete(k);
    }
    this.tilesOf.delete(v);
  }

  /** Recompute the tiles a vehicle covers (after it moved or turned). */
  reindex(v: Vehicle): void {
    this.unindex(v);
    const keys: number[] = [];
    for (const t of v.occupiedTiles()) {
      const k = tileKey(t.tx, t.ty, v.z);
      keys.push(k);
      const o = { v, mx: t.mx, my: t.my };
      const list = this.index.get(k);
      if (list) list.push(o);
      else this.index.set(k, [o]);
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
      if (ter.move_cost <= 0 || furn.move_cost_mod < 0 || this.overlayBlocks(t.tx, t.ty, v.z)) return false;
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
    return this.occupantAt(p.x, p.y, p.z);
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
          const here = this.playerOn();
          if (!here || here.v !== o.v) continue;
        }
        return o.v;
      }
    return null;
  }

  /**
   * Climbing in from beside the vehicle: in first person, standing exactly on the driver's
   * tile is fiddly, so "take the controls" works within GET_IN_RANGE tiles of the driver's
   * seat. It opens the closest door by the seat (as the player would) and fails with a
   * reason when that isn't possible.
   */
  getInReason(v: Vehicle): string | null {
    const c = v.controls();
    if (!c) return `The ${v.name} has no controls.`;
    const p = this.game.player;
    if (this.reachableControls() === v) return null;
    const [wx, wy] = this.driverSeatWorld(v);
    if (p.z !== v.z || Math.hypot(wx - p.x, wy - p.y) > GET_IN_RANGE) return `Get closer to the ${v.name}'s driver's seat.`;
    return null;
  }

  /**
   * Whether `e` on mount (mx, my) of `v` should mean "get in and drive" rather than examining
   * that part. QA: `e` on a car opened a door or a parts menu, and taking the controls was
   * `^` (Shift+6), which no newcomer finds. Driving is the obvious action when the driver's
   * seat is in reach, except on a door or cargo away from the driver (rear doors, the trunk,
   * the passenger side): those keep their own action, and everything stays in the context menu.
   */
  driveOffer(v: Vehicle, mx: number, my: number): boolean {
    if (this.driving) return false;
    const c = v.controls();
    if (!c || c.hp <= 0 || this.getInReason(v) !== null) return false;
    const parts = v.partsAt(mx, my);
    // An open (side) door is the way in: offer to get in wherever you open one (playtest:
    // `e` at the open passenger door closed it again). Closing stays in the context menu.
    if (parts.some((q) => has(q, 'OPENABLE') && q.open && !has(q, 'MULTISQUARE'))) return true;
    const ownAction = parts.some((q) => has(q, 'OPENABLE') || has(q, 'CARGO'));
    // Manhattan 1: the driver's own door counts, the rear door diagonally behind it doesn't.
    return !ownAction || Math.abs(mx - c.mx) + Math.abs(my - c.my) <= 1;
  }

  /** The vehicle whose driver's seat the player can take from here (inside or beside it), nearest first. */
  enterableControls(): Vehicle | null {
    const inside = this.reachableControls();
    if (inside) return inside;
    let best: Vehicle | null = null;
    let bestD = Infinity;
    const p = this.game.player;
    for (const v of this.list) {
      const c = v.controls();
      if (!c || v.z !== p.z) continue;
      if (c.hp <= 0) continue;
      const [wx, wy] = this.driverSeatWorld(v);
      const d = Math.hypot(wx - p.x, wy - p.y);
      if (d <= GET_IN_RANGE && d < bestD) (best = v), (bestD = d);
    }
    return best;
  }

  /** World position of the driver's seat: as drawn (the template's) with a shaped body, else the cell centre. */
  driverSeatWorld(v: Vehicle): [number, number] {
    const c = v.controls();
    if (!c) throw new Error(`the ${v.name} has no controls`);
    const [sx, sy] = this.bodyRect(v) ? seatPoint(v, c.mx, c.my) : [c.mx, c.my];
    return v.mountToWorld(sx, sy);
  }

  /** Open the door nearest the driver's seat if it's closed (for getting in from outside). */
  openDriverDoor(v: Vehicle): string | null {
    const c = v.controls();
    if (!c) return null;
    const doors = v.parts.filter((q) => has(q, 'OPENABLE') && !q.open && Math.max(Math.abs(q.mx - c.mx), Math.abs(q.my - c.my)) <= 1);
    if (!doors.length) return null;
    const p = this.game.player;
    doors.sort((a, b) => {
      const [ax, ay] = v.mountToWorld(a.mx + 0.5, a.my + 0.5);
      const [bx, by] = v.mountToWorld(b.mx + 0.5, b.my + 0.5);
      return Math.hypot(ax - p.x, ay - p.y) - Math.hypot(bx - p.x, by - p.y);
    });
    return this.toggleDoor(v, doors[0].mx, doors[0].my);
  }

  takeControls(v: Vehicle): { ok: boolean; msg: string } {
    const c = v.controls();
    if (!c) return { ok: false, msg: `The ${v.name} has no controls.` };
    if (c.hp <= 0) return { ok: false, msg: `The ${v.name}'s controls are broken.` };
    this.driving = v;
    this.stations.leave();
    this.seatPlayer(v);
    this.claimMovement();
    const msg = v.locked ? `You take the controls of the ${v.name}. It's locked: you'll need to hotwire it.` : `You take the controls of the ${v.name}.`;
    return { ok: true, msg };
  }

  /** Take over WASD (driving / stations); composes with grab.ts's wrapper of movementOverride. */
  claimMovement(): void {
    this.game.movementOverride = this.holdMove;
  }

  /** How being inside a vehicle works (src/game/vehwalk.ts): 'stations' (default), 'allstations', 'free'. */
  walkMode(): string {
    return this.stations.mode;
  }

  releaseControls(): string {
    const v = this.driving;
    if (!v) return 'You are not driving.';
    this.driving = null;
    this.input = { throttle: 0, steer: 0, brake: false };
    this.pedal = 0;
    if (this.cruiseOn) {
      this.cruiseOn = false;
      v.cruiseVelocity = 0;
    }
    return Math.abs(v.velocity) > 1 ? `You let go of the controls of the moving ${v.name}!` : `You let go of the controls of the ${v.name}.`;
  }

  /**
   * Climb out of a (stopped) vehicle: open the nearest door and step onto free ground beyond
   * it. The driving HUD says "e get out"; letting go of the controls alone left a newcomer
   * sitting in a closed car, walking into its walls, with no idea the doors open.
   * Returns null when there's no way out from here (no door next to you, or it's blocked).
   */
  climbOut(v: Vehicle): string | null {
    if (Math.abs(v.velocity) > 1) return null;
    const p = this.game.player;
    const here = this.playerOn();
    if (!here || here.v !== v) return null;
    // The doors you can reach from your seat: next to it, or down the aisle (a bus driver's
    // door is across the cab at the kerb side). Walking steps through the vehicle's own cells
    // that don't block (BN move cost > 0), nearest first.
    const steps = this.walkInside(v, here.mx, here.my);
    const reach = (q: VehiclePart) => {
      let best = Infinity;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) best = Math.min(best, steps.get(`${q.mx + dx},${q.my + dy}`) ?? Infinity);
      return best + Math.hypot(q.mx - here.mx, q.my - here.my) * 1e-3;
    };
    const doors = v.parts.filter((q) => has(q, 'OPENABLE') && !has(q, 'MULTISQUARE') && reach(q) < Infinity);
    doors.sort((a, b) => reach(a) - reach(b));
    for (const d of doors) {
      const [dx, dy] = v.mountToWorld(d.mx, d.my);
      const tx = Math.floor(dx), ty = Math.floor(dy);
      // A free tile next to the door that isn't part of any vehicle.
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x = tx + ox, y = ty + oy;
        if (this.at(x, y, p.z) || !this.game.map.passable(x, y, p.z)) continue;
        const opened = d.open ? null : this.toggleDoor(v, d.mx, d.my);
        p.x = x + 0.5;
        p.y = y + 0.5;
        return `${opened ? opened.replace(/\.$/, '') + ' and' : 'You'} climb out of the ${v.name}.`;
      }
    }
    return null;
  }

  /** Steps from mount (mx, my) to every cell of `v` you can walk to inside it (4-neighbour, cells with BN move cost > 0). */
  private walkInside(v: Vehicle, mx: number, my: number): Map<string, number> {
    const dist = new Map<string, number>([[`${mx},${my}`, 0]]);
    const queue: [number, number][] = [[mx, my]];
    while (queue.length) {
      const [x, y] = queue.shift()!;
      const d = dist.get(`${x},${y}`)!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + dx},${y + dy}`;
        if (dist.has(k) || !v.hasMount(x + dx, y + dy) || v.moveCostAt(x + dx, y + dy) <= 0) continue;
        dist.set(k, d + 1);
        queue.push([x + dx, y + dy]);
      }
    }
    return dist;
  }

  private seatPlayer(v: Vehicle): void {
    const s = v.driverSeat();
    if (!s) return;
    // Onto the seat as drawn (the template's seat, inside its cell) when the body is shaped.
    const [wx, wy] = this.driverSeatWorld(v);
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
    const fueled = working.filter((e) => v.selectEngineFuel(e));
    if (!fueled.length) {
      const ft = v.engineFuel(working[0]) ?? 'fuel';
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
    this.emitSound(v, Math.max(20, v.engineNoise(0.3)), 'the engine starting', ['engine_start', engineVariant('engine_start', v)]);
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
    this.emitSound(v, 10, 'the engine stopping', ['engine_stop', engineVariant('engine_stop', v)]);
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
    this.emitSound(v, vol, 'honking!', ['vehicle', hornVariant(vol)], 'alert');
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
        const b = this.bodyRect(v);
        // With a shaped body you may stand in the door's tile but outside the car: only a
        // player inside the doorway itself blocks it.
        const inWay = b ? pl.z === v.z && circleTouchesBody(v, doorOnly(b, p.mx, p.my), pl.x, pl.y, CREATURE_RADIUS * 0.8)
          : Math.floor(wx) === pl.tileX && Math.floor(wy) === pl.tileY;
        if (inWay) return `There's something in the way of the ${door.def.name}.`;
      }
    }
    for (const p of group) p.open = opening;
    v.version++;
    const doorSfx = opening ? 'vehicle_open' : 'vehicle_close';
    this.emitSound(v, 3, opening ? 'a door opening' : 'a door closing', [doorSfx, pickVariant(doorSfx, door.def.id, 'door')]);
    return `You ${opening ? 'open' : 'close'} the ${v.name}'s ${door.def.name}.`;
  }

  /**
   * Noise for monsters and audio. `cddaSfx` is the CDDA sound_effect [id, variant] the audio
   * plays at the vehicle; without one the event is silent (sfxId '') but monsters still hear
   * it. The running-engine sound is a loop (src/audio/vehicleAudio.ts), not these events.
   */
  emitSound(v: Vehicle, volume: number, description: string, cddaSfx?: [string, string], category: SoundCategory = 'movement'): void {
    if (volume <= 0) return;
    // The driver doesn't need "You hear vroom!" every second: engine/door noises are ambient.
    const ambient = category === 'movement' || this.driving === v;
    emitSound(this.game, { x: v.x, y: v.y, z: v.z }, volume, description, { source: v, category, sfxId: cddaSfx?.[0] ?? '', sfxVariant: cddaSfx?.[1], ambient });
  }

  // --- simulation ---------------------------------------------------------------------

  update(game: Game, realDt: number, gameDt = realDt): void {
    this.simTime += realDt;
    this.moved.clear();
    this.frameDt = realDt;
    if ((this.rescanAcc += realDt) > 2) {
      this.rescanAcc = 0;
      this.rescan();
    }
    if (this.pending.length) this.flushPending();
    if (this.driving && !this.scriptedInput) this.readKeys();
    this.stations.update(realDt);
    if (this.driving && this.driveMode === 'cruise') this.updateCruise(this.driving, realDt);
    for (const v of this.list) this.simulate(v, realDt);
    this.towing.step(realDt);
    for (const v of this.list) {
      // the threshold (not the owed time) varies by uid: 0.5-1.5 steps, so cars spread out
      const owed = (this.powerOwed.get(v) ?? 0) + gameDt;
      if (owed >= POWER_STEP * (0.5 + ((v.uid * 0.618) % 1))) {
        updateVehiclePower(game, v, owed);
        this.powerOwed.set(v, 0);
      } else this.powerOwed.set(v, owed);
    }
    if (this.driving) this.closeDoorsUnderway(this.driving);
    const p = game.player;
    this.engineSounds.update(this.list, { x: p.x, y: p.y, z: p.z }, this.driving, realDt);
  }

  /**
   * Doors swing shut once the vehicle you drive gets moving (playtest: the driver's door
   * you got in by stayed open all the way down the road). Trunk lids, tailgates and rear
   * shutters (MULTISQUARE / end doors) stay as you left them: that's cargo, not a door.
   */
  private closeDoorsUnderway(v: Vehicle): void {
    if (Math.abs(v.velocity) < 1.5) return;
    let closed = false;
    for (const q of v.parts) {
      if (!q.open || !has(q, 'OPENABLE') || has(q, 'MULTISQUARE')) continue;
      q.open = false;
      closed = true;
    }
    if (closed) {
      v.version++;
      this.emitSound(v, 3, 'a door slamming', ['vehicle_close', pickVariant('vehicle_close', 'door', 'door')]);
    }
  }

  private readKeys(): void {
    const k = this.game.input.held;
    const cap = this.game.input.captured;
    const f = (code: string) => (!cap && k.has(code) ? 1 : 0);
    this.input = { throttle: f('KeyW') - f('KeyS'), steer: f('KeyD') - f('KeyA'), brake: !!f('Space') };
  }

  /**
   * Turn held W/S into CDDA cruise_thrust presses: one step on press, then repeating while
   * held. Holding the key pauses at the safe speed (CDDA's snap point) so a held W can't carry
   * you into engine-straining speeds without a deliberate second press. Space is CDDA's
   * handbrake: it zeroes the cruise target.
   */
  private updateCruise(v: Vehicle, dt: number): void {
    const dir = Math.sign(this.input.throttle);
    if (this.input.brake) v.cruiseVelocity = 0;
    if (dir === 0) {
      this.cruiseHeld = 0;
      this.cruiseHeldAtSafe = false;
      return;
    }
    let press = false;
    if (dir !== this.cruiseHeld) {
      this.cruiseHeld = dir;
      this.cruiseRepeatIn = CRUISE_REPEAT_DELAY;
      this.cruiseHeldAtSafe = false;
      press = true;
    } else if ((this.cruiseRepeatIn -= dt) <= 0 && !this.cruiseHeldAtSafe) {
      this.cruiseRepeatIn += CRUISE_REPEAT;
      press = true;
    }
    if (!press) return;
    if (!v.engineOn && dir > 0 && v.velocity >= 0) {
      // CDDA thrust(): the accelerator does nothing with the engine off.
      if (this.cruiseRepeatIn === CRUISE_REPEAT_DELAY) this.game.message(`The ${v.name}'s engine isn't on!`);
      return;
    }
    const offroad = this.offroad(v);
    v.cruiseThrust(dir * CRUISE_STEP_VMIPH, offroad);
    const safe = Math.trunc(v.maxVelocity(true, offroad) * VMIPH_PER_MS);
    if (dir > 0 && v.cruiseVelocity === safe) this.cruiseHeldAtSafe = true;
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
        if (alarm && v.fuelLeft('battery') > 0) this.emitSound(v, alarm.def.bonus ?? 60, 'WHOOP WHOOP', ['vehicle', 'car_alarm'], 'alarm');
        else v.alarmOn = false;
        this.soundAcc.set(v, 0);
      } else if (!v.engineOn) this.soundAcc.set(v, acc);
    }
    const motion = motionOf(v);
    if (!v.engineOn && Math.abs(v.velocity) < STOP_EPS && inp.throttle === 0 && inp.steer === 0 && settled(motion)) {
      motion.yaw = motion.pivot = 0;
      v.velocity = 0;
      // CDDA: thrusting with the engine off fails and zeroes cruise control.
      v.cruiseVelocity = 0;
      return;
    }

    const offroad = this.offroad(v);
    const mass = v.mass();
    const wheelsOk = v.validWheelConfig();
    const hd = this.handling(v);
    let load = 0.05;
    const vel = v.velocity;
    // Drag: CDDA's F = c_air v^2 + c_roll (33.3 + v); without intact wheels the vehicle
    // scrapes along on its frame and stops almost at once.
    const cAir = v.coeffAirDrag();
    const cRoll = wheelsOk ? v.coeffRollingDrag(offroad) : v.coeffRollingDrag(offroad) * 20;
    const dragDv = ((cAir * vel * vel + cRoll * (33.3 + Math.abs(vel))) / mass) * dt;
    let nv: number;
    // BN vehicle::thrust: a tower too weak for its load can't push while rolling (towing.ts).
    const canPull = !driven || this.towing.canPull(v, offroad, this.driveMode === 'cruise' ? Math.sign(v.cruiseVelocity / VMIPH_PER_MS - vel) : inp.throttle, dt);
    if (driven && this.driveMode === 'cruise') {
      const r = this.cruiseStep(v, dt, offroad, dragDv, wheelsOk && hasPower && canPull);
      nv = r.nv;
      load = Math.max(load, r.load);
    } else if (driven) {
      const r = this.directStep(v, inp, dt, offroad, dragDv, wheelsOk && hasPower && canPull, hd);
      nv = r.nv;
      load = Math.max(load, r.load);
    } else {
      // Nobody at the wheel: rolls to a stop on drag alone.
      nv = vel;
      if (nv > 0) nv = Math.max(0, nv - dragDv);
      else if (nv < 0) nv = Math.min(0, nv + dragDv);
      if (Math.abs(nv) < STOP_EPS) nv = 0;
    }
    if (hasPower && Math.abs(nv) > 0.1) load = Math.max(load, Math.min(1, ((cAir * nv * nv + cRoll * (33.3 + Math.abs(nv))) * Math.abs(nv)) / v.totalPower()));
    v.velocity = nv;

    // Steering: bicycle model. The wheel angle eases toward the input (a fraction of a second
    // to full lock, quicker back to centre) and the lock narrows with speed so a held A/D at
    // 50 mph is a firm curve, not a spin.
    const steerable = v.steerable() && wheelsOk;
    const maxSteer = maxSteerAt(Math.abs(nv), v.wheelbase(), hd.latAcc);
    const target = steerable ? inp.steer * maxSteer : 0;
    const outward = Math.abs(target) > Math.abs(v.steer) && Math.sign(target) === Math.sign(v.steer || target);
    const rate = (maxSteer / (outward ? STEER_IN_TIME * hd.steerIn : STEER_OUT_TIME * hd.steerOut)) * dt;
    v.steer += Math.max(-rate, Math.min(rate, target - v.steer));
    // The lock shrinks as speed builds even with the key held.
    v.steer = Math.max(-maxSteer, Math.min(maxSteer, v.steer));
    const yawRate = (nv * Math.tan(v.steer)) / v.wheelbase();
    let dFacing = (yawRate * dt * 180) / Math.PI;
    // Tracks pivot under power, turning the way the held key points (A left, D right). Heavy
    // ones spool the pivot up (hd.pivotSpool s to full rate) and wind it down twice as fast.
    if (steerable && driven && v.engineOn && hasPower && maxSteer > 0 && v.skidSteers()) {
      const fade = Math.max(0, 1 - Math.abs(nv) / PIVOT_FADE);
      if (hd.pivotSpool > 0) {
        const want = inp.steer * hd.pivotRate;
        const easing = motion.pivot !== 0 && (Math.abs(want) < Math.abs(motion.pivot) || Math.sign(want) === -Math.sign(motion.pivot));
        const r = ((hd.pivotRate / hd.pivotSpool) * (easing ? 2 : 1)) * dt;
        motion.pivot += Math.max(-r, Math.min(r, want - motion.pivot));
      } else motion.pivot = (v.steer / maxSteer) * hd.pivotRate;
      dFacing += motion.pivot * fade * dt;
    } else motion.pivot = 0;
    motion.yaw = dt > 0 ? dFacing / dt : 0;

    // Momentum crashes: whatever slide / spin a crash left integrates through the same
    // collision-checked move, then decays like tyres (vehicleImpact.ts).
    // A towed vehicle is pulled through the same slide / spin whatever the crash model.
    const momentum = this.crashModel === 'momentum' || this.towing.isTowed(v);
    const [sx, sy, spin] = momentum && !settled(motion) ? [motion.sx * dt, motion.sy * dt, motion.spin * dt] : [0, 0, 0];
    if (!this.moved.has(v) && (nv !== 0 || dFacing !== 0 || sx !== 0 || sy !== 0 || spin !== 0)) {
      this.moved.add(v);
      this.move(v, nv * dt, dFacing, sx, sy, spin);
    }
    if (momentum && !settled(motion)) decayMotion(v, motion, dt, this.rolling(v), v.skidSteers(), !driven && this.towing.isTowed(v));

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
        this.emitSound(v, noise, engineSoundMsg(noise));
        this.soundAcc.set(v, 0);
      } else this.soundAcc.set(v, acc);
    }
  }

  /**
   * One physics step of direct driving: W is an accelerator pedal (ramped, felt acceleration
   * from CDDA power/mass), off-throttle coasts with engine braking, S brakes to a stop and
   * then, held a moment longer, reverses; Space is the handbrake. With cruise control on and
   * no pedal input the engine holds `v.cruiseVelocity`; W past it raises the set speed on
   * release, S or Space cancel it.
   */
  private directStep(v: Vehicle, inp: DriveInput, dt: number, offroad: number, dragDv: number, canThrust: boolean, hd: Handling = this.handling(v)): { nv: number; load: number } {
    const vel = v.velocity;
    const want = Math.max(0, inp.throttle);
    this.pedal += Math.max(-THROTTLE_RAMP_DOWN * dt, Math.min(THROTTLE_RAMP_UP * hd.throttleRamp * dt, want - this.pedal));
    if (this.cruiseOn && (inp.throttle < 0 || inp.brake || !canThrust)) {
      this.cruiseOn = false;
      v.cruiseVelocity = 0;
      if (inp.throttle < 0 || inp.brake) this.say('Cruise control off.', 'c_light_gray');
    }
    if (this.cruiseOn && inp.throttle === 0) return this.cruiseStep(v, dt, offroad, dragDv, canThrust);
    // Accelerating past the set speed carries it along (released W then holds the new speed).
    if (this.cruiseOn && inp.throttle > 0) v.cruiseVelocity = Math.max(v.cruiseVelocity, Math.round(vel * VMIPH_PER_MS));
    const scale = (() => {
      const a0 = v.acceleration(0, offroad);
      return a0 > 0 ? (feltAcceleration(a0) * hd.accel) / a0 : 0;
    })();
    // Tracks are governed: thrust fades over the last 20% below the top speed.
    const top = trackTopSpeed(hd, offroad);
    const governor = (s: number) => (Number.isFinite(top) ? Math.max(0, Math.min(1, (top - Math.abs(s)) / (0.2 * top))) : 1);
    const brakeDecel = BRAKE_DECEL * hd.brake;
    let a = 0, load = 0;
    let braking = false;
    if (inp.throttle < 0 && vel > STOP_EPS) {
      a -= brakeDecel;
      braking = true;
      this.reverseHeld = 0;
    } else if (inp.throttle < 0) {
      this.reverseHeld += dt;
      if (canThrust && this.reverseHeld >= REVERSE_DELAY) {
        const electric = v.engines.some((e) => e.enabled && e.hp > 0 && e.def.fuel_type === 'battery');
        const maxRev = Math.min(-v.maxReverseVelocity(offroad), top * 0.5);
        if (-vel < maxRev) a -= v.acceleration(vel, offroad) * scale * (electric ? 1 : 0.6);
        load = 0.5;
      }
    } else {
      this.reverseHeld = 0;
      if (this.pedal > 0 && vel < -0.3) {
        // W while rolling backwards: brake first.
        a += brakeDecel;
        braking = true;
      } else if (this.pedal > 0 && canThrust) {
        a += this.pedal * v.acceleration(vel, offroad) * scale * governor(vel);
        load = Math.min(1, this.pedal);
      }
    }
    if (inp.brake) {
      a -= Math.sign(vel) * brakeDecel * 1.3;
      braking = true;
    }
    let nv = vel + a * dt;
    // Drag and, off the pedal, engine braking: always toward zero. Over the governed speed
    // (shoved, downhill) the tracks drag it back down.
    const over = Number.isFinite(top) && Math.abs(vel) > top ? 1.5 * dt : 0;
    const coast = dragDv + over + (this.pedal < 0.05 && !braking && inp.throttle >= 0 ? COAST_DECEL * hd.coast * dt : 0);
    if (nv > 0) nv = Math.max(0, nv - coast);
    else if (nv < 0) nv = Math.min(0, nv + coast);
    // Brakes (and the handbrake) only ever bring the vehicle to a stop, never reverse it.
    if (braking && vel !== 0 && Math.sign(nv) !== Math.sign(vel)) nv = 0;
    if (Math.abs(nv) < STOP_EPS && this.pedal < 0.05 && !(inp.throttle < 0 && this.reverseHeld >= REVERSE_DELAY)) nv = 0;
    return { nv, load };
  }

  /**
   * Cruise control key (direct driving): lock the current forward speed, or release it.
   * Returns the message for the driver.
   */
  toggleCruise(): string {
    const v = this.driving;
    if (!v) return "You're not driving.";
    if (this.driveMode === 'cruise') return 'Cruise control is always on in the CDDA driving model (Options > Driving controls).';
    if (this.cruiseOn) {
      this.cruiseOn = false;
      v.cruiseVelocity = 0;
      return 'Cruise control off.';
    }
    if (!v.engineOn) return `The ${v.name}'s engine isn't on!`;
    if (v.velocity < 2) return 'Get moving first: cruise control holds your current speed.';
    this.cruiseOn = true;
    v.cruiseVelocity = Math.round(v.velocity * VMIPH_PER_MS);
    return `Cruise control set to ${Math.round(v.velocity * MPH_PER_MS)} mph.`;
  }

  /**
   * One physics step toward the cruise target (CDDA vehicle::thrust with cruise control):
   * the engine accelerates toward the target without overshooting it, brakes (20 mph/s in
   * CDDA, BRAKE_DECEL here) plus engine braking slow it down, reverse gets 60% thrust for
   * non-electric engines. `canThrust` = working wheels and engine power.
   */
  private cruiseStep(v: Vehicle, dt: number, offroad: number, dragDv: number, canThrust: boolean): { nv: number; load: number } {
    const vel = v.velocity;
    const target = v.cruiseVelocity / VMIPH_PER_MS;
    let nv = vel;
    // Coasting: drag only, toward zero.
    if (nv > 0) nv = Math.max(0, nv - dragDv);
    else if (nv < 0) nv = Math.min(0, nv + dragDv);
    const want = target - nv;
    if (Math.abs(want) < 1e-6) return { nv: target, load: 0 };
    const thd = Math.sign(want);
    // Thrusting = pushing the way we're already moving (or from rest); otherwise it's braking.
    const thrusting = nv === 0 ? true : Math.sign(nv) === thd;
    let load = 0;
    let dv: number;
    if (thrusting) {
      if (!canThrust) {
        // CDDA thrust() without a working engine: "engine isn't on" and cruise drops to 0.
        v.cruiseVelocity = 0;
        return { nv: Math.abs(nv) < STOP_EPS ? 0 : nv, load: 0 };
      }
      const electric = v.engines.some((e) => e.enabled && e.hp > 0 && e.def.fuel_type === 'battery');
      const acc = v.acceleration(nv, offroad) * (thd < 0 && !electric ? 0.6 : 1);
      dv = Math.min(acc * dt, Math.abs(want));
      load = acc > 0 ? Math.min(1, dv / (acc * dt)) : 1;
    } else {
      // Brakes plus engine braking, and never past zero in one step (it then thrusts the other way).
      const decel = BRAKE_DECEL + (canThrust ? v.acceleration(nv, offroad) : 0);
      dv = Math.min(decel * dt, Math.abs(want), Math.abs(nv));
    }
    nv += thd * dv;
    if (Math.abs(nv) < STOP_EPS && target === 0) nv = 0;
    return { nv, load };
  }

  /**
   * Move/turn a vehicle by `dist` metres along its facing and `dFacing` degrees, in
   * substeps, colliding with anything in the tiles it newly enters (whole tiles) or its drawn
   * body newly touches (shaped bodies). The driver (and anyone standing inside) moves along.
   */
  move(v: Vehicle, dist: number, dFacing: number, sx = 0, sy = 0, spin = 0, slide = true): void {
    const body = this.crashBody(v);
    // A drawn body is thinner than a tile row (a bike is ~0.6 m across), so it steps finer to
    // never skip over one at speed, and turns in smaller steps so a swinging corner is caught
    // near where it touches. Whole tiles keep CDDA-ish tile stepping.
    const [stepLen, stepTurn] = body ? [BODY_STEP, BODY_TURN_STEP] : [0.3, 8];
    // A crash spin turns the body about its centre, not about mount (0, 0) like the steering:
    // the mount origin swings round the centre, which is a translation on top.
    if (spin) {
      const [cx, cy] = this.centreWorld(v);
      const a = (spin * Math.PI) / 180, ox = v.x - cx, oy = v.y - cy;
      sx += cx + ox * Math.cos(a) - oy * Math.sin(a) - v.x;
      sy += cy + ox * Math.sin(a) + oy * Math.cos(a) - v.y;
    }
    const turn = dFacing + spin;
    const steps = Math.max(1, Math.ceil(Math.max((Math.abs(dist) + Math.hypot(sx, sy)) / stepLen, Math.abs(turn) / stepTurn)));
    const p = this.game.player;
    let retries = 0;
    for (let i = 0; i < steps; i++) {
      const rad = (v.facing * Math.PI) / 180;
      const d = dist / steps;
      const nx = v.x + Math.cos(rad) * d + sx / steps, ny = v.y + Math.sin(rad) * d + sy / steps;
      const nf = v.facing + turn / steps;
      const before = new Set(this.tilesOf.get(v) ?? []);
      const on = this.playerOn();
      const riding = this.driving === v || (!!on && on.v === v);
      const [plx, ply] = riding ? v.worldToMount(p.x, p.y) : [0, 0];
      const place = (x: number, y: number, f: number) => {
        const oldFacing = v.facing;
        v.x = x;
        v.y = y;
        v.facing = ((f % 360) + 360) % 360;
        this.reindex(v);
        if (riding) {
          const [wx, wy] = v.mountToWorld(plx, ply);
          p.x = wx;
          p.y = wy;
          // The view turns with the vehicle (yaw 0 = north; facing 0 = east, both clockwise).
          p.yaw += ((v.facing - oldFacing + 540) % 360 - 180) * (Math.PI / 180);
        }
      };
      this.contactN = null;
      const res = this.collidePose(v, nx, ny, nf, before, riding);
      // The vehicle in the way just moved off (momentum crashes): try the same substep again.
      if (res === 'retry' && retries++ < 3) {
        i--;
        continue;
      }
      const stopped = res === 'retry' ? 'solid' : res;
      if (stopped) {
        // Shaped bodies: close the last gap so the crash happens where the paint touches, not
        // up to a substep short of it.
        const n = this.contactN;
        let f = 0;
        if (stopped === 'solid' && body) {
          const [x0, y0, f0] = [v.x, v.y, v.facing];
          f = this.contactFraction(v, body, nx, ny, nf);
          if (f > 0) place(x0 + (nx - x0) * f, y0 + (ny - y0) * f, f0 + (nf - f0) * f);
        }
        // Momentum crashes: the rest of this frame's travel slides along what was hit (its
        // face's tangent, the turn dropped), so a car steering into a wall scrapes along it and a
        // glancing hit carries on instead of sticking. A velocity-only model can't do this by
        // itself: the wheels keep pointing into the wall every frame.
        if (slide && n && stopped === 'solid') {
          const left = steps - i - f;
          let rx = (Math.cos(rad) * d + sx / steps) * left, ry = (Math.sin(rad) * d + sy / steps) * left;
          const into = rx * n[0] + ry * n[1];
          if (into < 0) (rx -= into * n[0]), (ry -= into * n[1]);
          if (Math.hypot(rx, ry) > 1e-3) this.move(v, 0, 0, rx, ry, 0, false);
        }
        // Stopped dead against something: drop the cruise target. CDDA keeps it, but there the
        // driver gets a turn to react; in real time the engine would ram the obstacle again
        // every frame.
        if (this.driving === v && Math.abs(v.velocity) < STOP_EPS) v.cruiseVelocity = 0;
        break;
      }
      place(nx, ny, nf);
    }
  }

  /**
   * How far (0..1) from its current pose toward (nx, ny, nf) a shaped body gets before it
   * touches something solid (bisection; the current pose is free by construction).
   */
  private contactFraction(v: Vehicle, body: BodyRect, nx: number, ny: number, nf: number): number {
    let lo = 0, hi = 1;
    for (let i = 0; i < 7; i++) {
      const m = (lo + hi) / 2;
      const hit = this.bodyContacts(v, body, v.x + (nx - v.x) * m, v.y + (ny - v.y) * m, v.facing + (nf - v.facing) * m).next();
      if (hit.done) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Vehicles (other than `self`) whose grids reach into world box [x0, y0, x1, y1] (+1 tile). */
  private vehiclesNear(self: Vehicle | null, z: number, [x0, y0, x1, y1]: [number, number, number, number]): Vehicle[] {
    const out = new Set<Vehicle>();
    for (let ty = Math.floor(y0) - 1; ty <= Math.floor(y1) + 1; ty++)
      for (let tx = Math.floor(x0) - 1; tx <= Math.floor(x1) + 1; tx++)
        for (const o of this.index.get(tileKey(tx, ty, z)) ?? []) if (o.v !== self) out.add(o.v);
    return [...out];
  }

  /**
   * What a shaped body at pose (nx, ny, nf) newly touches compared with where it is now:
   * other vehicles' bodies (OBB vs OBB), then blocking tiles (BN's obstacle rules per tile,
   * obstacleAt). Each contact names the mount of `v` nearest the touch point. Lazy, so a
   * caller can smash the first tile before the next is judged.
   */
  private *bodyContacts(v: Vehicle, body: BodyRect, nx: number, ny: number, nf: number): Generator<
    | { kind: 'vehicle'; mount: [number, number]; other: VehicleOccupant }
    | { kind: 'tile'; mount: [number, number]; tx: number; ty: number; ob: Obstacle }
  > {
    const map = this.game.map;
    const z = v.z;
    const nb = rectObb(v, body, nf, nx, ny), ob = rectObb(v, body);
    const bounds = obbBounds(nb);
    // The contact point picks the side of the body, that side's socket, and so the BN cell
    // (and part) that takes the hit (chassis hitMount).
    const mountOf = (wx: number, wy: number) => {
      const [lx, ly] = v.worldToMount(wx, wy, nf, nx, ny);
      return hitMount(v, lx, ly);
    };
    for (const o of this.vehiclesNear(v, z, bounds)) {
      for (const s of vehicleObbs(o, this.bodyRect(o))) {
        if (!obbHitsObb(nb, s) || obbHitsObb(ob, s)) continue;
        const [cx, cy] = obbContact(nb, s);
        const [olx, oly] = o.worldToMount(cx, cy);
        const [omx, omy] = this.bodyRect(o) ? hitMount(o, olx, oly) : nearestMount(o, olx, oly);
        yield { kind: 'vehicle', mount: mountOf(cx, cy), other: { v: o, mx: omx, my: omy } };
        break;
      }
    }
    const [x0, y0, x1, y1] = bounds;
    const touched: { tx: number; ty: number; cx: number; cy: number; d: number }[] = [];
    for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++)
      for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) {
        if (!obbHitsTile(nb, tx, ty) || obbHitsTile(ob, tx, ty)) continue;
        const [cx, cy] = clampToObb(nb, tx + 0.5, ty + 0.5);
        touched.push({ tx, ty, cx, cy, d: Math.hypot(cx - nb.cx, cy - nb.cy) });
      }
    // Nearest the body's centre first: a car meeting a wall square-on takes it on the bonnet /
    // bumper in the middle of the nose, not on whichever corner tile the scan found first.
    touched.sort((a, b) => a.d - b.d);
    for (const t of touched) {
      const mount = mountOf(t.cx, t.cy);
      const obs = this.obstacle(t.tx, t.ty, z, v.partsAt(mount[0], mount[1]).some((q) => has(q, 'WHEEL')));
      if (obs) yield { kind: 'tile', mount, tx: t.tx, ty: t.ty, ob: obs };
    }
  }

  /**
   * What a vehicle part runs into at a tile: BN's terrain / furniture rules (obstacleAt), then
   * anything another map overlay walls off for walkers (a stair flight's footprint,
   * src/game/stairwalk.ts): vehicles read terrain, and would otherwise drive onto a flight.
   */
  obstacle(x: number, y: number, z: number, wheel: boolean): Obstacle | null {
    const ob = obstacleAt(this.game.map, x, y, z, wheel);
    if (ob || !this.overlayBlocks(x, y, z)) return ob;
    return { name: `the ${this.game.map.terAt(x, y, z).name}`, bashable: false, mass2: 1000, dens: 80, e: 0.1 };
  }

  /**
   * BN vehicle::collision with just_detect (grabbed_veh_move): would `v` at pose (nx, ny, nf)
   * run into something it doesn't already touch? The name of the first blocker, or null. Nothing
   * is damaged or flung — a vehicle pushed by hand stops at the obstacle. The player (the one
   * pushing) is ignored like BN's ignored_critter; other creatures block.
   */
  dragBlocker(v: Vehicle, nx: number, ny: number, nf: number): string | null {
    const z = v.z;
    const body = this.crashBody(v);
    if (body) {
      const c = this.bodyContacts(v, body, nx, ny, nf).next();
      if (!c.done) return c.value.kind === 'vehicle' ? `the ${c.value.other.v.name}` : c.value.ob.name;
    }
    const before = new Set(this.tilesOf.get(v) ?? []);
    for (const t of v.occupiedTiles(nf, nx, ny)) {
      const k = tileKey(t.tx, t.ty, z);
      if (!body && !before.has(k)) {
        const other = (this.index.get(k) ?? []).find((o) => o.v !== v);
        if (other) return `the ${other.v.name}`;
        const ob = this.obstacle(t.tx, t.ty, z, v.partsAt(t.mx, t.my).some((q) => has(q, 'WHEEL')));
        if (ob) return ob.name;
      }
      const c = this.creatureHooks.at(t.tx, t.ty, z);
      if (c) return `the ${this.creatureHooks.name(c)}`;
    }
    return null;
  }

  /** Another map overlay (not this one) makes the tile impassable. */
  overlayBlocks(x: number, y: number, z: number): boolean {
    for (const o of this.game.map.overlays) if (o !== this && o.moveCost?.(x, y, z) === 0) return true;
    return false;
  }

  /**
   * Check the tiles a pose would newly occupy (whole tiles), or what the drawn body newly
   * touches (shaped). Returns false if the vehicle got through, else why it was stopped (it
   * keeps its old pose): 'solid' (terrain, another vehicle) or 'creature' (a body it couldn't
   * fling). Smashed obstacles and knocked-down creatures let it through.
   */
  private collidePose(v: Vehicle, nx: number, ny: number, nf: number, before: Set<number>, riding: boolean): false | 'solid' | 'creature' | 'retry' {
    const map = this.game.map;
    const p = this.game.player;
    const z = v.z;
    const mass = v.mass();
    const velBefore = v.velocity;
    const momentum = this.crashModel === 'momentum';
    const planarBefore = this.planarVelocity(v);
    let stopped: false | 'solid' | 'creature' = false;
    const pose = v.occupiedTiles(nf, nx, ny);
    const poseKeys = new Set(pose.map((t) => tileKey(t.tx, t.ty, z)));
    // Where a knocked-away body can land: off the vehicle's new footprint, walkable, empty.
    const free = (x: number, y: number) => !poseKeys.has(tileKey(x, y, z)) && !before.has(tileKey(x, y, z)) && map.passable(x, y, z) && !this.creatureHooks.at(x, y, z);
    // With a shaped body (modelled look) creatures can stand in the edge of the vehicle's
    // tiles, beside the paint: they're hit when the body moves onto them, not when a tile
    // they stand in becomes the vehicle's. Headless / parts look: the tile rules.
    const body = this.bodyRect(v);
    const struck = (x: number, y: number, r: number) => !!body && circleTouchesBody(v, body, x, y, r, nf, nx, ny) && !circleTouchesBody(v, body, x, y, r);
    const creaturePos = (c: unknown): [number, number, number] | null => {
      const o = c as { x?: unknown; y?: unknown; radius?: unknown };
      return typeof o.x === 'number' && typeof o.y === 'number' ? [o.x, o.y, typeof o.radius === 'number' ? o.radius : CREATURE_RADIUS] : null;
    };
    const dir = Math.sign(v.velocity) || 1;
    const rad = (nf * Math.PI) / 180;
    let fdx = Math.cos(rad) * dir, fdy = Math.sin(rad) * dir;
    // A slide moves the body sideways: things are knocked the way it's actually going.
    const mlen = Math.hypot(nx - v.x, ny - v.y);
    if (momentum && mlen > 1e-6 && !settled(motionOf(v))) [fdx, fdy] = [(nx - v.x) / mlen, (ny - v.y) / mlen];
    // Crashes may stay on whole tiles (crashGeometry 'tiles') while creatures use the body.
    const solidBody = this.crashBody(v);
    if (solidBody) {
      // Solid things first: the body stops at the paint, and a creature beyond a wall it
      // didn't get through isn't hit.
      const pusher = { v, obb: rectObb(v, solidBody, nf, nx, ny) };
      for (const c of this.bodyContacts(v, solidBody, nx, ny, nf)) {
        const part = collisionPart(v, c.mount[0], c.mount[1]);
        if (momentum) {
          const res = this.momentumContact(v, part, c, solidBody, nx, ny, nf, fdx, fdy, pusher);
          if (res === 'retry') return 'retry';
          if (res) {
            stopped = 'solid';
            break;
          }
          continue;
        }
        const hit = c.kind === 'vehicle'
          ? this.crashVehicle(v, part, c.other, fdx, fdy, new Set(), pusher)
          : this.crashTerrain(v, part, c.tx, c.ty, c.ob, velBefore);
        if (hit) {
          stopped = 'solid';
          break;
        }
      }
    }
    // A body moving diagonally or turning reaches a creature before the creature's tile joins
    // the footprint: check the ring of tiles around it too (creatures only).
    const cells: { tx: number; ty: number; mx: number; my: number; ring?: boolean }[] = stopped ? [] : [...pose];
    if (body && !stopped) {
      const seen = new Set(poseKeys);
      for (const t of pose)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const rk = tileKey(t.tx + dx, t.ty + dy, z);
            if (seen.has(rk)) continue;
            seen.add(rk);
            cells.push({ tx: t.tx + dx, ty: t.ty + dy, mx: t.mx, my: t.my, ring: true });
          }
    }
    // The part that meets a creature at (x, y): with a body, the mount nearest it.
    const partNear = (t: { mx: number; my: number }, x: number, y: number) => {
      if (!body) return collisionPart(v, t.mx, t.my);
      const [lx, ly] = v.worldToMount(x, y, nf, nx, ny);
      const [mx, my] = hitMount(v, lx, ly);
      return collisionPart(v, mx, my);
    };
    for (const t of cells) {
      const k = tileKey(t.tx, t.ty, z);
      const isNew = !t.ring && !before.has(k);
      if (!isNew && !body) continue;
      const part = collisionPart(v, t.mx, t.my);
      // Another vehicle (whole tiles; shaped bodies did theirs above).
      const other = isNew && !solidBody ? [...(this.index.get(k) ?? [])].reverse().find((o) => o.v !== v) : undefined;
      if (other && momentum) {
        // Whole tiles: the contact is the tile, the normal from the two grids' outlines where
        // they are now (clear of each other: the separating side is the one being met).
        const res = this.vehicleContactM(v, part, other, t.tx + 0.5, t.ty + 0.5, obbNormal(rectObb(v, gridRect(v)), rectObb(other.v, gridRect(other.v))), fdx, fdy, poseKeys, null);
        if (res === 'retry') return 'retry';
        if (res) {
          stopped = 'solid';
          break;
        }
        continue;
      }
      if (other && this.crashVehicle(v, part, other, fdx, fdy, poseKeys, null)) {
        stopped = 'solid';
        break;
      }
      if (other) continue;
      // The player standing in the way (not riding along).
      if (!riding && p.tileX === t.tx && p.tileY === t.ty && p.z === z && !p.dead && (body ? struck(p.x, p.y, CREATURE_RADIUS) : isNew)) {
        const res = this.hitBody(v, partNear(t, p.x, p.y), {
          name: 'you', mass: 70, damage: (dmg) => {
            for (const bp of MAIN_PARTS) p.takeHit(bp as BodyPartId, [{ type: 'bash', amount: Math.round(dmg * BALANCE.crashDamage * (0.6 + this.rng.next() * 0.8)) }]);
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
          stopped = 'creature';
          break;
        }
        continue;
      }
      const c = this.creatureHooks.at(t.tx, t.ty, z);
      const cp = c ? creaturePos(c) : null;
      if (c && (body && cp ? struck(cp[0], cp[1], cp[2]) : isNew)) {
        const h = this.creatureHooks;
        const planned = !!cp && this.planRunover(v, c, cp[0], cp[1], nf, nx, ny, (x, y) => free(x, y) || (h.at(x, y, z) === c && map.passable(x, y, z) && !poseKeys.has(tileKey(x, y, z)) && !before.has(tileKey(x, y, z))));
        let launched = false;
        const res = this.hitBody(v, cp ? partNear(t, cp[0], cp[1]) : part, {
          name: h.title ? h.title(c) : `the ${h.name(c)}`, mass: h.mass(c), hpMax: h.hpMax?.(c), damage: (dmg) => h.damage(c, dmg, v),
          fling: (force) => {
            if (planned) {
              h.launch!(c);
              launched = true;
              return true;
            }
            const spot = this.flingSpot(t.tx + 0.5, t.ty + 0.5, fdx, fdy, force, free);
            if (!spot) return false;
            h.place(c, spot[0], spot[1]);
            return true;
          },
        });
        if (planned && !launched) h.cancelFling?.(c);
        if (!res) {
          stopped = 'creature';
          break;
        }
        continue;
      }
      // Terrain / furniture (CDDA: bashable things that aren't flat floor, then walls).
      if (!isNew || solidBody) continue;
      const ob = this.obstacle(t.tx, t.ty, z, v.partsAt(t.mx, t.my).some((q) => has(q, 'WHEEL')));
      if (!ob) continue;
      // Whole tiles have no reliable contact normal: BN's stop, and any crash slide dies on it.
      if (this.crashTerrain(v, part, t.tx, t.ty, ob, velBefore)) {
        if (momentum) stopMotion(v);
        stopped = 'solid';
        break;
      }
    }
    // The driver feels the jolt (vehicle_move.cpp throw_passenger). Momentum crashes: whoever
    // rides this vehicle feels its own velocity change, so a tank clipping a car barely notices.
    if (momentum) {
      const [ax, ay] = this.planarVelocity(v);
      this.joltRiders(v, Math.hypot(ax - planarBefore[0], ay - planarBefore[1]) * MPH_PER_MS);
    } else {
      const dVel = Math.abs(velBefore - v.velocity) * MPH_PER_MS;
      if (dVel > 1 && this.driving === v) this.jolt(v, dVel);
    }
    return stopped;
  }

  // --- momentum crashes (vehicleImpact.ts) -----------------------------------------------

  /** Heavy / tracked handling factors for `v` (handlingMode 'light' = the car tuning for all). */
  handling(v: Vehicle): Handling {
    return handlingFor(v.mass(), v.totalPower(), v.skidSteers(), this.handlingMode);
  }

  /**
   * Safe and top speed (m/s, on road) as this port drives them: CDDA's power/drag figures
   * (maxVelocity), capped by the track governor (handlingFor: the Abrams' turbine gives CDDA
   * 122 / 150 mph, the governor ~45). For the dashboard, the vehicle screens and the engine's
   * gear pitch. `engineOn` false gives the figures as if it were running (BN's vehicle info).
   */
  speedLimits(v: Vehicle, offroad = 1): { safe: number; top: number } {
    const wasOn = v.engineOn;
    v.engineOn = true;
    const cddaSafe = v.maxVelocity(true, offroad), cddaTop = v.maxVelocity(false, offroad);
    v.engineOn = wasOn;
    const gov = trackTopSpeed(this.handling(v), offroad);
    const top = Math.min(cddaTop, gov);
    return { safe: Math.min(cddaSafe, top), top };
  }

  /** Rolling freely on its wheels: someone drives it, its engine runs, or it's already moving. */
  private rolling(v: Vehicle): boolean {
    // BN vehicle::slowdown: no parking brake on a towed vehicle (`!is_towed() && brake_hold`).
    return this.driving === v || v.engineOn || Math.abs(v.velocity) > STOP_EPS || this.towing.isTowed(v);
  }

  /** World velocity of the body (along the wheels + any slide), m/s. */
  planarVelocity(v: Vehicle): [number, number] {
    const m = motionOf(v);
    const rad = (v.facing * Math.PI) / 180;
    return [v.velocity * Math.cos(rad) + m.sx, v.velocity * Math.sin(rad) + m.sy];
  }

  /** The box physics uses: the drawn body, else the grid's outline (mount space). */
  physRect(v: Vehicle): BodyRect {
    return this.bodyRect(v) ?? gridRect(v);
  }

  /** World position of the body's centre (where a crash spin turns it about). */
  private centreWorld(v: Vehicle): [number, number] {
    const b = this.physRect(v);
    return v.mountToWorld((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
  }

  /** `v` as a rigid body for a contact at world (px, py): its point velocity there includes the
   *  steering / pivot yaw (about mount 0,0) and any crash spin (about the centre). */
  contactBody(v: Vehicle, px: number, py: number): ContactBody {
    const m = motionOf(v);
    const [cx, cy] = this.centreWorld(v);
    const [vx, vy] = this.planarVelocity(v);
    const wk = (m.yaw * Math.PI) / 180, ws = (m.spin * Math.PI) / 180;
    const mass = v.mass();
    return {
      m: mass, I: boxInertia(mass, this.physRect(v)), cx, cy,
      pvx: vx - wk * (py - v.y) - ws * (py - cy), pvy: vy + wk * (px - v.x) + ws * (px - cx),
    };
  }

  /**
   * Give `v` impulse (jx, jy) N·s at world (px, py). The part along the wheels goes into
   * `velocity` when it's rolling (the wheels just roll; the drive model owns that speed), the
   * rest into the slide; the torque into the spin. Returns its velocity change (m/s).
   */
  applyImpulse(v: Vehicle, jx: number, jy: number, px: number, py: number, vehicleHit = false): [number, number] {
    const mass = v.mass(), m = motionOf(v);
    const [cx, cy] = this.centreWorld(v);
    const dvx = jx / mass, dvy = jy / mass;
    const dw = ((px - cx) * jy - (py - cy) * jx) / boxInertia(mass, this.physRect(v));
    const rad = (v.facing * Math.PI) / 180, fx = Math.cos(rad), fy = Math.sin(rad);
    if (this.rolling(v)) {
      const along = dvx * fx + dvy * fy;
      v.velocity += along;
      m.sx += dvx - along * fx;
      m.sy += dvy - along * fy;
    } else {
      m.sx += dvx;
      m.sy += dvy;
    }
    const s = Math.hypot(m.sx, m.sy);
    if (s > MAX_SLIDE) (m.sx *= MAX_SLIDE / s), (m.sy *= MAX_SLIDE / s);
    // Arcade stability: the driver half-catches a spin (GTA keeps you pointing roughly where you
    // were going; the car you hit is the one that swaps ends).
    const catchSpin = this.driving === v ? DRIVER_SPIN_SCALE : 1;
    let dSpin = ((dw * 180) / Math.PI) * catchSpin;
    // Spun out: another vehicle that would check the spin (the rammer's nose catching the
    // swinging tail) only takes SKID_COUNTER of it; the rest of the impulse still shoves it.
    // Walls check it in full.
    if (vehicleHit && m.skid > 0 && m.spin * dSpin < 0) dSpin *= SKID_COUNTER;
    m.spin = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, m.spin + dSpin));
    return [dvx, dvy];
  }

  /**
   * A shaped body's contact (bodyContacts) under momentum crashes: find where and along which
   * normal the paint actually touches (the pose bisected to first contact), then hand it to
   * the vehicle or terrain response. Truthy = `v` stops this substep; 'retry' = the vehicle in
   * the way moved off, try the substep again.
   */
  private momentumContact(
    v: Vehicle, part: VehiclePart,
    c: { kind: 'vehicle'; other: VehicleOccupant } | { kind: 'tile'; tx: number; ty: number; ob: Obstacle },
    body: BodyRect, nx: number, ny: number, nf: number, fdx: number, fdy: number, pusher: Pusher,
  ): boolean | 'retry' {
    // The contact point from the first touching pose; the normal from the last free one (a
    // separating axis is exactly the face being met, where a penetrating pose can mislead).
    const lo = this.contactFraction(v, body, nx, ny, nf), hi = Math.min(1, lo + 1 / 64);
    const pose = (f: number) => rectObb(v, body, v.facing + (nf - v.facing) * f, v.x + (nx - v.x) * f, v.y + (ny - v.y) * f);
    const free = pose(lo), at = pose(hi), full = pose(1);
    if (c.kind === 'tile') {
      // A wall is many tiles: average every blocking tile the body meets at this pose, so a
      // square hit lands on the middle of the bumper instead of spinning off one tile's edge.
      const now = rectObb(v, body);
      let px = 0, py = 0, sx = 0, sy = 0, n = 0;
      const [x0, y0, x1, y1] = obbBounds(at);
      for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++)
        for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) {
          const mine = tx === c.tx && ty === c.ty;
          if (!mine && (!obbHitsTile(at, tx, ty) || obbHitsTile(now, tx, ty) || !this.obstacle(tx, ty, v.z, false))) continue;
          const t = tileObb(tx, ty);
          const [cx, cy] = obbContact(obbHitsObb(at, t) ? at : full, t);
          const [ux, uy] = this.tileNormal(free, tx, ty, v.z);
          (px += cx), (py += cy), (sx += ux), (sy += uy), n++;
        }
      const len = Math.hypot(sx, sy) || 1;
      return this.terrainContactM(v, part, c.tx, c.ty, c.ob, px / n, py / n, [sx / len, sy / len]);
    }
    const o = c.other.v;
    const shapes = vehicleObbs(o, this.bodyRect(o));
    const s = shapes.find((q) => obbHitsObb(at, q)) ?? shapes.find((q) => obbHitsObb(full, q)) ?? shapes[0];
    const [px, py] = obbContact(obbHitsObb(at, s) ? at : full, s);
    return this.vehicleContactM(v, part, c.other, px, py, obbNormal(free, s), fdx, fdy, new Set(), pusher);
  }

  /**
   * The face of blocking tile (tx, ty) a box at `o` (just clear of it) is meeting: of the
   * tile's four faces, those not buried against another blocking tile, the one the box is
   * furthest out from. A wall is a row of tiles; its tiles' shared sides aren't faces, so a
   * corner sliding past a seam still meets the wall's face, not the seam.
   */
  private tileNormal(o: Obb, tx: number, ty: number, z: number): [number, number] {
    let best: [number, number] | null = null, bestSep = -Infinity;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (this.obstacle(tx + dx, ty + dy, z, false)) continue;
      const reach = o.hx * Math.abs(o.ux * dx + o.uy * dy) + o.hy * Math.abs(o.wx * dx + o.wy * dy);
      const sep = o.cx * dx + o.cy * dy - reach - ((tx + 0.5) * dx + (ty + 0.5) * dy + 0.5);
      if (sep > bestSep) (bestSep = sep), (best = [dx, dy]);
    }
    return best ?? obbNormal(o, tileObb(tx, ty));
  }

  /**
   * `v`'s `part` meets another vehicle at world (px, py), normal (nx, ny) pointing from it to
   * `v`: exchange the impulse (both slow / shove / spin), damage both by the energy it took,
   * jolt whoever rides the struck one. When they aren't closing (it's already moving off) the
   * struck one is moved now, if it hasn't been this frame ('retry'); a light one pinned in
   * place is shoved aside as the old model did.
   */
  private vehicleContactM(v: Vehicle, part: VehiclePart, other: VehicleOccupant, px: number, py: number, [nx, ny]: [number, number], fdx: number, fdy: number, blocked: Set<number>, pusher: Pusher | null): boolean | 'retry' {
    const o = other.v;
    const a = this.contactBody(v, px, py), b = this.contactBody(o, px, py);
    const r = contactImpulse(a, b, px, py, nx, ny, VEHICLE_RESTITUTION, VEHICLE_FRICTION);
    if (r.closing < CLOSING_MIN) {
      if (this.advanceStruck(o)) return 'retry';
      const [vx, vy] = this.planarVelocity(v);
      if (o !== this.driving && o.mass() < a.m * 0.2 && Math.hypot(vx, vy) > 0.5 && this.shove(o, fdx, fdy, blocked, pusher)) {
        // A spun-out one keeps spinning (vehicleImpact SKID_*): it was swatted, not parked.
        const mo = motionOf(o), keep = mo.skid > 0 ? [mo.spin, mo.skid] : null;
        stopMotion(o);
        if (keep) [mo.spin, mo.skid] = keep;
        return 'retry';
      }
      this.contactN = [nx, ny];
      return true;
    }
    this.contactN = [nx, ny];
    this.applyImpulse(v, r.jx, r.jy, px, py, true);
    const [dvx, dvy] = this.applyImpulse(o, -r.jx, -r.jy, px, py, true);
    // A real hit that spins something you aren't driving breaks its tyres loose (vehicleImpact
    // SKID_*). A square shunt doesn't: that one is braked as before.
    if (r.closing * MPH_PER_MS > SKID_MIN_MPH) for (const w of [v, o]) if (w !== this.driving && Math.abs(motionOf(w).spin) > SKID_MIN_SPIN) motionOf(w).skid = SKID_TIME;
    const total = crashDamage(r.lost, MPH_PER_MS);
    const share = damageShare(a.m, b.m);
    this.damagePart(v, part, total * share);
    this.damagePart(o, collisionPart(o, other.mx, other.my), total * (1 - share));
    const mph = r.closing * MPH_PER_MS;
    // A real hit is told and heard; leaning on it (plowing a car along, nudging) just scrapes.
    if (mph > PUSH_QUIET_MPH) {
      const snd = mph > 15 ? 'smash!' : 'crunch!';
      this.impactMessage(v, part, `the ${o.name}`, snd);
      this.emitSound(v, Math.round(Math.min(90, 30 + mph * 1.5)), snd, ['smash_success', 'hit_vehicle'], 'combat');
    }
    this.joltRiders(o, Math.hypot(dvx, dvy) * MPH_PER_MS);
    return true;
  }

  /**
   * `v`'s `part` meets terrain obstacle `ob` at tile (tx, ty), touching at (px, py) with normal
   * (nx, ny) out of the obstacle. Only the speed *into* it counts: BN part_collision bashes it
   * with that (it may break and let `v` through, slower); otherwise the wall takes the normal
   * speed (no bounce) and some scrape, so a glancing hit slides along it and an off-centre one
   * swings the body round. True = held, `v` stops this substep.
   */
  private terrainContactM(v: Vehicle, part: VehiclePart, tx: number, ty: number, ob: Obstacle, px: number, py: number, [nx, ny]: [number, number]): boolean {
    const map = this.game.map, z = v.z;
    const a = this.contactBody(v, px, py);
    const into = -(a.pvx * nx + a.pvy * ny);
    this.contactN = [nx, ny];
    // Touching, not driving into it (a corner resting on a wall while turning away): blocked.
    if (into < CLOSING_MIN) return true;
    let smashedAny = false;
    const r = resolveCollision({
      mass: a.m, velocity: into, mass2: ob.mass2, e: ob.e, partDens: ob.dens,
      smash: ob.bashable ? (objDmg) => {
        if (!this.onBash(tx, ty, z, objDmg)) return false;
        smashedAny = true;
        return !obstacleAt(map, tx, ty, z, false);
      } : undefined,
    });
    this.damagePart(v, part, r.partDmg);
    this.impactMessage(v, part, ob.name, 'smash!');
    this.emitSound(v, r.smashed ? 80 : 50, 'smash!', ['smash_success', 'hit_vehicle'], 'combat');
    if (smashedAny) v.version++;
    if (r.smashed) {
      // Through it, minus the speed the smash took (along the normal only).
      const lost = Math.max(0, into - Math.max(0, r.velocity));
      this.applyImpulse(v, nx * lost * a.m, ny * lost * a.m, a.cx, a.cy);
      return false;
    }
    const wall: ContactBody = { m: Infinity, I: Infinity, cx: px, cy: py, pvx: 0, pvy: 0 };
    const j = contactImpulse(a, wall, px, py, nx, ny, WALL_RESTITUTION, WALL_FRICTION);
    const before = v.velocity;
    this.applyImpulse(v, j.jx, j.jy, px, py);
    // A wall doesn't throw you backwards (CDDA stops you): no reversing off it, nor creeping.
    if (Math.abs(v.velocity) < 0.5 || Math.sign(v.velocity) !== Math.sign(before)) v.velocity = 0;
    return true;
  }

  /**
   * Move a struck vehicle now by its own velocity for this frame (if it hasn't moved yet), so
   * whatever pushes it isn't held up a frame by its turn order in `list`. Collision-checked
   * like any move: it can push the next one along (chains) or be pinned. True if it moved.
   */
  private advanceStruck(o: Vehicle): boolean {
    if (this.moved.has(o)) return false;
    const m = motionOf(o);
    if (settled(m) && Math.abs(o.velocity) < STOP_EPS) return false;
    this.moved.add(o);
    const [x0, y0, f0] = [o.x, o.y, o.facing];
    const dt = this.frameDt;
    this.move(o, o.velocity * dt, m.yaw * dt, m.sx * dt, m.sy * dt, m.spin * dt);
    return o.x !== x0 || o.y !== y0 || o.facing !== f0;
  }

  /** Jolt the player if they ride `v` (driving it or inside it) by `dVelMph` of velocity change. */
  private joltRiders(v: Vehicle, dVelMph: number): void {
    if (dVelMph <= 1) return;
    if (this.driving === v || this.playerOn()?.v === v) this.jolt(v, dVelMph);
  }

  /**
   * `v`'s `part` runs into another vehicle at `other`'s mount. A much lighter one is shoved
   * aside (true = not stopped); otherwise both take BN's collision damage and `v` stops.
   * `blocked` / `pusher`: where the shoved vehicle can't go (see shove).
   */
  private crashVehicle(v: Vehicle, part: VehiclePart, other: VehicleOccupant, fdx: number, fdy: number, blocked: Set<number>, pusher: Pusher | null): boolean {
    const mass = v.mass();
    // A much lighter one (a bicycle, a shopping cart) is shoved out of the way instead: a car
    // that stopped dead against a bike lying on the road felt broken in playtesting.
    if (other.v !== this.driving && other.v.mass() < mass * 0.2 && Math.abs(v.velocity) > 0.5 && this.shove(other.v, fdx, fdy, blocked, pusher)) {
      const r = resolveCollision({ mass, velocity: v.velocity, mass2: other.v.mass(), e: 0.3, partDens: 80 });
      this.damagePart(other.v, collisionPart(other.v, other.mx, other.my), r.objDmg);
      this.impactMessage(v, part, `the ${other.v.name}`, 'crash!');
      this.emitSound(v, 50, 'crash!', ['smash_success', 'hit_vehicle'], 'combat');
      v.velocity *= mass / (mass + other.v.mass());
      return false;
    }
    // Another vehicle: treat as a heavy obstacle (no momentum transfer yet).
    const r = resolveCollision({ mass, velocity: v.velocity, mass2: other.v.mass(), e: 0.3, partDens: 80 });
    this.damagePart(v, part, r.partDmg);
    this.damagePart(other.v, collisionPart(other.v, other.mx, other.my), r.objDmg);
    this.impactMessage(v, part, `the ${other.v.name}`, 'smash!');
    this.emitSound(v, 50, 'smash!', ['smash_success', 'hit_vehicle'], 'combat');
    v.velocity = Math.abs(r.velocity) < 0.3 ? 0 : r.velocity;
    return true;
  }

  /**
   * `v`'s `part` runs into terrain/furniture obstacle `ob` at tile (tx, ty): BN part_collision
   * (bash it with the object's share of the impact). True if it held and stopped the vehicle.
   */
  private crashTerrain(v: Vehicle, part: VehiclePart, tx: number, ty: number, ob: Obstacle, velBefore: number): boolean {
    const map = this.game.map, z = v.z;
    let smashedAny = false;
    const r = resolveCollision({
      mass: v.mass(), velocity: v.velocity, mass2: ob.mass2, e: ob.e, partDens: ob.dens,
      smash: ob.bashable ? (objDmg) => {
        if (!this.onBash(tx, ty, z, objDmg)) return false;
        smashedAny = true;
        // Whatever the bash left behind may still be in the way (wall -> broken wall).
        return !obstacleAt(map, tx, ty, z, false);
      } : undefined,
    });
    this.damagePart(v, part, r.partDmg);
    this.impactMessage(v, part, ob.name, 'smash!');
    this.emitSound(v, r.smashed ? 80 : 50, 'smash!', ['smash_success', 'hit_vehicle'], 'combat');
    v.velocity = r.velocity;
    if (r.smashed) return false;
    if (Math.abs(v.velocity) < 0.5 || Math.sign(v.velocity) !== Math.sign(velBefore)) v.velocity = 0;
    if (smashedAny) v.version++;
    return true;
  }

  /**
   * Push a light vehicle off to the side of (dx, dy), else 1–3 tiles along it, to the first
   * spot it fits: walkable, clear of other vehicles, creatures and you, and of the pushing
   * vehicle. Whole tiles: its footprint vs the pusher's new footprint (`blocked`); with a
   * drawn `pusher` body, the boxes (vehicleObbs) vs the pusher's box and other vehicles'.
   * False (nothing moved) when pinned.
   */
  private shove(o: Vehicle, dx: number, dy: number, blocked: Set<number>, pusher: Pusher | null): boolean {
    const map = this.game.map;
    const p = this.game.player;
    const sx = Math.round(dx), sy = Math.round(dy);
    const clearTile = (tx: number, ty: number) => !this.creatureHooks.at(tx, ty, o.z) && !(p.tileX === tx && p.tileY === ty && p.z === o.z);
    // Aside first (a snowplowed bike just gets hit again), then straight ahead.
    const tries: [number, number][] = [[sx - sy * 2, sy + sx * 2], [sx + sy * 2, sy - sx * 2], [sx * 2 - sy * 2, sy * 2 + sx * 2], [sx * 2 + sy * 2, sy * 2 - sx * 2], [sx, sy], [sx * 2, sy * 2], [sx * 3, sy * 3]];
    for (const [ox, oy] of tries) {
      if (!ox && !oy) continue;
      let ok: boolean;
      if (pusher) {
        const shapes = vehicleObbs(o, this.bodyRect(o), o.facing, o.x + ox, o.y + oy);
        ok = shapes.every((s) => {
          if (obbHitsObb(s, pusher.obb)) return false;
          const [x0, y0, x1, y1] = obbBounds(s);
          for (let ty = Math.floor(y0); ty <= Math.floor(y1); ty++)
            for (let tx = Math.floor(x0); tx <= Math.floor(x1); tx++) {
              if (!obbHitsTile(s, tx, ty)) continue;
              const ter = map.terAt(tx, ty, o.z), furn = map.furnAt(tx, ty, o.z);
              if (ter.move_cost <= 0 || furn.move_cost_mod < 0 || this.overlayBlocks(tx, ty, o.z) || !clearTile(tx, ty)) return false;
            }
          return this.vehiclesNear(o, o.z, [x0, y0, x1, y1]).every((w) => w === pusher.v || vehicleObbs(w, this.bodyRect(w)).every((t) => !obbHitsObb(s, t)));
        });
      } else {
        ok = o.occupiedTiles(o.facing, o.x + ox, o.y + oy).every((t) => {
          const k = tileKey(t.tx, t.ty, o.z);
          const there = this.index.get(k);
          return !blocked.has(k) && (!there || there.every((q) => q.v === o)) && map.passable(t.tx, t.ty, o.z) && clearTile(t.tx, t.ty);
        });
      }
      if (!ok) continue;
      o.x += ox;
      o.y += oy;
      o.velocity = 0;
      this.reindex(o);
      o.version++;
      return true;
    }
    return false;
  }

  /**
   * Plan the throw of a creature the vehicle is about to hit (runoverMode 'ragdoll' / 'loose'):
   * launched along the vehicle's velocity at the hit, off the side it was struck on, through the
   * map (walls, other vehicles, ledges and roofs; not this vehicle, which it flies over). False
   * when it can't be (BN's teleport fling then applies).
   */
  private planRunover(v: Vehicle, c: unknown, cx: number, cy: number, nf: number, nx: number, ny: number, free: (tx: number, ty: number) => boolean): boolean {
    const h = this.creatureHooks;
    if (this.runoverMode === 'fall' || !h.planFling) return false;
    const [vx, vy] = this.planarVelocity(v);
    // BN flings only above 5 mph; slower, the creature stops the vehicle
    if (Math.hypot(vx, vy) * MPH_PER_MS <= 5) return false;
    const rect = this.physRect(v);
    const [, ly] = v.worldToMount(cx, cy, nf, nx, ny);
    const half = Math.max(0.3, (rect.y1 - rect.y0) / 2);
    // mount +y is the vehicle's right; reversing, the right of the travel is its left
    const rad = (nf * Math.PI) / 180;
    const fwd = Math.sign(vx * Math.cos(rad) + vy * Math.sin(rad)) || 1;
    const offset = Math.max(-1, Math.min(1, ((ly - (rect.y0 + rect.y1) / 2) / half) * fwd));
    const map = this.game.map, z = v.z;
    const world: FlingWorld = {
      blocked: (tx, ty) => {
        const ter = map.terAt(tx, ty, z);
        if (ter.move_cost <= 0 || map.furnAt(tx, ty, z).move_cost_mod < 0 || !map.hasFloor(tx, ty, z)) return true;
        const l = this.index.get(tileKey(tx, ty, z));
        return !!l && l.some((o) => o.v !== v && o.v.moveCostAt(o.mx, o.my) === 0);
      },
      roofed: (tx, ty) => map.hasFloor(tx, ty, z + 1),
      free,
    };
    return h.planFling(c, { x: cx, y: cy, vx, vy, offset, mass: h.mass(c), seed: this.rng.next() }, world);
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

  private hitBody(v: Vehicle, part: VehiclePart, target: { name: string; mass: number; hpMax?: number; damage: (dmg: number) => boolean; fling: (force: number) => boolean }): boolean {
    let dead = false, flung = false;
    // A vehicle sliding from a crash hits with its whole speed, not just the part along its wheels.
    const m = motionOf(v);
    const sliding = this.crashModel === 'momentum' && !settled(m);
    const speed = sliding ? Math.hypot(...this.planarVelocity(v)) : v.velocity;
    // BN's impulse model (resolveBodyCollision); the part's damage_modifier is applied inside.
    const r = resolveBodyCollision({
      mass: v.mass(), velocity: speed, mass2: target.mass, damageModifier: part.def.damage_modifier, hpMax: target.hpMax ?? 100,
      hit: (objDmg) => {
        const dam = Math.round(objDmg);
        if (dam > 0) dead = target.damage(dam) || dead;
        // Fling when the vehicle hits hard enough (CDDA: |vel2_a| > 10 mph or momentum).
        const vmph = Math.abs(speed) * MPH_PER_MS;
        if (!dead && vmph > 5) flung = target.fling(vmph);
        return dead || flung;
      },
    });
    this.damagePart(v, part, r.partDmg);
    if (r.objDmg > 20) part.blood = Math.min(600, part.blood + 50 + r.objDmg * 2.5);
    if (this.driving === v) this.say(`Your ${v.name}'s ${part.def.name} rams into ${target.name}${dead ? ', killing it' : ''}!`, dead ? 'c_light_green' : 'c_yellow');
    this.emitSound(v, 20, 'smash!', ['smash_success', 'hit_vehicle'], 'combat');
    if (sliding) {
      const k = speed > 0 ? Math.max(0, r.velocity) / speed : 0;
      v.velocity *= k;
      m.sx *= k;
      m.sy *= k;
    } else v.velocity = r.velocity;
    if (!(dead || flung)) {
      v.velocity = 0;
      m.sx = m.sy = 0;
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
    const p = this.game.player;
    // The belt of the seat you're in: the driver's, or (riding along) the one under you.
    const [lx, ly] = v.worldToMount(p.x, p.y);
    const seat = this.driving === v ? v.driverSeat() : { mx: Math.round(lx), my: Math.round(ly) };
    const belt = seat ? v.partsAt(seat.mx, seat.my).find((q) => has(q, 'SEATBELT') && q.hp > 0) : undefined;
    let dmg = Math.round(passengerImpactDamage(dVelMph, belt?.def.bonus ?? 0, this.rng) * BALANCE.crashDamage);
    // Momentum crashes: only a real wreck (your own vehicle's speed changing by LETHAL_JOLT_MPH
    // or more) can kill you outright; anything less leaves the torso on 1 HP at worst.
    if (this.crashModel === 'momentum' && dVelMph < LETHAL_JOLT_MPH) dmg = Math.min(dmg, Math.max(0, p.hp.torso.cur - 1));
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
        const to = L.ground(this.game.map, Math.floor(wx), Math.floor(wy), v.z);
        for (const it of [...part.items]) moveItem(it, L.cargo(part, v), to, { force: true, quiet: true });
      }
    }
  }

  // --- persistence ----------------------------------------------------------------------

  toJSON(): VehicleSaveJSON {
    const at = this.stations.at, st = this.stations.current();
    return {
      vehicles: this.list.map((v) => v.toJSON()), driving: this.driving?.uid ?? null, pending: [...this.pending],
      ...(this.towing.links.length ? { tows: this.towing.toJSON() } : {}),
      ...(at && st && !this.driving ? { station: { uid: at.v.uid, i: at.i, kind: st.kind, mx: st.mx, my: st.my } } : {}),
    };
  }

  /** Replace all vehicle state (save/load). Unknown prototypes/parts are dropped via `warn`. */
  fromJSON(data: GameData, j: VehicleSaveJSON, opts: { warn?: (msg: string) => void; loadItem?: (j: ItemJSON) => Item | null } = {}): void {
    this.clear();
    for (const vj of j.vehicles ?? []) {
      if (!this.vdata.vehicles[vj.proto]) {
        (opts.warn ?? console.warn)(`dropped vehicle of unknown prototype ${vj.proto}`);
        continue;
      }
      const v = Vehicle.fromJSON(this.vdata, data, vj, opts);
      // Save migration (one-time, VehicleJSON.chassis absent = a pre-v3 grid): add() maps
      // it onto a template with the same routine as spawns; saving writes the template.
      if (!vj.chassis) this.migrated++;
      this.add(v);
    }
    if (this.migrated) console.info(`[chassis] mapped ${this.migrated} saved grid vehicle(s) onto chassis templates`);
    this.pending = [...(j.pending ?? [])];
    this.towing.fromJSON(j.tows ?? [], opts.warn ?? console.warn);
    this.driving = this.list.find((v) => v.uid === j.driving) ?? null;
    if (this.driving) this.claimMovement();
    this.stations.leave();
    // Back at the station you saved at (the nearest-station fallback picked the gunner's seat
    // when you saved at the hatch on the same cell). Checked against its cell and kind, so a
    // station list that changed since (another walk mode, a part gone) finds it by those.
    const sj = j.station, sv = sj && !this.driving ? this.list.find((v) => v.uid === sj.uid) : undefined;
    if (sj && sv) {
      const list = this.stations.stations(sv);
      const same = (s: Station | undefined) => !!s && s.kind === sj.kind && s.mx === sj.mx && s.my === sj.my;
      const i = same(list[sj.i]) ? sj.i : list.findIndex(same);
      if (i >= 0) this.stations.enter(sv, i);
    }
  }

  /** Remove every vehicle and forget queued requests. */
  clear(): void {
    for (const v of [...this.list]) this.remove(v);
    this.migrated = 0;
    this.pending = [];
    this.driving = null;
    this.input = { throttle: 0, steer: 0, brake: false };
    this.soundAcc.clear();
    this.towing.clear();
    this.engineSounds.stopAll();
    this.load.clear();
  }
}

/**
 * Run-over hooks backed by the monster system (src/game/monai.ts): CDDA part_collision's
 * body branch applies torso damage, may stun, and flings the critter away.
 */
export function monsterCreatureHooks(ms: MonsterSystem): CreatureHooks {
  return {
    // a body already flying from an earlier hit can't be hit again until it lands
    at: (x, y, z) => {
      const m = ms.monsterAt(x, y, z);
      return m && !(m.fling && m.fling.t >= 0) ? m : null;
    },
    mass: (c) => Math.max(1, ((c as Monster).type.weight ?? 80000) / 1000),
    hpMax: (c) => (c as Monster).hpMax,
    damage: (c, dmg, v) => {
      const m = c as Monster;
      const stun = (m.rng.int(0, dmg) > 10 ? 1 : 0) + (m.rng.int(0, dmg) > 40 ? 1 : 0);
      if (stun) m.addEffect('stunned', stun / ACTION_SCALE);
      // BN: minus the torso's bash armor, then apply_damage(driver) — the kill is the
      // driver's (stats, achievements, progression), a runaway car's is nobody's.
      const armored = Math.max(0, dmg - (m.type.armor?.bash ?? 0));
      ms.hurt(m, armored, ms.game.vehicles?.driving === v ? 'player' : null);
      return m.dead;
    },
    place: (c, x, y) => {
      const m = c as Monster;
      m.x = x;
      m.y = y;
      m.addEffect('downed', 1);
    },
    name: (c) => (c as Monster).displayName(),
    planFling: (c, imp, world) => {
      const m = c as Monster;
      if (m.has('IMMOBILE')) return false;
      const plan = planFling(m.x, m.y, launchFromImpact(imp), world, imp.seed);
      if (!plan) return false;
      m.fling = { plan, t: -1, world };
      return true;
    },
    launch: (c) => {
      const m = c as Monster;
      if (!m.fling) throw new Error(`launch: ${m.type.id} #${m.uid} has no planned flight`);
      m.fling.t = 0;
      m.dashTime = 0;
      // down for the flight, then a moment on the ground before it gets up (the old fling: 1 s)
      m.addEffect('downed', m.fling.plan.duration + RUNOVER.getUp);
    },
    cancelFling: (c) => {
      const m = c as Monster;
      if (m.fling && m.fling.t < 0) m.fling = null;
    },
  };
}

/**
 * Run-over hooks for NPCs (src/game/npcai.ts `game.npcs`, looked up per call because the NPC
 * system is installed after vehicles). CDDA vehicle::part_collision on a character: the impact
 * damage goes to the torso unmitigated (apply_damage), a hard hit stuns and the body is flung
 * and downed like a monster; npcai's afterHit does the rest (death drops, anger, the faction
 * turning on you). No confirmation for friendlies: at speed there's no time to ask, and CDDA
 * doesn't either.
 */
export function npcCreatureHooks(game: Game, vs: VehicleSystem): CreatureHooks {
  const sys = () => (game as unknown as { npcs?: NpcSystem }).npcs;
  return {
    at: (x, y, z) => sys()?.npcAt(x, y, z) ?? null,
    mass: (c) => Math.max(1, (c as Npc).bodyweightKg()),
    damage: (c, dmg, v) => {
      const n = c as Npc;
      const s = sys();
      const byPlayer = vs.driving === v;
      const r = n.takeHit('torso', [{ type: 'bash', amount: dmg }]);
      if (byPlayer) game.message(`You hit ${n.name} with your ${v.name}!`, 'c_yellow');
      if (!n.dead) {
        // CDDA: stunned for (rng(0, dam) > 10) + (rng(0, dam) > 40) turns.
        const stun = (vs.rng.int(0, dmg) > 10 ? 1 : 0) + (vs.rng.int(0, dmg) > 40 ? 1 : 0);
        if (stun) n.addEffect('stunned', turnsToEffectSeconds(stun));
      }
      // Anything but a player-driven car is an accident with nobody to blame.
      if (s) s.afterHit(n, r.damage, (byPlayer ? { kind: 'player' } : { kind: 'npc', n }) as Parameters<NpcSystem['afterHit']>[2]);
      else n.checkDeath();
      return n.dead;
    },
    place: (c, x, y) => {
      const n = c as Npc;
      n.x = x;
      n.y = y;
      n.addEffect('downed', turnsToEffectSeconds(1));
    },
    name: (c) => (c as Npc).name,
    title: (c) => (c as Npc).name,
  };
}

/**
 * Several creature populations as one CreatureHooks: `at` asks each in turn and remembers who
 * answered, so damage/place/name go to the system that owns that creature.
 */
export function composeCreatureHooks(list: CreatureHooks[]): CreatureHooks {
  const owner = new WeakMap<object, CreatureHooks>();
  const of = (c: unknown): CreatureHooks => {
    const h = owner.get(c as object);
    if (!h) throw new Error('composeCreatureHooks: creature not found through at()');
    return h;
  };
  return {
    at: (x, y, z) => {
      for (const h of list) {
        const c = h.at(x, y, z);
        if (c) {
          if (typeof c === 'object') owner.set(c as object, h);
          return c;
        }
      }
      return null;
    },
    mass: (c) => of(c).mass(c),
    damage: (c, dmg, v) => of(c).damage(c, dmg, v),
    place: (c, x, y) => of(c).place(c, x, y),
    name: (c) => of(c).name(c),
    planFling: (c, imp, w) => of(c).planFling?.(c, imp, w) ?? false,
    launch: (c) => of(c).launch!(c),
    cancelFling: (c) => of(c).cancelFling?.(c),
    title: (c) => {
      const h = of(c);
      return h.title ? h.title(c) : `the ${h.name(c)}`;
    },
  };
}

export interface VehicleSaveJSON {
  vehicles: VehicleJSON[];
  /** uid of the vehicle the player is driving */
  driving: number | null;
  /** mapgen requests queued but not yet placed */
  pending: VehicleRequest[];
  /** The vehicle station you're at (vehwalk.ts), when not driving. */
  station?: { uid: number; i: number; kind: string; mx: number; my: number };
  /** Tow cables between vehicles (towing.ts), by vehicle uid and cable-part mount. */
  tows?: TowLinkJSON[];
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
 * CDDA is_bashable_ter_furn(p, allow_floor = false): floor-only bashes ("bash_below", e.g.
 * grass) don't count. Plain floors without bash_below (t_floor, pavement) are excluded by
 * the caller's move cost 2 check, exactly like vehicle_move.cpp.
 */
function wallBash(d: TerrainDef | FurnitureDef): boolean {
  return !!d.bash && !d.bash.bash_below;
}

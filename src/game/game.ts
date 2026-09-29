import { EventBus } from '../core/events';
import { GameClock } from '../core/time';
import type { Input } from '../core/input';
import type { GameData } from '../data/types';
import { GameMap } from '../world/map';
import { PlayerAvatar } from './player';
import { moveWithCollision } from './physics';
import { fromSpawned } from './item';
import { ActivityManager } from './activity';
import { Keys } from '../ui/keys';
import { GameStats } from './stats';
import type { RayHit } from './raycast';
import type { SpawnedItem } from '../data/itemgroups';
import type { ItemSpawn } from '../world/map';
import type { VehicleSystem } from './vehicles';
import type { WeatherState } from './weather';

function toSpawned(sp: ItemSpawn): SpawnedItem {
  return { id: sp.typeId, count: sp.count ?? 1, charges: sp.charges, contents: sp.contents?.map(toSpawned) } as SpawnedItem;
}

// Game owns all simulation state and advances it with a fixed timestep; rendering and UI
// only read from it. Subsystems register via `systems` so features can be added without
// editing this file's update loop.

export const TICK = 1 / 30;

export interface GameSystem {
  name: string;
  /** realDt: seconds of real time; gameDt: game-clock seconds elapsed this tick. */
  update(game: Game, realDt: number, gameDt: number): void;
}

/** Minimal creature shape the UI needs for look mode; monsters may carry more. */
export interface LookCreature {
  name: string;
  /** Extra look-mode lines (CDDA-tagged), e.g. "It is uninjured." */
  describe?: () => string;
  symbol?: string;
  color?: string;
}

export class Game {
  readonly events = new EventBus();
  readonly clock = new GameClock();
  readonly map: GameMap;
  readonly player: PlayerAvatar;
  readonly systems: GameSystem[] = [];
  readonly activities: ActivityManager;
  readonly keys: Keys;
  paused = false;
  /** Modal UI (input.captured) pauses the simulation like CDDA's turn-based menus. */
  pauseInMenus = true;
  /** Run statistics for the memorial screen (src/game/stats.ts). */
  readonly stats = new GameStats();
  /** Overmap tiles the player has seen, keys "omx,omy,z" (filled by the UI's overmap tracker). */
  readonly overmapSeen = new Set<string>();
  /**
   * Creature standing in a tile, for raycasts/look mode. The monster system replaces this;
   * return null for empty tiles and never the player.
   */
  creatureAt: (x: number, y: number, z: number) => LookCreature | null = () => null;
  /** What the crosshair points at (set by the UI from the active camera; null until then). */
  lookAt: (maxDist?: number) => RayHit<LookCreature> | null = () => null;
  /** Save/load hooks for a future save system; the UI greys out Save/Load while unset. */
  save?: () => void | Promise<void>;
  load?: () => boolean | Promise<boolean>;
  hasSave?: () => boolean;
  /** Vehicles in the world (src/game/vehicles.ts); set by installVehicles. */
  vehicles: VehicleSystem | null = null;
  /** When it returns true, WASD doesn't walk the player (e.g. driving: src/game/vehicles.ts). */
  movementOverride: (() => boolean) | null = null;
  /**
   * Exact world light at a tile in CDDA units (natural + placed sources, shadowcast), or
   * null where the provider has no exact value. main.ts backs it with the renderer's light
   * map (player's z-level, 64 tiles); vision.ts lightAt uses it first and falls back to its
   * own estimate (and headless tests have no provider). Keeps three.js out of src/game.
   */
  lightProvider: ((x: number, y: number, z: number) => number | null) | null = null;
  /** Current weather (src/game/weather.ts); null until installWeather runs. Read by HUD/sound/vision. */
  weather: WeatherState | null = null;
  private acc = 0;
  mouseSensitivity = 0.0025;

  constructor(readonly data: GameData, readonly seed: number, readonly input: Input) {
    this.map = new GameMap(seed);
    this.keys = new Keys(input);
    this.activities = new ActivityManager(this);
    this.systems.push(this.activities);
    this.player = new PlayerAvatar(data, { seed });
    this.player.onMessage = (text, color) => this.message(text, color);
    this.player.onDeath = (cause) => this.events.emit('playerDied', { cause });
    for (const t of Object.values(data.terrain)) this.map.terrain.add(t);
    for (const f of Object.values(data.furniture)) this.map.furniture.add(f);
    this.map.itemFactory = (sp) => fromSpawned(data, (sp.spawned as SpawnedItem | undefined) ?? toSpawned(sp));
  }

  message(text: string, color?: string): void {
    this.events.emit('message', { text, color });
  }

  frame(realDt: number): void {
    // Mouse look is applied per frame (not per tick) so it stays perfectly smooth.
    const [mx, my] = this.input.consumeMouse();
    const p = this.player;
    p.yaw += mx * this.mouseSensitivity;
    p.pitch = Math.max(-1.5, Math.min(1.5, p.pitch - my * this.mouseSensitivity));
    if (this.paused || (this.pauseInMenus && this.input.captured)) return;
    this.acc = Math.min(this.acc + realDt, 0.25);
    while (this.acc >= TICK) {
      this.tick(TICK);
      this.acc -= TICK;
    }
  }

  tick(dt: number): void {
    const gameDt = this.clock.advanceReal(dt);
    this.updatePlayerMovement(dt);
    this.player.update(gameDt);
    for (const s of this.systems) s.update(this, dt, gameDt);
  }

  private updatePlayerMovement(dt: number): void {
    const p = this.player;
    const k = this.input.held;
    if (this.input.captured) return;
    if (this.movementOverride?.()) return;
    let fx = 0, fy = 0;
    if (k.has('KeyW')) fy += 1;
    if (k.has('KeyS')) fy -= 1;
    if (k.has('KeyD')) fx += 1;
    if (k.has('KeyA')) fx -= 1;
    p.running = k.has('ShiftLeft') || k.has('ShiftRight');
    if (fx === 0 && fy === 0) return;
    const len = Math.hypot(fx, fy);
    fx /= len; fy /= len;
    // forward = (sin yaw, -cos yaw) in world (x east, y south)
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const wx = fy * sin + fx * cos;
    const wy = -fy * cos + fx * sin;
    // Terrain move_cost is in units of 50 moves (CDDA: 2 = flat ground = 100 moves).
    const cost = (this.map.moveCost(p.tileX, p.tileY, p.z) || 2) * 50;
    const v = p.moveSpeed(cost) * dt;
    const [ox, oy] = [p.x, p.y];
    [p.x, p.y] = moveWithCollision(this.map, p.x, p.y, p.z, wx * v, wy * v);
    p.onMoved(Math.hypot(p.x - ox, p.y - oy), cost);
  }
}

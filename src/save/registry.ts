import type { Game } from '../game/game';
import type { GameData } from '../data/types';

// Save registry: every system that owns persistent state plugs in here, so the save module
// never has to know about vehicles, weather, the message log, ... Each saveable produces a
// JSON-serializable section under its key and restores it on load.
//
//   import { registerSaveable } from '../save/registry';
//   registerSaveable(game, 'vehicles', {
//     order: 30,                                   // after the map (0) and player (10)
//     save: () => vehicles.map((v) => v.toJSON()),
//     load: (data, ctx) => { clearVehicles(); for (const v of data as VehicleJSON[]) spawnFrom(v); },
//     missing: () => clearVehicles(),              // save predates this system
//   });
//
// The registry is per Game (tests build several games in one process).

export interface LoadContext {
  game: Game;
  data: GameData;
  /** Save format version of the file being loaded. */
  version: number;
  /** Report a recoverable problem (unknown id dropped, ...); collected and logged once. */
  warn(msg: string): void;
}

export interface Saveable<T = unknown> {
  /** Snapshot this system's state as plain JSON data (no class instances, no Maps). */
  save(): T;
  /** Restore from a section written by save(). Must replace (not merge into) current state. */
  load(data: T, ctx: LoadContext): void;
  /** The file has no section for this key (older save, or the system is new): reset to defaults. */
  missing?(ctx: LoadContext): void;
  /**
   * Load order, lowest first. Built-ins: map 0, clock/world 5, player 10, monsters 20.
   * Default 50 — anything that references map items or the player should load after them.
   */
  order?: number;
}

export class SaveRegistry {
  private entries = new Map<string, Saveable<any>>();

  register<T>(key: string, s: Saveable<T>): () => void {
    if (this.entries.has(key)) throw new Error(`saveable "${key}" registered twice`);
    this.entries.set(key, s);
    return () => {
      if (this.entries.get(key) === s) this.entries.delete(key);
    };
  }
  has(key: string): boolean {
    return this.entries.has(key);
  }
  keys(): string[] {
    return this.sorted().map(([k]) => k);
  }
  /** [key, saveable] sorted by load order (ties: registration order). */
  sorted(): [string, Saveable<unknown>][] {
    return [...this.entries].sort((a, b) => (a[1].order ?? 50) - (b[1].order ?? 50));
  }
}

const registries = new WeakMap<Game, SaveRegistry>();

export function saveRegistry(game: Game): SaveRegistry {
  let r = registries.get(game);
  if (!r) registries.set(game, (r = new SaveRegistry()));
  return r;
}

/** Plug a system's state into save/load. Returns an unregister function. */
export function registerSaveable<T>(game: Game, key: string, s: Saveable<T>): () => void {
  return saveRegistry(game).register(key, s);
}

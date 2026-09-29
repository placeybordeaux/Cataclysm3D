import type { Game } from '../game/game';
import type { Chunk } from '../world/map';
import { chunkKey } from '../world/coords';
import { chunkMapDamage } from '../game/bash';

// Which chunks must go into a save? Generation is deterministic from the world seed, so only
// chunks that differ from what the generator would produce again are stored ("dirty").
//
// A chunk's baseline is captured right after the generator filled it, before the other
// onChunkGenerated hooks run (the spawner laying dormant-zombie corpses is already a change
// the generator won't redo). It is dirty when any of these hold:
//   - its `version` moved (every map API mutation and every renderer-visible direct write
//     bumps it: setTer/setFurn/addItem/removeItem/addField, fields.ts, traps.ts, late
//     z-level overlays from worldgen),
//   - its content fingerprint changed (catches in-place edits that don't bump the version:
//     taking an item out of a container lying on the ground, rot, field ageing, signs),
//   - it has persistent bash damage (bash.ts keeps it outside the chunk),
//   - it was restored from a save (it is authoritative; regenerating would lose changes).

interface Baseline {
  version: number;
  hash: number;
}

export class ChunkTracker {
  private base = new WeakMap<Chunk, Baseline>();
  private restored = new WeakSet<Chunk>();
  /** Chunk keys generated in sessions before the loaded save (from the save file). */
  readonly priorGenerated = new Set<string>();
  /** Chunk keys generated since this game started or was loaded. */
  readonly sessionGenerated = new Set<string>();

  constructor(readonly game: Game) {}

  install(): this {
    const map = this.game.map;
    // Chunks that already exist (install called late) take their current state as baseline.
    for (const c of map.loadedChunks()) this.snapshot(c);
    // unshift: must run before the spawner (and any other hook that edits the fresh chunk).
    map.onChunkGenerated.unshift((c) => this.snapshot(c));
    map.overlayFilter = (target, sourceKey) => !(this.restored.has(target) && this.priorGenerated.has(sourceKey));
    return this;
  }

  private snapshot(c: Chunk): void {
    this.base.set(c, { version: c.version, hash: chunkFingerprint(c) });
    this.sessionGenerated.add(chunkKey(c.cx, c.cy, c.z));
  }

  /** A chunk put back from a save: always dirty from now on. */
  markRestored(c: Chunk): void {
    this.restored.add(c);
  }

  isRestored(c: Chunk): boolean {
    return this.restored.has(c);
  }

  /**
   * Accept the chunk's current content as its generated state. Only for changes the world
   * re-derives on its own when the chunk is regenerated (the actualizer rotting mapgen food
   * from day 0): otherwise every chunk you walked past would count as modified, be kept in
   * memory forever and be written to every save.
   */
  rebaseline(c: Chunk): void {
    if (this.restored.has(c) || !this.base.has(c)) return;
    this.base.set(c, { version: c.version, hash: chunkFingerprint(c) });
  }

  isDirty(c: Chunk): boolean {
    if (this.restored.has(c)) return true;
    const b = this.base.get(c);
    // Unknown provenance (created outside the generator path): save it to be safe.
    if (!b) return true;
    if (c.version !== b.version) return true;
    if ((chunkMapDamage(c)?.size ?? 0) > 0) return true;
    return chunkFingerprint(c) !== b.hash;
  }

  /** Every chunk key ever generated in this world (written to the save for the spawner). */
  generatedKeys(): string[] {
    const all = new Set(this.priorGenerated);
    for (const k of this.sessionGenerated) all.add(k);
    return [...all];
  }

  /** Forget session state before loading a save into this game. */
  resetForLoad(prior: Iterable<string>): void {
    this.priorGenerated.clear();
    for (const k of prior) this.priorGenerated.add(k);
    this.sessionGenerated.clear();
    this.base = new WeakMap();
    this.restored = new WeakSet();
  }
}

const trackers = new WeakMap<Game, ChunkTracker>();

/**
 * Start dirty tracking. Call right after constructing the Game, before any chunk is generated
 * (main.ts does), so every chunk gets a pristine baseline.
 */
export function installChunkTracking(game: Game): ChunkTracker {
  const existing = trackers.get(game);
  if (existing) return existing;
  const t = new ChunkTracker(game).install();
  trackers.set(game, t);
  return t;
}

export function chunkTracker(game: Game): ChunkTracker | undefined {
  return trackers.get(game);
}

// ------------------------------------------------------------------ fingerprint

function fnv(h: number, n: number): number {
  h ^= n & 0xffff;
  h = Math.imul(h, 16777619);
  h ^= n >>> 16;
  return Math.imul(h, 16777619);
}
function fnvStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

/**
 * Content hash of everything a save would store for the chunk. Items hash through
 * JSON.stringify, which uses Item.toJSON (charges, damage, rot, vars, pocket contents).
 */
export function chunkFingerprint(c: Chunk): number {
  let h = 2166136261;
  for (let i = 0; i < c.ter.length; i++) h = fnv(h, c.ter[i] | (c.furn[i] << 16));
  const maps: Map<number, unknown>[] = [c.items, c.fields, c.traps, c.signs, c.graffiti, c.radiation];
  for (const m of maps) {
    h = fnv(h, m.size);
    if (m.size) h = fnvStr(h, JSON.stringify([...m]));
  }
  return h >>> 0;
}

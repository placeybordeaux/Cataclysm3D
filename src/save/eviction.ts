import type { Game, GameSystem } from '../game/game';
import type { Chunk } from '../world/map';
import { CHUNK, chunkKey } from '../world/coords';
import { chunkTracker, type ChunkTracker } from './tracking';

// Memory bound for long explorations. Every generated chunk used to stay in memory forever
// (~70 KB of JS heap per OMT column with its items), so a few in-game days of driving around
// grew the heap by hundreds of MB. Far chunks that are still identical to what the generator
// produces are dropped and simply regenerate if the player comes back.
//
// Rules that keep that invisible:
//   - Only clean chunks go (ChunkTracker.isDirty: same version, same content hash, no bash
//     damage, not restored from a save). Anything the player touched stays until it's saved.
//   - A whole column (cx, cy, every z) goes at once, or none of it. Worldgen writes a building's
//     upper floors/roof into z+1 as an overlay while generating z; if only z+1 were dropped
//     it would come back without them.
//   - The evicted key joins tracker.priorGenerated, the same set a loaded save uses for
//     "chunks generated in an earlier session": the spawner, NPC placement and vehicle
//     placement skip such chunks, so regenerating doesn't duplicate monsters/NPCs/cars (the
//     originals are still alive in their systems).

export interface EvictionOptions {
  /** Columns within this many chunks (Chebyshev) of the player are never evicted. */
  keepRadius?: () => number;
  /** Real seconds between scans. */
  interval?: number;
}

export class ChunkEvictor implements GameSystem {
  readonly name = 'chunk-eviction';
  readonly stats = { scans: 0, evicted: 0, keptDirty: 0, regenerated: 0 };
  interval: number;
  keepRadius: () => number;
  private acc = 0;
  private evictedKeys = new Set<string>();

  constructor(readonly game: Game, readonly tracker: ChunkTracker, opts: EvictionOptions = {}) {
    this.interval = opts.interval ?? 3;
    this.keepRadius = opts.keepRadius ?? (() => 8);
    // Count chunks that came back after eviction: a steady climb while standing still means
    // some system keeps touching far tiles and we're thrashing mapgen.
    game.map.onChunkGenerated.push((c) => {
      if (this.evictedKeys.delete(chunkKey(c.cx, c.cy, c.z))) this.stats.regenerated++;
    });
  }

  update(_game: Game, realDt: number): void {
    this.acc += realDt;
    if (this.acc < this.interval) return;
    this.acc = 0;
    this.scan();
  }

  /** Evict every far clean column now. Returns the number of chunks dropped. */
  scan(): number {
    const game = this.game;
    const map = game.map;
    const p = game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const R = this.keepRadius();
    const columns = new Map<string, Chunk[]>();
    for (const c of map.loadedChunks()) {
      if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cy - pcy)) <= R) continue;
      const k = `${c.cx},${c.cy}`;
      let l = columns.get(k);
      if (!l) columns.set(k, (l = []));
      l.push(c);
    }
    this.stats.scans++;
    let n = 0;
    let dirty = 0;
    for (const list of columns.values()) {
      if (list.some((c) => !this.evictable(c))) {
        dirty++;
        continue;
      }
      for (const c of list) {
        const key = chunkKey(c.cx, c.cy, c.z);
        this.tracker.priorGenerated.add(key);
        this.evictedKeys.add(key);
        map.evictChunk(c);
        n++;
      }
      map.generator?.forgetColumn?.(list[0].cx, list[0].cy);
    }
    this.stats.evicted += n;
    this.stats.keptDirty = dirty;
    return n;
  }

  private evictable(c: Chunk): boolean {
    // Unconsumed placement requests mean some system hasn't taken its monsters/cars/NPCs yet.
    if (c.spawns.length || c.vehicles.length || c.npcSpawns.length) return false;
    return !this.tracker.isDirty(c);
  }
}

const evictors = new WeakMap<Game, ChunkEvictor>();

/** Install far-chunk eviction (needs chunk tracking from installChunkTracking). */
export function installChunkEviction(game: Game, opts: EvictionOptions = {}): ChunkEvictor {
  const existing = evictors.get(game);
  if (existing) return existing;
  const tracker = chunkTracker(game);
  if (!tracker) throw new Error('installChunkEviction: chunk tracking is not installed');
  const ev = new ChunkEvictor(game, tracker, opts);
  game.systems.push(ev);
  evictors.set(game, ev);
  return ev;
}

export function chunkEvictor(game: Game): ChunkEvictor | undefined {
  return evictors.get(game);
}

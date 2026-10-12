import { CHUNK, chunkKey, chunkOf, localOf, MIN_Z, MAX_Z } from './coords';
import { hasFlag, IdRegistry, NULL_FURN, NULL_TER } from './registry';
import type { FurnitureDef, TerrainDef } from '../data/types';

// The map is an unbounded set of lazily generated chunks. Generation is deterministic
// from the world seed, but once a chunk is generated it becomes authoritative state
// (the player may have smashed walls, dropped items) and is saved/loaded as such.

/** Minimal shape the map needs from an item; the full Item class lives in src/game/item.ts. */
export interface MapItem {
  typeId: string;
}

/**
 * Raw item placement produced by mapgen (item-group rolls, liquids, corpses). The chunk
 * never stores these: GameMap.itemFactory turns them into real items (src/game/item.ts)
 * when a generated chunk is committed, keeping src/world free of game-layer imports.
 */
export interface ItemSpawn {
  typeId: string;
  /** Stack size / charges as rolled by mapgen item groups (absent = 1 / type default). */
  count?: number;
  charges?: number;
  contents?: ItemSpawn[];
  [extra: string]: unknown;
}

/**
 * A monster spawn requested by mapgen. Creatures are not created during generation; the
 * monster system consumes `chunk.spawns` (e.g. from map.onChunkGenerated). Coordinates are
 * absolute world tiles.
 */
export interface SpawnRequest {
  /** 'monster' = a specific mtype id; 'group' = a monstergroup id to roll from */
  kind: 'monster' | 'group';
  id: string;
  x: number;
  y: number;
  z: number;
  /** For groups: CDDA spawn density multiplier (place_monsters / "monsters" mapping). */
  density?: number;
  /** CDDA chance semantics of the source entry (one-in-N for groups, % for monsters). */
  chance?: number;
  /** Pack size / number of individuals for this request (default 1). */
  count?: number;
  /** For groups placed over an area: the rectangle to scatter in (absolute tiles). */
  area?: [number, number, number, number];
  name?: string;
  friendly?: boolean;
}

/** Vehicle placement requested by mapgen (consumed by src/game/vehicles.ts). Absolute tiles. */
export interface VehicleRequest {
  id: string;
  x: number;
  y: number;
  z: number;
  rotation?: number;
  chance?: number;
  status?: number;
  fuel?: number;
}

/**
 * An NPC placed by mapgen ("npcs" / "place_npcs"), consumed (and cleared) by the NPC system
 * like monster spawns. Absolute tiles.
 */
export interface NpcSpawnRequest {
  /** npc template id */
  template: string;
  x: number;
  y: number;
  z: number;
  uniqueId?: string;
  target?: boolean;
  addTrait?: string[];
}

/** Mapgen zone (e.g. ZONE_START_POINT from the evac shelter). Absolute tile rectangle. */
export interface MapZone {
  type: string;
  faction?: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
}

export interface Field {
  /** CDDA field_type id, e.g. "fd_fire", "fd_blood", "fd_smoke" */
  type: string;
  intensity: number; // 1..3 like CDDA
  age: number; // game seconds
}

export class Chunk {
  readonly ter = new Uint16Array(CHUNK * CHUNK);
  readonly furn = new Uint16Array(CHUNK * CHUNK);
  readonly items = new Map<number, MapItem[]>();
  readonly fields = new Map<number, Field[]>();
  readonly traps = new Map<number, string>();
  /** Everything below is keyed by local tile index (ly * CHUNK + lx) unless noted. */
  readonly signs = new Map<number, string>();
  readonly graffiti = new Map<number, string>();
  /** CDDA computer definitions (name, security, options...) kept verbatim for the UI. */
  readonly computers = new Map<number, Record<string, unknown>>();
  readonly radiation = new Map<number, number>();
  spawns: SpawnRequest[] = [];
  vehicles: VehicleRequest[] = [];
  zones: MapZone[] = [];
  npcSpawns: NpcSpawnRequest[] = [];
  /** Which overmap terrain / mapgen produced this chunk (debugging, stats). */
  omt?: { id: string; source: string };
  /** Bumped on every mutation so the renderer can rebuild meshes lazily. */
  version = 0;
  /** Cached "has any tile on this chunk" hint for renderers skipping empty sky levels. */
  empty = true;
  constructor(readonly cx: number, readonly cy: number, readonly z: number) {}
}

/**
 * Something occupying tiles on top of terrain/furniture (vehicles). GameMap consults every
 * registered overlay in moveCost/opaque, so creatures, physics and vision respect it
 * without knowing what it is. Return undefined for "nothing of mine here".
 */
export interface MapOverlay {
  /** CDDA move cost replacing terrain+furniture (0 = impassable), like map::move_cost with a vehicle. */
  moveCost?(x: number, y: number, z: number): number | undefined;
  /** true = blocks sight (overlays can only add opacity). */
  opaque?(x: number, y: number, z: number): boolean | undefined;
  /**
   * Sub-tile collision (vehicles in the modelled look): true when this overlay blocks tile
   * (x, y, z) with a shape smaller than the tile, which `collide` resolves. Physics then
   * skips the whole-tile test for it.
   */
  shaped?(x: number, y: number, z: number): boolean;
  /** Does a circle at (x, y) with radius r hit any of this overlay's shapes? */
  collide?(x: number, y: number, z: number, r: number): boolean;
}

export interface ChunkGenerator {
  /** Fill a freshly allocated chunk. Must be deterministic for (seed, cx, cy, z). */
  generate(map: GameMap, chunk: Chunk): void;
  /**
   * The whole column (cx, cy) was evicted: drop any state queued for it (z-level overlays
   * waiting for a level that doesn't exist yet), because regenerating the column queues it again.
   */
  forgetColumn?(cx: number, cy: number): void;
}

export class GameMap {
  readonly terrain = new IdRegistry<TerrainDef>(NULL_TER);
  readonly furniture = new IdRegistry<FurnitureDef>(NULL_FURN);
  private chunks = new Map<string, Chunk>();
  generator: ChunkGenerator | null = null;
  /** Converts mapgen item placements into real items; set by Game. */
  itemFactory: ((spawn: ItemSpawn) => MapItem[]) | null = null;
  /**
   * BN ITEM_SPAWNRATE for chunks generated from now on (the difficulty preset sets it): below 1
   * each mapgen item spawn survives with that chance, above 1 it can repeat. Deterministic per
   * tile, so a regenerated (evicted, clean) chunk gets the same items back.
   */
  itemSpawnRate = 1;
  /** Hooks for systems that must react to spawns during generation (monsters, vehicles). */
  onChunkGenerated: ((chunk: Chunk) => void)[] = [];
  /**
   * After an existing chunk was changed by mapgen again (update_mapgen): consume any new
   * `spawns` / `vehicles` / `npcSpawns` it now carries. Not for one-time generation work.
   */
  onChunkUpdated: ((chunk: Chunk) => void)[] = [];
  /** Tile occupants consulted by moveCost/opaque (the vehicle system registers one). */
  overlays: MapOverlay[] = [];
  /** Called after a chunk was dropped by evictChunk (per-chunk state kept elsewhere can go too). */
  onChunkEvicted: ((chunk: Chunk) => void)[] = [];
  /**
   * Asked by generators before writing a late z-level overlay (mapgen of `sourceKey` spilling
   * into an already existing chunk). Save/load uses it to avoid re-applying an overlay to a
   * chunk restored from a save that already contains it. Null = always apply.
   */
  overlayFilter: ((target: Chunk, sourceKey: string) => boolean) | null = null;

  constructor(readonly seed: number) {}

  hasChunk(cx: number, cy: number, z: number): boolean {
    return this.chunks.has(chunkKey(cx, cy, z));
  }

  /** Returns the chunk, generating it if needed. z outside [MIN_Z, MAX_Z] returns null. */
  chunk(cx: number, cy: number, z: number): Chunk | null {
    // A NaN/Infinity coordinate (a view ray from a NaN pitch) would otherwise generate a chunk
    // "at NaN", whose overmap region runs the road A* without end until the tab dies of OOM.
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(z)) throw new Error(`map.chunk: non-finite coordinates (${cx}, ${cy}, ${z})`);
    if (z < MIN_Z || z > MAX_Z) return null;
    const key = chunkKey(cx, cy, z);
    let c = this.chunks.get(key);
    if (!c) {
      c = new Chunk(cx, cy, z);
      this.chunks.set(key, c);
      if (this.generator) this.generator.generate(this, c);
      for (const fn of this.onChunkGenerated) fn(c);
    }
    return c;
  }

  loadedChunks(): IterableIterator<Chunk> {
    return this.chunks.values();
  }

  /** Used by save/load to restore an authoritative chunk without regenerating. */
  putChunk(c: Chunk): void {
    this.chunks.set(chunkKey(c.cx, c.cy, c.z), c);
  }

  /**
   * Drop a chunk from memory; the next access regenerates it. Only safe for chunks identical to
   * what the generator produces (see src/save/eviction.ts, which decides what is evictable).
   */
  evictChunk(c: Chunk): void {
    const key = chunkKey(c.cx, c.cy, c.z);
    if (this.chunks.get(key) !== c) return;
    this.chunks.delete(key);
    for (const fn of this.onChunkEvicted) fn(c);
  }

  /** Forget every chunk (loading a save into a running game); they regenerate on demand. */
  clearChunks(): void {
    this.chunks.clear();
  }

  private at(x: number, y: number, z: number): [Chunk, number] | null {
    const c = this.chunk(chunkOf(x), chunkOf(y), z);
    if (!c) return null;
    return [c, localOf(y) * CHUNK + localOf(x)];
  }

  terAt(x: number, y: number, z: number): TerrainDef {
    const a = this.at(x, y, z);
    return a ? this.terrain.get(a[0].ter[a[1]]) : NULL_TER;
  }
  furnAt(x: number, y: number, z: number): FurnitureDef {
    const a = this.at(x, y, z);
    return a ? this.furniture.get(a[0].furn[a[1]]) : NULL_FURN;
  }
  setTer(x: number, y: number, z: number, id: string): void {
    const a = this.at(x, y, z);
    if (!a) return;
    a[0].ter[a[1]] = this.terrain.index(id);
    a[0].empty = false;
    a[0].version++;
  }
  setFurn(x: number, y: number, z: number, id: string): void {
    const a = this.at(x, y, z);
    if (!a) return;
    a[0].furn[a[1]] = this.furniture.index(id);
    a[0].version++;
  }

  itemsAt(x: number, y: number, z: number): MapItem[] {
    const a = this.at(x, y, z);
    if (!a) return [];
    return a[0].items.get(a[1]) ?? [];
  }
  addItem(x: number, y: number, z: number, item: MapItem): void {
    const a = this.at(x, y, z);
    if (!a) return;
    let list = a[0].items.get(a[1]);
    if (!list) a[0].items.set(a[1], (list = []));
    list.push(item);
    a[0].version++;
  }
  /** Put `item` back at position `index` of the tile's list (undoing a removal exactly). */
  insertItemAt(x: number, y: number, z: number, index: number, item: MapItem): void {
    const a = this.at(x, y, z);
    if (!a) return;
    let list = a[0].items.get(a[1]);
    if (!list) a[0].items.set(a[1], (list = []));
    list.splice(Math.min(index, list.length), 0, item);
    a[0].version++;
  }
  removeItem(x: number, y: number, z: number, item: MapItem): boolean {
    const a = this.at(x, y, z);
    if (!a) return false;
    const list = a[0].items.get(a[1]);
    const i = list ? list.indexOf(item) : -1;
    if (i < 0) return false;
    list!.splice(i, 1);
    if (list!.length === 0) a[0].items.delete(a[1]);
    a[0].version++;
    return true;
  }

  fieldsAt(x: number, y: number, z: number): Field[] {
    const a = this.at(x, y, z);
    if (!a) return [];
    return a[0].fields.get(a[1]) ?? [];
  }
  addField(x: number, y: number, z: number, type: string, intensity = 1): void {
    const a = this.at(x, y, z);
    if (!a) return;
    let list = a[0].fields.get(a[1]);
    if (!list) a[0].fields.set(a[1], (list = []));
    const f = list.find((f) => f.type === type);
    if (f) f.intensity = Math.min(3, Math.max(f.intensity, intensity));
    else list.push({ type, intensity, age: 0 });
    a[0].version++;
  }

  // --- derived queries used by movement, vision and AI ---

  /** CDDA move cost of the tile (terrain + furniture); 0 = impassable. */
  moveCost(x: number, y: number, z: number): number {
    const t = this.terAt(x, y, z);
    if (t.move_cost <= 0) return 0;
    const f = this.furnAt(x, y, z);
    if (f.move_cost_mod < 0) return 0;
    for (const o of this.overlays) {
      const c = o.moveCost?.(x, y, z);
      if (c !== undefined) return c;
    }
    return t.move_cost + f.move_cost_mod;
  }
  passable(x: number, y: number, z: number): boolean {
    return this.moveCost(x, y, z) > 0;
  }
  /** Tile (x, y, z) is blocked only by an overlay with its own sub-tile shape (see MapOverlay.shaped). */
  shapedTile(x: number, y: number, z: number): boolean {
    const t = this.terAt(x, y, z);
    if (t.move_cost <= 0 || this.furnAt(x, y, z).move_cost_mod < 0) return false;
    for (const o of this.overlays) if (o.shaped?.(x, y, z)) return true;
    return false;
  }
  /** A circle hits some overlay's sub-tile shape. */
  collideShapes(x: number, y: number, z: number, r: number): boolean {
    for (const o of this.overlays) if (o.collide?.(x, y, z, r)) return true;
    return false;
  }
  /** Blocks sight: opaque terrain/furniture lacking TRANSPARENT, as in CDDA. */
  opaque(x: number, y: number, z: number): boolean {
    for (const o of this.overlays) if (o.opaque?.(x, y, z)) return true;
    const t = this.terAt(x, y, z);
    if (t.id === 't_null') return false;
    if (!hasFlag(t, 'TRANSPARENT')) return true;
    const f = this.furnAt(x, y, z);
    return f.id !== 'f_null' && !hasFlag(f, 'TRANSPARENT');
  }
  /** Tile has a floor you can stand on (not open air). */
  hasFloor(x: number, y: number, z: number): boolean {
    const t = this.terAt(x, y, z);
    return t.id !== 't_null' && !hasFlag(t, 'NO_FLOOR');
  }
}

// Rooms for the painted look (render-only): flood-fill covered floor tiles bounded by walls,
// doors and windows. A region that reaches uncovered ground (a porch, a carport) is not a
// room. Each room gets a stable seed (from its first tile in row order), so wallpaper, paint,
// curtains and set dressing are chosen per room and agree across chunk borders as long as
// the connected room is available. Initial query margins do not clip the flood fill.
// Pure: the chunk mesher passes tile queries; unavailable/open regions get no room finish.

export type TileClass = 'floor' | 'wall' | 'opening' | 'other';

export interface RoomQueries {
  /** Optional shared cache invalidation: one snapshot per dependency region. */
  dependencyKey?(x: number, y: number): string;
  validateSnapshot?(x: number, y: number): () => boolean;
  /** Loaded data can extend beyond the initial query rectangle; never generate chunks. */
  available?(x: number, y: number): boolean;
  /** floor = walkable floor; wall = solid; opening = door / window; other = open air, fence, water... */
  cls(x: number, y: number): TileClass;
  /** something above (a roof or the next storey) */
  covered(x: number, y: number): boolean;
  /** furniture id at a tile (f_null for none) */
  furn(x: number, y: number): string;
}

export type RoomKind = 'bathroom' | 'kitchen' | 'bedroom' | 'living' | 'shop' | 'other';

export interface Room {
  seed: number;
  /** first tile in row order (the room's anchor: set dressing is emitted by its chunk) */
  ax: number;
  ay: number;
  tiles: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: RoomKind;
  /** tile keys of the room (x, y packed) */
  set: Set<string>;
}

const key = (x: number, y: number) => `${x},${y}`;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function roomKind(furn: string[]): RoomKind {
  const has = (re: RegExp) => furn.some((f) => re.test(f));
  if (has(/toilet|bathtub|shower/)) return 'bathroom';
  if (has(/oven|fridge|sink|cupboard|dishwasher/)) return 'kitchen';
  if (has(/^f_bed$|bunkbed|bed_frame|mattress/)) return 'bedroom';
  if (has(/rack|displaycase|glass_fridge|vending|clothing_rail|warehouse_shelf/)) return 'shop';
  if (has(/sofa|armchair|entertainment|coffee_table|bookcase|table|desk/)) return 'living';
  return 'other';
}

/** Bounded completed-room cache. Dependencies include walls and unavailable neighbours. */
export class RoomCache {
  private at = new Map<string, { room: Room; valid: (() => boolean)[] }>();
  get(k: string): Room | undefined {
    const entry = this.at.get(k);
    if (!entry) return;
    if (entry.valid.every(check => check())) return entry.room;
    for (const tile of entry.room.set) this.at.delete(tile);
  }
  put(room: Room, valid: (() => boolean)[]): void {
    if (this.at.size + room.tiles > 65536) this.at.clear();
    const entry = { room, valid };
    for (const tile of room.set) this.at.set(tile, entry);
  }
}

/** Rooms over a rectangle [x0, x1) x [y0, y1) (the chunk plus a margin), computed on demand. */
export class RoomMap {
  private at = new Map<string, Room | null>();
  readonly rooms: Room[] = [];

  constructor(private q: RoomQueries, private x0: number, private y0: number, private x1: number, private y1: number, private z: number, private cache?: RoomCache) {}

  /** The room tile (x, y) belongs to, or null (outdoors, a porch, not a floor). */
  room(x: number, y: number): Room | null {
    const k = key(x, y);
    const hit = this.at.get(k);
    if (hit !== undefined) return hit;
    const cached = this.cache?.get(k);
    if (cached) {
      for (const tile of cached.set) this.at.set(tile, cached);
      this.rooms.push(cached);
      return cached;
    }
    if (x < this.x0 || y < this.y0 || x >= this.x1 || y >= this.y1) return null;
    if (this.q.cls(x, y) !== 'floor' || !this.q.covered(x, y)) {
      this.at.set(k, null);
      return null;
    }
    const dependencies = new Map<string, () => boolean>();
    const track = (tx: number, ty: number) => {
      if (!this.cache || !this.q.dependencyKey || !this.q.validateSnapshot) return;
      const id = this.q.dependencyKey(tx, ty);
      if (!dependencies.has(id)) dependencies.set(id, this.q.validateSnapshot(tx, ty));
    };
    track(x, y);
    // Expand through available covered floors, even beyond the query margin. Clipping at
    // a margin invented a different anchor (and finish) in each warehouse chunk.
    const available = this.q.available ?? ((tx: number, ty: number) => tx >= this.x0 && ty >= this.y0 && tx < this.x1 && ty < this.y1);
    // A corrupt/unbounded covered map must not monopolise the main thread.
    const MAX_ROOM_TILES = 16384;
    // flood fill from here
    const tiles: [number, number][] = [];
    const seen = new Set<string>([k]);
    const stack: [number, number][] = [[x, y]];
    let open = false;
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      tiles.push([cx, cy]);
      if (tiles.length >= MAX_ROOM_TILES) { open = true; break; }
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = cx + dx, ny = cy + dy, nk = key(nx, ny);
        if (seen.has(nk)) continue;
        track(nx, ny);
        if (!available(nx, ny)) { open = true; continue; }
        const c = this.q.cls(nx, ny);
        if (c === 'wall' || c === 'opening') continue;
        if (c !== 'floor' || !this.q.covered(nx, ny)) {
          // leaks to open ground: a porch, carport or roofed yard, not a room
          open = true;
          continue;
        }
        seen.add(nk);
        stack.push([nx, ny]);
      }
    }
    let r: Room | null = null;
    if (!open) {
      let ax = tiles[0][0], ay = tiles[0][1], bx0 = ax, by0 = ay, bx1 = ax, by1 = ay;
      const furn: string[] = [];
      for (const [tx, ty] of tiles) {
        if (ty < ay || (ty === ay && tx < ax)) { ax = tx; ay = ty; }
        bx0 = Math.min(bx0, tx); by0 = Math.min(by0, ty); bx1 = Math.max(bx1, tx); by1 = Math.max(by1, ty);
        const f = this.q.furn(tx, ty);
        if (f !== 'f_null') furn.push(f);
      }
      const seed = (Math.imul(ax, 73856093) ^ Math.imul(ay, 19349663) ^ Math.imul(this.z + 7, 83492791)) >>> 0;
      r = { seed, ax, ay, tiles: tiles.length, x0: bx0, y0: by0, x1: bx1, y1: by1, kind: roomKind(furn), set: seen };
      this.rooms.push(r);
      if (dependencies.size) this.cache?.put(r, [...dependencies.values()]);
    }
    for (const k of seen) this.at.set(k, r);
    return r;
  }

  has(r: Room, x: number, y: number): boolean {
    return r.set.has(key(x, y));
  }
}

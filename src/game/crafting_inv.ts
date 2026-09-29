import type { GameData } from '../data/types';
import type { GameMap } from '../world/map';
import type { Character } from './character';
import { asArray, createItem, Item } from './item';
import { consumeItem, isAt, L, moveItem, type Loc } from './moves';

// BN's crafting_inventory: everything a crafter can draw on — carried items, items on the
// ground within reach, furniture "crafting_pseudo_item"s (a stove, an anvil …) and the
// environment (a fire nearby provides the "fire" pseudo tool). Each entry remembers exactly
// where it is (a moves.ts location), so using a component takes it from that place: either
// consumed, or moved into an in-progress craft (which holds its components until it's done).

/** Tiles around the crafter that count as "nearby" (BN PICKUP_RANGE is 6; 2 feels right in 3D). */
export const CRAFT_RANGE = 2;

export type SourceKind = 'inv' | 'map' | 'furniture' | 'environment';

export interface CraftSource {
  item: Item;
  kind: SourceKind;
  /** Where the item sits (null for pseudo tools that exist nowhere). */
  loc: Loc | null;
  /** Containing item for nested contents (e.g. the bottle holding water). */
  parent: Item | null;
  /** Map tile for 'map' / 'furniture' / 'environment' sources. */
  x?: number;
  y?: number;
  z?: number;
  /** Worn clothing itself (usable as a tool, never as a component, like BN). */
  worn?: boolean;
}

export interface CrafterPos {
  x: number;
  y: number;
  z: number;
}

/** Charges a tool offers for "tools: [[id, n]]" requirements (pseudo tools are unlimited). */
export function toolCharges(s: CraftSource): number {
  if (s.kind === 'furniture' || s.kind === 'environment') return Infinity;
  const it = s.item;
  return it.countByCharges ? it.charges : it.ammoRemaining();
}

export class CraftingInventory {
  readonly sources: CraftSource[] = [];
  /** typeId → sources, built on first query (thousands of recipes are checked per screen). */
  private byType: Map<string, CraftSource[]> | null = null;
  private qualCache = new Map<string, number>();

  constructor(readonly data: GameData, readonly crafter: Character | null, readonly map: GameMap | null, readonly pos: CrafterPos | null) {}

  /**
   * Gather what `c` can use at `pos`: inventory (wielded, worn, carried + contents), map items
   * and furniture within CRAFT_RANGE on the same z-level, and a nearby fd_fire as "fire".
   */
  static gather(data: GameData, c: Character, map: GameMap | null, pos: CrafterPos | null, range = CRAFT_RANGE): CraftingInventory {
    const inv = new CraftingInventory(data, c, map, pos);
    if (c.inv.wielded) inv.addTree(c.inv.wielded, 'inv', L.hands(c), null);
    for (const w of c.inv.worn) inv.addTree(w, 'inv', L.worn(c), null, undefined, true);
    for (const it of c.inv.items) inv.addTree(it, 'inv', L.inv(c), null);
    // Body-provided pseudo tools (bionic toolset, finger lighter…) act like fixed furniture tools.
    for (const f of c.inv.qualityProviders) for (const it of f()) inv.sources.push({ item: it, kind: 'environment', loc: null, parent: null });
    if (map && pos) {
      const cx = Math.floor(pos.x), cy = Math.floor(pos.y);
      let fire = false;
      for (let dy = -range; dy <= range; dy++) {
        for (let dx = -range; dx <= range; dx++) {
          const x = cx + dx, y = cy + dy, z = pos.z;
          const ground = L.ground(map, x, y, z);
          for (const mi of map.itemsAt(x, y, z)) if (mi instanceof Item) inv.addTree(mi, 'map', ground, null, [x, y, z]);
          const f = map.furnAt(x, y, z);
          for (const pid of asArray(f.crafting_pseudo_item)) {
            if (!data.items[pid]) continue;
            inv.sources.push({ item: createItem(data, pid), kind: 'furniture', loc: null, parent: null, x, y, z });
          }
          if (!fire && map.fieldsAt(x, y, z).some((fd) => fd.type === 'fd_fire')) {
            fire = true;
            if (data.items.fire) inv.sources.push({ item: createItem(data, 'fire'), kind: 'environment', loc: null, parent: null, x, y, z });
          }
        }
      }
    }
    return inv;
  }

  private addTree(it: Item, kind: SourceKind, loc: Loc, parent: Item | null, at?: [number, number, number], worn = false): void {
    // An in-progress craft's components are spoken for: neither components nor tools.
    if (it.isCraft()) return;
    const s: CraftSource = { item: it, kind, loc, parent, worn };
    if (at) [s.x, s.y, s.z] = at;
    this.sources.push(s);
    // Rounds in a tool's magazine are the tool's charges, not separate components.
    if (it.isMagazine()) return;
    for (const c of it.contents) this.addTree(c, kind, L.in(it), it, at);
  }

  /** Add a single extra source (tests, debug). */
  add(s: CraftSource): void {
    this.sources.push(s);
    this.dirty();
  }

  private dirty(): void {
    this.byType = null;
    this.qualCache.clear();
  }

  private ofType(id: string): CraftSource[] {
    if (!this.byType) {
      this.byType = new Map();
      for (const s of this.sources) {
        const l = this.byType.get(s.item.typeId);
        if (l) l.push(s);
        else this.byType.set(s.item.typeId, [s]);
      }
    }
    return this.byType.get(id) ?? [];
  }

  // ------------------------------------------------------------------ queries
  /** Best level of a tool quality among everything available. */
  maxQuality(id: string): number {
    let best = this.qualCache.get(id);
    if (best !== undefined) return best;
    best = 0;
    for (const s of this.sources) best = Math.max(best, s.item.qualityLevel(id));
    this.qualCache.set(id, best);
    return best;
  }
  /** `amount` distinct tools each with quality `id` >= level. */
  hasQuality(id: string, level: number, amount = 1): boolean {
    if (this.maxQuality(id) < level) return false;
    if (amount <= 1) return true;
    let n = 0;
    for (const s of this.sources) if (s.item.qualityLevel(id) >= level && ++n >= amount) return true;
    return false;
  }
  /** The items providing quality `id` at `level` (for "where is it" in the UI). */
  qualitySources(id: string, level: number): CraftSource[] {
    return this.sources.filter((s) => s.item.qualityLevel(id) >= level);
  }

  /** Items usable as components of type `id` (not worn gear, not non-empty containers). */
  componentSources(id: string): CraftSource[] {
    return this.ofType(id).filter((s) => (s.kind === 'inv' || s.kind === 'map') && !s.worn && !s.item.hasContents() && !s.item.magazine);
  }
  /** Count (charges for count-by-charges items) of a component type available. */
  countOf(id: string): number {
    let n = 0;
    for (const s of this.componentSources(id)) n += s.item.count();
    return n;
  }

  /** Tool sources of type `id`. */
  toolSources(id: string): CraftSource[] {
    return this.ofType(id);
  }
  hasTool(id: string): boolean {
    return this.ofType(id).length > 0;
  }
  /** Total charges available from tools of type `id`. */
  toolChargesOf(id: string): number {
    let n = 0;
    for (const s of this.toolSources(id)) n += toolCharges(s);
    return n;
  }

  // ------------------------------------------------------------------ using things up
  /**
   * Take `n` of component `id` (charges for count-by-charges): consumed, or — with `into` —
   * moved there (an in-progress craft's contents). Returns the items taken. Carried items are
   * used before ones on the ground: walking to a pile to craft shouldn't eat what you
   * deliberately picked up, but carrying it means you meant to use it.
   */
  consumeComponent(id: string, n: number, into?: Loc): Item[] {
    const srcs = this.componentSources(id).sort((a, b) => (a.kind === 'inv' ? 0 : 1) - (b.kind === 'inv' ? 0 : 1));
    const have = srcs.reduce((t, s) => t + s.item.count(), 0);
    if (have < n) throw new Error(`consumeComponent: need ${n} ${id}, have ${have}`);
    const out: Item[] = [];
    for (const s of srcs) {
      if (n <= 0) break;
      const take = Math.min(n, s.item.count());
      out.push(this.take(s, s.item.countByCharges ? take : undefined, into));
      n -= take;
    }
    return out;
  }

  /** Use `n` charges of tool `id` (pseudo tools are free). */
  consumeToolCharges(id: string, n: number): void {
    let left = n;
    const srcs = [...this.toolSources(id)].sort((a, b) => toolCharges(b) - toolCharges(a));
    for (const s of srcs) {
      if (left <= 0) return;
      if (s.kind === 'furniture' || s.kind === 'environment') return;
      const it = s.item;
      if (it.countByCharges) {
        const take = Math.min(left, it.charges);
        this.take(s, take);
        left -= take;
      } else left -= it.ammoConsume(left);
    }
    if (left > 0) throw new Error(`consumeToolCharges: ${left} of ${n} ${id} charges missing`);
  }

  /**
   * Take `count` (default: all) of a source where it is, keeping the source list in sync:
   * consumed, or moved to `into` (a system move: capacity rules don't apply there).
   */
  take(s: CraftSource, count?: number, into?: Loc): Item {
    if (!s.loc) throw new Error(`crafting: ${s.item.typeId} is a pseudo tool and can't be used up`);
    if (!isAt(s.item, s.loc)) throw new Error(`crafting: ${s.item.typeId} is no longer where it was gathered`);
    const all = count === undefined || count >= s.item.count();
    let piece: Item;
    if (into) {
      const r = moveItem(s.item, s.loc, into, { count, force: true, quiet: true });
      if (!r.ok) throw new Error(`crafting: couldn't take the ${s.item.typeId}: ${r.msg}`);
      piece = r.item!;
    } else piece = consumeItem(s.item, s.loc, count)!;
    if (all) this.forget(s);
    this.dirty();
    return piece;
  }

  /** Drop a source (and anything gathered inside it) from the list. */
  forget(s: CraftSource): void {
    const it = s.item;
    const i = this.sources.indexOf(s);
    if (i >= 0) this.sources.splice(i, 1);
    for (let j = this.sources.length - 1; j >= 0; j--) if (this.sources[j].parent === it) this.sources.splice(j, 1);
    this.dirty();
  }
}

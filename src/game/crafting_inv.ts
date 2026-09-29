import type { GameData } from '../data/types';
import type { GameMap } from '../world/map';
import type { Character } from './character';
import { asArray, createItem, Item } from './item';

// CDDA's temp_crafting_inventory: everything a crafter can draw on — carried items, items on
// the ground within reach, furniture "crafting_pseudo_item"s (a stove, an anvil …) and the
// environment (a fire nearby provides the "fire" pseudo tool). Each entry remembers where it
// came from so consuming a component removes it from the right place.

/** Tiles around the crafter that count as "nearby" (CDDA uses PICKUP_RANGE; 2 feels right in 3D). */
export const CRAFT_RANGE = 2;

export type SourceKind = 'inv' | 'map' | 'furniture' | 'environment';

export interface CraftSource {
  item: Item;
  kind: SourceKind;
  /** Containing item for nested contents (e.g. the bottle holding water). */
  parent: Item | null;
  /** Map tile for 'map' / 'furniture' / 'environment' sources. */
  x?: number;
  y?: number;
  z?: number;
  /** Top-level carried item that is worn (not usable as a component, like CDDA). */
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

  constructor(readonly data: GameData, readonly crafter: Character | null, readonly map: GameMap | null, readonly pos: CrafterPos | null) {}

  /**
   * Gather what `c` can use at `pos`: inventory (worn/wielded + contents), map items and
   * furniture within CRAFT_RANGE on the same z-level, and a nearby fd_fire as "fire".
   */
  static gather(data: GameData, c: Character, map: GameMap | null, pos: CrafterPos | null, range = CRAFT_RANGE): CraftingInventory {
    const inv = new CraftingInventory(data, c, map, pos);
    for (const top of c.inv.topLevel()) inv.addTree(top, 'inv', null, undefined, c.inv.worn.includes(top));
    if (map && pos) {
      const cx = Math.floor(pos.x), cy = Math.floor(pos.y);
      let fire = false;
      for (let dy = -range; dy <= range; dy++) {
        for (let dx = -range; dx <= range; dx++) {
          const x = cx + dx, y = cy + dy, z = pos.z;
          for (const mi of map.itemsAt(x, y, z)) if (mi instanceof Item) inv.addTree(mi, 'map', null, [x, y, z]);
          const f = map.furnAt(x, y, z);
          for (const pid of asArray(f.crafting_pseudo_item)) {
            if (!data.items[pid]) continue;
            inv.sources.push({ item: createItem(data, pid), kind: 'furniture', parent: null, x, y, z });
          }
          if (!fire && map.fieldsAt(x, y, z).some((fd) => fd.type === 'fd_fire')) {
            fire = true;
            if (data.items.fire) inv.sources.push({ item: createItem(data, 'fire'), kind: 'environment', parent: null, x, y, z });
          }
        }
      }
    }
    return inv;
  }

  private addTree(it: Item, kind: SourceKind, parent: Item | null, at?: [number, number, number], worn = false): void {
    const s: CraftSource = { item: it, kind, parent, worn };
    if (at) [s.x, s.y, s.z] = at;
    this.sources.push(s);
    for (const p of it.pockets) {
      // Ammo inside a tool's magazine is the tool's charges, not a separate component.
      if (p.type !== 'CONTAINER') continue;
      for (const c of p.contents) this.addTree(c, kind, it, at);
    }
  }

  /** Add a single extra source (tests, debug). */
  add(s: CraftSource): void {
    this.sources.push(s);
  }

  // ------------------------------------------------------------------ queries
  /** Best level of a tool quality among everything available. */
  maxQuality(id: string): number {
    let best = 0;
    for (const s of this.sources) best = Math.max(best, s.item.qualityLevel(id));
    return best;
  }
  /** `amount` distinct tools each with quality `id` >= level. */
  hasQuality(id: string, level: number, amount = 1): boolean {
    let n = 0;
    for (const s of this.sources) if (s.item.qualityLevel(id) >= level && ++n >= amount) return true;
    return false;
  }

  /** Items usable as components of type `id` (not worn gear, not non-empty containers). */
  componentSources(id: string): CraftSource[] {
    return this.sources.filter((s) => s.item.typeId === id && (s.kind === 'inv' || s.kind === 'map') && !s.worn && !hasContents(s.item));
  }
  /** Count (charges for count-by-charges items) of a component type available. */
  countOf(id: string): number {
    let n = 0;
    for (const s of this.componentSources(id)) n += s.item.count();
    return n;
  }

  /** Tool sources of type `id`. */
  toolSources(id: string): CraftSource[] {
    return this.sources.filter((s) => s.item.typeId === id);
  }
  hasTool(id: string): boolean {
    return this.toolSources(id).length > 0;
  }
  /** Total charges available from tools of type `id`. */
  toolChargesOf(id: string): number {
    let n = 0;
    for (const s of this.toolSources(id)) n += toolCharges(s);
    return n;
  }

  // ------------------------------------------------------------------ consumption
  /**
   * Remove `n` of component `id` (charges for count-by-charges) and return the removed
   * items. Carried items are used before ones on the ground: walking to a pile to craft
   * shouldn't eat what you deliberately picked up, but carrying it means you meant to use it.
   */
  consumeComponent(id: string, n: number): Item[] {
    const srcs = this.componentSources(id).sort((a, b) => (a.kind === 'inv' ? 0 : 1) - (b.kind === 'inv' ? 0 : 1));
    const have = srcs.reduce((t, s) => t + s.item.count(), 0);
    if (have < n) throw new Error(`consumeComponent: need ${n} ${id}, have ${have}`);
    const out: Item[] = [];
    for (const s of srcs) {
      if (n <= 0) break;
      const it = s.item;
      if (it.countByCharges && it.charges > n) {
        out.push(it.split(n));
        n = 0;
        continue;
      }
      this.detach(s);
      out.push(it);
      n -= it.count();
    }
    return out;
  }

  /** Use `n` charges of tool `id` (pseudo tools are free). */
  consumeToolCharges(id: string, n: number): void {
    let left = n;
    const srcs = this.toolSources(id).sort((a, b) => toolCharges(b) - toolCharges(a));
    for (const s of srcs) {
      if (left <= 0) return;
      if (s.kind === 'furniture' || s.kind === 'environment') return;
      const it = s.item;
      if (it.countByCharges) {
        const take = Math.min(left, it.charges);
        it.charges -= take;
        left -= take;
        if (it.charges <= 0) this.detach(s);
      } else left -= it.ammoConsume(left);
    }
    if (left > 0) throw new Error(`consumeToolCharges: ${left} of ${n} ${id} charges missing`);
  }

  /** Take an item out of wherever it lives. */
  detach(s: CraftSource): void {
    const it = s.item;
    if (s.parent) s.parent.removeContent(it);
    else if (s.kind === 'map' && this.map) this.map.removeItem(s.x!, s.y!, s.z!, it);
    else if (s.kind === 'inv' && this.crafter) this.crafter.inv.remove(it);
    const i = this.sources.indexOf(s);
    if (i >= 0) this.sources.splice(i, 1);
    // Drop nested entries of a removed container too.
    for (let j = this.sources.length - 1; j >= 0; j--) if (this.sources[j].parent === it) this.sources.splice(j, 1);
  }
}

function hasContents(it: Item): boolean {
  return it.containerPockets().some((p) => p.contents.length > 0);
}

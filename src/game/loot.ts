// Looting rules shared by every looting UI (src/ui2/loot: the crosshair quick-loot panel, the
// area loot window, the pile markers; src/ui2/bn: the inventory's Take all). UI-free, so the
// tests can hold it to item conservation like the moves API underneath.
//
// - What an item is worth to a scavenger (`lootValue`): BN's post-apocalypse price, what it
//   holds included, nudged toward the things a survivor runs out of (ammo, medicine, food).
// - The order "Take all" takes things in (`takeOrder`): the most value per share of the room
//   you have left first, so a cupboard of blankets no longer fills the bag before the pistol.
// - Which pile item to show in the world (`notableItem`) and the loot filter categories.
// - Memory of searched containers (`LootMemory`), CDDA's "you remember this locker is empty".

import type { Item } from './item';
import { marketPrice } from './trade';

/** The filter chips of the area loot window, in display order. */
export const LOOT_CATEGORIES = ['weapons', 'ammo', 'meds', 'food', 'tools', 'clothing', 'containers', 'other'] as const;
export type LootCategory = (typeof LOOT_CATEGORIES)[number];

export const LOOT_CATEGORY_NAMES: Record<LootCategory, string> = {
  weapons: 'Weapons', ammo: 'Ammo', meds: 'Meds', food: 'Food & drink', tools: 'Tools',
  clothing: 'Clothing', containers: 'Containers', other: 'Other',
};

/** BN item_category ids → loot filter. Unknown / scrap / books land in "other". */
const CATEGORY_OF: Record<string, LootCategory> = {
  guns: 'weapons', weapons: 'weapons', mods: 'weapons',
  ammo: 'ammo', magazines: 'ammo',
  drugs: 'meds', mutagen: 'meds',
  food: 'food', cooking_ingredients: 'food', seeds: 'food',
  tools: 'tools', tools_entry: 'tools', tools_workshop: 'tools', tools_cooking: 'tools', tools_chemistry: 'tools', tools_farming: 'tools',
  electronics: 'tools', battery: 'tools', fuel: 'tools', deployables: 'tools',
  clothing: 'clothing',
  container: 'containers',
};

export function lootCategory(it: Item): LootCategory {
  if (it.isGun()) return 'weapons';
  if (it.isAmmo() || it.isMagazine()) return 'ammo';
  if (it.isArmor() && !CATEGORY_OF[it.def.category]) return 'clothing';
  return CATEGORY_OF[it.def.category] ?? (it.isContainer() ? 'containers' : 'other');
}

/**
 * Multipliers on price for what matters in a run. BN prices are pre-war economics (a watch
 * outprices a box of bandages); a scavenger's "notable" leans toward what keeps them alive.
 */
const NEED_BONUS: Partial<Record<LootCategory, number>> = { ammo: 2, meds: 2.5, weapons: 1.6, food: 1.5 };

/** What an item (with everything inside it) is worth to a scavenger, in BN cents. */
export function lootValue(it: Item): number {
  let v = marketPrice(it) * (NEED_BONUS[lootCategory(it)] ?? 1);
  for (const c of it.contents) v += lootValue(c);
  if (it.magazine) v += lootValue(it.magazine);
  // Rotten food is worth nothing to eat; broken things are worth less.
  if (it.isComestible() && it.rotten()) v *= 0.05;
  v *= Math.max(0.2, 1 - it.damageLevel() * 0.2);
  return v;
}

/** Room left in the carried inventory: volume in ml, weight in g (up to the 1× limit). */
export interface Room {
  volume: number;
  weight: number;
}

/**
 * How much it's worth taking this before other things when room runs short: value per share
 * of the room left (whichever of volume / weight is scarcer counts more). A pistol (0.6 L,
 * $80) beats seven blankets (3.5 L, $30) for a half-empty backpack.
 */
export function takePriority(it: Item, room: Room): number {
  const vol = Math.max(1, it.volume()) / Math.max(250, room.volume);
  const wt = Math.max(1, it.weight()) / Math.max(250, room.weight);
  // A floor so worthless light things (a paper scrap) still come along, after the rest.
  return (lootValue(it) + 1) / (vol + wt);
}

/** `items` in the order a smart Take all takes them (best value per room first, light first on ties). */
export function takeOrder(items: readonly Item[], room: Room): Item[] {
  return items
    .map((it, i) => ({ it, i, p: takePriority(it, room) }))
    .sort((a, b) => b.p - a.p || a.it.weight() - b.it.weight() || a.i - b.i)
    .map((x) => x.it);
}

/** The pile's item to show large in the world: the most valuable, weapons first on a tie. */
export function notableItem(items: readonly Item[]): Item | null {
  let best: Item | null = null, bestV = -1;
  for (const it of items) {
    const v = lootValue(it) + (it.isGun() ? 1e5 : 0);
    if (v > bestV) {
      best = it;
      bestV = v;
    }
  }
  return best;
}

// ------------------------------------------------------------------ memory of searched containers

export type SearchState = 'unsearched' | 'searched' | 'empty';

export interface LootMemoryJSON {
  v: 1;
  /** "x,y,z" → how many top-level items were inside when last seen. */
  seen: [string, number][];
}

/**
 * Storage furniture the survivor has looked into, like CDDA's map memory of items: a locker you
 * emptied (or found empty) shows as searched, so you don't walk across the room to open it
 * again. Keyed by tile; what's inside is re-read whenever the container is in view again.
 */
export class LootMemory {
  private seen = new Map<string, number>();
  /** Bumped on every change (renderers compare it). */
  version = 0;

  private static key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  /** The survivor saw what's inside (looked in, looted, or had it listed within reach). */
  mark(x: number, y: number, z: number, itemsInside: number): void {
    const k = LootMemory.key(x, y, z);
    if (this.seen.get(k) === itemsInside) return;
    this.seen.set(k, itemsInside);
    this.version++;
  }

  state(x: number, y: number, z: number): SearchState {
    const n = this.seen.get(LootMemory.key(x, y, z));
    return n === undefined ? 'unsearched' : n === 0 ? 'empty' : 'searched';
  }

  forget(x: number, y: number, z: number): void {
    if (this.seen.delete(LootMemory.key(x, y, z))) this.version++;
  }

  get size(): number {
    return this.seen.size;
  }

  toJSON(): LootMemoryJSON {
    return { v: 1, seen: [...this.seen] };
  }

  static fromJSON(j: unknown): LootMemory {
    const m = new LootMemory();
    const d = j as Partial<LootMemoryJSON> | null;
    if (!d || d.v !== 1 || !Array.isArray(d.seen)) throw new Error(`loot memory: unreadable save section ${JSON.stringify(j)?.slice(0, 80)}`);
    for (const e of d.seen) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'number' || !/^-?\d+,-?\d+,-?\d+$/.test(e[0])) throw new Error(`loot memory: bad entry ${JSON.stringify(e)}`);
      m.seen.set(e[0], e[1]);
    }
    return m;
  }
}

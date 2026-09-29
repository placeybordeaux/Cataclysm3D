// Item group expansion with CDDA semantics (item_group.cpp / doc/JSON/ITEM_SPAWN.md).
//
//  - collection: every entry rolls independently, spawning when rng(0,99) < prob
//  - distribution: exactly one entry, picked with weight `prob`
//  - count [a,b] is rolled once per entry and repeats the item/group that many times
//  - charges [a,b] is rolled per created item; [a,-1] means "a up to capacity"
//  - "container-item" on a group wraps everything the group made into one container;
//    on an entry it wraps each item separately; "entry-wrapper" wraps all of the entry's
//    items together
//  - "contents-item"/"contents-group" put things inside each created item
//
// Not modelled (yet): default containers (item.in_its_container), the group-level
// "ammo"/"magazine" chances, on_overflow (containers never overflow here), holiday
// ("event") entries (never spawn), item damage/dirt.

import type { Rng } from '../core/rng';
import { warnOnce } from './warn';
import type { GameData, ItemDef, ItemGroupDef, ItemGroupEntry, ItemGroupRef } from './types';

export interface SpawnedItem {
  id: string;
  count: number;
  /** ammo/charges loaded, or stack size for count-by-charges items (ammo, food) */
  charges?: number;
  /** ammo item id the charges consist of ("ammo-item"), when not the item's default */
  ammo?: string;
  variant?: string;
  contents?: SpawnedItem[];
}

function roll(rng: Rng, v: number | [number, number] | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v === 'number') return v;
  return v[0] === v[1] ? v[0] : rng.int(Math.min(v[0], v[1]), Math.max(v[0], v[1]));
}

/** Maximum charges we can infer from the item def (CDDA uses container/magazine capacity). */
function capacity(def: ItemDef | undefined): number | undefined {
  if (!def) return undefined;
  const c = (def.max_charges ?? def.charges ?? def.count ?? def.initial_charges) as number | undefined;
  return typeof c === 'number' && c > 0 ? c : undefined;
}

function rollCharges(rng: Rng, v: number | [number, number] | undefined, def: ItemDef | undefined): number | undefined {
  if (v === undefined) return undefined;
  let lo: number;
  let hi: number;
  if (typeof v === 'number') lo = hi = v;
  else [lo, hi] = v;
  const cap = capacity(def);
  if (lo === -1 && hi === -1) return cap; // "fill": capacity if we know it, else item default
  if (lo === -1) lo = 0;
  if (hi === -1) hi = cap ?? lo;
  if (cap !== undefined && hi > cap) hi = cap;
  if (lo > hi) lo = hi;
  return lo === hi ? lo : rng.int(lo, hi);
}

function sameStack(a: SpawnedItem, b: SpawnedItem): boolean {
  return a.id === b.id && a.charges === b.charges && a.ammo === b.ammo && a.variant === b.variant && !a.contents && !b.contents;
}

/** Merge identical adjacent content-less items into one stack with a count. */
function stack(items: SpawnedItem[]): SpawnedItem[] {
  const out: SpawnedItem[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && sameStack(last, it)) last.count += it.count;
    else out.push(it);
  }
  return out;
}

class Expander {
  constructor(private readonly data: GameData, private readonly rng: Rng) {}

  group(ref: ItemGroupRef, stackIds: string[]): SpawnedItem[] {
    let def: ItemGroupDef | undefined;
    if (typeof ref === 'string') {
      if (stackIds.includes(ref)) {
        warnOnce('itemgroup-recursion', ref, `item group recursion: ${[...stackIds, ref].join(' -> ')}`);
        return [];
      }
      def = this.data.itemGroups[ref];
      if (!def) {
        warnOnce('itemgroup', ref);
        return [];
      }
      stackIds = [...stackIds, ref];
    } else def = ref;
    const items = this.entries(def.subtype, def.entries, stackIds);
    const ci = def['container-item'];
    // CDDA: "container-item": "null" means "spawn loose", not "wrap in the null item".
    if (ci && ci !== 'null' && items.length) return [{ id: ci, count: 1, contents: items }];
    return items;
  }

  entries(subtype: 'distribution' | 'collection', entries: ItemGroupEntry[], stackIds: string[]): SpawnedItem[] {
    const live = entries.filter((e) => !e.event || e.event === 'none');
    const out: SpawnedItem[] = [];
    if (subtype === 'collection') {
      for (const e of live) {
        if (this.rng.int(0, 99) < Math.min(100, e.prob ?? 100)) out.push(...this.entry(e, stackIds));
      }
    } else {
      let total = 0;
      for (const e of live) total += e.prob ?? 100;
      if (total <= 0) return out;
      let r = this.rng.int(0, total - 1);
      for (const e of live) {
        r -= e.prob ?? 100;
        if (r < 0) {
          out.push(...this.entry(e, stackIds));
          break;
        }
      }
    }
    return out;
  }

  entry(e: ItemGroupEntry, stackIds: string[]): SpawnedItem[] {
    if (e.collection) return this.entries('collection', e.collection, stackIds);
    if (e.distribution) return this.entries('distribution', e.distribution, stackIds);
    const count = roll(this.rng, e.count, 1);
    let made: SpawnedItem[] = [];
    for (let i = 0; i < count; i++) {
      if (e.item) {
        made.push(this.single(e.item, e, stackIds));
      } else if (e.group) {
        // modifiers (charges, contents, container) apply to every item the group makes
        for (const it of this.group(e.group, stackIds)) made.push(this.modify(it, e, stackIds));
      }
    }
    made = stack(made);
    const wrapper = e['entry-wrapper'];
    if (wrapper && made.length) return [{ id: wrapper, count: 1, contents: made }];
    return made;
  }

  single(id: string, e: ItemGroupEntry, stackIds: string[]): SpawnedItem {
    const def = this.data.items[id];
    if (!def && id !== 'corpse') warnOnce('item', id);
    return this.modify({ id, count: 1 }, e, stackIds);
  }

  modify(it: SpawnedItem, e: ItemGroupEntry, stackIds: string[]): SpawnedItem {
    const def = this.data.items[it.id];
    const charges = rollCharges(this.rng, e.charges, def);
    if (charges !== undefined) it.charges = charges;
    if (e['ammo-item']) it.ammo = e['ammo-item'];
    if (e.variant) it.variant = e.variant;
    const contents: SpawnedItem[] = [];
    for (const c of e['contents-item'] ?? []) contents.push({ id: c, count: 1 });
    for (const g of e['contents-group'] ?? []) contents.push(...this.group(g, stackIds));
    if (contents.length) it.contents = [...(it.contents ?? []), ...stack(contents)];
    const container = e['container-item'] ?? (e['container-group'] ? this.group(e['container-group'], stackIds)[0]?.id : undefined);
    if (container && container !== 'null') return { id: container, count: 1, contents: [it] };
    return it;
  }
}

/**
 * Spawn the items of an item group (id or inline definition). Unknown group/item ids warn
 * once and are skipped. Deterministic for a given rng state.
 */
export function expandItemGroup(data: GameData, ref: ItemGroupRef, rng: Rng): SpawnedItem[] {
  return stack(new Expander(data, rng).group(ref, []));
}

/** Every item id a group can possibly produce (ignores probabilities), for debugging/UI. */
export function possibleItems(data: GameData, ref: ItemGroupRef, out = new Set<string>(), seen = new Set<string>()): Set<string> {
  let def: ItemGroupDef | undefined;
  if (typeof ref === 'string') {
    if (seen.has(ref)) return out;
    seen.add(ref);
    def = data.itemGroups[ref];
    if (!def) return out;
  } else def = ref;
  const visit = (e: ItemGroupEntry) => {
    if (e.item) out.add(e.item);
    if (e.group) possibleItems(data, e.group, out, seen);
    e.collection?.forEach(visit);
    e.distribution?.forEach(visit);
    e['contents-item']?.forEach((i) => out.add(i));
    e['contents-group']?.forEach((g) => possibleItems(data, g, out, seen));
  };
  def.entries.forEach(visit);
  return out;
}

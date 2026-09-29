// Item group expansion with Bright Nights semantics (src/item_group.cpp, item_factory.cpp).
//
//  - collection: every entry rolls independently, spawning when rng(0,99) < prob
//  - distribution: exactly one entry, picked with weight `prob`
//  - count [a,b] is rolled once per entry and repeats the item/group that many times
//  - every created item ends up in a container: the entry's "container-item"/"container-group"
//    if any, else the item's default `container` (item::in_its_container / Item_modifier::modify);
//    liquids are topped up to fill that container unless charges are given
//  - charges [a,b] is rolled per created item; -1 as max means "up to capacity" (the item's
//    own ammo capacity, else how many fit in its container)
//  - guns / magazines / tools with charges get loaded with "ammo-item" or their default ammo;
//    the group's "ammo" / "magazine" percentages load / insert a default magazine into guns and
//    tools that spawned without charges (inherited by every entry of the group)
//  - "contents-item"/"contents-group" put things inside each created item
//  - "custom-flags", "active", damage (x1000, BN damage scale) and VARSIZE's 1-in-3 FIT flag
//    are carried on the SpawnedItem for the item runtime to apply
//
// The result is a description (SpawnedItem tree); src/game/item.ts turns it into Items.

import type { Rng } from '../core/rng';
import { warnOnce } from './warn';
import type { GameData, ItemDef, ItemGroupDef, ItemGroupEntry, ItemGroupRef } from './types';

export interface SpawnedItem {
  id: string;
  count: number;
  /**
   * count_by_charges items: stack size; tools/guns with integral magazines and magazines:
   * rounds loaded (of `ammo`); liquids: amount in the container.
   */
  charges?: number;
  /** ammo item id loaded (with `charges` rounds) into a gun, tool or magazine */
  ammo?: string;
  /** @deprecated DDA item variants; never set for BN */
  variant?: string;
  /** items inside: container contents, an inserted magazine, "contents-item"s */
  contents?: SpawnedItem[];
  /** the entry's "custom-flags" (e.g. profession gear's auto_wield) plus FIT for VARSIZE */
  flags?: string[];
  /** item damage in BN's scale (-1000..4000; entry damage levels x 1000) */
  damage?: number;
  /** "active": true entries */
  active?: boolean;
  /** profession legacy items: snippet id for the description */
  snippet?: string;
}

function roll(rng: Rng, v: number | [number, number] | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v === 'number') return v;
  return v[0] === v[1] ? v[0] : rng.int(Math.min(v[0], v[1]), Math.max(v[0], v[1]));
}

const has = (def: ItemDef | undefined, slot: string) => !!def?.subtypes.includes(slot);
const isLiquid = (def: ItemDef | undefined) => def?.phase === 'liquid';

/** item::ammo_capacity for a fresh item: tool max_charges, gun clip_size, magazine capacity. */
export function ammoCapacity(def: ItemDef | undefined): number {
  if (!def) return 0;
  if (has(def, 'MAGAZINE')) return def.magazine?.capacity ?? 0;
  if (has(def, 'GUN')) return def.clip_size ?? 0;
  if (has(def, 'TOOL')) return def.max_charges ?? 0;
  return 0;
}

/** item::charges_per_volume for count_by_charges items (whole items otherwise). */
export function chargesPerVolume(def: ItemDef, vol: number): number {
  if (def.count_by_charges) return Math.floor((vol * (def.stack_size ?? 1)) / def.volume);
  return Math.floor(vol / def.volume);
}

/** item::ammo_default: tool default_ammo, magazine default, else the ammo type's default. */
export function defaultAmmo(data: GameData, def: ItemDef | undefined): string | undefined {
  if (!def) return undefined;
  if (def.magazine?.default_ammo) return def.magazine.default_ammo;
  if (typeof def.default_ammo === 'string' && def.default_ammo !== 'NULL') return def.default_ammo;
  const t = def.ammo?.[0];
  return t ? (data.misc.ammunition_type?.[t]?.default as string | undefined) : undefined;
}

/** item::magazine_default: the first compatible magazine for the first ammo type. */
function magazineDefault(def: ItemDef | undefined): string | undefined {
  const t = def?.ammo?.[0];
  return t ? def?.magazine_default?.[t] : undefined;
}

function sameStack(a: SpawnedItem, b: SpawnedItem): boolean {
  return a.id === b.id && a.charges === b.charges && a.ammo === b.ammo && !a.contents && !b.contents && !a.flags && !b.flags
    && a.damage === b.damage && !a.active && !b.active && !a.snippet && !b.snippet;
}

/** Merge identical adjacent content-less items into one SpawnedItem with a count. */
function stack(items: SpawnedItem[]): SpawnedItem[] {
  const out: SpawnedItem[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && sameStack(last, it)) last.count += it.count;
    else out.push(it);
  }
  return out;
}

interface Chances { ammo: number; magazine: number }

class Expander {
  constructor(private readonly data: GameData, private readonly rng: Rng) {}

  /** Item_spawn_data::create for a group reference. */
  group(ref: ItemGroupRef, stackIds: string[], inherited?: Chances): SpawnedItem[] {
    const def = this.resolve(ref, stackIds);
    if (!def) return [];
    const ids = typeof ref === 'string' ? [...stackIds, ref] : stackIds;
    // Item_group(...) takes its own ammo/magazine chances; nested inline groups inherit
    const chances: Chances = { ammo: def.ammo ?? inherited?.ammo ?? 0, magazine: def.magazine ?? inherited?.magazine ?? 0 };
    return this.entries(def.subtype, def.entries, ids, chances);
  }

  private resolve(ref: ItemGroupRef, stackIds: string[]): ItemGroupDef | undefined {
    if (typeof ref !== 'string') return ref;
    if (stackIds.includes(ref)) {
      warnOnce('itemgroup-recursion', ref, `recursion in item spawn list ${[...stackIds, ref].join(' -> ')}`);
      return undefined;
    }
    const def = this.data.itemGroups[ref];
    if (!def) warnOnce('itemgroup', ref);
    return def;
  }

  entries(subtype: 'distribution' | 'collection', entries: ItemGroupEntry[], stackIds: string[], ch: Chances): SpawnedItem[] {
    const out: SpawnedItem[] = [];
    if (subtype === 'collection') {
      for (const e of entries) {
        if (this.rng.int(0, 99) >= Math.min(100, e.prob ?? 100)) continue;
        out.push(...this.entry(e, stackIds, ch));
      }
    } else {
      let total = 0;
      for (const e of entries) total += e.prob ?? 100;
      if (total <= 0) return out;
      let p = this.rng.int(0, total - 1);
      for (const e of entries) {
        p -= e.prob ?? 100;
        if (p >= 0) continue;
        out.push(...this.entry(e, stackIds, ch));
        break;
      }
    }
    return out;
  }

  entry(e: ItemGroupEntry, stackIds: string[], ch: Chances): SpawnedItem[] {
    if (e.collection) return this.entries('collection', e.collection, stackIds, ch);
    if (e.distribution) return this.entries('distribution', e.distribution, stackIds, ch);
    const count = roll(this.rng, e.count, 1);
    const made: SpawnedItem[] = [];
    for (let i = 0; i < count; i++) {
      if (e.item) {
        const def = this.data.items[e.item];
        if (!def && e.item !== 'corpse') {
          warnOnce('item', e.item);
          continue;
        }
        const it: SpawnedItem = { id: e.item, count: 1 };
        if (e.snippet) it.snippet = e.snippet;
        made.push(this.modify(it, e, stackIds, ch));
      } else if (e.group) {
        // the entry's modifiers apply to every item the group makes
        for (const it of this.group(e.group, stackIds, ch)) made.push(this.modify(it, e, stackIds, ch));
      }
    }
    return stack(made);
  }

  /** Single_item_creator::create_single's VARSIZE roll + Item_modifier::modify / in_its_container. */
  modify(it: SpawnedItem, e: ItemGroupEntry, stackIds: string[], ch: Chances): SpawnedItem {
    const def = this.data.items[it.id];
    // an already-wrapped item from a sub-group: the modifier works on the outermost item
    if (def?.flags.includes('VARSIZE') && this.rng.int(1, 3) === 1) it.flags = [...(it.flags ?? []), 'FIT'];
    if (e.damage !== undefined) {
      const dmg = roll(this.rng, e.damage, 0) * 1000;
      if (dmg) it.damage = dmg;
    }
    // container: explicit, else the default container
    let cont: string | undefined;
    if (e['container-item']) cont = e['container-item'];
    else if (e['container-group']) cont = this.group(e['container-group'], stackIds, ch)[0]?.id;
    if ((!cont || cont === 'null') && def?.container) cont = def.container;
    if (cont === 'null') cont = undefined;
    const contDef = cont ? this.data.items[cont] : undefined;
    if (cont && !contDef) warnOnce('item', cont);

    const cap = ammoCapacity(def);
    const [cLo, cHi] = e.charges === undefined ? [-1, -1] : typeof e.charges === 'number' ? [e.charges, e.charges] : e.charges;
    let maxCap = -1;
    if (cLo !== -1 && cHi === -1 && cap > 0) maxCap = cap;
    if (maxCap === -1 && def && contDef?.container_data && (isLiquid(def) || (!has(def, 'TOOL') && !has(def, 'GUN') && !has(def, 'MAGAZINE')))) {
      maxCap = chargesPerVolume(def, contDef.container_data.contains);
    }
    let rolled = -1;
    if (!(cLo === -1 && cHi === -1)) {
      let lo = cLo === -1 ? 0 : cLo;
      let hi = cHi === -1 ? maxCap : cHi;
      if (maxCap !== -1 && (hi > maxCap || (lo !== 1 && hi === -1))) hi = maxCap;
      if (lo > hi) lo = hi;
      rolled = lo === hi ? lo : this.rng.int(lo, hi);
    } else if (contDef?.container_data && isLiquid(def)) {
      it.charges = Math.max(1, maxCap);
    }
    const explicitAmmo = () => e['ammo-item'] ?? (e['ammo-group'] ? this.group(e['ammo-group'], stackIds, ch)[0]?.id : undefined);
    if (def && rolled !== -1) {
      if (def.count_by_charges || isLiquid(def)) it.charges = Math.max(1, rolled);
      else if (has(def, 'TOOL')) {
        // qty = min(ch, ammo_capacity()): a tool that takes magazines has capacity 0 here
        const qty = Math.min(rolled, cap);
        const am = explicitAmmo() ?? defaultAmmo(this.data, def);
        if (qty > 0) it.charges = qty;
        if (qty > 0 && def.ammo?.length && am) it.ammo = am;
      } else if (has(def, 'GUN') || has(def, 'MAGAZINE')) it.charges = rolled;
    }
    if (def && rolled > 0 && (has(def, 'GUN') || has(def, 'MAGAZINE'))) {
      const am = explicitAmmo() ?? defaultAmmo(this.data, def);
      if (cap > 0 || has(def, 'MAGAZINE')) {
        it.charges = Math.min(rolled, cap);
        if (am) it.ammo = am;
      } else {
        // item::ammo_set on a magazine-fed gun inserts its default magazine and fills that
        delete it.charges;
        const mag = magazineDefault(def);
        if (mag && am) it.contents = [...(it.contents ?? []), { id: mag, count: 1, charges: Math.min(rolled, ammoCapacity(this.data.items[mag])), ammo: am }];
      }
    }
    // group ammo / magazine chances (guns, tools, magazines that got no explicit charges)
    if (def && (has(def, 'TOOL') || has(def, 'GUN') || has(def, 'MAGAZINE'))) {
      const spawnAmmo = this.rng.int(0, 99) < ch.ammo && !it.charges && rolled === -1;
      const mag = magazineDefault(def);
      const spawnMag = this.rng.int(0, 99) < ch.magazine && !!mag && !it.contents?.some((c) => has(this.data.items[c.id], 'MAGAZINE'));
      let magItem: SpawnedItem | undefined;
      if (spawnMag && mag) {
        magItem = { id: mag, count: 1 };
        it.contents = [...(it.contents ?? []), magItem];
      }
      if (spawnAmmo) {
        const am = e['ammo-item'] ?? defaultAmmo(this.data, def);
        const target = magItem ?? (cap > 0 ? it : undefined);
        const tcap = magItem ? ammoCapacity(this.data.items[magItem.id]) : cap;
        if (am && target && tcap > 0) {
          target.ammo = am;
          target.charges = tcap;
        }
      }
    }
    let result = it;
    if (cont && contDef) result = { id: cont, count: 1, contents: [it] };
    const contents: SpawnedItem[] = [];
    for (const c of e['contents-item'] ?? []) contents.push({ id: c, count: 1 });
    for (const g of e['contents-group'] ?? []) contents.push(...this.group(g, stackIds, ch));
    if (contents.length) result.contents = [...(result.contents ?? []), ...stack(contents)];
    if (e['custom-flags']?.length) result.flags = [...(result.flags ?? []), ...e['custom-flags']];
    if (e.active) result.active = true;
    return result;
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

import type { Rng } from '../core/rng';
import type { GameData, ItemGroupDef } from '../data/types';
import { expandItemGroup, type SpawnedItem } from '../data/itemgroups';

// BN starting kit (profession.cpp profession::items + json_item_substitution): the
// profession's `items.both` + gendered collection groups, then trait-driven bonus items and
// substitutions (misc.profession_item_substitutions, keyed "item:<id>" / "trait:<id>" /
// "bonus:<id>"), and every VARSIZE item made to FIT. Pure data → SpawnedItem, so chargen
// and tests share it; turning SpawnedItems into Items stays with the item model.

interface TraitReqs {
  present?: string[];
  absent?: string[];
}
type NewItem = string | { item: string; ratio?: number };
interface ItemSub extends TraitReqs {
  new: NewItem[];
}
interface TraitSub {
  item: string;
  new: NewItem[];
}

export interface ProfessionItemsDef {
  items?: { both?: ItemGroupDef; male?: ItemGroupDef; female?: ItemGroupDef };
  no_bonus?: string[];
}

const meets = (r: TraitReqs, traits: Set<string>) => (r.present ?? []).every((t) => traits.has(t)) && !(r.absent ?? []).some((t) => traits.has(t));

/** The substitution rules as BN's json_item_substitution holds them: item id → alternatives. */
interface Bonus {
  item?: string;
  group?: ItemGroupDef;
  bonus: TraitReqs;
}

function substitutionRules(data: GameData): { subs: Map<string, ItemSub[]>; bonuses: Bonus[] } {
  const raw = (data.misc?.profession_item_substitutions ?? {}) as Record<string, unknown>;
  const subs = new Map<string, ItemSub[]>();
  const bonuses: Bonus[] = [];
  const push = (item: string, s: ItemSub) => {
    if (!subs.has(item)) subs.set(item, []);
    subs.get(item)!.push(s);
  };
  for (const [key, val] of Object.entries(raw)) {
    const [kind, id] = key.split(':', 2);
    if (kind === 'item') for (const s of val as ItemSub[]) push(id, s);
    else if (kind === 'trait') for (const s of val as TraitSub[]) push(s.item, { present: [id], new: s.new });
    else if (kind === 'bonus') bonuses.push(val as Bonus);
    else throw new Error(`profession_item_substitutions: unknown key ${key}`);
  }
  return { subs, bonuses };
}

function spawnOne(data: GameData, id: string, rng: Rng, charges?: number): SpawnedItem[] {
  if (!data.items[id]) {
    console.warn(`profession item substitution: unknown item ${id}`);
    return [];
  }
  return expandItemGroup(data, { subtype: 'collection', entries: [{ item: id, ...(charges !== undefined ? { charges } : {}) }] } as ItemGroupDef, rng);
}

/** json_item_substitution::get_substitution (recursing into contents like the C++). */
function substitute(data: GameData, s: SpawnedItem, traits: Set<string>, subs: Map<string, ItemSub[]>, rng: Rng): SpawnedItem[] | null {
  const alts = subs.get(s.id);
  if (!alts) {
    // Not substituted itself: a substitution inside (the water in a bottle) replaces it.
    const out: SpawnedItem[] = [];
    for (const c of s.contents ?? []) out.push(...(substitute(data, c, traits, subs, rng) ?? []));
    return out.length ? out : null;
  }
  const sub = alts.find((a) => meets(a, traits));
  if (!sub) return null;
  const def = data.items[s.id];
  const oldAmt = def?.count_by_charges ? s.charges ?? s.count : s.count;
  const out: SpawnedItem[] = [];
  for (const n of sub.new) {
    const id = typeof n === 'string' ? n : n.item;
    const ratio = typeof n === 'string' ? 1 : n.ratio ?? 1;
    const amt = Math.max(1, Math.round(ratio * oldAmt));
    if (data.items[id]?.count_by_charges) out.push(...spawnOne(data, id, rng, amt));
    else for (let i = 0; i < amt; i++) out.push(...spawnOne(data, id, rng));
  }
  return out;
}

/** profession::items(male, traits) as SpawnedItems. */
export function professionItems(data: GameData, prof: ProfessionItemsDef, male: boolean, traits: Iterable<string>, rng: Rng): SpawnedItem[] {
  const have = new Set(traits);
  const { subs, bonuses } = substitutionRules(data);
  let result: SpawnedItem[] = [];
  for (const key of ['both', male ? 'male' : 'female'] as const) {
    const g = prof.items?.[key];
    if (g) result.push(...expandItemGroup(data, g, rng));
  }
  const noBonus = new Set(prof.no_bonus ?? []);
  // get_bonus_items: single items, then item-group bonuses (each item still checked against no_bonus).
  for (const b of bonuses) {
    if (!meets(b.bonus, have)) continue;
    if (b.item && !noBonus.has(b.item)) result.push(...spawnOne(data, b.item, rng));
    if (b.group) result.push(...expandItemGroup(data, b.group, rng).filter((s) => !noBonus.has(s.id)));
  }
  const out: SpawnedItem[] = [];
  for (const s of result) {
    const sub = substitute(data, s, have, subs, rng);
    if (sub) out.push(...sub);
    else out.push(s);
  }
  result = out;
  // Starting clothes always fit.
  const fit = (s: SpawnedItem) => {
    if (data.items[s.id]?.flags?.includes('VARSIZE') && !s.flags?.includes('FIT')) s.flags = [...(s.flags ?? []), 'FIT'];
    for (const c of s.contents ?? []) fit(c);
  };
  result.forEach(fit);
  return result;
}

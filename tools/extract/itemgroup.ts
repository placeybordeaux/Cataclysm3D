// item_group JSON -> normalized ItemGroupDef (see src/data/types.ts).
//
// CDDA accepts several spellings (Item_factory::load_item_group / add_entry in
// item_factory.cpp): legacy "items"/"groups" arrays of strings or [id, prob] pairs,
// subtype "old", "count-min"/"count-max", object-form "container-item". We fold all of
// that into `entries` so the runtime (src/data/itemgroups.ts) handles one shape.

import type { ItemGroupDef, ItemGroupEntry, ItemGroupRef } from '../../src/data/types';

type Json = Record<string, any>;

function minMax(obj: Json, name: string): number | [number, number] | undefined {
  let lo: number | undefined;
  let hi: number | undefined;
  const v = obj[name];
  if (Array.isArray(v)) {
    if (v.length !== 2) throw new Error(`"${name}" array must have 2 entries: ${JSON.stringify(obj)}`);
    [lo, hi] = v;
  } else if (typeof v === 'number') {
    lo = hi = v;
  } else if (v !== undefined) {
    throw new Error(`bad "${name}": ${JSON.stringify(v)}`);
  }
  if (typeof obj[name + '-min'] === 'number') lo = obj[name + '-min'];
  if (typeof obj[name + '-max'] === 'number') hi = obj[name + '-max'];
  if (lo === undefined && hi === undefined) return undefined;
  // Item_modifier defaults: count (1,1), charges (-1,-1), damage (0,0)
  const dflt = name === 'count' ? 1 : name === 'charges' ? -1 : 0;
  lo ??= dflt;
  hi ??= dflt;
  return lo === hi ? lo : [lo, hi];
}

const strList = (v: unknown): string[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v as string]);

// keys we translate explicitly; everything else on an entry is passed through verbatim
const HANDLED = new Set([
  'item', 'group', 'distribution', 'collection', 'prob', 'count', 'count-min', 'count-max', 'charges',
  'charges-min', 'charges-max', 'damage', 'damage-min', 'damage-max', 'container-item', 'contents-item',
  'contents-group', 'entry-wrapper',
]);

export function normalizeEntry(obj: Json, inCollection: boolean): ItemGroupEntry | null {
  let prob: number = obj.prob ?? 100;
  // Item_group::add_entry drops non-positive probabilities and caps collection probs at 100
  if (prob <= 0) return null;
  if (inCollection) prob = Math.min(100, prob);
  const e: ItemGroupEntry = {};
  if (obj.collection || obj.distribution) {
    const isColl = !!obj.collection;
    const list: Json[] = obj.collection ?? obj.distribution;
    const sub = list.map((x) => normalizeEntry(x, isColl)).filter((x): x is ItemGroupEntry => !!x);
    if (isColl) e.collection = sub;
    else e.distribution = sub;
    if (prob !== 100) e.prob = prob;
    // add_entry returns before reading modifiers for nested groups, so nothing else applies
    return e;
  }
  if (typeof obj.item === 'string') e.item = obj.item;
  else if (typeof obj.group === 'string') e.group = obj.group;
  // add_entry silently skips such entries (core data has a few `{}` placeholders)
  else return null;
  if (prob !== 100) e.prob = prob;
  const count = minMax(obj, 'count');
  if (count !== undefined && count !== 1) e.count = count;
  const charges = minMax(obj, 'charges');
  if (charges !== undefined) e.charges = charges;
  const damage = minMax(obj, 'damage');
  if (damage !== undefined && damage !== 0) e.damage = damage;
  const ci = obj['container-item'];
  if (typeof ci === 'string') e['container-item'] = ci;
  else if (ci && typeof ci === 'object') {
    // object form sets Single_item_creator::container_item: one container around all `count` items
    e['entry-wrapper'] = ci.item;
    if (ci.variant) e['container-variant'] = ci.variant;
  }
  if (typeof obj['entry-wrapper'] === 'string') e['entry-wrapper'] = obj['entry-wrapper'];
  const ciItems = strList(obj['contents-item']);
  if (ciItems) e['contents-item'] = ciItems;
  const ciGroups = strList(obj['contents-group']);
  if (ciGroups) e['contents-group'] = ciGroups;
  for (const [k, v] of Object.entries(obj)) if (!HANDLED.has(k)) (e as Json)[k] = v;
  return e;
}

function legacyList(arr: unknown[], kind: 'item' | 'group', inCollection: boolean): ItemGroupEntry[] {
  const out: ItemGroupEntry[] = [];
  for (const x of arr) {
    let e: ItemGroupEntry | null;
    if (typeof x === 'string') e = normalizeEntry({ [kind]: x }, inCollection);
    else if (Array.isArray(x)) e = normalizeEntry({ [kind]: x[0], prob: x[1] }, inCollection);
    else e = normalizeEntry(x as Json, inCollection);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Normalize an item group object (a top-level `item_group` or an inline group's object
 * form). `defaultSubtype` is what the call site passes to item_group::load_item_group
 * ("old" for top-level groups, i.e. distribution).
 */
export function normalizeGroupObject(obj: Json, defaultSubtype: 'old' | 'distribution' | 'collection' = 'old'): ItemGroupDef {
  const st: string = obj.subtype ?? defaultSubtype;
  if (st !== 'old' && st !== 'distribution' && st !== 'collection') throw new Error(`unknown item group subtype ${st}`);
  const subtype = st === 'collection' ? 'collection' : 'distribution';
  const inColl = subtype === 'collection';
  const entries: ItemGroupEntry[] = [];
  if (Array.isArray(obj.entries)) for (const x of obj.entries) {
    const e = normalizeEntry(x, inColl);
    if (e) entries.push(e);
  }
  if (Array.isArray(obj.items)) entries.push(...legacyList(obj.items, 'item', inColl));
  if (Array.isArray(obj.groups)) entries.push(...legacyList(obj.groups, 'group', inColl));
  const def: ItemGroupDef = { subtype, entries };
  if (typeof obj.id === 'string') def.id = obj.id;
  const ci = obj['container-item'];
  if (typeof ci === 'string') def['container-item'] = ci;
  else if (ci && typeof ci === 'object') {
    def['container-item'] = ci.item;
    if (ci.variant) def['container-variant'] = ci.variant;
  }
  if (obj.on_overflow) def.on_overflow = obj.on_overflow;
  if (obj.ammo) def.ammo = obj.ammo;
  if (obj.magazine) def.magazine = obj.magazine;
  if (obj.sealed !== undefined) def.sealed = obj.sealed;
  return def;
}

/** Inline group reference: a group id string, an object group, or an array of entries. */
export function normalizeGroupRef(v: unknown, defaultSubtype: 'distribution' | 'collection'): ItemGroupRef | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return normalizeGroupObject({ subtype: defaultSubtype, entries: v }, defaultSubtype);
  if (typeof v === 'object') return normalizeGroupObject(v as Json, defaultSubtype);
  throw new Error(`invalid item group reference ${JSON.stringify(v)}`);
}

export interface ItemMigration { replace: string; variant?: string }

/**
 * Apply MIGRATION replacements in place, as Item_factory::finalize does for every item
 * template group (obsolete ids like "uno" -> "deck_of_cards" variant "uno").
 */
export function migrateGroup(ref: ItemGroupRef | undefined, mig: Map<string, ItemMigration>): void {
  if (ref === undefined || typeof ref === 'string') return;
  const visit = (e: ItemGroupEntry) => {
    if (e.item && mig.has(e.item)) {
      const m = mig.get(e.item)!;
      e.item = m.replace;
      if (m.variant && e.variant === undefined) e.variant = m.variant;
    }
    for (const k of ['container-item', 'entry-wrapper', 'ammo-item'] as const) {
      const v = e[k];
      if (typeof v === 'string' && mig.has(v)) e[k] = mig.get(v)!.replace;
    }
    if (e['contents-item']) e['contents-item'] = e['contents-item'].map((i) => mig.get(i)?.replace ?? i);
    e.collection?.forEach(visit);
    e.distribution?.forEach(visit);
  };
  ref.entries.forEach(visit);
  const ci = ref['container-item'];
  if (ci && mig.has(ci)) ref['container-item'] = mig.get(ci)!.replace;
}

/** Collect group ids referenced (recursively) by a ref, for validation. */
export function referencedIds(ref: ItemGroupRef | ItemGroupEntry[], items: Set<string>, groups: Set<string>): void {
  const visit = (e: ItemGroupEntry) => {
    if (e.item) items.add(e.item);
    if (e.group) groups.add(e.group);
    e.collection?.forEach(visit);
    e.distribution?.forEach(visit);
    for (const k of ['container-item', 'entry-wrapper', 'ammo-item'] as const) if (typeof e[k] === 'string') items.add(e[k] as string);
    e['contents-item']?.forEach((i) => items.add(i));
    e['contents-group']?.forEach((g) => groups.add(g));
    for (const k of ['container-group', 'ammo-group'] as const) if (typeof e[k] === 'string') groups.add(e[k] as string);
  };
  if (typeof ref === 'string') groups.add(ref);
  else if (Array.isArray(ref)) ref.forEach(visit);
  else {
    ref.entries.forEach(visit);
    if (ref['container-item']) items.add(ref['container-item']);
  }
}

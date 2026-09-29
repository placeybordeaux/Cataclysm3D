// item_group JSON -> normalized ItemGroupDef (see src/data/types.ts), with Bright Nights'
// rules (src/item_factory.cpp load_item_group / add_entry / load_sub_ref / load_min_max,
// src/item_group.cpp item_group::load_item_group):
//  - top-level groups default to subtype "old" = a distribution that reads *only* "items"
//    (objects or [id, prob] pairs); "distribution"/"collection" read "entries", "items"
//    (strings, pairs or objects) and "groups" (same for group ids)
//  - an inline group object defaults to the caller's subtype, an inline array is a list of
//    entry objects
//  - entries: "item"/"group"/"collection"/"distribution", prob (<= 0 dropped, capped at 100
//    in collections), count/charges/damage/dirt as n, [min, max] or -min/-max,
//    "container-item"|"container-group" (one), "ammo-item"|"ammo-group" (one),
//    "contents-item"/"contents-group" (strings or arrays, both allowed), "custom-flags",
//    "active". Everything else (DDA's "entry-wrapper", "variant", "event", object-form
//    "container-item", group-level "container-item"/"on_overflow") is not BN and fails.
//  - no copy-from: a repeated group id appends to the earlier group ("purge": true resets
//    it) and "delete": [{item}|{group}] removes the first matching entry

import type { ItemGroupDef, ItemGroupEntry, ItemGroupRef } from '../../src/data/types';

type Json = Record<string, any>;

function minMax(obj: Json, name: string, dflt: [number, number], ctx: string): [number, number] | undefined {
  let lo: number | undefined;
  let hi: number | undefined;
  const v = obj[name];
  if (Array.isArray(v)) {
    if (v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number') throw new Error(`${ctx}: "${name}" must be [min, max]: ${JSON.stringify(v)}`);
    [lo, hi] = v;
  } else if (typeof v === 'number') {
    lo = hi = v;
  } else if (v !== undefined) {
    throw new Error(`${ctx}: bad "${name}": ${JSON.stringify(v)}`);
  }
  if (typeof obj[name + '-min'] === 'number') lo = obj[name + '-min'];
  if (typeof obj[name + '-max'] === 'number') hi = obj[name + '-max'];
  if (lo === undefined && hi === undefined) return undefined;
  return [lo ?? dflt[0], hi ?? dflt[1]];
}

const oneOrPair = (p: [number, number]): number | [number, number] => (p[0] === p[1] ? p[0] : p);
const strList = (v: unknown, ctx: string): string[] | undefined => {
  if (v === undefined) return undefined;
  const l = Array.isArray(v) ? v : [v];
  if (!l.every((x) => typeof x === 'string')) throw new Error(`${ctx}: expected id or id list, got ${JSON.stringify(v)}`);
  return l as string[];
};

const ENTRY_KEYS = new Set([
  'item', 'group', 'distribution', 'collection', 'prob', 'count', 'count-min', 'count-max', 'charges', 'charges-min',
  'charges-max', 'damage', 'damage-min', 'damage-max', 'dirt', 'dirt-min', 'dirt-max', 'container-item', 'container-group',
  'contents-item', 'contents-group', 'ammo-item', 'ammo-group', 'custom-flags', 'active',
  // only produced by normalizeProfession's legacy [id, snippet] items
  'snippet',
]);

export function normalizeEntry(obj: Json, inCollection: boolean, ctx = 'item group'): ItemGroupEntry | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${ctx}: entry must be an object: ${JSON.stringify(obj)}`);
  for (const k of Object.keys(obj)) if (!ENTRY_KEYS.has(k)) throw new Error(`${ctx}: entry key "${k}" is not BN: ${JSON.stringify(obj).slice(0, 200)}`);
  let prob: number = obj.prob ?? 100;
  // Item_group::add_entry drops non-positive probabilities and caps collection probs at 100
  if (prob <= 0) return null;
  if (inCollection) prob = Math.min(100, prob);
  const e: ItemGroupEntry = {};
  if (obj.collection || obj.distribution) {
    const isColl = !!obj.collection;
    const list: Json[] = obj.collection ?? obj.distribution;
    const sub = list.map((x) => normalizeEntry(x, isColl, ctx)).filter((x): x is ItemGroupEntry => !!x);
    if (isColl) e.collection = sub;
    else e.distribution = sub;
    if (prob !== 100) e.prob = prob;
    // add_entry returns before reading modifiers for nested groups, so nothing else applies
    return e;
  }
  if (typeof obj.item === 'string') e.item = obj.item;
  else if (typeof obj.group === 'string') e.group = obj.group;
  // add_entry silently skips entries with neither
  else return null;
  if (prob !== 100) e.prob = prob;
  // Item_modifier defaults: count (1,1), charges (-1,-1), damage (0,0), dirt (0,500)
  const count = minMax(obj, 'count', [1, 1], ctx);
  if (count && !(count[0] === 1 && count[1] === 1)) e.count = oneOrPair(count);
  const charges = minMax(obj, 'charges', [-1, -1], ctx);
  if (charges) e.charges = oneOrPair(charges);
  const damage = minMax(obj, 'damage', [0, 0], ctx);
  if (damage && !(damage[0] === 0 && damage[1] === 0)) e.damage = oneOrPair(damage);
  const dirt = minMax(obj, 'dirt', [0, 500], ctx);
  if (dirt) e.dirt = oneOrPair(dirt);
  for (const k of ['container', 'ammo'] as const) {
    const i = obj[`${k}-item`];
    const g = obj[`${k}-group`];
    if (i !== undefined && g !== undefined) throw new Error(`${ctx}: only one of ${k}-item and ${k}-group`);
    if (i !== undefined && typeof i !== 'string') throw new Error(`${ctx}: ${k}-item must be an id: ${JSON.stringify(i)}`);
    if (g !== undefined && typeof g !== 'string') throw new Error(`${ctx}: ${k}-group must be an id: ${JSON.stringify(g)}`);
    if (i !== undefined) e[`${k}-item`] = i;
    if (g !== undefined) e[`${k}-group`] = g;
  }
  const ci = strList(obj['contents-item'], ctx);
  if (ci) e['contents-item'] = ci;
  const cg = strList(obj['contents-group'], ctx);
  if (cg) e['contents-group'] = cg;
  const flags = strList(obj['custom-flags'], ctx);
  if (flags?.length) e['custom-flags'] = flags;
  if (obj.active === true) e.active = true;
  if (typeof obj.snippet === 'string') e.snippet = obj.snippet;
  return e;
}

function pairOrEntry(x: unknown, kind: 'item' | 'group', inCollection: boolean, allowString: boolean, ctx: string): ItemGroupEntry | null {
  if (typeof x === 'string') {
    if (!allowString) throw new Error(`${ctx}: subtype "old" items must be objects or [id, prob] pairs, got "${x}"`);
    return normalizeEntry({ [kind]: x }, inCollection, ctx);
  }
  if (Array.isArray(x)) {
    if (typeof x[0] !== 'string' || typeof x[1] !== 'number') throw new Error(`${ctx}: bad [id, prob] pair ${JSON.stringify(x)}`);
    return normalizeEntry({ [kind]: x[0], prob: x[1] }, inCollection, ctx);
  }
  return normalizeEntry(x as Json, inCollection, ctx);
}

const GROUP_KEYS = new Set(['id', 'type', 'subtype', 'entries', 'items', 'groups', 'ammo', 'magazine', 'purge', 'delete']);

/**
 * Normalize an item group object (a top-level `item_group`, or an inline group's object
 * form). `defaultSubtype` is what the call site passes to load_item_group ("old" for
 * top-level groups, the caller's default for inline ones).
 */
export function normalizeGroupObject(obj: Json, defaultSubtype: 'old' | 'distribution' | 'collection' = 'old'): ItemGroupDef {
  const ctx = `item group ${obj.id ?? '(inline)'}`;
  for (const k of Object.keys(obj)) if (!GROUP_KEYS.has(k)) throw new Error(`${ctx}: key "${k}" is not BN`);
  const st: string = obj.subtype ?? defaultSubtype;
  if (st !== 'old' && st !== 'distribution' && st !== 'collection') throw new Error(`${ctx}: unknown item group subtype ${st}`);
  const subtype = st === 'collection' ? 'collection' : 'distribution';
  const inColl = subtype === 'collection';
  const entries: ItemGroupEntry[] = [];
  const push = (e: ItemGroupEntry | null) => e && entries.push(e);
  if (st === 'old') {
    if (obj.entries !== undefined || obj.groups !== undefined) throw new Error(`${ctx}: subtype "old" only reads "items" (BN ignores entries/groups)`);
    for (const x of obj.items ?? []) push(pairOrEntry(x, 'item', false, false, ctx));
  } else {
    for (const x of obj.entries ?? []) push(normalizeEntry(x, inColl, ctx));
    for (const x of obj.items ?? []) push(pairOrEntry(x, 'item', inColl, true, ctx));
    for (const x of obj.groups ?? []) push(pairOrEntry(x, 'group', inColl, true, ctx));
  }
  const def: ItemGroupDef = { subtype, entries };
  if (typeof obj.id === 'string') def.id = obj.id;
  if (obj.ammo) def.ammo = obj.ammo;
  if (obj.magazine) def.magazine = obj.magazine;
  return def;
}

/** Inline group reference: a group id string, an object group, or an array of entries. */
export function normalizeGroupRef(v: unknown, defaultSubtype: 'distribution' | 'collection'): ItemGroupRef | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const inColl = defaultSubtype === 'collection';
    return { subtype: defaultSubtype, entries: v.map((x) => normalizeEntry(x, inColl, 'inline item group')).filter((x): x is ItemGroupEntry => !!x) };
  }
  if (typeof v === 'object') return normalizeGroupObject(v as Json, defaultSubtype);
  throw new Error(`invalid item group reference ${JSON.stringify(v)}`);
}

/**
 * Merge all `item_group` objects in load order (Item_factory::load_item_group): a repeated
 * id appends its entries to the existing group, which must have the same subtype;
 * "purge": true discards what was there; "delete" removes the first direct entry naming
 * that item / group. The first definition's ammo/magazine chances stay (make_group_or_throw).
 */
export function mergeItemGroups(objs: Json[]): Record<string, ItemGroupDef> {
  const out: Record<string, ItemGroupDef> = {};
  for (const o of objs) {
    const id: string = o.id;
    if (typeof id !== 'string') throw new Error(`item_group without string id: ${JSON.stringify(o).slice(0, 200)}`);
    const def = normalizeGroupObject(o, 'old');
    const prev = o.purge === true ? undefined : out[id];
    if (!prev) {
      out[id] = def;
    } else {
      if (prev.subtype !== def.subtype) throw new Error(`item group "${id}" already defined with type ${prev.subtype}`);
      prev.entries.push(...def.entries);
    }
    const g = out[id];
    for (const d of Array.isArray(o.delete) ? o.delete : []) {
      const key = typeof d?.item === 'string' ? 'item' : typeof d?.group === 'string' ? 'group' : undefined;
      if (!key) continue;
      const i = g.entries.findIndex((e) => e[key] === d[key]);
      if (i >= 0) g.entries.splice(i, 1);
    }
  }
  return out;
}

/** `variant` is DDA-only and never set for BN; kept optional so older callers still compile. */
export interface ItemMigration { replace: string; variant?: string }

/**
 * Apply MIGRATION replacements in place, as Item_factory::finalize does for every item
 * group (Single_item_creator::replace_item: the entry's item and its container/ammo
 * modifiers; BN leaves "contents" alone).
 */
export function migrateGroup(ref: ItemGroupRef | undefined, mig: Map<string, ItemMigration>): void {
  if (ref === undefined || typeof ref === 'string') return;
  const visit = (e: ItemGroupEntry) => {
    if (e.item && mig.has(e.item)) e.item = mig.get(e.item)!.replace;
    for (const k of ['container-item', 'ammo-item'] as const) {
      const v = e[k];
      if (typeof v === 'string' && mig.has(v)) e[k] = mig.get(v)!.replace;
    }
    e.collection?.forEach(visit);
    e.distribution?.forEach(visit);
  };
  ref.entries.forEach(visit);
}

/** Collect item / group ids referenced (recursively) by a ref, for validation. */
export function referencedIds(ref: ItemGroupRef | ItemGroupEntry[], items: Set<string>, groups: Set<string>): void {
  const visit = (e: ItemGroupEntry) => {
    if (e.item) items.add(e.item);
    if (e.group) groups.add(e.group);
    e.collection?.forEach(visit);
    e.distribution?.forEach(visit);
    for (const k of ['container-item', 'ammo-item'] as const) if (typeof e[k] === 'string') items.add(e[k] as string);
    e['contents-item']?.forEach((i) => items.add(i));
    e['contents-group']?.forEach((g) => groups.add(g));
    for (const k of ['container-group', 'ammo-group'] as const) if (typeof e[k] === 'string') groups.add(e[k] as string);
  };
  if (typeof ref === 'string') groups.add(ref);
  else if (Array.isArray(ref)) ref.forEach(visit);
  else ref.entries.forEach(visit);
}

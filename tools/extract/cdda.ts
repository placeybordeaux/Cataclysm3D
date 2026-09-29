// Reusable Cataclysm JSON loading + inheritance resolution, targeting Cataclysm: Bright
// Nights (~/code/Cataclysm-BN). Names still say "cdda": the formats share ancestry and the
// other extractors import these names.
//
// Shared with the world extractors (mapgen, npcs, vehicles, ...), so keep this free of
// output-format concerns: it reads raw JSON, groups it by type, and resolves copy-from the
// way BN's loaders do. BN ships no JSON docs in the checkout; the C++ is the reference:
//   src/generic_factory.h  handle_inheritance + optional(): explicit > proportional > relative
//   src/assign.h/.cpp      assign(): relative > proportional > explicit (items and most slots)
//   src/item_factory.cpp   load_definition / load_basic_info (item copy-from, looks_like)
//   src/item_factory.cpp   load_item_group: repeated ids *append* (no copy-from), "purge"
//   src/mongroup.cpp       LoadMonsterGroup: keyed by "name", repeated names extend

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareObject } from './prepare';

export type CddaObject = Record<string, any>;

/** Where each raw object came from; attached as a non-enumerable property so JSON output ignores it. */
export const SOURCE = Symbol('cddaSource');

/** Game data checkout: $CDDA_DIR, else Bright Nights at ~/code/Cataclysm-BN. */
export function defaultCddaDir(): string {
  return process.env.CDDA_DIR ?? path.join(os.homedir(), 'code/Cataclysm-BN');
}

function listJsonFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    // Sorted so load order (and therefore "last duplicate wins") is deterministic.
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export interface LoadOptions {
  /** Only keep these types (exact CDDA `type` strings). */
  types?: Iterable<string>;
  /** Drop these types. */
  excludeTypes?: Iterable<string>;
}

/**
 * Load every object under `<cddaDir>/data/json` (core game only, no mods), grouped by
 * `type` in load order. Objects are returned as parsed (no preprocessing).
 * `cddaDir` may also point directly at a `data/json` directory.
 */
export function loadCddaObjects(cddaDir: string = defaultCddaDir(), opts: LoadOptions = {}): Map<string, CddaObject[]> {
  const jsonDir = fs.existsSync(path.join(cddaDir, 'data/json')) ? path.join(cddaDir, 'data/json') : cddaDir;
  if (!fs.existsSync(jsonDir)) throw new Error(`game data dir not found: ${jsonDir} (set CDDA_DIR or pass --cdda)`);
  const only = opts.types ? new Set(opts.types) : null;
  const exclude = new Set(opts.excludeTypes ?? []);
  const byType = new Map<string, CddaObject[]>();
  for (const file of listJsonFiles(jsonDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${(e as Error).message}`);
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const rel = path.relative(jsonDir, file);
    for (const obj of arr) {
      if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') {
        throw new Error(`${rel}: object without string "type": ${JSON.stringify(obj).slice(0, 200)}`);
      }
      if (only && !only.has(obj.type)) continue;
      if (exclude.has(obj.type)) continue;
      Object.defineProperty(obj, SOURCE, { value: rel, enumerable: false });
      let list = byType.get(obj.type);
      if (!list) byType.set(obj.type, (list = []));
      list.push(obj);
    }
  }
  return byType;
}

export function sourceOf(obj: CddaObject): string | undefined {
  return (obj as any)[SOURCE];
}

// ---------------------------------------------------------------------------------------
// Type families: types that share one id namespace for copy-from.

// BN keeps one JSON `type` per item kind (init.cpp registers each with its own
// Item_factory::load_* function) but they share the one itype id namespace, so a TOOL may
// copy-from a GENERIC. Modern DDA's single "ITEM" type is deliberately *not* listed: DDA data
// then fails loudly as an unclassified type instead of being half-understood.
export const ITEM_TYPES = [
  'GENERIC', 'TOOL', 'COMESTIBLE', 'ARMOR', 'TOOL_ARMOR', 'PET_ARMOR', 'GUN', 'GUNMOD', 'AMMO', 'MAGAZINE', 'BOOK',
  'CONTAINER', 'BIONIC_ITEM', 'TOOLMOD', 'ENGINE', 'WHEEL', 'FUEL', 'BATTERY',
];
/** @deprecated DDA-era name, kept for importers; same list as ITEM_TYPES. */
export const LEGACY_ITEM_TYPES = ITEM_TYPES;

export function familyOf(type: string): string {
  if (ITEM_TYPES.includes(type)) return 'ITEM';
  // recipe_dictionary::load_nested_category stores into the recipe map (uncraft has its own)
  if (type === 'recipe' || type === 'nested_category') return 'recipe';
  return type;
}

/** Types belonging to a family name, so callers may ask for "ITEM" as if it were a type. */
export function familyTypes(family: string): string[] {
  if (family === 'ITEM') return ITEM_TYPES;
  if (family === 'recipe') return ['recipe', 'nested_category'];
  return [family];
}

/**
 * Ids an object defines. `id` may be an array (one definition per id); generic_factory also
 * accepts the legacy "ident". Recipes are keyed by result + "_" + id_suffix (BN
 * recipe::load; BN has no DDA recipe variants). Objects without any id (speech, dream,
 * snippet with only category...) return [].
 */
export function objectIds(obj: CddaObject): string[] {
  const fam = familyOf(obj.type);
  if (typeof obj.abstract === 'string') return [obj.abstract];
  if (fam === 'recipe' || obj.type === 'uncraft') {
    if (obj.type === 'nested_category') return [obj.id];
    if (typeof obj.result !== 'string') throw new Error(`${obj.type} without string "result": ${JSON.stringify(obj).slice(0, 200)}`);
    return [obj.type === 'recipe' && obj.id_suffix ? `${obj.result}_${obj.id_suffix}` : obj.result];
  }
  if (Array.isArray(obj.id)) return obj.id;
  if (typeof obj.id === 'string') return [obj.id];
  if (typeof obj.ident === 'string') return [obj.ident];
  // types keyed by something other than "id"
  switch (obj.type) {
    case 'MONSTER_FACTION':
    case 'monstergroup':
    case 'EXTERNAL_OPTION':
    case 'named_color':
      return typeof obj.name === 'string' ? [obj.name] : [];
    case 'profession_item_substitutions':
      return [obj.item ?? obj.trait ?? obj.item_group].filter((x) => typeof x === 'string');
    case 'rotatable_symbol':
      return Array.isArray(obj.tuple) ? [obj.tuple.join('')] : [];
    case 'hit_range':
      return ['default'];
  }
  return [];
}

/** generic_factory "alias": extra ids that resolve to the same object (t_wall_h -> t_wall). */
export function objectAliases(obj: CddaObject): string[] {
  const a = obj.alias;
  if (a === undefined) return [];
  if (typeof a === 'string') return [a];
  if (Array.isArray(a) && a.every((x) => typeof x === 'string')) return a;
  throw new Error(`${obj.type} ${obj.id}: bad "alias" ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------------------
// Inheritance

const INHERIT_KEYS = new Set(['copy-from', 'extend', 'delete', 'relative', 'proportional', 'abstract', 'id']);

export interface InheritHooks {
  /** Keys that are never inherited from the parent (reset to default on each load in C++). */
  notInherited?: string[];
  /** Keys whose object values merge field-by-field with the parent's instead of replacing. */
  mergeObjects?: string[];
  /** Keys the child *must* not take from its own JSON when it has copy-from. */
  ignoreOwnWhenCopying?: string[];
  /**
   * true for families read with assign() (assign.h: relative beats proportional beats the
   * explicit value); false for generic_factory optional() (explicit first).
   */
  modifierFirst?: boolean;
  /** Called after merging with the resolved result, the parent id, and the raw child. */
  post?(result: CddaObject, parentId: string, parent: CddaObject, child: CddaObject, parentIsAbstract: boolean): void;
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Identifier used to match array elements for relative/delete ([id, n] pairs, {id}/{type}/{drop} objects, damage units). */
function elemKey(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  if (isObj(v)) {
    const k = v.damage_type ?? v.id ?? v.type ?? v.drop ?? v.monster ?? v.item ?? v.group;
    return typeof k === 'string' ? k : undefined;
  }
  return undefined;
}

type NumOp = (base: number, mod: number) => number;

/**
 * Apply `relative` (add) / `proportional` (multiply) to a parent value.
 * Handles plain numbers, maps ({bash: 2}), damage units ({damage_type, amount, ...} or
 * arrays of them), and [id, n] pair arrays (qualities).
 */
type Quantize = (result: number, base: number) => number;
const floatQ = (r: number): number => Math.round(r * 1e6) / 1e6;

function applyNumeric(base: unknown, mod: unknown, op: NumOp, quant: Quantize): unknown {
  if (typeof mod === 'number') {
    if (base === undefined) return op(0, mod);
    if (typeof base === 'number') {
      const r = op(base, mod);
      // C++ does `int_member *= float`, truncating toward zero.
      return quant(r, base);
    }
    // proportional: { armor: 1.5 } scales every number in the map / damage units
    if (isObj(base)) {
      const out: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(base)) if (typeof v === 'number' && k !== 'damage_type') out[k] = applyNumeric(v, mod, op, floatQ);
      return out;
    }
    if (Array.isArray(base)) return base.map((b) => (isObj(b) ? applyNumeric(b, mod, op, floatQ) : b));
    return base;
  }
  if (Array.isArray(mod)) {
    let out = base;
    for (const m of mod) out = applyNumeric(out, m, op, quant);
    return out;
  }
  if (isObj(mod)) {
    if (typeof mod.damage_type === 'string') {
      // damage unit: match by damage_type in base object or array
      // damage_unit fields are floats in C++ (no truncation), and the amount modifier is
      // also applied to every per-barrel-length amount (damage.cpp handle_proportional/+=)
      const f = (a: number | undefined, b: number) => Math.round(op(a ?? 0, b) * 1e6) / 1e6;
      const applyTo = (unit: Record<string, any>) => {
        const out: Record<string, any> = { ...unit };
        for (const [k, v] of Object.entries(mod)) {
          if (k === 'damage_type' || typeof v !== 'number') continue;
          out[k] = f(unit[k], v);
        }
        if (typeof mod.amount === 'number' && Array.isArray(unit.barrels)) {
          out.barrels = unit.barrels.map((b: Record<string, any>) => ({ ...b, amount: f(b.amount, mod.amount) }));
        }
        return out;
      };
      if (Array.isArray(base)) {
        let found = false;
        const arr = base.map((u) => {
          if (isObj(u) && u.damage_type === mod.damage_type) {
            found = true;
            return applyTo(u);
          }
          return u;
        });
        return found ? arr : [...arr, applyTo({ damage_type: mod.damage_type })];
      }
      if (isObj(base) && base.damage_type === mod.damage_type) return applyTo(base);
      if (isObj(base) && Array.isArray(base.values)) return { ...base, values: applyNumeric(base.values, mod, op, floatQ) };
      if (base === undefined) return applyTo({ damage_type: mod.damage_type });
      // mismatched damage type on a single-unit object: turn into an array
      if (isObj(base) && typeof base.damage_type === 'string') return [base, applyTo({ damage_type: mod.damage_type })];
      throw new Error(`cannot apply damage modifier ${JSON.stringify(mod)} to ${JSON.stringify(base)}`);
    }
    // map of numbers ({bash: 2, cut: 1}) or nested structure
    const out: Record<string, unknown> = isObj(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(mod)) out[k] = applyNumeric(out[k], v, op, floatQ);
    return out;
  }
  throw new Error(`unsupported relative/proportional modifier ${JSON.stringify(mod)}`);
}

// qualities relative: [["CUT", 1]] adds to the level of the matching pair
function applyPairs(base: unknown, mod: unknown[], op: NumOp): unknown {
  const arr: unknown[] = Array.isArray(base) ? clone(base) : [];
  for (const m of mod) {
    if (!Array.isArray(m) || typeof m[0] !== 'string' || typeof m[1] !== 'number') {
      throw new Error(`unsupported pair modifier ${JSON.stringify(m)}`);
    }
    const i = arr.findIndex((b) => Array.isArray(b) && b[0] === m[0]);
    if (i >= 0) {
      const b = arr[i] as [string, number];
      arr[i] = [b[0], Math.trunc(op(b[1], m[1]))];
    } else {
      arr.push([m[0], Math.trunc(op(0, m[1]))]);
    }
  }
  return arr;
}

function isPairArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number');
}

// Our gram unit is coarser than BN's internal milligrams (units::mass is int64 mg), so
// truncation after scaling happens at mg resolution. Volumes (ml), money (cents) and plain
// ints are integers in both.
const MASS_KEYS = new Set(['weight', 'integral_weight', 'mass', 'max_weight', 'weight_capacity_bonus', 'trigger_weight']);

/**
 * Apply one `relative` / `proportional` entry for top-level member `key`.
 * BN reads the factor as a double and does `out = val * scalar` (assign.h) or
 * `member *= scalar` (generic_factory.h handle_proportional): a double product truncated
 * toward zero for integer members (100 * 0.7 = 70; 1500 * 0.57 = 855.0000000000001 -> 855).
 * DDA used a 32-bit float factor; BN does not.
 */
export function applyModifier(base: unknown, mod: unknown, kind: 'relative' | 'proportional', key = ''): unknown {
  const op: NumOp = kind === 'relative' ? (a, b) => a + b : (a, b) => a * b;
  let quant: Quantize = floatQ;
  if (kind === 'proportional') {
    if (MASS_KEYS.has(key)) quant = (r) => Math.trunc(floatQ(r * 1000)) / 1000;
    else quant = (r, b) => (Number.isInteger(b) ? Math.trunc(r) : floatQ(r));
  }
  if (isPairArray(mod)) return applyPairs(base, mod, op);
  return applyNumeric(base, mod, op, quant);
}

export function applyExtend(base: unknown, ext: unknown): unknown {
  if (base === undefined) return clone(ext);
  if (Array.isArray(base)) {
    const add = Array.isArray(ext) ? ext : [ext];
    const out = [...base];
    for (const a of add) {
      // flag-like string sets are deduplicated (assign_set inserts into a set)
      if (typeof a === 'string' && out.includes(a)) continue;
      // [id, n] pairs are maps in C++ (qualities: def.qualities[id] = level): same id replaces
      if (isPairArray([a])) {
        const i = out.findIndex((b) => Array.isArray(b) && b[0] === (a as unknown[])[0]);
        if (i >= 0) {
          out[i] = clone(a);
          continue;
        }
      }
      out.push(clone(a));
    }
    return out;
  }
  if (isObj(base) && isObj(ext)) return { ...base, ...clone(ext) };
  // scalar "extend" (e.g. extend a string field into a list)
  return Array.isArray(ext) ? [base, ...ext] : [base, ext];
}

export function applyDelete(base: unknown, del: unknown): unknown {
  if (base === undefined) return undefined;
  const dels = Array.isArray(del) ? del : [del];
  if (Array.isArray(base)) {
    return base.filter((b) => {
      for (const d of dels) {
        if (deepEqual(b, d)) return false;
        // BN delete_qualities_from_json only removes a quality whose level matches too
        if (isPairArray([d])) continue;
        const bk = elemKey(b);
        const dk = elemKey(d);
        if (bk !== undefined && bk === dk) return false;
      }
      return true;
    });
  }
  if (isObj(base)) {
    const out = { ...base };
    for (const d of dels) {
      if (typeof d === 'string') delete out[d];
      else if (isObj(d)) for (const k of Object.keys(d)) delete out[k];
    }
    return out;
  }
  // deleting a scalar field's matching value clears it
  return dels.some((d) => deepEqual(d, base)) ? undefined : base;
}

/** Merge one child definition onto its resolved parent. Exported for tests. */
export function mergeInherited(parent: CddaObject | undefined, child: CddaObject, hooks: InheritHooks = {}): CddaObject {
  const out: CddaObject = {};
  if (parent) {
    for (const [k, v] of Object.entries(parent)) {
      if (INHERIT_KEYS.has(k)) continue;
      if (hooks.notInherited?.includes(k)) continue;
      out[k] = clone(v);
    }
  }
  const ignoreOwn = parent && hooks.ignoreOwnWhenCopying ? new Set(hooks.ignoreOwnWhenCopying) : null;
  for (const [k, v] of Object.entries(child)) {
    if (INHERIT_KEYS.has(k) && k !== 'id' && k !== 'abstract') continue;
    if (ignoreOwn?.has(k)) continue;
    if (parent && hooks.mergeObjects?.includes(k) && isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...clone(v) };
    else out[k] = clone(v);
  }
  if (!('abstract' in child)) delete out.abstract;
  // Exactly one of explicit / relative / proportional applies per member, and modifiers act
  // on the *inherited* value. Which one wins depends on the C++ reader:
  //   generic_factory optional(): explicit, else proportional, else relative
  //   assign() (items):           relative, else proportional, else explicit
  const rel = isObj(child.relative) ? child.relative : {};
  const prop = isObj(child.proportional) ? child.proportional : {};
  for (const k of new Set([...Object.keys(rel), ...Object.keys(prop)])) {
    const inherited = parent?.[k];
    if (hooks.modifierFirst) {
      if (k in rel) out[k] = applyModifier(clone(inherited), rel[k], 'relative', k);
      else out[k] = applyModifier(clone(inherited), prop[k], 'proportional', k);
    } else {
      if (k in child) continue;
      if (k in prop) out[k] = applyModifier(clone(inherited), prop[k], 'proportional', k);
      else out[k] = applyModifier(clone(inherited), rel[k], 'relative', k);
    }
  }
  if (isObj(child.extend)) for (const [k, e] of Object.entries(child.extend)) out[k] = applyExtend(out[k], e);
  if (isObj(child.delete)) {
    for (const [k, d] of Object.entries(child.delete)) {
      const r = applyDelete(out[k], d);
      if (r === undefined) delete out[k];
      else out[k] = r;
    }
  }
  return out;
}

export interface ResolvedFamily {
  /** Concrete (non-abstract) objects by id, fully resolved. Objects with array ids appear once per id. */
  byId: Map<string, CddaObject>;
  /** Abstract templates by id (resolved), for reference. */
  abstracts: Map<string, CddaObject>;
  /** Number of duplicate definitions that replaced an earlier one. */
  duplicates: string[];
  /** Non-fatal oddities BN tolerates (reported by the C++ as load errors). */
  warnings: string[];
  /** generic_factory "alias" id -> canonical id (byId also answers alias lookups). */
  aliases: Map<string, string>;
}

/**
 * Resolve copy-from for all objects of one family, in load order. Later duplicates of an
 * id replace earlier ones, except that `copy-from` pointing at the object's own id copies
 * the *previous* definition (how mods/extensions patch an existing object).
 *
 * `prepare` is applied to each raw object first (e.g. units/translation normalization).
 */
export function resolveFamily(
  objs: CddaObject[],
  hooks: InheritHooks = {},
  prepare: (o: CddaObject) => CddaObject = (o) => o,
): ResolvedFamily {
  interface Def { id: string; raw: CddaObject; src: string; index: number; resolved?: CddaObject; resolving?: boolean; abstract: boolean; discarded?: boolean }
  const defs: Def[] = [];
  const warnings: string[] = [];
  const byIdDefs = new Map<string, Def[]>();
  const aliases = new Map<string, string>();
  for (const raw0 of objs) {
    const raw = prepare(raw0);
    const ids = objectIds(raw0);
    for (const a of objectAliases(raw0)) aliases.set(a, ids[0]);
    for (const id of ids) {
      const d: Def = { id, raw, src: sourceOf(raw0) ?? '?', index: defs.length, abstract: typeof raw0.abstract === 'string' };
      defs.push(d);
      let l = byIdDefs.get(id);
      if (!l) byIdDefs.set(id, (l = []));
      l.push(d);
    }
  }
  const resolve = (d: Def, chain: string[]): CddaObject => {
    if (d.resolved) return d.resolved;
    if (d.resolving) throw new Error(`copy-from cycle: ${[...chain, d.id].join(' -> ')}`);
    d.resolving = true;
    const pid: unknown = d.raw['copy-from'];
    let result: CddaObject;
    if (typeof pid === 'string') {
      const cands = byIdDefs.get(pid);
      let pdef: Def | undefined;
      if (pid === d.id) {
        pdef = cands?.filter((c) => c.index < d.index).at(-1);
      } else {
        pdef = cands?.at(-1);
      }
      if (!pdef && pid === d.id) {
        // BN core has a few of these (enchantment_value PAIN_GOOD): the C++ defers the object,
        // never finds the parent and reports "circular dependency, this object is discarded".
        warnings.push(`${d.raw.type} ${d.id} (${d.src}): copy-from itself with no earlier definition; discarded like BN`);
        d.discarded = true;
        d.resolving = false;
        d.resolved = {};
        return d.resolved;
      }
      if (!pdef) throw new Error(`${d.raw.type} ${d.id} (${d.src}): copy-from unknown id "${pid}"`);
      if (pdef.discarded) throw new Error(`${d.raw.type} ${d.id} (${d.src}): copy-from discarded object "${pid}"`);
      const parent = resolve(pdef, [...chain, d.id]);
      result = mergeInherited(parent, d.raw, hooks);
      hooks.post?.(result, pid, parent, d.raw, pdef.abstract);
    } else {
      result = mergeInherited(undefined, d.raw, hooks);
    }
    if (!d.abstract && ('id' in result || 'ident' in result)) result.id = d.id;
    delete result.ident;
    delete result.alias;
    d.resolving = false;
    d.resolved = result;
    return result;
  };
  const byId = new Map<string, CddaObject>();
  const abstracts = new Map<string, CddaObject>();
  const duplicates: string[] = [];
  for (const [id, list] of byIdDefs) {
    for (const d of list) resolve(d, []);
    const kept = list.filter((x) => !x.discarded);
    const last = kept.at(-1);
    if (!last) continue;
    if (list.length > 1 && !list.slice(1).every((x) => x.raw['copy-from'] === id)) duplicates.push(id);
    if (last.abstract) abstracts.set(id, last.resolved!);
    else byId.set(id, last.resolved!);
  }
  // generic_factory::load: map[alias] = int id of the canonical object, overriding any
  // object that happened to use the alias as its own id.
  for (const [alias, id] of aliases) {
    const o = byId.get(id);
    if (!o) {
      warnings.push(`alias ${alias} -> unknown or discarded id ${id}`);
      continue;
    }
    byId.set(alias, o);
  }
  return { byId, abstracts, duplicates, aliases, warnings };
}

// ---------------------------------------------------------------------------------------
// Per-family quirks of the C++ loaders that the generic merge doesn't capture.

// looks_like: BN defaults it to the copy-from id (item_factory load_definition,
// map_data_common_t::load_symbol, mtype::load). We skip abstract parents (they never have
// sprites) so the renderer's looks_like fallback chain only walks real ids.
function looksLikeInherited(r: CddaObject, pid: string, parent: CddaObject, child: CddaObject, parentAbstract: boolean): void {
  r.looks_like = child.looks_like ?? parent.looks_like ?? (parentAbstract ? undefined : pid);
  if (r.looks_like === undefined) delete r.looks_like;
}

export const FAMILY_HOOKS: Record<string, InheritHooks> = {
  ITEM: {
    // every item slot is read with assign() (item_factory.cpp load_basic_info & friends)
    modifierFirst: true,
    post(r, pid, parent, child, parentAbstract) {
      // load_definition: a real parent's id always becomes looks_like (even if the parent had
      // its own); an abstract parent passes its looks_like on. The JSON's own value wins.
      r.looks_like = child.looks_like ?? (parentAbstract ? parent.looks_like : pid);
      if (r.looks_like === undefined) delete r.looks_like;
    },
  },
  terrain: {
    // map/mapdata.cpp ter_t::load: the activity_data members are re-made on every load
    // (not inherited); "bash" is read with optional() into the inherited struct so it merges
    // field-wise; "deconstruct"/"pry" replace wholesale when present. open/close/roof/
    // transforms_into ARE inherited in BN (DDA resets them).
    notInherited: ['hacksaw', 'oxytorch', 'boltcut'],
    mergeObjects: ['bash'],
    post: looksLikeInherited,
  },
  furniture: {
    notInherited: ['hacksaw', 'oxytorch', 'boltcut'],
    mergeObjects: ['bash'],
    post: looksLikeInherited,
  },
  MONSTER: { post: looksLikeInherited },
  // recipe.cpp: "inline requirements are always replaced (cannot be inherited)"
  recipe: { notInherited: ['tools', 'qualities', 'components'] },
  uncraft: { notInherited: ['tools', 'qualities', 'components'] },
  // veh_type.cpp vehicle_prototype::load: "parts" always *append* to the inherited list
  // (e.g. "car" = car_abstract's body + its own engine and tank).
  vehicle: {
    post(r, _pid, parent, child) {
      if (Array.isArray(child.parts) && Array.isArray(parent.parts)) r.parts = [...structuredClone(parent.parts), ...structuredClone(child.parts)];
    },
  },
};

/**
 * Families that do not use copy-from at all in BN: a repeated id *adds to* the earlier
 * definition. They must go through their own merge (itemgroup.ts mergeItemGroupDefs,
 * normalize.ts normalizeMonsterGroups), never resolveFamily.
 */
export const APPENDING_FAMILIES = new Set(['item_group', 'monstergroup']);

/**
 * One-stop helper for other extractors: load the given types (family names such as "ITEM"
 * expand to all their types) and resolve copy-from per family with the standard hooks.
 * With `prepare` (default true) objects also get comments stripped, quantity strings
 * converted to base units and translations flattened (see prepare.ts).
 * Returns type -> id -> resolved object (abstracts excluded; alias ids included).
 * item_group / monstergroup are not supported here (see APPENDING_FAMILIES).
 */
export function loadResolved(
  types: string[],
  cddaDir: string = defaultCddaDir(),
  opts: { prepare?: boolean } = {},
): Map<string, Map<string, CddaObject>> {
  const wanted = types.flatMap(familyTypes);
  for (const t of wanted) if (APPENDING_FAMILIES.has(familyOf(t))) throw new Error(`loadResolved: ${t} has no copy-from in BN; use its dedicated merge`);
  const raw = loadCddaObjects(cddaDir, { types: wanted });
  const families = new Map<string, CddaObject[]>();
  for (const [type, list] of raw) {
    const f = familyOf(type);
    families.set(f, [...(families.get(f) ?? []), ...list]);
  }
  const out = new Map<string, Map<string, CddaObject>>();
  for (const [fam, list] of families) {
    const withIds = list.filter((o) => objectIds(o).length > 0);
    const r = resolveFamily(withIds, FAMILY_HOOKS[fam] ?? {}, opts.prepare === false ? undefined : prepareObject);
    for (const [id, o] of r.byId) {
      let m = out.get(o.type);
      if (!m) out.set(o.type, (m = new Map()));
      m.set(id, o);
    }
  }
  return out;
}

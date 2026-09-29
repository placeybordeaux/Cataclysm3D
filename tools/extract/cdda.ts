// Reusable CDDA JSON loading + inheritance resolution.
//
// Shared with the mapgen extractor (tools/extract/mapgen.ts), so keep this free of
// output-format concerns: it reads raw JSON, groups it by type, and resolves copy-from
// the way CDDA's generic_factory / per-type loaders do (doc/JSON/JSON_INHERITANCE.md).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareObject } from './prepare';

export type CddaObject = Record<string, any>;

/** Where each raw object came from; attached as a non-enumerable property so JSON output ignores it. */
export const SOURCE = Symbol('cddaSource');

export function defaultCddaDir(): string {
  return process.env.CDDA_DIR ?? path.join(os.homedir(), 'code/Cataclysm-DDA');
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
  if (!fs.existsSync(jsonDir)) throw new Error(`CDDA data dir not found: ${jsonDir} (set CDDA_DIR)`);
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

// Pre-"subtypes" CDDA used one `type` per item slot; all of them are the ITEM namespace.
// Current data only uses "ITEM", but mods/older checkouts may still use the legacy names.
export const LEGACY_ITEM_TYPES = [
  'ITEM', 'GENERIC', 'TOOL', 'TOOL_ARMOR', 'ARMOR', 'PET_ARMOR', 'GUN', 'GUNMOD', 'AMMO', 'MAGAZINE',
  'COMESTIBLE', 'BOOK', 'BIONIC_ITEM', 'TOOLMOD', 'ENGINE', 'WHEEL', 'BATTERY',
];

export function familyOf(type: string): string {
  if (LEGACY_ITEM_TYPES.includes(type)) return 'ITEM';
  // recipe_dictionary loads these three into the same map (recipe_dictionary.cpp).
  if (type === 'recipe' || type === 'practice' || type === 'nested_category') return 'recipe';
  return type;
}

/**
 * Ids an object defines. `id` may be an array (one definition per id). Recipes are keyed
 * by result/variant/id_suffix (recipe::load in recipe.cpp). Objects without any id
 * (speech, dream, snippet with only category...) return [].
 */
export function objectIds(obj: CddaObject): string[] {
  const fam = familyOf(obj.type);
  if (typeof obj.abstract === 'string') return [obj.abstract];
  if (fam === 'recipe' || obj.type === 'uncraft') {
    if (obj.type === 'practice' || obj.type === 'nested_category') return [obj.id];
    let id: string = obj.result ?? obj.id;
    if (id === undefined) return [];
    if (obj.type === 'recipe') {
      if (obj.variant) id += '_' + obj.variant;
      if (obj.id_suffix) id += '_' + obj.id_suffix;
    }
    return [id];
  }
  if (Array.isArray(obj.id)) return obj.id;
  if (typeof obj.id === 'string') return [obj.id];
  // types keyed by something other than "id"
  switch (obj.type) {
    case 'MONSTER_FACTION':
      return typeof obj.name === 'string' ? [obj.name] : [];
    case 'profession_item_substitutions':
      return [obj.item ?? obj.trait ?? obj.group].filter((x) => typeof x === 'string');
    case 'ter_furn_migration':
      return [obj.from_ter ?? obj.from_furn].filter((x) => typeof x === 'string');
    case 'rotatable_symbol':
      return Array.isArray(obj.tuple) ? [obj.tuple.join('')] : [];
    case 'hit_range':
      return ['default'];
  }
  return [];
}

// ---------------------------------------------------------------------------------------
// Inheritance

const INHERIT_KEYS = new Set(['copy-from', 'extend', 'delete', 'relative', 'proportional', 'abstract', 'id']);

export interface InheritHooks {
  /** Keys that are never inherited from the parent (reset to default on each load in C++). */
  notInherited?: string[];
  /** Keys whose object values merge field-by-field with the parent's instead of replacing. */
  mergeObjects?: string[];
  /** Keys the child *must* not take from its own JSON when it has copy-from (item_group). */
  ignoreOwnWhenCopying?: string[];
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

// Our units are coarser than CDDA's internal ones for these (g vs mg, cm vs mm), so
// truncation after scaling happens at the internal resolution.
const MASS_KEYS = new Set(['weight', 'integral_weight', 'mass', 'max_contains_weight', 'trigger_weight']);
const LENGTH_KEYS = new Set(['longest_side', 'integral_longest_side', 'barrel_length']);

/**
 * Apply one `relative` / `proportional` entry for top-level member `key`.
 * C++ does `int_member *= float_factor` (generic_factory.h): the product is computed in
 * 32-bit float and truncated toward zero, so e.g. 100 * 0.7f is 70 (the float product
 * rounds to 70.0f) where a double product of the float factor would truncate to 69.
 */
export function applyModifier(base: unknown, mod: unknown, kind: 'relative' | 'proportional', key = ''): unknown {
  const f32 = (b: number) => Math.fround(b);
  const op: NumOp = kind === 'relative' ? (a, b) => a + b : (a, b) => a * f32(b);
  let quant: Quantize = floatQ;
  if (kind === 'proportional') {
    if (MASS_KEYS.has(key)) quant = (r) => Math.trunc(Math.fround(r * 1000)) / 1000;
    else if (LENGTH_KEYS.has(key)) quant = (r) => Math.trunc(Math.fround(r * 10)) / 10;
    else quant = (r, b) => (Number.isInteger(b) ? Math.trunc(Math.fround(r)) : floatQ(r));
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
      // flag-like string sets are deduplicated (auto_flags_reader is a set)
      if (typeof a === 'string' && out.includes(a)) continue;
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
  for (const kind of ['relative', 'proportional'] as const) {
    const mods = child[kind];
    if (!isObj(mods)) continue;
    for (const [k, m] of Object.entries(mods)) {
      // an explicit value in the child wins over a modifier of the parent's (optional() reads one or the other)
      if (k in child) continue;
      out[k] = applyModifier(out[k], m, kind, k);
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
  interface Def { id: string; raw: CddaObject; index: number; resolved?: CddaObject; resolving?: boolean; abstract: boolean }
  const defs: Def[] = [];
  const byIdDefs = new Map<string, Def[]>();
  for (const raw0 of objs) {
    const raw = prepare(raw0);
    for (const id of objectIds(raw0)) {
      const d: Def = { id, raw, index: defs.length, abstract: typeof raw0.abstract === 'string' };
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
      if (!pdef) {
        const src = sourceOf(d.raw) ?? '';
        throw new Error(`${d.raw.type} ${d.id} (${src}): copy-from unknown id "${pid}"`);
      }
      const parent = resolve(pdef, [...chain, d.id]);
      result = mergeInherited(parent, d.raw, hooks);
      hooks.post?.(result, pid, parent, d.raw, pdef.abstract);
    } else {
      result = mergeInherited(undefined, d.raw, hooks);
    }
    if (Array.isArray(result.id)) result.id = d.id;
    d.resolving = false;
    d.resolved = result;
    return result;
  };
  const byId = new Map<string, CddaObject>();
  const abstracts = new Map<string, CddaObject>();
  const duplicates: string[] = [];
  for (const [id, list] of byIdDefs) {
    for (const d of list) resolve(d, []);
    const last = list.at(-1)!;
    if (list.length > 1 && !list.slice(1).every((x) => x.raw['copy-from'] === id)) duplicates.push(id);
    if (last.abstract) abstracts.set(id, last.resolved!);
    else byId.set(id, last.resolved!);
  }
  return { byId, abstracts, duplicates };
}

// ---------------------------------------------------------------------------------------
// Per-family quirks of the C++ loaders that the generic merge doesn't capture.

// looks_like: CDDA defaults it to the copy-from id. We skip abstract parents (they never
// have sprites), so the renderer's looks_like fallback chain only walks real ids.
export const FAMILY_HOOKS: Record<string, InheritHooks> = {
  ITEM: {
    post(r, pid, parent, child, parentAbstract) {
      // item_factory: looks_like = copy-from (if it names a real item), then the JSON's own
      r.looks_like = child.looks_like ?? (parentAbstract ? parent.looks_like : pid);
      if (r.looks_like === undefined) delete r.looks_like;
    },
  },
  terrain: {
    // mapdata.cpp: these are reset on every load, and bash/deconstruct merge field-wise
    notInherited: ['open', 'close', 'transforms_into', 'prying', 'hacksaw', 'oxytorch', 'boltcut'],
    mergeObjects: ['bash', 'deconstruct'],
    post(r, pid, parent, child, parentAbstract) {
      r.looks_like = child.looks_like ?? (parentAbstract ? parent.looks_like : pid);
      if (r.looks_like === undefined) delete r.looks_like;
    },
  },
  furniture: {
    notInherited: ['prying', 'hacksaw', 'oxytorch', 'boltcut'],
    mergeObjects: ['bash', 'deconstruct'],
    post(r, pid, parent, child, parentAbstract) {
      r.looks_like = child.looks_like ?? (parentAbstract ? parent.looks_like : pid);
      if (r.looks_like === undefined) delete r.looks_like;
    },
  },
  MONSTER: {
    post(r, pid, parent, child, parentAbstract) {
      r.looks_like = child.looks_like ?? parent.looks_like ?? (parentAbstract ? undefined : pid);
      if (r.looks_like === undefined) delete r.looks_like;
    },
  },
  // recipe.cpp: "inline requirements are always replaced (cannot be inherited)"
  recipe: { notInherited: ['tools', 'qualities', 'components'] },
  uncraft: { notInherited: ['tools', 'qualities', 'components'] },
  // item_factory: a copy-from group only takes its additions from "extend"
  item_group: { ignoreOwnWhenCopying: ['entries', 'items', 'groups'] },
  // veh_type.cpp vehicle_prototype::load: "parts" always *append* to the inherited list
  // (e.g. "car" = car_abstract's body + its own engine and tank).
  vehicle: {
    post(r, _pid, parent, child) {
      if (Array.isArray(child.parts) && Array.isArray(parent.parts)) r.parts = [...structuredClone(parent.parts), ...structuredClone(child.parts)];
    },
  },
};

/**
 * One-stop helper for other extractors: load the given CDDA types and resolve copy-from
 * per family with the standard hooks. With `prepare` (default true) objects also get
 * comments stripped, quantity strings converted to base units and translations
 * flattened (see prepare.ts). Returns type -> id -> resolved object (abstracts excluded).
 */
export function loadResolved(
  types: string[],
  cddaDir: string = defaultCddaDir(),
  opts: { prepare?: boolean } = {},
): Map<string, Map<string, CddaObject>> {
  const raw = loadCddaObjects(cddaDir, { types });
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

import { Rng, hashSeed, hashString } from '../../core/rng';

// CDDA "mapgen values" and mapgen parameters (doc/JSON/MAPGEN.md "Mapgen parameters").
// A value is a plain id string, {"param": name, "fallback"}, {"distribution": [...]} or
// {"switch": <value>, "cases": {...}}. Parameters are rolled lazily the first time they
// are read, from an RNG derived from (world seed, scope key, name) so the result does not
// depend on which chunk happened to be generated first.

export type Scope = 'overmap_special' | 'omt_stack' | 'omt' | 'nest';

export interface ParamDef {
  type?: string;
  scope: Scope;
  default: unknown;
}

/** Inclusive integer range (CDDA jmapgen_int). */
export interface IntR {
  a: number;
  b: number;
}

export function intR(v: unknown, def: number): IntR {
  if (v === undefined || v === null) return { a: def, b: def };
  if (typeof v === 'number') return { a: v, b: v };
  if (Array.isArray(v)) {
    const a = Number(v[0]);
    const b = v.length > 1 ? Number(v[1]) : a;
    return { a: Math.min(a, b), b: Math.max(a, b) };
  }
  return { a: def, b: def };
}
export const rollR = (r: IntR, rng: Rng): number => (r.a === r.b ? r.a : rng.int(r.a, r.b));

/** Weighted list in CDDA's forms: "id", ["id", w], {"distribution"...} objects etc. */
export function weightedPick<T>(rng: Rng, list: readonly (readonly [T, number])[]): T | undefined {
  let total = 0;
  for (const [, w] of list) total += w > 0 ? w : 0;
  if (total <= 0) return undefined;
  let r = rng.next() * total;
  for (const [v, w] of list) {
    if (w <= 0) continue;
    if ((r -= w) < 0) return v;
  }
  return list[list.length - 1][0];
}

/** Parse a CDDA weighted list: entries are "id" (weight 1 or `defW`) or ["id", weight]. */
export function parseWeighted(list: unknown, defW = 1): [unknown, number][] {
  if (!Array.isArray(list)) return [[list, defW]];
  return list.map((e) => (Array.isArray(e) && e.length === 2 && typeof e[1] === 'number' ? [e[0], e[1]] : [e, defW]));
}

export interface ArgStores {
  seed: number;
  /** key identifying the overmap special instance (or the OMT stack if none) */
  specialKey: number;
  special: Map<string, string>;
  stackKey: number;
  stack: Map<string, string>;
  omtKey: number;
  omt: Map<string, string>;
}

/**
 * Parameter lookup chain. Nested mapgen gets a child context with its own definitions and a
 * fresh "nest" store; lookups fall back to the parent's definitions (a nested chunk may use
 * a parameter that only its host's palette defines).
 */
export class ParamCtx {
  readonly nest = new Map<string, string>();
  constructor(
    readonly stores: ArgStores,
    readonly defs: Map<string, ParamDef>,
    readonly rng: Rng,
    readonly parent?: ParamCtx,
  ) {}

  private findDef(name: string): [ParamDef, ParamCtx] | undefined {
    for (let c: ParamCtx | undefined = this; c; c = c.parent) {
      const d = c.defs.get(name);
      if (d) return [d, c];
    }
    return undefined;
  }

  get(name: string): string | undefined {
    for (let c: ParamCtx | undefined = this; c; c = c.parent) {
      const v = c.nest.get(name);
      if (v !== undefined) return v;
    }
    const s = this.stores;
    const v = s.omt.get(name) ?? s.stack.get(name) ?? s.special.get(name);
    if (v !== undefined) return v;
    const found = this.findDef(name);
    if (!found) return undefined;
    const [def, owner] = found;
    let store: Map<string, string>, rng: Rng;
    const h = hashString(name);
    switch (def.scope) {
      case 'nest':
        store = owner.nest;
        rng = owner.rng;
        break;
      case 'omt':
        store = s.omt;
        rng = new Rng(hashSeed(s.seed, s.omtKey, h, 3));
        break;
      case 'omt_stack':
        store = s.stack;
        rng = new Rng(hashSeed(s.seed, s.stackKey, h, 2));
        break;
      default:
        store = s.special;
        rng = new Rng(hashSeed(s.seed, s.specialKey, h, 1));
    }
    const val = evalValue(def.default, this, rng);
    if (val === undefined) return undefined;
    store.set(name, val);
    return val;
  }

  /** All values a parameter could take (CDDA all_possible_results), for palette choices. */
  possible(v: unknown): string[] {
    if (typeof v === 'string') return [v];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, any>;
      if ('param' in o) {
        const f = this.findDef(o.param);
        return f ? this.possible(f[0].default) : o.fallback !== undefined ? [o.fallback] : [];
      }
      if ('distribution' in o) return parseWeighted(o.distribution).map(([e]) => String(e));
      if ('switch' in o) return Object.values(o.cases ?? {}).map(String);
    }
    if (Array.isArray(v)) return parseWeighted(v).flatMap(([e]) => this.possible(e));
    return [];
  }
}

/** Evaluate a mapgen value to an id string (undefined = null / no result). */
export function evalValue(v: unknown, ctx: ParamCtx, rng: Rng): string | undefined {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const picked = weightedPick(rng, parseWeighted(v));
    return evalValue(picked, ctx, rng);
  }
  if (typeof v === 'object') {
    const o = v as Record<string, any>;
    if ('param' in o) return ctx.get(o.param) ?? o.fallback;
    if ('distribution' in o) return evalValue(weightedPick(rng, parseWeighted(o.distribution)), ctx, rng);
    if ('switch' in o) {
      const on = evalValue(o.switch, ctx, rng);
      if (on === undefined) return undefined;
      const c = o.cases?.[on];
      return c === undefined ? undefined : String(c);
    }
  }
  return undefined;
}

// BN trait groups (trait_group.cpp, mutation_data.cpp load_trait_group): npc_class "traits"
// lists are a collection of {trait}/{group} entries; misc.trait_group holds named groups
// ("distribution" picks one entry by prob, "collection" rolls each entry against its prob,
// "old" is a collection of ["TRAIT", prob] pairs). NPCs get their background story
// (BG_survival_story_* -> BGSS_* traits, which unlock the "tell me about yourself" topics),
// starting traits and appearance this way.

import type { Rng } from '../core/rng';
import type { GameData } from '../data/types';
import { warnOnce } from '../data/warn';

type Creator =
  | { kind: 'trait'; id: string; prob: number }
  | { kind: 'group'; id: string; prob: number }
  | { kind: 'collection' | 'distribution'; prob: number; entries: Creator[] };

/** mutation_branch::add_entry: one {trait|group|collection|distribution, prob} object. */
function entry(o: Record<string, unknown>): Creator | null {
  const prob = typeof o.prob === 'number' ? o.prob : 100;
  if (Array.isArray(o.collection)) return { kind: 'collection', prob, entries: o.collection.map((x) => entry(x as Record<string, unknown>)).filter((x): x is Creator => !!x) };
  if (Array.isArray(o.distribution)) return { kind: 'distribution', prob, entries: o.distribution.map((x) => entry(x as Record<string, unknown>)).filter((x): x is Creator => !!x) };
  if (typeof o.trait === 'string') return { kind: 'trait', id: o.trait, prob };
  if (typeof o.group === 'string') return { kind: 'group', id: o.group, prob };
  throw new Error(`trait group entry without trait/group: ${JSON.stringify(o)}`);
}

/** load_trait_group(JsonObject): a named group's creators. */
function groupCreator(def: Record<string, any>): Creator {
  const subtype = def.subtype ?? 'old';
  if (!['old', 'collection', 'distribution'].includes(subtype)) throw new Error(`trait group ${def.id}: unknown subtype ${subtype}`);
  const entries: Creator[] = [];
  if (subtype === 'old') {
    for (const pair of def.traits ?? []) entries.push({ kind: 'trait', id: String(pair[0]), prob: Number(pair[1]) });
  } else {
    for (const e of def.entries ?? []) entries.push(entry(e)!);
    for (const t of def.traits ?? []) {
      if (typeof t === 'string') entries.push({ kind: 'trait', id: t, prob: 100 });
      else if (Array.isArray(t)) entries.push({ kind: 'trait', id: String(t[0]), prob: Number(t[1]) });
      else entries.push(entry(t)!);
    }
    for (const g of def.groups ?? []) {
      if (typeof g === 'string') entries.push({ kind: 'group', id: g, prob: 100 });
      else if (Array.isArray(g)) entries.push({ kind: 'group', id: String(g[0]), prob: Number(g[1]) });
      else entries.push(entry(g)!);
    }
  }
  return { kind: subtype === 'distribution' ? 'distribution' : 'collection', prob: 100, entries };
}

function create(data: GameData, c: Creator, rng: Rng, rec: string[]): string[] {
  switch (c.kind) {
    case 'trait':
      return [c.id];
    case 'group': {
      if (rec.includes(c.id)) {
        warnOnce('trait_group_recursion', c.id, `[trait group] recursion in ${c.id}`);
        return [];
      }
      const def = (data.misc.trait_group as Record<string, any> | undefined)?.[c.id];
      if (!def) {
        warnOnce('trait_group', c.id);
        return [];
      }
      return create(data, groupCreator(def), rng, [...rec, c.id]);
    }
    case 'collection': {
      // Trait_group_collection::create: each entry rolls rng(0, 99) < prob (prob capped at 100).
      const out: string[] = [];
      for (const e of c.entries) {
        if (e.prob <= 0 || rng.int(0, 99) >= Math.min(100, e.prob)) continue;
        out.push(...create(data, e, rng, rec));
      }
      return out;
    }
    case 'distribution': {
      // Trait_group_distribution::create: one entry, weighted by prob.
      const live = c.entries.filter((e) => e.prob > 0);
      const sum = live.reduce((a, e) => a + e.prob, 0);
      if (sum <= 0) return [];
      let p = rng.int(0, sum - 1);
      for (const e of live) {
        p -= e.prob;
        if (p < 0) return create(data, e, rng, rec);
      }
      return [];
    }
  }
}

/**
 * trait_group::traits_from(group, male): roll an npc_class "traits" list (a collection) and drop
 * traits flagged for the other sex (FEMALE_/MALE_EXCLUSIVE and _PREFERRED).
 */
export function traitsFromClassList(data: GameData, list: unknown[], rng: Rng, male: boolean): string[] {
  const root: Creator = { kind: 'collection', prob: 100, entries: list.map((x) => entry(x as Record<string, unknown>)).filter((x): x is Creator => !!x) };
  const muts = (data.misc.mutation ?? {}) as Record<string, { flags?: string[] }>;
  return create(data, root, rng, []).filter((id) => {
    const f = muts[id]?.flags ?? [];
    return male ? !f.includes('FEMALE_EXCLUSIVE') && !f.includes('FEMALE_PREFERRED') : !f.includes('MALE_EXCLUSIVE') && !f.includes('MALE_PREFERRED');
  });
}

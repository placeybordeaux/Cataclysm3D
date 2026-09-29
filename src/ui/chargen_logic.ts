import type { MutationDef } from '../data/types';

// Character creation rules (CDDA newcharacter.cpp, "multiple pools" mode) as pure
// functions so the point budget is unit-testable. Defaults are CDDA's external_options:
// INITIAL_STAT_POINTS 6, INITIAL_TRAIT_POINTS 0, INITIAL_SKILL_POINTS 2, MAX_TRAIT_POINTS 12.

export const STAT_MIN = 4; // character.h CHARACTER_STAT_MIN
export const STAT_MAX = 20; // newcharacter.cpp: stats can't be raised past 20 at creation
export const HIGH_STAT = 12; // player_difficulty.h: each point above 12 costs double
export const BASE_STAT = 8;
export const INITIAL_STAT_POINTS = 6;
export const INITIAL_TRAIT_POINTS = 0;
export const INITIAL_SKILL_POINTS = 2;
export const MAX_TRAIT_POINTS = 12;

export type StatId = 'str' | 'dex' | 'int' | 'per';
export type Stats = Record<StatId, number>;

export interface ScenarioDef {
  id: string;
  name: string | { str: string; str_f?: string };
  description?: string;
  points?: number;
  professions?: string[];
  add_professions?: boolean;
  forced_traits?: string[];
  forbidden_traits?: string[];
  traits?: string[];
  requirement?: string | string[];
  start_name?: string;
  flags?: string[];
}

export interface ProfessionDef {
  id: string;
  name: string | { male?: string; female?: string; str?: string };
  description?: string | { male?: string; female?: string; str?: string };
  points?: number;
  subtype?: string;
  skills?: { level: number; name: string }[];
  traits?: string[];
  items?: { both?: unknown; male?: unknown; female?: unknown };
  requirement?: string | string[];
  flags?: string[];
}

export function statPointsUsed(s: Stats): number {
  let used = 0;
  for (const v of [s.str, s.dex, s.int, s.per]) used += v + Math.max(0, v - HIGH_STAT);
  return used;
}

/** Traits granted by the scenario/profession are free (CDDA is_locked_trait). */
export function traitPointsUsed(traits: Iterable<string>, locked: Set<string>, defs: Record<string, MutationDef>): number {
  let used = 0;
  for (const t of traits) if (!locked.has(t)) used += defs[t]?.points ?? 0;
  return used;
}

export function skillPointsUsed(scenarioPoints: number, professionPoints: number): number {
  return scenarioPoints + professionPoints;
}

export interface Pools {
  pureStat: number;
  pureTrait: number;
  pureSkill: number;
  /** Points left in each pool after borrowing (CDDA multi_pool). */
  statLeft: number;
  traitLeft: number;
  skillLeft: number;
}

/**
 * CDDA multi_pool: lower pools may borrow from higher ones (skills from traits from stats),
 * so "points left" in a pool is its own balance plus whatever the pools above can spare.
 */
export function multiPool(statsUsed: number, traitsUsed: number, skillsUsed: number): Pools {
  const pureStat = 4 * BASE_STAT + INITIAL_STAT_POINTS - statsUsed;
  const pureTrait = INITIAL_TRAIT_POINTS - traitsUsed;
  const pureSkill = INITIAL_SKILL_POINTS - skillsUsed;
  return {
    pureStat, pureTrait, pureSkill,
    statLeft: pureStat + Math.min(0, pureTrait + Math.min(0, pureSkill)),
    traitLeft: pureStat + pureTrait + Math.min(0, pureSkill),
    skillLeft: pureStat + pureTrait + pureSkill,
  };
}

/** Cost in pool points of raising a stat from v to v+1. */
export function statStepCost(v: number): number {
  return v >= HIGH_STAT ? 2 : 1;
}

export interface TraitCheck {
  ok: boolean;
  reason?: string;
}

/** Two traits conflict if either cancels the other or they share a mutually exclusive type. */
export function traitsConflict(a: MutationDef, b: MutationDef): boolean {
  if (a.id === b.id) return false;
  const ca = (a.cancels as string[] | undefined) ?? [], cb = (b.cancels as string[] | undefined) ?? [];
  if (ca.includes(b.id) || cb.includes(a.id)) return true;
  const ta = (a.types as string[] | undefined) ?? [], tb = (b.types as string[] | undefined) ?? [];
  return ta.some((t) => tb.includes(t));
}

/**
 * Can `id` be toggled on? Mirrors set_traits: conflicts, the MAX_TRAIT_POINTS cap on
 * positive and on negative traits separately, and positive traits needing points.
 */
export function canAddTrait(
  id: string,
  current: Set<string>,
  locked: Set<string>,
  defs: Record<string, MutationDef>,
  pools: Pools,
  forbidden: Set<string> = new Set(),
): TraitCheck {
  const def = defs[id];
  if (!def) return { ok: false, reason: `Unknown trait ${id}.` };
  if (forbidden.has(id)) return { ok: false, reason: 'Your scenario forbids this trait.' };
  for (const t of current) {
    const o = defs[t];
    if (o && traitsConflict(def, o)) return { ok: false, reason: `You already picked a conflicting trait: ${nameOf(o)}.` };
  }
  const pts = def.points ?? 0;
  let good = 0, bad = 0;
  for (const t of current) {
    if (locked.has(t)) continue;
    const p = defs[t]?.points ?? 0;
    if (p > 0) good += p;
    else bad -= p;
  }
  if (pts > 0 && good + pts > MAX_TRAIT_POINTS) return { ok: false, reason: `Sorry, but you can only take ${MAX_TRAIT_POINTS} points of advantages.` };
  if (pts < 0 && bad - pts > MAX_TRAIT_POINTS) return { ok: false, reason: `Sorry, but you can only take ${MAX_TRAIT_POINTS} points of disadvantages.` };
  if (pts > 0 && pts > pools.traitLeft) return { ok: false, reason: 'Not enough points left.' };
  return { ok: true };
}

/** Whether the build can be finalized (CDDA refuses to start with a negative pool). */
export function finishCheck(pools: Pools): TraitCheck {
  if (pools.statLeft < 0 || pools.traitLeft < 0 || pools.skillLeft < 0) return { ok: false, reason: 'Too many points allocated, change some features and try again.' };
  return { ok: true };
}

function nameOf(d: MutationDef): string {
  const n = d.name;
  return typeof n === 'string' ? n : n?.str ?? d.id;
}

/** Startable traits for the trait tab, split CDDA-style into positive / negative / neutral. */
export function startingTraits(defs: Record<string, MutationDef>): { good: MutationDef[]; bad: MutationDef[]; neutral: MutationDef[] } {
  // Vanity traits (hair, skin tone) belong to the description tab in CDDA.
  const list = Object.values(defs).filter((d) => d.starting_trait && !d.vanity);
  const byName = (a: MutationDef, b: MutationDef) => nameOf(a).localeCompare(nameOf(b));
  return {
    good: list.filter((d) => (d.points ?? 0) > 0).sort(byName),
    bad: list.filter((d) => (d.points ?? 0) < 0).sort(byName),
    neutral: list.filter((d) => (d.points ?? 0) === 0).sort(byName),
  };
}

/** scenario::permitted_professions (simplified). Hobbies are excluded; SCEN_ONLY need listing. */
export function permittedProfessions(scen: ScenarioDef, profs: Record<string, ProfessionDef>): ProfessionDef[] {
  const all = Object.values(profs).filter((p) => p.subtype !== 'hobby');
  const listed = (scen.professions ?? []).filter((id) => profs[id]);
  let out: ProfessionDef[];
  if (listed.length && !scen.add_professions) out = listed.map((id) => profs[id]);
  else {
    out = all.filter((p) => !p.flags?.includes('SCEN_ONLY') || listed.includes(p.id));
    // CDDA lists the scenario's own professions first, then the default one, then the rest.
    const first = [...listed, 'unemployed'].filter((id) => profs[id]);
    out = [...first.map((id) => profs[id]), ...out.filter((p) => !first.includes(p.id)).sort((a, b) => (a.points ?? 0) - (b.points ?? 0) || profName(a, true).localeCompare(profName(b, true)))];
  }
  return out;
}

export function profName(p: ProfessionDef, male: boolean): string {
  const n = p.name;
  if (typeof n === 'string') return n;
  return (male ? n.male : n.female) ?? n.str ?? n.male ?? p.id;
}

export function scenName(s: ScenarioDef, male: boolean): string {
  const n = s.name;
  if (typeof n === 'string') return n;
  return (!male && n.str_f) || n.str;
}

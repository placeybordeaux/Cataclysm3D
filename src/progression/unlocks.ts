// Unlock catalogue (public/data/unlocks.json, hand-authored) and its evaluation. UI-free.
//
// An unlock is earned by meeting its requirement: BN achievements (completed by any
// character, src/game/achievements.ts globalAchievements) and/or lifetime statistics from
// the progression profile (profile.ts). What it grants is a *choice* — a start (profession +
// default scenario), a scenario, the custom creator or a cosmetic title — never a bonus: no
// run is stronger because of an earlier one (docs/DESIGN_V2.md decision 6). Classic mode
// treats everything as unlocked without recording it, so turning it off restores the ladder.
//
//   {"id": "prof_cop", "kind": "profession", "name": "Police Officer",
//    "requirement": [{"stat": "zombie_kills", "gte": 10}],
//    "grants": {"profession": "cop"}, "pitch": "…", "icon": "usp_45"}

import { STAT_IDS, type StatId } from './profile';

export type UnlockKind = 'start' | 'scenario' | 'profession' | 'creator' | 'cosmetic';

export type Req =
  | { achievement: string; hint?: string }
  | { stat: StatId; gte: number; hint?: string }
  | { any: Req[]; hint?: string };

export interface UnlockGrants {
  profession?: string;
  scenario?: string;
  /** Cosmetic title ("the Unlucky"). */
  title?: string;
  creator?: boolean;
}

export interface UnlockDef {
  id: string;
  kind: UnlockKind;
  name: string;
  /** All must hold. Empty = available from the start. */
  requirement: Req[];
  grants: UnlockGrants;
  /** One line for the start card. */
  pitch?: string;
  /** What you give up (sidegrades have a cost). */
  tradeoff?: string;
  /** Item id whose sprite is the card art. */
  icon?: string;
  /** Sort order within the ladder (lower first). */
  tier?: number;
}

export interface Catalogue {
  version: 1;
  unlocks: UnlockDef[];
}

/** What unlocks are measured against. */
export interface UnlockEnv {
  achievements: { has(id: string): boolean };
  stat(id: StatId): number;
}

export interface KnownIds {
  professions: Set<string>;
  scenarios: Set<string>;
  achievements: Set<string>;
  /** Scenarios the new-game flow can place (placement.ts). */
  placeableScenarios: Set<string>;
}

const KINDS: UnlockKind[] = ['start', 'scenario', 'profession', 'creator', 'cosmetic'];

/** Parse + cross-check the catalogue against game data. Throws listing every problem. */
export function validateCatalogue(raw: unknown, known: KnownIds): Catalogue {
  const errs: string[] = [];
  const c = raw as Catalogue;
  if (!c || c.version !== 1 || !Array.isArray(c.unlocks)) throw new Error('unlocks.json: expected {version: 1, unlocks: [...]}');
  const ids = new Set<string>();
  const checkReq = (r: Req, where: string) => {
    if ('any' in r) {
      if (!Array.isArray(r.any) || !r.any.length) errs.push(`${where}: "any" needs a non-empty list`);
      else r.any.forEach((x, i) => checkReq(x, `${where}.any[${i}]`));
    } else if ('achievement' in r) {
      if (!known.achievements.has(r.achievement)) errs.push(`${where}: unknown achievement ${r.achievement}`);
    } else if ('stat' in r) {
      if (!STAT_IDS.includes(r.stat)) errs.push(`${where}: unknown stat ${r.stat}`);
      if (typeof r.gte !== 'number' || !(r.gte > 0)) errs.push(`${where}: gte must be a positive number`);
    } else errs.push(`${where}: requirement needs achievement, stat or any`);
  };
  for (const u of c.unlocks) {
    const where = `unlock ${u?.id ?? '?'}`;
    if (!u?.id || typeof u.id !== 'string') {
      errs.push('an unlock has no id');
      continue;
    }
    if (ids.has(u.id)) errs.push(`${where}: duplicate id`);
    ids.add(u.id);
    if (!KINDS.includes(u.kind)) errs.push(`${where}: unknown kind ${u.kind}`);
    if (!u.name) errs.push(`${where}: no name`);
    if (!Array.isArray(u.requirement)) errs.push(`${where}: requirement must be a list`);
    else u.requirement.forEach((r, i) => checkReq(r, `${where}.requirement[${i}]`));
    const g = u.grants ?? {};
    if (g.profession && !known.professions.has(g.profession)) errs.push(`${where}: unknown profession ${g.profession}`);
    if (g.scenario && !known.scenarios.has(g.scenario)) errs.push(`${where}: unknown scenario ${g.scenario}`);
    if (g.scenario && !known.placeableScenarios.has(g.scenario)) errs.push(`${where}: scenario ${g.scenario} has no start placement (src/progression/placement.ts)`);
    const want: Record<UnlockKind, boolean> = {
      start: !!g.profession, profession: !!g.profession, scenario: !!g.scenario && !g.profession, creator: !!g.creator, cosmetic: !!g.title,
    };
    if (KINDS.includes(u.kind) && !want[u.kind]) errs.push(`${where}: kind ${u.kind} doesn't match its grants ${JSON.stringify(g)}`);
  }
  if (!c.unlocks.some((u) => u.kind === 'start' && !u.requirement.length)) errs.push('there must be a start with no requirement (the quick start)');
  if (errs.length) throw new Error(`unlocks.json: ${errs.join('; ')}`);
  return c;
}

export function reqMet(r: Req, env: UnlockEnv): boolean {
  if ('any' in r) return r.any.some((x) => reqMet(x, env));
  if ('achievement' in r) return env.achievements.has(r.achievement);
  return env.stat(r.stat) >= r.gte;
}

export function unlockMet(u: UnlockDef, env: UnlockEnv): boolean {
  return u.requirement.every((r) => reqMet(r, env));
}

/** Player-facing wording of a stat threshold ("Kill 10 zombies"). */
export function statGoal(stat: StatId, n: number): string {
  const s = (one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)));
  switch (stat) {
    case 'runs': return s('Start a game', 'Start # games');
    case 'deaths': return s('Die once', 'Die # times');
    case 'kills': return s('Kill a monster', 'Kill # monsters');
    case 'zombie_kills': return s('Kill a zombie', 'Kill # zombies');
    case 'best_days': return s('Survive a day in one life', 'Survive # days in one life');
    case 'items_crafted': return s('Craft an item', 'Craft # items');
    case 'hp_healed': return `Heal ${n} HP`;
    case 'corpses_butchered': return s('Butcher a corpse', 'Butcher # corpses');
    case 'foods_eaten': return s('Eat something', 'Eat or drink # times');
    case 'distance_m': return n >= 1000 ? `Walk ${+(n / 1000).toFixed(1)} km` : `Walk ${n} m`;
    case 'towns_visited': return s('Reach a town', 'Visit # towns');
    case 'books_read': return s('Read a book', 'Read # different books');
    case 'labs_reached': return s('Find an underground lab', 'Find # labs');
    case 'vehicles_driven': return s('Drive a vehicle', 'Drive # different vehicles');
  }
}

/** Display progress for a stat (distance in km, days whole). */
export function statValueText(stat: StatId, v: number): string {
  if (stat === 'distance_m') return `${+(v / 1000).toFixed(1)} km`;
  return String(Math.floor(v));
}

export interface ProgressLine {
  text: string;
  done: boolean;
  /** 0..1 for stat thresholds; undefined for yes/no requirements. */
  fraction?: number;
  /** "4/10" */
  count?: string;
}

/** One line per requirement, e.g. "Kill 10 zombies — 4/10". `achName` maps achievement ids to names. */
export function progressLines(u: UnlockDef, env: UnlockEnv, achName: (id: string) => string): ProgressLine[] {
  const line = (r: Req): ProgressLine => {
    const done = reqMet(r, env);
    if ('any' in r) {
      // "Either" requirements show the closest alternative.
      const parts = r.any.map(line);
      const best = parts.find((p) => p.done) ?? parts.reduce((a, b) => ((b.fraction ?? 0) > (a.fraction ?? 0) ? b : a));
      return { ...best, text: r.hint ?? best.text, done };
    }
    if ('achievement' in r) return { text: r.hint ?? `Achievement: ${achName(r.achievement)}`, done };
    const v = env.stat(r.stat);
    return {
      text: r.hint ?? statGoal(r.stat, r.gte),
      done,
      fraction: Math.min(1, v / r.gte),
      count: r.stat === 'distance_m' ? `${statValueText(r.stat, Math.min(v, r.gte))}/${statValueText(r.stat, r.gte)}` : `${Math.min(Math.floor(v), r.gte)}/${r.gte}`,
    };
  };
  return u.requirement.map(line);
}

/** Overall 0..1 progress (mean over requirements), for sorting "next up" hints. */
export function unlockProgress(u: UnlockDef, env: UnlockEnv, achName: (id: string) => string = (x) => x): number {
  const lines = progressLines(u, env, achName);
  if (!lines.length) return 1;
  return lines.reduce((t, l) => t + (l.done ? 1 : (l.fraction ?? 0)), 0) / lines.length;
}

/**
 * Unlocks newly earned: requirement met and not yet recorded. Classic mode doesn't record
 * anything (it only changes what's *available*), so this ignores it.
 */
export function newlyEarned(cat: Catalogue, env: UnlockEnv, recorded: (id: string) => boolean): UnlockDef[] {
  // Free starts are available, not earned: they never show up as "new".
  return cat.unlocks.filter((u) => u.requirement.length && !recorded(u.id) && unlockMet(u, env));
}

/** Whether a choice is available now: earned, free, or Classic mode. */
export function available(u: UnlockDef, recorded: (id: string) => boolean, classic: boolean): boolean {
  return classic || !u.requirement.length || recorded(u.id);
}

/** The closest unearned unlocks (for "Next: …" on the death screen / journal). */
export function nextUp(cat: Catalogue, env: UnlockEnv, recorded: (id: string) => boolean, n = 3, achName: (id: string) => string = (x) => x): { u: UnlockDef; progress: number }[] {
  return cat.unlocks
    .filter((u) => u.requirement.length && !recorded(u.id) && !unlockMet(u, env))
    .map((u) => ({ u, progress: unlockProgress(u, env, achName) }))
    .sort((a, b) => b.progress - a.progress || (a.u.tier ?? 9) - (b.u.tier ?? 9))
    .slice(0, n);
}

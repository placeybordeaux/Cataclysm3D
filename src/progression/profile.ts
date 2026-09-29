// The player's progression profile: everything that survives death (docs/DESIGN_V2.md
// decision 6). Lifetime statistics that unlocks are measured against, which unlocks are
// earned, which one-time discovery hints were already shown, and the player's progression
// options (Classic mode, hints on/off). UI-free and storage-agnostic (tests pass a Map).
//
// Stored in localStorage (`cdda3d.progression`) rather than the IndexedDB saves: death
// deletes the save, and the title screen must read unlocks synchronously. Export/import is a
// plain JSON document, validated on import (a bad file throws; it never half-applies).

import type { KVSync } from '../game/achievements';

/** Counters kept across lives. Set-backed stats are counted from `sets` (see SET_STATS). */
export const COUNTER_STATS = [
  'runs', 'deaths', 'kills', 'zombie_kills', 'best_days', 'items_crafted', 'hp_healed',
  'corpses_butchered', 'foods_eaten', 'distance_m',
] as const;
export const SET_STATS = { towns_visited: 'towns', books_read: 'books', labs_reached: 'labs', vehicles_driven: 'vehicles' } as const;
export type CounterStat = (typeof COUNTER_STATS)[number];
export type SetStat = keyof typeof SET_STATS;
export type SetId = (typeof SET_STATS)[SetStat];
export type StatId = CounterStat | SetStat;
export const STAT_IDS: readonly StatId[] = [...COUNTER_STATS, ...(Object.keys(SET_STATS) as SetStat[])];
const SET_IDS = Object.values(SET_STATS) as SetId[];

export interface UnlockRecord {
  /** Date.now() when earned. */
  at: number;
  /** The character whose life earned it ('' for imports / classic). */
  by: string;
}

export interface ProfileOptions {
  /** Veterans: every start, scenario and the custom creator are available (docs "Classic" toggle). */
  classic: boolean;
  /** Discovery nudges (toasts). The journal still records what you discover. */
  hints: boolean;
}

export interface ProfileJSON {
  v: 1;
  stats: Partial<Record<CounterStat, number>>;
  sets: Partial<Record<SetId, string[]>>;
  unlocked: Record<string, UnlockRecord>;
  /** Unlocks earned but not yet announced on the title screen. */
  unseen: string[];
  /** Discovery ids already toasted (once per profile). */
  hintsShown: string[];
  /** Discovery ids met (journal entries), whether or not the toast was shown. */
  discovered: string[];
  /** Recipes the player was told about ("You could craft…"), and ones they have crafted. */
  recipesNotified: string[];
  recipesCrafted: string[];
  options: ProfileOptions;
  /** Cosmetic title chosen for new characters ('' = none). */
  title: string;
}

export const PROFILE_KEY = 'cdda3d.progression';

export function emptyProfile(): ProfileJSON {
  return {
    v: 1, stats: {}, sets: {}, unlocked: {}, unseen: [], hintsShown: [], discovered: [], recipesNotified: [], recipesCrafted: [],
    options: { classic: false, hints: true }, title: '',
  };
}

/**
 * Validate an imported/stored document. Throws with every problem listed: a profile is the
 * player's long-term progress, so silently dropping half of a malformed file is worse than
 * refusing it.
 */
export function parseProfile(raw: unknown): ProfileJSON {
  const errs: string[] = [];
  const o = raw as Partial<ProfileJSON> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('progression profile: not a JSON object');
  if (o.v !== 1) errs.push(`unsupported version ${JSON.stringify(o.v)} (expected 1)`);
  const out = emptyProfile();
  const strList = (v: unknown, what: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      errs.push(`${what} must be a list of strings`);
      return [];
    }
    return [...new Set(v as string[])];
  };
  if (o.stats !== undefined) {
    if (typeof o.stats !== 'object' || !o.stats) errs.push('stats must be an object');
    else
      for (const [k, v] of Object.entries(o.stats)) {
        if (!(COUNTER_STATS as readonly string[]).includes(k)) errs.push(`unknown stat ${k}`);
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errs.push(`stat ${k} must be a non-negative number`);
        else out.stats[k as CounterStat] = v;
      }
  }
  if (o.sets !== undefined) {
    if (typeof o.sets !== 'object' || !o.sets) errs.push('sets must be an object');
    else
      for (const [k, v] of Object.entries(o.sets)) {
        if (!(SET_IDS as string[]).includes(k)) errs.push(`unknown set ${k}`);
        else out.sets[k as SetId] = strList(v, `sets.${k}`);
      }
  }
  if (o.unlocked !== undefined) {
    if (typeof o.unlocked !== 'object' || !o.unlocked || Array.isArray(o.unlocked)) errs.push('unlocked must be an object');
    else
      for (const [k, v] of Object.entries(o.unlocked)) {
        const r = v as Partial<UnlockRecord>;
        if (!r || typeof r.at !== 'number' || typeof r.by !== 'string') errs.push(`unlocked.${k} must be {at: number, by: string}`);
        else out.unlocked[k] = { at: r.at, by: r.by };
      }
  }
  out.unseen = strList(o.unseen, 'unseen');
  out.hintsShown = strList(o.hintsShown, 'hintsShown');
  out.discovered = strList(o.discovered, 'discovered');
  out.recipesNotified = strList(o.recipesNotified, 'recipesNotified');
  out.recipesCrafted = strList(o.recipesCrafted, 'recipesCrafted');
  if (o.options !== undefined) {
    const op = o.options as Partial<ProfileOptions>;
    if (typeof op !== 'object' || !op) errs.push('options must be an object');
    else {
      if (op.classic !== undefined && typeof op.classic !== 'boolean') errs.push('options.classic must be a boolean');
      if (op.hints !== undefined && typeof op.hints !== 'boolean') errs.push('options.hints must be a boolean');
      out.options = { classic: op.classic ?? false, hints: op.hints ?? true };
    }
  }
  if (o.title !== undefined && typeof o.title !== 'string') errs.push('title must be a string');
  else out.title = o.title ?? '';
  if (errs.length) throw new Error(`progression profile: ${errs.join('; ')}`);
  return out;
}

/** The live profile. Mutators mark it dirty; flush() writes (callers batch frequent stats). */
export class Profile {
  data: ProfileJSON = emptyProfile();
  private dirty = false;
  /** Called after any change (UI refresh, unlock re-evaluation). */
  onChange: (() => void) | null = null;

  constructor(private readonly store: KVSync | null, private readonly key = PROFILE_KEY) {
    const raw = (() => {
      try {
        return store?.getItem(key) ?? null;
      } catch {
        return null;
      }
    })();
    if (raw) {
      try {
        this.data = parseProfile(JSON.parse(raw));
      } catch (e) {
        // Keep the unreadable copy so a fix can recover it; start fresh rather than crash the title.
        console.warn('progression: stored profile unreadable, starting fresh (kept as .broken)', e);
        try {
          store?.setItem(`${key}.broken`, raw);
        } catch {
          // storage full/blocked: nothing more we can do
        }
      }
    }
  }

  stat(id: StatId): number {
    if (id in SET_STATS) return this.data.sets[SET_STATS[id as SetStat]]?.length ?? 0;
    return this.data.stats[id as CounterStat] ?? 0;
  }
  add(id: CounterStat, n = 1): void {
    if (!(n > 0)) return;
    this.data.stats[id] = (this.data.stats[id] ?? 0) + n;
    this.touch();
  }
  /** Raise a "best" stat (best_days) if v beats it. */
  max(id: CounterStat, v: number): void {
    if (!(v > (this.data.stats[id] ?? 0))) return;
    this.data.stats[id] = v;
    this.touch();
  }
  /** Add to a unique set (towns, books…); true when it was new. */
  note(set: SetId, value: string): boolean {
    const l = (this.data.sets[set] ??= []);
    if (l.includes(value)) return false;
    l.push(value);
    this.touch();
    return true;
  }
  has(list: 'hintsShown' | 'discovered' | 'recipesNotified' | 'recipesCrafted', id: string): boolean {
    return this.data[list].includes(id);
  }
  mark(list: 'hintsShown' | 'discovered' | 'recipesNotified' | 'recipesCrafted', id: string): boolean {
    if (this.data[list].includes(id)) return false;
    this.data[list].push(id);
    this.touch();
    return true;
  }
  isUnlocked(id: string): boolean {
    return !!this.data.unlocked[id];
  }
  unlock(id: string, by: string): boolean {
    if (this.data.unlocked[id]) return false;
    this.data.unlocked[id] = { at: Date.now(), by };
    if (!this.data.unseen.includes(id)) this.data.unseen.push(id);
    this.touch();
    return true;
  }
  /** Unlocks not yet announced on the title screen; clears the list. */
  takeUnseen(): string[] {
    const l = this.data.unseen;
    if (!l.length) return [];
    this.data.unseen = [];
    this.touch();
    this.flush();
    return l;
  }
  setOption<K extends keyof ProfileOptions>(k: K, v: ProfileOptions[K]): void {
    this.data.options[k] = v;
    this.touch();
    this.flush();
  }
  setTitle(t: string): void {
    this.data.title = t;
    this.touch();
    this.flush();
  }
  /** Forget which hints were shown (Options: "Reset hints"); the journal keeps its entries. */
  resetHints(): void {
    this.data.hintsShown = [];
    this.touch();
    this.flush();
  }

  private touch(): void {
    this.dirty = true;
    this.onChange?.();
  }
  get isDirty(): boolean {
    return this.dirty;
  }
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.store?.setItem(this.key, JSON.stringify(this.data));
    } catch (e) {
      console.warn('progression: could not persist profile', e);
    }
  }

  export(): string {
    return JSON.stringify(this.data, null, 1);
  }
  /** Replace the profile with an exported one. Throws (and changes nothing) if it's invalid. */
  import(json: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      throw new Error(`progression profile: not valid JSON (${(e as Error).message})`);
    }
    this.data = parseProfile(raw);
    this.touch();
    this.flush();
  }
}

let browserProfile: Profile | null = null;
/** The browser's profile (localStorage), created on first use. */
export function profile(): Profile {
  if (!browserProfile) {
    let ls: KVSync | null = null;
    try {
      ls = typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      ls = null;
    }
    browserProfile = new Profile(ls);
  }
  return browserProfile;
}

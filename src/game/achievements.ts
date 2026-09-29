import { toSeconds } from './units';

// CDDA's scores & achievements (event_statistics.cpp, achievement.cpp, stats_tracker.cpp),
// UI-free. Game code reports *events* (`character_kills_monster`, `avatar_moves`, ...) with
// CDDA's field names; `event_transformation`s derive filtered/extended event streams from
// them; `event_statistic`s reduce a stream to one value (count, total, maximum, ...); and
// `achievement`s compare statistics against targets, optionally within a time constraint.
//
// Storage follows CDDA's stats_tracker: each event type keeps a multiset of distinct event
// payloads (payload -> count, first/last sequence number), so 10 000 identical footsteps are
// one entry. Statistics are recomputed lazily from that and cached per event-type version.
//
// Achievement state machine = achievement_tracker::set_requirement: an achievement is
// re-checked whenever an event its requirements depend on arrives. It completes when every
// requirement holds and the time constraint is met (conducts never "complete", they can
// only fail); it fails when the time constraint expires or a requirement that can never
// become true again (CDDA "becomes_false", from the statistic's monotonicity) is false.
//
// Achievements that depend on event types this port never emits are "unsupported": they
// stay pending forever and the UI shows them as untracked, never silently unlocked.

export type EvValue = string | number | boolean;
export type EventData = Record<string, EvValue>;

export interface AchievementReq {
  event_statistic: string;
  is: '==' | '<=' | '>=' | 'anything';
  target?: number | [string, string] | boolean;
  visible?: 'always' | 'when_requirement_completed' | 'when_achievement_completed' | 'never';
  description?: string;
}
export interface AchievementDef {
  id: string;
  name: string;
  description?: string;
  conduct?: boolean;
  requirements: AchievementReq[];
  hidden_by?: string[];
  time_constraint?: { since: 'game_start' | 'cataclysm'; is: AchievementReq['is']; target: string };
  manually_given?: boolean;
  /** BN kill/skill requirements (achievement.cpp kill_req_completed / skill_req_completed). */
  skill_requirements?: { skill: string; is: AchievementReq['is']; level: number }[];
  kill_requirements?: ({ monster?: string; species?: string; is: AchievementReq['is']; count: number })[];
}
export interface StatisticDef {
  id: string;
  stat_type: 'count' | 'total' | 'maximum' | 'minimum' | 'first_value' | 'last_value' | 'unique_value';
  event_type?: string;
  event_transformation?: string;
  field?: string;
  description?: { one?: string; many?: string };
}
type Constraint = { equals?: unknown; equals_any?: [string, unknown[]]; equals_statistic?: string };
export interface TransformationDef {
  id: string;
  event_type?: string;
  event_transformation?: string;
  new_fields?: Record<string, Record<string, string>>;
  value_constraints?: Record<string, Constraint>;
  drop_fields?: string[];
}
export interface ScoreDef {
  id: string;
  statistic: string;
  description?: string;
}
export interface AchievementsData {
  achievements: Record<string, AchievementDef>;
  statistics: Record<string, StatisticDef>;
  transformations: Record<string, TransformationDef>;
  scores: Record<string, ScoreDef>;
}

/**
 * World lookups used by event_transformation new_fields (CDDA event_field_transformations).
 * Each returns every value the field expands to (a monster with two species makes two events).
 */
export interface WorldQueries {
  speciesOf(monsterId: string): string[];
  terrainFlags(terrainId: string): string[];
  isSwimmingTerrain(terrainId: string): boolean;
  itemFlags(itemId: string): string[];
  oterTypeOf(oterId: string): string;
  /** Overmap special id at an OMT position ("x,y,z"), '' when none. */
  specialAt(pos: string): string;
  skillLevel?(skill: string): number;
  kills?(): Record<string, number>;
}

/** Event types this port feeds (src/achievements_install.ts). Anything else is untracked. */
export const SUPPORTED_EVENTS = new Set([
  'game_start', 'crosses_mycus_threshold', 'game_avatar_new', 'game_avatar_death', 'character_kills_monster', 'character_kills_character',
  'character_takes_damage', 'character_heals_damage', 'character_wakes_up', 'avatar_moves', 'avatar_enters_omt',
  'gains_skill_level', 'gains_mutation', 'crosses_mutation_threshold', 'installs_cbm', 'installs_faulty_cbm',
  'broken_bone', 'reads_book', 'character_wields_item', 'character_wears_item', 'character_consumes_item',
  'character_eats_item', 'character_melee_attacks_monster', 'character_ranged_attacks_monster',
  'character_melee_attacks_character', 'character_ranged_attacks_character',
]);

export type Completion = 'pending' | 'completed' | 'failed';
export interface AchievementState {
  completion: Completion;
  /** Game seconds of the state change. */
  time: number;
  finalValues: EvValue[];
}

interface MultiEntry {
  data: EventData;
  count: number;
  /** sequence numbers of the first/last occurrence (for first_value/last_value) */
  first: number;
  last: number;
}

export interface TrackerJSON {
  v: 1;
  seq: number;
  start?: number;
  events: Record<string, [EventData, number, number, number][]>;
  status: Record<string, AchievementState>;
}

type Monotonic = 'constant' | 'increasing' | 'decreasing' | 'unknown';

const keyOf = (d: EventData) => JSON.stringify(Object.keys(d).sort().map((k) => [k, d[k]]));

export class AchievementTracker {
  private seq = 0;
  private events = new Map<string, Map<string, MultiEntry>>();
  private version = new Map<string, number>();
  private streamCache = new Map<string, { sig: string; entries: MultiEntry[] }>();
  private rootsCache = new Map<string, Set<string>>();
  readonly status = new Map<string, AchievementState>();
  /** achievement ids whose requirements depend on each event type */
  private watchers = new Map<string, string[]>();
  private pendingTypes = new Set<string>();
  /** Game clock (seconds), for time constraints. */
  now: () => number = () => 0;
  /** Game clock at CDDA's game_start event (set by the owner when a character starts; saved). */
  gameStart = 0;
  startSeconds: () => number = () => this.gameStart;
  /** Called when an achievement completes (not for conducts) or fails. */
  onCompleted: ((a: AchievementDef) => void) | null = null;
  onFailed: ((a: AchievementDef) => void) | null = null;

  constructor(readonly data: AchievementsData, readonly world: WorldQueries) {
    for (const a of Object.values(data.achievements)) {
      const types = new Set<string>();
      for (const r of a.requirements) for (const t of this.rootsOfStat(r.event_statistic)) types.add(t);
      if (a.skill_requirements) types.add('gains_skill_level');
      if (a.kill_requirements) types.add('character_kills_monster');
      for (const t of types) {
        let l = this.watchers.get(t);
        if (!l) this.watchers.set(t, (l = []));
        l.push(a.id);
      }
    }
  }

  // ------------------------------------------------------------------ events

  /** Report an event (CDDA cata::event). Achievements are re-checked on flush(). */
  emit(type: string, data: EventData, count = 1): void {
    let ms = this.events.get(type);
    if (!ms) this.events.set(type, (ms = new Map()));
    const k = keyOf(data);
    const seq = ++this.seq;
    const e = ms.get(k);
    if (e) {
      e.count += count;
      e.last = seq;
    } else ms.set(k, { data: { ...data }, count, first: seq, last: seq });
    this.version.set(type, (this.version.get(type) ?? 0) + 1);
    this.pendingTypes.add(type);
  }

  /** Re-check achievements watching the event types seen since the last flush. */
  flush(): void {
    if (!this.pendingTypes.size) return;
    const ids = new Set<string>();
    for (const t of this.pendingTypes) for (const id of this.watchers.get(t) ?? []) ids.add(id);
    this.pendingTypes.clear();
    for (const id of ids) this.check(this.data.achievements[id]);
  }

  // ------------------------------------------------------------------ streams & statistics

  /** Event types a statistic ultimately reads. */
  rootsOfStat(statId: string): Set<string> {
    const s = this.data.statistics[statId];
    if (!s) return new Set(['?unknown']);
    return s.event_type ? new Set([s.event_type]) : this.rootsOfTransform(s.event_transformation!);
  }
  private rootsOfTransform(id: string): Set<string> {
    const c = this.rootsCache.get(id);
    if (c) return c;
    const t = this.data.transformations[id];
    const out = new Set<string>();
    if (!t) out.add('?unknown');
    else {
      if (t.event_type) out.add(t.event_type);
      if (t.event_transformation) for (const r of this.rootsOfTransform(t.event_transformation)) out.add(r);
      // equals_statistic constraints read another statistic (usually avatar_id).
      for (const vc of Object.values(t.value_constraints ?? {})) if (vc.equals_statistic) for (const r of this.rootsOfStat(vc.equals_statistic)) out.add(r);
    }
    this.rootsCache.set(id, out);
    return out;
  }

  private sigOf(roots: Set<string>): string {
    let s = '';
    for (const r of roots) s += `${r}:${this.version.get(r) ?? 0};`;
    return s;
  }

  private rawStream(type: string): MultiEntry[] {
    return [...(this.events.get(type)?.values() ?? [])];
  }

  /** CDDA event_transformation::value over its source multiset. */
  private stream(transformId: string): MultiEntry[] {
    const roots = this.rootsOfTransform(transformId);
    const sig = this.sigOf(roots);
    const c = this.streamCache.get(transformId);
    if (c && c.sig === sig) return c.entries;
    const t = this.data.transformations[transformId];
    const src = t.event_type ? this.rawStream(t.event_type) : this.stream(t.event_transformation!);
    const out = new Map<string, MultiEntry>();
    for (const e of src) {
      for (const d of this.expand(e.data, t.new_fields ?? {})) {
        if (!this.passes(d, t.value_constraints ?? {})) continue;
        for (const f of t.drop_fields ?? []) delete d[f];
        const k = keyOf(d);
        const o = out.get(k);
        if (o) {
          o.count += e.count;
          o.first = Math.min(o.first, e.first);
          o.last = Math.max(o.last, e.last);
        } else out.set(k, { data: d, count: e.count, first: e.first, last: e.last });
      }
    }
    const entries = [...out.values()];
    this.streamCache.set(transformId, { sig, entries });
    return entries;
  }

  private expand(data: EventData, newFields: Record<string, Record<string, string>>): EventData[] {
    let acc: EventData[] = [{ ...data }];
    for (const [name, spec] of Object.entries(newFields)) {
      const [fn, srcField] = Object.entries(spec)[0];
      const next: EventData[] = [];
      for (const d of acc) for (const v of this.fieldTransform(fn, d[srcField])) next.push({ ...d, [name]: v });
      acc = next;
    }
    return acc;
  }

  /** CDDA event_field_transformations. */
  private fieldTransform(fn: string, v: EvValue | undefined): EvValue[] {
    const w = this.world;
    const s = String(v ?? '');
    switch (fn) {
      case 'species_of_monster': return w.speciesOf(s);
      case 'flags_of_terrain': return w.terrainFlags(s);
      case 'is_swimming_terrain': return [w.isSwimmingTerrain(s)];
      case 'is_mounted': return [s !== '' && s !== 'mon_null'];
      case 'math_abs': return [Math.abs(Number(v ?? 0))];
      case 'flags_of_itype': return w.itemFlags(s);
      case 'oter_type_of_oter': return [w.oterTypeOf(s)];
      case 'overmap_special_at': return [w.specialAt(s)];
      default:
        throw new Error(`achievements: unknown event field transformation ${fn}`);
    }
  }

  private passes(d: EventData, vcs: Record<string, Constraint>): boolean {
    for (const [field, c] of Object.entries(vcs)) {
      const v = d[field];
      if (c.equals_statistic !== undefined) {
        if (String(v) !== String(this.value(c.equals_statistic))) return false;
      } else if (c.equals !== undefined) {
        if (!variantEquals(v, c.equals)) return false;
      } else if (c.equals_any !== undefined) {
        if (!c.equals_any[1].some((x) => String(x) === String(v))) return false;
      }
    }
    return true;
  }

  /** Current value of an event_statistic (CDDA event_statistic::value). */
  value(statId: string): EvValue {
    const s = this.data.statistics[statId];
    if (!s) throw new Error(`achievements: unknown statistic ${statId}`);
    const entries = s.event_type ? this.rawStream(s.event_type) : this.stream(s.event_transformation!);
    const f = s.field ?? '';
    switch (s.stat_type) {
      case 'count': {
        let n = 0;
        for (const e of entries) n += e.count;
        return n;
      }
      case 'total': {
        let n = 0;
        for (const e of entries) n += Number(e.data[f] ?? 0) * e.count;
        return n;
      }
      case 'maximum':
      case 'minimum': {
        // CDDA returns the type's default (0) for an empty stream.
        if (!entries.length) return 0;
        let best = s.stat_type === 'maximum' ? -Infinity : Infinity;
        for (const e of entries) {
          const v = Number(e.data[f] ?? 0);
          best = s.stat_type === 'maximum' ? Math.max(best, v) : Math.min(best, v);
        }
        return best;
      }
      case 'first_value':
      case 'last_value': {
        let pick: MultiEntry | undefined;
        for (const e of entries) {
          if (!pick) pick = e;
          else if (s.stat_type === 'first_value' ? e.first < pick.first : e.last > pick.last) pick = e;
        }
        return pick ? pick.data[f] ?? '' : '';
      }
      case 'unique_value': {
        const vals = new Set(entries.map((e) => String(e.data[f])));
        return vals.size === 1 ? entries[0].data[f] : '';
      }
    }
  }

  monotonicity(statId: string): Monotonic {
    switch (this.data.statistics[statId]?.stat_type) {
      case 'count':
      case 'maximum':
        return 'increasing';
      case 'minimum':
        return 'decreasing';
      case 'first_value':
      case 'unique_value':
        return 'constant';
      default:
        return 'unknown';
    }
  }

  /** Whether every event type the statistic depends on is fed by this port. */
  statSupported(statId: string): boolean {
    for (const r of this.rootsOfStat(statId)) if (!SUPPORTED_EVENTS.has(r)) return false;
    return true;
  }
  achievementSupported(a: AchievementDef): boolean {
    if (a.manually_given) return true;
    return a.requirements.every((r) => this.statSupported(r.event_statistic));
  }

  // ------------------------------------------------------------------ achievements

  reqSatisfied(r: AchievementReq, v: EvValue): boolean {
    switch (r.is) {
      case '==':
        return variantEquals(v, r.target);
      case '<=':
        return Number(v) <= Number(r.target);
      case '>=':
        return Number(v) >= Number(r.target);
      case 'anything':
        return true;
    }
  }

  private becomesFalse(r: AchievementReq): boolean {
    const m = this.monotonicity(r.event_statistic);
    switch (r.is) {
      case '==': return m === 'constant';
      case '<=': return m === 'increasing' || m === 'constant';
      case '>=': return m === 'decreasing' || m === 'constant';
      case 'anything': return true;
    }
  }

  /** achievement::time_bound::completed */
  timeCompletion(a: AchievementDef): Completion {
    const tc = a.time_constraint;
    if (!tc) return 'completed';
    // "cataclysm" epoch: this port's calendar starts at the cataclysm, i.e. clock 0.
    const target = (tc.since === 'game_start' ? this.startSeconds() : 0) + toSeconds(tc.target);
    const now = this.now();
    switch (tc.is) {
      case '==': return now === target ? 'completed' : now > target ? 'failed' : 'pending';
      case '<=': return now <= target ? 'completed' : 'failed';
      case '>=': return now >= target ? 'completed' : 'pending';
      default: return 'completed';
    }
  }

  /** The avatar's kills per monster type (BN kill_tracker), from character_kills_monster events. */
  private avatarKills(): Map<string, number> {
    const avatar = this.value('avatar_id');
    const out = new Map<string, number>();
    for (const e of this.events.get('character_kills_monster')?.values() ?? []) {
      if (e.data.killer !== avatar) continue;
      const id = String(e.data.victim_type);
      out.set(id, (out.get(id) ?? 0) + e.count);
    }
    return out;
  }

  /**
   * BN kill_req_completed / skill_req_completed: a ">=" requirement not yet met is pending, a
   * "<=" one exceeded has failed for good (kills and skills don't go down).
   */
  legacyCompletion(a: AchievementDef): Completion {
    let out: Completion = 'completed';
    const judge = (is: AchievementReq['is'], target: number, v: number) => {
      if (out === 'failed' || this.reqSatisfied({ event_statistic: '', is, target }, v)) return;
      if (is === '>=') out = 'pending';
      else if (is === '<=') out = 'failed';
    };
    for (const s of a.skill_requirements ?? []) judge(s.is, s.level, this.world.skillLevel?.(s.skill) ?? 0);
    if (a.kill_requirements) {
      const kills = this.avatarKills();
      for (const k of a.kill_requirements) {
        let n = 0;
        for (const [id, c] of kills) if ((k.monster && id === k.monster) || (k.species && this.world.speciesOf(id).includes(k.species)) || (!k.monster && !k.species)) n += c;
        judge(k.is, k.count, n);
      }
    }
    return out;
  }

  /** achievement_tracker::set_requirement for every requirement at once. */
  check(a: AchievementDef): void {
    if (this.status.has(a.id) || a.manually_given || !this.achievementSupported(a)) return;
    const values = a.requirements.map((r) => this.value(r.event_statistic));
    const sat = a.requirements.map((r, i) => this.reqSatisfied(r, values[i]));
    const time = this.timeCompletion(a);
    const legacy = this.legacyCompletion(a);
    if (sat.every(Boolean) && legacy === 'completed' && time === 'completed' && !a.conduct) {
      this.report(a, 'completed', values);
      return;
    }
    if (time === 'failed' || legacy === 'failed' || a.requirements.some((r, i) => !sat[i] && this.becomesFalse(r))) this.report(a, 'failed', values);
  }

  private report(a: AchievementDef, completion: Completion, values: EvValue[]): void {
    this.status.set(a.id, { completion, time: this.now(), finalValues: values });
    if (completion === 'completed') this.onCompleted?.(a);
    else this.onFailed?.(a);
  }

  /** Debug / manually_given achievements (CDDA achievements_tracker via EOC). */
  giveManually(id: string): boolean {
    const a = this.data.achievements[id];
    if (!a || this.status.get(id)?.completion === 'completed') return false;
    this.status.delete(id);
    this.report(a, 'completed', a.requirements.map((r) => this.value(r.event_statistic)));
    return true;
  }

  /** achievements_tracker::is_completed (time expiry counts as failed). */
  completion(id: string): Completion {
    const s = this.status.get(id);
    if (s) return s.completion;
    const a = this.data.achievements[id];
    if (a && this.timeCompletion(a) === 'failed') return 'failed';
    return 'pending';
  }

  /** achievements_tracker::is_hidden */
  isHidden(a: AchievementDef): boolean {
    if (a.id === 'achievement_arcade_mode') return true;
    const end: Completion = a.conduct ? 'failed' : 'completed';
    if (this.completion(a.id) === end) return false;
    return (a.hidden_by ?? []).some((h) => this.completion(h) !== end);
  }

  /** Requirement progress lines for the UI (CDDA text_for_requirement), null = hidden. */
  requirementLines(a: AchievementDef): ({ text: string; done: boolean } | null)[] {
    const st = this.status.get(a.id);
    const comp = this.completion(a.id);
    return a.requirements.map((r, i) => {
      const v = st && st.finalValues.length === a.requirements.length ? st.finalValues[i] : this.value(r.event_statistic);
      const done = this.reqSatisfied(r, v);
      const vis = r.visible ?? 'always';
      if (vis === 'never' || (vis === 'when_requirement_completed' && !done) || (vis === 'when_achievement_completed' && comp !== 'completed')) return null;
      const stat = this.data.statistics[r.event_statistic];
      let text: string;
      if (r.is === 'anything') text = r.description ?? '';
      else if (typeof r.target === 'number' && typeof v === 'number') {
        const desc = r.description ?? (r.target === 1 ? stat?.description?.one : stat?.description?.many) ?? r.event_statistic;
        text = r.is === '<=' && r.target === 0 ? desc : `${v}/${r.target} ${desc}`;
      } else text = r.description ?? `${r.event_statistic} ${r.is} ${JSON.stringify(r.target)}`;
      return { text, done };
    });
  }

  // ------------------------------------------------------------------ persistence

  toJSON(): TrackerJSON {
    const events: TrackerJSON['events'] = {};
    for (const [t, ms] of this.events) events[t] = [...ms.values()].map((e) => [e.data, e.count, e.first, e.last]);
    return { v: 1, seq: this.seq, start: this.gameStart, events, status: Object.fromEntries(this.status) };
  }

  load(j: TrackerJSON, warn?: (msg: string) => void): void {
    this.reset();
    this.seq = j.seq;
    this.gameStart = j.start ?? 0;
    for (const [t, list] of Object.entries(j.events ?? {})) {
      const ms = new Map<string, MultiEntry>();
      for (const [data, count, first, last] of list) ms.set(keyOf(data), { data, count, first, last });
      this.events.set(t, ms);
      this.version.set(t, 1);
    }
    for (const [id, s] of Object.entries(j.status ?? {})) {
      if (!this.data.achievements[id]) {
        warn?.(`unknown achievement ${id} dropped`);
        continue;
      }
      this.status.set(id, s);
    }
  }

  reset(): void {
    this.seq = 0;
    this.events.clear();
    for (const t of this.version.keys()) this.version.set(t, (this.version.get(t) ?? 0) + 1);
    this.streamCache.clear();
    this.status.clear();
    this.pendingTypes.clear();
  }
}

/** cata_variant equality: targets are [type, "string value"], ints or bools. */
export function variantEquals(v: EvValue | undefined, target: unknown): boolean {
  const t = Array.isArray(target) ? target[1] : target;
  if (typeof t === 'boolean') return v === t;
  return String(v ?? '') === String(t);
}

/**
 * Names of the achievements a game's character completed, for the memorial entry (the save
 * manager must not import the browser-side install module). Keyed by Game.
 */
export const runAchievementNames = new WeakMap<object, () => string[]>();

// ------------------------------------------------------------------ global (cross-character) store

export interface PastAchievement {
  /** Character names that completed it, oldest first (CDDA past_achievements_info). */
  avatars: string[];
  /** Date.now() of the first completion. */
  first: number;
}

export interface KVSync {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/**
 * Achievements completed by any character, kept across deaths like CDDA's per-user
 * achievements folder. Stored in localStorage (the memorial lives in IndexedDB; this must
 * be readable synchronously by character creation's locked scenarios).
 */
export class GlobalAchievements {
  static readonly KEY = 'cdda3d.achievements';
  private data: Record<string, PastAchievement> = {};
  constructor(private readonly store: KVSync | null) {
    try {
      const raw = store?.getItem(GlobalAchievements.KEY);
      if (raw) this.data = JSON.parse(raw).completed ?? {};
    } catch (e) {
      console.warn('achievements: stored global achievements unreadable, starting fresh', e);
    }
  }
  has(id: string): boolean {
    return !!this.data[id];
  }
  get(id: string): PastAchievement | undefined {
    return this.data[id];
  }
  ids(): string[] {
    return Object.keys(this.data);
  }
  add(id: string, avatar: string): void {
    const e = (this.data[id] ??= { avatars: [], first: Date.now() });
    if (!e.avatars.includes(avatar)) e.avatars.push(avatar);
    try {
      this.store?.setItem(GlobalAchievements.KEY, JSON.stringify({ v: 1, completed: this.data }));
    } catch (e) {
      console.warn('achievements: could not persist', e);
    }
  }
}

let globalStore: GlobalAchievements | null = null;
/** The browser's global store (localStorage), created on first use. */
export function globalAchievements(): GlobalAchievements {
  if (!globalStore) {
    let ls: KVSync | null = null;
    try {
      ls = typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      ls = null;
    }
    globalStore = new GlobalAchievements(ls);
  }
  return globalStore;
}

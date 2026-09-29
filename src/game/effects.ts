import type { EffectTypeDef, GameData } from '../data/types';
import type { Rng } from '../core/rng';
import type { BodyPartId } from './bodyparts';
import { cddaText, toSeconds } from './units';

// Data-driven status effects (CDDA effect.cpp + doc/JSON/EFFECTS_JSON.md). An effect_type
// defines intensity/duration rules and "base_mods"/"scaling_mods"; an Effect is one
// instance on a creature (optionally on a body part). Per-turn consequences (pain, hurt,
// painkiller, stamina...) are rolled by Character using the helpers here; hardcoded CDDA
// behaviour (bleeding, bites turning into infections, sleep) lives in character.ts.

/** Mod keys: "pain_min" -> type PAIN, action min. "str_mod" -> STR, action mod. */
export type ModAction = 'mod' | 'amount' | 'min' | 'max' | 'min_val' | 'max_val' | 'chance' | 'chance_bot' | 'tick';

const MOD_KEY = /^(.*?)_(min_val|max_val|chance_bot|amount|chance|tick|min|max|mod)$/;

/** CDDA default max_duration is effectively unlimited (365 days). */
const DEFAULT_MAX_DURATION = 365 * 86400;

export class EffectType {
  readonly id: string;
  readonly maxIntensity: number;
  readonly maxEffectiveIntensity: number;
  readonly maxDuration: number;
  readonly intDurFactor: number;
  readonly intAddVal: number;
  readonly intDecayStep: number;
  readonly intDecayTick: number;
  readonly intDecayRemove: boolean;
  /** type -> action -> [base[normal, reduced], scaling[normal, reduced]] */
  private mods = new Map<string, Map<ModAction, { base: number[]; scaling: number[] }>>();
  /** Keys that aren't X_action shaped (healing_rate, healing_head...). */
  readonly extra: Record<string, { base: number[]; scaling: number[] }> = {};

  constructor(readonly def: EffectTypeDef) {
    this.id = def.id;
    this.maxIntensity = def.max_intensity ?? 1;
    this.maxEffectiveIntensity = def.max_effective_intensity ?? 0;
    this.maxDuration = toSeconds(def.max_duration, DEFAULT_MAX_DURATION);
    this.intDurFactor = toSeconds(def.int_dur_factor, 0);
    this.intAddVal = def.int_add_val ?? 0;
    this.intDecayStep = def.int_decay_step ?? -1;
    this.intDecayTick = def.int_decay_tick ?? 0;
    this.intDecayRemove = def.int_decay_remove ?? true;
    const load = (src: Record<string, number[]> | undefined, slot: 'base' | 'scaling') => {
      for (const [key, raw] of Object.entries(src ?? {})) {
        if (key.startsWith('//')) continue;
        const vals = Array.isArray(raw) ? raw : [raw as unknown as number];
        const m = MOD_KEY.exec(key);
        if (!m) {
          const e = (this.extra[key] ??= { base: [], scaling: [] });
          e[slot] = vals;
          continue;
        }
        const type = m[1].toUpperCase();
        const action = m[2] as ModAction;
        let byAction = this.mods.get(type);
        if (!byAction) this.mods.set(type, (byAction = new Map()));
        const e = byAction.get(action) ?? { base: [], scaling: [] };
        e[slot] = vals;
        byAction.set(action, e);
      }
    };
    load(def.base_mods, 'base');
    load(def.scaling_mods, 'scaling');
  }

  /** effect_type::get_mod_value: base + scaling * (intensity - 1); [1] is the resisted value. */
  modValue(type: string, action: ModAction, reduced: boolean, intensity: number): number {
    const e = this.mods.get(type)?.get(action);
    if (!e) return 0;
    const pick = (a: number[]) => (a.length === 0 ? 0 : reduced && a.length > 1 ? a[1] : a[0]);
    return pick(e.base) + pick(e.scaling) * (intensity - 1);
  }
  extraValue(key: string, reduced: boolean, intensity: number): number {
    const e = this.extra[key];
    if (!e) return 0;
    const pick = (a: number[]) => (a.length === 0 ? 0 : reduced && a.length > 1 ? a[1] : a[0]);
    return pick(e.base) + pick(e.scaling) * (intensity - 1);
  }
  hasModType(type: string): boolean {
    return this.mods.has(type);
  }
  modTypes(): string[] {
    return [...this.mods.keys()];
  }
  /** Name for an intensity; '' means hidden from the player (EFFECTS_JSON "name"). */
  name(intensity: number): string {
    const names = this.def.name ?? [];
    if (names.length === 0) return '';
    if (this.maxIntensity > 1 && names.length >= this.maxIntensity) return cddaText(names[Math.min(intensity, names.length) - 1]);
    const base = cddaText(names[0]);
    return base && intensity > 1 ? `${base} [${intensity}]` : base;
  }
  desc(intensity: number): string {
    const d = this.def.desc ?? [];
    if (d.length === 0) return '';
    return cddaText(d[Math.min(Math.max(intensity, 1), d.length) - 1]);
  }
  hasFlag(f: string): boolean {
    return this.def.flags?.includes(f) ?? false;
  }
}

export class Effect {
  duration = 0;
  intensity = 1;
  permanent = false;
  /** Game-second when applied; used for CDDA "tick" alignment. */
  startTurn = 0;
  constructor(readonly type: EffectType, readonly bp: BodyPartId | null) {}
  get id(): string {
    return this.type.id;
  }
  effectiveIntensity(): number {
    const m = this.type.maxEffectiveIntensity;
    return m > 0 ? Math.min(m, this.intensity) : this.intensity;
  }
  setIntensity(v: number): void {
    v = Math.max(0, Math.min(this.type.maxIntensity, Math.round(v)));
    if (v === 0 && !this.type.intDecayRemove) v = 1;
    this.intensity = v;
  }
  /** effect::set_duration: clamp to max_duration, then derive intensity via int_dur_factor. */
  setDuration(d: number): void {
    this.duration = Math.min(Math.max(0, d), this.type.maxDuration);
    if (this.type.intDurFactor > 0) this.setIntensity(Math.max(1, Math.ceil(this.duration / this.type.intDurFactor)));
  }
  modDuration(d: number): void {
    this.setDuration(this.duration + d);
  }
  name(): string {
    return this.type.name(this.intensity);
  }
  toJSON(): EffectJSON {
    return { id: this.id, bp: this.bp, duration: this.duration, intensity: this.intensity, permanent: this.permanent || undefined };
  }
}

export interface EffectJSON {
  id: string;
  bp: BodyPartId | null;
  duration: number;
  intensity: number;
  permanent?: boolean;
}

// Fallback effect_type definitions (copied from CDDA data/json/effects.json) for effects the
// simulation references by id, so it works even before the extractor ships effect_type.
const BUILTIN: EffectTypeDef[] = [
  { id: 'bleed', name: [...Array(5).fill('Minor Bleeding'), ...Array(5).fill('Bleeding'), ...Array(10).fill('Bad Bleeding'), ...Array(10).fill('Heavy Bleeding'), ...Array(10).fill('Heavy Arterial Bleeding')], main_parts_only: true, apply_message: "You're bleeding!", remove_message: 'The bleeding stops!', rating: 'bad', max_intensity: 40, int_dur_factor: 60, max_duration: 2400, scaling_mods: { str_mod: [-0.1], per_mod: [-0.1] }, show_in_info: true },
  { id: 'bite', name: ['Bite', 'Painful Bite'], desc: ['You have a nasty bite wound.'], apply_message: 'The bite wound feels really deep…', resist_traits: ['INFRESIST'], main_parts_only: true, rating: 'bad', int_dur_factor: '30 m', max_intensity: 2, scaling_mods: { dex_mod: [-1, 0], pain_chance_bot: [200], pain_chance: [2, 1], pain_min: [1], pain_max_val: [10, 5] } },
  { id: 'infected', name: ['Infected', 'Badly Infected', 'Pus Filled'], desc: ['You have an infected wound.'], apply_message: 'Your wound feels infected.', resist_traits: ['INFRESIST'], main_parts_only: true, rating: 'bad', int_dur_factor: '8 h', max_intensity: 3, base_mods: { str_mod: [-2], dex_mod: [-3], int_mod: [-2], thirst_min: [2], thirst_chance: [10, 100], thirst_tick: [30], speed_mod: [-10, 0], stamina_min: [-8, -4], stamina_max: [-50, -20], stamina_chance: [3, 10], sleepiness_min: [2, 0], sleepiness_max: [10, 5], sleepiness_chance: [110], sleepiness_max_val: [700, 250], healing_rate: [0.01, 1] }, scaling_mods: { str_mod: [-1, -0.5], dex_mod: [-1, -0.5], int_mod: [-3, -1], speed_mod: [-10, -5], stamina_min: [-6, -4], stamina_max: [15, 4], stamina_chance: [-1, -2.5], sleepiness_chance: [-50], sleepiness_tick: [0.5] } },
  { id: 'hypovolemia', name: ['Mild Hypovolemic Shock', 'Moderate Hypovolemic Shock', 'Advanced Hypovolemic Shock', 'Severe Hypovolemic Shock'], apply_message: 'You have lost a lot of blood, and your condition worsens.', remove_message: 'You are no longer in shock.', max_intensity: 4, scaling_mods: { str_mod: [-1], per_mod: [-1], dex_mod: [-1], int_mod: [-1], speed_mod: [-10] }, rating: 'bad' },
  { id: 'bandaged', name: ['Bandaged'], desc: ['The wounds on your %s are bandaged.'], main_parts_only: true, rating: 'good', int_dur_factor: '6 h', max_intensity: 16, max_effective_intensity: 8, max_duration: '4 d', base_mods: { healing_rate: [2], healing_head: [50], healing_torso: [150] }, scaling_mods: { healing_rate: [2] } },
  { id: 'disinfected', name: ['Disinfected'], desc: ['The wounds on your %s are disinfected.'], main_parts_only: true, rating: 'good', int_dur_factor: '6 h', max_intensity: 16, max_effective_intensity: 8, max_duration: '4 d', base_mods: { healing_rate: [2], healing_head: [50], healing_torso: [150] }, scaling_mods: { healing_rate: [2] } },
  { id: 'downed', name: ['Downed'], desc: ["You're knocked to the ground.  You have to get up before you can move."], apply_message: "You're knocked to the floor!", rating: 'bad', show_in_info: true },
  { id: 'stunned', name: ['Stunned'], desc: ['Your movement is randomized.'], apply_message: "You're stunned!", rating: 'bad', show_in_info: true },
  { id: 'dazed', name: ['Dazed'], apply_message: 'The scream dazes you!', rating: 'bad', max_intensity: 10, max_duration: '10 m', int_add_val: 2, scaling_mods: { speed_mod: [-3] } },
  { id: 'winded', name: ['Winded'], desc: ["You're short of breath.  Running and fighting will be difficult until you recover."], apply_message: 'Your breath gives out!', remove_message: 'You catch your breath.', rating: 'bad', max_duration: '30 s', base_mods: { per_mod: [-1], speed_mod: [-10], pain_min: [1], pain_chance: [5], pain_max_val: [20] } },
  { id: 'grabbed', name: ['Grabbed'], rating: 'bad', max_intensity: 100, base_mods: { dodge_mod: [-10] }, flags: ['GRAB'] },
  { id: 'poison', name: ['Poisoned'], desc: ['You have been poisoned!'], miss_messages: [['You feel bad inside.', 1]], rating: 'bad', resist_traits: ['POISRESIST'], main_parts_only: true, max_intensity: 10, base_mods: { per_mod: [-2, -1], dex_mod: [-1, -1], str_mod: [-2, 0], pain_min: [1], pain_chance: [150, 900], hurt_min: [1], hurt_chance: [450, 2700] } },
  { id: 'drunk', name: ['Tipsy', 'Drunk', 'Trashed', 'Wasted', 'Dead Drunk'], max_intensity: 5, apply_message: 'You feel lightheaded.', int_dur_factor: '100 m', miss_messages: [['You feel woozy.', 1]], base_mods: { vomit_chance: [-43], sleep_chance: [-1003], sleep_min: [15000], sleep_max: [21000], pkill_amount: [3], pkill_max_val: [3], pkill_min: [1], pkill_tick: [45] }, scaling_mods: { per_mod: [-0.5], dex_mod: [-0.5], int_mod: [-0.75], vomit_chance: [21], sleep_chance: [501], pkill_max_val: [10], pkill_tick: [-10] } },
  { id: 'pkill1_generic', max_duration: '4 m', base_mods: { pkill_tick: [42], pkill_min: [1], pkill_max_val: [15] }, rating: 'good' },
  { id: 'pkill1_nsaid', max_duration: '4 m', base_mods: { pkill_tick: [42], pkill_min: [1], pkill_max_val: [15] }, rating: 'good' },
  { id: 'pkill1_acetaminophen', max_duration: '4 m', base_mods: { pkill_tick: [42], pkill_min: [1], pkill_max_val: [15] }, rating: 'good' },
  { id: 'pkill2', base_mods: { pkill_tick: [42], pkill_min: [2] }, rating: 'good' },
  { id: 'pkill3', base_mods: { pkill_tick: [12], pkill_min: [1] }, rating: 'good' },
  { id: 'pkill_l', base_mods: { pkill_max_val: [40], pkill_tick: [120], pkill_min: [1] }, rating: 'good' },
  { id: 'sleep', apply_message: 'You fall asleep.', remove_message: 'You wake up.', rating: 'neutral', max_intensity: 24 },
  { id: 'lying_down', apply_message: 'You lie down to go to sleep…', rating: 'neutral', max_duration: '50 m' },
  { id: 'cold', name: ['Chilly', 'Cold', 'Freezing'], desc: ['Your %s is exposed to the cold.', 'Your %s is very exposed to the cold.', 'Your %s is dangerously cold!'], max_intensity: 3, base_mods: { speed_mod: [-2] }, scaling_mods: { speed_mod: [-7], int_mod: [-0.5], dex_mod: [-0.5], hurt_min: [1], hurt_chance: [200], pkill_tick: [60], pkill_min: [1], pkill_max_val: [30], stamina_chance: [2], stamina_min: [-2] } },
  { id: 'hot', name: ['Warm', 'Hot', 'Scorching'], desc: ['Your %s feels warm.', 'Your %s is hot.', 'Your %s is burning up!'], max_intensity: 3, base_mods: { thirst_min: [1], thirst_tick: [60], thirst_chance: [6], pain_min: [1], pain_chance: [2], pain_max_val: [-1], hurt_min: [1], hurt_chance: [-300], stamina_chance: [2] }, scaling_mods: { thirst_min: [1], pain_max_val: [10], hurt_chance: [200], stamina_min: [-1] } },
  { id: 'onfire', name: ['On Fire'], apply_message: "You're on fire!  Wait in place to attempt to put out the fire.", rating: 'bad', max_intensity: 3, int_dur_factor: '5 s', max_duration: '50 s' },
  { id: 'recover', name: ['Recovering From Infection'], rating: 'mixed', max_duration: '4 d' },
  { id: 'adrenaline', name: ['Adrenaline Rush'], rating: 'good', max_intensity: 2, base_mods: { speed_mod: [20], str_mod: [5], dex_mod: [3], int_mod: [-8], per_mod: [1] } },
];

export class EffectRegistry {
  private types = new Map<string, EffectType>();
  private warned = new Set<string>();
  constructor(data?: GameData) {
    for (const d of BUILTIN) this.types.set(d.id, new EffectType(d));
    const fromData = (data?.misc?.effect_type ?? {}) as Record<string, EffectTypeDef>;
    for (const d of Object.values(fromData)) this.types.set(d.id, new EffectType(d));
  }
  has(id: string): boolean {
    return this.types.has(id);
  }
  /** Unknown ids warn once and get an inert type so gameplay continues (ARCHITECTURE.md). */
  get(id: string): EffectType {
    let t = this.types.get(id);
    if (!t) {
      if (!this.warned.has(id)) {
        this.warned.add(id);
        console.warn(`Unknown effect_type "${id}"`);
      }
      t = new EffectType({ id, name: [id] });
      this.types.set(id, t);
    }
    return t;
  }
}

/**
 * effect::activated: does X trigger this turn? `turn` is the absolute game second.
 * chance_bot == 0 => one_in(chance/mod), else x_in_y(chance*mod, chance_bot).
 */
export function effectActivated(e: Effect, type: string, val: number, reduced: boolean, turn: number, rng: Rng, mod = 1): boolean {
  const t = e.type;
  const top = t.modValue(type, 'chance', reduced, e.intensity);
  if (val === 0 && top <= 0) return false;
  let tick = Math.trunc(t.modValue(type, 'tick', reduced, e.intensity));
  if (tick === 0) tick = 1;
  else if (tick < 0) return false;
  if (turn % tick !== 0) return false;
  const bot = Math.trunc(t.modValue(type, 'chance_bot', reduced, e.intensity));
  if (!bot) return top > 0 ? rng.next() * top < mod : false;
  return rng.next() * bot < top * mod;
}

/** effect::get_mod: rng(min, max) when max != 0, else min (truncated like CDDA's int cast). */
export function effectRollMod(e: Effect, type: string, reduced: boolean, rng: Rng): number {
  const i = e.effectiveIntensity();
  const min = e.type.modValue(type, 'min', reduced, i);
  const max = e.type.modValue(type, 'max', reduced, i);
  if (Math.trunc(max) !== 0) return rng.int(Math.trunc(Math.min(min, max)), Math.trunc(Math.max(min, max)));
  return Math.trunc(min);
}

export function effectAmount(e: Effect, type: string, reduced: boolean): number {
  return Math.trunc(e.type.modValue(type, 'amount', reduced, e.effectiveIntensity()));
}

/** cata_utility bound_mod_to_vals: limit a change so val stays within [min, max] (0 = uncapped). */
export function boundModToVals(val: number, mod: number, max: number, min: number): number {
  if (val + mod > max && max !== 0) mod = Math.max(max - val, 0);
  if (val + mod < min && min !== 0) mod = Math.min(min - val, 0);
  return mod;
}

/** Container of effects keyed by (id, body part), like CDDA's effects_map. */
export class EffectSet {
  private map = new Map<string, Effect>();
  constructor(readonly registry: EffectRegistry) {}

  private key(id: string, bp: BodyPartId | null | undefined): string {
    return `${id}|${bp ?? ''}`;
  }
  get(id: string, bp?: BodyPartId | null): Effect | undefined {
    if (bp === undefined) {
      for (const e of this.map.values()) if (e.id === id) return e;
      return undefined;
    }
    return this.map.get(this.key(id, bp));
  }
  has(id: string, bp?: BodyPartId | null): boolean {
    return this.get(id, bp) !== undefined;
  }
  /** Highest intensity across body parts (0 when absent). */
  intensity(id: string, bp?: BodyPartId | null): number {
    if (bp !== undefined) return this.map.get(this.key(id, bp))?.intensity ?? 0;
    let best = 0;
    for (const e of this.map.values()) if (e.id === id && e.intensity > best) best = e.intensity;
    return best;
  }
  /**
   * Creature::add_effect semantics: new effects start at `intensity`; existing ones gain
   * duration, int_add_val, and keep the higher intensity. Returns [effect, isNew].
   */
  add(id: string, duration: number, opts: { bp?: BodyPartId | null; intensity?: number; permanent?: boolean; turn?: number } = {}): [Effect, boolean] {
    const type = this.registry.get(id);
    const bp = opts.bp ?? null;
    const k = this.key(id, bp);
    const existing = this.map.get(k);
    if (existing) {
      if (type.intAddVal) existing.setIntensity(existing.intensity + type.intAddVal);
      existing.modDuration(duration);
      if (opts.intensity !== undefined && opts.intensity > existing.intensity) existing.setIntensity(opts.intensity);
      if (opts.permanent) existing.permanent = true;
      return [existing, false];
    }
    const e = new Effect(type, bp);
    e.startTurn = opts.turn ?? 0;
    e.permanent = !!opts.permanent;
    e.setIntensity(opts.intensity ?? 1);
    e.setDuration(duration);
    if (opts.intensity !== undefined && type.intDurFactor === 0) e.setIntensity(opts.intensity);
    this.map.set(k, e);
    return [e, true];
  }
  remove(id: string, bp?: BodyPartId | null): boolean {
    let removed = false;
    for (const [k, e] of this.map) {
      if (e.id === id && (bp === undefined || e.bp === bp)) {
        this.map.delete(k);
        removed = true;
      }
    }
    return removed;
  }
  all(): Effect[] {
    return [...this.map.values()];
  }
  clear(): void {
    this.map.clear();
  }
  toJSON(): EffectJSON[] {
    return this.all().map((e) => e.toJSON());
  }
  load(list: EffectJSON[]): void {
    this.map.clear();
    for (const j of list) {
      const e = new Effect(this.registry.get(j.id), j.bp);
      e.duration = j.duration;
      e.intensity = j.intensity;
      e.permanent = !!j.permanent;
      this.map.set(this.key(j.id, j.bp), e);
    }
  }
}

import type { EnchantmentDef, GameData, MutationDef } from '../data/types';
import { Rng } from '../core/rng';
import { ACTION_SCALE, clockScale } from '../core/time';
import { ALL_PARTS, BODY_PARTS, MAIN_PARTS, isLimb, type BodyPartId, type MainPartId } from './bodyparts';
import {
  boundModToVals, Effect, effectActivated, effectAmount, EffectRegistry, EffectSet, effectRollMod, type EffectJSON,
} from './effects';
import { Inventory, type InventoryJSON } from './inventory';
import type { Loc } from './moves';
import { focusEquilibrium, Morale, type MoralePoint } from './morale';
import { cddaText } from './units';
import { buffFlat } from './martialarts';
import { NEUTRAL_SURVIVOR, type SurvivorBalance } from './balance';

// The survivor model (Cataclysm: Bright Nights Character/avatar, simplified). Everything is
// driven by update(gameDt) in game-clock seconds; BN rates are per game second ("turn"), so they
// are used directly. Stamina is the one exception: BN regenerates it per turn of *action*, and
// our action time runs at ACTION_SCALE turns per real second while the clock runs at
// clockScale() (CLOCK_SCALE × the day-length rate), so stamina uses gameDt * ACTION_SCALE /
// clockScale() turns (see update()).
//
// BN differs from the DDA 0.G model this file used to implement (see docs/BN_DATA_MODEL.md):
//   - food is a flat calorie store capped at max_stored_kcal (2500 × 7 kcal); no BMI, body fat,
//     stomach volume or guts. The stomach only holds calories waiting to be digested; water
//     (quench) goes straight to thirst. Hunger is shown as "days of food left".
//   - no blood vitamin / hypovolemia: bleeding hurts the bleeding part (eff_fun_bleed).
//   - stamina is a flat 10000 (PLAYER_MAX_STAMINA); no cardio, no "winded" when it runs out;
//     you just can't run below 10 %.
//   - traits act through mutation_branch fields (hp_modifier, speed_modifier, …, aggregated by
//     Character::mutation_value) and BN enchantments (`mut_enchantments`: add/multiply/max).
//   - body temperature: comfortable air is always 19 °C (sleeping warmth comes only from
//     bedding); torso at BODYTEMP_COLD always wakes you.

// --- constants (BN source in comments) ---
/** character.h fatigue_levels */
export const SLEEPINESS = { TIRED: 191, DEAD_TIRED: 383, EXHAUSTED: 575, MASSIVE: 1000 } as const;
/** character.h sleep_deprivation_levels, in minutes of deprivation */
export const SLEEP_DEPRIVATION = { HARMLESS: 2 * 24 * 60, MINOR: 3 * 24 * 60, SERIOUS: 4 * 24 * 60, MAJOR: 5 * 24 * 60, MASSIVE: 6 * 24 * 60 } as const;
/** character.h thirst_levels (turgid is INT_MIN: anything at or below "hydrated"). */
export const THIRST = { HYDRATED: 0, SLAKED: 60, THIRSTY: 120, VERY_THIRSTY: 240, DEHYDRATED: 480, PARCHED: 600, DEAD: 1200 } as const;
/** weather.h BODYTEMP_* in °C */
export const BODYTEMP = { FREEZING: 28, VERY_COLD: 31, COLD: 34, NORM: 37, HOT: 40, VERY_HOT: 43, SCORCHING: 46 } as const;
/** character.cpp metabolic_base_kcals: kcal burned per day at metabolic rate 1. */
export const METABOLIC_BASE_KCALS = 2500;
/** game_balance.json external options */
export const PLAYER_MAX_STAMINA = 10000;
export const PLAYER_BASE_STAMINA_REGEN_RATE = 20;
export const PLAYER_BASE_STAMINA_BURN_RATE = 15;
export const PLAYER_HEALING_RATE = 0.0002;
export const PLAYER_HUNGER_RATE = 1;
export const PLAYER_THIRST_RATE = 1;
export const PLAYER_FATIGUE_RATE = 1;
/** INT_BASED_LEARNING_BASE_VALUE / _FOCUS_ADJUSTMENT */
const INT_LEARNING_BASE = 8;
const INT_LEARNING_FOCUS = 5;
/** game_constants.h MAX_RECOIL */
export const MAX_RECOIL = 3000;
/** Game seconds between BN's 5-minute needs updates. */
const FIVE_MINUTES = 300;

/** "torso", "torso and arms", "head, torso and legs": pairs of limbs collapse to the plural. */
export function partList(parts: MainPartId[]): string {
  const names: string[] = [];
  for (const p of parts) {
    const pair = p.endsWith('_l') || p.endsWith('_r');
    const other = pair ? (p.slice(0, -1) + (p.endsWith('_l') ? 'r' : 'l')) as MainPartId : null;
    if (other && parts.includes(other)) {
      const plural = p.startsWith('arm') ? 'arms' : 'legs';
      if (!names.includes(plural)) names.push(plural);
    } else names.push(BODY_PARTS[p].name);
  }
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}


/** cata_utility logarithmic_range: 1 at min, 0 at max, logistic in between. */
export function logarithmicRange(min: number, max: number, pos: number): number {
  const CUT = 4;
  const logi = (t: number) => 1 / (1 + Math.exp(-t));
  const lo = logi(-CUT), hi = logi(CUT);
  if (pos <= min) return 1;
  if (pos >= max) return 0;
  const unit = (pos - min) / (max - min);
  return 1 - (logi(CUT * (2 * unit - 1)) - lo) / (hi - lo);
}

/**
 * weather.cpp get_local_windchill: the felt-temperature delta in °F (an int, ceil) for air
 * temperature °C, relative humidity % and wind mph. Below 70 °F BN lerps (unclamped) from the
 * North-American cold model at 30 °F to the Australian apparent-temperature model at 70 °F; the
 * cold model floors wind at 3 mph, so still air still reads a little colder than it is.
 */
export function localWindchill(tempC: number, humidity: number, windMph: number): number {
  const tempF = (tempC * 9) / 5 + 32;
  const high = (tf: number) => {
    const tc = ((tf - 32) * 5) / 9;
    const c = 0.33 * Math.min(150, (humidity / 100) * 6.105 * Math.exp((17.27 * tc) / (237.7 + tc))) - 0.7 * windMph * 0.44704 - 4;
    return (c * 9) / 5;
  };
  const low = (tf: number) => {
    const w = Math.pow(Math.max(3, windMph), 0.16);
    return 35.74 + 0.6215 * tf - 35.75 * w + 0.4275 * tf * w - tf;
  };
  if (tempF >= 70) return Math.ceil(high(tempF));
  const hi = high(70);
  const lo = Math.min(hi, low(30));
  const t = (tempF - 30) / 40;
  return Math.ceil(lo + (hi - lo) * t);
}

export type MoveMode = 'walk' | 'run' | 'crouch';

export interface SkillLevel {
  level: number;
  /** BN SkillLevel::_exercise ×100: level up at 10000 * (level+1)^2 (skill.cpp train). */
  exercise: number;
}

export interface CharacterEnvironment {
  /** Ambient air temperature at the character, °C (weather + radiant heat from nearby fires). */
  temperature: number;
  /** Wind speed, km/h (already reduced by shelter). */
  wind: number;
  /** Rain/snow falling on the character. */
  precipitation: boolean;
  /** Relative humidity, % (BN's wind chill uses it). */
  humidity?: number;
  /**
   * Sunlight warmth, °C: BN adds 1 °C (2 °C under a "high" sun_intensity weather) when you
   * stand outside in daylight (weather::is_in_sunlight), else 0.
   */
  sun?: number;
  /** floor_bedding_warmth of the spot you'd lie on, °C (furniture, or terrain − 4 °C). */
  bedding?: number;
  /** Warmth of blankets/clothes lying on your tile (Character::floor_item_warmth), °C. */
  floorItemWarmth?: number;
  /** Intensity of the best fire adjacent to you (get_heat_radiation(pos, true)), 0 = none. */
  bestFire?: number;
}

export interface HpPart {
  cur: number;
  max: number;
}

/** Character::get_hunger_description (BN: days of food left, never blank). */
export type HungerState = 'Engorged' | 'Sated' | 'Hungry' | 'Very Hungry' | 'Famished' | 'Starving';

export interface DamageResult {
  /** HP actually removed from the main part. */
  damage: number;
  pain: number;
  part: MainPartId;
  broken: boolean;
}

/** An {add, multiply, max} enchantment sum (BN enchantment values_add/multiply/max). */
export interface EnchantSum {
  add: number;
  multiply: number;
  max?: number;
}

// Common starting traits in BN's field vocabulary (data/json/mutations/mutations.json), used
// when the data files don't carry "mutation" definitions (unit-test fixtures).
const BUILTIN_TRAITS: MutationDef[] = [
  { id: 'QUICK', name: 'Quick', points: 4, speed_modifier: 1.1 },
  { id: 'FLEET', name: 'Fleet-Footed', points: 2, movecost_flatground_modifier: 0.85 },
  { id: 'STRONGBACK', name: 'Strong Back', points: 2, weight_capacity_modifier: 1.35 },
  { id: 'BADBACK', name: 'Bad Back', points: -3, weight_capacity_modifier: 0.65 },
  { id: 'GOODHEARING', name: 'Good Hearing', points: 1, hearing_modifier: 1.5 },
  { id: 'TOUGH', name: 'Tough', points: 2, hp_modifier: 0.2 },
  { id: 'FASTHEALER', name: 'Fast Healer', points: 2, healing_awake: 0.2, healing_resting: 0.5, mending_modifier: 0.5 },
  { id: 'PAINRESIST', name: 'Pain Resistant', points: 2, mut_enchantments: [{ values: [{ value: 'PAIN_GAIN', multiply: -0.33 }] }] },
  { id: 'LIGHTEATER', name: 'Light Eater', points: 1, metabolism_modifier: -0.333 },
  { id: 'GLASSJAW', name: 'Glass Jaw', points: -2, mut_enchantments: [{ values: [{ value: 'HEALTH_POINTS_HEAD', multiply: -0.2 }] }] },
  { id: 'NIGHTVISION', name: 'Night Vision', points: 2, night_vision_range: 2 },
  { id: 'INFRESIST', name: 'Infection Resistant', points: 2 },
  { id: 'POISRESIST', name: 'Poison Resistant', points: 1 },
  { id: 'WEAKSTOMACH', name: 'Weak Stomach', points: -1 },
];

// character.cpp mutation_value_map: how each mutation_branch float combines across traits.
// Default: the most negative plus the most positive value (calc_mutation_value).
const MUT_ADDITIVE = new Set(['dodge_modifier', 'mana_modifier', 'mutagen_target_modifier', 'local_detail_sight']);
const MUT_MULTIPLICATIVE = new Set([
  'mana_multiplier', 'mana_regen_multiplier', 'speed_modifier', 'movecost_modifier', 'movecost_flatground_modifier',
  'movecost_obstacle_modifier', 'packmule_modifier', 'crafting_speed_modifier', 'construction_speed_modifier',
  'attackcost_modifier', 'falling_damage_multiplier', 'max_stamina_modifier', 'weight_capacity_modifier',
  'hearing_modifier', 'movecost_swim_modifier', 'noise_modifier', 'overmap_sight', 'overmap_multiplier',
  'reading_speed_multiplier', 'skill_rust_multiplier',
]);
/** mutation_data.cpp defaults for the multiplicative members (overmap_sight really is 0 in BN). */
const MUT_DEFAULT_ONE = new Set([...MUT_MULTIPLICATIVE].filter((k) => k !== 'overmap_sight'));

export interface CharacterJSON {
  name: string;
  male: boolean;
  str_base: number; dex_base: number; int_base: number; per_base: number;
  baseSpeed: number;
  skills: Record<string, SkillLevel>;
  hp: Record<MainPartId, HpPart>;
  pain: number; painkiller: number; stamina: number;
  storedKcal: number; stomach: Character['stomach'];
  thirst: number; hunger: number; sleepiness: number; sleepDeprivation: number; stim: number;
  focus: number;
  bodyTemp: Record<MainPartId, number>; wetness: Record<MainPartId, number>;
  traits: string[];
  effects: EffectJSON[];
  morale: MoralePoint[];
  turn: number;
  dead: boolean; causeOfDeath?: string;
  inventory: InventoryJSON;
  /** Crafting knowledge (src/game/crafting.ts, reading.ts); optional for older saves. */
  learnedRecipes?: string[];
  identifiedBooks?: string[];
  proficiencies?: string[];
  /** BN Character::last_sleep_check (roll_can_sleep's 30-minute limiter). */
  lastSleepCheck?: number;
}

export class Character {
  name = 'Survivor';
  male = true;
  // Base stats are BN's *_max; bonuses are recomputed every update from effects etc.
  str_base = 8;
  dex_base = 8;
  int_base = 8;
  per_base = 8;
  baseSpeed = 100;
  str_bonus = 0;
  dex_bonus = 0;
  int_bonus = 0;
  per_bonus = 0;
  speed_bonus = 0;
  /** Creature::speed_mult (mutation speed_modifier − 1): speed = (base + bonus) × (1 + mult). */
  speed_mult = 0;
  dodge_bonus = 0;
  hit_bonus = 0;
  /** Named contributions to speed for the '@' screen. */
  speedModifiers: [string, number][] = [];

  skills: Record<string, SkillLevel> = {};
  hp = {} as Record<MainPartId, HpPart>;
  pain = 0;
  painkiller = 0;
  stamina = 0;
  /** BN stored_calories: kcal of food reserves, capped at maxStoredKcal(). */
  storedKcal = 0;
  /** BN stomach_contents: calories still being digested and when you last ate (game second). */
  stomach = { kcal: 0, lastAte: 0 };
  /** BN thirst: 0 hydrated, >120 Thirsty, >240 Very Thirsty, >480 Dehydrated, >600 Parched, 1200 death. */
  thirst = 0;
  /**
   * Legacy hunger counter kept for dialogue conditions (talk.ts reads/writes `u_hunger`); BN
   * has no hunger stat, food is storedKcal.
   */
  hunger = 0;
  /** BN fatigue. */
  sleepiness = 0;
  /** minutes */
  sleepDeprivation = 0;
  stim = 0;
  focus = 100;
  bodyTemp = {} as Record<MainPartId, number>;
  /** 0..1 per main part */
  wetness = {} as Record<MainPartId, number>;
  readonly morale = new Morale();
  readonly effects: EffectSet;
  readonly traits = new Set<string>();
  readonly inv: Inventory;
  /** Recipe ids learned from books, professions or memorized (autolearn is computed). */
  readonly learnedRecipes = new Set<string>();
  /** Book item ids read at least once (CDDA "identified"/skimmed). */
  readonly identifiedBooks = new Set<string>();
  /** CDDA proficiency ids known (crafting time/skill penalties when missing). */
  readonly proficiencies = new Set<string>();
  /** Gun recoil/aim state in MOA; MAX_RECOIL means completely unaimed. */
  recoil = MAX_RECOIL;
  running = false;
  crouching = false;
  dead = false;
  causeOfDeath?: string;
  env: CharacterEnvironment = { temperature: 20, wind: 0, precipitation: false };
  /** Absolute game second counter used for BN "once_every"/tick alignment. */
  turn = 0;
  /** Game second of the last "learning slowly: low morale" note (practice). */
  lastSlowLearningNote = -Infinity;
  /** Character::last_sleep_check: roll_can_sleep rolls at most every 30 minutes. */
  lastSleepCheck = -Infinity;
  /**
   * Comfort of the spot you're lying on (character_funcs::base_comfort_value level), set by
   * rest.ts; feeds rate_sleep_spot and the sleep-deprivation recovery bonus.
   */
  sleepComfort = 0;
  rng: Rng;
  onMessage: ((text: string, color?: string) => void) | null = null;
  onDeath: ((cause: string) => void) | null = null;
  /** Debug only (cdda.godMode): hits land but deal no damage, for screenshots and playtests. */
  debugInvulnerable = false;
  /**
   * Where things this character drops land (the tile under them). Set by the game for the player
   * and NPCs; null (tests, no map) means actions that would have to drop something refuse.
   */
  groundLoc: (() => Loc | null) | null = null;

  private acc = 0;
  private staminaAcc = 0;
  private healAcc = {} as Record<MainPartId, number>;
  private traitDefs = new Map<string, MutationDef>();
  /** enchantment_value ids from data (children like PAIN_GAIN are generated from them). */
  private enchantValueIds: Set<string>;
  readonly effectTypes: EffectRegistry;
  /**
   * Extra enchantment sources beyond traits (installed bionics: src/game/bionics.ts). Each
   * returns its summed {add, multiply, max?} for an enchantment_value id, or null when it has
   * none. Called for the value and each of its parents (PAIN_GAIN → PAIN).
   */
  readonly enchantProviders: ((value: string) => EnchantSum | null)[] = [];
  /**
   * Decides whether a trait enchantment condition holds (src/game/mutations.ts sets it: ACTIVE
   * needs the mutation powered, DAY/NIGHT/INSIDE…). Unset: always true.
   */
  enchantCondition: ((condition: unknown, traitId: string) => boolean) | null = null;
  /** Adjacent monsters holding this character (set by the monster system; BN get_dodge). */
  grabbers: (() => number) | null = null;
  /**
   * Difficulty multipliers on needs, healing, bleeding and cold (src/game/balance.ts). All 1 =
   * BN; the difficulty system sets the survivor's. Not saved here: the difficulty section of
   * the save re-applies it after load.
   */
  balance: SurvivorBalance = { ...NEUTRAL_SURVIVOR };

  constructor(readonly data: GameData, opts: { seed?: number } = {}) {
    this.rng = new Rng(opts.seed ?? 12345);
    this.effectTypes = new EffectRegistry(data);
    this.effects = new EffectSet(this.effectTypes);
    for (const t of BUILTIN_TRAITS) this.traitDefs.set(t.id, t);
    for (const t of Object.values((data.misc?.mutation ?? {}) as Record<string, MutationDef>)) this.traitDefs.set(t.id, t);
    this.enchantValueIds = new Set(Object.keys((data.misc?.enchantment_value ?? {}) as Record<string, unknown>));
    for (const p of MAIN_PARTS) {
      this.hp[p] = { cur: 1, max: 1 };
      this.bodyTemp[p] = BODYTEMP.NORM;
      this.wetness[p] = 0;
      this.healAcc[p] = 0;
    }
    this.inv = new Inventory(this);
    this.recalcHp(true);
    this.stamina = this.staminaMax();
    // character.cpp: a new character starts 100 kcal short of full.
    this.storedKcal = this.maxStoredKcal() - 100;
  }

  // ---------------------------------------------------------------- messages
  msg(text: string, color?: string): void {
    this.onMessage?.(text, color);
  }

  // ---------------------------------------------------------------- traits
  hasTrait(id: string): boolean {
    return this.traits.has(id);
  }
  addTrait(id: string): void {
    if (!this.traitDefs.has(id)) console.warn(`Unknown trait "${id}" (kept, no effect)`);
    this.traits.add(id);
    this.recalcHp();
  }
  removeTrait(id: string): void {
    this.traits.delete(id);
    this.recalcHp();
  }
  /** The trait/mutation definition (misc.mutation or the built-in fallbacks), if known. */
  traitDef(id: string): MutationDef | undefined {
    return this.traitDefs.get(id);
  }
  traitName(id: string): string {
    return cddaText(this.traitDefs.get(id)?.name) || id;
  }

  /** Character::mutation_value: a mutation_branch float member combined over all traits. */
  mutationValue(field: string): number {
    const additive = MUT_ADDITIVE.has(field), mult = MUT_MULTIPLICATIVE.has(field);
    const dflt = MUT_DEFAULT_ONE.has(field) ? 1 : 0;
    let sum = 0, prod = 1, lowest = 0, highest = 0;
    for (const id of this.traits) {
      const raw = this.traitDefs.get(id)?.[field];
      const v = typeof raw === 'number' ? raw : dflt;
      sum += v;
      prod *= v;
      lowest = Math.min(lowest, v);
      highest = Math.max(highest, v);
    }
    if (additive) return sum;
    if (mult) return prod;
    return Math.min(0, lowest) + Math.max(0, highest);
  }

  /**
   * enchantment_value parents (enchantment_value.cpp define_child_enchantments): generated
   * children like PAIN_GAIN or HEALTH_POINTS_ARM_L also count their base value (PAIN,
   * HEALTH_POINTS). Values listed in the data are their own roots (PAIN_MOD isn't PAIN's child).
   */
  private enchantChain(value: string): string[] {
    const out = [value];
    if (this.enchantValueIds.has(value)) return out;
    let v = value;
    for (let i = v.lastIndexOf('_'); i > 0; i = v.lastIndexOf('_')) {
      v = v.slice(0, i);
      if (this.enchantValueIds.has(v)) {
        out.push(v);
        break;
      }
    }
    return out;
  }

  /** Every BN enchantment object a trait carries whose conditions hold. */
  private activeTraitEnchantments(): EnchantmentDef[] {
    const named = this.data.misc?.enchantment as Record<string, EnchantmentDef> | undefined;
    const out: EnchantmentDef[] = [];
    for (const id of this.traits) {
      const d = this.traitDefs.get(id);
      if (!d) continue;
      const list: (EnchantmentDef | string)[] = [...(d.enchantments ?? []), ...(d.mut_enchantments ?? [])];
      for (const raw of list) {
        const e = typeof raw === 'string' ? named?.[raw] : raw;
        if (!e) continue;
        const conds: unknown[] = [...(e.conditions ?? []), ...(e.condition !== undefined ? [e.condition] : [])];
        if (this.enchantCondition && conds.some((c) => c !== 'ALWAYS' && !this.enchantCondition!(c, id))) continue;
        out.push(e);
      }
    }
    return out;
  }

  /** Summed enchantment values for an enchantment_value id (traits + providers, with parents). */
  enchant(value: string): Required<EnchantSum> {
    let add = 0, multiply = 0, max = 0;
    const chain = this.enchantChain(value);
    for (const e of this.activeTraitEnchantments()) {
      for (const v of e.values ?? []) {
        if (!chain.includes(v.value)) continue;
        add += v.add ?? 0;
        multiply += v.multiply ?? 0;
        max = Math.max(max, v.max ?? 0);
      }
    }
    for (const p of this.enchantProviders) {
      for (const id of chain) {
        const r = p(id);
        if (!r) continue;
        add += r.add;
        multiply += r.multiply;
        max = Math.max(max, r.max ?? 0);
      }
    }
    return { add, multiply, max };
  }
  /** Character::bonus_from_enchantments / enchantment::calc_bonus: add + base × multiply (+ max). */
  enchantBonus(value: string, base: number, round = false): number {
    const e = this.enchant(value);
    const r = e.add + base * e.multiply + e.max;
    return round ? Math.trunc(r) : r;
  }
  /** base + calc_bonus: the value after enchantments. */
  byEnchant(base: number, value: string): number {
    return base + this.enchantBonus(value, base);
  }

  // ---------------------------------------------------------------- stats
  /** Character::get_str_base: str_max + STRENGTH_PERMANENT enchantments. */
  strBase(): number {
    return Math.max(0, this.str_base + this.enchantBonus('STRENGTH_PERMANENT', this.str_base, true));
  }
  dexBase(): number {
    return Math.max(0, this.dex_base + this.enchantBonus('DEXTERITY_PERMANENT', this.dex_base, true));
  }
  intBase(): number {
    return Math.max(0, this.int_base + this.enchantBonus('INTELLIGENCE_PERMANENT', this.int_base, true));
  }
  perBase(): number {
    return Math.max(0, this.per_base + this.enchantBonus('PERCEPTION_PERMANENT', this.per_base, true));
  }
  get str(): number {
    return Math.max(0, this.strBase() + this.str_bonus);
  }
  get dex(): number {
    return Math.max(0, this.dexBase() + this.dex_bonus);
  }
  get int(): number {
    return Math.max(0, this.intBase() + this.int_bonus);
  }
  get per(): number {
    return Math.max(0, this.perBase() + this.per_bonus);
  }
  /** Creature::get_speed: round((base + bonus) × (1 + mult)), at least a quarter of base. Setting it changes the base. */
  get speed(): number {
    return Math.max(Math.round(this.baseSpeed * 0.25), Math.round((this.baseSpeed + this.speed_bonus) * (1 + this.speed_mult)));
  }
  set speed(v: number) {
    this.baseSpeed = v;
  }
  get moveMode(): MoveMode {
    return this.running ? 'run' : this.crouching ? 'crouch' : 'walk';
  }

  getSkill(id: string): number {
    return this.skills[id]?.level ?? 0;
  }
  setSkill(id: string, level: number): void {
    this.skills[id] = { level, exercise: 0 };
  }

  /**
   * Character::practice + adjust_for_focus + SkillLevel::train: amount × effective focus / 100
   * (focus + 5 per Int over 8, FAST/SLOWLEARNER ±15) of exercise; level up at 100 × (level+1)²
   * (we store exercise ×100). Each practice that trains drains focus by focus/100 (+1 with the
   * remainder as a percent chance). Returns true on level-up.
   */
  practice(id: string, amount: number, cap = 10): boolean {
    if (amount <= 0 || this.isAsleep()) return false;
    const sk = (this.skills[id] ??= { level: 0, exercise: 0 });
    if (sk.level >= 10) return false;
    amount = Math.round(this.byEnchant(amount, `SKILL_EXP_${id.toUpperCase()}`));
    let focus = this.focus + this.enchantBonus('EFFECTIVE_FOCUS', this.focus);
    if (this.hasTrait('FASTLEARNER')) focus += 15;
    if (this.hasTrait('SLOWLEARNER')) focus -= 15;
    focus += (this.int - INT_LEARNING_BASE) * INT_LEARNING_FOCUS;
    // Low morale pulls focus (and so learning) down, invisibly in BN. Say so, at most once an
    // hour of game time (docs/ADAPTATION.md: "why is my skill not going up?").
    const mood = this.morale.level();
    if (mood <= -10 && focus < 90 && this.turn - this.lastSlowLearningNote >= 3600) {
      this.lastSlowLearningNote = this.turn;
      this.msg(`You're learning slowly: your low morale (${mood}) makes it hard to focus. Something tasty, warmth, rest or a good book helps.`, 'c_yellow');
    }
    amount = this.rollRemainder((amount * focus) / 100);
    if (amount <= 0 || sk.level > cap) return false;
    sk.exercise += amount * 100;
    let leveled = false;
    if (sk.exercise >= 10000 * (sk.level + 1) ** 2) {
      sk.exercise = 0;
      sk.level++;
      leveled = true;
      this.msg(`Your skill in ${this.skillName(id)} has increased to ${sk.level}!`, 'c_light_green');
    }
    const drop = Math.max(0, this.focus);
    this.focus -= Math.trunc(drop / 100);
    if (this.rng.int(1, 100) <= drop % 100) this.focus--;
    this.focus = Math.max(0, this.focus);
    return leveled;
  }
  skillName(id: string): string {
    const def = this.data.misc?.skill?.[id];
    return cddaText(def?.name) || id;
  }

  // ---------------------------------------------------------------- HP & damage
  /**
   * Character::recalc_hp + calc_all_parts_hp: (base_hp 60 + 3 × Str + hp_adjustment) ×
   * (1 + hp_modifier + hp_modifier_secondary), then the HEALTH_POINTS_<PART> enchantment
   * (Glass Jaw: head −20 %). Current HP keeps its ratio.
   */
  recalcHp(fill = false): void {
    const hpMod = 1 + this.mutationValue('hp_modifier') + this.mutationValue('hp_modifier_secondary');
    const adj = this.mutationValue('hp_adjustment');
    const str = this.strBase();
    for (const p of MAIN_PARTS) {
      let max = Math.trunc((BODY_PARTS[p].base_hp + str * 3 + adj) * hpMod);
      max += this.enchantBonus(`HEALTH_POINTS_${p.toUpperCase()}`, max, true);
      max = Math.max(1, max);
      const part = this.hp[p];
      const cur = fill ? max : Math.ceil(max * (part.cur / part.max));
      this.hp[p] = { cur: Math.max(0, Math.min(cur, max)), max };
    }
  }
  hpPercent(): number {
    // Head and torso weighted 3x and 2x, like Character::hp_percentage.
    let cur = this.hp.head.cur * 3 + this.hp.torso.cur * 2, max = this.hp.head.max * 3 + this.hp.torso.max * 2;
    for (const p of MAIN_PARTS) {
      cur += this.hp[p].cur;
      max += this.hp[p].max;
    }
    return Math.floor((100 * cur) / max);
  }
  isLimbBroken(p: MainPartId): boolean {
    return isLimb(p) && this.hp[p].cur <= 0;
  }
  brokenLegs(): number {
    return (this.isLimbBroken('leg_l') ? 1 : 0) + (this.isLimbBroken('leg_r') ? 1 : 0);
  }
  brokenArms(): number {
    return (this.isLimbBroken('arm_l') ? 1 : 0) + (this.isLimbBroken('arm_r') ? 1 : 0);
  }

  /** Remove HP from a part (minor parts hit their main part), no armor. Returns HP removed. */
  applyDamage(bp: BodyPartId, amount: number): number {
    if (this.dead || amount <= 0 || this.debugInvulnerable) return 0;
    const main = BODY_PARTS[bp].main;
    const part = this.hp[main];
    const before = part.cur;
    part.cur = Math.max(0, part.cur - Math.round(amount));
    const dealt = before - part.cur;
    if (before > 0 && part.cur === 0 && isLimb(main)) {
      this.msg(`Your ${BODY_PARTS[main].name} is broken!`, 'c_red');
    }
    this.checkDeath();
    return dealt;
  }
  /**
   * Character::heal. BN lets any part heal, but natural regen and medicine on a broken limb go
   * through regen()'s mending factor, and first aid refuses parts at 0 HP (heal_actor).
   */
  heal(bp: BodyPartId, amount: number): void {
    const part = this.hp[BODY_PARTS[bp].main];
    part.cur = Math.min(part.max, part.cur + Math.max(0, Math.floor(amount)));
  }

  /**
   * Take an already armor-reduced hit: damage units {type: amount} land on `bp`, adding pain
   * via Creature::deal_damage_handle_type (bash pain = dmg/5, others dmg/4, acid dmg/3).
   */
  takeHit(bp: BodyPartId, units: { type: string; amount: number }[]): DamageResult {
    let total = 0, painf = 0;
    const mul = this.balance.damage;
    for (const u of units) {
      // balance.damage (difficulty): scaled after armor; exact BN numbers at 1.
      const amt = mul === 1 ? Math.floor(u.amount) : this.rollRemainder(Math.floor(u.amount) * mul);
      if (amt <= 0) continue;
      total += amt;
      painf += amt / (u.type === 'bash' ? 5 : u.type === 'acid' ? 3 : 4);
    }
    const main = BODY_PARTS[bp].main;
    const wasBroken = this.isLimbBroken(main);
    const pain = this.debugInvulnerable ? 0 : this.rollRemainder(painf);
    if (pain > 0) this.modPain(pain);
    const dealt = this.applyDamage(bp, total);
    return { damage: dealt, pain, part: main, broken: !wasBroken && this.isLimbBroken(main) };
  }

  checkDeath(): void {
    if (this.dead) return;
    if (this.hp.head.cur <= 0) this.die('head trauma');
    else if (this.hp.torso.cur <= 0) this.die('torso trauma');
  }
  die(cause: string): void {
    if (this.dead) return;
    this.dead = true;
    this.causeOfDeath = cause;
    this.msg('You die…', 'c_red');
    this.onDeath?.(cause);
  }

  // ---------------------------------------------------------------- pain
  /** Character::mod_pain: NOPAIN ignores gains; PAIN_GAIN / PAIN_LOSS enchantments scale. */
  modPain(n: number): void {
    if (n > 0) {
      if (this.hasTrait('NOPAIN') || this.hasEffect('narcosis')) return;
      n = Math.trunc(n + this.enchantBonus('PAIN_GAIN', n));
    } else if (n < 0) n = Math.trunc(n + this.enchantBonus('PAIN_LOSS', n));
    this.pain = Math.max(0, this.pain + n);
  }
  modPainkiller(n: number): void {
    this.painkiller = Math.max(0, this.painkiller + n);
  }
  /** Character::get_perceived_pain: none under adrenaline; PERCEIVED_PAIN_MOD enchantments. */
  perceivedPain(): number {
    if (this.effects.has('adrenaline')) return 0;
    const p = this.pain - this.painkiller;
    return Math.max(0, Math.trunc(p + this.enchantBonus('PERCEIVED_PAIN_MOD', p)));
  }
  /** character_effects::get_pain_penalty: each stat −floor(pain^0.8 / 10), speed −pain^0.7 (max 30). */
  painPenalty(): { str: number; dex: number; int: number; per: number; speed: number } {
    const pain = this.perceivedPain();
    if (pain <= 0) return { str: 0, dex: 0, int: 0, per: 0, speed: 0 };
    const stat = Math.floor(Math.pow(pain, 0.8) / 10);
    const pen = (v: string) => Math.max(0, Math.trunc(stat + this.enchantBonus(v, stat)));
    let speed = Math.trunc(Math.pow(pain, 0.7));
    speed = Math.trunc(speed + this.enchantBonus('PAIN_PENALTY_SPD', speed));
    if (this.hasTrait('CENOBITE')) return { str: 0, dex: 0, int: 0, per: 0, speed: 0 };
    return { str: pen('PAIN_PENALTY_STR'), dex: pen('PAIN_PENALTY_DEX'), int: pen('PAIN_PENALTY_INT'), per: pen('PAIN_PENALTY_PER'), speed: Math.max(0, Math.min(30, speed)) };
  }
  painDescription(): string {
    const scale = this.perceivedPain() / 10;
    if (scale > 7) return 'Severe pain';
    if (scale > 6) return 'Intense pain';
    if (scale > 5) return 'Unmanageable pain';
    if (scale > 4) return 'Distressing pain';
    if (scale > 3) return 'Distracting pain';
    if (scale > 2) return 'Moderate pain';
    if (scale > 1) return 'Mild pain';
    if (scale > 0) return 'Minimal pain';
    return 'No pain';
  }

  // ---------------------------------------------------------------- stamina
  /** Character::get_stamina_max: PLAYER_MAX_STAMINA × max_stamina_modifier + STAMINA_CAP (≥ 10 %). */
  staminaMax(): number {
    let max = Math.trunc(PLAYER_MAX_STAMINA * this.mutationValue('max_stamina_modifier'));
    max += Math.trunc(this.enchantBonus('STAMINA_CAP', max));
    return Math.max(PLAYER_MAX_STAMINA / 10, max);
  }
  /**
   * Character::mod_stamina: burning stamina trains athletics (BN's "swimming" skill), which
   * also makes it cheaper (down to 2/3 at level 10).
   */
  modStamina(n: number, skill = true): void {
    const lost = this.stamina + n >= 0 ? n : -this.stamina;
    if (skill && lost < 0) {
      this.practice('swimming', this.rollRemainder(Math.abs(lost) / 500));
      n *= Math.max(0.667, (30 - this.getSkill('swimming')) / 30);
    }
    this.stamina = Math.max(0, Math.min(this.staminaMax(), this.stamina + n));
  }
  /** Character::can_run: over 10 % stamina and two working legs. */
  canRun(): boolean {
    return this.stamina > this.staminaMax() * 0.1 && this.brokenLegs() === 0 && !this.effects.has('downed');
  }
  /**
   * Character::burn_move_stamina: `moves` spent moving. Burn = moves × (15 + overburden %) / 100,
   * ×7 running, × stamina_burn_cost_modifier ((stamina/max + 1) / 2 × run 2 / crouch 0.5).
   */
  burnMoveStamina(moves: number, mode: MoveMode = this.moveMode): void {
    const cap = Math.max(1, this.inv.weightCapacity());
    const carried = this.inv.weightCarried();
    const overburden = carried > cap ? Math.floor(((carried - cap) * 100) / cap) : 0;
    let burn = PLAYER_BASE_STAMINA_BURN_RATE + overburden;
    if (mode === 'run') burn *= 7;
    const modeMul = mode === 'run' ? 2 : mode === 'crouch' ? 0.5 : 1;
    const costMod = ((this.stamina / this.staminaMax() + 1) / 2) * modeMul;
    this.modStamina(Math.trunc(-((moves * burn) / 100) * costMod));
  }
  /** Character::update_stamina for `turns` action turns. */
  private updateStamina(turns: number): void {
    const mult = 1 + this.mutationValue('stamina_regen_modifier') + (this.mutationValue('max_stamina_modifier') - 1) + this.enchantBonus('STAMINA_REGEN', 1);
    // Mouth encumbrance interferes with breathing.
    let rate = mult * Math.max(1, PLAYER_BASE_STAMINA_REGEN_RATE - this.inv.encumbrance('mouth') / 5);
    if (this.stim > 0) rate += Math.min(5, this.stim / 15);
    else if (this.stim < 0) rate += ((this.stim / 5) * this.stamina) / this.staminaMax();
    rate = Math.max(0, rate);
    this.staminaAcc += rate * turns;
    const whole = Math.floor(this.staminaAcc);
    this.staminaAcc -= whole;
    this.stamina = Math.max(0, Math.min(this.staminaMax(), this.stamina + whole));
  }

  // ---------------------------------------------------------------- food & water
  /** Character::height (init_height 175, medium size). */
  heightCm(): number {
    return 175;
  }
  age(): number {
    return 25;
  }
  /** Character::bodyweight: BN fixes BMI at 25. */
  bodyweightKg(): number {
    return 25 * (this.heightCm() / 100) ** 2;
  }
  /** Character::max_stored_kcal: 2500 × 7 × (1 + kcal_scale). */
  maxStoredKcal(): number {
    return Math.trunc(METABOLIC_BASE_KCALS * 7 * (1 + this.mutationValue('kcal_scale')));
  }
  /** Deprecated alias of maxStoredKcal() (the DDA "healthy" fat reserve no longer exists). */
  healthyKcal(): number {
    return this.maxStoredKcal();
  }
  kcalPercent(): number {
    return this.storedKcal / this.maxStoredKcal();
  }
  /** Character::metabolic_rate_base: PLAYER_HUNGER_RATE × (1 + metabolism_modifier) + METABOLISM. */
  metabolicRate(): number {
    const withMut = PLAYER_HUNGER_RATE * (1 + this.mutationValue('metabolism_modifier'));
    return Math.max(0, withMut + this.enchantBonus('METABOLISM', withMut));
  }
  /** Character::bmr: kcal burned per day. */
  bmr(): number {
    return Math.trunc(this.metabolicRate() * METABOLIC_BASE_KCALS);
  }
  /** Character::calc_needs_rates (thirst, fatigue; hunger is metabolicRate()). */
  needsRates(): { thirst: number; fatigue: number; recovery: number } {
    let thirst = PLAYER_THIRST_RATE * (1 + this.mutationValue('thirst_modifier'));
    thirst += this.enchantBonus('THIRST', thirst);
    if (this.inv.worn.some((it) => it.hasFlag('SLOWS_THIRST'))) thirst *= 0.7;
    let fatigue = PLAYER_FATIGUE_RATE * (1 + this.mutationValue('fatigue_modifier'));
    fatigue += this.enchantBonus('FATIGUE', fatigue);
    // Legacy ×2: BN keeps DDA's bugged always-on "slept over two hours" bonus.
    const recovery = this.isAsleep() ? 2 * (1 + this.mutationValue('fatigue_regen_modifier')) - this.perceivedPain() / 60 : 0;
    return { thirst: Math.max(0, thirst), fatigue: Math.max(0, fatigue), recovery: Math.max(0, recovery) };
  }
  /** BN thirst is instant (quench goes straight to thirst); kept for callers of the DDA API. */
  instantThirst(): number {
    return this.thirst;
  }
  /** Character::get_thirst_description */
  thirstDescription(): string {
    const t = this.thirst;
    if (t > THIRST.PARCHED) return 'Parched';
    if (t > THIRST.DEHYDRATED) return 'Dehydrated';
    if (t > THIRST.VERY_THIRSTY) return 'Very Thirsty';
    if (t > THIRST.THIRSTY) return 'Thirsty';
    if (t > THIRST.SLAKED) return '';
    if (t > THIRST.HYDRATED) return 'Hydrated';
    return 'Turgid';
  }
  /**
   * Stomach fullness in ml for the DDA-era "too full" check in Inventory.consume: BN has no
   * stomach volume, so this is "full" (2500) only while bloated, else 0.
   */
  stomachContains(): number {
    return this.effects.has('bloated') ? 2500 : 0;
  }
  /** Character::get_hunger_description: days of food left (stored + stomach) against the maximum. */
  hungerState(): HungerState {
    const total = this.storedKcal + this.stomach.kcal;
    const bmr = Math.max(1, this.bmr());
    const daysLeft = total / bmr, daysMax = this.maxStoredKcal() / bmr;
    if (daysLeft >= daysMax) return 'Engorged';
    if (daysMax - daysLeft < 0.5) return 'Sated';
    if (daysMax - daysLeft < 1) return 'Hungry';
    if (daysMax / daysLeft < 2) return 'Very Hungry';
    if (daysLeft > 1) return 'Famished';
    return 'Starving';
  }
  /**
   * Character::eat → consume_effects: calories go into the stomach to be digested, quench goes
   * straight to thirst. Overfilling (stored + stomach + food over the maximum, or quench past
   * hydrated) makes you bloated for 5 minutes. `solidsMl` is ignored (BN has no stomach volume);
   * `waterMl` is quench × 5 (250 ml = quench 50).
   */
  ingest(kcal: number, _solidsMl: number, waterMl: number): void {
    const quench = Math.round(waterMl / 5);
    const excessKcal = this.storedKcal + this.stomach.kcal + kcal - this.maxStoredKcal();
    const excessQuench = quench - this.thirst;
    this.stomach.kcal += Math.max(0, kcal);
    this.stomach.lastAte = this.turn;
    if (quench) this.modThirst(-quench);
    if ((excessKcal > 0 || (excessQuench > 0 && quench > 0)) && !this.hasTrait('GOURMAND')) this.addEffect('bloated', 300);
  }
  /**
   * Why eating/drinking this would be a bad idea (Character::will_eat consequences), or null:
   * bloated → you'd vomit; over the maximum → the excess is wasted.
   */
  eatWarning(kcal: number, quench: number): string | null {
    if ((kcal > 0 || quench > 0) && this.effects.has('bloated')) return "You're full and will vomit if you try to consume anything.";
    if ((kcal > 0 && this.storedKcal + this.stomach.kcal + kcal > this.maxStoredKcal()) || (quench > 0 && this.thirst < quench))
      return "You're full already and the excess food will be wasted.";
    return null;
  }
  /** Character::mod_thirst: never below −100. */
  modThirst(n: number): void {
    if (this.hasTrait('NO_THIRST')) return;
    this.thirst = Math.max(-100, this.thirst + n);
  }
  /** Character::set_stored_kcal: capped at the maximum. */
  modStoredKcal(n: number): void {
    this.storedKcal = Math.min(this.storedKcal + n, this.maxStoredKcal());
  }
  /**
   * stomach_contents::digest for `fiveMins` 5-minute steps: at least 100 kcal per step and at
   * least half of what's there, never more than the stomach holds.
   */
  private digest(fiveMins: number): void {
    const s = this.stomach;
    const half = Math.round(s.kcal * 0.5);
    const k = Math.min(Math.max(fiveMins * 100, fiveMins * half), s.kcal);
    s.kcal -= k;
    this.modStoredKcal(k);
  }

  // ---------------------------------------------------------------- sleep
  isAsleep(): boolean {
    return this.effects.has('sleep');
  }
  /** Character::get_fatigue_description */
  sleepinessDescription(): string {
    if (this.sleepiness > SLEEPINESS.EXHAUSTED) return 'Exhausted';
    if (this.sleepiness > SLEEPINESS.DEAD_TIRED) return 'Dead Tired';
    if (this.sleepiness > SLEEPINESS.TIRED) return 'Tired';
    return '';
  }
  /** Lie down; you'll fall asleep once roll_can_sleep passes (effect lying_down). */
  tryToSleep(): void {
    if (this.isAsleep()) return;
    this.addEffect('lying_down', 50 * 60);
  }
  /**
   * character_funcs::rate_sleep_spot: comfort of the spot, how tired you are (−1 per 4 fatigue
   * under Tired, +1 per 16 over), stimulants (−2 each) and sleep traits.
   */
  rateSleepSpot(comfort = this.sleepComfort): number {
    let sleepy = comfort;
    if (this.hasTrait('INSOMNIA')) sleepy -= 12;
    if (this.hasTrait('EASYSLEEPER')) sleepy += 40;
    if (this.hasTrait('EASYSLEEPER2')) sleepy += 100;
    if (this.sleepiness < SLEEPINESS.TIRED + 1) sleepy -= Math.trunc((SLEEPINESS.TIRED + 1 - this.sleepiness) / 4);
    else sleepy += Math.trunc((this.sleepiness - SLEEPINESS.TIRED + 1) / 16);
    if (this.stim > 0 || !this.hasTrait('INSOMNIA')) sleepy -= 2 * this.stim;
    else sleepy -= this.stim;
    return sleepy;
  }
  /** character_funcs::roll_can_sleep: rate_sleep_spot + rng(−8, 8) > 0, rolled at most every 30 minutes. */
  rollCanSleep(comfort = this.sleepComfort): boolean {
    if (this.effects.has('meth')) return false;
    if (this.turn - this.lastSleepCheck < 1800 && this.turn >= this.lastSleepCheck) return false;
    this.lastSleepCheck = this.turn;
    return this.rateSleepSpot(comfort) + this.rng.int(-8, 8) > 0;
  }
  /** Character::fall_asleep (default 10 hours, BN's maximum night). */
  fallAsleep(duration = 10 * 3600): void {
    this.effects.remove('lying_down');
    const [, isNew] = this.effects.add('sleep', duration, { turn: this.turn });
    if (isNew) this.msg('You fall asleep.');
  }
  wakeUp(): void {
    if (this.effects.remove('sleep')) this.msg('You wake up.');
    this.effects.remove('lying_down');
  }

  // ---------------------------------------------------------------- effects
  /**
   * Creature::add_effect with BN semantics: blocked by another effect's blocks_effects /
   * removes_effects; prints the apply message for new visible effects.
   */
  addEffect(id: string, duration: number, opts: { bp?: BodyPartId; intensity?: number; permanent?: boolean } = {}): Effect {
    let bp = opts.bp ?? null;
    const type = this.effectTypes.get(id);
    if (bp && type.def.main_parts_only) bp = BODY_PARTS[bp].main;
    const existing = this.effects.get(id, bp);
    if (!existing) {
      for (const other of this.effects.all()) {
        const d = other.type.def;
        if ((d.blocks_effects ?? []).includes(id) || (d.removes_effects ?? []).includes(id)) {
          // Blocked: hand back an inert instance so callers can keep chaining.
          const e = new Effect(type, bp);
          return e;
        }
      }
    }
    const [e, isNew] = this.effects.add(id, duration, { ...opts, bp, turn: this.turn });
    if (isNew) {
      if (type.def.apply_message) this.msg(cddaText(type.def.apply_message), type.def.rating === 'good' ? 'c_green' : type.def.rating === 'bad' ? 'c_red' : undefined);
      this.processEffect(e, true);
    }
    return e;
  }
  /**
   * Remove an effect (all body parts when `bp` is omitted). `decayed` = it ran out of duration
   * (Creature::process_effects), which triggers `effects_on_remove` entries allowed on decay;
   * an explicit removal triggers those with allow_on_remove (effect::create_child_effects).
   */
  removeEffect(id: string, bp?: BodyPartId, decayed = false): boolean {
    const had = bp === undefined ? this.effects.all().filter((e) => e.id === id) : [this.effects.get(id, bp)].filter((e): e is Effect => !!e);
    const ok = this.effects.remove(id, bp);
    if (!ok) return false;
    const def = had[0]?.type.def;
    if (def?.remove_message) this.msg(cddaText(def.remove_message));
    type Caused = { effect_type: string; intensity_requirement?: number; allow_on_decay?: boolean; allow_on_remove?: boolean; duration?: number; inherit_duration?: boolean; intensity?: number; inherit_intensity?: boolean; body_part?: BodyPartId; inherit_body_part?: boolean };
    for (const parent of had) {
      for (const c of (parent.type.def.effects_on_remove ?? []) as Caused[]) {
        if (parent.intensity < (c.intensity_requirement ?? 0)) continue;
        if (decayed ? c.allow_on_decay === false : !c.allow_on_remove) continue;
        const dur = c.inherit_duration ? parent.duration : c.duration || this.effectTypes.get(c.effect_type).maxDuration;
        if (c.inherit_duration && dur < 1) continue;
        const b = c.inherit_body_part ? parent.bp ?? undefined : c.body_part;
        this.addEffect(c.effect_type, dur, { bp: b, intensity: c.inherit_intensity ? parent.intensity : c.intensity ?? 1 });
      }
    }
    return true;
  }
  hasEffect(id: string, bp?: BodyPartId): boolean {
    return this.effects.has(id, bp);
  }
  resistsEffect(e: Effect): boolean {
    const d = e.type.def;
    return (d.resist_traits ?? []).some((t) => this.traits.has(t)) || (d.resist_effects ?? []).some((x) => this.effects.has(x));
  }

  /** Character::process_one_effect for the data-driven mods (pain, hurt, pkill, ...). */
  private processEffect(e: Effect, isNew: boolean): void {
    const reduced = this.resistsEffect(e);
    const rng = this.rng;
    const get = (type: string) => (isNew ? effectAmount(e, type, reduced) : effectRollMod(e, type, reduced, rng));
    const fires = (type: string, val: number) => isNew || effectActivated(e, type, val, reduced, this.turn, rng);
    const maxVal = (type: string) => Math.trunc(e.type.modValue(type, 'max_val', reduced, e.intensity));
    const minVal = (type: string) => Math.trunc(e.type.modValue(type, 'min_val', reduced, e.intensity));
    const bpMain: MainPartId = e.bp ? BODY_PARTS[e.bp].main : 'torso';
    let val: number;
    if ((val = get('PAIN')) !== 0 && fires('PAIN', val)) {
      const inc = boundModToVals(this.pain, val, maxVal('PAIN'), 0);
      this.modPain(inc);
    }
    if ((val = get('HURT')) !== 0 && fires('HURT', val)) {
      this.msg(val > 5 ? `Your ${BODY_PARTS[bpMain].name} HURTS!` : `Your ${BODY_PARTS[bpMain].name} hurts!`, 'c_red');
      if (val > 0) this.applyDamage(bpMain, val);
      else this.heal(bpMain, -val);
    }
    if ((val = get('SLEEP')) !== 0 && fires('SLEEP', val) && !this.isAsleep()) {
      this.msg('You pass out!');
      this.fallAsleep(val);
    }
    if ((val = get('PKILL')) !== 0 && fires('PKILL', val)) this.modPainkiller(boundModToVals(this.painkiller, val, maxVal('PKILL'), 0));
    if ((val = get('STIM')) !== 0 && fires('STIM', val)) this.stim += boundModToVals(this.stim, val, maxVal('STIM'), minVal('STIM'));
    // BN "hunger" mods act on stored calories as legacy nutrition (mod_stored_nutr: 1 = 2500/288 kcal).
    if ((val = get('HUNGER')) !== 0 && fires('HUNGER', val)) this.modStoredKcal(-Math.round((val * METABOLIC_BASE_KCALS) / 288));
    if ((val = get('THIRST')) !== 0 && fires('THIRST', val)) this.modThirst(boundModToVals(this.thirst, val, maxVal('THIRST'), minVal('THIRST')));
    if ((val = get('SLEEPINESS')) !== 0 && !this.isAsleep() && fires('SLEEPINESS', val))
      this.sleepiness = Math.max(0, this.sleepiness + boundModToVals(this.sleepiness, val, maxVal('SLEEPINESS'), minVal('SLEEPINESS')));
    if ((val = get('FATIGUE')) !== 0 && !this.isAsleep() && fires('FATIGUE', val))
      this.sleepiness = Math.max(0, this.sleepiness + boundModToVals(this.sleepiness, val, maxVal('FATIGUE'), minVal('FATIGUE')));
    if ((val = get('STAMINA')) !== 0 && fires('STAMINA', val)) this.modStamina(boundModToVals(this.stamina, val, maxVal('STAMINA'), minVal('STAMINA')), false);
  }

  /** Hardcoded BN effects (player_hardcoded_effects.cpp), once per game second. */
  private hardcodedEffect(e: Effect): void {
    const bpName = e.bp ? BODY_PARTS[e.bp].name : 'body';
    switch (e.id) {
      case 'bleed': {
        // eff_fun_bleed: one in (36 / intensity) turns you lose some blood: 1 HP on the part and 1 pain.
        const intense = Math.max(1, e.intensity);
        // Difficulty scales the odds (balance.bleed), not the wound: intensity still reads BN's.
        const odds = Math.max(1, Math.trunc(36 / intense));
        if (this.balance.bleed === 1 ? this.rng.oneIn(odds) : this.rng.next() < this.balance.bleed / odds) {
          this.msg('You lose some blood.', 'c_red');
          this.modPain(1);
          if (e.bp) this.applyDamage(e.bp, 1);
        }
        break;
      }
      case 'bite': {
        // Bites heal with 100/648000 chance every 10 turns, else become infections after 6 h.
        if (e.duration % 10 === 0) {
          let recover = 100;
          if (this.hasTrait('INFRESIST')) recover += 200;
          if (this.rng.next() * 648000 < recover) {
            this.msg(`Your ${bpName} wound begins to feel better!`, 'c_green');
            e.setDuration(0);
            return;
          }
        }
        if (e.duration > 6 * 3600) {
          this.effects.remove('bite', e.bp);
          this.addEffect('infected', 1, { bp: e.bp ?? undefined });
        } else e.modDuration(2); // +1 to cancel the normal decay, +1 to grow
        break;
      }
      case 'infected': {
        if (e.duration % 10 === 0) {
          let recover = 100;
          if (this.hasTrait('INFRESIST')) recover += 200;
          if (this.rng.next() * 5184000 < recover) {
            this.msg(`Your ${bpName} wound begins to feel better!`, 'c_green');
            this.addEffect('recover', 4 * e.duration);
            e.setDuration(0);
            return;
          }
        }
        if (e.duration > 86400) {
          this.msg('You succumb to the infection.', 'c_red');
          this.die('infection');
        } else e.modDuration(2);
        break;
      }
      case 'bloated': {
        // eff_fun_bloated: stays while you're over the maximum or over-hydrated.
        if (this.storedKcal > this.maxStoredKcal() || this.thirst < 0) e.setDuration(300);
        break;
      }
      case 'sleep':
        this.sleepEffect(e);
        break;
      case 'lying_down': {
        // Character::hardcoded_effects lying_down: roll_can_sleep (itself limited to every 30 min).
        if (this.rollCanSleep()) this.fallAsleep();
        else if (e.duration <= 1 && !this.isAsleep()) this.msg("You try to sleep, but can't…");
        break;
      }
    }
  }

  /**
   * hardcoded_effects sleep: fatigue down to 25 ends the night ("You feel well rested."); cold
   * or heat wake you unless you're tired enough (thresholds shift by fatigue/2 legacy units =
   * fatigue × 0.001 °C). Light and hallucination wake-ups need the map and aren't modelled here.
   */
  private sleepEffect(e: Effect): void {
    if (this.sleepiness <= 25 && !this.hasEffect('narcosis')) {
      this.sleepiness = 0;
      if (this.sleepDeprivation < SLEEP_DEPRIVATION.HARMLESS) this.msg('You feel well rested.', 'c_green');
      else this.msg("You feel physically rested, but you haven't been able to catch up on your missed sleep yet.", 'c_yellow');
      e.setDuration(0);
      this.wakeUp();
      return;
    }
    if (this.hasEffect('narcosis')) return;
    const slack = this.sleepiness * 0.001;
    for (const p of MAIN_PARTS) {
      const t = this.bodyTemp[p];
      if (t < BODYTEMP.VERY_COLD - slack) {
        // one_in(temp_cur × 6 + 30000) in legacy units (500 per °C above 0 legacy ≡ 27 °C).
        const legacy = (t - BODYTEMP.FREEZING) * 500 + 500;
        if (t < BODYTEMP.FREEZING - slack || this.rng.oneIn(Math.max(1, Math.trunc(legacy * 6 + 30000)))) {
          this.msg("It's too cold to sleep.", 'c_light_red');
          this.wakeUp();
          return;
        }
      } else if (t > BODYTEMP.VERY_HOT + slack) {
        const legacy = (t - BODYTEMP.FREEZING) * 500 + 500;
        if (t > BODYTEMP.SCORCHING + slack || this.rng.oneIn(Math.max(1, Math.trunc(90000 - legacy)))) {
          this.msg("It's too hot to sleep.", 'c_light_red');
          this.wakeUp();
          return;
        }
      }
    }
    if (e.duration <= 1) this.wakeUp();
  }

  /** Per-effect stat modifiers (str_mod etc.), truncated toward zero per effect like BN. */
  private effectStatMods(): Record<'STR' | 'DEX' | 'INT' | 'PER' | 'SPEED' | 'DODGE' | 'HIT', number> {
    const out = { STR: 0, DEX: 0, INT: 0, PER: 0, SPEED: 0, DODGE: 0, HIT: 0 };
    this.speedModifiers = [];
    for (const e of this.effects.all()) {
      const reduced = this.resistsEffect(e);
      const i = e.effectiveIntensity();
      for (const k of Object.keys(out) as (keyof typeof out)[]) {
        const v = Math.trunc(e.type.modValue(k, 'mod', reduced, i));
        out[k] += v;
        if (k === 'SPEED' && v) this.speedModifiers.push([e.name() || e.id, v]);
      }
    }
    return out;
  }

  /**
   * BN process_turn "fake effects": thirsty (duration = thirst − 240) and sleep_deprived
   * (duration = deprivation minutes once past harmless) carry their stat penalties as data.
   */
  private updateFakeEffects(): void {
    const fake = (id: string, dur: number) => {
      if (!this.effectTypes.has(id)) return;
      const e = this.effects.get(id, null);
      if (dur <= 0) {
        if (e) this.removeEffect(id);
      } else if (e) e.setDuration(dur);
      else this.addEffect(id, dur);
    };
    fake('thirsty', this.thirst - THIRST.VERY_THIRSTY);
    fake('sleep_deprived', this.sleepDeprivation >= SLEEP_DEPRIVATION.HARMLESS ? this.sleepDeprivation : 0);
    // player_morale's mutation hooks: Optimist +9 / Bad Temper -9 permanent morale, which
    // also switch on the temper multipliers (Morale.temperMult).
    this.morale.setPermanent('morale_perm_optimist', this.hasTrait('OPTIMISTIC') ? 9 : 0);
    this.morale.setPermanent('morale_perm_badtemper', this.hasTrait('BADTEMPER') ? -9 : 0);
  }

  /** Recompute stat/speed bonuses (Character::reset_stats + recalc_speed_bonus). */
  resetStats(): void {
    const m = this.effectStatMods();
    const pp = this.painPenalty();
    this.str_bonus = m.STR - pp.str + Math.floor(this.mutationValue('str_modifier')) + this.enchantBonus('STRENGTH', this.strBase(), true);
    this.dex_bonus = m.DEX - pp.dex + this.enchantBonus('DEXTERITY', this.dexBase(), true);
    this.int_bonus = m.INT - pp.int + this.enchantBonus('INTELLIGENCE', this.intBase(), true);
    this.per_bonus = m.PER - pp.per + this.enchantBonus('PERCEPTION', this.perBase(), true);
    this.dodge_bonus = m.DODGE + Math.floor(this.mutationValue('dodge_modifier'));
    this.hit_bonus = m.HIT;
    // Starvation (process_turn): multi_lerp gives a fraction of a point that BN floors, so the
    // penalty is 0 in practice; kept so the rule is visible and follows BN if it's fixed there.
    if (this.kcalPercent() < 0.95) {
      const pen = Math.floor(multiLerp([[0, 0.5], [0.8, 0.1], [0.95, 0]], this.kcalPercent()));
      this.str_bonus -= pen;
      this.dex_bonus -= Math.trunc(pen / 2);
      this.int_bonus -= Math.trunc(pen / 2);
    }
    // recalc_speed_bonus
    let speed = m.SPEED - pp.speed + Math.trunc(buffFlat(this, 'speed'));
    if (pp.speed) this.speedModifiers.push(['Pain', -pp.speed]);
    const cap = Math.max(1, this.inv.weightCapacity());
    const carried = this.inv.weightCarried();
    if (carried > cap) {
      const pen = Math.trunc((25 * (carried - cap)) / cap);
      speed -= pen;
      this.speedModifiers.push(['Weight Carried', -pen]);
    }
    if (this.thirst > THIRST.VERY_THIRSTY) {
      const pen = thirstSpeedPenalty(this.thirst);
      speed += pen;
      this.speedModifiers.push(['Thirst', pen]);
    }
    const kp = kcalSpeedPenalty(this.kcalPercent());
    if (kp) {
      speed += kp;
      this.speedModifiers.push(['Starving', kp]);
    }
    // Cold-blooded mutations slow down below 65 °F (temperature_speed_modifier, BODYTEMP_SPEED).
    let tsm = this.mutationValue('temperature_speed_modifier');
    tsm += this.enchantBonus('BODYTEMP_SPEED', tsm);
    if (tsm !== 0) {
      const f = (this.env.temperature * 9) / 5 + 32;
      if (this.hasTrait('COLDBLOOD4') || f < 65) {
        const pen = Math.trunc((f - 65) * tsm);
        speed += pen;
        this.speedModifiers.push(['Cold-Blooded', pen]);
      }
    }
    this.speed_mult = this.mutationValue('speed_modifier') - 1;
    if (this.speed_mult) this.speedModifiers.push(['Bio/Mut/Etc Effects', Math.round((this.baseSpeed + speed) * this.speed_mult)]);
    const ench = Math.trunc(this.enchantBonus('SPEED', Math.round((this.baseSpeed + speed) * (1 + this.speed_mult))));
    if (ench) this.speedModifiers.push(['Bio/Mut/Etc Effects', ench]);
    this.speed_bonus = speed + ench;
  }
  /** Deprecated: BN kcal speed penalty; see kcalSpeedPenalty(). */
  kcalSpeedPenalty(): number {
    return kcalSpeedPenalty(this.kcalPercent());
  }

  // ---------------------------------------------------------------- dodge / hit helpers
  /** BN Character::get_dodge_base: dex/4 + dodge skill. */
  dodgeBase(): number {
    return this.dex / 4 + this.getSkill('dodge');
  }
  /**
   * BN Character::get_dodge before the per-turn dodge penalty (combat.ts characterDodge adds
   * that): base + effect/martial-arts bonuses − leg encumbrance/20 − torso encumbrance/10
   * (reset_stats), scaled down linearly below half stamina, a quarter off per grabber.
   */
  dodge(): number {
    if (this.effects.has('downed') || this.isAsleep() || this.effects.has('stunned') || this.stamina <= 0) return 0;
    let ret = this.dodgeBase() + this.dodge_bonus + buffFlat(this, 'dodge');
    ret -= (this.inv.encumbrance('leg_l') + this.inv.encumbrance('leg_r')) / 20 + this.inv.encumbrance('torso') / 10;
    const max = this.staminaMax();
    if (this.stamina < max / 2) ret *= (this.stamina / max) * 2;
    // Each adjacent grabbing monster costs a quarter (the grab effect's intensity is grab
    // strength, not a head count: the monster system counts them through `grabbers`).
    if (this.effects.has('grabbed')) ret *= Math.max(0, 1 - 0.25 * Math.max(1, this.grabbers?.() ?? 1));
    return Math.max(0, ret);
  }

  // ---------------------------------------------------------------- body temperature
  /** Total clothing warmth on a part (warmth::from_clothing: soaked clothes lose up to 66%). */
  warmth(p: MainPartId): number {
    return this.inv.warmth(p) * (1 - 0.66 * this.wetness[p]);
  }
  /** Character::can_use_floor_warmth: asleep or lying down (waiting/reading also count in BN). */
  canUseFloorWarmth(): boolean {
    return this.isAsleep() || this.effects.has('lying_down');
  }
  /**
   * update_bodytemp_bps' convergent temperature for a main part, in °C (1 °C = 500 BN legacy
   * units). Air below the comfortable 19 °C costs 1 °C per 5 °C; each point of clothing warmth
   * gives back 0.06–0.12 °C (homeostasis works harder the colder you are); wind chill uses BN's
   * bugged °F-as-legacy scaling (×0.2); sunlight adds 1–2 °C. Comfortable warmth (adjacent fire
   * 1 °C per intensity, bedding and blankets when lying down) and mutation heat can only pull
   * you toward BODYTEMP_NORM, never past BODYTEMP_HOT; clothes count half above NORM.
   */
  bodyTempTarget(p: MainPartId): number {
    const env = this.env;
    const cur = this.bodyTemp[p];
    const scaled = logarithmicRange(BODYTEMP.VERY_COLD, BODYTEMP.VERY_HOT, cur);
    const clothing = Math.trunc(30 * (1 + scaled) * this.warmth(p)) / 500;
    const windMph = env.wind / 1.609;
    const windchill = localWindchill(env.temperature, env.humidity ?? 70, windMph) * 0.2;
    let heatLow = 0, heatHigh = 0;
    for (const t of this.traits) {
      const m = this.traitDefs.get(t)?.bodytemp_modifiers as number[] | undefined;
      if (Array.isArray(m)) (heatLow += Math.min(m[0], m[1]) / 500), (heatHigh += Math.max(m[0], m[1]) / 500);
    }
    heatLow += this.enchantBonus('BODYTEMP_MIN', heatLow * 500) / 500;
    heatHigh += this.enchantBonus('BODYTEMP_MAX', heatHigh * 500) / 500;
    // balance.cold eases only what makes you colder (cold air, wind chill), never heat.
    const coldMul = this.balance.cold;
    const air = (env.temperature - 19) / 5;
    let conv = BODYTEMP.NORM + (air < 0 ? air * coldMul : air) + (windchill < 0 ? windchill * coldMul : windchill) + clothing + heatLow + (env.sun ?? 0);
    // adjust_bp_conv_for_bonus_warmth
    const lying = this.canUseFloorWarmth() ? this.floorWarmth() : 0;
    const comfortable = (env.bestFire ?? 0) * 1 + lying;
    // bonus_item_warmth: an unencumbered head pulls up a worn hood (hood_warmth).
    let hood = 0;
    if (p === 'head' && this.inv.encumbrance('head') < 10) {
      for (const it of this.inv.worn) if (it.hasFlag('HOOD')) hood = Math.max(hood, it.def.warmth ?? 0);
    }
    const clothingBonus = Math.trunc(30 * (1 + scaled) * hood * (1 - 0.66 * this.wetness[p])) / 500;
    const bonus = comfortable + (heatHigh - heatLow) + clothingBonus;
    if (bonus > 0) {
      // The conv needed to reach NORM this very turn (the update formula inverted in legacy
      // units, where 0 is 27 °C and 500 is 1 °C), capped at HOT.
      let desired = 501 * (BODYTEMP.NORM - 27) - 499 * (cur - 27) + 27;
      if (Math.abs(BODYTEMP.NORM - desired) < 2) desired = BODYTEMP.NORM;
      else if (desired > BODYTEMP.HOT) desired = BODYTEMP.HOT;
      if (desired >= conv) conv = desired < conv + bonus ? desired : conv + bonus;
    }
    // adjust_bp_conv_for_insulation: clothes are half as good at making you uncomfortably hot.
    if (conv >= BODYTEMP.NORM) {
      const without = conv - clothing;
      if (without >= BODYTEMP.NORM) conv -= clothing / 2;
      else conv -= (clothing - (BODYTEMP.NORM - without)) / 2;
    }
    return conv;
  }
  /** Character::floor_warmth: bedding + items + mutation floor warmth (fur never lets bedding go negative). */
  floorWarmth(): number {
    const items = this.env.floorItemWarmth ?? 0;
    let bedding = this.env.bedding ?? -4;
    let mut = 0;
    for (const t of this.traits) {
      const v = this.traitDefs.get(t)?.bodytemp_sleep;
      if (typeof v === 'number') mut += v / 500;
    }
    mut += this.enchantBonus('BODYTEMP_SLEEP', mut * 500) / 500;
    if (!this.hasTrait('DOWN') && mut >= 0.4) bedding = Math.max(0, bedding);
    return items + bedding + mut;
  }
  /** panels.cpp temp_stat on the most extreme part. */
  bodyTempDescription(): string {
    let worst: number = BODYTEMP.NORM;
    for (const p of MAIN_PARTS) if (Math.abs(this.bodyTemp[p] - BODYTEMP.NORM) > Math.abs(worst - BODYTEMP.NORM)) worst = this.bodyTemp[p];
    if (worst > BODYTEMP.SCORCHING) return 'Scorching!';
    if (worst > BODYTEMP.VERY_HOT) return 'Very hot!';
    if (worst > BODYTEMP.HOT) return 'Warm';
    if (worst > BODYTEMP.COLD) return 'Comfortable';
    if (worst > BODYTEMP.VERY_COLD) return 'Chilly';
    if (worst > BODYTEMP.FREEZING) return 'Very cold!';
    return 'Freezing!';
  }
  private updateBodyTemp(dt: number): void {
    // BN converges by e^(−0.002) per turn (half-life ≈ 6 minutes).
    const k = 1 - Math.exp(-0.002 * dt);
    const waterproof = (p: MainPartId) => this.inv.wornCovering(p).some((it) => it.hasFlag('WATERPROOF') || it.hasFlag('RAINPROOF'));
    // Parts crossing the same threshold together get one message ("your torso and arms").
    const warn = { numb: [] as MainPartId[], veryCold: [] as MainPartId[], chilly: [] as MainPartId[], redHot: [] as MainPartId[], veryHot: [] as MainPartId[], warm: [] as MainPartId[] };
    // equalize_temperature: torso shares heat with head and limbs (temp_equalizer: 0.1 % of the gap per turn).
    const eq = 1 - Math.exp(-0.001 * dt);
    for (const p of ['arm_l', 'arm_r', 'leg_l', 'leg_r', 'head'] as MainPartId[]) {
      const d = (this.bodyTemp.torso - this.bodyTemp[p]) * eq;
      this.bodyTemp.torso -= d;
      this.bodyTemp[p] += d;
    }
    for (const p of MAIN_PARTS) {
      const before = this.bodyTemp[p];
      this.bodyTemp[p] += (this.bodyTempTarget(p) - before) * k;
      if (this.env.precipitation && !waterproof(p)) this.wetness[p] = Math.min(1, this.wetness[p] + dt / 300);
      else this.wetness[p] = Math.max(0, this.wetness[p] - dt / (this.bodyTemp[p] > BODYTEMP.NORM ? 900 : 1800));
      const t = this.bodyTemp[p];
      // apply_temp_effects
      const cold = t < BODYTEMP.FREEZING ? 3 : t < BODYTEMP.VERY_COLD ? 2 : t < BODYTEMP.COLD ? 1 : 0;
      const hot = t > BODYTEMP.SCORCHING ? 3 : t > BODYTEMP.VERY_HOT ? 2 : t > BODYTEMP.HOT ? 1 : 0;
      this.setTempEffect('cold', p, cold);
      this.setTempEffect('hot', p, hot);
      // warn_temp_change (BN warns whether or not you're asleep)
      if (before > BODYTEMP.FREEZING && t <= BODYTEMP.FREEZING) warn.numb.push(p);
      else if (before > BODYTEMP.VERY_COLD && t <= BODYTEMP.VERY_COLD) warn.veryCold.push(p);
      else if (before > BODYTEMP.COLD && t <= BODYTEMP.COLD) warn.chilly.push(p);
      else if (before < BODYTEMP.SCORCHING && t >= BODYTEMP.SCORCHING) warn.redHot.push(p);
      else if (before < BODYTEMP.VERY_HOT && t >= BODYTEMP.VERY_HOT) warn.veryHot.push(p);
      else if (before < BODYTEMP.HOT && t >= BODYTEMP.HOT) warn.warm.push(p);
      // wake_if_hypothermia: a torso at BODYTEMP_COLD shivers you awake, however tired you are.
      if (p === 'torso' && t <= BODYTEMP.COLD && this.isAsleep()) {
        this.msg('Your shivering prevents you from sleeping.', 'c_yellow');
        this.wakeUp();
      }
    }
    if (warn.numb.length) this.msg(`You feel your ${partList(warn.numb)} beginning to go numb from the cold!`, 'c_red');
    if (warn.veryCold.length) this.msg(`You feel your ${partList(warn.veryCold)} getting very cold.`, 'c_yellow');
    if (warn.chilly.length) this.msg(`You feel your ${partList(warn.chilly)} getting chilly.`, 'c_yellow');
    if (warn.redHot.length) this.msg(`You feel your ${partList(warn.redHot)} getting red hot from the heat!`, 'c_red');
    if (warn.veryHot.length) this.msg(`You feel your ${partList(warn.veryHot)} getting very hot.`, 'c_yellow');
    if (warn.warm.length) this.msg(`You feel your ${partList(warn.warm)} getting warm.`, 'c_yellow');
  }
  private setTempEffect(id: 'cold' | 'hot', p: MainPartId, intensity: number): void {
    const e = this.effects.get(id, p);
    if (intensity === 0) {
      if (e) this.effects.remove(id, p);
      return;
    }
    if (!e) this.effects.add(id, 3600, { bp: p, intensity, turn: this.turn });
    else {
      e.setIntensity(intensity);
      e.setDuration(3600);
    }
  }

  // ---------------------------------------------------------------- update loop
  /** Advance the simulation by gameDt game-clock seconds. */
  update(gameDt: number): void {
    if (this.dead || gameDt <= 0) return;
    // Stamina works in action turns: see the file header.
    this.updateStamina((gameDt * ACTION_SCALE) / clockScale());
    this.acc += gameDt;
    while (this.acc >= 1 && !this.dead) {
      this.acc -= 1;
      this.turn++;
      this.perTurn();
    }
    this.updateBodyTemp(gameDt);
    this.morale.decay(gameDt);
    this.inv.update(gameDt);
    this.inv.processRot(gameDt, this.env.temperature);
    this.updateFakeEffects();
    this.resetStats();
  }

  private perTurn(): void {
    // Creature::process_effects: removes_effects, data-driven mods, hardcoded behaviour, decay.
    for (const e of this.effects.all()) {
      for (const r of e.type.def.removes_effects ?? []) if (this.effects.has(r)) this.removeEffect(r);
    }
    for (const e of this.effects.all()) {
      if (!this.effects.get(e.id, e.bp)) continue;
      this.processEffect(e, false);
      this.hardcodedEffect(e);
      if (this.dead) return;
      // effect::decay: intensity steps down every int_decay_tick while under max duration,
      // but never below 1 (BN never removes an effect by intensity).
      if (e.intensity > 1 && e.type.intDecayTick && this.turn % e.type.intDecayTick === 0 && e.type.maxDuration > e.duration) {
        e.setIntensity(Math.max(1, e.intensity + e.type.intDecayStep));
      }
      if (e.duration <= 0) this.removeEffect(e.id, e.bp ?? undefined, true);
      else if (!e.permanent && !e.type.def.permanent) e.modDuration(-1);
    }
    if (this.dead) return;
    if (this.turn % 60 === 0) this.perMinute();
    if (this.turn % FIVE_MINUTES === 0) this.perFiveMinutes();
  }

  private perMinute(): void {
    // character_effects::calc_focus_change: gap/10 per minute plus the remainder as a chance.
    let eqMorale = this.morale.level();
    const cap = moraleFatigueCap(this.sleepiness);
    const eff = eqMorale - (this.hasTrait('CENOBITE') ? 0 : this.perceivedPain());
    eqMorale = cap !== 0 && eff > cap - 100 ? cap - 100 : eff;
    const eq = focusEquilibrium(eqMorale, 0);
    let gap = Math.round(eq - this.focus);
    const sign = gap < 0 ? -1 : 1;
    gap = Math.abs(gap);
    let gain = Math.trunc(gap / 10);
    if (this.rng.int(1, 100) <= gap % 100) gain++;
    this.focus += sign * gain;
    this.checkSleepinessExtremes();
  }

  /** Character::check_needs_extremes (fatigue part: collapsing, yawning). */
  private checkSleepinessExtremes(): void {
    if (this.isAsleep()) return;
    const every30 = this.turn % 1800 === 0;
    if (this.sleepiness >= SLEEPINESS.MASSIVE) {
      this.msg('Survivor sleep now.', 'c_red');
      this.sleepiness -= 10;
      this.fallAsleep();
      return;
    }
    if (this.sleepiness >= SLEEPINESS.EXHAUSTED + 25 && every30)
      this.msg(this.sleepiness >= 800 ? 'Anywhere would be a good place to sleep…' : "You feel like you haven't slept in days.", 'c_yellow');
    if (this.sleepiness >= 700) {
      if (every30) this.msg("You're too physically tired to stop yawning.", 'c_yellow');
      if (this.rng.oneIn(50 + this.int)) this.fallAsleep(30);
    } else if (this.sleepiness >= SLEEPINESS.EXHAUSTED) {
      if (every30) this.msg('How much longer until bedtime?', 'c_yellow');
      if (this.rng.oneIn(100 + this.int)) this.fallAsleep(30);
    } else if (this.sleepiness >= SLEEPINESS.DEAD_TIRED && every30) {
      this.msg('*yawn* You should really get some sleep.', 'c_yellow');
    }
  }

  private perFiveMinutes(): void {
    const asleep = this.isAsleep();
    const rates = this.needsRates();
    // --- update_stomach: digest, burn calories, get thirsty
    this.digest(1);
    this.modStoredKcal(-this.rollRemainder((this.metabolicRate() * METABOLIC_BASE_KCALS * this.balance.hunger) / (12 * 24)));
    this.modThirst(this.rollRemainder(rates.thirst * this.balance.thirst));
    // --- check_needs_extremes
    if (this.storedKcal <= 0) {
      this.msg('You have starved to death.', 'c_red');
      this.hp.torso.cur = 0;
      this.die('starvation');
      return;
    }
    if (this.thirst >= THIRST.DEAD) {
      this.msg('You have died of dehydration.', 'c_red');
      this.hp.torso.cur = 0;
      this.die('dehydration');
      return;
    }
    if (this.turn % (6 * 3600) === 0) {
      const kp = this.kcalPercent();
      const cat = kp < 0.1 ? 'empty_starving' : kp < 0.25 ? 'empty_emaciated' : kp < 0.5 ? 'empty_malnutrition' : kp < 0.7 ? 'empty_low_cal' : null;
      const s = cat ? this.snippet(cat) : null;
      if (s) this.msg(s, 'c_yellow');
    }
    if (this.thirst >= THIRST.PARCHED + (THIRST.DEAD - THIRST.PARCHED) * 0.333 && this.turn % 1800 === 0)
      this.msg('Even your eyes feel dry…', 'c_light_red');
    // --- update_needs: fatigue and sleep deprivation
    const wasTired = this.sleepiness > SLEEPINESS.DEAD_TIRED;
    if (this.sleepiness < 1050 && !asleep) {
      const roll = this.rollRemainder(rates.fatigue * this.balance.fatigue);
      this.sleepiness += roll;
      this.sleepDeprivation = Math.min(SLEEP_DEPRIVATION.MASSIVE, this.sleepDeprivation + roll * 5);
    } else if (asleep && rates.recovery > 0) {
      const rec = this.rollRemainder(rates.recovery);
      if (this.sleepiness - rec < -20) {
        this.effects.get('sleep')?.setDuration(1);
        this.sleepiness = Math.max(0, this.sleepiness - 25);
      } else {
        this.sleepiness = Math.max(0, this.sleepiness - rec);
        // Best beds add up to 30 % of base to paying off sleep deprivation.
        let restMod = 1;
        if (this.sleepComfort >= 10) restMod += 0.3;
        else if (this.sleepComfort >= 5) restMod += 0.2;
        else if (this.sleepComfort >= 3) restMod += 0.1;
        this.sleepDeprivation = Math.max(0, this.sleepDeprivation - (restMod * rec * 3 * 5) / 2);
      }
    }
    const lying = asleep || this.effects.has('lying_down');
    if (!wasTired && this.sleepiness > SLEEPINESS.DEAD_TIRED && !lying)
      this.msg("You're feeling tired.  Press <keybind:sleep> to lie down for sleep.", 'c_yellow');
    if (this.stim > 0) this.stim--;
    else if (this.stim < 0) this.stim++;
    if (this.painkiller > 0) this.painkiller--;
    this.regen(asleep);
  }

  /**
   * Character::regen for one 5-minute step: pain fades by 0.2 + pain/50 (× pain_recovery),
   * natural healing at PLAYER_HEALING_RATE × rest quality (0.85 asleep) × healing_resting (or
   * healing_awake while up), bandages/disinfectant add their healing_rate per day; a broken
   * limb mends at 25 % (+ mending_modifier) of the medicine rate.
   */
  private regen(asleep: boolean): void {
    if (this.pain > 0) this.modPainRaw(-this.rollRemainder((0.2 + this.pain / 50) * (1 + this.mutationValue('pain_recovery'))));
    const rest = asleep ? 0.85 : 0;
    let rate = 0;
    const awakeRate = PLAYER_HEALING_RATE * this.mutationValue('healing_awake');
    if (awakeRate > 0) rate += awakeRate;
    if (rest > 0) rate += rest * PLAYER_HEALING_RATE * (1 + this.mutationValue('healing_resting'));
    if (Math.abs(rate) < 0.000007) rate = 0;
    const hpMod = this.mutationValue('hp_modifier');
    if (hpMod < 0) rate *= 1 + hpMod;
    const natural = rate * FIVE_MINUTES * this.balance.healing;
    const mending = Math.max(0, Math.min(1, 0.25 + this.mutationValue('mending_modifier') + this.enchantBonus('MENDING_MULT', 0.25 + this.mutationValue('mending_modifier'))));
    for (const p of MAIN_PARTS) {
      // healing_rate_medicine: bandaged + disinfected "healing_rate" HP/day, head/torso scaled.
      let med = 0;
      let both = 0;
      for (const id of ['bandaged', 'disinfected']) {
        const eff = this.effects.get(id, p);
        if (!eff) continue;
        both++;
        let r = eff.type.extraValue('healing_rate', this.resistsEffect(eff), eff.effectiveIntensity()) / 86400;
        if (p === 'head') r *= eff.type.extraValue('healing_head', false, 1) / 100;
        if (p === 'torso') r *= eff.type.extraValue('healing_torso', false, 1) / 100;
        med += r;
      }
      med *= (1 + this.mutationValue('healing_resting')) * (1 + rest) * this.balance.healing;
      if (both === 2) med *= 1.25;
      const broken = this.isLimbBroken(p) && !this.inv.worn.some((w) => w.hasFlag('SPLINT'));
      const add = (broken ? 0 : natural) + (broken ? med * FIVE_MINUTES * mending : med * FIVE_MINUTES);
      this.healAcc[p] += add;
      const whole = Math.floor(this.healAcc[p]);
      if (whole > 0) {
        this.healAcc[p] -= whole;
        this.heal(p, whole);
      }
    }
  }

  private modPainRaw(n: number): void {
    this.pain = Math.max(0, this.pain + n);
  }

  private snippet(cat: string): string | null {
    const list = this.data.misc?.snippet?.[cat] as unknown[] | undefined;
    if (!list?.length) return null;
    const s = this.rng.pick(list);
    return typeof s === 'string' ? s : cddaText((s as { text?: string }).text) || null;
  }

  /** BN roll_remainder: integer part plus a chance for the fraction. */
  rollRemainder(v: number): number {
    const i = Math.trunc(v);
    const f = v - i;
    return i + (f > 0 && this.rng.next() < f ? 1 : f < 0 && this.rng.next() < -f ? -1 : 0);
  }

  /** Every body part id, handy for UIs. */
  static readonly allParts = ALL_PARTS;

  // ---------------------------------------------------------------- serialization
  toJSON(): CharacterJSON {
    return {
      name: this.name, male: this.male,
      str_base: this.str_base, dex_base: this.dex_base, int_base: this.int_base, per_base: this.per_base,
      baseSpeed: this.baseSpeed,
      skills: structuredClone(this.skills), hp: structuredClone(this.hp),
      pain: this.pain, painkiller: this.painkiller, stamina: this.stamina,
      storedKcal: this.storedKcal, stomach: { ...this.stomach },
      thirst: this.thirst, hunger: this.hunger, sleepiness: this.sleepiness, sleepDeprivation: this.sleepDeprivation, stim: this.stim,
      focus: this.focus,
      bodyTemp: { ...this.bodyTemp }, wetness: { ...this.wetness },
      traits: [...this.traits], effects: this.effects.toJSON(), morale: structuredClone(this.morale.points),
      turn: this.turn, dead: this.dead, causeOfDeath: this.causeOfDeath,
      inventory: this.inv.toJSON(),
      learnedRecipes: [...this.learnedRecipes], identifiedBooks: [...this.identifiedBooks], proficiencies: [...this.proficiencies],
      ...(Number.isFinite(this.lastSleepCheck) ? { lastSleepCheck: this.lastSleepCheck } : {}),
    };
  }
  load(j: CharacterJSON): void {
    Object.assign(this, {
      name: j.name, male: j.male, str_base: j.str_base, dex_base: j.dex_base, int_base: j.int_base, per_base: j.per_base,
      baseSpeed: j.baseSpeed, skills: structuredClone(j.skills), hp: structuredClone(j.hp),
      pain: j.pain, painkiller: j.painkiller, stamina: j.stamina, storedKcal: j.storedKcal,
      // DDA-era saves also stored stomach volume/water: BN only keeps calories.
      stomach: { kcal: j.stomach?.kcal ?? 0, lastAte: j.stomach?.lastAte ?? 0 },
      thirst: j.thirst, hunger: j.hunger, sleepiness: j.sleepiness, sleepDeprivation: j.sleepDeprivation, stim: j.stim,
      focus: j.focus, bodyTemp: { ...j.bodyTemp }, wetness: { ...j.wetness },
      turn: j.turn, dead: j.dead, causeOfDeath: j.causeOfDeath,
      lastSleepCheck: j.lastSleepCheck ?? -Infinity,
    });
    this.storedKcal = Math.min(this.storedKcal, this.maxStoredKcal());
    this.traits.clear();
    for (const t of j.traits) this.traits.add(t);
    this.effects.load(j.effects);
    this.morale.points = structuredClone(j.morale);
    this.inv.load(j.inventory);
    for (const [set, list] of [[this.learnedRecipes, j.learnedRecipes], [this.identifiedBooks, j.identifiedBooks], [this.proficiencies, j.proficiencies]] as const) {
      set.clear();
      for (const id of list ?? []) set.add(id);
    }
    this.resetStats();
  }
}

/** cata_utility multi_lerp over sorted [x, y] points. */
export function multiLerp(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

/** character_effects::get_thirst_speed_penalty (applies above Very Thirsty). */
export function thirstSpeedPenalty(thirst: number): number {
  return Math.trunc(multiLerp([[THIRST.VERY_THIRSTY, 0], [THIRST.DEHYDRATED, -25], [THIRST.PARCHED, -50], [THIRST.DEAD, -75]], thirst));
}

/** character_effects::get_kcal_speed_penalty: 0 above 95 % stored, down to −90 when empty. */
export function kcalSpeedPenalty(kcalPercent: number): number {
  if (kcalPercent > 0.95) return 0;
  return Math.round(multiLerp([[0, -90], [0.1, -50], [0.3, -25], [0.5, 0]], kcalPercent));
}

/** character_effects::calc_morale_fatigue_cap */
export function moraleFatigueCap(fatigue: number): number {
  if (fatigue >= SLEEPINESS.MASSIVE) return 20;
  if (fatigue >= SLEEPINESS.EXHAUSTED) return 40;
  if (fatigue >= SLEEPINESS.DEAD_TIRED) return 60;
  if (fatigue >= SLEEPINESS.TIRED) return 80;
  return 0;
}

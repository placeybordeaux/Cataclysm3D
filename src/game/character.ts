import type { GameData, MutationDef } from '../data/types';
import { Rng } from '../core/rng';
import { ACTION_SCALE, CLOCK_SCALE } from '../core/time';
import { ALL_PARTS, BODY_PARTS, MAIN_PARTS, isLimb, type BodyPartId, type MainPartId } from './bodyparts';
import {
  boundModToVals, Effect, effectActivated, effectAmount, EffectRegistry, EffectSet, effectRollMod, type EffectJSON,
} from './effects';
import { Inventory, type InventoryJSON } from './inventory';
import { focusEquilibrium, Morale, type MoralePoint } from './morale';
import { cddaText } from './units';
import { buffFlat } from './martialarts';

// The survivor model (CDDA Character/avatar, simplified). Everything is driven by
// update(gameDt) in game-clock seconds; CDDA rates are per game second ("turn"), so they are
// used directly. Stamina is the one exception: CDDA regenerates it per turn of *action*,
// and our action time runs at ACTION_SCALE turns per real second while the clock runs at
// CLOCK_SCALE, so stamina uses gameDt * ACTION_SCALE / CLOCK_SCALE turns (see update()).

// --- constants (CDDA source in comments) ---
/** character.h sleepiness_levels */
export const SLEEPINESS = { TIRED: 191, DEAD_TIRED: 383, EXHAUSTED: 575, MASSIVE: 1000 } as const;
/** character.h, in minutes of deprivation */
export const SLEEP_DEPRIVATION = { HARMLESS: 2 * 24 * 60, MINOR: 4 * 24 * 60, SERIOUS: 7 * 24 * 60, MAJOR: 10 * 24 * 60, MASSIVE: 14 * 24 * 60 } as const;
/** weather.h BODYTEMP_* in °C */
export const BODYTEMP = { FREEZING: 28, VERY_COLD: 31, COLD: 34, NORM: 37, HOT: 40, VERY_HOT: 43, SCORCHING: 46 } as const;
/** character.h: KCAL_PER_KG = 3500 * 2.20462 */
export const KCAL_PER_KG = 3500 * 2.20462;
/** game_constants.h character_weight_category (BMI from fat) */
export const WEIGHT_CATEGORY = { emaciated: 1, underweight: 2, normal: 3, overweight: 5, obese: 10 } as const;
/** external_options.json */
export const PLAYER_MAX_STAMINA_BASE = 3500;
export const PLAYER_CARDIOFIT_STAMINA_SCALING = 5;
export const PLAYER_BASE_STAMINA_REGEN_RATE = 20;
export const PLAYER_BASE_STAMINA_BURN_RATE = 15;
export const PLAYER_HEALING_RATE = 0.0001;
/** vitamin.json "blood": min -50000, regenerates 1 per 6 s; hypovolemia thresholds. */
export const BLOOD_MIN = -50000;
const HYPOVOLEMIA_STAGES: [number, number][] = [[-5000, 1], [-7510, 2], [-15010, 3], [-20010, 4]];
/** stomach.cpp: 2500 ml capacity; water passes 250 ml / 5 min, solids 1/6 per 30 min. */
export const STOMACH_CAPACITY = 2500;
/** game_constants.h MAX_RECOIL */
export const MAX_RECOIL = 3000;
/** Game seconds between CDDA's 5-minute needs updates. */
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

/** body_parts.json fire_warmth_bonus per main part (hands/feet folded into arms/legs), °C. */
const FIRE_WARMTH_BONUS: Record<MainPartId, number> = { head: 0.3, torso: 0.3, arm_l: 1.2, arm_r: 1.2, leg_l: 0.6, leg_r: 0.6 };

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

/** weather.cpp get_local_windchill: apparent-temperature delta (K) for air °C, humidity %, wind mph. */
export function localWindchill(tempC: number, humidity: number, windMph: number): number {
  if (tempC < 10) {
    if (windMph < 3) return 0;
    const kmh = windMph * 0.44704 * 3.6;
    const w = Math.pow(kmh, 0.16);
    return 13.12 + 0.6215 * tempC - 11.37 * w + 0.3965 * tempC * w - tempC;
  }
  const ms = windMph * 0.44704;
  return 0.33 * Math.min(150, (humidity / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC))) - 0.7 * ms - 4;
}

export type MoveMode = 'walk' | 'run' | 'crouch';

export interface SkillLevel {
  level: number;
  /** CDDA _exercise: level up at 10000 * (level+1)^2 */
  exercise: number;
}

export interface CharacterEnvironment {
  /** Ambient air temperature at the character, °C (weather + radiant heat from nearby fires). */
  temperature: number;
  /** Wind speed, km/h (already reduced by shelter). */
  wind: number;
  /** Rain/snow falling on the character. */
  precipitation: boolean;
  /** Relative humidity, % (CDDA's warm-weather wind chill uses it). */
  humidity?: number;
  /** Sun irradiance on the character, 0..1 of the maximum (0 indoors / at night). */
  sun?: number;
  /** floor_bedding_warmth of the spot you'd lie on, °C (furniture, or terrain − 4 °C). */
  bedding?: number;
  /** Warmth of blankets/clothes lying on your tile (Character::floor_item_warmth), °C. */
  floorItemWarmth?: number;
  /** Intensity of the best fire adjacent to you (get_best_fire), 0 = none. */
  bestFire?: number;
}

export interface HpPart {
  cur: number;
  max: number;
}

export type HungerState = 'Engorged' | 'Full' | 'Satisfied' | '' | 'Peckish' | 'Hungry' | 'Near starving' | 'Starving!' | 'Famished';

export interface DamageResult {
  /** HP actually removed from the main part. */
  damage: number;
  pain: number;
  part: MainPartId;
  broken: boolean;
}

// Common starting traits' enchantments (CDDA data/json/mutations/mutations.json) used when
// the data files don't carry "mutation" definitions.
const BUILTIN_TRAITS: MutationDef[] = [
  { id: 'QUICK', name: 'Quick', points: 5, enchantments: [{ values: [{ value: 'SPEED', multiply: 0.1 }] }] },
  { id: 'FLEET', name: 'Fleet-Footed', points: 2, enchantments: [{ values: [{ value: 'MOVECOST_FLATGROUND_MOD', multiply: -0.15 }] }] },
  { id: 'STRONGBACK', name: 'Strong Back', points: 2, enchantments: [{ values: [{ value: 'CARRY_WEIGHT', multiply: 0.35 }] }] },
  { id: 'BADBACK', name: 'Bad Back', points: -3, enchantments: [{ values: [{ value: 'CARRY_WEIGHT', multiply: -0.35 }] }] },
  { id: 'GOODHEARING', name: 'Good Hearing', points: 1, enchantments: [{ values: [{ value: 'HEARING_MULT', multiply: 0.25 }] }] },
  { id: 'TOUGH', name: 'Tough', points: 2, enchantments: [{ values: [{ value: 'MAX_HP', multiply: 0.2 }] }] },
  { id: 'FASTHEALER', name: 'Fast Healer', points: 2, enchantments: [{ values: [{ value: 'REGEN_HP', multiply: 0.5 }, { value: 'REGEN_HP_AWAKE', multiply: 0.133 }] }] },
  { id: 'PAINRESIST', name: 'Pain Resistant', points: 3, enchantments: [{ values: [{ value: 'PAIN', multiply: -0.33 }] }] },
  { id: 'LIGHTEATER', name: 'Light Eater', points: 2, enchantments: [{ values: [{ value: 'METABOLISM', multiply: -0.333 }] }] },
  { id: 'GLASSJAW', name: 'Glass Jaw', points: -2 },
  { id: 'NIGHTVISION', name: 'Night Vision', points: 3 },
  { id: 'INFRESIST', name: 'Infection Resistant', points: 2 },
  { id: 'POISRESIST', name: 'Poison Resistant', points: 1 },
  { id: 'WEAKSTOMACH', name: 'Weak Stomach', points: -1 },
];

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
  blood: number; focus: number;
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
}

export class Character {
  name = 'Survivor';
  male = true;
  // Base stats are CDDA's *_max; bonuses are recomputed every update from effects etc.
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
  dodge_bonus = 0;
  hit_bonus = 0;
  /** Named contributions to speed_bonus for the '@' screen. */
  speedModifiers: [string, number][] = [];

  skills: Record<string, SkillLevel> = {};
  hp = {} as Record<MainPartId, HpPart>;
  pain = 0;
  painkiller = 0;
  stamina = 0;
  /** kcal in fat stores (CDDA stored_calories / 1000). */
  storedKcal = 0;
  /** lastAte starts at 0 so a new survivor counts as having just had breakfast. */
  stomach = { volume: 0, kcal: 0, water: 0, lastAte: 0 };
  /** CDDA thirst scale: 0 normal, >40 Thirsty, >240 Dehydrated, >520 Parched, 1200 death. */
  thirst = 0;
  /** CDDA's legacy hunger counter (kept for effects that modify it); display uses hungerState(). */
  hunger = 0;
  sleepiness = 0;
  /** minutes */
  sleepDeprivation = 0;
  stim = 0;
  /** CDDA "blood" vitamin: 0 healthy .. -50000 dead. */
  blood = 0;
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
  /** Absolute game second counter used for CDDA "once_every"/tick alignment. */
  turn = 0;
  rng: Rng;
  onMessage: ((text: string, color?: string) => void) | null = null;
  onDeath: ((cause: string) => void) | null = null;
  /** Debug only (cdda.godMode): hits land but deal no damage, for screenshots and playtests. */
  debugInvulnerable = false;

  private acc = 0;
  private staminaAcc = 0;
  private healAcc = {} as Record<MainPartId, number>;
  private traitDefs = new Map<string, MutationDef>();
  readonly effectTypes: EffectRegistry;
  /**
   * Extra enchantment sources beyond traits (installed bionics: src/game/bionics.ts). Each
   * returns its summed {add, multiply} for an enchant_vals id, or null when it has none.
   */
  readonly enchantProviders: ((value: string) => { add: number; multiply: number } | null)[] = [];
  /**
   * Decides whether a trait enchantment's CDDA `condition` holds (src/game/mutations.ts sets
   * it: ACTIVE needs the mutation powered, simple dialogue conditions). Unset: always true.
   */
  enchantCondition: ((condition: unknown, traitId: string) => boolean) | null = null;

  constructor(readonly data: GameData, opts: { seed?: number } = {}) {
    this.rng = new Rng(opts.seed ?? 12345);
    this.effectTypes = new EffectRegistry(data);
    this.effects = new EffectSet(this.effectTypes);
    for (const t of BUILTIN_TRAITS) this.traitDefs.set(t.id, t);
    for (const t of Object.values((data.misc?.mutation ?? {}) as Record<string, MutationDef>)) this.traitDefs.set(t.id, t);
    for (const p of MAIN_PARTS) {
      this.hp[p] = { cur: 1, max: 1 };
      this.bodyTemp[p] = BODYTEMP.NORM;
      this.wetness[p] = 0;
      this.healAcc[p] = 0;
    }
    this.inv = new Inventory(this);
    this.recalcHp(true);
    this.stamina = this.staminaMax();
    this.storedKcal = this.healthyKcal();
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
  /** Sum of trait enchantment values for a CDDA enchant_vals::mod id. */
  enchant(value: string): { add: number; multiply: number } {
    let add = 0, multiply = 0;
    const named = this.data.misc?.enchantment as Record<string, { values?: { value: string; add?: number; multiply?: number }[]; condition?: unknown }> | undefined;
    for (const id of this.traits) {
      for (const raw of this.traitDefs.get(id)?.enchantments ?? []) {
        // CDDA lets traits reference a standalone "enchantment" object by id.
        const e = typeof raw === 'string' ? named?.[raw] : raw;
        if (!e) continue;
        if (e.condition !== undefined && this.enchantCondition && !this.enchantCondition(e.condition, id)) continue;
        for (const v of e.values ?? []) {
          if (v.value !== value) continue;
          add += v.add ?? 0;
          multiply += v.multiply ?? 0;
        }
      }
    }
    for (const p of this.enchantProviders) {
      const r = p(value);
      if (!r) continue;
      add += r.add;
      multiply += r.multiply;
    }
    return { add, multiply };
  }
  /** Character::calculate_by_enchantment: (base + add) * (1 + multiply). */
  byEnchant(base: number, value: string): number {
    const e = this.enchant(value);
    return (base + e.add) * (1 + e.multiply);
  }

  // ---------------------------------------------------------------- stats
  get str(): number {
    return Math.max(0, this.str_base + this.str_bonus);
  }
  get dex(): number {
    return Math.max(0, this.dex_base + this.dex_bonus);
  }
  get int(): number {
    return Math.max(0, this.int_base + this.int_bonus);
  }
  get per(): number {
    return Math.max(0, this.per_base + this.per_bonus);
  }
  /** Current CDDA speed (base 100). Setting it changes the base. */
  get speed(): number {
    return Math.max(Math.floor(this.baseSpeed * 0.25), this.baseSpeed + this.speed_bonus);
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
   * Character::practice: exercise += amount*100 scaled by focus; level up at
   * 10000*(level+1)^2 exercise (skill.cpp on_exercise_change). Returns true on level-up.
   */
  practice(id: string, amount: number, cap = 10): boolean {
    if (amount <= 0 || this.isAsleep()) return false;
    const sk = (this.skills[id] ??= { level: 0, exercise: 0 });
    if (sk.level >= 10 || sk.level > cap) return false;
    const gained = Math.min(1000, amount) * (Math.max(1, this.focus) / 100) * 100;
    sk.exercise += gained;
    // Practicing drains focus (character.cpp: focus_pool -= max(focus_pool/100, amount)).
    this.focus = Math.max(1, this.focus - Math.max(this.focus / 100, gained / 1000));
    let leveled = false;
    while (sk.exercise >= 10000 * (sk.level + 1) ** 2 && sk.level < 10) {
      sk.exercise -= 10000 * (sk.level + 1) ** 2;
      sk.level++;
      leveled = true;
      this.msg(`Your practical skill in ${this.skillName(id)} has increased to ${sk.level}!`, 'c_light_green');
    }
    return leveled;
  }
  skillName(id: string): string {
    const def = this.data.misc?.skill?.[id];
    return cddaText(def?.name) || id;
  }

  // ---------------------------------------------------------------- HP & damage
  /** Character::calc_all_parts_hp: 60 + 3*str (TOUGH etc via MAX_HP enchantment). */
  recalcHp(fill = false): void {
    for (const p of MAIN_PARTS) {
      let max = this.byEnchant(BODY_PARTS[p].base_hp + this.str_base * 3, 'MAX_HP');
      if (p === 'head' && this.hasTrait('GLASSJAW')) max *= 0.8;
      max = Math.max(1, Math.floor(max));
      const part = this.hp[p];
      const cur = fill ? max : Math.ceil(part.cur * (max / part.max));
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
  heal(bp: BodyPartId, amount: number): void {
    const part = this.hp[BODY_PARTS[bp].main];
    // CDDA: broken limbs don't regenerate until mended; keep them at 0.
    if (isLimb(BODY_PARTS[bp].main) && part.cur <= 0) return;
    part.cur = Math.min(part.max, part.cur + Math.max(0, Math.floor(amount)));
  }

  /**
   * Take an already armor-reduced hit: damage units {type: amount} land on `bp`, adding pain
   * via Creature::deal_damage_handle_type (bash pain = dmg/5, others dmg/4, acid dmg/3).
   */
  takeHit(bp: BodyPartId, units: { type: string; amount: number }[]): DamageResult {
    let total = 0, painf = 0;
    for (const u of units) {
      const amt = Math.floor(u.amount);
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
  modPain(n: number): void {
    if (n > 0) n = Math.round(this.byEnchant(n, 'PAIN'));
    this.pain = Math.max(0, this.pain + n);
  }
  modPainkiller(n: number): void {
    this.painkiller = Math.max(0, this.painkiller + n);
  }
  perceivedPain(): number {
    if (this.effects.intensity('adrenaline') > 1) return 0;
    return Math.max(0, this.pain - this.painkiller);
  }
  /** Character::get_pain_penalty (external_options PAIN_PENALTY_MOD_*). */
  painPenalty(): { str: number; dex: number; int: number; per: number; speed: number } {
    const pain = this.perceivedPain();
    if (pain <= 10) return { str: 0, dex: 0, int: 0, per: 0, speed: 0 };
    const clampStat = (stat: number, pen: number) => (stat > 2 ? Math.min(Math.max(Math.trunc(pen), 1), stat - 1) : Math.max(0, stat - 1));
    const s = Math.max(0, this.str_base), d = Math.max(0, this.dex_base), i = Math.max(0, this.int_base), p = Math.max(0, this.per_base);
    return {
      str: clampStat(s, s * pain * 0.005),
      dex: clampStat(d, d * pain * 0.0075),
      int: clampStat(i, i * pain * 0.01),
      per: clampStat(p, p * pain * 0.01),
      speed: Math.min(50, Math.max(0, Math.trunc(Math.pow(pain, 0.7)))),
    };
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
  staminaMax(): number {
    // cardio fitness fixed at CDDA's default 1000 (no cardio training yet).
    return Math.round(this.byEnchant(PLAYER_MAX_STAMINA_BASE + PLAYER_CARDIOFIT_STAMINA_SCALING * 1000, 'MAX_STAMINA'));
  }
  modStamina(n: number): void {
    const before = this.stamina;
    this.stamina = Math.max(0, Math.min(this.staminaMax(), this.stamina + n));
    if (before > 0 && this.stamina === 0 && n < 0) this.effects.has('winded') || this.addEffect('winded', 10);
  }
  canRun(): boolean {
    return this.stamina > 0 && !this.effects.has('winded') && this.brokenLegs() === 0 && !this.effects.has('downed');
  }
  /**
   * Character::burn_move_stamina: `moves` spent moving. Burn = moves * 15/100 per mode
   * multiplier (run x7 per move_modes.json), +1% per 1% overburden.
   */
  burnMoveStamina(moves: number, mode: MoveMode = this.moveMode): void {
    const cap = this.inv.weightCapacity();
    const carried = this.inv.weightCarried();
    const overburden = carried > cap ? Math.floor(((carried - cap) * 100) / Math.max(cap, 1)) : 0;
    let burn = PLAYER_BASE_STAMINA_BURN_RATE + overburden;
    burn *= mode === 'run' ? 7 : 1;
    this.modStamina(-(moves * burn) / 100);
  }
  private updateStamina(turns: number): void {
    const winded = this.effects.has('winded');
    let rate = Math.max(0.1, winded ? 0.1 : 1) * PLAYER_BASE_STAMINA_REGEN_RATE;
    // Mouth encumbrance interferes with breathing (stamina_recovery_breathing_mod).
    const mouthEnc = this.inv.encumbrance('mouth');
    if (mouthEnc > 0) rate *= Math.max(0.1, 1 - mouthEnc / 100);
    if (this.stim > 0) rate += Math.min(5, this.stim / 15);
    rate = this.byEnchant(rate, 'REGEN_STAMINA');
    this.staminaAcc += rate * turns;
    const whole = Math.floor(this.staminaAcc);
    this.staminaAcc -= whole;
    this.stamina = Math.max(0, Math.min(this.staminaMax(), this.stamina + whole));
  }

  // ---------------------------------------------------------------- food & water
  heightCm(): number {
    return 175;
  }
  age(): number {
    return 25;
  }
  /** Character::get_healthy_kcal: BMI-5 worth of fat at our height. */
  healthyKcal(): number {
    return Math.floor(KCAL_PER_KG * 5 * (this.heightCm() / 100) ** 2);
  }
  bmiFat(): number {
    return this.storedKcal / KCAL_PER_KG / (this.heightCm() / 100) ** 2;
  }
  bodyweightKg(): number {
    return this.storedKcal / KCAL_PER_KG + (12 + this.str_base) * (this.heightCm() / 100) ** 2;
  }
  /** Character::base_bmr (Mifflin-St Jeor, male): kcal/day at rest. */
  baseBmr(): number {
    const weightFactor = Math.floor((this.bodyweightKg() * 1000) / 100);
    const heightFactor = Math.floor(6.25 * this.heightCm());
    return this.byEnchant(1, 'METABOLISM') * (weightFactor + heightFactor - 5 * this.age() + 5);
  }
  /** Activity multiplier (CDDA activity_history): 1 idle, 2 light, 4 moderate... */
  activityLevel = 1;
  bmr(): number {
    return this.baseBmr() * Math.ceil(Math.max(this.isAsleep() ? 0.85 : 1, this.activityLevel));
  }
  /** Thirst as displayed (Character::get_instant_thirst: water in stomach counts early). */
  instantThirst(): number {
    return this.thirst - Math.max(0, Math.floor(this.stomach.water / 5));
  }
  thirstDescription(): string {
    const t = this.instantThirst();
    if (t > 520) return 'Parched';
    if (t > 240) return 'Dehydrated';
    if (t > 80) return 'Very thirsty';
    if (t > 40) return 'Thirsty';
    if (t < -60) return 'Turgid';
    if (t < -20) return 'Hydrated';
    if (t < 0) return 'Slaked';
    return '';
  }
  stomachContains(): number {
    return this.stomach.volume + this.stomach.water;
  }
  /** Character::update_stomach hunger-effect table. */
  hungerState(): HungerState {
    const cap = STOMACH_CAPACITY;
    const contains = this.stomachContains();
    const since = this.turn - this.stomach.lastAte;
    const justAte = since < 15 * 60, recentlyAte = since < 3 * 3600;
    const deficit = this.bmiFat() < WEIGHT_CATEGORY.normal;
    const engorged = (deficit && contains >= cap) || contains >= (cap * 5) / 6;
    const full = (deficit && contains >= cap * 0.75) || contains > (cap * 11) / 20;
    if (engorged) return 'Engorged';
    if (full) return 'Full';
    if (deficit) {
      if (justAte && contains > cap / 2) return 'Satisfied';
      if (justAte) return 'Peckish';
      if (recentlyAte) return 'Hungry';
      if (this.bmiFat() < WEIGHT_CATEGORY.underweight) return 'Near starving';
      if (this.bmiFat() < WEIGHT_CATEGORY.emaciated) return 'Starving!';
      return 'Famished';
    }
    if (recentlyAte && contains >= (cap * 3) / 8) return 'Satisfied';
    if (recentlyAte || contains > 0) return '';
    if (this.bmiFat() > WEIGHT_CATEGORY.overweight) return 'Peckish';
    return 'Hungry';
  }
  /** Put food into the stomach (consumption.cpp, simplified: no vitamins/guts stage). */
  ingest(kcal: number, solidsMl: number, waterMl: number): void {
    this.stomach.kcal += kcal;
    this.stomach.volume += Math.max(0, solidsMl);
    this.stomach.water += Math.max(0, waterMl);
    this.stomach.lastAte = this.turn;
  }
  private digest(): void {
    // Water: 250 ml per 5 minutes straight to hydration (stomach.cpp get_digest_rates).
    const w = Math.min(this.stomach.water, 250);
    this.stomach.water -= w;
    this.thirst = Math.max(-100, this.thirst - Math.floor(w / 5));
  }
  private digestSolids(): void {
    // Every 30 minutes: 1/6 of solids pass and 1/6 of kcal (min 5 kcal) is absorbed.
    this.stomach.volume = Math.max(0, this.stomach.volume - STOMACH_CAPACITY / 6);
    const k = Math.min(this.stomach.kcal, Math.max(5, Math.round(this.stomach.kcal / 6)));
    this.stomach.kcal -= k;
    this.storedKcal += k;
  }

  // ---------------------------------------------------------------- sleep
  isAsleep(): boolean {
    return this.effects.has('sleep');
  }
  sleepinessDescription(): string {
    if (this.sleepiness >= SLEEPINESS.EXHAUSTED) return 'Exhausted';
    if (this.sleepiness >= SLEEPINESS.DEAD_TIRED) return 'Dead Tired';
    if (this.sleepiness >= SLEEPINESS.TIRED) return 'Tired';
    return '';
  }
  /** Lie down; you'll fall asleep once tired enough (CDDA lying_down / try_sleep). */
  tryToSleep(): void {
    if (this.isAsleep()) return;
    this.addEffect('lying_down', 50 * 60);
  }
  fallAsleep(duration = 10 * 3600): void {
    this.effects.remove('lying_down');
    const [e, isNew] = this.effects.add('sleep', duration, { turn: this.turn });
    if (isNew) this.msg('You fall asleep.');
    e.setIntensity(1);
  }
  wakeUp(): void {
    if (this.effects.remove('sleep')) this.msg('You wake up.');
    this.effects.remove('lying_down');
  }

  // ---------------------------------------------------------------- effects
  /** Add an effect with CDDA semantics; prints the apply message for new visible effects. */
  addEffect(id: string, duration: number, opts: { bp?: BodyPartId; intensity?: number; permanent?: boolean } = {}): Effect {
    let bp = opts.bp ?? null;
    const type = this.effectTypes.get(id);
    if (bp && type.def.main_parts_only) bp = BODY_PARTS[bp].main;
    const [e, isNew] = this.effects.add(id, duration, { ...opts, bp, turn: this.turn });
    if (isNew) {
      if (type.def.apply_message) this.msg(cddaText(type.def.apply_message), type.def.rating === 'good' ? 'c_green' : type.def.rating === 'bad' ? 'c_red' : undefined);
      this.processEffect(e, true);
    }
    return e;
  }
  removeEffect(id: string, bp?: BodyPartId): boolean {
    const had = this.effects.get(id, bp);
    const ok = this.effects.remove(id, bp);
    if (ok && had?.type.def.remove_message) this.msg(cddaText(had.type.def.remove_message));
    return ok;
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
    if ((val = get('HUNGER')) !== 0 && fires('HUNGER', val)) this.hunger += boundModToVals(this.hunger, val, maxVal('HUNGER'), minVal('HUNGER'));
    if ((val = get('THIRST')) !== 0 && fires('THIRST', val)) this.thirst += boundModToVals(this.thirst, val, maxVal('THIRST'), minVal('THIRST'));
    if ((val = get('SLEEPINESS')) !== 0 && !this.isAsleep() && fires('SLEEPINESS', val))
      this.sleepiness += boundModToVals(this.sleepiness, val, maxVal('SLEEPINESS'), minVal('SLEEPINESS'));
    if ((val = get('STAMINA')) !== 0 && fires('STAMINA', val)) this.modStamina(boundModToVals(this.stamina, val, maxVal('STAMINA'), minVal('STAMINA')));
  }

  /** Hardcoded CDDA effects (player_hardcoded_effects.cpp), once per game second. */
  private hardcodedEffect(e: Effect): void {
    const bpName = e.bp ? BODY_PARTS[e.bp].name : 'body';
    switch (e.id) {
      case 'bleed': {
        // eff_fun_bleed: lose `intensity` blood per turn; occasional pain and messages.
        const intense = e.intensity;
        this.blood = Math.max(BLOOD_MIN, this.blood - intense);
        if (this.rng.oneIn(Math.floor(400 / intense))) this.modPain(1);
        if (this.rng.oneIn(Math.floor(120 / intense))) {
          const verb = intense >= 31 ? 'gushes from' : intense >= 21 ? 'pours from' : intense >= 11 ? 'flows from' : intense >= 6 ? 'leaks from' : 'drips from';
          const end = intense >= 21 ? '!' : '.';
          this.msg(`Blood ${verb} your ${bpName}${end}`, 'c_red');
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
      case 'sleep': {
        // Deeper sleep over time: +1 intensity per 5 minutes, so the accelerated recovery in
        // calc_sleep_recovery_rate reaches its 2x cap after 2 hours as CDDA's comment says.
        const slept = this.turn - e.startTurn;
        e.setIntensity(Math.min(24, 1 + Math.floor(slept / 300)));
        break;
      }
      case 'lying_down': {
        // Simplified can_sleep(): fall asleep once tired enough, rolled once a minute.
        if (this.turn % 60 === 0 && this.sleepiness > 40 && this.rng.chance(Math.min(100, this.sleepiness / 4))) this.fallAsleep();
        break;
      }
    }
  }

  /** Per-effect stat modifiers (str_mod etc.), truncated toward zero per effect like CDDA. */
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

  /** Recompute stat/speed bonuses (Character::reset_stats + recalc_speed_bonus). */
  resetStats(): void {
    const m = this.effectStatMods();
    const pp = this.painPenalty();
    this.str_bonus = m.STR - pp.str + Math.trunc(this.enchant('STRENGTH').add);
    this.dex_bonus = m.DEX - pp.dex + Math.trunc(this.enchant('DEXTERITY').add);
    this.int_bonus = m.INT - pp.int + Math.trunc(this.enchant('INTELLIGENCE').add);
    this.per_bonus = m.PER - pp.per + Math.trunc(this.enchant('PERCEPTION').add);
    this.dodge_bonus = m.DODGE;
    this.hit_bonus = m.HIT;
    // Starvation weakens (Character::get_weight_penalty).
    if (this.bmiFat() < WEIGHT_CATEGORY.normal) {
      const bmi = this.bmiFat();
      this.str_bonus -= Math.floor((1 - bmi / WEIGHT_CATEGORY.normal) * this.str_base);
      const d = Math.floor((WEIGHT_CATEGORY.normal - bmi) * 3);
      this.dex_bonus -= d;
      this.int_bonus -= d;
    }
    let speed = m.SPEED - pp.speed + Math.trunc(buffFlat(this, 'speed'));
    if (pp.speed) this.speedModifiers.push(['Pain', -pp.speed]);
    const cap = this.inv.weightCapacity();
    const carried = this.inv.weightCarried();
    if (carried > cap) {
      const pen = Math.floor((25 * (carried - cap)) / Math.max(1, cap));
      speed -= pen;
      this.speedModifiers.push(['Weight Carried', -pen]);
    }
    if (this.thirst > 40) {
      const pen = thirstSpeedPenalty(this.thirst);
      speed += pen;
      this.speedModifiers.push(['Thirst', pen]);
    }
    const kp = this.kcalSpeedPenalty();
    if (kp) {
      speed += kp;
      this.speedModifiers.push(['Underweight', kp]);
    }
    // Enchantment SPEED multiplies total speed (QUICK: x1.1).
    const total = this.baseSpeed + speed;
    const enchanted = Math.round(this.byEnchant(total, 'SPEED'));
    if (enchanted !== total) this.speedModifiers.push(['Bio/Mut/Etc Effects', enchanted - total]);
    speed += enchanted - total;
    this.speed_bonus = Math.max(Math.trunc(-0.75 * this.baseSpeed), speed);
  }
  /** Character::kcal_speed_penalty */
  kcalSpeedPenalty(): number {
    if (this.storedKcal / this.healthyKcal() > 0.95) return 0;
    return Math.round(multiLerp([[0, -90], [WEIGHT_CATEGORY.emaciated, -50], [WEIGHT_CATEGORY.underweight, -25], [WEIGHT_CATEGORY.normal, 0]], this.bmiFat()));
  }

  // ---------------------------------------------------------------- dodge / hit helpers
  /** Character::get_dodge_base: dex/2 + dodge skill. */
  dodgeBase(): number {
    return this.dex / 2 + this.getSkill('dodge');
  }
  /** Character::get_dodge (simplified: downed/grab, speed<100, stamina logistic, encumbrance). */
  dodge(): number {
    if (this.effects.has('downed') || this.isAsleep() || this.effects.has('stunned')) return 0;
    // Martial-arts buffs add dodge (Character::get_dodge_bonus + mabuff_dodge_bonus).
    let ret = this.dodgeBase() + this.dodge_bonus + buffFlat(this, 'dodge');
    if (this.speed < 100) ret *= this.speed / 100;
    // get_stamina_dodge_modifier: logistic falloff below ~ half stamina.
    const ratio = this.stamina / this.staminaMax();
    ret *= 1 / (1 + Math.exp(-(ratio - 0.25) * 20)) * 0.5 + 0.5;
    // Legs/torso encumbrance reduce the reaction limb score (simplified).
    const enc = (this.inv.encumbrance('leg_l') + this.inv.encumbrance('leg_r')) / 2 + this.inv.encumbrance('torso') / 2;
    ret *= Math.max(0.2, 1 - enc / 100);
    return Math.max(0, ret);
  }

  // ---------------------------------------------------------------- body temperature
  /** Total clothing warmth on a part (outfit::warmth: soaked clothes lose up to 66%). */
  warmth(p: MainPartId): number {
    return this.inv.warmth(p) * (1 - 0.66 * this.wetness[p]);
  }
  /**
   * Character::update_bodytemp's convergent temperature for a main part (character_body.cpp),
   * in °C. A naked person is comfortable at 19 °C awake / 31 °C asleep; every 5 °C of air
   * below that costs 1 °C of body temperature; each point of clothing warmth gives back
   * 0.06–0.12 °C (more the colder you are: homeostasis); wind chill uses CDDA's (bugged, kept
   * for balance) °F-as-legacy-units scaling. Bedding, blankets on the floor and an adjacent
   * fire are "comfortable warmth": they help up to BODYTEMP_HOT but never push you past it.
   */
  bodyTempTarget(p: MainPartId): number {
    const env = this.env;
    const asleep = this.isAsleep();
    const ambientNorm = asleep ? 31 : 19;
    const cur = this.bodyTemp[p];
    // logarithmic_range(VERY_COLD, VERY_HOT, cur): 1 when cold, 0 when hot.
    const scaled = logarithmicRange(BODYTEMP.VERY_COLD, BODYTEMP.VERY_HOT, cur);
    const homeostasis = 0.06 * (1 + scaled);
    const windMph = env.wind / 1.609;
    const windchill = localWindchill(env.temperature, env.humidity ?? 70, windMph) * 1.8 * 0.2;
    let conv = BODYTEMP.NORM + (env.temperature - ambientNorm) / 5 + homeostasis * this.warmth(p) + windchill;
    // Sleepiness chills you while awake (−1.725 °C when exhausted), sunlight warms you outdoors.
    if (!asleep) conv -= (1.725 * Math.min(Math.max(this.sleepiness, 0), 900)) / SLEEPINESS.EXHAUSTED;
    conv += 3 * (env.sun ?? 0);
    let heatLow = 0, heatHigh = 0;
    for (const t of this.traits) {
      const m = this.traitDefs.get(t)?.bodytemp_modifiers as number[] | undefined;
      if (Array.isArray(m)) (heatLow += m[0] / 500), (heatHigh += m[1] / 500);
    }
    conv += heatLow;
    const lying = asleep || this.effects.has('lying_down');
    const fire = !lying && env.bestFire ? env.bestFire * FIRE_WARMTH_BONUS[p] : 0;
    const comfortable = fire + (lying ? (env.bedding ?? 0) + (env.floorItemWarmth ?? 0) : 0);
    const bonus = comfortable + (heatHigh - heatLow);
    if (bonus > 0 && conv < BODYTEMP.HOT) conv = Math.min(BODYTEMP.HOT, conv + bonus);
    // bonus_item_warmth: an unencumbered head can pull up a worn hood (outfit::hood_warmth),
    // used only while it doesn't overheat you.
    if (p === 'head' && this.inv.encumbrance('head') < 10) {
      let hood = 0;
      for (const it of this.inv.worn) if (it.hasFlag('HOOD')) hood = Math.max(hood, it.def.warmth ?? 0);
      const extra = homeostasis * hood * (1 - 0.66 * this.wetness.head);
      if (extra > 0 && (conv + extra < BODYTEMP.HOT || cur < BODYTEMP.COLD)) conv += extra;
    }
    return conv;
  }
  bodyTempDescription(): string {
    let worst: number = BODYTEMP.NORM;
    for (const p of MAIN_PARTS) if (Math.abs(this.bodyTemp[p] - BODYTEMP.NORM) > Math.abs(worst - BODYTEMP.NORM)) worst = this.bodyTemp[p];
    if (worst > BODYTEMP.SCORCHING) return 'Scorching!';
    if (worst > BODYTEMP.VERY_HOT) return 'Very hot!';
    if (worst > BODYTEMP.HOT) return 'Warm';
    if (worst < BODYTEMP.FREEZING) return 'Freezing!';
    if (worst < BODYTEMP.VERY_COLD) return 'Very cold!';
    if (worst < BODYTEMP.COLD) return 'Chilly';
    return 'Comfortable';
  }
  private updateBodyTemp(dt: number): void {
    // CDDA converges 1 − e^(−0.002) per turn (half-life ≈ 6 minutes).
    const k = 1 - Math.exp(-0.002 * dt);
    const waterproof = (p: MainPartId) => this.inv.wornCovering(p).some((it) => it.hasFlag('WATERPROOF') || it.hasFlag('RAINPROOF'));
    const asleep = this.isAsleep();
    // Parts crossing the same threshold together get one message ("your torso and arms").
    const warn = { numb: [] as MainPartId[], veryCold: [] as MainPartId[], chilly: [] as MainPartId[] };
    for (const p of MAIN_PARTS) {
      const before = this.bodyTemp[p];
      this.bodyTemp[p] += (this.bodyTempTarget(p) - before) * k;
      if (this.env.precipitation && !waterproof(p)) this.wetness[p] = Math.min(1, this.wetness[p] + dt / 300);
      else this.wetness[p] = Math.max(0, this.wetness[p] - dt / (this.bodyTemp[p] > BODYTEMP.NORM ? 900 : 1800));
      const t = this.bodyTemp[p];
      const cold = t < BODYTEMP.FREEZING ? 3 : t < BODYTEMP.VERY_COLD ? 2 : t < BODYTEMP.COLD ? 1 : 0;
      const hot = t > BODYTEMP.SCORCHING ? 3 : t > BODYTEMP.VERY_HOT ? 2 : t > BODYTEMP.HOT ? 1 : 0;
      this.setTempEffect('cold', p, cold);
      this.setTempEffect('hot', p, hot);
      if (!asleep) {
        if (before > BODYTEMP.FREEZING && t <= BODYTEMP.FREEZING) warn.numb.push(p);
        else if (before > BODYTEMP.VERY_COLD && t <= BODYTEMP.VERY_COLD) warn.veryCold.push(p);
        else if (before > BODYTEMP.COLD && t <= BODYTEMP.COLD) warn.chilly.push(p);
      }
      // CDDA: shivering keeps you from sleeping once your torso is very cold, unless you're
      // dead tired. We also count the head: we have no separate mouth/eyes/hands/feet, so a
      // bare head is the part that most often freezes, and sleeping on while it takes cold
      // damage all night would kill survivors without a hat, which CDDA doesn't do in practice.
      // Dead tired sleepers shiver on, but the cold still wakes them once it starts to hurt
      // (a fifth of the part's HP) rather than letting them freeze to death in their sleep.
      const hurting = this.hp[p].cur < this.hp[p].max * 0.8;
      if (asleep && (p === 'torso' || p === 'head') && t <= BODYTEMP.VERY_COLD && (this.sleepiness <= SLEEPINESS.DEAD_TIRED || hurting) && this.isAsleep()) {
        this.msg(hurting ? 'You wake up shivering violently, aching from the cold!' : 'Your shivering prevents you from sleeping.', hurting ? 'c_red' : 'c_yellow');
        this.wakeUp();
      }
    }
    if (warn.numb.length) this.msg(`You feel your ${partList(warn.numb)} beginning to go numb from the cold!`, 'c_red');
    if (warn.veryCold.length) this.msg(`You feel your ${partList(warn.veryCold)} getting very cold.`, 'c_yellow');
    if (warn.chilly.length) this.msg(`You feel your ${partList(warn.chilly)} getting chilly.`, 'c_yellow');
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
    this.updateStamina((gameDt * ACTION_SCALE) / CLOCK_SCALE);
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
    this.resetStats();
  }

  private perTurn(): void {
    // Effects: data-driven mods, then hardcoded behaviour, then duration decay.
    for (const e of this.effects.all()) {
      this.processEffect(e, false);
      this.hardcodedEffect(e);
      if (this.dead) return;
      if (e.type.intDecayTick && this.turn % e.type.intDecayTick === 0 && e.type.maxDuration > e.duration) {
        e.setIntensity(e.intensity + e.type.intDecayStep);
        if (e.intensity <= 0) {
          this.removeEffect(e.id, e.bp ?? undefined);
          continue;
        }
      }
      if (e.duration <= 0) this.removeEffect(e.id, e.bp ?? undefined);
      else if (!e.permanent) e.modDuration(-1);
    }
    // Blood regenerates 1 per 6 s (vitamin.json rate "-6 s") and drives hypovolemia.
    if (this.turn % 6 === 0 && this.blood < 0) this.blood++;
    this.updateHypovolemia();
    if (this.dead) return;
    if (this.turn % 60 === 0) this.perMinute();
    if (this.turn % FIVE_MINUTES === 0) this.perFiveMinutes();
    if (this.turn % 1800 === 0) this.digestSolids();
  }

  private updateHypovolemia(): void {
    let stage = 0;
    for (const [thr, s] of HYPOVOLEMIA_STAGES) if (this.blood <= thr) stage = s;
    const e = this.effects.get('hypovolemia', null);
    if (stage === 0) {
      if (e) this.removeEffect('hypovolemia');
    } else if (!e) {
      this.addEffect('hypovolemia', 3600, { intensity: stage, permanent: true });
    } else e.setIntensity(stage);
    if (this.blood <= BLOOD_MIN) {
      this.msg(this.effects.has('bleed') ? 'You bleed to death!' : "Your heart can't keep up the pace and fails!", 'c_red');
      this.hp.torso.cur = 0;
      this.die(this.effects.has('bleed') ? 'blood loss' : 'hypovolemia');
    }
  }

  private perMinute(): void {
    // Character::update_mental_focus: move 1% of the gap to equilibrium per minute.
    let eq = focusEquilibrium(this.morale.level(), this.perceivedPain());
    if (this.sleepiness >= SLEEPINESS.EXHAUSTED) eq = Math.min(eq, 40);
    else if (this.sleepiness >= SLEEPINESS.DEAD_TIRED) eq = Math.min(eq, 60);
    else if (this.sleepiness >= SLEEPINESS.TIRED) eq = Math.min(eq, 80);
    this.focus += (eq - this.focus) / 100;
    this.checkSleepinessExtremes();
  }

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
    // --- metabolism (update_stomach) ---
    this.digest();
    this.storedKcal -= this.bmr() / (12 * 24);
    const thirstRate = asleep ? 0.5 : 1;
    this.thirst += this.rollRemainder(thirstRate);
    if (this.thirst >= 1200) {
      this.msg('You have died of dehydration.', 'c_red');
      this.die('dehydration');
      return;
    }
    if (this.storedKcal <= 0) {
      this.msg('You have starved to death.', 'c_red');
      this.die('starvation');
      return;
    }
    // --- sleepiness (update_needs) ---
    const wasTired = this.sleepiness > SLEEPINESS.DEAD_TIRED;
    if (!asleep) {
      if (this.sleepiness < 1050) {
        const rate = this.byEnchant(1, 'SLEEPINESS');
        const roll = this.rollRemainder(rate);
        this.sleepiness += roll;
        this.sleepDeprivation = Math.min(SLEEP_DEPRIVATION.MASSIVE, this.sleepDeprivation + roll * 5);
      }
      if (!wasTired && this.sleepiness > SLEEPINESS.DEAD_TIRED && !this.effects.has('lying_down'))
        this.msg("You're feeling tired.  Press $ to lie down for sleep.", 'c_yellow');
    } else {
      // calc_sleep_recovery_rate: 1 + accelerated 1/(25 - intensity), minus cold parts and pain.
      const sleep = this.effects.get('sleep')!;
      let rate = 1 + 1 / (24 - sleep.intensity + 1);
      for (const p of MAIN_PARTS) if (this.bodyTemp[p] <= BODYTEMP.COLD) rate -= 0.05;
      rate -= this.perceivedPain() / 60;
      const rec = this.rollRemainder(Math.max(0, rate));
      if (this.sleepiness - rec < -20) {
        this.sleepiness -= 25;
        this.wakeUp();
      } else {
        this.sleepiness -= rec;
        const restMod = this.sleepiness < SLEEPINESS.DEAD_TIRED ? 3 : 1;
        this.sleepDeprivation = Math.max(0, this.sleepDeprivation - restMod * rec * 2);
      }
    }
    if (this.stim > 0) this.stim--;
    else if (this.stim < 0) this.stim++;
    if (this.painkiller > 0) this.painkiller--;
    // --- regen (Character::regen) ---
    if (this.pain > 0) this.modPainRaw(-this.rollRemainder(0.2 + this.pain / 50));
    const rest = asleep ? 1 : 0;
    const e = this.enchant('REGEN_HP');
    const awake = (1 - rest) * PLAYER_HEALING_RATE * (1 + e.multiply) * this.enchant('REGEN_HP_AWAKE').multiply;
    const sleepRate = rest * PLAYER_HEALING_RATE * (1 + e.multiply);
    const perPart = (awake + sleepRate) * FIVE_MINUTES;
    for (const p of MAIN_PARTS) {
      // healing_rate_medicine: bandaged/disinfected effects give "healing_rate" HP/day.
      let med = 0;
      for (const eff of this.effects.all()) {
        if (eff.bp !== p) continue;
        const r = eff.type.extraValue('healing_rate', this.resistsEffect(eff), eff.effectiveIntensity());
        if (!r) continue;
        const pct = p === 'head' ? eff.type.extraValue('healing_head', false, 1) || 100 : p === 'torso' ? eff.type.extraValue('healing_torso', false, 1) || 100 : 100;
        med += (r * pct) / 100 / (86400 / FIVE_MINUTES);
      }
      if (asleep) med *= 2;
      this.healAcc[p] += perPart + med;
      const whole = Math.floor(this.healAcc[p]);
      if (whole > 0) {
        this.healAcc[p] -= whole;
        this.heal(p, whole);
      }
    }
    this.hunger = Math.min(300, this.hunger + (asleep ? 0 : 1));
  }

  private modPainRaw(n: number): void {
    this.pain = Math.max(0, this.pain + n);
  }

  /** CDDA roll_remainder: integer part plus a chance for the fraction. */
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
      blood: this.blood, focus: this.focus,
      bodyTemp: { ...this.bodyTemp }, wetness: { ...this.wetness },
      traits: [...this.traits], effects: this.effects.toJSON(), morale: structuredClone(this.morale.points),
      turn: this.turn, dead: this.dead, causeOfDeath: this.causeOfDeath,
      inventory: this.inv.toJSON(),
      learnedRecipes: [...this.learnedRecipes], identifiedBooks: [...this.identifiedBooks], proficiencies: [...this.proficiencies],
    };
  }
  load(j: CharacterJSON): void {
    Object.assign(this, {
      name: j.name, male: j.male, str_base: j.str_base, dex_base: j.dex_base, int_base: j.int_base, per_base: j.per_base,
      baseSpeed: j.baseSpeed, skills: structuredClone(j.skills), hp: structuredClone(j.hp),
      pain: j.pain, painkiller: j.painkiller, stamina: j.stamina, storedKcal: j.storedKcal, stomach: { ...j.stomach },
      thirst: j.thirst, hunger: j.hunger, sleepiness: j.sleepiness, sleepDeprivation: j.sleepDeprivation, stim: j.stim,
      blood: j.blood, focus: j.focus, bodyTemp: { ...j.bodyTemp }, wetness: { ...j.wetness },
      turn: j.turn, dead: j.dead, causeOfDeath: j.causeOfDeath,
    });
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

/** Character::thirst_speed_penalty */
export function thirstSpeedPenalty(thirst: number): number {
  return Math.trunc(multiLerp([[40, 0], [300, -25], [600, -50], [1200, -75]], thirst));
}

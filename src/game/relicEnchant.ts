import type { GameData } from '../data/types';
import { SECONDS_PER_DAY, SECONDS_PER_HOUR } from '../core/time';
import type { Character, EnchantSum } from './character';
import type { Item } from './item';
import { enchantValueTree } from './enchantValues';
import { sunTimes } from './sun';

// Relic passive effects of the items a character has (docs/BN_POWER_ARMOR.md). BN sources,
// Cataclysm-BN/src:
//  - character.cpp Character::recalculate_enchantment_cache: visit_items over the character
//    and add every item enchantment whose enchantment::is_active(guy, item) holds.
//  - visitable.cpp visitable<Character>::visit_items: the wielded item, then worn items, then
//    the inventory, each with its contents, except that guns and magazines are not looked into.
//  - item.cpp item::get_enchantments: the type's relic_data passive_effects.
//  - relic.cpp relic::load: each passive effect is an enchantment object; one with an "id" is
//    replaced by that named enchantment (DRONE_CAM).
//  - enchantments/enchantment.cpp enchantment::load: "conditions" plus the legacy "has" and
//    "condition" strings all go into one condition set; is_active ANDs them (none = always).
//  - enchantments/enchantment_condition.cpp: the built-in condition functions. Their ids and
//    types come from data/json/enchantment_conditions.json (misc.enchantment_condition here):
//      global     always, dawn, day, dusk, night, active (the item is active), inactive
//      character  inside, outside, underground (z < 0), aboveground (z >= 0), underwater
//                 (map::is_divable at the character)
//      item_and_character  has (Character::has_item: anything visit_items reaches), wield
//                 (the primary weapon), worn (Character::is_worn: directly worn)
//    `item` conditions and Lua-defined functions have no built-in implementation; data using
//    them throws here rather than being silently treated as false.
//  - calendar.cpp is_day/is_dawn/is_dusk/is_night: sunrise and sunset with a one-hour twilight.
//    The port's sunrise/sunset come from src/game/sun.ts so they agree with the sky.

/** Where a character is (set by the game, src/game/characterWorld.ts; tests can fake it). */
export interface CharacterWorld {
  /** Game-clock seconds (calendar::turn). */
  seconds(): number;
  /** map::is_outside at the character. */
  outside(): boolean;
  /** The character's z-level. */
  z(): number;
  /** map::is_divable at the character: deep, swimmable water. */
  divable(): boolean;
  /** map::has_flag_ter_or_furn("FUNGUS") at the character. */
  onFungus(): boolean;
  /**
   * in_climate_control's vehicle check: standing on an inside tile of a vehicle with engine
   * power (vpart_position::is_inside && vehicle::total_power_w() > 0).
   */
  vehicleClimateControl(): boolean;
}

type CondType = 'global' | 'character' | 'item_and_character' | 'item';
interface CondDef {
  id: string;
  type: CondType;
  fn: string;
  info: string;
  order: number;
}
interface ValueDef {
  value: string;
  add: number;
  multiply: number;
  max: number;
}
/** One relic passive effect, resolved and validated. */
export interface RelicEnchantment {
  conditions: CondDef[];
  values: ValueDef[];
}

const FUNCTIONS: Record<CondType, readonly string[]> = {
  global: ['always', 'dawn', 'day', 'dusk', 'night', 'active', 'inactive'],
  character: ['inside', 'outside', 'underground', 'aboveground', 'underwater'],
  item_and_character: ['has', 'wield', 'worn'],
  item: [],
};

interface Parsed {
  conds: Map<string, CondDef>;
  byType: Map<string, RelicEnchantment[] | null>;
}
const parsedByData = new WeakMap<GameData, Parsed>();

function parsed(data: GameData): Parsed {
  let p = parsedByData.get(data);
  if (p) return p;
  const conds = new Map<string, CondDef>();
  let order = 0;
  for (const raw of Object.values((data.misc?.enchantment_condition ?? {}) as Record<string, Record<string, unknown>>)) {
    const id = String(raw.id);
    const type = String(raw.condition_type) as CondType;
    const fn = String(raw.condition_function);
    if (!(type in FUNCTIONS)) throw new Error(`enchantment_condition ${id}: unknown condition_type "${type}"`);
    conds.set(id, { id, type, fn, info: String(raw.condition_info ?? id), order: order++ });
  }
  p = { conds, byType: new Map() };
  parsedByData.set(data, p);
  return p;
}

function condition(p: Parsed, id: string, where: string): CondDef {
  const d = p.conds.get(id);
  if (!d) throw new Error(`${where}: unknown enchantment condition "${id}"`);
  // A condition the port can't evaluate is an error in the data, not a silent "false".
  if (!FUNCTIONS[d.type].includes(d.fn)) throw new Error(`${where}: enchantment condition ${id} (${d.type} ${d.fn}) has no implementation`);
  return d;
}

/** enchantment::load for one passive effect (or the named enchantment it points at). */
function parseEnchantment(data: GameData, p: Parsed, raw: Record<string, unknown>, where: string): RelicEnchantment {
  let e = raw;
  if (typeof raw.id === 'string') {
    const named = (data.misc?.enchantment as Record<string, Record<string, unknown>> | undefined)?.[raw.id];
    if (!named) throw new Error(`${where}: named enchantment ${raw.id} missing`);
    e = named;
  }
  const ids = new Set<string>([...((e.conditions as string[] | undefined) ?? [])]);
  if (typeof e.has === 'string') ids.add(e.has);
  if (typeof e.condition === 'string') ids.add(e.condition);
  const conditions = [...ids].map((id) => condition(p, id, where)).sort((a, b) => a.order - b.order);
  const values: ValueDef[] = [];
  for (const v of (e.values as Record<string, unknown>[] | undefined) ?? []) {
    values.push({ value: String(v.value), add: Number(v.add ?? 0), multiply: Number(v.multiply ?? 0), max: Number(v.max ?? 0) });
  }
  return { conditions, values };
}

/** The passive effects of an item type, parsed once. Throws on conditions the port can't evaluate. */
export function relicEnchantments(data: GameData, typeId: string): RelicEnchantment[] | null {
  const p = parsed(data);
  let list = p.byType.get(typeId);
  if (list !== undefined) return list;
  const def = data.items[typeId] as { relic_data?: { passive_effects?: unknown[] } } | undefined;
  const effects = def?.relic_data?.passive_effects ?? [];
  list = effects.length ? effects.map((raw) => parseEnchantment(data, p, raw as Record<string, unknown>, `item ${typeId}`)) : null;
  p.byType.set(typeId, list);
  return list;
}

// ------------------------------------------------------------------ conditions

/** How the character holds the item: the visit_items position. */
export type Holding = 'wielded' | 'worn' | 'carried';

function needWorld(c: Character, cond: CondDef): CharacterWorld {
  if (!c.world) throw new Error(`enchantment condition ${cond.id} needs Character.world (where the character is)`);
  return c.world;
}

/** calendar.cpp is_day / is_dawn / is_dusk / is_night, with sunrise/sunset from src/game/sun.ts. */
export function timeOfDay(seconds: number): { day: boolean; dawn: boolean; dusk: boolean; night: boolean } {
  const day = Math.floor(seconds / SECONDS_PER_DAY);
  const now = (seconds - day * SECONDS_PER_DAY) / SECONDS_PER_HOUR;
  const { sunrise: sr, sunset: ss } = sunTimes(day);
  const twilight = 1;
  return {
    day: now >= sr + twilight && now <= ss,
    dawn: now >= sr && now <= sr + twilight,
    dusk: now >= ss && now <= ss + twilight,
    night: now >= ss + twilight || now <= sr,
  };
}

function holds(c: Character, cond: CondDef, it: Item, holding: Holding): boolean {
  switch (cond.fn) {
    case 'always': return true;
    case 'active': return it.active;
    case 'inactive': return !it.active;
    case 'day': return timeOfDay(needWorld(c, cond).seconds()).day;
    case 'dawn': return timeOfDay(needWorld(c, cond).seconds()).dawn;
    case 'dusk': return timeOfDay(needWorld(c, cond).seconds()).dusk;
    case 'night': return timeOfDay(needWorld(c, cond).seconds()).night;
    case 'inside': return !needWorld(c, cond).outside();
    case 'outside': return needWorld(c, cond).outside();
    case 'underground': return needWorld(c, cond).z() < 0;
    case 'aboveground': return needWorld(c, cond).z() >= 0;
    case 'underwater': return needWorld(c, cond).divable();
    // Every item visit_items reaches is had by the character.
    case 'has': return true;
    case 'wield': return holding === 'wielded';
    case 'worn': return holding === 'worn';
  }
  throw new Error(`enchantment condition ${cond.id}: no implementation for ${cond.fn}`);
}

/** enchantment::is_active(guy, item). */
export function enchantmentActive(c: Character, e: RelicEnchantment, it: Item, holding: Holding): boolean {
  for (const cond of e.conditions) if (!holds(c, cond, it, holding)) return false;
  return true;
}

// ------------------------------------------------------------------ visiting

/**
 * visit_items over a character: wielded, worn, then carried, each with its contents, not looking
 * inside guns or magazines. Only items whose type has passive effects reach `fn`.
 */
export function visitRelics(c: Character, fn: (it: Item, effects: RelicEnchantment[], holding: Holding) => void): void {
  const data = c.data;
  const visit = (it: Item, holding: Holding) => {
    const effects = it.def.relic_data ? relicEnchantments(data, it.typeId) : null;
    if (effects) fn(it, effects, holding);
    if (it.isGun() || it.isMagazine()) return;
    // A tool's magazine sits in BN's contents; it is visited, but not looked into.
    for (const x of it.contents) visit(x, 'carried');
    if (it.magazine) visit(it.magazine, 'carried');
  };
  const inv = c.inv;
  if (inv.wielded) visit(inv.wielded, 'wielded');
  for (const w of inv.worn) visit(w, 'worn');
  for (const x of inv.items) visit(x, 'carried');
}

/** Character.enchantProviders entry: the summed active item enchantments for one value id. */
export function relicEnchant(c: Character, value: string): EnchantSum | null {
  let add = 0, multiply = 0, max = 0, any = false;
  visitRelics(c, (it, effects, holding) => {
    for (const e of effects) {
      let match = false;
      for (const v of e.values) if (v.value === value) match = true;
      if (!match || !enchantmentActive(c, e, it, holding)) continue;
      for (const v of e.values) {
        if (v.value !== value) continue;
        add += v.add;
        multiply += v.multiply;
        max = Math.max(max, v.max);
        any = true;
      }
    }
  });
  return any ? { add, multiply, max } : null;
}

export function installRelicEnchantments(c: Character): void {
  c.enchantProviders.push((v) => relicEnchant(c, v));
}

/**
 * Character::in_climate_control: M_SKIN3 asleep on fungus, any worn CLIMATE_CONTROL item, or an
 * inside tile of a powered vehicle. BN rechecks the vehicle every 20 turns (60 after a miss) to
 * "simulate acclimation"; here it is checked when asked.
 */
export function inClimateControl(c: Character): boolean {
  if (c.hasTrait('M_SKIN3') && c.isAsleep() && c.world?.onFungus()) return true;
  for (const w of c.inv.worn) if (w.hasFlag('CLIMATE_CONTROL')) return true;
  return c.world?.vehicleClimateControl() ?? false;
}

// ------------------------------------------------------------------ item info

export interface RelicInfo {
  /** "While active and While worn" / "At all times" (enchantment::get_effect_string). */
  condition: string;
  /** Null when the character doesn't have the item; otherwise whether it applies right now. */
  inEffect: boolean | null;
  lines: { text: string; good: number }[];
}

/** How an item is held by `c`, or null when `c` doesn't have it. */
function holdingOf(c: Character, it: Item): Holding | null {
  let found: Holding | null = null;
  visitRelics(c, (x, _e, h) => {
    if (x === it) found = h;
  });
  return found;
}

function amount(value: string, v: ValueDef): string {
  const parts: string[] = [];
  const climate = value.startsWith('CLIMATE_CONTROL');
  if (v.add) parts.push(climate ? `${v.add > 0 ? '+' : ''}${+(v.add / 500).toFixed(2)} °C` : `${v.add > 0 ? '+' : ''}${v.add}`);
  if (v.multiply) parts.push(`${v.multiply > 0 ? '+' : ''}${Math.round(v.multiply * 100)}%`);
  if (v.max) parts.push(`${v.max}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * item::enchantment_info: each passive effect's conditions and what it affects, coloured good
 * (green) or bad (red) by the value's increase_good. The amounts in brackets are the port's
 * addition (BN shows only the description).
 */
export function relicInfo(c: Character, it: Item): RelicInfo[] {
  const effects = it.def.relic_data ? relicEnchantments(c.data, it.typeId) : null;
  if (!effects || it.hasFlag('SECRET_ENCHANTMENTS')) return [];
  const tree = enchantValueTree(c.data);
  const holding = holdingOf(c, it);
  const out: RelicInfo[] = [];
  for (const e of effects) {
    if (!e.values.length) continue;
    const condition = e.conditions.length ? e.conditions.map((k) => k.info).join(' and ') : 'At all times';
    const lines = e.values.map((v) => {
      const node = tree.get(v.value);
      const good = node?.increaseGood ?? true;
      const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
      const score = (v.add ? sign(v.add) * (good ? 1 : -1) : 0) + (v.multiply ? sign(v.multiply) * (good ? 1 : -1) : 0) + (v.max ? 1 : 0);
      return { text: (node?.desc || v.value) + amount(v.value, v), good: score };
    });
    // A detached character (no world) can't answer DAY/OUTSIDE…: the tooltip then doesn't say.
    const needsWorld = e.conditions.some((k) => k.type === 'character' || ['day', 'dawn', 'dusk', 'night'].includes(k.fn));
    const inEffect = holding && (c.world || !needsWorld) ? enchantmentActive(c, e, it, holding) : null;
    out.push({ condition, inEffect, lines });
  }
  return out;
}

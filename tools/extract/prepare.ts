// Per-object preprocessing applied to raw BN JSON *before* inheritance resolution:
//  - drop translator/dev comments ("//", "//~", "//2", ...) and ascii art references
//  - convert quantity strings to numbers in base units, and BN's legacy integers in
//    non-base units (250 ml volume steps, moves, hours...) likewise (see legacyTable)
//  - flatten translation objects ({str, str_pl}) to strings; top-level `name` also yields
//    `name_plural`
//
// Doing units first means `relative: { weight: "-25 g" }` and the parent's "250 g" are
// both plain numbers by the time inheritance does arithmetic on them.

import { parseQuantity } from './units';

// Keys whose string values are identifiers or prose, never quantities, even when they
// happen to look like one ("10mm" ammo, a snippet saying "5 m").
const NEVER_QUANTITY = new Set([
  'id', 'abstract', 'copy-from', 'looks_like', 'name', 'description', 'text', 'str', 'str_pl', 'str_sp',
  'ctxt', 'message', 'msg', 'result', 'item', 'items', 'group', 'ammo', 'ammo_type', 'ammo-item',
  'type', 'symbol', 'color', 'flags', 'category', 'snippet_category', 'default', 'replace',
  'u_spawn_item', 'tools', 'magazine_adaptor', 'ammo_modifier', 'sound', 'sound_fail', 'npc_background',
  'magazines', 'default_ammo', 'acceptable_ammo', 'reloads_like', 'weapon_category', 'signage', 'container',
]);

// Keys that are quantities even without whitespace ("-25g"). Values with a space
// ("250 ml") are converted anywhere except NEVER_QUANTITY keys.
const QUANTITY_KEYS = new Set([
  'weight', 'volume', 'price', 'price_postapoc', 'longest_side', 'integral_volume', 'integral_weight',
  'integral_longest_side', 'barrel_length', 'barrel_volume', 'time', 'spoils_in', 'mass', 'max_volume',
  'max_contains_volume', 'max_contains_weight', 'min_item_volume', 'max_item_volume', 'max_item_length',
  'min_item_length', 'duration', 'energy', 'power_draw', 'capacity', 'folded_volume', 'keg_capacity',
  'contains', 'storage', 'magazine_well', 'max_pet_vol', 'min_pet_vol', 'install_time', 'max_weight',
  'weight_capacity_bonus', 'max_capacity', 'reload_noise_volume', 'charge_interval',
]);

const DROP_KEYS = new Set(['ascii_picture', 'ascii_art']);

function isComment(k: string): boolean {
  return k.startsWith('//');
}

const TRANSLATION_KEYS = new Set(['str', 'str_pl', 'str_sp', 'ctxt']);

/** {str: "x"} / {str_sp: "x"} / {str: "x", str_pl: "xs", ctxt: ".."} -> true */
export function isTranslation(v: unknown): v is { str?: string; str_pl?: string; str_sp?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  let has = false;
  for (const k of Object.keys(v)) {
    if (isComment(k)) continue;
    if (!TRANSLATION_KEYS.has(k)) return false;
    if (k === 'str' || k === 'str_sp') has = true;
  }
  return has;
}

export function translationText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isTranslation(v)) return (v.str ?? v.str_sp)!;
  throw new Error(`not a translation: ${JSON.stringify(v)}`);
}

/** CDDA's default plural (translation::make_plural) just appends "s". */
export function translationPlural(v: unknown): string {
  if (typeof v === 'string') return v + 's';
  if (isTranslation(v)) {
    if (v.str_sp !== undefined) return v.str_sp;
    if (v.str_pl !== undefined) return v.str_pl;
    return v.str + 's';
  }
  throw new Error(`not a translation: ${JSON.stringify(v)}`);
}

function convertValue(v: unknown, key: string): unknown {
  if (typeof v === 'string') {
    if (NEVER_QUANTITY.has(key)) return v;
    const q = parseQuantity(v);
    if (q && (q.spaced || QUANTITY_KEYS.has(key))) return q.value;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => convertValue(x, key));
  if (v && typeof v === 'object') {
    if (isTranslation(v)) return translationText(v);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (isComment(k) || DROP_KEYS.has(k)) continue;
      out[k] = convertValue(x, k);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------------------
// BN legacy integers. Some members accept a bare int in a unit other than our base unit;
// the C++ reader multiplies it (and the same parse is used for "relative" values, never for
// "proportional" factors). Strings in these members are ordinary quantities.
//   units::volume assign(): int * legacy_volume_factor (250 ml)       assign.cpp
//   furn_t keg_capacity: legacy_volume_reader (int * 250 ml)          map/mapdata.cpp
//   islot_comestible spoils_in: assign(..., 1_hours) factor           item_factory.cpp
//   islot_book time: int minutes                                       item_factory.cpp
//   islot_gunmod install_time: int moves (100 per second)              item_factory.cpp
//   islot_seed grow: assign(..., 1_days)                               item_factory.cpp
//   recipe / uncraft time: int moves                                   recipe.cpp
// Mass ints are grams, money ints cents, energy ints kJ: already our base units.
const V250 = 250;
const MOVES = 0.01;
const ITEM_VOLUME_KEYS = ['volume', 'integral_volume', 'storage', 'magazine_well', 'barrel_volume', 'barrel_length', 'contains', 'max_pet_vol', 'min_pet_vol'];
const ITEM_LEGACY: Record<string, number> = {
  ...Object.fromEntries(ITEM_VOLUME_KEYS.map((k) => [k, V250])),
  spoils_in: 3600,
  install_time: MOVES,
  grow: 86400,
};
// sub-objects that carry another slot's members on any item type (load_basic_info)
const ITEM_SLOT_OBJECTS = ['container_data', 'armor_data', 'pet_armor_data', 'book_data', 'gun_data', 'gunmod_data', 'seed_data'];
const ITEM_TYPES_FOR_LEGACY = new Set([
  'GENERIC', 'TOOL', 'COMESTIBLE', 'ARMOR', 'TOOL_ARMOR', 'PET_ARMOR', 'GUN', 'GUNMOD', 'AMMO', 'MAGAZINE', 'BOOK',
  'CONTAINER', 'BIONIC_ITEM', 'TOOLMOD', 'ENGINE', 'WHEEL', 'FUEL', 'BATTERY',
]);

const isPlainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function legacyTable(type: unknown): Record<string, number> | undefined {
  if (typeof type !== 'string') return undefined;
  if (ITEM_TYPES_FOR_LEGACY.has(type)) return type === 'BOOK' ? { ...ITEM_LEGACY, time: 60 } : ITEM_LEGACY;
  if (type === 'recipe' || type === 'uncraft') return { time: MOVES };
  if (type === 'furniture') return { keg_capacity: V250 };
  if (type === 'terrain') return { max_volume: V250 };
  return undefined;
}

function convertMembers(obj: Record<string, any>, legacy: Record<string, number> | undefined, out: Record<string, any>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (isComment(k) || DROP_KEYS.has(k)) continue;
    const f = legacy?.[k];
    if (f !== undefined && typeof v === 'number') out[k] = Math.round(v * f * 1e6) / 1e6;
    else out[k] = convertValue(v, k);
  }
}

/** Returns a new object; the input is not mutated (loader output is shared with the other extractors). */
export function prepareObject(obj: Record<string, any>): Record<string, any> {
  const legacy = legacyTable(obj.type);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isComment(k) || DROP_KEYS.has(k)) continue;
    if (k === 'name' && (typeof v === 'string' || isTranslation(v))) {
      out.name = translationText(v);
      out.name_plural = translationPlural(v);
      continue;
    }
    const f = legacy?.[k];
    if (f !== undefined && typeof v === 'number') {
      out[k] = Math.round(v * f * 1e6) / 1e6;
    } else if (legacy && k === 'relative' && isPlainObject(v)) {
      convertMembers(v, legacy, (out[k] = {}));
    } else if (legacy && ITEM_SLOT_OBJECTS.includes(k) && isPlainObject(v)) {
      convertMembers(v, k === 'book_data' ? { ...ITEM_LEGACY, time: 60 } : ITEM_LEGACY, (out[k] = {}));
    } else {
      out[k] = convertValue(v, k);
    }
  }
  return out;
}

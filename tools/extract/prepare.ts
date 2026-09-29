// Per-object preprocessing applied to raw CDDA JSON *before* inheritance resolution:
//  - drop translator/dev comments ("//", "//~", "//2", ...) and ascii art references
//  - convert quantity strings to numbers in base units
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
]);

// Keys that are quantities even without whitespace ("-25g"). Values with a space
// ("250 ml") are converted anywhere except NEVER_QUANTITY keys.
const QUANTITY_KEYS = new Set([
  'weight', 'volume', 'price', 'price_postapoc', 'longest_side', 'integral_volume', 'integral_weight',
  'integral_longest_side', 'barrel_length', 'barrel_volume', 'time', 'spoils_in', 'mass', 'max_volume',
  'max_contains_volume', 'max_contains_weight', 'min_item_volume', 'max_item_volume', 'max_item_length',
  'min_item_length', 'duration', 'energy', 'power_draw', 'capacity', 'folded_volume', 'keg_capacity',
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

/** Returns a new object; the input is not mutated (loader output is shared with the mapgen extractor). */
export function prepareObject(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isComment(k) || DROP_KEYS.has(k)) continue;
    if (k === 'name' && (typeof v === 'string' || isTranslation(v))) {
      out.name = translationText(v);
      out.name_plural = translationPlural(v);
      continue;
    }
    out[k] = convertValue(v, k);
  }
  return out;
}

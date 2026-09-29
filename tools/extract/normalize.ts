// Resolved Bright Nights objects -> the normalized shapes in src/data/types.ts.
//
// Philosophy: keep BN key names and pass through fields we don't specifically understand
// (after unit conversion), but give the fields runtime code leans on a single well-defined
// shape (arrays not "string or array", numbers not quantity strings, defaults filled in
// from the C++ loaders and Item_factory::finalize_pre). The item container / magazine /
// armor model is documented in src/data/types.ts and docs/BN_DATA_MODEL.md.

import type {
  ArmorPortion, BandolierData, ContainerData, DamageUnit, FurnitureDef, HolsterData, ItemDef, ItemGroupDef, MagazineData,
  MonsterDef, MonsterGroupDef, RecipeDef, TerrainDef,
} from '../../src/data/types';
import { ITEM_SLOT_OBJECTS, ITEM_TYPE_SLOTS, ownItemSlots } from './cdda';
import { normalizeGroupObject, normalizeGroupRef } from './itemgroup';
import { dedupeGroups, parseRequirementLists, parseUsing, RequirementResolver, type RawRequirement } from './requirements';

type Json = Record<string, any>;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Remove keys we never want in output (inheritance bookkeeping, translator notes). */
function strip(o: Json, extra: string[] = []): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'type' || k === 'copy-from' || k === 'abstract' || k === 'extend' || k === 'delete' || k === 'relative' || k === 'proportional') continue;
    if (extra.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number') throw new Error(`${what}: expected number, got ${JSON.stringify(v)}`);
  return v;
}

/** Seasonal arrays ([spring, summer, autumn, winter]) collapse to spring; the array is kept alongside. */
function glyph(o: Json, out: Json, defaultColor = 'white'): void {
  const sym = o.symbol;
  const col = o.color;
  if (Array.isArray(sym)) {
    out.symbol = sym[0];
    out.symbol_seasonal = sym;
  } else out.symbol = sym ?? '?';
  if (Array.isArray(col)) {
    out.color = col[0];
    out.color_seasonal = col;
  } else out.color = col ?? defaultColor;
}

// ---------------------------------------------------------------------------------------
// terrain / furniture

function bashInfo(b: Json | undefined): Json | undefined {
  if (!b) return undefined;
  const out: Json = { ...b };
  out.str_min = b.str_min ?? 0;
  out.str_max = b.str_max ?? 0;
  const items = normalizeGroupRef(b.items, 'collection');
  if (items !== undefined) out.items = items;
  return out;
}

function deconstructInfo(d: Json | undefined): Json | undefined {
  if (!d) return undefined;
  const out: Json = { ...d };
  const items = normalizeGroupRef(d.items, 'collection');
  if (items !== undefined) out.items = items;
  return out;
}

function mapDataCommon(o: Json): Json {
  const out: Json = strip(o, ['symbol', 'color', 'name_plural']);
  out.id = o.id;
  out.name = o.name ?? o.id;
  glyph(o, out);
  out.flags = asArray(o.flags);
  for (const k of ['connect_groups', 'connects_to', 'rotates_to']) if (o[k] !== undefined) out[k] = asArray(o[k]);
  if (o.bash) out.bash = bashInfo(o.bash);
  if (o.deconstruct) out.deconstruct = deconstructInfo(o.deconstruct);
  return out;
}

export function normalizeTerrain(o: Json): TerrainDef {
  const out = mapDataCommon(o);
  out.move_cost = o.move_cost ?? 100;
  return out as TerrainDef;
}

export function normalizeFurniture(o: Json): FurnitureDef {
  const out = mapDataCommon(o);
  out.move_cost_mod = o.move_cost_mod ?? 0;
  out.required_str = o.required_str ?? 0;
  return out as FurnitureDef;
}

// ---------------------------------------------------------------------------------------
// items (BN item_factory.cpp: load_basic_info + load(islot_*) + finalize_pre)

/** damage_instance JSON: a unit, an array of units, or {values: [...]}. */
export function damageUnits(v: unknown): DamageUnit[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.flatMap((x) => damageUnits(x) ?? []);
  if (v && typeof v === 'object') {
    const o = v as Json;
    if (Array.isArray(o.values)) return damageUnits(o.values);
    if (typeof o.damage_type === 'string') return [{ ...o, amount: o.amount ?? 0 } as DamageUnit];
  }
  throw new Error(`bad damage instance ${JSON.stringify(v)}`);
}

// calc_category (item_factory.cpp) when "category" is not set; MELEE_STAT is 5
function defaultCategory(slots: Set<string>, o: Json): string {
  if (slots.has('ARTIFACT')) return 'artifacts';
  if (slots.has('GUN') && !slots.has('GUNMOD')) return 'guns';
  if (slots.has('MAGAZINE')) return 'magazines';
  if (slots.has('AMMO')) return 'ammo';
  if (slots.has('TOOL')) return 'tools';
  if (slots.has('ARMOR')) return 'clothing';
  if (slots.has('COMESTIBLE')) return o.comestible_type === 'MED' ? 'drugs' : 'food';
  if (slots.has('BOOK')) return 'books';
  if (slots.has('GUNMOD')) return 'mods';
  if (slots.has('BIONIC_ITEM')) return 'bionics';
  return (o.bashing ?? 0) > 5 || (o.cutting ?? 0) > 5 ? 'weapons' : 'other';
}

// assign_coverage_from_json: "arms"/"arm_either" -> both arms (the _either forms make the
// item "sided"), legacy upper-case enum tokens ("TORSO", "ARM_L") lower-cased.
const PAIRS: Record<string, [string, string]> = { arms: ['arm_l', 'arm_r'], hands: ['hand_l', 'hand_r'], legs: ['leg_l', 'leg_r'], feet: ['foot_l', 'foot_r'] };
function parseCovers(v: unknown, id: string): { covers: string[]; sided: boolean } {
  const out: string[] = [];
  let sided = false;
  for (const raw of asArray(v as string | string[] | undefined)) {
    if (typeof raw !== 'string') throw new Error(`item ${id}: bad covers entry ${JSON.stringify(raw)}`);
    const s = raw.toLowerCase();
    const either = s.match(/^(arm|hand|leg|foot)_either$/);
    if (either) sided = true;
    const pair = PAIRS[s] ?? (either ? PAIRS[{ arm: 'arms', hand: 'hands', leg: 'legs', foot: 'feet' }[either[1]]!] : undefined);
    for (const p of pair ?? [s]) if (!out.includes(p)) out.push(p);
  }
  return { covers: out, sided };
}

function armorPortions(o: Json, id: string): { portions: ArmorPortion[]; sided: boolean } {
  let sided = false;
  const portion = (p: Json): ArmorPortion => {
    const c = parseCovers(p.covers, id);
    sided ||= c.sided;
    const enc: unknown = p.encumbrance;
    const [e, m] = Array.isArray(enc) ? enc : [enc ?? 0, p.max_encumbrance ?? enc ?? 0];
    return { covers: c.covers, coverage: p.coverage ?? 0, encumbrance: num(e, `item ${id} encumbrance`), max_encumbrance: num(m, `item ${id} max_encumbrance`) };
  };
  if (Array.isArray(o.armor_portion_data)) return { portions: o.armor_portion_data.map(portion), sided };
  return { portions: [portion(o)], sided };
}

// flags that set the clothing layer (finalize_pre), first match wins
const LAYER_FLAGS: [string, ItemDef['layer']][] = [
  ['PERSONAL', 'PERSONAL'], ['SKINTIGHT', 'UNDERWEAR'], ['WAIST', 'WAIST'], ['OUTER', 'OUTER'], ['BELTED', 'BELTED'], ['AURA', 'AURA'],
];

function useActions(v: unknown): Json[] {
  return asArray(v as unknown[] | undefined).map((u) => (typeof u === 'string' ? { type: u } : Array.isArray(u) ? { type: u[0] } : (u as Json)));
}

// Bulky, runtime-irrelevant fields. Keep this list short and obvious.
const ITEM_DROP = ['name_plural', 'symbol', 'color', 'type', '__slots', 'armor_portion_data', 'covers', 'coverage', 'encumbrance', 'max_encumbrance', 'snippet_category'];
// slot objects whose members BN loads into the same islot the flat form would; flattened
const FLATTEN = ['armor_data', 'pet_armor_data', 'book_data', 'gun_data', 'bionic_data', 'ammo_data', 'gunmod_data'];
const INVENTORY_HANDLING_PENALTY = 100;

/**
 * Normalize one resolved BN item (see ItemDef in src/data/types.ts). `warn` receives
 * non-fatal oddities (a slot object disagreeing with a flat member BN ignores).
 */
export function normalizeItem(o: Json, warn: (m: string) => void = () => {}): ItemDef {
  const id: string = o.id;
  const type: string = o.type;
  if (!ITEM_TYPE_SLOTS[type]) throw new Error(`item ${id}: unknown BN item type ${type}`);
  const slots = new Set<string>([...(o.__slots ?? []), ...ownItemSlots(o)]);
  const out: Json = strip(o, ITEM_DROP);
  delete out.container_data;
  // slot objects win over flat members of the same name: BN ignores flat members that the
  // item's own type does not read (a TOOL's flat "clip_size" next to its "gun_data")
  for (const k of FLATTEN) {
    const s = o[k];
    if (!s || typeof s !== 'object') continue;
    delete out[k];
    for (const [kk, vv] of Object.entries(s as Json)) {
      if (kk in out && JSON.stringify(out[kk]) !== JSON.stringify(vv)) warn(`item ${id}: ${k}.${kk} ${JSON.stringify(vv)} overrides flat ${JSON.stringify(out[kk])}`);
      out[kk] = vv;
    }
  }
  const f = out as Json; // flattened view
  out.id = id;
  out.type = type;
  out.subtypes = [...slots].sort();
  out.name = o.name ?? id;
  out.name_plural = o.name_plural ?? out.name + 's';
  glyph(o, out);
  out.weight = num(o.weight ?? 0, `item ${id} weight`);
  // finalize_pre: items always have some volume
  out.volume = Math.max(1, num(o.volume ?? 0, `item ${id} volume`));
  out.integral_volume = o.integral_volume ?? out.volume;
  out.integral_weight = o.integral_weight ?? out.weight;
  out.price = num(o.price ?? 0, `item ${id} price`);
  out.price_postapoc = o.price_postapoc ?? out.price;
  out.material = asArray<unknown>(o.material).map((m) => {
    if (typeof m !== 'string') throw new Error(`item ${id}: BN materials are plain ids, got ${JSON.stringify(m)}`);
    return m;
  });
  // flags: LIGHT_<n> becomes light_emission (finalize_pre), the rest verbatim
  const flags: string[] = [];
  for (const fl of asArray<string>(o.flags)) {
    const m = /^LIGHT_(\d+)$/.exec(fl);
    if (m && Number(m[1]) > 0) out.light_emission = Number(m[1]);
    else if (!flags.includes(fl)) flags.push(fl);
  }
  out.flags = flags;
  out.stackable = o.stackable ?? false;
  out.rigid = o.rigid ?? true;
  out.phase = o.phase ?? 'solid';
  if (!['solid', 'liquid', 'gas', 'plasma'].includes(out.phase)) throw new Error(`item ${id}: bad phase ${out.phase}`);

  // melee: BN's flat "bashing"/"cutting"; a STAB flag turns cutting into stabbing
  if (o.to_hit !== undefined && typeof o.to_hit !== 'number') throw new Error(`item ${id}: BN to_hit is an int, got ${JSON.stringify(o.to_hit)}`);
  out.to_hit = o.to_hit ?? 0;
  out.bashing = o.bashing ?? 0;
  out.cutting = o.cutting ?? 0;
  const md: Record<string, number> = {};
  if (out.bashing > 0) md.bash = out.bashing;
  if (out.cutting > 0) md[flags.includes('STAB') ? 'stab' : 'cut'] = out.cutting;
  out.melee_damage = md;
  out.thrown_damage = o.thrown_damage !== undefined ? damageUnits(o.thrown_damage) : [{ damage_type: 'bash', amount: out.bashing + out.weight / 1000 }];
  if (o.qualities !== undefined) {
    if (!Array.isArray(o.qualities) || !o.qualities.every((q: unknown) => Array.isArray(q) && typeof q[0] === 'string' && typeof q[1] === 'number')) {
      throw new Error(`item ${id}: bad qualities ${JSON.stringify(o.qualities)}`);
    }
  }
  out.qualities = o.qualities ?? [];
  if (o.techniques !== undefined) out.techniques = asArray(o.techniques);
  if (o.use_action !== undefined) {
    const uas = useActions(o.use_action);
    const h = uas.find((u) => u.type === 'holster');
    if (h) {
      const hd: HolsterData = {
        max_volume: num(h.max_volume ?? 0, `item ${id} holster max_volume`),
        min_volume: h.min_volume ?? Math.trunc((h.max_volume ?? 0) / 3),
        max_weight: h.max_weight ?? -1,
        multi: h.multi ?? 1,
        draw_cost: h.draw_cost ?? INVENTORY_HANDLING_PENALTY,
        flags: asArray(h.flags),
        skills: asArray(h.skills),
      };
      out.holster = hd;
    }
    const b = uas.find((u) => u.type === 'bandolier');
    if (b) out.bandolier = { capacity: b.capacity ?? 1, ammo: asArray(b.ammo), draw_cost: b.draw_cost ?? INVENTORY_HANDLING_PENALTY } satisfies BandolierData;
  }
  out.category = o.category ?? defaultCategory(slots, out);

  // --- ammo / magazines / charges
  for (const k of ['damage', 'ranged_damage', 'damage_modifier']) if (f[k] !== undefined) out[k] = damageUnits(f[k]);
  if (slots.has('AMMO')) {
    if (typeof f.ammo_type !== 'string') throw new Error(`item ${id}: AMMO without ammo_type`);
    out.count = f.count ?? 1;
    // finalize_pre: loudness derived from range/damage when unset (dB)
    if (f.loudness === undefined || f.loudness < 0) {
      if ((f.speed ?? 0) > 342) {
        let l = (f.range ?? 0) * 2;
        for (const u of out.damage ?? []) l += u.amount * 2 + (u.armor_penetration ?? 0);
        out.loudness = Math.min(191, 120 + Math.floor(20 * Math.log10(l)));
      } else out.loudness = 20;
    }
  }
  if (slots.has('MAGAZINE')) {
    const types = asArray<string>(f.ammo_type);
    if (!types.length) throw new Error(`item ${id}: MAGAZINE without ammo_type`);
    const mag: MagazineData = {
      ammo_type: types,
      capacity: f.capacity ?? 0,
      count: f.count ?? 0,
      default_ammo: f.default_ammo, // filled from ammunition_type.default in index.ts when unset
      reliability: f.reliability ?? 0,
      reload_time: f.reload_time ?? 100,
    };
    if (f.linkage) mag.linkage = f.linkage;
    if (f.reloads_like) mag.reloads_like = f.reloads_like;
    out.magazine = mag;
    out.ammo_type = types;
    // one source of truth: the flat members now live in `magazine`
    for (const k of ['capacity', 'default_ammo', 'reliability', 'reload_time', 'linkage', 'reloads_like']) delete out[k];
    if (!slots.has('AMMO')) delete out.count;
  }
  if (slots.has('GUN') || slots.has('TOOL')) {
    if (f.ammo !== undefined) out.ammo = asArray(f.ammo);
  }
  if (slots.has('TOOL')) {
    out.max_charges = f.max_charges ?? 0;
    out.initial_charges = f.initial_charges ?? 0;
    out.charges_per_use = f.charges_per_use ?? 0;
  }
  if (slots.has('GUN')) {
    out.clip_size = f.clip_size ?? 0;
    out.reload = f.reload ?? 100;
    if (f.barrel_length !== undefined) {
      // "barrel_length" is BN's deprecated alias of barrel_volume (a volume, not a length)
      out.barrel_volume ??= f.barrel_length;
      delete out.barrel_length;
    }
    // finalize_pre: DEFAULT mode always exists; legacy "burst" adds AUTO
    const modes: unknown[][] = Array.isArray(f.modes) ? f.modes.map((m: unknown[]) => [...m]) : [];
    const defName = slots.has('GUNMOD') ? 'gunmod' : out.clip_size === 1 ? 'manual' : f.skill === 'pistol' && flags.includes('RELOAD_ONE') ? 'revolver' : 'semi';
    if (!modes.some((m) => m[0] === 'DEFAULT')) modes.unshift(['DEFAULT', defName, 1]);
    if ((f.burst ?? 1) > 1 && !modes.some((m) => m[0] === 'AUTO')) modes.push(['AUTO', 'auto', f.burst]);
    out.modes = modes;
  }
  // magazines: [[ammo_type, [mag ids]]] -> map; the first listed is the default (load_basic_info)
  if (Array.isArray(o.magazines)) {
    const mags: Record<string, string[]> = {};
    const defaults: Record<string, string> = {};
    for (const e of o.magazines) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !Array.isArray(e[1])) throw new Error(`item ${id}: bad magazines entry ${JSON.stringify(e)}`);
      mags[e[0]] = [...new Set([...(mags[e[0]] ?? []), ...e[1]])];
      defaults[e[0]] ??= e[1][0];
    }
    out.magazines = mags;
    out.magazine_default = defaults;
  }
  out.magazine_well = o.magazine_well ?? 0;

  // --- containers
  let cd: ContainerData | undefined;
  const cSrc = slots.has('CONTAINER') ? (typeof o.container_data === 'object' ? o.container_data : o) : undefined;
  if (cSrc) {
    cd = {
      contains: num(cSrc.contains ?? 0, `item ${id} contains`),
      seals: cSrc.seals ?? false,
      watertight: cSrc.watertight ?? false,
      preserves: cSrc.preserves ?? false,
    };
    if (cSrc.unseals_into && cSrc.unseals_into !== 'null') cd.unseals_into = cSrc.unseals_into;
    out.container_data = cd;
    for (const k of ['contains', 'seals', 'watertight', 'preserves', 'unseals_into']) delete out[k];
  }

  // --- armor
  if (slots.has('ARMOR')) {
    const { portions, sided } = armorPortions(o.armor_data ? { ...o, ...o.armor_data } : o, id);
    out.armor = portions;
    out.sided = sided;
    out.storage = f.storage ?? 0;
    out.material_thickness = f.material_thickness ?? 0;
    out.environmental_protection = f.environmental_protection ?? 0;
    out.warmth = f.warmth ?? 0;
    out.weight_capacity_modifier = f.weight_capacity_modifier ?? 1;
    out.weight_capacity_bonus = f.weight_capacity_bonus ?? 0;
    out.layer = LAYER_FLAGS.find(([fl]) => flags.includes(fl))?.[1] ?? 'REGULAR';
  } else if (slots.has('PET_ARMOR')) {
    out.storage = f.storage ?? 0;
  }

  // --- count by charges (itype::count_by_charges) and stack size (finalize_pre)
  out.count_by_charges = out.stackable || slots.has('AMMO') || slots.has('COMESTIBLE');
  if (out.count_by_charges) {
    const chargesDefault = slots.has('TOOL') ? out.initial_charges : slots.has('COMESTIBLE') ? (f.charges ?? 1) : slots.has('AMMO') ? out.count : 1;
    const ss = f.stack_size ?? 0;
    out.stack_size = ss === 0 ? chargesDefault : Math.min(ss, 200);
  } else delete out.stack_size;

  // --- comestibles
  if (slots.has('COMESTIBLE')) {
    out.comestible_type = f.comestible_type;
    out.charges = f.charges ?? 1;
    if (f.nutrition !== undefined) {
      // islot_comestible::kcal_per_nutr = 2500 / 288; calories wins if both (BN throws)
      if (f.calories !== undefined) throw new Error(`item ${id}: both nutrition and calories`);
      out.calories = Math.trunc(f.nutrition * (2500 / (12 * 24)));
      delete out.nutrition;
    }
    out.calories ??= 0;
    out.quench ??= 0;
    out.fun ??= 0;
  }

  // --- books / bionics
  if (slots.has('BOOK') && out.martial_art === undefined && useActions(o.use_action).some((u) => u.type === 'MA_MANUAL') && id.startsWith('manual_')) {
    // finalize_pre HACK: legacy martial arts books name their style via the item id
    out.martial_art = 'style_' + id.slice(7);
  }
  if (slots.has('BIONIC_ITEM')) {
    // load(islot_bionic&): "bionic_id", else the item's own id
    out.bionic_id = f.bionic_id ?? id;
    out.difficulty = f.difficulty ?? 0;
  }
  for (const k of Object.keys(ITEM_SLOT_OBJECTS)) if (FLATTEN.includes(k)) delete out[k];
  return out as ItemDef;
}

// ---------------------------------------------------------------------------------------
// monsters (BN monstergenerator.cpp mtype::load + finalize_mtypes)

function specialAttack(v: unknown, id: string): Json {
  if (Array.isArray(v)) {
    if (typeof v[0] !== 'string') throw new Error(`monster ${id}: bad special attack ${JSON.stringify(v)}`);
    return { id: v[0], cooldown: v[1] ?? 0 };
  }
  if (v && typeof v === 'object') {
    const o = v as Json;
    // create_actor: "type" defaults to "monster_attack" (a named attack, "id" required);
    // other types (leap, melee, bite, gun, spell, ...) use "id" or their type as the key
    const type = o.type ?? 'monster_attack';
    const attackType = o.attack_type ?? type;
    const aid = o.id ?? attackType;
    if (attackType === 'monster_attack' && typeof o.id !== 'string') throw new Error(`monster ${id}: monster_attack without id`);
    return { ...o, id: aid, type: attackType };
  }
  throw new Error(`monster ${id}: bad special attack ${JSON.stringify(v)}`);
}

// armor_<x> members -> damage type ids (DT_HEAT is "heat"; armor_fire feeds it)
const MON_ARMOR: [string, string][] = [
  ['armor_bash', 'bash'], ['armor_cut', 'cut'], ['armor_stab', 'stab'], ['armor_bullet', 'bullet'], ['armor_acid', 'acid'],
  ['armor_fire', 'heat'], ['armor_cold', 'cold'], ['armor_electric', 'electric'], ['armor_dark', 'dark'], ['armor_light', 'light'], ['armor_psi', 'psi'],
];

export function normalizeMonster(o: Json, species: Record<string, Json> = {}): MonsterDef {
  const id: string = o.id;
  const out: Json = strip(o, ['symbol', 'color', ...MON_ARMOR.map(([k]) => k), 'melee_cut']);
  out.id = id;
  out.name = o.name ?? id;
  out.name_plural = o.name_plural ?? out.name + 's';
  glyph(o, out);
  // defaults from the mtype constructor (mtype.cpp) and mtype::load
  out.species = asArray(o.species);
  if (typeof o.default_faction !== 'string') throw new Error(`monster ${id}: missing default_faction`);
  out.volume = o.volume ?? 62499;
  out.weight = o.weight ?? 81499;
  out.hp = Math.max(1, o.hp ?? 1);
  out.speed = o.speed ?? 0;
  out.aggression = o.aggression ?? 0;
  out.morale = o.morale ?? 0;
  out.melee_skill = o.melee_skill ?? 0;
  out.melee_dice = o.melee_dice ?? 0;
  out.melee_dice_sides = o.melee_dice_sides ?? 0;
  out.dodge = o.dodge ?? 0;
  out.attack_cost = o.attack_cost ?? 100;
  out.vision_day = o.vision_day ?? 40;
  out.vision_night = o.vision_night ?? 1;
  out.luminance = o.luminance ?? 0;
  out.harvest = o.harvest ?? 'human';
  // flags: own, plus every species' flags (apply_species_attributes); same for triggers
  const flags = new Set(asArray<string>(o.flags));
  const trig: Record<string, Set<string>> = { anger_triggers: new Set(asArray(o.anger_triggers)), fear_triggers: new Set(asArray(o.fear_triggers)), placate_triggers: new Set(asArray(o.placate_triggers)) };
  for (const s of out.species) {
    const sp = species[s];
    if (!sp) continue;
    for (const fl of asArray<string>(sp.flags)) flags.add(fl);
    for (const [k, set] of Object.entries(trig)) for (const t of asArray<string>(sp[k])) set.add(t);
  }
  out.flags = [...flags];
  for (const [k, set] of Object.entries(trig)) if (set.size) out[k] = [...set];
  const md = damageUnits(o.melee_damage) ?? [];
  if (typeof o.melee_cut === 'number' && o.melee_cut) md.push({ damage_type: 'cut', amount: o.melee_cut });
  if (md.length) out.melee_damage = md;
  // armor: finalize_mtypes defaults stab to 0.8 * cut and acid to 0.5 * cut
  const armor: Record<string, number> = {};
  for (const [k, dt] of MON_ARMOR) armor[dt] = o[k] ?? -1;
  if (armor.stab < 0) armor.stab = Math.trunc(Math.max(0, armor.cut) * 0.8);
  if (armor.acid < 0) armor.acid = Math.trunc(Math.max(0, armor.cut) * 0.5);
  for (const k of Object.keys(armor)) if (armor[k] < 0) armor[k] = 0;
  out.armor = armor;
  const mats = asArray<any>(o.material);
  out.material = mats.length ? mats : ['flesh'];
  if (o.special_attacks) {
    // add_special_attack: a repeated attack id replaces the earlier one
    const byId = new Map<string, Json>();
    for (const a of asArray(o.special_attacks).map((x) => specialAttack(x, id))) {
      byId.delete(a.id);
      byId.set(a.id, a);
    }
    out.special_attacks = [...byId.values()];
  }
  // death_function: BN lists named mdeath functions (["NORMAL"] when empty) or an
  // "on_death" object with its own death_function list plus spawn_mon/spawn_mon_near
  const od = o.on_death && typeof o.on_death === 'object' ? o.on_death : undefined;
  const df = asArray<string>(od ? od.death_function : o.death_function);
  out.death_function = df.length || (od && (od.spawn_mon || od.spawn_mon_near)) ? df : ['NORMAL'];
  // "" is the null group id (no drops)
  if (o.death_drops !== undefined && o.death_drops !== '') out.death_drops = normalizeGroupRef(o.death_drops, 'distribution');
  else delete out.death_drops;
  if (o.upgrades === false) delete out.upgrades;
  return out as MonsterDef;
}

/**
 * MonsterGenerator::generate_fake_pseudo_dormant_monster (DDA): every GEN_DORMANT monster
 * gets a "pseudo_dormant_<id>" twin. BN core has no GEN_DORMANT monsters; kept so the
 * extractor stays total if data ever uses the flag.
 */
export function pseudoDormantMonster(m: MonsterDef): MonsterDef {
  const flags = ['DORMANT', 'QUIETDEATH', 'REVIVES', 'REVIVES_HEALTHY'];
  if (m.flags.includes('FILTHY')) flags.push('FILTHY');
  const d: MonsterDef = {
    ...structuredClone(m),
    id: 'pseudo_dormant_' + m.id,
    flags,
    zombify_into: m.id,
    looks_like: 'corpse_' + m.id,
    hp: 5,
    speed: 1,
    dodge: 0,
    regenerates: 0,
    regenerates_in_dark: false,
    armor: Object.fromEntries(Object.keys(m.armor ?? {}).map((k) => [k, 0])),
  };
  delete d.upgrades;
  delete d.special_attacks;
  return d;
}

/**
 * BN MonsterGroupManager::LoadMonsterGroup (mongroup.cpp): groups are keyed by "name"; a
 * repeated name *extends* the earlier group unless "override": true. Entries are monsters
 * only (no nested groups); "starts"/"ends" are hours (stored here as seconds);
 * freq_total defaults to 1000 (or the sum of freqs with "auto_total").
 */
export function normalizeMonsterGroups(objs: Json[]): Record<string, MonsterGroupDef> {
  const out: Record<string, MonsterGroupDef> = {};
  for (const o of objs) {
    const id: string = o.name;
    if (typeof id !== 'string') throw new Error(`monstergroup without "name": ${JSON.stringify(o).slice(0, 200)}`);
    const prev = out[id];
    const extending = !!prev && !o.override;
    const monsters = asArray<Json>(o.monsters).map((m) => {
      if (typeof m.monster !== 'string') throw new Error(`monstergroup ${id}: entry without monster ${JSON.stringify(m)}`);
      const e: Json = { ...m, weight: m.freq ?? 0, cost_multiplier: m.cost_multiplier ?? 0 };
      delete e.freq;
      if (m.pack_size !== undefined) e.pack_size = [m.pack_size[0], m.pack_size[1]];
      if (m.starts !== undefined) e.starts = m.starts * 3600;
      if (m.ends !== undefined) e.ends = m.ends * 3600;
      return e;
    });
    const g: Json = extending ? { ...prev, monsters: [...prev.monsters, ...monsters] } : { ...strip(o, ['name', 'name_plural', 'override', 'auto_total']), monsters };
    g.id = id;
    if (!extending || o.default !== undefined) {
      if (typeof o.default !== 'string') throw new Error(`monstergroup ${id}: missing "default"`);
      g.default = o.default;
    }
    g.is_animal = o.is_animal ?? false;
    g.freq_total = o.freq_total ?? (extending ? prev.freq_total : 1000);
    if (o.auto_total) g.freq_total = g.monsters.reduce((s: number, m: Json) => s + m.weight, 0);
    if (o.replacement_time !== undefined && typeof o.replacement_time === 'number' && !Number.isInteger(o.replacement_time)) {
      throw new Error(`monstergroup ${id}: bad replacement_time`);
    }
    out[id] = g as MonsterGroupDef;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// recipes & requirements

export function buildRequirementResolver(reqObjs: Json[], warn: (m: string) => void): { resolver: RequirementResolver; raw: Map<string, RawRequirement> } {
  const raw = new Map<string, RawRequirement>();
  for (const o of reqObjs) raw.set(o.id, parseRequirementLists(o, `requirement ${o.id}`));
  return { resolver: new RequirementResolver(raw, warn), raw };
}

function skillPairs(v: unknown): [string, number][] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`bad skills list ${JSON.stringify(v)}`);
  if (v.length === 0) return [];
  if (typeof v[0] === 'string') return [[v[0], v[1]]];
  return v as [string, number][];
}

/**
 * Recipe-like objects (recipe, uncraft) with requirements expanded (BN recipe::load +
 * finalize). `time` arrives in seconds (prepare.ts turns int moves into seconds).
 */
export function normalizeRecipe(o: Json, id: string, reqs: RequirementResolver): RecipeDef {
  const ctx = `${o.type} ${id}`;
  if (o.type !== 'recipe' && o.type !== 'uncraft') throw new Error(`${ctx}: not a recipe`);
  const out: Json = strip(o, ['using', 'name_plural']);
  out.id = id;
  out.type = o.type;
  const expanded = reqs.expand(parseRequirementLists(o, ctx), parseUsing(o.using, ctx), ctx);
  out.components = expanded.components;
  out.tools = expanded.tools;
  out.qualities = expanded.qualities;
  out.difficulty = o.difficulty ?? 0;
  out.time = num(o.time ?? 0, `${ctx} time`);
  out.result_mult = o.result_mult ?? 1;
  if (out.difficulty !== 0 && !o.skill_used) throw new Error(`${ctx}: non-zero difficulty without skill_used`);
  if (o.skills_required !== undefined) out.skills_required = skillPairs(o.skills_required);
  // autolearn: true -> skills_required + skill_used at difficulty (recipe::finalize)
  if (o.autolearn === true) {
    const req: [string, number][] = [...(out.skills_required ?? [])];
    if (o.skill_used) {
      const i = req.findIndex(([s]) => s === o.skill_used);
      if (i >= 0) req[i] = [o.skill_used, out.difficulty];
      else req.push([o.skill_used, out.difficulty]);
    }
    out.autolearn = req;
  } else if (Array.isArray(o.autolearn)) out.autolearn = skillPairs(o.autolearn);
  else out.autolearn = false;
  if (o.book_learn !== undefined) {
    // [[book, level?], ...]; a missing level is -1 ("use the recipe difficulty")
    out.book_learn = (o.book_learn as unknown[][]).map((b) => [b[0], b.length > 1 ? b[1] : -1]);
  }
  if (o.decomp_learn !== undefined) {
    out.decomp_learn = typeof o.decomp_learn === 'number' ? [[o.skill_used, o.decomp_learn]] : skillPairs(o.decomp_learn);
  }
  if (o.byproducts !== undefined) {
    // BN byproducts are [[id, count?], ...]; repeated ids add up
    const m = new Map<string, number>();
    for (const b of o.byproducts as unknown[]) {
      const [bid, n] = Array.isArray(b) ? [b[0], b.length === 2 ? b[1] : 1] : [b, 1];
      m.set(bid as string, (m.get(bid as string) ?? 0) + (n as number));
    }
    out.byproducts = [...m];
  }
  // "container" implies "contained"; recipe::finalize fills an unset container later
  if (o.container !== undefined) out.contained = true;
  out.contained = out.contained ?? false;
  if (o.type === 'uncraft') out.reversible = true;
  return out as RecipeDef;
}

export function normalizeConstruction(o: Json, reqs: RequirementResolver): Json {
  const ctx = `construction ${o.id}`;
  const out: Json = strip(o, ['using']);
  const expanded = reqs.expand(parseRequirementLists(o, ctx), parseUsing(o.using, ctx), ctx);
  out.components = expanded.components;
  out.tools = expanded.tools;
  out.qualities = expanded.qualities;
  if (o.required_skills !== undefined) out.required_skills = skillPairs(o.required_skills);
  if (o.byproducts !== undefined) out.byproducts = normalizeGroupRef(o.byproducts, 'collection');
  return out;
}

export function normalizeItemGroup(o: Json): ItemGroupDef {
  return normalizeGroupObject(o, 'old');
}

/**
 * BN profession::load "items": {both, male, female}, each either an item group (object) or
 * the legacy array of item ids / [id, snippet_id] pairs; arrays become collections.
 */
export function normalizeProfession(o: Json): Json {
  const out: Json = strip(o, ['name_plural']);
  if (o.items && typeof o.items === 'object') {
    const items: Json = {};
    for (const k of ['both', 'male', 'female'] as const) {
      const v = o.items[k];
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        items[k] = normalizeGroupObject({
          subtype: 'collection',
          entries: v.map((x: unknown) => {
            if (typeof x === 'string') return { item: x };
            if (Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string') return { item: x[0], snippet: x[1] };
            throw new Error(`profession ${o.id}: bad legacy item ${JSON.stringify(x)}`);
          }),
        }, 'collection');
      } else items[k] = normalizeGroupRef(v, 'collection');
    }
    out.items = items;
  }
  return out;
}

export { strip };

/** BN calc_category for a normalized item (finalize_pre uses it when the JSON category is unset or invalid). */
export function calcCategory(it: ItemDef): string {
  return defaultCategory(new Set(it.subtypes), it);
}

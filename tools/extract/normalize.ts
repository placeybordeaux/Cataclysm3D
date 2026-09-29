// Resolved CDDA objects -> the normalized shapes in src/data/types.ts.
//
// Philosophy: keep CDDA key names and pass through fields we don't specifically
// understand (after unit conversion), but give the fields runtime code leans on a single
// well-defined shape (arrays not "string or array", numbers not quantity strings, defaults
// filled in from the C++ loaders).

import type {
  DamageUnit, FurnitureDef, ItemDef, ItemGroupDef, MonsterDef, MonsterGroupDef, RecipeDef, TerrainDef,
} from '../../src/data/types';
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
// items

const SUBTYPE_PRIORITY = ['GUN', 'GUNMOD', 'AMMO', 'MAGAZINE', 'COMESTIBLE', 'BOOK', 'BIONIC_ITEM', 'TOOL', 'ARMOR', 'PET_ARMOR', 'TOOLMOD', 'ENGINE', 'WHEEL'];

// item_factory.cpp melee_accuracy: base -2 plus enum offsets
const GRIP = { bad: 0, none: 1, solid: 2, weapon: 3 } as Record<string, number>;
const LENGTH = { hand: 0, short: 1, long: 2 } as Record<string, number>;
const SURFACE = { point: 0, line: 1, any: 2, every: 3 } as Record<string, number>;
const BALANCE = { clumsy: 0, uneven: 1, neutral: 2, good: 3 } as Record<string, number>;

export function toHit(v: unknown, id: string): number {
  if (v === undefined) return -2;
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const o = v as Json;
    const pick = (table: Record<string, number>, key: string, dflt: string) => {
      const val = table[o[key] ?? dflt];
      if (val === undefined) throw new Error(`item ${id}: bad to_hit.${key} ${o[key]}`);
      return val;
    };
    return -2 - 1 - 2 - 2 + pick(GRIP, 'grip', 'weapon') + pick(LENGTH, 'length', 'hand') + pick(SURFACE, 'surface', 'any') + pick(BALANCE, 'balance', 'neutral');
  }
  throw new Error(`item ${id}: bad to_hit ${JSON.stringify(v)}`);
}

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

// item::get_category_shallow fallback when "category" is not set
function defaultCategory(o: Json, subtypes: string[]): string {
  const has = (s: string) => subtypes.includes(s);
  if (has('GUN')) return 'guns';
  if (has('MAGAZINE')) return 'magazines';
  if (has('AMMO')) return 'ammo';
  if (has('TOOL')) return 'tools';
  if (has('ARMOR')) return 'clothing';
  if (has('COMESTIBLE')) return o.comestible_type === 'MED' ? 'drugs' : 'food';
  if (has('BOOK')) return 'books';
  if (has('GUNMOD')) return 'mods';
  if (has('BIONIC_ITEM')) return 'bionics';
  return 'other';
}

// Bulky, runtime-irrelevant fields. Keep this list short and obvious.
const ITEM_DROP = ['name_plural', 'symbol', 'color', 'nanofab_template_group', 'template_requirements'];

export function normalizeItem(o: Json): ItemDef {
  const id: string = o.id;
  const subtypes: string[] = asArray(o.subtypes);
  const out: Json = strip(o, ITEM_DROP);
  out.id = id;
  out.type = SUBTYPE_PRIORITY.find((s) => subtypes.includes(s)) ?? 'GENERIC';
  out.subtypes = subtypes;
  out.name = o.name ?? id;
  out.name_plural = o.name_plural ?? out.name + 's';
  glyph(o, out);
  out.weight = o.weight ?? 0;
  out.volume = o.volume ?? 0;
  num(out.weight, `item ${id} weight`);
  num(out.volume, `item ${id} volume`);
  if (o.price !== undefined) num(o.price, `item ${id} price`);
  out.category = o.category ?? defaultCategory(o, subtypes);
  // material: ["wood"] or [{type, portion}] -> ids, with portions only when uneven
  const mats = asArray<any>(o.material);
  out.material = mats.map((m) => (typeof m === 'string' ? m : m.type));
  if (mats.some((m) => typeof m === 'object' && (m.portion ?? 1) !== 1)) {
    out.material_portions = Object.fromEntries(mats.map((m) => (typeof m === 'string' ? [m, 1] : [m.type, m.portion ?? 1])));
  }
  out.flags = asArray(o.flags);
  const md: Json = o.melee_damage ?? {};
  if (Object.keys(md).length) {
    out.melee_damage = md;
    if (md.bash) out.bashing = md.bash;
    if (md.cut || md.stab) out.cutting = Math.max(md.cut ?? 0, md.stab ?? 0);
  } else delete out.melee_damage;
  out.to_hit = toHit(o.to_hit, id);
  for (const k of ['damage', 'ranged_damage', 'thrown_damage', 'shot_damage']) {
    if (o[k] !== undefined) out[k] = damageUnits(o[k]);
  }
  if (o.ammo !== undefined) out.ammo = asArray(o.ammo);
  if (o.ammo_type !== undefined) out.ammo_type = asArray(o.ammo_type)[0];
  if (Array.isArray(o.ammo_type) && o.ammo_type.length > 1) out.ammo_types = o.ammo_type;
  if (o.variants) {
    // variant descriptions are long flavour text; the game only needs names/weights
    out.variants = o.variants.map((v: Json) => {
      const { description: _d, ...rest } = v;
      return rest;
    });
  }
  return out as ItemDef;
}

// ---------------------------------------------------------------------------------------
// monsters

function specialAttack(v: unknown, id: string): Json {
  if (Array.isArray(v)) return { id: v[0], cooldown: v[1] };
  if (v && typeof v === 'object') {
    const o = v as Json;
    return { ...o, id: o.id ?? o.type };
  }
  throw new Error(`monster ${id}: bad special attack ${JSON.stringify(v)}`);
}

export function normalizeMonster(o: Json): MonsterDef {
  const id: string = o.id;
  const out: Json = strip(o, ['symbol', 'color']);
  out.id = id;
  out.name = o.name ?? id;
  out.name_plural = o.name_plural ?? out.name + 's';
  glyph(o, out);
  // defaults from mtype::load (monstergenerator.cpp)
  out.species = asArray(o.species);
  if (typeof o.default_faction !== 'string') throw new Error(`monster ${id}: missing default_faction`);
  out.volume = o.volume ?? 62499;
  out.weight = o.weight ?? 81499;
  out.hp = o.hp ?? 1;
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
  out.flags = asArray(o.flags);
  const md = damageUnits(o.melee_damage);
  if (md) out.melee_damage = md;
  const mats = asArray<any>(o.material);
  out.material = mats.length ? mats.map((m) => (typeof m === 'string' ? m : m.type)) : ['flesh'];
  if (o.special_attacks) out.special_attacks = asArray(o.special_attacks).map((a) => specialAttack(a, id));
  // "" is the null group id (no drops)
  if (o.death_drops !== undefined && o.death_drops !== '') out.death_drops = normalizeGroupRef(o.death_drops, 'distribution');
  else delete out.death_drops;
  if (o.upgrades === false) delete out.upgrades;
  return out as MonsterDef;
}

/**
 * MonsterGenerator::generate_fake_pseudo_dormant_monster: every GEN_DORMANT monster gets a
 * "pseudo_dormant_<id>" twin that lies as a corpse and revives into the original.
 * Monster groups reference these ids directly.
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
    special_attacks: [{
      id: 'pseudo_dormant_trap_setup_attk',
      type: 'spell',
      spell_data: { id: 'pseudo_dormant_trap_setup', hit_self: true },
      cooldown: 1,
      allow_no_target: true,
      monster_message: '',
    }],
  };
  delete d.upgrades;
  return d;
}

// monstergroups with a repeated id extend the earlier one unless "override": true (mongroup.cpp)
export function normalizeMonsterGroups(objs: Json[]): Record<string, MonsterGroupDef> {
  const out: Record<string, MonsterGroupDef> = {};
  for (const o of objs) {
    const id: string = o.id;
    const prev = out[id];
    const monsters = asArray<Json>(o.monsters).map((m) => {
      const e: Json = { ...m };
      if (e.freq !== undefined) {
        e.weight = e.freq;
        delete e.freq;
      }
      e.weight ??= 1;
      return e;
    });
    const g: Json = prev && !o.override ? { ...prev, monsters: [...prev.monsters, ...monsters] } : strip(o);
    if (!(prev && !o.override)) g.monsters = monsters;
    g.id = id;
    if (o.default !== undefined) g.default = o.default;
    out[id] = g as MonsterGroupDef;
  }
  // default monster: explicit, else the highest-weight non-event monster entry
  for (const g of Object.values(out)) {
    if (g.default !== undefined) continue;
    let best: { id?: string; w: number } = { w: 0 };
    for (const m of g.monsters) if (m.monster && !m.event && (m.weight ?? 1) > best.w) best = { id: m.monster, w: m.weight ?? 1 };
    if (best.id) g.default = best.id;
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

function byproducts(v: unknown): [string, number][] | undefined {
  if (v === undefined) return undefined;
  return (v as unknown[]).map((b) => (Array.isArray(b) ? [b[0], b[1] ?? 1] : [b as string, 1]));
}

/** Recipe-like objects (recipe, uncraft, practice) with requirements expanded. */
export function normalizeRecipe(o: Json, id: string, reqs: RequirementResolver): RecipeDef {
  const ctx = `${o.type} ${id}`;
  const out: Json = strip(o, ['using', 'name_plural']);
  out.id = id;
  const expanded = reqs.expand(parseRequirementLists(o, ctx), parseUsing(o.using, ctx), ctx);
  out.components = expanded.components;
  out.tools = expanded.tools;
  out.qualities = expanded.qualities;
  out.difficulty = o.difficulty ?? 0;
  out.time = o.time ?? 0;
  if (o.skills_required !== undefined) out.skills_required = skillPairs(o.skills_required);
  if (o.byproducts !== undefined) out.byproducts = byproducts(o.byproducts);
  if (o.byproduct_group !== undefined) out.byproduct_group = normalizeGroupRef(o.byproduct_group, 'collection');
  if (Array.isArray(o.steps)) {
    // step recipes: time and tools/qualities live on the steps; also expose the totals
    let time = 0;
    out.steps = o.steps.map((s: Json, i: number) => {
      const sctx = `${ctx} step ${i}`;
      const se = reqs.expand(parseRequirementLists({ tools: s.tools, qualities: s.qualities }, sctx), parseUsing(s.using, sctx), sctx);
      time += num(s.time, `${sctx} time`);
      const step: Json = { ...s, tools: se.tools, qualities: se.qualities };
      delete step.using;
      if (se.components.length) step.components = se.components;
      return step;
    });
    out.time = time;
    out.tools = dedupeGroups([...out.tools, ...out.steps.flatMap((s: Json) => s.tools)]);
    out.qualities = dedupeGroups([...out.qualities, ...out.steps.flatMap((s: Json) => s.qualities)]);
    const stepComps = out.steps.flatMap((s: Json) => s.components ?? []);
    if (stepComps.length) out.components = [...out.components, ...stepComps];
  }
  num(out.time, `${ctx} time`);
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

export function normalizeProfession(o: Json): Json {
  const out: Json = strip(o, ['name_plural']);
  if (o.items && typeof o.items === 'object') {
    const items: Json = {};
    for (const k of ['both', 'male', 'female'] as const) {
      const v = o.items[k];
      if (v === undefined) continue;
      // legacy array form: item ids or [id, count]... read by item_reader; convert to entries
      if (Array.isArray(v)) {
        items[k] = normalizeGroupObject({
          subtype: 'collection',
          entries: v.map((x: unknown) => (typeof x === 'string' ? { item: x } : Array.isArray(x) ? { item: x[0], count: x[1] ?? 1 } : x)),
        }, 'collection');
      } else items[k] = normalizeGroupRef(v, 'collection');
    }
    out.items = items;
  }
  return out;
}

export { strip };

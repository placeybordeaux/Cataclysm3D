// CDDA JSON -> public/data/*.json. Run via `npm run extract` (see --help).
//
// Pipeline: load raw JSON (cdda.ts) -> per-object prep: comments, units, translations
// (prepare.ts) -> copy-from resolution per type family (cdda.ts) -> per-type
// normalization (normalize.ts) -> reference validation -> write.
//
// Mapgen-family types are deliberately skipped; tools/extract/mapgen.ts owns them.

import fs from 'node:fs';
import path from 'node:path';
import { defaultCddaDir, FAMILY_HOOKS, familyOf, loadCddaObjects, objectIds, resolveFamily, type CddaObject } from './cdda';
import { prepareObject } from './prepare';
import {
  buildRequirementResolver, normalizeConstruction, normalizeFurniture, normalizeItem, normalizeItemGroup, normalizeMonster,
  normalizeMonsterGroups, normalizeProfession, pseudoDormantMonster, normalizeRecipe, normalizeTerrain, strip,
} from './normalize';
import { migrateGroup, normalizeGroupRef, referencedIds, type ItemMigration } from './itemgroup';

const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
import type { GameData, ItemGroupRef, RecipeStep, RequirementData } from '../../src/data/types';

// Owned by the mapgen extractor, or irrelevant to this game (NPC dialogue, UI widgets...).
export const MAPGEN_TYPES = [
  'mapgen', 'palette', 'overmap_terrain', 'overmap_special', 'city_building', 'region_settings', 'overmap_location',
  'overmap_connection', 'overmap_land_use_code', 'oter_vision', 'map_extra', 'map_extra_collection', 'region_terrain_furniture',
  'region_settings_terrain_furniture', 'region_settings_ravine', 'region_settings_map_extras', 'region_settings_forest_mapgen',
  'region_settings_city', 'region_settings_river', 'region_settings_lake', 'region_settings_ocean', 'region_settings_highway',
  'region_settings_forest', 'region_settings_forest_trail', 'forest_biome_component', 'forest_biome_mapgen', 'weather_generator',
  'dimension', 'dimension_region_layout', 'omt_placeholder', 'overmap_special_migration', 'oter_id_migration', 'nested_mapgen',
  'update_mapgen', 'vehicle_placement', 'vehicle_spawn',
];
// Owned by tools/extract/vehicles.ts (public/data/vehicles.json, with CDDA's "parts append"
// copy-from rule and slimmed parts); nothing at runtime reads them from misc.
export const VEHICLE_TYPES = ['vehicle', 'vehicle_part', 'vehicle_group', 'vehicle_part_category', 'vehicle_part_location'];
const IGNORED_TYPES = [
  'talk_topic', 'npc', 'npc_class', 'widget', 'mission_definition', 'faction_mission', 'effect_on_condition', 'event_transformation',
  'event_statistic', 'achievement', 'conduct', 'score', 'jmath_function', 'camp_migration', 'var_migration', 'overlay_order',
  'body_graph', 'mood_face', 'shopkeeper_blacklist', 'shopkeeper_consumption_rates', 'charge_removal_blacklist',
  'temperature_removal_blacklist', 'SCENARIO_BLACKLIST', 'MONSTER_BLACKLIST', 'LOOT_ZONE', 'faction', 'behavior', 'pp_generator',
  'relic_procgen_data', 'skill_display_type', 'zone_type', 'ascii_art', 'monster_flag', 'end_screen', 'trap_migration',
  'effect_migration', 'vehicle_part_migration', 'proficiency_migration', 'TRAIT_MIGRATION',
];

// CDDA type -> misc key. Anything loaded that is neither here, nor a primary output, nor
// ignored makes the extractor fail, so new CDDA types get a conscious decision.
const MISC: Record<string, string> = {
  material: 'material', requirement: 'requirement', tool_quality: 'tool_quality', ammunition_type: 'ammunition_type',
  profession: 'profession', profession_group: 'profession_group', profession_item_substitutions: 'profession_item_substitutions',
  scenario: 'scenario', start_location: 'start_location', mutation: 'mutation', mutation_category: 'mutation_category',
  mutation_type: 'mutation_type', trait_group: 'trait_group', effect_type: 'effect_type', martial_art: 'martial_art',
  technique: 'technique', harvest: 'harvest', harvest_drop_type: 'harvest_drop_type', butchery_requirement: 'butchery_requirement',
  field_type: 'field_type', trap: 'trap', construction: 'construction', construction_group: 'construction_group',
  construction_category: 'construction_category', body_part: 'body_part', sub_body_part: 'sub_body_part', anatomy: 'anatomy',
  limb_score: 'limb_score', character_mod: 'character_mod', skill: 'skill', ITEM_CATEGORY: 'item_category',
  MONSTER_FACTION: 'monster_faction', SPECIES: 'species', snippet: 'snippet',
  bionic: 'bionic', proficiency: 'proficiency', proficiency_category: 'proficiency_category', fault: 'fault', fault_fix: 'fault_fix',
  fault_group: 'fault_group', morale_type: 'morale_type', addiction_type: 'addiction_type', practice: 'practice',
  nested_category: 'nested_category', recipe_category: 'recipe_category', recipe_group: 'recipe_group', uncraft: 'uncraft',
  item_action: 'item_action', emit: 'emit', speech: 'speech', dream: 'dream', vitamin: 'vitamin', weather_type: 'weather_type',
  damage_type: 'damage_type', damage_info_order: 'damage_info_order', ammo_effect: 'ammo_effect', json_flag: 'json_flag',
  movement_mode: 'movement_mode', weakpoint_set: 'weakpoint_set', monster_attack: 'monster_attack', SPELL: 'spell',
  enchantment: 'enchantment', gate: 'gate', ter_furn_transform: 'ter_furn_transform', connect_group: 'connect_group',
  rotatable_symbol: 'rotatable_symbol', weapon_category: 'weapon_category', clothing_mod: 'clothing_mod',
  scent_type: 'scent_type', bash_damage_profile: 'bash_damage_profile', activity_type: 'activity_type',
  climbing_aid: 'climbing_aid', attack_vector: 'attack_vector', hit_range: 'hit_range', speed_description: 'speed_description',
  disease_type: 'disease_type', MIGRATION: 'item_migration', ter_furn_migration: 'ter_furn_migration',
};
const PRIMARY = ['terrain', 'furniture', 'ITEM', 'item_group', 'MONSTER', 'monstergroup', 'recipe'];

interface Args { dryRun: boolean; out: string; cdda: string; quiet: boolean }

function usage(): string {
  return `Usage: npm run extract -- [options]

Convert CDDA core JSON into normalized public/data/*.json.

Options:
  --cdda <dir>   Cataclysm-DDA checkout (default: $CDDA_DIR or ~/code/Cataclysm-DDA)
  --out <dir>    output directory (default: public/data)
  --dry-run      do everything except writing files
  --quiet        only print errors
  -h, --help     show this help`;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, out: 'public/data', cdda: defaultCddaDir(), quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '-h' || k === '--help') {
      console.log(usage());
      process.exit(0);
    } else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--cdda') a.cdda = argv[++i];
    else throw new Error(`unknown argument ${k}\n\n${usage()}`);
  }
  return a;
}

export function extract(cddaDir: string, log: (m: string) => void = console.log): { data: GameData; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const raw = loadCddaObjects(cddaDir, { excludeTypes: [...MAPGEN_TYPES, ...VEHICLE_TYPES, ...IGNORED_TYPES] });

  const unknownTypes = [...raw.keys()].filter((t) => !MISC[t] && !PRIMARY.includes(familyOf(t)) && familyOf(t) !== 'recipe');
  if (unknownTypes.length) throw new Error(`unclassified CDDA types (add to MISC or IGNORED_TYPES in tools/extract/index.ts): ${unknownTypes.join(', ')}`);

  // group into inheritance families (legacy item types -> ITEM; recipe/practice/nested_category -> recipe)
  const families = new Map<string, CddaObject[]>();
  for (const [type, list] of raw) {
    const fam = familyOf(type);
    let l = families.get(fam);
    if (!l) families.set(fam, (l = []));
    l.push(...list);
  }
  const resolved = new Map<string, Map<string, CddaObject>>();
  for (const [fam, list] of families) {
    if (fam === 'monstergroup') continue; // custom extend-by-default semantics, see normalizeMonsterGroups
    const withIds = list.filter((o) => objectIds(o).length > 0);
    const r = resolveFamily(withIds, FAMILY_HOOKS[fam] ?? {}, prepareObject);
    resolved.set(fam, r.byId);
    if (r.duplicates.length) warn(`${fam}: ${r.duplicates.length} ids defined more than once (last wins): ${r.duplicates.slice(0, 5).join(', ')}`);
  }
  const fam = (f: string) => resolved.get(f) ?? new Map<string, CddaObject>();

  // --- primary outputs
  const terrain: GameData['terrain'] = {};
  for (const [id, o] of fam('terrain')) terrain[id] = normalizeTerrain(o);
  const furniture: GameData['furniture'] = {};
  for (const [id, o] of fam('furniture')) furniture[id] = normalizeFurniture(o);
  const items: GameData['items'] = {};
  for (const [id, o] of fam('ITEM')) items[id] = normalizeItem(o);
  const itemGroups: GameData['itemGroups'] = {};
  for (const [id, o] of fam('item_group')) itemGroups[id] = normalizeItemGroup(o);
  // built into the C++ (item_group.cpp), referenced by JSON
  itemGroups.EMPTY_GROUP ??= { id: 'EMPTY_GROUP', subtype: 'collection', entries: [] };
  const monsters: GameData['monsters'] = {};
  for (const [id, o] of fam('MONSTER')) monsters[id] = normalizeMonster(o);
  for (const m of Object.values(monsters)) {
    if (m.flags.includes('GEN_DORMANT')) {
      const d = pseudoDormantMonster(m);
      monsters[d.id] = d;
    }
  }
  const monsterGroups = normalizeMonsterGroups((raw.get('monstergroup') ?? []).map(prepareObject));

  const { resolver } = buildRequirementResolver([...fam('requirement').values()], warn);
  const recipes: GameData['recipes'] = [];
  const misc: GameData['misc'] = {};
  const miscPut = (key: string, id: string, v: unknown) => ((misc[key] ??= {})[id] = v);
  for (const [id, o] of fam('recipe')) {
    if (o.obsolete) continue;
    if (o.type === 'recipe') recipes.push(normalizeRecipe(o, id, resolver));
    else if (o.type === 'practice') miscPut('practice', id, normalizeRecipe(o, id, resolver));
    else miscPut(o.type, id, strip(o, ['name_plural']));
  }
  for (const [id, o] of fam('uncraft')) miscPut('uncraft', id, normalizeRecipe(o, id, resolver));
  // requirement defs with their own LIST references inlined (same as CDDA's finalize)
  for (const [id, o] of fam('requirement')) miscPut('requirement', id, { id, name: o.name, ...resolver.expand(resolver.get(id)!, [], `requirement ${id}`) });
  for (const [id, o] of fam('construction')) miscPut('construction', id, normalizeConstruction(o, resolver));
  for (const [id, o] of fam('profession')) miscPut('profession', id, normalizeProfession(o));

  // --- everything else in misc
  const handled = new Set(['profession_item_substitutions', 'recipe', 'practice', 'nested_category', 'uncraft', 'requirement', 'construction', 'profession', 'snippet', 'speech', 'dream']);
  for (const [type, key] of Object.entries(MISC)) {
    if (handled.has(type) || !raw.has(type)) continue;
    const f = familyOf(type);
    const byId = resolved.get(f);
    if (!byId) continue;
    for (const [id, o] of byId) {
      if (o.type !== type) continue;
      // name_plural is only meaningful for items and monsters
      miscPut(key, id, strip(o, ['name_plural']));
    }
    const idless = (raw.get(type) ?? []).filter((o) => objectIds(o).length === 0);
    if (idless.length) warn(`${type}: ${idless.length} objects without id skipped`);
  }
  // id-less types
  for (const o of (raw.get('snippet') ?? []).map(prepareObject)) {
    const texts = (Array.isArray(o.text) ? o.text : [o.text]).map((t: any) => (typeof t === 'string' ? t : t.text));
    const cat: string = o.category ?? o.id;
    ((misc.snippet ??= {})[cat] ??= []).push(...texts);
  }
  for (const o of (raw.get('speech') ?? []).map(prepareObject)) {
    const { type: _t, speaker, ...rest } = o;
    for (const s of Array.isArray(speaker) ? speaker : [speaker]) ((misc.speech ??= {})[s] ??= []).push(rest);
  }
  // profession_item_substitutions are keyed by item, by trait, or are trait-conditional
  // bonus groups: "item:<id>" / "trait:<id>" (subs concatenated) / "bonus:<n>"
  const subs: Record<string, any> = (misc.profession_item_substitutions = {});
  (raw.get('profession_item_substitutions') ?? []).map(prepareObject).forEach((o, i) => {
    if (o.item || o.trait) {
      const key = o.item ? `item:${o.item}` : `trait:${o.trait}`;
      (subs[key] ??= []).push(...asArr(o.sub));
    } else if (o.group) {
      subs[`bonus:${i}`] = { group: normalizeGroupRef(o.group, 'collection'), bonus: o.bonus };
    } else throw new Error(`profession_item_substitutions without item/trait/group: ${JSON.stringify(o)}`);
  });
  for (const o of (raw.get('dream') ?? []).map(prepareObject)) {
    const { type: _t, ...rest } = o;
    ((misc.dream ??= {})[o.category] ??= []).push(rest);
  }

  const data: GameData = { terrain, furniture, items, itemGroups, monsters, monsterGroups, recipes, misc };
  applyMigrations(data, raw.get('MIGRATION') ?? []);
  validate(data, warn);
  log(`resolved: ${Object.keys(items).length} items, ${Object.keys(monsters).length} monsters, ${Object.keys(terrain).length} terrain, ` +
    `${Object.keys(furniture).length} furniture, ${Object.keys(itemGroups).length} item groups, ${recipes.length} recipes, ` +
    `${Object.keys(misc).length} misc types`);
  return { data, warnings };
}

// Item_factory::finalize replaces obsolete item ids in all item groups and requirements
// with their MIGRATION target (only unambiguous, non-variant-specific migrations).
function applyMigrations(d: GameData, migrations: CddaObject[]): void {
  // Item_factory::add_migration: a later non-from_variant entry overwrites an earlier one;
  // from_variant entries only apply to existing item instances, not templates
  const mig = new Map<string, ItemMigration>();
  for (const m of migrations) {
    if (m.from_variant) continue;
    for (const id of objectIds(m)) {
      if (typeof m.replace !== 'string') mig.delete(id);
      else mig.set(id, m.variant ? { replace: m.replace, variant: m.variant } : { replace: m.replace });
    }
  }
  for (const [id, m] of mig) if (!d.items[m.replace]) mig.delete(id);
  const reqs = (r: Partial<RequirementData> | undefined) => {
    for (const k of ['components', 'tools'] as const) {
      for (const alts of r?.[k] ?? []) for (const c of alts) c.id = mig.get(c.id)?.replace ?? c.id;
    }
  };
  for (const g of Object.values(d.itemGroups)) migrateGroup(g, mig);
  for (const t of [...Object.values(d.terrain), ...Object.values(d.furniture)]) {
    migrateGroup(t.bash?.items, mig);
    migrateGroup(t.deconstruct?.items, mig);
  }
  for (const m of Object.values(d.monsters)) migrateGroup(m.death_drops, mig);
  for (const p of Object.values(d.misc.profession ?? {})) for (const v of Object.values(p.items ?? {})) migrateGroup(v as ItemGroupRef, mig);
  for (const r of [...d.recipes, ...Object.values(d.misc.uncraft ?? {}), ...Object.values(d.misc.practice ?? {})]) {
    reqs(r);
    r.steps?.forEach((s: RecipeStep) => reqs(s));
    migrateGroup(r.byproduct_group, mig);
  }
  for (const c of Object.values(d.misc.construction ?? {})) {
    reqs(c);
    migrateGroup(c.byproducts, mig);
  }
  for (const r of Object.values(d.misc.requirement ?? {})) reqs(r);
  // recipes producing an obsolete item (kept in CDDA so old saves can finish crafts)
  d.recipes = d.recipes.filter((r) => !mig.has(r.result));
}

// Reference checks. CDDA core data should be self-consistent; a dangling id almost always
// means our resolution is wrong, so these are reported loudly (and fail the run).
function validate(d: GameData, warn: (m: string) => void): void {
  const errors: string[] = [];
  const itemRefs = new Map<string, string>();
  const groupRefs = new Map<string, string>();
  const check = (ref: ItemGroupRef | undefined, ctx: string) => {
    if (ref === undefined) return;
    const is = new Set<string>();
    const gs = new Set<string>();
    referencedIds(ref, is, gs);
    for (const i of is) if (!itemRefs.has(i)) itemRefs.set(i, ctx);
    for (const g of gs) if (!groupRefs.has(g)) groupRefs.set(g, ctx);
  };
  for (const [id, g] of Object.entries(d.itemGroups)) check(g, `item_group ${id}`);
  for (const t of [...Object.values(d.terrain), ...Object.values(d.furniture)]) {
    check(t.bash?.items, `${t.id} bash`);
    check(t.deconstruct?.items, `${t.id} deconstruct`);
  }
  for (const m of Object.values(d.monsters)) check(m.death_drops, `${m.id} death_drops`);
  for (const p of Object.values(d.misc.profession ?? {})) for (const v of Object.values(p.items ?? {})) check(v as ItemGroupRef, `profession ${p.id}`);
  for (const [i, ctx] of itemRefs) if (!d.items[i] && i !== 'corpse') errors.push(`${ctx}: unknown item ${i}`);
  for (const [g, ctx] of groupRefs) if (!d.itemGroups[g]) errors.push(`${ctx}: unknown item group ${g}`);
  for (const r of d.recipes) {
    // faction camp blueprints "result" in a blueprint name, not an item
    if (r.result && !r.construction_blueprint && r.category !== 'CC_BUILDING' && !d.items[r.result]) errors.push(`recipe ${r.id}: unknown result ${r.result}`);
    for (const alts of r.components) for (const c of alts) if (!d.items[c.id]) errors.push(`recipe ${r.id}: unknown component ${c.id}`);
    for (const alts of r.tools) for (const c of alts) if (!d.items[c.id]) errors.push(`recipe ${r.id}: unknown tool ${c.id}`);
  }
  for (const g of Object.values(d.monsterGroups)) {
    for (const m of g.monsters) {
      if (m.monster && !d.monsters[m.monster] && m.monster !== 'mon_null') errors.push(`monstergroup ${g.id}: unknown monster ${m.monster}`);
      if (m.group && !d.monsterGroups[m.group]) errors.push(`monstergroup ${g.id}: unknown group ${m.group}`);
    }
  }
  for (const t of Object.values(d.terrain)) {
    for (const k of ['open', 'close', 'roof', 'transforms_into'] as const) {
      const v = t[k];
      if (!v || v === 't_null' || d.terrain[v]) continue;
      // a missing roof only affects what gets built above; CDDA core has at least one (t_foam_roof)
      if (k === 'roof') warn(`terrain ${t.id}: unknown roof ${v}`);
      else errors.push(`terrain ${t.id}: unknown ${k} ${v}`);
    }
    const ts = t.bash?.ter_set;
    if (ts && ts !== 't_null' && !d.terrain[ts]) errors.push(`terrain ${t.id}: unknown bash.ter_set ${ts}`);
  }
  if (errors.length) {
    if (process.env.EXTRACT_ERRORS_FILE) fs.writeFileSync(process.env.EXTRACT_ERRORS_FILE, errors.join('\n'));
    for (const e of errors.slice(0, 50)) warn('ERROR ' + e);
    throw new Error(`${errors.length} dangling references, first: \n  ${errors.slice(0, 30).join('\n  ')}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const log = args.quiet ? () => {} : (m: string) => console.log(m);
  const t0 = Date.now();
  const { data, warnings } = extract(args.cdda, log);
  for (const w of warnings) log(`  warn: ${w}`);
  const files: Record<string, unknown> = {
    'terrain.json': data.terrain,
    'furniture.json': data.furniture,
    'items.json': data.items,
    'item_groups.json': data.itemGroups,
    'monsters.json': data.monsters,
    'monster_groups.json': data.monsterGroups,
    'recipes.json': data.recipes,
    'misc.json': data.misc,
  };
  if (!args.dryRun) fs.mkdirSync(args.out, { recursive: true });
  let total = 0;
  for (const [name, value] of Object.entries(files)) {
    const text = JSON.stringify(value);
    total += text.length;
    if (!args.dryRun) fs.writeFileSync(path.join(args.out, name), text);
    log(`  ${args.dryRun ? '(dry-run) ' : ''}${name.padEnd(20)} ${(text.length / 1024 / 1024).toFixed(2).padStart(6)} MB`);
  }
  log(`${args.dryRun ? 'would write' : 'wrote'} ${(total / 1024 / 1024).toFixed(1)} MB to ${args.out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const miscSizes = Object.entries(data.misc).map(([k, v]) => [k, JSON.stringify(v).length] as const).sort((a, b) => b[1] - a[1]);
  log(`  misc by type (KB): ${miscSizes.slice(0, 12).map(([k, n]) => `${k} ${Math.round(n / 1024)}`).join(', ')}`);
}

// Only run when executed directly, so tests can import extract().
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) {
  try {
    main();
  } catch (e) {
    console.error(`extract failed: ${(e as Error).message}`);
    process.exit(1);
  }
}


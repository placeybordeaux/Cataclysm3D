// Cataclysm: Bright Nights JSON -> public/data/*.json. Run via `npm run extract` (see --help).
//
// Pipeline: load raw JSON (cdda.ts) -> per-object prep: comments, units, BN legacy ints,
// translations (prepare.ts) -> copy-from resolution per type family (cdda.ts; item groups
// and monster groups append instead) -> per-type normalization (normalize.ts,
// itemgroup.ts) -> MIGRATION / MONSTER_BLACKLIST -> reference validation -> write.
//
// World types (mapgen, overmap, npcs, vehicles, achievements, ui) are deliberately skipped;
// their own extractors own them.

import fs from 'node:fs';
import path from 'node:path';
import { defaultCddaDir, FAMILY_HOOKS, familyOf, ITEM_TYPES, loadCddaObjects, objectIds, resolveFamily, type CddaObject } from './cdda';
import { prepareObject } from './prepare';
import {
  buildRequirementResolver, calcCategory, normalizeConstruction, normalizeFurniture, normalizeItem, normalizeMonster, normalizeMonsterGroups,
  normalizeProfession, normalizeRecipe, normalizeTerrain, pseudoDormantMonster, strip,
} from './normalize';
import { mergeItemGroups, migrateGroup, normalizeGroupRef, referencedIds, type ItemMigration } from './itemgroup';
import type { GameData, ItemGroupRef, RequirementData } from '../../src/data/types';

const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Owned by the world extractors (tools/extract/mapgen.ts & co.).
export const MAPGEN_TYPES = [
  'mapgen', 'palette', 'overmap_terrain', 'overmap_special', 'city_building', 'region_settings', 'region_overlay',
  'overmap_location', 'overmap_connection', 'overmap_land_use_code', 'map_extra', 'oter_id_migration',
  'mapgen_color_palette', 'map_feature_description', 'vehicle_placement', 'vehicle_spawn', 'world_type',
];
// Owned by tools/extract/vehicles.ts (public/data/vehicles.json).
export const VEHICLE_TYPES = ['vehicle', 'vehicle_part', 'vehicle_group', 'vehicle_color_palette'];
// Owned by npcs.ts / achievements.ts / ui.ts, or irrelevant to this game (tileset, sound,
// UI colours, NPC AI trees, zone types, mod blacklists).
const IGNORED_TYPES = [
  'talk_topic', 'npc', 'npc_class', 'mission_definition', 'faction', 'behavior',
  'achievement', 'event_statistic', 'event_transformation', 'score',
  'ascii_art', 'named_color', 'mod_tileset', 'overlay_order', 'LOOT_ZONE', 'skill_display_type',
  'charge_removal_blacklist', 'to_cbc_migration',
];

// BN type -> misc key. Anything loaded that is neither here, nor a primary output, nor
// owned elsewhere makes the extractor fail, so new BN types get a conscious decision.
const MISC: Record<string, string> = {
  material: 'material', requirement: 'requirement', tool_quality: 'tool_quality', ammunition_type: 'ammunition_type',
  profession: 'profession', profession_item_substitutions: 'profession_item_substitutions', scenario: 'scenario',
  start_location: 'start_location', mutation: 'mutation', mutation_category: 'mutation_category', mutation_type: 'mutation_type',
  mutation_flag: 'mutation_flag', trait_group: 'trait_group', effect_type: 'effect_type', martial_art: 'martial_art',
  technique: 'technique', harvest: 'harvest', field_type: 'field_type', trap: 'trap', construction: 'construction',
  construction_group: 'construction_group', construction_category: 'construction_category', body_part: 'body_part',
  anatomy: 'anatomy', skill: 'skill', ITEM_CATEGORY: 'item_category', MONSTER_FACTION: 'monster_faction', SPECIES: 'species',
  snippet: 'snippet', bionic: 'bionic', fault: 'fault', morale_type: 'morale_type', nested_category: 'nested_category',
  recipe_category: 'recipe_category', uncraft: 'uncraft', item_action: 'item_action', emit: 'emit', speech: 'speech',
  dream: 'dream', vitamin: 'vitamin', weather_type: 'weather_type', ammo_effect: 'ammo_effect', json_flag: 'json_flag',
  monster_attack: 'monster_attack', SPELL: 'spell', enchantment: 'enchantment', enchantment_value: 'enchantment_value',
  enchantment_flag: 'enchantment_flag', enchantment_condition: 'enchantment_condition', enchantment_vision: 'enchantment_vision',
  gate: 'gate', ter_furn_transform: 'ter_furn_transform', rotatable_symbol: 'rotatable_symbol', weapon_category: 'weapon_category',
  clothing_mod: 'clothing_mod', scent_type: 'scent_type', activity_type: 'activity_type', hit_range: 'hit_range',
  disease_type: 'disease_type', MIGRATION: 'item_migration', EXTERNAL_OPTION: 'external_option',
  MONSTER_BLACKLIST: 'monster_blacklist',
};
const PRIMARY = ['terrain', 'furniture', 'ITEM', 'item_group', 'MONSTER', 'monstergroup', 'recipe'];

interface Args { dryRun: boolean; out: string; cdda: string; quiet: boolean }

function usage(): string {
  return `Usage: npm run extract -- [options]

Convert Cataclysm: Bright Nights core JSON into normalized public/data/*.json
(terrain, furniture, items, item_groups, monsters, monster_groups, recipes, misc).

Options:
  --cdda <dir>   BN checkout (default: $CDDA_DIR or ~/code/Cataclysm-BN)
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

  const unknownTypes = [...raw.keys()].filter((t) => !MISC[t] && !PRIMARY.includes(familyOf(t)) && t !== 'uncraft');
  if (unknownTypes.length) throw new Error(`unclassified BN types (add to MISC or IGNORED_TYPES in tools/extract/index.ts): ${unknownTypes.join(', ')}`);

  // group into inheritance families (item kinds -> ITEM; recipe + nested_category -> recipe)
  const families = new Map<string, CddaObject[]>();
  for (const [type, list] of raw) {
    const fam = familyOf(type);
    let l = families.get(fam);
    if (!l) families.set(fam, (l = []));
    l.push(...list);
  }
  const resolved = new Map<string, Map<string, CddaObject>>();
  for (const [fam, list] of families) {
    // item groups and monster groups append rather than copy-from (see their merges)
    if (fam === 'monstergroup' || fam === 'item_group') continue;
    const withIds = list.filter((o) => objectIds(o).length > 0);
    const r = resolveFamily(withIds, FAMILY_HOOKS[fam] ?? {}, prepareObject);
    resolved.set(fam, r.byId);
    for (const w of r.warnings) warn(w);
    if (r.duplicates.length) warn(`${fam}: ${r.duplicates.length} ids defined more than once (last wins): ${r.duplicates.slice(0, 5).join(', ')}`);
  }
  const fam = (f: string) => resolved.get(f) ?? new Map<string, CddaObject>();
  const misc: GameData['misc'] = {};
  const miscPut = (key: string, id: string, v: unknown) => ((misc[key] ??= {})[id] = v);

  // --- primary outputs
  const terrain: GameData['terrain'] = {};
  for (const [id, o] of fam('terrain')) terrain[id] = normalizeTerrain(o);
  const furniture: GameData['furniture'] = {};
  for (const [id, o] of fam('furniture')) furniture[id] = normalizeFurniture(o);

  const items: GameData['items'] = {};
  for (const [id, o] of fam('ITEM')) items[id] = normalizeItem(o, warn);
  // finalize_pre: a category that is not a real ITEM_CATEGORY is recomputed (BN core has
  // e.g. "armor" and "tool", which do not exist)
  const categories = fam('ITEM_CATEGORY');
  for (const it of Object.values(items)) {
    if (categories.has(it.category)) continue;
    const c = calcCategory(it);
    warn(`item ${it.id}: category ${it.category} does not exist, using ${c} like BN`);
    it.category = c;
  }
  // islot_magazine default_ammo: explicit, else the first ammo type's default (finalize_pre)
  const ammoTypes = fam('ammunition_type');
  for (const it of Object.values(items)) {
    if (!it.magazine || it.magazine.default_ammo) continue;
    const at = ammoTypes.get(it.magazine.ammo_type[0]);
    if (!at?.default) throw new Error(`magazine ${it.id}: no default_ammo and ammo type ${it.magazine.ammo_type[0]} has no default`);
    it.magazine.default_ammo = at.default;
  }

  const itemGroups = mergeItemGroups((raw.get('item_group') ?? []).map(prepareObject));
  // built into the C++ (Item_factory::init), referenced by JSON
  itemGroups.EMPTY_GROUP ??= { id: 'EMPTY_GROUP', subtype: 'collection', entries: [] };
  const monsterGroups = normalizeMonsterGroups((raw.get('monstergroup') ?? []).map(prepareObject));

  const species = Object.fromEntries(fam('SPECIES'));
  const monsters: GameData['monsters'] = {};
  for (const [id, o] of fam('MONSTER')) monsters[id] = normalizeMonster(o, species);
  for (const m of Object.values(monsters)) {
    if (m.flags.includes('GEN_DORMANT')) {
      const d = pseudoDormantMonster(m);
      monsters[d.id] = d;
    }
  }
  // MONSTER_BLACKLIST (MonsterGroupManager::FinalizeMonsterGroups): blacklisted monsters
  // leave every group; a blacklisted default becomes mon_null
  const blacklist = new Set((raw.get('MONSTER_BLACKLIST') ?? []).flatMap((o) => asArr<string>(o.monsters)));
  for (const g of Object.values(monsterGroups)) {
    g.monsters = g.monsters.filter((m) => !blacklist.has(m.monster));
    if (blacklist.has(g.default)) g.default = 'mon_null';
  }
  misc.monster_blacklist = { default: [...blacklist] };

  const { resolver } = buildRequirementResolver([...fam('requirement').values()], warn);
  const recipes: GameData['recipes'] = [];
  for (const [id, o] of fam('recipe')) {
    if (o.obsolete || o.abstract) continue;
    if (o.type === 'recipe') recipes.push(normalizeRecipe(o, id, resolver));
    else miscPut(o.type, id, strip(o, ['name_plural']));
  }
  for (const [id, o] of fam('uncraft')) if (!o.obsolete) miscPut('uncraft', id, normalizeRecipe(o, id, resolver));
  // requirement defs with their own LIST references inlined (same as BN's finalize)
  for (const [id, o] of fam('requirement')) miscPut('requirement', id, { id, name: o.name, ...resolver.expand(resolver.get(id)!, [], `requirement ${id}`) });
  for (const [id, o] of fam('construction')) miscPut('construction', id, normalizeConstruction(o, resolver));
  for (const [id, o] of fam('profession')) miscPut('profession', id, normalizeProfession(o));

  // --- everything else in misc
  const handled = new Set([
    'profession_item_substitutions', 'nested_category', 'uncraft', 'requirement', 'construction', 'profession', 'snippet',
    'speech', 'dream', 'MONSTER_BLACKLIST',
  ]);
  for (const [type, key] of Object.entries(MISC)) {
    if (handled.has(type) || !raw.has(type)) continue;
    const byId = resolved.get(familyOf(type));
    if (!byId) continue;
    for (const [id, o] of byId) {
      if (o.type !== type) continue;
      // name_plural is only meaningful for items and monsters
      miscPut(key, id, strip(o, ['name_plural']));
    }
    const idless = (raw.get(type) ?? []).filter((o) => objectIds(o).length === 0);
    if (idless.length) throw new Error(`${type}: ${idless.length} objects without an id (classify their key in cdda.ts objectIds)`);
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
  // profession_item_substitutions (json_item_substitution::load) are keyed by item, by
  // trait, or are trait-conditional bonus item groups: "item:<id>" / "trait:<id>" (subs
  // concatenated) / "bonus:<n>"
  const subs: Record<string, any> = (misc.profession_item_substitutions = {});
  (raw.get('profession_item_substitutions') ?? []).map(prepareObject).forEach((o, i) => {
    if (o.item || o.trait) {
      const key = o.item ? `item:${o.item}` : `trait:${o.trait}`;
      (subs[key] ??= []).push(...asArr(o.sub));
      if (o.item && o.bonus) subs[`bonus:${i}`] = { item: o.item, bonus: o.bonus };
    } else if (o.item_group) {
      if (o.bonus) subs[`bonus:${i}`] = { group: normalizeGroupRef(o.item_group, 'collection'), bonus: o.bonus };
    } else throw new Error(`profession_item_substitutions without item/trait/item_group: ${JSON.stringify(o)}`);
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

// Item_factory::finalize: every MIGRATION (id -> replace) is applied to all item groups
// and requirements, and recipes for the migrated id are dropped. The flags/charges/contents
// parts only affect existing item instances (saves), so they stay in misc.item_migration.
function applyMigrations(d: GameData, migrations: CddaObject[]): void {
  const mig = new Map<string, ItemMigration>();
  for (const m of migrations) {
    if (typeof m.replace !== 'string') throw new Error(`MIGRATION ${JSON.stringify(m.id)} without "replace"`);
    for (const id of objectIds(m)) mig.set(id, { replace: m.replace });
  }
  for (const [id, m] of mig) {
    // finalize: "Replacement item for migration %s does not exist" -> skipped
    if (!d.items[m.replace]) mig.delete(id);
  }
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
  for (const r of [...d.recipes, ...Object.values(d.misc.uncraft ?? {})]) reqs(r);
  for (const c of Object.values(d.misc.construction ?? {})) {
    reqs(c);
    migrateGroup(c.byproducts, mig);
  }
  for (const r of Object.values(d.misc.requirement ?? {})) reqs(r);
  d.recipes = d.recipes.filter((r) => !mig.has(r.result));
}

// Reference checks. BN core data should be self-consistent; a dangling id almost always
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
  const item = (id: string | undefined, ctx: string) => {
    if (id !== undefined && id !== 'null' && !d.items[id]) errors.push(`${ctx}: unknown item ${id}`);
  };
  for (const it of Object.values(d.items)) {
    item(it.container, `item ${it.id} container`);
    item(it.container_data?.unseals_into, `item ${it.id} unseals_into`);
    item(it.magazine?.default_ammo, `item ${it.id} default_ammo`);
    for (const mags of Object.values(it.magazines ?? {})) for (const m of mags) item(m, `item ${it.id} magazines`);
    for (const t of asArr(it.ammo_type)) if (!d.misc.ammunition_type?.[t]) errors.push(`item ${it.id}: unknown ammo type ${t}`);
    for (const t of it.ammo ?? []) if (t !== 'NULL' && !d.misc.ammunition_type?.[t]) errors.push(`item ${it.id}: unknown ammo type ${t}`);
    for (const [q] of it.qualities) if (!d.misc.tool_quality?.[q]) errors.push(`item ${it.id}: unknown quality ${q}`);
    for (const m of it.material) if (!d.misc.material?.[m]) errors.push(`item ${it.id}: unknown material ${m}`);
    if (!d.misc.item_category?.[it.category]) errors.push(`item ${it.id}: unknown category ${it.category}`);
    for (const p of it.armor ?? []) for (const bp of p.covers) if (!d.misc.body_part?.[bp]) errors.push(`item ${it.id}: unknown body part ${bp}`);
  }
  for (const r of d.recipes) {
    // faction camp blueprints "result" in an overmap terrain, not an item
    if (r.category !== 'CC_BUILDING' && !d.items[r.result]) errors.push(`recipe ${r.id}: unknown result ${r.result}`);
    for (const alts of r.components) for (const c of alts) if (!d.items[c.id]) errors.push(`recipe ${r.id}: unknown component ${c.id}`);
    for (const alts of r.tools) for (const c of alts) if (!d.items[c.id]) errors.push(`recipe ${r.id}: unknown tool ${c.id}`);
    for (const [b] of r.book_learn ?? []) if (!d.items[b]?.subtypes.includes('BOOK')) errors.push(`recipe ${r.id}: book_learn ${b} is not a book`);
    item(r.container, `recipe ${r.id} container`);
  }
  for (const g of Object.values(d.monsterGroups)) {
    for (const m of g.monsters) if (!d.monsters[m.monster] && m.monster !== 'mon_null') errors.push(`monstergroup ${g.id}: unknown monster ${m.monster}`);
    if (g.default !== 'mon_null' && !d.monsters[g.default]) errors.push(`monstergroup ${g.id}: unknown default ${g.default}`);
  }
  for (const m of Object.values(d.monsters)) {
    if (m.harvest && !d.misc.harvest?.[m.harvest]) errors.push(`monster ${m.id}: unknown harvest ${m.harvest}`);
    for (const k of ['into', 'into_group'] as const) {
      const v = m.upgrades?.[k];
      if (typeof v !== 'string' || v === 'mon_null' || v === 'GROUP_NULL') continue;
      if (k === 'into' ? !d.monsters[v] : !d.monsterGroups[v]) errors.push(`monster ${m.id}: unknown upgrades.${k} ${v}`);
    }
  }
  for (const t of Object.values(d.terrain)) {
    for (const k of ['open', 'close', 'roof', 'transforms_into'] as const) {
      const v = t[k];
      if (!v || v === 't_null' || d.terrain[v]) continue;
      errors.push(`terrain ${t.id}: unknown ${k} ${v}`);
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

// ITEM_TYPES is re-exported for tools that classify raw types.
export { ITEM_TYPES };

// Only run when executed directly, so tests can import extract().
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) {
  try {
    main();
  } catch (e) {
    console.error(`extract failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

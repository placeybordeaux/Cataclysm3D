// Extract Bright Nights NPC content into public/data/npcs.json: npc templates, npc classes,
// talk topics (merged like json_talk_topic::load), mission definitions, factions, the
// effect_on_conditions dialogue reaches through run_eocs (DDA only; BN has none), and name
// lists for random NPCs. Snippets (<greet>, <name_b>, ...) already live in misc.json.
//
// Usage: npm run extract:npcs -- [--cdda ~/code/Cataclysm-BN] [--out public/data] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { FAMILY_HOOKS, loadCddaObjects, objectIds, resolveFamily, type CddaObject } from './cdda';
import { prepareObject } from './prepare';
import { defaultGameDir } from './gamedir';

function usage(): string {
  return `Usage: npm run extract:npcs -- [options]

Write public/data/npcs.json (npc templates, npc_class, talk_topic, mission_definition,
faction, referenced effect_on_condition, NPC name lists).

Options:
  --cdda <dir>   game checkout (default: $CDDA_DIR or ~/code/Cataclysm-BN)
  --out <dir>    output directory (default: public/data)
  --dry-run      print a summary instead of writing
  -h, --help     show this help`;
}

const args = { cdda: defaultGameDir(), out: 'public/data', dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '-h' || k === '--help') {
    console.log(usage());
    process.exit(0);
  } else if (k === '--dry-run') args.dryRun = true;
  else if (k === '--cdda') args.cdda = argv[++i];
  else if (k === '--out') args.out = argv[++i];
  else throw new Error(`unknown argument ${k}\n\n${usage()}`);
}

const TYPES = ['npc', 'npc_class', 'talk_topic', 'mission_definition', 'faction', 'effect_on_condition'];
const raw = loadCddaObjects(args.cdda, { types: TYPES });
const all = (t: string) => raw.get(t) ?? [];

const resolved = (type: string): Map<string, CddaObject> => {
  const withIds = all(type).filter((o) => objectIds(o).length > 0);
  return resolveFamily(withIds, FAMILY_HOOKS[type] ?? {}, prepareObject).byId;
};

// ---------------------------------------------------------------------------------------
// Talk topics. CDDA appends responses from every definition of an id (the "table of
// contents" pattern adds shared responses to many topics at once), while dynamic_line and
// replace_built_in_responses are overridden by later definitions that set them.

interface TopicOut {
  dynamic_line?: unknown;
  responses: unknown[];
  speaker_effect?: unknown[];
  repeat_responses?: unknown[];
  replace_built_in_responses?: boolean;
  /** Responses from insert_before_standard_exits definitions (mods); kept apart so the UI can order them. */
  insert_before_exits?: unknown[];
}
const topics: Record<string, TopicOut> = {};
for (const o0 of all('talk_topic')) {
  const o = prepareObject(o0);
  const ids: string[] = Array.isArray(o.id) ? o.id : [o.id];
  for (const id of ids) {
    if (typeof id !== 'string') throw new Error(`talk_topic with bad id: ${JSON.stringify(o.id)}`);
    const t = (topics[id] ??= { responses: [] });
    if (o.dynamic_line !== undefined) t.dynamic_line = o.dynamic_line;
    if (o.replace_built_in_responses !== undefined) t.replace_built_in_responses = !!o.replace_built_in_responses;
    const resp = (o.responses ?? []) as unknown[];
    if (o.insert_before_standard_exits) (t.insert_before_exits ??= []).push(...resp);
    else t.responses.push(...resp);
    if (o.speaker_effect !== undefined) (t.speaker_effect ??= []).push(...(Array.isArray(o.speaker_effect) ? o.speaker_effect : [o.speaker_effect]));
    if (o.repeat_responses !== undefined) (t.repeat_responses ??= []).push(...(Array.isArray(o.repeat_responses) ? o.repeat_responses : [o.repeat_responses]));
  }
}

// ---------------------------------------------------------------------------------------
// Templates, classes, missions, factions

const pick = (o: CddaObject, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const templates: Record<string, CddaObject> = {};
for (const [id, o] of resolved('npc')) {
  const { type: _t, ...rest } = o;
  templates[id] = rest;
}

const CLASS_KEYS = [
  'id', 'name', 'job_description', 'common', 'common_spawn_weight', 'sells_belongings', 'bonus_str', 'bonus_dex', 'bonus_int', 'bonus_per',
  'bonus_aggression', 'bonus_bravery', 'bonus_collector', 'bonus_altruism', 'skills', 'worn_override', 'carry_override',
  'weapon_override', 'shopkeeper_item_group', 'shopkeeper_price_rules', 'shopkeeper_blacklist', 'traits', 'proficiencies',
  'work_hours', 'bye_message_override', 'restock_interval',
  // BN: CBMs the class starts with
  'bionics',
];
const classes: Record<string, CddaObject> = {};
for (const [id, o] of resolved('npc_class')) {
  const c = pick(o, CLASS_KEYS);
  // BN writes shopkeeper_item_group as one group id; the runtime reads DDA's [{group, trust...}].
  if (typeof c.shopkeeper_item_group === 'string') c.shopkeeper_item_group = [{ group: c.shopkeeper_item_group }];
  classes[id] = c;
}

const missions: Record<string, CddaObject> = {};
for (const [id, o] of resolved('mission_definition')) {
  const { type: _t, ...rest } = o;
  missions[id] = rest;
}

const factions: Record<string, CddaObject> = {};
for (const [id, o] of resolved('faction')) {
  factions[id] = pick(o, ['id', 'name', 'currency', 'price_rules', 'likes_u', 'respects_u', 'trusts_u', 'known_by_u', 'relations', 'description', 'lone_wolf_faction']);
}

// ---------------------------------------------------------------------------------------
// effect_on_condition: only the ones dialogue/missions can reach (run_eocs, *_eocs lists),
// closed over EOCs that run other EOCs. Recurring/event EOCs are not dialogue material.

const eocAll = resolved('effect_on_condition');
const eocs: Record<string, CddaObject> = {};
const queue: unknown[] = [topics, missions, templates];
while (queue.length) {
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      const e = eocAll.get(v);
      if (e && !eocs[v]) {
        const { type: _t, ...rest } = e;
        eocs[v] = rest;
        queue.push(rest);
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(queue.pop());
}

// ---------------------------------------------------------------------------------------
// Names (npc::pick_name uses <male_full_name>/<female_full_name> = given + family)

const namesRaw = JSON.parse(fs.readFileSync(path.join(args.cdda, 'data/names/en.json'), 'utf8')) as { usage: string; gender?: string; name: string[] }[];
const names = (usage: string, gender?: string) => namesRaw.filter((n) => n.usage === usage && (gender === undefined || n.gender === gender)).flatMap((n) => n.name);
const nameLists = { male: names('given', 'male'), female: names('given', 'female'), family: names('family') };
for (const [k, v] of Object.entries(nameLists)) if (!v.length) throw new Error(`no ${k} names in data/names/en.json`);

// Sanity: every template's class and chat must exist (fail loudly, the runtime relies on it).
for (const [id, t] of Object.entries(templates)) {
  if (t.class && t.class !== 'NC_NONE' && !classes[t.class]) throw new Error(`npc ${id}: unknown class ${t.class}`);
  if (typeof t.chat === 'string' && t.chat !== 'TALK_NONE' && t.chat !== 'TALK_DONE' && !topics[t.chat]) console.warn(`npc ${id}: chat topic ${t.chat} has no talk_topic`);
}

const out = { templates, classes, topics, missions, factions, eocs, names: nameLists };
const text = JSON.stringify(out);
const summary = `templates ${Object.keys(templates).length}, classes ${Object.keys(classes).length}, topics ${Object.keys(topics).length}, ` +
  `missions ${Object.keys(missions).length}, factions ${Object.keys(factions).length}, eocs ${Object.keys(eocs).length} (${(text.length / 1e6).toFixed(2)} MB)`;
const file = path.join(args.out, 'npcs.json');
if (args.dryRun) console.log(`[dry-run] would write ${file}: ${summary}`);
else {
  fs.writeFileSync(file, text);
  console.log(`wrote ${file}: ${summary}`);
}

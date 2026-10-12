// Dialogue coverage: which BN talk conditions, effects and trial mods does src/game/talk.ts
// actually handle?
//
// Walks every talk_topic (dynamic lines, responses, trials, speaker effects, repeat responses,
// inline topics) and every mission_definition (start/end/fail effects, goal_condition) in
// public/data/npcs.json, splits them into atoms (one condition / effect / trial mod each), and
// runs each distinct atom through the real runtime (a headless Game + NpcSystem + Dialogue, as
// tests/npcs.test.ts builds it). An atom is unsupported when the runtime logs an
// "[talk…] unsupported/deprecated" warning for it; that is the runtime's contract for kinds
// it cannot honour (they evaluate false / do nothing), so this measures behaviour, not a list
// that could drift from the switch statements.
//
// Kinds are weighted by how many reachable topics use them, and by how many topics the player
// meets early use them:
//   reachable  BFS from every template chat topic, the chatbin defaults (TALK_STRANGER_*,
//              TALK_FRIEND, TALK_MISSION_*…) and TALK_SHELTER, along response topics,
//              failure topics, inline topics and npc_first_topic effects; missions offered by
//              reachable templates, their followups and add_mission/assign_mission targets.
//   early      the same BFS from the refugee center's templates (every npc class placed by an
//              evac_center mapgen), the starting NPC (TALK_SHELTER) and random town survivors
//              (chatbin defaults), plus their missions and the random opener missions.
//
// Usage: npx tsx tools/dialogue-coverage.ts [--top N] [--all] [--json FILE] [--kind cond|effect|mod|feature]
//   --top N      rows in the kind table (default 40)
//   --all        list supported kinds too (default: unsupported only)
//   --json FILE  also write the full per-kind numbers as JSON
//   --kind K     only list one category (cond, effect, mod, feature)
//   -h, --help   this text
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameData } from '../src/data/types';
import { resetWarnings } from '../src/data/warn';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem } from '../src/game/npcai';
import type { NpcData } from '../src/game/npc';
import { Dialogue } from '../src/game/talk';
import { loadNodeData } from './lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const get = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--top' || a === '--json' || a === '--kind') i++;
  else if (a !== '--all') throw new Error(`unknown argument ${a} (see --help)`);
}
const TOP = Number(get('--top') ?? 40);
const SHOW_ALL = argv.includes('--all');
const ONLY = get('--kind');
if (ONLY && !['cond', 'effect', 'mod', 'feature'].includes(ONLY)) throw new Error(`--kind must be cond, effect, mod or feature, not ${ONLY}`);

const { game: data } = loadNodeData();
const nd = JSON.parse(readFileSync(resolve('public/data/npcs.json'), 'utf8')) as NpcData;
const mapgen = JSON.parse(readFileSync(resolve('public/data/mapgen.json'), 'utf8')) as { omt: Record<string, { o: number }[]>; objects: unknown[] };

// ------------------------------------------------------------------ atoms

type Cat = 'cond' | 'effect' | 'mod' | 'feature';
interface Atom {
  cat: Cat;
  kind: string;
  raw: unknown;
}

/** Keys that are arguments of a condition/effect object (BN and DDA), never its kind. */
const ARG_KEYS = new Set([
  'value', 'count', 'cost', 'container', 'duration', 'true_eocs', 'false_eocs', 'intensity', 'target_var', 'use_item_group',
  'suppress_message', 'popup', 'flags', 'bodypart', 'force', 'charges', 'possible_values', 'time', 'type', 'context', 'op',
  'adjustment', 'bonus', 'max_bonus', 'decay_start', 'capped', 'then', 'else', 'cases', 'success', 'time_in_future', 'om_terrain',
  'target', 'range', 'om_special', 'om_terrain_match_type', 'origin_npc', 'offset_x', 'offset_y', 'offset_z', 'reveal_radius',
  'search_range', 'min_distance', 'z', 'key', 'level', 'amount', 'yes', 'no', 'pacified', 'name',
]);
const kindOf = (o: Record<string, unknown>) => {
  const keys = Object.keys(o).filter((k) => !k.startsWith('//'));
  return keys.find((k) => !ARG_KEYS.has(k)) ?? keys[0] ?? '?';
};

function condAtoms(c: unknown, out: Atom[]): void {
  if (c === undefined || c === null || typeof c === 'boolean') return;
  if (typeof c === 'string') return void out.push({ cat: 'cond', kind: c, raw: c });
  if (Array.isArray(c) || typeof c !== 'object') return void out.push({ cat: 'cond', kind: `<bad ${typeof c}>`, raw: c });
  const o = c as Record<string, unknown>;
  if (Array.isArray(o.and)) return o.and.forEach((x) => condAtoms(x, out));
  if (Array.isArray(o.or)) return o.or.forEach((x) => condAtoms(x, out));
  if ('not' in o) return condAtoms(o.not, out);
  out.push({ cat: 'cond', kind: kindOf(o), raw: o });
}

function effectAtoms(e: unknown, out: Atom[]): void {
  if (e === undefined || e === null) return;
  if (Array.isArray(e)) return e.forEach((x) => effectAtoms(x, out));
  if (typeof e === 'string') return void out.push({ cat: 'effect', kind: e, raw: e });
  if (typeof e !== 'object') return;
  const o = e as Record<string, unknown>;
  const k = kindOf(o);
  out.push({ cat: 'effect', kind: k, raw: o });
}

/** BN simple_string_conds: usable as a dynamic-line key with a yes line as its value. */
const SIMPLE = new Set([
  'u_male', 'u_female', 'npc_male', 'npc_female', 'has_no_assigned_mission', 'has_assigned_mission', 'has_many_assigned_missions',
  'has_no_available_mission', 'has_available_mission', 'has_many_available_missions', 'mission_complete', 'mission_incomplete',
  'mission_has_generic_rewards', 'npc_available', 'npc_following', 'npc_friend', 'npc_hostile', 'npc_train_skills', 'npc_train_styles',
  'npc_is_sleepy', 'at_safe_space', 'is_day', 'npc_has_activity', 'is_outside', 'u_can_stow_weapon', 'npc_can_stow_weapon',
  'u_has_weapon', 'npc_has_weapon', 'u_driving', 'npc_driving', 'has_pickup_list', 'is_by_radio', 'has_reason',
]);

/** dynamic_line_t: string | random array | {and: concatenation} | gendered/hint/reason | condition with yes/no. */
function lineAtoms(dl: unknown, out: Atom[]): void {
  if (dl === undefined || dl === null || typeof dl === 'string') return;
  if (Array.isArray(dl)) return dl.forEach((x) => lineAtoms(x, out));
  if (typeof dl !== 'object') return;
  const o = dl as Record<string, unknown>;
  if (Array.isArray(o.and)) {
    out.push({ cat: 'feature', kind: 'dynamic_line.and', raw: null });
    return o.and.forEach((x) => lineAtoms(x, out));
  }
  if (Array.isArray(o.concatenate)) return o.concatenate.forEach((x) => lineAtoms(x, out));
  if (o.give_hint || o.use_reason || typeof o.gendered_line === 'string' || typeof o.str === 'string' || o.list_faction_camp_sites) return;
  lineAtoms(o.yes, out);
  lineAtoms(o.no, out);
  for (const k of Object.keys(o)) {
    if (!SIMPLE.has(k)) continue;
    out.push({ cat: 'cond', kind: k, raw: k });
    if (o[k] !== true) lineAtoms(o[k], out);
    return;
  }
  const { yes: _y, no: _n, ...rest } = o;
  condAtoms(rest, out);
}

interface Unit {
  id: string;
  atoms: Atom[];
  /** Topics this unit can lead to. */
  next: string[];
  /** Missions this unit can hand out. */
  missions: string[];
}

function respAtoms(r: any, u: Unit, inline: (t: any) => void): void {
  if (!r || typeof r !== 'object') return;
  condAtoms(r.condition, u.atoms);
  condAtoms(r.show_condition, u.atoms);
  if (r.truefalsetext) condAtoms(r.truefalsetext.condition, u.atoms);
  if (r.trial) {
    condAtoms(r.trial.condition, u.atoms);
    for (const m of r.trial.mod ?? []) if (Array.isArray(m)) u.atoms.push({ cat: 'mod', kind: String(m[0]), raw: m });
  }
  for (const b of [r, r.success, r.failure]) {
    if (!b || typeof b !== 'object') continue;
    effectAtoms(b.effect, u.atoms);
    const t = b.topic;
    if (typeof t === 'string') u.next.push(t);
    else if (t && typeof t === 'object') {
      if (typeof t.id === 'string') u.next.push(t.id);
      inline(t);
    }
  }
  const ft = r.failure_topic;
  if (typeof ft === 'string') u.next.push(ft);
  else if (ft && typeof ft === 'object' && typeof ft.id === 'string') u.next.push(ft.id);
}

const units = new Map<string, Unit>();
function topicUnit(id: string, t: any): Unit {
  const u: Unit = { id: `topic:${id}`, atoms: [], next: [], missions: [] };
  const inline = (x: any) => {
    lineAtoms(x.dynamic_line, u.atoms);
    for (const r of x.responses ?? []) respAtoms(r, u, inline);
  };
  lineAtoms(t.dynamic_line, u.atoms);
  for (const r of [...(t.responses ?? []), ...(t.insert_before_exits ?? [])]) respAtoms(r, u, inline);
  for (const se of t.speaker_effect ?? []) {
    condAtoms(se?.condition, u.atoms);
    effectAtoms(se?.effect, u.atoms);
  }
  for (const rr of t.repeat_responses ?? []) {
    if (rr?.for_category) u.atoms.push({ cat: 'feature', kind: 'repeat_responses.for_category', raw: null });
    respAtoms(rr?.response, u, inline);
  }
  for (const a of u.atoms) {
    if (a.cat !== 'effect' || !a.raw || typeof a.raw !== 'object') continue;
    const o = a.raw as Record<string, unknown>;
    if (a.kind === 'npc_first_topic') u.next.push(String(o.npc_first_topic));
    if (a.kind === 'add_mission' || a.kind === 'assign_mission') u.missions.push(String(o[a.kind]));
  }
  return u;
}
for (const [id, t] of Object.entries(nd.topics)) units.set(`topic:${id}`, topicUnit(id, t));
for (const [id, m] of Object.entries(nd.missions) as [string, any][]) {
  const u: Unit = { id: `mission:${id}`, atoms: [], next: [], missions: [] };
  for (const ph of ['start', 'end', 'fail']) if (m[ph] && typeof m[ph] === 'object') effectAtoms(m[ph].effect, u.atoms);
  condAtoms(m.goal_condition, u.atoms);
  if (typeof m.followup === 'string') u.missions.push(m.followup);
  units.set(u.id, u);
}

// ------------------------------------------------------------------ reachability

const CHATBIN = ['TALK_NONE', 'TALK_RADIO', 'TALK_LEADER', 'TALK_FRIEND', 'TALK_STOLE_ITEM', 'TALK_WAKE_UP', 'TALK_MUG',
  'TALK_STRANGER_AGGRESSIVE', 'TALK_STRANGER_SCARED', 'TALK_STRANGER_WARY', 'TALK_STRANGER_FRIENDLY', 'TALK_STRANGER_NEUTRAL',
  'TALK_FRIEND_GUARD', 'TALK_MISSION_INQUIRE', 'TALK_MISSION_DESCRIBE_URGENT', 'TALK_MISSION_LIST', 'TALK_MISSION_LIST_ASSIGNED',
  'TALK_MISSION_OFFER', 'TALK_MISSION_ACCEPTED', 'TALK_MISSION_REJECTED', 'TALK_MISSION_ADVICE', 'TALK_MISSION_SUCCESS',
  'TALK_MISSION_SUCCESS_LIE', 'TALK_MISSION_FAILURE', 'TALK_MISSION_DESCRIBE', 'TALK_DONE'];
const opener = Object.values(nd.missions as Record<string, any>)
  .filter((m) => (m.origins ?? []).some((o: string) => o === 'ORIGIN_OPENER_NPC' || o === 'ORIGIN_ANY_NPC'))
  .map((m) => m.id as string);

function reach(rootTopics: string[], rootMissions: string[]): Set<string> {
  const seen = new Set<string>();
  const q = [...rootTopics.map((t) => `topic:${t}`), ...rootMissions.map((m) => `mission:${m}`)];
  while (q.length) {
    const id = q.pop()!;
    if (seen.has(id)) continue;
    const u = units.get(id);
    if (!u) continue;
    seen.add(id);
    for (const t of u.next) q.push(`topic:${t}`);
    for (const m of u.missions) q.push(`mission:${m}`);
  }
  return seen;
}

const templates = nd.templates as Record<string, any>;
const allChats = Object.values(templates).map((t) => String(t.chat));
const allOffered = Object.values(templates).flatMap((t) => (t.mission_offered ? [String(t.mission_offered)] : []));
const reachable = reach([...CHATBIN, 'TALK_SHELTER', ...allChats], [...allOffered, ...opener]);

// The refugee center: every npc template an evac_center mapgen places.
const evacObjs = new Set<number>();
for (const [k, v] of Object.entries(mapgen.omt)) if (k.startsWith('evac_center')) for (const e of v) evacObjs.add(e.o);
const evacText = JSON.stringify([...evacObjs].map((i) => mapgen.objects[i]));
const evacTemplates = Object.keys(templates).filter((t) => evacText.includes(`"class":"${t}"`) || evacText.includes(`"class": "${t}"`));
if (!evacTemplates.includes('evac_merchant')) throw new Error(`refugee center templates not found in mapgen.json (got ${evacTemplates.join(', ')})`);
const early = reach(
  [...CHATBIN, 'TALK_SHELTER', ...evacTemplates.map((t) => String(templates[t].chat)), String(templates.thug?.chat ?? 'TALK_NONE')],
  [...evacTemplates.flatMap((t) => (templates[t].mission_offered ? [String(templates[t].mission_offered)] : [])), ...opener],
);

// ------------------------------------------------------------------ probing the runtime

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}
const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
const realLog = console.log;

function makeWorld(): { npcs: NpcSystem; probe: () => Dialogue } {
  const game = new Game(data as GameData, 7, input);
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) game.map.chunk(x, y, 0);
  const mons = new MonsterSystem(game);
  const npcs = new NpcSystem(game, nd, mons);
  game.systems.push(mons, npcs);
  game.clock.seconds = 12 * 3600;
  // The game wires these from the UI and world generator (src/npcs.ts); stand-ins that decline,
  // so effects that need them run their real code path instead of reporting a missing hook.
  npcs.pickOption = (_t, _o, onPick) => onPick(null);
  npcs.pickItem = (_t, _i, onPick) => onPick(null);
  npcs.startTrade = (_n, _c, onDone) => onDone?.(false);
  npcs.omtAt = () => 'field';
  const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
  const att = n.attitude, fac = n.faction;
  return {
    npcs,
    probe: () => {
      n.attitude = att;
      n.faction = fac;
      n.following = false;
      return new Dialogue(npcs, n);
    },
  };
}
const w = makeWorld();
const UNSUPPORTED = /^\[talk[^\]]*\].*\b(unsupported|deprecated)\b/i;

/** Structural dialogue features: exercise them on a synthetic topic and check the result. */
function probeFeature(d: Dialogue, kind: string): void {
  if (kind === 'dynamic_line.and') {
    if (d.evalDynamicLine({ and: ['a', 'b'] }) !== 'ab') warnings.push('[talk probe] unsupported: {"and": [...]} dynamic lines are not concatenated');
  } else if (kind === 'repeat_responses.for_category') {
    const id = '__COVERAGE_FOR_CATEGORY';
    nd.topics[id] = { dynamic_line: 'x', responses: [], repeat_responses: [{ for_category: ['food'], response: { text: 'x' } }] } as never;
    (d as unknown as { topics: string[] }).topics.push(id);
    d.view();
    delete nd.topics[id];
  } else warnings.push(`[talk probe] unsupported: no probe for feature ${kind}`);
}

interface Verdict {
  ok: boolean;
  why?: string;
}
const verdicts = new Map<string, Verdict>();
function probe(a: Atom): Verdict {
  const key = `${a.cat}|${JSON.stringify(a.raw)}`;
  const hit = verdicts.get(key);
  if (hit) return hit;
  resetWarnings();
  warnings.length = 0;
  let err: string | undefined;
  try {
    const d = w.probe();
    if (a.cat === 'cond') d.cond(a.raw);
    else if (a.cat === 'effect') d.effect(a.raw);
    else if (a.cat === 'feature') probeFeature(d, a.kind);
    else (d as unknown as { parseMod(attr: string, f: number): number }).parseMod(String((a.raw as unknown[])[0]), Number((a.raw as unknown[])[1]) || 0);
  } catch (e) {
    err = `throws: ${(e as Error).message}`;
  }
  const bad = warnings.find((m) => UNSUPPORTED.test(m));
  const v: Verdict = err ? { ok: false, why: err } : bad ? { ok: false, why: bad.replace(/^\[talk[^\]]*\]\s*/, '') } : { ok: true };
  verdicts.set(key, v);
  return v;
}

// ------------------------------------------------------------------ tally

interface KindRow {
  cat: Cat;
  kind: string;
  uses: number;
  unsupportedUses: number;
  reachableTopics: Set<string>;
  earlyTopics: Set<string>;
  why: Set<string>;
}
const rows = new Map<string, KindRow>();
let atomsReach = 0, atomsReachOk = 0, atomsEarly = 0, atomsEarlyOk = 0;
let unitsReach = 0, unitsReachOk = 0, unitsEarly = 0, unitsEarlyOk = 0;
for (const u of units.values()) {
  const isReach = reachable.has(u.id), isEarly = early.has(u.id);
  let allOk = true;
  for (const a of u.atoms) {
    const v = probe(a);
    const key = `${a.cat}|${a.kind}`;
    const r = rows.get(key) ?? { cat: a.cat, kind: a.kind, uses: 0, unsupportedUses: 0, reachableTopics: new Set(), earlyTopics: new Set(), why: new Set() };
    rows.set(key, r);
    r.uses++;
    if (!v.ok) {
      r.unsupportedUses++;
      if (v.why) r.why.add(v.why);
      allOk = false;
    }
    if (isReach) {
      r.reachableTopics.add(u.id);
      atomsReach++;
      if (v.ok) atomsReachOk++;
    }
    if (isEarly) {
      r.earlyTopics.add(u.id);
      atomsEarly++;
      if (v.ok) atomsEarlyOk++;
    }
  }
  if (isReach) {
    unitsReach++;
    if (allOk) unitsReachOk++;
  }
  if (isEarly) {
    unitsEarly++;
    if (allOk) unitsEarlyOk++;
  }
}
console.warn = realWarn;

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const score = (r: KindRow) => r.earlyTopics.size * 3 + r.reachableTopics.size;
const kinds = [...rows.values()];
const unsupportedKinds = kinds.filter((r) => r.unsupportedUses > 0);
const out = realLog;
out(`dialogue coverage — ${units.size} units (${Object.keys(nd.topics).length} topics, ${Object.keys(nd.missions).length} missions); ` +
  `reachable ${reachable.size}, early ${early.size} (refugee center: ${evacTemplates.length} templates)`);
out('');
out(`  atoms in reachable units   ${atomsReachOk}/${atomsReach} supported (${pct(atomsReachOk, atomsReach)})`);
out(`  atoms in early units       ${atomsEarlyOk}/${atomsEarly} supported (${pct(atomsEarlyOk, atomsEarly)})`);
out(`  reachable units, all ok    ${unitsReachOk}/${unitsReach} (${pct(unitsReachOk, unitsReach)})`);
out(`  early units, all ok        ${unitsEarlyOk}/${unitsEarly} (${pct(unitsEarlyOk, unitsEarly)})`);
out(`  kinds                      ${kinds.length - unsupportedKinds.length}/${kinds.length} fully supported ` +
  `(cond ${kinds.filter((r) => r.cat === 'cond' && !r.unsupportedUses).length}/${kinds.filter((r) => r.cat === 'cond').length}, ` +
  `effect ${kinds.filter((r) => r.cat === 'effect' && !r.unsupportedUses).length}/${kinds.filter((r) => r.cat === 'effect').length}, ` +
  `mod ${kinds.filter((r) => r.cat === 'mod' && !r.unsupportedUses).length}/${kinds.filter((r) => r.cat === 'mod').length}, ` +
  `feature ${kinds.filter((r) => r.cat === 'feature' && !r.unsupportedUses).length}/${kinds.filter((r) => r.cat === 'feature').length})`);
out('');
const list = (SHOW_ALL ? kinds : unsupportedKinds).filter((r) => !ONLY || r.cat === ONLY).sort((a, b) => score(b) - score(a) || b.uses - a.uses);
out(`${SHOW_ALL ? 'all' : 'unsupported'} kinds by weight (3 × early topics + reachable topics):`);
out(`  ${'cat'.padEnd(6)} ${'kind'.padEnd(30)} ${'early'.padStart(5)} ${'reach'.padStart(5)} ${'uses'.padStart(5)} ${'bad'.padStart(5)}  why`);
for (const r of list.slice(0, TOP)) {
  const mark = r.unsupportedUses === 0 ? '✓' : r.unsupportedUses < r.uses ? '~' : '✗';
  out(`${mark} ${r.cat.padEnd(6)} ${r.kind.slice(0, 30).padEnd(30)} ${String(r.earlyTopics.size).padStart(5)} ${String(r.reachableTopics.size).padStart(5)} ` +
    `${String(r.uses).padStart(5)} ${String(r.unsupportedUses).padStart(5)}  ${[...r.why].join(' | ').slice(0, 110)}`);
}
if (list.length > TOP) out(`  … ${list.length - TOP} more (--top N)`);

const jsonOut = get('--json');
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({
    summary: { atomsReach, atomsReachOk, atomsEarly, atomsEarlyOk, unitsReach, unitsReachOk, unitsEarly, unitsEarlyOk, kinds: kinds.length, unsupportedKinds: unsupportedKinds.length },
    kinds: kinds.map((r) => ({ cat: r.cat, kind: r.kind, uses: r.uses, unsupportedUses: r.unsupportedUses, reachable: r.reachableTopics.size, early: r.earlyTopics.size, why: [...r.why] })),
  }, null, 1));
  out(`\nwrote ${jsonOut}`);
}

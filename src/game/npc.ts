import { Rng } from '../core/rng';
import type { GameData } from '../data/types';
import { expandItemGroup, type SpawnedItem } from '../data/index';
import { warnOnce } from '../data/warn';
import { Character, type CharacterJSON } from './character';
import { createItem, defaultAmmoId, fromSpawned, loadAmmo, Item, type ItemJSON } from './item';

// NPCs (CDDA npc.cpp): a Character plus position, attitude, faction, personality, the NPC's
// opinion of the survivor (op_of_u), dialogue variables and the chatbin (which topic each
// situation starts with). Generation follows npc::load_npc_template + npc::randomize: stats
// 4d3 + class bonus, class skill distributions, clothes/weapon/carried items from the class
// item groups (falling back to the generic npc_* / survivor_* groups), names from the CDDA
// name lists. The real-time AI lives in npcai.ts; dialogue in talk.ts.

// ------------------------------------------------------------------ extracted data (npcs.json)

export interface NpcTemplate {
  id: string;
  class: string;
  attitude: number;
  mission: string | number;
  chat: string;
  faction: string;
  name_unique?: string;
  name_suffix?: string;
  gender?: 'male' | 'female';
  mission_offered?: string | string[];
  age?: number;
  height?: number;
  str?: number;
  dex?: number;
  int?: number;
  per?: number;
  personality?: Partial<Personality>;
  talk_friend?: string;
  talk_friend_guard?: string;
  [k: string]: unknown;
}

export interface NpcClassDef {
  id: string;
  name?: string;
  job_description?: string;
  common?: boolean;
  bonus_str?: unknown;
  bonus_dex?: unknown;
  bonus_int?: unknown;
  bonus_per?: unknown;
  bonus_aggression?: unknown;
  bonus_bravery?: unknown;
  bonus_collector?: unknown;
  bonus_altruism?: unknown;
  skills?: { skill: string; level?: unknown; bonus?: unknown }[];
  worn_override?: string;
  carry_override?: string;
  weapon_override?: string;
  shopkeeper_item_group?: { group: string; trust?: number; rigid?: boolean; strict?: boolean; condition?: unknown }[];
  shopkeeper_price_rules?: PriceRule[];
  sells_belongings?: boolean;
  traits?: { trait?: string; group?: string }[];
  bye_message_override?: string;
}

export interface PriceRule {
  item?: string;
  category?: string;
  group?: string;
  flag?: string;
  premium?: number;
  markup?: number;
  fixed_adj?: number;
  price?: number;
  condition?: unknown;
}

export interface FactionDef {
  id: string;
  name: string;
  currency?: string;
  price_rules?: PriceRule[];
  likes_u?: number;
  respects_u?: number;
  trusts_u?: number;
  lone_wolf_faction?: boolean;
}

export interface TalkTopicDef {
  dynamic_line?: unknown;
  responses: any[];
  speaker_effect?: any[];
  repeat_responses?: any[];
  replace_built_in_responses?: boolean;
  insert_before_exits?: any[];
}

export interface MissionDef {
  id: string;
  name: string;
  description?: string;
  goal: string;
  difficulty?: number;
  value?: number;
  origins?: string[];
  dialogue?: Record<string, string>;
  start?: any;
  end?: any;
  fail?: any;
  item?: string;
  count?: number;
  followup?: string;
  destination?: string;
  goal_condition?: unknown;
  monster_type?: string;
  monster_species?: string;
  monster_kill_goal?: number;
  urgent?: boolean;
  has_generic_rewards?: boolean;
  deadline?: unknown;
}

export interface NpcData {
  templates: Record<string, NpcTemplate>;
  classes: Record<string, NpcClassDef>;
  topics: Record<string, TalkTopicDef>;
  missions: Record<string, MissionDef>;
  factions: Record<string, FactionDef>;
  eocs: Record<string, any>;
  names: { male: string[]; female: string[]; family: string[] };
}

// ------------------------------------------------------------------ enums

/** npc_attitude (npc.h), by name. Template JSON uses the numeric enum. */
export type NpcAttitude =
  | 'NULL' | 'TALK' | 'FOLLOW' | 'LEAD' | 'WAIT' | 'MUG' | 'WAIT_FOR_LEAVE' | 'KILL' | 'FLEE' | 'HEAL' | 'ACTIVITY' | 'FLEE_TEMP' | 'RECOVER_GOODS';
const ATTITUDE_BY_NUM: NpcAttitude[] = [
  'NULL', 'TALK', 'NULL', 'FOLLOW', 'NULL', 'LEAD', 'WAIT', 'NULL', 'MUG', 'WAIT_FOR_LEAVE', 'KILL', 'FLEE', 'NULL', 'HEAL', 'NULL', 'NULL', 'ACTIVITY', 'FLEE_TEMP', 'RECOVER_GOODS',
];
export function attitudeFromJson(v: unknown): NpcAttitude {
  if (typeof v === 'number') return ATTITUDE_BY_NUM[v] ?? 'NULL';
  if (typeof v === 'string') return (v.replace(/^NPCATT_/, '') as NpcAttitude) || 'NULL';
  return 'NULL';
}

/** npc_mission: what the NPC does when idle. */
export type NpcMission = 'NULL' | 'SHELTER' | 'SHOPKEEP' | 'GUARD_ALLY' | 'GUARD' | 'GUARD_PATROL' | 'ACTIVITY' | 'TRAVELLING' | 'CAMP_RESIDENT';
const MISSION_BY_NUM: NpcMission[] = ['NULL', 'NULL', 'SHELTER', 'SHOPKEEP', 'GUARD_ALLY', 'GUARD', 'GUARD_PATROL', 'ACTIVITY', 'TRAVELLING', 'CAMP_RESIDENT'];
export function missionFromJson(v: unknown): NpcMission {
  if (typeof v === 'number') return MISSION_BY_NUM[v] ?? 'NULL';
  if (typeof v === 'string') return (v.replace(/^NPC_MISSION_/, '') as NpcMission) || 'NULL';
  return 'NULL';
}

export interface Personality {
  aggression: number;
  bravery: number;
  collector: number;
  altruism: number;
}

/** npc_opinion op_of_u. */
export interface Opinion {
  trust: number;
  fear: number;
  value: number;
  anger: number;
  /** Positive: the NPC owes the survivor (cents). */
  owed: number;
}

export const FACTION_FOLLOWERS = 'your_followers';
export const FACTION_NONE = 'no_faction';
const PERSONALITY_MIN = -10, PERSONALITY_MAX = 10;

/** Default chatbin topics (dialogue_chatbin in dialogue_chatbin.h). */
export const DEFAULT_CHATBIN: Record<string, string> = {
  first_topic: 'TALK_NONE',
  talk_radio: 'TALK_RADIO',
  talk_leader: 'TALK_LEADER',
  talk_friend: 'TALK_FRIEND',
  talk_stole_item: 'TALK_STOLE_ITEM',
  talk_wake_up: 'TALK_WAKE_UP',
  talk_mug: 'TALK_MUG',
  talk_stranger_aggressive: 'TALK_STRANGER_AGGRESSIVE',
  talk_stranger_scared: 'TALK_STRANGER_SCARED',
  talk_stranger_wary: 'TALK_STRANGER_WARY',
  talk_stranger_friendly: 'TALK_STRANGER_FRIENDLY',
  talk_stranger_neutral: 'TALK_STRANGER_NEUTRAL',
  talk_friend_guard: 'TALK_FRIEND_GUARD',
  talk_mission_inquire: 'TALK_MISSION_INQUIRE',
  talk_mission_describe_urgent: 'TALK_MISSION_DESCRIBE_URGENT',
};

// ------------------------------------------------------------------ distributions (npc_class.cpp)

/**
 * Roll a CDDA npc_class distribution: number | {constant} | {one_in} | {dice:[n,s]} |
 * {rng:[a,b]} | {sum:[...]} | {mul:[...]}. Unknown shapes warn once and roll 0.
 */
export function rollDistribution(d: unknown, rng: Rng): number {
  if (d === undefined || d === null) return 0;
  if (typeof d === 'number') return d;
  if (typeof d !== 'object') return 0;
  const o = d as Record<string, any>;
  if (typeof o.constant === 'number') return o.constant;
  if (typeof o.one_in === 'number') return o.one_in > 1 && rng.next() * o.one_in < 1 ? 1 : 0;
  if (Array.isArray(o.dice)) return rng.dice(o.dice[0], o.dice[1]);
  if (Array.isArray(o.rng)) return rng.int(o.rng[0], o.rng[1]);
  if (Array.isArray(o.sum)) return o.sum.reduce((s: number, x: unknown) => s + rollDistribution(x, rng), 0);
  if (Array.isArray(o.mul)) return o.mul.reduce((s: number, x: unknown) => s * rollDistribution(x, rng), 1);
  warnOnce('npc_distribution', JSON.stringify(d).slice(0, 60));
  return 0;
}

/** npc_class::roll_skill for every skill: class "level" (or the "ALL" default) + "bonus", >= 0. */
export function rollClassSkills(cls: NpcClassDef | undefined, skillIds: string[], rng: Rng): Record<string, number> {
  const level = new Map<string, unknown>(), bonus = new Map<string, unknown>();
  for (const s of cls?.skills ?? []) {
    if (s.level !== undefined) level.set(s.skill, s.level);
    if (s.bonus !== undefined) bonus.set(s.skill, s.bonus);
  }
  const out: Record<string, number> = {};
  for (const id of skillIds) {
    const l = level.has(id) ? level.get(id) : level.get('ALL');
    const b = bonus.has(id) ? bonus.get(id) : bonus.get('ALL');
    if (l === undefined && b === undefined) continue;
    out[id] = Math.max(0, Math.round(rollDistribution(l, rng) + rollDistribution(b, rng)));
  }
  return out;
}

// ------------------------------------------------------------------ the NPC

export interface NpcJSON {
  uid: number;
  character: CharacterJSON;
  templateId?: string;
  classId: string;
  x: number;
  y: number;
  z: number;
  facing: number;
  attitude: NpcAttitude;
  mission: NpcMission;
  faction: string;
  nameSuffix?: string;
  personality: Personality;
  op: Opinion;
  chat: Record<string, string>;
  vars: [string, string][];
  talkEffects: [string, number][];
  missionIds: number[];
  missionSelected: number | null;
  guardPos: { x: number; y: number; z: number } | null;
  stock: ItemJSON[];
  restockAt: number;
  following: boolean;
  spawnKey?: string;
}

let nextNpcUid = 1;

export class Npc extends Character {
  uid = nextNpcUid++;
  templateId?: string;
  classId = 'NC_NONE';
  x = 0;
  y = 0;
  z = 0;
  /** Radians, 0 = north, clockwise (like monsters and the player's yaw). */
  facing = 0;
  attitude: NpcAttitude = 'NULL';
  mission: NpcMission = 'NULL';
  faction = FACTION_NONE;
  nameSuffix?: string;
  personality: Personality = { aggression: 0, bravery: 0, collector: 0, altruism: 0 };
  op: Opinion = { trust: 0, fear: 0, value: 0, anger: 0, owed: 0 };
  chat: Record<string, string> = { ...DEFAULT_CHATBIN };
  /** Dialogue variables (npc_add_var / npc_val / n_ math vars). Values are strings like CDDA's. */
  readonly vars = new Map<string, string>();
  /** Dialogue-only timed effects (npc_add_effect ids we don't simulate): id -> expiry in game seconds. */
  readonly talkEffects = new Map<string, number>();
  /** Uids of missions this NPC offers or has handed out (MissionSystem instances). */
  missionIds: number[] = [];
  missionSelected: number | null = null;
  /** Where a guard/shopkeeper returns to (RETURN_TO_START_POS); set at spawn. */
  guardPos: { x: number; y: number; z: number } | null = null;
  /** Shopkeeper stock (CDDA keeps it in loot zones; we keep it on the NPC). */
  stock: Item[] = [];
  restockAt = 0;
  /** Follower ordered to walk with the survivor (false = "wait here"). */
  following = false;
  /** Mapgen placement key so a regenerated/reloaded chunk doesn't spawn the NPC twice. */
  spawnKey?: string;

  // --- AI scratch state (npcai.ts); not serialized
  dead_ = false;
  moving = false;
  walkPhase = 0;
  attackCooldown = 0;
  thinkTimer = 0;
  hitFlash = 0;
  path: [number, number][] = [];
  pathGoalX = 0;
  pathGoalY = 0;
  pathAge = 99;
  pathPending = false;
  stuckTime = 0;
  goal: { kind: 'none' | 'wander' | 'follow' | 'flee' | 'fight' | 'return' | 'approach'; x: number; y: number; target?: unknown } = { kind: 'none', x: 0, y: 0 };
  idleTimer = 0;
  lastSpeech = -Infinity;
  /** Real seconds this NPC stays angry-fleeing (FLEE_TEMP). */
  fleeTime = 0;

  constructor(data: GameData, seed: number) {
    super(data, { seed });
  }

  get tileX(): number {
    return Math.floor(this.x);
  }
  get tileY(): number {
    return Math.floor(this.y);
  }

  /** "Smokes, Merchant" (name + suffix, like CDDA's disp_name with play_name_suffix). */
  displayName(): string {
    return this.nameSuffix ? `${this.name}, ${this.nameSuffix}` : this.name;
  }

  isAlly(): boolean {
    return this.faction === FACTION_FOLLOWERS;
  }
  /** npc::is_enemy / attitude_group::hostile. */
  isEnemy(): boolean {
    return this.attitude === 'KILL' || this.attitude === 'MUG' || this.attitude === 'WAIT_FOR_LEAVE';
  }
  isFriendly(): boolean {
    return this.isAlly() || this.attitude === 'FOLLOW' || this.attitude === 'LEAD' || this.attitude === 'WAIT' || this.attitude === 'HEAL';
  }
  isFollower(): boolean {
    return this.isAlly() || this.attitude === 'FOLLOW';
  }
  isShopkeeper(): boolean {
    return this.mission === 'SHOPKEEP';
  }
  hasTalkEffect(id: string, now: number): boolean {
    const t = this.talkEffects.get(id);
    return (t !== undefined && t > now) || this.effects.has(id);
  }

  /** npc::hostile_anger_level */
  hostileAngerLevel(): number {
    return 20 + this.op.fear - this.personality.aggression;
  }

  /** npc::make_angry: fight back, or run if the survivor is too scary. Allies mutiny. */
  makeAngry(): void {
    if (this.isEnemy()) return;
    if (this.isAlly()) this.faction = FACTION_NONE;
    this.following = false;
    if (this.op.fear > 10 + this.personality.aggression + this.personality.bravery) this.attitude = 'FLEE_TEMP';
    else this.attitude = 'KILL';
  }

  /** npc::intimidation (Character::intimidation): str*2, +10 gun, +5 heavy melee weapon. */
  intimidation(): number {
    let r = this.str * 2;
    const w = this.inv.wielded;
    if (w?.isGun()) r += 10;
    else if (w && (w.meleeDamage('bash') >= 12 || w.meleeDamage('cut') >= 12 || w.meleeDamage('stab') >= 12)) r += 5;
    return r;
  }

  override toJSON(): CharacterJSON & { npc: NpcJSON } {
    const character = super.toJSON();
    return { ...character, npc: this.npcJSON(character) };
  }

  npcJSON(character = super.toJSON()): NpcJSON {
    return {
      uid: this.uid, character, templateId: this.templateId, classId: this.classId,
      x: this.x, y: this.y, z: this.z, facing: this.facing,
      attitude: this.attitude, mission: this.mission, faction: this.faction, nameSuffix: this.nameSuffix,
      personality: { ...this.personality }, op: { ...this.op }, chat: { ...this.chat },
      vars: [...this.vars], talkEffects: [...this.talkEffects],
      missionIds: [...this.missionIds], missionSelected: this.missionSelected,
      guardPos: this.guardPos ? { ...this.guardPos } : null,
      stock: this.stock.map((i) => i.toJSON()), restockAt: this.restockAt, following: this.following, spawnKey: this.spawnKey,
    };
  }

  static fromJSON(data: GameData, j: NpcJSON): Npc {
    const n = new Npc(data, j.uid);
    n.load(j.character);
    n.uid = j.uid;
    nextNpcUid = Math.max(nextNpcUid, j.uid + 1);
    Object.assign(n, {
      templateId: j.templateId, classId: j.classId, x: j.x, y: j.y, z: j.z, facing: j.facing,
      attitude: j.attitude, mission: j.mission, faction: j.faction, nameSuffix: j.nameSuffix,
      personality: { ...j.personality }, op: { ...j.op }, chat: { ...DEFAULT_CHATBIN, ...j.chat },
      missionIds: [...j.missionIds], missionSelected: j.missionSelected,
      guardPos: j.guardPos ? { ...j.guardPos } : null, restockAt: j.restockAt, following: j.following, spawnKey: j.spawnKey,
    });
    for (const [k, v] of j.vars) n.vars.set(k, v);
    for (const [k, v] of j.talkEffects) n.talkEffects.set(k, v);
    n.stock = j.stock.map((s) => Item.fromJSON(data, s));
    return n;
  }
}

// ------------------------------------------------------------------ generation

export interface NpcSpec {
  /** npc template id (mapgen place_npcs "class" field is a template id). */
  template?: string;
  /** npc_class id for a random NPC of that class (no template). */
  cls?: string;
  male?: boolean;
}

function itemsFromGroup(data: GameData, group: string, rng: Rng): Item[] {
  if (!data.itemGroups[group]) return [];
  const out: Item[] = [];
  for (const s of expandItemGroup(data, group, rng)) out.push(...fromSpawned(data, s));
  return out;
}

/** random_item_from: "<class>_<what>" or the fallback group; may be empty. */
function randomItemFrom(data: GameData, cls: string, what: string, rng: Rng, fallback: string | null = `npc_${what}`): Item[] {
  const own = itemsFromGroup(data, `${cls}_${what}`, rng);
  if (own.length) return own;
  return fallback ? itemsFromGroup(data, fallback, rng) : [];
}

function clothingItem(data: GameData, cls: string, what: string, male: boolean, rng: Rng): Item[] {
  const g = male ? 'male' : 'female';
  const a = randomItemFrom(data, cls, `${what}_${g}`, rng, null);
  if (a.length) return a;
  return randomItemFrom(data, cls, what, rng, `npc_${what}_${g}`);
}

const WEAPON_SKILLS = ['stabbing', 'bashing', 'cutting', 'throw', 'archery', 'pistol', 'shotgun', 'smg', 'rifle'];
const WEAPON_FALLBACK: Record<string, string | null> = {
  stabbing: 'survivor_stabbing', bashing: 'survivor_bashing', cutting: 'survivor_cutting', throw: null, archery: null,
  pistol: 'guns_pistol_common', shotgun: 'guns_shotgun_common', smg: 'guns_smg_common', rifle: 'guns_rifle_common',
};

/** Load a gun with its default magazine/ammo so NPC gunmen can actually shoot. */
function loadGun(data: GameData, gun: Item): void {
  if (!gun.isGun() || gun.ammoRemaining() > 0) return;
  const ammo = defaultAmmoId(data, gun.ammoTypes()[0] ?? '');
  if (ammo) loadAmmo(gun, ammo);
}

/**
 * Create an NPC from a template id or a class id (npc::load_npc_template / npc::randomize).
 * Throws on unknown ids: callers (mapgen, debug) should check `nd.templates` first.
 */
export function generateNpc(data: GameData, nd: NpcData, spec: NpcSpec, seed: number): Npc {
  const rng = new Rng(seed);
  const tem = spec.template ? nd.templates[spec.template] : undefined;
  if (spec.template && !tem) throw new Error(`generateNpc: unknown npc template ${spec.template}`);
  const classId = tem?.class ?? spec.cls ?? 'NC_NONE';
  const cls = nd.classes[classId];
  if (classId !== 'NC_NONE' && !cls) throw new Error(`generateNpc: unknown npc_class ${classId}`);
  const n = new Npc(data, seed);
  n.templateId = tem?.id;
  n.classId = classId;
  // randomize_personality
  n.personality = {
    aggression: rng.int(PERSONALITY_MIN, PERSONALITY_MAX),
    bravery: rng.int(-3, PERSONALITY_MAX),
    collector: rng.int(-1, PERSONALITY_MAX),
    altruism: Math.round(Math.max(PERSONALITY_MIN, Math.min(PERSONALITY_MAX, normal(rng) * 3))),
  };
  if (tem?.personality) Object.assign(n.personality, tem.personality);
  n.male = tem?.gender ? tem.gender === 'male' : spec.male ?? rng.oneIn(2);
  const given = rng.pick(n.male ? nd.names.male : nd.names.female);
  n.name = tem?.name_unique ?? `${given} ${rng.pick(nd.names.family)}`;
  n.nameSuffix = tem?.name_suffix;
  n.str_base = (tem?.str ?? rng.dice(4, 3)) + Math.round(rollDistribution(cls?.bonus_str, rng));
  n.dex_base = (tem?.dex ?? rng.dice(4, 3)) + Math.round(rollDistribution(cls?.bonus_dex, rng));
  n.int_base = (tem?.int ?? rng.dice(4, 3)) + Math.round(rollDistribution(cls?.bonus_int, rng));
  n.per_base = (tem?.per ?? rng.dice(4, 3)) + Math.round(rollDistribution(cls?.bonus_per, rng));
  const p = n.personality;
  p.aggression = clampP(p.aggression + rollDistribution(cls?.bonus_aggression, rng));
  p.bravery = clampP(p.bravery + rollDistribution(cls?.bonus_bravery, rng));
  p.collector = clampP(p.collector + rollDistribution(cls?.bonus_collector, rng));
  p.altruism = clampP(p.altruism + rollDistribution(cls?.bonus_altruism, rng));
  const skillIds = Object.keys(data.misc.skill ?? {});
  for (const [id, lvl] of Object.entries(rollClassSkills(cls, skillIds, rng))) if (lvl > 0) n.setSkill(id, lvl);
  n.recalcHp(true);
  n.stamina = n.staminaMax();
  // Fixed class traits (NO_BASH, RETURN_TO_START_POS, ...): kept as flags the AI reads.
  for (const t of cls?.traits ?? []) if (t.trait) n.traits.add(t.trait);

  equipNpc(data, n, cls, classId, rng);

  if (tem) {
    n.attitude = attitudeFromJson(tem.attitude);
    n.mission = missionFromJson(tem.mission);
    n.faction = tem.faction ?? FACTION_NONE;
    n.chat.first_topic = tem.chat ?? 'TALK_NONE';
    for (const k of Object.keys(DEFAULT_CHATBIN)) if (typeof tem[k] === 'string') n.chat[k] = tem[k] as string;
  }
  n.resetStats();
  return n;
}

/** starting_weapon + starting_clothes + starting_inv (npc.cpp), simplified. */
function equipNpc(data: GameData, n: Npc, cls: NpcClassDef | undefined, classId: string, rng: Rng): void {
  const male = n.male;
  const worn: Item[] = [];
  if (cls?.worn_override && data.itemGroups[cls.worn_override]) worn.push(...itemsFromGroup(data, cls.worn_override, rng));
  else {
    for (const w of ['pants', 'shirt', 'underwear_top', 'underwear_bottom', 'underwear_feet', 'shoes']) worn.push(...clothingItem(data, classId, w, male, rng));
    for (const w of ['gloves', 'coat', 'vest', 'masks', 'hat', 'scarf', 'storage', 'holster', 'belt', 'wrist', 'extra']) worn.push(...randomItemFrom(data, classId, w, rng));
    worn.push(...randomItemFrom(data, classId, 'glasses', rng, 'npc_eyes'));
  }
  const quiet = n.onMessage;
  n.onMessage = null;
  try {
    for (const it of worn) if (n.inv.canWear(it).ok) n.inv.wear(it, null);
    // Weapon: override group, else the group for the NPC's best weapon skill.
    let weaponRoll: Item[] = [];
    if (cls?.weapon_override && data.itemGroups[cls.weapon_override]) weaponRoll = itemsFromGroup(data, cls.weapon_override, rng);
    else {
      let best = '', bl = 0;
      for (const s of WEAPON_SKILLS) if (n.getSkill(s) > bl) (bl = n.getSkill(s)), (best = s);
      if (best) weaponRoll = randomItemFrom(data, classId, best, rng, WEAPON_FALLBACK[best]);
    }
    // Gun groups roll the gun together with spare magazines/ammo, not always gun first: wield
    // the gun (an NPC "wielding" a Glock magazine was the result) and carry the rest.
    const weapon: Item | undefined = weaponRoll.find((it) => it.isGun()) ?? weaponRoll[0];
    if (weapon) {
      loadGun(data, weapon);
      n.inv.wield(weapon, null);
    }
    const carried: Item[] = weaponRoll.filter((it) => it !== weapon);
    if (cls?.carry_override && data.itemGroups[cls.carry_override]) carried.push(...itemsFromGroup(data, cls.carry_override, rng));
    else {
      let qty = rng.int(2, 6);
      while (qty-- > 0) carried.push(...randomItemFrom(data, classId, 'misc', rng));
      if (weapon?.isGun()) {
        const ammo = defaultAmmoId(data, weapon.ammoTypes()[0] ?? '');
        if (ammo && data.items[ammo]) carried.push(createItem(data, ammo, { count: Math.max(1, Math.min(30, ((data.items[ammo] as { count?: number }).count ?? 10))) }));
      }
    }
    // what doesn't fit in their pack isn't generated at all (a new NPC has nothing on the ground)
    for (const it of carried) if (!it.hasFlag('TRADER_AVOID')) n.inv.stashNew(it);
  } finally {
    n.onMessage = quiet;
  }
}

/**
 * Shopkeeper stock from shopkeeper_item_group (npc::shop_restock, simplified: every group
 * the NPC's faction trust allows, rigid groups once, others rolled until ~ a stock value).
 */
export function restockShop(data: GameData, nd: NpcData, n: Npc, seed: number, factionTrust = 0): void {
  const cls = nd.classes[n.classId];
  const groups = cls?.shopkeeper_item_group ?? [];
  if (!groups.length) return;
  const rng = new Rng(seed);
  const stock: Item[] = [];
  let value = 0;
  const target = 150000;
  for (const g of groups) {
    if ((g.trust ?? 0) > factionTrust) continue;
    if (g.condition !== undefined) continue; // conditional stock needs the dialogue engine; skipped
    const rolls = g.rigid ? 1 : 3;
    for (let i = 0; i < rolls && (g.rigid || value < target); i++) {
      for (const it of itemsFromGroup(data, g.group, rng)) {
        stock.push(it);
        value += (it.def.price_postapoc ?? it.def.price ?? 0) * Math.max(1, it.countByCharges ? it.charges / Math.max(1, it.stackSize()) : 1);
      }
    }
  }
  n.stock = stock;
}

function clampP(v: number): number {
  return Math.max(PERSONALITY_MIN, Math.min(PERSONALITY_MAX, Math.round(v)));
}

function normal(rng: Rng): number {
  const u = Math.max(1e-9, rng.next()), v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

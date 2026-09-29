import type { Rng } from '../core/rng';
import { DAYS_PER_SEASON, SECONDS_PER_DAY } from '../core/time';
import type { GameData } from '../data/types';
import { expandItemGroup, itemName } from '../data/index';
import { warnOnce } from '../data/warn';
import type { Character } from './character';
import { createItem, fromSpawned, type Item } from './item';
import { FACTION_FOLLOWERS, FACTION_NONE, type Npc, type NpcData, type TalkTopicDef } from './npc';
import type { MissionInstance, MissionSystem } from './missions';
import { evalMath, evalMathArray, type MathHost, type MathValue, type VarScope } from './talkmath';
import type { BodyPartId } from './bodyparts';
import { MAIN_PARTS } from './bodyparts';

// The CDDA dialogue engine (npctalk.cpp, condition.cpp, talker_*.cpp), UI-free:
//  - talk_topic dynamic lines (strings, random arrays, conditional objects, concatenate,
//    gendered_line), speaker_effect with sentinels
//  - responses with condition / switch+default / show_always / truefalsetext / trials
//    (LIE, PERSUADE, INTIMIDATE with CDDA's calc_chance, CONDITION, SKILL_CHECK), success and
//    failure branches with opinion changes and effects
//  - a subset of dialogue conditions and effects (see COND / EFFECT tables); anything else
//    warns once and counts as false / no-op, as ARCHITECTURE.md asks.
// The world is reached through TalkWorld so tests can run real talk topics headlessly.

// ------------------------------------------------------------------ host interface

export interface TalkPlayer extends Character {
  x: number;
  y: number;
  z: number;
}

export interface TalkWorld {
  data: GameData;
  nd: NpcData;
  player: TalkPlayer;
  /** The survivor's dialogue variables (u_add_var, u_val, u_ math vars). */
  playerVars: Map<string, string>;
  globals: Map<string, string>;
  /** Dialogue-only timed effects on the survivor: id -> expiry (game seconds). */
  playerTalkEffects: Map<string, number>;
  /** Faction trust in the survivor (faction likes_u, CDDA u_add_faction_trust). */
  factionTrust: Map<string, number>;
  /** The survivor's e-cash in cents (CDDA's deprecated `cash`; u_spend_cash/u_has_cash). */
  cash: number;
  rng: Rng;
  /** Game seconds since the cataclysm began (GameClock.seconds). */
  now(): number;
  missions: MissionSystem;
  message(text: string, color?: string): void;
  // Optional hooks the game wires; headless tests may leave them out.
  /** Open the trade screen; `cost` > 0 means the survivor must pay that much in goods. */
  startTrade?(npc: Npc, cost?: number, onDone?: (traded: boolean) => void): void;
  /** Let the survivor pick one of their items (npc_gets_item). */
  pickItem?(title: string, items: Item[], onPick: (it: Item | null) => void): void;
  /** Put an item on the ground at a position. */
  dropItem?(it: Item, x: number, y: number, z: number): void;
  /** Allied NPCs near the survivor (npc_allies, give_aid_all). */
  alliesNear?(): Npc[];
  /** Overmap terrain id at an OMT (npc_at_om_location). */
  omtAt?(omx: number, omy: number, z: number): string | undefined;
  cityName?(): string;
  totalKills?(): number;
  isDay?(): boolean;
  isOutside?(x: number, y: number, z: number): boolean;
  /** No hostile creature in sight (CDDA at_safe_space: only safe monsters in the OMT). */
  safeSpace?(): boolean;
  /** An NPC turned hostile (effect hostile/insult_combat, or anger past its limit). */
  onHostile?(npc: Npc): void;
}

// ------------------------------------------------------------------ views for the UI

export interface ResponseView {
  /** Display text (tags expanded, trial prefix like "[PERSUADE 45%] "). */
  text: string;
  /** CDDA option color: red (hostile), light_red ('*' / helpless), green ('&' / actions), white. */
  color: string;
  /** False: shown greyed (show_always/show_condition/failure_explanation or debug view). */
  available: boolean;
  /** Only visible because the UI asked to show hidden options (dark gray). */
  hidden?: boolean;
  reason?: string;
  index: number;
}

export interface TopicView {
  id: string;
  /** What the NPC says (already formatted: quoted, or "Name does something" for '*' lines). */
  line: string;
  responses: ResponseView[];
}

export interface ChooseResult {
  /** Text the survivor said (for the log). */
  said: string;
  /** Trial outcome when the response had one. */
  trial?: { kind: string; chance: number; success: boolean };
  done: boolean;
}

interface Resp {
  raw: any;
  /** Built-in responses carry a mission to select. */
  mission?: MissionInstance;
  available: boolean;
  hidden?: boolean;
  reason?: string;
  topicItem?: string;
}

// Effects that end the conversation the moment they run.
const ENDS_TALK = new Set(['hostile', 'insult_combat', 'end_conversation', 'flee', 'start_mugging', 'npc_die']);
const ACTION_EFFECTS = new Set(['start_trade', 'follow', 'follow_only', 'stop_following', 'leave', 'assign_guard', 'stop_guard', 'give_equipment', 'npc_gets_item', 'npc_gets_item_to_use', 'player_weapon_away', 'player_weapon_drop', 'assign_mission', 'mission_reward']);

// ------------------------------------------------------------------ the dialogue

export class Dialogue implements MathHost {
  /** Topic stack; the last entry is current. TALK_NONE pops. */
  readonly topics: string[] = [];
  /** Conversation log for the UI: [speaker, text]. */
  readonly log: { who: 'npc' | 'u' | 'info'; text: string }[] = [];
  done = false;
  /** Show every response whose condition failed, in dark gray (debug / curiosity toggle). */
  showHidden = false;
  private context = new Map<string, string>();
  private resps: Resp[] = [];
  private lineCache: { topic: string; line: string } | null = null;
  private reason = '';
  private topicItem: string | undefined;
  /** Effects queued to run after the dialogue window closes (start_trade opens a window). */
  readonly after: (() => void)[] = [];

  constructor(readonly w: TalkWorld, readonly npc: Npc) {}

  get data(): GameData {
    return this.w.data;
  }
  get u(): TalkPlayer {
    return this.w.player;
  }
  get current(): string {
    return this.topics[this.topics.length - 1] ?? 'TALK_DONE';
  }

  /** avatar::talk_to + talker_npc::get_topics: pick the opening topic(s). */
  start(): TopicView {
    const n = this.npc;
    this.w.missions.checkMissions(n);
    const add: string[] = [n.chat.first_topic];
    if (n.attitude === 'LEAD') add.push(n.chat.talk_leader);
    else if (n.isAlly() && n.following) add.push(n.chat.talk_friend);
    else if (n.isAlly()) add.push(n.guardPos ? n.chat.talk_friend_guard : n.chat.talk_friend);
    let hardest = 0;
    for (const m of this.w.missions.offeredBy(n)) {
      const def = this.w.nd.missions[m.id];
      if (def?.urgent && (def.difficulty ?? 0) > hardest) {
        add.push(n.chat.talk_mission_describe_urgent);
        n.missionSelected = m.uid;
        hardest = def.difficulty ?? 0;
      }
    }
    hardest = 0;
    let urgent = false;
    for (const m of this.w.missions.assignedFrom(n)) {
      const def = this.w.nd.missions[m.id];
      const du = !!def?.urgent, diff = def?.difficulty ?? 0;
      if ((du && !urgent) || (diff > hardest && (du || !urgent))) {
        urgent = du;
        add.push(n.chat.talk_mission_inquire);
        n.missionSelected = m.uid;
        hardest = diff;
      }
    }
    if (add[add.length - 1] === 'TALK_NONE') add[add.length - 1] = this.pickTalkTopic();
    for (const t of add) this.addTopic(t);
    return this.view();
  }

  /** npc::pick_talk_topic for strangers. */
  pickTalkTopic(): string {
    const n = this.npc, p = n.personality, op = n.op;
    if (p.aggression > 0) {
      if (op.fear * 2 < p.bravery && p.altruism < 0) {
        n.attitude = 'MUG';
        return n.chat.talk_mug;
      }
      if (p.aggression + p.bravery - op.fear > 0) return n.chat.talk_stranger_aggressive;
    }
    if (op.fear * 2 > p.altruism + p.bravery) return n.chat.talk_stranger_scared;
    if (op.fear * 2 > p.bravery + op.trust) return n.chat.talk_stranger_wary;
    if (op.trust - op.fear + (p.bravery + p.altruism) / 2 > 0) return n.chat.talk_stranger_friendly;
    if (n.attitude === 'TALK') n.attitude = 'NULL';
    return n.chat.talk_stranger_neutral;
  }

  private addTopic(id: string): void {
    if (id === 'TALK_NONE') {
      if (this.topics.length > 1) this.topics.pop();
    } else if (id === 'TALK_DONE') {
      this.done = true;
      this.topics.push(id);
    } else this.topics.push(id);
    this.lineCache = null;
  }

  // ---------------------------------------------------------------- topic rendering

  topicDef(id = this.current): TalkTopicDef | undefined {
    return this.w.nd.topics[id];
  }

  /** The current topic: NPC line (computed once per visit, speaker effects run then) + responses. */
  view(): TopicView {
    const id = this.current;
    if (!this.lineCache || this.lineCache.topic !== id) {
      let raw = this.dynamicLine(id);
      this.lineCache = { topic: id, line: raw };
      this.runSpeakerEffects(id);
      raw = this.lineCache.line;
      if (raw) this.log.push({ who: 'npc', text: this.formatNpcLine(raw) });
      this.genResponses(id);
    }
    return {
      id,
      line: this.lineCache.line ? this.formatNpcLine(this.lineCache.line) : '',
      responses: this.resps.map((r, i) => this.responseView(r, i)).filter((r) => !r.hidden || this.showHidden),
    };
  }

  /** Recompute the response list (e.g. after the showHidden toggle or an item changed hands). */
  refresh(): TopicView {
    this.genResponses(this.current);
    return this.view();
  }

  /** '*' lines are actions ("Smokes drops his weapon."); '&' lines are unquoted narration. */
  formatNpcLine(line: string): string {
    if (line.startsWith('*')) return `${this.npc.name} ${line.slice(1)}`;
    if (line.startsWith('&')) return line.slice(1);
    return `"${line}"`;
  }

  private dynamicLine(id: string): string {
    const def = this.topicDef(id);
    let line = '';
    const builtin = this.builtinLine(id);
    if (builtin !== undefined) line = builtin;
    else if (def?.dynamic_line !== undefined) line = this.evalDynamicLine(def.dynamic_line);
    return this.parseTags(line);
  }

  /** Hardcoded dynamic lines (dialogue::dynamic_line) for topics json leaves to C++. */
  private builtinLine(id: string): string | undefined {
    const mtopics: Record<string, string> = {
      TALK_MISSION_DESCRIBE: 'describe', TALK_MISSION_DESCRIBE_URGENT: 'describe', TALK_MISSION_OFFER: 'offer',
      TALK_MISSION_ACCEPTED: 'accepted', TALK_MISSION_REJECTED: 'rejected', TALK_MISSION_ADVICE: 'advice',
      TALK_MISSION_INQUIRE: 'inquire', TALK_MISSION_SUCCESS: 'success', TALK_MISSION_SUCCESS_LIE: 'success_lie', TALK_MISSION_FAILURE: 'failure',
    };
    if (mtopics[id]) {
      const m = this.selectedMission();
      if (!m) return '';
      const def = this.w.nd.missions[m.id];
      let s = def?.dialogue?.[mtopics[id]] ?? '';
      if (id === 'TALK_MISSION_SUCCESS' && def?.followup) s += this.w.rng.pick(['  And I have more I\'d like you to do.', '  I could use a hand with something else if you are interested.', '  If you are interested, I have another job for you.']);
      return s;
    }
    if (id === 'TALK_NONE' || id === 'TALK_DONE') return this.byeMessage();
    if (id === 'TALK_DESCRIBE_MISSION') return this.describeMission();
    if (id === 'TALK_TRAIN') return "Sorry, but it doesn't seem I have anything to teach you.";
    if (id === 'TALK_SIZE_UP') return this.sizeUp();
    if (id === 'TALK_LOOK_AT') return `&You examine ${this.npc.name}.  ${this.npc.male ? 'He' : 'She'} seems to be ${this.npc.hpPercent() >= 80 ? 'in good health' : 'hurt'}.`;
    if (id === 'TALK_OPINION') {
      const op = this.npc.op;
      return `&Trust: ${op.trust}, Fear: ${op.fear}, Value: ${op.value}, Anger: ${op.anger}, Owed: ${(op.owed / 100).toFixed(2)}`;
    }
    return undefined;
  }

  private byeMessage(): string {
    const cls = this.w.nd.classes[this.npc.classId];
    const o = cls?.bye_message_override;
    if (o === 'null') return '';
    return this.parseTags(o ?? '<bye>');
  }

  private describeMission(): string {
    const job = this.w.nd.classes[this.npc.classId]?.job_description ?? "I'm just trying to survive.";
    switch (this.npc.mission) {
      case 'SHELTER': return `I'm holing up here for safety.  Long term, ${job}`;
      case 'SHOPKEEP': return 'I run the shop here.';
      case 'GUARD': case 'GUARD_ALLY': case 'GUARD_PATROL': return `Currently, I'm guarding this location.  Overall, ${job}`;
      default: return job;
    }
  }

  private sizeUp(): string {
    const n = this.npc, per = this.u.per;
    const est = (v: number) => (per >= 12 ? String(v) : `${Math.max(1, v - 2)}-${v + 2}`);
    return `&Strength ${est(n.str)}, Dexterity ${est(n.dex)}, Intelligence ${est(n.int)}, Perception ${est(n.per)}.`;
  }

  evalDynamicLine(dl: unknown): string {
    if (dl === undefined || dl === null) return '';
    if (typeof dl === 'string') return dl;
    if (Array.isArray(dl)) return dl.length ? this.evalDynamicLine(this.w.rng.pick(dl)) : '';
    if (typeof dl !== 'object') return String(dl);
    const o = dl as Record<string, any>;
    if (typeof o.str === 'string') return o.str;
    if (typeof o.gendered_line === 'string') return o.gendered_line;
    if (Array.isArray(o.concatenate)) return o.concatenate.map((x: unknown) => this.evalDynamicLine(x)).join('');
    if (o.give_hint) return this.parseTags('<hint>') || 'Keep your weapon close and your head down.';
    if (o.use_reason === true) {
      const r = this.reason;
      this.reason = '';
      return r;
    }
    if (o.list_faction_camp_sites) return "I can't think of a single place I can build a camp.";
    // dynamic_line_t(JsonObject): a simple string condition key picks yes/no (its value is the
    // "yes" line unless it is just `true`); otherwise the object itself is a complex condition.
    for (const [k, v] of Object.entries(o)) {
      if (!SIMPLE_CONDS.has(k)) continue;
      if (v === true) return this.evalDynamicLine(this.cond(k) ? o.yes : o.no);
      return this.evalDynamicLine(this.cond(k) ? v : o.no);
    }
    const { yes, no, ...rest } = o;
    return this.evalDynamicLine(this.cond(rest) ? yes : no);
  }

  private runSpeakerEffects(id: string): void {
    const def = this.topicDef(id);
    for (const se of def?.speaker_effect ?? []) {
      if (!se || typeof se !== 'object') continue;
      const key = se.sentinel ? `sentinel_${id}_${se.sentinel}` : null;
      if (key && this.npc.vars.get(key) === 'yes') continue;
      if (se.condition !== undefined && !this.cond(se.condition)) continue;
      if (key) this.npc.vars.set(key, 'yes');
      this.effect(se.effect);
    }
  }

  // ---------------------------------------------------------------- responses

  private genResponses(id: string): void {
    const out: Resp[] = [];
    const def = this.topicDef(id);
    let switched = false;
    const add = (raw: any, extra: Partial<Resp> = {}) => {
      if (!raw || typeof raw !== 'object') return;
      const isSwitch = !!raw.switch, isDefault = !!raw.default;
      if (isSwitch && switched) return;
      const ok = raw.condition === undefined || this.cond(raw.condition);
      if (ok) {
        out.push({ raw, available: true, ...extra });
        if (isSwitch && !isDefault) switched = true;
        return;
      }
      const showCond = raw.show_always === true || (raw.show_condition !== undefined && this.cond(raw.show_condition));
      if (showCond || raw.failure_explanation || raw.failure_topic) out.push({ raw, available: !!raw.failure_topic, reason: raw.show_reason ?? raw.failure_explanation, ...extra });
      else out.push({ raw, available: false, hidden: true, ...extra });
    };
    const responses = [...(def?.responses ?? [])];
    // insert_before_standard_exits: above a trailing TALK_NONE/TALK_DONE pair.
    if (def?.insert_before_exits?.length) {
      let at = responses.length;
      if (at && topicId(responses[at - 1]) === 'TALK_DONE') at--;
      if (at && topicId(responses[at - 1]) === 'TALK_NONE') at--;
      responses.splice(at, 0, ...def.insert_before_exits);
    }
    for (const r of responses) add(r);
    for (const rr of def?.repeat_responses ?? []) {
      const list: string[] = rr.for_item ? (Array.isArray(rr.for_item) ? rr.for_item : [rr.for_item]) : [];
      const owner: Character = rr.is_npc ? this.npc : this.u;
      for (const itemId of list) if (owner.inv.countOf(itemId) > 0) add(rr.response, { topicItem: itemId });
      if (rr.for_category) warnOnce('talk', 'repeat_responses.for_category', '[talk] repeat_responses for_category is unsupported');
    }
    this.builtinResponses(id, out);
    this.resps = out;
  }

  /** dialogue::gen_responses hardcoded parts (mission lists). */
  private builtinResponses(id: string, out: Resp[]): void {
    if (id === 'TALK_MISSION_LIST') {
      const offered = this.w.missions.offeredBy(this.npc);
      if (offered.length === 1) out.unshift({ raw: { text: 'Tell me about it.', topic: 'TALK_MISSION_OFFER' }, available: true, mission: offered[0] });
      else offered.reverse().forEach((m) => out.unshift({ raw: { text: this.w.nd.missions[m.id]?.name ?? m.id, topic: 'TALK_MISSION_OFFER' }, available: true, mission: m }));
    } else if (id === 'TALK_MISSION_LIST_ASSIGNED') {
      const mine = this.w.missions.assignedFrom(this.npc);
      if (mine.length === 1) out.unshift({ raw: { text: 'I have news.', topic: 'TALK_MISSION_INQUIRE' }, available: true, mission: mine[0] });
      else mine.reverse().forEach((m) => out.unshift({ raw: { text: this.w.nd.missions[m.id]?.name ?? m.id, topic: 'TALK_MISSION_INQUIRE' }, available: true, mission: m }));
    }
  }

  private responseText(raw: any, topicItem?: string): string {
    let text = '';
    if (raw.truefalsetext) text = this.cond(raw.truefalsetext.condition) ? raw.truefalsetext.true : raw.truefalsetext.false;
    else text = typeof raw.text === 'string' ? raw.text : '';
    const prev = this.topicItem;
    this.topicItem = topicItem;
    const s = this.parseTags(text);
    this.topicItem = prev;
    return s;
  }

  private responseView(r: Resp, index: number): ResponseView {
    const raw = r.raw;
    let text = this.responseText(raw, r.topicItem);
    const t = raw.trial;
    const kind = t?.type ?? 'NONE';
    if (kind === 'LIE' || kind === 'PERSUADE' || kind === 'INTIMIDATE') text = `[${kind} ${this.trialChance(t)}%] ${text}`;
    else if (kind === 'SKILL_CHECK') text = `[${this.data.misc.skill?.[t.skill_required]?.name ?? t.skill_required} ${Math.min(this.u.getSkill(t.skill_required), t.difficulty ?? 0)}/${t.difficulty ?? 0}] ${text}`;
    if (!r.available && r.reason && !r.hidden) text = `*${r.reason}: ${text}`;
    let color = 'c_white';
    const eff = [raw.effect, raw.success?.effect, kind !== 'NONE' ? raw.failure?.effect : undefined].flat().filter((e) => e !== undefined);
    const names = eff.map((e) => (typeof e === 'string' ? e : e && typeof e === 'object' ? Object.keys(e)[0] : '')).filter(Boolean) as string[];
    if (names.some((e) => e === 'hostile' || e === 'insult_combat')) color = 'c_red';
    else if (text.startsWith('*')) color = 'c_light_red';
    else if (text.startsWith('&') || names.some((e) => ACTION_EFFECTS.has(e))) color = 'c_green';
    if (!r.available) color = 'c_dark_gray';
    if (text.startsWith('&')) text = text.slice(1);
    return { text, color, available: r.available, hidden: r.hidden, reason: r.reason, index };
  }

  /** talk_trial::calc_chance */
  trialChance(t: any): number {
    const kind = t?.type ?? 'NONE';
    if (kind === 'NONE') return 100;
    if (kind === 'CONDITION') return this.cond(t.condition) ? 100 : 0;
    if (kind === 'SKILL_CHECK') return this.u.getSkill(t.skill_required) >= (t.difficulty ?? 0) ? 100 : 0;
    let chance = t.difficulty ?? 0;
    const n = this.npc, u = this.u, op = n.op;
    const speechU = u.int + u.per + u.getSkill('speech') * 3;
    const speechN = n.int + n.per + n.getSkill('speech') * 3;
    if (kind === 'LIE') chance += speechU + (-speechN + op.trust * 3);
    else if (kind === 'PERSUADE') chance += speechU + (-Math.trunc(speechN * 0.5) + op.trust * 2 + op.value);
    else if (kind === 'INTIMIDATE') chance += intimidation(u) + (-n.intimidation() + op.fear * 2 - n.personality.bravery * 2);
    for (const m of t.mod ?? []) if (Array.isArray(m)) chance += this.parseMod(String(m[0]), Number(m[1]) || 0);
    return Math.max(0, Math.min(100, chance));
  }

  /** talker_npc::parse_mod + talker_avatar::parse_mod */
  private parseMod(attr: string, factor: number): number {
    const n = this.npc, op = n.op, p = n.personality;
    let v = 0;
    switch (attr) {
      case 'ANGER': v = op.anger; break;
      case 'FEAR': v = op.fear; break;
      case 'TRUST': v = op.trust; break;
      case 'VALUE': v = op.value; break;
      case 'POS_FEAR': v = Math.max(0, op.fear); break;
      case 'AGGRESSION': v = p.aggression; break;
      case 'ALTRUISM': v = p.altruism; break;
      case 'BRAVERY': v = p.bravery; break;
      case 'COLLECTOR': v = p.collector; break;
      case 'MISSIONS': v = Math.trunc(this.w.missions.completedValue(n) / 1000); break;
      case 'NPC_INTIMIDATE': v = n.intimidation(); break;
      case 'U_INTIMIDATE': v = intimidation(this.u); break;
      case 'TOTAL': v = 0; break;
      default:
        if (attr.startsWith('u_has_trait: ')) v = this.u.hasTrait(attr.slice(13)) ? 1 : 0;
        else if (attr.startsWith('npc_has_trait: ')) v = n.hasTrait(attr.slice(15)) ? 1 : 0;
        else warnOnce('talk_mod', attr, `[talk] unknown trial mod "${attr}"`);
    }
    return v * factor;
  }

  /** Pick a response by its index in view().responses. */
  choose(index: number): ChooseResult {
    const r = this.resps[index];
    if (!r) throw new Error(`Dialogue.choose: no response #${index}`);
    const raw = r.raw;
    const said = this.responseText(raw, r.topicItem);
    this.log.push({ who: 'u', text: said });
    if (r.mission) this.npc.missionSelected = r.mission.uid;
    this.topicItem = r.topicItem;
    if (!r.available) {
      if (raw.failure_topic) this.addTopic(typeof raw.failure_topic === 'string' ? raw.failure_topic : raw.failure_topic.id);
      return { said, done: this.done };
    }
    const t = raw.trial;
    const kind = t?.type ?? 'NONE';
    let success = true, chance = 100;
    if (kind !== 'NONE') {
      chance = this.trialChance(t);
      success = this.w.rng.int(0, 99) < chance;
      if (kind === 'LIE' || kind === 'PERSUADE' || kind === 'INTIMIDATE') this.u.practice('speech', Math.trunc((100 - chance) / (success ? 10 : 7)));
    }
    // Short form: text/topic/effect/opinion on the response itself is the success branch.
    const branch = kind === 'NONE' || success ? raw.success ?? raw : raw.failure ?? {};
    this.applyBranch(branch, raw);
    return { said, trial: kind !== 'NONE' ? { kind, chance, success } : undefined, done: this.done };
  }

  private applyBranch(b: any, raw: any): void {
    if (b.opinion) this.applyOpinion(b.opinion);
    if (b.mission_opinion) {
      const m = this.selectedMission();
      const value = m ? this.w.nd.missions[m.id]?.value ?? 0 : 0;
      const o = b.mission_opinion;
      const scaled: Record<string, number> = {};
      for (const k of ['trust', 'fear', 'value', 'anger']) if (o[k]) scaled[k] = Math.trunc(value / o[k] / 1000);
      this.applyOpinion(scaled);
    }
    const topicsBefore = this.done;
    this.effect(b.effect);
    const next = b.topic ?? raw.topic;
    if (this.done && !topicsBefore) return;
    if (next === undefined) this.addTopic('TALK_NONE');
    else if (typeof next === 'string') this.addTopic(next);
    else if (next && typeof next === 'object' && typeof next.id === 'string') {
      // Inline topic object: register it for this conversation.
      this.w.nd.topics[next.id] ??= { dynamic_line: next.dynamic_line, responses: next.responses ?? [] };
      this.addTopic(next.id);
    }
  }

  /** Opinion changes; talk_effect_t::apply makes the NPC hostile when anger passes its limit. */
  applyOpinion(o: Record<string, number>): void {
    const op = this.npc.op;
    op.trust += o.trust ?? 0;
    op.fear += o.fear ?? 0;
    op.value += o.value ?? 0;
    op.anger += o.anger ?? 0;
    op.owed += o.owed ?? 0;
    if ((o.anger ?? 0) > 0 && op.anger > this.npc.hostileAngerLevel()) this.makeHostile();
  }

  private makeHostile(): void {
    this.npc.makeAngry();
    this.done = true;
    this.w.onHostile?.(this.npc);
  }

  selectedMission(): MissionInstance | undefined {
    const uid = this.npc.missionSelected;
    return uid === null ? undefined : this.w.missions.get(uid);
  }

  // ---------------------------------------------------------------- tags

  /** parse_tags: snippets (recursively), then the game-state tags. */
  parseTags(text: string, depth = 0): string {
    if (!text || depth > 6) return text;
    return text.replace(/<([a-zA-Z_!?][a-zA-Z0-9_!?:'. -]*)>/g, (m, tag: string) => {
      if (tag.startsWith('color_')) return m;
      const special = this.specialTag(tag);
      if (special !== undefined) return special;
      // NPC templates can override snippet categories ("<acknowledged>": "I gotcha fam").
      const tem = this.npc.templateId ? this.w.nd.templates[this.npc.templateId] : undefined;
      const over = tem?.[`<${tag}>`];
      if (typeof over === 'string') return this.parseTags(over, depth + 1);
      const list: unknown[] | undefined = this.data.misc.snippet?.[`<${tag}>`] ?? this.data.misc.snippet?.[tag];
      if (list?.length) {
        const s = this.w.rng.pick(list);
        return this.parseTags(typeof s === 'string' ? s : String((s as { text?: string })?.text ?? ''), depth + 1);
      }
      return m;
    });
  }

  private specialTag(tag: string): string | undefined {
    const u = this.u, n = this.npc;
    switch (tag) {
      case 'yrwp': return u.inv.wielded ? u.inv.wielded.name() : 'fists';
      case 'mywp': return n.inv.wielded ? n.inv.wielded.name() : 'fists';
      case 'u_name': return u.name;
      case 'npc_name': case 'npcname': return n.name;
      case 'mypronoun': return n.male ? 'He' : 'She';
      case 'mypossesivepronoun': return n.male ? 'his' : 'her';
      case 'ammo': {
        const a = n.inv.wielded?.ammoData();
        return a ? itemName(a) : 'BADAMMO';
      }
      case 'current_activity': return 'doing this and that';
      case 'topic_item': {
        const d = this.topicItem ? this.data.items[this.topicItem] : undefined;
        return d ? itemName(d) : 'item';
      }
      case 'topic_item_price': {
        const d = this.topicItem ? this.data.items[this.topicItem] : undefined;
        return `$${((d?.price_postapoc ?? d?.price ?? 0) / 100).toFixed(2)}`;
      }
      case 'interval': return 'a few days';
      case 'city': return this.w.cityName?.() ?? 'town';
      case 'time_survived': return `${Math.floor(this.w.now() / SECONDS_PER_DAY)} days`;
      case 'total_kills': return String(this.w.totalKills?.() ?? 0);
    }
    const colon = tag.indexOf(':');
    if (colon > 0) {
      const k = tag.slice(0, colon), arg = tag.slice(colon + 1);
      switch (k) {
        case 'u_val': return this.w.playerVars.get(arg) ?? '';
        case 'npc_val': return n.vars.get(arg) ?? '';
        case 'global_val': return this.w.globals.get(arg) ?? '';
        case 'context_val': return this.context.get(arg) ?? '';
        case 'item_name': return this.data.items[arg] ? itemName(this.data.items[arg]) : arg;
        case 'item_description': return String(this.data.items[arg]?.description ?? '');
        case 'trait_name': return u.traitName(arg);
        case 'reward_count': {
          const m = this.selectedMission();
          return String(m ? rewardCount(this.w.nd.missions[m.id], arg) : 0);
        }
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- variables (MathHost)

  getVar(scope: VarScope, name: string): string | undefined {
    if (scope === 'u') return this.w.playerVars.get(name);
    if (scope === 'npc') return this.npc.vars.get(name);
    if (scope === 'context') return this.context.get(name);
    return this.w.globals.get(name);
  }
  setVar(scope: VarScope, name: string, value: string | undefined): void {
    const m = scope === 'u' ? this.w.playerVars : scope === 'npc' ? this.npc.vars : scope === 'context' ? this.context : this.w.globals;
    if (value === undefined) m.delete(name);
    else m.set(name, value);
  }
  call(name: string, args: MathValue[], kw: Record<string, MathValue>): number | undefined {
    const now = this.w.now();
    const unitDiv = (u: MathValue | undefined) => ({ days: SECONDS_PER_DAY, hours: 3600, minutes: 60, seconds: 1, turns: 1 } as Record<string, number>)[String(u ?? 'turns')] ?? 1;
    switch (name) {
      case 'time_since': {
        const a = args[0];
        const since = a === 'cataclysm' || a === 'game_start' ? 0 : Number(a) || 0;
        return Math.floor((now - since) / unitDiv(kw.unit));
      }
      case 'time': {
        const a = args[0];
        if (a === 'now') return now;
        if (a === 'cataclysm') return 0;
        return parseDuration(String(a));
      }
      case 'u_val': case 'n_val': case 'npc_val': return this.charVal(name === 'u_val' ? this.u : this.npc, String(args[0]));
      case 'u_skill': case 'n_skill': return (name === 'u_skill' ? this.u : this.npc).getSkill(String(args[0]));
      case 'rng': return this.w.rng.int(Math.round(Number(args[0])), Math.round(Number(args[1])));
      case 'rand': return this.w.rng.int(0, Math.round(Number(args[0])));
      case 'u_has_trait': return this.u.hasTrait(String(args[0])) ? 1 : 0;
      case 'n_has_trait': return this.npc.hasTrait(String(args[0])) ? 1 : 0;
      case 'days_since': return Math.floor(now / SECONDS_PER_DAY);
    }
    return undefined;
  }

  private charVal(c: Character, what: string): number | undefined {
    switch (what) {
      case 'strength': return c.str;
      case 'dexterity': return c.dex;
      case 'intelligence': return c.int;
      case 'perception': return c.per;
      case 'strength_base': return c.str_base;
      case 'dexterity_base': return c.dex_base;
      case 'intelligence_base': return c.int_base;
      case 'perception_base': return c.per_base;
      case 'age': return c.age();
      case 'thirst': return c.thirst;
      case 'hunger': return c.hunger;
      case 'sleepiness': return c.sleepiness;
      case 'pain': return c.perceivedPain();
      case 'stamina': return c.stamina;
      case 'size': return 3;
    }
    warnOnce('talk_val', what, `[talk] unsupported u_val/n_val "${what}"`);
    return undefined;
  }

  // ---------------------------------------------------------------- conditions

  /** Evaluate a dialogue condition (string or object). Unsupported ones warn once -> false. */
  cond(c: unknown): boolean {
    if (c === undefined || c === null) return true;
    if (typeof c === 'boolean') return c;
    if (typeof c === 'string') return this.simpleCond(c);
    if (typeof c !== 'object' || Array.isArray(c)) return false;
    const o = c as Record<string, any>;
    if (Array.isArray(o.and)) return o.and.every((x: unknown) => this.cond(x));
    if (Array.isArray(o.or)) return o.or.some((x: unknown) => this.cond(x));
    if ('not' in o) return !this.cond(o.not);
    const keys = Object.keys(o).filter((k) => !k.startsWith('//'));
    const k = keys.find((x) => !COND_ARGS.has(x)) ?? keys[0];
    if (k === undefined) return true;
    return this.objectCond(k, o[k], o);
  }

  private simpleCond(c: string): boolean {
    const u = this.u, n = this.npc, ms = this.w.missions;
    const sel = this.selectedMission();
    switch (c) {
      case 'u_male': return u.male;
      case 'u_female': return !u.male;
      case 'npc_male': return n.male;
      case 'npc_female': return !n.male;
      case 'has_assigned_mission': return ms.assignedFrom(n).length === 1;
      case 'has_many_assigned_missions': case 'has_many_assigned_mission': return ms.assignedFrom(n).length > 1;
      case 'has_no_assigned_mission': return ms.assignedFrom(n).length === 0;
      case 'has_available_mission': case 'npc_has_available_mission': case 'u_has_available_mission': return ms.offeredBy(n).length === 1;
      case 'has_many_available_missions': return ms.offeredBy(n).length > 1;
      case 'has_no_available_mission': case 'npc_has_no_available_mission': case 'u_has_no_available_mission': return ms.offeredBy(n).length === 0;
      case 'mission_complete': case 'npc_mission_complete': case 'u_mission_complete': return !!sel && ms.isComplete(sel, n);
      case 'mission_incomplete': case 'npc_mission_incomplete': case 'u_mission_incomplete': return !!sel && sel.status === 'active' && !ms.isComplete(sel, n);
      case 'mission_failed': case 'npc_mission_failed': case 'u_mission_failed': return !!sel && sel.status === 'failed';
      case 'mission_has_generic_rewards': return !!sel && this.w.nd.missions[sel.id]?.has_generic_rewards !== false;
      case 'npc_friend': return n.isFriendly();
      case 'u_friend': return true;
      case 'npc_hostile': return n.isEnemy();
      case 'u_hostile': return false;
      case 'npc_following': return n.isFollower() && n.following;
      case 'u_following': return false;
      case 'npc_available': return !n.hasTalkEffect('currently_busy', this.w.now());
      case 'u_available': return true;
      case 'u_has_weapon': return !!u.inv.wielded;
      case 'npc_has_weapon': return !!n.inv.wielded;
      case 'u_can_stow_weapon': return !!u.inv.wielded && u.inv.canStash(u.inv.wielded);
      case 'u_can_drop_weapon': return !!u.inv.wielded;
      case 'is_day': return this.w.isDay?.() ?? true;
      case 'is_outside': case 'u_is_outside': return this.w.isOutside?.(u.x | 0, u.y | 0, u.z) ?? true;
      case 'npc_is_outside': return this.w.isOutside?.(n.tileX, n.tileY, n.z) ?? true;
      case 'npc_train_skills': return false;
      case 'npc_train_styles': return false;
      case 'is_by_radio': return false;
      case 'u_has_camp': return false;
      case 'u_driving': case 'npc_driving': case 'npc_is_riding': case 'u_is_riding': return false;
      case 'npc_has_activity': case 'u_has_activity': return false;
      case 'npc_is_travelling': case 'u_is_travelling': return false;
      case 'npc_has_destination': return false;
      case 'npc_has_assigned_camp': return false;
      case 'u_has_stolen_item': return false;
      case 'at_safe_space': case 'u_at_safe_space': case 'npc_at_safe_space': return this.w.safeSpace?.() ?? true;
      case 'u_is_deaf': case 'u_is_mute': case 'npc_is_deaf': return false;
      case 'has_reason': return !!this.reason;
      case 'u_is_alive': return !u.dead;
      case 'npc_is_alive': return !n.dead;
      case 'u_can_see': case 'npc_can_see': return true;
    }
    warnOnce('talk_cond', c, `[talk] unsupported condition "${c}" (treated as false)`);
    return false;
  }

  private varFrom(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o.u_val === 'string') return this.w.playerVars.get(o.u_val);
    if (typeof o.npc_val === 'string') return this.npc.vars.get(o.npc_val);
    if (typeof o.global_val === 'string') return this.w.globals.get(o.global_val);
    if (typeof o.context_val === 'string') return this.context.get(o.context_val);
    if (typeof o.var_val === 'string') return this.context.get(o.var_val) ?? this.w.globals.get(o.var_val);
    warnOnce('talk_var', JSON.stringify(v).slice(0, 60), `[talk] unsupported variable object ${JSON.stringify(v).slice(0, 60)}`);
    return undefined;
  }

  private num(v: unknown, def = 0): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v) || def;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.math)) return evalMathArray(o.math, this);
      const s = this.varFrom(v);
      return s === undefined ? def : Number(s) || 0;
    }
    return def;
  }

  private objectCond(k: string, v: any, o: Record<string, any>): boolean {
    const u = this.u, n = this.npc;
    const who = (prefix: string): Character | null => (prefix === 'u' ? u : prefix === 'npc' ? n : null);
    switch (k) {
      case 'math': return Array.isArray(v) ? evalMathArray(v, this) !== 0 : false;
      case 'compare_string': {
        if (!Array.isArray(v) || v.length < 2) return false;
        const vals = v.map((x: unknown) => this.varFrom(x));
        return vals.slice(1).some((x: string | undefined) => x !== undefined && x === vals[0]);
      }
      case 'compare_num': case 'compare_int': {
        if (!Array.isArray(v) || v.length !== 3) return false;
        const a = this.num(v[0]), b = this.num(v[2]);
        return evalMath(`${a} ${v[1]} ${b}`, this) !== 0;
      }
      case 'u_has_var': case 'npc_has_var': {
        const m = k === 'u_has_var' ? this.w.playerVars : n.vars;
        const val = m.get(String(v));
        return o.value === undefined ? val !== undefined : val === String(o.value);
      }
      case 'u_has_mission': return this.w.missions.playerHasMission(String(this.varFrom(v) ?? v));
      case 'u_has_trait': case 'npc_has_trait': return who(k.split('_')[0])!.hasTrait(String(this.varFrom(v) ?? v));
      case 'u_has_any_trait': case 'npc_has_any_trait': return Array.isArray(v) && v.some((t: string) => who(k.split('_')[0])!.hasTrait(t));
      case 'npc_has_visible_trait': return n.hasTrait(String(v));
      case 'u_has_effect': return this.hasTalkEffect('u', String(this.varFrom(v) ?? v));
      case 'npc_has_effect': return this.hasTalkEffect('npc', String(this.varFrom(v) ?? v));
      case 'u_has_item': case 'npc_has_item': return who(k.split('_')[0])!.inv.countOf(String(this.varFrom(v) ?? v)) > 0;
      case 'u_has_items': case 'npc_has_items': {
        const c = who(k.split('_')[0])!;
        const id = String(this.varFrom(v.item) ?? v.item);
        const need = this.num(v.count ?? v.charges, 1);
        return c.inv.countOf(id) >= need;
      }
      case 'u_has_items_sum': {
        // Sum of fractions: [{item, amount}...] each contributes have/amount; true when >= 1.
        if (!Array.isArray(v)) return false;
        let f = 0;
        for (const e of v) f += u.inv.countOf(String(e.item)) / Math.max(1, this.num(e.amount, 1));
        return f >= 1;
      }
      case 'u_has_item_category': case 'npc_has_item_category': {
        const c = who(k.split('_')[0])!;
        const need = this.num(o.count, 1);
        return c.inv.allItems().filter((it) => it.def.category === v).length >= need;
      }
      case 'u_is_wearing': case 'npc_is_wearing': return who(k.split('_')[0])!.inv.worn.some((it) => it.typeId === String(this.varFrom(v) ?? v));
      case 'u_has_wielded_with_flag': case 'npc_has_wielded_with_flag': return !!who(k.split('_')[0])!.inv.wielded?.hasFlag(String(v));
      case 'u_has_strength': case 'npc_has_strength': return who(k.split('_')[0])!.str >= this.num(v);
      case 'u_has_dexterity': case 'npc_has_dexterity': return who(k.split('_')[0])!.dex >= this.num(v);
      case 'u_has_intelligence': case 'npc_has_intelligence': return who(k.split('_')[0])!.int >= this.num(v);
      case 'u_has_perception': case 'npc_has_perception': return who(k.split('_')[0])!.per >= this.num(v);
      case 'u_has_bionics': case 'npc_has_bionics': return false;
      case 'u_has_flag': case 'npc_has_flag': return false;
      case 'npc_has_class': return n.classId === String(v);
      case 'u_has_cash': return this.w.cash >= this.num(v);
      case 'u_are_owed': return n.op.owed >= this.num(v);
      case 'npc_service': return !n.hasTalkEffect('currently_busy', this.w.now()) && this.w.cash >= this.num(v);
      case 'u_has_faction_trust': return (this.w.factionTrust.get(n.faction) ?? 0) >= this.num(v);
      case 'mission_goal': case 'npc_mission_goal': case 'u_mission_goal': {
        const m = this.selectedMission();
        return !!m && this.w.nd.missions[m.id]?.goal === String(v);
      }
      case 'npc_allies': return (this.w.alliesNear?.().length ?? 0) >= this.num(v);
      case 'npc_allies_global': return (this.w.alliesNear?.().length ?? 0) >= this.num(v);
      case 'is_season': return seasonOf(this.w.now()) === String(v).toLowerCase();
      case 'days_since_cataclysm': return Math.floor(this.w.now() / SECONDS_PER_DAY) >= this.num(v);
      case 'one_in_chance': return this.w.rng.oneIn(this.num(v, 1));
      case 'x_in_y_chance': return this.w.rng.next() * this.num(v.y, 1) < this.num(v.x);
      case 'npc_need': case 'u_need': {
        const c = who(k.split('_')[0])!;
        const need = String(v);
        const cur = need === 'thirst' ? c.thirst : need === 'hunger' ? c.hunger : need === 'sleepiness' || need === 'fatigue' ? c.sleepiness : 0;
        if (o.amount !== undefined) return cur >= this.num(o.amount);
        const levels: Record<string, number> = { TIRED: 191, DEAD_TIRED: 383, EXHAUSTED: 575, MASSIVE_FATIGUE: 1000 };
        return o.level !== undefined ? cur >= (levels[o.level] ?? 0) : false;
      }
      case 'u_at_om_location': case 'npc_at_om_location': case 'npc_near_om_location': case 'u_near_om_location': {
        const c = k.startsWith('u_') ? { x: u.x, y: u.y, z: u.z } : { x: n.x, y: n.y, z: n.z };
        const range = k.includes('near') ? this.num(o.range, 1) : 0;
        const target = String(v);
        if (!this.w.omtAt) return false;
        const ox = Math.floor(c.x / 24), oy = Math.floor(c.y / 24);
        for (let dy = -range; dy <= range; dy++)
          for (let dx = -range; dx <= range; dx++) {
            const t = this.w.omtAt(ox + dx, oy + dy, c.z);
            if (t && omtMatches(t, target)) return true;
          }
        return false;
      }
      case 'test_eoc': {
        const e = this.w.nd.eocs[String(v)];
        return !!e && this.cond(e.condition);
      }
      case 'npc_role_nearby': return false;
      case 'npc_aim_rule': case 'npc_engagement_rule': case 'npc_rule': case 'npc_override': return false;
      case 'u_has_worn_with_flag': case 'npc_has_worn_with_flag': return who(k.split('_')[0])!.inv.worn.some((it) => it.hasFlag(String(v)));
      case 'u_can_see': case 'npc_can_see': return true;
      case 'mod_is_loaded': return false;
      case 'u_has_proficiency': case 'npc_has_proficiency': return who(k.split('_')[0])!.proficiencies.has(String(v));
      case 'u_know_recipe': return u.learnedRecipes.has(String(v));
    }
    warnOnce('talk_cond', k, `[talk] unsupported condition "${k}" (treated as false)`);
    return false;
  }

  private hasTalkEffect(who: 'u' | 'npc', id: string): boolean {
    const now = this.w.now();
    if (who === 'npc') return this.npc.hasTalkEffect(id, now);
    const t = this.w.playerTalkEffects.get(id);
    return (t !== undefined && t > now) || this.u.effects.has(id);
  }

  // ---------------------------------------------------------------- effects

  /** Run a dialogue effect: string, object, or an array of them, in order. */
  effect(e: unknown): void {
    if (e === undefined || e === null) return;
    if (Array.isArray(e)) {
      for (const x of e) {
        this.effect(x);
        if (this.done && typeof x === 'string' && ENDS_TALK.has(x)) return;
      }
      return;
    }
    if (typeof e === 'string') return this.simpleEffect(e);
    if (typeof e !== 'object') return;
    const o = e as Record<string, any>;
    const keys = Object.keys(o).filter((k) => !k.startsWith('//'));
    const k = keys.find((x) => !EFFECT_ARGS.has(x)) ?? keys[0];
    if (k === undefined) return;
    this.objectEffect(k, o[k], o);
  }

  private simpleEffect(e: string): void {
    const u = this.u, n = this.npc, now = this.w.now();
    switch (e) {
      case 'follow':
        n.attitude = 'FOLLOW';
        n.faction = FACTION_FOLLOWERS;
        n.following = true;
        n.guardPos = null;
        n.mission = 'NULL';
        this.w.message(`${n.name} joins your party!`, 'c_light_green');
        return;
      case 'follow_only':
        n.attitude = 'FOLLOW';
        n.following = true;
        return;
      case 'stop_following':
        n.attitude = 'NULL';
        n.following = false;
        return;
      case 'leave':
        n.attitude = 'NULL';
        n.faction = FACTION_NONE;
        n.following = false;
        this.w.message(`${n.name} leaves your party.`);
        return;
      case 'assign_guard':
        n.following = false;
        n.guardPos = { x: n.tileX, y: n.tileY, z: n.z };
        if (!n.isAlly()) n.mission = 'GUARD';
        this.w.message(`${n.name} is posted as a guard.`);
        return;
      case 'stop_guard':
        n.guardPos = null;
        if (n.isAlly()) {
          n.attitude = 'FOLLOW';
          n.following = true;
          this.w.message(`${n.name} begins to follow you.`);
        } else n.mission = 'NULL';
        return;
      case 'hostile':
        this.w.message(`${n.name} turns hostile!`, 'c_red');
        n.attitude = 'KILL';
        if (n.isAlly()) n.faction = FACTION_NONE;
        n.following = false;
        this.done = true;
        this.w.onHostile?.(n);
        return;
      case 'insult_combat':
        this.w.message(`You start a fight with ${n.name}!`, 'c_red');
        n.attitude = 'KILL';
        n.following = false;
        this.done = true;
        this.w.onHostile?.(n);
        return;
      case 'flee':
        n.attitude = 'FLEE_TEMP';
        n.fleeTime = 30;
        this.done = true;
        return;
      case 'end_conversation':
        n.attitude = 'NULL';
        this.w.message(`${n.name} starts ignoring you.`);
        this.done = true;
        return;
      case 'stranger_neutral':
        n.attitude = 'NULL';
        return;
      case 'npc_thankful':
        if (n.attitude === 'MUG' || n.attitude === 'WAIT_FOR_LEAVE' || n.attitude === 'FLEE' || n.attitude === 'KILL' || n.attitude === 'FLEE_TEMP') n.attitude = 'NULL';
        n.op.trust = Math.max(n.op.trust, 1);
        return;
      case 'start_mugging':
        n.attitude = 'MUG';
        this.done = true;
        return;
      case 'drop_weapon': {
        const w = n.inv.wielded;
        if (w) {
          n.inv.remove(w);
          this.w.dropItem?.(w, n.tileX, n.tileY, n.z);
        }
        return;
      }
      case 'player_weapon_away': {
        const w = u.inv.wielded;
        if (w) u.inv.unwield();
        return;
      }
      case 'player_weapon_drop': {
        const w = u.inv.wielded;
        if (w) {
          u.inv.remove(w);
          this.w.dropItem?.(w, Math.floor(u.x), Math.floor(u.y), u.z);
        }
        return;
      }
      case 'start_trade':
        this.after.push(() => this.w.startTrade?.(n));
        if (!this.w.startTrade) warnOnce('talk_effect', 'start_trade(no ui)', '[talk] start_trade without a trade UI');
        return;
      case 'assign_mission': {
        const m = this.selectedMission();
        if (!m) return warnOnce('talk_effect', 'assign_mission(none)', '[talk] assign_mission with no selected mission') as unknown as void;
        this.w.missions.assign(m, this);
        return;
      }
      case 'mission_success': {
        const m = this.selectedMission();
        if (m) this.w.missions.succeed(m, this);
        return;
      }
      case 'mission_failure': {
        const m = this.selectedMission();
        if (m) this.w.missions.fail(m, this);
        return;
      }
      case 'clear_mission': {
        const m = this.selectedMission();
        if (m) this.w.missions.clear(m, n);
        n.missionSelected = null;
        return;
      }
      case 'mission_reward': {
        const m = this.selectedMission();
        const value = m ? this.w.nd.missions[m.id]?.value ?? 0 : 0;
        n.op.owed += value;
        this.after.push(() => this.w.startTrade?.(n));
        return;
      }
      case 'give_aid': case 'lesser_give_aid': case 'give_aid_all': case 'lesser_give_aid_all': {
        const targets: Character[] = e.endsWith('_all') ? [u, ...(this.w.alliesNear?.() ?? [])] : [u];
        const [lo, hi] = e.startsWith('lesser') ? [5, 15] : [10, 25];
        for (const c of targets) {
          for (const bp of MAIN_PARTS) {
            c.heal(bp as BodyPartId, this.w.rng.int(lo, hi));
            for (const id of e.startsWith('lesser') ? ['bleed'] : ['bleed', 'bite', 'infected']) c.removeEffect(id, bp as BodyPartId);
          }
        }
        this.w.message(e.endsWith('_all') ? `${n.name} patches up your group.` : `${n.name} patches you up.`, 'c_light_green');
        return;
      }
      case 'buy_haircut': case 'buy_shave':
        u.morale.add(e === 'buy_haircut' ? 'haircut' : 'shave', e === 'buy_haircut' ? 5 : 10, e === 'buy_haircut' ? 5 : 10, e === 'buy_haircut' ? 12 * 3600 : 6 * 3600, 3 * 3600, true);
        this.w.message(e === 'buy_haircut' ? 'You get a haircut.' : 'You get a shave.', 'c_light_green');
        return;
      case 'morale_chat': case 'morale_chat_activity':
        u.morale.add('chat', 10, 10, 6 * 3600, 3 * 3600, true);
        this.w.message(`You have a pleasant chat with ${n.name}.`, 'c_light_green');
        return;
      case 'deny_follow': case 'deny_lead': case 'deny_train': case 'deny_personal_info':
        n.talkEffects.set({ deny_follow: 'asked_to_follow', deny_lead: 'asked_to_lead', deny_train: 'asked_to_train', deny_personal_info: 'asked_personal_info' }[e]!, now + 6 * 3600);
        return;
      case 'wake_up':
        n.wakeUp();
        return;
      case 'reveal_stats':
        this.w.message(`${n.name}: Str ${n.str}, Dex ${n.dex}, Int ${n.int}, Per ${n.per}.  Best skills: ${bestSkills(n)}.`);
        return;
      case 'npc_die':
        this.after.push(() => n.die('dialogue'));
        this.done = true;
        return;
      case 'npc_gets_item': case 'npc_gets_item_to_use': {
        const items = [u.inv.wielded, ...u.inv.carried()].filter((x): x is Item => !!x);
        if (!this.w.pickItem) return warnOnce('talk_effect', e, `[talk] ${e} needs an item picker`) as unknown as void;
        this.w.pickItem(e === 'npc_gets_item' ? `Give what to ${n.name}?` : `What should ${n.name} use?`, items, (it) => {
          if (!it) return;
          u.inv.remove(it);
          if (e === 'npc_gets_item_to_use' && (it.isGun() || it.meleeDamage('bash') + it.meleeDamage('cut') + it.meleeDamage('stab') > 6)) {
            const old = n.inv.wielded;
            if (old) n.inv.unwield();
            n.inv.wield(it);
            this.reason = 'Thanks, I\'ll wield that now.';
          } else if (!n.inv.stash(it)) this.reason = 'Thanks, I\'ll carry that now.';
          else {
            u.inv.pickUp(it);
            this.reason = 'I have no space to store it.';
          }
          this.w.message(`You give ${it.name()} to ${n.name}.`);
        });
        return;
      }
      case 'give_equipment':
        this.after.push(() => this.w.startTrade?.(n, 0));
        return;
    }
    if (IGNORED_EFFECTS.has(e)) return;
    warnOnce('talk_effect', e, `[talk] unsupported effect "${e}" (no-op)`);
  }

  private objectEffect(k: string, v: any, o: Record<string, any>): void {
    const u = this.u, n = this.npc, now = this.w.now();
    const who = (prefix: string): Character => (prefix === 'u' ? u : n);
    const eocs = (list: unknown) => {
      for (const id of Array.isArray(list) ? list : list === undefined ? [] : [list]) this.runEoc(id);
    };
    switch (k) {
      case 'u_add_var': case 'npc_add_var': {
        const m = k === 'u_add_var' ? this.w.playerVars : n.vars;
        const val = o.possible_values ? this.w.rng.pick(o.possible_values as string[]) : o.time ? String(now) : String(o.value ?? 'yes');
        m.set(String(v), val);
        return;
      }
      case 'u_lose_var': case 'npc_lose_var': (k === 'u_lose_var' ? this.w.playerVars : n.vars).delete(String(v)); return;
      case 'set_string_var': {
        const target = o.target_var;
        const val = Array.isArray(v) ? String(this.w.rng.pick(v)) : this.varFrom(v) ?? String(v);
        this.setVarObj(target, val);
        return;
      }
      case 'math': if (Array.isArray(v)) evalMathArray(v, this); return;
      case 'u_message': case 'npc_message': {
        const text = this.parseTags(String(this.varFrom(v) ?? v));
        const col = o.type === 'good' ? 'c_light_green' : o.type === 'bad' ? 'c_light_red' : o.type === 'mixed' ? 'c_pink' : o.type === 'warning' ? 'c_yellow' : o.type === 'info' ? 'c_light_cyan' : undefined;
        this.w.message(text, col);
        if (o.popup) this.log.push({ who: 'info', text });
        return;
      }
      case 'u_spawn_item': {
        const id = String(this.varFrom(v) ?? v);
        const count = Math.max(1, this.num(o.count, 1));
        const items = this.makeItems(id, count, !!o.use_item_group, o.container);
        for (const it of items) this.giveToPlayer(it);
        if (!o.suppress_message && items.length) this.w.message(`${n.name} gives you ${count > 1 ? `${count} ` : ''}${items[0].baseName(count)}.`, 'c_light_green');
        return;
      }
      case 'u_buy_item': {
        const id = String(this.varFrom(v) ?? v);
        const cost = this.num(o.cost, 0), count = Math.max(1, this.num(o.count, 1));
        const give = () => {
          const items = this.makeItems(id, count, !!o.use_item_group, o.container);
          for (const it of items) this.giveToPlayer(it);
          if (!o.suppress_message && items.length) this.w.message(`You buy ${count > 1 ? `${count} ` : ''}${items[0].baseName(count)} from ${n.name}.`, 'c_light_green');
          eocs(o.true_eocs);
        };
        if (cost <= 0 || n.op.owed >= cost) {
          n.op.owed -= Math.max(0, cost);
          give();
        } else if (this.w.startTrade) {
          this.after.push(() => this.w.startTrade!(n, cost - Math.max(0, n.op.owed), (ok) => {
            if (!ok) return eocs(o.false_eocs);
            n.op.owed = 0;
            give();
          }));
        } else {
          this.w.message("You can't afford it!", 'c_light_red');
          eocs(o.false_eocs);
        }
        return;
      }
      case 'u_sell_item': {
        const id = String(this.varFrom(v) ?? v);
        const count = Math.max(1, this.num(o.count, 1)), cost = this.num(o.cost, 0);
        if (u.inv.countOf(id) < count) {
          this.w.message(`You don't have enough ${this.data.items[id] ? itemName(this.data.items[id], 2) : id}.`, 'c_light_red');
          eocs(o.false_eocs);
          return;
        }
        for (const it of u.inv.useAmount(id, count)) if (!n.inv.stash(it)) n.stock.push(it);
        n.op.owed += cost;
        this.w.message(`You give ${count > 1 ? `${count} ` : ''}${this.data.items[id] ? itemName(this.data.items[id], count) : id} to ${n.name}.`);
        eocs(o.true_eocs);
        return;
      }
      case 'u_consume_item': case 'npc_consume_item': {
        const c = who(k.split('_')[0]);
        const id = String(this.varFrom(v) ?? v);
        const count = Math.max(1, this.num(o.count ?? o.charges, 1));
        if (c.inv.countOf(id) >= count) c.inv.useAmount(id, count);
        else warnOnce('talk_consume', id, `[talk] ${k}: not enough ${id}`);
        if (o.popup && c === u) this.w.message(`You give ${count > 1 ? `${count} ` : ''}${this.data.items[id] ? itemName(this.data.items[id], count) : id} to ${n.name}.`);
        return;
      }
      case 'u_remove_item_with': case 'npc_remove_item_with': {
        const c = who(k.split('_')[0]);
        const id = String(v);
        for (const it of c.inv.allItems()) if (it.typeId === id) c.inv.remove(it);
        return;
      }
      case 'u_spend_cash': {
        const cost = this.num(v);
        if (cost <= this.w.cash) {
          this.w.cash -= cost;
          eocs(o.true_eocs);
        } else eocs(o.false_eocs);
        return;
      }
      case 'u_add_effect': case 'npc_add_effect': {
        const id = String(this.varFrom(v) ?? v);
        const dur = o.duration === 'PERMANENT' ? Infinity : typeof o.duration === 'number' ? o.duration : this.num(o.duration, 60);
        const c = who(k.split('_')[0]);
        if (c.effectTypes.has?.(id)) c.addEffect(id, dur === Infinity ? 1e9 : dur, { intensity: typeof o.intensity === 'number' ? o.intensity : undefined, permanent: dur === Infinity });
        else (k === 'u_add_effect' ? this.w.playerTalkEffects : n.talkEffects).set(id, now + dur);
        return;
      }
      case 'u_lose_effect': case 'npc_lose_effect': {
        const id = String(v);
        const c = who(k.split('_')[0]);
        c.removeEffect(id);
        (k === 'u_lose_effect' ? this.w.playerTalkEffects : n.talkEffects).delete(id);
        return;
      }
      case 'u_add_trait': case 'npc_add_trait': who(k.split('_')[0]).traits.add(String(v)); return;
      case 'u_lose_trait': case 'npc_lose_trait': who(k.split('_')[0]).traits.delete(String(v)); return;
      case 'u_add_morale': case 'npc_add_morale': {
        const c = who(k.split('_')[0]);
        const bonus = this.num(o.bonus, 1), max = this.num(o.max_bonus, bonus);
        const dur = typeof o.duration === 'number' ? o.duration : 3600;
        c.morale.add(String(v), bonus, max, dur, typeof o.decay_start === 'number' ? o.decay_start : dur / 2, true);
        return;
      }
      case 'u_add_faction_trust': case 'u_faction_rep': {
        this.w.factionTrust.set(n.faction, (this.w.factionTrust.get(n.faction) ?? 0) + this.num(v));
        return;
      }
      case 'npc_first_topic': n.chat.first_topic = String(v); return;
      case 'npc_change_faction': case 'npc_faction_change': n.faction = String(v); return;
      case 'npc_change_class': case 'npc_class_change': n.classId = String(v); return;
      case 'run_eocs': eocs(v); return;
      case 'if': {
        if (this.cond(v)) this.effect(o.then);
        else this.effect(o.else);
        return;
      }
      case 'switch': {
        const val = this.num(v);
        for (const c of (o.cases as any[]) ?? []) if (val >= this.num(c.case)) this.effect(c.effect);
        return;
      }
      case 'add_mission': {
        const inst = this.w.missions.create(String(v), n);
        if (inst) this.w.missions.assign(inst, this);
        return;
      }
      case 'finish_mission': {
        const inst = this.w.missions.findActive(String(v));
        if (!inst) return;
        if (o.success === false) this.w.missions.fail(inst, this);
        else this.w.missions.succeed(inst, this);
        return;
      }
      case 'assign_mission': {
        const inst = this.w.missions.create(String(v), n);
        if (inst) this.w.missions.assign(inst, this);
        return;
      }
      case 'u_set_guard_pos': case 'npc_set_guard_pos': n.guardPos = { x: n.tileX, y: n.tileY, z: n.z }; return;
      case 'give_equipment': this.after.push(() => this.w.startTrade?.(n, 0)); return;
      case 'npc_die': this.simpleEffect('npc_die'); return;
      case 'arithmetic': case 'u_adjust_var': case 'npc_adjust_var': {
        warnOnce('talk_effect', k, `[talk] deprecated effect "${k}" (no-op)`);
        return;
      }
    }
    if (IGNORED_EFFECTS.has(k)) return;
    warnOnce('talk_effect', k, `[talk] unsupported effect "${k}" (no-op)`);
  }

  private setVarObj(target: unknown, val: string): void {
    if (!target || typeof target !== 'object') return;
    const t = target as Record<string, string>;
    if (t.u_val) this.w.playerVars.set(t.u_val, val);
    else if (t.npc_val) this.npc.vars.set(t.npc_val, val);
    else if (t.global_val) this.w.globals.set(t.global_val, val);
    else if (t.context_val) this.context.set(t.context_val, val);
  }

  /** Run an effect_on_condition (id or inline object) with this dialogue's talkers. */
  runEoc(id: unknown): void {
    const e = typeof id === 'string' ? this.w.nd.eocs[id] : id && typeof id === 'object' ? (id as any) : undefined;
    if (!e) {
      if (typeof id === 'string') warnOnce('eoc', id, `[talk] unknown effect_on_condition "${id}"`);
      return;
    }
    if (e.condition === undefined || this.cond(e.condition)) this.effect(e.effect);
    else this.effect(e.false_effect);
  }

  private makeItems(id: string, count: number, group: boolean, container?: string): Item[] {
    const data = this.data;
    if (group) {
      if (!data.itemGroups[id]) {
        warnOnce('item_group', id);
        return [];
      }
      return expandItemGroup(data, id, this.w.rng).flatMap((s) => fromSpawned(data, s));
    }
    if (!data.items[id]) {
      warnOnce('item', id);
      return [];
    }
    const def = data.items[id];
    let items: Item[];
    const probe = createItem(data, id);
    if (probe.countByCharges) items = [createItem(data, id, { count })];
    else items = Array.from({ length: count }, () => createItem(data, id));
    if (container && data.items[container]) {
      const c = createItem(data, container);
      for (const it of items) c.put(it);
      return [c];
    }
    void def;
    return items;
  }

  private giveToPlayer(it: Item): void {
    const u = this.u;
    const quiet = u.onMessage;
    u.onMessage = null;
    try {
      const r = u.inv.pickUp(it);
      if (!r.ok) {
        this.w.dropItem?.(it, Math.floor(u.x), Math.floor(u.y), u.z);
        this.w.message(`You drop ${it.name()} at your feet; you have no room for it.`, 'c_light_red');
      }
    } finally {
      u.onMessage = quiet;
    }
  }
}

// Effects that make no sense in CDDA-3D yet (camps, bionics surgery, map updates, AI rules):
// quietly no-ops rather than warnings on every conversation.
const IGNORED_EFFECTS = new Set([
  'npc_rules_menu', 'set_npc_pickup', 'basecamp_mission', 'start_camp', 'distribute_food_auto', 'revert_activity', 'goto_location',
  'find_mount', 'dismount', 'drop_items_in_place', 'remove_stolen_status', 'toggle_npc_rule', 'set_npc_rule', 'clear_npc_rule',
  'set_npc_engagement_rule', 'set_npc_aim_rule', 'mapgen_update', 'u_location_variable', 'npc_location_variable', 'u_assign_activity',
  'bionic_install', 'bionic_remove', 'u_add_bionic', 'u_lose_bionic', 'companion_mission', 'u_set_fac_relation', 'u_transform_radius',
  'u_teleport', 'npc_teleport', 'u_spawn_npc', 'assign_camp', 'return_to_camp_duties', 'abandon_camp', 'lead_to_safety',
  'start_training', 'start_training_npc', 'start_training_seminar', 'sort_loot', 'do_construction', 'do_mining', 'do_mopping',
  'do_read', 'do_eread', 'do_read_repeatedly', 'study_npc_zone', 'do_vehicle_deconstruct', 'do_vehicle_repair', 'do_chop_plank',
  'do_butcher', 'do_chop_trees', 'do_fishing', 'do_farming', 'do_disassembly', 'do_craft', 'dismiss', 'u_bulk_trade_accept',
  'npc_bulk_trade_accept', 'u_bulk_donate', 'npc_bulk_donate', 'u_make_sound', 'npc_make_sound', 'u_cast_spell', 'npc_cast_spell',
]);

/** Keys that are arguments of an effect object, never the effect itself. */
const EFFECT_ARGS = new Set([
  'value', 'count', 'cost', 'container', 'duration', 'true_eocs', 'false_eocs', 'intensity', 'target_var', 'use_item_group',
  'suppress_message', 'popup', 'flags', 'bodypart', 'force', 'charges', 'possible_values', 'time', 'type', 'bonus', 'max_bonus',
  'decay_start', 'capped', 'then', 'else', 'cases', 'success', 'time_in_future', 'om_terrain', 'target', 'range',
]);

/** condition.cpp parsers_simple keys: string conditions usable as dynamic-line keys. */
const SIMPLE_CONDS = new Set([
  'u_male', 'npc_male', 'u_female', 'npc_female', 'u_is_travelling', 'npc_is_travelling', 'has_no_assigned_mission', 'has_assigned_mission',
  'has_many_assigned_missions', 'u_has_no_available_mission', 'has_no_available_mission', 'npc_has_no_available_mission',
  'u_has_available_mission', 'has_available_mission', 'npc_has_available_mission', 'u_has_many_available_missions',
  'has_many_available_missions', 'npc_has_many_available_missions', 'u_mission_complete', 'mission_complete', 'npc_mission_complete',
  'u_mission_incomplete', 'mission_incomplete', 'npc_mission_incomplete', 'u_mission_failed', 'mission_failed', 'npc_mission_failed',
  'u_available', 'npc_available', 'u_following', 'npc_following', 'u_friend', 'npc_friend', 'u_hostile', 'npc_hostile',
  'u_train_skills', 'npc_train_skills', 'u_train_styles', 'npc_train_styles', 'u_at_safe_space', 'at_safe_space', 'npc_at_safe_space',
  'u_can_stow_weapon', 'npc_can_stow_weapon', 'u_can_drop_weapon', 'npc_can_drop_weapon', 'u_has_weapon', 'npc_has_weapon',
  'u_driving', 'npc_driving', 'u_has_activity', 'npc_has_activity', 'u_is_riding', 'npc_is_riding', 'is_day', 'u_has_stolen_item',
  'u_is_outside', 'npc_is_outside', 'u_has_camp', 'npc_has_assigned_camp', 'is_by_radio', 'has_reason', 'mission_has_generic_rewards',
  'u_can_see', 'npc_can_see', 'u_is_deaf', 'npc_is_deaf', 'u_is_alive', 'npc_is_alive',
]);

/** Keys that are arguments of a condition object, never the condition itself. */
const COND_ARGS = new Set(['level', 'amount', 'range', 'count', 'intensity', 'value', 'charges', 'bodypart', 'yes', 'no']);

function topicId(r: any): string | undefined {
  const t = r?.topic ?? r?.success?.topic;
  return typeof t === 'string' ? t : t?.id;
}

/** "overmap terrain id" or its base type without rotation suffix (house_01_east matches house_01). */
export function omtMatches(id: string, target: string): boolean {
  if (id === target) return true;
  if (target === 'FACTION_CAMP_ANY' || target === 'FACTION_CAMP_START') return false;
  return id.replace(/_(north|east|south|west)$/, '') === target.replace(/_(north|east|south|west)$/, '');
}

export function seasonOf(seconds: number): string {
  return ['spring', 'summer', 'autumn', 'winter'][Math.floor(seconds / SECONDS_PER_DAY / DAYS_PER_SEASON) % 4];
}

/** "1 d", "30 minutes", "2 h" -> seconds (CDDA time_duration strings). */
export function parseDuration(s: string): number {
  let total = 0;
  const re = /(-?\d+(?:\.\d+)?)\s*([a-z]+)/gi;
  let m: RegExpExecArray | null;
  const unit: Record<string, number> = {
    turn: 1, turns: 1, t: 1, s: 1, sec: 1, second: 1, seconds: 1, m: 60, min: 60, minute: 60, minutes: 60,
    h: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400, w: 604800, week: 604800, weeks: 604800,
  };
  while ((m = re.exec(s))) total += Number(m[1]) * (unit[m[2].toLowerCase()] ?? 0);
  if (!total && /^\s*-?\d+(\.\d+)?\s*$/.test(s)) total = Number(s);
  return total;
}

/** Character::intimidation (str*2, +10 with a gun, +5 heavy melee weapon, stim/drunk). */
export function intimidation(c: Character): number {
  let r = c.str * 2;
  const w = c.inv.wielded;
  if (w?.isGun()) r += 10;
  else if (w && (w.meleeDamage('bash') >= 12 || w.meleeDamage('cut') >= 12 || w.meleeDamage('stab') >= 12)) r += 5;
  if (c.stim > 20) r += 2;
  if (c.effects.has('drunk')) r -= 4;
  return r;
}

function bestSkills(c: Character): string {
  const list = Object.entries(c.skills).map(([id, s]) => [id, s.level] as const).filter(([, l]) => l > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return list.length ? list.map(([id, l]) => `${c.skillName(id)} ${l}`).join(', ') : 'none';
}

/** <reward_count:ITEM>: how many of an item the mission's end effect spawns. */
export function rewardCount(def: { end?: any } | undefined, item: string): number {
  let n = 0;
  const visit = (e: unknown) => {
    if (Array.isArray(e)) e.forEach(visit);
    else if (e && typeof e === 'object') {
      const o = e as Record<string, any>;
      if (o.u_spawn_item === item) n += typeof o.count === 'number' ? o.count : 1;
      else Object.values(o).forEach(visit);
    }
  };
  visit(def?.end?.effect);
  return n;
}

import type { Character } from './character';
import type { RecipeDef } from '../data/types';
import type { ConstructionDef } from './construction';

// Skill practice made visible (docs/ADAPTATION.md "Seeing skill practice").
//
// BN trains skills silently: Character::practice adds exercise (or doesn't — a cap, a zero
// amount, low focus) and only a level-up prints anything. A new player disassembling toasters
// can't tell that a difficulty-0 uncraft teaches nothing at all. This module is the plumbing:
//
//   - every Character.practice call (and reading's direct SkillLevel::train) emits a
//     PracticeEvent to `practiceListeners`, including the calls that train nothing and why;
//   - callers name what is teaching with withPracticeSource('Disassembling the toaster', …);
//     anything else falls back to `ambientPracticeSource` (the running activity, set by the UI);
//   - the last few sources per skill are kept for the character sheet ("Recently trained by");
//   - preview* functions answer "what would this action train?" with the same formulas the
//     actions use (BN crafting.cpp / construction.cpp / avatar.cpp read), for menus and cards.
//
// The rules themselves stay BN's; the one adaptation, "Practice from simple tasks", is a switch
// (practiceSettings.simpleTasks, default off = BN).

/** Why a practice call trained nothing. */
export type PracticeBlock =
  /** amount was 0 before focus: the task teaches nothing (a difficulty-0 uncraft). */
  | 'no_amount'
  /** the skill is above the task's cap ("blunt grinding cap" in BN). */
  | 'cap'
  /** focus scaled the amount down to 0. */
  | 'focus'
  /** level 10. */
  | 'max'
  | 'asleep';

export interface PracticeEvent {
  who: Character;
  skill: string;
  /** What taught it ("Disassembling the toaster"); null when nobody said. */
  source: string | null;
  /** Whether the source was named by the caller (an action the player chose) rather than ambient. */
  explicit: boolean;
  /** Amount asked for (BN exercise units, before focus). */
  requested: number;
  /** Exercise actually added (BN units; a level takes 100 × (level+1)²). */
  gained: number;
  cap: number;
  levelBefore: number;
  level: number;
  /** Progress toward the next level before / after, 0..1. */
  progressBefore: number;
  progress: number;
  levelUp: boolean;
  blocked: PracticeBlock | null;
  /** 'book' for reading (BN SkillLevel::readBook, which bypasses Character::practice). */
  via: 'practice' | 'book';
}

export const practiceListeners: ((e: PracticeEvent) => void)[] = [];

/** Exercise (BN units) a level takes: SkillLevel::train levels up at 100 × (level+1)². */
export function exerciseForLevel(level: number): number {
  return 100 * (level + 1) ** 2;
}

/** Progress toward the next level, 0..1 (exercise is stored ×100 on SkillLevel). */
export function skillFraction(c: Character, skill: string): number {
  const sk = c.skills[skill];
  if (!sk) return 0;
  return Math.min(1, sk.exercise / (100 * exerciseForLevel(sk.level)));
}

// ------------------------------------------------------------------ sources

const sourceStack: string[] = [];

/** Run `fn` with practice inside it credited to `label` ("Crafting a stone knife"). */
export function withPracticeSource<T>(label: string, fn: () => T): T {
  if (!label) throw new Error('withPracticeSource: empty label');
  sourceStack.push(label);
  try {
    return fn();
  } finally {
    sourceStack.pop();
  }
}

/** Fallback when no caller named a source: the UI points this at the running activity. */
export const ambient: { source: () => string | null } = { source: () => null };

function currentSource(): { source: string | null; explicit: boolean } {
  const top = sourceStack[sourceStack.length - 1];
  if (top) return { source: top, explicit: true };
  return { source: ambient.source(), explicit: false };
}

/** Called by Character.practice / reading at every outcome. Cheap when nobody listens. */
export function emitPractice(e: Omit<PracticeEvent, 'source' | 'explicit'>): void {
  const s = currentSource();
  const ev: PracticeEvent = { ...e, ...s };
  recordRecent(ev);
  for (const l of practiceListeners) l(ev);
}

// ------------------------------------------------------------------ recent sources

export interface RecentPractice {
  source: string;
  /** BN exercise units gained from it (summed over a run of the same source). */
  gained: number;
  /** Character turn (game seconds) when last trained by it. */
  turn: number;
}

const RECENT_PER_SKILL = 4;
const recent = new WeakMap<Character, Map<string, RecentPractice[]>>();

function recordRecent(e: PracticeEvent): void {
  if (e.gained <= 0) return;
  const label = e.source ?? implicitSource(e.skill);
  let m = recent.get(e.who);
  if (!m) recent.set(e.who, (m = new Map()));
  const list = m.get(e.skill) ?? [];
  const i = list.findIndex((r) => r.source === label);
  const prev = i >= 0 ? list.splice(i, 1)[0] : null;
  list.unshift({ source: label, gained: (prev?.gained ?? 0) + e.gained, turn: e.who.turn });
  if (list.length > RECENT_PER_SKILL) list.length = RECENT_PER_SKILL;
  m.set(e.skill, list);
}

/** The last few things that trained `skill`, most recent first. */
export function recentPractice(c: Character, skill: string): readonly RecentPractice[] {
  return recent.get(c)?.get(skill) ?? [];
}

/** What usually trains a skill when nobody named the source (combat, swimming…). */
export function implicitSource(skill: string): string {
  const s: Record<string, string> = {
    melee: 'Fighting', bashing: 'Fighting', cutting: 'Fighting', stabbing: 'Fighting', unarmed: 'Fighting',
    dodge: 'Dodging attacks', gun: 'Shooting', pistol: 'Shooting', rifle: 'Shooting', shotgun: 'Shooting', smg: 'Shooting',
    archery: 'Shooting', launcher: 'Shooting', throw: 'Throwing', swimming: 'Swimming', driving: 'Driving',
    speech: 'Talking', barter: 'Trading', computer: 'Using computers', firstaid: 'First aid', survival: 'Surviving',
    traps: 'Handling traps', fabrication: 'Working', electronics: 'Working', mechanics: 'Working', tailor: 'Working', cooking: 'Cooking',
  };
  return s[skill] ?? 'Practice';
}

// ------------------------------------------------------------------ settings

/**
 * Adaptation switch (Options > "Practice from simple tasks"). Off = BN: a difficulty-0 uncraft
 * teaches nothing. On: it teaches a token amount up to level 1 (see simpleTaskPractice).
 */
export const practiceSettings = { simpleTasks: false };

/**
 * The token practice a difficulty-0 disassembly gives with simpleTasks on: half what crafting a
 * difficulty-0 recipe of the same length teaches in BN ((0×15+10) × (1 + time/300 s)), so a
 * 10-minute toaster gives 15 — about seven toasters to Electronics 1 at normal focus. Cap 0:
 * it stops once you reach level 1, like a difficulty-0 craft.
 */
export function simpleTaskPractice(r: RecipeDef): { amount: number; cap: number } {
  return { amount: Math.max(2, Math.round(5 * (1 + Math.max(0, r.time) / 300))), cap: 0 };
}

// ------------------------------------------------------------------ formulas (BN)

/** Character::adjust_for_focus's effective focus (before the roll_remainder). */
export function effectiveFocus(c: Character): number {
  let focus = c.focus + c.enchantBonus('EFFECTIVE_FOCUS', c.focus);
  if (c.hasTrait('FASTLEARNER')) focus += 15;
  if (c.hasTrait('SLOWLEARNER')) focus -= 15;
  // INT_BASED_LEARNING_BASE_VALUE 8, _FOCUS_ADJUSTMENT 5 (as in Character.practice)
  focus += (c.int - 8) * 5;
  return focus;
}

/** crafting::complete_disassemble: practice(skill_used, difficulty × 2, difficulty). */
export function disassemblyPractice(r: RecipeDef, simpleTasks = practiceSettings.simpleTasks): { skill: string; amount: number; cap: number; token: boolean } | null {
  if (!r.skill_used) return null;
  const d = r.difficulty ?? 0;
  if (d === 0 && simpleTasks) return { skill: r.skill_used, ...simpleTaskPractice(r), token: true };
  return { skill: r.skill_used, amount: d * 2, cap: d, token: false };
}

/**
 * Character::craft_skill_gain summed over a whole craft (it runs every 5 %: 20 times):
 * (difficulty × 15 + 10) × batch_mult with batch_mult = batch + base time (moves) / 30000, capped
 * at difficulty × 1.25; required sub-skills get half of (their level × 15 + 10) × batch_mult.
 * `baseMoves` is base_time_to_craft for the batch in moves (craftTime(c, r, batch, 1) × 100).
 */
export function craftPractice(c: Character, r: RecipeDef, batch: number, baseMoves: number, combatSkill: (s: string) => boolean): { skill: string; amount: number; cap: number }[] {
  if (!r.skill_used) return [];
  const batchMult = batch + baseMoves / 30000;
  const out = [{ skill: r.skill_used, amount: Math.round((r.difficulty * 15 + 10) * batchMult), cap: Math.floor(r.difficulty * 1.25) }];
  for (const [s, l] of r.skills_required ?? []) {
    if (s === r.skill_used || combatSkill(s)) continue;
    out.push({ skill: s, amount: Math.round(((c.getSkill(s) * 15 + 10) * batchMult) / 2), cap: Math.floor(l * 1.25) });
  }
  return out;
}

/** construction.cpp award_xp: (10 + 15 × level) × (1 + time / 10 min), capped at level × 1.25. */
export function constructionPractice(con: ConstructionDef): { skill: string; amount: number; cap: number }[] {
  return (con.required_skills ?? []).map(([s, l]) => ({ skill: s, amount: Math.floor((10 + 15 * l) * (1 + con.time / 600)), cap: Math.floor(l * 1.25) }));
}

// ------------------------------------------------------------------ previews

export type PracticeVerdict = 'trains' | 'too_simple' | 'capped' | 'maxed';

export interface PracticePreview {
  skill: string;
  skillName: string;
  verdict: PracticeVerdict;
  /** Raw amount per action (before focus). */
  amount: number;
  cap: number;
  /** Expected share of the next level one action gives at the current focus, 0..1. */
  perAction: number;
  /** The highest level this can take you to. */
  upTo: number;
  /** "Trains Electronics up to level 3 (+12% of the next level each time)". */
  text: string;
  /** With simpleTasks: this is the adaptation's token practice, not BN. */
  token?: boolean;
}

/** What one action that calls practice(skill, amount, cap) would do for `c` now. */
export function previewPractice(c: Character, skill: string, amount: number, cap: number, opts: { token?: boolean; each?: string } = {}): PracticePreview {
  const level = c.getSkill(skill);
  const name = c.skillName(skill);
  const upTo = Math.min(10, cap + 1);
  const base = { skill, skillName: name, amount, cap, upTo, token: opts.token };
  if (level >= 10) return { ...base, verdict: 'maxed', perAction: 0, text: `${name} is already at its maximum` };
  if (amount <= 0) return { ...base, verdict: 'too_simple', perAction: 0, text: `Too simple to train ${name}` };
  if (level > cap) return { ...base, verdict: 'capped', perAction: 0, text: `Too simple to train ${name} at your level (${level}; this trains up to ${upTo})` };
  const perAction = Math.max(0, (amount * effectiveFocus(c)) / 100) / exerciseForLevel(level);
  const pct = perAction >= 0.995 ? 'a full level' : perAction >= 0.01 ? `+${Math.round(perAction * 100)}%` : '<1%';
  return { ...base, verdict: 'trains', perAction, text: `Trains ${name} up to level ${upTo} (${pct} of level ${level + 1} ${opts.each ?? 'each time'})${opts.token ? ' · simple-task practice' : ''}` };
}

/** Disassembly preview, or null if the uncraft has no skill. */
export function previewDisassembly(c: Character, r: RecipeDef): PracticePreview | null {
  const p = disassemblyPractice(r);
  if (!p) return null;
  const pv = previewPractice(c, p.skill, p.amount, p.cap, { token: p.token });
  if (pv.verdict === 'too_simple') pv.text = `Too simple to train ${pv.skillName} (difficulty 0)`;
  return pv;
}

/** Previews for crafting `r` (×batch): the main skill, then sub-skills (half the practice). */
export function previewCraft(c: Character, r: RecipeDef, batch: number, baseMoves: number): PracticePreview[] {
  const combat = (s: string) => !!c.data.misc.skill?.[s]?.tags?.includes('combat_skill');
  return craftPractice(c, r, batch, baseMoves, combat).map((p) => previewPractice(c, p.skill, p.amount, p.cap, { each: 'per craft' }));
}

/** Previews for a construction stage. */
export function previewConstruction(c: Character, con: ConstructionDef): PracticePreview[] {
  return constructionPractice(con).map((p) => previewPractice(c, p.skill, p.amount, p.cap, { each: 'when built' }));
}

/**
 * avatar.cpp do_read's skill gain for one chapter, averaged: (level+1) × rng(min_ex, max_ex) with
 * min_ex = max(1, minutes/10 + Int/4), max_ex = minutes/5 + Int/2 − level, both focus-adjusted,
 * max_ex clamped to 2..10 (as reading.ts trainFromBook applies it).
 */
export function bookChapterPractice(c: Character, b: { time: number }, level: number): number {
  const minutes = b.time / 60;
  const f = effectiveFocus(c) / 100;
  let minEx = Math.max(1, Math.floor(minutes / 10 + c.int / 4)) * f;
  let maxEx = Math.floor(minutes / 5 + c.int / 2 - level) * f;
  maxEx = Math.max(minEx, Math.min(10, Math.max(2, maxEx)));
  minEx = Math.max(1, minEx * (level + 1));
  maxEx = Math.max(minEx, maxEx * (level + 1));
  return (level + 1) * ((minEx + maxEx) / 2);
}

/** Reading preview: books train their skill from required_level up to max_level, nothing past it. */
export function previewBook(c: Character, b: { skill?: string; req: number; level: number; time: number }): PracticePreview | null {
  if (!b.skill) return null;
  const level = c.getSkill(b.skill);
  const name = c.skillName(b.skill);
  const base = { skill: b.skill, skillName: name, amount: 0, cap: b.level - 1, upTo: b.level };
  if (level >= 10) return { ...base, verdict: 'maxed', perAction: 0, text: `${name} is already at its maximum` };
  if (level < b.req) return { ...base, verdict: 'capped', perAction: 0, text: `Too advanced: needs ${name} ${b.req} to learn from` };
  if (level >= b.level) return { ...base, verdict: 'capped', perAction: 0, text: `Too simple to train ${name} at your level (it teaches up to ${b.level})` };
  const amount = bookChapterPractice(c, b, level);
  const perAction = amount / exerciseForLevel(level);
  return { ...base, amount, verdict: 'trains', perAction, text: `Trains ${name} up to level ${b.level} (~${Math.max(1, Math.round(perAction * 100))}% of level ${level + 1} a chapter)` };
}

/** One line for a menu: the first skill's preview text, '' when nothing is involved. */
export function previewLine(list: (PracticePreview | null)[]): string {
  return list.filter((p): p is PracticePreview => !!p).map((p) => p.text).join(' · ');
}

/** Words for why a practice event trained nothing (the HUD cue). */
export function blockedText(e: PracticeEvent, skillName: string): string {
  switch (e.blocked) {
    case 'no_amount':
      return `${skillName}: no practice, too simple to learn from`;
    case 'cap':
      return `${skillName}: no practice, you're past what this teaches (level ${e.cap + 1})`;
    case 'focus':
      return `${skillName}: no practice, your focus is too low`;
    case 'max':
      return `${skillName}: already mastered`;
    case 'asleep':
      return `${skillName}: no practice while asleep`;
    default:
      return '';
  }
}

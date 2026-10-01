import type { Character } from './character';
import type { RecipeDef } from '../data/types';
import { canCraft, craftingInventory, craftTime, knowsRecipe, recipeName, type CraftHost } from './crafting';
import { canBuild, constructionGroups, constructionInventory, type ConstructionDef } from './construction';
import { effectiveSkills } from './adaptation_rules';
import { canDisassemble, disassemblables, uncraftRecipe } from './disassembly';
import { bookData, readableBooks } from './reading';
import { constructionPractice, craftPractice, disassemblyPractice, practiceSettings } from './practice';
import { cddaText } from './units';

// "How to reach the next level" for a skill (hover a skill on the character sheet or the HUD
// practice cue): a short, concrete list built from what the player knows and has around —
// recipes, things to take apart, constructions, books — plus the activities that train the
// skill in BN, and the caps that will stop them. Nearest first: what you can do right now,
// then what you know but lack something for, then activities, then a cap note.
//
// Every "trains" claim uses the same rule the action applies (practice.ts formulas, BN caps):
// a suggestion never promises practice the action won't give.

export interface SkillHint {
  text: string;
  /** 'now': you can do it right away; 'known': you know it, something's missing; 'do': an activity; 'cap': a limit. */
  kind: 'now' | 'known' | 'do' | 'cap';
}

/** The skill-training activities this port implements, with BN's caps (where the code calls practice()). */
const ACTIVITIES: Record<string, { text: string; cap?: number; capText?: string }[]> = {
  melee: [{ text: 'Fight: every swing trains it, hits more than misses' }, { text: 'Misses no longer teach it past level 5', cap: 5 }],
  bashing: [{ text: 'Fight with a club, pipe or hammer' }],
  cutting: [{ text: 'Fight with a blade or an axe' }],
  stabbing: [{ text: 'Fight with a knife or a spear' }],
  unarmed: [{ text: 'Fight bare-handed or with knuckle weapons' }],
  dodge: [{ text: 'Get attacked: each dodge trains it, up to the attacker\'s own skill' }],
  gun: [{ text: 'Fire any gun: every shot trains it' }],
  pistol: [{ text: 'Fire a pistol: every shot trains it' }],
  rifle: [{ text: 'Fire a rifle: every shot trains it' }],
  shotgun: [{ text: 'Fire a shotgun: every shot trains it' }],
  smg: [{ text: 'Fire a submachine gun: every shot trains it' }],
  archery: [{ text: 'Shoot a bow or crossbow: every shot trains it' }],
  launcher: [{ text: 'Fire a launcher' }],
  throw: [{ text: 'Throw things at something: longer throws teach more' }],
  swimming: [{ text: 'Swim in deep water' }],
  driving: [{ text: 'Drive a vehicle: heavier and faster teaches more' }],
  firstaid: [{ text: 'Bandage or disinfect wounds' }, { text: 'Dissect corpses with a scalpel' }],
  survival: [{ text: 'Start a fire', cap: 5, capText: 'Starting fires no longer teaches it past level 5' }, { text: 'Butcher a corpse (bigger ones teach further)' }, { text: 'Forage and harvest plants' }],
  speech: [{ text: 'Persuade, lie to or intimidate someone in conversation' }, { text: 'Trade with someone' }],
  computer: [{ text: 'Use or hack a terminal' }],
  traps: [{ text: 'Set or disarm traps' }],
  fabrication: [{ text: 'Chop trees or cut logs' }],
  electronics: [{ text: 'Install bionics (an Autodoc)' }],
  mechanics: [{ text: 'Install bionics (an Autodoc)' }],
};

const MAX_LINES = 5;

/** A few concrete ways for `host.player` to get `skill` to the next level, nearest first. */
export function skillHints(host: CraftHost, skill: string): SkillHint[] {
  const c = host.player;
  const level = c.getSkill(skill);
  const name = c.skillName(skill);
  if (level >= 10) return [{ text: `${name} is at its maximum.`, kind: 'cap' }];
  const scored: { hint: SkillHint; score: number }[] = [];
  const add = (hint: SkillHint, score: number) => scored.push({ hint, score });

  // --- recipes you know whose practice still reaches you (cap ≥ your level)
  const combat = (s: string) => !!c.data.misc.skill?.[s]?.tags?.includes('combat_skill');
  const crafts: { r: RecipeDef; d: number }[] = [];
  for (const r of c.data.recipes) {
    if (r.skill_used !== skill || !knowsRecipe(c, r)) continue;
    const p = craftPractice(c, r, 1, craftTime(c, r, 1, 1) * 100, combat)[0];
    if (p && p.amount > 0 && level <= p.cap) crafts.push({ r, d: r.difficulty });
  }
  // The sweet spot is difficulty level+1 (BN gives (difficulty × 15 + 10): harder teaches more,
  // and one above your level you can still make); easier ones next, much harder ones last.
  const reach = (d: number) => (d <= level + 1 ? level + 1 - d : (d - level - 1) * 2);
  crafts.sort((a, b) => reach(a.d) - reach(b.d));
  const inv = crafts.length ? craftingInventory(host) : null;
  let craftLines = 0;
  for (const { r, d } of crafts.slice(0, 8)) {
    if (craftLines >= 2) break;
    const ok = canCraft(host, r, 1, inv!).ok;
    add({ text: `Craft ${recipeName(c.data, r)} (${name} ${d})${ok ? '' : ' when you have the parts'}`, kind: ok ? 'now' : 'known' }, (ok ? 0 : 20) + reach(d));
    craftLines++;
  }

  // --- things you carry or stand next to that teach it when taken apart
  const seen = new Set<string>();
  for (const { item } of disassemblables(host)) {
    if (seen.has(item.typeId)) continue;
    seen.add(item.typeId);
    const r = uncraftRecipe(c.data, item.typeId);
    const p = r && disassemblyPractice(r);
    if (!p || p.skill !== skill || p.amount <= 0 || level > p.cap) continue;
    const ok = canDisassemble(host, item).ok;
    add({ text: `Disassemble the ${item.baseName()} (${name} ${r!.difficulty ?? 0})${ok ? '' : ' with the right tools'}`, kind: ok ? 'now' : 'known' }, (ok ? 1 : 21) + Math.abs((r!.difficulty ?? 0) - level));
  }

  // --- constructions you're skilled enough to build that still teach it
  const cons: { con: ConstructionDef; l: number; group: string }[] = [];
  for (const g of constructionGroups(c.data)) {
    for (const con of g.constructions) {
      const p = constructionPractice(con).find((x) => x.skill === skill);
      if (!p || level > p.cap) continue;
      if (!effectiveSkills(con).every(([s, l]) => c.getSkill(s) >= l)) continue;
      const l = (con.required_skills ?? []).find(([s]) => s === skill)![1];
      cons.push({ con, l, group: g.name });
    }
  }
  cons.sort((a, b) => b.l - a.l || a.con.time - b.con.time);
  if (cons.length) {
    const cinv = constructionInventory(host);
    const pick = cons.slice(0, 6).map((x) => ({ ...x, ok: canBuild(host, x.con, cinv).ok }));
    const best = pick.find((x) => x.ok) ?? pick[0];
    add({ text: `Build: ${best.group} (${name} ${best.l})${best.ok ? '' : ' when you have the materials'}`, kind: best.ok ? 'now' : 'known' }, (best.ok ? 2 : 22) + Math.abs(best.l - level));
  }

  // --- books you have or are next to
  let bookMax = -1;
  const books = new Set<string>();
  for (const it of readableBooks(host)) {
    const b = bookData(it);
    if (!b || b.skill !== skill || books.has(it.typeId)) continue;
    books.add(it.typeId);
    bookMax = Math.max(bookMax, b.level);
    const title = cddaText(it.def.name);
    if (level < b.req) add({ text: `Read ${title} once you have ${name} ${b.req} (it teaches ${b.req}–${b.level})`, kind: 'known' }, 30 + b.req - level);
    else if (level < b.level) add({ text: `Read ${title} (teaches ${name} up to ${b.level})`, kind: 'now' }, 3);
  }

  // --- activities that train it in BN, past their caps or not
  const caps: SkillHint[] = [];
  for (const a of ACTIVITIES[skill] ?? []) {
    if (a.cap !== undefined && level > a.cap) {
      caps.push({ text: a.capText ?? a.text, kind: 'cap' });
      continue;
    }
    if (a.cap !== undefined && !a.capText) continue; // a pure cap note that doesn't apply yet
    add({ text: a.text, kind: 'do' }, 10);
  }
  if (bookMax >= 0 && level >= bookMax) caps.push({ text: `Your books only go to level ${bookMax}`, kind: 'cap' });
  if (!scored.length && !caps.length)
    caps.push({ text: practiceSettings.simpleTasks ? `Nothing you know trains ${name} at level ${level} yet: learn harder recipes` : `Nothing you know trains ${name} yet: harder recipes and books do`, kind: 'cap' });

  const lines = scored.sort((a, b) => a.score - b.score).map((s) => s.hint);
  const room = MAX_LINES - Math.min(1, caps.length);
  return [...lines.slice(0, room), ...caps.slice(0, MAX_LINES - Math.min(room, lines.length))].slice(0, MAX_LINES);
}

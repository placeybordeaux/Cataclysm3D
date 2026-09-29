import type { Rng } from '../core/rng';
import type { GameData, MonsterDef } from '../data/types';
import { warnOnce } from '../data/warn';
import type { Character } from './character';
import { fromSpawned, type Item } from './item';
import { monsterSize } from './monster';
import { expandItemGroup } from '../data/itemgroups';

// Butchery (CDDA butchery.cpp): time by corpse size and the best BUTCHER tool quality, yields
// from the monster's `harvest` entries scaled by survival skill, dexterity and tool quality.
// Only QUICK and FULL butchery are offered; proficiencies are not modelled, so the
// "no proficiency" penalties CDDA applies to untrained survivors always apply.

export type ButcherKind = 'quick' | 'full';

interface HarvestEntry {
  drop: string;
  type?: string;
  mass_ratio?: number;
  base_num?: [number, number];
  scale_num?: [number, number];
  max?: number;
}

/** CDDA roll_butchery_dissect. */
export function rollButchery(rng: Rng, skill: number, dex: number, toolQuality: number): number {
  let shift = 0;
  shift += uniform(rng, 0, skill - 3);
  shift += uniform(rng, 0, dex - 8) / 4;
  if (toolQuality < 0) shift -= uniform(rng, 0, -toolQuality / 5);
  else shift += Math.min(toolQuality, 4);
  return Math.round(shift);
}

/** rng_float(a, b) with a > b allowed (CDDA swaps). */
function uniform(rng: Rng, a: number, b: number): number {
  return Math.min(a, b) + rng.next() * Math.abs(b - a);
}

/** CDDA butchery_dissect_yield_mult: 0..1 share of the mass you manage to harvest. */
export function yieldMult(skill: number, dex: number, toolQuality: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return 0.5 * clamp(skill / 10) + 0.3 * clamp((toolQuality + 50) / 100) + 0.2 * clamp(dex / 20);
}

/**
 * butcher_time_to_cut, in game seconds. Size base (moves) x max(25, 100 - BUTCHER quality)
 * / 100, x6 for full butchery, x the untrained-proficiency factors (quick 2.4, full 1.8).
 */
export function butcherSeconds(def: MonsterDef, toolQuality: number, kind: ButcherKind): number {
  const base = { tiny: 900, small: 1800, medium: 2700, large: 3600, huge: 10800 }[monsterSize(def)];
  let moves = base * Math.max(25, 100 - toolQuality);
  if (kind === 'full') moves *= 6 * (0.4 * 3 + 0.4 * 1 + 0.2);
  else moves *= 0.7 * 3 + 0.15 * 1 + 0.15;
  return Math.round(moves / 100);
}

export interface ButcherResult {
  ok: boolean;
  items: Item[];
  messages: string[];
  /** Survival practice granted. */
  practice: number;
}

/**
 * butchery_drops_harvest for QUICK/FULL: mass_ratio entries give round(ratio * weight +-10%)
 * grams (scaled by yieldMult, then divided by the drop's unit weight); counted entries roll
 * between base_num + butchery * scale_num. Quick butchery keeps 1/4 of the flesh, 1/2 of
 * bones, 1/5 of offal, half the skin of medium+ animals and nothing else.
 */
export function butcherYield(data: GameData, c: Character, def: MonsterDef, toolQuality: number, kind: ButcherKind, rng: Rng): ButcherResult {
  const messages: string[] = [];
  const h = def.harvest ? data.misc.harvest?.[def.harvest] : undefined;
  if (!h || !(h.entries as HarvestEntry[] | undefined)?.length) {
    if (def.harvest && !h) warnOnce('harvest', def.harvest);
    return { ok: false, items: [], messages: [`There's nothing useful to butcher on the ${def.name}.`], practice: 0 };
  }
  const entries = h.entries as HarvestEntry[];
  const skill = Math.round(c.getSkill('survival'));
  const dex = c.dex;
  if (rollButchery(rng, skill, dex, toolQuality) <= -15 && rng.oneIn(2)) {
    return { ok: false, items: [], messages: ['You mangle the corpse beyond use.'], practice: 1 };
  }
  let weight = def.weight;
  weight += Math.round(weight * (rng.next() * 0.2 - 0.1));
  let practice = 0;
  const out: Item[] = [];
  const sizeRank = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4 }[monsterSize(def)];
  for (const e of entries) {
    const dropDef = data.items[e.drop];
    const harvestType = e.type ? data.misc.harvest_drop_type?.[e.type] : undefined;
    if (harvestType?.dissect_only || harvestType?.group) continue;
    const butchery = rollButchery(rng, skill, dex, toolQuality);
    practice += (4 + butchery) / entries.length;
    const base = e.base_num ?? [1, 1];
    const scale = e.scale_num ?? [0, 0];
    let roll: number;
    if (e.mass_ratio) roll = Math.round(e.mass_ratio * weight);
    else {
      const lo = base[0] + butchery * scale[0], hi = base[1] + butchery * scale[1];
      roll = Math.min(e.max ?? 1000, Math.round(uniform(rng, lo, hi)));
      roll = Math.max(roll, base[0]);
    }
    const t = e.type ?? '';
    if (t === 'flesh' || t === 'offal') roll /= 1.15;
    if (t === 'skin') roll = roll / 3 / 1.15;
    if (kind === 'quick') {
      if (t === 'flesh') roll /= 4;
      else if (t === 'bone') roll /= 2;
      else if (t === 'skin' && sizeRank >= 2) roll /= 2;
      else if (t === 'offal') roll /= 5;
      else continue;
    }
    if (!dropDef) {
      warnOnce('item', e.drop);
      continue;
    }
    let count: number;
    if (e.mass_ratio) {
      roll *= yieldMult(skill, dex, toolQuality);
      count = Math.ceil(roll / Math.max(0.001, dropDef.weight));
    } else count = Math.floor(roll);
    if (count <= 0) {
      messages.push(`You fail to harvest: ${dropDef.name}`);
      continue;
    }
    out.push(...fromSpawned(data, { id: e.drop, count } as any));
  }
  return { ok: true, items: out, messages, practice: Math.max(0, Math.round(practice)) };
}

/** Best BUTCHER quality the survivor has; -1 when they have nothing that cuts. */
export function butcherToolQuality(c: Character): number {
  const q = c.inv.maxQuality('BUTCHER');
  if (q > 0) return q;
  return c.inv.maxQuality('CUT') >= 1 ? 0 : -1;
}

// ------------------------------------------------------------------------------------------
// Dissection (CDDA butcher_type::DISSECT): needs a CUT_FINE tool (scalpel 3+, knives 1-2),
// takes 6x the base cutting time, and uses the monster's `dissect` harvest instead of its
// `harvest`. Item-group entries (bionic_group / mutagen_group: the CBMs inside a zomborg, the
// mutagen glands of a mutant) are what CDDA puts in the corpse's CORPSE pocket at death
// (monster::spawn_dissectables_on_death); each is recovered on a check_butcher_dissect roll,
// a failed CBM becomes a burnt-out bionic. Plain item entries drop like butchery yields.
// Skill per drop type is harvest_drop_type.harvest_skills (bionics: electronics + first aid,
// mutagen: chemistry + first aid), otherwise survival; practice goes to first aid.

/** Best CUT_FINE quality carried (0 = nothing precise enough). */
export function dissectToolQuality(c: Character): number {
  return Math.max(0, c.inv.maxQuality('CUT_FINE'));
}

/** Can this corpse be dissected at all (the monster has a dissect harvest)? */
export function canDissect(data: GameData, def: MonsterDef): boolean {
  const id = def.dissect;
  return !!id && !!(data.misc.harvest?.[id]?.entries as unknown[] | undefined)?.length;
}

/** butcher_time_to_cut for DISSECT, in game seconds (no proficiency factors apply to it). */
export function dissectSeconds(def: MonsterDef, toolQuality: number): number {
  const base = { tiny: 900, small: 1800, medium: 2700, large: 3600, huge: 10800 }[monsterSize(def)];
  return Math.round((base * Math.max(25, 100 - toolQuality) * 6) / 100);
}

/** CDDA butchery_dissect_skill_level: average of the drop type's harvest skills + tool quality. */
export function dissectSkillLevel(data: GameData, c: Character, toolQuality: number, type: string | undefined): number {
  const t = type ? data.misc.harvest_drop_type?.[type] : undefined;
  if (!t) return Math.round(c.getSkill('survival'));
  const skills: string[] = t.harvest_skills ?? [];
  let total = 0;
  for (const s of skills) total += c.getSkill(s);
  return Math.round((total + toolQuality) / (skills.length || 1));
}

/** CDDA check_butcher_dissect: success chance 1 - 10/(10 + 5·roll); roll 0 always fails. */
export function dissectCheck(rng: Rng, roll: number): boolean {
  if (roll < 0) return false;
  return rng.int(1, 10 + roll * 5) > 10;
}

/** Messages the setup step prints about your tool (set_up_butchery for DISSECT). */
export function dissectToolMessage(q: number): string | null {
  if (q <= 0) return 'None of your tools are sharp and precise enough to do that.';
  if (q === 1) return 'You could use a better tool, but this will do.';
  if (q === 2) return 'This tool is great, but you still would like a scalpel.';
  if (q === 3) return 'You dissect the corpse with a trusty scalpel.';
  if (q >= 5) return 'You dissect the corpse with a sophisticated system of surgical grade scalpels.';
  return null;
}

/**
 * Yields of dissecting one corpse. `damageLevel` is the corpse item's damage (pulped corpses
 * lose their dissectables, as in CDDA where it lowers every roll). Practice is for first aid.
 */
export function dissectYield(data: GameData, c: Character, def: MonsterDef, toolQuality: number, rng: Rng, damageLevel = 0): ButcherResult {
  const messages: string[] = [];
  const h = def.dissect ? data.misc.harvest?.[def.dissect] : undefined;
  const entries = (h?.entries as (HarvestEntry & { flags?: string[]; faults?: string[] })[] | undefined) ?? [];
  if (!entries.length) {
    if (def.dissect && !h) warnOnce('harvest', def.dissect);
    return { ok: false, items: [], messages: [`There's nothing to dissect in the ${def.name}.`], practice: 0 };
  }
  if (toolQuality <= 0) return { ok: false, items: [], messages: [dissectToolMessage(0)!], practice: 0 };
  const dex = c.dex;
  let weight = def.weight;
  weight += Math.round(weight * (rng.next() * 0.2 - 0.1));
  const out: Item[] = [];
  let practice = 0;
  const tag = (it: Item, e: { flags?: string[]; faults?: string[] }) => {
    if (e.flags?.length) it.vars.flags = e.flags.join(',');
    if (e.faults?.length) it.vars.faults = e.faults.join(',');
  };
  // 1. the corpse's dissectables (item-group entries)
  let dissectables = 0, dPractice = 0;
  for (const e of entries) {
    const dt = e.type ? data.misc.harvest_drop_type?.[e.type] : undefined;
    if (!dt?.group) continue;
    for (const sp of expandItemGroup(data, e.drop, rng)) {
      for (let n = 0; n < Math.max(1, sp.count); n++) {
        dissectables++;
        const skill = dissectSkillLevel(data, c, toolQuality, e.type);
        const butchery = rollButchery(rng, skill, dex, toolQuality);
        dPractice += 4 + butchery;
        const roll = Math.max(0, butchery - damageLevel);
        const ok = dissectCheck(rng, roll);
        const isCbm = !!data.items[sp.id]?.subtypes?.includes('BIONIC_ITEM') || !!data.items[sp.id]?.flags?.includes('CBM');
        if (!ok && !isCbm) continue;
        const id = ok ? sp.id : 'burnt_out_bionic';
        if (!data.items[id]) {
          warnOnce('item', id);
          continue;
        }
        for (const it of fromSpawned(data, { ...sp, id, count: 1 })) {
          tag(it, e);
          out.push(it);
          messages.push(`You discover a ${it.name()}!`);
        }
      }
    }
  }
  if (dissectables) practice += dPractice / dissectables;
  // 2. plain item entries (mutagen samples, tissue)
  for (const e of entries) {
    const dt = e.type ? data.misc.harvest_drop_type?.[e.type] : undefined;
    const skill = dissectSkillLevel(data, c, toolQuality, e.type);
    const butchery = rollButchery(rng, skill, dex, toolQuality);
    practice += (4 + butchery) / entries.length;
    if (dt?.group) continue;
    const dropDef = data.items[e.drop];
    if (!dropDef) {
      warnOnce('item', e.drop);
      continue;
    }
    const base = e.base_num ?? [1, 1];
    const scale = e.scale_num ?? [0, 0];
    let roll: number;
    if (e.mass_ratio) roll = Math.round(e.mass_ratio * weight);
    else {
      roll = Math.min(e.max ?? 1000, Math.round(uniform(rng, base[0] + butchery * scale[0], base[1] + butchery * scale[1])));
      roll = Math.max(roll, base[0]);
    }
    const t = e.type ?? '';
    if (t === 'flesh' || t === 'offal') roll /= 1.15;
    if (t === 'skin') roll = roll / 3 / 1.15;
    let count: number;
    if (e.mass_ratio) count = Math.ceil((roll * yieldMult(skill, dex, toolQuality)) / Math.max(0.001, dropDef.weight));
    else count = Math.floor(roll);
    if (count <= 0) {
      messages.push(`You fail to harvest: ${dropDef.name}`);
      continue;
    }
    for (const it of fromSpawned(data, { id: e.drop, count } as any)) {
      tag(it, e);
      out.push(it);
    }
    messages.push(`You harvest: ${dropDef.name}`);
    practice++;
  }
  return { ok: true, items: out, messages, practice: Math.max(0, Math.round(practice)) };
}

/** CDDA practice cap for dissection: size + min(tool quality, 3) + 2. */
export function dissectPracticeCap(def: MonsterDef, toolQuality: number): number {
  const size = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4 }[monsterSize(def)];
  return size + Math.min(toolQuality, 3) + 2;
}

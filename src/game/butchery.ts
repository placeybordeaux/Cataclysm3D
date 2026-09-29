import type { Rng } from '../core/rng';
import type { GameData, MonsterDef } from '../data/types';
import { warnOnce } from '../data/warn';
import type { Character } from './character';
import { fromSpawned, type Item } from './item';
import { monsterSize } from './monster';
import { expandItemGroup, type SpawnedItem } from '../data/itemgroups';

// Butchery and dissection as Cataclysm: Bright Nights does them (activity_handlers.cpp
// butcher_finish / butchery_drops_harvest, mondeath.cpp make_mon_corpse):
//   - one `harvest` list per monster; entry types blood / flesh / offal / bone / skin plus
//     "bionic" (one item) and "bionic_group" (an item group). There is no separate DDA
//     `dissect` harvest and no harvest_drop_type objects.
//   - bionic entries are rolled when the monster dies and hidden in the corpse
//     (`corpseDissectables`); only dissection recovers them, one x_in_y(roll, 10) check each,
//     a failed CBM becomes a burnt-out bionic. Butchering them away prints a hint.
//   - quick butchery (BUTCHER) keeps 1/4 flesh, 1/2 bone, 1/2 skin of medium+ corpses, 1/5
//     offal; full butchery (BUTCHER_FULL) keeps everything but blood (only bleeding gets that);
//     dissection yields like full butchery plus the implants.
// Activity speed (activity_speed.cpp) is reduced to its tool factor; skills/stats/light
// modifiers of BN's complex_moves are not modelled.

export type ButcherKind = 'quick' | 'full';

interface HarvestEntry {
  drop: string;
  type?: string;
  mass_ratio?: number;
  base_num?: [number, number];
  scale_num?: [number, number];
  max?: number;
  flags?: string[];
  faults?: string[];
}

/** BN creature_size (tiny = 0 … huge = 4). */
const SIZE_RANK = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4 } as const;

/** rng_float(a, b) with a > b allowed (BN swaps). */
function uniform(rng: Rng, a: number, b: number): number {
  return Math.min(a, b) + rng.next() * Math.abs(b - a);
}

/**
 * butcher_finish roll_butchery: skill + rng_float(0, dex - 8) / 4, minus rng_float(0, -q/5)
 * for a negative tool quality. For dissection `skill` already includes the CUT_FINE level.
 */
export function rollButchery(rng: Rng, skill: number, dex: number, toolQuality: number): number {
  let shift = skill;
  shift += uniform(rng, 0, dex - 8) / 4;
  if (toolQuality < 0) shift -= uniform(rng, 0, -toolQuality / 5);
  return Math.round(shift);
}

/** butcher_finish roll_drops: share of a mass_ratio yield you get (not clamped, as in BN). */
export function yieldMult(skill: number, dex: number, toolQuality: number): number {
  const factor = Math.max(toolQuality, -50);
  return (0.5 * skill) / 10 + (0.3 * (factor + 50)) / 100 + (0.2 * dex) / 20;
}

/** size_factor_in_time_to_cut, in moves. */
function sizeMoves(def: MonsterDef): number {
  return { tiny: 15000, small: 30000, medium: 45000, large: 60000, huge: 180000 }[monsterSize(def)];
}

/** activity_speed tools factor for a single quality requirement (refine/limit_factor). */
function toolFactor(quality: 'BUTCHER' | 'CUT_FINE', q: number): number {
  // get_best_qual_mod: BUTCHER q * 10 (mod 10); CUT_FINE 2q^3 - 10q^2 + 32q - 60 (ACT_DISSECT mod -60)
  const mod = quality === 'BUTCHER' ? (q === 0 ? 0 : q * 10) : 2 * q ** 3 - 10 * q ** 2 + 32 * q - 60;
  const f = 1 + Math.max(-75, Math.min(100, mod)) / 100;
  return Math.max(0.25, Math.min(2, f));
}

/** butcher_time_to_cut (quick x1, full x6) / the BUTCHER tool factor, in game seconds. */
export function butcherSeconds(def: MonsterDef, toolQuality: number, kind: ButcherKind): number {
  const moves = sizeMoves(def) * (kind === 'full' ? 6 : 1);
  return Math.round(moves / 100 / toolFactor('BUTCHER', toolQuality));
}

export interface ButcherResult {
  ok: boolean;
  items: Item[];
  messages: string[];
  /** Practice granted (survival for butchery, first aid for dissection). */
  practice: number;
}

/** corpse_damage_effect: damaged corpses lose part of their soft yields. */
function corpseDamageEffect(weight: number, type: string, damageLevel: number): number {
  switch (damageLevel) {
    case 2:
      if (type === 'offal' || type === 'skin') return Math.round(weight * 0.75);
      if (type === 'flesh') return Math.round(weight * 0.9);
      break;
    case 3:
      if (type === 'offal') return 0;
      if (type === 'skin') return Math.round(weight * 0.5);
      if (type === 'bone') return Math.round(weight * 0.9);
      if (type === 'flesh') return Math.round(weight * 0.75);
      break;
    case 4:
      if (type === 'offal' || type === 'skin') return 0;
      if (type === 'bone') return Math.round(weight * 0.75);
      if (type === 'flesh') return Math.round(weight * 0.5);
      break;
  }
  return weight;
}

const isImplantEntry = (e: HarvestEntry) => e.type === 'bionic' || e.type === 'bionic_group';

type Action = 'quick' | 'full' | 'dissect';

/** butchery_drops_harvest for BUTCHER / BUTCHER_FULL / DISSECT (no field dressing etc.). */
function dropsHarvest(
  data: GameData, def: MonsterDef, action: Action, entries: HarvestEntry[], roll: () => number, drops: () => number, rng: Rng, damageLevel: number,
): { items: Item[]; messages: string[]; practice: number } {
  const messages: string[] = [];
  const out: Item[] = [];
  let weight = def.weight;
  weight += Math.round(weight * uniform(rng, -0.1, 0.1));
  let practice = 4 + roll();
  const sizeRank = SIZE_RANK[monsterSize(def)];
  for (const e of entries) {
    const butchery = roll();
    const t = e.type ?? '';
    let n = 0;
    if (e.mass_ratio) n = corpseDamageEffect(Math.round(e.mass_ratio * weight), t, damageLevel);
    else if (!isImplantEntry(e)) {
      const base = e.base_num ?? [1, 1];
      const scale = e.scale_num ?? [0, 0];
      n = Math.min(e.max ?? 1000, Math.round(uniform(rng, base[0] + butchery * scale[0], base[1] + butchery * scale[1])));
      n = Math.max(corpseDamageEffect(n, t, damageLevel), base[0]);
    }
    if (isImplantEntry(e)) {
      // Implants were placed in the corpse at death; the knife only finds traces of them.
      if (action !== 'dissect') {
        const dropDef = e.type === 'bionic' ? data.items[e.drop] : undefined;
        if (dropDef && !dropDef.subtypes?.includes('BIONIC_ITEM')) {
          if (rng.oneIn(3)) messages.push('Your butchering tool destroys something.  Perhaps a more surgical approach would allow harvesting it.');
        } else {
          messages.push(rng.pick([
            'Your butchering tool encounters something implanted in this corpse, but your rough cuts destroy it.',
            'You find traces of implants in the body, but you care only for the flesh.',
            'You found some implants in the body, but harvesting them would require more surgical approach.',
          ]));
        }
      }
      practice++;
      continue;
    }
    // Only bleeding a corpse (not modelled) collects its blood.
    const alreadyHarvested = t === 'blood';
    if (alreadyHarvested) n = 0;
    if (action === 'quick') {
      if (t === 'flesh') n = Math.trunc(n / 4);
      else if (t === 'bone') n = Math.trunc(n / 2);
      else if (sizeRank >= SIZE_RANK.medium && t === 'skin') n = Math.trunc(n / 2);
      else if (t === 'offal') n = Math.trunc(n / 5);
      else continue;
    }
    const dropDef = data.items[e.drop];
    if (!dropDef) {
      warnOnce('item', e.drop);
      continue;
    }
    if (e.mass_ratio) {
      let grams = n * drops();
      grams = Math.min(grams, def.weight * e.mass_ratio);
      n = Math.ceil(grams / Math.max(1, dropDef.weight));
    }
    if (n <= 0) {
      if (!alreadyHarvested) messages.push(`You fail to harvest: ${dropDef.name}`);
      practice++;
      continue;
    }
    for (const it of fromSpawned(data, { id: e.drop, count: n })) {
      tagItem(it, e);
      out.push(it);
    }
    messages.push(`You harvest: ${dropDef.name}`);
    practice++;
  }
  return { items: out, messages, practice };
}

function tagItem(it: Item, e: { flags?: string[]; faults?: string[] }): void {
  if (e.flags?.length) it.vars.flags = e.flags.join(',');
  if (e.faults?.length) it.vars.faults = e.faults.join(',');
}

function harvestEntries(data: GameData, def: MonsterDef): HarvestEntry[] | null {
  const h = def.harvest ? data.misc.harvest?.[def.harvest] : undefined;
  if (def.harvest && !h) warnOnce('harvest', def.harvest);
  const entries = (h?.entries as HarvestEntry[] | undefined) ?? [];
  return entries.length ? entries : null;
}

/**
 * QUICK / FULL butchery of a corpse. A roll of -15 or worse fails fatally half the time
 * (nothing left). `damageLevel` is the corpse item's damage level (0..4).
 */
export function butcherYield(data: GameData, c: Character, def: MonsterDef, toolQuality: number, kind: ButcherKind, rng: Rng, damageLevel = 0): ButcherResult {
  const entries = harvestEntries(data, def);
  if (!entries) return { ok: false, items: [], messages: [`There's nothing useful to butcher on the ${def.name}.`], practice: 0 };
  const skill = Math.trunc(c.getSkill('survival'));
  const dex = c.dex;
  const roll = () => rollButchery(rng, skill, dex, toolQuality);
  if (roll() <= -15 && rng.oneIn(2)) {
    return { ok: false, items: [], messages: ['You hack up the corpse so unskillfully, that there is nothing left to salvage from this bloody mess.'], practice: 0 };
  }
  const r = dropsHarvest(data, def, kind, entries, roll, () => yieldMult(skill, dex, toolQuality), rng, damageLevel);
  return { ok: true, items: r.items, messages: r.messages, practice: Math.max(0, r.practice) };
}

/** Best BUTCHER quality the survivor has; -1 when they have nothing that cuts. */
export function butcherToolQuality(c: Character): number {
  const q = c.inv.maxQuality('BUTCHER');
  if (q > 0) return q;
  return c.inv.maxQuality('CUT') >= 1 ? 0 : -1;
}

/** Survival practice cap for butchery: max(size - medium, 0) + 4. */
export function butcherPracticeCap(def: MonsterDef): number {
  return Math.max(SIZE_RANK[monsterSize(def)] - SIZE_RANK.medium, 0) + 4;
}

// ------------------------------------------------------------------------------------------
// Dissection (BN butcher_type::DISSECT)

/** Best CUT_FINE quality carried (0 = nothing precise enough). */
export function dissectToolQuality(c: Character): number {
  return Math.max(0, c.inv.maxQuality('CUT_FINE'));
}

/** Any corpse with a (non-exempt) harvest can be dissected in BN. */
export function canDissect(data: GameData, def: MonsterDef): boolean {
  return !!harvestEntries(data, def);
}

/** butcher_time_to_cut for DISSECT (size x4) / the CUT_FINE tool factor, in game seconds. */
export function dissectSeconds(def: MonsterDef, toolQuality: number): number {
  return Math.round((sizeMoves(def) * 4) / 100 / toolFactor('CUT_FINE', toolQuality));
}

/** Dissection skill: first aid / 2 + electronics / 2 + CUT_FINE quality (integer halves). */
export function dissectSkillLevel(c: Character, toolQuality: number): number {
  return Math.trunc(Math.trunc(c.getSkill('firstaid')) / 2) + Math.trunc(Math.trunc(c.getSkill('electronics')) / 2) + toolQuality;
}

/** check_butcher_cbm: x_in_y(roll, 10), i.e. 10% per point of roll. */
export function dissectCheck(rng: Rng, roll: number): boolean {
  return rng.next() * 10 < roll;
}

/** Messages the setup step prints about your tool (consider_butchery for DISSECT). */
export function dissectToolMessage(q: number): string | null {
  if (q <= 0) return 'None of your tools are sharp and precise enough to do that.';
  if (q === 1) return 'You could use a better tool, but this will do.';
  if (q === 2) return 'This tool is great, but you still would like a scalpel.';
  if (q === 3) return 'You dissect the corpse with a trusty scalpel.';
  if (q === 5) return 'You dissect the corpse with a sophisticated system of surgical grade scalpels.';
  return null;
}

/** A dissectable hidden in a corpse: the spawned item plus its harvest entry's flags/faults. */
export interface Dissectable extends SpawnedItem {
  flags?: string[];
  faults?: string[];
}

/**
 * make_mon_corpse: roll the monster's bionic / bionic_group harvest entries into the items
 * its corpse hides. Stored on the corpse item (vars.dissectables, JSON) by the monster system.
 */
export function corpseDissectables(data: GameData, def: MonsterDef, rng: Rng): Dissectable[] {
  const out: Dissectable[] = [];
  for (const e of harvestEntries(data, def) ?? []) {
    if (!isImplantEntry(e)) continue;
    const spawned: SpawnedItem[] = e.type === 'bionic' ? [{ id: e.drop, count: 1 }] : expandItemGroup(data, e.drop, rng);
    for (const s of spawned) out.push({ ...s, ...(e.flags?.length ? { flags: e.flags } : {}), ...(e.faults?.length ? { faults: e.faults } : {}) });
  }
  return out;
}

/** The dissectables stored on a corpse item (empty when none or unreadable). */
export function readDissectables(corpse: Item): Dissectable[] {
  const raw = corpse.vars.dissectables;
  if (typeof raw !== 'string') return [];
  try {
    return JSON.parse(raw) as Dissectable[];
  } catch {
    warnOnce('corpse_dissectables', raw.slice(0, 40));
    return [];
  }
}

/**
 * Dissect one corpse: harvest yields as full butchery, then extract_or_wreck_cbms over the
 * hidden `contents` (roll = roll_butchery - corpse damage level, at least 1). Practice is first
 * aid, (size_mult + 1) * (time/150 + 1) * (n²/2 + 1) as in butcher_finish.
 * Without `contents` the dissectables are rolled now (a fresh corpse).
 */
export function dissectYield(data: GameData, c: Character, def: MonsterDef, toolQuality: number, rng: Rng, damageLevel = 0, contents?: Dissectable[]): ButcherResult {
  const entries = harvestEntries(data, def);
  if (!entries) return { ok: false, items: [], messages: [`There's nothing to dissect in the ${def.name}.`], practice: 0 };
  if (toolQuality <= 0) return { ok: false, items: [], messages: [dissectToolMessage(0)!], practice: 0 };
  const skill = dissectSkillLevel(c, toolQuality);
  const dex = c.dex;
  const roll = () => rollButchery(rng, skill, dex, toolQuality);
  const r = dropsHarvest(data, def, 'dissect', entries, roll, () => yieldMult(skill, dex, toolQuality), rng, damageLevel);
  const hidden = contents ?? corpseDissectables(data, def, rng);
  const cbmRoll = Math.max(1, roll() - damageLevel);
  for (const d of hidden) {
    const dd = data.items[d.id];
    if (!dd) {
      warnOnce('item', d.id);
      continue;
    }
    const isBionic = !!dd.subtypes?.includes('BIONIC_ITEM');
    const ok = dissectCheck(rng, cbmRoll);
    let id = d.id;
    let faults = d.faults;
    if (isBionic) {
      if (!ok || dd.flags?.includes('BIONIC_FAULTY')) {
        id = 'burnt_out_bionic';
        faults = faults?.filter((f) => f !== 'fault_bionic_nonsterile');
      }
      if (ok) r.messages.push(`You discover: ${data.items[id]?.name ?? id}!`);
      else r.messages.push('Your imprecise surgery damaged a bionic, producing a burnt-out bionic.');
    } else if (!ok) {
      r.messages.push('Your imprecise surgery destroyed something.');
      continue;
    } else {
      faults = faults?.filter((f) => f !== 'fault_bionic_nonsterile');
      r.messages.push(`You discover: ${dd.name}!`);
    }
    for (const it of fromSpawned(data, { ...d, id })) {
      tagItem(it, { flags: d.flags, faults });
      r.items.push(it);
    }
  }
  const size = SIZE_RANK[monsterSize(def)];
  const timeToCut = sizeMoves(def) / 100;
  const sizeMult = size > SIZE_RANK.medium ? size * size : 8;
  const n = hidden.length;
  const practice = (sizeMult + 1) * (Math.trunc(timeToCut / 150) + 1) * (Math.trunc((n * n) / 2) + 1);
  return { ok: true, items: r.items, messages: r.messages, practice };
}

/** First aid practice cap for dissection: min(MAX_SKILL, size + 2 * dissectables + 1). */
export function dissectPracticeCap(def: MonsterDef, dissectables: number): number {
  return Math.min(10, SIZE_RANK[monsterSize(def)] + dissectables * 2 + 1);
}

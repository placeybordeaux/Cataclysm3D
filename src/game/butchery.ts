import type { Rng } from '../core/rng';
import type { GameData, MonsterDef } from '../data/types';
import { warnOnce } from '../data/warn';
import type { Character } from './character';
import { fromSpawned, type Item } from './item';
import { monsterSize } from './monster';

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

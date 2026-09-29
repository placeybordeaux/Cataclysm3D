// Starts offered by the new-game flow: a profession + scenario pair built from the unlock
// catalogue, turned into the same Build the old character creator produces (so applyBuild
// in src/ui/chargen.ts equips it exactly as CDDA's add_profession_items does).

import { Rng } from '../core/rng';
import { expandItemGroup, type SpawnedItem } from '../data/itemgroups';
import type { GameData, ItemGroupDef } from '../data/types';
import { BASE_STAT, permittedProfessions, profName, scenName, type ProfessionDef, type ScenarioDef } from '../ui/chargen_logic';
import type { Build } from '../ui/chargen';
import { available, type Catalogue, type UnlockDef } from './unlocks';
import { SCENARIO_PLACEMENT } from './placement';
import type { Difficulty } from './difficulty';

export interface StartChoice {
  /** The card (unlock id) this start came from. */
  unlockId: string;
  profession: string;
  scenario: string;
  name: string;
  male: boolean;
  difficulty: Difficulty;
  /** Cosmetic title ('' = none). */
  title: string;
}

export interface StartCard {
  unlock: UnlockDef;
  profession: ProfessionDef;
  /** The card's own scenario. */
  scenario: ScenarioDef;
  available: boolean;
}

export function professionDef(data: GameData, id: string): ProfessionDef {
  const p = data.misc?.profession?.[id] as ProfessionDef | undefined;
  if (!p) throw new Error(`progression: profession ${id} missing from misc.json`);
  return p;
}
export function scenarioDef(data: GameData, id: string): ScenarioDef {
  const s = data.misc?.scenario?.[id] as ScenarioDef | undefined;
  if (!s) throw new Error(`progression: scenario ${id} missing from misc.json`);
  return s;
}

/** Every start card in ladder order (available ones first within a tier is the UI's job). */
export function startCards(data: GameData, cat: Catalogue, recorded: (id: string) => boolean, classic: boolean): StartCard[] {
  return cat.unlocks
    .filter((u) => u.kind === 'start' || u.kind === 'profession')
    .map((u) => ({ unlock: u, profession: professionDef(data, u.grants.profession!), scenario: scenarioDef(data, u.grants.scenario ?? 'evacuee'), available: available(u, recorded, classic) }));
}

/**
 * Scenarios a card can switch to: its own, plus unlocked scenario unlocks that allow the
 * profession (BN scenario::permitted_professions) and that we can place.
 */
export function scenarioOptions(data: GameData, cat: Catalogue, card: StartCard, recorded: (id: string) => boolean, classic: boolean): ScenarioDef[] {
  const out = [card.scenario];
  const profs = (data.misc?.profession ?? {}) as Record<string, ProfessionDef>;
  for (const u of cat.unlocks) {
    if (u.kind !== 'scenario' || !u.grants.scenario || !available(u, recorded, classic)) continue;
    const s = scenarioDef(data, u.grants.scenario);
    if (out.includes(s) || !SCENARIO_PLACEMENT[s.id]) continue;
    if (permittedProfessions(s, profs).some((p) => p.id === card.profession.id)) out.push(s);
  }
  // The default scenario is always an option (the evac shelter is where everyone starts in BN).
  const evac = scenarioDef(data, 'evacuee');
  if (!out.includes(evac)) out.push(evac);
  return out;
}

export function buildFor(data: GameData, choice: StartChoice, density?: number): Build {
  const scenario = scenarioDef(data, choice.scenario);
  const profession = professionDef(data, choice.profession);
  if (!SCENARIO_PLACEMENT[scenario.id]) throw new Error(`progression: scenario ${scenario.id} can't be placed`);
  const name = choice.name.trim();
  if (!name) throw new Error('progression: a start needs a name');
  return {
    scenario,
    profession,
    traits: new Set(),
    stats: { str: BASE_STAT, dex: BASE_STAT, int: BASE_STAT, per: BASE_STAT },
    male: choice.male,
    name,
    ...(density !== undefined ? { density } : {}),
  };
}

export interface KitEntry {
  id: string;
  name: string;
  count: number;
}

/** What the profession starts with (one deterministic roll), top-level items only, for the card. */
export function kitPreview(data: GameData, prof: ProfessionDef, male: boolean): KitEntry[] {
  const rng = new Rng(0x4b17);
  const out = new Map<string, KitEntry>();
  const add = (s: SpawnedItem) => {
    const def = data.items[s.id];
    if (!def) return;
    // A container shows what it holds ("plastic bottle of clean water").
    const inner = s.contents?.length === 1 ? data.items[s.contents[0].id]?.name : undefined;
    const e = out.get(s.id) ?? { id: s.id, name: inner ? `${def.name} of ${inner}` : def.name, count: 0 };
    // A stack of charges (lighter fluid, nails) is one thing to carry, not 180.
    e.count += def.count_by_charges ? 1 : s.count;
    out.set(s.id, e);
  };
  for (const key of ['both', male ? 'male' : 'female'] as const) {
    const g = prof.items?.[key] as ItemGroupDef | undefined;
    if (g) for (const s of expandItemGroup(data, g, rng)) add(s);
  }
  return [...out.values()];
}

export function cardTitle(card: StartCard, male: boolean): string {
  return card.unlock.kind === 'start' ? card.unlock.name : profName(card.profession, male);
}
export { scenName };

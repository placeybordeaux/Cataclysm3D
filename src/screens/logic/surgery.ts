// What an Autodoc operation would mean, gathered for the surgery screen (unit-tested): the
// odds, what goes wrong when it fails (BN bionics_install_failure, in plain words), what it
// needs (anesthetic, an install program), how long you're under, and anything that stops it.
// BN installs bionics only through an Autodoc (MANUAL_BIONIC_INSTALLATION off).

import type { BionicState } from '../../game/bionics';
import type { Item } from '../../game/item';
import { BODY_PARTS, isBodyPart } from '../../game/bodyparts';
import type { Tone } from '../../ui2';
import { oddsTone } from './dialogue';

export interface SurgeryPlan {
  itemId: string;
  bionicId: string;
  name: string;
  difficulty: number;
  /** Success chance 0..100 (the operation always installs; failure means complications). */
  chance: number;
  chanceTone: Tone;
  /** Game seconds under the knife (difficulty × 20 min). */
  seconds: number;
  anesthesia: { needed: number; have: number; required: boolean };
  /** An installation_data program at hand raises the Autodoc's skill to 10. */
  program: { id: string; name: string; have: boolean } | null;
  /** Why it can't go ahead at all (already installed, needs another CBM, not sterile, no anesthetic). */
  blocker: string | null;
  /** Mutations it removes. */
  removesTraits: string[];
  /** It replaces an installed bionic. */
  upgrades: string | null;
  /** Body parts it occupies (where damage lands on a bad roll). */
  parts: string[];
  /** Complications on a failed roll, mildest first. */
  risks: string[];
  /** Power storage it adds, kJ. */
  capacity: number;
}

export function surgeryPlan(bio: BionicState, it: Item, traitName: (id: string) => string): SurgeryPlan {
  const itemId = it.typeId;
  const bionicId = bio.idx.bionicOf(itemId);
  const d = bio.def(bionicId);
  const program = (it.def.installation_data as string | undefined) ?? null;
  const haveProgram = !!program && bio.c.inv.allItems().some((x) => x.typeId === program);
  const chance = bio.successChance(itemId, true, haveProgram ? 10 : -1);
  const difficulty = bio.idx.difficulty(itemId);
  const required = bio.needsAnesthesia();
  const needed = required ? bio.anesthesiaNeeded(itemId) : 0;
  const have = bio.anesthesiaAvailable();
  const parts = (d?.occupied_bodyparts ?? []).filter(([, n]) => n > 0).map(([bp]) => (isBodyPart(bp) ? BODY_PARTS[bp].name : bp));
  const where = parts.length ? parts.join(', ') : 'torso';
  let blocker = bio.installBlocker(it);
  if (!blocker && required && have < needed) blocker = `Not enough anesthetic: ${needed} charges needed, ${have} at hand.`;
  const up = d?.upgraded_bionic && bio.has(d.upgraded_bionic) ? bio.name(d.upgraded_bionic) : null;
  return {
    itemId,
    bionicId,
    name: bio.name(bionicId),
    difficulty,
    chance,
    chanceTone: oddsTone(chance),
    seconds: Math.max(1, difficulty) * 20 * 60,
    anesthesia: { needed, have, required },
    program: program ? { id: program, name: bio.c.data.items[program]?.name ?? program, have: haveProgram } : null,
    blocker,
    removesTraits: (d?.canceled_mutations ?? []).filter((m) => bio.c.hasTrait(m)).map(traitName),
    upgrades: up,
    parts,
    risks: [
      `Minor wounds to the ${where}`,
      `Serious damage to the ${where} (up to ${Math.max(5, difficulty * 5)} HP; infection if it would be fatal)`,
      'A faulty implant installed alongside it, or lost power capacity',
    ],
    capacity: d?.capacity ?? 0,
  };
}

/** "20 min", "1 h 40 min" for operation lengths. */
export function operationTime(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

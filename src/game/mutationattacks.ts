import type { Rng } from '../core/rng';
import type { DamageUnit } from '../data/types';
import { warnOnce } from '../data/warn';
import type { Character } from './character';
import { isBodyPart, type BodyPartId } from './bodyparts';
import { covers } from './inventory';
import { asArray } from './item';
import type { RolledDamage } from './combat';

interface MutationAttackDef {
  attack_text_u?: string;
  attack_text_npc?: string;
  body_part?: string;
  chance: number;
  blocker_mutations?: string[];
  required_mutations?: string[];
  hardcoded_effect?: boolean;
  base_damage?: DamageUnit | DamageUnit[];
  strength_damage?: DamageUnit | DamageUnit[];
}

export interface MutationStrike {
  mutation: string;
  textU: string;
  textNpc: string;
  damage: RolledDamage[];
  /**
   * The strike's own hit roll (×0.8) against a fresh dodge, returning the hit spread (< 0 =
   * dodged). Callers roll each strike only when they apply it, so a dodge or block spent on
   * one strike is gone for the next, as in BN perform_special_attacks.
   */
  roll(): number;
}

/** BN exclusive_flag_coverage: ordinary covering armor restricts the specified natural attack. */
function restricted(c: Character, bp: BodyPartId): boolean {
  return c.inv.worn.some(w => covers(w, bp) && !['ALLOWS_NATURAL_ATTACKS', 'SEMITANGIBLE', 'PERSONAL', 'AURA'].some(f => w.hasFlag(f)));
}

function physical(type: string, amount: number, multiplier = 1): RolledDamage[] {
  return amount > 0 && multiplier > 0 ? [{ type, amount: amount * multiplier, multiplier, armor_penetration: 0, armor_multiplier: 1 }] : [];
}

/** BN melee.cpp hardcoded_mutation_attack; multipliers apply after armor, not as extra raw damage. */
function hardcoded(c: Character, id: string, rng: Rng, twoHanded: boolean): RolledDamage[] {
  if (id === 'BEAK_PECK') return physical('stab', 10 * Math.max(1, Math.min(6, Math.trunc(c.dex + c.getSkill('unarmed') - rng.int(4, 10)))));
  if (id === 'VINES2' || id === 'VINES3') return physical('bash', c.str / 2, id === 'VINES2' ? 2 : 3);
  if (['ARM_TENTACLES', 'ARM_TENTACLES_4', 'ARM_TENTACLES_8'].includes(id)) {
    let count = id === 'ARM_TENTACLES_8' ? 7 : id === 'ARM_TENTACLES_4' ? 3 : 1;
    if (twoHanded || c.brokenArms() > 0 || c.inv.worn.some(w => w.hasFlag('RESTRICT_HANDS'))) count--;
    return c.hasTrait('CLAWS_TENTACLE') ? physical('cut', c.str / 2 + 1, count) : physical('bash', c.str / 3 + 1, count);
  }
  warnOnce('mutation_attack', id, `[mutation attacks] unsupported hardcoded attack ${id}`);
  return [];
}

function declaredDamage(c: Character, attack: MutationAttackDef): RolledDamage[] {
  const grouped = new Map<string, RolledDamage>();
  for (const [units, scale] of [[attack.base_damage, 1], [attack.strength_damage, Math.min(15, c.str)]] as const) {
    for (const unit of asArray(units)) {
      const mult = unit.damage_multiplier ?? 1, pen = unit.armor_penetration ?? 0, armor = unit.armor_multiplier ?? 1;
      const key = `${unit.damage_type}:${pen}:${armor}:${mult}`;
      const prior = grouped.get(key) ?? { type: unit.damage_type, amount: 0, multiplier: mult, armor_penetration: pen, armor_multiplier: armor };
      // Preserve negative base damage (e.g. ANTLERS) until strength contribution has been added.
      prior.amount += unit.amount * scale * mult;
      grouped.set(key, prior);
    }
  }
  return [...grouped.values()].filter(u => u.amount > 0);
}

/** Generate a combo only after a primary hit; each proc has its own reduced hit roll and dodge, rolled on apply. */
export function mutationStrikes(
  c: Character, rng: Rng,
  rolls: { hit: () => number; dodge: () => number; twoHanded: boolean },
): MutationStrike[] {
  const out: MutationStrike[] = [];
  let practiced = false;
  for (const id of c.traits) {
    const attacks = c.traitDef(id)?.attacks as MutationAttackDef | MutationAttackDef[] | undefined;
    for (const attack of asArray(attacks)) {
      if (attack.body_part && (!isBodyPart(attack.body_part) || restricted(c, attack.body_part))) continue;
      const ability = c.dex + Math.trunc(c.getSkill('unarmed'));
      if (attack.chance <= 0 || (ability < attack.chance && rng.next() * attack.chance >= ability)) continue;
      if (attack.blocker_mutations?.some(t => c.hasTrait(t)) || attack.required_mutations?.some(t => !c.hasTrait(t))) continue;
      const damage = attack.hardcoded_effect ? hardcoded(c, id, rng, rolls.twoHanded) : declaredDamage(c, attack);
      if (!damage.length) continue;
      out.push({
        mutation: id, textU: attack.attack_text_u ?? '', textNpc: attack.attack_text_npc ?? '', damage,
        roll: () => {
          const spread = rolls.hit() * 0.8 - rolls.dodge();
          if (spread >= 0 && !practiced) {
            practiced = true; // at most once per combo
            c.practice('unarmed', rng.int(0, 10));
          }
          return spread;
        },
      });
    }
  }
  return out;
}

export function mutationStrikeText(strike: MutationStrike, target: string, actor?: string): string {
  return actor === undefined ? strike.textU.replace('%s', target) : strike.textNpc.replace('%1$s', actor).replace('%2$s', target);
}

export type VenomEffect = 'poison' | 'badpoison';

/** BN melee.cpp checks POISONOUS before POISONOUS2. */
export function venomEffect(c: Character): VenomEffect | null {
  return c.hasTrait('POISONOUS') ? 'poison' : c.hasTrait('POISONOUS2') ? 'badpoison' : null;
}

const pierces = (dealt: readonly { type: string; amount: number }[] | undefined) =>
  !!dealt?.some(d => (d.type === 'cut' || d.type === 'stab') && d.amount > 0);

/**
 * BN Character::melee_attack venom check, after the primary blow: cut/stab damage dealt by the
 * last mutation strike that landed, or by an unarmed primary blow. A strike that missed leaves
 * the previous strike's dealt damage in place (BN reuses one dealt_damage_instance).
 */
export function venomTriggered(
  lastSpecialDealt: readonly { type: string; amount: number }[] | undefined,
  primaryUnarmed: boolean, primaryDealt: readonly { type: string; amount: number }[],
): boolean {
  return pierces(lastSpecialDealt) || (primaryUnarmed && pierces(primaryDealt));
}

/** BN: t.add_effect( effect_poison / effect_badpoison, 6_turns ). */
export const VENOM_TURNS = 6;

export function venomMessage(effect: VenomEffect, target: string): string {
  return effect === 'poison' ? `You poison ${target}!` : `You inject your venom into ${target}!`;
}

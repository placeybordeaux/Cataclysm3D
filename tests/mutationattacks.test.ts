import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Character } from '../src/game/character';
import { Rng } from '../src/core/rng';
import { mutationStrikes, mutationStrikeText, venomEffect, venomMessage, venomTriggered } from '../src/game/mutationattacks';
import { applyFlatArmor, maArmor, meleeAttack, rollMeleeDamage } from '../src/game/combat';
import { maOf } from '../src/game/martialarts';
import { createItem } from '../src/game/item';
import { makeData } from './fixtures/gamedata';

const data = makeData();
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data', name), 'utf8'));
data.items = read('items.json');
data.misc = read('misc.json');
const rolls = { hit: () => 100, dodge: () => 0, twoHanded: false };
function actor(...traits: string[]) {
  const c = new Character(data, { seed: 11 });
  c.dex_base = 40;
  for (const trait of traits) c.addTrait(trait);
  return c;
}

describe('BN mutation special attacks', () => {
  it('applies martial-arts passive absorption before folded damage multipliers', () => {
    const defender = actor();
    maOf(defender).buffs.set('test_guard', { def: { id: 'test_guard', name: 'Guard',
      flat_bonuses: [{ stat: 'armor', type: 'bash', scale: 3 }] }, left: 10, stacks: 1 });
    const packet = [{ type: 'bash', amount: 20, multiplier: 2, armor_penetration: 0, armor_multiplier: 1 }];
    expect(maArmor(defender, packet)[0].amount).toBe(14); // (raw10 - guard3) * 2
    defender.inv.naturalArmor.push(() => 2);
    expect(defender.inv.absorbHit('torso', packet, new Rng(1))[0].amount).toBe(10); // (10 - 3 - 2) * 2
  });
  it('retains primary crit and technique multipliers for one character armor application', () => {
    const c = actor();
    c.skills.unarmed = { level: 5, exercise: 0 };
    const defender = actor();
    defender.inv.naturalArmor.push((_bp, type) => type === 'bash' ? 3 : 0);
    for (const crit of [false, true]) {
      const raw = rollMeleeDamage(c, null, crit, new Rng(9), true);
      const bash = raw.find(u => u.type === 'bash')!;
      expect(bash.multiplier).toBeCloseTo(crit ? 1.74 : 1.16);
      const absorbed = defender.inv.absorbHit('torso', raw, new Rng(1));
      expect(absorbed).toEqual(applyFlatArmor(raw, { bash: 3 }));
      expect(absorbed[0].amount).toBeCloseTo(Math.max(0, bash.amount - 3 * bash.armor_multiplier * bash.multiplier!));
    }
    const result = meleeAttack(c, { dodge: 0 }, new Rng(9), 'defender', {
      autoHit: { glancingMul: 1 },
      forceTechnique: { id: 'test_double', name: 'Double', description: '', unarmed_allowed: true,
        mult_bonuses: [{ stat: 'damage', type: 'bash', scale: 2 }] },
    });
    expect(result.hit).toBe(true);
    expect(result.technique?.id).toBe('test_double');
    expect(result.rawDamage![0].multiplier).toBeGreaterThan(2);
    expect(defender.inv.absorbHit('torso', result.rawDamage!, new Rng(1)))
      .toEqual(applyFlatArmor(result.rawDamage!, { bash: 3 }));
    // The monster output has already lost armor; character defenses use rawDamage instead.
    const armored = meleeAttack(actor(), { dodge: 0, armor: { bash: 3 } }, new Rng(9), 'monster', { autoHit: { glancingMul: 1 } });
    expect(armored.damage).toEqual(applyFlatArmor(armored.rawDamage!, { bash: 3 }));
    expect(armored.rawDamage![0].amount).toBeGreaterThan(armored.damage[0].amount);
  });
  it('selects the actual fang variant, honors mouth coverage and uses actual actor/target texts', () => {
    const c = actor('FANGS');
    let strikes = mutationStrikes(c, new Rng(1), rolls);
    expect(strikes.filter(s => s.mutation === 'FANGS')).toHaveLength(1);
    expect(strikes[0].damage[0].amount).toBe(20);
    expect(mutationStrikeText(strikes[0], 'the zombie')).toBe('You sink your fangs into the zombie');
    expect(mutationStrikeText(strikes[0], 'the zombie', 'Alex')).toBe('Alex sinks their fangs into the zombie');
    c.addTrait('MUZZLE_LONG');
    strikes = mutationStrikes(c, new Rng(2), rolls);
    expect(strikes.filter(s => s.mutation === 'FANGS')).toHaveLength(1);
    const mask = createItem(data, 'mask_dust');
    expect(c.inv.wear(mask, null).ok).toBe(true);
    expect(mutationStrikes(c, new Rng(3), rolls).filter(s => s.mutation === 'FANGS')).toHaveLength(0);
    mask.flags.push('ALLOWS_NATURAL_ATTACKS');
    expect(mutationStrikes(c, new Rng(4), rolls).filter(s => s.mutation === 'FANGS')).toHaveLength(1);
  });

  it('uses dexterity plus unarmed skill for proc chance and the separate 0.8 hit roll', () => {
    const c = actor('FANGS');
    c.dex_base = 8;
    const rng = new Rng(8);
    let procs = 0;
    for (let i = 0; i < 3000; i++) {
      c.skills.unarmed = { level: 0, exercise: 0 };
      procs += mutationStrikes(c, rng, rolls).length;
    }
    expect(procs / 3000).toBeGreaterThan(0.36);
    expect(procs / 3000).toBeLessThan(0.44);
    c.dex_base = 40;
    const dodged = mutationStrikes(c, new Rng(1), { ...rolls, hit: () => 20, dodge: () => 17 });
    expect(dodged).toHaveLength(1);
    expect(dodged[0].roll()).toBe(-1);
  });

  it('rolls each strike only when it is applied, so a dodge spent on one is gone for the next', () => {
    const c = actor('FANGS', 'HORNS_POINTED');
    let dodgesLeft = 1, dodgeRolls = 0;
    const strikes = mutationStrikes(c, new Rng(1), { ...rolls, hit: () => 20, dodge: () => (dodgeRolls++, dodgesLeft-- > 0 ? 100 : 0) });
    expect(strikes).toHaveLength(2);
    expect(dodgeRolls).toBe(0);
    expect(strikes[0].roll()).toBeLessThan(0);
    expect(strikes[1].roll()).toBeGreaterThanOrEqual(0);
    expect(dodgeRolls).toBe(2);
  });

  it('trains unarmed at most once per combo, on the first strike that lands', () => {
    const c = actor('FANGS', 'HORNS_POINTED');
    c.skills.unarmed = { level: 0, exercise: 0 };
    const before = JSON.stringify(c.skills.unarmed);
    const strikes = mutationStrikes(c, new Rng(1), { ...rolls, hit: () => 0, dodge: () => 1 });
    for (const s of strikes) s.roll();
    expect(JSON.stringify(c.skills.unarmed)).toBe(before); // all dodged: no practice
  });

  it('BN venom: POISONOUS before POISONOUS2, on cut/stab from the last landed strike or an unarmed blow', () => {
    expect(venomEffect(actor())).toBeNull();
    expect(venomEffect(actor('POISONOUS'))).toBe('poison');
    expect(venomEffect(actor('POISONOUS2'))).toBe('badpoison');
    const stab = [{ type: 'stab', amount: 3 }], bash = [{ type: 'bash', amount: 9 }], none = [{ type: 'stab', amount: 0 }];
    expect(venomTriggered(stab, false, bash)).toBe(true);
    expect(venomTriggered(none, false, bash)).toBe(false); // armor stopped the fangs
    expect(venomTriggered(undefined, true, [{ type: 'cut', amount: 2 }])).toBe(true); // claws, no weapon
    expect(venomTriggered(undefined, false, [{ type: 'cut', amount: 2 }])).toBe(false); // a knife isn't venomous
    expect(venomMessage('badpoison', 'the zombie')).toBe('You inject your venom into the zombie!');
    expect(meleeAttack(actor(), { dodge: 0 }, new Rng(1), 't', { autoHit: { glancingMul: 1 } }).primaryUnarmed).toBe(true);
  });

  it('preserves negative base damage, caps strength scaling and resolves special armor independently', () => {
    const antlers = actor('ANTLERS');
    antlers.str_base = 8;
    expect(mutationStrikes(antlers, new Rng(1), rolls)[0].damage[0].amount).toBe(6); // -10 + 2*8
    const horns = actor('HORNS_POINTED');
    horns.str_base = 40;
    expect(mutationStrikes(horns, new Rng(1), rolls)[0].damage[0].amount).toBe(45); // 30 + min(15,STR)
    const fangs = mutationStrikes(actor('FANGS'), new Rng(1), rolls)[0];
    expect(applyFlatArmor(fangs.damage, { stab: 15 })[0].amount).toBe(5);
  });

  it('ports tentacle/vine multipliers after armor and working-arm/two-hand restrictions', () => {
    const c = actor('ARM_TENTACLES_4');
    c.str_base = 9;
    const strike = mutationStrikes(c, new Rng(1), rolls)[0];
    expect(strike.damage[0].amount).toBe(12);
    expect(strike.damage[0].multiplier).toBe(3);
    expect(applyFlatArmor(strike.damage, { bash: 3 })[0].amount).toBe(3);
    const defender = actor();
    defender.inv.naturalArmor.push(() => 3);
    expect(defender.inv.absorbHit('torso', strike.damage, new Rng(1))[0].amount).toBe(3);
    expect(mutationStrikes(c, new Rng(1), { ...rolls, twoHanded: true })[0].damage[0].multiplier).toBe(2);
    c.hp.arm_l.cur = 0;
    expect(mutationStrikes(c, new Rng(1), rolls)[0].damage[0].multiplier).toBe(2);
    c.addTrait('CLAWS_TENTACLE');
    const rake = mutationStrikes(c, new Rng(1), rolls)[0];
    expect(rake.damage[0].type).toBe('cut');
    expect(rake.damage[0].amount).toBe(11);
    const vines = actor('VINES3');
    vines.str_base = 8;
    expect(mutationStrikes(vines, new Rng(1), rolls)[0].damage[0]).toMatchObject({ amount: 12, multiplier: 3 });
  });

  it('does not roll special attacks on a primary miss or an AoE follow-up; beak count is bounded', () => {
    const c = actor('FANGS');
    const miss = meleeAttack(c, { dodge: 1000 }, new Rng(1));
    expect(miss.hit).toBe(false);
    expect(miss.mutationStrikes).toBeUndefined();
    const follow = meleeAttack(c, { dodge: 0 }, new Rng(1), 'target', { allowSpecial: false, autoHit: { glancingMul: 0.5 } });
    expect(follow.hit).toBe(true);
    expect(follow.mutationStrikes).toBeUndefined();
    const peck = actor('BEAK_PECK');
    expect(mutationStrikes(peck, new Rng(1), rolls)[0].damage[0].amount).toBe(60);
  });
});

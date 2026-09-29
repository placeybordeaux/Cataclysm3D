import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import {
  aim, applyFlatArmor, attackCooldownSeconds, attackSpeedMoves, critChance, dispersionFromSkill, fireGun, gunDispersion, gunRecoil, maxDispersionMoa,
  meleeAttack, meleeHitBase, meleeHitChance, monsterCanAttackHigh, monsterMeleeAttack, normalAtLeast, rollMeleeDamage, selectBodyPart,
  sizeFromVolume, swingSpeedRating, unwieldyWarning, weaponDispersionSources,
} from '../src/game/combat';
import { heldItemExtent } from '../src/render/viewmodel';
import { createItem } from '../src/game/item';
import { refreshDefenses } from '../src/game/martialarts';
import { makeData } from './fixtures/gamedata';

const data = makeData();
const zombie = data.monsters.mon_zombie;

function survivor(): Character {
  return new Character(data, { seed: 11 });
}

describe('weapon speed legibility', () => {
  it('rates swing speed in bands and warns when wielding something awkward', () => {
    expect(swingSpeedRating(60).label).toBe('fast');
    expect(swingSpeedRating(100).label).toBe('normal');
    expect(swingSpeedRating(150).label).toBe('slow');
    expect(swingSpeedRating(370).label).toBe('very slow');
    const c = survivor();
    expect(unwieldyWarning(c, createItem(data, 'pipe'))).toBeNull();
    const heavy = createItem(data, 'pipe');
    heavy.def = { ...heavy.def, id: 'extinguisher', name: 'large fire extinguisher', volume: 20000, weight: 7030 };
    expect(unwieldyWarning(c, heavy)).toBe('The large fire extinguisher is very unwieldy, attacks will be slow.');
    expect(c.inv.wield(heavy).ok).toBe(true);
  });

  it('held items cover the screen by size: knives small, long things capped, bulky ones shrunk', () => {
    const knife = heldItemExtent({ longest_side: 20, volume: 150 }, 0.2);
    const bat = heldItemExtent({ longest_side: 86, volume: 1750 }, 0.15);
    const spear = heldItemExtent({ longest_side: 260, volume: 5000 }, 0.05);
    const extinguisher = heldItemExtent({ longest_side: 50, volume: 20000 }, 0.6);
    expect(knife).toBeLessThan(bat);
    expect(spear).toBeLessThanOrEqual(0.38);
    expect(extinguisher).toBeLessThan(bat);
  });
});

describe('melee: attack speed (BN melee.cpp Character::attack_cost)', () => {
  it('pipe at 8 dex, no skill: 40 + 40*15/15 - 8 dex = 72 moves', () => {
    const c = survivor();
    const pipe = createItem(data, 'pipe');
    expect(attackSpeedMoves(c, pipe)).toBe(72);
    expect(attackCooldownSeconds(c, pipe)).toBeCloseTo(72 / 100 / 2);
  });

  it('unarmed: attack_cost 65 -> 32 + 32 - 8 = 56; melee 10 -> 32 + 10 - 8', () => {
    const c = survivor();
    expect(attackSpeedMoves(c, null)).toBe(56);
    c.setSkill('melee', 10);
    expect(attackSpeedMoves(c, null)).toBe(34);
  });

  it('exhaustion doubles the base cost at 0 stamina', () => {
    const c = survivor();
    c.stamina = 0;
    expect(attackSpeedMoves(c, createItem(data, 'pipe'))).toBe(40 * 2 + 40 - 8);
  });

  it('torso encumbrance slows the swing', () => {
    const c = survivor();
    c.inv.wear(createItem(data, 'hoodie'));
    c.inv.wear(createItem(data, 'jacket_leather'));
    const enc = c.inv.encumbrance('torso');
    expect(enc).toBeGreaterThan(0);
    expect(attackSpeedMoves(c, createItem(data, 'pipe'))).toBe(72 + enc);
  });
});

describe('melee: to-hit and crits', () => {
  it('hit base = dex/4 + weapon skill/3 + melee/2 + to_hit', () => {
    const c = survivor();
    expect(meleeHitBase(c, createItem(data, 'pipe'))).toBe(2);
    c.setSkill('bashing', 3);
    c.setSkill('melee', 2);
    expect(meleeHitBase(c, createItem(data, 'pipe'))).toBe(2 + 1 + 1);
    // BN: torso encumbrance 20 scales accuracy by 1 - 20/100 (DDA subtracted enc/10)
    const d = survivor();
    d.inv.wear(createItem(data, 'hoodie'));
    d.inv.wear(createItem(data, 'jacket_leather'));
    expect(meleeHitBase(d, null)).toBeCloseTo(2 * 0.8);
  });

  it('hit chance vs an undodging zombie matches normal(10, 25) >= 0', () => {
    const c = survivor();
    c.inv.wield(createItem(data, 'pipe'));
    expect(meleeHitChance(c, c.inv.wielded, 0)).toBeCloseTo(normalAtLeast(10, 25, 0), 5);
    expect(meleeHitChance(c, c.inv.wielded, 0)).toBeCloseTo(0.655, 2);
    const rng = new Rng(3);
    let hits = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      c.skills = {}; // swings train skills; keep the survivor fresh
      c.stamina = c.staminaMax();
      if (meleeAttack(c, { dodge: 0 }, rng).hit) hits++;
    }
    expect(hits / N).toBeGreaterThan(0.62);
    expect(hits / N).toBeLessThan(0.69);
  });

  it('crit chance for a fresh 8/8/8/8 survivor with a pipe = triple chance 0.06125 (melee.cpp crit_chance)', () => {
    const c = survivor();
    const pipe = createItem(data, 'pipe');
    // weapon 0.5 * stat (0.25 + 0.08 + 0.16) * skill 0.25
    expect(critChance(c, pipe, 0, 10)).toBeCloseTo(0.5 * 0.49 * 0.25);
    // with hit roll > 1.5 * dodge the double-crit term is added
    expect(critChance(c, pipe, 20, 10)).toBeGreaterThan(0.2);
  });
});

describe('melee: damage (roll_melee_damage_internal)', () => {
  it('pipe average: (10 + 0.75*8 str) with low cap 0.4, x0.7 armed at bashing 0 = 7.84 bash', () => {
    const c = survivor();
    const d = rollMeleeDamage(c, createItem(data, 'pipe'), false, new Rng(1), true);
    expect(d).toHaveLength(1);
    expect(d[0].type).toBe('bash');
    expect(d[0].amount).toBeCloseTo(7.84);
    expect(d[0].multiplier).toBeCloseTo(0.7);
  });

  it('bare hands add the unarmed skill to the blow and use the unarmed multiplier', () => {
    const c = survivor();
    c.setSkill('unarmed', 5);
    // (0 + 6 str + 5 skill) with low cap 0.4 → avg 7.7, x(0.96 + 0.2)
    const d = rollMeleeDamage(c, null, false, new Rng(1), true).find((u) => u.type === 'bash')!;
    expect(d.amount).toBeCloseTo(((0.4 * 11 + 11) / 2) * 1.16);
  });

  it('armor comes off before the skill multiplier (damage_unit::damage_multiplier)', () => {
    const c = survivor();
    const units = rollMeleeDamage(c, createItem(data, 'pipe'), false, new Rng(1), true);
    // raw 11.2 − armor 2 = 9.2, × 0.7
    expect(applyFlatArmor(units, { bash: 2 })[0].amount).toBeCloseTo((11.2 - 2) * 0.7);
  });

  it('stab skill multiplier 0.66 at skill 0; crits multiply by 1 + skill/10 and ignore 34% armor', () => {
    const c = survivor();
    const knife = createItem(data, 'knife_combat');
    const stab = rollMeleeDamage(c, knife, false, new Rng(1), true).find((u) => u.type === 'stab')!;
    expect(stab.amount).toBeCloseTo(21 * 0.66);
    c.setSkill('stabbing', 5);
    const crit = rollMeleeDamage(c, knife, true, new Rng(1), true).find((u) => u.type === 'stab')!;
    expect(crit.amount).toBeCloseTo(21 * 1.16 * 1.5);
    expect(crit.armor_multiplier).toBeCloseTo(0.66);
  });

  it('bash cap: weak characters get scaled-down damage from heavy weapons', () => {
    const c = survivor();
    c.str_base = 2;
    c.update(1);
    const d = rollMeleeDamage(c, createItem(data, 'crowbar'), false, new Rng(1), true).find((u) => u.type === 'bash')!;
    // dmg 19 + 1.5 = 20.5 > cap 4: mul (1 + 4/20.5)/2
    expect(d.amount).toBeLessThan(10);
  });

  it('meleeAttack spends stamina and trains melee skills', () => {
    const c = survivor();
    c.inv.wield(createItem(data, 'pipe'));
    const before = c.stamina;
    const r = meleeAttack(c, { dodge: 0, armor: { bash: 2 } }, new Rng(9), 'the zombie');
    expect(before - c.stamina).toBe(Math.floor(600 / 16) + 50);
    expect(c.skills.melee.exercise + c.skills.bashing.exercise).toBeGreaterThan(0);
    expect(r.cooldownSeconds).toBeGreaterThan(0);
  });
});

describe('ranged', () => {
  it('Glock 19 dispersion at 8 dex/0 skill: 30 gun + 6 dex + 287.5 skill + recoil', () => {
    const c = survivor();
    const gun = createItem(data, 'glock_19');
    gun.magazineWell()!.insert(createItem(data, 'glockmag', { ammo: '9mm' }));
    expect(gunDispersion(gun)).toBe(30); // (480 + 60) / 18
    expect(dispersionFromSkill(0, 300 / 18)).toBeCloseTo(287.5);
    expect(maxDispersionMoa(weaponDispersionSources(c, gun, 0))).toBeCloseTo(30 + 6 + 287.5);
    c.setSkill('gun', 10);
    c.setSkill('pistol', 10);
    expect(maxDispersionMoa(weaponDispersionSources(c, gun, 0))).toBeCloseTo(36);
  });

  it('recoil per shot: 500 / (1.8^0.8 * 1) (item::gun_recoil)', () => {
    const c = survivor();
    const gun = createItem(data, 'glock_19');
    gun.magazineWell()!.insert(createItem(data, 'glockmag', { ammo: '9mm' }));
    expect(gunRecoil(c, gun)).toBeCloseTo(500 / Math.pow(600 / 333, 0.8), 3);
  });

  it('fireGun consumes a round, makes noise, returns a cone angle and damage', () => {
    const c = survivor();
    const gun = createItem(data, 'glock_19');
    gun.magazineWell()!.insert(createItem(data, 'glockmag', { ammo: '9mm' }));
    c.recoil = 0;
    aim(c, gun, 0);
    const shot = fireGun(c, gun, new Rng(4));
    expect(shot.ok).toBe(true);
    expect(gun.ammoRemaining()).toBe(14);
    expect(shot.noise).toEqual({ volume: 74, sound: 'bang!' });
    expect(shot.damage).toEqual([{ type: 'bullet', amount: 23, armor_penetration: 0 }]);
    expect(shot.range).toBe(14);
    expect(shot.spread).toBeLessThanOrEqual(shot.maxSpread);
    expect(shot.maxSpread).toBeCloseTo(((323.5 / 60) * Math.PI) / 180);
    expect(c.recoil).toBeGreaterThan(300);
    gun.ammoConsume(14);
    expect(fireGun(c, gun, new Rng(4)).message).toBe('Your Glock 19 pistol is empty!');
  });

  it('aiming reduces recoil toward the sight floor (sight 60 + per penalty 14.4)', () => {
    const c = survivor();
    const gun = createItem(data, 'glock_19');
    expect(c.recoil).toBe(3000);
    aim(c, gun, 100);
    expect(c.recoil).toBeLessThan(1500);
    aim(c, gun, 2000);
    expect(c.recoil).toBeCloseTo(74.4, 0);
  });
});

describe('monsters vs the survivor', () => {
  it('zombie accuracy normal(4*5, 25) vs BN dodge (8/4)*5: about two in three attacks land', () => {
    const c = survivor();
    expect(c.dodge()).toBeCloseTo(2, 1);
    const rng = new Rng(6);
    let hits = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      c.hp.torso.cur = c.hp.torso.max;
      c.hp.head.cur = c.hp.head.max;
      c.skills = {}; // dodging trains the dodge skill; keep the survivor fresh
      // One dodge per turn (dodges_left): each attack here is a fresh turn.
      refreshDefenses(c);
      c.stamina = c.staminaMax();
      if (monsterMeleeAttack(zombie, c, rng).hit) hits++;
    }
    const expected = normalAtLeast(20, 25, 10);
    expect(hits / N).toBeGreaterThan(expected - 0.03);
    expect(hits / N).toBeLessThan(expected + 0.03);
  });

  it('hits land on body parts by hit_size (anatomy::select_body_part)', () => {
    const rng = new Rng(8);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20000; i++) {
      const bp = selectBodyPart(rng);
      counts[bp] = (counts[bp] ?? 0) + 1;
    }
    // total hit_size 100: torso 36, each arm/leg 13, head 4
    expect(counts.torso / 20000).toBeCloseTo(0.36, 1);
    expect(counts.arm_l / 20000).toBeCloseTo(0.13, 1);
    expect(counts.head / 20000).toBeCloseTo(0.04, 1);
  });

  it("small monsters can't reach high: no head/torso-less upper hits, legs x3", () => {
    const rng = new Rng(8);
    for (let i = 0; i < 2000; i++) expect(['head', 'eyes', 'mouth']).not.toContain(selectBodyPart(rng, { canAttackHigh: false }));
    expect(sizeFromVolume(62500)).toBe('medium');
    expect(monsterCanAttackHigh(zombie)).toBe(true);
    expect(monsterCanAttackHigh({ ...zombie, volume: 10000 })).toBe(false);
  });

  it('a zombie hitting an arm: dice 2d3 bash, leather jacket absorbs 1, pain and message', () => {
    const c = survivor();
    const log: string[] = [];
    c.onMessage = (t) => log.push(t);
    c.inv.wear(createItem(data, 'jacket_leather'));
    const rng = new Rng(2);
    let r;
    do r = monsterMeleeAttack(zombie, c, rng, { bp: 'arm_l' });
    while (!r.hit);
    const bash = r.raw.find((u) => u.type === 'bash')!.amount;
    expect(bash).toBeGreaterThanOrEqual(2);
    expect(bash).toBeLessThanOrEqual(6);
    expect(r.absorbed.find((u) => u.type === 'bash')!.amount).toBe(bash - 1);
    expect(c.hp.arm_l.cur).toBe(84 - (bash - 1));
    expect(log.some((m) => m.startsWith('The zombie hits your left arm'))).toBe(true);
  });
});

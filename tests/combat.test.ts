import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import {
  aim, attackCooldownSeconds, attackSpeedMoves, critChance, dispersionFromSkill, fireGun, gunDispersion, gunRecoil, maxDispersionMoa,
  meleeAttack, meleeHitBase, meleeHitChance, monsterCanAttackHigh, monsterMeleeAttack, normalAtLeast, rollMeleeDamage, selectBodyPart,
  sizeFromVolume, weaponDispersionSources,
} from '../src/game/combat';
import { createItem } from '../src/game/item';
import { makeData } from './fixtures/gamedata';

const data = makeData();
const zombie = data.monsters.mon_zombie;

function survivor(): Character {
  return new Character(data, { seed: 11 });
}

describe('melee: attack speed (melee.cpp Character::attack_speed)', () => {
  it('pipe at 8 dex, no skill: 40 + 40*15/15 - 4 = 76 moves', () => {
    const c = survivor();
    const pipe = createItem(data, 'pipe');
    expect(attackSpeedMoves(c, pipe)).toBe(76);
    expect(attackCooldownSeconds(c, pipe)).toBeCloseTo(76 / 100 / 2);
  });

  it('unarmed: attack_time 65 -> 32 + 32 - 4 = 60; melee 10 -> 32 + 10 - 4', () => {
    const c = survivor();
    expect(attackSpeedMoves(c, null)).toBe(60);
    c.setSkill('melee', 10);
    expect(attackSpeedMoves(c, null)).toBe(38);
  });

  it('exhaustion doubles the base cost at 0 stamina', () => {
    const c = survivor();
    c.stamina = 0;
    expect(attackSpeedMoves(c, createItem(data, 'pipe'))).toBe(40 * 2 + 40 - 4);
  });
});

describe('melee: to-hit and crits', () => {
  it('hit base = dex/4 + weapon skill/3 + melee/2 + to_hit', () => {
    const c = survivor();
    expect(meleeHitBase(c, createItem(data, 'pipe'))).toBe(2);
    c.setSkill('bashing', 3);
    c.setSkill('melee', 2);
    expect(meleeHitBase(c, createItem(data, 'pipe'))).toBe(2 + 1 + 1);
    // torso encumbrance 20 -> -2
    const d = survivor();
    d.inv.wear(createItem(data, 'hoodie'));
    d.inv.wear(createItem(data, 'jacket_leather'));
    expect(meleeHitBase(d, null)).toBe(2 - 2);
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
  it('pipe average: (10 + 0.75*8 str) with low cap 0.4, x0.8 at skill 0 = 8.96 bash', () => {
    const c = survivor();
    const d = rollMeleeDamage(c, createItem(data, 'pipe'), false, new Rng(1), true);
    expect(d).toHaveLength(1);
    expect(d[0].type).toBe('bash');
    expect(d[0].amount).toBeCloseTo(8.96);
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
  it('zombie accuracy normal(4*5, 25) vs dodge (8/2)*5: about half the attacks land', () => {
    const c = survivor();
    expect(c.dodge()).toBeCloseTo(4, 1);
    const rng = new Rng(6);
    let hits = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      c.hp.torso.cur = c.hp.torso.max;
      c.hp.head.cur = c.hp.head.max;
      c.skills = {}; // dodging trains the dodge skill; keep the survivor fresh
      if (monsterMeleeAttack(zombie, c, rng).hit) hits++;
    }
    expect(hits / N).toBeGreaterThan(0.45);
    expect(hits / N).toBeLessThan(0.56);
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

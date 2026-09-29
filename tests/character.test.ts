import { describe, expect, it } from 'vitest';
import { Character, thirstSpeedPenalty } from '../src/game/character';
import { createItem } from '../src/game/item';
import { makeData } from './fixtures/gamedata';

const data = makeData();

function survivor(seed = 1): { c: Character; log: string[] } {
  const c = new Character(data, { seed });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  return { c, log };
}

/** Advance in 1-minute steps (like frames during clock warp). */
function passTime(c: Character, seconds: number, step = 60): void {
  for (let t = 0; t < seconds; t += step) c.update(Math.min(step, seconds - t));
}

describe('stats and body', () => {
  it('base HP = 60 + 3*str per part (Character::calc_all_parts_hp)', () => {
    const { c } = survivor();
    expect(c.hp.torso).toEqual({ cur: 84, max: 84 });
    c.str_base = 10;
    c.recalcHp(true);
    expect(c.hp.arm_l.max).toBe(90);
  });

  it('TOUGH gives +20% HP (hp_modifier), GLASSJAW -20% head (HEALTH_POINTS_HEAD enchantment)', () => {
    const { c } = survivor();
    c.addTrait('TOUGH');
    expect(c.hp.torso.max).toBe(100); // trunc(84 * 1.2)
    c.removeTrait('TOUGH');
    c.addTrait('GLASSJAW');
    expect(c.hp.head.max).toBe(68); // 84 + trunc(84 * -0.2)
    expect(c.hp.torso.max).toBe(84);
  });

  it('QUICK: speed x1.1 (speed_modifier -> speed_mult)', () => {
    const { c } = survivor();
    c.update(1);
    expect(c.speed).toBe(100);
    c.addTrait('QUICK');
    c.update(1);
    expect(c.speed).toBe(110);
  });

  it('stamina max = PLAYER_MAX_STAMINA 10000; regenerates 20 per action turn', () => {
    const { c } = survivor();
    expect(c.staminaMax()).toBe(10000);
    c.stamina = 0;
    // 24 game seconds = 1 real second = 3 action turns (CLOCK_SCALE 24, ACTION_SCALE 3)
    c.update(24);
    expect(c.stamina).toBe(60);
  });

  it('running burns 15*7 stamina per 100 moves, x2 run cost at full stamina (burn_move_stamina)', () => {
    const { c } = survivor();
    const before = c.stamina;
    c.burnMoveStamina(100, 'run');
    expect(before - c.stamina).toBe(210); // 105 x ((1 + 1) / 2 x 2)
    c.burnMoveStamina(100, 'walk');
    expect(before - c.stamina).toBe(224); // + trunc(15 x (0.979 + 1) / 2)
  });

  it('below 10% stamina you can no longer run (can_run); BN has no winded effect for it', () => {
    const { c } = survivor();
    expect(c.canRun()).toBe(true);
    c.stamina = 1000;
    expect(c.canRun()).toBe(false);
    c.burnMoveStamina(100000, 'run');
    expect(c.stamina).toBe(0);
    expect(c.hasEffect('winded')).toBe(false);
  });
});

describe('damage, pain, death', () => {
  it('pain from damage: bash/5, cut/4 (Creature::deal_damage_handle_type)', () => {
    const { c } = survivor();
    const r = c.takeHit('torso', [{ type: 'bash', amount: 10 }, { type: 'cut', amount: 8 }]);
    expect(r.damage).toBe(18);
    expect(r.pain).toBe(4);
    expect(c.pain).toBe(4);
    expect(c.hp.torso.cur).toBe(66);
  });

  it('minor parts damage their main part', () => {
    const { c } = survivor();
    c.applyDamage('hand_r', 10);
    expect(c.hp.arm_r.cur).toBe(74);
  });

  it('pain penalties (get_pain_penalty: stats floor(pain^0.8 / 10), speed pain^0.7)', () => {
    const { c } = survivor();
    c.pain = 50;
    expect(c.painPenalty()).toEqual({ str: 2, dex: 2, int: 2, per: 2, speed: 15 });
    c.update(1);
    expect(c.str).toBe(6);
    expect(c.speed).toBe(85);
    expect(c.painDescription()).toBe('Distressing pain');
  });

  it('pain fades over time (Character::regen: -(0.2 + pain/50) per 5 min)', () => {
    const { c } = survivor();
    c.pain = 50;
    passTime(c, 3600);
    expect(c.pain).toBeLessThan(40);
    expect(c.pain).toBeGreaterThan(20);
  });

  it('broken limb: HP 0 on an arm breaks it but does not kill, and sleep does not mend it', () => {
    const { c, log } = survivor();
    c.applyDamage('arm_l', 500);
    c.applyDamage('arm_r', 20);
    expect(c.isLimbBroken('arm_l')).toBe(true);
    expect(c.dead).toBe(false);
    expect(log).toContain('Your left arm is broken!');
    // Character::regen: natural healing skips broken limbs (only medicine mends them, slowly)
    c.sleepiness = 800;
    c.fallAsleep();
    passTime(c, 8 * 3600, 60);
    expect(c.hp.arm_l.cur).toBe(0);
    expect(c.hp.arm_r.cur).toBeGreaterThan(64);
  });

  it('dies when head or torso reach 0', () => {
    const { c } = survivor();
    let cause = '';
    c.onDeath = (x) => (cause = x);
    c.applyDamage('head', 200);
    expect(c.dead).toBe(true);
    expect(cause).toBe('head trauma');
  });
});

describe('needs (BN calorie store, instant thirst)', () => {
  it('a new survivor is 100 kcal short of the 17500 kcal maximum and burns 2500 kcal a day', () => {
    const { c } = survivor();
    expect(c.maxStoredKcal()).toBe(17500);
    expect(c.storedKcal).toBe(17400);
    expect(c.bmr()).toBe(2500);
    expect(c.hungerState()).toBe('Sated');
    const start = c.storedKcal;
    passTime(c, 86400, 300);
    expect(start - c.storedKcal).toBeGreaterThan(2450);
    expect(start - c.storedKcal).toBeLessThan(2550);
  });

  it('thirst +1 per 5 minutes: Very Thirsty after a day, which slows you', () => {
    const { c } = survivor();
    passTime(c, 8 * 3600, 300);
    expect(c.thirst).toBe(96);
    expect(c.thirstDescription()).toBe('');
    passTime(c, 16 * 3600, 300);
    expect(c.thirst).toBe(288);
    expect(c.thirstDescription()).toBe('Very Thirsty');
    expect(thirstSpeedPenalty(c.thirst)).toBe(-5);
    expect(c.speed).toBe(100 + thirstSpeedPenalty(c.thirst));
    // the "thirsty" effect carries the stat penalty (duration = thirst - 240)
    expect(c.str_bonus).toBe(-1);
  });

  it('drinking water: quench 50 lowers thirst by 50 at once', () => {
    const { c } = survivor();
    c.thirst = 100;
    c.inv.consume(createItem(data, 'water_clean'), null);
    expect(c.thirst).toBe(50);
    expect(c.hasEffect('bloated')).toBe(false);
    c.inv.consume(createItem(data, 'water_clean'), null);
    c.inv.consume(createItem(data, 'water_clean'), null);
    // past hydrated: bloated for a while
    expect(c.thirst).toBe(-50);
    expect(c.hasEffect('bloated')).toBe(true);
  });

  it('eating: Very Hungry after a day without food; the stomach digests into stored kcal', () => {
    const { c, log } = survivor();
    passTime(c, 86400, 300);
    expect(c.hungerState()).toBe('Very Hungry');
    const kcal = c.storedKcal;
    const r = c.inv.consume(createItem(data, 'can_beans'), null);
    expect(r.ok).toBe(true);
    expect(log).toContain('You eat your canned beans.');
    expect(c.stomach.kcal).toBe(203);
    expect(c.hungerState()).toBe('Hungry');
    passTime(c, 300, 300);
    // stomach_contents::digest: max(100, half) per 5 minutes
    expect(c.stomach.kcal).toBe(101);
    passTime(c, 4 * 3600 - 300, 300);
    expect(c.stomach.kcal).toBe(0);
    expect(c.storedKcal - kcal).toBeCloseTo(203 - (4 * 2500) / 24, -2);
  });

  it('sleepiness +1 per 5 min: Tired after 16 h awake', () => {
    const { c } = survivor();
    passTime(c, 16 * 3600, 300);
    expect(c.sleepiness).toBe(192);
    expect(c.sleepinessDescription()).toBe('Tired');
    expect(c.sleepDeprivation).toBe(192 * 5);
  });

  it('sleeping recovers 2 fatigue per 5 minutes; at 25 you wake well rested', () => {
    const { c, log } = survivor();
    c.sleepiness = 230;
    c.sleepComfort = 5;
    c.tryToSleep();
    passTime(c, 3600, 60);
    expect(c.isAsleep()).toBe(true);
    expect(log).toContain('You fall asleep.');
    passTime(c, 9 * 3600, 60);
    expect(c.isAsleep()).toBe(false);
    expect(c.sleepiness).toBeLessThan(25); // set to 0 on waking, then awake again for a while
    expect(log).toContain('You feel well rested.');
    expect(log).toContain('You wake up.');
  });

  it('a night is at most 10 hours: very tired sleepers wake before they are rested', () => {
    const { c } = survivor();
    c.sleepiness = 500;
    c.fallAsleep();
    passTime(c, 11 * 3600, 60);
    expect(c.isAsleep()).toBe(false);
    expect(c.sleepiness).toBeGreaterThan(250);
    expect(c.sleepiness).toBeLessThan(290);
  });

  it('dehydration kills at 1200 thirst', () => {
    const { c } = survivor();
    c.thirst = 1199;
    passTime(c, 300);
    expect(c.dead).toBe(true);
    expect(c.causeOfDeath).toBe('dehydration');
  });

  it('starvation kills when stored kcal run out', () => {
    const { c } = survivor();
    c.storedKcal = 5;
    passTime(c, 300);
    expect(c.dead).toBe(true);
    expect(c.causeOfDeath).toBe('starvation');
  });
});

describe('effects', () => {
  it('bleeding (eff_fun_bleed) hurts the bleeding part; a bandage stops it and bandages the wound', () => {
    const { c, log } = survivor();
    const e = c.addEffect('bleed', 600, { bp: 'hand_l' }); // main_parts_only -> arm_l
    expect(e.bp).toBe('arm_l');
    expect(e.intensity).toBe(1);
    expect(log).toContain("You're bleeding!");
    passTime(c, 600, 1);
    // one in 36 turns: 1 HP and 1 pain
    expect(c.hp.arm_l.cur).toBeLessThan(84 - 8);
    expect(c.hp.arm_l.cur).toBeGreaterThan(84 - 30);
    expect(log).toContain('You lose some blood.');
    expect(c.hp.torso.cur).toBe(84);
    c.addEffect('bleed', 600, { bp: 'arm_l' });
    const r = c.inv.use(createItem(data, 'bandages'), undefined, 0, null);
    expect(r.ok).toBe(true);
    expect(r.msg).toContain('You stop the bleeding.');
    expect(r.moves).toBe(300);
    expect(c.hasEffect('bleed')).toBe(false);
    expect(c.hasEffect('bandaged', 'arm_l')).toBe(true);
  });

  it('bleeding stacks intensity (int_add_val) up to 3 and eases every 2 minutes (int_decay_tick)', () => {
    const { c } = survivor();
    c.addEffect('bleed', 3600, { bp: 'torso' });
    c.addEffect('bleed', 60, { bp: 'torso' });
    c.addEffect('bleed', 60, { bp: 'torso' });
    c.addEffect('bleed', 60, { bp: 'torso' });
    expect(c.effects.get('bleed', 'torso')!.intensity).toBe(3);
    expect(c.effects.get('bleed', 'torso')!.name()).toBe('Heavy Bleeding');
    passTime(c, 240, 1);
    expect(c.effects.get('bleed', 'torso')!.intensity).toBe(1);
  });

  it('stat mods scale with intensity and truncate toward zero (effect.cpp get_mod)', () => {
    const { c } = survivor();
    c.addEffect('bleed', 1200, { bp: 'torso' }); // BN bleed: str -1, per -1
    c.update(1);
    expect(c.str_bonus).toBe(-1);
    c.removeEffect('bleed');
    c.addEffect('drunk', 250 * 60); // intensity 3: per -1, dex -1, int trunc(-1.5) = -1
    c.update(1);
    expect(c.effects.get('drunk')!.name()).toBe('Trashed');
    expect([c.per_bonus, c.dex_bonus, c.int_bonus]).toEqual([-1, -1, -1]);
  });

  it('painkillers: aspirin -> pkill1_nsaid adds painkiller over time', () => {
    const { c, log } = survivor();
    c.pain = 20;
    const r = c.inv.consume(createItem(data, 'aspirin'), null);
    expect(log).toContain('You take some aspirin.');
    expect(r.ok).toBe(true);
    passTime(c, 240, 1);
    expect(c.painkiller).toBeGreaterThan(2);
    expect(c.perceivedPain()).toBeLessThan(20);
  });

  it('data-driven effect_type from misc overrides builtins (winded pain_chance)', () => {
    const { c } = survivor();
    c.addEffect('winded', 30);
    c.update(1);
    expect(c.speed).toBe(90); // speed_mod -10
    passTime(c, 30, 1);
    expect(c.hasEffect('winded')).toBe(false);
  });

  it('bites become infections after 6 hours; disinfectant cleans bites', () => {
    const { c } = survivor(7);
    c.addEffect('bite', 1, { bp: 'arm_r' });
    passTime(c, 6 * 3600 + 120, 60);
    // (tiny chance to heal spontaneously; seed chosen so it doesn't)
    expect(c.hasEffect('bite')).toBe(false);
    expect(c.hasEffect('infected', 'arm_r')).toBe(true);
    const { c: c2 } = survivor(3);
    c2.addEffect('bite', 1, { bp: 'arm_r' });
    const r = c2.inv.use(createItem(data, 'disinfectant'), undefined, 0, null);
    expect(r.ok).toBe(true);
    expect(c2.hasEffect('bite')).toBe(false);
  });
});

describe('skills, morale, focus', () => {
  it('practice: level 1 at 100 exercise x focus (skill.cpp train); message on level-up', () => {
    const { c, log } = survivor();
    let n = 0;
    while (c.getSkill('melee') < 1 && n < 100) {
      c.practice('melee', 5);
      n++;
    }
    expect(c.getSkill('melee')).toBe(1);
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThan(40); // focus drains as you practice
    expect(log).toContain('Your skill in melee has increased to 1!');
  });

  it('tasty food adds morale (fun), which raises focus equilibrium', () => {
    const { c } = survivor();
    c.inv.consume(createItem(data, 'chocolate'), null);
    expect(c.morale.level()).toBe(20);
    passTime(c, 3600);
    expect(c.focus).toBeGreaterThan(100);
    passTime(c, 3 * 3600);
    expect(c.morale.level()).toBe(0);
  });

  it('optimists get +9 permanent morale and count good morale 1.2x (get_temper_mult)', () => {
    const { c } = survivor();
    c.addTrait('OPTIMISTIC');
    c.update(1);
    expect(c.morale.level()).toBe(10); // trunc(9 x 1.2)
    c.inv.consume(createItem(data, 'chocolate'), null);
    expect(c.morale.level()).toBe(Math.trunc(Math.sqrt(10 * 10 + 24 * 24)));
    c.removeTrait('OPTIMISTIC');
    c.update(1);
    expect(c.morale.has('morale_perm_optimist')).toBe(false);
  });
});

describe('temperature', () => {
  it('naked in freezing weather gets cold; clothes help', () => {
    const { c } = survivor();
    c.env = { temperature: -5, wind: 10, precipitation: false };
    passTime(c, 3600);
    expect(c.bodyTempDescription()).toMatch(/cold|Freezing/i);
    expect(c.effects.intensity('cold')).toBeGreaterThanOrEqual(2);
    const { c: d } = survivor();
    for (const id of ['hoodie', 'jacket_leather', 'jeans', 'sneakers', 'hat_hard']) d.inv.wear(createItem(data, id), null);
    d.env = { temperature: 10, wind: 0, precipitation: false };
    passTime(d, 3600);
    expect(d.effects.has('cold', 'torso')).toBe(false);
  });

  it('rain soaks you unless covered', () => {
    const { c } = survivor();
    c.env = { temperature: 20, wind: 0, precipitation: true };
    passTime(c, 600);
    expect(c.wetness.torso).toBe(1);
    expect(c.warmth('torso')).toBe(0);
  });
});

describe('serialization', () => {
  it('toJSON/load round-trip', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    c.inv.giveNew(createItem(data, 'can_beans'));
    c.addEffect('bleed', 300, { bp: 'leg_l' });
    c.addTrait('TOUGH');
    c.setSkill('melee', 3);
    c.pain = 7;
    const j = JSON.parse(JSON.stringify(c.toJSON()));
    const d = new Character(data);
    d.load(j);
    expect(d.toJSON()).toEqual(c.toJSON());
    expect(d.inv.countOf('can_beans')).toBe(1);
  });
});

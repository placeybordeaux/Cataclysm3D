import { describe, expect, it } from 'vitest';
import { BLOOD_MIN, Character, SLEEPINESS, thirstSpeedPenalty } from '../src/game/character';
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

  it('TOUGH gives +20% HP (MAX_HP enchantment), GLASSJAW 80% head', () => {
    const { c } = survivor();
    c.addTrait('TOUGH');
    expect(c.hp.torso.max).toBe(100); // floor(84 * 1.2)
    c.removeTrait('TOUGH');
    c.addTrait('GLASSJAW');
    expect(c.hp.head.max).toBe(67);
    expect(c.hp.torso.max).toBe(84);
  });

  it('QUICK: speed x1.1 (SPEED enchantment)', () => {
    const { c } = survivor();
    c.update(1);
    expect(c.speed).toBe(100);
    c.addTrait('QUICK');
    c.update(1);
    expect(c.speed).toBe(110);
  });

  it('stamina max = 3500 + 5 * cardio(1000); regenerates 20 per action turn', () => {
    const { c } = survivor();
    expect(c.staminaMax()).toBe(8500);
    c.stamina = 0;
    // 24 game seconds = 1 real second = 3 action turns (CLOCK_SCALE 24, ACTION_SCALE 3)
    c.update(24);
    expect(c.stamina).toBe(60);
  });

  it('running burns 15*7 stamina per 100 moves (burn_move_stamina + move_modes.json)', () => {
    const { c } = survivor();
    const before = c.stamina;
    c.burnMoveStamina(100, 'run');
    expect(before - c.stamina).toBe(105);
    c.burnMoveStamina(100, 'walk');
    expect(before - c.stamina).toBe(120);
  });

  it('running out of stamina makes you winded; you can no longer run', () => {
    const { c, log } = survivor();
    c.burnMoveStamina(100000, 'run');
    expect(c.stamina).toBe(0);
    expect(c.hasEffect('winded')).toBe(true);
    expect(c.canRun()).toBe(false);
    expect(log).toContain('Your breath gives out!');
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

  it('pain penalties (get_pain_penalty with PAIN_PENALTY_MOD_*)', () => {
    const { c } = survivor();
    c.pain = 50;
    expect(c.painPenalty()).toEqual({ str: 2, dex: 3, int: 4, per: 4, speed: 15 });
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

  it('broken limb: HP 0 on an arm breaks it but does not kill', () => {
    const { c, log } = survivor();
    c.applyDamage('arm_l', 500);
    expect(c.isLimbBroken('arm_l')).toBe(true);
    expect(c.dead).toBe(false);
    expect(log).toContain('Your left arm is broken!');
    // broken limbs don't regenerate naturally
    c.heal('arm_l', 10);
    expect(c.hp.arm_l.cur).toBe(0);
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

describe('needs', () => {
  it('BMR ~1738 kcal/day for the default survivor (Character::base_bmr)', () => {
    const { c } = survivor();
    expect(Math.round(c.baseBmr())).toBeGreaterThan(1700);
    expect(Math.round(c.baseBmr())).toBeLessThan(1780);
    const start = c.storedKcal;
    passTime(c, 86400, 300);
    expect(start - c.storedKcal).toBeCloseTo(c.baseBmr(), -2);
  });

  it('thirst +1 per 5 minutes awake: Very thirsty after 8 h, Dehydrated after a day', () => {
    const { c } = survivor();
    passTime(c, 8 * 3600, 300);
    expect(c.thirst).toBe(96);
    expect(c.thirstDescription()).toBe('Very thirsty');
    passTime(c, 16 * 3600, 300);
    expect(c.thirstDescription()).toBe('Dehydrated');
    expect(c.speed).toBe(100 + thirstSpeedPenalty(c.thirst));
  });

  it('drinking water: quench 50 = 250 ml -> thirst -50 within 5 minutes', () => {
    const { c } = survivor();
    c.thirst = 100;
    c.inv.consume(createItem(data, 'water_clean'));
    expect(c.instantThirst()).toBe(50);
    passTime(c, 300);
    expect(c.thirst).toBeLessThanOrEqual(51);
    expect(c.stomach.water).toBe(0);
  });

  it('eating: hungry after a day without food; eating fills the stomach and stores kcal', () => {
    const { c, log } = survivor();
    passTime(c, 86400, 300);
    expect(c.hungerState()).toBe('Hungry');
    const kcal = c.storedKcal;
    const r = c.inv.consume(createItem(data, 'can_beans'));
    expect(r.ok).toBe(true);
    expect(log).toContain('You eat your canned beans.');
    expect(c.hungerState()).toBe('');
    passTime(c, 4 * 3600, 300);
    // stomach passes 1/6 of its kcal per 30 min (stomach.cpp); the rest is still digesting
    expect(c.stomach.kcal).toBeCloseTo(203 * (5 / 6) ** 8, -1);
    expect(c.storedKcal - kcal + c.stomach.kcal).toBeCloseTo(203 - (4 * c.bmr()) / 24, -1);
  });

  it('sleepiness +1 per 5 min: Tired after 16 h awake', () => {
    const { c } = survivor();
    passTime(c, 16 * 3600, 300);
    expect(c.sleepiness).toBe(192);
    expect(c.sleepinessDescription()).toBe('Tired');
    expect(c.sleepDeprivation).toBe(192 * 5);
  });

  it('sleeping recovers sleepiness and you wake up rested', () => {
    const { c, log } = survivor();
    c.sleepiness = SLEEPINESS.TIRED + 10;
    c.tryToSleep();
    passTime(c, 3600, 60);
    expect(c.isAsleep()).toBe(true);
    expect(log).toContain('You fall asleep.');
    passTime(c, 10 * 3600, 60);
    expect(c.isAsleep()).toBe(false);
    expect(c.sleepiness).toBeLessThan(0);
    expect(log).toContain('You wake up.');
  });

  it('dehydration kills at 1200 thirst', () => {
    const { c } = survivor();
    c.thirst = 1199;
    passTime(c, 300);
    expect(c.dead).toBe(true);
    expect(c.causeOfDeath).toBe('dehydration');
  });
});

describe('effects', () => {
  it('bleeding drains blood (eff_fun_bleed) until hypovolemia; bandage stops it', () => {
    const { c, log } = survivor();
    const e = c.addEffect('bleed', 600, { bp: 'hand_l' }); // main_parts_only -> arm_l
    expect(e.bp).toBe('arm_l');
    expect(e.intensity).toBe(10); // int_dur_factor 60 s
    expect(log).toContain("You're bleeding!");
    passTime(c, 300, 1);
    // intensity falls as duration runs down: sum over 300 s ~ 10+..+6 per minute
    expect(c.blood).toBeLessThan(-2000);
    expect(c.blood).toBeGreaterThan(-3000);
    const r = c.inv.use(createItem(data, 'bandages'));
    expect(r.ok).toBe(true);
    expect(r.msg).toContain('You stop the bleeding.');
    expect(r.moves).toBe(6000);
    expect(c.hasEffect('bleed')).toBe(false);
    expect(c.hasEffect('bandaged', 'arm_l')).toBe(false); // arm isn't damaged: nothing to bandage
    const blood = c.blood;
    passTime(c, 600, 1);
    expect(c.blood).toBe(blood + 100); // regenerates 1 per 6 s
  });

  it('heavy bleeding causes hypovolemic shock and can kill', () => {
    const { c, log } = survivor();
    c.addEffect('bleed', 2400, { bp: 'torso' }); // intensity 40
    passTime(c, 600, 1);
    expect(c.effects.intensity('hypovolemia')).toBeGreaterThanOrEqual(2);
    expect(log).toContain('You have lost a lot of blood, and your condition worsens.');
    c.blood = BLOOD_MIN + 10;
    passTime(c, 5, 1);
    expect(c.dead).toBe(true);
    expect(c.causeOfDeath).toBe('blood loss');
  });

  it('stat mods scale with intensity and truncate toward zero (effect.cpp get_mod)', () => {
    const { c } = survivor();
    c.addEffect('bleed', 1200, { bp: 'torso' }); // intensity 20: str -0.1*19 = -1.9 -> -1
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
    const r = c.inv.consume(createItem(data, 'aspirin'));
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
    const r = c2.inv.use(createItem(data, 'disinfectant'));
    expect(r.ok).toBe(true);
    expect(c2.hasEffect('bite')).toBe(false);
  });
});

describe('skills, morale, focus', () => {
  it('practice: level 1 at 10000 exercise (skill.cpp); message on level-up', () => {
    const { c, log } = survivor();
    let n = 0;
    while (c.getSkill('melee') < 1 && n < 100) {
      c.practice('melee', 5);
      n++;
    }
    expect(c.getSkill('melee')).toBe(1);
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThan(40); // focus drains as you practice
    expect(log).toContain('Your practical skill in melee has increased to 1!');
  });

  it('tasty food adds morale (fun), which raises focus equilibrium', () => {
    const { c } = survivor();
    c.inv.consume(createItem(data, 'chocolate'));
    expect(c.morale.level()).toBe(20);
    passTime(c, 3600);
    expect(c.focus).toBeGreaterThan(100);
    passTime(c, 3 * 3600);
    expect(c.morale.level()).toBe(0);
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
    for (const id of ['hoodie', 'jacket_leather', 'jeans', 'sneakers', 'hat_hard']) d.inv.wear(createItem(data, id));
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
    c.inv.wear(createItem(data, 'backpack'));
    c.inv.pickUp(createItem(data, 'can_beans'));
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

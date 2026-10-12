// BN venom on monsters: monster::is_immune_effect and the poison effect mods monsters read
// (SPEED, DODGE, HIT, BASH, CUT) from data/json/effects.json.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import { monsterMeleeAttack } from '../src/game/combat';
import { withMeleeBonus } from '../src/game/monattack';
import { Monster } from '../src/game/monster';
import { makeData } from './fixtures/gamedata';

const data = makeData();
const monsters = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/monsters.json'), 'utf8'));
data.monsters = Array.isArray(monsters) ? Object.fromEntries(monsters.map((m: { id: string }) => [m.id, m])) : monsters;

const make = (id: string, patch: Record<string, unknown> = {}) => new Monster(data, { ...data.monsters[id], ...patch }, 1, 1, 0, new Rng(1));

describe('monster venom', () => {
  it('only warm-blooded flesh takes poison', () => {
    expect(make('mon_dog').resistsPoison()).toBe(false);
    expect(make('mon_dog', { flags: data.monsters.mon_dog.flags.filter((f: string) => f !== 'WARM') }).resistsPoison()).toBe(true);
    expect(make('mon_dog', { material: ['steel'] }).resistsPoison()).toBe(true);
    expect(make('mon_dog', { material: ['iflesh'] }).resistsPoison()).toBe(false);
  });

  // effects.json "dodge_mod": [-1, -1] etc. are [normal, reduced] (effect.cpp extract_effect);
  // monsters never resist, so they take the first value: poison -1 dodge/hit, -2 bash/cut;
  // badpoison -10 speed, -2 dodge/hit, -3 bash/cut. The two stack (one bonus per effect).
  it('poison costs 1 dodge and 1 accuracy; badpoison slows (-10 speed) and costs 2 of each', () => {
    const dog = make('mon_dog', { dodge: 4 });
    const speed = dog.speed;
    expect([dog.dodge(), dog.hitBonus()]).toEqual([4, 0]);
    dog.addEffect('poison', 5);
    expect([dog.speed, dog.dodge(), dog.hitBonus()]).toEqual([speed, 3, -1]);
    dog.effects.delete('poison');
    dog.addEffect('badpoison', 5);
    expect([dog.speed, dog.dodge(), dog.hitBonus()]).toEqual([speed - 10, 2, -2]);
    expect(dog.moveSpeed(100)).toBeCloseTo(make('mon_dog').moveSpeed(100) * (speed - 10) / speed);
    dog.addEffect('poison', 5);
    expect([dog.dodge(), dog.hitBonus()]).toEqual([1, -3]);
  });

  it('poison weakens melee: bash_bonus / cut_bonus -2 (poison), -3 (badpoison), stacking', () => {
    const dog = make('mon_dog');
    expect(dog.meleeBonus()).toEqual({ bash: 0, cut: 0 });
    dog.addEffect('poison', 5);
    expect(dog.meleeBonus()).toEqual({ bash: -2, cut: -2 });
    dog.addEffect('badpoison', 5);
    expect(dog.meleeBonus()).toEqual({ bash: -5, cut: -5 });
    dog.effects.delete('poison');
    expect(dog.meleeBonus()).toEqual({ bash: -3, cut: -3 });
  });

  it('monster::melee_attack adds the bonus to the dice bash and to the cut unit; <= 0 deals nothing', () => {
    const zombie = data.monsters.mon_zombie;
    const swing = (seed: number, bonus?: { bash: number; cut: number }, def = zombie) => {
      const c = new Character(data, { seed: 11 });
      const rng = new Rng(seed);
      let r;
      do r = monsterMeleeAttack(def, c, rng, { bp: 'torso', dodgeable: false, bonus });
      while (!r.hit);
      return r.raw;
    };
    // Same seed, same dice: only the bonus differs.
    for (let seed = 1; seed < 40; seed++) {
      const plain = swing(seed).find((u) => u.type === 'bash')!.amount;
      const weak = swing(seed, { bash: -3, cut: -3 }).find((u) => u.type === 'bash')?.amount ?? 0;
      expect(weak).toBe(Math.max(0, plain - 3));
    }
    // A cutting monster loses cut damage too; a monster with no cut doesn't gain a cut unit.
    const clawed = { ...zombie, melee_damage: [{ damage_type: 'cut', amount: 5 }] };
    expect(swing(3, { bash: -3, cut: -3 }, clawed).find((u) => u.type === 'cut')!.amount).toBe(2);
    expect(swing(3, { bash: -3, cut: -3 }).some((u) => u.type === 'cut')).toBe(false);
    // An override (melee_actor damage) already carries the bonus: passing both is a bug.
    expect(() => monsterMeleeAttack(zombie, new Character(data, { seed: 11 }), new Rng(1), { damage: [{ damage_type: 'bash', amount: 3 }], bonus: { bash: -3, cut: -3 } })).toThrow();
  });

  it('melee_actor: the bonus merges into damage_max_instance by type before the multiplier', () => {
    expect(withMeleeBonus([{ damage_type: 'bash', amount: 9 }], { bash: -3, cut: -3 })).toEqual([{ damage_type: 'bash', amount: 6 }, { damage_type: 'cut', amount: -3 }]);
    expect(withMeleeBonus([{ damage_type: 'cut', amount: 8 }], { bash: 0, cut: -2 })).toEqual([{ damage_type: 'cut', amount: 6 }]);
  });
});

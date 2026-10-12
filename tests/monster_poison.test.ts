// BN venom on monsters: monster::is_immune_effect and the poison effect mods monsters read
// (SPEED, DODGE, HIT) from data/json/effects.json.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
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

  it('badpoison slows (-10 speed), and costs 2 dodge and 2 accuracy; plain poison only hurts', () => {
    const dog = make('mon_dog');
    const { speed, dodge } = { speed: dog.speed, dodge: dog.dodge() };
    dog.addEffect('poison', 5);
    expect([dog.speed, dog.dodge(), dog.hitBonus()]).toEqual([speed, dodge, 0]);
    dog.addEffect('badpoison', 5);
    expect([dog.speed, dog.dodge(), dog.hitBonus()]).toEqual([speed - 10, Math.max(0, dodge - 2), -2]);
    expect(dog.moveSpeed(100)).toBeCloseTo(make('mon_dog').moveSpeed(100) * (speed - 10) / speed);
  });
});

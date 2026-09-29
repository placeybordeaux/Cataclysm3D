// Body temperature against real Bright Nights items (public/data): update_bodytemp_bps'
// convergent temperatures, wake_if_hypothermia, and bedding/fire warmth.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { BODYTEMP, Character, localWindchill, logarithmicRange, partList } from '../src/game/character';
import { BODY_PARTS, type BodyPartId } from '../src/game/bodyparts';
import { createItem, fromSpawned } from '../src/game/item';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: {}, furniture: {}, items: load('items.json'), itemGroups: load('item_groups.json'),
  monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json'),
};

function survivor(wear: string[]): { c: Character; log: string[] } {
  const c = new Character(data, { seed: 3 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  for (const id of wear) c.inv.wear(createItem(data, id));
  return { c, log };
}
const pass = (c: Character, s: number, step = 30) => {
  for (let t = 0; t < s; t += step) c.update(step);
};
const hpLost = (c: Character) => Object.values(c.hp).reduce((a, h) => a + h.max - h.cur, 0);
const SURVIVOR_CLOTHES = ['longshirt', 'jeans', 'socks', 'sneakers', 'boxer_shorts'];

describe('BN body temperature', () => {
  it('threshold messages group parts', () => {
    expect(partList(['torso'])).toBe('torso');
    expect(partList(['torso', 'arm_l', 'arm_r'])).toBe('torso and arms');
    expect(partList(['head', 'arm_l', 'leg_l', 'leg_r'])).toBe('head, left arm and legs');
    const { c, log } = survivor([]);
    c.env = { temperature: 0, wind: 0, precipitation: false };
    pass(c, 3600);
    expect(log.filter((m) => /getting chilly/.test(m)).length).toBeLessThanOrEqual(2);
  });

  it('helpers match cata_utility / weather.cpp', () => {
    expect(logarithmicRange(31, 43, 37)).toBeCloseTo(0.5, 5);
    expect(logarithmicRange(31, 43, 20)).toBe(1);
    // get_local_windchill (°F delta, ceil): below 70 °F a lerp from the 30 °F cold model
    // (wind floored at 3 mph, so still air still chills) to the 70 °F apparent-temperature model
    expect(localWindchill(-5, 70, 1)).toBe(-3);
    expect(localWindchill(-5, 70, 10)).toBe(-9);
    expect(localWindchill(30, 50, 0)).toBe(6);
  });

  it('a clothed survivor awake in a 0 °C shelter is at worst chilly and takes no damage', () => {
    const { c } = survivor(SURVIVOR_CLOTHES);
    c.env = { temperature: 0, wind: 0, precipitation: false };
    pass(c, 4 * 3600);
    expect(c.effects.intensity('cold')).toBeLessThanOrEqual(1);
    expect(hpLost(c)).toBe(0);
  });

  it('sleeping at -4 °C in everyday clothes: a torso at BODYTEMP_COLD shivers you awake', () => {
    const { c, log } = survivor(SURVIVOR_CLOTHES);
    c.env = { temperature: -4, wind: 0, precipitation: false, bedding: -4 };
    c.sleepiness = 300;
    c.fallAsleep();
    pass(c, 3600);
    expect(c.isAsleep()).toBe(false);
    expect(log).toContain('Your shivering prevents you from sleeping.');
    expect(hpLost(c)).toBeLessThan(5);
  });

  it('even dead tired, the cold wakes you (BN has no exhaustion exception)', () => {
    const { c, log } = survivor([]);
    c.env = { temperature: -4, wind: 0, precipitation: false, bedding: -4 };
    c.sleepiness = 500;
    c.fallAsleep();
    pass(c, 3600);
    expect(c.isAsleep()).toBe(false);
    expect(log).toContain('Your shivering prevents you from sleeping.');
    expect(c.dead).toBe(false);
  });

  it('a blanket worn over your clothes lets you sleep through a -4 °C night', () => {
    const { c } = survivor([...SURVIVOR_CLOTHES, 'blanket']);
    c.env = { temperature: -4, wind: 0, precipitation: false, bedding: -4 };
    c.sleepiness = 350;
    c.fallAsleep();
    pass(c, 3 * 3600);
    expect(c.isAsleep()).toBe(true);
    expect(c.bodyTemp.torso).toBeGreaterThan(BODYTEMP.COLD);
    expect(hpLost(c)).toBe(0);
  });

  it('a bed and a blanket on the floor are comfortable warmth; a fire warms you awake', () => {
    const naked = () => survivor([]).c;
    const a = naked(), b = naked();
    a.env = { temperature: 5, wind: 0, precipitation: false, bedding: -4 };
    b.env = { temperature: 5, wind: 0, precipitation: false, bedding: 2, floorItemWarmth: 0.12 * 50 * (15500 / 2500) };
    a.sleepiness = b.sleepiness = 350;
    a.fallAsleep(); b.fallAsleep();
    pass(a, 3600); pass(b, 3600);
    // bedding only pulls you toward BODYTEMP_NORM (adjust_bp_conv_for_bonus_warmth); the bare
    // floor's -4 °C is never applied as a chill
    expect(a.bodyTemp.head).toBeCloseTo(34, 0);
    expect(b.bodyTemp.head).toBeGreaterThan(a.bodyTemp.head + 2.5);
    expect(b.bodyTemp.head).toBeLessThanOrEqual(BODYTEMP.NORM + 0.1);
    const f = naked(), g = naked();
    f.env = { temperature: 0, wind: 0, precipitation: false };
    g.env = { temperature: 0 + (6 * 4 / 1) * 5 / 9, wind: 0, precipitation: false, bestFire: 2 };
    pass(f, 3600); pass(g, 3600);
    expect(g.bodyTemp.torso).toBeGreaterThan(f.bodyTemp.torso + 2);
  });

  it('body parts match BN body_parts.json (hit sizes, drench capacity)', () => {
    const bps = data.misc.body_part as Record<string, { hit_size: number; hit_size_relative?: number[]; hit_difficulty: number; drench_capacity: number }>;
    for (const [id, bp] of Object.entries(BODY_PARTS)) {
      const d = bps[id as BodyPartId];
      expect(bp.hit_size, id).toBe(d.hit_size);
      expect(bp.hit_size_relative, id).toEqual(d.hit_size_relative ?? [0, 0, 0]);
      expect(bp.hit_difficulty, id).toBe(d.hit_difficulty);
      expect(bp.drench_capacity, id).toBe(d.drench_capacity);
    }
  });

  it('liquids overflowing their default container fill more containers', () => {
    const out = fromSpawned(data, { id: 'water_clean', count: 1, charges: 7 });
    expect(out.every((i) => i.typeId !== 'water_clean')).toBe(true);
    expect(out.reduce((n, i) => n + i.allContents().reduce((m, x) => m + x.charges, 0), 0)).toBe(7);
  });
});

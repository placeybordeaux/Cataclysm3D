// The gameplay core against the real extracted CDDA data (public/data), not fixtures:
// the same behaviours as the fixture tests plus a smoke pass over every item/monster.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Character } from '../src/game/character';
import { fireGun, monsterMeleeAttack } from '../src/game/combat';
import { createItem, fromSpawned, Item } from '../src/game/item';
import { BODY_PARTS, ALL_PARTS } from '../src/game/bodyparts';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: {},
  furniture: {},
  items: load('items.json'),
  itemGroups: load('item_groups.json'),
  monsters: load('monsters.json'),
  monsterGroups: {},
  recipes: [],
  misc: load('misc.json'),
};

function survivor(): { c: Character; log: string[] } {
  const c = new Character(data, { seed: 21 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  return { c, log };
}

describe('real data: items', () => {
  it('backpack, jeans, hoodie give storage and encumbrance', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    expect(c.inv.volumeCapacity()).toBeGreaterThanOrEqual(25000);
    expect(c.inv.encumbrance('torso')).toBe(2);
    expect(c.inv.wear(createItem(data, 'backpack')).ok).toBe(false);
    c.inv.wear(createItem(data, 'jeans'));
    expect(c.inv.encumbrance('leg_l')).toBe(7);
    expect(c.inv.pickUp(createItem(data, 'can_beans')).ok).toBe(true);
  });

  it('water_clean spawns in a plastic bottle and quenches thirst', () => {
    const { c, log } = survivor();
    const [bottle] = fromSpawned(data, { id: 'water_clean', count: 1, charges: 2 });
    expect(bottle.typeId).toBe('bottle_plastic');
    expect(bottle.name()).toBe('plastic bottle > clean water (2)');
    c.thirst = 100;
    expect(c.inv.consume(bottle).ok).toBe(true);
    expect(log).toContain('You drink your clean water.');
    expect(c.instantThirst()).toBe(50);
  });

  it('glock_19 + glockmag + 9mm: default ammo, reload, fire', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    const gun = createItem(data, 'glock_19');
    c.inv.wield(gun);
    c.inv.pickUp(createItem(data, 'glockmag', { ammo: 'default' }));
    const r = c.inv.reload();
    expect(r.ok).toBe(true);
    expect(r.moves).toBe(153);
    expect(gun.ammoRemaining()).toBe(15);
    expect(gun.name()).toBe('Glock carry pistol (15/15)');
    const shot = fireGun(c, gun, new Rng(1));
    expect(shot.ok).toBe(true);
    expect(shot.damage[0]).toMatchObject({ type: 'bullet', amount: 23 });
    expect(shot.noise.sound).toBe('bang!');
    expect(shot.noise.volume).toBeGreaterThan(50);
    expect(gun.ammoRemaining()).toBe(14);
  });

  it('bandages stop bleeding; aspirin is a painkiller', () => {
    const { c } = survivor();
    c.addEffect('bleed', 600, { bp: 'leg_r' });
    c.applyDamage('leg_r', 10);
    const r = c.inv.use(createItem(data, 'bandages'));
    expect(r.msg).toContain('You stop the bleeding.');
    expect(c.hasEffect('bandaged', 'leg_r')).toBe(true);
    c.pain = 10;
    c.inv.consume(createItem(data, 'aspirin'));
    for (let i = 0; i < 240; i++) c.update(1);
    expect(c.painkiller).toBeGreaterThan(0);
  });

  it('flashlight spawns with its default battery and turns on', () => {
    const { c } = survivor();
    const fl = createItem(data, 'flashlight', { ammo: 'default' });
    expect(fl.magazineCurrent()?.typeId).toBe('medium_battery_cell');
    expect(fl.ammoRemaining()).toBe(56);
    expect(c.inv.use(fl).msg).toBe('You turn the flashlight on.');
    expect(fl.typeId).toBe('flashlight_on');
    expect(fl.active).toBe(true);
  });

  it('real traits and damage adjectives', () => {
    const { c } = survivor();
    c.addTrait('TOUGH');
    expect(c.hp.torso.max).toBe(100);
    const jacket = createItem(data, 'jacket_leather');
    jacket.damage = 1000;
    expect(jacket.name()).toBe('cut leather jacket');
  });

  it('smoke: every item can be created, weighed, named and serialized', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const { c } = survivor();
    for (const id of Object.keys(data.items)) {
      const it = createItem(data, id);
      expect(Number.isFinite(it.weight())).toBe(true);
      expect(Number.isFinite(it.volume())).toBe(true);
      expect(typeof it.name()).toBe('string');
      Item.fromJSON(data, it.toJSON());
      if (it.isArmor()) for (const bp of ALL_PARTS) expect(Number.isFinite(c.inv.itemEncumbrance(it, bp))).toBe(true);
      if (it.isGun()) expect(Number.isFinite(it.attackTime())).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(5000);
    warn.mockRestore();
  });

  it('smoke: every monster can attack the survivor', () => {
    const rng = new Rng(5);
    for (const mon of Object.values(data.monsters)) {
      const { c } = survivor();
      const r = monsterMeleeAttack(mon, c, rng);
      if (r.hit) expect(Object.keys(BODY_PARTS)).toContain(r.bp);
    }
  });

  it('all effect_types parse and can be applied for a minute', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { c } = survivor();
    for (const id of Object.keys(data.misc.effect_type)) {
      const e = c.addEffect(id, 60, { bp: 'torso' });
      expect(e.intensity).toBeGreaterThanOrEqual(0);
    }
    for (let i = 0; i < 60; i++) c.update(1);
    warn.mockRestore();
  });
});

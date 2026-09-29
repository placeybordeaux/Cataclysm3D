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
import { itemsOf, stackEntries, type InvEntry } from '../src/ui/inventory_ui';
import { L, spawnItem } from '../src/game/moves';
import { expandItemGroup } from '../src/data/itemgroups';

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
  it('a liquid spawned with "container-item" goes in that container, not in its default one first', () => {
    // spice.json: { "item": "ketchup", "charges": 32, "container-item": "condiment_bottle_sealed" }
    const [bottle, ...rest] = fromSpawned(data, { id: 'condiment_bottle_sealed', count: 1, contents: [{ id: 'ketchup', count: 1, charges: 32 }] });
    expect(rest).toEqual([]);
    expect(bottle.allContents().map((c) => `${c.typeId}x${c.charges}`)).toEqual(['ketchupx32']);
    // ... while an item group entry without one gets its default container (Item_modifier::modify)
    const spawned = expandItemGroup(data, { subtype: 'collection', entries: [{ item: 'water_clean' }] } as never, new Rng(1));
    const [bottle2] = spawned.flatMap((s) => fromSpawned(data, s));
    expect(bottle2.typeId).toBe('bottle_plastic');
    expect(bottle2.contents.map((c) => `${c.typeId}x${c.charges}`)).toEqual(['water_cleanx2']);
  });

  it('bows, crossbows and flamethrowers make their own shot sounds (ranged.cpp gun_noise)', () => {
    expect(createItem(data, 'crossbow').gunNoise().sound).toBe('thonk!');
    expect(createItem(data, 'compbow').gunNoise().sound).toBe('whizz!');
    expect(createItem(data, 'flamethrower').gunNoise()).toEqual({ volume: 4, sound: 'Fwoosh!' });
  });

  it('identical items inside a container show as one inventory line', () => {
    const { c } = survivor();
    const bag = createItem(data, 'bag_plastic');
    const loc = L.in(bag);
    for (let i = 0; i < 4; i++) expect(spawnItem(createItem(data, 'crowbar'), loc).ok).toBe(true);
    const entries: InvEntry[] = [
      { item: bag, where: 'carried', loc: L.inv(c), depth: 0 },
      ...bag.contents.map((item) => ({ item, where: 'carried' as const, loc, depth: 1, parent: bag })),
    ];
    const stacked = stackEntries(entries);
    expect(stacked.map((e) => [e.item.typeId, itemsOf(e).length])).toEqual([['bag_plastic', 1], ['crowbar', 4]]);
  });

  it('backpack and jeans give carrying volume; soft backpack encumbrance grows with the load', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    expect(c.inv.volumeCapacity()).toBe(15000);
    expect(c.inv.encumbrance('torso')).toBe(3);
    c.inv.wear(createItem(data, 'jeans'), null);
    expect(c.inv.volumeCapacity()).toBe(15500);
    expect(c.inv.giveNew(createItem(data, 'can_beans'))?.kind).toBe('inv');
  });

  it('water_clean spawns in a plastic bottle and quenches thirst', () => {
    const { c, log } = survivor();
    const [bottle] = fromSpawned(data, { id: 'bottle_plastic', count: 1, contents: [{ id: 'water_clean', count: 1, charges: 2 }] });
    expect(bottle.name()).toBe('clean water (plastic bottle) (2/2)');
    c.thirst = 100;
    expect(c.inv.consume(bottle, null).ok).toBe(true);
    expect(log).toContain('You drink your clean water.');
    expect(c.instantThirst()).toBe(50);
  });

  it('glock_19 + glockmag + 9mm: default ammo, reload, fire', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const gun = createItem(data, 'glock_19');
    c.inv.wield(gun, null);
    c.inv.giveNew(createItem(data, 'glockmag', { ammo: 'default' }));
    const r = c.inv.reload();
    expect(r.ok).toBe(true);
    // item_reload_cost: min(200, 250 ml / 20) + reload 100 / (1 + 0)
    expect(r.moves).toBe(112);
    expect(gun.ammoRemaining()).toBe(15);
    expect(gun.name()).toBe('Glock 19 (15/15)');
    const shot = fireGun(c, gun, new Rng(1));
    expect(shot.ok).toBe(true);
    expect(shot.damage[0]).toMatchObject({ type: 'bullet', amount: 30 });
    expect(shot.noise.sound).toBe('blam!');
    expect(gun.ammoRemaining()).toBe(14);
  });

  it('BN effect_type rules: adrenaline hides pain and wears off into its comedown (effects_on_remove)', () => {
    const { c } = survivor();
    c.pain = 30;
    c.addEffect('adrenaline', 60);
    expect(c.perceivedPain()).toBe(0);
    for (let i = 0; i < 61; i++) c.update(1);
    expect(c.hasEffect('adrenaline')).toBe(false);
    expect(c.hasEffect('adrenaline_comedown')).toBe(true);
    expect(c.perceivedPain()).toBeGreaterThan(0);
  });

  it('bandages stop bleeding (heal_actor bleed 0.9); aspirin is a painkiller', () => {
    const { c } = survivor();
    c.addEffect('bleed', 600, { bp: 'leg_r' });
    c.applyDamage('leg_r', 10);
    const r = c.inv.use(createItem(data, 'bandages'), undefined, 0, null);
    expect(r.msg).toContain('You stop the bleeding.');
    expect(r.moves).toBe(300);
    expect(c.hasEffect('bleed')).toBe(false);
    // bandages_power 4 + 0.25 x first aid 0 -> intensity 4 (6 h each)
    expect(c.effects.get('bandaged', 'leg_r')!.intensity).toBe(4);
    c.pain = 10;
    c.inv.consume(createItem(data, 'aspirin'), null);
    for (let i = 0; i < 240; i++) c.update(1);
    expect(c.painkiller).toBeGreaterThan(0);
  });

  it('flashlight spawns with its default battery and turns on', () => {
    const { c } = survivor();
    const fl = createItem(data, 'flashlight', { ammo: 'default' });
    expect(fl.magazineCurrent()?.typeId).toBe('light_disposable_cell');
    expect(fl.ammoRemaining()).toBe(300);
    expect(c.inv.use(fl, undefined, 0, null).msg).toBe('You turn the flashlight on.');
    expect(fl.typeId).toBe('flashlight_on');
    expect(fl.active).toBe(true);
  });

  it('real traits and damage adjectives', () => {
    const { c } = survivor();
    c.addTrait('TOUGH'); // BN hp_modifier 0.2: trunc(84 x 1.2)
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

describe('filling containers (fromSpawned)', () => {
  it('a bag full of loot keeps every item and stays fast', () => {
    const spec = { id: 'bag_canvas', count: 1, contents: [{ id: 'rock', count: 200 }, { id: 'nail', count: 1, charges: 500 }, { id: 'box_small', count: 3 }] };
    const t0 = performance.now();
    const [bag] = fromSpawned(data, spec as never);
    const ms = performance.now() - t0;
    const n = (id: string) => bag.contents.filter((x) => x.typeId === id).reduce((k, x) => k + x.count(), 0);
    expect(n('rock')).toBe(200);
    expect(n('nail')).toBe(500);
    expect(n('box_small')).toBe(3);
    expect(ms).toBeLessThan(200);
  });
});

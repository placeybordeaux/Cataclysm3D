import { describe, expect, it } from 'vitest';
import { ammoRoom, containerRefusal, containerRoomFor, createItem, fromSpawned, holsterRefusal, hourlyRotpoints, inNewContainer, Item, loadAmmo } from '../src/game/item';
import { makeData } from './fixtures/gamedata';

// The BN item model (item.cpp): stacks, containers holding one load, magazines and integral
// magazines, holsters, bandoliers, soft items growing with contents, serialization.

const data = makeData();

describe('item basics', () => {
  it('attack_cost = 65 + volume/62.5ml + weight/60g, per unit of a stack', () => {
    // BN pipe: 500 ml, 1250 g, stackable
    expect(createItem(data, 'pipe').attackTime()).toBe(Math.floor(65 + 500 / 62.5 + 1250 / 60));
  });

  it('melee skill follows the largest damage type', () => {
    expect(createItem(data, 'crowbar').meleeSkill()).toBe('bashing');
    expect(createItem(data, 'knife_combat').meleeSkill()).toBe('stabbing');
  });

  it('damage levels reduce melee damage by 10% per level above 1 and name the item', () => {
    const c = createItem(data, 'crowbar');
    const full = c.meleeDamage('bash');
    c.damage = 1000; // level 2
    expect(c.damageLevel()).toBe(2);
    expect(c.meleeDamage('bash')).toBeCloseTo(full * 0.9);
    expect(c.name()).toBe('damaged crowbar');
    c.damage = -500;
    expect(c.name()).toBe('reinforced crowbar');
  });
});

describe('charges and stacks (count_by_charges)', () => {
  it('ammo: weight per round, volume per stack_size rounded up', () => {
    const a = createItem(data, '9mm');
    expect(a.countByCharges).toBe(true);
    expect(a.charges).toBe(50);
    expect(a.weight()).toBe(7 * 50);
    expect(a.volume()).toBe(250);
    a.charges = 1;
    expect(a.volume()).toBe(5); // ceil(250 * 1 / 50)
    expect(createItem(data, '9mm', { count: 51 }).volume()).toBe(255);
    expect(createItem(data, '9mm', { count: 7 }).name()).toBe('9x19mm JHP (7)');
  });

  it('all comestibles count by charges in BN (a can of beans is 2 portions)', () => {
    const beans = createItem(data, 'can_beans');
    expect(beans.countByCharges).toBe(true);
    expect(beans.charges).toBe(2);
    expect(beans.volume()).toBe(500);
  });

  it('stacksWith compares type and state, never contents', () => {
    const a = createItem(data, '9mm', { count: 30 }), b = createItem(data, '9mm', { count: 10 });
    expect(a.stacksWith(b)).toBe(true);
    b.damage = 1000;
    expect(a.stacksWith(b)).toBe(false);
    expect(a.stacksWith(a)).toBe(false);
    const g1 = createItem(data, 'glock_19'), g2 = createItem(data, 'glock_19');
    expect(g1.stacksWith(g2)).toBe(true);
    loadAmmo(g2, '9mm', 3);
    expect(g1.stacksWith(g2)).toBe(false);
  });

  it('a non-stack refuses a count', () => {
    expect(() => createItem(data, 'crowbar', { count: 3 })).toThrow(/separate items/);
  });
});

describe('containers hold one load (item::get_remaining_capacity_for_liquid)', () => {
  it('a plastic bottle holds 500 ml = 2 charges of water; rigid, so its volume stays the same', () => {
    const { container: bottle, rest } = inNewContainer(data, createItem(data, 'water_clean', { charges: 3 }), 'bottle_plastic');
    expect(rest!.charges).toBe(1);
    expect(bottle.contents.map((c) => c.charges)).toEqual([2]);
    expect(bottle.volume()).toBe(500);
    expect(bottle.weight()).toBe(13 + 2 * 250);
    expect(bottle.name()).toBe('clean water (plastic bottle) (2/2)');
  });

  it("you can't mix loads; liquids need a watertight container", () => {
    const bottle = inNewContainer(data, createItem(data, 'water_clean', { charges: 1 }), 'bottle_plastic').container;
    expect(containerRoomFor(bottle, createItem(data, 'water_clean', { charges: 5 }))).toBe(1);
    expect(containerRefusal(bottle, createItem(data, 'water', { charges: 1 }))).toBe("You can't mix loads in your plastic bottle.");
    const bag = createItem(data, 'bag_plastic');
    expect(containerRefusal(bag, createItem(data, 'water_clean'))).toBe("That plastic bag isn't water-tight.");
    expect(containerRoomFor(bag, createItem(data, '9mm'))).toBe(1200); // 6 L of 9mm at 50 per 250 ml
  });

  it('a soft bag grows by what it holds (item::volume for non-rigid items)', () => {
    const bag = createItem(data, 'bag_plastic');
    const empty = bag.volume();
    const { container } = inNewContainer(data, createItem(data, '9mm', { count: 100 }), 'bag_plastic');
    expect(container.volume()).toBe(empty + 500);
  });

  it('BN classification: sealed bottle, bucket, can that unseals', () => {
    expect(createItem(data, 'bottle_plastic').isWatertight()).toBe(true);
    expect(createItem(data, 'bucket').isBucket()).toBe(true);
    expect(createItem(data, 'pot').isBucket()).toBe(true);
    const can = createItem(data, 'can_medium');
    expect(can.isBucket()).toBe(false);
    expect(can.def.container_data?.unseals_into).toBe('can_medium_unsealed');
  });

  it('food in a container that preserves does not rot', () => {
    const can = fromSpawned(data, { id: 'can_medium', count: 1, contents: [{ id: 'can_beans', count: 1 }] })[0];
    const loose = createItem(data, 'can_beans');
    can.processRot(86400, 30);
    loose.processRot(86400, 30);
    expect(can.contents[0].rot).toBe(0);
    expect(loose.rot).toBeGreaterThan(0);
  });
});

describe('guns, magazines and ammo', () => {
  it('a magazine-fed gun: the magazine sits in the magazine slot; the well hides part of its volume', () => {
    const gun = createItem(data, 'glock_19', { ammo: 'default' });
    expect(gun.magazine?.typeId).toBe('glockmag');
    expect(gun.ammoRemaining()).toBe(15);
    expect(gun.ammoCapacity()).toBe(15);
    expect(gun.ammoData()?.id).toBe('9mm');
    // glockmag 250 ml fits the 250 ml well entirely
    expect(gun.volume()).toBe(500);
    expect(gun.weight()).toBe(600 + 105 + 15 * 7);
    expect(gun.name()).toBe('Glock 19 (15/15)');
    expect(gun.acceptsMagazine(createItem(data, 'glockbigmag'))).toBe(true);
    expect(gun.acceptsMagazine(createItem(data, 'light_battery_cell'))).toBe(false);
    expect(gun.ammoConsume(4)).toBe(4);
    expect(gun.ammoRemaining()).toBe(11);
  });

  it('an integral magazine keeps rounds as charges of one ammo type (BN curammo)', () => {
    const gun = createItem(data, 'sw_619');
    expect(gun.hasIntegralMagazine()).toBe(true);
    // a speedloader is not a magazine for the slot: it refills the cylinder
    expect(gun.takesMagazines()).toBe(false);
    expect(gun.ammoCapacity()).toBe(7);
    expect(loadAmmo(gun, '38_special', 10)).toBe(7);
    expect(gun.charges).toBe(7);
    expect(gun.ammoId).toBe('38_special');
    expect(gun.weight()).toBe(1074 + 7 * 8);
    const r = ammoRoom(gun, createItem(data, '357mag_fmj'));
    expect(r.room).toBe(0);
  });

  it('shotgun tube: loose shells count toward its capacity', () => {
    const gun = createItem(data, 'remington_870');
    expect(gun.hasIntegralMagazine()).toBe(true);
    expect(ammoRoom(gun, createItem(data, 'shot_00')).room).toBe(5);
    expect(ammoRoom(gun, createItem(data, '9mm')).why).toMatch(/can't load/);
  });

  it('a bandolier holds rounds of the listed types', () => {
    const b = createItem(data, 'bandolier_pistol');
    expect(ammoRoom(b, createItem(data, '9mm')).room).toBe(40);
    expect(ammoRoom(b, createItem(data, 'shot_00')).room).toBe(0);
  });

  it('holsters take what holster_actor::can_holster allows', () => {
    const h = createItem(data, 'holster');
    expect(holsterRefusal(h, createItem(data, 'glock_19'))).toBeNull();
    expect(holsterRefusal(h, createItem(data, 'remington_870'))).toMatch(/too big/);
    expect(holsterRefusal(createItem(data, 'sheath'), createItem(data, 'knife_combat'))).toBeNull();
    expect(holsterRefusal(createItem(data, 'sheath'), createItem(data, 'crowbar'))).toMatch(/can't put/);
    // survivor_pack's min_volume arrives as "250ml" in the data: still read as ml
    expect(holsterRefusal(createItem(data, 'survivor_pack'), createItem(data, 'knife_combat'))).toBeNull();
  });
});

describe('item groups (fromSpawned)', () => {
  it('stacks become one item; others one item each; contents go inside; magazines into the slot', () => {
    expect(fromSpawned(data, { id: '9mm', count: 3, charges: 10 }).map((i) => i.charges)).toEqual([30]);
    expect(fromSpawned(data, { id: 'crowbar', count: 2 })).toHaveLength(2);
    const [gun] = fromSpawned(data, { id: 'glock_19', count: 1, contents: [{ id: 'glockmag', count: 1, charges: 9, ammo: '9mm' }] });
    expect(gun.magazine?.ammoRemaining()).toBe(9);
    const [box] = fromSpawned(data, { id: 'bottle_plastic', count: 1, contents: [{ id: 'water_clean', count: 1, charges: 2 }] });
    expect(box.contents[0].charges).toBe(2);
    expect(fromSpawned(data, { id: 'nope', count: 1 })).toEqual([]);
  });

  it('custom flags, damage and active carry over', () => {
    const [j] = fromSpawned(data, { id: 'jeans', count: 1, flags: ['FIT'], damage: 2000 });
    expect(j.hasFlag('FIT')).toBe(true);
    expect(j.damage).toBe(2000);
  });
});

describe('serialization', () => {
  it('round-trips charges, ammo, contents, magazine and flags', () => {
    const gun = createItem(data, 'glock_19', { ammo: '9mm', ammoCount: 12 });
    const rev = createItem(data, 'sw_619');
    loadAmmo(rev, '38_special', 5);
    const bottle = inNewContainer(data, createItem(data, 'water_clean', { charges: 2 }), 'bottle_plastic').container;
    const j = fromSpawned(data, { id: 'jeans', count: 1, flags: ['FIT'] })[0];
    for (const it of [gun, rev, bottle, j]) {
      const back = Item.fromJSON(data, JSON.parse(JSON.stringify(it.toJSON())));
      expect(back.toJSON()).toEqual(it.toJSON());
      expect(back.name()).toBe(it.name());
      expect(back.weight()).toBe(it.weight());
    }
  });

  it('rejects DDA pockets (they are migrated by src/save/items.ts first)', () => {
    expect(() => Item.fromJSON(data, { typeId: 'backpack', pockets: [[]] })).toThrow(/migrate/);
  });
});

describe('rot', () => {
  it('rot points: none below freezing, 3600/h at 65F', () => {
    expect(hourlyRotpoints(-5)).toBe(0);
    expect(hourlyRotpoints((65 - 32) / 1.8)).toBeCloseTo(3600);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createItem, fromSpawned, hourlyRotpoints, Item, toHitFromAccuracy } from '../src/game/item';
import { makeData } from './fixtures/gamedata';

const data = makeData();

describe('item basics', () => {
  it('to_hit from melee_accuracy sums to base -7 offsets (item_factory.cpp melee_accuracy)', () => {
    expect(toHitFromAccuracy({ grip: 'solid', length: 'short', surface: 'any', balance: 'neutral' })).toBe(0); // pipe
    expect(toHitFromAccuracy({ grip: 'weapon', length: 'hand', surface: 'point', balance: 'good' })).toBe(-1); // bayonet
    expect(toHitFromAccuracy({ grip: 'solid', length: 'hand', surface: 'line', balance: 'neutral' })).toBe(-2); // glock
    expect(toHitFromAccuracy({})).toBe(-7 + 3 + 0 + 2 + 2);
    expect(createItem(data, 'pipe').toHit()).toBe(0);
  });

  it('attack_time = 65 + volume/62.5ml + weight/60g (item_gun_tool_ammo.cpp)', () => {
    // pipe: 370 ml, 600 g -> 65 + 5.92 + 10
    expect(createItem(data, 'pipe').attackTime()).toBe(80);
  });

  it('melee skill follows the largest damage type', () => {
    expect(createItem(data, 'pipe').meleeSkill()).toBe('bashing');
    expect(createItem(data, 'knife_combat').meleeSkill()).toBe('stabbing');
  });

  it('damage levels reduce melee damage by 10% per level above 1 (item_degrade.cpp)', () => {
    const p = createItem(data, 'pipe');
    expect(p.damageLevel()).toBe(0);
    p.damage = 1000; // 1 + 4*1000/4000 = 2
    expect(p.damageLevel()).toBe(2);
    expect(p.meleeDamage('bash')).toBeCloseTo(9);
    expect(p.name()).toBe('damaged pipe');
    p.damage = -500;
    expect(p.name()).toBe('reinforced pipe');
  });

  it('qualities', () => {
    const c = createItem(data, 'crowbar');
    expect(c.qualityLevel('PRY')).toBe(3);
    expect(c.qualityLevel('CUT')).toBe(0);
  });
});

describe('charges and stacks', () => {
  it('ammo is count-by-charges: weight per round, volume per stack_size', () => {
    const a = createItem(data, '9mm');
    expect(a.countByCharges).toBe(true);
    expect(a.charges).toBe(50);
    expect(a.weight()).toBe(600);
    expect(a.volume()).toBe(115);
    expect(a.name()).toBe('9x19mm JHP (50)');
  });

  it('split/merge/stacksWith', () => {
    const a = createItem(data, '9mm', { count: 30 });
    const b = a.split(10);
    expect(a.charges).toBe(20);
    expect(b.charges).toBe(10);
    expect(a.stacksWith(b)).toBe(true);
    expect(a.merge(b)).toBe(true);
    expect(a.charges).toBe(30);
    expect(() => createItem(data, 'pipe', { count: 3 })).toThrow(/separate items/);
    const p1 = createItem(data, 'pipe'), p2 = createItem(data, 'pipe');
    expect(p1.stacksWith(p2)).toBe(true);
    p2.damage = 1000;
    expect(p1.stacksWith(p2)).toBe(false);
  });
});

describe('pockets', () => {
  it('a plastic bottle holds 500 ml = 2 charges of water; rigid bottle volume stays 510 ml', () => {
    const bottle = createItem(data, 'bottle_plastic');
    const water = createItem(data, 'water_clean', { charges: 3 });
    const left = bottle.put(water);
    expect(left).not.toBeNull();
    expect(left!.charges).toBe(1);
    const inside = bottle.allContents();
    expect(inside).toHaveLength(1);
    expect(inside[0].charges).toBe(2);
    expect(bottle.volume()).toBe(510);
    expect(bottle.weight()).toBe(13 + 500);
    expect(bottle.name()).toBe('plastic bottle > clean water (2)');
  });

  it('liquids need watertight pockets and do not mix with solids', () => {
    const jeans = createItem(data, 'jeans');
    expect(jeans.canContain(createItem(data, 'water_clean')).ok).toBe(false);
    const bottle = createItem(data, 'bottle_plastic');
    // a 9mm round (2.3 ml) passes the 17 ml opening, but then water can't join it
    bottle.put(createItem(data, '9mm', { count: 1 }));
    expect(bottle.canContain(createItem(data, 'water_clean')).ok).toBe(false);
    // opening size: max_item_volume 17 ml rejects a can of beans
    expect(createItem(data, 'bottle_plastic').canContain(createItem(data, 'can_beans')).reason).toBe('item too big for opening');
  });

  it('non-rigid containers grow with contents; length limits apply', () => {
    const bp = createItem(data, 'backpack');
    bp.put(createItem(data, 'can_beans'));
    expect(bp.volume()).toBe(2000 + 250);
    const jeans = createItem(data, 'jeans');
    expect(jeans.canContain(createItem(data, 'pipe')).reason).toBe('item too long'); // 60 cm > 19 cm
  });

  it('magazines only take their ammo type up to the restriction', () => {
    const mag = createItem(data, 'glockmag');
    const ammo = createItem(data, '9mm', { count: 20 });
    const left = mag.magazinePockets()[0].insert(ammo);
    expect(left?.charges).toBe(5);
    expect(mag.ammoRemaining()).toBe(15);
    expect(mag.ammoCapacity()).toBe(15);
    expect(mag.name()).toBe('Glock 9x19mm 15-round magazine (15/15)');
    expect(mag.magazinePockets()[0].canContain(createItem(data, 'battery')).ok).toBe(false);
  });

  it('guns take compatible magazines in the well; loaded gun reports ammo', () => {
    const gun = createItem(data, 'glock_19');
    const mag = createItem(data, 'glockmag', { ammo: '9mm' });
    expect(gun.acceptsMagazine(mag)).toBe(true);
    expect(gun.acceptsMagazine(createItem(data, 'medium_battery_cell'))).toBe(false);
    gun.magazineWell()!.insert(mag);
    expect(gun.ammoRemaining()).toBe(15);
    expect(gun.ammoData()?.id).toBe('9mm');
    expect(gun.name()).toBe('Glock 19 pistol (15/15)');
    expect(gun.ammoConsume(2)).toBe(2);
    expect(gun.ammoRemaining()).toBe(13);
    // 76 ml magazine, 250 ml well: fully inside
    expect(gun.volume()).toBe(386);
  });

  it('gun damage and noise come from the ammo (ranged.cpp gun_noise; item_factory loudness)', () => {
    const gun = createItem(data, 'glock_19');
    gun.magazineWell()!.insert(createItem(data, 'glockmag', { ammo: '9mm' }));
    expect(gun.gunDamage()).toEqual([{ type: 'bullet', amount: 23, armor_penetration: 0 }]);
    // 9mm: range 14*2 + damage 23*2 = 74 -> "bang!"
    expect(gun.gunNoise()).toEqual({ volume: 74, sound: 'bang!' });
  });
});

describe('spawning', () => {
  it('fromSpawned wraps loose liquid in its default container', () => {
    const out = fromSpawned(data, { id: 'water_clean', count: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].typeId).toBe('bottle_plastic');
    expect(out[0].allContents()[0].charges).toBe(1);
  });

  it('fromSpawned makes separate non-stackable items and places contents', () => {
    const out = fromSpawned(data, { id: 'glock_19', count: 2, contents: [{ id: 'glockmag', count: 1 }] });
    expect(out).toHaveLength(2);
    expect(out[0].magazineCurrent()?.typeId).toBe('glockmag');
  });

  it('unknown ids: createItem throws, fromSpawned warns once and skips', () => {
    expect(() => createItem(data, 'nope')).toThrow(/unknown item/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(fromSpawned(data, { id: 'nope_x', count: 1 })).toEqual([]);
    fromSpawned(data, { id: 'nope_x', count: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('rot (item_degrade.cpp calc_hourly_rotpoints_at_temp)', () => {
  it('rot rates', () => {
    expect(hourlyRotpoints(0)).toBe(0);
    expect(hourlyRotpoints((65 - 32) / 1.8)).toBeCloseTo(3600); // 65 F
    expect(hourlyRotpoints((81 - 32) / 1.8)).toBeCloseTo(7200); // doubles every 16 F
  });

  it('canned beans spoil after 2 days at 65 F, not in the freezer', () => {
    const beans = createItem(data, 'can_beans');
    const t65 = (65 - 32) / 1.8;
    beans.processRot(44 * 3600, t65);
    expect(beans.goingBad()).toBe(true);
    expect(beans.name()).toBe('canned beans (old)');
    beans.processRot(5 * 3600, t65);
    expect(beans.rotten()).toBe(true);
    expect(beans.name()).toBe('canned beans (rotten)');
    const frozen = createItem(data, 'can_beans');
    frozen.processRot(10 * 86400, -5);
    expect(frozen.rot).toBe(0);
  });
});

describe('serialization', () => {
  it('round-trips nested contents and state', () => {
    const bp = createItem(data, 'backpack');
    const bottle = createItem(data, 'bottle_plastic');
    bottle.put(createItem(data, 'water_clean', { charges: 2 }));
    bp.put(bottle);
    const gun = createItem(data, 'glock_19', { damage: 1000 });
    gun.magazineWell()!.insert(createItem(data, 'glockmag', { ammo: '9mm' }));
    bp.put(gun);
    const j = JSON.parse(JSON.stringify(bp.toJSON()));
    const back = Item.fromJSON(data, j);
    expect(back.toJSON()).toEqual(bp.toJSON());
    expect(back.weight()).toBe(bp.weight());
    const g2 = back.allContents().find((i) => i.typeId === 'glock_19')!;
    expect(g2.ammoRemaining()).toBe(15);
    expect(g2.damage).toBe(1000);
  });
});

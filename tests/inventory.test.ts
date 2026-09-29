import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import { createItem } from '../src/game/item';
import { makeData } from './fixtures/gamedata';

const data = makeData();

function survivor(): { c: Character; log: string[] } {
  const c = new Character(data, { seed: 5 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  return { c, log };
}

describe('carrying', () => {
  it('weight capacity = 13 kg + 4 kg * str (Character::weight_capacity); STRONGBACK +35%', () => {
    const { c } = survivor();
    expect(c.inv.weightCapacity()).toBe(45000);
    c.addTrait('STRONGBACK');
    expect(c.inv.weightCapacity()).toBeCloseTo(60750);
  });

  it('wearing a backpack gives pocket capacity; pick up goes into it', () => {
    const { c, log } = survivor();
    expect(c.inv.volumeCapacity()).toBe(0);
    const beans = createItem(data, 'can_beans');
    // no pockets: the first thing picked up goes to your hands
    expect(c.inv.pickUp(beans).msg).toBe('You wield your canned beans.');
    expect(c.inv.pickUp(createItem(data, 'can_beans')).msg).toBe("There's no room in your inventory for the canned beans.");
    const r = c.inv.wear(createItem(data, 'backpack'));
    expect(r.ok).toBe(true);
    expect(log).toContain('You put on your backpack.');
    expect(c.inv.volumeCapacity()).toBe(25510);
    const r2 = c.inv.pickUp(createItem(data, 'can_beans'));
    expect(r2.ok).toBe(true);
    expect(r2.msg).toBe('You pick up: canned beans');
    expect(c.inv.carried().map((i) => i.typeId)).toEqual(['can_beans']);
    expect(c.inv.weightCarried()).toBe(633 + 256 * 2);
  });

  it("you can't wear two backpacks, or three pairs of jeans", () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    const r = c.inv.wear(createItem(data, 'backpack'));
    expect(r.ok).toBe(false);
    expect(r.msg).toBe('backpack conflicts with backpack!');
    expect(c.inv.wear(createItem(data, 'jeans')).ok).toBe(true);
    expect(c.inv.wear(createItem(data, 'jeans')).ok).toBe(true);
    expect(c.inv.wear(createItem(data, 'jeans')).msg).toBe("Can't wear 2 or more jeans at once.");
    expect(c.inv.wear(createItem(data, 'pipe')).msg).toBe('Putting on a pipe would be tricky.');
  });

  it('encumbrance: per-part values, fill-dependent storage, CDDA layering penalty', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'hoodie')); // OUTER, torso 6
    c.inv.wear(createItem(data, 'backpack')); // BELTED, torso 2..25
    expect(c.inv.encumbrance('torso')).toBe(8);
    expect(c.inv.encumbrance('arm_l')).toBe(6);
    // fill the main 25 L pocket halfway: 2 + 23 * ~0.5
    for (let i = 0; i < 50; i++) c.inv.pickUp(createItem(data, 'can_beans'));
    expect(c.inv.encumbrance('torso')).toBeGreaterThan(18);
    const { c: d } = survivor();
    d.inv.wear(createItem(data, 'hoodie'));
    d.inv.wear(createItem(data, 'jacket_leather')); // both OUTER on torso: 6 + 8, + min(6,8)=6 penalty
    expect(d.inv.encumbrance('torso')).toBe(6 + 8 + 6);
    expect(d.inv.encumbrance('arm_r')).toBe(6 + 12 + 6);
  });

  it('take off, drop and wield', () => {
    const { c, log } = survivor();
    const bp = createItem(data, 'backpack');
    c.inv.wear(bp);
    c.inv.wear(createItem(data, 'jeans'));
    const pipe = createItem(data, 'pipe');
    // 60 cm pipe doesn't fit the 40 cm backpack pocket: picked up into your hands
    expect(c.inv.pickUp(pipe).msg).toBe('You wield your pipe.');
    expect(c.inv.wielded).toBe(pipe);
    const knife = createItem(data, 'knife_combat');
    const w = c.inv.wield(knife); // the pipe can't be stored, so it is dropped
    expect(w.dropped).toEqual([pipe]);
    c.inv.wield(createItem(data, 'crowbar')); // the knife goes into the backpack
    expect(c.inv.carried()).toContain(knife);
    c.inv.pickUp(pipe);
    const d = c.inv.drop(knife);
    expect(d.dropped).toEqual([knife]);
    expect(log).toContain('You drop your National Guard bayonet.');
    const t = c.inv.takeOff(bp);
    expect(t.ok).toBe(true);
    expect(log).toContain('You take off your backpack.');
    // backpack doesn't fit in jeans pockets and hands are full: it is dropped
    expect(t.dropped).toEqual([bp]);
  });

  it('warmth sums covering clothes', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'hoodie'));
    c.inv.wear(createItem(data, 'jacket_leather'));
    expect(c.inv.warmth('torso')).toBe(45);
    expect(c.inv.warmth('leg_l')).toBe(0);
  });
});

describe('eating and drinking from containers', () => {
  it('drinking from a bottle takes one 250 ml portion and leaves the bottle', () => {
    const { c, log } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    const bottle = createItem(data, 'bottle_plastic');
    bottle.put(createItem(data, 'water_clean', { charges: 2 }));
    c.inv.pickUp(bottle);
    c.thirst = 120;
    const r = c.inv.consume(bottle);
    expect(r.ok).toBe(true);
    expect(log).toContain('You drink your clean water.');
    expect(bottle.allContents()[0].charges).toBe(1);
    c.inv.consume(bottle);
    expect(bottle.allContents()).toHaveLength(0);
    expect(c.inv.carried()).toContain(bottle);
    expect(c.instantThirst()).toBe(20);
    expect(c.inv.consume(bottle).msg).toBe("That doesn't look edible.");
  });

  it('consuming an item from the map reports usedUp so the caller removes it', () => {
    const { c } = survivor();
    const beans = createItem(data, 'can_beans');
    expect(c.inv.consume(beans).usedUp).toBe(true);
  });
});

describe('tools and qualities', () => {
  it('hasQuality finds tools in pockets and hands', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    expect(c.inv.hasQuality('CUT', 1)).toBe(false);
    c.inv.pickUp(createItem(data, 'knife_combat'));
    expect(c.inv.hasQuality('CUT', 1)).toBe(true);
    expect(c.inv.hasQuality('CUT', 3)).toBe(false);
    c.inv.wield(createItem(data, 'crowbar'));
    expect(c.inv.maxQuality('PRY')).toBe(3);
    expect(c.inv.findByQuality('HAMMER', 1).map((i) => i.typeId)).toEqual(['crowbar']);
  });

  it('countOf/useAmount split stacks', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    c.inv.pickUp(createItem(data, '9mm', { count: 50 }));
    expect(c.inv.countOf('9mm')).toBe(50);
    const used = c.inv.useAmount('9mm', 20);
    expect(used[0].charges).toBe(20);
    expect(c.inv.countOf('9mm')).toBe(30);
    expect(() => c.inv.useAmount('9mm', 31)).toThrow();
  });

  it('flashlight: transform on with batteries, drains 1 kJ per 1000/1.56 s, reverts when empty', () => {
    const { c, log } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    const fl = createItem(data, 'flashlight');
    c.inv.pickUp(fl);
    expect(c.inv.use(fl).msg).toBe('The batteries are dead.');
    const cell = createItem(data, 'medium_battery_cell', { ammo: 'battery', ammoCount: 2 });
    fl.magazineWell()!.insert(cell);
    const r = c.inv.use(fl);
    expect(r.msg).toBe('You turn the flashlight on.');
    expect(fl.typeId).toBe('flashlight_on');
    expect(fl.active).toBe(true);
    expect(fl.ammoRemaining()).toBe(2);
    c.update(700);
    expect(fl.ammoRemaining()).toBe(1);
    c.update(700);
    expect(fl.typeId).toBe('flashlight');
    expect(fl.active).toBe(false);
    expect(log).toContain('Your flashlight (on) runs out of power.');
  });
});

describe('reloading (9mm handgun)', () => {
  it('swaps in a loaded magazine: 150 reload + 3 handling moves at skill 0', () => {
    const { c, log } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    const gun = createItem(data, 'glock_19');
    c.inv.wield(gun);
    expect(c.inv.reload().msg).toBe("You don't have a magazine to reload your Glock 19 pistol!");
    c.inv.pickUp(createItem(data, 'glockmag', { ammo: '9mm' }));
    const r = c.inv.reload();
    expect(r.ok).toBe(true);
    expect(r.moves).toBe(153); // item_reload_cost: min(200, 76ml/20) + 150 / (1 + 0)
    expect(log).toContain('You reload the Glock 19 pistol.');
    expect(gun.ammoRemaining()).toBe(15);
    expect(c.inv.reload().msg).toBe('The Glock 19 pistol is already fully loaded!');
    c.setSkill('pistol', 5);
    gun.ammoConsume(15);
    // empty magazine in the gun + loose rounds -> reload the inserted magazine
    c.inv.pickUp(createItem(data, '9mm', { count: 20 }));
    const r2 = c.inv.reload();
    expect(r2.ok).toBe(true);
    expect(r2.msg).toBe('You reload the Glock 9x19mm 15-round magazine with 9x19mm JHPs.');
    expect(gun.ammoRemaining()).toBe(15);
    expect(c.inv.countOf('9mm')).toBe(15 + 5);
  });

  it('prefers the fullest spare magazine and stashes the old one', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'));
    const gun = createItem(data, 'glock_19');
    const m1 = createItem(data, 'glockmag', { ammo: '9mm', ammoCount: 3 });
    gun.magazineWell()!.insert(m1);
    c.inv.wield(gun);
    const m2 = createItem(data, 'glockmag', { ammo: '9mm', ammoCount: 10 });
    const m3 = createItem(data, 'glockmag', { ammo: '9mm', ammoCount: 15 });
    c.inv.pickUp(m2);
    c.inv.pickUp(m3);
    c.inv.reload();
    expect(gun.magazineCurrent()).toBe(m3);
    expect(c.inv.carried()).toContain(m1);
    expect(c.inv.unload(gun).ok).toBe(true);
    expect(gun.magazineCurrent()).toBeUndefined();
  });
});

describe('armor', () => {
  it('leather jacket absorbs a zombie claw on the arm (resist cut 3 * thickness 1)', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'jacket_leather'));
    const out = c.inv.absorbHit('arm_l', [{ type: 'cut', amount: 8 }, { type: 'bash', amount: 4 }], new Rng(1));
    expect(out).toEqual([{ type: 'cut', amount: 5 }, { type: 'bash', amount: 3 }]);
    // uncovered part: full damage
    expect(c.inv.absorbHit('leg_l', [{ type: 'cut', amount: 8 }], new Rng(1))).toEqual([{ type: 'cut', amount: 8 }]);
  });

  it('portion materials: hard hat plastic x4 thickness', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'hat_hard'));
    expect(c.inv.absorbHit('head', [{ type: 'bash', amount: 10 }], new Rng(2))).toEqual([{ type: 'bash', amount: 2 }]);
  });

  it('armor penetration and crit armor multipliers', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'hat_hard'));
    expect(c.inv.absorbHit('head', [{ type: 'bash', amount: 10, armor_penetration: 4 }], new Rng(2))).toEqual([{ type: 'bash', amount: 6 }]);
    expect(c.inv.absorbHit('head', [{ type: 'bash', amount: 10, armor_multiplier: 0.5 }], new Rng(2))).toEqual([{ type: 'bash', amount: 6 }]);
  });
});

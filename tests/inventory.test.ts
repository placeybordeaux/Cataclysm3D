import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Character } from '../src/game/character';
import { createItem, inNewContainer, loadAmmo } from '../src/game/item';
import { canMove, L, moveItem, spawnItem } from '../src/game/moves';
import { makeData } from './fixtures/gamedata';
import { FakeGround } from './fixtures/ground';

// The BN carrying model (character.cpp, docs/BN_DATA_MODEL.md §4): worn storage pools into
// one carrying volume; the inventory is flat; containers, holsters, bandoliers and magazines
// hold their own things. Every action is a move (src/game/moves.ts).

const data = makeData();

function survivor(): { c: Character; log: string[]; ground: FakeGround } {
  const c = new Character(data, { seed: 5 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  const ground = new FakeGround();
  c.groundLoc = () => L.ground(ground, 0, 0, 0);
  return { c, log, ground };
}
const here = (g: FakeGround) => L.ground(g, 0, 0, 0);
const give = (c: Character, id: string, opts = {}) => {
  const it = createItem(data, id, opts);
  expect(c.inv.giveNew(it)).not.toBeNull();
  return it;
};

describe('carrying capacity (Character::weight_capacity / volume_capacity)', () => {
  it('weight: 13 kg + 4 kg per Str; STRONGBACK +35%', () => {
    const { c } = survivor();
    expect(c.inv.weightCapacity()).toBe(45000);
    c.addTrait('STRONGBACK');
    expect(c.inv.weightCapacity()).toBeCloseTo(60750);
  });

  it('volume: the sum of worn storage; worn and wielded items do not count as carried', () => {
    const { c, log, ground } = survivor();
    expect(c.inv.volumeCapacity()).toBe(0);
    const beans = createItem(data, 'can_beans');
    spawnItem(beans, here(ground));
    // nothing to carry it in: BN pickup puts it in your hands
    expect(c.inv.pickUp(beans, here(ground)).msg).toBe('You wield your canned beans (2).');
    const more = createItem(data, 'can_beans');
    spawnItem(more, here(ground));
    expect(c.inv.pickUp(more, here(ground)).msg).toBe("There's no room in your inventory for the canned beans (2).");
    expect(ground.itemsAt(0, 0, 0)).toEqual([more]);
    const bp = createItem(data, 'backpack');
    expect(c.inv.wear(bp, null).ok).toBe(true);
    expect(log).toContain('You put on your backpack.');
    c.inv.wear(createItem(data, 'jeans'), null);
    expect(c.inv.volumeCapacity()).toBe(15000 + 500);
    const r = c.inv.pickUp(more, here(ground));
    expect(r.ok).toBe(true);
    expect(r.msg).toBe('You pick up: canned beans (2)');
    expect(c.inv.carried()).toEqual([more]);
    expect(c.inv.volumeCarried()).toBe(500);
    expect(c.inv.weightCarried()).toBe(633 + 600 + 256 * 4);
  });

  it('stacks merge in the inventory; a partial pickup splits the stack on the ground', () => {
    const { c, ground } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    give(c, '9mm', { count: 20 });
    const pile = createItem(data, '9mm', { count: 30 });
    spawnItem(pile, here(ground));
    expect(c.inv.pickUp(pile, here(ground), 10).ok).toBe(true);
    expect(pile.charges).toBe(20);
    expect(c.inv.carried().map((i) => i.charges)).toEqual([30]);
  });

  it("clothing rules: two of a kind at most, one pair of shoes, one helmet; a pipe can't be worn", () => {
    const { c } = survivor();
    expect(c.inv.wear(createItem(data, 'backpack'), null).ok).toBe(true);
    expect(c.inv.wear(createItem(data, 'backpack'), null).ok).toBe(true);
    expect(c.inv.wear(createItem(data, 'backpack'), null).msg).toBe("Can't wear 3 or more backpacks at once.");
    expect(c.inv.wear(createItem(data, 'sneakers'), null).ok).toBe(true);
    expect(c.inv.wear(createItem(data, 'sneakers'), null).msg).toBe("You're already wearing footwear!");
    expect(c.inv.wear(createItem(data, 'socks'), null).ok).toBe(true);
    expect(c.inv.wear(createItem(data, 'hat_hard'), null).ok).toBe(true);
    expect(c.inv.wear(createItem(data, 'hat_hard'), null).msg).toBe("You can't wear that with other headgear!");
    expect(c.inv.wear(createItem(data, 'crowbar'), null).msg).toBe('Putting on a crowbar would be tricky.');
  });

  it('encumbrance: a soft backpack grows with the carried volume; BN layering penalty', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null); // torso 3..15, 15 L
    expect(c.inv.encumbrance('torso')).toBe(3);
    give(c, '9mm', { count: 50 * 30 }); // 7.5 L: half full
    expect(c.inv.volumeCarried()).toBe(7500);
    expect(c.inv.encumbrance('torso')).toBe(3 + 6);
    const { c: d } = survivor();
    d.inv.wear(createItem(data, 'hoodie'), null); // OUTER 12
    d.inv.wear(createItem(data, 'jacket_leather'), null); // OUTER 15
    // two items on one layer: all but the most encumbering count again (min 2, max 10 each)
    expect(d.inv.encumbrance('torso')).toBe(12 + 15 + 10);
  });

  it('warmth sums covering clothes', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'hoodie'), null);
    expect(c.inv.warmth('torso')).toBe(30);
    expect(c.inv.warmth('leg_l')).toBe(0);
  });
});

describe('wield, take off, drop', () => {
  it('wielding stows the old weapon, or drops it when there is no room', () => {
    const { c, log, ground } = survivor();
    const bar = give(c, 'crowbar');
    expect(c.inv.wielded).toBe(bar);
    const knife = createItem(data, 'knife_combat');
    spawnItem(knife, here(ground));
    const r = c.inv.wield(knife, here(ground));
    expect(r.ok).toBe(true);
    expect(log).toContain('You drop your crowbar and wield your combat knife.');
    expect(ground.itemsAt(0, 0, 0)).toEqual([bar]);
    c.inv.wear(createItem(data, 'backpack'), null);
    expect(c.inv.wield(bar, here(ground)).ok).toBe(true);
    expect(c.inv.carried()).toEqual([knife]);
    expect(ground.itemsAt(0, 0, 0)).toEqual([]);
  });

  it("taking off a backpack whose room you're using: into your hands, else dropped", () => {
    const { c, ground } = survivor();
    const bp = createItem(data, 'backpack');
    c.inv.wear(bp, null);
    give(c, '9mm', { count: 600 }); // 3 L
    const t = c.inv.takeOff(bp);
    expect(t.ok).toBe(true);
    expect(c.inv.wielded).toBe(bp);
    // the rounds are still carried: over capacity is allowed after the fact (BN), never created by a pick up
    expect(c.inv.carried()[0].charges).toBe(600);
    c.inv.wear(bp);
    c.inv.wield(give(c, 'crowbar'), c.inv.locOf(c.inv.carried().find((i) => i.typeId === 'crowbar')!));
    expect(c.inv.takeOff(bp).msg).toBe('You take off your backpack and drop it.');
    expect(ground.itemsAt(0, 0, 0)).toContain(bp);
  });

  it('drop a part of a stack', () => {
    const { c, ground } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const r = give(c, '9mm', { count: 50 });
    expect(c.inv.drop(r, here(ground), 20).ok).toBe(true);
    expect(r.charges).toBe(30);
    expect((ground.itemsAt(0, 0, 0)[0] as typeof r).charges).toBe(20);
  });

  it("integrated and bionic items can't be dropped or taken off", () => {
    const { c } = survivor();
    const claws = createItem(data, 'glock_19');
    claws.flags.push('INTEGRATED');
    spawnItem(claws, L.hands(c), { force: true });
    expect(c.inv.drop(claws).ok).toBe(false);
  });
});

describe('containers (one load, sealed for liquids when carried)', () => {
  it('drinking from a bottle: one portion at a time; the empty bottle stays', () => {
    const { c, log } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const bottle = inNewContainer(data, createItem(data, 'water_clean', { charges: 2 }), 'bottle_plastic').container;
    c.inv.giveNew(bottle);
    c.thirst = 120;
    expect(c.inv.consume(bottle).ok).toBe(true);
    expect(log).toContain('You drink your clean water.');
    expect(bottle.contents[0].charges).toBe(1);
    c.inv.consume(bottle);
    expect(bottle.contents).toHaveLength(0);
    expect(c.inv.carried()).toContain(bottle);
    expect(c.instantThirst()).toBe(20);
    expect(c.inv.consume(bottle).msg).toBe("That doesn't look edible.");
  });

  it('a can opens (unseals_into) the moment you take something out', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const can = inNewContainer(data, createItem(data, 'can_beans'), 'can_medium').container;
    c.inv.giveNew(can);
    c.inv.consume(can);
    expect(can.typeId).toBe('can_medium_unsealed');
    expect(can.contents[0].charges).toBe(1);
  });

  it('liquid: sealed bottle anywhere; a bucket only on the ground or in hand; never loose in a pack', () => {
    const { c, ground } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const water = createItem(data, 'water_clean', { charges: 40 });
    spawnItem(water, here(ground));
    expect(c.inv.pickUp(water, here(ground)).code).toBe('liquid');
    const bucket = give(c, 'bucket'); // into the inventory (the backpack's room)
    expect(c.inv.carried()).toContain(bucket);
    expect(canMove(water, here(ground), L.in(bucket), { actor: c }).msg).toBe('That bucket must be on the ground or held to hold contents!');
    expect(c.inv.wield(bucket).ok).toBe(true);
    const r = moveItem(water, here(ground), L.in(bucket), { actor: c, partial: true });
    expect(r.ok).toBe(true);
    expect(r.moved).toBe(20); // 5 L
    expect(water.charges).toBe(20);
    // with water in it, the bucket can't go back into the pack
    expect(c.inv.unwield().code).toBe('needs_seal');
    const bottle = give(c, 'bottle_plastic');
    expect(moveItem(water, here(ground), L.in(bottle), { actor: c, partial: true }).moved).toBe(2);
    expect(moveItem(createItem(data, 'water', { charges: 1 }), null, L.in(bottle), { actor: c }).msg).toBe("You can't mix loads in your plastic bottle.");
  });

  it('a soft container you carry can only grow into your free carrying volume', () => {
    const { c, ground } = survivor();
    c.inv.wear(createItem(data, 'jeans'), null); // 500 ml
    const bag = give(c, 'bag_plastic'); // 10 ml
    expect(c.inv.carried()).toEqual([bag]);
    const rounds = createItem(data, '9mm', { count: 500 }); // 2.5 L
    spawnItem(rounds, here(ground));
    const r = moveItem(rounds, here(ground), L.in(bag), { actor: c });
    expect(r.code).toBe('no_room');
    const part = moveItem(rounds, here(ground), L.in(bag), { actor: c, count: 90 });
    expect(part.ok).toBe(true);
    expect(c.inv.volumeCarried()).toBe(10 + 450);
  });
});

describe('holsters and bandoliers hold their own items', () => {
  it("a worn holster's pistol doesn't use carrying volume; drawing costs draw_cost", () => {
    const { c, ground } = survivor();
    const h = createItem(data, 'holster');
    c.inv.wear(h, null);
    const gun = createItem(data, 'glock_19', { ammo: 'default' });
    spawnItem(gun, here(ground));
    const r = moveItem(gun, here(ground), L.in(h), { actor: c });
    expect(r.ok).toBe(true);
    expect(r.msg).toBe('You holster your Glock 19 (15/15).');
    expect(c.inv.volumeCarried()).toBe(0);
    expect(moveItem(createItem(data, 'glock_19'), null, L.in(h), { actor: c }).msg).toBe('Your holster is full.');
    const draw = c.inv.wield(gun);
    expect(draw.ok).toBe(true);
    expect(draw.moves).toBe(100);
  });

  it('a bandolier takes rounds of its types, up to capacity', () => {
    const { c } = survivor();
    const b = createItem(data, 'bandolier_pistol');
    c.inv.wear(b, null);
    c.inv.wear(createItem(data, 'backpack'), null);
    const rounds = give(c, '9mm', { count: 50 });
    const r = moveItem(rounds, L.inv(c), L.in(b), { actor: c, partial: true });
    expect(r.moved).toBe(40);
    expect(rounds.charges).toBe(10);
    expect(b.ammoRemaining()).toBe(40);
    expect(c.inv.reload(b).msg).toBe('The pistol bandolier is already fully loaded!');
  });
});

describe('tools and qualities', () => {
  it('countOf / useAmount take from the inventory and wielded item, not worn clothes', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    give(c, '9mm', { count: 50 });
    expect(c.inv.countOf('9mm')).toBe(50);
    const used = c.inv.useAmount('9mm', 20);
    expect(used[0].charges).toBe(20);
    expect(c.inv.countOf('9mm')).toBe(30);
    expect(c.inv.countOf('backpack')).toBe(0);
    expect(() => c.inv.useAmount('9mm', 31)).toThrow();
  });

  it('flashlight: needs a charged battery; drains power_draw, reverts when empty', () => {
    const { c, log } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const fl = give(c, 'flashlight');
    // src/game/reloadhelp.ts: what it takes, not just "dead" (no item groups in the fixture: no "most common")
    expect(c.inv.use(fl).msg).toBe("The flashlight's batteries are dead. Your flashlight takes a light disposable battery or a light battery. You have none.");
    const cell = createItem(data, 'light_battery_cell', { ammo: 'battery', ammoCount: 2 });
    expect(spawnItem(cell, L.mag(fl)).ok).toBe(true);
    const r = c.inv.use(fl);
    expect(r.msg).toBe('You turn the flashlight on.');
    expect(fl.typeId).toBe('flashlight_on');
    expect(fl.active).toBe(true);
    expect(fl.ammoRemaining()).toBe(2);
    // BN power_draw 10000 is milliwatts (10 W): one 1 kJ battery charge per 100 game seconds.
    c.update(99);
    expect(fl.ammoRemaining()).toBe(2);
    c.update(1);
    expect(fl.ammoRemaining()).toBe(1);
    c.update(100);
    expect(fl.typeId).toBe('flashlight');
    expect(fl.active).toBe(false);
    expect(log.at(-1)).toMatch(/runs out of power/);
  });
});

describe('reloading and unloading', () => {
  it('swaps in a loaded magazine; the old one goes to the inventory', () => {
    const { c, log } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const gun = createItem(data, 'glock_19');
    c.inv.wield(gun, null);
    expect(c.inv.reload().msg).toMatch(/^Your Glock 19 takes a Glock magazine or a Glock extended magazine \(9x19mm\)\. You have none\./);
    const mag = give(c, 'glockmag', { ammo: '9mm' });
    const r = c.inv.reload();
    expect(r.ok).toBe(true);
    expect(log).toContain('You reload the Glock 19.');
    expect(gun.magazine).toBe(mag);
    expect(gun.ammoRemaining()).toBe(15);
    expect(c.inv.reload().msg).toBe('The Glock 19 is already fully loaded!');
    gun.ammoConsume(15);
    give(c, '9mm', { count: 20 });
    const r2 = c.inv.reload();
    expect(r2.msg).toBe('You reload the Glock magazine with 9x19mm JHPs.');
    expect(gun.ammoRemaining()).toBe(15);
    expect(c.inv.countOf('9mm')).toBe(5); // the rounds in the gun's magazine are not loose ammo
  });

  it('empty gun + empty magazine + loose rounds: one reload fills and inserts the magazine', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const gun = createItem(data, 'glock_19');
    c.inv.wield(gun, null);
    give(c, 'glockmag');
    give(c, '9mm', { count: 20 });
    expect(c.inv.reload().ok).toBe(true);
    expect(gun.ammoRemaining()).toBe(15);
  });

  it('prefers the fullest spare magazine and stows the old one', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const gun = createItem(data, 'glock_19', { ammo: '9mm', ammoCount: 3 });
    const m1 = gun.magazine!;
    c.inv.wield(gun, null);
    give(c, 'glockmag', { ammo: '9mm', ammoCount: 10 });
    const m3 = give(c, 'glockmag', { ammo: '9mm', ammoCount: 15 });
    c.inv.reload();
    expect(gun.magazine).toBe(m3);
    expect(c.inv.carried()).toContain(m1);
  });

  it('unload: magazine out of the gun, rounds out of the magazine, rounds out of a revolver', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const gun = give(c, 'glock_19', { ammo: '9mm', ammoCount: 12 });
    const mag = gun.magazine!;
    expect(c.inv.unload(gun).ok).toBe(true);
    expect(gun.magazine).toBeNull();
    expect(c.inv.carried()).toContain(mag);
    expect(c.inv.unload(mag).ok).toBe(true);
    expect(mag.ammoRemaining()).toBe(0);
    expect(c.inv.countOf('9mm')).toBe(12);
    const rev = give(c, 'sw_619');
    loadAmmo(rev, '38_special', 6);
    expect(c.inv.unload(rev).ok).toBe(true);
    expect(rev.charges).toBe(0);
    expect(c.inv.countOf('38_special')).toBe(6);
    expect(c.inv.unload(rev).msg).toBe("Your S&W 619 isn't loaded.");
  });

  it('a revolver loads loose rounds into its cylinder', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const rev = createItem(data, 'sw_619');
    c.inv.wield(rev, null);
    give(c, '38_special', { count: 10 });
    expect(c.inv.reload().ok).toBe(true);
    expect(rev.ammoRemaining()).toBe(7);
    expect(c.inv.countOf('38_special')).toBe(3);
  });
});

describe('armor', () => {
  it('leather jacket absorbs a zombie claw on the arm (fixture leather cut 3 x thickness 3)', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'jacket_leather'), null);
    const out = c.inv.absorbHit('arm_l', [{ type: 'cut', amount: 12 }, { type: 'bash', amount: 4 }], new Rng(1));
    expect(out).toEqual([{ type: 'cut', amount: 3 }, { type: 'bash', amount: 1 }]);
    expect(c.inv.absorbHit('leg_l', [{ type: 'cut', amount: 8 }], new Rng(1))).toEqual([{ type: 'cut', amount: 8 }]);
  });

  it('armor penetration and crit armor multipliers (hard hat: plastic 2 x thickness 4)', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'hat_hard'), null);
    const hit = (u: object) => {
      for (let seed = 1; seed < 50; seed++) {
        const r = c.inv.absorbHit('head', [{ type: 'bash', amount: 10, ...u }], new Rng(seed));
        if (r[0].amount < 10) return r[0].amount; // the hat's 80% coverage caught it
      }
      return 10;
    };
    expect(hit({})).toBe(2);
    expect(hit({ armor_penetration: 4 })).toBe(6);
    expect(hit({ armor_multiplier: 0.5 })).toBe(6);
  });
});

describe('successful item presentation facts', () => {
  it('reports the consumed portion, suppressing rejected consumption', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const actions: { kind: string; item: { typeId: string }; moves: number }[] = [];
    c.inv.onItemPresentation.push((a) => actions.push(a));
    const bottle = inNewContainer(data, createItem(data, 'water_clean', { charges: 2 }), 'bottle_plastic').container;
    c.inv.giveNew(bottle);
    c.inv.consumeChecks.push(() => 'not now');
    expect(c.inv.consume(bottle).ok).toBe(false);
    expect(actions).toHaveLength(0);
    c.inv.consumeChecks.length = 0;
    const r = c.inv.consume(bottle);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'drink', item: { typeId: 'water_clean' }, moves: r.moves });
    expect(bottle.contents[0].charges).toBe(1);
    const food = give(c, 'chocolate');
    expect(c.inv.consume(food).ok).toBe(true);
    expect(actions[1]).toMatchObject({ kind: 'eat', item: { typeId: 'chocolate' } });
  });
  it('reports successful use with pre-transform identity, but no-power failures stay silent', () => {
    const { c } = survivor();
    c.inv.wear(createItem(data, 'backpack'), null);
    const actions: { kind: string; item: { typeId: string } }[] = [];
    c.inv.onItemPresentation.push((a) => actions.push(a));
    const fl = give(c, 'flashlight');
    expect(c.inv.use(fl).ok).toBe(false);
    expect(actions).toHaveLength(0);
    spawnItem(createItem(data, 'light_battery_cell', { ammo: 'battery', ammoCount: 2 }), L.mag(fl));
    expect(c.inv.use(fl).ok).toBe(true);
    expect(fl.typeId).toBe('flashlight_on');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'use', item: { typeId: 'flashlight' } });
  });
});

describe('deferred tool presentation', () => {
  it('use() skips its own immediate gesture when a handler marks the result deferred, leaving the completion fact to the handler itself', () => {
    const { c } = survivor();
    const tool = createItem(data, 'lighter');
    const seen: unknown[] = [];
    c.inv.onItemPresentation.push((a) => seen.push(a));
    // A menu/activity-based handler (firestarter, axe/shovel/rod uses, bionic self-install):
    // ok:true only means "accepted", so use() must not fire its own gesture for it.
    c.inv.useHandlers.set('firestarter', () => ({ ok: true, msg: '', moves: 0, deferred: true }));
    expect(c.inv.use(tool, undefined, 1, null).ok).toBe(true);
    expect(seen).toHaveLength(0);
    // The handler fires it itself, from the action's own completion fact (fire.ts, nature.ts,
    // mutbio_ui.ts), never from use() guessing at open time — see those modules' tests.
    c.inv.presentDeferredUse({ typeId: tool.typeId, def: tool.def, isGun: () => false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'use', item: { typeId: 'lighter' } });
  });
 });

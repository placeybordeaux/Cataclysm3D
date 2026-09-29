import { describe, expect, it } from 'vitest';
import { Character } from '../src/game/character';
import { createItem, inNewContainer } from '../src/game/item';
import { findItemLoc, inventoryView, itemActions, itemKey, locKey, resolveLocKey, verdict, type InventoryScope } from '../src/game/inventory_view';
import { census, L, spawnItem } from '../src/game/moves';
import { makeData } from './fixtures/gamedata';
import { FakeGround } from './fixtures/ground';

const data = makeData();

function scope(): InventoryScope & { map: FakeGround } {
  const who = new Character(data, { seed: 4 });
  const map = new FakeGround();
  map.furn.set('1,0,0', { id: 'f_locker', name: 'locker', max_volume: 2000 });
  who.groundLoc = () => L.ground(map, 0, 0, 0);
  const trunk = { items: [], def: { name: 'trunk', size: 10000 } };
  return { who, map, at: { x: 0, y: 0, z: 0 }, cargo: [{ part: trunk, label: "Sedan's trunk" }] };
}

describe('inventoryView', () => {
  it('hands, clothes by body part with storage, carried groups, containers with fill, nearby places', () => {
    const s = scope();
    const c = s.who;
    c.inv.wear(createItem(data, 'backpack'), null);
    c.inv.wear(createItem(data, 'jeans'), null);
    const holster = createItem(data, 'holster');
    c.inv.wear(holster, null);
    spawnItem(createItem(data, 'glock_19', { ammo: 'default' }), L.in(holster));
    c.inv.wield(createItem(data, 'crowbar'), null);
    const bottle = inNewContainer(data, createItem(data, 'water_clean', { charges: 1 }), 'bottle_plastic').container;
    c.inv.giveNew(bottle);
    c.inv.giveNew(createItem(data, '9mm', { count: 50 }));
    spawnItem(createItem(data, 'rock', { count: 3 }), L.ground(s.map, 0, 0, 0));
    spawnItem(createItem(data, 'can_beans'), L.ground(s.map, 1, 0, 0));
    const v = inventoryView(s);
    expect(v.hands.item?.typeId).toBe('crowbar');
    expect(v.hands.item?.badges).toContain('W');
    expect(v.worn.map((w) => w.node.typeId)).toEqual(['jeans', 'holster', 'backpack']);
    expect(v.worn.find((w) => w.node.typeId === 'backpack')!.storage).toEqual({ capacity: 15000, used: Math.round((15000 * 750) / 15500) });
    const holsterNode = v.worn.find((w) => w.node.typeId === 'holster')!.node;
    expect(holsterNode.inside?.fill).toEqual({ used: 1, max: 1, unit: 'items' });
    expect(holsterNode.inside?.items[0].magazine?.item?.charges).toEqual({ cur: 15, max: 15, label: '9x19mm JHP' });
    expect(v.bodyParts.find((b) => b.id === 'leg_l')!.worn.map((n) => n.typeId)).toEqual(['jeans', 'holster']);
    const bottleNode = v.carried.groups.flatMap((g) => g.items).find((n) => n.typeId === 'bottle_plastic')!;
    expect(bottleNode.inside?.fill).toEqual({ used: 250, max: 500, unit: 'ml' });
    expect(v.totals.volume).toEqual([750, 15500]);
    expect(v.nearby.map((p) => [p.label, p.items.length, p.fill?.max ?? null])).toEqual([['under you', 1, null], ['locker (east)', 1, 2000], ["Sedan's trunk", 0, 10000]]);
  });

  it('string keys round-trip to the same places and items', () => {
    const s = scope();
    const bag = inNewContainer(data, createItem(data, 'rock', { count: 2 }), 'bag_canvas').container;
    spawnItem(bag, L.ground(s.map, 0, 0, 0));
    const inside = L.in(bag);
    const k = locKey(inside, s);
    expect(resolveLocKey(k, s)).toEqual(inside);
    expect(resolveLocKey(locKey(L.ground(s.map, 0, 0, 0), s), s)).toEqual(L.ground(s.map, 0, 0, 0));
    expect(resolveLocKey('cargo:0', s)?.kind).toBe('cargo');
    expect(findItemLoc(itemKey(bag.contents[0]), s)).toEqual({ item: bag.contents[0], loc: inside });
  });
});

describe('verdict: what a drop would do, and why not', () => {
  it('ok / partial / reject / noop with BN reasons', () => {
    const s = scope();
    const c = s.who;
    c.inv.wear(createItem(data, 'jeans'), null); // 500 ml
    const here = L.ground(s.map, 0, 0, 0);
    const rounds = createItem(data, '9mm', { count: 200 }); // 1 L
    spawnItem(rounds, here);
    expect(verdict(c, rounds, here, L.inv(c))).toMatchObject({ kind: 'partial', count: 100, reason: "There's no room in your inventory for the 9x19mm JHP (200)." });
    expect(verdict(c, rounds, here, L.inv(c), 50)).toMatchObject({ kind: 'ok', count: 50 });
    expect(verdict(c, rounds, here, here)).toEqual({ kind: 'noop' });
    const water = createItem(data, 'water_clean', { charges: 2 });
    spawnItem(water, here);
    expect(verdict(c, water, here, L.inv(c))).toMatchObject({ kind: 'reject', code: 'liquid' });
    expect(verdict(c, water, here, L.ground(s.map, 1, 0, 0))).toMatchObject({ kind: 'ok', count: 2 });
    // the locker holds 2 L: 1 L of rounds fit whole
    expect(verdict(c, rounds, here, L.ground(s.map, 1, 0, 0))).toMatchObject({ kind: 'ok', count: 200 });
    expect(census([here, L.inv(c)]).counts.get('9mm')).toBe(200);
  });
});

describe('itemActions', () => {
  it('food eats, clothes wear, bags empty, ground items pick up; greyed with the reason', () => {
    const s = scope();
    const c = s.who;
    const here = L.ground(s.map, 0, 0, 0);
    const beans = createItem(data, 'can_beans');
    spawnItem(beans, here);
    const eat = itemActions(c, beans, here);
    expect(eat.map((a) => a.id)).toEqual(['eat', 'wield', 'pickup']);
    expect(eat[0].primary).toBe(true);
    expect(eat.find((a) => a.id === 'pickup')!.disabled).toBe("There's no room in your inventory for the canned beans (2).");
    const jeans = createItem(data, 'jeans');
    spawnItem(jeans, here);
    const wear = itemActions(c, jeans, here);
    expect(wear.find((a) => a.primary)?.id).toBe('wear');
    expect(wear.find((a) => a.id === 'wear')!.run().ok).toBe(true);
    const bag = inNewContainer(data, createItem(data, 'rock', { count: 1 }), 'bag_canvas').container;
    spawnItem(bag, here);
    const empty = itemActions(c, bag, here).find((a) => a.id === 'unload')!;
    expect(empty.label).toBe('Empty');
    expect(empty.disabled).toBeUndefined();
    expect(empty.run().ok).toBe(true);
    expect(bag.contents).toEqual([]);
    const off = itemActions(c, jeans, L.worn(c)).find((a) => a.id === 'takeoff')!;
    expect(off.disabled).toBeUndefined();
  });
});

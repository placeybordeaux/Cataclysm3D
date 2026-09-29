import { describe, expect, it } from 'vitest';
import { Character } from '../src/game/character';
import { createItem, inNewContainer, type Item } from '../src/game/item';
import { census, isAt, L, moveItem, spawnItem, type Loc } from '../src/game/moves';
import { carriedEntries, doAction, dropRows, nearbyEntries } from '../src/ui/inventory_ui';
import { makeData } from './fixtures/gamedata';
import { FakeGround } from './fixtures/ground';

// The ways v1 duplicated items, replayed against the BN model through the same v1 UI functions
// (src/ui/inventory_ui.ts). Found by fuzzing the v1-dda build (item census across the survivor
// and the map after every UI action; see docs/INVENTORY_MODEL.md "Why v1 duplicated items"):
//
//  1. carriedEntries() listed the inventory as "everything in the pockets of wielded + worn
//     items", but also listed the wielded item's contents under WIELDED: a bag picked up into
//     your hands showed every item in it twice.
//  2. Actions never checked that an item was where the UI entry said. wield()/wear() "removed"
//     it from the inventory (a silent no-op when it wasn't there) and attached it anyway, and
//     for ground entries the map removal after the action also failed silently: an entry that
//     was no longer true (the bag had just been unloaded, a liquid menu answered later, a list
//     not yet rebuilt) put the same item object in two places. Saving then wrote it twice.
//  3. Trade listed a wielded bag and its contents as separate goods; selling both detached the
//     bag and then failed (silently) to detach the contents from it, so they were sold twice.
//
// In the BN model an item's place is explicit, every action is a move from a stated place, and a
// move from a place the item isn't in fails ("The X is no longer there.") without changing
// anything.

const data = makeData();

function setup() {
  const c = new Character(data, { seed: 3 });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  const map = new FakeGround();
  Object.assign(c, { tileX: 0, tileY: 0, z: 0 });
  c.groundLoc = () => L.ground(map, 0, 0, 0);
  const ctx = { game: { player: c, map, message: (t: string) => log.push(t) }, renderer: null } as never;
  const all = (): Loc[] => [L.hands(c), L.worn(c), L.inv(c), L.ground(map, 0, 0, 0), L.ground(map, 1, 0, 0)];
  return { c, map, ctx, log, all };
}

/** A canvas bag holding a stack of rounds (BN containers hold one load). */
function bagOfRounds(n = 40): Item {
  return inNewContainer(data, createItem(data, '9mm', { count: n }), 'bag_canvas').container;
}

describe('v1 duplication paths, replayed', () => {
  it('a bag picked up into your hands lists its contents once, and unloading it moves them once', () => {
    const { c, map, ctx, all } = setup();
    const bag = bagOfRounds();
    spawnItem(bag, L.ground(map, 0, 0, 0));
    const before = census(all()).counts;
    // no storage worn: the pickup puts the bag in the survivor's hands (v1 did the same)
    const pick = nearbyEntries(ctx).find((e) => e.item === bag)!;
    expect(c.inv.pickUp(pick.item, pick.loc).ok).toBe(true);
    expect(c.inv.wielded).toBe(bag);
    const listed = carriedEntries(ctx).map((e) => e.item);
    expect(listed.filter((i) => i.typeId === '9mm')).toHaveLength(1); // v1: 2
    // Unload through the v1 item menu path: no room anywhere but the ground, so there they go
    const entry = carriedEntries(ctx).find((e) => e.item === bag)!;
    doAction(ctx, 'unload', entry);
    expect(bag.contents).toHaveLength(0);
    expect(census(all()).counts).toEqual(before);
    expect(census(all()).aliased).toEqual([]);
  });

  it('acting on a stale entry after the unload fails instead of cloning the item', () => {
    const { c, ctx, all } = setup();
    c.inv.wear(createItem(data, 'backpack'), null);
    const bag = bagOfRounds();
    c.inv.giveNew(bag);
    const staleRounds = carriedEntries(ctx).find((e) => e.item.typeId === '9mm')!; // "in the bag"
    const before = census(all()).counts;
    doAction(ctx, 'unload', carriedEntries(ctx).find((e) => e.item === bag)!);
    expect(bag.contents).toHaveLength(0);
    // The list wasn't rebuilt yet: the player picks the rounds' old line and wields / drops them.
    expect(isAt(staleRounds.item, staleRounds.loc)).toBe(false);
    expect(doAction(ctx, 'wield', staleRounds)).toBeNull(); // "The 9x19mm JHP is no longer there."
    dropRows(ctx, [{ entry: staleRounds, max: 40, count: 40 }]);
    expect(c.inv.wield(staleRounds.item, staleRounds.loc).code).toBe('stale');
    expect(census(all()).counts).toEqual(before);
    expect(census(all()).aliased).toEqual([]);
  });

  it('unloading a bag lying on the ground: into the inventory, the rest stays on the ground', () => {
    const { c, map, all } = setup();
    c.inv.wear(createItem(data, 'jeans'), null); // 500 ml of carrying space
    const bag = inNewContainer(data, createItem(data, 'rock', { count: 5 }), 'bag_canvas').container; // 5 x 250 ml
    spawnItem(bag, L.ground(map, 0, 0, 0));
    const before = census(all()).counts;
    const r = c.inv.unload(bag);
    expect(r.ok).toBe(true);
    // BN: what fits goes in the inventory (a stack moves whole), the rest lands at your feet
    expect(census(all()).counts).toEqual(before);
    expect(bag.contents).toHaveLength(0);
    expect(c.inv.countOf('rock') + (map.itemsAt(0, 0, 0) as Item[]).filter((i) => i.typeId === 'rock').reduce((n, i) => n + i.count(), 0)).toBe(5);
  });

  it('a stale ground entry (the item was moved to another tile) is not taken twice', () => {
    const { c, map, ctx, all } = setup();
    c.inv.wear(createItem(data, 'backpack'), null);
    const knife = createItem(data, 'knife_combat');
    spawnItem(knife, L.ground(map, 0, 0, 0));
    const entry = nearbyEntries(ctx).find((e) => e.item === knife)!;
    moveItem(knife, L.ground(map, 0, 0, 0), L.ground(map, 1, 0, 0)); // kicked aside meanwhile
    const before = census(all()).counts;
    expect(doAction(ctx, 'wield', entry)).toBeNull();
    expect(c.inv.wielded).toBeNull();
    expect(census(all()).counts).toEqual(before);
    expect(census(all()).aliased).toEqual([]);
  });
});

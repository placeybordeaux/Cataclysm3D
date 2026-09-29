import { describe, expect, it } from 'vitest';
import { createItem, Item } from '../src/game/item';
import { autoStoreLiquid, drinkLiquid, liquidTargets, pourInto } from '../src/game/liquid';
import { PlayerAvatar } from '../src/game/player';
import { GameMap } from '../src/world/map';
import { makeData } from './fixtures/gamedata';

const data = makeData();
// An open, watertight container like CDDA's pot.
data.items.pot = { ...structuredClone(data.items.bottle_plastic), id: 'pot', name: 'pot' };
data.items.pot.pocket_data![0] = { ...data.items.pot.pocket_data![0], open_container: true, max_contains_volume: 2000, max_item_volume: undefined };

function host() {
  const player = new PlayerAvatar(data, { seed: 1 });
  player.x = 5.5;
  player.y = 5.5;
  const msgs: string[] = [];
  player.inv.wear(createItem(data, 'backpack'));
  return { map: new GameMap(1), player, message: (t: string) => void msgs.push(t), msgs };
}

describe('liquid handling (liquid_handler.cpp)', () => {
  it('auto-stores into carried closed containers only; open pots and full bottles are left to the menu', () => {
    const h = host();
    const pot = createItem(data, 'pot');
    const bottle = createItem(data, 'bottle_plastic');
    h.player.inv.stash(pot);
    h.player.inv.stash(bottle);
    const water = createItem(data, 'water_clean', { charges: 5 });
    const left = autoStoreLiquid(h, water);
    // the 500 ml bottle takes 2 of 5 charges (250 ml each), the rest waits for a choice
    expect(bottle.allContents()[0]?.charges).toBe(2);
    expect(pot.allContents()).toHaveLength(0);
    expect(left?.charges).toBe(3);
    const targets = liquidTargets(h, left!);
    expect(targets.map((t) => t.item)).toEqual([pot]);
    expect(targets[0].open).toBe(true);
  });

  it('offers containers on the ground next to you, never the one it came out of or ones holding something else', () => {
    const h = host();
    const onFloor = createItem(data, 'bottle_plastic');
    const other = createItem(data, 'bottle_plastic');
    other.put(createItem(data, 'disinfectant', { charges: 1 }));
    h.map.addItem(6, 5, 0, onFloor);
    h.map.addItem(5, 6, 0, other);
    h.map.addItem(9, 9, 0, createItem(data, 'bottle_plastic')); // too far
    const water = createItem(data, 'water_clean', { charges: 1 });
    expect(liquidTargets(h, water).map((t) => [t.item, t.where])).toEqual([[onFloor, 'ground']]);
    expect(liquidTargets(h, water, onFloor)).toEqual([]);
    expect(pourInto(h, water, onFloor)).toBeNull();
    expect(onFloor.name()).toMatch(/clean water/);
  });

  it('drinking from your hands consumes charges until done', () => {
    const h = host();
    const water = createItem(data, 'water_clean', { charges: 2 });
    expect(drinkLiquid(h, water)).toBeNull();
    expect(water.charges).toBe(0);
    expect(water).toBeInstanceOf(Item);
  });
});

import { describe, expect, it } from 'vitest';
import { createItem, inNewContainer } from '../src/game/item';
import { autoStoreLiquid, drinkLiquid, liquidTargets, pourInto } from '../src/game/liquid';
import { census, L, spawnOnGround } from '../src/game/moves';
import { PlayerAvatar } from '../src/game/player';
import { GameMap } from '../src/world/map';
import { makeData } from './fixtures/gamedata';

const data = makeData();

function host() {
  const player = new PlayerAvatar(data, { seed: 1 });
  player.x = 5.5;
  player.y = 5.5;
  const msgs: string[] = [];
  const map = new GameMap(1);
  player.groundLoc = () => L.ground(map, player.tileX, player.tileY, player.z);
  player.inv.wear(createItem(data, 'backpack'), null);
  return { map, player, message: (t: string) => void msgs.push(t), msgs };
}

describe('liquid handling (liquid_handler.cpp)', () => {
  it('auto-stores into carried sealed containers only; a carried pot is no target at all', () => {
    const h = host();
    const pot = createItem(data, 'pot');
    const bottle = createItem(data, 'bottle_plastic');
    h.player.inv.stashNew(pot);
    h.player.inv.stashNew(bottle);
    const water = createItem(data, 'water_clean', { charges: 5 });
    const left = autoStoreLiquid(h, water);
    // the 500 ml bottle takes 2 of 5 charges (250 ml each), the rest waits for a choice
    expect(bottle.contents[0]?.charges).toBe(2);
    expect(pot.contents).toHaveLength(0);
    expect(left?.charges).toBe(3);
    // BN: an open pot holds liquid only on the ground or in your hands
    expect(liquidTargets(h, left!)).toEqual([]);
    h.player.inv.wield(pot);
    const targets = liquidTargets(h, left!);
    expect(targets.map((t) => t.item)).toEqual([pot]);
    expect(targets[0].open).toBe(true);
  });

  it('offers containers on the ground next to you, never the one it came out of or ones holding something else', () => {
    const h = host();
    const onFloor = createItem(data, 'bottle_plastic');
    const other = inNewContainer(data, createItem(data, 'disinfectant', { charges: 1 }), 'bottle_plastic').container;
    spawnOnGround(h.map, 6, 5, 0, onFloor);
    spawnOnGround(h.map, 5, 6, 0, other);
    spawnOnGround(h.map, 9, 9, 0, createItem(data, 'bottle_plastic')); // too far
    const water = createItem(data, 'water_clean', { charges: 1 });
    expect(liquidTargets(h, water).map((t) => [t.item, t.where])).toEqual([[onFloor, 'ground']]);
    expect(liquidTargets(h, water, onFloor)).toEqual([]);
    expect(pourInto(h, water, onFloor)).toBeNull();
    expect(onFloor.name()).toMatch(/clean water/);
  });

  it('pouring out of a container moves exactly what fits and leaves the rest in place', () => {
    const h = host();
    const jug = inNewContainer(data, createItem(data, 'water_clean', { charges: 8 }), 'bucket').container;
    spawnOnGround(h.map, 5, 5, 0, jug);
    const bottle = createItem(data, 'bottle_plastic');
    h.player.inv.stashNew(bottle);
    const scope = [L.ground(h.map, 5, 5, 0), L.inv(h.player)];
    const before = census(scope).counts.get('water_clean');
    const water = jug.contents[0];
    const rest = pourInto(h, water, bottle, L.in(jug));
    expect(rest).toBe(water);
    expect(water.charges).toBe(6);
    expect(bottle.contents[0].charges).toBe(2);
    expect(census(scope).counts.get('water_clean')).toBe(before);
  });

  it('drinking from your hands consumes charges until done', () => {
    const h = host();
    const water = createItem(data, 'water_clean', { charges: 2 });
    expect(drinkLiquid(h, water)).toBeNull();
  });
});

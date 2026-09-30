// Wood on a fire keeps it going (BN map_field.cpp fd_fire: time_added = roll_remainder(fuel)).
// Playtest: a campfire on a pile of sticks went out in ~20 minutes with every stick unburnt,
// because the port rounded the ~0.16 s/turn a stick yields down to 0.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameClock } from '../src/core/time';
import type { GameData } from '../src/data/types';
import { addField, processFields } from '../src/game/fields';
import { createItem } from '../src/game/item';
import { PlayerAvatar } from '../src/game/player';
import { GameMap } from '../src/world/map';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
  monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json'),
};

function world(): any {
  const map = new GameMap(1);
  for (const t of Object.values(data.terrain)) map.terrain.add(t);
  for (const f of Object.values(data.furniture)) map.furniture.add(f);
  map.generator = { generate: (m, c) => c.ter.fill(m.terrain.index('t_dirt')) };
  const player = new PlayerAvatar(data, { seed: 3 });
  player.x = 2.5;
  player.y = 2.5;
  return { data, map, player, clock: new GameClock(), message: () => {}, input: { held: new Set(), captured: false } };
}

/** Seconds until the fire at (6,6) is gone, up to `cap`. `bulk`: as during a time warp (8 turns
 * simulated, the rest in bulk, like the fields system does each frame). */
function lifetime(h: any, cap: number, bulk = false): number {
  for (let t = 0; t < cap; t += 60) {
    if (bulk) processFields(h, 8, 52);
    else processFields(h, 60);
    if (!h.map.fieldsAt(6, 6, 0).some((f: { type: string }) => f.type === 'fd_fire')) return t + 60;
  }
  return cap;
}

describe('fire fuel', () => {
  // Burning is random turn by turn, so compare averages over a few seeds.
  const SEEDS = [11, 23, 37, 41, 53, 67];
  const meanLife = (sticks: number, bulk: boolean) => {
    let sum = 0;
    for (const seed of SEEDS) {
      const h = world();
      h.seed = seed;
      for (let i = 0; i < sticks; i++) h.map.addItem(6, 6, 0, createItem(data, 'stick'));
      addField(h, 6, 6, 0, 'fd_fire', 1);
      sum += lifetime(h, 6 * 3600, bulk);
    }
    return sum / SEEDS.length;
  };
  for (const bulk of [false, true]) {
    it(`a pile of heavy sticks outlasts a bare fire several times over${bulk ? ' (while time is warped)' : ''}`, () => {
      expect(meanLife(6, bulk)).toBeGreaterThan(meanLife(0, bulk) * 3);
    });
  }

  it('in a fire ring the same planks burn far longer (BN fire_data.contained: intensity-3 rates, volume-independent)', () => {
    const life = (ring: boolean) => {
      let sum = 0;
      for (const seed of SEEDS) {
        const h = world();
        h.seed = seed;
        if (ring) h.map.setFurn(6, 6, 0, 'f_firering');
        h.map.addItem(6, 6, 0, createItem(data, '2x4', { charges: 2 }));
        addField(h, 6, 6, 0, 'fd_fire', 1);
        sum += lifetime(h, 12 * 3600);
      }
      return sum / SEEDS.length;
    };
    expect(life(true)).toBeGreaterThan(life(false) * 3);
  });
});

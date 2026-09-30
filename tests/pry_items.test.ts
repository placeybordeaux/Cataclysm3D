// Regression: "Pry the manhole cover" threw "entries is not iterable" (user report, wave 4).
// BN's pry_items / break_items are inline entry lists loaded as a collection.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData, TerrainDef } from '../src/data/types';
import { pryDrops, pryInfo } from '../src/game/pry';
import { Rng } from '../src/core/rng';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'),
    itemGroups: load('item_groups.json'), monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json'),
  } as GameData;
});

describe('pry item drops', () => {
  it('prying a manhole cover drops the manhole cover item', () => {
    const info = pryInfo(data.terrain.t_manhole_cover as TerrainDef);
    expect(info).not.toBeNull();
    const drops = pryDrops(data, info!.items, new Rng(1));
    expect(drops.map((d) => d.id)).toContain('manhole_cover');
  });

  it('every pryable terrain and furniture expands its pry and break items without throwing', () => {
    const defs = [...Object.values(data.terrain), ...Object.values(data.furniture)] as TerrainDef[];
    let checked = 0;
    for (const def of defs) {
      const info = pryInfo(def);
      if (!info) continue;
      expect(() => pryDrops(data, info.items, new Rng(2)), def.id).not.toThrow();
      expect(() => pryDrops(data, info.breakItems, new Rng(3)), def.id).not.toThrow();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

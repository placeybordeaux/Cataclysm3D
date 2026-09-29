import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameData } from '../../src/data/types';
import type { WorldgenData } from '../../src/world/worldgen_data';
import { GameMap } from '../../src/world/map';

// Load public/data/*.json from disk for Node tools and vitest (the browser uses fetch).

export function loadNodeData(dir = resolve('public/data')): { game: GameData; wg: WorldgenData } {
  const j = (f: string) => JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
  const game = {
    terrain: j('terrain.json'), furniture: j('furniture.json'), items: j('items.json'), itemGroups: j('item_groups.json'),
    monsters: j('monsters.json'), monsterGroups: j('monster_groups.json'), recipes: j('recipes.json'), misc: j('misc.json'),
  } as GameData;
  const wg = { mapgen: j('mapgen.json'), palettes: j('palettes.json'), overmap: j('overmap.json') } as WorldgenData;
  return { game, wg };
}

export function makeMap(game: GameData, seed: number): GameMap {
  const map = new GameMap(seed);
  for (const t of Object.values(game.terrain)) map.terrain.add(t);
  for (const f of Object.values(game.furniture)) map.furniture.add(f);
  return map;
}

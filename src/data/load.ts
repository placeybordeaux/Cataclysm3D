import type { GameData } from './types';

// Files produced by `npm run extract`. Loading fails loudly if any is missing: running
// with partial content would produce confusing downstream errors (unknown ids in mapgen).
const FILES = {
  terrain: 'terrain.json',
  furniture: 'furniture.json',
  items: 'items.json',
  itemGroups: 'item_groups.json',
  monsters: 'monsters.json',
  monsterGroups: 'monster_groups.json',
  recipes: 'recipes.json',
  misc: 'misc.json',
} as const;

export async function loadGameData(base = '/data/'): Promise<GameData> {
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([key, file]) => {
      const res = await fetch(base + file);
      if (!res.ok) throw new Error(`Failed to load ${base + file}: HTTP ${res.status} (run \`npm run extract\`)`);
      return [key, await res.json()] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as GameData;
}

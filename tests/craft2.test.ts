// The ui2 crafting screen's data layer (src/ui/craft2/craft_model.ts) on real BN data.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameClock } from '../src/core/time';
import type { GameData } from '../src/data/types';
import { ActivityManager } from '../src/game/activity';
import { craftingInventory, findRecipe, type CraftHost } from '../src/game/crafting';
import { createItem } from '../src/game/item';
import { PlayerAvatar } from '../src/game/player';
import { GameMap } from '../src/world/map';
import { qualityIcon, RecipeBook, searchMatcher, sourcesOf, type RowQuery } from '../src/ui/craft2/craft_model';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
  monsters: {}, monsterGroups: {}, recipes: load('recipes.json'), misc: load('misc.json'),
};

function host(): CraftHost {
  const map = new GameMap(1);
  for (const t of Object.values(data.terrain)) map.terrain.add(t);
  for (const f of Object.values(data.furniture)) map.furniture.add(f);
  map.generator = { generate: (m, c) => c.ter.fill(m.terrain.index('t_dirt')) };
  const player = new PlayerAvatar(data, { seed: 1 });
  player.x = player.y = 5.5;
  player.inv.wear(createItem(data, 'backpack'), null);
  const h: any = { data, map, player, clock: new GameClock(), input: { held: new Set(), captured: false }, message: () => {} };
  h.activities = new ActivityManager(h);
  return h;
}

const q = (o: Partial<RowQuery> = {}): RowQuery => ({ filter: 'known', category: 'ALL', query: '', favourites: new Set(), recent: [], isNew: () => false, ...o });

describe('recipe browser rows', () => {
  it('filters: craftable now / have some / all known / favourites; craftable sort first', () => {
    const h = host();
    h.player.inv.giveNew(createItem(data, 'knife_folding'));
    h.map.addItem(6, 5, 0, createItem(data, 'stick_long'));
    const book = new RecipeBook(h, craftingInventory(h));
    const all = book.rows(q());
    expect(all.length).toBeGreaterThan(50);
    expect(all[0].check.ok).toBe(true);
    const ok = book.rows(q({ filter: 'craftable' }));
    expect(ok.map((r) => r.recipe.id)).toContain('pointy_stick_long');
    expect(ok.every((r) => r.check.ok)).toBe(true);
    const some = book.rows(q({ filter: 'some' }));
    expect(some.length).toBeGreaterThanOrEqual(ok.length);
    expect(book.rows(q({ filter: 'favs', favourites: new Set(['pointy_stick_long']) })).map((r) => r.recipe.id)).toEqual(['pointy_stick_long']);
    expect(book.rows(q({ category: 'CC_FOOD' })).every((r) => r.recipe.category === 'CC_FOOD')).toBe(true);
    expect(book.rows(q({ category: 'RECENT', recent: ['pointy_stick_long'] })).map((r) => r.recipe.id)).toEqual(['pointy_stick_long']);
    const fresh = book.rows(q({ isNew: (id) => id === 'pointy_stick_long' }));
    expect(fresh[0].recipe.id).toBe('pointy_stick_long');
  });

  it('search prefixes: name, c: component, t: tool/quality', () => {
    const r = findRecipe(data, 'spear_wood')!;
    expect(searchMatcher(data, 'wooden sp')(r)).toBe(true);
    expect(searchMatcher(data, 'c:long stick')(r)).toBe(true);
    expect(searchMatcher(data, 'c:nail')(r)).toBe(false);
    expect(searchMatcher(data, 't:cutting')(r)).toBe(true);
  });

  it('where to get a component: recipes that make it and things that come apart into it', () => {
    const h = host();
    const s = sourcesOf(h, 'stick', new Set());
    expect(s.salvage).toContain('stick_long');
    expect(sourcesOf(h, 'pointy_stick_long', new Set()).craft.map((r) => r.id)).toContain('pointy_stick_long');
    expect(qualityIcon(data, 'CUT', 1)).toBeTruthy();
  });
});

// "Boil water" at a lit fire (docs/ADAPTATION.md). Water from a river, a toilet or rain is
// "water", not "water_clean"; BN boils it through the crafting menu (recipe water_clean: a BOIL
// tool and a fire in reach). Sharp edge: in BN unclean water carries no disease (no
// contamination/parasites in its JSON; iuse::blech_because_unclean only asks "This looks
// unclean, sure you want to drink it?"), so the label says "clean water", never "safe" or
// "you'll get sick". Tips said "boil it" but a newcomer had to discover the recipe. Here the
// fire itself offers it: `e` on a burning fire with dirty water and a pot, runs the same recipe
// (same time, same tools, same skill practice), as many servings as the pot allows.

import type { Game } from './game';
import { canCraft, craftingInventory, findRecipe, startCraft } from './crafting';
import { interactionProviders, type Interaction } from './interact';

/** The id BN uses for unsafe water ("water" = dirty; "water_clean" = safe). */
const DIRTY = 'water';

/** The biggest batch (servings) you can boil right now, 0 when none. */
export function boilableServings(game: Game): number {
  const r = findRecipe(game.data, 'water_clean');
  if (!r) return 0;
  const inv = craftingInventory(game);
  const have = inv.countOf(DIRTY);
  for (let n = Math.min(have, 20); n >= 1; n--) if (canCraft(game, r, n, inv, true).ok) return n;
  return 0;
}

export function installBoilWater(game: Game): void {
  interactionProviders.push((g, x, y, z): Interaction[] => {
    if (!g.map.fieldsAt(x, y, z).some((f) => f.type === 'fd_fire' && f.intensity > 0)) return [];
    const r = findRecipe(g.data, 'water_clean');
    if (!r) return [];
    const inv = craftingInventory(g);
    const have = inv.countOf(DIRTY);
    if (have <= 0) return [];
    const n = boilableServings(g);
    if (n <= 0) {
      const why = canCraft(g, r, 1, inv, true).missing.join('; ');
      return [{ id: 'boil_water', label: 'Boil water (you need a pot or a can to boil it in)', run: () => g.message(`You can't boil water yet: ${why || 'you need a pot'}.`, 'c_light_red') }];
    }
    return [{ id: 'boil_water', label: `Boil water (${n} serving${n === 1 ? '' : 's'} of clean water)`, run: () => void startCraft(g, r, { batch: n }) }];
  });
}

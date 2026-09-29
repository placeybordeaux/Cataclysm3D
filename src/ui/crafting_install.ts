import type { Game } from '../game/game';
import type { DebugApi } from '../debug';
import { canCraft, findRecipe, learnAll, startCraft } from '../game/crafting';
import { getConstruction, startConstruction } from '../game/construction';
import { startDisassembly } from '../game/disassembly';
import { fireTarget, useFirestarter } from '../game/fire';
import { createItem, Item } from '../game/item';
import { startReading } from '../game/reading';
import { openConstructionMenu } from './construction';
import { openCraftingMenu } from './crafting';
import { openDisassembleMenu, openReadMenu } from './craft_menus';

// Wires crafting, construction, disassembly, reading and fire-starting into the game:
// key actions (& * ( R), the firestarter use_action for `A`pply and window.cdda helpers. Call once from main.ts after the debug API exists.

export function installCrafting(game: Game, api?: DebugApi): void {
  game.keys.register('craft', 'Craft items', () => openCraftingMenu(game));
  game.keys.register('construct', 'Construct terrain', () => openConstructionMenu(game));
  game.keys.register('disassemble', 'Disassemble items', () => openDisassembleMenu(game));
  game.keys.register('read', 'Read', () => openReadMenu(game));
  game.player.inv.useHandlers.set('firestarter', (it, ua) => {
    const [x, y, z] = fireTarget(game);
    return useFirestarter(game, it, ua, x, y, z);
  });
  // The activity progress bar lives in the HUD (src/ui/hud.ts); installActivityBar stays
  // available for standalone use.
  if (api) installCraftingDebug(game, api);
}

function installCraftingDebug(game: Game, api: DebugApi): void {
  const p = () => game.player;
  const recipe = (id: string) => {
    const r = findRecipe(game.data, id);
    if (!r) throw new Error(`no recipe ${id}`);
    return r;
  };
  /** Learn every craftable recipe; returns how many were new. */
  api.learnAll = () => learnAll(p());
  /** Missing requirements for a recipe id or result item id ([] = craftable). */
  api.canCraft = (id: string, batch = 1) => canCraft(game, recipe(id), batch).missing;
  /** Start crafting (activity) — `instant` finishes at once. Returns the start message. */
  api.craft = (id: string, opts: { batch?: number; instant?: boolean } = {}) => startCraft(game, recipe(id), opts).msg;
  /** Build construction `id` at (x, y, z) (default: tile faced). */
  api.construct = (id: string, x?: number, y?: number, z?: number, instant = false) => {
    const con = getConstruction(game.data, id);
    if (!con) throw new Error(`no construction ${id}`);
    const pl = p();
    const [fx, fy] = [Math.floor(pl.x + Math.sin(pl.yaw) * 0.9), Math.floor(pl.y - Math.cos(pl.yaw) * 0.9)];
    return startConstruction(game, con, x ?? fx, y ?? fy, z ?? pl.z, { instant });
  };
  /** Place an item on the ground next to the player (dx, dy tiles). */
  api.placeItem = (id: string, dx = 0, dy = 0, count?: number) => {
    const pl = p();
    const it = createItem(game.data, id, count !== undefined ? { count } : {});
    game.map.addItem(Math.floor(pl.x) + dx, Math.floor(pl.y) + dy, pl.z, it);
    return it.name();
  };
  api.addFire = (dx = 1, dy = 0) => {
    const pl = p();
    game.map.addField(Math.floor(pl.x) + dx, Math.floor(pl.y) + dy, pl.z, 'fd_fire', 1);
  };
  api.openCrafting = (filter?: string) => {
    const m = openCraftingMenu(game);
    if (filter) m.setFilter(filter);
    return m.entries();
  };
  api.craftingMenu = () => openCraftingMenu(game);
  api.openConstruction = (filter?: string) => {
    const m = openConstructionMenu(game);
    if (filter) m.setFilter(filter);
  };
  api.openRead = () => openReadMenu(game);
  api.openDisassemble = () => openDisassembleMenu(game);
  /** Read the first carried book of type `id` (gives it first if missing). */
  api.read = (id: string) => {
    let b = p().inv.allItems().find((i) => i.typeId === id);
    if (!b) {
      b = createItem(game.data, id);
      p().inv.pickUp(b);
    }
    return startReading(game, b);
  };
  api.disassemble = (id: string, instant = false) => {
    const it = p().inv.allItems().find((i) => i.typeId === id) as Item | undefined;
    if (!it) throw new Error(`not carrying ${id}`);
    return startDisassembly(game, it, { instant });
  };
  api.knownRecipes = () => [...p().learnedRecipes];
}

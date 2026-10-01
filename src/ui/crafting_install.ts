import type { Game } from '../game/game';
import type { DebugApi } from '../debug';
import type { Renderer } from '../render/renderer';
import { canCraft, continueCraft, craftQueue, findRecipe, inProgressCrafts, learnAll, startCraft } from '../game/crafting';
import { cancelConstruction, continueConstruction, getConstruction, startConstruction, unfinishedAt } from '../game/construction';
import { startDisassembly } from '../game/disassembly';
import { fireTarget, useFirestarter } from '../game/fire';
import { itemActionProviders } from '../game/inventory_view';
import { createItem, Item } from '../game/item';
import { spawnOnGround } from '../game/moves';
import { reading, startReading } from '../game/reading';
import { worldContextProviders } from '../ui2';
import { constructionWorldMenu, craftingItemActions } from './craft2/actions';
import { constructionScreen, currentPlacement, openConstructionScreen, startPlacement } from './craft2/construction_screen';
import { craftingScreen, openCraftingScreen } from './craft2/crafting_screen';
import { installCraftOverlay } from './craft2/overlay';
import { installReadQuiz } from './readquiz';
import { openConstructionMenu } from './construction';
import { openCraftingMenu } from './crafting';
import { openDisassembleMenu, openReadMenu } from './craft_menus';
import { constructionGroups } from '../game/construction';
import { installPractice } from './practice_cue';

// Wires crafting, construction, disassembly, reading and fire-starting into the game: key
// actions (& * ( R) open the ui2 screens (src/ui/craft2), right-click item actions (read,
// disassemble, continue a craft) join the inventory screens through itemActionProviders, world
// right-clicks get "continue construction" / "build here", the firestarter use_action serves
// `A`pply, and window.cdda gets helpers. Call once from main.ts after the debug API exists.

export function installCrafting(game: Game, api?: DebugApi, renderer?: Renderer): void {
  game.keys.register('craft', 'Craft items', () => void openCraftingScreen(game));
  game.keys.register('construct', 'Construct terrain', () => (renderer ? void openConstructionScreen(game, renderer) : void openConstructionMenu(game)));
  game.keys.register('disassemble', 'Disassemble items', () => openDisassembleMenu(game));
  game.keys.register('read', 'Read', () => openReadMenu(game));
  game.player.inv.useHandlers.set('firestarter', (it, ua) => {
    const [x, y, z] = fireTarget(game);
    return useFirestarter(game, it, ua, x, y, z);
  });
  // BN "CRAFT" use_action on the in-progress item: activating it continues the work.
  game.player.inv.useHandlers.set('CRAFT', (it) => {
    const r = continueCraft(game, it);
    return { ok: r.ok, msg: r.msg, moves: 0 };
  });
  itemActionProviders.push((who, it, loc) => (who === game.player ? craftingItemActions(game, it, loc) : []));
  if (renderer) {
    installCraftOverlay(game, renderer);
    installReadQuiz(game, renderer, api);
    worldContextProviders.push((t) => constructionWorldMenu(game, t, () => void openConstructionScreen(game, renderer)));
  }
  if (api) installCraftingDebug(game, api, renderer);
  // Skill practice made visible: HUD cue, level-up toasts, options (src/ui/practice_cue.ts).
  installPractice(game, api);
}

function installCraftingDebug(game: Game, api: DebugApi, renderer?: Renderer): void {
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
    spawnOnGround(game.map, Math.floor(pl.x) + dx, Math.floor(pl.y) + dy, pl.z, it);
    return it.name();
  };
  api.addFire = (dx = 1, dy = 0) => {
    const pl = p();
    game.map.addField(Math.floor(pl.x) + dx, Math.floor(pl.y) + dy, pl.z, 'fd_fire', 1);
  };
  /** The ui2 crafting screen: open (optionally searching), its state, and actions for automation. */
  api.crafting = {
    open: (query?: string) => {
      const s = craftingScreen() ?? openCraftingScreen(game);
      if (query !== undefined) s.setQuery(query);
      return s.rows();
    },
    screen: () => craftingScreen(),
    state: () => {
      const s = craftingScreen();
      return s ? { open: true, rows: s.rows().length, selected: s.selected() } : { open: false };
    },
    queue: () => {
      const q = craftQueue(game);
      return { running: q.running, current: q.current?.recipe.id ?? null, entries: q.entries.map((e) => [e.recipe.id, e.batch]) };
    },
    inProgress: () => inProgressCrafts(game).map((c) => ({ recipe: c.state.recipe.id, progress: c.state.progress, nearby: c.nearby })),
    continue: () => {
      const c = inProgressCrafts(game)[0];
      return c ? continueCraft(game, c.item).msg : 'nothing in progress';
    },
    reading: () => (reading.current ? { book: reading.current.book.typeId, mode: reading.current.mode, sessions: reading.current.sessions } : null),
  };
  /** The legacy curses-style menus (kept for comparison). */
  api.openCraftingLegacy = (filter?: string) => {
    const m = openCraftingMenu(game);
    if (filter) m.setFilter(filter);
    return m.entries();
  };
  api.openCrafting = (filter?: string) => api.crafting.open(filter);
  api.openConstruction = (filter?: string) => {
    if (!renderer) return openConstructionMenu(game);
    const s = constructionScreen() ?? openConstructionScreen(game, renderer);
    if (filter) s.setQuery(filter);
    return s.rows();
  };
  api.construction = {
    place: (groupId: string) => {
      const g = constructionGroups(game.data).find((x) => x.id === groupId);
      if (!g || !renderer) throw new Error(`no construction group ${groupId}`);
      startPlacement(game, renderer, g);
    },
    placement: () => currentPlacement()?.target() ?? null,
    confirm: () => currentPlacement()?.confirm() ?? false,
    cancel: () => currentPlacement()?.cancel(),
    unfinished: (x: number, y: number, z: number) => unfinishedAt(game, x, y, z)?.name() ?? null,
    continueAt: (x: number, y: number, z: number) => {
      const s = unfinishedAt(game, x, y, z);
      return s ? continueConstruction(game, s, x, y, z) : false;
    },
    cancelAt: (x: number, y: number, z: number) => {
      const s = unfinishedAt(game, x, y, z);
      return s ? cancelConstruction(game, s, x, y, z) : false;
    },
  };
  api.openRead = () => openReadMenu(game);
  api.openDisassemble = () => openDisassembleMenu(game);
  /** Read the first carried book of type `id` (gives it first if missing). */
  api.read = (id: string, mode: 'until_level' | 'once' = 'until_level') => {
    let b = p().inv.allItems().find((i) => i.typeId === id);
    if (!b) {
      b = createItem(game.data, id);
      p().inv.giveNew(b);
    }
    return startReading(game, b, mode);
  };
  api.disassemble = (id: string, instant = false) => {
    const it = p().inv.allItems().find((i) => i.typeId === id) as Item | undefined;
    if (!it) throw new Error(`not carrying ${id}`);
    return startDisassembly(game, it, { instant });
  };
  api.knownRecipes = () => [...p().learnedRecipes];
}

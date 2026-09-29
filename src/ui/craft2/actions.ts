// Item and world actions for crafting, construction, disassembly and reading, for the inventory
// screens' right-click menus (itemActionProviders in src/game/inventory_view.ts) and the world
// context menu (ui2 worldContextProviders). Exposed for other screens as
//   disassembleAction(game, item, loc), readAction(game, item, loc), craftItemActions(game, item, loc)
// which return ItemAction entries (label, time in BN moves, disabled reason, run()).

import type { Game } from '../../game/game';
import type { Item } from '../../game/item';
import type { Loc } from '../../game/moves';
import type { ItemAction } from '../../game/inventory_view';
import { abandonCraft, cantContinue, continueCraft, craftState, recipeName, type CraftHost } from '../../game/crafting';
import { cancelConstruction, constructionGroups, canBuild, constructionInventory, continueConstruction, siteProblem, stageFor, startConstruction, unfinishedAt, unfinishedState } from '../../game/construction';
import { canDisassemble, startDisassembly, uncraftRecipe, yieldText } from '../../game/disassembly';
import { bookData, bookMastery, cantRead, nothingToLearn, startReading, timeToRead } from '../../game/reading';
import { fineVisionMod } from '../../game/crafting';
import type { MenuItem, WorldTarget } from '../../ui2';

const ok = (b: boolean, msg = '') => ({ ok: b, msg });

/** "Read" (until a level, when the book still teaches) and "Read once". */
export function readAction(game: CraftHost, it: Item, _loc?: Loc): ItemAction[] {
  if (!it.isBook()) return [];
  const why = cantRead(game, it) ?? undefined;
  const moves = timeToRead(game.player, it, fineVisionMod(game)) * 100;
  const b = bookData(it)!;
  const trains = !!b.skill && bookMastery(game.player, it) === 'learning';
  const out: ItemAction[] = [
    {
      id: 'read',
      label: trains ? 'Read (until you level up)' : nothingToLearn(game.player, it) && b.fun > 0 ? 'Read for fun' : 'Read',
      moves,
      disabled: why,
      primary: true,
      run: () => ok(startReading(game, it, trains ? 'until_level' : 'once')),
    },
  ];
  if (trains) out.push({ id: 'read_once', label: 'Read one chapter', moves, disabled: why, run: () => ok(startReading(game, it, 'once')) });
  return out;
}

/** "Disassemble" with its time and yield, greyed with the reason when you can't. */
export function disassembleAction(game: CraftHost, it: Item, _loc?: Loc): ItemAction[] {
  if (craftState(game.data, it) || unfinishedState(game.data, it)) return [];
  const r = uncraftRecipe(game.data, it.typeId);
  if (!r) return [];
  const ch = canDisassemble(game, it);
  return [
    {
      id: 'disassemble',
      label: `Disassemble (${yieldText(game.data, r) || 'nothing recoverable'})`,
      moves: Math.max(1, r.time) * 100,
      disabled: ch.ok ? undefined : ch.missing[0],
      run: () => ok(startDisassembly(game, it)),
    },
  ];
}

/** An in-progress craft: continue it, or take it apart for the components. An unfinished construction: continue or cancel. */
export function craftItemActions(game: CraftHost, it: Item, loc?: Loc): ItemAction[] {
  const st = craftState(game.data, it);
  if (st) {
    const left = (1 - st.progress) * st.recipe.time * st.batch;
    return [
      { id: 'craft_continue', label: `Continue crafting ${recipeName(game.data, st.recipe)}`, moves: left * 100, disabled: cantContinue(game, it) ?? undefined, primary: true, run: () => ok(continueCraft(game, it).ok) },
      { id: 'craft_abandon', label: 'Take apart (get the components back)', moves: 100, run: () => ok(abandonCraft(game, it)) },
    ];
  }
  const con = unfinishedState(game.data, it);
  if (con && loc?.kind === 'ground') {
    const { x, y, z } = loc;
    return [
      { id: 'craft_continue', label: 'Continue construction', moves: (1 - con.progress) * con.con.time * 100, primary: true, run: () => ok(continueConstruction(game, it, x, y, z)) },
      { id: 'craft_abandon', label: 'Cancel construction (get the materials back)', moves: 100, run: () => ok(cancelConstruction(game, it, x, y, z)) },
    ];
  }
  return [];
}

/** All of the above: the provider registered with inventory_view's itemActionProviders. */
export function craftingItemActions(game: CraftHost, it: Item, loc: Loc): ItemAction[] {
  return [...craftItemActions(game, it, loc), ...readAction(game, it, loc), ...disassembleAction(game, it, loc)];
}

/**
 * World context menu entries: continue / cancel an unfinished construction on the tile, and
 * "Build here" with the constructions that fit a tile next to you.
 */
export function constructionWorldMenu(game: Game, t: WorldTarget, openScreen: () => void): MenuItem[] {
  const p = game.player;
  const out: MenuItem[] = [];
  const site = unfinishedAt(game, t.x, t.y, t.z);
  if (site) {
    const st = unfinishedState(game.data, site)!;
    out.push({ label: `Continue: ${site.baseName().replace(/^unfinished /, '')} (${Math.floor(st.progress * 100)}%)`, primary: true, time: Math.round((1 - st.progress) * st.con.time), action: () => void continueConstruction(game, site, t.x, t.y, t.z) });
    out.push({ label: 'Cancel construction (get the materials back)', action: () => void cancelConstruction(game, site, t.x, t.y, t.z) });
    return out;
  }
  const near = t.z === p.z && Math.max(Math.abs(t.x - Math.floor(p.x)), Math.abs(t.y - Math.floor(p.y))) === 1;
  if (!near || t.kind === 'creature') return out;
  // Computed when the submenu opens: every group checked against this tile.
  const fits = (): MenuItem[] => {
    const inv = constructionInventory(game);
    const l: MenuItem[] = [];
    for (const g of constructionGroups(game.data)) {
      const stage = stageFor(game, g, t.x, t.y, t.z, inv);
      if (!stage || siteProblem(game, stage, t.x, t.y, t.z)) continue;
      const ch = canBuild(game, stage, inv);
      l.push({ label: g.name, time: stage.time, disabled: ch.ok ? undefined : `Need: ${ch.missing[0]}`, action: () => void startConstruction(game, stage, t.x, t.y, t.z) });
    }
    l.sort((a, b) => Number('disabled' in a && !!a.disabled) - Number('disabled' in b && !!b.disabled));
    if (!l.length) l.push({ label: 'Nothing can be built on this tile', disabled: true });
    return [...l.slice(0, 16), { separator: true }, { label: 'Construction menu…', action: openScreen }];
  };
  out.push({ label: 'Build here…', submenu: fits });
  return out;
}

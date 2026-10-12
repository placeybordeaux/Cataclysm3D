// BN's display names for Use ▸ submenu entries, in the ui2 `u` apply picker / right-click
// menu (src/ui2/bn/model.ts) and the legacy inventory_ui.ts apply picker. BN's own priority
// (item_action.cpp iuse_actor::get_name, item_action_generator::get_action_name):
//   1. the use_action's own "menu_text" (set_name / display_name — per use_action, not per type)
//   2. data/json/item_actions.json's "name" for the action id (extracted into misc.item_action)
//   3. the raw id — which is the bug this fixes: ui2 was showing "CHOP TREE", "PORTABLE GAME".
// itemActionName() (src/game/inventory.ts) implements steps 2-3, recording anything it had to
// fall back on in itemActionNameFallbacks so the sweep test below fails loudly instead of a
// menu quietly showing an unnamed action.
import { describe, expect, it } from 'vitest';
import { Character } from '../src/game/character';
import { createItem } from '../src/game/item';
import { itemActionName, itemActionNameFallbacks, useActions } from '../src/game/inventory';
import { upsToggleLabel } from '../src/game/upsTransfer';
import { installNature } from '../src/nature';
import { Game } from '../src/game/game';
import { BnInventoryModel } from '../src/ui2/bn/model';
import { applyPickerChoice } from '../src/ui2/bn/install';
import { useActionLabel } from '../src/ui/inventory_ui';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data } = loadNodeData();

function stubInput(): any {
  return { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
}

/** A Game with nature installed (registers the AXE/DIG/... quality use_actions, e.g. an axe's
 * CHOP_TREE/CHOP_LOGS/LUMBER), the only prerequisite these labels need. */
function makeGame(seed = 1): Game {
  const game = new Game(data, seed, stubInput());
  installNature(game, null);
  return game;
}

describe('item action names (BN item_actions.json, menu_text overrides)', () => {
  it("an axe's tool-quality actions show BN's names, not the raw CHOP_TREE/CHOP_LOGS/LUMBER ids", () => {
    makeGame();
    const axe = createItem(data, 'ax');
    const names = useActions(axe.def).map((ua) => itemActionName(data, ua.type));
    expect(names).toEqual(expect.arrayContaining(['Chop down a tree', 'Chop a Tree Trunk into logs', 'Cut a log into planks']));
  });

  it("the ui2 Use submenu (model.actions / applyPickerChoice) shows the axe's real names too", () => {
    const game = makeGame();
    game.player.inv.wield(createItem(data, 'ax'), null);
    const model = new BnInventoryModel(() => ({ who: game.player, map: game.map, at: { x: game.player.tileX, y: game.player.tileY, z: game.player.z } }));
    model.refresh();
    const hands = model.contents('hands')[0];
    const choice = applyPickerChoice(model, hands, 'hands');
    if (choice?.kind !== 'submenu') throw new Error('expected the axe to offer a Use submenu');
    const labels = choice.items.map((i) => ('label' in i ? i.label : ''));
    expect(labels).toEqual(expect.arrayContaining(['Chop down a tree', 'Chop a Tree Trunk into logs', 'Cut a log into planks']));
  });

  it('the legacy v1 inventory_ui.ts apply picker (useActionLabel) shows the same real names', () => {
    makeGame();
    const axe = createItem(data, 'ax');
    const labels = useActions(axe.def).map((ua) => useActionLabel(axe, ua));
    expect(labels).toEqual(expect.arrayContaining(['Chop down a tree', 'Chop a Tree Trunk into logs', 'Cut a log into planks']));
    // menu_text still overrides it here too.
    const stick = createItem(data, 'l-stick_on');
    const ua = useActions(stick.def).find((u) => u.type === 'transform')!;
    expect(useActionLabel(stick, ua)).toBe('Turn off');
  });

  it('handheld game system: PORTABLE_GAME shows "Play", not "PORTABLE GAME"', () => {
    const g = createItem(data, 'portable_game');
    const ua = useActions(g.def).find((u) => u.type === 'PORTABLE_GAME');
    expect(ua).toBeTruthy();
    expect(itemActionName(data, ua!.type)).toBe('Play');
    expect(itemActionNameFallbacks.has('PORTABLE_GAME')).toBe(false);
  });

  it('a menu_text override on a use_action wins over its item_actions.json name', () => {
    // l-stick_on (lit glowstick): a "transform" use_action with menu_text "Turn off" — BN's
    // plain item_actions.json name for "transform" is just "Transform".
    const stick = createItem(data, 'l-stick_on');
    const ua = useActions(stick.def).find((u) => u.type === 'transform');
    expect(ua?.menu_text).toBe('Turn off');
    expect(itemActionName(data, 'transform')).toBe('Transform');
  });

  it("repair_item's registered action is its item_action_type (repair_metal/repair_fabric), BN's JSON-load-time rewrite (item_factory.cpp usage_from_object)", () => {
    // A forge repairs metal; BN authors it as a "repair_item" use_action with
    // item_action_type: "repair_metal" and no own name, so item_action_generator never sees
    // a bare "repair_item" id — the actual registered action (and its name) is "repair_metal".
    const forge = createItem(data, 'forge');
    const types = useActions(forge.def).map((u) => u.type);
    expect(types).not.toContain('repair_item');
    expect(types).toContain('repair_metal');
    expect(itemActionName(data, 'repair_metal')).toBe('Repair metal/plastic/kevlar');
  });

  it("UPS toggle keeps its own dynamic enable/disable wording — BN's static item_actions.json name for TOGGLE_UPS_CHARGING ('Enable/disable UPS charging') must not replace it", () => {
    const game = makeGame();
    game.player.inv.wear(createItem(data, 'backpack'), null); // room in 'inv', not hands/ground
    const device = createItem(data, 'portable_game');
    game.player.inv.giveNew(device);
    expect(upsToggleLabel(device)).toBe('Enable UPS charging');
    const idx = useActions(device.def).findIndex((u) => u.type === 'TOGGLE_UPS_CHARGING');
    expect(game.player.inv.use(device, undefined, idx).ok).toBe(true);
    expect(upsToggleLabel(device)).toBe('Disable UPS charging');
    // ...and the ui2 submenu shows that dynamic label too, not item_actions.json's static one.
    const model = new BnInventoryModel(() => ({ who: game.player, map: game.map, at: { x: game.player.tileX, y: game.player.tileY, z: game.player.z } }));
    model.refresh();
    const view = model.contents('inv').find((v) => v.typeId === 'portable_game')!;
    expect(view).toBeTruthy();
    const choice = applyPickerChoice(model, view, 'inv');
    if (choice?.kind !== 'submenu') throw new Error('expected the handheld game to offer a Use submenu');
    const labels = choice.items.map((i) => ('label' in i ? i.label : ''));
    expect(labels).toContain('Disable UPS charging');
    expect(labels).not.toContain('Enable/disable UPS charging');
  });

  it('sweep: every use_action type actually present on an item has a BN name (item_actions.json or menu_text) — no silent fallback to a readable id', () => {
    makeGame(); // registers the quality-granted actions (AXE/DIG/... -> CHOP_TREE etc) too
    itemActionNameFallbacks.clear();
    const seen = new Set<string>();
    for (const def of Object.values(data.items)) {
      const raw = def.use_action;
      if (!raw) continue;
      for (const ua of useActions(def)) {
        seen.add(ua.type);
        if (typeof (ua as { menu_text?: unknown }).menu_text === 'string' && (ua as { menu_text?: string }).menu_text) continue;
        itemActionName(data, ua.type);
      }
    }
    expect(seen.size).toBeGreaterThan(50); // sanity: we actually walked real data
    expect([...itemActionNameFallbacks]).toEqual([]);
  });
});

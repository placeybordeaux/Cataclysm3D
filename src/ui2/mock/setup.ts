// Wires the mock inventory (store + model + hotbar + toasts) the same way for the showcase
// page and the in-game Tab placeholder, so both behave identically.

import { containerPanel, splitPrompt } from '../containers';
import { confirmModal } from '../modal';
import { toast } from '../toast';
import { Hotbar } from '../hotbar';
import { itemTooltip } from '../tooltip';
import { setLooksLike } from '../icons';
import type { ItemView } from '../logic/items';
import { INVENTORY_GROUP } from '../inventory_screen';
import { buildMockKit, DOLL_SLOTS, type RawItems } from './data';
import { MockInventoryModel } from './model';

export interface MockSetup {
  model: MockInventoryModel;
  hotbar: Hotbar;
}

export function setupMockInventory(raw: RawItems, hotbarKey: string): MockSetup {
  setLooksLike((id) => raw[id]?.looks_like);
  const kit = buildMockKit(raw);
  let hotbar: Hotbar;
  const model: MockInventoryModel = new MockInventoryModel(kit, {
    openContainer: (loc, item) =>
      void containerPanel(model, loc, { id: `inv.c.${item.id}`, group: INVENTORY_GROUP, pauses: true, title: item.name, icon: item.icon, width: 'calc(var(--cell) * 5 + var(--gap) * 4 + var(--u) * 18)' }),
    notify: (text, tone) => void toast({ category: tone === 'bad' || tone === 'warn' ? 'warning' : 'info', title: text }),
    bindHotbar: (slot, item) => hotbar.bind(slot, item),
    confirm: (title, body, ok) => confirmModal({ title, body, ok, danger: true }),
    split: (item) => void splitPrompt(model, item),
  });

  /** Everything you carry of a type (worn, wielded, inside worn containers), as one stack. */
  const carriedOf = (typeId: string): ItemView | null => {
    let first: ItemView | null = null;
    let n = 0;
    const visit = (it: ItemView) => {
      if (it.typeId === typeId) {
        first ??= it;
        n += it.count;
      }
      for (const c of it.contents ?? []) visit(c);
    };
    for (const s of DOLL_SLOTS) for (const it of model.contents(kit.slot(s.id))) visit(it);
    return first ? { ...(first as ItemView), count: n } : null;
  };
  hotbar = new Hotbar({
    storageKey: hotbarKey,
    resolve: carriedOf,
    use: (b, item) => {
      if (!item) return void toast({ category: 'warning', title: `You have no ${b.name} left.` });
      // Find the real instance and run its primary action (eat, wield, open…).
      const found = model.store.find(item.id);
      if (found) model.use(found.item, found.loc);
    },
    tooltip: (it) => itemTooltip(it, { compare: model.compareWith(it, 'ground'), hints: ['Click or its number: use', 'Drag off: unbind'] }),
  });
  // A sensible first-run hotbar (only when nothing is stored yet).
  if (!hotbar.binding(0) && !hotbar.binding(1)) {
    const firstCarried = (id: string) => carriedOf(id);
    const defaults = ['bat', 'water_clean', 'bandages', 'granola', 'flashlight'].map(firstCarried).filter((x): x is ItemView => !!x);
    defaults.forEach((it, i) => hotbar.bind(i, it));
  }
  model.onChange(() => hotbar.refresh());
  return { model, hotbar };
}

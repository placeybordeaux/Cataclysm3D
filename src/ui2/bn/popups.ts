// Small ui2 surfaces around the inventory: the quick picker behind the old action keys
// (z wield, O wear, E eat, q drop, T take off, U unload, u use), the liquid menu (pour into a
// container / drink / pour out: BN liquid_handler, on the UI-free src/game/liquid.ts), and the
// examine card.

import { h } from '../dom';
import { iconEl } from '../icons';
import { openContextMenu, type MenuItem } from '../menu';
import { confirmModal } from '../modal';
import { scrollList } from '../widgets';
import { closeGroup, openPanel } from '../window';
import { attachTooltip, itemTooltip } from '../tooltip';
import { fmtDuration, type ItemView } from '../logic/items';
import type { Item } from '../../game/item';
import { isAt, type Loc } from '../../game/moves';
import { drinkable, drinkLiquid, liquidTargets, pourInto, pourOnGround, type LiquidHost } from '../../game/liquid';
import type { BnInventoryModel } from './model';

export interface PickRow {
  view: ItemView;
  loc: string;
  /** Greyed with the reason (still listed, so the player sees why). */
  disabled?: string;
  /** Seconds the action takes. */
  time?: number;
}

export const PICKER_GROUP = 'picker';

/**
 * A focused list of the items an action applies to, like BN's single-purpose menus but
 * clickable: arrows + Enter, click, or double-click. Picking runs `run` and closes.
 */
export function openPicker(model: BnInventoryModel, o: { title: string; none: string; rows: PickRow[]; run(r: PickRow): void; note?: string; onNone?(msg: string): void; closeKeys?: string[] }): boolean {
  if (!o.rows.length) {
    o.onNone?.(o.none);
    return false;
  }
  closeGroup(PICKER_GROUP);
  const rows = [...o.rows].sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
  let done = false;
  const pick = (r: PickRow) => {
    if (r.disabled || done) return;
    done = true;
    p.close();
    o.run(r);
  };
  const list = scrollList<PickRow>({
    items: rows,
    render: (r) => {
      const row = h(
        'div',
        { class: `bn-pick-row${r.disabled ? ' off' : ''}` },
        iconEl(r.view.icon, 'row'),
        h('span', { class: 'bn-pick-name', text: r.view.count > 1 ? `${r.view.name} ×${r.view.count}` : r.view.name }),
        h('span', { class: 'bn-pick-where', text: model.where(r.loc) }),
        h('span', { class: 'bn-pick-time', text: r.disabled ? '' : r.time ? fmtDuration(r.time) : '' }),
      );
      attachTooltip(row, () => (r.disabled ? r.disabled : itemTooltip(r.view, { where: model.where(r.loc), compare: model.compareWith(r.view, r.loc), hints: ['Click / Enter: choose'] })));
      row.addEventListener('click', () => pick(r));
      return row;
    },
    onActivate: pick,
  });
  const p = openPanel({
    id: 'inv.picker', title: o.title, group: PICKER_GROUP, pauses: true,
    width: 'calc(var(--fs) * 30 + var(--row-icon) * 2)',
    footer: o.note ?? '↑↓ Enter: choose · Esc: cancel · Tab: full inventory',
    // Like every menu: the key that opened it closes it, and so does Backspace.
    onKey: (e) => {
      if (e.repeat || !(e.key === 'Backspace' || o.closeKeys?.includes(e.key))) return false;
      p.close();
      return true;
    },
  });
  p.body.append(list.el);
  // Centre it: it's a question, not a window you arrange.
  const r = p.el.getBoundingClientRect();
  p.moveTo(Math.round((innerWidth - r.width) / 2), Math.round((innerHeight - r.height) / 3));
  list.el.focus();
  return true;
}

/**
 * What to do with a liquid (in its container, or loose): pour into something that takes it,
 * drink it, or pour it out. Whatever's left asks again.
 */
export function liquidMenu(host: LiquidHost, liquid: Item, from: Loc, source: Item | null, at: { x: number; y: number }, done?: () => void): void {
  if (!isAt(liquid, from)) return;
  const again = (left: Item | null) => {
    done?.();
    if (left && isAt(left, from)) setTimeout(() => liquidMenu(host, left, from, source, at, done), 0);
  };
  const targets = liquidTargets(host, liquid, source ?? undefined, from);
  const items: MenuItem[] = [
    ...(targets.length ? [{ header: 'Pour into' } as MenuItem] : []),
    ...targets.map((t): MenuItem => ({
      label: `${t.item.name()}${t.room < liquid.charges ? ` (${t.room} fit)` : ''}`,
      icon: { typeId: t.item.typeId, looksLike: t.item.def.looks_like, symbol: t.item.def.symbol, color: t.item.def.color },
      action: () => again(isAt(liquid, from) ? pourInto(host, liquid, t.item, from) : null),
    })),
    ...(targets.length ? [{ separator: true } as MenuItem] : []),
    ...(drinkable(liquid) ? [{ label: 'Drink from your hands', key: 'E', action: () => again(isAt(liquid, from) ? drinkLiquid(host, liquid, from) : null) } as MenuItem] : []),
    {
      label: 'Pour onto the ground', danger: true, key: 'P',
      action: async () => {
        if (!(await confirmModal({ title: 'Pour it out?', body: `The ${liquid.name()} will soak into the ground; it can't be picked up again.`, ok: 'Pour it out', danger: true }))) return;
        if (isAt(liquid, from)) pourOnGround(host, liquid, from);
        done?.();
      },
    },
  ];
  openContextMenu(at, items, { title: `What to do with the ${liquid.name()}?` });
}

/** The full item info (the v1 text, CDDA colours) in a ui2 window. */
export function examineCard(html: string, title: string): void {
  const p = openPanel({ id: 'inv.examine', title, group: 'examine', pauses: true, width: 'calc(var(--fs) * 38)' });
  p.setTitle(title);
  p.body.replaceChildren(h('div', { class: 'bn-examine', html }));
}

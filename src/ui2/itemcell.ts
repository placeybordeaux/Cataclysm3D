// Item cells: how an item looks in a grid (icon well with count, condition pip bar, corner
// badges) or in a list row (icon, name, count, weight/volume, condition). Pure presentation:
// interaction (drag, click, menus, tooltip) is wired by whoever owns the cell — usually
// containerView() in containers.ts.

import { h } from './dom';
import { iconEl } from './icons';
import { fmtVolume, fmtWeight, totalVolume, totalWeight, type ItemView } from './logic/items';
import { conditionLabel } from './tooltip';

export type CellMode = 'grid' | 'row';

export function itemCell(it: ItemView, mode: CellMode): HTMLElement {
  return mode === 'grid' ? gridCell(it) : rowCell(it);
}

function condBar(it: ItemView): HTMLElement | null {
  if (it.condition === undefined) return null;
  const [, tone] = conditionLabel(it.condition);
  return h('div', { class: 'ui2-cell-cond' }, h('div', { class: `tone-${tone}`, style: { width: `${Math.round(it.condition * 100)}%` } }));
}

function chargeBar(it: ItemView): HTMLElement | null {
  if (!it.charges) return null;
  const f = it.charges.max > 0 ? it.charges.cur / it.charges.max : 0;
  return h('div', { class: 'ui2-cell-charge' }, h('div', { style: { width: `${Math.round(f * 100)}%` } }));
}

function badges(it: ItemView): HTMLElement | null {
  if (!it.badges?.length) return null;
  return h('div', { class: 'ui2-cell-badges' }, ...it.badges.map((b) => h('span', { class: `ui2-badge tone-${b.tone ?? 'dim'}`, text: b.text })));
}

function gridCell(it: ItemView): HTMLElement {
  return h(
    'div',
    { class: 'ui2-cell grid', data: { item: it.id } },
    iconEl(it.icon, 'grid'),
    badges(it),
    it.count > 1 ? h('span', { class: 'ui2-cell-count', text: it.count > 9999 ? '9k+' : String(it.count) }) : null,
    it.contents?.length ? h('span', { class: 'ui2-cell-contents', text: String(it.contents.length), title: 'Holds items' }) : null,
    condBar(it),
    chargeBar(it),
  );
}

function rowCell(it: ItemView): HTMLElement {
  return h(
    'div',
    { class: 'ui2-cell row', data: { item: it.id } },
    iconEl(it.icon, 'row'),
    h(
      'div',
      { class: 'ui2-row-main' },
      h('div', { class: 'ui2-row-name' }, h('span', { text: it.name }), it.count > 1 ? h('span', { class: 'ui2-row-count', text: ` ×${it.count}` }) : null, badges(it)),
      condBar(it),
    ),
    h('span', { class: 'ui2-row-num', text: fmtWeight(totalWeight(it)) }),
    h('span', { class: 'ui2-row-num', text: fmtVolume(totalVolume(it)) }),
  );
}

/** An empty equipment/hotbar well with a faint label ("Head", "3"). */
export function emptySlot(label: string, mode: CellMode = 'grid'): HTMLElement {
  return h('div', { class: `ui2-cell ${mode} empty` }, h('span', { class: 'ui2-slot-label', text: label }));
}

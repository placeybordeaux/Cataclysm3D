// Container views: a location's items as a grid or list, wired for everything the
// interaction rules promise (docs/UI2.md):
//   drag → move (any registered target)       double-click / Enter → use
//   right-click / Menu key → context menu     Shift-click → quick move
//   Ctrl-click → split stack (count prompt)   hover → item tooltip with compare
//   arrows → keyboard cursor                  drop on a container item → put it inside
// plus capacity bars for the location. containerPanel() puts one in a window.

import { h } from './dom';
import { makeDraggable, registerDropTarget, flashNote, type DragPayload, type DropTarget } from './dragdrop';
import { itemCell, type CellMode } from './itemcell';
import { fmtVolume, fmtWeight, type ItemView } from './logic/items';
import { gridColumns } from './logic/layout';
import { openContextMenu } from './menu';
import { countPrompt } from './modal';
import type { InventoryModel } from './model';
import { attachTooltip, itemTooltip } from './tooltip';
import { capacityBar, type Bar } from './widgets';
import { defaultSplit } from './logic/dnd';
import { openPanel, type Panel, type PanelOpts } from './window';
import { iconEl } from './icons';
import { overlayOpen } from './host';

export interface ContainerView {
  el: HTMLElement;
  refresh(): void;
  setMode(m: CellMode): void;
  mode: CellMode;
  destroy(): void;
}

/** Drop target for a whole location (panel body, slot, container cell). */
export function locationTarget(model: InventoryModel, loc: string, el: HTMLElement, verb?: string): DropTarget {
  return {
    el,
    id: loc,
    check: (p, n) => (p.from.startsWith('hotbar:') ? { kind: 'noop' } : model.check(p.item.id, loc, n)),
    drop: (p, n) => {
      const r = model.move(p.item.id, loc, n);
      if (!r.ok) {
        const b = el.getBoundingClientRect();
        flashNote(b.left + b.width / 2, b.top + b.height / 2, r.reason, 'bad');
      }
    },
    label: () => verb ?? (loc === 'ground' ? 'Drop' : `Put in ${model.name(loc)}`),
  };
}

/** Wire one item cell: drag source, clicks, menu, tooltip; container items are targets too. */
export function wireItemCell(model: InventoryModel, loc: string, it: ItemView, cell: HTMLElement, onSelect?: () => void): () => void {
  const payload = (): DragPayload => ({ item: it, count: it.count, from: loc });
  makeDraggable(cell, {
    payload,
    onClick: (e) => {
      if (e.shiftKey) {
        const to = model.quickMoveTarget(it, loc);
        if (!to) return flashNote(e.clientX, e.clientY, 'Nowhere to move it', 'warn');
        const r = model.move(it.id, to, it.count);
        if (!r.ok) flashNote(e.clientX, e.clientY, r.reason, 'bad');
      } else if (e.ctrlKey || e.metaKey) {
        void splitPrompt(model, it);
      } else onSelect?.();
    },
    onDoubleClick: () => model.use(it, loc),
    onContext: (e) => openContextMenu({ x: e.clientX, y: e.clientY }, model.actions(it, loc), { title: it.count > 1 ? `${it.name} ×${it.count}` : it.name }),
  });
  attachTooltip(cell, () => itemTooltip(it, { compare: model.compareWith(it, loc), where: model.where(loc) }));
  const inside = model.insideOf(it);
  return inside ? registerDropTarget(locationTarget(model, inside, cell)) : () => {};
}

export async function splitPrompt(model: InventoryModel, it: ItemView): Promise<void> {
  if (it.count < 2) return;
  const n = await countPrompt({ title: 'Split stack', subtitle: `${it.name} ×${it.count}`, max: it.count - 1, initial: defaultSplit(it.count), icon: it.icon, ok: 'Split' });
  if (n !== null) model.split(it.id, n);
}

export function containerView(model: InventoryModel, loc: string, opts: { mode?: CellMode; empty?: string } = {}): ContainerView {
  const el = h('div', { class: 'ui2-container', attrs: { tabindex: '0' } });
  let mode: CellMode = opts.mode ?? 'grid';
  let sel = -1;
  let cleanups: (() => void)[] = [];
  let items: ItemView[] = [];
  const unregister = registerDropTarget(locationTarget(model, loc, el));

  const render = () => {
    for (const c of cleanups) c();
    cleanups = [];
    try {
      items = model.contents(loc).slice();
    } catch {
      // The container itself is gone (used up); its panel closes on the same change.
      el.replaceChildren(h('div', { class: 'ui2-empty', text: '(gone)' }));
      return;
    }
    el.className = `ui2-container ${mode}`;
    if (!items.length) {
      el.replaceChildren(h('div', { class: 'ui2-empty', text: opts.empty ?? 'Empty — drag items here' }));
      return;
    }
    sel = Math.min(sel, items.length - 1);
    el.replaceChildren(
      ...items.map((it, i) => {
        const cell = itemCell(it, mode);
        cell.classList.toggle('selected', i === sel);
        cleanups.push(wireItemCell(model, loc, it, cell, () => select(i)));
        return cell;
      }),
    );
  };
  const select = (i: number) => {
    sel = Math.max(0, Math.min(items.length - 1, i));
    [...el.children].forEach((c, j) => c.classList.toggle('selected', j === sel));
    (el.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  };
  el.addEventListener('keydown', (e) => {
    if (!items.length || overlayOpen()) return;
    const cell = el.children[Math.max(0, sel)] as HTMLElement | undefined;
    const cols = mode === 'grid' && cell ? gridColumns(el.clientWidth, cell.offsetWidth, 0) : 1;
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -1e6, End: 1e6 };
    const it = items[sel];
    if (moves[e.key] !== undefined) select((sel < 0 ? 0 : sel) + moves[e.key]);
    else if (e.key === 'Enter' && it) model.use(it, loc);
    else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && it && cell) {
      const r = cell.getBoundingClientRect();
      openContextMenu({ x: r.left + r.width / 2, y: r.bottom }, model.actions(it, loc), { title: it.name });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const off = model.onChange(render);
  render();
  return {
    el,
    get mode() {
      return mode;
    },
    refresh: render,
    setMode(m) {
      mode = m;
      render();
    },
    destroy() {
      off();
      unregister();
      for (const c of cleanups) c();
    },
  };
}

/** Weight + volume bars for a location (hidden for unlimited ones). */
export function capacityBars(model: InventoryModel, loc: string): { el: HTMLElement; refresh(): void } {
  const vol: Bar = capacityBar('Volume', fmtVolume);
  const wt: Bar = capacityBar('Weight', fmtWeight);
  const el = h('div', { class: 'ui2-caps' }, vol.el, wt.el);
  const refresh = () => {
    const c = model.capacity(loc);
    el.style.display = c ? '' : 'none';
    if (!c) return;
    vol.set(...c.volume);
    wt.set(...c.weight);
  };
  refresh();
  return { el, refresh };
}

/**
 * A window showing one location: capacity bars, the item grid/list, a grid/list toggle.
 * Closes itself if the location disappears (a container item that no longer exists).
 */
export function containerPanel(model: InventoryModel, loc: string, panel: Omit<PanelOpts, 'title'> & { title?: string; mode?: CellMode }): Panel {
  const caps = capacityBars(model, loc);
  const modeKey = `cdda3d.ui2.mode.${panel.id}`;
  let initial: CellMode = panel.mode ?? 'grid';
  try {
    const m = localStorage.getItem(modeKey);
    if (m === 'grid' || m === 'row') initial = m;
  } catch {
    // default mode
  }
  const view = containerView(model, loc, { mode: initial });
  const toggle = h('button', { class: 'ui2-iconbtn ui2-no-drag', title: 'Grid / list view' });
  const setToggle = () => (toggle.textContent = view.mode === 'grid' ? '☰' : '▦');
  toggle.addEventListener('click', () => {
    view.setMode(view.mode === 'grid' ? 'row' : 'grid');
    setToggle();
    try {
      localStorage.setItem(modeKey, view.mode);
    } catch {
      // not persisted
    }
  });
  setToggle();
  const p = openPanel({ ...panel, title: panel.title ?? model.name(loc), titleExtras: [toggle, ...(panel.titleExtras ?? [])], onClose: () => (off(), view.destroy(), panel.onClose?.()) });
  p.body.append(caps.el, view.el);
  const off = model.onChange(() => {
    try {
      model.name(loc);
    } catch {
      p.close();
      return;
    }
    caps.refresh();
  });
  return p;
}

/** Title-bar style label with an icon, for panel sections. */
export function sectionLabel(text: string, item?: ItemView): HTMLElement {
  return h('div', { class: 'ui2-section' }, item ? iconEl(item.icon, 'row') : null, h('span', { text }));
}

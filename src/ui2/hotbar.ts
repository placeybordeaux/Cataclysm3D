// Hotbar: ten slots bound to keys 1…9, 0. Drag an item onto a slot to bind it (the item
// doesn't move; the slot remembers its *type* and shows how many you have), click or press
// the key to use it, drag a slot onto another to swap, drag it off to unbind, right-click
// for Use / Clear. Bindings persist per storage key.

import { h, ui2Layers } from './dom';
import { flashNote, makeDraggable, registerDropTarget } from './dragdrop';
import { iconEl } from './icons';
import type { IconRef, ItemView } from './logic/items';
import { openContextMenu } from './menu';
import { attachTooltip, itemTooltip } from './tooltip';

export interface HotbarBinding {
  typeId: string;
  name: string;
  icon?: IconRef;
}

export interface HotbarOpts {
  /** Where the bindings persist (localStorage key). */
  storageKey: string;
  /** Current stock of a bound type (aggregated count), or null when none is left. */
  resolve(typeId: string): ItemView | null;
  /** Use the bound item (null when you have none: the owner explains). */
  use(binding: HotbarBinding, item: ItemView | null, slot: number): void;
  /** Tooltip extras (compare with equipped…). */
  tooltip?(item: ItemView): HTMLElement;
}

export const HOTBAR_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export class Hotbar {
  readonly el: HTMLElement;
  private slots: (HotbarBinding | null)[];
  private cells: HTMLElement[] = [];

  constructor(private o: HotbarOpts) {
    this.slots = this.load();
    this.el = h('div', { class: 'ui2-hotbar' });
    HOTBAR_KEYS.forEach((k, i) => {
      const cell = h('div', { class: 'ui2-hot-slot', data: { slot: String(i) } });
      this.cells.push(cell);
      this.el.appendChild(cell);
      registerDropTarget({
        el: cell,
        id: `hotbar:${i}`,
        check: (p) => (p.from === `hotbar:${i}` ? { kind: 'noop' } : { kind: 'ok', count: p.count }),
        drop: (p) => {
          const from = p.from.startsWith('hotbar:') ? Number(p.from.slice(7)) : -1;
          const b: HotbarBinding = { typeId: p.item.typeId, name: p.item.name, icon: p.item.icon };
          if (from >= 0) [this.slots[i], this.slots[from]] = [this.slots[from], this.slots[i]];
          else {
            // One binding per type: binding it again moves it here.
            this.slots = this.slots.map((s) => (s?.typeId === b.typeId ? null : s));
            this.slots[i] = b;
          }
          this.save();
          this.refresh();
        },
        label: () => `Bind to ${k}`,
      });
      makeDraggable(cell, {
        payload: () => {
          const b = this.slots[i];
          if (!b) return null;
          const it = this.o.resolve(b.typeId) ?? { id: `hotbar-${i}`, typeId: b.typeId, name: b.name, count: 1, stackable: false, weight: 0, volume: 0, icon: b.icon };
          return { item: it, count: 1, from: `hotbar:${i}` };
        },
        onClick: () => this.use(i),
        onDropNowhere: (_p, at) => {
          this.slots[i] = null;
          this.save();
          this.refresh();
          flashNote(at.x, at.y, 'Unbound', 'info');
        },
        onContext: (e) => {
          const b = this.slots[i];
          if (!b) return;
          openContextMenu({ x: e.clientX, y: e.clientY }, [
            { label: 'Use', key: k, primary: true, action: () => this.use(i), disabled: this.o.resolve(b.typeId) ? false : `You have no ${b.name}` },
            { separator: true },
            { label: 'Clear slot', action: () => ((this.slots[i] = null), this.save(), this.refresh()) },
          ], { title: b.name });
        },
      });
      attachTooltip(cell, () => {
        const b = this.slots[i];
        if (!b) return `Empty — drag an item here to bind it to ${k}`;
        const it = this.o.resolve(b.typeId);
        return it ? (this.o.tooltip?.(it) ?? itemTooltip(it, { hints: [`${k} or click: use`, 'Drag off: unbind'] })) : `${b.name}: none left`;
      });
    });
    this.refresh();
  }

  /** Show it in the HUD layer (bottom centre). */
  mount(): this {
    ui2Layers().hud.appendChild(this.el);
    return this;
  }

  unmount(): void {
    this.el.remove();
  }

  binding(i: number): HotbarBinding | null {
    return this.slots[i] ?? null;
  }

  bind(i: number, item: ItemView): void {
    this.slots[i] = { typeId: item.typeId, name: item.name, icon: item.icon };
    this.save();
    this.refresh();
  }

  /** 1…0: use that slot. Returns true if it was a hotbar key. */
  handleKey(e: KeyboardEvent): boolean {
    const i = HOTBAR_KEYS.indexOf(e.key);
    if (i < 0 || e.ctrlKey || e.altKey || e.metaKey) return false;
    if (!e.repeat) this.use(i);
    return true;
  }

  use(i: number): void {
    const b = this.slots[i];
    const cell = this.cells[i];
    cell.classList.remove('pressed');
    void cell.offsetWidth;
    cell.classList.add('pressed');
    if (!b) return;
    this.o.use(b, this.o.resolve(b.typeId), i);
    this.refresh();
  }

  refresh(): void {
    this.slots.forEach((b, i) => {
      const cell = this.cells[i];
      const it = b ? this.o.resolve(b.typeId) : null;
      cell.classList.toggle('bound', !!b);
      cell.classList.toggle('none-left', !!b && !it);
      cell.replaceChildren(
        h('span', { class: 'ui2-hot-key', text: HOTBAR_KEYS[i] }),
        ...(b ? [iconEl(b.icon, 'grid'), h('span', { class: 'ui2-cell-count', text: it ? (it.count > 1 ? String(it.count) : '') : '0' })] : []),
      );
    });
  }

  private load(): (HotbarBinding | null)[] {
    try {
      const v = JSON.parse(localStorage.getItem(this.o.storageKey) ?? '[]') as (HotbarBinding | null)[];
      if (Array.isArray(v)) return HOTBAR_KEYS.map((_, i) => v[i] ?? null);
    } catch {
      // corrupt: start empty
    }
    return HOTBAR_KEYS.map(() => null);
  }

  private save(): void {
    try {
      localStorage.setItem(this.o.storageKey, JSON.stringify(this.slots));
    } catch {
      // not persisted
    }
  }
}

// Small ui2 widgets: buttons, tabs, scroll list, capacity bars, progress bars.

import { h } from './dom';
import { iconEl } from './icons';
import { overlayOpen } from './host';
import type { IconRef, Tone } from './logic/items';

export interface ButtonOpts {
  icon?: IconRef;
  tone?: Tone;
  title?: string;
  disabled?: boolean | string;
  small?: boolean;
  /** Keyboard accelerator shown on the button ("Y"). The owner handles the key. */
  key?: string;
}

export function button(label: string, onClick: (e: MouseEvent) => void, o: ButtonOpts = {}): HTMLButtonElement {
  const b = h(
    'button',
    { class: `ui2-btn${o.small ? ' small' : ''}${o.tone ? ` tone-${o.tone}` : ''}`, title: typeof o.disabled === 'string' ? o.disabled : o.title },
    o.icon ? iconEl(o.icon, 'row') : null,
    h('span', { text: label }),
    o.key ? h('kbd', { text: o.key }) : null,
  );
  if (o.disabled) b.disabled = true;
  b.addEventListener('click', (e) => !b.disabled && onClick(e));
  return b;
}

export interface TabDef {
  id: string;
  label: string;
  icon?: IconRef;
  /** Small count/marker after the label. */
  badge?: string;
}

export interface Tabs {
  el: HTMLElement;
  active: string;
  set(id: string): void;
}

/** A tab strip. ←/→ move between tabs when it has focus; clicking selects. */
export function tabs(defs: TabDef[], active: string, onChange: (id: string) => void): Tabs {
  const el = h('div', { class: 'ui2-tabs', attrs: { role: 'tablist', tabindex: '0' } });
  const t: Tabs = {
    el,
    active,
    set(id) {
      if (!defs.some((d) => d.id === id)) throw new Error(`tabs: no tab ${id}`);
      t.active = id;
      render();
      onChange(id);
    },
  };
  const render = () =>
    el.replaceChildren(
      ...defs.map((d) =>
        h(
          'button',
          { class: `ui2-tab${d.id === t.active ? ' on' : ''}`, attrs: { role: 'tab' }, on: { click: () => t.set(d.id) } },
          d.icon ? iconEl(d.icon, 'row') : null,
          h('span', { text: d.label }),
          d.badge ? h('span', { class: 'ui2-tab-badge', text: d.badge }) : null,
        ),
      ),
    );
  el.addEventListener('keydown', (e) => {
    if (overlayOpen()) return;
    const i = defs.findIndex((d) => d.id === t.active);
    if (e.key === 'ArrowRight') t.set(defs[(i + 1) % defs.length].id);
    else if (e.key === 'ArrowLeft') t.set(defs[(i + defs.length - 1) % defs.length].id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  render();
  return t;
}

export interface ScrollList<T> {
  el: HTMLElement;
  setItems(items: T[]): void;
  selected(): T | undefined;
  select(i: number): void;
}

/**
 * A vertical list with a keyboard cursor: ↑/↓/PgUp/PgDn/Home/End move, Enter activates.
 * Rows are whatever `render` returns; the list adds hover/selection states.
 */
export function scrollList<T>(opts: { items: T[]; render: (it: T) => HTMLElement; onActivate?: (it: T) => void; onSelect?: (it: T) => void; empty?: string }): ScrollList<T> {
  let items = opts.items;
  let sel = 0;
  const el = h('div', { class: 'ui2-list', attrs: { tabindex: '0', role: 'listbox' } });
  const draw = () => {
    if (!items.length) {
      el.replaceChildren(h('div', { class: 'ui2-empty', text: opts.empty ?? 'Nothing here.' }));
      return;
    }
    el.replaceChildren(
      ...items.map((it, i) => {
        const row = opts.render(it);
        row.classList.add('ui2-list-row');
        row.classList.toggle('selected', i === sel);
        row.addEventListener('click', () => api.select(i));
        row.addEventListener('dblclick', () => opts.onActivate?.(it));
        return row;
      }),
    );
  };
  const api: ScrollList<T> = {
    el,
    setItems(next) {
      items = next;
      sel = Math.min(sel, Math.max(0, items.length - 1));
      draw();
    },
    selected: () => items[sel],
    select(i) {
      if (!items.length) return;
      sel = Math.max(0, Math.min(items.length - 1, i));
      el.querySelectorAll('.ui2-list-row').forEach((r, j) => r.classList.toggle('selected', j === sel));
      (el.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
      opts.onSelect?.(items[sel]);
    },
  };
  el.addEventListener('keydown', (e) => {
    if (overlayOpen()) return;
    const page = Math.max(1, Math.floor(el.clientHeight / ((el.firstElementChild as HTMLElement | null)?.offsetHeight || 20)));
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9 };
    if (moves[e.key] !== undefined) api.select(sel + moves[e.key]);
    else if (e.key === 'Enter' && items[sel]) opts.onActivate?.(items[sel]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  draw();
  return api;
}

export interface Bar {
  el: HTMLElement;
  set(used: number, max: number): void;
}

/**
 * Capacity bar: "Weight 12.4 / 30 kg". Turns warn at 80%, and over 100% shows the overflow
 * as a striped red segment (you *can* be overloaded; the bar must say so, not clip).
 */
export function capacityBar(label: string, fmt: (n: number) => string, opts: { icon?: string } = {}): Bar {
  const fill = h('div', { class: 'ui2-bar-fill' });
  const over = h('div', { class: 'ui2-bar-over' });
  const text = h('span', { class: 'ui2-bar-text' });
  const track = h('div', { class: 'ui2-bar ui2-cap-track' }, fill, over);
  const el = h('div', { class: 'ui2-cap' }, h('span', { class: 'ui2-cap-label', text: (opts.icon ? opts.icon + ' ' : '') + label }), track, text);
  return {
    el,
    set(used, max) {
      const f = max > 0 ? used / max : used > 0 ? Infinity : 0;
      // Over capacity: the bar is rescaled so the full length is `used`, max marks the limit.
      const scale = Math.max(1, f);
      fill.style.width = `${(Math.min(1, f) / scale) * 100}%`;
      over.style.left = `${(1 / scale) * 100}%`;
      over.style.width = f > 1 ? `${(1 - 1 / scale) * 100}%` : '0';
      el.classList.toggle('high', f >= 0.8 && f <= 1);
      el.classList.toggle('over', f > 1);
      text.textContent = `${fmt(used)} / ${fmt(max)}`;
      el.title = f > 1 ? `${label}: over by ${fmt(used - max)}` : `${label}: ${fmt(Math.max(0, max - used))} free`;
    },
  };
}

/** A plain 0..1 bar with a label ("Condition", reading progress). */
export function progressBar(tone: Tone = 'accent'): { el: HTMLElement; set(v: number, label?: string): void } {
  const fill = h('div', { class: `ui2-bar-fill tone-${tone}` });
  const text = h('span', { class: 'ui2-bar-label' });
  const el = h('div', { class: 'ui2-bar ui2-progress' }, fill, text);
  return {
    el,
    set(v, label) {
      fill.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
      if (label !== undefined) text.textContent = label;
    },
  };
}

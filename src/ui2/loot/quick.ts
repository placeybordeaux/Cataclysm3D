// The crosshair loot panel (Skyrim / Fallout style): look at a pile, a locker, a body or an
// open trunk within reach and its contents show next to the crosshair, without leaving
// mouse-look. In the "quick" looting style it's interactive (wheel / ↑↓ select, the interact
// key takes, the reload key takes all, the inventory key opens the full screen on it); in the
// other styles it's a read-only peek at the top items. Pure view: install.ts owns the state.

import { h, ui2Layers } from '../dom';
import { iconEl } from '../icons';
import { fmtVolume, fmtWeight, type ItemView } from '../logic/items';

export interface QuickSpec {
  mode: 'quick' | 'peek';
  title: string;
  rows: ItemView[];
  /** Selected row (quick mode). */
  sel: number;
  /** Rows that won't come along as they are (id → short reason: "no room", "too heavy"). */
  bad: Map<string, string>;
  /** Under the list: why the selected thing won't fit, or that the bag is full. */
  warn: { text: string; tone: 'bad' | 'warn' } | null;
  /** Carried volume / weight, used and capacity (ml, g). */
  bars: { volume: [number, number]; weight: [number, number] } | null;
  /** The weight the selected item would add (marker on the weight bar). */
  adds: { volume: number; weight: number } | null;
  keys: [key: string, what: string][];
  /** Result of the last take ("Took 3 things"), shown for a moment. */
  flash: { text: string; tone: 'good' | 'warn' | 'bad' } | null;
  /** Shown instead of the list when there's nothing inside. */
  empty: string;
  /** How many things are there (a stack of 40 rounds is one; three cans are three). */
  total: number;
}

/** Rows visible at once; the list scrolls with the selection. */
const VISIBLE = { quick: 6, peek: 4 };

export function quickPanel(): { el: HTMLElement; show(s: QuickSpec): void; hide(): void; shown(): boolean } {
  const el = h('div', { class: 'lq', attrs: { 'data-testid': 'quick-loot' } });
  el.style.display = 'none';
  ui2Layers().hud.appendChild(el);
  let last = '';
  let shown = false;
  return {
    el,
    shown: () => shown,
    hide() {
      if (!shown) return;
      shown = false;
      last = '';
      el.style.display = 'none';
    },
    show(s) {
      shown = true;
      el.style.display = '';
      el.className = `lq ${s.mode}`;
      const sig = JSON.stringify([s.mode, s.title, s.rows.map((r) => [r.id, r.name, r.count]), s.sel, [...s.bad], s.warn, s.bars, s.adds, s.keys, s.flash, s.total]);
      if (sig !== last) {
        last = sig;
        el.replaceChildren(...render(s));
      }
      // Right of the crosshair, the list's first row level with it; snapped to whole pixels.
      const cx = Math.round(innerWidth / 2), cy = Math.round(innerHeight / 2);
      const gap = Math.max(28, Math.round(innerHeight * 0.035));
      el.style.left = `${cx + gap}px`;
      el.style.top = `${Math.max(8, Math.min(innerHeight - el.offsetHeight - 8, cy - Math.round(el.offsetHeight * 0.3)))}px`;
    },
  };
}

function render(s: QuickSpec): HTMLElement[] {
  const out: HTMLElement[] = [];
  const total = s.total;
  out.push(h('div', { class: 'lq-head' }, h('span', { class: 'lq-title', text: s.title }), s.rows.length ? h('span', { class: 'lq-n', text: `${total} item${total === 1 ? '' : 's'}` }) : null));
  if (!s.rows.length) out.push(h('div', { class: 'lq-empty', text: s.empty }));
  else {
    const n = VISIBLE[s.mode];
    const start = s.mode === 'quick' ? Math.max(0, Math.min(s.sel - Math.floor(n / 2), s.rows.length - n)) : 0;
    const rows = h('div', { class: 'lq-rows' });
    if (start > 0) rows.append(h('div', { class: 'lq-more', text: `▲ ${start} more` }));
    s.rows.slice(start, start + n).forEach((r, i) => {
      const idx = start + i;
      const bad = s.bad.get(r.id);
      rows.append(h('div', { class: `lq-row${s.mode === 'quick' && idx === s.sel ? ' sel' : ''}${bad ? ' bad' : ''}`, attrs: { 'data-item': r.id, 'data-type': r.typeId } },
        iconEl(r.icon, 'row'),
        h('span', { class: 'lq-name', text: r.name }),
        r.count > 1 ? h('span', { class: 'lq-count', text: `×${r.count}` }) : null,
        h('span', { class: 'lq-wt', text: fmtWeight(r.weight * r.count) })));
    });
    const rest = s.rows.length - start - n;
    if (rest > 0) rows.append(h('div', { class: 'lq-more', text: `▼ ${rest} more` }));
    out.push(rows);
  }
  if (s.warn) out.push(h('div', { class: `lq-warn tone-${s.warn.tone}`, text: s.warn.text }));
  if (s.flash) out.push(h('div', { class: `lq-flash tone-${s.flash.tone}`, text: s.flash.text }));
  if (s.bars) {
    const bar = (used: number, max: number, add: number) => {
      const frac = max > 0 ? used / max : 1;
      const b = h('div', { class: `lq-bar${frac >= 1 ? ' full' : frac >= 0.8 ? ' warn' : ''}` }, h('i'));
      (b.firstChild as HTMLElement).style.width = `${Math.min(100, frac * 100)}%`;
      if (add > 0 && max > 0) {
        const m = h('b');
        m.style.left = `${Math.min(100, ((used + add) / max) * 100)}%`;
        b.append(m);
      }
      return b;
    };
    const [vu, vm] = s.bars.volume, [wu, wm] = s.bars.weight;
    // Playtest: under "Cupboard / Empty" these read as the cupboard's own fill. They're yours.
    out.push(h('div', { class: 'lq-empty', text: 'You carry' }));
    out.push(h('div', { class: 'lq-bars' },
      h('span', { text: `${fmtVolume(vu)} / ${fmtVolume(vm)}` }), bar(vu, vm, s.adds?.volume ?? 0),
      h('span', { text: `${fmtWeight(wu)} / ${fmtWeight(wm)}` }), bar(wu, wm, s.adds?.weight ?? 0)));
  }
  if (s.keys.length) out.push(h('div', { class: 'lq-keys' }, ...s.keys.map(([k, what]) => h('span', null, h('kbd', { text: `[${k}]` }), ` ${what}`))));
  return out;
}

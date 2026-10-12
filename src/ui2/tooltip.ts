// Tooltips: one floating element, driven by pointer position. Anything can have one:
// attachTooltip(el, () => content). Shown after a short delay; once one has been shown,
// moving to a neighbour shows the next one instantly ("warm" mode, like OS tooltips), so
// scanning a grid of items reads fast. Hidden while dragging or while a menu is open.
//
// itemTooltip() builds the rich item card: name, category, weight/volume, condition, badges,
// stats (with ▲/▼ against the equipped item), description and the mouse hints.

import { h, ui2Layers, viewport } from './dom';
import { iconEl } from './icons';
import { isCloseKey } from './host';
import { placePopup } from './logic/layout';
import { fmtVolume, fmtWeight, totalVolume, totalWeight, type ItemStat, type ItemView } from './logic/items';

export type TipContent = HTMLElement | string | null;

const providers = new WeakMap<Element, () => TipContent>();
let tipEl: HTMLElement | null = null;
let current: Element | null = null;
let timer: ReturnType<typeof setTimeout> | 0 = 0;
let lastHidden = -1e9;
let suppressed = 0;
let lastXY = { x: 0, y: 0 };
const DELAY = 350;
const WARM_MS = 600;

export function attachTooltip(el: Element, content: () => TipContent): void {
  providers.set(el, content);
}

/** Suppress while something else owns the pointer (drag, open menu); returns the undo. */
export function suppressTooltips(): () => void {
  suppressed++;
  hideTooltip();
  let done = false;
  return () => {
    if (!done) (done = true), suppressed--;
  };
}

export function hideTooltip(): void {
  if (timer) clearTimeout(timer), (timer = 0);
  if (tipEl && tipEl.style.display !== 'none') {
    tipEl.style.display = 'none';
    lastHidden = performance.now();
  }
  current = null;
}

function providerFor(target: Element | null): Element | null {
  for (let e = target; e; e = e.parentElement) if (providers.has(e)) return e;
  return null;
}

function show(el: Element): void {
  const c = providers.get(el)?.();
  if (!c || suppressed || !el.isConnected) return hideTooltip();
  tipEl ??= ui2Layers().popups.appendChild(h('div', { class: 'ui2-tip' }));
  tipEl.replaceChildren(typeof c === 'string' ? h('div', { class: 'ui2-tip-text', text: c }) : c);
  tipEl.style.display = '';
  position();
}

function position(): void {
  if (!tipEl || tipEl.style.display === 'none') return;
  const r = tipEl.getBoundingClientRect();
  // Offset from the cursor so the tip never sits under it (it would steal the hover).
  const off = 16;
  const p = placePopup({ x: lastXY.x + off, y: lastXY.y + off, w: 0, h: 0 }, { w: r.width, h: r.height }, viewport());
  // Flipped above/left: keep clear of the cursor on that side too.
  if (p.y < lastXY.y + off && p.y + r.height > lastXY.y - 4) p.y = Math.max(0, lastXY.y - off - r.height);
  if (p.x < lastXY.x + off && p.x + r.width > lastXY.x - 4 && p.y + r.height > lastXY.y) p.x = Math.max(0, lastXY.x - off - r.width);
  tipEl.style.left = `${p.x}px`;
  tipEl.style.top = `${p.y}px`;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointermove', (e) => {
    lastXY = { x: e.clientX, y: e.clientY };
    if (suppressed) return;
    const el = providerFor(e.target as Element);
    if (el === current) return position();
    hideTooltip();
    if (!el) return;
    current = el;
    const warm = performance.now() - lastHidden < WARM_MS;
    timer = setTimeout(() => {
      timer = 0;
      if (current !== el) return;
      // A list can re-render under a resting pointer during the delay (the inventory's 400 ms
      // poll saw a charge or count change), leaving `el` a detached row. No pointermove comes
      // to find its replacement, so the tooltip would never open: look again under the pointer.
      const live = el.isConnected ? el : providerFor(document.elementFromPoint(lastXY.x, lastXY.y));
      if (!live) return hideTooltip();
      current = live;
      show(live);
    }, warm ? 0 : DELAY);
  });
  // A click starts something (drag, menu, use): get out of the way.
  document.addEventListener('pointerdown', () => hideTooltip(), true);
  document.addEventListener('wheel', () => hideTooltip(), { passive: true, capture: true });
  // Playtest: a component's card from the crafting window stayed on screen through the whole
  // craft (Enter closed the window, the mouse was captured, no pointermove ever hid it). Any
  // key that closes or confirms, and grabbing the mouse for play, take the tooltip with them.
  document.addEventListener('pointerlockchange', () => hideTooltip());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Backspace' || isCloseKey(e)) hideTooltip();
  }, true);
}

// --- item card -----------------------------------------------------------------------------

export function conditionLabel(c: number): [string, string] {
  if (c >= 0.95) return ['Pristine', 'good'];
  if (c >= 0.75) return ['Good', 'good'];
  if (c >= 0.5) return ['Worn', 'warn'];
  if (c >= 0.25) return ['Damaged', 'bad'];
  return ['Badly damaged', 'bad'];
}

const fmtStat = (s: ItemStat, v = s.value) => `${v.toFixed(s.digits ?? (Number.isInteger(v) ? 0 : 1))}${s.unit ?? ''}`;

export interface ItemTipOpts {
  /** The item it would replace (equipped in the same slot / wielded): shows ▲▼ deltas. */
  compare?: ItemView | null;
  /** Where it is, e.g. "In backpack" / "On the ground". */
  where?: string;
  /** Mouse hints at the bottom; default: drag / right-click / double-click. */
  hints?: string[];
  /** Extra sections from the screen (recipe uses, ammo, …). */
  sections?: HTMLElement[];
}

export function itemTooltip(it: ItemView, o: ItemTipOpts = {}): HTMLElement {
  const card = h('div', { class: 'ui2-itemtip' });
  card.append(
    h(
      'div',
      { class: 'ui2-itemtip-head' },
      iconEl(it.icon, 'grid'),
      h(
        'div',
        null,
        h('div', { class: 'ui2-itemtip-name', text: it.count > 1 ? `${it.name} ×${it.count}` : it.name }),
        h('div', { class: 'ui2-dim', text: [it.category, o.where].filter(Boolean).join(' · ') }),
      ),
    ),
  );
  const facts = [`${fmtWeight(totalWeight(it))}`, `${fmtVolume(totalVolume(it))}`];
  if (it.count > 1) facts.push(`(${fmtWeight(it.weight)} each)`);
  card.append(h('div', { class: 'ui2-itemtip-facts' }, facts.join('   ')));
  if (it.capacity) {
    const used = (it.contents ?? []).reduce((a, c) => a + totalVolume(c), 0);
    card.append(h('div', { class: 'ui2-dim', text: `Holds ${fmtVolume(used)} / ${fmtVolume(it.capacity.volume)}, up to ${fmtWeight(it.capacity.weight)}` }));
  }
  if (it.condition !== undefined) {
    const [label, tone] = conditionLabel(it.condition);
    const bar = h('div', { class: 'ui2-bar ui2-cond' }, h('div', { class: `ui2-bar-fill tone-${tone}`, style: { width: `${it.condition * 100}%` } }));
    card.append(h('div', { class: 'ui2-itemtip-row' }, h('span', { class: 'ui2-dim', text: 'Condition' }), bar, h('span', { class: `tone-${tone}`, text: label })));
  }
  if (it.charges) {
    card.append(h('div', { class: 'ui2-itemtip-row' }, h('span', { class: 'ui2-dim', text: it.charges.label ?? 'Charges' }), h('span', { text: `${it.charges.cur} / ${it.charges.max}` })));
  }
  if (it.badges?.some((b) => b.title)) {
    card.append(h('div', { class: 'ui2-itemtip-badges' }, ...it.badges.filter((b) => b.title).map((b) => h('span', { class: `ui2-chip tone-${b.tone ?? 'dim'}`, text: `${b.text} ${b.title}` }))));
  }
  const stats = it.stats ?? [];
  const cmp = o.compare && o.compare.id !== it.id ? o.compare : null;
  if (stats.length || cmp?.stats?.length) {
    const table = h('div', { class: 'ui2-itemtip-stats' });
    const labels = [...new Set([...stats.map((s) => s.label), ...(cmp?.stats ?? []).map((s) => s.label)])];
    for (const label of labels) {
      const s = stats.find((x) => x.label === label);
      const c = cmp?.stats?.find((x) => x.label === label);
      const ref = s ?? c!;
      const value = s?.value ?? 0;
      let delta: HTMLElement | null = null;
      if (cmp) {
        const d = value - (c?.value ?? 0);
        if (Math.abs(d) > 1e-9) {
          const good = ref.better ? (ref.better === 'higher' ? d > 0 : d < 0) : null;
          delta = h('span', { class: `ui2-delta tone-${good === null ? 'dim' : good ? 'good' : 'bad'}`, text: `${d > 0 ? '▲' : '▼'}${fmtStat(ref, Math.abs(d))}` });
        } else delta = h('span', { class: 'ui2-delta tone-dim', text: '=' });
      }
      table.append(h('span', { class: 'ui2-dim', text: label }), h('span', { text: s ? fmtStat(s) : '—' }), delta ?? h('span'));
    }
    card.append(table);
    if (cmp) card.append(h('div', { class: 'ui2-dim ui2-small', text: `▲▼ compared with ${cmp.name}` }));
  }
  if (it.note) card.append(h('div', { class: 'ui2-itemtip-note tone-info', text: it.note }));
  if (it.takes) card.append(h('div', { class: 'ui2-itemtip-note tone-dim', attrs: { 'data-testid': 'item-takes' }, text: it.takes }));
  if (it.description) card.append(h('div', { class: 'ui2-itemtip-desc', text: it.description }));
  for (const s of o.sections ?? []) card.append(s);
  const hints = o.hints ?? ['Drag to move', 'Right-click: actions', 'Double-click: use'];
  if (hints.length) card.append(h('div', { class: 'ui2-itemtip-hints', text: hints.join(' · ') }));
  return card;
}

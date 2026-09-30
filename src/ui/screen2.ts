// Shared plumbing for the status screens built on ui2 (character sheet, map, help, options,
// key bindings, Esc menu, message log): a ui2 panel that closes on the close key (Space), the
// key that opened it and Backspace (the legacy convention: players never need Esc, which also
// frees the mouse — so the legend never advertises it), a close legend in the footer, and CDDA
// colour tags remapped to the palette (.ui2-cdda).

import type { Game } from '../game/game';
import { closeKeyLabel, h, openPanel, type Panel, type PanelOpts } from '../ui2';
import { rememberedPosition } from '../ui2/window';
import './screens2.css';

export interface ScreenOpts extends Omit<PanelOpts, 'onKey' | 'footer'> {
  /** Game action whose key toggles the screen ('character' → '@'). */
  action?: string;
  /** Keys the screen handles first; true = handled. */
  onKey?: (e: KeyboardEvent) => boolean;
  /** Extra footer legend before the close keys, e.g. [['drag', 'pan'], ['wheel', 'zoom']]. */
  legend?: [string, string][];
  /** What closing does in the legend ('close', 'back', 'resume'). */
  closeLabel?: string;
}

/**
 * Footer legend: "wheel zoom · Space / m close" with the keys highlighted: the close key, then
 * the opening key (Bksp instead of the close key when the screen gives Space another meaning).
 */
export function legendEl(game: Game | null, items: [string, string][], action?: string, closeLabel = 'close', closeKey = true): HTMLElement {
  const el = h('div', { class: 'scr-legend' });
  const key = (k: string) => h('span', { class: 'scr-key', text: k });
  const openKey = action && game && game.keys.keyFor(action) !== 'Escape' ? game.keys.label(action) : null;
  const ck = (closeKey && closeKeyLabel()) || 'Bksp';
  const all: [string, string][] = [...items, [[...new Set([ck, openKey].filter(Boolean))].join(' / '), closeLabel]];
  all.forEach(([k, what], i) => {
    if (i) el.append(h('span', { class: 'ui2-dim', text: '  ·  ' }));
    el.append(key(k), h('span', { text: ` ${what}` }));
  });
  return el;
}

export function openScreen(game: Game | null, o: ScreenOpts): Panel {
  const { action, onKey, legend, closeLabel, ...rest } = o;
  const panel: Panel = openPanel({
    ...rest,
    footer: legendEl(game, legend ?? [], action, closeLabel, o.closeKey !== false),
    onKey: (e) => {
      if (onKey?.(e)) return true;
      if (e.repeat) return false;
      const openKey = action && game ? game.keys.keyFor(action) : null;
      if (e.key === 'Backspace' || (openKey && e.key === openKey)) {
        panel.close();
        return true;
      }
      return false;
    },
  });
  panel.el.classList.add('ui2-cdda', 'scr');
  // Status screens open centred (the ui2 default cascades from the top-left), unless the
  // player moved the window before: then it's where they left it.
  if (!rememberedPosition(o.id) && o.x === undefined) {
    const r = panel.el.getBoundingClientRect();
    panel.moveTo((innerWidth - r.width) / 2, Math.max(0, (innerHeight - r.height) / 2.2));
  }
  return panel;
}

/** A labelled bar: "Str 8 ▮▮▮▮▮▯▯▯" style rows for stats/skills. */
export function meter(frac: number, tone: string, label?: string): HTMLElement {
  return h(
    'div',
    { class: 'ui2-bar scr-meter' },
    h('div', { class: `ui2-bar-fill tone-${tone}`, style: { width: `${Math.max(0, Math.min(1, frac)) * 100}%` } }),
    label ? h('span', { class: 'ui2-bar-label', text: label }) : null,
  );
}

// Modal dialogs: a scrim blocks everything under it until answered.
//   await confirmModal({ title: 'Drop into the fire?', body: '…', ok: 'Burn it', danger: true })
//   await countPrompt({ title: 'Move how many?', max: 40, initial: 20 })   → number | null
// Destructive confirms never take Enter as yes (same rule as the legacy confirm()).

import { h, ui2Layers } from './dom';
import { acquireSurface, pushKeys } from './host';
import { iconEl } from './icons';
import type { IconRef } from './logic/items';
import { suppressTooltips } from './tooltip';
import { button } from './widgets';

interface Dialog {
  box: HTMLElement;
  close: () => void;
}

function openDialog(title: string, content: HTMLElement[], buttons: HTMLElement[], onKey: (e: KeyboardEvent) => boolean, onDismiss: () => void, icon?: IconRef): Dialog {
  const release = acquireSurface();
  const unsuppress = suppressTooltips();
  const scrim = h('div', { class: 'ui2-scrim' });
  const box = h(
    'div',
    { class: 'ui2-dialog', attrs: { role: 'dialog', 'aria-modal': 'true' } },
    h('div', { class: 'ui2-dialog-title' }, icon ? iconEl(icon, 'row') : null, h('span', { text: title })),
    h('div', { class: 'ui2-dialog-body' }, ...content),
    h('div', { class: 'ui2-dialog-buttons' }, ...buttons),
  );
  scrim.appendChild(box);
  ui2Layers().modal.appendChild(scrim);
  // Clicking the scrim outside the dialog = cancel (it's what people try first).
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && onDismiss());
  scrim.addEventListener('contextmenu', (e) => e.preventDefault());
  const removeKeys = pushKeys((e) => {
    if (onKey(e)) return true;
    if (e.key === 'Escape' && !e.repeat) onDismiss();
    // Modal: everything stops here.
    return true;
  }, { overlay: true });
  let closed = false;
  return {
    box,
    close() {
      if (closed) return;
      closed = true;
      removeKeys();
      unsuppress();
      scrim.remove();
      release();
    },
  };
}

export interface ConfirmOpts {
  title: string;
  body?: string | HTMLElement;
  ok?: string;
  cancel?: string;
  danger?: boolean;
  icon?: IconRef;
}

export function confirmModal(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const answer = (v: boolean) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const okBtn = button(o.ok ?? 'OK', () => answer(true), { tone: o.danger ? 'bad' : 'accent', key: o.danger ? 'Y' : 'Enter' });
    const cancelBtn = button(o.cancel ?? 'Cancel', () => answer(false), { key: 'Esc' });
    const body = typeof o.body === 'string' ? h('div', { text: o.body }) : o.body ?? h('div');
    const d = openDialog(
      o.title,
      [body],
      [cancelBtn, okBtn],
      (e) => {
        if (e.repeat) return true;
        if (e.key === 'Enter' && !o.danger) answer(true);
        else if ((e.key === 'y' || e.key === 'Y') && o.danger) answer(true);
        else if (e.key === 'n' || e.key === 'N') answer(false);
        else return false;
        return true;
      },
      () => answer(false),
      o.icon,
    );
    okBtn.focus();
  });
}

export interface CountOpts {
  title: string;
  max: number;
  initial?: number;
  icon?: IconRef;
  /** Line under the title ("clean water in backpack"). */
  subtitle?: string;
  ok?: string;
}

/**
 * How many? Slider + number field + quick buttons (1 / half / all). ↑↓ ±1, PgUp/PgDn ±10,
 * Home/End min/max, the wheel adjusts, typing digits edits, Enter accepts, Esc cancels.
 */
export function countPrompt(o: CountOpts): Promise<number | null> {
  if (!Number.isInteger(o.max) || o.max < 1) throw new Error(`countPrompt: bad max ${o.max}`);
  return new Promise((resolve) => {
    let value = Math.max(1, Math.min(o.max, o.initial ?? o.max));
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const range = h('input', { class: 'ui2-range', attrs: { type: 'range', min: '1', max: String(o.max), step: '1' } });
    const num = h('input', { class: 'ui2-num', attrs: { type: 'text', inputmode: 'numeric', size: String(String(o.max).length + 1) } });
    const set = (v: number) => {
      value = Math.max(1, Math.min(o.max, Math.round(v) || 1));
      range.value = String(value);
      if (document.activeElement !== num || num.value !== '') num.value = String(value);
    };
    range.addEventListener('input', () => set(Number(range.value)));
    num.addEventListener('input', () => {
      const v = parseInt(num.value.replace(/\D/g, ''), 10);
      if (!Number.isNaN(v)) set(v);
    });
    // Keys typed into the field never reach the game's Input (it ignores <input> targets),
    // so the field handles Enter/Esc itself.
    num.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(value);
      else if (e.key === 'Escape') finish(null);
      else if (e.key === 'ArrowUp') (set(value + 1), e.preventDefault());
      else if (e.key === 'ArrowDown') (set(value - 1), e.preventDefault());
    });
    const quick = h(
      'div',
      { class: 'ui2-count-quick' },
      button('1', () => set(1), { small: true }),
      button('Half', () => set(Math.max(1, Math.floor(o.max / 2))), { small: true }),
      button(`All (${o.max})`, () => set(o.max), { small: true }),
    );
    const content = [
      ...(o.subtitle ? [h('div', { class: 'ui2-dim', text: o.subtitle })] : []),
      h('div', { class: 'ui2-count-row' }, range, num),
      quick,
    ];
    const d = openDialog(
      o.title,
      content,
      [button('Cancel', () => finish(null), { key: 'Esc' }), button(o.ok ?? 'OK', () => finish(value), { tone: 'accent', key: 'Enter' })],
      (e) => {
        const steps: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
        if (steps[e.key] !== undefined) set(value + steps[e.key]);
        else if (e.key === 'Home') set(1);
        else if (e.key === 'End') set(o.max);
        else if (e.key === 'Enter' && !e.repeat) finish(value);
        else if (/^[0-9]$/.test(e.key)) {
          num.focus();
          num.value = e.key;
          set(Number(e.key));
        } else return false;
        return true;
      },
      () => finish(null),
      o.icon,
    );
    d.box.addEventListener('wheel', (e) => {
      e.preventDefault();
      set(value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
    }, { passive: false });
    set(value);
    setTimeout(() => {
      num.focus();
      num.select();
    }, 0);
  });
}

export interface TextPromptOpts {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  ok?: string;
  maxLength?: number;
  icon?: IconRef;
}

/**
 * A one-line text field (map notes, names): resolves to the text, or null on cancel. Keys typed
 * in the field never reach the game (src/core/input.ts ignores keydowns aimed at inputs), so
 * Enter/Esc are handled on the field itself.
 */
export function textPrompt(o: TextPromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const answer = (v: string | null) => {
      if (done) return;
      done = true;
      d.close();
      resolve(v);
    };
    const field = h('input', { class: 'ui2-num', attrs: { type: 'text', maxlength: String(o.maxLength ?? 80), placeholder: o.placeholder ?? '', 'data-testid': 'text-prompt' } });
    field.value = o.initial ?? '';
    field.style.textAlign = 'left';
    field.style.width = '100%';
    field.style.userSelect = 'text';
    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') (e.preventDefault(), answer(field.value));
      else if (e.key === 'Escape') (e.preventDefault(), answer(null));
    });
    const d = openDialog(
      o.title,
      [o.label ? h('div', { class: 'ui2-dim ui2-small', text: o.label }) : h('span'), field],
      [button('Cancel', () => answer(null), { key: 'Esc' }), button(o.ok ?? 'OK', () => answer(field.value), { tone: 'accent', key: 'Enter' })],
      (e) => {
        if (e.key === 'Enter' && !e.repeat) return answer(field.value), true;
        return false;
      },
      () => answer(null),
      o.icon,
    );
    setTimeout(() => (field.focus(), field.select()), 0);
  });
}

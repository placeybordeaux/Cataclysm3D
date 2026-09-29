import type { Input } from '../core/input';
import { sfx } from '../audio/sfx';

// Shared building blocks for CDDA-style curses screens. Every modal screen (inventory,
// crafting, construction, character sheet, …) should be made from these so the whole UI
// looks and behaves consistently: black bordered windows, CDDA color tags, letter hotkeys,
// Esc to close, arrow keys / j k to move, Enter to select.

let uiRoot: HTMLElement | null = null;
let input: Input | null = null;

export function initUi(root: HTMLElement, inp: Input): void {
  uiRoot = root;
  input = inp;
}

export function getUiRoot(): HTMLElement {
  if (!uiRoot) throw new Error('initUi() not called');
  return uiRoot;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** CDDA color name ("c_red", "light_gray", "i_yellow", "red_white" …) → CSS color. */
export function cssColor(name: string | undefined): string {
  if (!name) return 'var(--c-light_gray)';
  let n = name.replace(/^[cih]_/, '');
  n = n.replace(/^lt/, 'light').replace(/^dk/, 'dark');
  const base = ['light_gray', 'dark_gray', 'light_red', 'light_green', 'light_blue', 'light_cyan']
    .find((b) => n.startsWith(b)) ?? n.split('_')[0];
  return `var(--c-${base}, var(--c-light_gray))`;
}

/**
 * Render CDDA-tagged text to HTML: "<color_red>danger</color> ok" (CDDA's own markup, used
 * in its JSON strings) plus plain text escaping. Newlines preserved by CSS.
 */
export function colorize(text: string): string {
  let out = '';
  let depth = 0;
  const re = /<color_([a-z_]+)>|<\/color>|<good>|<bad>|<info>|<\/(?:good|bad|info)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += escapeHtml(text.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[0];
    if (tag.startsWith('</')) {
      if (depth > 0) (out += '</span>'), depth--;
    } else {
      const col = m[1] ?? ({ '<good>': 'c_green', '<bad>': 'c_red', '<info>': 'c_cyan' } as Record<string, string>)[tag];
      out += `<span style="color:${cssColor(col)}">`;
      depth++;
    }
  }
  out += escapeHtml(text.slice(last));
  while (depth-- > 0) out += '</span>';
  return out;
}

/** Colored span helper: c('c_red', 'text'). */
export const c = (color: string, text: string) => `<span style="color:${cssColor(color)}">${escapeHtml(text)}</span>`;

export interface WindowOpts {
  title: string;
  /** CSS width/height, e.g. '60ch', '80vw'. Defaults size to content. */
  width?: string;
  height?: string;
  /** Screen anchor; default centered. */
  anchor?: 'center' | 'left' | 'right';
  footer?: string;
  /** Called for key presses; return true if handled. Esc closes by default. */
  onKey?: (e: KeyboardEvent) => boolean | void;
  onClose?: () => void;
  /** Skip the menu_open/menu_close sounds (full-screen overlays that manage their own). */
  silent?: boolean;
}

export interface UiWindow {
  el: HTMLElement;
  body: HTMLElement;
  setTitle(t: string): void;
  setFooter(html: string): void;
  close(): void;
  readonly closed: boolean;
}

/** Open a modal window that captures keyboard input until closed. */
export function openWindow(opts: WindowOpts): UiWindow {
  const root = getUiRoot();
  const el = document.createElement('div');
  el.className = 'cdda-window';
  if (opts.width) el.style.width = opts.width;
  if (opts.height) el.style.height = opts.height;
  const anchor = opts.anchor ?? 'center';
  if (anchor === 'center') Object.assign(el.style, { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' });
  else if (anchor === 'left') Object.assign(el.style, { left: '2vw', top: '4vh' });
  else Object.assign(el.style, { right: '2vw', top: '4vh' });
  el.innerHTML = `<div class="title"></div><div class="body"></div><div class="footer"></div>`;
  const title = el.querySelector('.title') as HTMLElement;
  const body = el.querySelector('.body') as HTMLElement;
  const footer = el.querySelector('.footer') as HTMLElement;
  title.textContent = opts.title;
  footer.innerHTML = opts.footer ?? '';
  footer.style.display = opts.footer ? '' : 'none';
  root.appendChild(el);
  if (!opts.silent) sfx.ui('menu_open');
  let closed = false;
  const release = input!.capture((e) => {
    if (opts.onKey && opts.onKey(e) === true) return true;
    if (e.key === 'Escape') {
      win.close();
      return true;
    }
    return true;
  });
  const win: UiWindow = {
    el,
    body,
    setTitle: (t) => (title.textContent = t),
    setFooter: (h) => {
      footer.innerHTML = h;
      footer.style.display = h ? '' : 'none';
    },
    close() {
      if (closed) return;
      closed = true;
      release();
      el.remove();
      if (!opts.silent) sfx.ui('menu_close');
      opts.onClose?.();
    },
    get closed() {
      return closed;
    },
  };
  return win;
}

export interface MenuEntry<T> {
  /** HTML allowed (use c()/colorize()); plain strings are escaped by caller helpers. */
  label: string;
  value: T;
  /** Explicit hotkey; otherwise a-z then A-Z assigned in order (CDDA style). */
  hotkey?: string;
  disabled?: boolean;
  /** Group header shown above the first entry of each distinct value (e.g. item category). */
  header?: string;
  /** Right-hand detail HTML shown when this entry is highlighted. */
  detail?: () => string;
}

export interface MenuOpts<T> extends Omit<WindowOpts, 'onKey'> {
  entries: MenuEntry<T>[];
  /** Called when an entry is chosen. Return false to keep the menu open. */
  onSelect: (value: T, entry: MenuEntry<T>) => boolean | void;
  /** Extra keys (e.g. 'd' for drop in the inventory). */
  onKey?: (e: KeyboardEvent, current: T | undefined) => boolean | void;
  /** Show a detail pane to the right using entry.detail(). */
  detailPane?: boolean;
}

const AUTO_KEYS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** CDDA uilist: scrolling list with letter hotkeys, arrows/jk, Enter, Esc. */
export function openMenu<T>(opts: MenuOpts<T>): UiWindow & { refresh(entries?: MenuEntry<T>[]): void } {
  let entries = opts.entries;
  let sel = 0;
  let keys: string[] = [];
  const win = openWindow({
    ...opts,
    onKey: (e) => {
      const cur = entries[sel];
      if (opts.onKey && opts.onKey(e, cur?.value) === true) return true;
      if (e.key === 'ArrowDown' || (e.key === 'j' && !keys.includes('j'))) move(1);
      else if (e.key === 'ArrowUp' || (e.key === 'k' && !keys.includes('k'))) move(-1);
      else if (e.key === 'PageDown') move(10);
      else if (e.key === 'PageUp') move(-10);
      else if (e.key === 'Enter') choose(sel);
      else {
        const i = keys.indexOf(e.key);
        if (i >= 0) choose(i);
        else return false;
      }
      return true;
    },
  });
  const listEl = document.createElement('div');
  const detailEl = document.createElement('div');
  if (opts.detailPane) {
    const cols = document.createElement('div');
    cols.className = 'cols';
    cols.append(listEl, detailEl);
    detailEl.style.borderLeft = '1px solid var(--c-dark_gray)';
    detailEl.style.paddingLeft = '8px';
    win.body.appendChild(cols);
  } else win.body.appendChild(listEl);

  function move(d: number) {
    if (!entries.length) return;
    const next = Math.max(0, Math.min(entries.length - 1, sel + d));
    if (next !== sel) sfx.ui('menu_move');
    sel = next;
    render();
  }
  function choose(i: number) {
    const e = entries[i];
    if (!e || e.disabled) {
      sfx.ui('menu_error');
      return;
    }
    sfx.ui('menu_select');
    sel = i;
    if (opts.onSelect(e.value, e) !== false) win.close();
    else render();
  }
  function render() {
    let auto = 0;
    keys = entries.map((e) => e.hotkey ?? (AUTO_KEYS[auto++] ?? ''));
    let html = '';
    let lastHeader: string | undefined;
    entries.forEach((e, i) => {
      if (e.header && e.header !== lastHeader) {
        html += `<div class="menu-header">${escapeHtml(e.header)}</div>`;
        lastHeader = e.header;
      }
      const k = keys[i] ? `<span class="hotkey">${escapeHtml(keys[i])}</span> ` : '  ';
      html += `<div class="menu-entry${i === sel ? ' sel' : ''}${e.disabled ? ' disabled' : ''}" data-i="${i}">${k}${e.label}</div>`;
    });
    if (!entries.length) html = `<div class="menu-entry disabled">(nothing)</div>`;
    listEl.innerHTML = html;
    listEl.querySelectorAll<HTMLElement>('.menu-entry[data-i]').forEach((row) => {
      const i = Number(row.dataset.i);
      row.onmouseenter = () => {
        if (sel !== i) (sel = i), render();
      };
      row.onclick = () => choose(i);
    });
    (listEl.querySelector('.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    if (opts.detailPane) detailEl.innerHTML = entries[sel]?.detail?.() ?? '';
  }
  render();
  return Object.assign(win, {
    refresh(next?: MenuEntry<T>[]) {
      if (next) entries = next;
      sel = Math.min(sel, Math.max(0, entries.length - 1));
      render();
    },
  });
}

/** Yes/no prompt (CDDA query_yn). */
export function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const w = openWindow({
      title: 'Confirm',
      footer: `${c('c_light_green', 'y')}es / ${c('c_light_green', 'n')}o`,
      onKey: (e) => {
        if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') (answered = true), w.close(), resolve(true);
        // query_yn: Esc answers no (and must close, or cdda.ui.closeAll() leaves it open)
        else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') (answered = true), w.close(), resolve(false);
        return true;
      },
      onClose: () => !answered && resolve(false),
    });
    w.body.innerHTML = colorize(question);
  });
}

/** Number / text prompt (CDDA string_input_popup). Resolves null on Esc. */
export function prompt(question: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const w = openWindow({
      title: question,
      // Keys typed into the <input> never reach the capture stack (Input ignores input
      // targets); Esc sent to the window (closeAll, focus lost) closes via openWindow.
      onClose: () => !done && resolve(null),
    });
    const inp = document.createElement('input');
    Object.assign(inp.style, { background: '#000', color: 'var(--c-white)', border: '1px solid var(--c-dark_gray)', font: 'inherit', width: '30ch' });
    inp.value = initial;
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') (done = true), w.close(), resolve(inp.value);
      else if (e.key === 'Escape') w.close();
    };
    w.body.appendChild(inp);
    setTimeout(() => inp.focus(), 0);
  });
}

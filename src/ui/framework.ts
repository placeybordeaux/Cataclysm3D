import type { Input } from '../core/input';
import { sfx } from '../audio/sfx';
import { Keys } from './keys';
import { keyLabel } from './keymap';

// Shared building blocks for CDDA-style curses screens. Every modal screen (inventory,
// crafting, construction, character sheet, …) should be made from these so the whole UI
// looks and behaves consistently: black bordered windows, CDDA color tags, letter hotkeys,
// Space (the player's `close_menu` key) or the opening key to close, arrow keys / j k to move,
// Enter to select. Esc also closes but is never advertised: outside fullscreen the browser takes
// it to release the captured mouse, so players who learn "Esc closes" keep losing the mouse.

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
  /**
   * What closing does, for the footer legend the framework appends ("Space/i close"):
   * 'close' by default; e.g. 'back', 'cancel', 'leave'. null leaves the legend out (the
   * window explains its own keys, e.g. a yes/no prompt).
   */
  closeLabel?: string | null;
  /** Mouse motion keeps turning the view while this window is on top (look mode). */
  mouseLook?: boolean;
  /** The key that opened the window closes it (default). False where it means something inside (dialogue letters). */
  closeOnOpenKey?: boolean;
  /**
   * The close key (`close_menu`, Space) closes it (default). False where Space means something
   * inside (multi-select toggles, chargen traits): Bksp and the opening key still close, and
   * the legend says so instead.
   */
  closeKey?: boolean;
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

/**
 * Open windows, oldest first: `close` shuts one outright, `escape` presses Esc in it (which may
 * mean "back" rather than close: chargen steps back a tab, crafting leaves a group).
 */
const openWindows: { close: () => void; escape: () => void; el: HTMLElement; mouseLook: boolean }[] = [];

/** Only the top window takes clicks (a click on the inventory behind an item menu opened a second one). */
function markTopWindow(): void {
  openWindows.forEach((w, i) => w.el.classList.toggle('inactive', i < openWindows.length - 1));
  if (input) input.menuMouseLook = openWindows[openWindows.length - 1]?.mouseLook ?? false;
}

/**
 * Footer legend for closing: "Space/i close" — the close key, then the opening key. Never Esc
 * (see the header); Bksp only where Space means something else in the window.
 */
export function closeLegend(openKey: string | null, label = 'close', closeKey = true): string {
  const ck = closeKey ? Keys.closeKeys()[0] : undefined;
  const keys = [...new Set([...(ck !== undefined ? [keyLabel(ck)] : ['Bksp']), ...(openKey && openKey !== 'Escape' ? [keyLabel(openKey)] : [])])];
  return `${keys.map((k) => c('c_light_green', k)).join('/')} ${label}`;
}

/** The close key for legends ("Space"), or Bksp when close_menu is unbound. */
export function closeKeyLabel(): string {
  const ck = Keys.closeKeys()[0];
  return ck === undefined ? 'Bksp' : keyLabel(ck);
}

/** A fresh press of the player's close key (`close_menu`, Space by default). */
export const isCloseKey = (e: KeyboardEvent) => !e.repeat && Keys.closeKeys().includes(e.key);

/**
 * Hover only counts when the mouse really moved: when a menu opens under a resting cursor (the
 * cursor reappears mid-screen as pointer lock ends), the browser sends a motionless mousemove,
 * and the entry under it would steal the highlight — Enter on the Esc menu then opened Help
 * instead of Resume.
 */
export const hoverMoved = (ev: MouseEvent) => ev.movementX !== 0 || ev.movementY !== 0;

/** Legend fragment for a key: key('Enter', 'select') → green "Enter" + " select". */
export const legendKey = (k: string, what: string) => `${c('c_light_green', k)} ${what}`;

/** Number of open framework windows (tests / the death screen). */
export function openWindowCount(): number {
  return openWindows.length;
}

/** Close every open window, topmost first (death, quitting). */
export function closeAllWindows(): void {
  for (let i = 0; i < 50 && openWindows.length; i++) openWindows[openWindows.length - 1].close();
}

/**
 * Do what Esc does in the topmost window (the browser ate the key to release pointer lock,
 * src/ui/pointer.ts). Returns false if no window is open.
 */
export function closeTopWindow(): boolean {
  const top = openWindows[openWindows.length - 1];
  if (!top) return false;
  top.escape();
  return true;
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
  // The close key (Space), the key that opened this window (e.g. "i", "&") and Backspace close
  // it, so players never need Esc — which in a browser also releases the captured mouse.
  const openKey = opts.closeOnOpenKey === false ? null : Keys.openingKey();
  const useCloseKey = opts.closeKey !== false;
  const legend = opts.closeLabel === null ? '' : closeLegend(openKey, opts.closeLabel ?? 'close', useCloseKey);
  const setFooter = (h: string) => {
    const html = [h, legend].filter(Boolean).join('  ');
    footer.innerHTML = html;
    footer.style.display = html ? '' : 'none';
  };
  setFooter(opts.footer ?? '');
  root.appendChild(el);
  if (!opts.silent) sfx.ui('menu_open');
  let closed = false;
  const handler = (e: KeyboardEvent): boolean => {
    if (opts.onKey && opts.onKey(e) === true) return true;
    // Arrow keys the window doesn't use scroll its body (character sheet at 960×540, item info).
    const scroll = { ArrowDown: 40, ArrowUp: -40, PageDown: body.clientHeight, PageUp: -body.clientHeight }[e.key];
    if (scroll !== undefined) {
      body.scrollTop += scroll;
      return true;
    }
    // Held keys repeat: without this, holding i (or Esc) would flicker the window shut and open.
    if (e.repeat) return true;
    if (e.key === 'Escape' || e.key === 'Backspace' || (openKey !== null && e.key === openKey) || (useCloseKey && isCloseKey(e))) {
      win.close();
      return true;
    }
    return true;
  };
  const entry = {
    close: () => win.close(),
    escape: () => void handler(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' })),
    el,
    mouseLook: !!opts.mouseLook,
  };
  openWindows.push(entry);
  markTopWindow();
  // Free-cursor menus (Options > Menu cursor): the first window frees the mouse to point and
  // click; closing the last one re-captures it (see close()).
  if (input!.menuCursor === 'free' && !input!.captured && !opts.mouseLook) input!.releaseForMenu();
  const release = input!.capture(handler);
  const win: UiWindow = {
    el,
    body,
    setTitle: (t) => (title.textContent = t),
    setFooter,
    close() {
      if (closed) return;
      closed = true;
      const wi = openWindows.lastIndexOf(entry);
      if (wi >= 0) openWindows.splice(wi, 1);
      markTopWindow();
      release();
      el.remove();
      if (!opts.silent) sfx.ui('menu_close');
      opts.onClose?.();
      // Back to gameplay: re-enter mouse-look if the lock was lost (we're inside the key
      // or click that closed the window, which counts as the required user gesture).
      if (!input!.captured) input!.tryLock();
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
  // Don't hand out the opening key as an entry hotkey: pressing it again should close.
  const ok = Keys.openingKey();
  const autoKeys = ok && ok.length === 1 ? AUTO_KEYS.replace(ok, '') : AUTO_KEYS;
  const win = openWindow({
    ...opts,
    onKey: (e) => {
      const cur = entries[sel];
      if (opts.onKey && opts.onKey(e, cur?.value) === true) return true;
      // Auto-repeat scrolls, but never picks: a letter held a moment too long would otherwise
      // also choose in the menu it opened (inventory `a` → item menu `a`ctivate).
      if (e.repeat && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'j', 'k'].includes(e.key)) return true;
      if (e.key === 'ArrowDown' || (e.key === 'j' && !keys.includes('j'))) move(1);
      else if (e.key === 'ArrowUp' || (e.key === 'k' && !keys.includes('k'))) move(-1);
      else if (e.key === 'PageDown') move(10);
      else if (e.key === 'PageUp') move(-10);
      else if (e.key === '>' && !keys.includes('>') && entries.length > AUTO_KEYS.length) move(AUTO_KEYS.length);
      else if (e.key === '<' && !keys.includes('<') && entries.length > AUTO_KEYS.length) move(-AUTO_KEYS.length);
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
    // Long names ("The Hitchhiker's Guide to the Cataclysm (unread)") end in an ellipsis
    // instead of running on under the detail pane.
    listEl.className = 'menu-list-clip';
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
    // More auto-keyed entries than letters: the letters cover the page of AUTO_KEYS.length
    // entries around the selection (CDDA uilist pages), so every entry is reachable by key.
    let auto = 0;
    let selAuto = 0;
    entries.forEach((e, i) => {
      if (e.hotkey !== undefined) return;
      if (i <= sel) selAuto = auto;
      auto++;
    });
    const page = Math.floor(selAuto / autoKeys.length) * autoKeys.length;
    auto = 0;
    keys = entries.map((e) => {
      if (e.hotkey !== undefined) return e.hotkey;
      const k = auto++ - page;
      return k >= 0 ? autoKeys[k] ?? '' : '';
    });
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
      row.onmousemove = (ev) => {
        if (hoverMoved(ev) && sel !== i) (sel = i), render();
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

/**
 * Yes/no prompt (CDDA query_yn). `destructive` questions (delete a save, quit without saving)
 * don't take Enter as yes, so a player hammering Enter through dialogs can't lose anything.
 */
export function confirm(question: string, opts: { destructive?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (yes: boolean) => {
      if (answered) return;
      answered = true;
      w.close();
      resolve(yes);
    };
    const w = openWindow({
      title: 'Confirm',
      closeLabel: null,
      footer: `${legendKey('y', 'yes')}  ${legendKey(`n/${closeKeyLabel()}`, 'no')}${opts.destructive ? '' : `  ${legendKey('Enter', 'yes')}`}`,
      onKey: (e) => {
        if (e.repeat) return true;
        if (e.key === 'y' || e.key === 'Y' || (e.key === 'Enter' && !opts.destructive)) answer(true);
        // query_yn: Esc answers no (and must close, or cdda.ui.closeAll() leaves it open). The
        // close key (Space) is always "no", never "yes", destructive or not.
        else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape' || e.key === 'Backspace' || isCloseKey(e)) answer(false);
        return true;
      },
      onClose: () => !answered && resolve(false),
    });
    w.body.innerHTML = `${colorize(question)}<div class="confirm-buttons"><span class="btn" data-a="y">[${c('c_light_green', 'Y')}es]</span> <span class="btn" data-a="n">[${c('c_light_green', 'N')}o]</span></div>`;
    w.body.querySelectorAll<HTMLElement>('.btn').forEach((b) => (b.onclick = () => answer(b.dataset.a === 'y')));
  });
}

/**
 * Number / text prompt (CDDA string_input_popup). Resolves null on cancel: Bksp in the empty
 * field (Space types a space here, so it can't be the close key), or Esc.
 */
export function prompt(question: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const w = openWindow({
      title: question,
      closeLabel: null,
      footer: `${legendKey('Enter', 'ok')}  ${legendKey('Bksp', 'cancel (empty field)')}`,
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
      // A fresh press on an already-empty field: holding Bksp to clear the text doesn't cancel.
      else if (e.key === 'Backspace' && !e.repeat && inp.value === '') w.close();
    };
    w.body.appendChild(inp);
    setTimeout(() => inp.focus(), 0);
  });
}

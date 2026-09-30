// Title screen layouts (docs/ADAPTATION.md). The CDDA main menu is a one-line terminal row
// of [bracketed] words with 11 px tall hit targets — faithful, but a newcomer's first screen
// should say "click here to play" in big letters. Two button layouts, plus the old row:
//
//   center  — logo on top, one big primary button (Start, or Continue when there's a save)
//             with a sentence saying what it does, the other ways in below it, the rest as a
//             small row. The default.
//   side    — a left-hand column over a darkened edge of the slowly turning world, every
//             entry the same size (the "modern shooter" menu), tip card bottom-right.
//   classic — CDDA's horizontal [Start] [New Game] … row (the pre-wave-3 screen).
//
// Pick with Options > Title screen or ?title=center|side|classic. Only markup lives here;
// menus.ts keeps the entries, keyboard handling and what each entry does.

import { registerOption } from './options';
import './title.css';

export type TitleLayout = 'center' | 'side' | 'classic';
export const TITLE_LAYOUTS: TitleLayout[] = ['center', 'side', 'classic'];
const KEY = 'cdda3d.titleLayout';

/** ?title= wins, then the stored choice, then the default. Unknown ?title= values fail loudly. */
export function titleLayout(): TitleLayout {
  const q = new URLSearchParams(location.search).get('title');
  if (q !== null) {
    if (!(TITLE_LAYOUTS as string[]).includes(q)) throw new Error(`?title=${q}: expected one of ${TITLE_LAYOUTS.join(', ')}`);
    return q as TitleLayout;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s && (TITLE_LAYOUTS as string[]).includes(s)) return s as TitleLayout;
  } catch {
    // storage blocked: default
  }
  return 'center';
}

export function setTitleLayout(l: TitleLayout): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // not persisted
  }
}

let registered = false;
export function registerTitleLayoutOption(onChange?: () => void): void {
  if (registered) return;
  registered = true;
  const names: Record<TitleLayout, string> = { center: 'Big buttons', side: 'Side column', classic: 'Classic row (CDDA)' };
  registerOption({
    name: 'Title screen',
    value: () => names[titleLayout()],
    change: (d) => {
      const n = TITLE_LAYOUTS.length;
      setTitleLayout(TITLE_LAYOUTS[(TITLE_LAYOUTS.indexOf(titleLayout()) + d + n) % n]);
      onChange?.();
    },
    desc: 'How the main menu looks: big buttons under the logo, a column down the left side, or the one-line menu from Cataclysm.',
  });
}

/** One title-screen entry as the layouts see it. */
export interface TitleEntryView {
  label: string;
  /** Shortcut letter (shown as a small key cap). */
  key: string;
  /** One sentence under a big button: what happens when you press it. */
  desc?: string;
  enabled: boolean;
  /** primary = the big button; major = full-size; minor = the small row. */
  weight: 'primary' | 'major' | 'minor';
  selected: boolean;
}

export interface TitleView {
  entries: TitleEntryView[];
  /** The logo element (a canvas or the ASCII art), placed as-is. */
  logo: HTMLElement;
  subtitle: string;
  /** Unlock lines (already HTML). */
  bannerHtml: string;
  /** Tip of the day (already HTML), or ''. */
  tipHtml: string;
}

/**
 * The ui2 theme (pixel skins, font metrics) lives as custom properties on #ui2; the title is
 * drawn in the old #ui root, so borrow them. Without this the buttons fall back to plain CSS.
 */
function borrowUi2Theme(el: HTMLElement): void {
  const root = document.getElementById('ui2');
  if (!root) return;
  for (let i = 0; i < root.style.length; i++) {
    const n = root.style[i];
    if (n.startsWith('--')) el.style.setProperty(n, root.style.getPropertyValue(n));
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

function button(e: TitleEntryView, i: number, withDesc: boolean): string {
  const cls = ['tt-btn', `tt-${e.weight}`, e.selected ? 'sel' : '', e.enabled ? '' : 'off'].filter(Boolean).join(' ');
  const desc = withDesc && e.desc ? `<span class="tt-desc">${esc(e.desc)}</span>` : '';
  return `<button class="${cls} title-entry" data-i="${i}" data-key="${esc(e.key)}" ${e.enabled ? '' : 'aria-disabled="true"'}><span class="tt-label">${esc(e.label)}</span>${desc}<kbd>${esc(e.key.toUpperCase())}</kbd></button>`;
}

/** Fill `el` with the button layout; returns the clickable buttons keyed by entry index. */
export function renderTitleButtons(el: HTMLElement, layout: Exclude<TitleLayout, 'classic'>, v: TitleView): HTMLElement[] {
  borrowUi2Theme(el);
  el.classList.toggle('tt-center', layout === 'center');
  el.classList.toggle('tt-side', layout === 'side');
  const idx = (w: TitleEntryView['weight']) => v.entries.map((e, i) => [e, i] as const).filter(([e]) => e.weight === w);
  const big = [...idx('primary'), ...idx('major')];
  const small = idx('minor');
  const tip = v.tipHtml ? `<div class="tt-tip"><div class="tt-tip-head">Survivor's tip</div><div>${v.tipHtml}</div></div>` : '';
  const banner = v.bannerHtml ? `<div class="tt-banner">${v.bannerHtml}</div>` : '';
  const hint = `<div class="tt-hint">↑↓ choose · Enter confirm · or press the key on a button</div>`;
  if (layout === 'center') {
    el.innerHTML = `<div class="tt-wrap">
        <div class="tt-logo"></div>
        <div class="tt-sub">${v.subtitle}</div>
        ${banner}
        <div class="tt-stack">${big.map(([e, i]) => button(e, i, true)).join('')}</div>
        <div class="tt-row">${small.map(([e, i]) => button(e, i, false)).join('')}</div>
        ${hint}
        ${tip}
      </div>`;
  } else {
    el.innerHTML = `<div class="tt-col">
        <div class="tt-logo"></div>
        <div class="tt-sub">${v.subtitle}</div>
        ${banner}
        <div class="tt-stack">${big.map(([e, i]) => button(e, i, true)).join('')}${small.map(([e, i]) => button(e, i, false)).join('')}</div>
        ${hint}
      </div>
      ${tip}`;
  }
  el.querySelector('.tt-logo')!.appendChild(v.logo);
  return [...el.querySelectorAll<HTMLElement>('.tt-btn')];
}

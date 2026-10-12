// Item/terrain icons from the UltiCa atlas for ui2. Sprites are drawn at 1:1 into a cached
// data URL and scaled in CSS by an integer (--icon-k / --row-icon-k) with nearest filtering,
// so a 32px sprite is exactly 32/64/96 px and never smeared.
//
// Lookup order: the id, its first looks_like, the looks_like chain from game data (set with
// setLooksLike), then a picture of the item's held 3D model (weapons and tools, set with
// setModelIconSource: render/heldIcon.ts), then CDDA's ASCII glyph in the item's colour. Icons requested before the
// atlas has loaded fill themselves in when it arrives.

import { loadAtlas, type Atlas } from '../render/atlas';
import type { IconRef } from './logic/items';
import { h } from './dom';

let atlas: Atlas | null = null;
let failed = false;
const pending: (() => void)[] = [];
let looksLike: (id: string) => string | undefined = () => undefined;

const ready = loadAtlas().then(
  (a) => {
    atlas = a;
    for (const f of pending.splice(0)) f();
  },
  (e) => {
    failed = true;
    console.warn(`ui2 icons: atlas unavailable (${e}); using glyphs`);
  },
);

/** Resolves when the atlas is usable (or known to be missing). */
export function iconsReady(): Promise<void> {
  return ready;
}

/** Data source for CDDA looks_like chains (game data or raw items.json). */
export function setLooksLike(fn: (id: string) => string | undefined): void {
  looksLike = fn;
}

const cache = new Map<string, { url: string; w: number; h: number } | null>();

let modelIcon: ((typeId: string) => HTMLCanvasElement | null) | null = null;
/**
 * Icons for ids the tileset has no art for (before the glyph fallback). Setting it drops the
 * cached icons, so elements built from now on use it (open lists keep theirs until redrawn).
 */
export function setModelIconSource(fn: ((typeId: string) => HTMLCanvasElement | null) | null): void {
  modelIcon = fn;
  cache.clear();
}

function render(ref: IconRef): { url: string; w: number; h: number } | null {
  const key = `${ref.typeId}|${ref.looksLike ?? ''}|${ref.symbol ?? ''}|${ref.color ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;
  let out: { url: string; w: number; h: number } | null = null;
  if (atlas) {
    const art =
      atlas.lookup(ref.typeId) ??
      (ref.looksLike ? atlas.lookupWithLooksLike(ref.looksLike, looksLike) : null) ??
      atlas.lookupWithLooksLike(ref.typeId, looksLike);
    const model = art ? null : modelIcon?.(ref.typeId) ?? null;
    const hit = art ?? (!model && ref.symbol ? { id: ref.typeId, fg: atlas.glyph(ref.symbol, ref.color ?? 'light_gray') } : null);
    const c = model ?? (hit ? atlas.spriteCanvas(hit, 1) : null);
    if (c) out = { url: c.toDataURL(), w: c.width, h: c.height };
  }
  cache.set(key, out);
  return out;
}

/**
 * An icon element. `size` 'grid' uses --icon (inventory cells), 'row' uses --row-icon
 * (lists, menus). The element is a fixed square; taller sprites are cropped from the bottom
 * up (UltiCa items sit on the cell floor).
 */
export function iconEl(ref: IconRef | undefined, size: 'grid' | 'row' = 'grid'): HTMLElement {
  const box = h('span', { class: `ui2-icon ui2-icon-${size}` });
  if (!ref) return box;
  const fill = () => {
    const r = render(ref);
    if (!r) {
      box.textContent = ref.symbol ?? '?';
      box.classList.add('glyph');
      return;
    }
    const img = h('img', { attrs: { src: r.url, alt: '', draggable: 'false' } });
    const k = size === 'grid' ? 'var(--icon-k)' : 'var(--row-icon-k)';
    img.style.width = `calc(${r.w}px * ${k})`;
    img.style.height = `calc(${r.h}px * ${k})`;
    box.replaceChildren(img);
  };
  if (atlas || failed) fill();
  else pending.push(fill);
  return box;
}

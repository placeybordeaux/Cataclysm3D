// Shared bits for the interaction screens (dialogue, trade, missions, vehicles, body mods,
// achievements): CDDA colour markup mapped onto the ui2 palette, small meters and chips,
// item → ItemView for the item cells, and the NPC portrait.

import type { Game } from '../game/game';
import type { Item } from '../game/item';
import type { Npc } from '../game/npc';
import type { Renderer } from '../render/renderer';
import { atlasOf } from '../ui/context';
import { portraitCanvas } from '../ui/npc_ui';
import { h, type ItemView, type Tone } from '../ui2';

/** CDDA colour names → ui2 tones (the palette is graded; raw CDDA colours would clash). */
const TONE_OF: Record<string, Tone | 'bright'> = {
  red: 'bad', light_red: 'bad', green: 'good', light_green: 'good', yellow: 'warn', brown: 'warn',
  cyan: 'info', light_cyan: 'info', blue: 'info', light_blue: 'info', magenta: 'magic', pink: 'magic',
  white: 'bright', dark_gray: 'dim', light_gray: 'dim',
};

export function toneOfColor(c: string): Tone | 'bright' | undefined {
  return TONE_OF[c.replace(/^c_/, '').replace(/^i_/, '')];
}

/**
 * Text with CDDA <color_x>…</color> / <good> / <bad> / <info> markup as DOM: spans with tone
 * classes. Everything else is text (never innerHTML: NPC names and lines are data).
 */
export function markup(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const stack: HTMLElement[] = [];
  const parent = () => (stack.length ? stack[stack.length - 1] : frag);
  const re = /<color_([a-z_]+)>|<\/color>|<(good|bad|info)>|<\/(?:good|bad|info)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent().append(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[0].startsWith('</')) stack.pop();
    else {
      const tone = m[1] ? toneOfColor(m[1]) : m[2] === 'good' ? 'good' : m[2] === 'bad' ? 'bad' : 'info';
      const span = h('span', { class: tone === 'bright' ? 'ix-bright' : tone ? `tone-${tone}` : '' });
      parent().append(span);
      stack.push(span);
    }
  }
  if (last < text.length) parent().append(text.slice(last));
  return frag;
}

/** Strip CDDA colour markup (for titles and tooltips). */
export function plain(text: string): string {
  return text.replace(/<\/?(?:color_[a-z_]+|color|good|bad|info)>/g, '');
}

/** A small tone-coloured label in a box. */
export function chip(text: string, tone: Tone | 'bright' = 'dim', title?: string): HTMLElement {
  return h('span', { class: `ix-chip tone-${tone}`, text, title });
}

/** A labelled meter: "Fuel ▮▮▮▮▯ 12.4 / 40 L". `frac` 0..1. */
export function meter(label: string, frac: number, text: string, tone: Tone = 'accent', opts: { title?: string; cls?: string } = {}): HTMLElement {
  const f = Math.max(0, Math.min(1, frac));
  return h(
    'div',
    { class: `ix-meter ${opts.cls ?? ''}`, title: opts.title },
    h('span', { class: 'ix-meter-label', text: label }),
    h('div', { class: 'ix-meter-track' }, h('div', { class: `ix-meter-fill fill-${tone}`, style: { width: `${f * 100}%` } })),
    h('span', { class: `ix-meter-text tone-${tone}`, text }),
  );
}

/** Heading inside a panel (same look as the journal's sections). */
export function section(text: string, extra?: HTMLElement | null): HTMLElement {
  return h('div', { class: 'ui2-section' }, h('span', { text }), extra ?? null);
}

/** Minimal ItemView for item cells in these screens (trade rows, cargo, CBMs). */
export function itemView(game: Game, it: Item, id: string, count?: number): ItemView {
  const def = it.def;
  const n = count ?? (it.countByCharges ? it.charges : 1);
  const dmg = it.damageLevel();
  return {
    id,
    typeId: it.typeId,
    name: it.countByCharges ? it.baseName(n) : it.name(),
    count: n,
    stackable: it.countByCharges,
    // totalWeight() adds the contents itself: the item's own share only
    weight: it.countByCharges ? it.unitWeight() : it.weight() - it.contents.reduce((w, c) => w + c.weight(), 0),
    volume: it.countByCharges ? it.unitVolume() : it.volume(),
    category: typeof def.category === 'string' ? def.category : undefined,
    condition: dmg > 0 ? Math.max(0, 1 - dmg / 4) : undefined,
    description: typeof def.description === 'string' ? plain(def.description) : undefined,
    icon: { typeId: it.typeId, looksLike: def.looks_like as string | undefined, symbol: (def.symbol as string | undefined) ?? '?', color: ((def.color as string | undefined) ?? 'light_gray').replace(/^c_/, '') },
    contents: it.contents.length ? it.contents.map((c, i) => itemView(game, c, `${id}/${i}`)) : undefined,
  };
}

/** The NPC's composited sprite (body + clothes + weapon), pixel-scaled, in a well. */
export function portrait(game: Game, renderer: Renderer | null, n: Npc, k = 2): HTMLElement {
  const well = h('div', { class: 'ix-portrait' });
  // Drawn 1:1 and scaled in CSS by an integer multiple of the UI pixel, so it stays crisp.
  const cv = renderer ? portraitCanvas(atlasOf(renderer), n, (id) => game.data.items[id]?.looks_like as string | undefined, 1) : null;
  if (cv) {
    cv.style.width = `calc(${cv.width}px * var(--u) * ${k})`;
    cv.style.height = `calc(${cv.height}px * var(--u) * ${k})`;
    well.append(cv);
  } else well.append(h('span', { class: 'ix-portrait-glyph', text: '@' }));
  return well;
}

/** "3 h 20 min" for game durations. */
export function hours(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.floor(h)} h${Math.round((h % 1) * 60) ? ` ${Math.round((h % 1) * 60)} min` : ''}`;
  return `${Math.round(h / 24)} days`;
}

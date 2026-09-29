// Shared bits for the ui2 crafting / construction / reading screens: icons for items and
// terrain, an item card for tooltips, requirement chips (icon + have/need), text input.

import type { GameData } from '../../data/types';
import type { AltEval, GroupEval, RequirementEval } from '../../game/requirements';
import { itemDisplayName, qualityName } from '../../game/requirements';
import { cddaText } from '../../game/units';
import { attachTooltip, h, iconEl, itemTooltip, type IconRef, type ItemStat, type ItemView } from '../../ui2';
import { qualityIcon } from './craft_model';

export function itemIconRef(data: GameData, id: string): IconRef {
  const d = data.items[id];
  return { typeId: id, ...(d?.looks_like ? { looksLike: d.looks_like } : {}), ...(d ? { symbol: d.symbol, color: d.color } : {}) };
}

/** Terrain / furniture sprite (construction results). */
export function mapIconRef(data: GameData, id: string): IconRef {
  const d = (id.startsWith('f_') ? data.furniture[id] : data.terrain[id]) as { symbol?: string; color?: string | string[]; looks_like?: string } | undefined;
  const color = Array.isArray(d?.color) ? d?.color[0] : d?.color;
  return { typeId: id, ...(d?.looks_like ? { looksLike: d.looks_like } : {}), ...(d?.symbol ? { symbol: d.symbol } : {}), ...(color ? { color } : {}) };
}

/** An ItemView of a type (for tooltips of results and components that don't exist yet). */
export function defView(data: GameData, id: string, count = 1): ItemView {
  const d = data.items[id];
  const stats: ItemStat[] = [];
  if (d) {
    if (d.bashing) stats.push({ label: 'Bash', value: d.bashing, better: 'higher' });
    if (d.cutting) stats.push({ label: d.flags?.includes('SPEAR') || d.flags?.includes('STAB') ? 'Pierce' : 'Cut', value: d.cutting, better: 'higher' });
    if (d.to_hit) stats.push({ label: 'To-hit', value: d.to_hit, better: 'higher' });
    const cal = (d as { calories?: number }).calories;
    if (cal) stats.push({ label: 'Calories', value: cal, unit: ' kcal' });
    const q = (d as { quench?: number }).quench;
    if (q) stats.push({ label: 'Quench', value: q });
    for (const [qid, lvl] of d.qualities ?? []) stats.push({ label: qualityName(data, qid), value: lvl });
    if (d.storage) stats.push({ label: 'Storage', value: d.storage / 1000, unit: ' L', digits: 2 });
  }
  return {
    id: `def:${id}`,
    typeId: id,
    name: itemDisplayName(data, id, count),
    count,
    stackable: !!d?.count_by_charges,
    weight: d?.weight ?? 0,
    volume: d?.volume ?? 0,
    category: d ? cddaText(data.misc.item_category?.[d.category]?.name) || d.category : undefined,
    description: d ? cddaText(d.description) : undefined,
    icon: itemIconRef(data, id),
    stats,
  };
}

/** Text field that keeps typed keys out of the game (the input handler skips inputs). */
export function searchField(placeholder: string, onInput: (v: string) => void): HTMLInputElement {
  const el = h('input', { class: 'c2-search', attrs: { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' } });
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

export interface ChipOpts {
  onClick?: (alt: AltEval) => void;
  selected?: (alt: AltEval) => boolean;
}

/** One alternative as a chip: [icon] name  have/need, coloured by state. */
export function altChip(data: GameData, alt: AltEval, o: ChipOpts = {}): HTMLElement {
  const icon = alt.kind === 'quality' ? itemIconRef(data, qualityIcon(data, alt.id, alt.need) ?? '') : itemIconRef(data, alt.id);
  const name = alt.kind === 'quality' ? `${qualityName(data, alt.id)} ${alt.need}` : itemDisplayName(data, alt.id, Math.max(1, alt.need) === 1 ? 1 : 2);
  const amount =
    alt.kind === 'quality' ? (alt.avail > 0 ? `best ${alt.avail}` : 'none')
    : alt.kind === 'tool' ? (alt.need > 0 ? `${fmtAvail(alt.avail)}/${alt.need} ch` : alt.avail > 0 ? 'at hand' : 'missing')
    : `${fmtAvail(alt.avail)}/${alt.need}`;
  const state = alt.have ? 'ok' : alt.color === 'c_dark_gray' ? 'alt' : 'missing';
  const chip = h(
    'button',
    { class: `c2-chip ${state}${o.selected?.(alt) ? ' sel' : ''}`, data: { kind: alt.kind, id: alt.id } },
    iconEl(icon, 'row'),
    h('span', { class: 'c2-chip-name', text: name }),
    h('span', { class: 'c2-chip-amt', text: amount }),
  );
  chip.addEventListener('click', () => o.onClick?.(alt));
  attachTooltip(chip, () => {
    if (alt.kind === 'quality') return `${alt.text}${alt.have ? '' : '\nClick: what has it'}`;
    const card = itemTooltip(defView(data, alt.id, Math.max(1, alt.need)), { hints: alt.have ? [] : ['Click: where to get it'] });
    return card;
  });
  return chip;
}

function fmtAvail(n: number): string {
  return n === Infinity ? '∞' : String(n);
}

/** A requirement group row: alternatives joined by "or". */
export function groupRow(data: GameData, g: GroupEval, o: ChipOpts = {}): HTMLElement {
  const row = h('div', { class: `c2-group${g.ok ? ' ok' : ' missing'}` });
  g.alts.forEach((a, i) => {
    if (i) row.append(h('span', { class: 'c2-or', text: 'or' }));
    row.append(altChip(data, a, o));
  });
  return row;
}

/** "Tools" and "Components" sections of a requirement evaluation. */
export function requirementSections(data: GameData, ev: RequirementEval, o: ChipOpts = {}, labels = { tools: 'Tools', comps: 'Components' }): HTMLElement[] {
  const out: HTMLElement[] = [];
  const tools = [...ev.qualities, ...ev.tools];
  out.push(h('div', { class: 'ui2-section', text: labels.tools }));
  if (!tools.length) out.push(h('div', { class: 'ui2-dim ui2-small', text: 'None needed.' }));
  for (const g of tools) out.push(groupRow(data, g, o));
  if (ev.components.length) {
    out.push(h('div', { class: 'ui2-section', text: labels.comps }));
    for (const g of ev.components) out.push(groupRow(data, g, o));
  }
  return out;
}

/** localStorage-backed string list (favourites, recent). Never throws. */
export function storedList(key: string): { get(): string[]; set(v: string[]): void } {
  return {
    get() {
      try {
        const v = JSON.parse(localStorage.getItem(key) ?? '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
      } catch {
        return [];
      }
    },
    set(v) {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // not persisted (private window)
      }
    },
  };
}

/** Whether ui2 remembers a position for window `id` (else a screen centres itself). */
export function rememberedWindow(id: string): boolean {
  try {
    return !!JSON.parse(localStorage.getItem('cdda3d.ui2.win') ?? '{}')[id];
  } catch {
    return false;
  }
}

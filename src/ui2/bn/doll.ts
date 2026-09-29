// The BN paper doll: one well per body part showing what's worn there as a stack of layers
// (innermost at the back, outermost in front), the part's encumbrance in the corner (coloured
// by how much it slows you), and the wielded item in the middle. Drop clothes on any part to
// wear them, a weapon on the hands to wield it; drag the front layer off to take it off.
// Hover a part for its layers, encumbrance and warmth; right-click it for each layer's actions.

import { h } from '../dom';
import { registerDropTarget } from '../dragdrop';
import { iconEl } from '../icons';
import { openContextMenu, type MenuItem } from '../menu';
import { attachTooltip } from '../tooltip';
import type { BodyPartId } from '../../game/bodyparts';
import { bnTarget, wireItem, type ListEnv } from './lists';

interface PartPos {
  id: BodyPartId | 'hands';
  label: string;
  col: number;
  row: number;
}

// Viewer-facing: the survivor's right side on the left, like a character facing you.
const PARTS: PartPos[] = [
  { id: 'eyes', label: 'Eyes', col: 0, row: 0 },
  { id: 'head', label: 'Head', col: 1, row: 0 },
  { id: 'mouth', label: 'Mouth', col: 2, row: 0 },
  { id: 'arm_r', label: 'R arm', col: 0, row: 1 },
  { id: 'torso', label: 'Torso', col: 1, row: 1 },
  { id: 'arm_l', label: 'L arm', col: 2, row: 1 },
  { id: 'hand_r', label: 'R hand', col: 0, row: 2 },
  { id: 'hands', label: 'Wielded', col: 1, row: 2 },
  { id: 'hand_l', label: 'L hand', col: 2, row: 2 },
  { id: 'leg_r', label: 'R leg', col: 0.5, row: 3 },
  { id: 'leg_l', label: 'L leg', col: 1.5, row: 3 },
  { id: 'foot_r', label: 'R foot', col: 0.5, row: 4 },
  { id: 'foot_l', label: 'L foot', col: 1.5, row: 4 },
];

/** BN encumbrance bands: what the number means for the player. */
export function encTone(e: number): string {
  return e <= 0 ? 'dim' : e <= 10 ? 'good' : e <= 20 ? 'warn' : 'bad';
}

export function bnDoll(env: ListEnv): { el: HTMLElement; render(): void; destroy(): void } {
  const m = env.model;
  const el = h('div', { class: 'ui2-doll bn-doll' });
  el.style.width = `calc(2 * (var(--cell) + var(--gap)) + var(--cell))`;
  el.style.height = `calc(4 * (var(--cell) + var(--gap) * 2) + var(--cell) + var(--fs-s))`;
  const wells = new Map<string, HTMLElement>();
  const unregs: (() => void)[] = [];
  for (const p of PARTS) {
    const loc = p.id === 'hands' ? 'hands' : `worn:${p.id}`;
    const w = h('div', { class: `ui2-doll-slot bn-part${p.id === 'hands' ? ' bn-hands' : ''}`, data: { part: p.id } });
    w.style.left = `calc(${p.col} * (var(--cell) + var(--gap)))`;
    w.style.top = `calc(${p.row} * (var(--cell) + var(--gap) * 2))`;
    el.appendChild(w);
    wells.set(p.id, w);
    unregs.push(registerDropTarget(bnTarget(env, loc, w, p.id === 'hands' ? undefined : 'Wear')));
    attachTooltip(w, () => partTip(env, p));
    w.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = m.contents(loc);
      if (!items.length) return;
      const menu: MenuItem[] = [];
      // Outermost first: the order you'd peel them off.
      for (const it of [...items].reverse()) menu.push({ label: it.name, icon: it.icon, submenu: () => m.actions(it, loc) });
      openContextMenu({ x: e.clientX, y: e.clientY }, menu, { title: p.label });
    });
  }
  let cleanups: (() => void)[] = [];
  const render = () => {
    for (const c of cleanups.splice(0)) c();
    const bp = new Map(m.view.bodyParts.map((b) => [b.id, b]));
    for (const p of PARTS) {
      const w = wells.get(p.id)!;
      const loc = p.id === 'hands' ? 'hands' : `worn:${p.id}`;
      const items = m.contents(loc);
      const stack = h('div', { class: 'ui2-cell grid bn-stack' + (items.length ? '' : ' empty') });
      // Up to three layers drawn, front = outermost.
      const shown = items.slice(-3);
      shown.forEach((it, i) => {
        const ic = iconEl(it.icon, 'grid');
        ic.classList.add('bn-layer');
        ic.style.transform = `translate(calc(var(--u) * ${(i - shown.length + 1) * 3}), calc(var(--u) * ${(i - shown.length + 1) * 3}))`;
        if (i < shown.length - 1) ic.style.opacity = '0.45';
        stack.appendChild(ic);
      });
      if (items.length > 1) stack.appendChild(h('span', { class: 'ui2-cell-count', text: `${items.length}` , title: `${items.length} layers` }));
      const front = items[items.length - 1];
      if (front) {
        for (const b of front.badges ?? []) if (b.text === '!') stack.appendChild(h('span', { class: 'ui2-cell-badges' }, h('span', { class: `ui2-badge tone-${b.tone}`, text: '!' })));
        cleanups.push(wireItem(env, loc, front, stack));
      }
      const b = p.id === 'hands' ? null : bp.get(p.id);
      w.replaceChildren(stack, h('div', { class: 'bn-part-foot' }, h('span', { class: 'bn-part-name', text: p.label }), b ? h('span', { class: `bn-enc tone-${encTone(b.encumbrance)}`, text: String(b.encumbrance), title: 'Encumbrance' }) : null));
    }
  };
  const off = m.onChange(render);
  render();
  return {
    el,
    render,
    destroy() {
      off();
      for (const u of unregs) u();
      for (const c of cleanups.splice(0)) c();
    },
  };
}

function partTip(env: ListEnv, p: PartPos): HTMLElement {
  const m = env.model;
  const card = h('div', { class: 'ui2-itemtip' });
  if (p.id === 'hands') {
    const w = m.contents('hands')[0];
    card.append(h('div', { class: 'ui2-itemtip-name', text: 'Wielded' }), h('div', { class: 'ui2-dim', text: w ? w.name : 'Nothing: drop a weapon or tool here to wield it' }));
    return card;
  }
  const b = m.view.bodyParts.find((x) => x.id === p.id)!;
  card.append(
    h('div', { class: 'ui2-itemtip-name', text: b.name.charAt(0).toUpperCase() + b.name.slice(1) }),
    h('div', { class: 'ui2-itemtip-row' }, h('span', { class: 'ui2-dim', text: 'Encumbrance' }), h('span', { class: `tone-${encTone(b.encumbrance)}`, text: `${b.encumbrance} ${encWords(p.id as BodyPartId, b.encumbrance)}` })),
    h('div', { class: 'ui2-itemtip-row' }, h('span', { class: 'ui2-dim', text: 'Warmth' }), h('span', { text: String(b.warmth) })),
  );
  if (b.worn.length) {
    card.append(h('div', { class: 'ui2-dim ui2-small', text: 'Layers, outermost first:' }));
    for (const n of [...b.worn].reverse()) card.append(h('div', { class: 'bn-tip-layer' }, iconEl({ typeId: n.typeId, looksLike: n.item.def.looks_like, symbol: n.item.def.symbol, color: n.item.def.color }, 'row'), h('span', { text: n.name })));
  } else card.append(h('div', { class: 'ui2-dim', text: 'Nothing worn here: drop clothes on it to wear them.' }));
  card.append(h('div', { class: 'ui2-itemtip-hints', text: 'Drag the front layer off: take off · Right-click: every layer' }));
  return card;
}

/** What BN's encumbrance does on this part, in a few words. */
function encWords(bp: BodyPartId, e: number): string {
  if (e <= 0) return '';
  const what: Partial<Record<BodyPartId, string>> = {
    torso: 'slower melee, dodging', head: 'less accuracy', eyes: 'worse aim, vision', mouth: 'faster tiring',
    arm_l: 'slower attacks', arm_r: 'slower attacks', hand_l: 'slower handling, crafting', hand_r: 'slower handling, crafting',
    leg_l: 'slower walking', leg_r: 'slower walking', foot_l: 'slower walking', foot_r: 'slower walking',
  };
  return e > 10 ? `(${what[bp] ?? 'penalties'})` : '(slight)';
}

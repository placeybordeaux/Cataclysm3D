// Barter screen (replaces the curses trade window). Your goods on the left, theirs on the
// right, the table in the middle: drag (or click) what you offer onto "You give", what you
// want onto "You get". The balance bar shows who comes out ahead against the credit the NPC
// extends, and the NPC reacts to the offer as it changes. "Make the deal" asks them; the goods
// then change hands through TradeSession.commit, one moves-API transaction (all or nothing,
// conserved: tests/trade_screen.test.ts).
//
// Mouse: drag between a list and the table (wheel while dragging changes the amount, Shift
// asks for it), click moves the whole row, Ctrl-click asks how many, right-click for a menu.
// Keys: ←/→ column, ↑/↓ row, Enter/Space move it, +/- one unit, D make the deal, Esc cancel.

import type { Game } from '../game/game';
import type { Npc } from '../game/npc';
import type { NpcSystem } from '../game/npcai';
import type { Renderer } from '../render/renderer';
import { TradeSession, maxCreditExtended, type TradeEntry } from '../game/trade';
import {
  attachTooltip, button, countPrompt, flashNote, h, iconEl, itemTooltip, makeDraggable, openContextMenu, openPanel, registerDropTarget, toast,
  type DragPayload, type DropVerdict, type MenuItem, type Panel,
} from '../ui2';
import { centreFirstTime, chip, itemView, portrait } from './common';
import { balanceMeter, money, reaction } from './logic/trade';
import { sfx } from '../audio/sfx';

export interface TradeCtx {
  game: Game;
  renderer: Renderer | null;
  sys: NpcSystem;
}

type Side = 'yours' | 'give' | 'get' | 'theirs';

export interface TradeHandle {
  panel: Panel;
  session: TradeSession;
  /** Offer/ask for `n` more of a row (tests, automation), as a drop would. */
  add(side: 'yours' | 'theirs', row: number, n?: number): void;
  deal(): boolean;
}

export function openTradePanel(ctx: TradeCtx, n: Npc, cost = 0, onDone?: (traded: boolean) => void): TradeHandle {
  const { game, sys } = ctx;
  let s = new TradeSession(game.data, sys.nd, game.player, n, cost);
  let traded = false;
  const filters: Record<'yours' | 'theirs', string> = { yours: '', theirs: '' };
  let cursor: { side: Side; i: number } = { side: 'theirs', i: 0 };
  const unregs: (() => void)[] = [];

  const panel = openPanel({
    id: 'trade',
    title: `Trade with ${n.displayName()}`,
    group: 'trade',
    pauses: true,
    width: 'min(calc(var(--fs) * 74), 97vw)',
    height: 'min(90vh, calc(var(--fs) * 40))',
    footer: 'Drag or click goods onto the table · wheel while dragging: amount · Ctrl-click: how many · D make the deal · Esc cancel',
    onKey,
    onClose: () => {
      for (const u of unregs) u();
      onDone?.(traded);
    },
  });
  panel.el.classList.add('ix-trade-win');
  centreFirstTime(panel);

  // ---------------------------------------------------------------- layout
  const colYours = h('div', { class: 'ix-tcol yours' });
  const colTheirs = h('div', { class: 'ix-tcol theirs' });
  const giveZone = h('div', { class: 'ix-tzone give', attrs: { 'data-testid': 'trade-give' } });
  const getZone = h('div', { class: 'ix-tzone get', attrs: { 'data-testid': 'trade-get' } });
  const meterEl = h('div', { class: 'ix-balance' });
  const reactEl = h('div', { class: 'ix-react' });
  const dealBtn = button('Make the deal', () => void deal(), { tone: 'accent', key: 'D' });
  dealBtn.dataset.testid = 'trade-deal';
  const cancelBtn = button('Cancel', () => panel.close(), { key: 'Esc' });
  const table = h(
    'div',
    { class: 'ix-table' },
    h('div', { class: 'ix-who-mini' }, portrait(game, ctx.renderer, n, 1), h('div', {}, h('div', { class: 'ix-dlg-name', text: n.name }), reactEl)),
    h('div', { class: 'ix-zone-title', text: 'You give' }), giveZone,
    meterEl,
    h('div', { class: 'ix-zone-title', text: 'You get' }), getZone,
    h('div', { class: 'ix-deal-row' }, cancelBtn, dealBtn),
  );
  panel.body.append(h('div', { class: 'ix-trade' }, colYours, table, colTheirs));
  panel.body.classList.add('ix-trade-body');

  // Drop targets: each place takes only what can go there.
  const accept = (to: Side) => (p: DragPayload, count: number): DropVerdict => {
    const from = (p.meta as { side: Side } | undefined)?.side;
    const ok = (to === 'give' && from === 'yours') || (to === 'yours' && from === 'give') || (to === 'get' && from === 'theirs') || (to === 'theirs' && from === 'get');
    if (from === to) return { kind: 'noop' };
    if (!ok) return { kind: 'reject', reason: to === 'give' || to === 'yours' ? "That's theirs." : "That's yours." };
    return { kind: 'ok', count };
  };
  const drop = (to: Side) => (p: DragPayload, count: number) => {
    const e = (p.meta as { entry: TradeEntry }).entry;
    s.setCount(e, to === 'give' || to === 'get' ? e.count + count : e.count - count);
    sfx.ui('menu_select');
    render();
  };
  const verb: Record<Side, string> = { give: 'Offer', get: 'Ask for', yours: 'Take back', theirs: 'Put back' };
  for (const [el, side] of [[colYours, 'yours'], [giveZone, 'give'], [getZone, 'get'], [colTheirs, 'theirs']] as [HTMLElement, Side][])
    unregs.push(registerDropTarget({ el, id: `trade:${side}`, check: accept(side), drop: drop(side), label: () => verb[side] }));

  // ---------------------------------------------------------------- rows
  const listOf = (side: Side): TradeEntry[] => {
    const src = side === 'yours' || side === 'give' ? s.yours : s.theirs;
    if (side === 'give' || side === 'get') return src.filter((e) => e.count > 0);
    const f = filters[side].toLowerCase();
    // Grouped by where the goods are (one header per group), the session's order within.
    const rank = (e: TradeEntry) => ['stock', 'npc', 'carried', 'worn', 'wielded'].indexOf(e.source);
    return src
      .filter((e) => e.count < e.max && (!f || e.item.name().toLowerCase().includes(f)))
      .map((e, i) => [e, i] as const)
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
      .map(([e]) => e);
  };

  function row(e: TradeEntry, side: Side, i: number): HTMLElement {
    const onTable = side === 'give' || side === 'get';
    const units = onTable ? e.count : e.max - e.count;
    const view = itemView(game, e.item, `${side}:${i}`, e.item.countByCharges ? units : undefined);
    const each = !e.item.countByCharges && e.max > 1;
    const value = onTable ? TradeSession.value(e) : Math.ceil((e.price * units) / e.max);
    const sel = cursor.side === side && cursor.i === i;
    const el = h(
      'div',
      { class: `ix-trow${sel ? ' selected' : ''}`, data: { side, i: String(i) } },
      iconEl(view.icon, 'row'),
      h('span', { class: 'ix-trow-name' }, h('span', { text: e.item.countByCharges ? e.item.baseName(1) : view.name }), units > 1 ? h('span', { class: 'ui2-row-count', text: ` ×${units}` }) : null),
      h('span', { class: 'ix-trow-price' }, h('span', { text: money(value) }), each && !onTable ? h('span', { class: 'ui2-dim', text: ` (${money(e.price / e.max)} ea)` }) : null),
    );
    if (e.source === 'worn' || e.source === 'wielded') el.append(chip(e.source === 'worn' ? 'worn' : 'held', 'dim'));
    const payload = (): DragPayload => ({ item: { ...view, count: units }, count: units, from: `trade:${side}`, meta: { side, entry: e } });
    makeDraggable(el, {
      payload,
      onClick: (ev) => {
        cursor = { side, i };
        if (ev.ctrlKey || ev.metaKey) return void askAmount(e, side);
        moveRow(e, side, units);
      },
      onContext: (ev) => openContextMenu({ x: ev.clientX, y: ev.clientY }, rowMenu(e, side), { title: view.name }),
    });
    attachTooltip(el, () => itemTooltip(view, { where: e.source === 'stock' ? 'Shop' : side === 'yours' || side === 'give' ? 'Yours' : `${n.name}'s`, hints: onTable ? ['Click: take it off the table', 'Drag: back to the list'] : ['Click: all onto the table', 'Ctrl-click: how many', 'Drag: to the table (wheel: amount)'] }));
    return el;
  }

  function moveRow(e: TradeEntry, side: Side, units: number): void {
    const onTable = side === 'give' || side === 'get';
    s.setCount(e, onTable ? e.count - units : e.count + units);
    sfx.ui('menu_select');
    render();
  }

  async function askAmount(e: TradeEntry, side: Side): Promise<void> {
    const onTable = side === 'give' || side === 'get';
    const max = onTable ? e.count : e.max - e.count;
    if (max < 1) return;
    const k = max === 1 ? 1 : await countPrompt({ title: onTable ? 'Take back how many?' : side === 'yours' ? 'Offer how many?' : 'Ask for how many?', subtitle: e.item.name(), max, initial: max, ok: onTable ? 'Take back' : 'Put on the table' });
    if (k !== null && !panel.closed) moveRow(e, side, k);
  }

  function rowMenu(e: TradeEntry, side: Side): MenuItem[] {
    const onTable = side === 'give' || side === 'get';
    const max = onTable ? e.count : e.max - e.count;
    const word = onTable ? 'Take back' : side === 'yours' ? 'Offer' : 'Ask for';
    return [
      { label: `${word} all (${max})`, primary: true, action: () => moveRow(e, side, max) },
      { label: `${word} one`, disabled: max < 1, action: () => moveRow(e, side, 1) },
      { label: `${word} how many…`, disabled: max < 2, action: () => void askAmount(e, side) },
    ];
  }

  function column(el: HTMLElement, side: 'yours' | 'theirs'): void {
    const list = listOf(side);
    const title = side === 'yours' ? 'Your goods' : n.isShopkeeper() ? `${n.name}'s stock` : `${n.name}'s goods`;
    const input = h('input', { class: 'pg-input ix-filter', attrs: { type: 'text', placeholder: 'Filter…', spellcheck: 'false', 'aria-label': `Filter ${title}` } });
    input.value = filters[side];
    input.addEventListener('input', () => {
      filters[side] = input.value;
      renderColumn(side);
    });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || ev.key === 'Enter') input.blur();
    });
    const rows = h('div', { class: 'ix-tlist', attrs: { 'data-testid': `trade-${side}` } });
    fillRows(rows, list, side);
    const total = (side === 'yours' ? s.yours : s.theirs).reduce((sum, e) => sum + e.price, 0);
    el.replaceChildren(h('div', { class: 'ix-tcol-head' }, h('span', { class: 'ix-zone-title', text: title }), h('span', { class: 'ui2-dim', text: `${money(total)} in all` })), input, rows);
  }

  function fillRows(rows: HTMLElement, list: TradeEntry[], side: Side): void {
    let lastSrc = '';
    const out: HTMLElement[] = [];
    list.forEach((e, i) => {
      const group = e.source === 'stock' ? 'For sale' : e.source === 'npc' ? 'Carried' : e.source === 'worn' ? 'Worn' : e.source === 'wielded' ? 'In hand' : 'Carried';
      if (group !== lastSrc && (side === 'yours' || side === 'theirs')) {
        out.push(h('div', { class: 'ix-tgroup', text: group }));
        lastSrc = group;
      }
      out.push(row(e, side, i));
    });
    if (!out.length) out.push(h('div', { class: 'ui2-empty', text: side === 'give' ? 'Drag what you offer here' : side === 'get' ? 'Drag what you want here' : filters[side as 'yours'] ? 'Nothing matches.' : 'Nothing to trade.' }));
    rows.replaceChildren(...out);
  }

  function renderColumn(side: 'yours' | 'theirs'): void {
    const rows = (side === 'yours' ? colYours : colTheirs).querySelector('.ix-tlist') as HTMLElement | null;
    if (rows) fillRows(rows, listOf(side), side);
  }

  function renderTable(): void {
    fillRows(giveZone, listOf('give'), 'give');
    fillRows(getZone, listOf('get'), 'get');
    const bal = s.balance();
    const credit = maxCreditExtended(n);
    const size = s.yourValue() + s.theirValue() + Math.abs(cost);
    const m = balanceMeter(bal, credit, size, n.name);
    const empty = !s.yours.some((e) => e.count) && !s.theirs.some((e) => e.count);
    const r = reaction(empty && cost <= 0 && !n.op.owed, bal, credit, n.name);
    // The bar: centre = even; right = in their favour (they'll owe you); the green zone
    // reaches left as far as the credit they'll extend.
    const pct = (v: number) => `${50 + v * 50}%`;
    meterEl.replaceChildren(
      h('div', { class: 'ix-bal-labels' }, h('span', { text: `You give ${money(s.yourValue())}` }), h('span', { text: `You get ${money(s.theirValue())}` })),
      h(
        'div',
        { class: 'ix-bal-track' },
        h('div', { class: 'ix-bal-credit', style: { left: pct(m.creditEdge), width: `calc(100% - ${pct(m.creditEdge)})` } }),
        h('div', { class: 'ix-bal-mid' }),
        h('div', { class: `ix-bal-needle tone-${m.tone}`, style: { left: pct(m.needle) } }),
      ),
      h('div', { class: 'ix-bal-labels ui2-small' }, h('span', { text: `◂ ${n.name} comes out ahead` }), h('span', { text: 'you come out ahead ▸' })),
      h('div', { class: `ix-bal-text tone-${m.tone}`, text: m.text + (cost > 0 ? `  (includes ${money(cost)} you owe for the service)` : '') }),
    );
    reactEl.className = `ix-react mood-${r.mood} tone-${r.tone}`;
    reactEl.textContent = r.line;
    dealBtn.disabled = empty && cost <= 0;
  }

  function render(): void {
    column(colYours, 'yours');
    column(colTheirs, 'theirs');
    renderTable();
  }

  // ---------------------------------------------------------------- the deal
  function deal(): boolean {
    const ok = s.canAccept();
    if (!ok.ok) {
      sfx.ui('menu_error');
      reactEl.textContent = ok.reason ?? 'No deal.';
      reactEl.className = 'ix-react mood-refuses tone-bad shake';
      setTimeout(() => reactEl.classList.remove('shake'), 260);
      return false;
    }
    if (s.yourValue() === 0 && s.theirValue() === 0 && cost <= 0) {
      panel.close();
      return false;
    }
    const dropped: string[] = [];
    if (!s.commit((it) => dropped.push(it.name()))) {
      // Something moved under the screen (an item used up, a follower dropped it): start over
      // from what is really there rather than guess.
      s = new TradeSession(game.data, sys.nd, game.player, n, cost);
      render();
      const b = dealBtn.getBoundingClientRect();
      flashNote(b.left + b.width / 2, b.top, 'Something changed; the deal is off.', 'bad');
      return false;
    }
    traded = true;
    game.message(`You trade with ${n.name}.`, 'c_light_green');
    toast({ category: 'info', title: `Traded with ${n.name}`, body: dropped.length ? `No room for ${dropped.length === 1 ? `the ${dropped[0]}` : `${dropped.length} items`}: set down at your feet.` : undefined });
    // Otherwise a bought backpack silently lands at your feet and looks like it vanished.
    if (dropped.length) game.message(`You have no room for ${dropped.length === 1 ? `the ${dropped[0]}` : `${dropped.length} items`}; you set ${dropped.length === 1 ? 'it' : 'them'} down at your feet.`, 'c_yellow');
    panel.close();
    return true;
  }

  // ---------------------------------------------------------------- keys
  const SIDES: Side[] = ['yours', 'give', 'get', 'theirs'];
  function onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') return panel.close(), true;
    if (e.key === 'd' || e.key === 'D') return deal(), true;
    const list = listOf(cursor.side);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const j = SIDES.indexOf(cursor.side) + (e.key === 'ArrowRight' ? 1 : -1);
      cursor = { side: SIDES[(j + SIDES.length) % SIDES.length], i: 0 };
    } else if (e.key === 'ArrowDown') cursor.i = Math.min(list.length - 1, cursor.i + 1);
    else if (e.key === 'ArrowUp') cursor.i = Math.max(0, cursor.i - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      const en = list[cursor.i];
      const onTable = cursor.side === 'give' || cursor.side === 'get';
      if (en) moveRow(en, cursor.side, onTable ? en.count : en.max - en.count);
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      const en = list[cursor.i];
      // + always means "more on the table", - "less", whichever list the cursor is in.
      if (en) s.setCount(en, en.count + (e.key === '-' ? -1 : 1));
    } else return true;
    render();
    panel.body.querySelector('.ix-trow.selected')?.scrollIntoView({ block: 'nearest' });
    return true;
  }

  render();
  return {
    panel,
    get session() {
      return s;
    },
    add(side, i, k) {
      const e = listOf(side)[i];
      if (!e) throw new Error(`trade: no row ${i} on ${side}`);
      moveRow(e, side, k ?? e.max - e.count);
    },
    deal,
  };
}

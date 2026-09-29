import type { Item } from '../game/item';
import type { ActionResult } from '../game/inventory';
import { useActions } from '../game/inventory';
import { c, openMenu, openWindow, type MenuEntry, type UiWindow } from './framework';
import { fit, kg, liters } from './format';
import { categoryName, escapeHtml, itemInfo } from './iteminfo';
import { spriteImg, type UiContext } from './context';

// CDDA inventory screens (inventory_ui.cpp): the `i` overview, the single-purpose pickers
// (wield, wear, take off, eat, apply, reload, unload), and the multi-select drop and pickup
// menus with CDDA's "type a number, then the letter" counts. Items near the player (the
// tile you stand on and the 8 around it) are offered too, like CDDA's "NEARBY" section.

export type Where = 'wielded' | 'worn' | 'carried' | 'ground';

export interface InvEntry {
  item: Item;
  where: Where;
  /** Map tile for ground items. */
  pos?: { x: number; y: number; z: number };
  /** Nesting depth inside containers (for indentation). */
  depth: number;
  /** For ground items: direction label ("under you", "north"…). */
  dir?: string;
}

/** Stub hooks other systems fill in (reading lives with crafting/skills). */
export const itemActionHooks: {
  read?: (item: Item) => void;
  /** Throw (G) — combat owns it. */
  throw?: (item: Item) => void;
} = {};

const DIRS: Record<string, string> = {
  '0,0': 'under you', '0,-1': 'north', '1,-1': 'northeast', '1,0': 'east', '1,1': 'southeast',
  '0,1': 'south', '-1,1': 'southwest', '-1,0': 'west', '-1,-1': 'northwest',
};

/** Everything the player has, in CDDA's order: wielded, worn, then pocket contents. */
export function carriedEntries(ctx: UiContext): InvEntry[] {
  const inv = ctx.game.player.inv;
  const out: InvEntry[] = [];
  if (inv.wielded) {
    out.push({ item: inv.wielded, where: 'wielded', depth: 0 });
    pushContents(out, inv.wielded, 1);
  }
  for (const w of inv.worn) out.push({ item: w, where: 'worn', depth: 0 });
  const carried: InvEntry[] = [];
  for (const w of inv.topLevel()) for (const p of w.containerPockets()) for (const it of p.contents) {
    carried.push({ item: it, where: 'carried', depth: 0 });
    pushContents(carried, it, 1);
  }
  return [...out, ...carried];
}

function pushContents(out: InvEntry[], it: Item, depth: number): void {
  for (const p of it.containerPockets()) for (const inner of p.contents) {
    out.push({ item: inner, where: 'carried', depth });
    pushContents(out, inner, depth + 1);
  }
}

/** Items on the player's tile and the 8 around it. */
export function nearbyEntries(ctx: UiContext): InvEntry[] {
  const p = ctx.game.player;
  const out: InvEntry[] = [];
  const order = [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  for (const [dx, dy] of order) {
    const x = p.tileX + dx, y = p.tileY + dy;
    for (const it of ctx.game.map.itemsAt(x, y, p.z) as Item[]) {
      out.push({ item: it, where: 'ground', pos: { x, y, z: p.z }, depth: 0, dir: DIRS[`${dx},${dy}`] });
    }
  }
  return out;
}

function sectionOf(e: InvEntry): string {
  if (e.where === 'wielded') return 'WIELDED';
  if (e.where === 'worn') return 'WORN CLOTHING';
  if (e.where === 'ground') return `NEARBY (${e.dir})`;
  return categoryName(e.item).toUpperCase();
}

/** Item name with sprite icon, CDDA-ish coloring, padded to a column. */
export function itemLabel(ctx: UiContext, e: InvEntry, width = 36, countOverride?: number): string {
  const it = e.item;
  const indent = e.depth > 0 ? '  '.repeat(e.depth - 1) + '> ' : '';
  let name = indent + (countOverride !== undefined && it.countByCharges ? `${it.baseName(countOverride)} (${countOverride})` : it.name());
  name = fit(name, width);
  let col = 'c_light_gray';
  if (it.goesBad() && it.rotten()) col = 'c_brown';
  else if (e.where === 'wielded' || e.where === 'worn') col = 'c_white';
  const w = kg(it.weight()).padStart(6), v = liters(it.volume()).padStart(6);
  return `${spriteImg(ctx.renderer, it.typeId)}${c(col, name)} ${c('c_light_gray', w)} ${c('c_light_gray', v)}`;
}

const columnHeader = (width = 36) => `<div class="pre" style="color:var(--c-light_blue)">${' '.repeat(2)}${'Name'.padEnd(width + 2)}${'kg'.padStart(6)} ${'L'.padStart(6)}</div>`;

function statusFooter(ctx: UiContext): string {
  const inv = ctx.game.player.inv;
  const wt = inv.weightCarried(), cap = inv.weightCapacity();
  return `Weight (kg): ${c(wt > cap ? 'c_red' : 'c_light_gray', kg(wt))}/${kg(cap)}   Volume (L): ${liters(inv.volumeCarried())}/${liters(inv.volumeCapacity())}`;
}

/** Put items an action had to drop onto the player's tile. */
export function placeDropped(ctx: UiContext, items: Item[] | undefined): void {
  if (!items?.length) return;
  const p = ctx.game.player;
  for (const it of items) ctx.game.map.addItem(p.tileX, p.tileY, p.z, it);
}

/** Apply the bookkeeping every inventory action needs (map removal, dropped items). */
function finish(ctx: UiContext, e: InvEntry, r: ActionResult, tookItem: boolean): ActionResult {
  if (r.ok && e.where === 'ground' && e.pos && (tookItem || r.usedUp)) ctx.game.map.removeItem(e.pos.x, e.pos.y, e.pos.z, e.item);
  placeDropped(ctx, r.dropped);
  return r;
}

// ------------------------------------------------------------------ actions

export type ItemAction = 'wield' | 'wear' | 'takeoff' | 'eat' | 'apply' | 'read' | 'reload' | 'unload' | 'drop' | 'examine' | 'throw';

export function doAction(ctx: UiContext, action: ItemAction, e: InvEntry): ActionResult | null {
  const p = ctx.game.player;
  const inv = p.inv;
  const it = e.item;
  switch (action) {
    case 'wield':
      if (e.where === 'wielded') return finish(ctx, e, inv.unwield(), false);
      return finish(ctx, e, inv.wield(it), true);
    case 'wear':
      return finish(ctx, e, inv.wear(it), true);
    case 'takeoff':
      return finish(ctx, e, inv.takeOff(it), false);
    case 'eat':
      return finish(ctx, e, inv.consume(it), false);
    case 'apply':
      return finish(ctx, e, inv.use(it), false);
    case 'reload':
      return finish(ctx, e, inv.reload(it), false);
    case 'unload':
      return finish(ctx, e, inv.unload(it), false);
    case 'drop': {
      if (e.where === 'ground') return null;
      return finish(ctx, e, inv.drop(it), false);
    }
    case 'read':
      if (itemActionHooks.read) itemActionHooks.read(it);
      else ctx.game.message(it.isBook() ? "You can't concentrate on reading right now." : `You can't read a ${it.name()}.`, 'c_light_red');
      return null;
    case 'throw':
      if (itemActionHooks.throw) itemActionHooks.throw(it);
      else ctx.game.message("You can't throw things yet.", 'c_light_red');
      return null;
    case 'examine':
      showItemInfo(ctx, it);
      return null;
  }
}

export function showItemInfo(ctx: UiContext, it: Item): UiWindow {
  const w = openWindow({ title: it.name(), width: 'min(70ch, 90vw)' });
  w.body.innerHTML = `${spriteImg(ctx.renderer, it.typeId, 'icon-big')}${itemInfo(it, ctx.game.player)}`;
  return w;
}

/** Actions that make sense for an item, CDDA item-action-menu hotkeys. */
function actionsFor(e: InvEntry): { action: ItemAction; key: string; label: string; ok: boolean }[] {
  const it = e.item;
  const worn = e.where === 'worn';
  const out = [
    { action: 'apply' as const, key: 'a', label: 'Activate', ok: useActions(it.def).length > 0 },
    { action: 'read' as const, key: 'R', label: 'Read', ok: it.isBook() },
    { action: 'eat' as const, key: 'E', label: 'Eat', ok: !!it.isComestible() || it.containerPockets().some((p) => p.contents.some((c) => c.isComestible())) },
    { action: 'wear' as const, key: 'W', label: 'Wear', ok: it.isArmor() && !worn },
    { action: 'wield' as const, key: 'w', label: e.where === 'wielded' ? 'Put away' : 'Wield', ok: true },
    { action: 'throw' as const, key: 't', label: 'Throw', ok: e.where !== 'worn' },
    { action: 'takeoff' as const, key: 'T', label: 'Take off', ok: worn },
    { action: 'drop' as const, key: 'd', label: 'Drop', ok: e.where !== 'ground' },
    { action: 'unload' as const, key: 'U', label: 'Unload', ok: it.isGun() || it.isMagazine() },
    { action: 'reload' as const, key: 'r', label: 'Reload', ok: it.isGun() || it.isMagazine() },
    { action: 'examine' as const, key: 'x', label: 'Examine', ok: true },
  ];
  if (it.isComestible() && it.isLiquid()) out[2].label = 'Drink';
  return out;
}

/** CDDA's item action menu: the item's info plus a list of what you can do with it. */
export function openItemMenu(ctx: UiContext, e: InvEntry, onDone?: () => void): UiWindow {
  const acts = actionsFor(e);
  return openMenu<ItemAction>({
    title: e.item.name(),
    width: 'min(96ch, 94vw)',
    detailPane: true,
    entries: acts.map((a) => ({
      label: a.ok ? a.label : c('c_dark_gray', a.label),
      value: a.action,
      hotkey: a.key,
      disabled: !a.ok,
      detail: () => `${spriteImg(ctx.renderer, e.item.typeId, 'icon-big')}${itemInfo(e.item, ctx.game.player)}`,
    })),
    onSelect: (action) => {
      // Examine opens on top; everything else closes the menu first.
      if (action === 'examine') {
        doAction(ctx, action, e);
        return false;
      }
      setTimeout(() => {
        doAction(ctx, action, e);
        onDone?.();
      }, 0);
    },
  });
}

// ------------------------------------------------------------------ single pickers

export interface PickOpts {
  title: string;
  filter: (e: InvEntry) => boolean;
  includeNearby?: boolean;
  /** Message when nothing matches (CDDA wording, e.g. "You have nothing to wear."). */
  none: string;
  onPick: (e: InvEntry) => void;
  /** Keep the menu open and refresh after picking (the `i` screen). */
  stay?: boolean;
}

export function openItemPicker(ctx: UiContext, opts: PickOpts): UiWindow | null {
  const build = (): MenuEntry<InvEntry>[] => {
    const list = [...carriedEntries(ctx), ...(opts.includeNearby ? nearbyEntries(ctx) : [])].filter(opts.filter);
    // Group each top-level entry with the nested items listed right after it, then order
    // groups CDDA-style: wielded, worn, pocket contents by category sort_rank, nearby.
    const groups: InvEntry[][] = [];
    for (const e of list) {
      if (e.depth > 0 && groups.length) groups[groups.length - 1].push(e);
      else groups.push([e]);
    }
    const rank = (e: InvEntry) => (ctx.game.data.misc?.item_category?.[e.item.def.category]?.sort_rank as number | undefined) ?? 0;
    const whereRank = { wielded: 0, worn: 1, carried: 2, ground: 3 } as const;
    groups.sort((ga, gb) => {
      const a = ga[0], b = gb[0];
      if (a.where !== b.where) return whereRank[a.where] - whereRank[b.where];
      if (a.where !== 'carried') return 0;
      return rank(a) - rank(b) || categoryName(a.item).localeCompare(categoryName(b.item)) || a.item.name().localeCompare(b.item.name());
    });
    const ordered = groups.flat();
    let lastSection = '';
    return ordered.map((e) => {
      const section = e.depth > 0 ? lastSection : sectionOf(e);
      lastSection = section;
      return {
        label: itemLabel(ctx, e),
        value: e,
        header: section,
        detail: () => `${spriteImg(ctx.renderer, e.item.typeId, 'icon-big')}${itemInfo(e.item, ctx.game.player)}`,
      };
    });
  };
  const entries = build();
  if (!entries.length) {
    ctx.game.message(opts.none, 'c_light_gray');
    return null;
  }
  const win = openMenu<InvEntry>({
    title: opts.title,
    width: 'min(120ch, 96vw)',
    height: '86vh',
    detailPane: true,
    footer: statusFooter(ctx),
    entries,
    onSelect: (e) => {
      if (opts.stay) {
        opts.onPick(e);
        return false;
      }
      setTimeout(() => opts.onPick(e), 0);
    },
  });
  win.body.prepend(Object.assign(document.createElement('div'), { innerHTML: columnHeader() }));
  if (opts.stay) {
    // The `i` screen: after an action, rebuild the list in place.
    (win as any).rebuild = () => {
      const next = build();
      if (!next.length) return win.close();
      win.refresh(next);
      win.setFooter(statusFooter(ctx));
    };
  }
  return win;
}

// ------------------------------------------------------------------ multi-select (drop/pickup)

export interface MultiRow {
  entry: InvEntry;
  /** Max selectable count (charges for stacks, 1 otherwise). */
  max: number;
  /** Selected count, 0 = not selected. */
  count: number;
}

/**
 * CDDA multi-select: letter toggles all/none, "12" then a letter selects 12, Space/→
 * toggles the highlighted row, ',' selects everything, Enter confirms.
 */
export function openMultiSelect(ctx: UiContext, title: string, rows: MultiRow[], confirmLabel: string, onConfirm: (rows: MultiRow[]) => void): UiWindow {
  let digits = '';
  let current: MultiRow | undefined;
  const build = (): MenuEntry<MultiRow>[] => {
    let lastSection = '';
    return rows.map((r) => {
      const section = r.entry.depth > 0 ? lastSection : sectionOf(r.entry);
      lastSection = section;
      const mark = r.count === 0 ? '[ ]' : r.count >= r.max ? c('c_light_green', '[X]') : c('c_yellow', '[#]');
      const cnt = r.max > 1 ? c(r.count ? 'c_white' : 'c_dark_gray', `${r.count}/${r.max}`.padStart(9)) : ' '.repeat(9);
      return {
        label: `${mark} ${itemLabel(ctx, r.entry, 34)} ${cnt}`,
        value: r,
        header: section,
        detail: () => `${spriteImg(ctx.renderer, r.entry.item.typeId, 'icon-big')}${itemInfo(r.entry.item, ctx.game.player)}`,
      };
    });
  };
  const footer = () => {
    const n = rows.filter((r) => r.count > 0).length;
    return `${c('c_light_green', 'Enter')} ${confirmLabel} ${n ? `(${n} selected)` : ''}  ${c('c_light_green', ',')} all  ${c('c_light_green', 'Space')} toggle  ${c('c_light_green', '0-9')} count${digits ? `: ${c('c_yellow', digits)}` : ''}`;
  };
  const toggle = (r: MultiRow) => {
    const n = digits ? Math.min(r.max, Math.max(0, parseInt(digits, 10))) : r.count ? 0 : r.max;
    r.count = n;
    digits = '';
  };
  const win = openMenu<MultiRow>({
    title,
    width: 'min(124ch, 96vw)',
    height: '86vh',
    detailPane: true,
    footer: footer(),
    entries: build(),
    onKey: (e, cur) => {
      current = cur;
      if (/^[0-9]$/.test(e.key)) {
        digits = (digits + e.key).slice(0, 5);
        win.setFooter(footer());
        return true;
      }
      if (e.key === 'Backspace') {
        digits = digits.slice(0, -1);
        win.setFooter(footer());
        return true;
      }
      if (e.key === 'Enter') {
        const chosen = rows.filter((r) => r.count > 0);
        win.close();
        if (chosen.length) onConfirm(chosen);
        return true;
      }
      if (e.key === ' ' || e.key === 'ArrowRight') {
        if (current) toggle(current);
        win.refresh(build());
        win.setFooter(footer());
        return true;
      }
      if (e.key === ',') {
        const all = rows.every((r) => r.count === r.max);
        for (const r of rows) r.count = all ? 0 : r.max;
        win.refresh(build());
        win.setFooter(footer());
        return true;
      }
      return false;
    },
    onSelect: (r) => {
      toggle(r);
      win.refresh(build());
      win.setFooter(footer());
      return false;
    },
  });
  win.body.prepend(Object.assign(document.createElement('div'), { innerHTML: `<div class="pre" style="color:var(--c-light_blue)">    ${'Name'.padEnd(36)}${'kg'.padStart(6)} ${'L'.padStart(6)} ${'amount'.padStart(9)}</div>` }));
  return win;
}

const maxOf = (it: Item) => (it.countByCharges ? it.charges : 1);

export function openDropMenu(ctx: UiContext): UiWindow | null {
  const rows = carriedEntries(ctx).map((entry) => ({ entry, max: maxOf(entry.item), count: 0 }));
  if (!rows.length) {
    ctx.game.message("You have nothing to drop.", 'c_light_gray');
    return null;
  }
  return openMultiSelect(ctx, 'Drop which items?', rows, 'drop', (chosen) => {
    const inv = ctx.game.player.inv;
    // Drop nested items before their containers so we don't drop something twice.
    for (const r of [...chosen].sort((a, b) => b.entry.depth - a.entry.depth)) {
      const it = r.entry.item;
      if (!inv.has(it)) continue;
      if (it.countByCharges && r.count < it.charges) {
        const piece = it.split(r.count);
        placeDropped(ctx, [piece]);
        ctx.game.message(`You drop ${piece.name()}.`);
      } else {
        placeDropped(ctx, inv.drop(it).dropped);
      }
    }
  });
}

export function openPickupMenu(ctx: UiContext): UiWindow | null {
  const near = nearbyEntries(ctx);
  if (!near.length) {
    ctx.game.message('There is nothing to pick up nearby.', 'c_light_gray');
    return null;
  }
  const rows = near.map((entry) => ({ entry, max: maxOf(entry.item), count: 0 }));
  // A single item under you is picked up directly, like CDDA's pickup of a lone item.
  if (rows.length === 1 && !rows[0].entry.item.countByCharges) {
    pickUpRows(ctx, [{ ...rows[0], count: 1 }]);
    return null;
  }
  return openMultiSelect(ctx, 'Pick up which items?', rows, 'pick up', (chosen) => pickUpRows(ctx, chosen));
}

export function pickUpRows(ctx: UiContext, chosen: MultiRow[]): void {
  const inv = ctx.game.player.inv;
  const map = ctx.game.map;
  for (const r of chosen) {
    const e = r.entry;
    const it = e.item;
    const pos = e.pos!;
    if (it.countByCharges && r.count < it.charges) {
      const piece = it.split(r.count);
      const res = inv.pickUp(piece);
      if (!res.ok) it.charges += piece.charges;
    } else {
      const res = inv.pickUp(it);
      if (res.ok) map.removeItem(pos.x, pos.y, pos.z, it);
      else break; // CDDA stops at the first thing that doesn't fit
    }
  }
}

// ------------------------------------------------------------------ install

export function installInventoryUi(ctx: UiContext): void {
  const { game } = ctx;
  const inv = () => game.player.inv;
  const pick = (title: string, none: string, filter: (e: InvEntry) => boolean, act: ItemAction, nearby = true) => () =>
    openItemPicker(ctx, { title, none, filter, includeNearby: nearby, onPick: (e) => doAction(ctx, act, e) });

  game.keys.register('inventory', 'Open inventory', () => {
    const win = openItemPicker(ctx, {
      title: 'Inventory',
      none: 'Your inventory is empty.',
      filter: (e) => e.where !== 'ground',
      stay: true,
      onPick: (e) => openItemMenu(ctx, e, () => (win as any)?.rebuild?.()),
    });
  });
  game.keys.register('wield', 'Wield item', pick('Wield what?', 'You have nothing to wield.', (e) => e.where !== 'worn', 'wield'));
  game.keys.register('wear', 'Wear item', pick('Wear what?', 'You have nothing to wear.', (e) => e.item.isArmor() && e.where !== 'worn', 'wear'));
  game.keys.register('takeoff', 'Take off worn item', pick('Take off what?', 'You are not wearing anything.', (e) => e.where === 'worn', 'takeoff', false));
  game.keys.register('eat', 'Eat / drink', pick('Consume item', 'You have nothing to consume.', (e) => !!inv().comestibleIn(e.item), 'eat'));
  game.keys.register('apply', 'Activate / apply item', pick('Use item', "You don't have any items you can use.", (e) => useActions(e.item.def).length > 0, 'apply'));
  game.keys.register('drop', 'Drop items', () => openDropMenu(ctx));
  game.keys.register('pickup', 'Pick up items nearby', () => openPickupMenu(ctx));
  game.keys.register('unload', 'Unload item', pick('Unload what?', 'You have nothing to unload.', (e) => (e.item.isGun() || e.item.isMagazine()) && e.item.ammoRemaining() > 0, 'unload', false));
  game.keys.register('reload', 'Reload wielded item', () => {
    const w = inv().wielded;
    // CDDA 'r' reloads the wielded weapon when it can take ammo, else asks.
    if (w && (w.isGun() || w.isMagazine())) return void doAction(ctx, 'reload', { item: w, where: 'wielded', depth: 0 });
    pick('Reload what?', 'You have nothing to reload.', (e) => e.item.isGun() || e.item.isMagazine(), 'reload', false)();
  });
}

export { escapeHtml };

import type { Item } from '../game/item';
import { unloadContainer } from './liquid_ui';
import type { ActionResult } from '../game/inventory';
import { itemActionName, qualityUsages, useActions } from '../game/inventory';
import { upsToggleLabel } from '../game/upsTransfer';
import { isAt, L, moveItem, type Loc } from '../game/moves';
import { patchInteractUi } from '../game/interact';
import { c, openMenu, openWindow, type MenuEntry, type UiWindow } from './framework';
import { fit, kg, liters } from './format';
import { categoryName, escapeHtml, itemInfo } from './iteminfo';
import { spriteImg, type UiContext } from './context';

// The v1 inventory screens (inventory_ui.cpp look): the `i` overview, the single-purpose
// pickers (wield, wear, take off, eat, apply, reload, unload), and the multi-select drop and
// pickup menus with "type a number, then the letter" counts. Items near the player (the tile
// you stand on and the 8 around it) are offered too, like the "NEARBY" section. Every entry
// carries the exact location of its item (src/game/moves.ts) and every action is a move from
// there, so a stale entry fails instead of duplicating anything. The v2 screens replace these.

export type Where = 'wielded' | 'worn' | 'carried' | 'ground';

export interface InvEntry {
  item: Item;
  where: Where;
  /** Exactly where the item sits (hands, worn, inventory, inside a container, a tile). */
  loc: Loc;
  /** Map tile for ground items. */
  pos?: { x: number; y: number; z: number };
  /** Nesting depth inside containers (for indentation). */
  depth: number;
  /** For ground items: direction label ("under you", "north"…). */
  dir?: string;
  /** Identical items shown as one line ("2 canned beans"); item is stack[0]. */
  stack?: Item[];
  /** Container item this entry sits in (nested entries only). */
  parent?: Item;
}

/**
 * Collapse identical items into one entry ("2 cans of beans"). Depth-0 carried items, ground
 * items on the same tile, and items inside the same container merge; charge stacks (ammo,
 * liquids) are already one item. Only entries at the same location merge.
 */
export function stackEntries(list: InvEntry[]): InvEntry[] {
  const out: InvEntry[] = [];
  for (const e of list) {
    const mergeable = (e.depth === 0 ? e.where === 'carried' || e.where === 'ground' : !!e.parent) && !e.item.countByCharges;
    const into = mergeable
      ? out.find((o) => o.depth === e.depth && o.parent === e.parent && o.where === e.where && o.dir === e.dir && sameLoc(o.loc, e.loc) && !o.item.countByCharges && o.item.stacksWith(e.item))
      : undefined;
    if (into) (into.stack ??= [into.item]).push(e.item);
    else out.push({ ...e });
  }
  return out;
}

function sameLoc(a: Loc, b: Loc): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ground' && b.kind === 'ground') return a.x === b.x && a.y === b.y && a.z === b.z;
  if ((a.kind === 'in' || a.kind === 'mag' || a.kind === 'mod') && (b.kind === 'in' || b.kind === 'mag' || b.kind === 'mod')) return a.host === b.host;
  if (a.kind === 'cargo' && b.kind === 'cargo') return a.part === b.part;
  return true;
}

/** Items an entry stands for (the whole stack, or just the item). */
export const itemsOf = (e: InvEntry): Item[] => e.stack ?? [e.item];

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

/** Everything the player has, in BN's order: wielded, worn, then the inventory; contents nested. */
export function carriedEntries(ctx: UiContext): InvEntry[] {
  const p = ctx.game.player;
  const inv = p.inv;
  const out: InvEntry[] = [];
  if (inv.wielded) {
    out.push({ item: inv.wielded, where: 'wielded', loc: L.hands(p), depth: 0 });
    pushContents(out, inv.wielded, 1);
  }
  for (const w of inv.worn) {
    out.push({ item: w, where: 'worn', loc: L.worn(p), depth: 0 });
    pushContents(out, w, 1);
  }
  for (const it of inv.items) {
    out.push({ item: it, where: 'carried', loc: L.inv(p), depth: 0 });
    pushContents(out, it, 1);
  }
  return out;
}

function pushContents(out: InvEntry[], it: Item, depth: number): void {
  for (const inner of it.contents) {
    out.push({ item: inner, where: 'carried', loc: L.in(it), depth, parent: it });
    pushContents(out, inner, depth + 1);
  }
  if (it.magazine) out.push({ item: it.magazine, where: 'carried', loc: L.mag(it), depth, parent: it });
}

/** Items on the player's tile and the 8 around it. */
export function nearbyEntries(ctx: UiContext): InvEntry[] {
  const p = ctx.game.player;
  const out: InvEntry[] = [];
  const order = [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  for (const [dx, dy] of order) {
    const x = p.tileX + dx, y = p.tileY + dy;
    const loc = L.ground(ctx.game.map, x, y, p.z);
    for (const it of ctx.game.map.itemsAt(x, y, p.z) as Item[]) {
      out.push({ item: it, where: 'ground', loc, pos: { x, y, z: p.z }, depth: 0, dir: DIRS[`${dx},${dy}`] });
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

/** Name column width that fits the list pane (half the window) at the current size. */
export function nameWidth(): number {
  return window.innerWidth < 1100 ? 26 : window.innerWidth < 1500 ? 32 : 38;
}

/** Item name with sprite icon, CDDA-ish coloring, padded to a column. */
export function itemLabel(ctx: UiContext, e: InvEntry, width = nameWidth()): string {
  const it = e.item;
  const n = e.stack?.length ?? 1;
  const indent = e.depth > 0 ? '  '.repeat(e.depth - 1) + '> ' : '';
  let name = indent + (n > 1 ? `${n} ${it.name(n)}` : it.name());
  name = fit(name, width);
  let col = 'c_light_gray';
  if (it.goesBad() && it.rotten()) col = 'c_brown';
  else if (e.where === 'wielded' || e.where === 'worn') col = 'c_white';
  const w = kg(it.weight() * n).padStart(6), v = liters(it.volume() * n).padStart(6);
  const icon = spriteImg(ctx.renderer, it.typeId) || '<span class="icon"></span>';
  return `${icon}${c(col, name)} ${c('c_light_gray', w)} ${c('c_light_gray', v)}`;
}

const columnHeader = (width = nameWidth()) => `<div class="pre" style="color:var(--c-light_blue)">${' '.repeat(2)}<span class="icon"></span>${'Name'.padEnd(width + 1)}${'kg'.padStart(6)} ${'L'.padStart(6)}</div>`;

function statusFooter(ctx: UiContext): string {
  const inv = ctx.game.player.inv;
  const wt = inv.weightCarried(), cap = inv.weightCapacity();
  const vol = inv.volumeCarried(), vcap = inv.volumeCapacity();
  return `Weight (kg): ${c(wt > cap ? 'c_red' : 'c_light_gray', kg(wt))}/${kg(cap)}   Volume (L): ${c(vol > vcap ? 'c_red' : 'c_light_gray', liters(vol))}/${liters(vcap)}`;
}

/** Menu text for a use_action: its menu_text override, else BN's item_actions.json name. */
export function useActionLabel(it: Item, ua: { type: string; menu_text?: unknown }): string {
  if (typeof ua.menu_text === 'string' && ua.menu_text) return ua.menu_text;
  return itemActionName(it.data, ua.type);
}

// ------------------------------------------------------------------ actions

export type ItemAction = 'wield' | 'wear' | 'takeoff' | 'eat' | 'apply' | 'read' | 'reload' | 'unload' | 'drop' | 'examine' | 'throw';

export function doAction(ctx: UiContext, action: ItemAction, e: InvEntry): ActionResult | null {
  const p = ctx.game.player;
  const inv = p.inv;
  const it = e.item;
  // The list may be older than the world: act only on an item that is still where it was.
  if (!isAt(it, e.loc) && action !== 'examine') {
    ctx.game.message(`The ${it.name()} is no longer there.`, 'c_light_red');
    return null;
  }
  switch (action) {
    case 'wield':
      if (e.where === 'wielded') return inv.unwield();
      return inv.wield(it, e.loc);
    case 'wear':
      return inv.wear(it, e.loc);
    case 'takeoff':
      return inv.takeOff(it);
    case 'eat':
      return inv.consume(it, e.loc);
    case 'apply': {
      // Tool-quality usages (a shovel's till / dig) share one handler with its own menu of
      // what's possible here, so they're one entry; listing each would ask twice.
      const qTypes = new Set(qualityUsages.map((u) => u.type));
      let quality = false;
      const acts = useActions(it.def)
        .map((ua, i) => ({ ua, i }))
        .filter(({ ua }) => !qTypes.has(ua.type) || (!quality && (quality = true)));
      if (acts.length > 1) {
        // The activate submenu: "Light up" / "Start a fire" for a refillable lighter.
        openMenu({
          title: it.name(),
          entries: acts.map(({ ua, i }) => ({ label: c('c_white', qTypes.has(ua.type) ? `Use your ${it.baseName()}` : ua.type === 'TOGGLE_UPS_CHARGING' ? upsToggleLabel(it) : useActionLabel(it, ua)), value: i })),
          onSelect: (i) => void (isAt(it, e.loc) && inv.use(it, undefined, i, e.loc)),
        });
        return null;
      }
      return inv.use(it, undefined, acts[0]?.i, e.loc);
    }
    case 'reload':
      return inv.reload(it);
    case 'unload':
      // Containers (a pot of boiled water, a bag of chips): unload empties them.
      if (!reloadable(it)) {
        unloadContainer(ctx.game, it);
        return null;
      }
      return inv.unload(it);
    case 'drop': {
      if (e.where === 'ground') return null;
      return inv.drop(it);
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

/** Guns and magazines, and tools that take one (a flashlight's battery) or hold ammo. */
const reloadable = (it: Item): boolean => it.isGun() || it.isMagazine() || it.takesMagazines() || it.hasIntegralMagazine() || it.isBandolier();

/**
 * Actions that make sense for an item. Hotkeys are the game's own keys for the same action
 * (wear is O here, like outside the menu), so what a player learns in one place works in the
 * other; `key` maps an action id to its key, falling back to CDDA's letter.
 */
function actionsFor(e: InvEntry, key: (id: string, cdda: string) => string): { action: ItemAction; key: string; label: string; ok: boolean }[] {
  const it = e.item;
  const worn = e.where === 'worn';
  const out = [
    { action: 'apply' as const, key: key('apply', 'a'), label: 'Activate', ok: useActions(it.def).length > 0 },
    { action: 'read' as const, key: key('read', 'R'), label: 'Read', ok: it.isBook() },
    { action: 'eat' as const, key: key('eat', 'E'), label: 'Eat', ok: !!it.isComestible() || it.contents.some((c) => c.isComestible()) },
    { action: 'wear' as const, key: key('wear', 'W'), label: 'Wear', ok: it.isArmor() && !worn },
    { action: 'wield' as const, key: key('wield', 'w'), label: e.where === 'wielded' ? 'Put away' : 'Wield', ok: true },
    { action: 'throw' as const, key: key('throw', 't'), label: 'Throw', ok: e.where !== 'worn' },
    { action: 'takeoff' as const, key: key('takeoff', 'T'), label: 'Take off', ok: worn },
    { action: 'drop' as const, key: key('drop', 'd'), label: 'Drop', ok: e.where !== 'ground' },
    { action: 'unload' as const, key: key('unload', 'U'), label: 'Unload', ok: (reloadable(it) && (it.ammoRemaining() > 0 || !!it.magazine)) || (it.hasContents() && !it.isMagazine()) },
    { action: 'reload' as const, key: key('reload', 'r'), label: 'Reload', ok: reloadable(it) },
    { action: 'examine' as const, key: key('look', 'x'), label: 'Examine', ok: true },
  ];
  if (it.isComestible() && it.isLiquid()) out[2].label = 'Drink';
  return out;
}

/** Item-menu actions added by other systems (gunmods: install/remove). Shown only when `ok`. */
export interface ExtraItemAction {
  key: string;
  label: (e: InvEntry) => string;
  ok: (e: InvEntry) => boolean;
  run: (ctx: UiContext, e: InvEntry) => void;
}
export const extraItemActions: ExtraItemAction[] = [];

/** CDDA's item action menu: the item's info plus a list of what you can do with it. */
export function openItemMenu(ctx: UiContext, e: InvEntry, onDone?: () => void): UiWindow {
  const keys = ctx.game.keys;
  const used = new Set(extraItemActions.map((x) => x.key));
  const acts = actionsFor(e, (id, cdda) => {
    const k = keys.keyFor(id);
    const pick = k.length === 1 && k !== '?' && !used.has(k) ? k : cdda;
    used.add(pick);
    return pick;
  });
  const detail = () => `${spriteImg(ctx.renderer, e.item.typeId, 'icon-big')}${itemInfo(e.item, ctx.game.player)}`;
  const extra = extraItemActions.filter((x) => x.ok(e));
  return openMenu<ItemAction | ExtraItemAction>({
    title: e.item.name(),
    width: 'min(96ch, 94vw)',
    detailPane: true,
    entries: [
      ...acts.map((a) => ({
        label: a.ok ? a.label : c('c_dark_gray', a.label),
        value: a.action as ItemAction | ExtraItemAction,
        hotkey: a.key,
        disabled: !a.ok,
        detail,
      })),
      ...extra.map((x) => ({ label: x.label(e), value: x as ItemAction | ExtraItemAction, hotkey: x.key, detail })),
    ],
    onSelect: (action) => {
      // Examine opens on top; everything else closes the menu first.
      if (action === 'examine') {
        doAction(ctx, action, e);
        return false;
      }
      setTimeout(() => {
        if (typeof action === 'string') doAction(ctx, action, e);
        else action.run(ctx, e);
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
    const kept = [...carriedEntries(ctx), ...(opts.includeNearby ? nearbyEntries(ctx) : [])].filter(opts.filter);
    // Contents whose container was filtered out (coins when the wallet can't be applied) stand
    // on their own; otherwise they'd be drawn as "> 2 dimes" under whatever item came before.
    const shown = new Set(kept.map((e) => e.item));
    const list = stackEntries(kept.map((e) => (e.depth > 0 && e.parent && !shown.has(e.parent) ? { ...e, depth: 0 } : e)));
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
  widenList(win);
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
        label: `${mark} ${itemLabel(ctx, r.entry, nameWidth() - 4)} ${cnt}`,
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
    // Space toggles the highlighted row here (CDDA multi-select): Bksp / the opening key close.
    closeKey: false,
    footer: footer(),
    entries: build(),
    onKey: (e, cur) => {
      current = cur;
      if (/^[0-9]$/.test(e.key)) {
        digits = (digits + e.key).slice(0, 5);
        win.setFooter(footer());
        return true;
      }
      if (e.key === 'Backspace' && digits) {
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
  win.body.prepend(Object.assign(document.createElement('div'), { innerHTML: `<div class="pre" style="color:var(--c-light_blue)">      <span class="icon"></span>${'Name'.padEnd(nameWidth() - 3)}${'kg'.padStart(6)} ${'L'.padStart(6)} ${'amount'.padStart(9)}</div>` }));
  widenList(win);
  return win;
}

const maxOf = (e: InvEntry) => (e.stack ? e.stack.length : e.item.countByCharges ? e.item.charges : 1);

/** Give the list pane of a detail-pane menu more room than the description. */
function widenList(win: UiWindow): void {
  const list = win.body.querySelector('.cols')?.firstElementChild as HTMLElement | null;
  if (list) list.style.flex = '1.35';
}

export function openDropMenu(ctx: UiContext): UiWindow | null {
  const rows = stackEntries(carriedEntries(ctx)).map((entry) => ({ entry, max: maxOf(entry), count: 0 }));
  if (!rows.length) {
    ctx.game.message('You have nothing to drop.', 'c_light_gray');
    return null;
  }
  return openMultiSelect(ctx, 'Drop which items?', rows, 'drop', (chosen) => dropRows(ctx, chosen));
}

export function dropRows(ctx: UiContext, chosen: MultiRow[]): void {
  const inv = ctx.game.player.inv;
  const ground = inv.groundHere();
  if (!ground) return;
  // Nested items first: dropping a container carries its contents along, so a content row
  // handled afterwards would find its item gone (and skip it rather than drop it twice).
  for (const r of [...chosen].sort((a, b) => b.entry.depth - a.entry.depth)) {
    const e = r.entry;
    if (e.stack) {
      for (const one of e.stack.slice(0, r.count)) if (isAt(one, e.loc)) dropOne(ctx, one, e.loc, ground);
      continue;
    }
    if (!isAt(e.item, e.loc)) continue;
    dropOne(ctx, e.item, e.loc, ground, e.item.countByCharges ? Math.min(r.count, e.item.charges) : undefined);
  }
}

function dropOne(ctx: UiContext, it: Item, from: Loc, ground: Loc, count?: number): void {
  const p = ctx.game.player;
  const r = moveItem(it, from, ground, { count, actor: p, quiet: true });
  if (r.ok) ctx.game.message(from.kind === 'worn' ? `You take off and drop your ${it.name()}.` : `You drop your ${r.item?.countByCharges ? `${it.baseName(r.moved)}${r.moved > 1 ? ` (${r.moved})` : ''}` : it.name()}.`);
  else ctx.game.message(r.msg, 'c_light_red');
}

export function openPickupMenu(ctx: UiContext): UiWindow | null {
  const near = stackEntries(nearbyEntries(ctx));
  if (!near.length) {
    ctx.game.message('There is nothing to pick up nearby.', 'c_light_gray');
    return null;
  }
  const rows = near.map((entry) => ({ entry, max: maxOf(entry), count: 0 }));
  // A lone item is picked up directly, when there's only one thing there.
  if (rows.length === 1 && rows[0].max === 1) {
    pickUpRows(ctx, [{ ...rows[0], count: 1 }]);
    return null;
  }
  return openMultiSelect(ctx, 'Pick up which items?', rows, 'pick up', (chosen) => pickUpRows(ctx, chosen));
}

/**
 * `e` on a locker/dresser/pile: the multi-select pickup for that one tile, so emptying a
 * locker is `,` Enter rather than one item per keypress.
 */
export function openTilePickup(ctx: UiContext, title: string, x: number, y: number, z: number): UiWindow | null {
  const items = ctx.game.map.itemsAt(x, y, z) as Item[];
  if (!items.length) return null;
  const loc = L.ground(ctx.game.map, x, y, z);
  const rows = stackEntries(items.map((item) => ({ item, where: 'ground' as const, loc, pos: { x, y, z }, depth: 0, dir: title })))
    .map((entry) => ({ entry, max: maxOf(entry), count: 0 }));
  if (rows.length === 1 && rows[0].max === 1) {
    pickUpRows(ctx, [{ ...rows[0], count: 1 }]);
    return null;
  }
  return openMultiSelect(ctx, title, rows, 'take', (chosen) => pickUpRows(ctx, chosen));
}

export function pickUpRows(ctx: UiContext, chosen: MultiRow[]): void {
  const inv = ctx.game.player.inv;
  for (const r of chosen) {
    const e = r.entry;
    const items = e.stack ? e.stack.slice(0, r.count) : [e.item];
    for (const it of items) {
      if (!isAt(it, e.loc)) continue;
      const count = !e.stack && it.countByCharges ? Math.min(r.count, it.charges) : undefined;
      // Pickup asks "[W]ear it?" for clothes that don't fit; wearing is the useful answer (the
      // evac shelter's emergency jacket). Anything else that doesn't fit is skipped and the
      // rest of the selection is still taken.
      const wearInstead = !inv.canCarry(it) && it.isArmor() && inv.canWear(it).ok;
      const res = wearInstead ? inv.wear(it, e.loc) : inv.pickUp(it, e.loc, count);
      if (!res.ok) break;
    }
  }
}
// ------------------------------------------------------------------ install

export function installInventoryUi(ctx: UiContext): void {
  const { game } = ctx;
  patchInteractUi({ pickup: (title, x, y, z) => void openTilePickup(ctx, title, x, y, z) });
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
  game.keys.register('unload', 'Unload item', pick('Unload what?', 'You have nothing to unload.', (e) => (reloadable(e.item) && (e.item.ammoRemaining() > 0 || !!e.item.magazine)) || (e.item.hasContents() && !e.item.isMagazine()), 'unload', false));
  game.keys.register('reload', 'Reload wielded item', () => {
    const w = inv().wielded;
    // CDDA 'r' reloads the wielded weapon when it can take ammo, else asks.
    if (w && reloadable(w)) return void doAction(ctx, 'reload', { item: w, where: 'wielded', loc: L.hands(game.player), depth: 0 });
    pick('Reload what?', 'You have nothing to reload.', (e) => reloadable(e.item), 'reload', false)();
  });
}

export { escapeHtml };

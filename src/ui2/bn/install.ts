// Wires the BN inventory screens into the game: the model over the player's real items, the
// keys (i / Tab open it; the old single-action keys z O T E u q U open a quick picker; g
// picks up or opens the loot tab), `e` on lockers / piles / corpses / trunks opening the
// screen on that place, the hotbar (live in gameplay: 1…0 use what's bound), timed actions
// and the liquid menu. Options > "Inventory screens" switches back to the v1 lists.

import { canPowerOn } from '../../game/lightitems';
import { adaptEatRows } from './eat_rows';
import type { Game } from '../../game/game';
import type { UiContext } from '../../ui/context';
import type { DebugApi } from '../../debug';
import type { Item } from '../../game/item';
import { itemKey, scopeLocs, type InventoryScope } from '../../game/inventory_view';
import { useActions } from '../../game/inventory';
import { census, L, spawnItem, spawnOnGround, type Loc, type Cargo } from '../../game/moves';
import { createItem } from '../../game/item';
import { has, type VehiclePart } from '../../game/vehicle';
import { patchInteractUi } from '../../game/interact';
import { itemInfo } from '../../ui/iteminfo';
import { extraItemActions, type InvEntry } from '../../ui/inventory_ui';
import { cargoPanel, openCargoPanel } from '../../screens/vehicle';
import { registerOption } from '../../ui/options';
import { cargoUi } from '../../ui/vehicle_ui';
import { closeGroup } from '../window';
import { countPrompt } from '../modal';
import { toast } from '../toast';
import { startProgress, type ProgressHandle } from '../progress';
import { flashNote } from '../dragdrop';
import { Hotbar, HOTBAR_KEYS } from '../hotbar';
import { itemTooltip } from '../tooltip';
import { setLooksLike } from '../icons';
import { closeKeyLabel, settings, saveSettings } from '../host';
import { worldContextProviders } from '../world';
import type { ItemView } from '../logic/items';
import type { MenuItem } from '../menu';
import { BnInventoryModel, movesToSeconds } from './model';
import { bnInventoryOpen, BN_GROUP, focusSource, openBnInventory } from './screen';
import { examineCard, liquidMenu, openPicker, type PickRow } from './popups';
import type { ListEnv } from './lists';

export interface BnInventoryHandle {
  model: BnInventoryModel;
  hotbar: Hotbar;
  toggle(focus?: string): void;
  open(focus?: string): void;
  /** Open the screen on a place, or bring that place to the front when it's already open. */
  toggleFocus(focus: string): void;
  /** Run a timed action: at once under the tactical pause, else after a progress bar. */
  perform(label: string, moves: number, fn: () => void, anchor?: HTMLElement | null): void;
  /**
   * Looting UIs (src/ui2/loot) take over `g` and `e` on piles for their style; null = the
   * inventory's own Nearby tab. Called with the tile when `e` targets a pile / container.
   */
  lootHooks: { pickupKey: (() => boolean) | null; pile: ((x: number, y: number, z: number) => boolean) | null };
}

/** Real seconds under which an action just happens (no bar flicker). */
const INSTANT = 0.2;

export function installBnInventory(game: Game, ctx: UiContext, api: DebugApi, canvas: HTMLElement): BnInventoryHandle {
  setLooksLike((id) => game.data.items[id]?.looks_like);
  // Places beyond the pickup ring that the player reached for with `e` (a locker a step away).
  let extraTiles: { x: number; y: number; z: number }[] = [];
  const scope = (): InventoryScope => {
    const p = game.player;
    return { who: p, map: game.map, at: { x: p.tileX, y: p.tileY, z: p.z }, reach: 1, extraTiles, cargo: nearbyCargo(game) };
  };
  let last: { x: number; y: number } = { x: innerWidth / 2, y: innerHeight / 2 };
  document.addEventListener('pointerdown', (e) => (last = { x: e.clientX, y: e.clientY }), true);

  // --- timed actions: instant under the tactical pause, a progress bar when time runs
  let busy: ProgressHandle | null = null;
  const perform = (label: string, moves: number, fn: () => void, anchor?: HTMLElement | null) => {
    const secs = movesToSeconds(moves);
    if (game.tacticalPause || secs < INSTANT) return fn();
    if (busy) return flashNote(last.x, last.y, 'Busy: wait for the current action', 'warn');
    const a = anchor ?? null;
    busy = startProgress({
      label, seconds: secs,
      anchor: a ? () => (a.isConnected ? (({ left, top, width }) => ({ x: left + width / 2, y: top }))(a.getBoundingClientRect()) : { x: last.x, y: last.y }) : undefined,
      onDone: () => {
        busy = null;
        fn();
      },
    });
  };

  const model: BnInventoryModel = new BnInventoryModel(scope, {
    notify: (text, tone) => (tone === 'bad' ? flashNote(last.x, last.y, text, 'bad') : toast({ category: tone === 'warn' ? 'warning' : 'info', title: text })),
    liquid: (liquid, from, source) => liquidMenu(game, liquid, from, source, last, () => model.refresh(true)),
    openContainer: (_loc, item) => {
      // Expanding in place reads better than yet another window.
      void import('./lists').then(({ expanded }) => {
        expanded.add(item.id);
        model.refresh(true);
      });
    },
    examine: (it) => examineCard(itemInfo(it, game.player), it.name()),
    bindHotbar: (slot, item) => hotbar.bind(slot, item),
    askCount: (item, verb) => countPrompt({ title: `${verb} how many?`, subtitle: item.name, max: item.count, initial: Math.max(1, Math.floor(item.count / 2)), icon: item.icon, ok: verb }),
    extraActions: (it, loc) => legacyExtras(ctx, it, loc),
    perform: (label, moves, fn) => perform(label, moves, fn),
  });
  const env: ListEnv = { model, perform };

  // --- hotbar: references to real items; falls back to another of the same kind you carry
  const carriedOf = (typeId: string, ref?: string): { view: ItemView; loc: string } | null => {
    let byType: { view: ItemView; loc: string } | null = null;
    let total = 0;
    let exact: { view: ItemView; loc: string } | null = null;
    for (const a of model.all()) {
      if (!model.onBody(a.loc)) continue;
      // The exact item even when a use_action transformed it (smartphone → "smartphone -
      // Flashlight"): the slot read "0 left" in red while the phone lit the room.
      // (or, after a reload when refs are new, the "on" type whose revert_to is the bound one).
      const turnedOn = (a.item.def as { revert_to?: string }).revert_to === typeId;
      if ((ref && a.view.id === ref && a.view.typeId !== typeId) || (turnedOn && a.view.typeId !== typeId)) {
        if (ref && a.view.id === ref) exact = { view: a.view, loc: a.loc };
        else byType ??= { view: a.view, loc: a.loc };
        total += a.view.count;
        continue;
      }
      if (a.view.typeId !== typeId) continue;
      total += a.view.count;
      if (ref && a.view.id === ref) exact = { view: a.view, loc: a.loc };
      byType ??= { view: a.view, loc: a.loc };
    }
    const hit = exact ?? byType;
    return hit ? { view: { ...hit.view, count: total }, loc: hit.loc } : null;
  };
  const hotbar: Hotbar = new Hotbar({
    storageKey: 'cdda3d.ui2.hotbar.bn',
    resolve: (typeId, b) => carriedOf(typeId, b?.ref)?.view ?? null,
    use: (b, item, slot) => {
      model.refresh();
      let found = carriedOf(b.typeId, b.ref);
      if (!item || !found) return void game.message(`You have no ${b.name} left.`, 'c_light_gray');
      // The bound one is dead but another of the same kind works (two flashlights, one
      // flat): use the working one rather than failing.
      const bound = model.entry(found.view.id)?.items[0];
      if (bound && !canPowerOn(bound)) {
        const alt = [...model.all()].find((a) => model.onBody(a.loc) && a.view.typeId === found!.view.typeId && a.view.id !== found!.view.id && canPowerOn(a.item));
        if (alt) found = { view: alt.view, loc: alt.loc };
      }
      const real = model.entry(found.view.id);
      if (!real) return;
      if (found.loc === 'hands') {
        const r = game.player.inv.unwield();
        if (!r.ok) flashNote(last.x, last.y, r.msg, 'bad');
      } else if (!model.hotbarUse(real.view)) {
        // the quick-draw rule had no answer (a bag with contents, an empty bottle): double-click
        const p = model.primary(real.view, found.loc);
        if (p && 'action' in p && p.action) void p.action();
        else game.message(`Nothing to do with the ${b.name} from the hotbar.`, 'c_light_gray');
      }
      model.refresh(true);
      void slot;
    },
    tooltip: (it) => itemTooltip(it, { where: model.where(carriedOf(it.typeId, it.id)?.loc ?? 'inv'), hints: ['Key or click: use', 'Drag off: unbind', 'Right-click: clear'] }),
    active: (b) => carriedOf(b.typeId, b.ref)?.loc === 'hands',
  });
  model.onChange(() => hotbar.refresh());
  // The hotbar is part of the HUD in gameplay. Its model follows the world (eating from it,
  // `g` pickups, crafting) by polling while no screen is open (the screen polls itself).
  let hotbarShown = false;
  const showHotbar = () => {
    if (hotbarShown || game.player.dead) return;
    hotbarShown = true;
    hotbar.mount();
    model.refresh(true);
    firstRunHotbar();
  };
  setInterval(() => {
    if (hotbarShown && !bnInventoryOpen()) model.refresh();
  }, 500);
  game.events.on('playerDied', () => {
    hotbar.unmount();
    hotbarShown = false;
  });
  const firstRunHotbar = () => {
    if (HOTBAR_KEYS.some((_, i) => hotbar.binding(i))) return;
    const inv = game.player.inv;
    const picks: Item[] = [];
    if (inv.wielded) picks.push(inv.wielded);
    // Not the water inside a bottle already picked: slot 2 "clean water (plastic bottle)" and
    // slot 3 "water" were the same drink, and the second counted every clean water carried, so it
    // read "water ×3" with no such item in sight (playtest, round 6).
    const inPicked = (it: Item) => picks.some((q) => q.contents.includes(it));
    for (const it of inv.allItems()) if (picks.length < 4 && !picks.includes(it) && !inPicked(it) && (inv.comestibleIn(it) || useActions(it.def).length) && !inv.worn.includes(it)) picks.push(it);
    picks.forEach((it, i) => {
      const v = model.viewOfItem(it);
      if (v) hotbar.bind(i, v.view);
    });
  };
  const useSlot = (i: number) => () => {
    showHotbar();
    model.refresh();
    hotbar.use(i);
  };
  // Spelled out: tests/ui.test.ts checks every binding in keys.ts is registered in the source.
  const slotName = (k: string) => `Hotbar slot ${k}: use / wield / eat what's bound there`;
  game.keys.register('hotbar_1', slotName('1'), useSlot(0));
  game.keys.register('hotbar_2', slotName('2'), useSlot(1));
  game.keys.register('hotbar_3', slotName('3'), useSlot(2));
  game.keys.register('hotbar_4', slotName('4'), useSlot(3));
  game.keys.register('hotbar_5', slotName('5'), useSlot(4));
  game.keys.register('hotbar_6', slotName('6'), useSlot(5));
  game.keys.register('hotbar_7', slotName('7'), useSlot(6));
  game.keys.register('hotbar_8', slotName('8'), useSlot(7));
  game.keys.register('hotbar_9', slotName('9'), useSlot(8));
  game.keys.register('hotbar_0', slotName('0'), useSlot(9));

  // --- opening
  const inventoryKeys = () => [...game.keys.keysFor('inventory'), ...game.keys.keysFor('inventory2')];
  const open = (focus?: string) => {
    showHotbar();
    if (focus) {
      const t = /^ground:(-?\d+),(-?\d+),(-?\d+)$/.exec(focus);
      if (t) extraTiles = [{ x: +t[1], y: +t[2], z: +t[3] }];
    }
    closeGroup('picker');
    // Free the mouse before building the screen: while the lock is still on, the browser eats an
    // Esc pressed during a slow first open (to exit the lock) and the inventory would stay up.
    game.input.releaseForMenu();
    openBnInventory(env, {
      focus, worldEl: canvas, hotbar, closeKeys: [...inventoryKeys(), 'Backspace'],
      onClose: () => {
        extraTiles = [];
      },
    });
  };
  const toggle = (focus?: string) => {
    if (bnInventoryOpen() && !focus) closeGroup(BN_GROUP);
    else if (bnInventoryOpen() && focus) {
      open(focus);
      focusSource(focus);
    } else open(focus);
  };

  // --- v1 fallback (Options > Inventory screens: Classic)
  const legacy = new Map<string, (() => void) | undefined>();
  for (const id of ['inventory', 'wield', 'wear', 'takeoff', 'eat', 'apply', 'drop', 'pickup', 'unload']) legacy.set(id, game.keys.handler(id));
  const classic = () => !!settings.classicInventory;
  const reg = (id: string, name: string, fn: () => void) => game.keys.register(id, name, () => (classic() && legacy.get(id) ? legacy.get(id)!() : fn()));

  reg('inventory', 'Inventory', () => toggle());
  game.keys.register('inventory2', 'Inventory (also: loot what is nearby)', () => toggle());

  // --- quick pickers for the old one-action keys
  const rowsFor = (pred: (v: ItemView, loc: string, it: Item) => string | false | null, time?: (v: ItemView, loc: string) => number): PickRow[] => {
    model.refresh();
    const out: PickRow[] = [];
    for (const a of model.all()) {
      const r = pred(a.view, a.loc, a.item);
      if (r === null) continue;
      out.push({ view: a.view, loc: a.loc, disabled: r || undefined, time: time?.(a.view, a.loc) });
    }
    return out;
  };
  const actionRow = (label: RegExp) => (v: ItemView, loc: string): string | false | null => {
    const a = model.actions(v, loc).find((m): m is Extract<MenuItem, { label: string }> => 'label' in m && label.test(m.label));
    if (!a || !('action' in a)) return null;
    return typeof a.disabled === 'string' ? a.disabled : false;
  };
  const actionTime = (label: RegExp) => (v: ItemView, loc: string) => {
    const a = model.actions(v, loc).find((m) => 'label' in m && label.test(m.label));
    return a && 'time' in a ? a.time ?? 0 : 0;
  };
  const runAction = (label: RegExp) => (r: PickRow) => {
    const a = model.actions(r.view, r.loc).find((m) => 'label' in m && label.test(m.label));
    if (a && 'action' in a && a.action) void a.action();
  };
  const picker = (id: string, name: string, title: string, none: string, label: RegExp, filter: (v: ItemView, loc: string, it: Item) => boolean = () => true, rank?: (it: Item) => number, adapt?: (rows: PickRow[]) => PickRow[]) =>
    reg(id, name, () => {
      let rows = rowsFor((v, loc, it) => (filter(v, loc, it) ? actionRow(label)(v, loc) : null), actionTime(label)).filter((r) => !r.disabled || model.onBody(r.loc));
      // Carried first, then by how good it is for this (the best weapon on top for z).
      if (rank) rows = rows.map((r) => ({ r, k: (model.onBody(r.loc) ? 1e6 : 0) + rank(model.itemOf(r.view.id)!) })).sort((a, b) => b.k - a.k).map((x) => x.r);
      if (adapt) rows = adapt(rows);
      openPicker(model, {
        title, none, onNone: (msg) => game.message(msg, 'c_light_gray'), closeKeys: game.keys.keysFor(id),
        rows,
        run: runAction(label),
      });
    });
  const meleeScore = (it: Item) => { const d = it.def.melee_damage ?? {}; return (d.bash ?? 0) + (d.cut ?? 0) + (d.stab ?? 0) + (it.isGun() ? 50 : 0); };
  picker('wield', 'Wield item', 'Wield what?', 'You have nothing to wield.', /^Wield$/, (_v, loc, it) => loc !== 'hands' && loc !== 'worn' && !it.isLiquid() && !it.isArmor(), meleeScore);
  picker('wear', 'Wear item', 'Wear what?', 'You have nothing to wear.', /^Wear$/);
  picker('takeoff', 'Take off worn item', 'Take off what?', 'You are not wearing anything.', /^Take off$/);
  // One row per thing you'd drink, in words (eat_rows.ts: no bottle + its water twice, no "(2/2)").
  const adaptEat = (rows: PickRow[]) =>
    adaptEatRows(rows.map((row) => ({ row, item: model.itemOf(row.view.id)!, host: model.hostOf(row.loc) }))).map(({ row, label }) => ({ ...row, label }));
  picker('eat', 'Eat / drink', 'Eat or drink what?', 'You have nothing to consume.', /^(Eat|Drink)$/, undefined, (it) => (it.goesBad() ? 1 + it.relativeRot() * 10 : 0), adaptEat);
  picker('unload', 'Unload / empty item', 'Unload what?', 'You have nothing to unload.', /^(Unload|Empty|Pour out)/, (_v, loc) => model.onBody(loc));
  reg('apply', 'Activate / apply item', () => {
    openPicker(model, {
      title: 'Use what?', none: "You don't have any items you can use.", onNone: (msg) => game.message(msg, 'c_light_gray'), closeKeys: game.keys.keysFor('apply'),
      // An empty lighter or a flat flashlight is listed greyed with why, below the ones that work
      // (playtest: "lighter (0/25)" sat next to the full one, looking just as usable).
      rows: rowsFor((v, loc, it) => {
        if (!model.onBody(loc) || !useActions(it.def).length) return null;
        const per = Number(it.def.charges_per_use ?? 0);
        return per > 0 && it.ammoCapacity() > 0 && it.ammoRemaining() < per ? `Empty (${it.ammoRemaining()}/${it.ammoCapacity()}): it needs charges to use.` : false;
      }),
      run: (r) => {
        const acts = model.actions(r.view, r.loc);
        const use = acts.find((m) => 'label' in m && ('submenu' in m ? m.label === 'Use' : 'key' in m && m.key === 'A'));
        if (use && 'submenu' in use && use.submenu) openMenuAt(model.actions(r.view, r.loc).filter((m) => m === use).flatMap((m) => ('submenu' in m && Array.isArray(m.submenu) ? m.submenu : [])), r.view.name);
        else if (use && 'action' in use && use.action) void use.action();
      },
    });
  });
  const openMenuAt = (items: MenuItem[], title: string) => void import('../menu').then(({ openContextMenu }) => openContextMenu({ x: innerWidth / 2, y: innerHeight / 2 }, items, { title }));
  reg('drop', 'Drop items', () => {
    openPicker(model, {
      title: 'Drop what?', none: 'You have nothing to drop.', onNone: (msg) => game.message(msg, 'c_light_gray'), closeKeys: game.keys.keysFor('drop'),
      rows: rowsFor((v, loc) => (model.onBody(loc) ? (() => { const g = model.who.inv.groundHere(); return g ? (model.check(v.id, ground(g), v.count).kind === 'reject' ? (model.check(v.id, ground(g), v.count) as { reason: string }).reason : false) : 'Nowhere to drop it'; })() : null)),
      note: `Enter: drop · stacks ask how many · ${closeKeyLabel() || 'Bksp'}: cancel`,
      run: async (r) => {
        const g = model.who.inv.groundHere();
        if (!g) return;
        let n = r.view.count;
        if (n > 1) {
          const k = await countPrompt({ title: 'Drop how many?', subtitle: r.view.name, max: n, initial: n, icon: r.view.icon, ok: 'Drop' });
          if (!k) return;
          n = k;
        }
        const res = model.move(r.view.id, ground(g), n);
        if (!res.ok) game.message(res.reason, 'c_light_red');
      },
    });
  });
  const lootHooks: BnInventoryHandle['lootHooks'] = { pickupKey: null, pile: null };
  reg('pickup', 'Pick up items nearby', () => {
    if (lootHooks.pickupKey?.()) return;
    model.refresh();
    const near = model.nearby().filter((p) => p.items.length);
    const total = near.reduce((a, p) => a + p.items.length, 0);
    if (!total) return void game.message('There is nothing to pick up nearby.', 'c_light_gray');
    const g = model.who.inv.groundHere();
    const under = g ? ground(g) : null;
    // One thing lying there: just take it (BN picks up a lone item without a menu).
    if (total === 1 && near[0].items[0].count === 1) {
      const v = model.contents(near[0].key)[0];
      const res = model.move(v.id, 'inv', v.count);
      if (!res.ok) game.message(res.reason, 'c_light_red');
      return;
    }
    toggleFocus(near.find((p) => p.key === under)?.key ?? near[0].key);
  });
  const toggleFocus = (focus: string) => (bnInventoryOpen() ? (focusSource(focus), void 0) : open(focus));

  // --- `e` on a locker / pile / corpse: the screen on that place
  patchInteractUi({
    pickup: (_title, x, y, z) => {
      if (classic()) return legacyPickup(ctx, _title, x, y, z);
      if (lootHooks.pile?.(x, y, z)) return;
      toggleFocus(`ground:${x},${y},${z}`);
    },
  });
  // The vehicle panel's "Open the trunk": the Nearby tab for it when it's within reach.
  cargoPanel.open = (g, v, part) => {
    const i = classic() ? -1 : nearbyCargo(game).findIndex((c) => c.part === part);
    if (i < 0) return openCargoPanel(g, v, part);
    toggleFocus(`cargo:${i}`);
  };
  cargoUi.open = (v, part) => {
    if (classic()) return false;
    const i = nearbyCargo(game).findIndex((c) => c.part === part);
    if (i < 0) return false;
    void v;
    toggleFocus(`cargo:${i}`);
    return true;
  };
  // The world while the cursor is free: right-click a pile / locker for "Open" (the primary).
  worldContextProviders.push((t) => {
    if (t.kind !== 'items' && t.kind !== 'furniture') return [];
    const p = game.player;
    if (t.z !== p.z || Math.max(Math.abs(t.x - p.tileX), Math.abs(t.y - p.tileY)) > 1) return [];
    const f = game.map.furnAt(t.x, t.y, t.z);
    const storage = typeof f.max_volume === 'number' && f.max_volume > 0;
    const n = game.map.itemsAt(t.x, t.y, t.z).length;
    if (!n && !storage) return [];
    return [{ label: n ? `Look inside / loot (${n})` : 'Look inside', key: 'E', time: 0, primary: true, action: () => toggleFocus(`ground:${t.x},${t.y},${t.z}`) }];
  });

  registerOption({
    name: 'Inventory screens',
    desc: 'New: drag & drop windows (i / Tab). Classic: the v1 letter lists for i, z, O, E, q, g…',
    value: () => (classic() ? 'Classic (v1)' : 'New'),
    change: () => {
      settings.classicInventory = !settings.classicInventory;
      saveSettings();
      if (classic()) closeGroup(BN_GROUP);
    },
  });

  // Gameplay started (title / chargen done): the hotbar appears with the first key or screen,
  // or right away once the survivor exists.
  const t = setInterval(() => {
    if (game.input.wantLock && !game.player.dead) {
      showHotbar();
      clearInterval(t);
    }
  }, 500);

  const handle: BnInventoryHandle = { model, hotbar, toggle, open, toggleFocus, perform, lootHooks };
  api.inv2 = {
    model,
    hotbar,
    open: (focus?: string) => open(focus),
    toggle,
    /** Census of everything in reach (for conservation checks from real-input tests). */
    census: () => {
      model.refresh();
      const c = census(scopeLocs(scope()));
      return { counts: Object.fromEntries(c.counts), aliased: c.aliased.length };
    },
    /** Centre of the row/cell showing an item type (in a window, `sel` narrows it). */
    rectOf: (typeId: string, sel = '#ui2') => {
      for (const a of model.all()) {
        if (a.view.typeId !== typeId) continue;
        const el = document.querySelector(`${sel} [data-item="${a.view.id}"]`);
        if (!el) continue;
        // A long list (a cupboard of rations) may have it scrolled out of view.
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2), id: a.view.id, loc: a.loc };
      }
      return null;
    },
    where: (typeId: string) => [...model.all()].filter((a) => a.view.typeId === typeId).map((a) => `${a.loc}×${a.view.count}`),
    key: (it: Item) => itemKey(it),
    /** Test setup: an item on the ground dx/dy from you, optionally with things inside. */
    spawn: (id: string, dx = 0, dy = 0, o: { charges?: number; contents?: [string, number?][] } = {}) => {
      const p = game.player;
      const it = createItem(game.data, id, o.charges ? { charges: o.charges } : {});
      for (const [cid, n] of o.contents ?? []) {
        const c = createItem(game.data, cid, n ? (game.data.items[cid]?.count_by_charges ? { charges: n } : {}) : {});
        const r = spawnItem(c, L.in(it), { force: true });
        if (!r.ok) throw new Error(`spawn: ${cid} won't go in ${id}: ${r.msg}`);
      }
      spawnOnGround(game.map, p.tileX + dx, p.tileY + dy, p.z, it);
      model.refresh(true);
      return itemKey(it);
    },
  };
  return handle;
}

const ground = (g: Loc) => (g.kind === 'ground' ? `ground:${g.x},${g.y},${g.z}` : 'inv');

/** CARGO parts within reach that are open (a closed trunk lid keeps them in). */
export function nearbyCargo(game: Game): { part: Cargo; vehicle?: { version: number; name?: string }; label: string }[] {
  const vs = game.vehicles;
  if (!vs) return [];
  const p = game.player;
  const out: { part: Cargo; vehicle?: { version: number; name?: string }; label: string }[] = [];
  const seen = new Set<VehiclePart>();
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const o = vs.at(p.tileX + dx, p.tileY + dy, p.z);
      if (!o) continue;
      const parts = o.v.partsAt(o.mx, o.my);
      const covered = parts.some((q) => has(q, 'OPENABLE') && !q.open);
      for (const c of parts) {
        if (!has(c, 'CARGO') || seen.has(c) || (covered && !has(c, 'CARGO_PASSABLE'))) continue;
        seen.add(c);
        out.push({ part: c, vehicle: o.v, label: `${o.v.name}'s ${c.def.name}` });
      }
    }
  return out;
}

/** Other systems' v1 item-menu entries (gunmods), as ui2 menu entries. */
function legacyExtras(ctx: UiContext, it: Item, loc: Loc): MenuItem[] {
  const where: InvEntry['where'] = loc.kind === 'hands' ? 'wielded' : loc.kind === 'worn' ? 'worn' : loc.kind === 'ground' || loc.kind === 'cargo' ? 'ground' : 'carried';
  const e: InvEntry = { item: it, where, loc, depth: 0 };
  return extraItemActions.filter((x) => x.ok(e)).map((x) => ({ label: x.label(e).replace(/<[^>]+>/g, ''), action: () => x.run(ctx, e) }));
}

function legacyPickup(ctx: UiContext, title: string, x: number, y: number, z: number): void {
  void import('../../ui/inventory_ui').then(({ openTilePickup }) => openTilePickup(ctx, title, x, y, z));
}

// Looting, wired into the game. Playtest: "It's a little laborious looting a bunch of stuff.
// It's unclear what's even in the item piles from the images and I gotta click in and then
// click out for each pile." Two genuinely different answers, switchable live in Options >
// "Looting style" (persisted with the ui2 settings), plus the inventory's own tabs:
//
//   Quick (default)  Skyrim / Fallout: the crosshair panel (quick.ts) lists what you look at;
//                    wheel / ↑↓ select, [interact] takes, [reload] takes all, [inventory]
//                    opens the full screen on it. No window, no mouse release.
//   Area             Zomboid / BN AIM: [pickup] (g) opens one window with everything in reach,
//                    merged by type (area.ts); it stays open while you walk.
//   Inventory tabs   the inventory's Nearby tabs (the flow before this), for comparison.
//
// All styles: a read-only peek at the top items under the crosshair, pile markers in the world
// (markers.ts), memory of searched containers (saved), and the smart Take all
// (BnInventoryModel.take: best value per room first, never past your weight limit). Every take
// goes through the model → moves.ts, so tests/loot.test.ts holds it to item conservation.

import type { Game } from '../../game/game';
import type { Renderer } from '../../render/renderer';
import type { DebugApi } from '../../debug';
import type { InventoryScope } from '../../game/inventory_view';
import { LootMemory } from '../../game/loot';
import { interactOverrides } from '../../game/interact';
import { registerSaveable } from '../../save/registry';
import { registerOption } from '../../ui/options';
import { settings, saveSettings, surfacesOpen } from '../host';
import { toast } from '../toast';
import { closeGroup } from '../window';
import { BnInventoryModel } from '../bn/model';
import { nearbyCargo, type BnInventoryHandle } from '../bn/install';
import { quickPanel, type QuickSpec } from './quick';
import { installMarkers } from './markers';
import { lootTargetAt, type LootTarget } from './sources';
import { AREA_ID, areaGroups, areaOpen, openArea, type AreaEnv } from './area';
import { shortSummary, summaryTitle } from './summary';
import './loot.css';

export type LootStyle = 'quick' | 'area' | 'tabs';
const STYLES: LootStyle[] = ['quick', 'area', 'tabs'];
const STYLE_NAMES: Record<LootStyle, string> = { quick: 'Quick (crosshair)', area: 'Area (all nearby)', tabs: 'Inventory tabs' };

export function lootStyle(): LootStyle {
  return STYLES.includes(settings.lootStyle as LootStyle) ? (settings.lootStyle as LootStyle) : 'quick';
}

export function installLoot(game: Game, renderer: Renderer, api: DebugApi, inv: BnInventoryHandle, canvas: HTMLElement): void {
  // --- memory of searched containers, saved with the game
  let memory = new LootMemory();
  registerSaveable(game, 'lootMemory', {
    save: () => memory.toJSON(),
    load: (j) => void (memory = LootMemory.fromJSON(j)),
    missing: () => void (memory = new LootMemory()),
  });

  // --- a model over what's in reach (plus the tile aimed at, which can be a step further)
  let extra: { x: number; y: number; z: number }[] = [];
  const scope = (): InventoryScope => {
    const p = game.player;
    return { who: p, map: game.map, at: { x: p.tileX, y: p.tileY, z: p.z }, reach: 1, extraTiles: extra, cargo: nearbyCargo(game) };
  };
  const model = new BnInventoryModel(scope, inv.model.hooks);
  // Under a difficulty that pauses in menus (Accessible) looting from the world is as instant as
  // it would be in the paused inventory; otherwise it takes BN's pickup time (a progress bar).
  const run = (label: string, moves: number, fn: () => void) => (settings.pauseInInventory ? fn() : inv.perform(label, moves, fn));
  const refreshAll = () => {
    model.refresh(true);
    inv.model.refresh(true);
  };

  // --- the crosshair panel
  const panel = quickPanel();
  let target: LootTarget | null = null;
  let since = 0;
  let sel = 0;
  let rows: QuickSpec['rows'] = [];
  let flash: { text: string; tone: 'good' | 'warn' | 'bad'; until: number } | null = null;
  const gameplay = () => {
    const p = game.player;
    // Not during a timed job (crafting at the locker): the card covered the job's progress bar,
    // and taking something would only cancel the job.
    return game.input.locked && !game.input.captured && surfacesOpen() === 0 && !p.dead && !p.isAsleep() && !game.vehicles?.driving && renderer.cameraMode !== 'top' && !game.activities.current && !inFight();
  };
  // Not in a fight either: the first kill's corpse pile opened a 13-row card over the second
  // zombie as it closed in (wave-3 playtest). Hostile within 6 m or a hit in the last 3 s.
  let lastHit = -1e9;
  for (const ev of ['playerHurt', 'playerAttack'] as const) game.events.on(ev, () => void (lastHit = performance.now()));
  const inFight = () => {
    if (performance.now() - lastHit < 3000) return true;
    const mons = (game as unknown as { monsters?: { visibleHostile(r: number): unknown } }).monsters;
    return !!mons?.visibleHostile(6);
  };
  const k = (id: string) => game.keys.label(id);
  // Adaptation (docs/ADAPTATION.md): a survivor who is cold and looking at a jacket in a
  // cupboard should be able to put it on right there (or, hungry at a kitchen cupboard, eat),
  // not take it, open the inventory and find the double-click. The player's own wear / eat key
  // does that while the card is up, and the card says so when the need is there.
  const COLD = new Set(['Chilly', 'Very cold!', 'Freezing!']);
  const HUNGRY = new Set(['Hungry', 'Very Hungry', 'Famished', 'Starving']);
  type Verb = { label: string; keyId: 'wear' | 'eat'; act: () => unknown; hint: string | null };
  const verbFor = (r: QuickSpec['rows'][number] | undefined, key: string): Verb | null => {
    if (!r) return null;
    const acts = model.actions(r, key);
    const find = (re: RegExp) => {
      const a = acts.find((m) => 'label' in m && re.test(m.label));
      return a && 'action' in a && a.action && !a.disabled ? a.action : null;
    };
    const p = game.player;
    const wear = find(/^Wear$/);
    if (wear) {
      const hint = COLD.has(p.bodyTempDescription()) && (model.itemOf(r.id)?.def.warmth ?? 0) > 0 ? `You're cold: [${k('wear')}] puts it on` : null;
      return { label: 'Wear', keyId: 'wear', act: wear, hint };
    }
    const eat = find(/^(Eat|Drink)$/);
    if (eat) {
      const drink = acts.some((m) => 'label' in m && m.label === 'Drink');
      const need = drink ? p.thirstDescription() !== '' && !/Hydrated|Turgid/.test(p.thirstDescription()) : HUNGRY.has(p.hungerState());
      const hint = need ? `You're ${drink ? 'thirsty' : 'hungry'}: [${k('eat')}] ${drink ? 'drinks' : 'eats'} it here` : null;
      return { label: drink ? 'Drink' : 'Eat', keyId: 'eat', act: eat, hint };
    }
    return null;
  };
  const update = () => {
    const now = performance.now();
    const t = gameplay() ? lootTargetAt(game) : null;
    if (!t) {
      target = null;
      rows = [];
      return panel.hide();
    }
    if (!target || target.key !== t.key) {
      sel = 0;
      flash = null;
      since = now;
    }
    target = t;
    extra = t.key.startsWith('ground:') ? [{ x: t.x, y: t.y, z: t.z }] : [];
    model.refresh();
    try {
      rows = model.contents(t.key);
    } catch {
      rows = [];
    }
    // Looking into a container long enough to read it counts as having searched it.
    if (t.container && t.key.startsWith('ground:') && now - since > 300) memory.mark(t.x, t.y, t.z, rows.length);
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    if (flash && now > flash.until) flash = null;
    const style = lootStyle();
    const quick = style === 'quick';
    const bad = new Map<string, string>();
    let warn: QuickSpec['warn'] = null;
    let adds: QuickSpec['adds'] = null;
    const tot = model.view.totals;
    if (quick) {
      for (const r of rows) {
        const to = model.quickMoveTarget(r, t.key);
        const v = to ? model.check(r.id, to, r.count) : { kind: 'reject' as const, reason: 'Liquids need a container' };
        if (v.kind === 'reject') bad.set(r.id, v.reason);
      }
      const s = rows[sel];
      if (s) {
        adds = { volume: s.volume * s.count, weight: s.weight * s.count };
        const why = bad.get(s.id);
        const to = model.quickMoveTarget(s, t.key);
        const v = to ? model.check(s.id, to, s.count) : null;
        if (why) warn = { text: fitWords(why, tot.volume[1]), tone: 'bad' };
        else if (v?.kind === 'partial') warn = { text: `Only ${v.count} of ${s.count} fit`, tone: 'warn' };
        else if (tot.weight[0] + adds.weight > tot.weight[1]) warn = { text: 'Heavy: taking it overburdens you', tone: 'warn' };
      } else if (tot.volume[0] >= tot.volume[1] && tot.volume[1] > 0) warn = { text: 'Bag full', tone: 'bad' };
    }
    const verb = quick ? verbFor(rows[sel], t.key) : null;
    if (verb?.hint && !warn) warn = { text: verb.hint, tone: 'warn' };
    const keys: QuickSpec['keys'] = quick
      ? rows.length
        ? [[k('interact'), 'Take'], ...(verb ? [[k(verb.keyId), verb.label] as [string, string]] : []), [k('reload'), 'Take all'], [k('inventory2'), 'Open'], ...(rows.length > 1 ? [['wheel', 'Select'] as [string, string]] : [])]
        : [[k('inventory2'), 'Open']]
      : style === 'area'
        ? [[k('pickup'), 'Loot everything nearby'], [k('inventory2'), 'Open']]
        : [[k('interact'), 'Open'], [k('inventory2'), 'Inventory']];
    panel.show({
      mode: quick ? 'quick' : 'peek', title: t.title, rows, sel, bad, warn, adds,
      bars: quick ? { volume: tot.volume, weight: [tot.weight[0], tot.weight[1]] } : null,
      keys, flash, empty: t.container ? 'Empty' : 'Nothing here',
      total: rows.reduce((a, r) => a + (model.itemOf(r.id)?.countByCharges ? 1 : r.count), 0),
    });
  };
  let lastT = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (now - lastT < 60) return;
    lastT = now;
    update();
  };
  requestAnimationFrame(loop);
  const shown = () => panel.shown() && !!target && gameplay();
  const quickLive = () => shown() && lootStyle() === 'quick';

  const setFlash = (text: string, tone: 'good' | 'warn' | 'bad') => {
    flash = { text, tone, until: performance.now() + 2600 };
    update();
  };
  const takeSelected = () => {
    const t = target, r = rows[sel];
    if (!t || !r) return;
    const to = model.quickMoveTarget(r, t.key);
    if (!to) return setFlash('Liquids need a container: carry a bottle or jug', 'bad');
    const v = model.check(r.id, to, r.count);
    if (v.kind === 'reject') return setFlash(v.reason, 'bad');
    const n = v.kind === 'partial' || v.kind === 'ok' ? v.count : r.count;
    run(`Pick up: ${r.name}`, model.moveCost(r.id, to, n), () => {
      const res = model.move(r.id, to, n);
      refreshAll();
      if (!res.ok) setFlash(res.reason, 'bad');
      else setFlash(`Took ${n > 1 ? `${n} ` : ''}${r.name.replace(/^\d+ /, '')}`, 'good');
    });
  };
  const takeAllHere = () => {
    const t = target;
    if (!t || !rows.length) return;
    run('Taking everything', model.takeCost([t.key]), () => {
      const r = model.takeAll(t.key);
      refreshAll();
      setFlash(shortSummary(r), r.left.length ? 'warn' : 'good');
      if (r.left.length) toast({ category: 'warning', title: summaryTitle(r).replace(/:$/, '.'), body: r.left.map((l) => `${l.count > 1 ? l.count + ' ' : ''}${l.name}: ${l.reason}`).join(' · ') });
    });
  };

  // `e` on the panel's target takes the selected thing (first go at the interact key, before
  // vehicles: an open trunk's panel takes from the trunk); no "[e] …" prompt under the panel.
  interactOverrides.unshift({
    interact: () => {
      if (!quickLive() || !rows.length) return false;
      takeSelected();
      return true;
    },
    prompt: () => (shown() ? '' : null),
  });
  // The panel's other keys are the player's own bindings for reload / the inventory, which
  // mean "take all" / "open it" only while it's up (Fallout's R); arrows select.
  game.input.onPriorityPress((e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || !shown()) return false;
    const t = target!;
    const quick = lootStyle() === 'quick';
    if (quick && rows.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      update();
      return true;
    }
    if (e.repeat) return false;
    if (quick && rows.length && game.keys.keysFor('reload').includes(e.key)) {
      takeAllHere();
      return true;
    }
    const verb = quick && rows.length ? verbFor(rows[sel], t.key) : null;
    if (verb && game.keys.keysFor(verb.keyId).includes(e.key)) {
      const r = rows[sel];
      void verb.act();
      refreshAll();
      // Wearing / eating are timed actions with their own bar; this only acknowledges the key.
      const what = r.name.replace(/^\d+ /, '');
      setFlash(verb.label === 'Wear' ? `Putting on the ${what}…` : `${verb.label === 'Drink' ? 'Drinking' : 'Eating'} the ${what}…`, 'good');
      return true;
    }
    if (game.keys.keysFor('inventory2').includes(e.key) || game.keys.keysFor('inventory').includes(e.key)) {
      if (lootStyle() === 'area') openAreaWin(t.key);
      else inv.toggleFocus(t.key);
      return true;
    }
    return false;
  });
  window.addEventListener('wheel', (e) => {
    if (!quickLive() || rows.length < 2) return;
    e.preventDefault();
    sel = Math.max(0, Math.min(rows.length - 1, sel + (e.deltaY > 0 ? 1 : -1)));
    update();
  }, { passive: false, capture: true });

  // --- the area window
  const areaEnv: AreaEnv = {
    game, model, memory: () => memory, run: (l, m, f) => run(l, m, () => (f(), refreshAll())), canvas,
    keys: {
      takeAll: () => game.keys.keysFor('reload'),
      close: () => game.keys.keysFor('pickup'),
      takeAllLabel: () => k('reload'),
      closeLabel: () => k('pickup'),
    },
    openInventory: (focus) => {
      closeGroup('loot');
      inv.open(focus);
    },
    setExtra: (tiles) => void (extra = tiles),
  };
  const openAreaWin = (focus: string | null = null) => {
    game.input.releaseForMenu();
    openArea(areaEnv, focus);
  };
  inv.lootHooks.pickupKey = () => {
    if (lootStyle() !== 'area') return false;
    openAreaWin(target?.key ?? null);
    return true;
  };
  inv.lootHooks.pile = (x, y, z) => {
    if (lootStyle() !== 'area') return false;
    openAreaWin(`ground:${x},${y},${z}`);
    return true;
  };

  // --- markers
  const markers = installMarkers(game, renderer, () => memory, {
    enabled: () => settings.lootMarkers !== false,
    hiddenKey: () => (shown() && target ? `${target.x},${target.y},${target.z}` : null),
  });

  // --- options
  registerOption({
    name: 'Looting style',
    desc: 'Quick: look at a pile and its contents show at the crosshair ([e] take, [r] take all, wheel to pick). Area: g opens one list of everything within reach that stays open while you walk. Inventory tabs: e / g open the inventory on that place.',
    value: () => STYLE_NAMES[lootStyle()],
    change: (dir) => {
      settings.lootStyle = STYLES[(STYLES.indexOf(lootStyle()) + dir + STYLES.length) % STYLES.length];
      saveSettings();
      if (lootStyle() !== 'area') closeGroup('loot');
    },
  });
  registerOption({
    name: 'Loot markers',
    desc: 'Badges over piles and containers in sight: the most notable item and how many things; "?" for containers you have not searched yet.',
    value: () => (settings.lootMarkers === false ? 'off' : 'on'),
    change: () => {
      settings.lootMarkers = settings.lootMarkers === false;
      saveSettings();
    },
  });

  api.loot = {
    model,
    style: () => lootStyle(),
    setStyle: (s: LootStyle) => {
      if (!STYLES.includes(s)) throw new Error(`loot style ${s}: expected ${STYLES.join(' | ')}`);
      settings.lootStyle = s;
      saveSettings();
    },
    /** What the crosshair panel shows now (null = hidden). */
    panel: () => (shown() && target ? { key: target.key, title: target.title, mode: lootStyle() === 'quick' ? 'quick' : 'peek', sel, rows: rows.map((r) => ({ typeId: r.typeId, name: r.name, count: r.count })), text: panel.el.textContent } : null),
    area: () => (areaOpen() ? { open: true, groups: areaGroups(model).map((g) => ({ typeId: g.typeId, name: g.name, count: g.count, sources: g.sources.map((s) => s.label) })) } : null),
    areaId: AREA_ID,
    memory: () => memory.toJSON(),
    searchState: (x: number, y: number, z: number) => memory.state(x, y, z),
    markers: () => markers.state(),
  };
}

/** "There's no room in your inventory for the X." → a line that fits under the list. */
function fitWords(why: string, capacity: number): string {
  if (/no room/i.test(why)) return capacity > 0 ? 'Bag full: no room for it' : 'No bag: wear something with storage';
  if (/too heavy|weight/i.test(why)) return 'Too heavy to carry';
  return why.replace(/\.$/, '');
}

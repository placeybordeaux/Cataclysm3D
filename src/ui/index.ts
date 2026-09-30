import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { WorldGenerator } from '../world/worldgen';
import type { DebugApi } from '../debug';
import { createItem } from '../game/item';
import { spawnOnGround } from '../game/moves';
import { startReading } from '../game/reading';
import { confirm, getUiRoot, prompt } from './framework';
import { Hud, hud } from './hud';
import { loadUiData, type UiContext } from './context';
import { itemActionHooks, installInventoryUi, carriedEntries, nearbyEntries, openPickupMenu, openDropMenu, openItemPicker, showItemInfo } from './inventory_ui';
import { openCharacterSheet } from './charsheet';
import { openHelp } from './help';
import { cameraLookAt, describeHit, installLookHover, openLookMode } from './look';
import { INITIAL_VISIBILITY, openOvermap, overmapSeenTracker, revealAround } from './overmap_ui';
import { showDeathScreen } from './death_screen';
import { openEscMenu, openMessageLog, showMainMenu } from './menus';
import { applyStoredOptions, openOptions, registerOption } from './options';
import { installMapMarks, mapMarks } from './mapmarks';
import { DEFAULT_BINDINGS } from './keys';
import { installTipsOption, openHints } from './tips';
import { installActivityRing } from './activity_ring';
import { installAdaptation } from './adaptation';
import { installRestUi } from './rest_ui';
import { installRouteGuide } from './route';
import { installLiquidUi } from './liquid_ui';
import { applyBuild, defaultBuild, openCharGen } from './chargen';
import { registerSaveable } from '../save/registry';
import { quitToTitle } from '../save/install';
import type { LogEntry } from './format';
import { installFullscreen } from './fullscreen';
import { armUnloadGuard, disarmUnloadGuard } from '../core/unload';
import { closeAllWindows } from './framework';
import { installUi2 } from '../ui2/install';

// Wires the whole UI into the game: HUD, key bindings for every screen, the trackers the
// screens need (distance walked, overmap exploration, kills), the death screen, and the
// boot flow (title screen unless ?skipmenu=1).
//
// Boot flow: the title screen shows by default. `?skipmenu=1` skips it (automated tests);
// so does running under automation (navigator.webdriver, e.g. tools/shot.ts) unless
// `?menu=1` asks for it, so existing screenshot scripts keep working unchanged.

export interface UiHandle {
  ctx: UiContext;
  hud: Hud;
  /** Show the title screen (or skip it per URL params). Resolves when gameplay starts. */
  boot(): Promise<void>;
}

export async function installUi(game: Game, renderer: Renderer, worldgen: WorldGenerator | null, api: DebugApi): Promise<UiHandle> {
  const data = await loadUiData();
  const ctx: UiContext = { game, renderer, worldgen, data };
  const h = new Hud(ctx, getUiRoot());
  applyStoredOptions(ctx);
  installMapMarks(game);
  registerOption({
    name: 'HUD style',
    desc: 'Modern: body, needs and weapon as icons that only light up when they matter. Detailed: the CDDA sidebar with every number.',
    value: () => (h.modern.prefs.detailed ? 'Detailed' : 'Modern'),
    change: () => h.modern.setPrefs({ detailed: !h.modern.prefs.detailed }),
  });
  registerOption({
    name: 'HUD width',
    desc: 'Full: the HUD uses the screen corners. 16:9: it stays in a centred 16:9 area, closer to where you look. Auto: 16:9 on ultrawide screens only.',
    value: () => ({ auto: 'Auto', full: 'Full', '16:9': '16:9' })[h.modern.prefs.width],
    change: (d) => {
      const order = ['auto', 'full', '16:9'] as const;
      h.modern.setPrefs({ width: order[(order.indexOf(h.modern.prefs.width) + d + 3) % 3] });
    },
  });
  installTipsOption();
  installAdaptation(game);
  installRestUi(game);
  installRouteGuide(game, renderer, () => worldgen?.overmap ?? null);
  installActivityRing(game, () => {
    const e = h.log.entries[h.log.entries.length - 1];
    return e ? e.text.replace(/<[^>]+>/g, '') : null;
  });
  installLiquidUi();

  game.lookAt = (maxDist) => cameraLookAt(ctx, maxDist);
  installInventoryUi(ctx);
  itemActionHooks.read = (it) => void startReading(game, it);
  game.keys.register('character', 'View character sheet', () => void openCharacterSheet(ctx));
  game.keys.register('help', 'Help', () => void openHelp(ctx));
  game.keys.register('map', 'View map', () => void openOvermap(ctx));
  game.keys.register('look', 'Look around', () => void openLookMode(ctx));
  game.keys.register('messages', 'View message log', () => void openMessageLog(ctx, h));
  // CDDA keeps the message log in the save.
  registerSaveable<LogEntry[]>(game, 'messages', {
    order: 70,
    save: () => h.log.entries.slice(-100).map((e) => ({ ...e })),
    load: (list) => {
      h.log.entries.length = 0;
      // Old messages go to the log (P) without flashing on the HUD again.
      h.log.entries.push(...list.map((e) => ({ ...e, time: -1e12 })));
    },
    missing: () => void (h.log.entries.length = 0),
  });
  game.keys.register('menu', 'Main menu', () => void openEscMenu(ctx, () => quitToTitle(game)));
  installFullscreen(game);
  let gameStarted = false;
  let dead = false;
  // Layouts that put an action's key on a movement key (AZERTY, Dvorak…): tell the player
  // once, with the way out. keys.ts already adds stand-ins where it can.
  let warnedLayout = false;
  game.keys.onChange = () => {
    const bad = game.keys.unreachable();
    if (!bad.length || warnedLayout || !gameStarted) return;
    warnedLayout = true;
    game.message(`Your keyboard layout puts ${bad.map((id) => DEFAULT_BINDINGS[id][0]).join(' ')} on movement keys (${game.keys.movementKeys()}); rebind those actions in Options > Key bindings.`, 'c_yellow');
  };
  void game.keys.detectLayout();

  if (game.save)
    game.keys.register('save', 'Save game', () =>
      void Promise.resolve(game.save!()).then(
        () => game.message('Game saved.', 'c_light_green'),
        (e) => game.message(`Save failed: ${(e as Error)?.message ?? e}`, 'c_light_red'),
      ));

  // --- trackers for the memorial screen and the overmap
  let lx = game.player.x, ly = game.player.y, lz = game.player.z;
  game.systems.push({
    name: 'ui-stats',
    update(g) {
      const p = g.player;
      const d = Math.hypot(p.x - lx, p.y - ly);
      // Teleports (debug, stairs) aren't walking.
      if (p.z === lz && d < 2) g.stats.distanceWalked += d;
      lx = p.x, ly = p.y, lz = p.z;
    },
  });
  game.systems.push(overmapSeenTracker());
  revealAround(game, INITIAL_VISIBILITY, 0);
  revealAround(game);
  game.events.on('creatureDied', (e) => {
    if (e.killer !== game.player) return;
    const cr = e.creature as { type?: { id?: string }; typeId?: string; id?: string } | null;
    game.stats.addKill(cr?.type?.id ?? cr?.typeId ?? cr?.id ?? 'unknown');
  });
  game.events.on('playerDied', (e) => {
    if (dead) return;
    dead = true;
    disarmUnloadGuard();
    // Menus open at the moment of death would sit on top of the tombstone.
    setTimeout(closeAllWindows, 1150);
    // A beat so the killing blow and "You die…" register before the screen fades in.
    // The world keeps ticking during that beat; report the moment of death (the memorial
    // entry, written right away, uses it too).
    const at = game.clock.seconds;
    setTimeout(() => showDeathScreen(ctx, h, e.cause, at), 1200);
  });

  // --- automation helpers (window.cdda)
  api.hud = hud;
  api.ui = {
    ctx,
    open: (name: string, ...args: unknown[]) => {
      const screens: Record<string, () => unknown> = {
        inventory: () => api.pressKey('i'),
        character: () => openCharacterSheet(ctx),
        help: () => openHelp(ctx),
        map: () => openOvermap(ctx),
        look: () => openLookMode(ctx),
        messages: () => openMessageLog(ctx, h),
        options: () => openOptions(ctx),
        hints: () => openHints(ctx),
        escmenu: () => openEscMenu(ctx, () => quitToTitle(game)),
        pickup: () => openPickupMenu(ctx),
        drop: () => openDropMenu(ctx),
        iteminfo: () => {
          const all = [...carriedEntries(ctx), ...nearbyEntries(ctx)];
          const e = all.find((x) => x.item.typeId === args[0]) ?? all[0];
          return e && showItemInfo(ctx, e.item);
        },
        wield: () => openItemPicker(ctx, { title: 'Wield what?', none: 'You have nothing to wield.', filter: () => true, includeNearby: true, onPick: () => {} }),
      };
      const f = screens[name];
      if (!f) throw new Error(`cdda.ui.open: unknown screen ${name} (${Object.keys(screens).join(', ')})`);
      f();
    },
    /** Framework popups for automation: resolve to the answer (Esc = false / null). */
    confirm: (q: string) => confirm(q),
    prompt: (q: string, initial = '') => prompt(q, initial),
    /** Close every open window (Esc repeatedly). */
    closeAll: () => {
      for (let i = 0; i < 10 && game.input.captured; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    },
    lookText: () => describeHit(ctx, game.lookAt()).replace(/<[^>]+>/g, ''),
    lookHit: () => {
      const hit = game.lookAt();
      return hit && { kind: hit.kind, x: hit.x, y: hit.y, z: hit.z, dist: +hit.dist.toFixed(2), terrain: hit.terrain.id, furniture: hit.furniture.id };
    },
    chargen: () => openCharGen(ctx).then((b) => b && applyBuild(ctx, b)),
    /** Apply a default (random-named Evacuee survivor) build without the UI. */
    quickStart: () => applyBuild(ctx, defaultBuild(ctx)),
    /** Map notes + destination (src/ui/mapmarks.ts). */
    mapMarks: () => mapMarks(game),
    log: () => h.log.entries.map((e) => (e.count > 1 ? `${e.text} x${e.count}` : e.text)),
  };
  /** Put an item on the map relative to the player (dx, dy tiles). For pickup/look tests. */
  api.spawnItem = (id: string, dx = 0, dy = 0, opts: { count?: number; ammo?: string } = {}) => {
    const p = game.player;
    const it = createItem(game.data, id, opts);
    spawnOnGround(game.map, p.tileX + dx, p.tileY + dy, p.z, it);
    return it.name();
  };
  /** Simulate a key press through the normal input path (keys.ts / open windows). */
  api.pressKey = (key: string, code?: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key) }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key) }));
  };

  installUi2(game, renderer, ctx, api);
  installLookHover(ctx);
  return {
    ctx,
    hud: h,
    async boot() {
      const params = new URLSearchParams(location.search);
      const automated = typeof navigator !== 'undefined' && navigator.webdriver;
      const skip = params.get('skipmenu') === '1' || (automated && params.get('menu') !== '1');
      if (!skip) await showMainMenu(ctx, h);
      gameStarted = true;
      armUnloadGuard();
      game.keys.onChange?.();
    },
  };
}

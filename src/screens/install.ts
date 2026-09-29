// Wiring for the interaction screens (src/screens): swaps the curses NPC/vehicle/body-mod/
// achievement windows for the ui2 panels through the seams those systems expose (npcScreens,
// vehicleScreens, key re-registration), registers mission map markers, options and window.cdda
// helpers. main.ts calls installScreens() once, after every system it touches is installed.

import './screens.css';
import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { DebugApi } from '../debug';
import type { NpcsHandle } from '../npcs';
import { npcScreens } from '../npcs';
import type { MissionInstance } from '../game/missions';
import { mapMarkerProviders, mapMarkers } from '../game/mapmarkers';
import { registerOption } from '../ui/options';
import { toast, worldContextProviders } from '../ui2';
import { dialoguePrefs, openDialoguePanel, type DialogueHandle } from './dialogue';
import { openTradePanel, type TradeHandle } from './trade';
import { missionTracking, openMissionsPanel } from './missions';
import { missionMarkers } from './logic/missions';
import { openChatMenu2, pickItem2 } from './chat';
import type { TextSpeed } from './logic/typewriter';
import type { BodyMods } from '../game/bodymods';
import { takeControls, vehicleScreens } from '../ui/vehicle_ui';
import { autodocScreen } from '../mutbio';
import { driveHud, openCargoPanel, openVehiclePanel, cargoPanel } from './vehicle';
import { has } from '../game/vehicle';
import { openAutodocPanel, openBionicsPanel, openMartialArtsPanel, openMutationsPanel, type AutodocHandle } from './bodymods';

export interface ScreensDeps {
  npcs?: NpcsHandle;
  mods?: BodyMods;
}

export interface ScreensHandle {
  dialogue: DialogueHandle | null;
  trade: TradeHandle | null;
  autodoc: AutodocHandle | null;
}

export function installScreens(game: Game, renderer: Renderer, deps: ScreensDeps, api?: DebugApi): ScreensHandle {
  const handle: ScreensHandle = { dialogue: null, trade: null, autodoc: null };

  // ---------------------------------------------------------------- NPCs
  const npcs = deps.npcs;
  if (npcs) {
    const sys = npcs.sys;
    npcScreens.dialogue = (ctx, d, onClose) => {
      const dh = openDialoguePanel({ game, renderer, sys: ctx.sys }, d, () => {
        if (handle.dialogue === dh) handle.dialogue = null;
        onClose();
      });
      handle.dialogue = dh;
      return {
        get closed() {
          return dh.panel.closed;
        },
        close: () => dh.panel.close(),
        pick: (i) => dh.pick(i),
      };
    };
    npcScreens.trade = (ctx, n, cost, onDone) => {
      const th = openTradePanel({ game, renderer, sys: ctx.sys }, n, cost, (traded) => {
        if (handle.trade === th) handle.trade = null;
        onDone?.(traded);
      });
      handle.trade = th;
    };
    npcScreens.missionLog = () => void openMissionsPanel({ game, renderer, sys });
    npcScreens.chat = (_ctx, talk) => openChatMenu2(game, sys, talk);
    npcScreens.pickItem = pickItem2;

    // Missions: a toast when one starts or ends (the log line is easy to miss mid-fight), and
    // map markers for their targets.
    const ms = sys.missions;
    const name = (m: MissionInstance) => ms.def(m)?.name ?? m.id;
    const assign = ms.assign.bind(ms);
    ms.assign = (m, d) => {
      const was = m.status;
      assign(m, d);
      if (was !== 'active' && m.status === 'active') toast({ category: 'info', title: `New job: ${name(m)}`, body: `${ms.goalText(m)} · Mission log: ${game.keys.keyFor('missions')}`, key: `mission:${m.uid}` });
    };
    const succeed = ms.succeed.bind(ms);
    ms.succeed = (m, d) => {
      const was = m.status;
      succeed(m, d);
      if (was === 'active' && m.status === 'succeeded') toast({ category: 'achievement', title: `Job done: ${name(m)}`, key: `mission:${m.uid}:done` });
      if (missionTracking.uid === m.uid) missionTracking.uid = null;
    };
    const fail = ms.fail.bind(ms);
    ms.fail = (m, d) => {
      const was = m.status;
      fail(m, d);
      if (was === 'active' && m.status === 'failed') toast({ category: 'warning', title: `Job failed: ${name(m)}`, key: `mission:${m.uid}:failed` });
      if (missionTracking.uid === m.uid) missionTracking.uid = null;
    };
    mapMarkerProviders.push(() => missionMarkers(ms, missionTracking.uid));
  }

  // ---------------------------------------------------------------- vehicles
  vehicleScreens.partMenu = (g, v, mx, my) => void openVehiclePanel(g, v, { mx, my });
  vehicleScreens.info = (g, v) => void openVehiclePanel(g, v);
  vehicleScreens.controls = (g) => {
    const v = g.vehicles?.driving;
    if (v) openVehiclePanel(g, v);
  };
  vehicleScreens.legacyDashboard = false;
  // Right-click (free cursor) or the world-menu key on a vehicle: the whole panel is one entry
  // away even where `e` means "open this door".
  worldContextProviders.push((t) => {
    const o = t.kind === 'vehicle' ? game.vehicles?.at(t.x, t.y, t.z) : null;
    if (!o) return [];
    const parts = o.v.partsAt(o.mx, o.my);
    const door = parts.find((q) => has(q, 'OPENABLE'));
    const cargo = parts.find((q) => has(q, 'CARGO'));
    const covered = !!door && !door.open && !!cargo && !has(cargo, 'CARGO_PASSABLE');
    const near = Math.hypot(t.x + 0.5 - game.player.x, t.y + 0.5 - game.player.y) <= 2.5;
    const far = near ? undefined : 'Too far away';
    // Same rule as `e` (vehicle_ui.ts): by the driver's seat, driving is the obvious action.
    const drive = game.vehicles!.driveOffer(o.v, o.mx, o.my);
    return [
      ...(drive ? [{ label: `${o.v.locked ? 'Get in' : 'Drive'} the ${o.v.name}`, primary: true, time: 1, key: 'D', action: () => takeControls(game, o.v) }] : []),
      { label: `Examine the ${o.v.name}`, primary: !door && !drive, time: 0, action: () => void openVehiclePanel(game, o.v, { mx: o.mx, my: o.my }) },
      ...(door ? [{ label: `${door.open ? 'Close' : 'Open'} the ${door.def.name}`, primary: !drive, time: 1, disabled: far, action: () => game.message(game.vehicles!.toggleDoor(o.v, o.mx, o.my) ?? '') }] : []),
      ...(cargo ? [{ label: `Look in the ${cargo.def.name} (${cargo.items.length})`, disabled: far ?? (covered ? `The ${door!.def.name} is closed` : undefined), action: () => void (cargoPanel.open ?? openCargoPanel)(game, o.v, cargo) }] : []),
    ];
  });
  const hud = driveHud(game);
  renderer.beforeRender.push(() => hud.update());

  // ---------------------------------------------------------------- body: bionics, mutations, martial arts, Autodoc
  const mods = deps.mods;
  if (mods) {
    game.keys.register('bionics', 'View/activate bionics', () => void openBionicsPanel(game, mods));
    game.keys.register('mutations', 'View/activate mutations', () => void openMutationsPanel(game, mods));
    autodocScreen.open = (g, m, cbms, drop) => {
      const ah = openAutodocPanel(g, m, cbms, drop);
      handle.autodoc = ah;
      const close = ah.panel.close;
      ah.panel.close = () => {
        if (handle.autodoc === ah) handle.autodoc = null;
        close();
      };
    };
  }
  game.keys.register('martial_arts', 'Martial arts style', () => void openMartialArtsPanel(game));

  // ---------------------------------------------------------------- options
  const speeds: TextSpeed[] = ['instant', 'fast', 'normal', 'slow'];
  registerOption({
    name: 'Dialogue text speed',
    desc: 'How fast NPC lines type themselves out (any key or click completes a line).',
    value: () => dialoguePrefs.speed.replace(/^./, (c) => c.toUpperCase()),
    change: (dir) => (dialoguePrefs.speed = speeds[(speeds.indexOf(dialoguePrefs.speed) + dir + speeds.length) % speeds.length]),
  });
  registerOption({
    name: 'Dialogue layout',
    desc: 'Scene: docked low and wide, the world stays visible. Book: a tall window with the history beside the answers.',
    value: () => (dialoguePrefs.layout === 'scene' ? 'Scene' : 'Book'),
    change: () => (dialoguePrefs.layout = dialoguePrefs.layout === 'scene' ? 'book' : 'scene'),
  });

  // ---------------------------------------------------------------- debug
  if (api) {
    api.screens = {
      dialogue: () => handle.dialogue,
      trade: () => handle.trade,
      /** Markers every system exports for the map (missions: active targets). */
      markers: () => mapMarkers(),
      trackMission: (uid: number | null) => (missionTracking.uid = uid),
      openMissions: (uid?: number) => npcs && openMissionsPanel({ game, renderer, sys: npcs.sys }, uid),
      prefs: dialoguePrefs,
      autodoc: () => handle.autodoc,
      vehicle: (dx = 0, dy = 0) => {
        const o = game.vehicles?.at(game.player.tileX + dx, game.player.tileY + dy, game.player.z);
        return o ? openVehiclePanel(game, o.v, { mx: o.mx, my: o.my }) : null;
      },
      bionics: () => mods && openBionicsPanel(game, mods),
      mutations: () => mods && openMutationsPanel(game, mods),
      martialArts: () => openMartialArtsPanel(game),
    };
  }
  return handle;
}

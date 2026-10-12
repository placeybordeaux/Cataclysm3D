import type { DebugApi } from './debug';
import type { Game } from './game/game';
import { createItem, type Item } from './game/item';
import { bodyLocs, L, locate, spawnItem } from './game/moves';
import { ATTACH_REACH, hookOnBody, isTowCable, TOW_TAUT_M, towDirection, type TowLink } from './game/towing';
import type { Vehicle } from './game/vehicle';
import type { VehicleSystem } from './game/vehicles';
import { motionOf } from './game/vehicleImpact';
import type { Renderer } from './render/renderer';
import { TowFx } from './render/towFx';
import { vehiclePanelExtras, type VehiclePanelExtra } from './screens/vehicle';
import { openMenu, type MenuEntry } from './ui/framework';
import { vehiclePartMenuExtras } from './ui/vehicle_ui';

// Wiring for tow cables (src/game/towing.ts; docs/VEHICLES.md "Towing"). Two ways in, as BN:
// - use (`a`) the heavy duty tow cable: the first use hooks it onto the vehicle beside you (it
//   will tow), the second onto the one you carried the loose end to (it gets towed). Several
//   vehicles in reach: the one under the crosshair, else a menu. A carried loose end can also
//   be detached and re-spooled from that menu.
// - examine a vehicle (`e` / the crosshair menu): the panel's square actions attach the cable
//   there, or detach a rigged one (BN's part removal: 5 s, both parts off, the cable back).
// installVehicles (src/ui/vehicle_ui.ts) calls installTowing once.

/** BN hd_tow_cable part "removal": { "time": 500 } moves = 5 turns (game seconds). */
const DETACH_SECONDS = 5;

/** Which face of the vehicle a hook is on, for menus ("the pickup's rear"). */
export function hookSide(vs: VehicleSystem, v: Vehicle, mx: number, my: number): string {
  const b = vs.physRect(v);
  const [hx, hy] = hookOnBody(b, mx, my);
  return hx === b.x1 ? 'front' : hx === b.x0 ? 'rear' : hy === b.y0 ? 'left side' : hy === b.y1 ? 'right side' : 'side';
}

export interface TowingHandle {
  fx: TowFx | null;
}

export function installTowing(game: Game, renderer: Renderer | null, api: DebugApi | undefined, pickTarget: () => { v: Vehicle; mx: number; my: number } | null): TowingHandle {
  const vs = game.vehicles as VehicleSystem;
  const tow = vs.towing;
  const fx = renderer ? new TowFx(game, renderer) : null;
  const carriedCable = (): Item | null => {
    for (const item of game.player.inv.allItems()) if (isTowCable(item)) return item;
    return null;
  };

  /** BN veh_interact removal of the cable part: a short job, then both parts off and the cable back. */
  const detach = (l: TowLink) => {
    game.activities.start({
      name: 'detaching the tow cable',
      duration: DETACH_SECONDS,
      onComplete: () => {
        if (!tow.links.includes(l)) return;
        tow.unlink(l, 'carry', `You detach the tow cable from the ${l.tower.name} and the ${l.towed.name} and reel it in.`);
      },
    });
  };

  const attach = (cable: Item, v: Vehicle, mx: number, my: number) => tow.useCable(cable, v, mx, my);

  // The item's use action (BN iuse::tow_attach).
  game.player.inv.useHandlers.set('TOW_ATTACH', (it) => {
    const loose = tow.looseEnd();
    const mine = loose?.cable === it ? loose : null;
    const hooks = tow.reachableHooks().filter((h) => h.v !== mine?.v);
    const verb = mine ? `Attach the loose end to` : `Attach the cable to`;
    type Act = () => void;
    const entries: MenuEntry<Act>[] = hooks.map((h) => ({ label: `${verb} the ${h.v.name}'s ${hookSide(vs, h.v, h.mx, h.my)}${mine ? ' (it will be towed)' : ' (it will tow)'}`, value: () => void attach(it, h.v, h.mx, h.my) }));
    if (mine) entries.push({ label: 'Detach and re-spool the cable', value: () => tow.resetCable(it, 'You reel in the cable.') });
    if (!entries.length) {
      game.message(`Stand next to the outside of a vehicle (its bumper or side) to attach the ${it.baseName()}.`, 'c_light_red');
      return { ok: false, msg: 'no vehicle in reach', moves: 0 };
    }
    // The vehicle under the crosshair wins when it's in reach (BN choose_adjacent).
    const t = pickTarget();
    const aimed = t ? hooks.find((h) => h.v === t.v) : undefined;
    if (aimed && !mine) return { ...attach(it, aimed.v, aimed.mx, aimed.my), moves: 15 };
    if (entries.length === 1) {
      entries[0].value();
      return { ok: true, msg: '', moves: 15 };
    }
    openMenu<Act>({ title: `Using the ${it.baseName()}`, width: 'min(60ch, 92vw)', entries, onSelect: (fn) => void setTimeout(fn, 0) });
    return { ok: true, msg: '', moves: 0, deferred: true };
  });

  /** Square actions on a vehicle for both vehicle screens. */
  const actionsFor = (v: Vehicle, mx: number, my: number): VehiclePanelExtra[] => {
    const out: VehiclePanelExtra[] = [];
    const l = tow.linkOf(v);
    if (l) {
      const other = l.tower === v ? l.towed : l.tower;
      const [hm] = [l.tower === v ? l.a : l.b];
      const far = tow.reachTo(v, hm.mx, hm.my) > ATTACH_REACH + 0.6 ? `Stand by the cable on the ${v.name}'s ${hookSide(vs, v, hm.mx, hm.my)}` : undefined;
      const moving = Math.abs(v.velocity) > 0.3 || Math.abs(other.velocity) > 0.3 ? 'Both vehicles must be stopped' : undefined;
      out.push({ label: `Detach the tow cable (${l.tower === v ? 'towing' : 'towed by'} the ${other.name})`, disabled: far ?? moving, run: () => detach(l), close: true });
      return out;
    }
    const cable = carriedCable();
    const loose = tow.looseEnd();
    if (loose?.v === v) {
      out.push({ label: 'Detach and re-spool the tow cable', run: () => tow.resetCable(loose.cable, 'You reel in the cable.') });
      return out;
    }
    if (!cable && !loose) return out;
    const why = tow.attachReason(v, mx, my) ?? (tow.reachTo(v, mx, my) > ATTACH_REACH ? 'Stand next to this square' : undefined) ?? (loose && loose.v.z !== v.z ? 'The other end is on another level' : undefined);
    const side = hookSide(vs, v, mx, my);
    if (loose) out.push({ label: `Attach the tow cable's loose end here, the ${side} (the ${loose.v.name} tows this)`, disabled: why ?? undefined, run: () => void attach(loose.cable, v, mx, my) });
    else if (cable) out.push({ label: `Attach a tow cable here, the ${side} (this vehicle will tow)`, disabled: why ?? undefined, run: () => void attach(cable, v, mx, my) });
    return out;
  };
  vehiclePanelExtras.push((_g, v, sel) => actionsFor(v, sel.mx, sel.my));
  vehiclePartMenuExtras.push((_g, v, mx, my) => actionsFor(v, mx, my).filter((a) => !a.disabled).map((a) => ({ label: a.label, hotkey: 'T', value: a.run })));

  if (api) {
    (api as unknown as Record<string, unknown>).towing = {
      /** Every tow link: vehicles, hooks, distance, tension (kN), taut. */
      links: () => tow.links.map((l) => ({
        tower: { uid: l.tower.uid, name: l.tower.name }, towed: { uid: l.towed.uid, name: l.towed.name }, a: l.a, b: l.b,
        dist: +l.dist.toFixed(2), taut: l.dist >= TOW_TAUT_M - 0.05, tensionKN: +(l.tension / 1000).toFixed(1),
        direction: towDirection(l.towed, l.b.mx), towedFacing: +l.towed.facing.toFixed(1), towerFacing: +l.tower.facing.toFixed(1),
        towedMph: +(l.towed.velocity * 2.2369363).toFixed(1), towedSpin: +motionOf(l.towed).spin.toFixed(1),
      })),
      /** Test setup: a tow cable into your inventory (or hands). */
      giveCable: () => {
        const c = createItem(game.data, 'hd_tow_cable');
        if (!spawnItem(c, L.inv(game.player), { quiet: true }).ok && !spawnItem(c, L.hands(game.player), { quiet: true }).ok) throw new Error('no room for the tow cable');
        return c.name();
      },
      /** The hooks you can reach now (what `a` on the cable offers). */
      reach: () => tow.reachableHooks().map((h) => ({ uid: h.v.uid, name: h.v.name, mx: h.mx, my: h.my, side: hookSide(vs, h.v, h.mx, h.my), dist: +h.dist.toFixed(2) })),
      /** The loose end you carry, if any. */
      loose: () => {
        const l = tow.looseEnd();
        return l ? { uid: l.v.uid, name: l.v.name, ...l.hook } : null;
      },
      /** Is a tow cable carried (and where). */
      carried: () => {
        const c = carriedCable();
        return c ? { name: c.name(), at: locate(c, bodyLocs(game.player))?.kind } : null;
      },
    };
  }
  return { fx };
}

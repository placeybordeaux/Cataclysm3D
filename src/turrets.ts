import type { Game } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { MonstersHandle } from './monsters';
import type { Vehicle, VehiclePart } from './game/vehicle';
import { has, turretGun } from './game/vehicle';
import { stationActions, stationEyeEstimate, type Station } from './game/vehwalk';
import { aimHooks } from './game/aimmodel';
import { weaponProviders } from './game/bionicguns';
import { ammoRequired, clearJam, currentMode, cycleMode, gunModes, upsDrain } from './game/gunmods';
import { Character } from './game/character';
import { applyFlatArmor, fireGun } from './game/combat';
import { aimDirection, yawPitch } from './game/aimmodel';
import { rangedClass } from './game/rangedfeel';
import { sfx } from './audio/sfx';
import { ACTION_SCALE } from './core/time';
import { bash } from './game/bash';
import { LEVEL_HEIGHT } from './world/coords';
import { createItem, loadAmmo } from './game/item';
import { L, spawnItem } from './game/moves';
import {
  aimError, ammoChoices, ammoPref, hullYaw, slewOf, isMainGun, isManualTurret, leaveTurret, manTurret, mountedKick, muzzleOf, reloadTurret, setAmmoPref, slewTurrets,
  turretAim, turretAt, turretsOf, turretSession, turretStatus, vehicleRecoilMoa, type TurretSession,
} from './game/turret';
import type { VehicleSystem } from './game/vehicles';
import { TurretFx } from './render/turretFx';

// Wiring for vehicle turrets (src/game/turret.ts; docs/VEHICLES.md "Turrets"): at a gunner
// station (vehwalk.ts: a seat on a turret's cell) `e` mans the gun — it becomes the weapon LMB /
// `f` fire, through the ordinary free-aim pipeline (PlayerCombat.mounted makes the shot BN's
// turret_data::fire: from the muzzle, with only the vehicle's recoil, power from its
// batteries) — `r` reloads it from what you carry or the cargo beside it, `fire_mode` switches
// fire mode or (single-mode guns) the round loaded next, and `e` (or Esc) stands down. Every
// turret slews toward where its gunner looks at its own rate; a click while the barrel is still
// coming round fires when it gets there. main.ts calls this once, after installBionicGuns.

/** How close (rad) the barrel must be to where you look before a round goes. */
const ON_TARGET_MAIN = (2.5 * Math.PI) / 180;
const ON_TARGET_MG = (8 * Math.PI) / 180;
/** A click while traversing waits for the barrel to come round, plus this long (s). */
const QUEUE_S = 1.2;

export interface TurretsHandle {
  /** The gunner's session (null when no turret is manned). */
  session(): TurretSession | null;
  /** Man the turret on the station you're at (what `e` does there). */
  man(): string | null;
  leave(message?: string): void;
}

function gunName(p: VehiclePart): string {
  return p.def.name;
}

export function installTurrets(game: Game, renderer: Renderer | null, monsters: MonstersHandle, api?: DebugApi): TurretsHandle {
  const { combat } = monsters;
  const vs = game.vehicles as VehicleSystem | undefined;
  if (!weaponProviders.includes(sessionGun)) weaponProviders.push(sessionGun);
  const keyLabel = (id: string) => game.keys.label(id);

  const leave = (message?: string) => {
    const s = leaveTurret(game);
    if (!s) return;
    if (combat.burst?.gun === s.gun) combat.burst = null;
    if (message) game.message(message, 'c_light_gray');
  };

  const statusLine = (v: Vehicle, p: VehiclePart): string => {
    const gun = turretGun(p, game.data);
    if (!gun) return 'wrecked';
    const st = turretStatus(v, p, game.data);
    const what = gun.ammoData()?.name;
    const loaded = gun.ammoRemaining() > 0 ? `${gun.ammoRemaining()}/${gun.ammoCapacity()} ${what ?? ''}`.trim() : 'empty';
    return st === 'no_power' ? `${loaded}, no power` : loaded;
  };

  const man = (v: Vehicle, p: VehiclePart): string => {
    const s = manTurret(game, v, p);
    if (!s) return `The ${gunName(p)} is wrecked.`;
    const e = keyLabel('interact'), r = keyLabel('reload');
    return `You man the ${gunName(p)} (${statusLine(v, p)}). Left click fires, ${r} reloads, ${e} stands down.`;
  };

  // `e` at a gunner station: man the gun there, or stand down from it.
  stationActions.push((sv, v: Vehicle, st: Station) => {
    // stationActions is module-wide: answer only for this game's vehicles
    if (sv.game !== game || !st.turret) return null;
    const p = turretAt(v, st.mx, st.my);
    if (!p) return null;
    const s = turretSession(game);
    if (s && s.part === p) return { label: `Stand down from the ${gunName(p)}`, run: () => (leave(), `You let go of the ${gunName(p)}.`) };
    return { label: `Man the ${gunName(p)}`, run: () => man(v, p) };
  });

  // PlayerCombat: a manned turret's shot is BN's turret_data::fire.
  combat.mounted = {
    is: (gun) => turretSession(game)?.gun === gun,
    recoil: () => {
      const s = turretSession(game);
      return s ? vehicleRecoilMoa(s.v) : 0;
    },
    refuse: (gun) => {
      const s = turretSession(game);
      if (!s || s.gun !== gun) return 'not manned';
      const name = gunName(s.part);
      if (s.reloadLeft > 0) return `reloading the ${name}`;
      if (has(s.part, 'USE_TANKS')) return `the ${name} feeds from the tanks: firing it by hand isn't built yet`;
      const st = turretStatus(s.v, s.part, game.data);
      if (st === 'invalid') return `the ${name} is wrecked`;
      if (st === 'no_ammo') return `the ${name} is empty: ${keyLabel('reload')} to reload`;
      if (st === 'no_power') return `the ${name} is not powered: the ${s.v.name}'s batteries are flat`;
      const a = turretAim(s.v, s.part);
      const err = aimError(a);
      if (err > (isMainGun(s.part) ? ON_TARGET_MAIN : ON_TARGET_MG)) {
        // wait as long as the barrel needs to come round (plus a little), not forever
        s.queued = Math.min(6, err / ((slewOf(s.part).traverse * Math.PI) / 180) + QUEUE_S);
        return `the turret is still traversing`;
      }
      return null;
    },
    muzzle: () => {
      const s = turretSession(game)!;
      return muzzleOf(s.v, s.part);
    },
    kick: (gun) => {
      const s = turretSession(game)!;
      return mountedKick(s.part, gun, game.player).aimMoa;
    },
    fired: (gun, shot, to) => {
      const s = turretSession(game);
      if (!s) return;
      // BN turret_data::post_fire: the vehicle's batteries pay the gun's ups_charges per shot.
      const ups = upsDrain(gun);
      if (ups > 0) s.v.drainFuel('battery', ups);
      const a = turretAim(s.v, s.part);
      a.sinceShot = 0;
      a.shots++;
      const main = isMainGun(s.part);
      const m = muzzleOf(s.v, s.part);
      // A kinetic tank round (no blast of its own) still smashes the wall it strikes, as BN's
      // map::shoot bashes what a projectile hits; a HEAT round's blast does that itself.
      const blast = (shot.ammoEffects ?? []).includes('CUSTOM_EXPLOSION') || (shot.ammoEffects ?? []).includes('EXPLOSIVE');
      if (main && !blast) {
        const dx = to.x - m.x, dy = to.y - m.y, d = Math.hypot(dx, dy) || 1;
        const tx = Math.floor(to.x + (dx / d) * 0.05), ty = Math.floor(to.y + (dy / d) * 0.05);
        const z = s.v.z + Math.floor((to.h - s.v.z * LEVEL_HEIGHT) / LEVEL_HEIGHT);
        const dmg = shot.damage.reduce((t, u) => t + u.amount, 0);
        if (game.map.terAt(tx, ty, z).bash || game.map.furnAt(tx, ty, z).bash) bash(game, tx, ty, z, Math.min(400, Math.round(dmg / 8)), { source: game.player, byPlayer: true });
      }
      game.events.emit('turretFired', { vehicle: s.v, part: s.part, muzzle: m, yaw: a.yaw, pitch: a.pitch, main, to });
    },
  };

  // Per tick: keep the session valid, slew every turret, run the reload clock, fire a queued shot.
  const lastFacing = new WeakMap<Vehicle, number>();
  game.systems.push({
    name: 'turrets',
    update(g, dt) {
      const s = turretSession(g);
      const p = g.player;
      if (s) {
        const at = vs?.stations.view();
        const here = at && at.v === s.v && at.station.turret && turretAt(at.v, at.station.mx, at.station.my) === s.part;
        if (p.dead || !here || s.part.hp <= 0 || !vs?.list.includes(s.v)) leave(p.dead ? undefined : `You let go of the ${gunName(s.part)}.`);
        else {
          turretAim(s.v, s.part).want = { yaw: p.yaw, pitch: p.pitch };
          if (s.reloadLeft > 0) s.reloadLeft = Math.max(0, s.reloadLeft - dt);
          if (s.queued > 0) {
            s.queued -= dt;
            const tol = isMainGun(s.part) ? ON_TARGET_MAIN : ON_TARGET_MG;
            if (aimError(turretAim(s.v, s.part)) <= tol && combat.cooldown <= 0 && !g.input.captured) {
              s.queued = 0;
              combat.fire();
            }
          }
        }
      }
      stepVolley(dt);
      for (const v of vs?.list ?? []) {
        if (Math.abs(v.x - p.x) > 80 || Math.abs(v.y - p.y) > 80) continue;
        const f = lastFacing.get(v);
        lastFacing.set(v, v.facing);
        const turn = f === undefined ? 0 : ((v.facing - f) * Math.PI) / 180;
        slewTurrets(v, dt, turn);
      }
    },
  });

  // `r` at a manned turret reloads it (BN avatar_action::reload on a turret tile).
  const prevReload = game.keys.handler('reload');
  game.keys.register('reload', game.keys.action('reload')?.name ?? 'Reload', () => {
    const s = turretSession(game);
    if (!s) return prevReload?.();
    if (s.reloadLeft > 0) return void game.message(`You're already reloading the ${gunName(s.part)}.`, 'c_light_gray');
    // a jam clears first, as with a gun in hand (combatdepth.ts)
    if (clearJam(s.gun)) {
      game.message(`You clear the jam in the ${gunName(s.part)}.`);
      s.reloadLeft = s.reloadTotal = 1;
      combat.cooldown = Math.max(combat.cooldown, 1);
      return;
    }
    const r = reloadTurret(s.v, s.part, game.player);
    game.message(r.msg, r.ok ? undefined : 'c_light_red');
    if (!r.ok) return;
    s.reloadLeft = s.reloadTotal = r.seconds;
    combat.cooldown = Math.max(combat.cooldown, r.seconds);
    game.events.emit('turretReload', { vehicle: s.v, part: s.part, seconds: r.seconds });
  });

  // `fire_mode`: a gun with fire modes cycles them; a single-mode gun (the 120 mm) picks the next round type.
  const prevMode = game.keys.handler('fire_mode');
  game.keys.register('fire_mode', game.keys.action('fire_mode')?.name ?? 'Select fire mode', () => {
    const s = turretSession(game);
    if (!s) return prevMode?.();
    if (gunModes(s.gun).length > 1) {
      const m = cycleMode(s.gun);
      return void game.message(`${gunName(s.part)}: ${m.name} (${m.qty} round${m.qty === 1 ? '' : 's'}).`, 'c_light_gray');
    }
    const choices = ammoChoices(s.v, s.part, s.gun, game.player);
    if (!choices.length) return void game.message(`There are no other rounds for the ${gunName(s.part)} within reach.`, 'c_light_gray');
    const cur = ammoPref(s.part) ?? s.gun.ammoData()?.id;
    const i = choices.findIndex((c) => c.id === cur);
    const next = choices[(i + 1) % choices.length];
    setAmmoPref(s.part, next.id);
    game.message(`Next round for the ${gunName(s.part)}: ${next.name} (${next.count} within reach).`, 'c_light_gray');
  });

  /**
   * BN vehicle::turrets_aim_and_fire_mult(MANUAL) from the controls: every turret in manual
   * targeting mode that isn't on a MANUAL mount, ready and in range of the target, is laid on
   * the point under your crosshair and fired by the vehicle's targeting computer — a fake NPC
   * with the gun's skill 10, marksmanship 5, Str 20, Dex 10, Per 15 (get_targeting_npc) —
   * each its full fire mode. BN fires them at once; here each turret traverses to the point at
   * its own rate first (as a manned gun's queued shot waits for its barrel) and fires as it
   * gets there, so a volley over the back deck visibly swings the turret round.
   */
  type Volley = { v: Vehicle; target: { x: number; y: number; h: number }; left: VehiclePart[]; timeout: number; fired: number };
  let pending: Volley | null = null;
  /** Where turret `t` has to point (from its muzzle, which moves as it turns) to hit `target`. */
  const layOn = (v: Vehicle, t: VehiclePart, target: Volley['target']) => {
    const a = turretAim(v, t);
    const save = { yaw: a.yaw, pitch: a.pitch };
    let want = save;
    for (let k = 0; k < 2; k++) {
      const m0 = muzzleOf(v, t);
      want = yawPitch({ x: target.x - m0.x, y: target.y - m0.y, h: target.h - m0.h });
      // the muzzle of a turret laid that way, for the second pass
      a.yaw = want.yaw;
      a.pitch = want.pitch;
    }
    a.yaw = save.yaw;
    a.pitch = save.pitch;
    const s = slewOf(t);
    return { yaw: want.yaw, pitch: Math.max(s.minPitch, Math.min(s.maxPitch, (want.pitch * 180) / Math.PI)) * Math.PI / 180 };
  };
  const fireOne = (v: Vehicle, t: VehiclePart, target: Volley['target']): number => {
    const gun = turretGun(t, game.data);
    if (!gun || turretStatus(v, t, game.data) !== 'ready') return 0;
    const cpu = targetingCpu(game, gun.def.skill ? String(gun.def.skill) : 'gun', t.def.name);
    const a = turretAim(v, t);
    a.want = null;
    let fired = 0;
    const mode = currentMode(gun);
    const need = Math.max(1, ammoRequired(gun));
    const n = Math.max(1, Math.min(mode.qty, ammoRequired(gun) > 0 ? Math.floor(gun.ammoRemaining() / need) : mode.qty));
    for (let i = 0; i < n; i++) {
      const ammo = gun.ammoData();
      const shot = fireGun(cpu, gun, combat.sys.rng, { burst: n > 1 });
      if (!shot.ok) break;
      fired++;
      const ups = upsDrain(gun);
      if (ups > 0) v.drainFuel('battery', ups);
      const m = muzzleOf(v, t);
      const base = yawPitch({ x: target.x - m.x, y: target.y - m.y, h: target.h - m.h });
      const dir = aimDirection(base.yaw, base.pitch, shot.spread * Math.cos(shot.azimuth), shot.spread * Math.sin(shot.azimuth));
      const hit = combat.castAim(dir.yaw, dir.pitch, Math.max(1, shot.range), undefined, m);
      combat.tracers.push({ x0: m.x, y0: m.y, x1: hit.x, y1: hit.y, z: v.z, t: 0.08, h0: m.h, h1: hit.hAbs, heavy: (ammo?.weight ?? 0) >= 5000 });
      sfx.rangedShot(rangedClass(gun), gun.typeId, { x: m.x, y: m.y, z: v.z }, { loudness: shot.noise.volume });
      if (shot.noise.volume > 0) combat.sys.emitSound(m.x, m.y, v.z, shot.noise.volume, shot.noise.sound || 'Bang!', 'player', '');
      const mon = hit.hit;
      if (mon) {
        const units = shot.damage.map((d) => ({ type: d.type, amount: d.amount, armor_penetration: d.armor_penetration, armor_multiplier: 1 }));
        const dmg = Math.floor(applyFlatArmor(units, mon.type.armor).reduce((s2, d) => s2 + d.amount, 0));
        mon.aggroCharacter = true;
        combat.sys.hurt(mon, dmg, 'player');
        game.events.emit('playerAttack', { kind: 'gun', outcome: mon.dead ? 'kill' : dmg > 0 ? 'hit' : 'block', x: mon.x, y: mon.y, z: mon.z, damage: dmg, heavy: dmg >= 20, target: mon, blood: combat.sys.bloodType(mon.type), ranged: rangedClass(gun) });
        combat.ammoEffectsAt(shot, mon.x, mon.y, mon, dmg);
      } else {
        game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: hit.x, y: hit.y, z: v.z, damage: 0, heavy: false, blood: null, ranged: rangedClass(gun), landed: hit.stop !== 'range' });
        if (hit.vehicle) combat.shootVehicle(hit.vehicle, shot.damage, shot.ammoEffects ?? []);
        combat.ammoEffectsAt(shot, hit.x, hit.y, null, 0);
      }
      a.sinceShot = 0;
      a.shots++;
      game.events.emit('turretFired', { vehicle: v, part: t, muzzle: m, yaw: a.yaw, pitch: a.pitch, main: isMainGun(t), to: { x: hit.x, y: hit.y, h: hit.hAbs } });
    }
    return fired;
  };
  /** Per tick while a volley is laid: re-lay each turret (the hull may turn), fire those on target. */
  const stepVolley = (dt: number) => {
    const q = pending;
    if (!q) return;
    const at = vs?.stations.view();
    const stillAtControls = vs?.list.includes(q.v) && (vs.driving === q.v || (at?.v === q.v && at.station.kind === 'driver'));
    q.timeout -= dt;
    if (!stillAtControls || game.player.dead) {
      for (const t of q.left) turretAim(q.v, t).want = null;
      pending = null;
      return;
    }
    for (const t of [...q.left]) {
      const a = turretAim(q.v, t);
      a.want = layOn(q.v, t, q.target);
      const tol = isMainGun(t) ? ON_TARGET_MAIN : ON_TARGET_MG;
      if (aimError(a) <= tol || q.timeout <= 0) {
        // out of time: it fires where it got to, as BN's instant volley would have
        q.fired += fireOne(q.v, t, q.target);
        q.left.splice(q.left.indexOf(t), 1);
      }
    }
    if (!q.left.length) {
      pending = null;
      if (!q.fired && dt > 0) game.message('No turret could fire.', 'c_light_gray');
    }
  };
  const volley = (v: Vehicle): string => {
    const list = turretsOf(v).filter((q) => !isManualTurret(v, q) && turretStatus(v, q, game.data) === 'ready');
    if (!list.length) return "Can't aim turrets: all turrets are offline or set to automatic targeting mode.";
    const p = game.player;
    const view = aimHooks.view?.() ?? null;
    const o = view ? view.o : { x: p.x, y: p.y, h: aimHooks.stationEye?.() ?? p.z * LEVEL_HEIGHT + 1.6 };
    const look = view ? yawPitch(view.f) : { yaw: p.yaw, pitch: p.pitch };
    const aimAt = combat.castAim(look.yaw, look.pitch, 150, undefined, o);
    const target = { x: aimAt.x, y: aimAt.y, h: aimAt.hAbs };
    const inRange = list.filter((t) => {
      const gun = turretGun(t, game.data)!;
      const [cx, cy] = v.mountToWorld(t.mx, t.my);
      const range = (gun.ammoData()?.range ?? 0) + (gun.def.range ?? 0);
      // BN turret_data::in_range: rl_dist from the turret to the target, in tiles
      return Math.max(Math.abs(Math.floor(target.x) - Math.floor(cx)), Math.abs(Math.floor(target.y) - Math.floor(cy))) <= range;
    });
    if (!inRange.length) return 'No turret can reach that.';
    // A new volley replaces one still traversing.
    if (pending) for (const t of pending.left) turretAim(pending.v, t).want = null;
    // Long enough for the slowest barrel to come round, plus a little; never forever.
    const timeout = Math.min(6, Math.max(...inRange.map((t) => {
      const a = turretAim(v, t), w = layOn(v, t, target);
      const err = Math.hypot(Math.atan2(Math.sin(w.yaw - a.yaw), Math.cos(w.yaw - a.yaw)), w.pitch - a.pitch);
      return err / ((slewOf(t).traverse * Math.PI) / 180);
    })) + QUEUE_S);
    const q: Volley = { v, target, left: inRange, timeout, fired: 0 };
    pending = q;
    // The ones already on target fire now.
    stepVolley(0);
    if (!pending && !q.fired) return 'No turret could fire.';
    // BN turrets_aim: aiming takes the driver a turn, less with Int.
    combat.cooldown = Math.max(combat.cooldown, Math.max(0, 100 - 5 * p.int) / 100 / ACTION_SCALE);
    if (pending) return `The ${v.name}'s turret${inRange.length > 1 ? 's traverse' : ' traverses'}…`;
    return `The ${v.name}'s turret${inRange.length > 1 ? 's fire' : ' fires'}!`;
  };

  // BN `f` (handle_action.cpp fire()): unarmed on a turret's tile fires that turret; unarmed at
  // the controls aims every manual-mode turret. With a gun in hand `f` fires the gun, as before.
  const prevFire = game.keys.handler('fire');
  game.keys.register('fire', game.keys.action('fire')?.name ?? 'Fire', () => {
    const p = game.player;
    const armed = !!combat.weapon()?.isGun();
    if (turretSession(game) || armed || !vs) return prevFire?.();
    const at = vs.stations.view();
    if (at?.station.turret) {
      const t = turretAt(at.v, at.station.mx, at.station.my);
      if (t) {
        game.message(man(at.v, t));
        combat.fire();
        return;
      }
    }
    const v = vs.driving ?? (at && at.station.kind === 'driver' ? at.v : null);
    if (v && turretsOf(v).length && v.controls()) return void game.message(volley(v), 'c_light_gray');
    void p;
    prevFire?.();
  });

  // Esc (the menu key) stands down instead of opening the menu, as it leaves BN's aiming UI.
  const menu = game.keys.action('menu');
  if (menu) {
    game.keys.register('menu', menu.name, () => {
      const s = turretSession(game);
      if (s) leave(`You let go of the ${gunName(s.part)}.`);
      else menu.handler();
    });
  }
  game.events.on('gameLoaded', () => {
    leave();
    pending = null;
  });

  // Shots from any vehicle station leave the station's eye (seat, hatch, cupola), not 1.6 m
  // over the road: the drawn one when the renderer has it, else vehwalk's estimate.
  aimHooks.stationEye = () => {
    const at = vs?.stations.view();
    if (!at || vs?.driving) return null;
    return renderer?.rig.stationEye ?? stationEyeEstimate(at);
  };

  if (renderer) {
    // Muzzle flash, smoke, barrel blast, camera shake for turret fire; fireballs for blasts.
    const fx = new TurretFx(game, renderer);
    if (api) (api as unknown as Record<string, unknown>).turretFx = fx;
    // No hands on screen while you're on the gun (the turret is what you see).
    renderer.beforeRender.push(() => {
      if (turretSession(game)) renderer.handsBusy = true;
    });
  }

  const handle: TurretsHandle = {
    session: () => turretSession(game),
    man: () => {
      const at = vs?.stations.view();
      if (!at || !at.station.turret) return 'Not at a gunner station.';
      const p = turretAt(at.v, at.station.mx, at.station.my);
      return p ? man(at.v, p) : 'No turret here.';
    },
    leave,
  };
  if (api) {
    (api as unknown as Record<string, unknown>).turrets = {
      ...handle,
      /**
       * Test setup (tools/realinput_turret.ts): the Abrams' 120 mm emptied, two HEAT and an
       * APFSDS round in the rack beside the gunner, the M2 on a full belt. Rounds are created
       * and used up through the item API (spawnItem, ammoConsume), never conjured into slots.
       * `{ loadMain: id }` instead puts one round of `id` in an empty 120 mm (loadAmmo).
       */
      stock: (uid: number, opts: { loadMain?: string } = {}) => {
        const v = vs?.list.find((q) => q.uid === uid);
        if (!v) return null;
        if (opts.loadMain) {
          // a later setup step (the controls volley): one round in the 120 mm, nothing else touched
          const main = v.parts.find((q) => q.def.id === 'mounted_tank_manual');
          const gun = main ? turretGun(main, game.data) : null;
          if (gun && !gun.ammoRemaining()) loadAmmo(gun, opts.loadMain, 1);
          return { main: gun?.ammoRemaining() ?? null };
        }
        const main = v.parts.find((q) => q.def.id === 'mounted_tank_manual');
        const gun = main ? turretGun(main, game.data) : null;
        if (gun && gun.ammoRemaining()) gun.ammoConsume(gun.ammoRemaining());
        const rack = v.partsAt(-3, 1).find((q) => has(q, 'CARGO'));
        if (rack) for (const id of ['120mm_usable_heat', '120mm_usable_heat', '120mm_usable_ap']) spawnItem(createItem(game.data, id), L.cargo(rack, v), { force: true, quiet: true });
        const m2 = v.parts.find((q) => q.def.id === 'mounted_browning');
        const mg = m2 ? turretGun(m2, game.data) : null;
        if (mg && (!mg.magazine || mg.ammoRemaining() < mg.ammoCapacity())) {
          if (mg.magazine) mg.ammoConsume(mg.ammoRemaining());
          loadAmmo(mg, '50bmg', Infinity);
        }
        return { main: gun?.ammoRemaining() ?? null, rack: rack?.items.map((i) => `${i.typeId}x${i.charges}`) ?? null, m2: mg?.ammoRemaining() ?? null };
      },
      /** Every turret of the vehicle you're in (or `uid`): gun, ammo, status, aim. */
      state: (uid?: number) => {
        const v = uid !== undefined ? vs?.list.find((q) => q.uid === uid) : vs?.stations.view()?.v ?? vs?.driving ?? vs?.playerOn()?.v;
        if (!v) return null;
        return v.parts.filter((q) => has(q, 'TURRET')).map((q) => {
          const gun = turretGun(q, game.data);
          const a = turretAim(v, q);
          return {
            part: q.def.id, cell: [q.mx, q.my], gun: gun?.typeId, status: turretStatus(v, q, game.data), ammo: gun?.ammoRemaining() ?? 0, capacity: gun?.ammoCapacity() ?? 0,
            loaded: gun?.ammoData()?.id ?? null, magazine: gun?.magazine?.typeId ?? null, yaw: +a.yaw.toFixed(3), pitch: +a.pitch.toFixed(3),
            hull: +hullYaw(v).toFixed(3), shots: a.shots, muzzle: muzzleOf(v, q), choices: gun ? ammoChoices(v, q, gun, game.player) : [],
          };
        });
      },
    };
  }
  return handle;
}

/** BN vehicle::get_targeting_npc: the fake gunner a vehicle's targeting computer fires with. */
function targetingCpu(game: Game, skill: string, name: string): Character {
  const c = new Character(game.data);
  c.name = `The ${name} turret`;
  c.str_base = 20;
  c.dex_base = 10;
  c.per_base = 15;
  c.skills[skill] = { level: 10, exercise: 0 };
  c.skills.gun = { level: 5, exercise: 0 };
  c.recoil = 0;
  return c;
}

/** activeWeapon's provider: the manned turret's gun. */
function sessionGun(game: Game) {
  return turretSession(game)?.gun ?? null;
}

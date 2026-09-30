import type { Game } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { MonstersHandle } from './monsters';
import { FEEL } from './game/combatfeel';
import {
  AIM_MODELS, aimModel, bowWindow, Breath, freeAim, isAimModel, offsetToPixels, reloadBand, rhythmWindow, setAimModel, timingGames, type AimModelId,
} from './game/aimmodel';
import { drawStyle, rangedClass } from './game/rangedfeel';
import { getUiRoot } from './ui/framework';
import { registerOption } from './ui/options';
import { AimHud, type AimHudFrame } from './ui/aimHud';
import { sfx } from './audio/sfx';
import { aimHooks, zoneOfPart, type Vec3 } from './game/aimmodel';
import { pickModel } from './render/aimPick';
import { LEVEL_HEIGHT } from './world/coords';
import type { Monster } from './game/monster';

// Wiring for the aim models (src/game/aimmodel.ts): which one is on (Options > Aim model,
// `?aim=sway|timing|dice`, remembered in localStorage, `cdda.setAimModel`), and — every render
// frame, so it never lags the picture — the moving reticle: the crosshair, the combat HUD's
// ring and brackets, the aim overlay (src/ui/aimHud.ts), the gun in the hands and the camera's
// share of the recoil kick are all placed from the same aim offset, and that offset is recorded
// so a click fires along exactly the reticle that was on screen. Also the timing model's
// breath key (Shift while aiming doesn't run) and active reload (reload again in the band).
// main.ts calls it once, after installCombatFeel (it wraps the reload key that one wraps).

const STORAGE_KEY = 'cdda3d.aimModel';
const TRAIL_KEY = 'cdda3d.aimTrail';

function storedModel(): AimModelId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isAimModel(v) ? v : null;
  } catch {
    return null;
  }
}

function storeModel(m: AimModelId): void {
  try {
    localStorage.setItem(STORAGE_KEY, m);
  } catch {
    // private mode: the choice just doesn't persist
  }
}

/** An active reload in progress (timing model): seconds in, its length, one press allowed. */
interface ActiveReload {
  t: number;
  dur: number;
  skill: number;
  judged: boolean;
}

export function installAim(game: Game, renderer: Renderer | null, monsters: MonstersHandle, api?: DebugApi): void {
  const { combat } = monsters;
  const p = game.player;

  // --- which model: the URL wins (a shared link or a test run), then the stored choice.
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('aim') : null;
  if (q !== null) {
    if (isAimModel(q)) setAimModel(q);
    else game.message(`Unknown aim model "?aim=${q}" (use sway, timing or dice); keeping ${aimModel()}.`, 'c_light_red');
  } else {
    const s = storedModel();
    if (s) setAimModel(s);
  }
  const choose = (m: AimModelId) => {
    setAimModel(m);
    storeModel(m);
    combat.aim.shown = null;
  };
  registerOption({
    name: 'Aim model',
    value: () => AIM_MODELS.find((m) => m.id === aimModel())!.name,
    change: (d) => {
      const i = AIM_MODELS.findIndex((m) => m.id === aimModel());
      choose(AIM_MODELS[(i + d + AIM_MODELS.length) % AIM_MODELS.length].id);
    },
    desc: AIM_MODELS.map((m) => `${m.name}: ${m.desc}`).join('  '),
  });

  const aimingTrigger = () => {
    const w = p.inv.wielded;
    return !!w?.isGun() && drawStyle(w) === 'trigger' && (game.input.mouseButtons & 4) !== 0 && !game.input.captured;
  };
  // Timing: Shift while aiming holds your breath, so it mustn't also break into a run.
  game.runVeto = () => timingGames() && aimingTrigger();

  // --- active reload (timing model): the reload key again while the marker is in the band.
  let reload: ActiveReload | null = null;
  const prevReload = game.keys.handler('reload');
  if (prevReload) {
    game.keys.register('reload', 'Reload / clear jam', () => {
      if (reload && timingGames()) {
        if (reload.judged) return;
        reload.judged = true;
        const band = reloadBand(reload.skill);
        const f = reload.t / reload.dur;
        if (f >= band.start && f <= band.end) {
          combat.cooldown = 0;
          combat.perfectNext = true;
          renderer?.viewmodel?.freeze(null);
          reload = null;
          game.message('Perfect reload! Your next shot is steady.', 'c_light_green');
          sfx.parry();
        } else {
          combat.cooldown += 0.5;
          reload.dur += 0.5;
          game.message('You fumble the reload.', 'c_yellow');
        }
        return;
      }
      const before = combat.cooldown;
      prevReload();
      const w = p.inv.wielded;
      if (timingGames() && w?.isGun() && rangedClass(w) !== 'bow' && combat.cooldown > before + 0.3)
        reload = { t: 0, dur: combat.cooldown, skill: combat.aimSkill(w), judged: false };
    });
  }
  game.systems.push({
    name: 'aim-active-reload',
    update(_g, dt) {
      if (!reload) return;
      reload.t += dt;
      if (reload.t >= reload.dur || !p.inv.wielded?.isGun() || p.dead) reload = null;
    },
  });

  if (renderer) installPresenter(game, renderer, monsters, () => reload, api);

  if (api) {
    api.aimModel = () => aimModel();
    api.aimModels = AIM_MODELS;
    api.setAimModel = (m: AimModelId) => {
      choose(m);
      return aimModel();
    };
    /** The aim state: amplitude and offset (deg), kick, breath, the last hit's readout. */
    api.aimState = () => {
      const a = combat.aim;
      const o = a.offset(0);
      const deg = (r: number) => +((r * 180) / Math.PI).toFixed(3);
      const w = p.inv.wielded;
      const sk = combat.aimSkill(w);
      return {
        model: aimModel(), active: a.active, ampDeg: deg(a.amp), offsetDeg: { x: deg(o.x), y: deg(o.y) }, kickDeg: { x: deg(a.kickX), y: deg(a.kickY) },
        breath: combat.breath.state(sk, p.stamina / Math.max(1, p.staminaMax())), perfectNext: combat.perfectNext, lastHit: combat.lastHit,
        reload: reload && { t: +reload.t.toFixed(2), dur: +reload.dur.toFixed(2), band: reloadBand(reload.skill) },
      };
    };
  }
}

/** Per render frame: place the reticle, the HUD marks, the gun and the view kick from one aim offset. */
function installPresenter(game: Game, renderer: Renderer, monsters: MonstersHandle, reload: () => ActiveReload | null, api?: DebugApi): void {
  const { combat } = monsters;
  const p = game.player;
  const root = getUiRoot();
  const hud = new AimHud(root);
  if (api) api.aimHud = hud;
  try {
    hud.trail = Number(localStorage.getItem(TRAIL_KEY) ?? 0) || 0;
  } catch {
    // no storage: default off
  }
  registerOption({
    name: 'Aim trail',
    value: () => (hud.trail > 0 ? 'on' : 'off'),
    change: () => {
      hud.trail = hud.trail > 0 ? 0 : 1;
      try {
        localStorage.setItem(TRAIL_KEY, String(hud.trail));
      } catch {
        // not persisted
      }
    },
    desc: 'Free aim: a faint trail behind the crosshair showing how it has been weaving over the last second (helps you time shots).',
  });
  installModelHooks(game, renderer, monsters, api);
  let cross: HTMLElement | null = null;
  let readout: HTMLElement | null = null;
  let linger = 0;
  let last = performance.now();
  let fitT = 0;
  let fit: 'good' | 'fair' | 'poor' | 'none' = 'none';
  renderer.beforeRender.push(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const aim = combat.aim;
    const view = renderer.cameraMode !== 'top' && !game.input.captured && !p.dead;
    const on = view && aim.active;
    let rel = { x: 0, y: 0 }, vk = { x: 0, y: 0 };
    if (on) {
      // In between simulation ticks: sample the weave where it is *now* (the shot uses what we draw).
      const extra = game.paused || game.tacticalPause ? 0 : Math.max(0, Math.min(0.05, (now - aim.tickAt) / 1000));
      const off = aim.offset(extra);
      vk = aim.viewKick(FEEL, extra);
      rel = { x: off.x - vk.x, y: off.y - vk.y };
      aim.markShown(off.x, off.y, now, rel.x, rel.y);
    } else aim.shown = null;
    renderer.rig.aimView.x = vk.x;
    renderer.rig.aimView.y = vk.y;
    const fov = renderer.rig.camera.fov;
    const H = root.clientHeight || window.innerHeight;
    const px = offsetToPixels(rel, fov, H);
    cross ??= root.querySelector('.hud-cross');
    if (cross) cross.style.transform = on && (px.x || px.y) ? `translate(calc(-50% + ${px.x.toFixed(1)}px), calc(-50% + ${px.y.toFixed(1)}px))` : '';
    // The aim readout (combatdepth.ts, 18 px under the centre) rides along under the reticle, a
    // little lower, so the weaving crosshair never sits on its text.
    readout ??= root.querySelector('.aim-level');
    if (readout) readout.style.transform = on ? `translate(calc(-50% + ${px.x.toFixed(1)}px), ${(Math.max(0, px.y) + 8).toFixed(1)}px)` : 'translateX(-50%)';
    (api?.combatHud as { setReticle?: (x: number, y: number) => void } | undefined)?.setReticle?.(px.x, px.y);
    const vm = renderer.viewmodel;
    if (vm) {
      const lp = offsetToPixels(rel, fov, renderer.pipeline.lowH);
      vm.aimPx.x = lp.x;
      vm.aimPx.y = -lp.y;
    }

    // --- the overlay
    if (!view) {
      hud.frame(null, now);
      return;
    }
    const w = p.inv.wielded;
    const gun = w?.isGun() ? w : null;
    const rmb = (game.input.mouseButtons & 4) !== 0;
    if (rmb) linger = 0.5;
    else linger = Math.max(0, linger - dt);
    const f: AimHudFrame = { active: on, rx: px.x, ry: px.y, envelope: null, breath: null, bow: null, beat: 0, reload: null };
    if (on && gun && linger > 0) {
      // Fit: the weave's size against the angular size of what the view centre is on.
      if ((fitT -= dt) <= 0) {
        fitT = 0.1;
        const t = combat.rangedTarget(60);
        if (!t) fit = 'none';
        else {
          const ang = Math.atan2(t.m.radius, t.dist);
          fit = aim.amp <= ang * 0.7 ? 'good' : aim.amp <= ang * 1.4 ? 'fair' : 'poor';
        }
      }
      f.envelope = { r: offsetToPixels({ x: aim.amp, y: 0 }, fov, H).x, fit };
    }
    const sk = combat.aimSkill(w);
    const stamina = p.stamina / Math.max(1, p.staminaMax());
    if (timingGames() && on && gun) {
      const b = combat.breath;
      const st = b.state(sk, stamina);
      if (st !== 'none') f.breath = { state: st, left: st === 'recovering' ? 1 - b.recovering / 1.5 : 1 - b.held / (Breath.holdLimit(sk, stamina) + 1) };
      const d = combat.draw;
      if (d && d.style === 'draw' && d.t >= d.full) {
        const win = bowWindow(sk);
        // The ring closes from 40 px to the 10 px target ring at the window's centre, then keeps closing.
        const k = d.heldFull / win.delay;
        f.bow = { r: 10 + 30 * (1 - k), perfect: Math.abs(d.heldFull - win.delay) <= win.width / 2 };
      }
    }
    if (timingGames() && !gun && freeAim()) {
      // Melee beat: pulse as the next swing comes ready (click inside the pulse to chain on the beat).
      const rw = rhythmWindow(sk);
      if (combat.swing && combat.cooldown > 0 && combat.cooldown <= rw.early) f.beat = 1 - combat.cooldown / rw.early;
      else if (!combat.swing && combat.cooldown <= 0) f.beat = 0;
    }
    const r = reload();
    if (r && timingGames()) f.reload = { t: r.t / r.dur, band: reloadBand(r.skill), judged: r.judged };
    hud.frame(f, now);
  });
}

/**
 * The renderer's side of free aim: the drawn camera (aimHooks.view, so a shot follows exactly the
 * pixel under the reticle, over the shoulder too), the drawn 3D bodies (aimHooks.pick: hit zones
 * from the model's own head/limb boxes), and the dodge hop — a monster that dodges a swing
 * (monsterDodge) springs up and leans away over 0.3 s on top of the slide the simulation gives it.
 */
function installModelHooks(game: Game, renderer: Renderer, monsters: MonstersHandle, api?: DebugApi): void {
  const p = game.player;
  const view = monsters.view;
  const cam = renderer.rig.camera;
  const e = cam.matrixWorld.elements;
  // three.js (x, y up, z) -> game (x, y = z, h = y)
  const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y: z, h: y });
  aimHooks.view = () => {
    const mode = renderer.cameraMode;
    if (mode === 'top') return null;
    const eyeH = (p.crouching ? 1.0 : 1.6) + renderer.rig.eyeOffset + (renderer.groundAt?.(p.x, p.y, p.z) ?? 0);
    return {
      o: v3(e[12], e[13], e[14]), r: v3(e[0], e[1], e[2]), u: v3(e[4], e[5], e[6]), f: v3(-e[8], -e[9], -e[10]),
      third: mode === 'third', eye: { x: p.x, y: p.y, h: p.z * LEVEL_HEIGHT + eyeH },
    };
  };
  if (!view) return;
  aimHooks.pick = (m, o, d) => {
    const mon = m as Monster;
    const inst = view.modelOf(mon);
    if (!inst) return undefined;
    const r = pickModel(inst, o, d);
    if (!r) return r;
    return { t: r.t, part: r.part, zone: zoneOfPart(r.part, mon.type.flags.includes('NOHEAD')) };
  };
  if (api) {
    /** Debug/setup: the drawn world centre (game coords) of a monster's model part, e.g. to aim at its head. */
    api.modelPart = (uid: number, name: string) => {
      const m = monsters.sys.active.find((q) => q.uid === uid);
      const inst = m && view.modelOf(m);
      if (!inst) return null;
      const i = inst.rig.parts.findIndex((q) => q.name === name);
      if (i < 0) return null;
      const e = inst.mats.subarray(i * 16, i * 16 + 16);
      return { x: e[12], y: e[14], h: e[13], parts: inst.rig.parts.map((q) => q.name) };
    };
    api.modelLift = (uid: number) => {
      const m = monsters.sys.active.find((q) => q.uid === uid);
      const inst = m && view.modelOf(m);
      return inst ? { lift: inst.lift, fall: inst.fall } : null;
    };
  }

  // --- dodge hop (additive over what the monster view set this tick; see the header)
  const HOP = 0.3;
  const hops = new Map<Monster, { t: number; dx: number; dy: number; lift: number; fall: number; baseLift: number; baseFall: number; baseDx: number; baseDy: number }>();
  game.events.on('monsterDodge', (ev) => {
    const d = Math.hypot(ev.dx, ev.dy) || 1;
    hops.set(ev.monster as Monster, { t: 0, dx: ev.dx / d, dy: ev.dy / d, lift: NaN, fall: NaN, baseLift: 0, baseFall: 0, baseDx: 0, baseDy: 1 });
  });
  renderer.beforeRender.unshift((dt) => {
    for (const [m, h] of hops) {
      const inst = view.modelOf(m);
      h.t += dt;
      if (!inst || m.dead) {
        hops.delete(m);
        continue;
      }
      // The monster view rewrites lift/fall every simulation tick; between ticks our last write stands.
      if (inst.lift !== h.lift) h.baseLift = inst.lift;
      if (inst.fall !== h.fall) {
        h.baseFall = inst.fall;
        h.baseDx = inst.fallDx;
        h.baseDy = inst.fallDy;
      }
      const u = Math.min(1, h.t / HOP);
      const k = Math.sin(Math.PI * u);
      if (u >= 1 || h.baseFall > 0) {
        inst.lift = h.baseLift;
        inst.fall = h.baseFall;
        inst.fallDx = h.baseDx;
        inst.fallDy = h.baseDy;
        inst.dirty = true;
        hops.delete(m);
        continue;
      }
      inst.lift = h.lift = h.baseLift + 0.28 * k;
      // Lean away: the body tips toward where it's springing, about its feet.
      inst.fall = h.fall = 0.35 * k;
      inst.fallDx = h.dx;
      inst.fallDy = h.dy;
      inst.dirty = true;
    }
  });
}

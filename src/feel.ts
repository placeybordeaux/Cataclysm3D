import type { Game } from './game/game';
import { activeWeapon } from './game/bionicguns';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { MonstersHandle } from './monsters';
import type { Monster } from './game/monster';
import { ACTION_SCALE } from './core/time';
import { FEEL, FEEL_PRESETS, defenseOf, feelDifficulty, setFeelDifficulty, type FeelDifficulty } from './game/combatfeel';
import { interactOverrides } from './game/interact';
import { CombatHud } from './ui/combatHud';
import { getUiRoot } from './ui/framework';
import { drawWarning, rangedClass, strDrawPenalty } from './game/rangedfeel';
import { registerSaveable } from './save/registry';
import { sfx } from './audio/sfx';
import { freeAim } from './game/aimmodel';

// Wiring for the combat feel layer (src/game/combatfeel.ts; rules in playercombat.ts/monai.ts,
// visuals in render/{viewmodel,monsterView,hitFx,camera}.ts): the crosshair combat HUD, the
// struggle key while grabbed, gun kick on the camera, aim-down-sights zoom, the viewmodel
// jolt when you're hit, reload timing, and window.cdda helpers. main.ts calls it once, after
// installCombatDepth (it wraps the reload key that one installs).

export function installCombatFeel(game: Game, renderer: Renderer | null, monsters: MonstersHandle, api?: DebugApi): void {
  const { combat, sys } = monsters;
  const p = game.player;

  // --- grabbed: the interact key struggles (CDDA: you break free by trying to move away,
  // which still works; mashing the key is the explicit version and builds a bonus).
  const prevInteract = game.keys.handler('interact');
  game.keys.register('interact', 'Examine / open / close / use / talk (while grabbed: struggle)', () => {
    if (sys.grabbedBy) {
      sys.struggle();
      return;
    }
    prevInteract?.();
  });
  interactOverrides.unshift({
    interact: () => false,
    // While grabbed the GRABBED banner (combatHud.ts) already says which key breaks free: an empty
    // prompt keeps the crosshair clear (and hides door/item prompts that don't apply now).
    prompt: () => (sys.grabbedBy ? '' : null),
  });

  // --- reload takes (and shows) time: the gun dips out of view and can't fire until it's back.
  const prevReload = game.keys.handler('reload');
  if (prevReload) {
    game.keys.register('reload', 'Reload / clear jam', () => {
      const w = p.inv.wielded;
      const before = w?.isGun() ? w.ammoRemaining() : -1;
      const mag = w?.isGun() ? w.magazineCurrent() ?? null : null;
      prevReload();
      if (!w?.isGun() || p.inv.wielded !== w) return;
      const loaded = w.ammoRemaining() - before;
      if (loaded <= 0 && (w.magazineCurrent() ?? null) === mag) return;
      // CDDA reload cost in moves (item reload_time, per round without a magazine), as real time.
      // Bows nock (fast: BN charges the draw with the shot); crossbows are cranked (STR_RELOAD:
      // strong survivors crank faster, Character::item_reload_cost).
      const cls = rangedClass(w);
      if (cls === 'bow') return;
      const per = typeof w.def.reload === 'number' ? w.def.reload : 100;
      const strMul = w.hasFlag('STR_RELOAD') ? Math.max(10 / Math.max(10, p.str), 0.25) : 1;
      // Character::item_reload_cost: the weapon's skill speeds it, mv / (1 + min(skill × 0.1, 1)).
      const skillDiv = 1 + Math.min(p.getSkill(String(w.def.skill ?? 'gun')) * 0.1, 1);
      const moves = ((w.takesMagazines() ? per + 100 : per * Math.max(1, loaded)) * strMul) / skillDiv;
      const secs = Math.max(0.7, Math.min(cls === 'crossbow' ? 3.5 : 2.5, moves / 100 / ACTION_SCALE * 2));
      renderer?.viewmodel?.reload(secs, cls === 'crossbow' ? 'crank' : 'dip');
      if (cls === 'crossbow') sfx.crossbowCrank();
      combat.cooldown = Math.max(combat.cooldown, secs);
    });
  }

  // A save lands every arrow still in the air where it is (nothing is lost mid-flight).
  registerSaveable(game, 'arrows_in_flight', { order: -1, save: () => (combat.settleFlights(), 0), load: () => {} });

  // Wielding a bow you can't draw properly: say so at once (BN only tells you when you fire).
  let lastWield: unknown = null;
  game.systems.push({
    name: 'draw-strength-warning',
    update() {
      const w = p.inv.wielded;
      if (w === lastWield) return;
      lastWield = w;
      const warn = w?.isGun() ? drawWarning(w, p) : null;
      if (warn) game.message(warn, strDrawPenalty(w!, p) < 0.5 ? 'c_light_red' : 'c_yellow');
    },
  });

  if (renderer) {
    // --- gun kick on the view, scaled by the round's recoil (and tiny for a bow, rangedfeel.kickScale).
    // Free aim: the kick is part of the aim state (aimmodel.AimSway) and src/aim.ts shows its view share.
    combat.onFire = (kick) => {
      if (!freeAim()) renderer.rig.kick(0.012 * Math.min(1, kick * 2) + 0.018 * kick, (Math.random() - 0.5) * 0.01 * kick);
    };
    if (renderer.viewmodel) renderer.viewmodel.bowSource = () => combat.bowPose();
    // --- ADS: RMB with a gun zooms in and brings the gun to the centre (aim level is shown by
    // combatdepth's readout under the crosshair).
    game.systems.push({
      name: 'combat-feel-ads',
      update() {
        const aiming = !!activeWeapon(game)?.isGun() && (game.input.mouseButtons & 4) !== 0 && !game.input.captured && !p.dead;
        renderer.rig.ads = aiming ? 1 : 0;
        renderer.rig.adsFov = FEEL.adsFov;
        if (renderer.viewmodel) renderer.viewmodel.ads = aiming;
      },
    });
    // --- getting hit knocks the hands toward the side the blow came from.
    game.events.on('playerHurt', (e) => {
      const m = e.source as { x?: number; y?: number } | undefined;
      if (typeof m?.x !== 'number' || typeof m.y !== 'number') return;
      const rel = Math.atan2(m.x - p.x, -(m.y - p.y)) - p.yaw;
      renderer.viewmodel?.jolt(-Math.sin(rel), e.amount > 0 ? Math.min(1, 0.4 + e.amount / 15) : 0.3);
    });
    // Dust and blood where dying bodies land; tracers for every gun line.
    const fx = api?.hitFx as { bodyLanded?: (x: number, y: number, z: number, b: string | null) => void; watchTracers?: (f: () => readonly never[]) => void } | undefined;
    if (monsters.view && fx?.bodyLanded) monsters.view.onBodyLanded = (x, y, z, b) => fx.bodyLanded!(x, y, z, b);
    fx?.watchTracers?.(() => combat.tracers as never);
    try {
      const hud = new CombatHud(game, combat, sys, getUiRoot(), () => renderer.cameraMode !== 'top', () => renderer.rig.camera.fov);
      if (api) api.combatHud = hud;
    } catch (e) {
      console.warn(`combat HUD unavailable: ${e}`);
    }
  }

  if (api) installDebug(api, game, monsters);
}

function installDebug(api: DebugApi, game: Game, monsters: MonstersHandle): void {
  const { combat, sys } = monsters;
  /** The live feel constants (mutate fields to experiment) and the difficulty hook. */
  api.feel = FEEL;
  api.feelPresets = FEEL_PRESETS;
  api.setFeel = (d: FeelDifficulty, overrides = {}) => {
    setFeelDifficulty(d, overrides);
    return feelDifficulty();
  };
  /**
   * Frame-exact recording for judging animation timing: runs `n` frames of `dt` seconds
   * (simulation + render) synchronously, calling `each(i)` before frame i (start a swing,
   * press guard…), and returns each frame as a PNG data URL cropped to the centre `crop`
   * fraction of the canvas. The DOM HUD isn't in these; screenshot for that.
   *   cdda.recordFrames(24, 1/60, (i) => i === 0 && cdda.combat.attack())
   */
  api.recordFrames = (n: number, dt = 1 / 60, each?: (i: number) => void, crop = 0.6) => {
    const r = api.renderer;
    const canvas = r.three.domElement as HTMLCanvasElement;
    const out: string[] = [];
    const c2 = document.createElement('canvas');
    for (let i = 0; i < n; i++) {
      each?.(i);
      game.frame(dt);
      r.render(dt);
      const w = Math.round(canvas.width * crop), h = Math.round(canvas.height * crop);
      c2.width = w;
      c2.height = h;
      c2.getContext('2d')!.drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2 + h * 0.15, w, h, 0, 0, w, h);
      out.push(c2.toDataURL('image/png'));
    }
    return out;
  };
  /** Snapshot of the feel layer: swing phase, hit-stop, guard, side-step, monster wind-ups. */
  api.feelState = () => {
    const s = combat.swing;
    const def = defenseOf(game.player);
    return {
      difficulty: feelDifficulty(),
      swing: s && { t: +s.t.toFixed(3), windup: +s.timing.windup.toFixed(3), contact: +(s.timing.windup + s.timing.strike).toFixed(3), total: +s.timing.total.toFixed(3), resolved: s.resolved, style: s.style },
      cooldown: +combat.cooldown.toFixed(3), hitStop: +combat.hitStop.toFixed(3),
      guarding: def.guarding, guardAge: +def.guardAge.toFixed(2), dodgeWindow: +def.dodgeWindow.toFixed(2), stepping: !!combat.step,
      grabbed: !!sys.grabbedBy, struggle: def.struggle,
      windups: sys.active.filter((m: Monster) => m.windup).map((m: Monster) => ({ uid: m.uid, kind: m.windup!.kind, t: +m.windup!.t.toFixed(3), total: +m.windup!.total.toFixed(3) })),
    };
  };
}

import { ACTION_SCALE } from '../core/time';
import type { ItemDef } from '../data/types';
import type { Game, GameSystem } from './game';
import { aim, aimFloorMoa, applyDelayedRecoil, applyFlatArmor, attackCooldownSeconds, dispersionBreakdown, fireGun, hitMessage, meleeAttack, meleeHitRoll, normalRoll, pelletAngle, sizeRank, type ShotResult } from './combat';
import { MAX_RECOIL } from './character';
import { currentMode } from './gunmods';
import { asArray, type Item } from './item';
import { L, moveItem, spawnItem } from './moves';
import {
  arcHeight, canDraw, drawSeconds, drawStyle, embedsIn, fliesVisibly, flightSpeed, hasMuzzleFlash, kickScale, LAUNCH_DROP, rangedClass, rangedMissReason, strNeeded,
  type DispersionBreakdown, type DrawStyle, type RangedClass, type RangedMissKind,
} from './rangedfeel';
import type { Voice } from '../audio/audio';
import { turnsToSeconds, type MonEffect, type Monster } from './monster';
import { COMBAT_TURN, maOf, tickMartialArts, triggerBuffs } from './martialarts';
import { techniqueMessage, type TargetInfo, type TechniqueOutcome } from './techniques';
import type { MonsterSystem } from './monai';
import { Grid, hasLOS } from './los';
import { sfx, type MeleeSkill } from '../audio/sfx';
import { FEEL, arcFor, defenseOf, hitStopSeconds, missReason, sweptArcTarget, swingTiming, type SwingStyle, type SwingTiming } from './combatfeel';
import { moveWithCollision, CREATURE_RADIUS } from './physics';
import { projectileHit } from './projectile';
import {
  aimDirection, aimHooks, AimSway, basisDirection, basisOf, swingFan, yawPitch, type Vec3, BODY_HEIGHT, Breath, bowPerfect, describeHit, freeAim, hitDamageMul, rhythmWindow, swayAmplitude, timingGames, weakSpotChance,
  type HitZone,
} from './aimmodel';
import { raycastTiles } from './raycast';
import { LEVEL_HEIGHT } from '../world/coords';

// The survivor's attacks in real time: LMB / `f` swings or fires, RMB aims a gun (or guards
// with a melee weapon / bare hands), Space or a double-tapped strafe side-steps, `G` throws.
//
// LMB melee runs through the feel layer (combatfeel.ts): wind-up -> contact -> active window ->
// recovery. The blow resolves at contact, against whatever the weapon's swept arc finds around
// the crosshair *then* (exact ray hit first, else closest in angle), with combat.ts meleeAttack
// underneath; a target stepping into the arc during the short active window still gets hit.
// `melee()` without the phases (tests, scripts) resolves instantly like before.
// Guns are hitscan: the CDDA dispersion roll becomes a cone offset around the view ray,
// walked tile by tile until a wall or a monster circle stops it.

/** Real seconds between the rounds of a burst (CDDA fires a burst within one action). */
const BURST_INTERVAL = 0.075;

export interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
  t: number;
}

/** Optional first-person viewmodel from the render agent. */
export interface ViewModelHook {
  attack(kind: 'melee' | 'fire' | 'throw' | 'sweep'): void;
  /** Raise the weapon/arms briefly (a block). */
  block?(): void;
  /** Feel layer: a phase-timed swing whose contact pose lands at windup + strike. */
  swing?(ph: { windup: number; strike: number; follow: number; recovery: number; style: SwingStyle }): void;
  /** Hold the pose for hit-stop. */
  impact?(seconds: number): void;
  setGuard?(on: boolean): void;
  /** Gun kick scaled by the round's recoil (replaces attack('fire') when present); `flash` false for bows, slings, air guns. */
  recoil?(k: number, o?: { flash?: boolean; cls?: RangedClass }): void;
}

/** A bow being drawn or a sling being whirled (RMB, or a snap shot from LMB). */
export interface DrawState {
  gun: Item;
  style: Exclude<DrawStyle, 'trigger'>;
  /** Seconds since the draw began, and seconds to full draw. */
  t: number;
  full: number;
  /** Loose as soon as fully drawn (LMB was pressed, or a snap shot). */
  release: boolean;
  /** Seconds held at full draw (the arms tire past FEEL.drawHoldSteady). */
  heldFull: number;
}

/**
 * An arrow, bolt or stone in the air. It flies straight in plan along `yaw` (the BN dispersion
 * roll already bent it off the crosshair) at `speed` m/s on a gravity arc (rangedfeel.arcHeight),
 * and resolves against whatever it actually reaches: a monster's circle, a wall, the ground.
 */
export interface Flight {
  x0: number;
  y0: number;
  z: number;
  dx: number;
  dy: number;
  yaw: number;
  /** Metres flown; current position (x, y) and height above the floor (h). */
  s: number;
  x: number;
  y: number;
  h: number;
  speed: number;
  /** BN range (tiles): nothing is hit past it, the round only falls. */
  range: number;
  arc: { eye: number; slope: number; aimDist: number; speed: number };
  cls: RangedClass;
  gun: Item;
  ammo: ItemDef | undefined;
  shot: ShotResult;
  /** The round itself when it survives (unplaced until it lands), else null (broke). */
  round: Item | null;
  /** What the crosshair was on at release, and how far. */
  intended: Monster | null;
  intendedDist: number;
  spread: DispersionBreakdown;
  /** Monsters that dodged it or that it flew over (it carries on past them). */
  passed: Set<Monster>;
  overflew: Set<Monster>;
  /** The crosshair already said why it missed. */
  explained: boolean;
  done: boolean;
  /** Free aim (aimmodel.ts): resolve by where it struck, no BN dice; timing: loosed in the window. */
  free?: boolean;
  perfect?: boolean;
}

/** Where a free-aim ray (the reticle's) ends: the first body it enters, a solid, the floor, or its range. */
export interface AimHit {
  x: number;
  y: number;
  /** Height above the shooter's floor (m), absolute height, and horizontal distance (m) from the survivor where it ended. */
  h: number;
  hAbs: number;
  dist: number;
  hit: Monster | null;
  /** Plan distance from the body's axis as a share of its radius (0 = dead centre). */
  missedBy: number;
  /** Height of the strike on the body, 0 = feet .. 1 = top, and the zone that is. */
  hFrac: number;
  zone: HitZone;
  /** What stopped it when it didn't hit a body. */
  stop: 'wall' | 'floor' | 'range' | null;
}

/** Where a recovered round came to rest in view (the renderer draws it stuck there until picked up). */
export interface Landed {
  /** The ground stack that holds it (arrows merge into one stack per tile). */
  item: Item;
  x: number;
  y: number;
  z: number;
  /** Height of the tip above the floor, the flight's yaw, and what it went into. */
  hgt: number;
  yaw: number;
  into: 'wall' | 'ground' | 'body';
  map: Parameters<typeof L.ground>[0];
}

/** Rough standing height (m) by size, for arrows flying over small things. */
const HEIGHT_BY_SIZE: Record<string, number> = { tiny: 0.5, small: 0.9, medium: 1.9, large: 2.6, huge: 3.6 };

/** A swing in progress (feel layer). `t` counts from the click. */
export interface SwingState {
  t: number;
  timing: SwingTiming;
  reach: number;
  arc: number;
  style: SwingStyle;
  resolved: boolean;
  /** Free aim: the monster that visibly dodged this swing; timing: chained on the beat. */
  dodged?: Monster | null;
  perfect?: boolean;
}

/** How a weapon is swung on screen (and how wide its arc is). */
export function swingStyleOf(w: Item | null): SwingStyle {
  if (!w) return 'punch';
  const skill = w.meleeSkill();
  if (skill === 'stabbing' || w.hasFlag('SPEAR') || w.hasFlag('REACH_ATTACK')) return 'thrust';
  return 'swing';
}

/** CDDA melee_message verbs by dominant damage type and total damage. */
export function meleeVerb(dominant: string, total: number, rngInt: (a: number, b: number) => number): string {
  const stab = ['impale', 'gouge', 'run through', 'puncture', 'pierce', 'poke'];
  const cut = ['gut', 'chop', 'slash', 'mutilate', 'maim', 'stab', 'slice', 'cut', 'nick'];
  const bash = ['clobber', 'smash', 'thrash', 'batter', 'whack', 'hit'];
  const cutting = dominant === 'cut';
  let idx: number;
  if (total > 30) idx = cutting ? rngInt(0, 4) : rngInt(0, 2);
  else if (total > 20) idx = cutting ? rngInt(5, 6) : 3;
  else if (total > 10) idx = cutting ? 7 : 4;
  else idx = cutting ? 8 : 5;
  if (dominant === 'stab') return stab[Math.min(idx, 5)];
  if (dominant === 'cut') return cut[idx];
  return bash[Math.min(idx, 5)];
}

function signedAngle(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function angleDiff(a: number, b: number): number {
  return Math.abs(signedAngle(a, b));
}

/** What technique conditions know about a monster (TargetInfo). */
export function monsterTargetInfo(m: Monster): TargetInfo {
  return {
    size: sizeRank(m.size),
    bodytype: typeof m.type.bodytype === 'string' ? m.type.bodytype : undefined,
    species: m.type.species,
    flags: m.type.flags,
    hasEffect: (id) => m.hasEffect(id as MonEffect),
    isMonster: true,
    // BN disarm techniques work on monsters that carry a monster_weapon (feral humans).
    hasWeapon: !!(m.type as { monster_weapon?: string }).monster_weapon && !m.hasEffect('monster_disarmed' as MonEffect),
    volumeMl: m.type.volume,
    grabStrength: typeof m.type.grab_strength === 'number' ? m.type.grab_strength : undefined,
  };
}

/**
 * perform_technique's effects on a monster: stunned/downed for rng(1, dur) combat turns and a
 * knockback shove (monster dash) of 1..knockback_dist tiles straight away from the attacker.
 */
export function applyTechniqueToMonster(m: Monster, o: TechniqueOutcome, fromX: number, fromY: number, rng: { int(a: number, b: number): number }): void {
  if (o.downTurns > 0) m.addEffect('downed', o.downTurns * COMBAT_TURN);
  if (o.stunTurns > 0) m.addEffect('stunned', o.stunTurns * COMBAT_TURN);
  if (o.knockback > 0 && !m.has('IMMOBILE')) {
    const spread = o.knockbackSpread;
    const ax = fromX + (spread ? rng.int(-spread, spread) : 0), ay = fromY + (spread ? rng.int(-spread, spread) : 0);
    const d = Math.max(0.01, Math.hypot(m.x - ax, m.y - ay));
    const t = 0.18;
    m.dashVx = ((m.x - ax) / d) * (o.knockback / t);
    m.dashVy = ((m.y - ay) / d) * (o.knockback / t);
    m.dashTime = t;
  }
}

export class PlayerCombat implements GameSystem {
  readonly name = 'player-combat';
  cooldown = 0;
  /** The swing being animated/resolved (null between swings). */
  swing: SwingState | null = null;
  /** Hit-stop seconds left: the swing clock and cooldown hold while the blow lands. */
  hitStop = 0;
  /** Side-step in progress: velocity (tiles/s) and seconds left. */
  step: { vx: number; vy: number; t: number } | null = null;
  stepCooldown = 0;
  /** Gunfire feedback for the renderer (camera kick): the round's recoil, ~1 for a pistol (a bow's is tiny). */
  onFire: ((kick: number, cls: RangedClass) => void) | null = null;
  /** Shots whose powder flashed (renderer: muzzle light); bows, slings and air guns don't count. */
  flashShots = 0;
  lastShotClass: RangedClass | null = null;
  /** The bow being drawn / sling being whirled. */
  draw: DrawState | null = null;
  /** Arrows, bolts and stones in the air (render/arrowFx.ts draws them). */
  readonly flights: Flight[] = [];
  /** Recovered rounds lying where they landed (render/arrowFx.ts draws them stuck there). */
  readonly landed: Landed[] = [];
  private whirl: Voice | null = null;
  private ammoCache = { t: 0, gun: null as Item | null, has: false };
  private time = 0;
  private prevHeld = new Set<string>();
  private tapAt: Record<string, number> = {};
  readonly tracers: Tracer[] = [];
  /** Shots fired so far (renderer uses it to trigger muzzle flashes). */
  shots = 0;
  viewmodel: () => ViewModelHook | undefined = () => undefined;
  /**
   * NPC system hooks (src/game/npcai.ts). attackGuard may veto an attack (it asks before
   * hitting a friendly NPC); npcMelee takes the swing when an NPC is a better target than
   * monster `m`; npcShot lets an NPC standing on the bullet's path (before `maxDist`) take it.
   */
  attackGuard: (() => boolean) | null = null;
  npcMelee: ((reach: number, m: Monster | null) => boolean) | null = null;
  npcShot: ((yaw: number, maxDist: number, shot: ShotResult) => { x: number; y: number } | null) | null = null;
  /** An arrow/bolt/stone the survivor loosed struck NPC `n` (npcai applies it; followers included). */
  npcRound: ((n: unknown, shot: ShotResult, missedBy: number, what: string) => void) | null = null;
  private grid: Grid;
  private lastX = NaN;
  private lastY = NaN;
  /**
   * Free aim (aimmodel.ts): where the weapon points relative to the view (sway + kick). The
   * reticle is drawn there and the shot leaves along it. `breath` is the timing model's held
   * breath; `perfectNext` a perfect shot banked by an active reload.
   */
  readonly aim = new AimSway();
  readonly breath = new Breath();
  perfectNext = false;
  /** Ground speed (m/s) for the sway, smoothed. */
  private aimSpeed = 0;
  private aimLast = { x: NaN, y: NaN };
  /** Timing: when the next swing became ready (time), and a click banked just before it. */
  private readyAt = -Infinity;
  private buffered = false;
  private wasReady = true;
  /** The last free-aim hit's readout (tests, debug). */
  lastHit: { zone: HitZone; mul: number; text: string; perfect: boolean } | null = null;

  constructor(readonly game: Game, readonly sys: MonsterSystem) {
    this.grid = sys.grid;
  }

  update(game: Game, dt: number): void {
    this.time += dt;
    // Hit-stop freezes the swing clock (and its cooldown) for a few frames when a blow lands.
    if (this.hitStop > 0) this.hitStop = Math.max(0, this.hitStop - dt);
    else this.cooldown = Math.max(0, this.cooldown - dt);
    this.stepCooldown = Math.max(0, this.stepCooldown - dt);
    for (let i = this.tracers.length - 1; i >= 0; i--) if ((this.tracers[i].t -= dt) <= 0) this.tracers.splice(i, 1);
    const input = game.input;
    const p = game.player;
    // Martial-arts turn clock: buffs expire, dodges/blocks refresh, onmove/onpause buffs.
    if (Math.hypot(p.x - this.lastX, p.y - this.lastY) > 0.02) maOf(p).moved = true;
    this.lastX = p.x;
    this.lastY = p.y;
    tickMartialArts(p, dt);
    const def = defenseOf(p);
    def.dodgeWindow = Math.max(0, def.dodgeWindow - dt);
    // Free aim: melee skill widens the parry window (aimmodel.ts; 1 in the dice model).
    def.parryMul = freeAim() ? 1 + FEEL.aimParryPerSkill * Math.min(10, p.getSkill('melee')) : 1;
    this.updateAim(dt);
    this.updateStep(dt);
    if (this.hitStop <= 0) this.updateSwing(dt);
    this.updateFlights(dt);
    if (p.dead || input.captured) {
      if (this.draw) this.cancelDraw();
      this.setGuard(false);
      this.prevHeld.clear();
      return;
    }
    // LMB: consume our clicks but leave other buttons' clicks for whoever else reads them.
    const clicks = input.consumeClicks();
    const others = clicks.filter((b) => b !== 0);
    if (others.length) (input as unknown as { clicks: number[] }).clicks.push(...others);
    const gun = p.inv.wielded?.isGun() ? p.inv.wielded : null;
    const style = gun ? drawStyle(gun) : 'trigger';
    // Holding LMB keeps swinging a melee weapon, but a gun only keeps firing when it has an
    // automatic mode; a pistol fires once per click like CDDA's one shot per `f`.
    const held = (input.mouseButtons & 1) !== 0 && (!gun || (style === 'trigger' && currentMode(gun).qty > 1));
    this.updateBurst(dt);
    const rmb = (input.mouseButtons & 4) !== 0;
    // Bows and slingshots are drawn (RMB), slings whirled; both loose on LMB (rangedfeel.ts).
    if (gun && style !== 'trigger') {
      this.setGuard(false);
      this.detectSidestep();
      this.updateDraw(gun, style, clicks.includes(0), rmb, dt);
      return;
    }
    if (this.draw) this.cancelDraw();
    const lmb = clicks.includes(0) || held;
    if (gun && rmb) aim(p, gun, dt * ACTION_SCALE * 100);
    // RMB with a melee weapon or bare hands: guard (lowered while a swing plays).
    this.setGuard(!gun && rmb && !this.swing && !p.effects.has('downed') && !game.movementOverride?.());
    if (def.guarding) {
      def.guardAge += dt;
      p.modStamina(-FEEL.guardStaminaPerSec * dt);
    }
    this.detectSidestep();
    const ready = this.cooldown <= 0 && !this.swing;
    if (ready && !this.wasReady) this.readyAt = this.time;
    this.wasReady = ready;
    // Timing model, melee: a click just before the swing is ready is banked, and one landing in
    // the window around the ready moment chains a perfect swing. Holding LMB repeats plainly.
    const rhythm = timingGames() && !gun;
    const click = clicks.includes(0);
    if (rhythm && click && !ready && this.cooldown <= rhythmWindow(this.meleeSkill()).early) this.buffered = true;
    if (ready && (lmb || this.buffered)) {
      const onBeat = rhythm && (this.buffered || (click && this.time - this.readyAt <= rhythmWindow(this.meleeSkill()).late));
      this.buffered = false;
      this.attack();
      if (onBeat && this.swing) this.swing.perfect = true;
    }
  }

  /** The skill that sets the melee rhythm window: the weapon's skill and melee, averaged. */
  private meleeSkill(): number {
    const p = this.game.player;
    const w = p.inv.wielded;
    return (p.getSkill(w ? w.meleeSkill() : 'unarmed') + p.getSkill('melee')) / 2;
  }

  // ------------------------------------------------------------------ free aim (aimmodel.ts)

  /** The weapon skill free aim uses: BN dispersion_from_skill's average of marksmanship and the weapon's skill. */
  aimSkill(gun: Item | null = this.game.player.inv.wielded): number {
    const p = this.game.player;
    if (!gun?.isGun()) return 0;
    return Math.min((p.getSkill('gun') + p.getSkill(String(gun.def.skill ?? 'gun'))) / 2, 10);
  }

  /** Advance the reticle sway: its size from BN's dispersion and the survivor's state (aimmodel.swayAmplitude). */
  private updateAim(dt: number): void {
    const game = this.game;
    const p = game.player;
    const gun = p.inv.wielded?.isGun() ? p.inv.wielded : null;
    const moved = Number.isNaN(this.aimLast.x) ? 0 : Math.hypot(p.x - this.aimLast.x, p.y - this.aimLast.y);
    this.aimLast.x = p.x;
    this.aimLast.y = p.y;
    this.aimSpeed += ((dt > 0 ? moved / dt : 0) - this.aimSpeed) * Math.min(1, dt * 8);
    this.aim.active = freeAim() && !!gun && !p.dead;
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!this.aim.active || !gun) {
      this.breath.update(dt, false, 0, 1);
      this.aim.update(dt, 0, 10, FEEL, now);
      return;
    }
    const b = dispersionBreakdown(p, gun);
    const skill = this.aimSkill(gun);
    const stamina = p.stamina / Math.max(1, p.staminaMax());
    const rmb = (game.input.mouseButtons & 4) !== 0 && !game.input.captured;
    const style = drawStyle(gun);
    const shift = game.input.held.has('ShiftLeft') || game.input.held.has('ShiftRight');
    // Timing: Shift while aiming a trigger weapon holds your breath (aim.ts vetoes running meanwhile).
    this.breath.update(dt, timingGames() && rmb && style === 'trigger' && shift, skill, stamina);
    const d = this.draw;
    const amp = swayAmplitude({
      staticMoa: (b.weapon + b.dex + b.hands + b.skill) * b.strMul,
      recoilMoa: p.recoil, floorMoa: aimFloorMoa(p, gun), skill,
      speed: this.aimSpeed, running: p.running && this.aimSpeed > 0.5, crouching: p.crouching,
      ads: style === 'trigger' && rmb ? 1 : 0, pain: p.pain, stamina,
      draw: d && d.style === 'draw' ? { full: d.t >= d.full, heldFull: d.heldFull, holdSteady: FEEL.drawHoldSteady } : null,
      breath: timingGames() ? this.breath.mul(skill, stamina) : 1,
    });
    this.aim.update(dt, amp, skill, FEEL, now);
  }

  /** Wall-clock ms (the HUD's clock), 0 without one. */
  private nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : 0;
  }

  /** The survivor's eye (absolute metres; x east, y south, h up). */
  private eye(): Vec3 {
    const p = this.game.player;
    return { x: p.x, y: p.y, h: p.z * LEVEL_HEIGHT + (p.crouching ? 1.0 : 1.6) };
  }

  /**
   * Where a free-aim shot leaves from and toward: the reticle's ray through the drawn camera
   * (aimHooks.view: exact, including camera shake and the pixel-snapped rotation). Over the
   * shoulder the camera isn't at the eye, so the round leaves the eye toward whatever the
   * camera's ray reaches (the point under the crosshair). Without a renderer (tests, the sim,
   * top-down view): from the eye along the view plus the aim offset.
   */
  aimRay(off: { x: number; y: number; rx: number; ry: number }, range: number): { o: Vec3; yaw: number; pitch: number } {
    const p = this.game.player;
    const v = aimHooks.view?.() ?? null;
    if (!v) return { o: this.eye(), ...aimDirection(p.yaw, p.pitch, off.x, off.y) };
    const cam = yawPitch(basisDirection(v, off.rx, off.ry));
    if (!v.third) return { o: v.o, ...cam };
    const far = this.castAim(cam.yaw, cam.pitch, range * 1.6 + 4, undefined, v.o);
    const d = { x: far.x - v.eye.x, y: far.y - v.eye.y, h: far.hAbs - v.eye.h };
    if (Math.hypot(d.x, d.y, d.h) < 0.6) return { o: v.eye, ...cam };
    return { o: v.eye, ...yawPitch(d) };
  }

  /**
   * The reticle's ray (free aim) from `origin` (default the eye): the first monster body it
   * enters, else the first solid, the floor, or `range` (m, in plan, from the origin). Bodies are
   * the drawn 3D models when there are any (aimHooks.pick: exact part boxes, so a dog's head is
   * where it's drawn), else a column of the body's height (aimHooks.body) zoned by height. Walls,
   * furniture and floors come from the tile raycast; see-through tiles let rounds through, as
   * castRay does.
   */
  castAim(yaw: number, pitch: number, range: number, skip?: (m: Monster) => boolean, origin: Vec3 = this.eye()): AimHit {
    const p = this.game.player;
    const o = origin;
    const hx = Math.sin(yaw), hy = -Math.cos(yaw);
    const cp = Math.max(0.02, Math.cos(pitch));
    const slope = Math.tan(pitch);
    const dir: Vec3 = { x: hx * cp, y: hy * cp, h: Math.sin(pitch) };
    const tile = raycastTiles(this.game.map, o, dir, { maxDist: range / cp + 0.5, throughTransparent: true });
    let limit = range, stop: AimHit['stop'] = 'range';
    if (tile && tile.dist * cp < limit) {
      limit = tile.dist * cp;
      stop = tile.kind === 'floor' ? 'floor' : 'wall';
    }
    const pick = aimHooks.pick;
    let best: Monster | null = null, bestS = limit, bestPerp = 1, bestFrac = 0, bestZone: HitZone = 'torso';
    for (const m of this.sys.active) {
      if (m.dead || m.z !== p.z || skip?.(m)) continue;
      const ox = m.x - o.x, oy = m.y - o.y;
      const t = ox * hx + oy * hy;
      // A little wider than the collision circle (shoulders); models get room for outflung limbs.
      const R = m.radius * 1.1;
      const reach = pick ? Math.max(R, m.radius * 2.5, 1) : R;
      if (t <= 0 || t - reach > bestS) continue;
      const perp = Math.abs(ox * hy - oy * hx);
      if (perp > reach) continue;
      const model = pick?.(m, o, dir);
      if (model === null) continue;
      if (model) {
        const s = model.t * cp;
        if (s <= 0.05 || s >= bestS) continue;
        best = m;
        bestS = s;
        bestPerp = 0;
        bestZone = model.zone;
        continue;
      }
      if (perp > R) continue;
      const half = Math.sqrt(R * R - perp * perp);
      const body = aimHooks.body?.(m, t) ?? { height: BODY_HEIGHT[m.size] ?? 1.7, lift: 0 };
      // The stretch of the chord through the body's column where the ray is between its feet and top.
      let s0 = Math.max(0.05, t - half), s1 = t + half;
      const foot = m.z * LEVEL_HEIGHT + body.lift;
      const lo = foot - o.h, hi = foot + body.height - o.h;
      if (Math.abs(slope) < 1e-9) {
        if (lo > 0 || hi < 0) continue;
      } else {
        let a = lo / slope, c = hi / slope;
        if (a > c) [a, c] = [c, a];
        s0 = Math.max(s0, a);
        s1 = Math.min(s1, c);
      }
      if (s0 > s1 || s0 >= bestS) continue;
      best = m;
      bestS = s0;
      bestPerp = perp / R;
      bestFrac = Math.max(0, Math.min(1, (o.h + slope * s0 - foot) / body.height));
      bestZone = aimHooks.hitZone(m, bestFrac);
    }
    const s = best ? bestS : limit;
    const x = o.x + hx * s, y = o.y + hy * s, hAbs = o.h + slope * s;
    return {
      x, y, h: hAbs - p.z * LEVEL_HEIGHT, hAbs, dist: Math.hypot(x - p.x, y - p.y), hit: best, missedBy: best ? bestPerp : 1, hFrac: bestFrac,
      zone: best ? bestZone : 'torso', stop: best ? null : stop,
    };
  }

  /**
   * A free-aim round lands on monster `m`: BN's damage for the round, times where it struck
   * (head/torso/legs, graze), a weak-spot roll from skill/dex/per, a perfect-timing bonus and the
   * skill multiplier (aimmodel.hitDamageMul) — no to-hit or dodge dice.
   */
  private freeHit(m: Monster, damage: ShotResult['damage'], o: { zone: HitZone; missedBy: number; perfect: boolean; name?: string; cls: RangedClass; gun: Item | null }): { total: number; dealt: { type: string; amount: number }[]; crit: boolean } {
    const game = this.game;
    const p = game.player;
    const skill = this.aimSkill(o.gun);
    const weak = this.sys.rng.next() < weakSpotChance(skill, p.dex, p.per, o.perfect ? 0.25 : 0);
    const q = hitDamageMul({ zone: o.zone, graze: o.missedBy > 0.8, weakSpot: weak, perfect: o.perfect, skill, skillName: skillName(String(o.gun?.def.skill ?? 'gun')) });
    const units = damage.map((d) => ({ type: d.type, amount: d.amount * q.mul, armor_penetration: d.armor_penetration, armor_multiplier: 1 }));
    const dealt = applyFlatArmor(units, m.type.armor);
    const total = Math.floor(dealt.reduce((a, d) => a + d.amount, 0));
    const crit = o.zone === 'head' || weak;
    const where = o.zone === 'head' ? ' in the head' : o.zone === 'legs' ? ' in the legs' : '';
    const what = o.name ? `Your ${o.name} hits` : 'You hit';
    game.message(total > 0 ? `${what} ${m.theName()}${where} for ${total} damage.` : `${o.name ? `Your ${o.name}` : 'The shot'} glances off ${m.theName()}!`, crit && total > 0 ? 'c_light_green' : undefined);
    if (o.zone === 'head') game.events.emit('playerHeadshot', { target: m });
    const text = describeHit(q);
    this.lastHit = { zone: o.zone, mul: q.mul, text, perfect: o.perfect };
    m.aggroCharacter = true;
    this.sys.hurt(m, total, 'player', { crit, stagger: 1 + FEEL.aimStaggerPerSkill * skill });
    this.feedback('gun', crit ? 'crit' : 'hit', m, m.x, m.y, total, 0, total <= 0 ? 'no damage' : text, { ranged: o.cls, quality: q.mul });
    return { total, dealt, crit };
  }

  private setGuard(on: boolean): void {
    const p = this.game.player;
    const def = defenseOf(p);
    if (on !== def.guarding) {
      def.guarding = on;
      def.guardAge = 0;
      this.viewmodel()?.setGuard?.(on);
    }
    p.moveSpeedMul = on ? FEEL.guardMoveMul : 1;
  }

  // ------------------------------------------------------------------ side-step

  /** Space, or a second tap of A/D/S within FEEL.doubleTap, side-steps that way. */
  private detectSidestep(): void {
    const held = this.game.input.held;
    let dir: string | null = null;
    for (const k of ['KeyA', 'KeyD', 'KeyS', 'Space']) {
      const down = held.has(k);
      if (down && !this.prevHeld.has(k)) {
        if (k === 'Space') dir = 'Space';
        else if (this.time - (this.tapAt[k] ?? -Infinity) <= FEEL.doubleTap) dir = k;
        this.tapAt[k] = this.time;
      }
      if (down) this.prevHeld.add(k);
      else this.prevHeld.delete(k);
    }
    if (dir) this.sidestep(dir);
  }

  /**
   * A quick step (FEEL.dodgeDistance over FEEL.dodgeTime) left/right/back; Space goes the way
   * the movement keys point, else back. Blows landing in the next FEEL.dodgeWindow roll CDDA's
   * dodge with a bonus (combat.ts tryDodgeRoll); stepping out of reach makes them whiff.
   */
  sidestep(key: string): boolean {
    const game = this.game;
    const p = game.player;
    if (this.stepCooldown > 0 || this.step || p.dead || p.effects.has('downed') || p.hasEffect('grabbed') || game.movementOverride?.()) return false;
    if (p.stamina < FEEL.dodgeStamina) {
      game.message("You're too winded to dodge.", 'c_yellow');
      this.stepCooldown = FEEL.dodgeCooldown;
      return false;
    }
    const held = game.input.held;
    let fx = 0, fy = -1;
    if (key === 'KeyA') [fx, fy] = [-1, 0];
    else if (key === 'KeyD') [fx, fy] = [1, 0];
    else if (key === 'Space') {
      const x = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0), y = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
      if (x || y) [fx, fy] = [x, y];
    }
    const len = Math.hypot(fx, fy);
    fx /= len;
    fy /= len;
    // Same frame as Game.updatePlayerMovement: forward = (sin yaw, -cos yaw).
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const wx = fy * sin + fx * cos, wy = -fy * cos + fx * sin;
    const v = FEEL.dodgeDistance / FEEL.dodgeTime;
    this.step = { vx: wx * v, vy: wy * v, t: FEEL.dodgeTime };
    this.stepCooldown = FEEL.dodgeCooldown;
    defenseOf(p).dodgeWindow = FEEL.dodgeWindow;
    p.modStamina(-FEEL.dodgeStamina);
    sfx.meleeWhiff(false);
    return true;
  }

  private updateStep(dt: number): void {
    const s = this.step;
    if (!s) return;
    const p = this.game.player;
    const t = Math.min(dt, s.t);
    s.t -= t;
    [p.x, p.y] = moveWithCollision(this.game.map, p.x, p.y, p.z, s.vx * t, s.vy * t);
    if (s.t <= 0 || p.dead) this.step = null;
  }

  // ------------------------------------------------------------------ phased swing

  /** Start a swing (LMB): the blow resolves at contact, see updateSwing. */
  beginSwing(): void {
    const p = this.game.player;
    const w = p.inv.wielded;
    const reach = w?.hasFlag('REACH_ATTACK') ? FEEL.reachLong : FEEL.reach;
    const style = swingStyleOf(w);
    const timing = swingTiming(attackCooldownSeconds(p, w), w?.weight() ?? 0);
    this.swing = { t: 0, timing, reach, arc: arcFor(style), style, resolved: false };
    this.cooldown = timing.total;
    if (freeAim()) this.swing.dodged = this.visibleDodge(reach, arcFor(style), timing.windup + timing.strike);
    const vm = this.viewmodel();
    // The follow-through carries past contact for up to 0.12 s, then the hands come back.
    const follow = Math.min(0.12, timing.active + timing.recovery * 0.4);
    if (vm?.swing) vm.swing({ windup: timing.windup, strike: timing.strike, follow, recovery: timing.total - timing.windup - timing.strike - follow, style });
    else vm?.attack('melee');
  }

  /**
   * Free aim: a monster that would dodge this swing (BN: the hit roll lands but not past its
   * dodge × 5) does it *visibly* — it hops back and aside out of the arc during the wind-up —
   * instead of the blow silently passing through it. Plain zombies (dodge 0) never do.
   */
  private visibleDodge(reach: number, arc: number, contact: number): Monster | null {
    const p = this.game.player;
    const m = this.meleeTarget(reach, arc);
    if (!m || m.dodge() <= 0 || m.has('IMMOBILE') || m.dashTime > 0) return null;
    const roll = meleeHitRoll(p, p.inv.wielded, this.sys.rng);
    if (roll < 0 || roll >= m.dodge() * 5) return null;
    const d = Math.max(0.01, Math.hypot(m.x - p.x, m.y - p.y));
    const ax = (m.x - p.x) / d, ay = (m.y - p.y) / d;
    const side = this.sys.rng.oneIn(2) ? 1 : -1;
    // Back and to the side, ~1.1 m, done before the blow lands: out of a ±40° arc at arm's length.
    const vx = ax * 0.6 + -ay * side * 0.8, vy = ay * 0.6 + ax * side * 0.8;
    const t = Math.max(0.08, Math.min(0.22, contact - 0.02));
    m.dashVx = (vx * 1.1) / t;
    m.dashVy = (vy * 1.1) / t;
    m.dashTime = t;
    this.game.events.emit('monsterDodge', { monster: m, x: m.x, y: m.y, z: m.z, dx: vx, dy: vy });
    return m;
  }

  /** Advance the swing: from contact until the active window closes, the arc looks for a target. */
  private updateSwing(dt: number): void {
    const s = this.swing;
    if (!s) return;
    s.t += dt;
    const contact = s.timing.windup + s.timing.strike;
    if (!s.resolved && s.t >= contact) {
      // A monster that visibly dodged this swing isn't in it any more, even if its edge still is.
      const pk = this.meleePick(s.reach, s.arc, s.dodged ?? undefined);
      const m = pk?.m ?? null;
      if (m || s.t >= contact + s.timing.active) {
        s.resolved = true;
        // An NPC under the crosshair may take the blow instead (npcai decides; asks first if friendly).
        if (!this.npcMelee?.(s.reach, m)) this.melee(m, { phased: s.t, zone: pk?.zone });
      }
    }
    if (s.resolved && s.t >= s.timing.total) this.swing = null;
  }

  /** LMB / debug: fire if wielding a gun, else start a (phased) swing. */
  attack(): void {
    if (this.attackGuard && !this.attackGuard()) return;
    const w = this.game.player.inv.wielded;
    const style = w?.isGun() ? drawStyle(w) : 'trigger';
    // A bow or sling from `f` / scripts: a snap shot, drawn (or whirled) then loosed at once.
    if (w && style !== 'trigger') {
      if (!this.draw && this.cooldown <= 0) this.startDraw(w, style, true);
    } else if (w?.isGun()) this.fire();
    else this.beginSwing();
  }

  // ------------------------------------------------------------------ melee

  /**
   * Monster the weapon's arc meets right now: the one the crosshair ray is on (the camera
   * raycast knows the exact sprite), else combatfeel.sweptArcTarget within `reach` and ±`arc`
   * of the aim, closest to the crosshair first, never through walls.
   */
  meleeTarget(reach = FEEL.reach, arc = FEEL.arcSwing, except?: Monster): Monster | null {
    return this.meleePick(reach, arc, except)?.m ?? null;
  }

  /**
   * What the swing meets, and where. Free aim with drawn 3D models: the swing's fan of rays
   * (aimmodel.swingFan: the crosshair first, then outward across the arc and a vertical band)
   * against the models' part boxes; the first ray that meets a body within reach wins, so in a
   * crowd it's the one under (or nearest) the crosshair, and the part it meets is the zone (a
   * bat to the head). When no ray meets anything, the swept arc below decides as before (so a
   * swing still clips what's beside you, or a zombie crawling at your feet) and the zone is torso.
   */
  meleePick(reach = FEEL.reach, arc = FEEL.arcSwing, except?: Monster): { m: Monster; zone: HitZone } | null {
    const p = this.game.player;
    const v = freeAim() ? aimHooks.view?.() ?? null : null;
    const prep = aimHooks.prepare;
    if (v && prep) {
      const origin = v.third ? v.eye : v.o;
      const basis = v.third ? basisOf(p.yaw, p.pitch) : v;
      const tests: [Monster, (o: Vec3, d: Vec3) => { t: number; zone: HitZone } | null][] = [];
      for (const m of this.sys.active) {
        if (m.dead || m.z !== p.z || m === except) continue;
        if (Math.hypot(m.x - p.x, m.y - p.y) - m.radius > reach + 1) continue;
        if (!hasLOS(this.grid, p.tileX, p.tileY, m.tileX, m.tileY, p.z)) continue;
        const f = prep(m);
        if (f) tests.push([m, f]);
      }
      if (tests.length) {
        for (const off of swingFan(arc)) {
          const d = basisDirection(basis, off.x, off.y);
          let best: { m: Monster; t: number; zone: HitZone } | null = null;
          for (const [m, f] of tests) {
            const r = f(origin, d);
            if (r && (!best || r.t < best.t)) best = { m, t: r.t, zone: r.zone };
          }
          if (!best) continue;
          const hx = origin.x + d.x * best.t, hy = origin.y + d.y * best.t;
          // Nearest body on this ray is out of reach: nothing nearer along it can be hit either.
          if (Math.hypot(hx - p.x, hy - p.y) > reach + 0.3) continue;
          return { m: best.m, zone: best.zone };
        }
      }
    }
    const look = this.game.lookAt?.(reach + 1.5);
    const hit = look?.kind === 'creature' ? (look.creature as { monster?: Monster } | undefined)?.monster : undefined;
    if (hit && hit !== except && !hit.dead && Math.hypot(hit.x - p.x, hit.y - p.y) - hit.radius <= reach) return { m: hit, zone: 'torso' };
    const near = this.sys.active.filter((m) => !m.dead && m.z === p.z && m !== except);
    const m = sweptArcTarget(p, near, reach, arc, (q) => !hasLOS(this.grid, p.tileX, p.tileY, q.tileX, q.tileY, p.z));
    return m ? { m, zone: 'torso' } : null;
  }

  /**
   * One melee blow. Without `phased` (scripts, tests) it picks a target, animates and resolves
   * at once, like before the feel layer. `phased` = seconds since the swing started: the swing
   * clock already runs the animation and cooldown, this only resolves the blow at contact.
   */
  melee(target: Monster | null = null, o: { phased?: number; zone?: HitZone } = {}): boolean {
    const game = this.game;
    const p = game.player;
    const w = p.inv.wielded;
    const phased = o.phased !== undefined;
    const reach = w?.hasFlag('REACH_ATTACK') ? FEEL.reachLong : FEEL.reach;
    const m = target ?? (phased ? null : this.meleeTarget(reach, arcFor(swingStyleOf(w))));
    if (!target && !phased && this.npcMelee?.(reach, m)) return true;
    const ws = weaponSound(w);
    sfx.meleeSwing(undefined, ws);
    if (!m) {
      if (!phased) this.viewmodel()?.attack('melee');
      // First-person players smash windows and doors by hitting them (CDDA's separate smash
      // key X still works). The bash applies its own recovery and messages.
      if (this.smashWorld?.()) {
        this.cooldown = phased ? Math.max(this.cooldown, attackCooldownSeconds(p, w) - o.phased!) : attackCooldownSeconds(p, w);
        return true;
      }
      // Swinging at nothing still costs the swing (and a little stamina).
      const cd = attackCooldownSeconds(p, w);
      this.cooldown = phased ? Math.max(this.cooldown, cd - o.phased!) : cd;
      p.modStamina(-20);
      sfx.meleeWhiff((w?.weight() ?? 0) > 2000);
      // Something in the swing's arc just beyond the weapon's reach: say so (a zombie drawn at
      // arm's length can still be a step too far).
      const near = this.sys.active.filter((q) => !q.dead && q.z === p.z);
      const short = sweptArcTarget(p, near, reach + 1.2, arcFor(swingStyleOf(w)), (q) => !hasLOS(this.grid, p.tileX, p.tileY, q.tileX, q.tileY, p.z));
      const dodged = phased && this.swing?.dodged && !this.swing.dodged.dead ? this.swing.dodged : null;
      this.feedback('melee', 'whiff', null, p.x + Math.sin(p.yaw) * reach, p.y - Math.cos(p.yaw) * reach, 0, 0, dodged ? `${dodged.theName()} dodged` : short ? 'out of reach' : undefined);
      return false;
    }
    const hit = this.swingAt(m, { reach, primary: true, elapsed: o.phased, zone: o.zone });
    return hit;
  }

  /**
   * One swing at monster `m` (Character::melee_attack_abstract): picks a technique, applies its
   * effects (stun, downed, knockback, AoE follow-ups), prints CDDA's technique message.
   * Follow-up AoE swings (`primary: false`) cost no time or stamina, like CDDA.
   */
  swingAt(m: Monster, o: { reach?: number; primary: boolean; elapsed?: number; zone?: HitZone }): boolean {
    const game = this.game;
    const p = game.player;
    const rng = this.sys.rng;
    const ws = weaponSound(p.inv.wielded);
    const reach = o.reach ?? FEEL.reach;
    const stamina = p.stamina;
    // Free aim: the blow that visibly connects lands (a failed hit roll glances); dodges already
    // happened on screen at the wind-up (visibleDodge), so none are rolled here.
    const free = freeAim();
    const perfect = !!(o.primary && o.elapsed !== undefined && this.swing?.perfect);
    // Free aim: where the blow lands (the model part the swing met). BN's melee has no zones;
    // this layer adds them: the head hurts more and rocks it, the legs less but can drop it.
    const zone: HitZone = free && o.primary ? o.zone ?? 'torso' : 'torso';
    const zoneMul = zone === 'head' ? FEEL.aimMeleeHeadMul : zone === 'legs' || zone === 'limb' ? FEEL.aimMeleeLimbMul : 1;
    const res = meleeAttack(p, { dodge: free ? 0 : m.dodge(), armor: m.type.armor, sizeMeleePenalty: m.sizeMeleePenalty(), info: monsterTargetInfo(m) }, rng, m.theName(), {
      allowSpecial: o.primary,
      aoeTargets: (kind) => this.aoeVictims(kind, m, reach).length,
      downable: !m.has('IMMOBILE'),
      autoHit: free ? { glancingMul: FEEL.aimGlancingMul } : undefined,
      damageMul: (perfect ? FEEL.aimPerfectMul : 1) * zoneMul,
    });
    if (o.primary) {
      // Phased: the swing clock already spent `elapsed`; CDDA's cost (stumbles, techniques)
      // can only make the rest longer.
      if (o.elapsed !== undefined) this.cooldown = Math.max(this.cooldown, res.cooldownSeconds - o.elapsed);
      else {
        this.cooldown = res.cooldownSeconds;
        this.viewmodel()?.attack(res.outcome?.aoe ? 'sweep' : 'melee');
      }
    } else p.stamina = stamina;
    // Hostility: animals remember who hit them even on a miss.
    m.aggroCharacter = true;
    if (res.shatter) this.sys.emitSound(p.x, p.y, p.z, 16, 'Crack!', 'player', '');
    if (!res.hit) {
      if (o.primary) sfx.meleeWhiff((p.inv.wielded?.weight() ?? 0) > 2000);
      this.feedback('melee', 'miss', m, m.x, m.y, 0, 0, missReason({ spread: res.hitSpread, dodge: m.dodge() * 5, size: m.sizeMeleePenalty(), stumble: res.stumble }));
      return false;
    }
    let dominant = 'bash', best = 0;
    for (const d of res.damage) if (d.amount > best) (best = d.amount), (dominant = d.type);
    const phrase = (res.technique && techniqueMessage(res.technique, m.theName())) || `You ${meleeVerb(dominant, res.total, (a, b) => rng.int(a, b))} ${m.theName()}`;
    game.message(hitMessage(phrase, res.total, res.crit), res.total > 0 ? undefined : 'c_light_gray');
    sfx.meleeHit(m.type.material[0] ?? 'flesh', m, ws);
    this.sys.emitSound(m.x, m.y, m.z, 8, 'Smack!', 'player', '');
    // Victims of a sweep are chosen before the blow can push the target out of the arc.
    const victims = res.outcome?.aoe ? this.aoeVictims(res.outcome.aoe, m, reach) : [];
    const wskill = p.getSkill(p.inv.wielded ? p.inv.wielded.meleeSkill() : 'unarmed');
    this.sys.hurt(m, res.total, 'player', { crit: res.crit || zone === 'head', stagger: free ? 1 + FEEL.aimStaggerPerSkill * (wskill + p.getSkill('melee')) / 2 + (perfect ? 0.3 : 0) + (zone === 'head' ? 0.5 : 0) : undefined });
    const zoneFx = free && res.total > 0 && !m.dead ? this.meleeZoneEffect(m, zone, wskill) : '';
    // Hit-stop: the hands, the swing clock and the struck monster hold for a few frames.
    let stop = 0;
    if (o.primary && o.elapsed !== undefined) {
      stop = m.dead ? FEEL.hitStopMax : hitStopSeconds(res.total, m.hpMax, res.crit);
      this.hitStop = Math.max(this.hitStop, stop);
      this.viewmodel()?.impact?.(stop);
      m.busy = Math.max(m.busy, stop);
    }
    // Before the technique can knock it away: the impact is where it stood when struck.
    this.feedback('melee', res.crit ? 'crit' : 'hit', m, m.x, m.y, res.total, stop, res.total <= 0 ? 'no damage' : free ? this.meleeQuality(res.glancing, res.crit, perfect, wskill, zone, zoneFx) : undefined,
      free ? { quality: (res.glancing ? FEEL.aimGlancingMul : perfect ? FEEL.aimPerfectMul : res.crit ? 1.5 : 1) * zoneMul } : {});
    if (m.dead) triggerBuffs(p, 'onkill');
    else if (res.outcome) applyTechniqueToMonster(m, res.outcome, p.x, p.y, rng);
    if (victims.length) {
      for (const v of victims) if (!v.dead) this.swingAt(v, { reach, primary: false });
      game.message(`${victims.length} ${victims.length === 1 ? 'enemy' : 'enemies'} hit!`, 'c_light_green');
    }
    return true;
  }

  /** Free aim: why a connecting blow was weak or strong, for the crosshair. */
  private meleeQuality(glancing: boolean | undefined, crit: boolean, perfect: boolean, skill: number, zone: HitZone = 'torso', fx = ''): string | undefined {
    const parts: string[] = [];
    const w = this.game.player.inv.wielded;
    if (zone === 'head') parts.push(`HEAD ×${FEEL.aimMeleeHeadMul}`);
    else if (zone === 'legs') parts.push(`legs ×${FEEL.aimMeleeLimbMul}`);
    else if (zone === 'limb') parts.push(`limb ×${FEEL.aimMeleeLimbMul}`);
    if (fx) parts.push(fx);
    if (glancing) parts.push(`glancing ×${FEEL.aimGlancingMul} (${w ? w.meleeSkill() : 'unarmed'} ${Math.floor(skill)})`);
    if (crit) parts.push('critical');
    if (perfect) parts.push(`on the beat ×${FEEL.aimPerfectMul}`);
    return parts.length ? parts.join(' · ') : undefined;
  }

  /**
   * A blow's zone effect (free aim): a head blow with a blunt or heavy weapon can stun; a leg
   * blow makes it stumble (a longer flinch) and can knock it down. Chances grow with the weapon
   * skill; huge monsters and immobile ones don't go down. Returns the crosshair word, if any.
   */
  private meleeZoneEffect(m: Monster, zone: HitZone, skill: number): string {
    const rng = this.sys.rng;
    const w = this.game.player.inv.wielded;
    const blunt = !w || w.meleeSkill() === 'bashing' || (w.weight() ?? 0) >= 1500;
    if (zone === 'head' && blunt && rng.next() < 0.3 + 0.04 * skill) {
      m.addEffect('stunned', 0.6 + 0.05 * skill);
      return 'stunned';
    }
    if (zone === 'legs') {
      m.flinch = Math.max(m.flinch, 0.5);
      if (!m.has('IMMOBILE') && m.size !== 'huge' && rng.next() < 0.2 + 0.04 * skill) {
        m.addEffect('downed', 1.2);
        return 'knocked down';
      }
      return 'stumbles';
    }
    return '';
  }

  /**
   * Tell hit-feedback listeners (particles, stagger, crosshair marker) how an attack went.
   * The impact point is the near side of the target (what the camera sees get hit).
   */
  private feedback(kind: 'melee' | 'gun' | 'throw', outcome: 'hit' | 'crit' | 'miss' | 'whiff', m: Monster | null, x: number, y: number, damage: number, hitStop = 0, reason?: string, extra: { ranged?: RangedClass; landed?: boolean; quality?: number } = {}): void {
    const p = this.game.player;
    if (m) {
      const d = Math.hypot(m.x - p.x, m.y - p.y) || 1;
      x = m.x - ((m.x - p.x) / d) * m.radius * 0.8;
      y = m.y - ((m.y - p.y) / d) * m.radius * 0.8;
    }
    const final = m?.dead ? 'kill' : outcome !== 'miss' && outcome !== 'whiff' && damage <= 0 ? 'block' : outcome;
    this.game.events.emit('playerAttack', {
      kind, outcome: final, x, y, z: p.z, damage, target: m ?? undefined,
      // A hit that takes a third of its health (or a crit that hurts) visibly rocks the target.
      heavy: !!m && damage > 0 && (damage >= m.hpMax * 0.3 || outcome === 'crit' || damage >= 20),
      blood: m ? this.sys.bloodType(m.type) : undefined,
      hitStop,
      reason,
      ...extra,
    });
  }

  /**
   * Character::valid_aoe_technique for a real-time arena: "wide" hits the enemies beside the
   * target (one each side, 20°–110° off the swing), "spin" everything in reach (needs 2+),
   * "impale" one enemy right behind the target.
   */
  aoeVictims(kind: string, target: Monster, reach = FEEL.reach): Monster[] {
    const p = this.game.player;
    const dir = Math.atan2(target.x - p.x, -(target.y - p.y));
    const near = this.sys.monstersNear(p.x, p.y, p.z, reach + 0.6).filter((o) => o !== target && !o.dead && !o.friendly && Math.hypot(o.x - p.x, o.y - p.y) - o.radius <= reach);
    if (kind === 'wide') {
      const side = (sgn: number) => near
        .filter((o) => {
          const a = signedAngle(Math.atan2(o.x - p.x, -(o.y - p.y)), dir) * sgn;
          return a >= (20 * Math.PI) / 180 && a <= (110 * Math.PI) / 180;
        })
        .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
      return [side(1), side(-1)].filter((o): o is Monster => !!o);
    }
    if (kind === 'spin') return near.length >= 2 ? near : [];
    if (kind === 'impale') {
      const dT = Math.hypot(target.x - p.x, target.y - p.y);
      const behind = this.sys.monstersNear(target.x, target.y, p.z, 1.3).filter((o) => o !== target && !o.dead && !o.friendly
        && Math.hypot(o.x - p.x, o.y - p.y) > dT && angleDiff(Math.atan2(o.x - p.x, -(o.y - p.y)), dir) < (35 * Math.PI) / 180);
      return behind.length ? [this.sys.rng.pick(behind)] : [];
    }
    return [];
  }

  // ------------------------------------------------------------------ guns

  /** Walk a ray from the player; first monster circle or blocking wall ends it. */
  castRay(yaw: number, range: number, skip?: (m: Monster) => boolean): { x: number; y: number; hit: Monster | null; missedBy: number } {
    const p = this.game.player;
    const dx = Math.sin(yaw), dy = -Math.cos(yaw);
    let best: Monster | null = null, bestT = range, missedBy = 1;
    for (const m of this.sys.active) {
      if (m.dead || m.z !== p.z || skip?.(m)) continue;
      const ox = m.x - p.x, oy = m.y - p.y;
      const t = ox * dx + oy * dy;
      if (t <= 0 || t > bestT) continue;
      const perp = Math.abs(ox * dy - oy * dx);
      if (perp > m.radius) continue;
      best = m;
      bestT = t;
      missedBy = perp / m.radius;
    }
    // Walls stop bullets (windows and other see-through tiles let them through).
    const step = 0.1;
    let tx = p.tileX, ty = p.tileY;
    for (let t = 0; t <= bestT; t += step) {
      const x = Math.floor(p.x + dx * t), y = Math.floor(p.y + dy * t);
      if (x === tx && y === ty) continue;
      tx = x;
      ty = y;
      if (!this.grid.passable(x, y, p.z) && this.grid.opaque(x, y, p.z)) {
        return { x: p.x + dx * t, y: p.y + dy * t, hit: null, missedBy: 1 };
      }
    }
    return { x: p.x + dx * bestT, y: p.y + dy * bestT, hit: best, missedBy };
  }

  /**
   * Pull the trigger (Character::fire_gun): fires the current fire mode's shot count. The
   * first round goes now; the rest of a burst follow BURST_INTERVAL apart (update()), each
   * with the recoil of the ones before it; recoil absorbed by skill lands when the burst ends.
   */
  fire(): boolean {
    const game = this.game;
    const p = game.player;
    const gun = p.inv.wielded;
    if (!gun?.isGun()) {
      game.message("You're not wielding a gun.");
      return false;
    }
    if (this.burst) return false;
    const mode = currentMode(gun);
    const n = Math.max(1, Math.min(mode.qty, gun.ammoRemaining() || 1));
    const shot = this.fireOne(gun, n > 1);
    if (!shot) return false;
    if (n > 1) this.burst = { gun, left: n - 1, timer: BURST_INTERVAL, delay: shot.delayedRecoil ?? 0, cooldown: shot.cooldownSeconds };
    else applyDelayedRecoil(p, shot.delayedRecoil ?? 0);
    // The trigger can't be pulled again until the whole burst is out.
    this.cooldown = shot.cooldownSeconds + (n - 1) * BURST_INTERVAL;
    return true;
  }

  /** One round of a trigger pull; null when the gun didn't fire (empty, jammed…). */
  fireOne(gun: Item, burst: boolean): ShotResult | null {
    const game = this.game;
    const p = game.player;
    const rng = this.sys.rng;
    const cls = rangedClass(gun);
    const flies = fliesVisibly(cls);
    // What made this shot wide, source by source, before the shot's own recoil lands.
    const spread = dispersionBreakdown(p, gun);
    const ammo = gun.ammoData() ?? null;
    const shot = fireGun(p, gun, rng, { burst, recover: flies });
    if (!shot.ok) {
      if (!canDraw(gun, p)) this.refuse(`too weak to draw this ${cls === 'bow' ? 'bow' : 'weapon'} (Str ${strNeeded(gun)} needed)`);
      else if (gun.ammoRemaining() <= 0) this.refuse(flies ? `no ${cls === 'bow' ? 'arrows' : cls === 'crossbow' ? 'bolt loaded: press r' : 'stones'}` : 'empty: press r to reload');
      // A dry click is a firearm thing; an empty bow is just silent.
      if (!flies) sfx.gunEmpty();
      this.cooldown = 0.25;
      return null;
    }
    this.shots++;
    this.lastShotClass = cls;
    if (hasMuzzleFlash(cls)) this.flashShots++;
    // Kick scaled by the round's recoil (MOA added; ~150-250 for a 9 mm pistol), and by what
    // kind of launcher it is: a bow barely moves on release.
    const kick = Math.max(0.4, Math.min(2.5, (shot.addedRecoil ?? 200) / 200)) * kickScale(cls);
    const vm = this.viewmodel();
    if (vm?.recoil) vm.recoil(kick, { flash: hasMuzzleFlash(cls), cls });
    else vm?.attack('fire');
    this.onFire?.(kick, cls);
    sfx.rangedShot(cls, gun.typeId, undefined, { ammoType: typeof ammo?.ammo_type === 'string' ? ammo.ammo_type : undefined, loudness: shot.noise.volume });
    // CDDA make_gun_sound_effect: silent weapons make no sound at all.
    if (shot.noise.volume > 0) this.sys.emitSound(p.x, p.y, p.z, shot.noise.volume, shot.noise.sound || 'Bang!', 'player', '');
    const range = Math.max(1, shot.range || 30);
    if (freeAim()) return this.fireFree(gun, cls, shot, ammo ?? undefined, range, spread);
    // Dispersion becomes a sideways offset (the vertical part of the cone can't miss a sprite
    // that already fills the crosshair's column, so only the horizontal component matters).
    const yaw = p.yaw + shot.spread * Math.cos(shot.azimuth);
    // What the survivor meant to hit: the crosshair's creature, else the one closest to it.
    const meant = this.rangedTarget(range * 1.6);
    if (flies) {
      this.launch(gun, cls, shot, ammo ?? undefined, yaw, range, meant, spread);
      return shot;
    }
    const hit = this.castRay(yaw, range);
    const npcHit = this.npcShot?.(yaw, Math.hypot(hit.x - p.x, hit.y - p.y), shot);
    if (npcHit) {
      this.tracers.push({ x0: p.x, y0: p.y, x1: npcHit.x, y1: npcHit.y, z: p.z, t: 0.08 });
      return shot;
    }
    const pellets = shot.pellets ?? 1;
    // Shotguns: point-blank the whole load hits as one; farther out each pellet flies on its
    // own line off the aim (ballistics.cpp shot_spread) for shot_damage each.
    const pointBlank = hit.hit && Math.hypot(hit.hit.x - p.x, hit.hit.y - p.y) <= 1.6;
    if (pellets <= 1 || pointBlank || !shot.shotDamage) {
      this.tracers.push({ x0: p.x, y0: p.y, x1: hit.x, y1: hit.y, z: p.z, t: 0.08 });
      const why = meant && hit.hit !== meant.m ? this.hitscanMissWhy(hit, meant, range, spread, gun, cls) : undefined;
      this.impact(hit, shot, shot.damage, true, why, cls);
      return shot;
    }
    const perMonster = new Map<Monster, { n: number; total: number }>();
    for (let i = 0; i < pellets; i++) {
      const py = yaw + pelletAngle(shot.shotSpreadMoa ?? 0, rng);
      const h = this.castRay(py, range);
      if (i < 12) this.tracers.push({ x0: p.x, y0: p.y, x1: h.x, y1: h.y, z: p.z, t: 0.06 });
      if (!h.hit) continue;
      const units = shot.shotDamage.map((d) => ({ type: d.type, amount: d.amount, armor_penetration: d.armor_penetration, armor_multiplier: 1 }));
      const dmg = applyFlatArmor(units, h.hit.type.armor).reduce((s, d) => s + d.amount, 0);
      const e = perMonster.get(h.hit) ?? { n: 0, total: 0 };
      e.n++;
      e.total += dmg;
      perMonster.set(h.hit, e);
    }
    if (!perMonster.size) {
      sfx.bulletHit('wall', { x: hit.x, y: hit.y, z: p.z });
      const reason = meant ? this.hitscanMissWhy(hit, meant, range, spread, gun, cls) : undefined;
      game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: hit.x, y: hit.y, z: p.z, damage: 0, heavy: false, blood: null, reason, ranged: cls, landed: true });
    }
    for (const [m, e] of perMonster) {
      if (m.dead) continue;
      m.aggroCharacter = true;
      const total = Math.floor(e.total);
      // projectile.cpp multi_projectile_hit_message.
      const count = e.n === 1 ? 'a' : e.n <= 2 ? 'several' : e.n <= 5 ? 'many' : e.n <= 20 ? 'a large number of' : 'a huge number of';
      game.message(`${m.TheName()} is hit by ${count} ${e.n === 1 ? 'projectile' : 'projectiles'}, ${total > 0 ? `dealing ${total} damage` : 'but they deal no damage'}.`);
      sfx.bulletHit('flesh', m);
      this.sys.hurt(m, total, 'player');
      this.feedback('gun', 'hit', m, m.x, m.y, total);
      this.ammoEffectsAt(shot, m.x, m.y, m, total);
    }
    return shot;
  }

  /**
   * Free aim (aimmodel.ts): the round leaves along the reticle the player saw — no dispersion
   * roll — then kicks the aim by the round's recoil. Hitscan rounds resolve at once against the
   * body the ray enters (freeHit); arrows, bolts and stones fly along it (launch). Shotgun pellets
   * still spread around the aim point: that cone is the weapon's, not the shooter's.
   */
  private fireFree(gun: Item, cls: RangedClass, shot: ShotResult, ammo: ItemDef | undefined, range: number, spread: DispersionBreakdown): ShotResult {
    const game = this.game;
    const p = game.player;
    const rng = this.sys.rng;
    const off = this.aim.shotOffset(this.nowMs());
    const ray = this.aimRay(off, range);
    const dir = { yaw: ray.yaw, pitch: ray.pitch };
    this.aim.kick((shot.addedRecoil ?? 0) * kickScale(cls), rng.next() * 2 - 1);
    // Timing: a breath held into its steady flash, or a perfect active reload banked for this shot.
    const skill = this.aimSkill(gun);
    const perfect = timingGames() && (this.breath.perfect(skill) || this.perfectNext);
    this.perfectNext = false;
    if (fliesVisibly(cls)) {
      const meant = this.rangedTarget(range * 1.6);
      const along = this.castAim(dir.yaw, dir.pitch, range * 1.6, undefined, ray.o);
      this.launch(gun, cls, shot, ammo, dir.yaw, range, meant, spread, { pitch: dir.pitch, eye: ray.o.h - p.z * LEVEL_HEIGHT, aimDist: along.hit ? Math.hypot(along.hit.x - p.x, along.hit.y - p.y) : along.dist, perfect });
      return shot;
    }
    const pellets = shot.pellets ?? 1;
    const hit = this.castAim(dir.yaw, dir.pitch, range, undefined, ray.o);
    const npcHit = this.npcShot?.(dir.yaw, hit.dist, shot);
    if (npcHit) {
      this.tracers.push({ x0: p.x, y0: p.y, x1: npcHit.x, y1: npcHit.y, z: p.z, t: 0.08 });
      return shot;
    }
    const pointBlank = hit.hit && hit.dist <= 1.6;
    if (pellets <= 1 || pointBlank || !shot.shotDamage) {
      this.tracers.push({ x0: p.x, y0: p.y, x1: hit.x, y1: hit.y, z: p.z, t: 0.08 });
      if (hit.hit) {
        const r = this.freeHit(hit.hit, shot.damage, { zone: hit.zone, missedBy: hit.missedBy, perfect, cls, gun });
        sfx.bulletHit('flesh', hit.hit);
        this.ammoEffectsAt(shot, hit.hit.x, hit.hit.y, hit.hit, r.total);
      } else {
        sfx.bulletHit('wall', { x: hit.x, y: hit.y, z: p.z });
        game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: hit.x, y: hit.y, z: p.z, damage: 0, heavy: false, blood: null, reason: this.freeMissWhy(hit, range), ranged: cls, landed: hit.stop !== 'range' });
        this.ammoEffectsAt(shot, hit.x, hit.y, null, 0);
      }
      return shot;
    }
    // Pellets: each on its own line off the aim point (ballistics.cpp shot_spread), in any direction.
    const perMonster = new Map<Monster, { n: number; total: number; head: number }>();
    const q = hitDamageMul({ zone: 'torso', graze: false, weakSpot: false, perfect, skill });
    for (let i = 0; i < pellets; i++) {
      const a = pelletAngle(shot.shotSpreadMoa ?? 0, rng), phi = rng.next() * Math.PI * 2;
      const d2 = aimDirection(dir.yaw, dir.pitch, a * Math.cos(phi), a * Math.sin(phi));
      const h = this.castAim(d2.yaw, d2.pitch, range, undefined, ray.o);
      if (i < 12) this.tracers.push({ x0: p.x, y0: p.y, x1: h.x, y1: h.y, z: p.z, t: 0.06 });
      if (!h.hit) continue;
      const zoneMul = h.zone === 'head' ? FEEL.aimHeadMul : h.zone === 'legs' ? FEEL.aimLegMul : 1;
      const units = shot.shotDamage.map((d) => ({ type: d.type, amount: d.amount * q.mul * zoneMul, armor_penetration: d.armor_penetration, armor_multiplier: 1 }));
      const dmg = applyFlatArmor(units, h.hit.type.armor).reduce((s, d) => s + d.amount, 0);
      const e = perMonster.get(h.hit) ?? { n: 0, total: 0, head: 0 };
      e.n++;
      e.total += dmg;
      if (h.zone === 'head') e.head++;
      perMonster.set(h.hit, e);
    }
    if (!perMonster.size) {
      sfx.bulletHit('wall', { x: hit.x, y: hit.y, z: p.z });
      game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: hit.x, y: hit.y, z: p.z, damage: 0, heavy: false, blood: null, reason: this.freeMissWhy(hit, range), ranged: cls, landed: true });
    }
    for (const [m, e] of perMonster) {
      if (m.dead) continue;
      m.aggroCharacter = true;
      const total = Math.floor(e.total);
      const count = e.n === 1 ? 'a' : e.n <= 2 ? 'several' : e.n <= 5 ? 'many' : e.n <= 20 ? 'a large number of' : 'a huge number of';
      game.message(`${m.TheName()} is hit by ${count} ${e.n === 1 ? 'projectile' : 'projectiles'}, ${total > 0 ? `dealing ${total} damage` : 'but they deal no damage'}.`);
      sfx.bulletHit('flesh', m);
      const text = [`${e.n}/${pellets} pellets`, e.head ? `${e.head} in the head` : '', describeHit({ mul: q.mul, parts: q.parts })].filter(Boolean).join(' · ');
      this.lastHit = { zone: e.head ? 'head' : 'torso', mul: q.mul, text, perfect };
      this.sys.hurt(m, total, 'player', { crit: e.head > 0, stagger: 1 + FEEL.aimStaggerPerSkill * skill });
      this.feedback('gun', e.head ? 'crit' : 'hit', m, m.x, m.y, total, 0, total > 0 ? text : 'no damage', { ranged: cls, quality: q.mul });
      this.ammoEffectsAt(shot, m.x, m.y, m, total);
    }
    return shot;
  }

  /**
   * Free aim: a miss says nothing when you could see it go wide (you aimed there); only the
   * physical reasons you might not see are named — cover in the way, out of range, into the floor.
   */
  private freeMissWhy(hit: AimHit, range: number): string | undefined {
    const meant = this.rangedTarget(range * 1.6);
    if (!meant) return undefined;
    if (hit.stop === 'wall' && hit.dist < meant.dist - meant.m.radius) return 'blocked by cover';
    if (hit.stop === 'floor' && hit.dist < meant.dist - meant.m.radius) return 'low: hit the ground short of it';
    if (hit.stop === 'range' && meant.dist - meant.m.radius > range) return `fell short: out of range (${Math.round(range)} m)`;
    return undefined;
  }

  /** A single projectile's impact: CDDA damage bands on a monster, or a wall. */
  private impact(hit: { x: number; y: number; hit: Monster | null; missedBy: number }, shot: ShotResult, damage: ShotResult['damage'], primary: boolean, why?: string, cls: RangedClass = 'firearm'): void {
    const game = this.game;
    const p = game.player;
    const rng = this.sys.rng;
    if (!hit.hit) {
      sfx.bulletHit('wall', { x: hit.x, y: hit.y, z: p.z });
      this.game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: hit.x, y: hit.y, z: p.z, damage: 0, heavy: false, blood: null, reason: why, ranged: cls, landed: true });
      if (primary) this.ammoEffectsAt(shot, hit.x, hit.y, null, 0);
      return;
    }
    const m = hit.hit;
    m.aggroCharacter = true;
    // BN Creature::deal_projectile_attack (src/game/projectile.ts): severity multiplier and
    // hit location from how well the round landed and how steady the shooter is.
    const gun = p.inv.wielded;
    const skill = gun?.def.skill ? p.getSkill(String(gun.def.skill)) : 0;
    const r = projectileHit(
      { dodgeRoll: m.dodge() * 5, isCharacter: false, flags: m.type.flags },
      { missedBy: hit.missedBy, shooter: { dex: p.dex, per: p.per, skill, steadiness: Math.max(1, p.stamina) / Math.max(1, p.staminaMax()), isPlayer: true } },
      rng,
    );
    if (!r.hit) {
      game.message(`${m.TheName()} avoids your projectile.`);
      this.feedback('gun', 'miss', m, m.x, m.y, 0, 0, 'dodged', { ranged: cls });
      if (primary) this.ammoEffectsAt(shot, hit.x, hit.y, null, 0);
      return;
    }
    // Grazes multiply before armor; other hits scale the armor reduction too (damage_multiplier).
    const units = damage.map((d) => ({ type: d.type, amount: d.amount * r.severity, armor_penetration: d.armor_penetration, armor_multiplier: 1, multiplier: r.graze ? 1 : r.severity }));
    const total = Math.floor(applyFlatArmor(units, m.type.armor).reduce((s, d) => s + d.amount, 0));
    if (r.tag) game.message(r.tag, 'c_light_green');
    game.message(total > 0 ? `You hit ${m.theName()} for ${total} damage.` : `The shot reflects off ${m.theName()}'s ${m.type.material.length ? 'armor' : 'skin'}!`);
    if (r.headshot) this.game.events.emit('playerHeadshot', { target: m });
    sfx.bulletHit('flesh', m);
    this.sys.hurt(m, total, 'player');
    this.feedback('gun', r.tag === 'Critical!' ? 'crit' : 'hit', m, m.x, m.y, total, 0, total <= 0 ? 'no damage' : r.graze ? 'grazed' : undefined, { ranged: cls });
    if (primary) this.ammoEffectsAt(shot, m.x, m.y, m, total);
  }

  /** Why a hitscan round missed the creature it was aimed at (the crosshair line). */
  private hitscanMissWhy(hit: { x: number; y: number; hit: Monster | null }, meant: { m: Monster; dist: number }, range: number, spread: DispersionBreakdown, gun: Item, cls: RangedClass): string | undefined {
    const p = this.game.player;
    if (hit.hit) return undefined; // it hit something else on the way
    const reached = Math.hypot(hit.x - p.x, hit.y - p.y);
    let kind: RangedMissKind = 'passed';
    if (reached < meant.dist - meant.m.radius && reached < range - 0.2) kind = 'wall';
    else if (range < meant.dist - meant.m.radius) kind = 'range';
    return this.missWhy(kind, meant, range, spread, gun, cls);
  }

  private missWhy(kind: RangedMissKind, meant: { m: Monster; dist: number }, range: number, spread: DispersionBreakdown, gun: Item, cls: RangedClass): string {
    const p = this.game.player;
    const skill = String(gun.def.skill ?? 'gun');
    return rangedMissReason({
      kind, spread, distance: meant.dist, targetRadius: meant.m.radius, skill: skillName(skill), skillLevel: p.getSkill(skill),
      style: cls === 'bow' ? 'draw' : drawStyle(gun), range, strNeeded: strNeeded(gun),
    });
  }

  /** The survivor couldn't attack: say why at the crosshair (and once in the log). */
  private refuse(reason: string): void {
    this.game.events.emit('attackRefused', { reason });
  }

  /**
   * The creature the survivor is shooting at: the one under the crosshair, else the closest to
   * it within a few degrees (and its angular size), in sight, within `maxDist`.
   */
  rangedTarget(maxDist: number): { m: Monster; dist: number } | null {
    const p = this.game.player;
    const look = this.game.lookAt?.(maxDist);
    const hit = look?.kind === 'creature' ? (look.creature as { monster?: Monster } | undefined)?.monster : undefined;
    if (hit && !hit.dead && !hit.friendly) return { m: hit, dist: Math.hypot(hit.x - p.x, hit.y - p.y) };
    let best: Monster | null = null, bestScore = Infinity, bestD = 0;
    for (const m of this.sys.active) {
      if (m.dead || m.friendly || m.z !== p.z) continue;
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      if (d > maxDist || d < 0.3) continue;
      const off = angleDiff(Math.atan2(m.x - p.x, -(m.y - p.y)), p.yaw);
      const half = Math.atan2(m.radius, d);
      if (off > half + 0.06) continue;
      if (!hasLOS(this.grid, p.tileX, p.tileY, m.tileX, m.tileY, p.z)) continue;
      const score = off - half;
      if (score < bestScore) {
        bestScore = score;
        best = m;
        bestD = d;
      }
    }
    return best ? { m: best, dist: bestD } : null;
  }

  // ------------------------------------------------------------------ bows and slings: draw, loose, flight

  /**
   * RMB draws (a bow) or whirls (a sling); aim builds only at full draw while RMB is held, and
   * costs stamina; held too long the arms shake and the aim drifts back. LMB looses — at once if
   * fully drawn, else as soon as the draw completes (so a plain click is a snap shot). Letting go
   * of RMB without loosing lets the string down (the arrow stays nocked).
   */
  private updateDraw(gun: Item, style: Exclude<DrawStyle, 'trigger'>, click: boolean, rmb: boolean, dt: number): void {
    const p = this.game.player;
    let d = this.draw;
    if (d && d.gun !== gun) {
      this.cancelDraw();
      d = null;
    }
    if (!d) {
      if ((click || rmb) && this.cooldown <= 0 && !this.burst) this.startDraw(gun, style, click);
      return;
    }
    if (click) d.release = true;
    d.t += dt;
    if (!rmb && !d.release) {
      this.cancelDraw();
      return;
    }
    if (d.t < d.full) return;
    d.heldFull += dt;
    if (rmb) aim(p, gun, dt * ACTION_SCALE * 100);
    if (style === 'draw') {
      p.modStamina(-FEEL.drawStaminaPerSec * dt);
      // Tired arms: past the steady window (or winded) the aim drifts back open.
      if (d.heldFull > FEEL.drawHoldSteady || p.stamina < p.staminaMax() * 0.1) p.recoil = Math.min(MAX_RECOIL, p.recoil + FEEL.drawShake * dt);
    }
    if (d.release) this.loose();
  }

  /** Nock (RELOAD_AND_SHOOT takes an arrow from what you carry) and start drawing; null if you can't. */
  startDraw(gun: Item, style: Exclude<DrawStyle, 'trigger'>, release: boolean): DrawState | null {
    const game = this.game;
    const p = game.player;
    const cls = rangedClass(gun);
    if (!canDraw(gun, p)) {
      const need = strNeeded(gun);
      game.message(`You don't have enough strength to draw your ${gun.baseName()} (Str ${need} needed, you have ${p.str}).`, 'c_light_red');
      this.refuse(`too weak to draw this ${cls === 'bow' ? 'bow' : 'weapon'} (Str ${need} needed)`);
      this.cooldown = 0.6;
      return null;
    }
    if (gun.ammoRemaining() <= 0 && gun.hasFlag('RELOAD_AND_SHOOT')) {
      const s = p.onMessage;
      p.onMessage = null;
      try {
        p.inv.reload(gun);
      } finally {
        p.onMessage = s;
      }
    }
    if (gun.ammoRemaining() <= 0) {
      const what = asArray(gun.ammoTypes()).includes('arrow') ? 'arrows' : cls === 'sling' ? 'stones' : 'ammunition';
      game.message(`You have no ${what} for your ${gun.baseName()}.`, 'c_light_red');
      this.refuse(`no ${what}`);
      this.cooldown = 0.6;
      return null;
    }
    const full = drawSeconds(gun, p, FEEL.drawMin) + (style === 'whirl' ? FEEL.slingWhirl : 0);
    this.draw = { gun, style, t: 0, full, release, heldFull: 0 };
    if (style === 'whirl') {
      this.whirl?.stop(0.05);
      this.whirl = sfx.slingWhirl();
    } else sfx.bowDraw(strNeeded(gun) >= 10);
    return this.draw;
  }

  /** Let the string down / stop whirling without shooting. */
  cancelDraw(): void {
    this.draw = null;
    this.whirl?.stop(0.08);
    this.whirl = null;
  }

  private loose(): void {
    const d = this.draw;
    // Timing: loosed as the closing ring met the reticle (aimmodel.bowWindow).
    if (d && timingGames() && d.style === 'draw' && d.t >= d.full && bowPerfect(d.heldFull, this.aimSkill(d.gun))) this.perfectNext = true;
    this.draw = null;
    this.whirl?.stop(0.05);
    this.whirl = null;
    this.fire();
  }

  /**
   * What the viewmodel shows for a drawn/whirled weapon: draw 0..1, whether an arrow sits on the
   * string (loaded, being drawn, or one to nock from what you carry), arm shake 0..1.
   */
  bowPose(): { style: DrawStyle; cls: RangedClass; draw: number; nocked: boolean; shake: number; whirl: number } | null {
    const p = this.game.player;
    const gun = p.inv.wielded;
    if (!gun?.isGun()) return null;
    const style = drawStyle(gun);
    if (style === 'trigger') return null;
    const d = this.draw;
    const c = this.ammoCache;
    if (c.gun !== gun || this.time - c.t > 0.5) {
      c.gun = gun;
      c.t = this.time;
      c.has = gun.ammoRemaining() > 0 || p.inv.allItems().some((it) => it.isAmmo() && it.charges > 0 && gun.acceptsAmmo(it));
    }
    const nocked = !!d || gun.ammoRemaining() > 0 || (c.has && this.cooldown <= 0.12);
    const draw = d ? Math.min(1, d.t / d.full) : 0;
    const shake = d && d.style === 'draw' && draw >= 1 ? Math.max(0, Math.min(1, (d.heldFull - FEEL.drawHoldSteady) / 2)) : 0;
    return { style, cls: rangedClass(gun), draw, nocked, shake, whirl: d && d.style === 'whirl' ? d.t : 0 };
  }

  /** Release a visible projectile (see Flight). */
  private launch(
    gun: Item, cls: RangedClass, shot: ShotResult, ammo: ItemDef | undefined, yaw: number, range: number, meant: { m: Monster; dist: number } | null, spread: DispersionBreakdown,
    free?: { pitch: number; aimDist: number; perfect: boolean; eye?: number },
  ): void {
    const p = this.game.player;
    const speed = flightSpeed(cls, Number(ammo?.speed) || 100);
    // Free aim: from where the shot ray starts (the drawn eye, which rides the ground relief the
    // drawn bodies stand on), so the arc and the models share one space.
    const eye = free?.eye ?? (p.crouching ? 1.0 : 1.6);
    // The arc meets the crosshair where the survivor aimed: the target, else where the view ray
    // reaches the ground or a wall, never past the range. Free aim: where the reticle's ray ends.
    let aimDist = range;
    if (free) aimDist = free.aimDist;
    else if (meant) aimDist = meant.dist;
    else {
      const look = this.game.lookAt?.(range * 1.5);
      if (look) aimDist = Math.hypot(look.point.x - p.x, look.point.y - p.y);
      if (p.pitch < -0.01) aimDist = Math.min(aimDist, eye / Math.tan(-p.pitch));
    }
    aimDist = Math.max(1, Math.min(range, aimDist));
    const dx = Math.sin(yaw), dy = -Math.cos(yaw);
    const arc = { eye, slope: Math.tan(free ? free.pitch : p.pitch), aimDist, speed };
    this.flights.push({
      x0: p.x, y0: p.y, z: p.z, dx, dy, yaw, s: 0, x: p.x, y: p.y, h: eye - LAUNCH_DROP, speed, range, arc, cls, gun, ammo, shot,
      round: shot.round ?? null, intended: meant?.m ?? null, intendedDist: meant?.dist ?? 0, spread,
      passed: new Set(), overflew: new Set(), explained: false, done: false, free: !!free, perfect: free?.perfect ?? false,
    });
  }

  private updateFlights(dt: number): void {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      this.stepFlight(f, dt);
      if (f.done) this.flights.splice(i, 1);
    }
  }

  private placeFlight(f: Flight, s: number): void {
    f.s = s;
    f.x = f.x0 + f.dx * s;
    f.y = f.y0 + f.dy * s;
    f.h = arcHeight(s, f.arc);
  }

  /** Advance one flight by dt: the first of a monster, a wall or the ground on the way ends (or dodges) it. */
  stepFlight(f: Flight, dt: number): void {
    const s0 = f.s;
    const maxS = f.range * 1.6 + 2;
    const s1 = Math.min(maxS, s0 + f.speed * dt);
    let ground = s1 >= maxS ? maxS : Infinity;
    for (let s = s0 + 0.2; s < s1 + 0.2; s += 0.2) {
      const q = Math.min(s, s1);
      if (arcHeight(q, f.arc) <= 0.02) {
        ground = q;
        break;
      }
    }
    const end = Math.min(s1, ground);
    const wall = this.wallAlong(f, s0, end);
    let hitM: Monster | null = null, hitS = Infinity, hitPerp = 0, hitZone: HitZone | undefined;
    const pick = f.free ? aimHooks.pick : null;
    // This step of the arc as a straight segment (≤ 2 m), for the exact test against drawn models.
    const segH = arcHeight(s0, f.arc), segSlope = (arcHeight(end, f.arc) - segH) / Math.max(1e-3, end - s0);
    const segN = Math.hypot(1, segSlope);
    const segO: Vec3 = { x: f.x0 + f.dx * s0, y: f.y0 + f.dy * s0, h: f.z * LEVEL_HEIGHT + segH };
    const segD: Vec3 = { x: f.dx / segN, y: f.dy / segN, h: segSlope / segN };
    for (const m of this.sys.active) {
      if (m.dead || m.z !== f.z || f.passed.has(m)) continue;
      const ox = m.x - f.x0, oy = m.y - f.y0;
      const t = ox * f.dx + oy * f.dy;
      if (pick) {
        const reach = Math.max(m.radius * 2.5, 1);
        if (t + reach > s0 && t - reach <= end && Math.abs(ox * f.dy - oy * f.dx) <= reach) {
          const r = pick(m, segO, segD);
          if (r === null) continue;
          if (r) {
            const sh = s0 + r.t / segN;
            if (sh > end || sh > f.range || sh >= hitS || sh >= wall) continue;
            hitM = m;
            hitS = sh;
            hitPerp = 0;
            hitZone = r.zone;
            continue;
          }
        } else continue;
      }
      if (t <= s0 || t > end || t > f.range || t >= hitS || t >= wall) continue;
      const perp = Math.abs(ox * f.dy - oy * f.dx);
      if (perp > m.radius * (f.free ? 1.1 : 1)) continue;
      const h = arcHeight(t, f.arc);
      // Free aim: the body's visible column (feet to top), as the reticle ray tests it.
      const body = f.free ? aimHooks.body?.(m, t) ?? { height: BODY_HEIGHT[m.size] ?? 1.7, lift: 0 } : null;
      if (h > (body ? body.lift + body.height : (HEIGHT_BY_SIZE[m.size] ?? 1.9) + 0.25)) {
        f.overflew.add(m);
        continue;
      }
      if (body && h < body.lift) continue;
      hitM = m;
      hitS = t;
      hitPerp = perp;
      hitZone = undefined;
    }
    // NPCs on the way (followers too: friendly fire) take the round before anything behind them.
    const npcHook = this.npcRound;
    if (npcHook) {
      const npcs = (this.game as unknown as { npcs?: { npcs: { x: number; y: number; z: number; dead?: boolean }[] } }).npcs?.npcs ?? [];
      let hitN: { x: number; y: number; z: number } | null = null, nS = Math.min(hitS, wall), nPerp = 0;
      for (const n of npcs) {
        if (n.dead || n.z !== f.z) continue;
        const ox = n.x - f.x0, oy = n.y - f.y0;
        const t = ox * f.dx + oy * f.dy;
        if (t <= s0 || t > end || t > f.range || t >= nS) continue;
        const perp = Math.abs(ox * f.dy - oy * f.dx);
        if (perp > CREATURE_RADIUS + 0.05) continue;
        const h = arcHeight(t, f.arc);
        if (h < 0 || h > 1.85) continue;
        hitN = n;
        nS = t;
        nPerp = perp;
      }
      if (hitN) {
        this.placeFlight(f, nS);
        f.done = true;
        f.explained = true;
        npcHook(hitN, f.shot, nPerp / (CREATURE_RADIUS + 0.05), defName(f.ammo));
        const round = f.round;
        f.round = null;
        if (round) this.placeRound(round, hitN.x, hitN.y, f.z, 0.05, f.yaw, 'ground');
        else if (f.shot.broke) this.game.message(`Your ${defName(f.ammo)} breaks.`, 'c_dark_gray');
        return;
      }
    }
    if (hitM) {
      this.placeFlight(f, hitS);
      if (!this.flightHits(f, hitM, hitPerp, hitZone)) f.passed.add(hitM);
      return;
    }
    // Past what it was aimed at without touching it: say why now, not when it lands. (Where the
    // target is *now* along the line: it may have stepped since the release.)
    const it = f.intended;
    if (it && !f.explained && !it.dead) {
      const along = (it.x - f.x0) * f.dx + (it.y - f.y0) * f.dy;
      if (end > along + it.radius && wall > along) {
        const kind: RangedMissKind = along > f.range + it.radius ? 'range' : f.overflew.has(it) ? 'over' : 'passed';
        this.explainFlight(f, kind);
      }
    }
    if (wall <= end) {
      this.placeFlight(f, Math.max(0, wall - 0.12));
      this.flightLands(f, 'wall');
      return;
    }
    if (ground <= s1) {
      this.placeFlight(f, ground);
      this.flightLands(f, 'ground');
      return;
    }
    this.placeFlight(f, s1);
  }

  /** First blocking wall between s0 and s1 along the flight (castRay's rule), else Infinity. */
  private wallAlong(f: Flight, s0: number, s1: number): number {
    let tx = Math.floor(f.x0 + f.dx * s0), ty = Math.floor(f.y0 + f.dy * s0);
    for (let s = s0; s <= s1 + 1e-6; s += 0.1) {
      const x = Math.floor(f.x0 + f.dx * s), y = Math.floor(f.y0 + f.dy * s);
      if (x === tx && y === ty) continue;
      tx = x;
      ty = y;
      if (!this.grid.passable(x, y, f.z) && this.grid.opaque(x, y, f.z)) return s;
    }
    return Infinity;
  }

  private explainFlight(f: Flight, kind: RangedMissKind): void {
    if (f.explained || !f.intended) return;
    f.explained = true;
    // Free aim: it flew where you aimed, so a plain wide miss needs no explaining; the arc's own
    // reasons (over, short, into cover, out of range) are still worth a word.
    if (f.free && kind === 'passed') return;
    const m = f.intended;
    const why = this.missWhy(kind, { m, dist: f.intendedDist }, f.range, f.spread, f.gun, f.cls);
    this.game.events.emit('playerAttack', { kind: 'gun', outcome: 'miss', x: f.x, y: f.y, z: f.z, damage: 0, heavy: false, blood: null, reason: why, ranged: f.cls, target: m });
  }

  /**
   * The round reaches monster `m` `perp` m off its centre: BN deal_projectile_attack at the
   * arrow's speed (a slow projectile is easier to dodge). Returns false when it was dodged and
   * flies on; true when it struck (it then embeds, drops at the monster's feet, or broke).
   */
  private flightHits(f: Flight, m: Monster, perp: number, zone?: HitZone): boolean {
    const game = this.game;
    const p = game.player;
    const rng = this.sys.rng;
    if (f.free) return this.flightHitsFree(f, m, perp, zone);
    const skill = p.getSkill(String(f.gun.def.skill ?? 'gun'));
    const speed = (Number(f.ammo?.speed) || 100) + (Number(f.gun.def.speed) || 0);
    const r = projectileHit(
      { dodgeRoll: m.dodge() * 5, isCharacter: false, flags: m.type.flags },
      { missedBy: perp / m.radius, speed, shooter: { dex: p.dex, per: p.per, skill, steadiness: Math.max(1, p.stamina) / Math.max(1, p.staminaMax()), isPlayer: true } },
      rng,
    );
    m.aggroCharacter = true;
    const name = defName(f.ammo);
    if (!r.hit) {
      game.message(`${m.TheName()} dodges your ${name}.`);
      if (m === f.intended) {
        f.explained = true;
        this.feedback('gun', 'miss', m, m.x, m.y, 0, 0, 'dodged', { ranged: f.cls });
      }
      sfx.arrowFly({ x: m.x, y: m.y, z: m.z });
      return false;
    }
    const units = f.shot.damage.map((d) => ({ type: d.type, amount: d.amount * r.severity, armor_penetration: d.armor_penetration, armor_multiplier: 1, multiplier: r.graze ? 1 : r.severity }));
    const dealtUnits = applyFlatArmor(units, m.type.armor);
    const total = Math.floor(dealtUnits.reduce((s, d) => s + d.amount, 0));
    if (r.tag) game.message(r.tag, 'c_light_green');
    game.message(total > 0 ? `Your ${name} hits ${m.theName()} for ${total} damage.` : `Your ${name} glances off ${m.theName()}!`);
    if (r.headshot) game.events.emit('playerHeadshot', { target: m });
    sfx.arrowHit('flesh', m);
    this.sys.hurt(m, total, 'player');
    f.explained = true;
    this.feedback('gun', r.tag === 'Critical!' ? 'crit' : 'hit', m, m.x, m.y, total, 0, total <= 0 ? 'no damage' : r.graze ? 'grazed' : undefined, { ranged: f.cls });
    this.ammoEffectsAt(f.shot, m.x, m.y, m, total);
    return this.flightStruck(f, m, dealtUnits);
  }

  /** Free aim: an arrow reaching a body strikes it where it arrives (height -> zone); no dice. */
  private flightHitsFree(f: Flight, m: Monster, perp: number, zone?: HitZone): boolean {
    const body = aimHooks.body?.(m, Math.hypot(m.x - f.x0, m.y - f.y0)) ?? { height: BODY_HEIGHT[m.size] ?? 1.7, lift: 0 };
    const hFrac = Math.max(0, Math.min(1, (f.h - body.lift) / body.height));
    sfx.arrowHit('flesh', m);
    const r = this.freeHit(m, f.shot.damage, { zone: zone ?? aimHooks.hitZone(m, hFrac), missedBy: perp / (m.radius * 1.1), perfect: !!f.perfect, name: defName(f.ammo), cls: f.cls, gun: f.gun });
    f.explained = true;
    this.ammoEffectsAt(f.shot, m.x, m.y, m, r.total);
    return this.flightStruck(f, m, r.dealt);
  }

  /** After a round strikes `m`: it breaks, sticks in the body, or drops at its feet (BN drop_or_embed_projectile). */
  private flightStruck(f: Flight, m: Monster, dealtUnits: { type: string; amount: number }[]): boolean {
    const game = this.game;
    const rng = this.sys.rng;
    const name = defName(f.ammo);
    const round = f.round;
    f.round = null;
    f.done = true;
    if (!round) {
      if (f.shot.broke) game.message(`Your ${name} breaks.`, 'c_dark_gray');
      return true;
    }
    const by = (t: string) => dealtUnits.filter((d) => d.type === t).reduce((s, d) => s + d.amount, 0);
    const fx = asArray(f.ammo?.effects as string[] | undefined);
    if (!m.dead && embedsIn(m.size, round.volume(), { cut: by('cut'), stab: by('stab'), bash: by('bash') }, rng, fx)) {
      const res = spawnItem(round, L.cargo(m.stuck), { force: true, quiet: true });
      const held = res.item ?? round;
      const list = m.stuck.hits.get(held) ?? [];
      const side = ((m.x - f.x0) * f.dy - (m.y - f.y0) * f.dx) / m.radius;
      list.push({ side: Math.max(-0.8, Math.min(0.8, side)), hgt: Math.max(0.25, Math.min(0.9, f.h / (HEIGHT_BY_SIZE[m.size] ?? 1.9))), yaw: f.yaw - m.facing });
      m.stuck.hits.set(held, list);
      game.message(`Your ${name} sticks in ${m.theName()}!`);
    } else this.placeRound(round, m.x, m.y, f.z, 0.05, f.yaw, 'ground');
    return true;
  }

  private flightLands(f: Flight, into: 'wall' | 'ground'): void {
    const game = this.game;
    f.done = true;
    if (f.intended && !f.explained && !f.intended.dead) {
      const along = (f.intended.x - f.x0) * f.dx + (f.intended.y - f.y0) * f.dy;
      const short = f.s < along - f.intended.radius;
      const kind: RangedMissKind = !short ? 'passed' : into === 'wall' ? 'wall' : f.s >= f.range - 0.5 ? 'range' : 'ground';
      this.explainFlight(f, kind);
    }
    sfx.arrowHit(into, { x: f.x, y: f.y, z: f.z });
    game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: f.x, y: f.y, z: f.z, damage: 0, heavy: false, blood: null, ranged: f.cls, landed: true });
    this.ammoEffectsAt(f.shot, f.x, f.y, null, 0);
    const round = f.round;
    f.round = null;
    if (round) this.placeRound(round, f.x, f.y, f.z, into === 'wall' ? Math.max(0.1, f.h) : 0, f.yaw, into);
    else if (f.shot.broke) game.message(`Your ${defName(f.ammo)} breaks.`, 'c_dark_gray');
  }

  /** A surviving round comes to rest on the tile at (x, y): an ordinary ground item from now on. */
  private placeRound(round: Item, x: number, y: number, z: number, hgt: number, yaw: number, into: Landed['into']): void {
    const map = this.game.map;
    let tx = Math.floor(x), ty = Math.floor(y);
    if (!this.grid.passable(tx, ty, z)) {
      tx = Math.floor(x - Math.sin(yaw) * 0.6);
      ty = Math.floor(y + Math.cos(yaw) * 0.6);
    }
    const r = spawnItem(round, L.ground(map, tx, ty, z), { force: true, quiet: true });
    if (!r.ok) return;
    this.landed.push({ item: r.item ?? round, x, y, z, hgt, yaw, into, map });
    if (this.landed.length > 120) this.landed.shift();
  }

  /** Bring every round in the air down where it is now (before a save: nothing is lost mid-flight). */
  settleFlights(): void {
    for (const f of this.flights.splice(0)) {
      const round = f.round;
      f.round = null;
      if (round) this.placeRound(round, f.x, f.y, f.z, 0, f.yaw, 'ground');
    }
  }

  /**
   * Ammo effects where a round lands: INCENDIARY sets the target alight (x_in_y(dmg/2, 50),
   * creature.cpp) or the tile on a miss; ammo effects with an `explosion` go off
   * (EXPLOSIVE, EXPLOSIVE_SMALL, NAPALM…); `aoe` fields (FLARE, NAPALM) spread fire.
   */
  ammoEffectsAt(shot: ShotResult, x: number, y: number, m: Monster | null, dealt: number): void {
    const game = this.game;
    const z = game.player.z;
    const rng = this.sys.rng;
    const table = (game.data.misc?.ammo_effect ?? {}) as Record<string, { explosion?: { power?: number; distance_factor?: number; fire?: boolean }; aoe?: { field_type: string; intensity_min?: number; intensity_max?: number; size?: number }[] }>;
    for (const id of shot.ammoEffects ?? []) {
      if (id === 'INCENDIARY') {
        const amount = dealt > 2 ? dealt / 2 : rng.oneIn(2) ? 1 : 0;
        if (m && rng.next() * 50 < amount) {
          const flesh = m.type.material.includes('flesh') || m.type.material.includes('hflesh');
          if (!flesh || rng.oneIn(4)) m.addEffect('onfire', turnsToSeconds(rng.int(1, 2) * Math.max(1, amount)));
        } else if (!m && rng.oneIn(4)) this.hooks.ignite?.(Math.floor(x), Math.floor(y), z);
      }
      const eff = table[id];
      for (const a of eff?.aoe ?? []) {
        const r = Math.max(0, Math.floor((a.size ?? 1) / 2));
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) this.hooks.addField?.(Math.floor(x) + dx, Math.floor(y) + dy, z, a.field_type, rng.int(a.intensity_min ?? 1, a.intensity_max ?? a.intensity_min ?? 1));
      }
      if (eff?.explosion?.power) this.hooks.explode?.(x, y, z, eff.explosion.power, eff.explosion.distance_factor ?? 0.75, !!eff.explosion.fire);
    }
  }

  /** World hooks for ammo effects (set by the combat-depth installer; no-ops in tests). */
  /**
   * A swing that finds no creature may hit the world instead: breaks the window/door/furniture
   * under the crosshair (set by main.ts from bash.ts). Returns true if the blow landed on something.
   */
  smashWorld?: () => boolean;

  hooks: {
    ignite?: (x: number, y: number, z: number) => void;
    addField?: (x: number, y: number, z: number, type: string, intensity: number) => void;
    explode?: (x: number, y: number, z: number, power: number, factor: number, fire: boolean) => void;
  } = {};

  /** Burst in progress: rounds left, time to the next one, recoil held back until the end. */
  burst: { gun: Item; left: number; timer: number; delay: number; cooldown: number } | null = null;

  private updateBurst(dt: number): void {
    const b = this.burst;
    if (!b) return;
    const p = this.game.player;
    if (p.inv.wielded !== b.gun || p.dead) {
      applyDelayedRecoil(p, b.delay);
      this.burst = null;
      return;
    }
    b.timer -= dt;
    while (this.burst && b.timer <= 0) {
      const shot = this.fireOne(b.gun, true);
      b.left--;
      b.timer += BURST_INTERVAL;
      if (shot) b.delay += shot.delayedRecoil ?? 0;
      if (!shot || b.left <= 0) {
        applyDelayedRecoil(p, b.delay);
        this.burst = null;
      }
    }
  }

  // ------------------------------------------------------------------ throwing

  /** Character::throw_range (simplified): lighter-than-150 g items fly less far, heavy ones less too. */
  throwRange(it: Item): number {
    const p = this.game.player;
    const w = it.weight();
    let r = (p.str * 10) / (w >= 150 ? w / 113 : 10 - Math.floor(w / 15));
    r -= it.volume() / 1000;
    r = Math.min(r, p.str + p.getSkill('throw'));
    return Math.max(1, Math.floor(r));
  }

  throwItem(it: Item | null = this.game.player.inv.wielded): boolean {
    const game = this.game;
    const p = game.player;
    if (!it) {
      game.message('You have nothing to throw.');
      return false;
    }
    if (this.cooldown > 0) return false;
    const from = p.inv.locOf(it);
    if (!from || it.hasFlag('NO_DROP') || it.hasFlag('BIONIC_WEAPON') || it.hasFlag('INTEGRATED') || from.kind === 'worn') {
      game.message(`You can't throw the ${it.name()}.`);
      return false;
    }
    this.viewmodel()?.attack('throw');
    const range = this.throwRange(it);
    // Skill and dexterity tighten the throw (dispersion ~ ranged.cpp throwing).
    const spread = Math.max(0.01, 0.25 - p.getSkill('throw') * 0.02 - (p.dex - 8) * 0.01);
    // Free aim: it goes where you look (the throw's skill shows in its range and damage).
    const yaw = freeAim() ? p.yaw : p.yaw + normalRoll(this.sys.rng, 0, spread);
    const hit = this.castRay(yaw, range);
    this.cooldown = (100 + it.weight() / 50) / 100 / ACTION_SCALE;
    p.practice('throw', 5 + Math.floor(range / 2));
    const land = { x: Math.floor(hit.x), y: Math.floor(hit.y) };
    if (!this.grid.passable(land.x, land.y, p.z)) {
      land.x = Math.floor(hit.x - Math.sin(yaw) * 0.6);
      land.y = Math.floor(hit.y + Math.cos(yaw) * 0.6);
    }
    // The item lands on its tile the moment it leaves the hand (the projectile is only the
    // picture of its flight), so it is never in two places or none. One of a stack flies.
    const moved = moveItem(it, from, L.ground(game.map, land.x, land.y, p.z), { count: it.countByCharges ? 1 : undefined, force: true, quiet: true });
    if (!moved.ok) {
      game.message(moved.msg, 'c_light_red');
      return false;
    }
    this.sys.projectiles.push({
      x: p.x, y: p.y, z: p.z, vx: (hit.x - p.x) / 0.25, vy: (hit.y - p.y) / 0.25, t: 0.25,
      glyph: { symbol: it.def.symbol ?? '*', color: it.def.color ?? 'white' },
      onArrive: () => {
        if (!hit.hit || hit.hit.dead) return;
        const m = hit.hit;
        const bash = Math.min(it.weight() / 100 + p.str / 2, p.str * 2);
        const units = [{ type: 'bash', amount: bash, armor_penetration: 0, armor_multiplier: 1 }];
        for (const u of it.def.thrown_damage ?? []) units.push({ type: u.damage_type, amount: u.amount, armor_penetration: u.armor_penetration ?? 0, armor_multiplier: 1 });
        const total = Math.floor(applyFlatArmor(units, m.type.armor).reduce((s, d) => s + d.amount, 0));
        game.message(`The ${it.baseName()} hits ${m.theName()} for ${total} damage.`);
        m.aggroCharacter = true;
        this.sys.hurt(m, total, 'player');
        this.feedback('throw', 'hit', m, m.x, m.y, total);
      },
    });
    this.sys.emitSound(land.x + 0.5, land.y + 0.5, p.z, 4, 'a thud.', 'player', '');
    return true;
  }
}

/** Does the gun have a burst/auto fire mode (CDDA `modes` entry firing more than one shot)? */
export function isAutomatic(gun: Item): boolean {
  const modes = gun.def.modes as unknown;
  return Array.isArray(modes) && modes.some((m) => Array.isArray(m) && typeof m[2] === 'number' && m[2] > 1);
}

/** Player-facing skill names for the miss line ("archery skill too low (1)"). */
function skillName(id: string): string {
  return ({ gun: 'marksmanship', throw: 'throwing', smg: 'submachine gun', launcher: 'launcher' } as Record<string, string>)[id] ?? id;
}

/** A round's display name from its def (names can be plain strings or {str} objects). */
function defName(def: ItemDef | undefined, fallback = 'arrow'): string {
  const n = def?.name as unknown;
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object' && typeof (n as { str?: unknown }).str === 'string') return (n as { str: string }).str;
  return fallback;
}

function weaponSound(w: Item | null): { id?: string; skill: MeleeSkill; volumeMl?: number } {
  if (!w) return { skill: 'unarmed' };
  return { id: w.typeId, skill: w.meleeSkill(), volumeMl: w.volume() };
}

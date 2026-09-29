import { ACTION_SCALE } from '../core/time';
import type { Game, GameSystem } from './game';
import { aim, applyDelayedRecoil, applyFlatArmor, attackCooldownSeconds, fireGun, hitMessage, meleeAttack, normalRoll, pelletAngle, sizeRank, type ShotResult } from './combat';
import { currentMode } from './gunmods';
import type { Item } from './item';
import { turnsToSeconds, type MonEffect, type Monster } from './monster';
import { COMBAT_TURN, maOf, tickMartialArts, triggerBuffs } from './martialarts';
import { techniqueMessage, type TargetInfo, type TechniqueOutcome } from './techniques';
import type { MonsterSystem } from './monai';
import { Grid, hasLOS } from './los';
import { sfx, type MeleeSkill } from '../audio/sfx';
import { FEEL, arcFor, defenseOf, hitStopSeconds, sweptArcTarget, swingTiming, type SwingStyle, type SwingTiming } from './combatfeel';
import { moveWithCollision } from './physics';

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
  /** Gun kick scaled by the round's recoil (replaces attack('fire') when present). */
  recoil?(k: number): void;
}

/** A swing in progress (feel layer). `t` counts from the click. */
export interface SwingState {
  t: number;
  timing: SwingTiming;
  reach: number;
  arc: number;
  style: SwingStyle;
  resolved: boolean;
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
    hasWeapon: false,
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
  /** Gunfire feedback for the renderer (camera kick): the round's recoil, ~1 for a pistol. */
  onFire: ((kick: number) => void) | null = null;
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
  private grid: Grid;
  private lastX = NaN;
  private lastY = NaN;

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
    this.updateStep(dt);
    if (this.hitStop <= 0) this.updateSwing(dt);
    if (p.dead || input.captured) {
      this.setGuard(false);
      this.prevHeld.clear();
      return;
    }
    // LMB: consume our clicks but leave other buttons' clicks for whoever else reads them.
    const clicks = input.consumeClicks();
    const others = clicks.filter((b) => b !== 0);
    if (others.length) (input as unknown as { clicks: number[] }).clicks.push(...others);
    const gun = p.inv.wielded?.isGun() ? p.inv.wielded : null;
    // Holding LMB keeps swinging a melee weapon, but a gun only keeps firing when it has an
    // automatic mode; a pistol fires once per click like CDDA's one shot per `f`.
    const held = (input.mouseButtons & 1) !== 0 && (!gun || currentMode(gun).qty > 1);
    this.updateBurst(dt);
    const lmb = clicks.includes(0) || held;
    const rmb = (input.mouseButtons & 4) !== 0;
    if (gun && rmb) aim(p, gun, dt * ACTION_SCALE * 100);
    // RMB with a melee weapon or bare hands: guard (lowered while a swing plays).
    this.setGuard(!gun && rmb && !this.swing && !p.effects.has('downed') && !game.movementOverride?.());
    if (def.guarding) {
      def.guardAge += dt;
      p.modStamina(-FEEL.guardStaminaPerSec * dt);
    }
    this.detectSidestep();
    if (lmb && this.cooldown <= 0 && !this.swing) this.attack();
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
    const vm = this.viewmodel();
    // The follow-through carries past contact for up to 0.12 s, then the hands come back.
    const follow = Math.min(0.12, timing.active + timing.recovery * 0.4);
    if (vm?.swing) vm.swing({ windup: timing.windup, strike: timing.strike, follow, recovery: timing.total - timing.windup - timing.strike - follow, style });
    else vm?.attack('melee');
  }

  /** Advance the swing: from contact until the active window closes, the arc looks for a target. */
  private updateSwing(dt: number): void {
    const s = this.swing;
    if (!s) return;
    s.t += dt;
    const contact = s.timing.windup + s.timing.strike;
    if (!s.resolved && s.t >= contact) {
      const m = this.meleeTarget(s.reach, s.arc);
      if (m || s.t >= contact + s.timing.active) {
        s.resolved = true;
        // An NPC under the crosshair may take the blow instead (npcai decides; asks first if friendly).
        if (!this.npcMelee?.(s.reach, m)) this.melee(m, { phased: s.t });
      }
    }
    if (s.resolved && s.t >= s.timing.total) this.swing = null;
  }

  /** LMB / debug: fire if wielding a gun, else start a (phased) swing. */
  attack(): void {
    if (this.attackGuard && !this.attackGuard()) return;
    const w = this.game.player.inv.wielded;
    if (w?.isGun()) this.fire();
    else this.beginSwing();
  }

  // ------------------------------------------------------------------ melee

  /**
   * Monster the weapon's arc meets right now: the one the crosshair ray is on (the camera
   * raycast knows the exact sprite), else combatfeel.sweptArcTarget within `reach` and ±`arc`
   * of the aim, closest to the crosshair first, never through walls.
   */
  meleeTarget(reach = FEEL.reach, arc = FEEL.arcSwing): Monster | null {
    const p = this.game.player;
    const look = this.game.lookAt?.(reach + 1.5);
    const hit = look?.kind === 'creature' ? (look.creature as { monster?: Monster } | undefined)?.monster : undefined;
    if (hit && !hit.dead && Math.hypot(hit.x - p.x, hit.y - p.y) - hit.radius <= reach) return hit;
    const near = this.sys.active.filter((m) => !m.dead && m.z === p.z);
    return sweptArcTarget(p, near, reach, arc, (m) => !hasLOS(this.grid, p.tileX, p.tileY, m.tileX, m.tileY, p.z));
  }

  /**
   * One melee blow. Without `phased` (scripts, tests) it picks a target, animates and resolves
   * at once, like before the feel layer. `phased` = seconds since the swing started: the swing
   * clock already runs the animation and cooldown, this only resolves the blow at contact.
   */
  melee(target: Monster | null = null, o: { phased?: number } = {}): boolean {
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
      // Swinging at nothing still costs the swing (and a little stamina).
      const cd = attackCooldownSeconds(p, w);
      this.cooldown = phased ? Math.max(this.cooldown, cd - o.phased!) : cd;
      p.modStamina(-20);
      sfx.meleeWhiff((w?.weight() ?? 0) > 2000);
      this.feedback('melee', 'whiff', null, p.x + Math.sin(p.yaw) * reach, p.y - Math.cos(p.yaw) * reach, 0);
      return false;
    }
    const hit = this.swingAt(m, { reach, primary: true, elapsed: o.phased });
    return hit;
  }

  /**
   * One swing at monster `m` (Character::melee_attack_abstract): picks a technique, applies its
   * effects (stun, downed, knockback, AoE follow-ups), prints CDDA's technique message.
   * Follow-up AoE swings (`primary: false`) cost no time or stamina, like CDDA.
   */
  swingAt(m: Monster, o: { reach?: number; primary: boolean; elapsed?: number }): boolean {
    const game = this.game;
    const p = game.player;
    const rng = this.sys.rng;
    const ws = weaponSound(p.inv.wielded);
    const reach = o.reach ?? FEEL.reach;
    const stamina = p.stamina;
    const res = meleeAttack(p, { dodge: m.dodge(), armor: m.type.armor, sizeMeleePenalty: m.sizeMeleePenalty(), info: monsterTargetInfo(m) }, rng, m.theName(), {
      allowSpecial: o.primary,
      aoeTargets: (kind) => this.aoeVictims(kind, m, reach).length,
      downable: !m.has('IMMOBILE'),
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
      this.feedback('melee', 'miss', m, m.x, m.y, 0);
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
    this.sys.hurt(m, res.total, 'player', { crit: res.crit });
    // Hit-stop: the hands, the swing clock and the struck monster hold for a few frames.
    let stop = 0;
    if (o.primary && o.elapsed !== undefined) {
      stop = m.dead ? FEEL.hitStopMax : hitStopSeconds(res.total, m.hpMax, res.crit);
      this.hitStop = Math.max(this.hitStop, stop);
      this.viewmodel()?.impact?.(stop);
      m.busy = Math.max(m.busy, stop);
    }
    // Before the technique can knock it away: the impact is where it stood when struck.
    this.feedback('melee', res.crit ? 'crit' : 'hit', m, m.x, m.y, res.total, stop);
    if (m.dead) triggerBuffs(p, 'onkill');
    else if (res.outcome) applyTechniqueToMonster(m, res.outcome, p.x, p.y, rng);
    if (victims.length) {
      for (const v of victims) if (!v.dead) this.swingAt(v, { reach, primary: false });
      game.message(`${victims.length} ${victims.length === 1 ? 'enemy' : 'enemies'} hit!`, 'c_light_green');
    }
    return true;
  }

  /**
   * Tell hit-feedback listeners (particles, stagger, crosshair marker) how an attack went.
   * The impact point is the near side of the target (what the camera sees get hit).
   */
  private feedback(kind: 'melee' | 'gun' | 'throw', outcome: 'hit' | 'crit' | 'miss' | 'whiff', m: Monster | null, x: number, y: number, damage: number, hitStop = 0): void {
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
    const shot = fireGun(p, gun, rng, { burst });
    if (!shot.ok) {
      sfx.gunEmpty();
      this.cooldown = 0.25;
      return null;
    }
    this.shots++;
    // Kick scaled by the round's recoil (MOA added; ~150-250 for a 9 mm pistol).
    const kick = Math.max(0.4, Math.min(2.5, (shot.addedRecoil ?? 200) / 200));
    const vm = this.viewmodel();
    if (vm?.recoil) vm.recoil(kick);
    else vm?.attack('fire');
    this.onFire?.(kick);
    const ammo = gun.ammoData() ?? null;
    sfx.gunshot(gun.typeId, undefined, { ammoType: typeof ammo?.ammo_type === 'string' ? ammo.ammo_type : undefined, loudness: shot.noise.volume });
    // CDDA make_gun_sound_effect: silent weapons make no sound at all.
    if (shot.noise.volume > 0) this.sys.emitSound(p.x, p.y, p.z, shot.noise.volume, shot.noise.sound || 'Bang!', 'player', '');
    // Dispersion becomes a sideways offset (the vertical part of the cone can't miss a sprite
    // that already fills the crosshair's column, so only the horizontal component matters).
    const yaw = p.yaw + shot.spread * Math.cos(shot.azimuth);
    const range = Math.max(1, shot.range || 30);
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
      this.impact(hit, shot, shot.damage, true);
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
      game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: hit.x, y: hit.y, z: p.z, damage: 0, heavy: false, blood: null });
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

  /** A single projectile's impact: CDDA damage bands on a monster, or a wall. */
  private impact(hit: { x: number; y: number; hit: Monster | null; missedBy: number }, shot: ShotResult, damage: ShotResult['damage'], primary: boolean): void {
    const game = this.game;
    const p = game.player;
    const rng = this.sys.rng;
    if (!hit.hit) {
      sfx.bulletHit('wall', { x: hit.x, y: hit.y, z: p.z });
      this.game.events.emit('playerAttack', { kind: 'gun', outcome: 'whiff', x: hit.x, y: hit.y, z: p.z, damage: 0, heavy: false, blood: null });
      if (primary) this.ammoEffectsAt(shot, hit.x, hit.y, null, 0);
      return;
    }
    const m = hit.hit;
    m.aggroCharacter = true;
    // Creature::deal_projectile_attack: goodhit = missed_by + partial dodge; damage bands.
    const dodge = Math.min(1, (m.dodge() * 5 * rng.next()) / Math.max(1, rng.dice(10, 50)));
    const goodhit = hit.missedBy * 0.9 + dodge;
    const hitRoll = goodhit + rng.next() * (1 - Math.min(1, goodhit));
    let mult = 1, tag = '';
    if (goodhit < 0.1 && rng.oneIn(3) && !m.has('NOHEAD')) {
      mult = (0.95 + 0.1 * rng.next()) * 2;
      tag = '  Critical!!';
    } else if (goodhit < 0.2 && hitRoll * 0.5 < 0.2) {
      mult = (1 - 0.25 * hitRoll) * 2;
      tag = '  Critical!';
    } else if (goodhit < 0.5) {
      mult = (1 - 0.5 * hitRoll) * 2;
      tag = '  Good hit!';
    } else if (goodhit < 0.8) mult = 1.5 - hitRoll;
    else {
      mult = Math.max(0.05, 1.05 - hitRoll);
      tag = '  Grazing hit.';
    }
    const units = damage.map((d) => ({ type: d.type, amount: d.amount * mult, armor_penetration: d.armor_penetration, armor_multiplier: 1 }));
    const total = Math.floor(applyFlatArmor(units, m.type.armor).reduce((s, d) => s + d.amount, 0));
    game.message(total > 0 ? `You shoot ${m.theName()} for ${total} damage.${tag}` : `You shoot ${m.theName()} but do no damage.`);
    sfx.bulletHit('flesh', m);
    this.sys.hurt(m, total, 'player');
    this.feedback('gun', tag.startsWith('  Critical') ? 'crit' : 'hit', m, m.x, m.y, total);
    if (primary) this.ammoEffectsAt(shot, m.x, m.y, m, total);
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
    const removed = p.inv.remove(it);
    if (!removed) {
      game.message(`You can't throw the ${it.name()}.`);
      return false;
    }
    this.viewmodel()?.attack('throw');
    const range = this.throwRange(it);
    // Skill and dexterity tighten the throw (dispersion ~ ranged.cpp throwing).
    const spread = Math.max(0.01, 0.25 - p.getSkill('throw') * 0.02 - (p.dex - 8) * 0.01);
    const yaw = p.yaw + normalRoll(this.sys.rng, 0, spread);
    const hit = this.castRay(yaw, range);
    this.cooldown = (100 + it.weight() / 50) / 100 / ACTION_SCALE;
    p.practice('throw', 5 + Math.floor(range / 2));
    const land = { x: Math.floor(hit.x), y: Math.floor(hit.y) };
    if (!this.grid.passable(land.x, land.y, p.z)) {
      land.x = Math.floor(hit.x - Math.sin(yaw) * 0.6);
      land.y = Math.floor(hit.y + Math.cos(yaw) * 0.6);
    }
    this.sys.projectiles.push({
      x: p.x, y: p.y, z: p.z, vx: (hit.x - p.x) / 0.25, vy: (hit.y - p.y) / 0.25, t: 0.25,
      glyph: { symbol: it.def.symbol ?? '*', color: it.def.color ?? 'white' },
      onArrive: () => {
        game.map.addItem(land.x, land.y, p.z, it);
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

function weaponSound(w: Item | null): { id?: string; skill: MeleeSkill; volumeMl?: number } {
  if (!w) return { skill: 'unarmed' };
  return { id: w.typeId, skill: w.meleeSkill(), volumeMl: w.volume() };
}

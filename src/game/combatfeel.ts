import type { Character } from './character';

// The feel layer of real-time combat: how long things take to happen on screen, how they are
// telegraphed and how forgiving the survivor's active defences are. The *resolution* layer
// underneath (to-hit, damage, armor, block and dodge math in combat.ts / techniques.ts) stays
// CDDA/BN; this module only decides *when* a blow resolves and against *what*, and gives the
// guard/side-step defences a mapping onto CDDA's block_hit / dodge_roll.
//
// Every tunable lives in FEEL (one object, so a balance pass edits one place). Difficulty
// presets swap the whole object: `setFeelDifficulty('classic')`. A later balance agent wires
// that to the game's difficulty presets; until then Accessible is the default (DESIGN_V2).
//
// Everything here is pure (no DOM, no three.js) and unit-tested in tests/combatfeel.test.ts.

export type FeelDifficulty = 'accessible' | 'classic';

export interface FeelConstants {
  // --- survivor melee: a swing is wind-up -> strike (contact) -> follow-through/recovery.
  /** Wind-up floor/ceiling (s) and how much each kg of weapon adds. */
  windupMin: number;
  windupMax: number;
  windupBase: number;
  windupPerKg: number;
  /** Wind-up never takes more than this share of the CDDA swing time. */
  windupMaxShare: number;
  /** Fast part of the swing from the wound-up pose to contact (s): the hit resolves at its end. */
  strike: number;
  /** After contact the arc stays live this long (s): a target stepping into it still gets hit. */
  activeWindow: number;
  /** Shortest recovery after the active window (s), whatever CDDA's move cost says. */
  recoveryMin: number;
  /** Hit-stop (freeze frames) on a connecting blow, s: base + scaled by damage share of max HP. */
  hitStopBase: number;
  hitStopMax: number;
  /** Half-angle (rad) of the swept arc per attack style; stabs are narrow, big swings wide. */
  arcSwing: number;
  arcThrust: number;
  arcPunch: number;
  /** Reach (tiles, centre to target edge): CDDA adjacency incl. diagonals; REACH_ATTACK weapons. */
  reach: number;
  reachLong: number;

  // --- monster attacks
  /** Telegraph (s) of a plain swing by a speed-100 monster; scaled by 100/speed and clamped. */
  telegraph: number;
  telegraphMin: number;
  telegraphMax: number;
  /** Heavy blows (hulk smash, big monsters) wind up this much longer. */
  telegraphHeavyMul: number;
  /** Crouch before a leap (s). */
  telegraphLeap: number;
  /** The blow still lands if you are within reach + this (m) when it resolves (the lunge). */
  lunge: number;
  /** A monster's swing cycle is at least its wind-up plus this (s), whatever CDDA's cost says. */
  monsterRecovery: number;

  // --- guard (RMB with a melee weapon or bare hands) -> CDDA block_hit
  /** Added to the block score (str + WBLOCK + melee) while guarding. */
  guardBlockBonus: number;
  /** Raising the guard this close (s) before a blow lands is a parry: extra score + attacker stagger. */
  parryWindow: number;
  parryBonus: number;
  /** Seconds a parried attacker is stunned. */
  parryStun: number;
  /** Walk speed multiplier while guarding (the "Swing any time" melee control only). */
  guardMoveMul: number;
  /** Stamina per second spent holding the guard (the "Swing any time" melee control only). */
  guardStaminaPerSec: number;

  // --- ready stance (the default "Ready to swing" melee control, see meleeStance): RMB raises the
  // weapon or fists, LMB swings only while it is up, and the raised stance is also the guard.
  /** Walk speed multiplier while readied. */
  readyMoveMul: number;
  /** Stamina per second spent holding the weapon up. */
  readyStaminaPerSec: number;

  // --- side-step (Space, or double-tap A/D/S) -> CDDA dodge_roll
  dodgeDistance: number;
  dodgeTime: number;
  dodgeCooldown: number;
  /** Seconds after the step starts during which blows roll dodge with the bonus. */
  dodgeWindow: number;
  /** Added to the dodge skill for that roll (dodge_roll = (dodge + bonus) * 5). */
  dodgeBonus: number;
  dodgeStamina: number;
  /** Two taps of a strafe/back key within this (s) side-step. */
  doubleTap: number;

  // --- grabs
  /** Each struggle press adds this to the next break-free roll (cumulative, resets on success). */
  struggleBonus: number;
  /** GRAB / GRAB_DRAG cooldowns are this many times BN's (the first fight lost newcomers to grab loops). */
  grabCooldownMul: number;
  /** A blow that staggers the grabber (staggerShare of its HP, or a crit) makes it let go. */
  staggerBreaksGrab: boolean;

  // --- hit reactions (monsters)
  /** Flinch (s) per unit of damage/maxHP, capped: the monster pauses and its wind-up slips. */
  flinchPerHp: number;
  flinchMax: number;
  /** A blow taking this share of max HP (or a crit) interrupts a wind-up. */
  staggerShare: number;
  /** Shove (tiles) per unit of damage/maxHP, capped; a real displacement over ~0.12 s. */
  shovePerHp: number;
  shoveMax: number;

  // --- spacing
  /** Chasers stop this far inside their reach (m) and only restart once out of reach (hysteresis). */
  holdInside: number;
  /** Within this range (m) chasers spread into slots around the survivor. */
  surroundRange: number;

  // --- guns
  /** Aim-down-sights field of view (deg; hip is the camera's normal 70). */
  adsFov: number;

  // --- bows (rangedfeel.ts): RMB draws, aim builds at full draw, LMB looses
  /** Shortest draw (s) whatever BN's reload cost says, so the draw reads on screen. */
  drawMin: number;
  /** Stamina per second spent holding a bow at full draw. */
  drawStaminaPerSec: number;
  /** Held at full draw longer than this (s), the arms start to shake... */
  drawHoldSteady: number;
  /** ...adding this much recoil (MOA) per second back onto the aim. */
  drawShake: number;
  /** Whirling a sling before the release (s, added to BN's reload cost). */
  slingWhirl: number;

  // --- free aim (src/game/aimmodel.ts; the "sway" and "timing" aim models, not "dice")
  /** Reticle sway amplitude as a share of BN's mean lateral shot error (the dispersion it replaces). */
  aimSwayScale: number;
  /** Unaimed-ness (recoil MOA above the sight floor, BN's aim state) adds this share as extra sway. */
  aimUnsteady: number;
  /** Shot recoil (BN MOA added by the round) -> reticle kick, and the share of it the camera shows. */
  aimKickScale: number;
  aimKickView: number;
  /** Kick recovery rate (1/s) at skill 0, and how much each skill level adds. */
  aimKickRecover: number;
  aimKickRecoverPerSkill: number;
  /** Damage multiplier at weapon skill 0 and at 10 (linear between): skill makes hits count, not land. */
  aimSkillDmg0: number;
  aimSkillDmg10: number;
  /** Where it hit: head, legs; a graze on the edge of the body; a weak spot (skill/dex/per chance); a perfectly timed shot. */
  aimHeadMul: number;
  aimLegMul: number;
  aimGrazeMul: number;
  aimWeakMul: number;
  aimPerfectMul: number;
  /** Melee in free aim: a blow that visibly connects but whose BN hit roll failed lands glancing. */
  aimGlancingMul: number;
  /** Melee zones (free aim, from the 3D model part the swing met): head and legs/limbs damage multipliers. */
  aimMeleeHeadMul: number;
  aimMeleeLimbMul: number;
  /** Each melee skill level widens the parry window by this share (free aim models). */
  aimParryPerSkill: number;
  /** Each weapon skill level adds this to a hit's stagger (share of HP counted for flinch/stagger). */
  aimStaggerPerSkill: number;
}

const ACCESSIBLE: FeelConstants = {
  windupMin: 0.07, windupMax: 0.34, windupBase: 0.08, windupPerKg: 0.06, windupMaxShare: 0.45,
  strike: 0.05, activeWindow: 0.08, recoveryMin: 0.12,
  hitStopBase: 0.045, hitStopMax: 0.085,
  arcSwing: (40 * Math.PI) / 180, arcThrust: (22 * Math.PI) / 180, arcPunch: (28 * Math.PI) / 180,
  reach: 1.2, reachLong: 2.2,
  telegraph: 0.5, telegraphMin: 0.4, telegraphMax: 0.8, telegraphHeavyMul: 1.5, telegraphLeap: 0.45, lunge: 0.35, monsterRecovery: 0.35,
  guardBlockBonus: 8, parryWindow: 0.35, parryBonus: 10, parryStun: 0.8, guardMoveMul: 0.55, guardStaminaPerSec: 60,
  // Readied walk speed: the survivor walks ~2.8 m/s (speed 100 / ~107 moves with clothes on, x
  // ACTION_SCALE 3; 3.0 bare), a speed-70 zombie 2.1 m/s (1.89 at Accessible's 0.9 monster speed).
  // 0.65 puts a readied survivor at ~1.8-1.95 m/s: backing off from a zombie with the weapon up
  // about keeps pace with it and buys no free swings; to open distance you lower it (or run).
  // Stamina: base regen is 20 per turn = 60/s. Holding the weapon up is now how every melee fight
  // is fought, so it costs a third of the regen (standing ready never runs you dry, you just
  // recover slower); a fight's real cost stays BN's: ~100 per swing, plus each block.
  readyMoveMul: 0.65, readyStaminaPerSec: 20,
  dodgeDistance: 1.3, dodgeTime: 0.18, dodgeCooldown: 0.6, dodgeWindow: 0.3, dodgeBonus: 6, dodgeStamina: 300, doubleTap: 0.25,
  struggleBonus: 3, grabCooldownMul: 1.6, staggerBreaksGrab: true,
  flinchPerHp: 1.2, flinchMax: 0.35, staggerShare: 0.2, shovePerHp: 1.2, shoveMax: 0.35,
  holdInside: 0.2, surroundRange: 3.5,
  adsFov: 50,
  drawMin: 0.45, drawStaminaPerSec: 50, drawHoldSteady: 4, drawShake: 220, slingWhirl: 0.35,
  aimSwayScale: 1.6, aimUnsteady: 0.06, aimKickScale: 0.15, aimKickView: 0.5, aimKickRecover: 5, aimKickRecoverPerSkill: 0.9,
  aimSkillDmg0: 0.75, aimSkillDmg10: 1.3, aimHeadMul: 2, aimLegMul: 0.75, aimGrazeMul: 0.5, aimWeakMul: 1.5, aimPerfectMul: 1.25,
  aimGlancingMul: 0.5, aimParryPerSkill: 0.05, aimStaggerPerSkill: 0.04, aimMeleeHeadMul: 1.5, aimMeleeLimbMul: 0.8,
};

/** Classic: BN's own pacing where real time allows — shorter tells, tighter parries. */
const CLASSIC: FeelConstants = {
  ...ACCESSIBLE,
  telegraph: 0.35, telegraphMin: 0.25, telegraphMax: 0.6, telegraphLeap: 0.3, lunge: 0.45, monsterRecovery: 0.2,
  guardBlockBonus: 4, parryWindow: 0.18, parryBonus: 6, parryStun: 0.5, guardMoveMul: 0.45, guardStaminaPerSec: 120,
  // ~1.7-1.8 m/s readied vs a 2.1 m/s zombie: backing away readied loses ground. Two thirds of
  // the regen while held: a long stand-off readied still recovers, slowly.
  readyMoveMul: 0.6, readyStaminaPerSec: 40,
  dodgeWindow: 0.22, dodgeBonus: 3, dodgeStamina: 450,
  struggleBonus: 1, grabCooldownMul: 1, staggerBreaksGrab: false,
  staggerShare: 0.3,
  drawStaminaPerSec: 90, drawHoldSteady: 2.5, drawShake: 400,
  aimSwayScale: 2, aimUnsteady: 0.08, aimKickRecover: 4, aimSkillDmg0: 0.65, aimGlancingMul: 0.4, aimParryPerSkill: 0.03,
};

export const FEEL_PRESETS: Record<FeelDifficulty, FeelConstants> = { accessible: ACCESSIBLE, classic: CLASSIC };

/** The live tuning. Mutate fields for experiments; setFeelDifficulty replaces them all. */
export const FEEL: FeelConstants = { ...ACCESSIBLE };
let difficulty: FeelDifficulty = 'accessible';

/** Difficulty hook: the balance pass maps game presets (Accessible/Classic/Custom) onto these. */
export function setFeelDifficulty(d: FeelDifficulty, overrides: Partial<FeelConstants> = {}): void {
  const preset = FEEL_PRESETS[d];
  if (!preset) throw new Error(`unknown feel difficulty ${d}`);
  difficulty = d;
  Object.assign(FEEL, preset, overrides);
}
export function feelDifficulty(): FeelDifficulty {
  return difficulty;
}

// ------------------------------------------------------------------ survivor swing timing

export type SwingStyle = 'swing' | 'thrust' | 'punch';

export interface SwingTiming {
  /** Anticipation: from the click until the fast part of the swing starts. */
  windup: number;
  /** Fast part of the swing; the blow resolves at windup + strike ("contact"). */
  strike: number;
  /** Arc stays live after contact. */
  active: number;
  /** From the end of the active window until the next swing may start. */
  recovery: number;
  /** windup + strike + active + recovery == CDDA's swing time (or longer if clamped). */
  total: number;
}

/**
 * Split CDDA's swing time (attack_speed moves -> seconds) into on-screen phases. Heavier
 * weapons wind up longer (they read as heavy), but never so long that the swing rate changes:
 * the phases always add up to `cycle` unless the floors push it longer.
 */
export function swingTiming(cycle: number, weightGrams: number, f: FeelConstants = FEEL): SwingTiming {
  const kg = Math.max(0, weightGrams) / 1000;
  const byWeight = Math.min(f.windupMax, Math.max(f.windupMin, f.windupBase + kg * f.windupPerKg));
  const windup = Math.min(byWeight, cycle * f.windupMaxShare);
  const strike = f.strike, active = f.activeWindow;
  const recovery = Math.max(f.recoveryMin, cycle - windup - strike - active);
  return { windup, strike, active, recovery, total: windup + strike + active + recovery };
}

/** Hit-stop length for a blow: heavier (relative to the target) freezes a touch longer. */
export function hitStopSeconds(damage: number, targetMaxHp: number, crit: boolean, f: FeelConstants = FEEL): number {
  if (damage <= 0) return f.hitStopBase * 0.6;
  const share = Math.min(1, damage / Math.max(1, targetMaxHp));
  return Math.min(f.hitStopMax, f.hitStopBase + share * (f.hitStopMax - f.hitStopBase) * 1.5 + (crit ? 0.015 : 0));
}

/** Arc half-angle for a style. */
export function arcFor(style: SwingStyle, f: FeelConstants = FEEL): number {
  return style === 'thrust' ? f.arcThrust : style === 'punch' ? f.arcPunch : f.arcSwing;
}

// ------------------------------------------------------------------ swept-arc target selection

export interface ArcCandidate {
  x: number;
  y: number;
  radius: number;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Bearing from (ox, oy) to (x, y) in the game's yaw convention (0 = north/-y, clockwise). */
export function bearing(ox: number, oy: number, x: number, y: number): number {
  return Math.atan2(x - ox, -(y - oy));
}

/**
 * What a swing hits at its contact frame. The weapon sweeps an arc of ±`arcHalf` around the
 * aim within `reach` of the survivor (centre to target edge). A target the crosshair ray
 * passes through wins outright; otherwise the one closest to the crosshair in angle (its
 * angular size counts, so a big target at the edge of the arc still gets clipped), ties to the
 * nearer one. `blocked(c)` rejects targets behind walls.
 */
/**
 * Why a melee blow missed, in two or three words for the crosshair (QA: "swing wildly and
 * miss" twice in a row with no visible cause). `spread` is BN's hit spread (hit roll minus the
 * target's dodge × 5 and size penalty; < 0 = miss), `dodge` the dodge × 5 part, `size` the
 * size penalty part, `stumble` the stumble moves of the swing.
 */
export function missReason(o: { spread: number; dodge: number; size?: number; stumble?: number }): string {
  if (o.dodge > 0 && o.spread + o.dodge >= 0) return 'dodged';
  const size = o.size ?? 0;
  if (size > 0 && o.spread + o.dodge + size >= 0) return 'too small to hit';
  const st = o.stumble ?? 0;
  return st >= 60 ? 'off balance' : st >= 10 ? 'wild swing' : 'clumsy swing';
}

export function sweptArcTarget<T extends ArcCandidate>(
  origin: { x: number; y: number; yaw: number },
  candidates: readonly T[],
  reach: number,
  arcHalf: number,
  blocked: (c: T) => boolean = () => false,
): T | null {
  let best: T | null = null, bestScore = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - origin.x, c.y - origin.y);
    if (d - c.radius > reach) continue;
    const off = Math.abs(wrap(bearing(origin.x, origin.y, c.x, c.y) - origin.yaw));
    const halfSize = Math.atan2(c.radius, Math.max(d, 0.05));
    const onRay = off <= halfSize;
    const edge = off - halfSize;
    if (!onRay && edge > arcHalf) continue;
    if (blocked(c)) continue;
    const score = (onRay ? 0 : 10 + edge) + d * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ------------------------------------------------------------------ monster telegraphs

export type TelegraphKind = 'melee' | 'heavy' | 'leap';

/** Wind-up (s) before a monster's blow resolves: slower monsters telegraph longer. */
export function telegraphSeconds(speed: number, kind: TelegraphKind, f: FeelConstants = FEEL): number {
  if (kind === 'leap') return f.telegraphLeap;
  const base = Math.min(f.telegraphMax, Math.max(f.telegraphMin, f.telegraph * Math.sqrt(100 / Math.max(10, speed))));
  return kind === 'heavy' ? Math.min(f.telegraphMax * f.telegraphHeavyMul, base * f.telegraphHeavyMul) : base;
}

// ------------------------------------------------------------------ active defences

export interface DefenseState {
  /** RMB guard raised (melee weapon or bare hands). */
  guarding: boolean;
  /** Seconds since the guard went up (parry timing). */
  guardAge: number;
  /** Seconds left of the side-step's dodge window. */
  dodgeWindow: number;
  /** Cumulative struggle bonus while grabbed. */
  struggle: number;
  /** Parry window multiplier (free aim: melee skill widens it; PlayerCombat sets it each tick). */
  parryMul?: number;
}

const defenses = new WeakMap<Character, DefenseState>();

/** Per-character active-defence state (the survivor's; NPCs never set it). */
export function defenseOf(c: Character): DefenseState {
  let s = defenses.get(c);
  if (!s) defenses.set(c, (s = { guarding: false, guardAge: 0, dodgeWindow: 0, struggle: 0 }));
  return s;
}

/**
 * Guard -> CDDA block_hit. DDA gates each block on a reaction roll (x_in_y(melee*20, 100));
 * BN blocks whenever a block is left. Holding the guard is the survivor *choosing* to block,
 * so it takes the BN rule: the attempt always happens and blocks don't run out (each still
 * costs stamina, and below 2000 stamina nothing blocks). Returns the attempt chance.
 */
export function blockAttemptChance(meleeSkill: number, guarding: boolean): number {
  if (guarding) return 1;
  return Math.max(0, Math.min(1, (meleeSkill * 20) / 100));
}

/** Block-score bonus from the guard (0 when not guarding); a fresh guard is a parry. */
export function guardScoreBonus(s: Pick<DefenseState, 'guarding' | 'guardAge' | 'parryMul'> | null, f: FeelConstants = FEEL): { bonus: number; parry: boolean } {
  if (!s?.guarding) return { bonus: 0, parry: false };
  const parry = s.guardAge <= parryWindowOf(s, f);
  return { bonus: f.guardBlockBonus + (parry ? f.parryBonus : 0), parry };
}

/** The parry window (s) for this defender: FEEL's, widened by skill in the free-aim models. */
export function parryWindowOf(s: Pick<DefenseState, 'parryMul'> | null, f: FeelConstants = FEEL): number {
  return f.parryWindow * (s?.parryMul ?? 1);
}

/** Side-step -> CDDA dodge_roll: inside the window the roll gets the bonus and needs no dodge left. */
export function sidestepDodgeRoll(dodge: number, s: Pick<DefenseState, 'dodgeWindow'> | null, f: FeelConstants = FEEL): number | null {
  if (!s || s.dodgeWindow <= 0) return null;
  return (Math.max(0, dodge) + f.dodgeBonus) * 5;
}

// ------------------------------------------------------------------ melee control: ready stance

/**
 * How LMB melee works (Options > Melee, `?melee=`, `cdda.setMeleeControl`):
 *  - 'ready'   (default): hold RMB to ready the weapon or fists; LMB swings only while readied.
 *              Readied you walk at FEEL.readyMoveMul and are guarding (block_hit bonus); raising
 *              it just before a blow lands is the parry. In CDDA a swing spends the moves you
 *              would have walked with: free swings while backpedalling at full speed made
 *              kiting a crowd trivial, and the slowdown has to come from a stance the player
 *              chose, never as a surprise on the click.
 *  - 'anytime' (classic): LMB swings whenever, RMB is a separate guard (the pre-stance controls).
 */
export type MeleeControl = 'ready' | 'anytime';
export const MELEE_CONTROLS: readonly { id: MeleeControl; name: string; desc: string }[] = [
  { id: 'ready', name: 'Ready to swing (RMB)', desc: 'hold right mouse to raise your weapon (you walk slower and guard), left click swings while it is up' },
  { id: 'anytime', name: 'Swing any time (classic)', desc: 'left click swings whenever, right mouse is a separate guard' },
];
let meleeControlMode: MeleeControl = 'ready';
export function isMeleeControl(v: unknown): v is MeleeControl {
  return v === 'ready' || v === 'anytime';
}
export function meleeControl(): MeleeControl {
  return meleeControlMode;
}
export function setMeleeControl(m: MeleeControl): void {
  if (!isMeleeControl(m)) throw new Error(`unknown melee control ${String(m)} (use ready or anytime)`);
  meleeControlMode = m;
}

export interface StanceInputs {
  /** RMB held in play (pointer captured by the game, no menu). */
  rmb: boolean;
  /** Actually running (Shift, able to run, a movement key down). */
  running: boolean;
  /** Driving, at a vehicle station, moving furniture: no guard (you can still swing from there, as before). */
  blocked: boolean;
  /** Knocked down: you can still swing from the ground but not guard. */
  downed: boolean;
  /** The survivor's own swing is playing (the guard is down while the weapon is in the arc). */
  swinging: boolean;
}

export interface Stance {
  /** The ready stance is up ('ready' control only): the weapon is shown raised. */
  ready: boolean;
  /** LMB may start a swing now. */
  canSwing: boolean;
  /** Counts as guarding for block_hit (defenseOf(c).guarding). */
  guarding: boolean;
  /** Walk speed multiplier (Player.moveSpeedMul). */
  moveMul: number;
  /** Stamina per second the stance costs. */
  staminaPerSec: number;
}

/**
 * The melee stance for one tick. Running drops the ready stance: Shift lowers the weapon to
 * sprint (full run speed, no swings, no guard) and letting go of Shift with RMB still held
 * raises it again, a fresh raise (so a parry is possible). The alternative, readiness vetoing
 * the run, would leave a player holding RMB unable to flee.
 */
export function meleeStance(i: StanceInputs, mode: MeleeControl = meleeControlMode, f: FeelConstants = FEEL): Stance {
  if (mode === 'anytime') {
    const guarding = i.rmb && !i.blocked && !i.downed && !i.swinging;
    return { ready: false, canSwing: true, guarding, moveMul: guarding ? f.guardMoveMul : 1, staminaPerSec: guarding ? f.guardStaminaPerSec : 0 };
  }
  const ready = i.rmb && !i.running;
  return {
    ready,
    canSwing: ready,
    guarding: ready && !i.blocked && !i.downed && !i.swinging,
    moveMul: ready ? f.readyMoveMul : 1,
    staminaPerSec: ready ? f.readyStaminaPerSec : 0,
  };
}

// ------------------------------------------------------------------ spacing

export interface SurroundMember {
  /** Current bearing from the survivor (yaw convention). */
  angle: number;
  radius: number;
}

/**
 * Spread melee attackers into slots around the survivor: bearings are pushed apart until
 * neighbours at distance `dist` have room for both bodies (plus a hand's width), so a crowd
 * surrounds instead of stacking in one file. Returns desired bearings in input order.
 */
export function surroundAngles(members: readonly SurroundMember[], dist: number, iterations = 12): number[] {
  const n = members.length;
  const out = members.map((m) => m.angle);
  if (n < 2) return out;
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const need = 2 * Math.asin(Math.min(1, (members[i].radius + members[j].radius + 0.12) / (2 * Math.max(0.3, dist))));
        const d = wrap(out[j] - out[i]);
        const gap = Math.abs(d);
        if (gap >= need) continue;
        // Push symmetrically; exact overlap splits by index so the result is deterministic.
        const push = (need - gap) / 2 + 1e-4;
        const s = d === 0 ? (i < j ? 1 : -1) : Math.sign(d);
        out[i] = wrap(out[i] - s * push);
        out[j] = wrap(out[j] + s * push);
        moved = true;
      }
    if (!moved) break;
  }
  return out;
}

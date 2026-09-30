import { FEEL, type FeelConstants } from './combatfeel';

// How the survivor's skill shows up when they aim (the user: "making a player miss their shot
// because their skill isn't high enough really doesn't feel good in FPV").
//
// Three aim models, switchable at runtime (Options > Aim model, `?aim=`, `cdda.setAimModel`):
//
//  - "sway" (default): what you see is what you get. The round leaves along the reticle's ray at
//    the moment you fire; there is no hidden dispersion roll. Skill shows as how hard the
//    reticle is to hold still (a smooth bob-and-weave whose size comes from BN's dispersion
//    formula, plus breathing, fatigue, pain, movement), how hard the gun kicks and how fast it
//    settles, and how much a hit does (damage, weak spots, stagger).
//  - "timing": sway plus optional timing games that reward a well-timed shot: hold your breath
//    while aiming (Shift) and fire on the steady flash, loose an arrow as the draw circle meets
//    the ring, chain melee swings on the ready beat, and an active reload.
//  - "dice": Bright Nights' own model (dispersion rolls, to-hit rolls, "miss: clumsy swing"),
//    kept for comparison.
//
// This module is pure (no DOM, no three.js): the model switch, the sway amplitude and its
// noise, the aim state (sway + kick) the reticle and the shot share, the ray direction for a
// reticle offset, hit zones and the damage a hit does. Rules live in playercombat.ts; the HUD
// in ui/combatHud.ts; wiring in src/aim.ts. Tested in tests/aimmodel.test.ts.

export type AimModelId = 'sway' | 'timing' | 'dice';

export const AIM_MODELS: readonly { id: AimModelId; name: string; desc: string }[] = [
  { id: 'sway', name: 'Steady hands', desc: 'Your shot goes exactly where the crosshair is. Low skill makes the crosshair weave and the gun kick; skill makes hits hit harder.' },
  { id: 'timing', name: 'Steady hands + timing', desc: 'Like Steady hands, plus optional timing: hold your breath (Shift while aiming) and fire on the flash, loose on the ring, chain swings on the beat, active reload (R again in the bright band).' },
  { id: 'dice', name: 'Classic dice', desc: "Bright Nights' own rules: every shot and swing rolls to hit against your skill, so a shot on target can still miss." },
];

let model: AimModelId = 'sway';

export function aimModel(): AimModelId {
  return model;
}

export function isAimModel(v: unknown): v is AimModelId {
  return v === 'sway' || v === 'timing' || v === 'dice';
}

export function setAimModel(m: AimModelId): void {
  if (!isAimModel(m)) throw new Error(`unknown aim model ${String(m)} (expected sway, timing or dice)`);
  model = m;
}

/** The shot goes along the reticle (sway and timing). */
export function freeAim(m: AimModelId = model): boolean {
  return m !== 'dice';
}

/** The optional timing games are on. */
export function timingGames(m: AimModelId = model): boolean {
  return m === 'timing';
}

// ------------------------------------------------------------------ sway amplitude

const MOA = Math.PI / 180 / 60;

export interface SwayInputs {
  /**
   * BN's dispersion without the recoil term (Character::get_weapon_dispersion: gun + ammo,
   * dexterity, hands, skill; times the STR_DRAW multiplier), MOA — the uniform-draw maxima
   * combat.ts dispersionBreakdown sums.
   */
  staticMoa: number;
  /** Current recoil (BN's aim state, MOA; MAX_RECOIL = unaimed) and the sight floor aiming decays it to. */
  recoilMoa: number;
  floorMoa: number;
  /** Average of marksmanship and the weapon skill (what dispersion_from_skill uses). */
  skill: number;
  /** Ground speed (m/s), running, crouching, aim-down-sights blend 0..1. */
  speed: number;
  running: boolean;
  crouching: boolean;
  ads: number;
  pain: number;
  /** stamina / max. */
  stamina: number;
  /** Bows: 'drawing' (not yet full), seconds held at full draw and the steady window. */
  draw?: { full: boolean; heldFull: number; holdSteady: number } | null;
  /** Timing: held breath multiplier (1 = breathing normally). */
  breath?: number;
}

/**
 * How far (radians, roughly the peak of the weave) the reticle wanders. The base is BN's mean
 * sideways error of a shot — the sum of uniform draws averages half its max, times E|cos| = 2/π —
 * so a weapon/skill/dex combination that BN makes miss often weaves as widely as the misses
 * would have been, and a steady marksman barely moves. Unaimed-ness (BN recoil above the sight
 * floor: moving, just raised, just fired) adds a compressed share; posture multiplies.
 */
export function swayAmplitude(i: SwayInputs, f: FeelConstants = FEEL): number {
  const staticRad = ((i.staticMoa / 2) * (2 / Math.PI)) * MOA * f.aimSwayScale;
  const skill = Math.max(0, Math.min(10, i.skill));
  const excess = Math.max(0, Math.min(3000, i.recoilMoa - i.floorMoa));
  const unsteady = excess * MOA * f.aimUnsteady * (1 - 0.05 * skill);
  let a = Math.hypot(staticRad, unsteady);
  a *= 1 - 0.35 * Math.max(0, Math.min(1, i.ads));
  if (i.crouching) a *= 0.8;
  a *= 1 + 0.6 * Math.min(1, i.speed / 3);
  if (i.running) a *= 1.6;
  a *= 1 + Math.min(80, Math.max(0, i.pain)) / 80;
  if (i.stamina < 0.3) a *= 1 + (0.3 - Math.max(0, i.stamina)) * 3;
  const d = i.draw;
  if (d) {
    if (!d.full) a *= 1.8;
    else if (d.heldFull > d.holdSteady) a *= Math.min(3, 1 + (d.heldFull - d.holdSteady) * 0.6);
  }
  a *= i.breath ?? 1;
  return Math.min(8 * (Math.PI / 180), a);
}

/**
 * The weave, a smooth figure-of-eight-ish wander (sums of sines at incommensurate rates, so it
 * never repeats visibly) plus a slow vertical breath. `speed` > 1 weaves faster (low skill).
 * Both axes stay within about ±1.
 */
export function swayNoise(t: number, speed = 1): { x: number; y: number } {
  const u = t * speed;
  const TAU = Math.PI * 2;
  const x = 0.62 * Math.sin(TAU * 0.29 * u + 1.3) + 0.38 * Math.sin(TAU * 0.53 * u + 0.2);
  const y = 0.5 * Math.sin(TAU * 0.41 * u) + 0.25 * Math.sin(TAU * 0.67 * u + 2.1) + 0.25 * Math.sin(TAU * 0.23 * t + 0.7);
  return { x, y };
}

/** How fast the weave moves: an untrained hand wanders faster as well as wider. */
export function swaySpeed(skill: number): number {
  return 1 + 0.6 * (1 - Math.max(0, Math.min(10, skill)) / 10);
}

// ------------------------------------------------------------------ aim state

/**
 * Where the survivor's weapon actually points, relative to the view centre, in screen angles
 * (x right, y up, radians): the sway plus the recoil kick. The HUD draws the reticle there, the
 * viewmodel holds the gun there, and the shot leaves along it. The simulation advances it on
 * its 30 Hz tick; the HUD samples in between with `offset(extra)` and records what it drew, so
 * the shot uses exactly the reticle the player saw when they clicked (`shotOffset`).
 */
export class AimSway {
  /** Weave clock (s), current amplitude (rad) and weave speed. */
  t = 0;
  amp = 0;
  speed = 1;
  /** Recoil kick (rad), springing back at `recover` per second. */
  kickX = 0;
  kickY = 0;
  recover = 5;
  /** Wall-clock ms of the last tick (for HUD interpolation) and the last drawn reticle. */
  tickAt = 0;
  shown: { x: number; y: number; at: number } | null = null;
  /** Off (dice model, no gun): the reticle sits at the centre. */
  active = false;

  /** One simulation tick: ease the amplitude toward `target`, advance the weave, let the kick settle. */
  update(dt: number, target: number, skill: number, f: FeelConstants = FEEL, now = 0): void {
    // The amplitude eases (≈0.15 s) so raising the sights or stopping reads as settling, not a snap.
    this.amp += (target - this.amp) * Math.min(1, dt * 7);
    this.speed = swaySpeed(skill);
    this.t += dt;
    this.recover = f.aimKickRecover + f.aimKickRecoverPerSkill * Math.max(0, Math.min(10, skill));
    const k = Math.exp(-this.recover * dt);
    this.kickX *= k;
    this.kickY *= k;
    this.tickAt = now;
  }

  /** Aim offset `extra` seconds after the last tick (the HUD's in-between frames). */
  offset(extra = 0): { x: number; y: number } {
    const n = swayNoise(this.t + extra, this.speed);
    const k = Math.exp(-this.recover * Math.max(0, extra));
    return { x: n.x * this.amp + this.kickX * k, y: n.y * this.amp + this.kickY * k };
  }

  /** The part of the kick the camera shows (the view jolts; the reticle shows the rest). */
  viewKick(f: FeelConstants = FEEL, extra = 0): { x: number; y: number } {
    const k = Math.exp(-this.recover * Math.max(0, extra)) * f.aimKickView;
    return { x: this.kickX * k, y: this.kickY * k };
  }

  /** Remember what the HUD drew (wall-clock ms), so a click fires along it. */
  markShown(x: number, y: number, at: number): void {
    this.shown = { x, y, at };
  }

  /**
   * The offset a shot fired now leaves along: the reticle the player saw if the HUD drew one in
   * the last ~2 frames, else the simulation's own (tests, the balance sim).
   */
  shotOffset(now = 0, freshMs = 50): { x: number; y: number } {
    const s = this.shown;
    if (s && now > 0 && now - s.at <= freshMs && now >= s.at) return { x: s.x, y: s.y };
    return this.offset(0);
  }

  /** A round's recoil: BN MOA added by the shot -> an upward kick with a little random sideways. */
  kick(addedMoa: number, side: number, f: FeelConstants = FEEL): void {
    const up = Math.min(0.08, Math.max(0, addedMoa) * MOA * f.aimKickScale);
    this.kickY = Math.min(0.14, this.kickY + up);
    this.kickX += up * 0.35 * Math.max(-1, Math.min(1, side));
  }
}

/**
 * The world direction (game yaw/pitch) of a ray leaving the view at screen offset (ox right, oy
 * up) radians from the centre: forward + right·tan(ox) + up·tan(oy), exactly what the camera
 * projects to that pixel. Yaw: 0 = north (−y), clockwise; pitch up positive.
 */
export function aimDirection(yaw: number, pitch: number, ox: number, oy: number): { yaw: number; pitch: number } {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const tx = Math.tan(ox), ty = Math.tan(oy);
  // forward (x east, y south, z up), right, up
  const dx = sy * cp + cy * tx + -sy * sp * ty;
  const dy = -cy * cp + sy * tx + cy * sp * ty;
  const dz = sp + cp * ty;
  return { yaw: Math.atan2(dx, -dy), pitch: Math.atan2(dz, Math.hypot(dx, dy)) };
}

/** Screen pixels from the centre for an angular offset, given the vertical FOV (deg) and the view height (px). */
export function offsetToPixels(o: { x: number; y: number }, fovDeg: number, heightPx: number): { x: number; y: number } {
  const f = heightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
  return { x: Math.tan(o.x) * f, y: -Math.tan(o.y) * f };
}

// ------------------------------------------------------------------ where it hit, and how hard

export type HitZone = 'head' | 'torso' | 'legs';

export interface ZoneTarget {
  size: string;
  type: { bodytype?: unknown; flags: readonly string[] };
}

/**
 * Hit zone from how high on the body the round struck (`hFrac`: 0 = feet, 1 = top of the
 * figure). Upright bodies (BN bodytype human and the like) carry the head on top; animals'
 * heads are up front, which a height alone can't tell, so they only get head hits near the top.
 * NOHEAD monsters have none.
 */
export function defaultHitZone(t: ZoneTarget, hFrac: number): HitZone {
  const flags = t.type.flags;
  const body = typeof t.type.bodytype === 'string' ? t.type.bodytype : 'human';
  const upright = body === 'human' || body === 'angel' || body === 'gorilla' || body === 'bear' || body === 'kangaroo' || body === 'migo';
  if (!flags.includes('NOHEAD') && hFrac >= (upright ? 0.83 : 0.8)) return 'head';
  if (hFrac < (upright ? 0.45 : 0.3)) return 'legs';
  return 'torso';
}

/**
 * The hit-zone hook: real 3D models (render/monsterView) can install their own resolver with
 * exact head/torso/leg volumes; until then the height rule above decides.
 */
export const aimHooks: {
  hitZone: (t: ZoneTarget, hFrac: number) => HitZone;
  /** Visible body of a monster: height (m) and how far its feet are lifted (close-range sprite lift). */
  body: ((m: unknown, dist: number) => { height: number; lift: number } | undefined) | null;
} = { hitZone: defaultHitZone, body: null };

/** Standing height (m) by size when no renderer says otherwise (matches monsterView's glyph heights). */
export const BODY_HEIGHT: Record<string, number> = { tiny: 0.45, small: 0.8, medium: 1.7, large: 2.3, huge: 3.2 };

/** Damage multiplier from the weapon skill: skill 0 lands every visible hit, but softer. */
export function skillDamageMul(skill: number, f: FeelConstants = FEEL): number {
  const s = Math.max(0, Math.min(10, skill)) / 10;
  return f.aimSkillDmg0 + (f.aimSkillDmg10 - f.aimSkillDmg0) * s;
}

/**
 * Chance a hit finds a weak spot (×aimWeakMul). Modelled on BN's crit inputs: the shooter's
 * skill and dex + per (projectile.ts: statAdjust 0.05·(dex+per−16), skillAdjust 0.15·skill).
 */
export function weakSpotChance(skill: number, dex: number, per: number, bonus = 0): number {
  return Math.max(0, Math.min(0.6, 0.04 + 0.025 * Math.max(0, skill) + 0.01 * (dex + per - 16) + bonus));
}

export interface HitQuality {
  zone: HitZone;
  /** Struck the outer edge of the body (BN's grazing band: missed_by > 0.8). */
  graze: boolean;
  weakSpot: boolean;
  /** Timing: a perfectly timed shot/loose/swing. */
  perfect: boolean;
  skill: number;
  /** Named skill for the readout ("marksmanship", "archery", "bashing"). */
  skillName?: string;
}

export interface DamageParts {
  mul: number;
  /** Why the hit was strong or weak, for the crosshair ("HEADSHOT ×2", "graze ×0.5"). */
  parts: { label: string; mul: number }[];
}

/** What a free-aim hit does relative to the round's BN damage. */
export function hitDamageMul(q: HitQuality, f: FeelConstants = FEEL): DamageParts {
  const parts: { label: string; mul: number }[] = [];
  if (q.zone === 'head') parts.push({ label: 'HEADSHOT', mul: f.aimHeadMul });
  else if (q.zone === 'legs') parts.push({ label: 'legs', mul: f.aimLegMul });
  if (q.graze) parts.push({ label: 'graze', mul: f.aimGrazeMul });
  if (q.weakSpot) parts.push({ label: 'weak spot', mul: f.aimWeakMul });
  if (q.perfect) parts.push({ label: 'perfect', mul: f.aimPerfectMul });
  const sk = skillDamageMul(q.skill, f);
  parts.push({ label: `${q.skillName ? `${q.skillName} skill` : 'skill'} ${Math.floor(q.skill)}`, mul: sk });
  // Head + weak spot + perfect would stack to ×4.7: cap it where BN caps a head crit's severity plus a little.
  const mul = Math.min(3, parts.reduce((a, p) => a * p.mul, 1));
  return { mul, parts };
}

/** The crosshair line for a hit: the notable factors, strongest first (skill only when it matters). */
export function describeHit(d: DamageParts): string {
  const shown = d.parts.filter((p) => !/ \d+$/.test(p.label) || Math.abs(p.mul - 1) >= 0.1);
  return shown.map((p) => `${p.label} ×${p.mul.toFixed(p.mul % 1 ? 2 : 0).replace(/0$/, '')}`).join(' · ');
}

// ------------------------------------------------------------------ timing games (the "timing" model)

/**
 * Holding your breath while aiming (timing model): the sway eases to `aimBreathMul` over the
 * settle time; the first moments after it settles are "perfect" (the reticle flashes); held past
 * the limit the hands shake until you breathe again, and you need a moment before the next breath.
 */
export class Breath {
  /** Seconds held (0 = breathing), seconds of recovery left. */
  held = 0;
  recovering = 0;
  static readonly SETTLE = 0.3;
  static readonly MUL = 0.3;

  /** Perfect window (s after settling) and how long the breath lasts, by skill. */
  static perfectWindow(skill: number): number {
    return 0.4 + 0.04 * Math.max(0, Math.min(10, skill));
  }
  static holdLimit(skill: number, stamina: number): number {
    return (2.5 + 0.25 * Math.max(0, Math.min(10, skill))) * (0.5 + 0.5 * Math.max(0, Math.min(1, stamina)));
  }

  update(dt: number, want: boolean, skill: number, stamina: number): void {
    if (this.recovering > 0) {
      this.recovering = Math.max(0, this.recovering - dt);
      this.held = 0;
      return;
    }
    if (!want) {
      if (this.held > 0) this.recovering = Math.min(1.5, 0.4 + this.held * 0.3);
      this.held = 0;
      return;
    }
    this.held += dt;
    // Held a second past the limit: you gasp and must recover.
    if (this.held > Breath.holdLimit(skill, stamina) + 1) {
      this.held = 0;
      this.recovering = 1.5;
    }
  }

  /** Sway multiplier now. */
  mul(skill: number, stamina: number): number {
    if (this.held <= 0) return this.recovering > 0 ? 1.25 : 1;
    const settle = Math.min(1, this.held / Breath.SETTLE);
    const over = this.held - Breath.holdLimit(skill, stamina);
    const base = 1 + (Breath.MUL - 1) * settle;
    return over > 0 ? base + over * 2.5 : base;
  }

  /** In the perfect window right now. */
  perfect(skill: number): boolean {
    return this.held >= Breath.SETTLE && this.held <= Breath.SETTLE + Breath.perfectWindow(skill);
  }

  state(skill: number, stamina: number): 'none' | 'settling' | 'perfect' | 'steady' | 'straining' | 'recovering' {
    if (this.recovering > 0) return 'recovering';
    if (this.held <= 0) return 'none';
    if (this.held < Breath.SETTLE) return 'settling';
    if (this.perfect(skill)) return 'perfect';
    return this.held > Breath.holdLimit(skill, stamina) ? 'straining' : 'steady';
  }
}

/**
 * The bow's release window (timing model): after full draw a ring closes in on the reticle and
 * meets it `delay` s later; loosing within ±half the window of that is perfect. Archery widens it.
 */
export function bowWindow(skill: number): { delay: number; width: number } {
  return { delay: 0.55, width: 0.16 + 0.03 * Math.max(0, Math.min(10, skill)) };
}

export function bowPerfect(heldFull: number, skill: number): boolean {
  const w = bowWindow(skill);
  return Math.abs(heldFull - w.delay) <= w.width / 2;
}

/**
 * Melee rhythm (timing model): a click that lands within this window around the moment the next
 * swing is ready (early clicks are buffered) chains a "perfect" swing.
 */
export function rhythmWindow(skill: number): { early: number; late: number } {
  return { early: 0.12, late: 0.08 + 0.012 * Math.max(0, Math.min(10, skill)) };
}

/**
 * Active reload (timing model): the bright band on the reload bar, as fractions of the reload
 * time. Pressing reload again inside it finishes at once and makes the next shot perfect;
 * pressing outside it fumbles (a delay).
 */
export function reloadBand(skill: number): { start: number; end: number } {
  const w = 0.1 + 0.012 * Math.max(0, Math.min(10, skill));
  const start = 0.42;
  return { start, end: start + w };
}

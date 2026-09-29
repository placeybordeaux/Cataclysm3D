import type { Rng } from '../core/rng';

// Bright Nights Creature::deal_projectile_attack (creature.cpp): how well a projectile lands
// and what that does. BN replaced DDA's hit tiers with a continuous "severity" damage
// multiplier and a hit location drawn from the shooter's steadiness:
//   goodhit = missed_by + dodge_roll / dice(10, projectile speed)  (dodge_roll = dodge × 5)
//   graze > 0.8: 4 × (1 − goodhit) (1–80%, applied before armor); 0.5–0.8: 1.6 − goodhit;
//   0.2–0.5: 1.766 − 4/3 goodhit; ≤ 0.2 (critical): 1.5, plus shooter skill/stats bonus.
//   Location: |goodhit ± variance| ≤ headshot accuracy (0.1; small heads 0.08, tiny 0.05) is
//   the head, ≤ 0.2 torso, then torso/limb odds by band. Severity caps: head ×2 (characters
//   ×1.5), torso ×1.5, limbs ×1.25, PROJECTILE_RESISTANT_n caps; NO_CRIT caps at ×1.1.
// Pure and UI-free: callers (player shots, monster guns) apply damage and messages.

export const ACCURACY = { headshot: 0.1, critical: 0.2, goodhit: 0.5, standard: 0.8, grazing: 1 } as const;
/** Projectile speed of gun rounds (ranged.cpp make_gun_projectile). */
export const GUN_PROJECTILE_SPEED = 1000;

export type HitLocation = 'head' | 'torso' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r';

export interface ProjectileShooter {
  dex: number;
  per: number;
  /** Weapon skill (gun skill, or throw for thrown attacks). */
  skill: number;
  /** Player: stamina / max stamina; NPC: hp fraction capped at 0.8 (BN's harsher rule). */
  steadiness: number;
  isPlayer: boolean;
}

export interface ProjectileTarget {
  /** dodge_roll(): get_dodge() × 5. */
  dodgeRoll: number;
  /** Characters split their health per part: head severity caps at 1.5. */
  isCharacter: boolean;
  /** Monster flags: NOHEAD, SMALL_HEAD, TINY_HEAD, NO_HEAD_BONUS_CRIT, HEAD_BONUS_MAX_CRIT_1/2, TORSO_BONUS_MAX_CRIT_1/2, PROJECTILE_RESISTANT_1..4. */
  flags?: readonly string[];
}

export interface ProjectileOpts {
  /** 0 = dead centre, ≥ 1 = miss. */
  missedBy: number;
  speed?: number;
  /** A monster's gun actor (`no_crits`) or NO_CRIT ammo. */
  noCrit?: boolean;
  /** ammo `critical_multiplier`-style aimedcritbonus / aimedcritmaxbonus. */
  severityBonus?: number;
  severityMaxBonus?: number;
  /** Character or NPC shooter; monsters and spells have none (full variance, no skill bonus). */
  shooter?: ProjectileShooter | null;
}

export interface ProjectileHit {
  /** false: "You avoid …" (goodhit ≥ 1). */
  hit: boolean;
  goodhit: number;
  severity: number;
  location: HitLocation;
  /** Grazes multiply damage before armor. */
  graze: boolean;
  /** ranged.cpp character_gets_headshot: missed_by ≤ 0.1 on a creature. */
  headshot: boolean;
  /** print_dmg_msg tag: "Critical!" (< 0.2) / "Grazing hit." (> 0.8). */
  tag: '' | 'Critical!' | 'Grazing hit.';
}

const limb = (rng: Rng): HitLocation => (rng.oneIn(2) ? (rng.oneIn(2) ? 'leg_l' : 'leg_r') : rng.oneIn(2) ? 'arm_l' : 'arm_r');

export function projectileHit(target: ProjectileTarget, o: ProjectileOpts, rng: Rng): ProjectileHit {
  const flags = target.flags ?? [];
  const has = (f: string) => flags.includes(f);
  const speed = o.speed ?? GUN_PROJECTILE_SPEED;
  const dodge = target.dodgeRoll / Math.max(1, rng.dice(10, speed));
  const goodhit = o.missedBy + Math.max(0, Math.min(1, dodge < 0.01 ? 0 : dodge));
  const headshot = o.missedBy <= ACCURACY.headshot;
  if (goodhit >= 1) return { hit: false, goodhit, severity: 0, location: 'torso', graze: false, headshot: false, tag: '' };
  let severity: number;
  if (goodhit > ACCURACY.standard) severity = Math.max(0.01, 4 * (1 - goodhit));
  else if (goodhit > ACCURACY.goodhit) severity = 1.6 - goodhit;
  else if (goodhit > ACCURACY.critical) severity = 1.766 - (goodhit * 4) / 3;
  else severity = 1.5;
  let variance = 0.9;
  const s = o.shooter;
  if (s) {
    const statAdjust = 0.05 * (s.dex + s.per - 16);
    const skillAdjust = s.skill * (s.isPlayer ? 0.15 : 0.1);
    variance = Math.max(0.05, Math.min(0.9, variance - (statAdjust + skillAdjust) * s.steadiness));
    if (!o.noCrit && goodhit <= ACCURACY.critical) severity += (skillAdjust + Math.max(0, statAdjust)) * ((0.2 - goodhit) * 5);
  }
  const headAcc = has('TINY_HEAD') ? 0.05 : has('SMALL_HEAD') ? 0.08 : ACCURACY.headshot;
  const hv = Math.abs(goodhit + (rng.next() * 2 - 1) * variance);
  let location: HitLocation;
  if (hv <= headAcc && !has('NOHEAD')) location = 'head';
  else if (hv <= ACCURACY.critical) location = 'torso';
  else if (hv <= ACCURACY.goodhit) location = !rng.oneIn(5) ? 'torso' : limb(rng);
  else if (hv <= ACCURACY.standard) location = rng.oneIn(2) ? 'torso' : limb(rng);
  else location = rng.oneIn(5) ? 'torso' : limb(rng);
  const bonus = o.severityBonus ?? 0, maxBonus = o.severityMaxBonus ?? 0;
  if (goodhit <= ACCURACY.standard) severity += bonus;
  if (location === 'head') {
    if (target.isCharacter || has('NO_HEAD_BONUS_CRIT')) severity = Math.min(severity, 1.5 + maxBonus);
    else if (has('HEAD_BONUS_MAX_CRIT_1') || has('HEAD_BONUS_MAX_CRIT_2')) severity = Math.min(severity, 2 + maxBonus + (has('HEAD_BONUS_MAX_CRIT_1') ? 0.5 : 1));
    else severity = Math.min(severity, 2 + maxBonus);
  } else {
    const pos = Math.max(0, maxBonus);
    if (has('PROJECTILE_RESISTANT_4')) severity = Math.min(severity, 0.2 + pos);
    else if (has('PROJECTILE_RESISTANT_3')) severity = Math.min(severity, 0.5 + pos);
    else if (has('PROJECTILE_RESISTANT_2')) severity = Math.min(severity, 0.8 + pos);
    else if (has('PROJECTILE_RESISTANT_1')) severity = Math.min(severity, 1.1 + pos);
    else if (location === 'torso') severity = Math.min(severity, has('TORSO_BONUS_MAX_CRIT_2') ? 2 + maxBonus : has('TORSO_BONUS_MAX_CRIT_1') ? 1.75 + maxBonus : 1.5 + maxBonus);
    else severity = Math.min(severity, 1.25 + maxBonus);
  }
  severity = Math.max(0, severity);
  if (o.noCrit) severity = Math.min(severity, 1.1);
  const tag = goodhit > ACCURACY.standard ? 'Grazing hit.' : goodhit < ACCURACY.critical ? 'Critical!' : '';
  return { hit: true, goodhit, severity, location, graze: goodhit > ACCURACY.standard, headshot, tag };
}

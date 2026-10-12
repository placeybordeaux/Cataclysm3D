import type { Rng } from '../core/rng';
import { BODY_PARTS, type BodyPartId } from './bodyparts';
import { aimHooks, defaultHitZone, hitDamageMul, weakSpotChance, zoneOfPart, type HitZone, type Vec3 } from './aimmodel';
import type { ShotResult } from './combat';
import type { Item } from './item';
import type { Npc } from './npc';
import type { NpcSystem } from './npcai';
import { CREATURE_RADIUS } from './physics';
import { projectileHit } from './projectile';
import { liftOf } from './stairwalk';
import { sfx } from '../audio/sfx';
import { LEVEL_HEIGHT } from '../world/coords';

// The survivor's projectiles against NPCs. BN ballistics.cpp projectile_attack walks the round
// along its path and hands it to *any* critter it meets (`g->critter_at(tp)`): the aimed-at
// NPC, a neutral, or a follower in the way. Here PlayerCombat asks the helpers below which NPC
// body a ray / pellet / arrow segment enters (the drawn 3D person when there is one, via
// aimHooks.pickNpc, else a 1.75 m column), compares it with the monster and wall it would
// otherwise reach, and resolves the nearest. Each pellet is its own projectile, as in BN's
// multi-projectile loop: own path, own body part, own armor roll, own damage.
//
// Consequences follow BN, which treats stray hits differently from shooting at someone:
// - target_ui::on_target_accepted (ranged.cpp) makes the NPC you *aimed at* angry (make_angry,
//   with its faction) — the port's attack confirmation does that before the shot, and a hit on
//   the intended NPC still runs the player-attack path in NpcSystem.afterHit.
// - Creature::deal_projectile_attack never calls npc::on_attacked, so an NPC caught by a stray
//   round (a follower behind your target, a neutral beside it) takes the damage without turning
//   hostile. A kill is still yours (deal_damage credits the source).
// - ballistics.cpp skips creatures friendly to the shooter within one tile of it ("prevent
//   adjacent friendly fire"), so a follower at your shoulder is never hit.
// - drop_or_embed_projectile only embeds in monsters: an arrow that hits a person drops at
//   their feet (PlayerCombat.placeRound).

/** The drawn height of a standing NPC (render/npcView.ts HEIGHT). */
export const NPC_BODY_HEIGHT = 1.75;

/** What the geometry needs of an NPC (Npc satisfies it; tests may pass plain objects). */
export interface NpcBody {
  x: number;
  y: number;
  z: number;
  dead?: boolean;
  isFriendly?: () => boolean;
  effects?: { has(id: string): boolean };
  isAsleep?: () => boolean;
}

/** Where a projectile entered an NPC. `s` is plan metres from the ray's origin. */
export interface NpcRayHit {
  n: NpcBody;
  s: number;
  /** 0 = dead centre, 1 = the edge of the body (BN missed_by). */
  missedBy: number;
  zone: HitZone;
  /** The model part it entered (free aim with a drawn model), for the body part. */
  part?: string;
}

/**
 * BN ballistics.cpp: "Skip friendly creatures within 1 tile of shooter to prevent adjacent
 * friendly fire" (rl_dist on tiles, square distance).
 */
export function sparedAtShoulder(shooter: { x: number; y: number; z: number }, n: NpcBody): boolean {
  if (!n.isFriendly?.() || n.z !== shooter.z) return false;
  return Math.max(Math.abs(Math.floor(n.x) - Math.floor(shooter.x)), Math.abs(Math.floor(n.y) - Math.floor(shooter.y))) <= 1;
}

function bodyHeight(n: NpcBody): number {
  return n.effects?.has('downed') || n.isAsleep?.() ? NPC_BODY_HEIGHT * 0.5 : NPC_BODY_HEIGHT;
}

const HUMAN_ZONE = { size: 'medium', type: { bodytype: 'human', flags: [] as string[] } };

/**
 * The first NPC body a free-aim ray enters before plan distance `limit` (from `o`), as
 * PlayerCombat.castAim tests monsters: the drawn model's part boxes, else the body's column
 * (feet to top, 1.1 × the collision radius for the shoulders) zoned by height.
 */
export function npcOnRay(
  npcs: readonly NpcBody[], o: Vec3, yaw: number, pitch: number, limit: number,
  opts: { shooter: { x: number; y: number; z: number }; skip?: (n: NpcBody) => boolean },
): NpcRayHit | null {
  const hx = Math.sin(yaw), hy = -Math.cos(yaw);
  const cp = Math.max(0.02, Math.cos(pitch));
  const slope = Math.tan(pitch);
  const dir: Vec3 = { x: hx * cp, y: hy * cp, h: Math.sin(pitch) };
  const pick = aimHooks.pickNpc;
  const R = CREATURE_RADIUS * 1.1;
  let best: NpcRayHit | null = null, bestS = limit;
  for (const n of npcs) {
    if (n.dead || n.z !== opts.shooter.z || opts.skip?.(n) || sparedAtShoulder(opts.shooter, n)) continue;
    const ox = n.x - o.x, oy = n.y - o.y;
    const t = ox * hx + oy * hy;
    const reach = pick ? Math.max(R * 2.5, 1) : R;
    if (t <= 0 || t - reach > bestS) continue;
    const perp = Math.abs(ox * hy - oy * hx);
    if (perp > reach) continue;
    const model = pick?.(n, o, dir);
    if (model === null) continue;
    if (model) {
      const s = model.t * cp;
      if (s <= 0.05 || s >= bestS) continue;
      bestS = s;
      best = { n, s, missedBy: 0, zone: model.zone, part: model.part };
      continue;
    }
    if (perp > R) continue;
    const half = Math.sqrt(R * R - perp * perp);
    let s0 = Math.max(0.05, t - half), s1 = t + half;
    const foot = n.z * LEVEL_HEIGHT + liftOf(n), height = bodyHeight(n);
    const lo = foot - o.h, hi = foot + height - o.h;
    if (Math.abs(slope) < 1e-9) {
      if (lo > 0 || hi < 0) continue;
    } else {
      let a = lo / slope, c = hi / slope;
      if (a > c) [a, c] = [c, a];
      s0 = Math.max(s0, a);
      s1 = Math.min(s1, c);
    }
    if (s0 > s1 || s0 >= bestS) continue;
    bestS = s0;
    const hFrac = Math.max(0, Math.min(1, (o.h + slope * s0 - foot) / height));
    best = { n, s: s0, missedBy: perp / R, zone: defaultHitZone(HUMAN_ZONE, hFrac) };
  }
  return best;
}

/**
 * The classic (dice) hitscan line, as PlayerCombat.castRay tests monsters: plan only, an NPC is
 * in the way when the line passes within its collision radius.
 */
export function npcOnLine(
  npcs: readonly NpcBody[], x0: number, y0: number, yaw: number, limit: number,
  opts: { shooter: { x: number; y: number; z: number }; skip?: (n: NpcBody) => boolean },
): NpcRayHit | null {
  const dx = Math.sin(yaw), dy = -Math.cos(yaw);
  let best: NpcRayHit | null = null, bestT = limit;
  for (const n of npcs) {
    if (n.dead || n.z !== opts.shooter.z || opts.skip?.(n) || sparedAtShoulder(opts.shooter, n)) continue;
    const ox = n.x - x0, oy = n.y - y0;
    const t = ox * dx + oy * dy;
    if (t <= 0 || t > bestT) continue;
    const perp = Math.abs(ox * dy - oy * dx);
    if (perp > CREATURE_RADIUS) continue;
    bestT = t;
    best = { n, s: t, missedBy: perp / CREATURE_RADIUS, zone: 'torso' };
  }
  return best;
}

/**
 * One step of an arrow's arc (PlayerCombat.stepFlight): the first NPC whose body the segment
 * from plan distance `s0` to `end` reaches, nearer than `limit`. `heightAt(s)` is the arc's
 * height above the flight's floor; `seg` the step as a straight 3D segment for the model test.
 */
export function npcOnArc(
  npcs: readonly NpcBody[],
  f: { x0: number; y0: number; z: number; dx: number; dy: number },
  s0: number, end: number, limit: number, heightAt: (s: number) => number,
  opts: { shooter: { x: number; y: number; z: number }; seg?: { o: Vec3; d: Vec3; n: number }; skip?: (n: NpcBody) => boolean },
): NpcRayHit | null {
  const pick = opts.seg ? aimHooks.pickNpc : null;
  const R = CREATURE_RADIUS * (opts.seg ? 1.1 : 1) + (opts.seg ? 0 : 0.05);
  let best: NpcRayHit | null = null, bestS = limit;
  for (const n of npcs) {
    if (n.dead || n.z !== f.z || opts.skip?.(n) || sparedAtShoulder(opts.shooter, n)) continue;
    const ox = n.x - f.x0, oy = n.y - f.y0;
    const t = ox * f.dx + oy * f.dy;
    const perp = Math.abs(ox * f.dy - oy * f.dx);
    if (pick && opts.seg) {
      const reach = Math.max(R * 2.5, 1);
      if (!(t + reach > s0 && t - reach <= end && perp <= reach)) continue;
      const r = pick(n, opts.seg.o, opts.seg.d);
      if (r === null) continue;
      if (r) {
        const sh = s0 + r.t / opts.seg.n;
        if (sh > end || sh >= bestS) continue;
        bestS = sh;
        best = { n, s: sh, missedBy: 0, zone: r.zone, part: r.part };
        continue;
      }
    }
    if (t <= s0 || t > end || t >= bestS || perp > R) continue;
    const lift = liftOf(n), height = bodyHeight(n);
    const h = heightAt(t);
    if (h < lift || h > lift + height) continue;
    bestS = t;
    best = { n, s: t, missedBy: perp / R, zone: defaultHitZone(HUMAN_ZONE, (h - lift) / height) };
  }
  return best;
}

// ------------------------------------------------------------------ resolving a hit

/** One projectile (a round, a pellet, an arrow) that reached the NPC. */
export interface NpcProjectileHit {
  missedBy: number;
  zone: HitZone;
  part?: string;
}

export interface NpcProjectile {
  /** One per projectile that reached this NPC (pellets each separately). */
  hits: NpcProjectileHit[];
  /** Damage of each projectile (a pellet's own damage for multi-projectile shots). */
  damage: ShotResult['damage'];
  /** The ammo's name for arrows, bolts and stones ("Your arrow hits ..."); null for gun rounds. */
  what: string | null;
  /** Free aim: the place it entered decides (no dice); classic: BN deal_projectile_attack. */
  free: boolean;
  perfect: boolean;
  gun: Item;
  /** Projectile speed for BN's dodge roll (ranged.cpp: guns 1000; arrows their ammo speed). */
  speed: number;
  /** The NPC the survivor was shooting at (BN on_target_accepted); false for a stray hit. */
  intended: boolean;
  /** One pellet of a multi-projectile shot (the log counts projectiles even when one hits). */
  multi?: boolean;
}

export interface NpcProjectileResult {
  /** Damage after armor, all projectiles. */
  total: number;
  /** Projectiles that struck (dodged ones fly on, see PlayerCombat). */
  landed: number;
  dodged: number;
  head: boolean;
  dead: boolean;
}

/** BN deal_projectile_attack hits only head, torso, arms and legs; a model part maps onto them. */
export function bodyPartOfModelPart(part: string): BodyPartId {
  if (/^(head|neck|jowls)/.test(part)) return 'head';
  if (/^(uArm|fArm|hand)R/.test(part) || part === 'weapon') return 'arm_r';
  if (/^(uArm|fArm|hand)L/.test(part)) return 'arm_l';
  if (/^(thigh|shin|foot)R/.test(part)) return 'leg_r';
  if (/^(thigh|shin|foot)L/.test(part)) return 'leg_l';
  return 'torso';
}

function bodyPartOfZone(zone: HitZone, rng: Rng): BodyPartId {
  if (zone === 'head') return 'head';
  if (zone === 'legs') return rng.oneIn(2) ? 'leg_l' : 'leg_r';
  if (zone === 'limb') return rng.oneIn(2) ? 'arm_l' : 'arm_r';
  return 'torso';
}

/**
 * BN caps a projectile's severity by where it lands, and characters (split health pools) at
 * ×1.5 on the head (creature.cpp deal_projectile_attack): head 1.5, torso 1.5, limbs 1.25.
 */
const CHARACTER_SEVERITY_CAP: Record<string, number> = { head: 1.5, torso: 1.5 };

/** BN projectile.cpp multi_projectile_hit_message quantity words. */
export function projectileCount(n: number): string {
  return n === 1 ? 'a' : n <= 2 ? 'several' : n <= 5 ? 'many' : n <= 20 ? 'a large number of' : 'a huge number of';
}

/**
 * Apply the survivor's projectiles to NPC `n`: per projectile a body part, BN's severity (or the
 * free-aim zone multiplier), the NPC's worn armor once (Inventory.absorbHit) and its part HP
 * (takeHit). Then NpcSystem.afterHit: death and loot credited to the survivor; anger only for
 * the NPC that was shot at (see the header).
 */
export function playerProjectileHitsNpc(sys: NpcSystem, n: Npc, o: NpcProjectile): NpcProjectileResult {
  const game = sys.game;
  const p = game.player;
  const rng = sys.rng;
  const skillId = String(o.gun.def.skill ?? 'gun');
  const skill = p.getSkill(skillId);
  let total = 0, landed = 0, dodged = 0, head = false;
  const parts: BodyPartId[] = [];
  for (const h of o.hits) {
    if (n.dead) break;
    let bp: BodyPartId;
    let units: { type: string; amount: number; armor_penetration: number; armor_multiplier: number; multiplier?: number }[];
    if (o.free) {
      bp = h.part ? bodyPartOfModelPart(h.part) : bodyPartOfZone(h.zone, rng);
      const weak = rng.next() < weakSpotChance(skill, p.dex, p.per, o.perfect ? 0.25 : 0);
      // The zone already chose the body part (and its own HP pool); the remaining factors are
      // capped where BN caps a character's severity for that part.
      const q = hitDamageMul({ zone: 'torso', graze: h.missedBy > 0.8, weakSpot: weak, perfect: o.perfect, skill });
      const mul = Math.min(q.mul, CHARACTER_SEVERITY_CAP[bp] ?? 1.25);
      units = o.damage.map((d) => ({ type: d.type, amount: d.amount * mul, armor_penetration: d.armor_penetration, armor_multiplier: 1 }));
    } else {
      const r = projectileHit(
        { dodgeRoll: n.dodge() * 5, isCharacter: true },
        { missedBy: h.missedBy, speed: o.speed, shooter: { dex: p.dex, per: p.per, skill, steadiness: Math.max(1, p.stamina) / Math.max(1, p.staminaMax()), isPlayer: true } },
        rng,
      );
      if (!r.hit) {
        dodged++;
        continue;
      }
      bp = r.location;
      units = o.damage.map((d) => ({ type: d.type, amount: d.amount * r.severity, armor_penetration: d.armor_penetration, armor_multiplier: 1, multiplier: r.graze ? 1 : r.severity }));
    }
    const absorbed = n.inv.absorbHit(bp, units, rng);
    const saved = n.onMessage;
    n.onMessage = null;
    let dealt: number;
    try {
      dealt = n.takeHit(bp, absorbed).damage;
    } finally {
      n.onMessage = saved;
    }
    total += dealt;
    landed++;
    parts.push(bp);
    if (bp === 'head') head = true;
  }
  const many = o.multi || o.hits.length > 1;
  if (dodged && !landed) sys.message(`${n.name} avoids your projectile${many ? 's' : ''}.`);
  else if (landed) {
    if (many) sys.message(`${n.name} is hit by ${projectileCount(landed)} ${landed === 1 ? 'projectile' : 'projectiles'}, ${total > 0 ? `dealing ${total} damage` : 'but they deal no damage'}.`);
    else {
      const where = BODY_PARTS[parts[0]].name;
      const what = o.what ? `Your ${o.what} hits` : 'You shoot';
      sys.message(total > 0 ? `${what} ${n.name} in the ${where} for ${total} damage.` : `${o.what ? `Your ${o.what}` : 'The shot'} glances off ${n.name}'s ${where}!`);
    }
    if (o.what) sfx.arrowHit('flesh', n);
    else sfx.bulletHit('flesh', n);
  }
  sys.afterHit(n, total, { kind: 'player', stray: !o.intended });
  return { total, landed, dodged, head, dead: !!n.dead };
}

/** PlayerCombat.npcFire for the game's NPCs (npcs.ts wires it; tests too). */
export interface NpcFireHooks {
  bodies(): readonly NpcBody[];
  hit(n: NpcBody, o: NpcProjectile): NpcProjectileResult;
}

export function npcFireHooks(sys: NpcSystem): NpcFireHooks {
  return {
    bodies: () => sys.npcs,
    hit: (n, o) => playerProjectileHitsNpc(sys, n as Npc, o),
  };
}

import type { DamageUnit } from '../data/types';
import { monsterName } from '../data/index';
import { warnOnce } from '../data/warn';
import { gunActor } from './monguns';
import { monsterCanAttackHigh, monsterMeleeAttack, selectBodyPart, type MonsterAttackResult } from './combat';
import { BODY_PARTS, isBodyPart, type BodyPartId } from './bodyparts';
import { SIZE_RANK, turnsToEffectSeconds, turnsToSeconds, type Monster, type SpecialAttackState } from './monster';
import type { MonsterSystem } from './monai';
import { sfx } from '../audio/sfx';
import { FEEL, defenseOf, type TelegraphKind } from './combatfeel';
import { blockHit, grabBreakTechnique } from './techniques';

// Monster special attacks as Cataclysm: Bright Nights runs them: the hardcoded functions of
// monattack.cpp (GRAB, SHRIEK, ACID, BOOMER, SMASH, RESURRECT, …, looked up by id) and the
// data-driven actors of mattack_actors.cpp (melee / bite / leap / gun / spell / deployer, and
// named JSON `monster_attack`s like "scratch" that are melee actors). Each returns true when
// performed, which puts it on cooldown (turns) and makes the monster busy for its move cost.
//
// BN attacks carry no dialogue conditions (DDA's grab/bite `condition` objects are gone): a
// bite infects only a target that is already grabbed, and grabbing is the GRAB function.
// Only the player is a target; monster-vs-monster fights (dogs vs zombies) are a gap.

/** CDDA/BN "%1$s grabs your %2$s!" style formatting. */
export function fmt(template: string, ...args: string[]): string {
  let i = 0;
  return template.replace(/%(\d)\$[sd]|%[sd]/g, (m, n) => (n ? args[Number(n) - 1] : args[i++]) ?? m);
}

function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { str?: string }).str === 'string') return (v as { str: string }).str;
  return undefined;
}

/** monster::name(): what BN's "The %s …" templates are filled with ("zombie", or a unique name). */
function mname(m: Monster): string {
  return m.name ?? monsterName(m.type);
}

/**
 * Condition evaluator kept for the gun actor's targeting hook (monguns.ts). BN special attacks
 * have no dialogue conditions, so anything given here is a DDA leftover: true when absent,
 * otherwise a warning and false.
 */
export function evalCondition(_sys: MonsterSystem, _m: Monster, cond: unknown): boolean {
  if (cond === undefined || cond === null) return true;
  warnOnce('attack_condition', JSON.stringify(cond).slice(0, 80));
  return false;
}

/** Run `fn` with the player's message sink muted, so we can print BN's attack-specific text instead. */
function quiet<T>(sys: MonsterSystem, fn: () => T): T {
  const p = sys.game.player;
  const sink = p.onMessage;
  p.onMessage = () => {};
  try {
    return fn();
  } finally {
    p.onMessage = sink;
  }
}

function asUnits(v: unknown): DamageUnit[] | undefined {
  if (!v) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr.filter((u): u is DamageUnit => !!u && typeof u === 'object' && typeof (u as DamageUnit).damage_type === 'string');
  return out.length ? out : undefined;
}

/** Is this special attack a melee blow (melee/bite actor or a JSON monster_attack melee)? */
function isActor(d: SpecialAttackState['def']): 'melee' | 'bite' | null {
  if (d.attack_type === 'bite' || d.type === 'bite') return 'bite';
  if (d.attack_type === 'melee' || d.type === 'melee') return 'melee';
  return null;
}

/** Hardcoded attacks that are blows at an adjacent target (wait for the swing cooldown). */
const MELEE_HARDCODED = new Set(['GRAB', 'GRAB_DRAG', 'SMASH', 'LUNGE', 'LONGSWIPE', 'ACID_BARF']);

/** Special attacks that spend a melee swing (monai waits for the swing cooldown before them). */
export function isMeleeSpecial(d: SpecialAttackState['def']): boolean {
  return !!isActor(d) || MELEE_HARDCODED.has(d.id);
}

/**
 * mattack::dodge_check: dodge = max(target dodge - rng(0, melee skill), 0);
 * rng(0, 10000) < 10000 / (1 + 99 e^(-0.6 dodge)). A combat-feel side-step adds its bonus.
 */
export function dodgeCheck(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  if (p.hasEffect('downed')) return false;
  const bonus = defenseOf(p).dodgeWindow > 0 ? FEEL.dodgeBonus : 0;
  const dodge = Math.max(p.dodge() + bonus - sys.rng.int(0, Math.max(0, m.type.melee_skill)), 0);
  return sys.rng.int(0, 10000) < 10000 / (1 + 99 * Math.exp(-0.6 * dodge));
}

/** Weighted `body_parts` of a melee actor ([["torso", 4], …]), else null. */
function pickBodyPart(sys: MonsterSystem, list: unknown): BodyPartId | null {
  if (!Array.isArray(list)) return null;
  const entries = (list as [string, number][]).filter(([bp]) => isBodyPart(bp)) as [BodyPartId, number][];
  return entries.length ? sys.rng.weighted(entries) : null;
}

/**
 * melee_actor / bite_actor (mattack_actors.cpp): damage = damage_max_instance (default 9
 * bash) × rng_float(min_mul 0, max_mul 1), accuracy defaults to melee_skill, body part from
 * `body_parts` or the hit roll. Effects apply only when damage got through. A bite infects
 * (effect "bite") only a grabbed target: one_in(no_infection_chance (14) - damage).
 */
export function meleeActor(sys: MonsterSystem, m: Monster, sa: SpecialAttackState, bite: boolean): boolean {
  const d = sa.def;
  const p = sys.game.player;
  if (!meleeActorReady(sys, m, sa)) return false;
  const name = mname(m);
  const mul = (d.min_mul ?? 0) + sys.rng.next() * ((d.max_mul ?? 1) - (d.min_mul ?? 0));
  const units = (asUnits(d.damage_max_instance) ?? [{ damage_type: 'bash', amount: 9 }]).map((u) => ({ ...u, amount: u.amount * mul }));
  const bp: BodyPartId = pickBodyPart(sys, d.body_parts) ?? selectBodyPart(sys.rng, { canAttackHigh: monsterCanAttackHigh(m.type) });
  const res: MonsterAttackResult = quiet(sys, () =>
    monsterMeleeAttack(m.type, p, sys.rng, { accuracy: typeof d.accuracy === 'number' ? d.accuracy : m.type.melee_skill + m.hitBonus(), damage: units, bp, name: m.TheName() }),
  );
  const hitBp = res.bp ?? bp;
  const part = BODY_PARTS[hitBp].name;
  if (!res.hit) {
    sys.message(fmt(textOf(d.miss_msg_u) ?? 'The %s lunges at you, but you dodge!', name));
    if (bite) sfx.monsterBite(false, m);
    return true;
  }
  const dealt = res.result?.damage ?? 0;
  if (dealt > 0) {
    sys.message(fmt(textOf(d.hit_dmg_u) ?? 'The %1$s bites your %2$s!', name, part), 'c_red');
    for (const e of (d.effects ?? []) as { id: string; chance?: number; duration?: number; affect_hit_bp?: boolean; bp?: string; permanent?: boolean }[]) {
      if (!sys.rng.chance(e.chance ?? 100)) continue;
      const effBp = e.affect_hit_bp ? hitBp : e.bp && isBodyPart(e.bp) ? e.bp : undefined;
      p.addEffect(e.id, turnsToEffectSeconds(e.duration ?? 1), { bp: effBp, permanent: e.permanent });
    }
    if (bite) biteInfection(sys, hitBp, dealt, typeof d.no_infection_chance === 'number' ? d.no_infection_chance : 14);
  } else {
    sys.message(fmt(textOf(d.no_dmg_msg_u) ?? 'The %1$s bites your %2$s, but fails to penetrate armor!', name, part));
  }
  if (bite) sfx.monsterBite(dealt > 0, m);
  else sfx.monsterHit(m);
  sys.onPlayerHurt(m, dealt, hitBp);
  if (res.block?.parry) parried(sys, m);
  return true;
}

/** bite_actor::on_damage: a grabbed target's wound may get infected. */
export function biteInfection(sys: MonsterSystem, bp: BodyPartId, damage: number, noInfectionChance = 14): boolean {
  const p = sys.game.player;
  if (!p.hasEffect('grabbed') || !sys.rng.oneIn(Math.max(1, noInfectionChance - damage))) return false;
  if (p.hasEffect('bite', bp)) p.addEffect('bite', 40 * 60, { bp });
  else if (p.hasEffect('infected', bp)) p.addEffect('infected', 25 * 60, { bp });
  else p.addEffect('bite', 1, { bp });
  return true;
}

/** Can this melee/bite actor hit right now (adjacent target)? */
export function meleeActorReady(sys: MonsterSystem, m: Monster, sa: SpecialAttackState): boolean {
  const range = typeof sa.def.range === 'number' ? sa.def.range : 1;
  return sys.inMeleeRange(m, range);
}

/** The survivor parried: the attacker is knocked off balance for a moment. */
function parried(sys: MonsterSystem, m: Monster): void {
  m.addEffect('stunned', FEEL.parryStun);
  sfx.parry(m);
}

/**
 * How a special attack is telegraphed before it resolves (combatfeel.ts): a TelegraphKind when
 * it is a blow at the survivor that could land now (the caller winds up, then calls
 * trySpecial), null when it is such a blow but can't land now, undefined for attacks that
 * aren't telegraphed this way (ranged specials, shrieks, guns — they go straight to trySpecial).
 */
export function specialTelegraph(sys: MonsterSystem, m: Monster, sa: SpecialAttackState): TelegraphKind | null | undefined {
  const d = sa.def;
  const heavy = SIZE_RANK[m.size] > 3;
  if (isActor(d)) return meleeActorReady(sys, m, sa) ? (heavy ? 'heavy' : 'melee') : null;
  if (d.type === 'leap' || d.attack_type === 'leap') return leapReady(sys, m, d) ? 'leap' : null;
  switch (d.id) {
    case 'SMASH':
      return sys.inMeleeRange(m, 1) ? 'heavy' : null;
    case 'GRAB':
    case 'GRAB_DRAG':
    case 'ACID_BARF':
    case 'LUNGE':
      return sys.inMeleeRange(m, 1) ? (heavy ? 'heavy' : 'melee') : null;
    case 'LONGSWIPE':
      return sys.inMeleeRange(m, 1) ? 'melee' : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- grabs

/**
 * mattack::grab: dodge_check → "gropes at you, but you dodge!"; a grab-break roll
 * rng(0, dex) > rng(0, dice + sides) bats it away; else the target is grabbed (effect
 * intensity += grab_strength, default 1) and takes a plain melee hit. Combat-feel rule on
 * top: when that hit is parried (guard raised in time) the grab never takes hold.
 */
function grab(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  if (!sys.inMeleeRange(m, 1)) return false;
  const name = mname(m);
  if (dodgeCheck(sys, m)) {
    m.busy = Math.max(m.busy, turnsToSeconds(40 / m.speed));
    sys.message(fmt('The %s gropes at you, but you dodge!', name));
    p.practice('dodge', Math.max(1, m.type.melee_skill * 2), m.type.melee_skill);
    return true;
  }
  // Only a martial-arts grab_break technique (can_use_grab_break_tec) gets the dexterity roll.
  if (grabBreakTechnique(p) && sys.rng.int(0, p.dex) > sys.rng.int(0, m.type.melee_dice + m.type.melee_dice_sides)) {
    sys.message(fmt(p.hasEffect('grabbed') ? 'The %s tries to grab you as well, but you bat it away!' : 'The %s tries to grab you, but you break its grab!', name));
    return true;
  }
  // "A hit to use up our moves" — resolved first here so a parry can stop the grab.
  const res = quiet(sys, () => monsterMeleeAttack(m.type, p, sys.rng, { name: m.TheName(), accuracy: m.type.melee_skill + m.hitBonus() }));
  if (res.block?.parry) {
    sys.message(fmt('The %s grabs at you, but you knock its arms aside!', name));
    parried(sys, m);
    return true;
  }
  applyGrab(sys, m);
  sys.message(fmt('The %s grabs you!', name), 'c_red');
  if (res.hit) {
    const dealt = res.result?.damage ?? 0;
    sfx.monsterHit(m);
    if (res.message) sys.message(res.message, dealt > 0 ? 'c_red' : undefined);
    sys.onPlayerHurt(m, dealt, res.bp);
  }
  return true;
}

/** Hold the survivor: "grabbing" on the monster, "grabbed" (intensity = total grab strength) on them. */
export function applyGrab(sys: MonsterSystem, m: Monster): void {
  const p = sys.game.player;
  m.addEffect('grabbing', 3600);
  sys.grabbedBy = m;
  const strength = Math.max(1, typeof m.type.grab_strength === 'number' ? m.type.grab_strength : 1);
  p.addEffect('grabbed', 3600 * 24, { intensity: Math.min(15, p.effects.intensity('grabbed') + strength) });
}

/**
 * mattack::grab_drag: grab, then if still held and stability_roll (melee + str + per/3 +
 * dex/4) < dice(sides, dice) the monster steps back and drags the survivor into its place.
 */
function grabDrag(sys: MonsterSystem, m: Monster): boolean {
  if (!sys.inMeleeRange(m, 1)) return false;
  grab(sys, m);
  const p = sys.game.player;
  if (!p.hasEffect('grabbed') || sys.grabbedBy !== m) return true;
  const stability = p.getSkill('melee') + p.str + p.per / 3 + p.dex / 4;
  if (stability < sys.rng.dice(m.type.melee_dice_sides, m.type.melee_dice)) {
    const d = Math.max(0.01, Math.hypot(m.x - p.x, m.y - p.y));
    const bx = m.x + ((m.x - p.x) / d), by = m.y + ((m.y - p.y) / d);
    if (sys.grid.passable(Math.floor(bx), Math.floor(by), m.z)) {
      const ox = m.x, oy = m.y;
      m.x = bx;
      m.y = by;
      sys.movePlayerTo(ox, oy);
      sys.message(fmt('You are dragged behind the %s!', mname(m)), 'c_red');
      return true;
    }
  }
  sys.message(fmt('You resist the %s as it tries to drag you!', mname(m)), 'c_light_green');
  return true;
}

/** The generic monster::melee_attack (no special attack involved). */
export function defaultMelee(sys: MonsterSystem, m: Monster): void {
  const p = sys.game.player;
  const hasDamage = m.type.melee_dice > 0 || (m.type.melee_damage ?? []).some((u) => u.amount > 0);
  if (!hasDamage) return;
  const res = monsterMeleeAttack(m.type, p, sys.rng, { name: m.TheName(), accuracy: m.type.melee_skill + m.hitBonus() });
  if (res.hit) {
    sfx.monsterHit(m);
    sys.onPlayerHurt(m, res.result?.damage ?? 0, res.bp);
    if (res.block?.parry) parried(sys, m);
  } else sfx.monsterWhiff(m);
}

// ---------------------------------------------------------------- hardcoded specials

function speech(sys: MonsterSystem, m: Monster): void {
  const lines: { sound: string; volume: number }[] | undefined = sys.game.data.misc.speech?.[m.id];
  if (!lines?.length) {
    // Zombies without their own lines still groan (the generic zombie speech).
    if (!m.inSpecies('ZOMBIE')) return;
    const z: { sound: string; volume: number }[] | undefined = sys.game.data.misc.speech?.mon_zombie;
    if (!z?.length) return;
    return sayLine(sys, m, sys.rng.pick(z));
  }
  sayLine(sys, m, sys.rng.pick(lines));
}

function sayLine(sys: MonsterSystem, m: Monster, line: { sound: string; volume: number }): void {
  sfx.monsterVoice(m.id, m);
  // sound.ts prints "From the north you hear moaning."; keep distant chatter out of the log.
  sys.emitSound(m.x, m.y, m.z, line.volume, line.sound, m, '', 'speech', sys.distToPlayer(m) > 12);
}

/** mattack::shriek: within 4 tiles in sight, 240 moves, a volume-120 alert. */
function shriek(sys: MonsterSystem, m: Monster): boolean {
  if (!m.seesPlayer || sys.distToPlayer(m) > 4.5) return false;
  m.busy = Math.max(m.busy, turnsToSeconds(240 / m.speed));
  sys.emitSound(m.x, m.y, m.z, 120, 'a terrible shriek!', m, undefined, 'alert');
  return true;
}

/** mattack::shriek_alert: within 15 tiles, starts a minute of "shrieking" (enables SHRIEK_STUN). */
function shriekAlert(sys: MonsterSystem, m: Monster): boolean {
  if (m.shriekingUntil > sys.time || !m.seesPlayer || sys.distToPlayer(m) > 15.5) return false;
  sys.messageIfSeen(m, fmt('The %s begins shrieking!', mname(m)));
  m.busy = Math.max(m.busy, turnsToSeconds(150 / m.speed));
  sys.emitSound(m.x, m.y, m.z, 120, 'a piercing wail!', m, undefined, 'alert');
  m.shriekingUntil = sys.time + turnsToSeconds(60);
  return true;
}

/** mattack::shriek_stun: while shrieking, a 20° cone at the target within 7 tiles dazes. */
function shriekStun(sys: MonsterSystem, m: Monster): boolean {
  if (m.shriekingUntil <= sys.time || !m.seesPlayer) return false;
  const dist = Math.round(sys.distToPlayer(m));
  if (dist > 7) return false;
  if (sys.rng.oneIn(Math.max(1, Math.floor(dist / 2)))) {
    const p = sys.game.player;
    p.addEffect('dazed', sys.rng.int(60, 120), { intensity: sys.rng.int(1, Math.max(1, Math.floor((15 - dist) / 3))) });
  }
  return true;
}

/** mattack::acid: 300 moves, a spit (dispersion 5400 MOA) that splashes acid 3 tiles around. */
function acidSpit(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  if (!m.seesPlayer || sys.distToPlayer(m) > 10 || !sys.clearLine(m, p.x, p.y)) return false;
  m.busy = Math.max(m.busy, turnsToSeconds(300 / m.speed));
  sys.emitSound(m.x, m.y, m.z, 60, 'a spitting noise.', m);
  // 5400 MOA = 90° of spread: at range the glob often lands beside you.
  const dist = sys.distToPlayer(m);
  const miss = sys.rng.next() < Math.min(0.75, 0.1 + dist * 0.05) + p.dodge() * 0.03;
  const tx = p.x + (miss ? (sys.rng.next() - 0.5) * 4 : 0), ty = p.y + (miss ? (sys.rng.next() - 0.5) * 4 : 0);
  sys.launchProjectile(m, tx, ty, p.z, { symbol: '*', color: 'light_green' }, 10, () => {
    if (!miss) {
      const bp = selectBodyPart(sys.rng);
      const r = p.takeHit(bp, p.inv.absorbHit(bp, [{ type: 'acid', amount: 5 }], sys.rng));
      sys.message(`A glob of acid hits your ${BODY_PARTS[bp].name}!`, 'c_red');
      sys.onPlayerHurt(m, r.damage, bp);
    } else sys.message('The acid splashes beside you.');
    const cx = Math.floor(tx), cy = Math.floor(ty);
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      if ((i === 0 && j === 0) || (sys.rng.oneIn(Math.abs(j) || 1) && sys.rng.oneIn(Math.abs(i) || 1))) sys.addField(cx + i, cy + j, p.z, 'fd_acid', 2);
    }
  });
  return true;
}

/** mattack::acid_barf: adjacent, 80 moves, dodge_check, rng(5, 12) acid + corroding. */
function acidBarf(sys: MonsterSystem, m: Monster): boolean {
  if (!sys.inMeleeRange(m, 1)) return false;
  const p = sys.game.player;
  m.busy = Math.max(m.busy, turnsToSeconds(80 / m.speed));
  sys.addField(p.tileX, p.tileY, p.z, 'fd_acid', 1);
  if (dodgeCheck(sys, m)) {
    sys.message(fmt('The %s barfs acid at you, but you dodge!', mname(m)));
    return true;
  }
  const bp = selectBodyPart(sys.rng);
  const r = p.takeHit(bp, p.inv.absorbHit(bp, [{ type: 'acid', amount: sys.rng.int(5, 12) }], sys.rng));
  if (r.damage > 0) {
    sys.message(fmt('The %1$s barfs acid on your %2$s for %3$d damage!', mname(m), BODY_PARTS[bp].name, String(r.damage)), 'c_red');
    p.addEffect('corroding', turnsToEffectSeconds(sys.rng.int(1, 3)));
  } else sys.message(fmt('The %1$s barfs acid on your %2$s, but it washes off the armor!', mname(m), BODY_PARTS[bp].name));
  sys.onPlayerHurt(m, r.damage, bp);
  return true;
}

/** mattack::boomer: within 3 tiles in sight, 250 moves, bile along the line; boomered unless dodged. */
function boomerVomit(sys: MonsterSystem, m: Monster, glow = false): boolean {
  const p = sys.game.player;
  const dist = sys.distToPlayer(m);
  if (!m.seesPlayer || dist > 3.5) return false;
  m.busy = Math.max(m.busy, turnsToSeconds(250 / m.speed));
  sys.messageIfSeen(m, fmt('The %s spews bile!', mname(m)), 'c_yellow');
  sys.emitSound(m.x, m.y, m.z, 8, 'gurgling.', m);
  sys.launchProjectile(m, p.x, p.y, p.z, { symbol: '*', color: 'pink' }, 8, () => {
    const n = Math.max(1, Math.round(dist));
    for (let i = 1; i <= n; i++) sys.addField(Math.floor(m.x + ((p.x - m.x) * i) / n), Math.floor(m.y + ((p.y - m.y) * i) / n), p.z, 'fd_bile', 1);
    const dodge = p.dodge();
    // rng(0, 10) > dodge || one_in(dodge): most survivors get it in the eyes.
    if (sys.rng.int(0, 10) > dodge || sys.rng.oneIn(Math.max(1, Math.floor(dodge)))) {
      p.addEffect('boomered', turnsToEffectSeconds(glow ? 25 : 12));
      if (glow) p.addEffect('glowing', 4 * 60);
      sys.onPlayerHurt(m, 0, 'eyes');
    } else sys.message('You dodge it!');
  });
  return true;
}

/** Leap preconditions: sees the survivor within its range band along a clear line. */
function leapReady(sys: MonsterSystem, m: Monster, d: Record<string, any>): boolean {
  const dist = sys.distToPlayer(m);
  const maxR = typeof d.max_range === 'number' ? d.max_range : 5;
  const minR = typeof d.min_range === 'number' ? d.min_range : 1;
  const minC = typeof d.min_consider_range === 'number' ? d.min_consider_range : 0;
  const maxC = typeof d.max_consider_range === 'number' ? d.max_consider_range : 200;
  if (!m.seesPlayer || dist < Math.max(2.2, minR + 1, minC) || dist > Math.min(maxR + 1, maxC) + 0.5) return false;
  const p = sys.game.player;
  return sys.clearLine(m, p.x, p.y);
}

/** leap_actor: jump to a spot closer to the target (never onto it), move_cost 150. */
function leap(sys: MonsterSystem, m: Monster, d: Record<string, any>): boolean {
  if (!leapReady(sys, m, d)) return false;
  const p = sys.game.player;
  const dist = sys.distToPlayer(m);
  const maxR = typeof d.max_range === 'number' ? d.max_range : 5;
  const len = Math.min(maxR, Math.max(0.01, dist - 1.1));
  const t = Math.max(0.12, len / 12);
  m.dashVx = ((p.x - m.x) / dist) * (len / t);
  m.dashVy = ((p.y - m.y) / dist) * (len / t);
  m.dashTime = t;
  sys.messageIfSeen(m, fmt('The %s leaps!', mname(m)));
  m.busy = Math.max(m.busy, t + turnsToSeconds((d.move_cost ?? 150) / m.speed));
  return true;
}

/**
 * mattack::resurrect: finds a REVIVES zombie corpse in sight within 10 tiles, charges up
 * ("throws its arms wide"), raises it and loses 10–50% of its base speed per raise.
 */
function resurrect(sys: MonsterSystem, m: Monster, sa: SpecialAttackState): boolean {
  const c = sys.findRevivableCorpse(m, 10);
  if (!c) {
    m.raising = 0;
    return false;
  }
  if (m.raising <= 0) {
    sys.messageIfSeen(m, fmt('The %s throws its arms wide.', mname(m)));
    m.raising = 1;
    m.busy = Math.max(m.busy, turnsToSeconds(100 / m.speed));
    sa.cooldown = Math.max(sa.cooldown, 1);
    return false;
  }
  const risen = sys.reviveCorpse(c);
  m.raising = 0;
  if (!risen) return false;
  sys.messageIfSeen(m, fmt('The %s gestures at a nearby corpse.', mname(m)));
  sys.messageIfSeen(risen, fmt('A nearby %s rises from the dead!', mname(risen)), 'c_red');
  m.busy = Math.max(m.busy, 1);
  // The charge-up and the speed penalty pace raising; data cooldown is 0.
  sa.cooldown = Math.max(sa.cooldown, 8);
  return true;
}

/** mattack::shockstorm: lightning at the target within 12 tiles; electricity fields around it. */
function shockstorm(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  if (!m.seesPlayer || sys.distToPlayer(m) > 12 || !sys.clearLine(m, p.x, p.y)) return false;
  m.busy = Math.max(m.busy, turnsToSeconds(50 / m.speed));
  sys.messageIfSeen(m, fmt('A bolt of electricity arcs towards you!', mname(m)), 'c_red');
  const tx = p.tileX + sys.rng.int(-1, 1) + sys.rng.int(-1, 1), ty = p.tileY + sys.rng.int(-1, 1) + sys.rng.int(-1, 1);
  sys.launchProjectile(m, tx + 0.5, ty + 0.5, p.z, { symbol: '*', color: 'light_cyan' }, 30, () => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (sys.rng.oneIn(3)) sys.addField(tx + i, ty + j, p.z, 'fd_electricity', 1);
    if (Math.max(Math.abs(p.tileX - tx), Math.abs(p.tileY - ty)) <= 1) {
      const bp = selectBodyPart(sys.rng);
      const r = p.takeHit(bp, p.inv.absorbHit(bp, [{ type: 'electric', amount: sys.rng.int(4, 10) }], sys.rng));
      sys.message(`You're shocked!`, 'c_red');
      sys.onPlayerHurt(m, r.damage, bp);
    }
  });
  return true;
}

/**
 * mattack::smash: adjacent, 400 moves, dodge_check, then fling_creature at velocity
 * dice × sides × 3: range velocity / 10 tiles and a landing impact of rng(v, 2v) / 9.
 */
function smash(sys: MonsterSystem, m: Monster): boolean {
  if (!sys.inMeleeRange(m, 1)) return false;
  const p = sys.game.player;
  m.busy = Math.max(m.busy, turnsToSeconds(400 / m.speed));
  if (dodgeCheck(sys, m)) {
    sys.message(fmt('The %s takes a powerful swing at you, but you dodge it!', mname(m)));
    return true;
  }
  const vel = m.type.melee_dice * m.type.melee_dice_sides * 3;
  const range = Math.floor(vel / 10);
  // A raised guard can still turn the swing aside (combat-feel parry), as for any blow.
  const block = blockHit(p, [{ type: 'bash', amount: vel / 9 }], 'torso', SIZE_RANK[m.size], sys.rng, { silent: true });
  if (block.parry) {
    sys.message(fmt('You turn aside the blow from the %s!', mname(m)));
    parried(sys, m);
    return true;
  }
  sys.message(fmt('A blow from the %s sends you flying!', mname(m)), 'c_red');
  sys.knockbackPlayer(m, Math.max(1, Math.min(9, range)));
  const impact = Math.floor(sys.rng.int(vel, vel * 2) / 9);
  if (impact > 0) {
    const r = p.takeHit('torso', [{ type: 'bash', amount: impact }]);
    sys.onPlayerHurt(m, r.damage, 'torso');
  }
  return true;
}

/** mattack::lunge: adjacent, 100 moves, dodge_check, rng(3, 7) bash, 1 in 6 downed. */
function lunge(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  if (!m.seesPlayer) return false;
  if (!sys.inMeleeRange(m, 1)) {
    // At range it only closes in: 1 in 5, within 4 tiles, the monster gains moves.
    if (sys.distToPlayer(m) > 4.5 || !sys.rng.oneIn(5)) return false;
    sys.messageIfSeen(m, fmt('The %s lunges for you!', mname(m)));
    m.attackCooldown = 0;
    return true;
  }
  m.busy = Math.max(m.busy, turnsToSeconds(100 / m.speed));
  if (dodgeCheck(sys, m)) {
    sys.message(fmt('The %1$s lunges at you, but you sidestep it!', mname(m)));
    return true;
  }
  const bp = selectBodyPart(sys.rng);
  const r = p.takeHit(bp, p.inv.absorbHit(bp, [{ type: 'bash', amount: sys.rng.int(3, 7) }], sys.rng));
  if (r.damage > 0) sys.message(fmt('The %1$s lunges at your %2$s, battering it for %3$d damage!', mname(m), BODY_PARTS[bp].name, String(r.damage)), 'c_red');
  else sys.message(fmt('The %1$s lunges at your %2$s, but your armor prevents injury!', mname(m), BODY_PARTS[bp].name));
  if (sys.rng.oneIn(6)) p.addEffect('downed', turnsToEffectSeconds(3));
  sys.onPlayerHurt(m, r.damage, bp);
  return true;
}

/** mattack::longswipe (adjacent part): dodge_check, rng(3, 7) cut … a thrust from up to 3 tiles away. */
function longswipe(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  const dist = sys.distToPlayer(m);
  if (!m.seesPlayer || dist > 3.5) return false;
  if (!sys.inMeleeRange(m, 1)) {
    if (!sys.clearLine(m, p.x, p.y) || !sys.rng.oneIn(5)) return false;
    m.busy = Math.max(m.busy, turnsToSeconds(150 / m.speed));
    if (dodgeCheck(sys, m)) {
      sys.message(fmt('The %s thrusts a claw at you, but you evade it!', mname(m)));
      return true;
    }
    const bp = selectBodyPart(sys.rng);
    const r = p.takeHit(bp, p.inv.absorbHit(bp, [{ type: 'cut', amount: sys.rng.int(3, 7) }], sys.rng));
    sys.message(fmt('The %1$s thrusts a claw at your %2$s, slashing it for %3$d damage!', mname(m), BODY_PARTS[bp].name, String(r.damage)), 'c_red');
    sys.onPlayerHurt(m, r.damage, bp);
    return true;
  }
  if (dodgeCheck(sys, m)) {
    sys.message(fmt('The %s slashes at your neck!  You duck!', mname(m)));
    return true;
  }
  const r = p.takeHit('head', p.inv.absorbHit('head', [{ type: 'cut', amount: sys.rng.int(6, 10) }], sys.rng));
  if (r.damage > 0) {
    sys.message(fmt('The %1$s slashes at your neck, cutting your throat for %2$d damage!', mname(m), String(r.damage)), 'c_red');
    p.addEffect('bleed', 15 * 60, { bp: 'head' });
  } else sys.message(fmt('The %1$s slashes at your neck, but your armor protects it!', mname(m)));
  sys.onPlayerHurt(m, r.damage, 'head');
  return true;
}

/** Hardcoded ids we deliberately ignore without warning (behaviour we don't model yet). */
const SILENT_SKIP = new Set(['NONE', 'FEAR_PARALYZE', 'EAT_FOOD', 'EAT_CROP', 'UPGRADE', 'DISAPPEAR', 'PHOTOGRAPH', 'FUNGUS', 'FUNGUS_HAZE', 'FUNGUS_BRISTLE', 'FUNGUS_INJECT', 'FUNGUS_SPROUT', 'FUNGUS_BIG_BLOSSOM', 'FUNGUS_FORTIFY', 'FUNGUS_GROWTH', 'FUNGAL_TRAIL', 'PLANT', 'GROWPLANTS', 'TRIFFID_HEARTBEAT', 'TRIFFID_GROWTH', 'GROW_VINE', 'VINE', 'COMMAND_BUFF', 'ZOMBIE_FUSE', 'DOOT']);

/** Try one special attack; true when performed (caller applies cooldown). */
export function trySpecial(sys: MonsterSystem, m: Monster, sa: SpecialAttackState): boolean {
  const d = sa.def;
  const id = d.id;
  const actor = isActor(d);
  if (actor) return meleeActor(sys, m, sa, actor === 'bite');
  if (d.type === 'leap' || d.attack_type === 'leap') return leap(sys, m, d);
  if (d.type === 'gun' || d.attack_type === 'gun') {
    // Turrets, secubots, armed humans/zombies, rock throwers (src/game/monguns.ts).
    return gunActor(sys, m, sa, (c) => evalCondition(sys, m, c));
  }
  switch (id) {
    case 'GRAB':
      return grab(sys, m);
    case 'GRAB_DRAG':
      return grabDrag(sys, m);
    case 'PARROT':
      if (!sys.rng.oneIn(20)) return false;
      speech(sys, m);
      return true;
    case 'PARROT_AT_DANGER':
      // Speaks when it notices a threat; cooldown 0 in data, so throttle by chance.
      if (!m.seesPlayer || !sys.rng.oneIn(40)) return false;
      speech(sys, m);
      sa.cooldown = 20;
      return true;
    case 'SHRIEK':
      return shriek(sys, m);
    case 'SHRIEK_ALERT':
      return shriekAlert(sys, m);
    case 'SHRIEK_STUN':
      return shriekStun(sys, m);
    case 'ACID':
    case 'ACID_ACCURATE':
      return acidSpit(sys, m);
    case 'ACID_BARF':
      return acidBarf(sys, m);
    case 'BOOMER':
      return boomerVomit(sys, m);
    case 'BOOMER_GLOW':
      return boomerVomit(sys, m, true);
    case 'RESURRECT':
      return resurrect(sys, m, sa);
    case 'SHOCKSTORM':
      return shockstorm(sys, m);
    case 'SMASH':
      return smash(sys, m);
    case 'LUNGE':
      return lunge(sys, m);
    case 'LONGSWIPE':
      return longswipe(sys, m);
    default:
      if (!SILENT_SKIP.has(id)) warnOnce('monster_attack', id);
      return false;
  }
}

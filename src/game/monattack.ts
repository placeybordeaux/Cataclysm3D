import type { DamageUnit } from '../data/types';
import { warnOnce } from '../data/warn';
import { gunActor } from './monguns';
import { monsterCanAttackHigh, monsterMeleeAttack, selectBodyPart, type MonsterAttackResult } from './combat';
import { BODY_PARTS, type BodyPartId } from './bodyparts';
import { SIZE_RANK, turnsToEffectSeconds, turnsToSeconds, type Monster, type SpecialAttackState } from './monster';
import type { MonsterSystem } from './monai';
import { sfx } from '../audio/sfx';

// Monster special attacks (monattack.cpp hardcoded ones + mattack_actors.cpp data-driven
// melee/bite/leap/gun actors) against the player. Each returns true when the attack was
// performed, which puts it on cooldown and makes the monster busy for its move cost.
//
// Only the player is a target for now: monster-vs-monster fights (dogs vs zombies) are a gap.

/** CDDA "%1$s grabs your %2$s!" style formatting. */
export function fmt(template: string, ...args: string[]): string {
  let i = 0;
  return template.replace(/%(\d)\$s|%s/g, (m, n) => (n ? args[Number(n) - 1] : args[i++]) ?? m);
}

function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { str?: string }).str === 'string') return (v as { str: string }).str;
  return undefined;
}

/**
 * Tiny evaluator for the dialogue conditions monster attacks carry. "u" is the attacker,
 * "npc" the target (player). Unknown condition shapes evaluate false (and warn once), so an
 * attack we can't reason about is skipped rather than spammed.
 */
export function evalCondition(sys: MonsterSystem, m: Monster, cond: unknown): boolean {
  if (cond === undefined || cond === null) return true;
  if (typeof cond !== 'object') return !!cond;
  const c = cond as Record<string, any>;
  if (Array.isArray(c.and)) return c.and.every((x: unknown) => evalCondition(sys, m, x));
  if (Array.isArray(c.or)) return c.or.some((x: unknown) => evalCondition(sys, m, x));
  if ('not' in c) return !evalCondition(sys, m, c.not);
  const p = sys.game.player;
  if (typeof c.u_has_flag === 'string') {
    // GRAB_FILTER comes from the "grabbing" effect; other flags are monster flags.
    if (c.u_has_flag === 'GRAB_FILTER') return m.hasEffect('grabbing');
    return m.has(c.u_has_flag);
  }
  if (typeof c.npc_has_flag === 'string') {
    if (c.npc_has_flag === 'GRAB') return p.hasEffect('grabbed');
    return false;
  }
  if (typeof c.u_has_effect === 'string') return m.hasEffect(c.u_has_effect as any);
  if (typeof c.npc_has_effect === 'string') return p.hasEffect(c.npc_has_effect);
  if (Array.isArray(c.math) && typeof c.math[0] === 'string') {
    const expr: string = c.math[0];
    const size = /u_val\('size'\)\s*(>=|<=|>|<|==)\s*n_val\('size'\)/.exec(expr);
    if (size) return cmp(SIZE_RANK[m.size], size[1], 3);
    const nsize = /n_val\('size'\)\s*(>=|<=|>|<|==)\s*(\d+)/.exec(expr);
    if (nsize) return cmp(3, nsize[1], Number(nsize[2]));
    // Charge-up counters and other EOC math: we don't model those effects -> not ready.
    return false;
  }
  warnOnce('attack_condition', JSON.stringify(c).slice(0, 80));
  return false;
}

function cmp(a: number, op: string, b: number): boolean {
  switch (op) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return a === b;
  }
}

/** Run `fn` with the player's message sink muted, so we can print CDDA's attack-specific text instead. */
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

function rollDamage(sys: MonsterSystem, units: DamageUnit[], minMul: number, maxMul: number): DamageUnit[] {
  const mul = minMul + sys.rng.next() * (maxMul - minMul);
  return units.map((u) => ({ ...u, amount: u.amount * mul }));
}

function asUnits(v: unknown): DamageUnit[] | undefined {
  if (!v) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((u): u is DamageUnit => !!u && typeof u === 'object' && typeof (u as DamageUnit).damage_type === 'string');
}

/**
 * melee_actor / bite_actor (mattack_actors.cpp). Damage = damage_max_instance scaled by
 * rng(min_mul, max_mul) (default bash 9), accuracy defaults to melee_skill, messages from
 * the data. Grabs apply "grabbed"/"grabbing", throw_strength knocks the target back, bites
 * carry infection_chance (default 5%) of the "bite" wound.
 */
export function meleeActor(sys: MonsterSystem, m: Monster, sa: SpecialAttackState, bite: boolean): boolean {
  const d = sa.def;
  const p = sys.game.player;
  const range = typeof d.range === 'number' ? d.range : 1;
  if (!sys.inMeleeRange(m, range)) return false;
  if (!evalCondition(sys, m, d.condition)) return false;
  // Grabs don't stack: CDDA's grab conditions exclude already-grabbed targets for most actors.
  if (d.grab && p.hasEffect('grabbed') && !m.hasEffect('grabbing') && !bite) return false;
  const name = m.TheName();
  const units = rollDamage(sys, asUnits(d.damage_max_instance) ?? [{ damage_type: 'bash', amount: 9 }], d.min_mul ?? 0.5, d.max_mul ?? 1);
  const hitsizeMin = typeof d.hitsize_min === 'number' && d.hitsize_min >= 0 ? d.hitsize_min : bite ? 1 : undefined;
  const canHigh = d.attack_upper === false ? false : monsterCanAttackHigh(m.type);
  const bp: BodyPartId = selectBodyPart(sys.rng, { canAttackHigh: canHigh, minHitSize: hitsizeMin });
  const res: MonsterAttackResult = quiet(sys, () =>
    monsterMeleeAttack(m.type, p, sys.rng, {
      accuracy: typeof d.accuracy === 'number' ? d.accuracy : m.type.melee_skill,
      damage: units,
      bp,
      name,
      dodgeable: d.dodgeable !== false,
    }),
  );
  const part = BODY_PARTS[res.bp ?? bp].name;
  if (!res.hit) {
    sys.message(fmt(textOf(d.miss_msg_u) ?? '%s lunges at you, but you dodge!', name));
    if (bite) sfx.monsterBite(false, m);
    return true;
  }
  const dealt = res.result?.damage ?? 0;
  if (dealt > 0 || d.grab) {
    sys.message(fmt(textOf(d.hit_dmg_u) ?? '%1$s bites your %2$s!', name, part), 'c_red');
  } else {
    sys.message(fmt(textOf(d.no_dmg_msg_u) ?? '%1$s bites your %2$s, but fails to penetrate armor!', name, part));
  }
  if (bite) sfx.monsterBite(true, m);
  else sfx.monsterHit(m);
  sys.onPlayerHurt(m, dealt, res.bp ?? bp);
  if (d.grab) applyGrab(sys, m);
  // Effects: CDDA effects_require_dmg defaults true.
  if (dealt > 0 || d.effects_require_dmg === false) {
    for (const e of (d.effects ?? []) as { id: string; chance?: number; duration?: number | [number, number]; affect_hit_bp?: boolean; permanent?: boolean }[]) {
      if (!sys.rng.chance(e.chance ?? 100)) continue;
      const dur = Array.isArray(e.duration) ? sys.rng.int(e.duration[0], e.duration[1]) : e.duration ?? 1;
      p.addEffect(e.id, turnsToEffectSeconds(dur), { bp: e.affect_hit_bp ? res.bp : undefined, permanent: e.permanent });
    }
    if (bite && sys.rng.chance(typeof d.infection_chance === 'number' ? d.infection_chance : 5)) {
      const hit = res.bp ?? bp;
      if (p.hasEffect('infected', hit)) p.addEffect('infected', 25 * 60, { bp: hit });
      else p.addEffect('bite', p.hasEffect('bite', hit) ? 40 * 60 : 1, { bp: hit });
    }
  }
  const throwStr = typeof d.throw_strength === 'number' ? d.throw_strength : 0;
  if (throwStr > 0 && SIZE_RANK[m.size] > 3) {
    sys.message(fmt(textOf(d.throw_msg_u) ?? '%1$s hurls you through the air!', name), 'c_red');
    sys.knockbackPlayer(m, Math.max(1, Math.min(5, throwStr / 20)));
  }
  return true;
}

export function applyGrab(sys: MonsterSystem, m: Monster): void {
  const p = sys.game.player;
  m.addEffect('grabbing', 3600);
  sys.grabbedBy = m;
  if (!p.hasEffect('grabbed')) {
    // Intensity carries the grab strength for the break-free roll (CDDA grab_data).
    p.addEffect('grabbed', 3600 * 24, { intensity: Math.max(1, (m.type as any).grab_strength ?? 20) });
  }
}

/** The generic monster::melee_attack (no special attack involved). */
export function defaultMelee(sys: MonsterSystem, m: Monster): void {
  const p = sys.game.player;
  const hasDamage = m.type.melee_dice > 0 || (m.type.melee_damage ?? []).some((u) => u.amount > 0);
  if (!hasDamage) return;
  const res = monsterMeleeAttack(m.type, p, sys.rng, { name: m.TheName() });
  if (res.hit) {
    sfx.monsterHit(m);
    sys.onPlayerHurt(m, res.result?.damage ?? 0, res.bp);
  }
}

// ---------------------------------------------------------------- hardcoded specials

function speech(sys: MonsterSystem, m: Monster): void {
  const lines: { sound: string; volume: number }[] | undefined = sys.game.data.misc.speech?.[m.id];
  if (!lines?.length) {
    // Zombies without their own lines still groan (CDDA's generic zombie speech).
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

function shriek(sys: MonsterSystem, m: Monster, stun: boolean): boolean {
  if (!m.seesPlayer || sys.distToPlayer(m) > 4.5) return false;
  m.busy = Math.max(m.busy, 2.4 * 100 / m.speed / 3);
  sys.emitSound(m.x, m.y, m.z, 50, 'a terrible shriek!', m, undefined, 'alert');
  if (stun && sys.rng.oneIn(2)) sys.game.player.addEffect('dazed', turnsToEffectSeconds(sys.rng.int(2, 5)));
  return true;
}

function acidSpit(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  if (!m.seesPlayer || sys.distToPlayer(m) > 10 || sys.distToPlayer(m) < 1.2) return false;
  m.busy = Math.max(m.busy, 300 / m.speed / 3);
  sys.emitSound(m.x, m.y, m.z, 4, 'a spitting noise.', m);
  sys.message(`${m.TheName()} spits acid!`);
  // dispersion 5400 MOA ~ 90 degrees: at range the glob often lands beside you.
  const dist = sys.distToPlayer(m);
  const miss = sys.rng.next() < Math.min(0.75, 0.1 + dist * 0.05) + p.dodge() * 0.03;
  const tx = p.x + (miss ? (sys.rng.next() - 0.5) * 4 : 0), ty = p.y + (miss ? (sys.rng.next() - 0.5) * 4 : 0);
  sys.launchProjectile(m, tx, ty, p.z, { symbol: '*', color: 'light_green' }, 10, () => {
    if (!miss) {
      const bp = selectBodyPart(sys.rng);
      const absorbed = p.inv.absorbHit(bp, [{ type: 'acid', amount: sys.rng.int(5, 10) }], sys.rng);
      const r = p.takeHit(bp, absorbed);
      sys.message(`A glob of acid hits your ${BODY_PARTS[bp].name}!`, 'c_red');
      sys.onPlayerHurt(m, r.damage, bp);
    } else sys.message('The acid splashes beside you.');
    const cx = Math.floor(tx), cy = Math.floor(ty);
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      if ((i === 0 && j === 0) || (sys.rng.oneIn(Math.abs(i) + 1) && sys.rng.oneIn(Math.abs(j) + 1))) sys.addField(cx + i, cy + j, p.z, 'fd_acid', 2);
    }
  });
  return true;
}

function acidBarf(sys: MonsterSystem, m: Monster): boolean {
  if (!sys.inMeleeRange(m, 1)) return false;
  const p = sys.game.player;
  m.busy = Math.max(m.busy, 80 / m.speed / 3);
  sys.addField(p.tileX, p.tileY, p.z, 'fd_acid', 1);
  if (sys.rng.next() * 10 < p.dodge()) {
    sys.message(`${m.TheName()} barfs acid at you, but you dodge!`);
    return true;
  }
  const bp = selectBodyPart(sys.rng);
  const r = p.takeHit(bp, p.inv.absorbHit(bp, [{ type: 'acid', amount: sys.rng.int(5, 12) }], sys.rng));
  sys.message(`${m.TheName()} barfs acid on your ${BODY_PARTS[bp].name}!`, 'c_red');
  p.addEffect('corroding', turnsToEffectSeconds(sys.rng.int(3, 5)));
  sys.onPlayerHurt(m, r.damage, bp);
  return true;
}

/** Boomer bile (boomer_bile gun actor / legacy BOOMER): short-range spew that blinds. */
function boomerVomit(sys: MonsterSystem, m: Monster, maxRange: number): boolean {
  const p = sys.game.player;
  const dist = sys.distToPlayer(m);
  if (!m.seesPlayer || dist > maxRange + 0.5) return false;
  m.busy = Math.max(m.busy, 150 / m.speed / 3);
  sys.message(`${m.TheName()} spews bile!`);
  sys.emitSound(m.x, m.y, m.z, 8, 'gurgling.', m);
  sys.launchProjectile(m, p.x, p.y, p.z, { symbol: '*', color: 'pink' }, 8, () => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (sys.rng.oneIn(2) || (i === 0 && j === 0)) sys.addField(p.tileX + i, p.tileY + j, p.z, 'fd_bile', 1);
    if (sys.rng.next() * 12 < p.dodge()) {
      sys.message('You dodge it!');
      return;
    }
    p.addEffect('boomered', turnsToEffectSeconds(sys.rng.int(5, 10)));
    sys.onPlayerHurt(m, 0, 'eyes');
  });
  return true;
}

function leap(sys: MonsterSystem, m: Monster, d: Record<string, any>): boolean {
  const dist = sys.distToPlayer(m);
  const maxR = typeof d.max_range === 'number' ? d.max_range : 5;
  const minC = typeof d.min_consider_range === 'number' ? d.min_consider_range : 0;
  const maxC = typeof d.max_consider_range === 'number' ? d.max_consider_range : 200;
  if (!m.seesPlayer || dist < Math.max(2.2, minC) || dist > Math.min(maxR, maxC) + 0.5) return false;
  const p = sys.game.player;
  if (!sys.clearLine(m, p.x, p.y)) return false;
  const len = Math.max(0.01, dist - 1.1);
  const t = Math.max(0.12, len / 12);
  m.dashVx = ((p.x - m.x) / dist) * (len / t);
  m.dashVy = ((p.y - m.y) / dist) * (len / t);
  m.dashTime = t;
  const msg = textOf(d.message);
  sys.messageIfSeen(m, msg ? fmt(msg, m.TheName()) : `${m.TheName()} leaps!`);
  m.busy = Math.max(m.busy, t + turnsToSeconds((d.move_cost ?? 150) / m.speed));
  return true;
}

function resurrect(sys: MonsterSystem, m: Monster, sa: SpecialAttackState): boolean {
  const c = sys.findRevivableCorpse(m, 10);
  if (!c) return false;
  const risen = sys.reviveCorpse(c);
  if (!risen) return false;
  sys.messageIfSeen(m, `${m.TheName()} gestures sinisterly.`);
  sys.messageIfSeen(risen, `${risen.TheName()} rises from the dead!`, 'c_red');
  m.busy = Math.max(m.busy, 1);
  // CDDA's raising charge-up takes a while; data cooldown is 0, so pace it here.
  sa.cooldown = Math.max(sa.cooldown, 8);
  return true;
}

function shockstorm(sys: MonsterSystem, m: Monster): boolean {
  const p = sys.game.player;
  if (!m.seesPlayer || sys.distToPlayer(m) > 12 || !sys.clearLine(m, p.x, p.y)) return false;
  m.busy = Math.max(m.busy, 50 / m.speed / 3);
  sys.message('A bolt of electricity arcs towards you!', 'c_red');
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

/** Hardcoded ids we deliberately ignore without warning (behaviour we don't model yet). */
const SILENT_SKIP = new Set(['FEAR_PARALYZE', 'EAT_FOOD', 'EAT_CROP', 'EAT_CARRION', 'GRAZE', 'BROWSE', 'UPGRADE', 'DISAPPEAR']);

/** Try one special attack; true when performed (caller applies cooldown). */
export function trySpecial(sys: MonsterSystem, m: Monster, sa: SpecialAttackState): boolean {
  const d = sa.def;
  const id = d.id;
  if (d.attack_type === 'melee') return meleeActor(sys, m, sa, false);
  if (d.attack_type === 'bite' || d.type === 'bite') return meleeActor(sys, m, sa, true);
  if (d.type === 'leap' || id === 'leap') return leap(sys, m, d);
  if (d.type === 'gun') {
    // The only common gun actor on core zombies is the boomer's bile.
    if (d.ammo_type === 'boomer_bile' || /bile/.test(id)) {
      const ranges = d.ranges as [number, number, string][] | undefined;
      return boomerVomit(sys, m, ranges?.[0]?.[1] ?? 2);
    }
    // Turrets, secubots, armed humans/zombies, rock throwers (src/game/monguns.ts).
    return gunActor(sys, m, sa, (c) => evalCondition(sys, m, c));
  }
  switch (id) {
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
    case 'SHRIEK_ALERT':
      return shriek(sys, m, false);
    case 'SHRIEK_STUN':
      return shriek(sys, m, true);
    case 'ACID':
      return acidSpit(sys, m);
    case 'ACID_BARF':
      return acidBarf(sys, m);
    case 'BOOMER':
      return boomerVomit(sys, m, 3);
    case 'RESURRECT':
      return resurrect(sys, m, sa);
    case 'SHOCKSTORM':
      return shockstorm(sys, m);
    case 'SMASH':
      return meleeActor(sys, m, { ...sa, def: { ...d, damage_max_instance: [{ damage_type: 'bash', amount: 30 }], throw_strength: 100, hit_dmg_u: '%1$s takes a powerful swing at your %2$s, pulverizing it!' } }, false);
    case 'LUNGE':
      return leap(sys, m, { max_range: 4, message: '%s lunges at you!' });
    default:
      if (!SILENT_SKIP.has(id)) warnOnce('monster_attack', id);
      return false;
  }
}

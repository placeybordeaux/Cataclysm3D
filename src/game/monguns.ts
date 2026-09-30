import type { DamageUnit, ItemDef } from '../data/types';
import { warnOnce } from '../data/warn';
import { Character, MAX_RECOIL } from './character';
import {
  dispersionFromSkill, moaToRadians, rollDispersionMoa, type DispersionSources,
} from './combat';
import { ammoLoudness, asArray, defaultAmmoId } from './item';
import { gunModes } from './gunmods';
import { turnsToSeconds, type Monster, type SpecialAttackState } from './monster';
import type { MonsterSystem } from './monai';
import { BODY_PARTS, type BodyPartId } from './bodyparts';
import { GUN_PROJECTILE_SPEED, projectileHit } from './projectile';
import { CREATURE_RADIUS } from './physics';
import { sfx } from '../audio/sfx';
import { flightSpeed, fliesVisibly, rangedClass } from './rangedfeel';

// Monster guns (mattack_actors.cpp gun_actor): turrets, secubots, armed zombies/humans and
// throwers. CDDA's rules: the attack needs its dialogue condition, a seen target in one of the
// actor's `ranges` (which also pick the fire mode: [min, max, "AUTO"]), no stun, and ammo from
// the monster's `starting_ammo` pool (guns that need no ammo fire freely). Targeting the survivor
// first costs a warm-up (require_targeting_player, default true): the actor announces itself
// with its targeting_sound ("Hostile detected.", default "Beep.") and only fires on a later
// turn, while the lock (targeting_timeout, default 8 turns) holds; each shot extends it by
// targeting_timeout_extend. Shots come from a fake shooter with the actor's fake stats and
// skills, using the gun + ammo data like a character's fire_gun: CDDA dispersion, recoil per
// round within the mode's burst, noise. Bullets are hitscan along the monster→target line;
// "throw" guns (feral humans' rocks) lob a visible projectile instead.

interface MonGunState {
  /** Rounds left per ammo id (monster::ammo, from starting_ammo). */
  ammo: Record<string, number>;
  /** sys.time until which the current target lock holds. */
  targetedUntil: number;
}

const states = new WeakMap<Monster, MonGunState>();

export function monGunState(m: Monster): MonGunState {
  let s = states.get(m);
  if (!s) {
    const start = (m.type.starting_ammo as Record<string, number> | undefined) ?? {};
    states.set(m, (s = { ammo: { ...start }, targetedUntil: -Infinity }));
  }
  return s;
}

/** World hooks (set by the combat-depth installer): a bullet line to draw. */
export const monsterGunHooks: { tracer: ((x0: number, y0: number, x1: number, y1: number, z: number) => void) | null } = { tracer: null };

const fakeShooters = new WeakMap<Monster, Character>();

/** The standard_npc CDDA builds to pull the trigger: fake stats and skills from the actor. */
function shooter(sys: MonsterSystem, m: Monster, d: Record<string, any>): Character {
  let c = fakeShooters.get(m);
  if (!c) {
    c = new Character(sys.game.data, { seed: m.uid });
    c.str_base = Number(d.fake_str ?? 16);
    c.dex_base = Number(d.fake_dex ?? 8);
    c.int_base = Number(d.fake_int ?? 8);
    c.per_base = Number(d.fake_per ?? 12);
    for (const [sk, lvl] of (d.fake_skills as [string, number][] | undefined) ?? []) c.setSkill(sk, lvl);
    c.resetStats();
    fakeShooters.set(m, c);
  }
  return c;
}

/** Ammo the actor fires: its ammo_type item, else the gun's default ammo; null for ammo-less guns. */
function ammoFor(sys: MonsterSystem, gun: ItemDef, d: Record<string, any>): ItemDef | null {
  const items = sys.game.data.items;
  if (typeof d.ammo_type === 'string' && items[d.ammo_type]) return items[d.ammo_type];
  const t = asArray(gun.ammo).filter((a) => a && a !== 'NULL')[0];
  const id = t ? defaultAmmoId(sys.game.data, t) : undefined;
  return id ? items[id] ?? null : null;
}

/** item::gun_recoil for a gun def + ammo def held by `c`. */
function recoilOf(c: Character, gun: ItemDef, ammo: ItemDef | null): number {
  const wt = Math.min(gun.weight, c.str * 333) / 333;
  const handlingDefault = ['rifle', 'smg', 'shotgun'].includes(gun.skill ?? '') ? 20 : 10;
  const handling = Math.pow(wt, 0.8) * Math.pow((gun.handling ?? handlingDefault) / 10, 1.2);
  const qty = (gun.recoil ?? 0) + (ammo?.recoil ?? 0);
  return handling > 1 ? qty / handling : qty * (1 + Math.abs(handling));
}

/** Dispersion sources for the fake shooter (item::gun_dispersion + get_weapon_dispersion). */
function dispersionOf(c: Character, gun: ItemDef, ammo: ItemDef | null): DispersionSources {
  const skill = gun.skill ?? 'gun';
  const gunDisp = Math.max(Math.round(Math.max(0, (gun.dispersion ?? 0) + (ammo?.dispersion ?? 0)) / 18), 1);
  const avg = Math.min((c.getSkill('gun') + c.getSkill(skill)) / 2, 10);
  return {
    linear: [gunDisp, Math.max((20 - c.dex) * 0.5, 0), dispersionFromSkill(avg, (skill === 'archery' ? 450 : 300) / 18), c.recoil],
    multipliers: [],
  };
}

function damageOf(gun: ItemDef, ammo: ItemDef | null): { type: string; amount: number; armor_penetration: number }[] {
  const out = new Map<string, { type: string; amount: number; armor_penetration: number }>();
  for (const u of [...asArray(ammo?.damage as DamageUnit[] | undefined), ...asArray(gun.ranged_damage)]) {
    const e = out.get(u.damage_type) ?? { type: u.damage_type, amount: 0, armor_penetration: 0 };
    e.amount += u.amount;
    e.armor_penetration += u.armor_penetration ?? 0;
    out.set(u.damage_type, e);
  }
  return [...out.values()].filter((u) => u.amount > 0);
}

/**
 * gun_actor::call against the survivor. Returns true when the actor spent its turn (warm-up
 * announcement or shots), so the caller applies the cooldown.
 */
export function gunActor(sys: MonsterSystem, m: Monster, sa: SpecialAttackState, cond: (c: unknown) => boolean): boolean {
  const d = sa.def as Record<string, any>;
  const p = sys.game.player;
  if (d.condition !== undefined && !cond(d.condition)) return false;
  if (m.friendly || p.dead || !m.seesPlayer || !m.aggroCharacter) return false;
  if (m.hasEffect('stunned')) return false;
  if (!sys.clearLine(m, p.x, p.y)) return false;
  const gun = sys.game.data.items[String(d.gun_type)];
  if (!gun) {
    warnOnce('item', String(d.gun_type));
    return false;
  }
  // rl_dist: CDDA's tile distance (Chebyshev).
  const dist = Math.max(Math.abs(Math.floor(p.x) - m.tileX), Math.abs(Math.floor(p.y) - m.tileY));
  const ranges = (d.ranges as [number, number, string?][] | undefined) ?? [];
  const band = ranges.find(([lo, hi]) => dist >= lo && dist <= hi);
  if (!band) return false;
  const st = monGunState(m);
  // try_target: first lock on (announce), fire on a later turn while the lock holds.
  if (d.require_targeting_player !== false && sys.time > st.targetedUntil) {
    const vol = typeof d.targeting_volume === 'number' ? d.targeting_volume : 6;
    const sound = typeof d.targeting_sound === 'string' ? d.targeting_sound : 'Beep.';
    if (vol > 0 && sound) {
      // Seen: say it outright ("The turret says "Hostile detected.""); unseen: the sound
      // system narrates "You hear …" like any other noise.
      const seen = sys.playerSees(m);
      sys.emitSound(m.x, m.y, m.z, vol, sound, m, undefined, 'alarm', seen);
      if (seen) sys.message(`${m.TheName()} ${sound.startsWith('"') ? `says ${sound}` : `goes ${sound.replace(/[.!]$/, '').toLowerCase()}!`}`, 'c_yellow');
    }
    st.targetedUntil = sys.time + turnsToSeconds(typeof d.targeting_timeout === 'number' ? d.targeting_timeout : 8);
    m.busy = Math.max(m.busy, turnsToSeconds((typeof d.targeting_cost === 'number' ? d.targeting_cost : 100) / 100));
    return true;
  }
  const ammo = ammoFor(sys, gun, d);
  const needsAmmo = asArray(gun.ammo).some((a) => a && a !== 'NULL') || !!d.ammo_type;
  const ammoKey = ammo?.id ?? String(d.ammo_type ?? '');
  const have = needsAmmo ? Math.min(st.ammo[ammoKey] ?? 0, typeof d.max_ammo === 'number' ? d.max_ammo : Infinity) : Infinity;
  if (have <= 0) {
    const click = typeof d.no_ammo_sound === 'string' ? d.no_ammo_sound : 'Click.';
    if (click) sys.emitSound(m.x, m.y, m.z, 10, click, m);
    return false;
  }
  const mode = gunModes({ def: gun, gunmods: [], vars: {} } as never).find((x) => x.id === (band[2] || 'DEFAULT')) ?? { qty: 1, id: 'DEFAULT', name: '', flags: [] };
  const shots = Math.max(1, Math.min(mode.qty, have));
  const c = shooter(sys, m, d);
  c.recoil = 0;
  const desc = typeof d.description === 'string' ? d.description : 'The %1$s fires its %2$s!';
  sys.messageIfSeen(m, fmtName(desc, m.displayName(), gun), 'c_light_red');
  m.facing = Math.atan2(p.x - m.x, -(p.y - m.y));
  const throwing = (d.fake_skills as [string, number][] | undefined)?.some(([sk]) => sk === 'throw') || gun.skill === 'throw';
  for (let i = 0; i < shots && !p.dead; i++) {
    if (needsAmmo) st.ammo[ammoKey] = (st.ammo[ammoKey] ?? 0) - 1;
    if (throwing) throwAt(sys, m, gun, ammo, c);
    else shootAt(sys, m, gun, ammo, c, shots > 1, !!d.no_crits);
  }
  st.targetedUntil = Math.max(st.targetedUntil, sys.time) + turnsToSeconds(typeof d.targeting_timeout_extend === 'number' ? d.targeting_timeout_extend : 3);
  m.busy = Math.max(m.busy, turnsToSeconds((typeof d.move_cost === 'number' ? d.move_cost : 150) / 100));
  return true;
}

/** "The %1$s fires its %2$s!" with the monster and gun names. */
function fmtName(template: string, monName: string, gun: ItemDef): string {
  const gunName = typeof gun.name === 'string' ? gun.name : String((gun.name as { str?: string })?.str ?? gun.id);
  let i = 0;
  const args = [monName, gunName];
  return template.replace(/%(\d)\$s|%s/g, (s, n) => (n ? args[Number(n) - 1] : args[i++]) ?? s);
}

/** One hitscan round at the survivor: dispersion cone, walls stop it, CDDA damage bands. */
function shootAt(sys: MonsterSystem, m: Monster, gun: ItemDef, ammo: ItemDef | null, c: Character, burst: boolean, noCrit: boolean): void {
  const p = sys.game.player;
  const rng = sys.rng;
  const moa = rollDispersionMoa(dispersionOf(c, gun, ammo), rng);
  c.recoil = Math.min(MAX_RECOIL, c.recoil + 5 * recoilOf(c, gun, ammo) * (1 - Math.min(c.getSkill(gun.skill ?? 'gun'), 10) / 20));
  const noise = Math.max(0, (gun.loudness ?? 0) + (ammo ? ammoLoudness(ammo) : 0));
  // A monster's crossbow or bow twangs and its bolt flies visibly (rangedfeel.ts), like the survivor's.
  const cls = rangedClass({ def: gun, isGun: () => true, hasFlag: (f) => asArray(gun.flags).includes(f), ammoTypes: () => asArray(gun.ammo as string[] | undefined), ammoData: () => ammo ?? undefined });
  sfx.rangedShot(cls, gun.id, m, { ammoType: typeof ammo?.ammo_type === 'string' ? ammo.ammo_type : undefined, loudness: noise });
  sys.emitSound(m.x, m.y, m.z, noise, fliesVisibly(cls) ? (cls === 'crossbow' ? 'thonk!' : 'whizz!') : noise >= 150 ? (burst ? 'Brrrap!' : 'kerblam!') : burst ? 'Brrrap!' : 'bang!', m, '', 'combat', sys.playerSees(m));
  const range = Math.max(1, (ammo?.range ?? 0) + (gun.range ?? 0)) || 30;
  const aim = Math.atan2(p.x - m.x, -(p.y - m.y));
  const off = moaToRadians(moa) * Math.cos(rng.next() * Math.PI * 2);
  const yaw = aim + off;
  const d = Math.hypot(p.x - m.x, p.y - m.y);
  const dx = Math.sin(yaw), dy = -Math.cos(yaw);
  if (fliesVisibly(cls)) {
    // Resolved where it arrives: step aside while it's in the air and it misses.
    const tx = m.x + dx * Math.min(d, range), ty = m.y + dy * Math.min(d, range);
    sys.launchProjectile(m, tx, ty, m.z, { symbol: ammo?.symbol ?? '=', color: ammo?.color ?? 'brown' }, flightSpeed(cls, Number(ammo?.speed) || 100), () => {
      const miss = Math.hypot(p.x - tx, p.y - ty);
      if (p.dead || d > range || miss > CREATURE_RADIUS + 0.05) return;
      hitSurvivor(sys, m, damageOf(gun, ammo), miss / (CREATURE_RADIUS + 0.05), noCrit, Number(ammo?.speed) || 100);
    });
    return;
  }
  // Perpendicular miss at the survivor's distance.
  const along = (p.x - m.x) * dx + (p.y - m.y) * dy;
  const perp = Math.abs((p.x - m.x) * dy - (p.y - m.y) * dx);
  const radius = CREATURE_RADIUS + 0.05;
  const hits = along > 0 && along <= range && perp <= radius;
  const endT = hits ? along : Math.min(range, d + 6);
  monsterGunHooks.tracer?.(m.x, m.y, m.x + dx * endT, m.y + dy * endT, m.z);
  if (!hits) return;
  const missedBy = perp / radius;
  hitSurvivor(sys, m, damageOf(gun, ammo), missedBy, noCrit);
}

/**
 * Creature::deal_projectile_attack on the survivor (src/game/projectile.ts): BN severity and
 * hit location, grazes before armor, "You were hit in the %s for %d damage." / "You avoid".
 */
function hitSurvivor(sys: MonsterSystem, m: Monster, base: { type: string; amount: number; armor_penetration?: number }[], missedBy: number, noCrit: boolean, speed = GUN_PROJECTILE_SPEED): void {
  const p = sys.game.player;
  const r = projectileHit({ dodgeRoll: p.dodge() * 5, isCharacter: true }, { missedBy, noCrit, speed }, sys.rng);
  if (!r.hit) {
    sys.message(`You avoid ${m.theName()}'s projectile!`, 'c_yellow');
    return;
  }
  const bp = r.location as BodyPartId;
  const units = base.map((u) => ({ type: u.type, amount: u.amount * r.severity, armor_penetration: u.armor_penetration, armor_multiplier: r.graze ? 1 : r.severity }));
  const absorbed = p.inv.absorbHit(bp, units, sys.rng);
  const hit = p.takeHit(bp, absorbed);
  if (hit.damage > 0) sys.message(`You were hit in the ${BODY_PARTS[bp].name} for ${hit.damage} damage.`, 'c_red');
  else sys.message(`The shot reflects off your ${BODY_PARTS[bp].name}!`);
  sys.onPlayerHurt(m, hit.damage, bp);
}

/** Thrown "guns" (rocks): a visible projectile that hits if the survivor is still there. */
function throwAt(sys: MonsterSystem, m: Monster, gun: ItemDef, ammo: ItemDef | null, c: Character): void {
  const p = sys.game.player;
  const rng = sys.rng;
  const moa = rollDispersionMoa(dispersionOf(c, gun, ammo), rng);
  const d = Math.hypot(p.x - m.x, p.y - m.y);
  const off = moaToRadians(moa) * Math.cos(rng.next() * Math.PI * 2);
  const yaw = Math.atan2(p.x - m.x, -(p.y - m.y)) + off;
  const tx = m.x + Math.sin(yaw) * d, ty = m.y - Math.cos(yaw) * d;
  sys.launchProjectile(m, tx, ty, m.z, { symbol: ammo?.symbol ?? '*', color: ammo?.color ?? 'light_gray' }, 12, () => {
    const miss = Math.hypot(p.x - tx, p.y - ty);
    if (p.dead || miss > CREATURE_RADIUS + 0.25) return;
    const units = damageOf(gun, ammo);
    if (!units.length) units.push({ type: 'bash', amount: Math.min(ammo ? ammo.weight / 100 + 4 : 5, 16), armor_penetration: 0 });
    // Thrown rocks fly slowly (BN thrown projectile speed ~ 10-20 m/s): dodging matters.
    hitSurvivor(sys, m, units, Math.min(0.99, miss / (CREATURE_RADIUS + 0.25)), false, 15);
  });
}

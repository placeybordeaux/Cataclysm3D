import { ACTION_SCALE } from '../core/time';
import type { Game, GameSystem } from './game';
import { aim, applyFlatArmor, attackCooldownSeconds, fireGun, meleeAttack, normalRoll, type ShotResult } from './combat';
import type { Item } from './item';
import type { Monster } from './monster';
import type { MonsterSystem } from './monai';
import { Grid, hasLOS } from './los';
import { sfx, type MeleeSkill } from '../audio/sfx';

// The survivor's attacks in real time: LMB / `f` swings or fires, RMB aims a gun, `G` throws.
// Melee picks the monster under the crosshair (exact ray hit first, then the closest within
// a cone), resolves it with combat.ts meleeAttack and applies the damage through the monster
// system. Guns are hitscan: the CDDA dispersion roll becomes a cone offset around the view
// ray, walked tile by tile until a wall or a monster circle stops it.

/** Half-angle of the melee target cone (radians). */
const MELEE_CONE = (32 * Math.PI) / 180;
/** Player reach in tiles (centre to monster edge), CDDA adjacency incl. diagonals. */
const MELEE_REACH = 1.2;

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
  attack(kind: 'melee' | 'fire' | 'throw'): void;
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

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

export class PlayerCombat implements GameSystem {
  readonly name = 'player-combat';
  cooldown = 0;
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

  constructor(readonly game: Game, readonly sys: MonsterSystem) {
    this.grid = sys.grid;
  }

  update(game: Game, dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    for (let i = this.tracers.length - 1; i >= 0; i--) if ((this.tracers[i].t -= dt) <= 0) this.tracers.splice(i, 1);
    const input = game.input;
    const p = game.player;
    if (p.dead || input.captured) return;
    // LMB: consume our clicks but leave other buttons' clicks for whoever else reads them.
    const clicks = input.consumeClicks();
    const others = clicks.filter((b) => b !== 0);
    if (others.length) (input as unknown as { clicks: number[] }).clicks.push(...others);
    const gun = p.inv.wielded?.isGun() ? p.inv.wielded : null;
    // Holding LMB keeps swinging a melee weapon, but a gun only keeps firing when it has an
    // automatic mode; a pistol fires once per click like CDDA's one shot per `f`.
    const held = (input.mouseButtons & 1) !== 0 && (!gun || isAutomatic(gun));
    const lmb = clicks.includes(0) || held;
    if (gun && (input.mouseButtons & 4) !== 0) aim(p, gun, dt * ACTION_SCALE * 100);
    if (lmb && this.cooldown <= 0) this.attack();
  }

  /** LMB / debug: fire if wielding a gun, else melee. */
  attack(): void {
    if (this.attackGuard && !this.attackGuard()) return;
    const w = this.game.player.inv.wielded;
    if (w?.isGun()) this.fire();
    else this.melee();
  }

  // ------------------------------------------------------------------ melee

  /** Monster under the crosshair within reach: exact ray hit preferred, else smallest angle. */
  meleeTarget(reach = MELEE_REACH): Monster | null {
    const p = this.game.player;
    // The UI's camera raycast (game.lookAt) knows exactly which sprite the crosshair is on.
    const look = this.game.lookAt?.(reach + 1.5);
    const hit = look?.kind === 'creature' ? (look.creature as { monster?: Monster } | undefined)?.monster : undefined;
    if (hit && !hit.dead && Math.hypot(hit.x - p.x, hit.y - p.y) - hit.radius <= reach) return hit;
    let best: Monster | null = null, bestScore = Infinity;
    for (const m of this.sys.active) {
      if (m.dead || m.z !== p.z) continue;
      const dx = m.x - p.x, dy = m.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d - m.radius > reach) continue;
      const ang = angleDiff(Math.atan2(dx, -dy), p.yaw);
      const rayHit = ang <= Math.atan2(m.radius, Math.max(d, 0.01)) + 0.05;
      if (!rayHit && ang > MELEE_CONE) continue;
      if (!hasLOS(this.grid, p.tileX, p.tileY, m.tileX, m.tileY, p.z)) continue;
      const score = (rayHit ? 0 : 10) + ang + d * 0.1;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  melee(target: Monster | null = null): boolean {
    const game = this.game;
    const p = game.player;
    const w = p.inv.wielded;
    const reach = w?.hasFlag('REACH_ATTACK') ? 2.2 : MELEE_REACH;
    const m = target ?? this.meleeTarget(reach);
    if (!target && this.npcMelee?.(reach, m)) return true;
    this.viewmodel()?.attack('melee');
    const ws = weaponSound(w);
    sfx.meleeSwing(undefined, ws);
    if (!m) {
      // Swinging at nothing still costs the swing (and a little stamina).
      this.cooldown = attackCooldownSeconds(p, w);
      p.modStamina(-20);
      return false;
    }
    const res = meleeAttack(p, { dodge: m.dodge(), armor: m.type.armor, sizeMeleePenalty: m.sizeMeleePenalty() }, this.sys.rng, m.theName());
    this.cooldown = res.cooldownSeconds;
    // Hostility: animals remember who hit them even on a miss.
    m.aggroCharacter = true;
    if (!res.hit) return false;
    let dominant = 'bash', best = 0;
    for (const d of res.damage) if (d.amount > best) (best = d.amount), (dominant = d.type);
    const verb = meleeVerb(dominant, res.total, (a, b) => this.sys.rng.int(a, b));
    const msg = res.total <= 0 ? `You ${verb} ${m.theName()} but do no damage.` : res.crit ? `You ${verb} ${m.theName()} for ${res.total} damage.  Critical!` : `You ${verb} ${m.theName()} for ${res.total} damage.`;
    game.message(msg, res.total > 0 ? undefined : 'c_light_gray');
    sfx.meleeHit(m.type.material[0] ?? 'flesh', m, ws);
    this.sys.emitSound(m.x, m.y, m.z, 8, 'Smack!', 'player', '');
    this.sys.hurt(m, res.total, 'player');
    return true;
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

  fire(): boolean {
    const game = this.game;
    const p = game.player;
    const gun = p.inv.wielded;
    if (!gun?.isGun()) {
      game.message("You're not wielding a gun.");
      return false;
    }
    const shot = fireGun(p, gun, this.sys.rng);
    if (!shot.ok) {
      sfx.gunEmpty();
      this.cooldown = 0.25;
      return false;
    }
    this.cooldown = shot.cooldownSeconds;
    this.shots++;
    this.viewmodel()?.attack('fire');
    const ammo = gun.ammoData();
    sfx.gunshot(gun.typeId, undefined, { ammoType: typeof ammo?.ammo_type === 'string' ? ammo.ammo_type : undefined, loudness: shot.noise.volume });
    this.sys.emitSound(p.x, p.y, p.z, shot.noise.volume, shot.noise.sound || 'Bang!', 'player', '');
    // Dispersion becomes a sideways offset (the vertical part of the cone can't miss a sprite
    // that already fills the crosshair's column, so only the horizontal component matters).
    const yaw = p.yaw + shot.spread * Math.cos(shot.azimuth);
    const range = Math.max(1, shot.range || 30);
    const hit = this.castRay(yaw, range);
    const npcHit = this.npcShot?.(yaw, Math.hypot(hit.x - p.x, hit.y - p.y), shot);
    if (npcHit) {
      this.tracers.push({ x0: p.x, y0: p.y, x1: npcHit.x, y1: npcHit.y, z: p.z, t: 0.08 });
      return true;
    }
    this.tracers.push({ x0: p.x, y0: p.y, x1: hit.x, y1: hit.y, z: p.z, t: 0.08 });
    if (!hit.hit) {
      sfx.bulletHit('wall', { x: hit.x, y: hit.y, z: p.z });
      return true;
    }
    const m = hit.hit;
    m.aggroCharacter = true;
    // Creature::deal_projectile_attack: goodhit = missed_by + partial dodge; damage bands.
    const dodge = Math.min(1, (m.dodge() * 5 * this.sys.rng.next()) / Math.max(1, this.sys.rng.dice(10, 50)));
    const goodhit = hit.missedBy * 0.9 + dodge;
    const hitRoll = goodhit + this.sys.rng.next() * (1 - Math.min(1, goodhit));
    let mult = 1, tag = '';
    if (goodhit < 0.1 && this.sys.rng.oneIn(3) && !m.has('NOHEAD')) {
      mult = (0.95 + 0.1 * this.sys.rng.next()) * 2;
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
    const units = shot.damage.map((d) => ({ type: d.type, amount: d.amount * mult, armor_penetration: d.armor_penetration, armor_multiplier: 1 }));
    const total = Math.floor(applyFlatArmor(units, m.type.armor).reduce((s, d) => s + d.amount, 0));
    game.message(total > 0 ? `You shoot ${m.theName()} for ${total} damage.${tag}` : `You shoot ${m.theName()} but do no damage.`);
    sfx.bulletHit('flesh', m);
    this.sys.hurt(m, total, 'player');
    return true;
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

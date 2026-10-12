import type { GameData, MonsterAttack, MonsterDef } from '../data/types';
import { monsterName } from '../data/index';
import { warnOnce } from '../data/warn';
import { Rng } from '../core/rng';
import { ACTION_SCALE, clockScale, SECONDS_PER_DAY } from '../core/time';
import { BALANCE } from './balance';
import { sizeFromVolume, sizeMeleePenalty, type CreatureSize } from './combat';
import type { Item } from './item';

// A live creature instance of a CDDA MonsterDef (monster.cpp). Positions are float tiles like
// the player's. All timers here are REAL seconds of action time: CDDA "moves"/"turns" are
// converted with ACTION_SCALE (1 turn = 1/ACTION_SCALE s), so a speed-100 monster acts as
// often as a speed-100 survivor.

export type Attitude = 'attack' | 'follow' | 'ignore' | 'flee' | 'friend';

/** Short-lived real-time status on a monster (seconds left). */
export type MonEffect = 'stunned' | 'downed' | 'grabbing' | 'boomered' | 'onfire' | 'fleeing' | 'hit_by_player' | 'poison' | 'badpoison';

/**
 * BN effects.json mods a monster gets from poison (monster::process_one_effect reads SPEED,
 * DODGE, HIT and HURT). HURT rolls one_in(hurtOneIn) each turn.
 */
export const MON_POISON = {
  poison: { speed: 0, dodge: 0, hit: 0, hurtOneIn: 450, hurt: [1, 1] },
  badpoison: { speed: -10, dodge: -2, hit: -2, hurtOneIn: 60, hurt: [1, 2] },
} as const;

export interface SpecialAttackState {
  /** Entry from MonsterDef.special_attacks, merged over misc.monster_attack when referenced. */
  def: MonsterAttack & Record<string, any>;
  /** Real seconds until usable again. */
  cooldown: number;
}

export interface MonsterWindup {
  t: number;
  total: number;
  kind: 'melee' | 'heavy' | 'leap';
  /** Special attack being wound up (grab, bite, smash, leap); null = plain melee. */
  special: SpecialAttackState | null;
}

let nextUid = 1;

/** CDDA turns -> real seconds of action time. */
export const turnsToSeconds = (turns: number) => turns / ACTION_SCALE;
/**
 * CDDA effect durations on the *player* are in turns but Character effects tick in game
 * seconds (clockScale() per real second). A 2-turn "downed" must still last 2/ACTION_SCALE
 * real seconds, so scale turns into game seconds.
 */
export const turnsToEffectSeconds = (turns: number) => (turns * clockScale()) / ACTION_SCALE;

export function monsterSize(def: MonsterDef): CreatureSize {
  return sizeFromVolume(def.volume);
}

/** Collision radius in tiles. Kept < 0.5 so even hulks fit through a 1-tile door. */
export function monsterRadius(def: MonsterDef): number {
  return { tiny: 0.16, small: 0.24, medium: 0.3, large: 0.38, huge: 0.45 }[monsterSize(def)];
}

/** Integer size for data conditions like "u_val('size') > n_val('size')" (CDDA creature_size). */
export const SIZE_RANK: Record<CreatureSize, number> = { tiny: 1, small: 2, medium: 3, large: 4, huge: 5 };

/**
 * BN names some zombies by the job they had ("nurse", "surgeon"). In a first-person game
 * "You spot a nurse to the west!" reads as a survivor to rescue (wave-3 playtest), so the
 * name says what it is now. Only zombies (species ZOMBIE) whose name is a bare job word.
 */
const JOB_NAMED_ZOMBIES = new Set(['nurse', 'surgeon']);
export function zombieAwareName(def: Pick<MonsterDef, 'name' | 'name_plural'> & { species?: string[] }): string {
  const n = monsterName(def);
  return def.species?.includes('ZOMBIE') && JOB_NAMED_ZOMBIES.has(n) ? `zombie ${n}` : n;
}

/** BN world options (options.cpp defaults): MONSTER_UPGRADE_FACTOR, EVOLVE_MAX_ITERS. */
export const MONSTER_UPGRADE_FACTOR = 2;
export const EVOLVE_MAX_ITERS = 5;

/**
 * BN monster::next_upgrade_time: one guaranteed day, then each (half_life ×
 * MONSTER_UPGRADE_FACTOR) period has a 50% chance to be the one the upgrade lands in, for at
 * most EVOLVE_MAX_ITERS periods (ALWAYS_EVOLVE off). Returns days from now, or -1 if it never
 * upgrades.
 */
export function nextUpgradeDay(def: MonsterDef, rng: Rng): number {
  const up = def.upgrades;
  if (!up || (!up.into && !up.into_group)) return -1;
  if (up.age_grow && up.age_grow > 0) return up.age_grow;
  const halfLife = Math.trunc((up.half_life ?? 0) * MONSTER_UPGRADE_FACTOR);
  if (halfLife <= 0) return -1;
  let day = 1;
  for (let i = 0; i < EVOLVE_MAX_ITERS; i++) {
    if (rng.oneIn(2)) return day + rng.int(0, halfLife);
    day += halfLife;
  }
  return -1;
}

/**
 * Faction relation of a monster toward the player (monster_faction data + attitude rules).
 * Zombies & co. are hostile via aggression 100; animals depend on aggression/morale, so we
 * only special-case factions that are explicitly friendly to the player.
 */
export function isFriendlyFaction(def: MonsterDef): boolean {
  return def.default_faction === 'player' || def.default_faction === 'pet';
}

export class Monster {
  readonly uid = nextUid++;
  type: MonsterDef;
  x: number;
  y: number;
  z: number;
  hp: number;
  /** Radians, 0 = north (-y), clockwise like the player's yaw. */
  facing = 0;
  anger: number;
  morale: number;
  /** CDDA aggro_character: becomes true when a character hurts it. */
  aggroCharacter: boolean;
  friendly = false;
  /** Seconds left per effect. */
  readonly effects = new Map<MonEffect, number>();
  /** Real seconds until the next melee swing / action. */
  attackCooldown = 0;
  /** Real seconds the monster is busy (special attack wind-up, bashing). */
  busy = 0;
  readonly specials: SpecialAttackState[] = [];
  /** Absolute game day at which to evolve; -1 never. */
  upgradeDay = -1;
  /** CDDA wander_pos/wandf: where noise led us and how many real seconds we keep going. */
  wanderX = 0;
  wanderY = 0;
  wanderZ: number | null = null;
  wanderTime = 0;
  /** Last known player position (seen) and how long ago. */
  lastSeenX = 0;
  lastSeenY = 0;
  lastSeenAge = Infinity;
  seesPlayer = false;
  /** True while outside the reality bubble: kept, not simulated. */
  dormant = true;
  /**
   * Member of a city horde (CDDA overmap mongroup with horde = true). Only these hear loud
   * noises from outside the reality bubble (sounds.cpp signal_hordes); other dormant monsters
   * are "unloaded" and deaf, as in CDDA.
   */
  horde = false;
  /**
   * Put there on purpose by a script or the debug API (cdda.spawnMonster), not by mapgen or the
   * spawner. The fresh-start clearing (progression startClearVictims) leaves these alone.
   */
  scripted = false;
  dead = false;
  /** Current path (tile centres) toward goal and bookkeeping for re-planning. */
  path: [number, number][] = [];
  pathGoalX = 0;
  pathGoalY = 0;
  pathAge = 0;
  pathPending = false;
  /** Stuck detection for bashing. */
  stuckTime = 0;
  /** Staggers AI thinking across ticks. */
  thinkTimer: number;
  /** Real seconds since last idle wander pick / speech. */
  idleTimer = 0;
  /** Whether this monster already triggered the "spotted" safe-mode warning. */
  spotted = false;
  /** Walk animation phase (renderer reads it). */
  walkPhase = 0;
  moving = false;
  /** Velocity of the last tick (tiles/s), for rendering and leap. */
  vx = 0;
  vy = 0;
  /** Seconds left of a forced move (leap / knockback) and its velocity. */
  dashTime = 0;
  dashVx = 0;
  dashVy = 0;
  /** Accumulated damage flash for the renderer (set to >0 when hit). */
  hitFlash = 0;
  /**
   * An attack being telegraphed (combatfeel.ts): `t` seconds left of `total`, then the CDDA
   * attack runs if the survivor is still within reach (monai.ts). Rooted meanwhile.
   */
  windup: MonsterWindup | null = null;
  /** Seconds left of a hit flinch (the renderer rocks the sprite; AI pauses). */
  flinch = 0;
  /** Stumble wobble state (STUMBLES). */
  wobble: number;
  /** MonsterSystem.time until which SHRIEK_ALERT's "shrieking" lasts (enables SHRIEK_STUN). */
  shriekingUntil = 0;
  /** RESURRECT charge-up ("raising"): > 0 once the necromancer has thrown its arms wide. */
  raising = 0;
  /** Speech/sound bookkeeping. */
  name?: string;
  /**
   * Arrows and bolts stuck in it (BN monster::add_item from drop_or_embed_projectile). A cargo-like
   * place so moves.ts moves them (L.cargo(m.stuck)); they fall where it dies (monai.die).
   * `hits` says where each arrow of a stack struck, for the renderer: sideways share of the
   * radius, height share of the body, and the flight's yaw relative to the monster's facing.
   */
  readonly stuck: { items: Item[]; def: { name: string; size: number }; hits: Map<Item, { side: number; hgt: number; yaw: number }[]> } = {
    items: [], def: { name: 'creature', size: 1e9 }, hits: new Map(), // no volume limit: BN monsters carry whatever sticks
  };
  readonly rng: Rng;

  constructor(readonly data: GameData, type: MonsterDef, x: number, y: number, z: number, rng: Rng) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.z = z;
    this.rng = rng;
    this.hpScale = BALANCE.monsterResilience;
    this.hp = this.hpMax;
    this.anger = type.aggression;
    this.morale = type.morale;
    this.aggroCharacter = (type as any).aggro_character !== false;
    this.thinkTimer = rng.next() * 0.25;
    this.wobble = rng.next() * Math.PI * 2;
    this.facing = rng.next() * Math.PI * 2;
    this.initSpecials();
  }

  private initSpecials(): void {
    this.specials.length = 0;
    const table = this.data.misc?.monster_attack ?? {};
    for (const sa of this.type.special_attacks ?? []) {
      const base = table[sa.id];
      // Inline fields ({"id":"smash","throw_strength":96}) override the shared definition.
      const def = base ? { ...base, ...sa } : { ...sa };
      const cd = typeof def.cooldown === 'number' ? def.cooldown : 0;
      // CDDA starts special attacks on a random fraction of their cooldown.
      this.specials.push({ def, cooldown: turnsToSeconds(this.rng.int(0, Math.max(0, cd))) });
    }
  }

  get def(): MonsterDef {
    return this.type;
  }
  get id(): string {
    return this.type.id;
  }
  /** BN MONSTER_RESILIENCE at creation (difficulty); hit points are type.hp × this. */
  hpScale = 1;
  get hpMax(): number {
    return Math.max(1, Math.round(this.type.hp * this.hpScale));
  }
  get size(): CreatureSize {
    return monsterSize(this.type);
  }
  get radius(): number {
    return monsterRadius(this.type);
  }
  get tileX(): number {
    return Math.floor(this.x);
  }
  get tileY(): number {
    return Math.floor(this.y);
  }

  has(flag: string): boolean {
    return this.type.flags.includes(flag);
  }
  inSpecies(s: string): boolean {
    return this.type.species.includes(s);
  }
  hasEffect(e: MonEffect): boolean {
    return (this.effects.get(e) ?? 0) > 0;
  }
  addEffect(e: MonEffect, seconds: number): void {
    this.effects.set(e, Math.max(this.effects.get(e) ?? 0, seconds));
  }

  /** monster::is_immune_effect: poisons only take in warm-blooded flesh. */
  resistsPoison(): boolean {
    return !this.has('WARM') || !this.type.material.some((m) => m === 'flesh' || m === 'iflesh');
  }

  /** Sum of one mod over the active poisons (BN adds every effect's bonus). */
  private poisonMod(k: 'speed' | 'dodge' | 'hit'): number {
    let v = 0;
    for (const id of ['poison', 'badpoison'] as const) if (this.hasEffect(id)) v += MON_POISON[id][k];
    return v;
  }
  /** monster hit_bonus from effects (melee accuracy). */
  hitBonus(): number {
    return this.poisonMod('hit');
  }

  /** "zombie" (or the mapgen-given name). */
  displayName(): string {
    return this.name ?? zombieAwareName(this.type);
  }
  /** "the zombie" for messages. */
  theName(): string {
    return this.name ?? `the ${zombieAwareName(this.type)}`;
  }
  /** "The zombie" at sentence start. */
  TheName(): string {
    const n = this.theName();
    return n[0].toUpperCase() + n.slice(1);
  }

  /** Effective dodge for the player's to-hit roll (monster::get_dodge). */
  dodge(): number {
    if (this.hasEffect('downed') || this.hasEffect('stunned')) return 0;
    let d = this.type.dodge;
    if (this.hasEffect('grabbing')) d = Math.max(0, d - 8);
    return Math.max(0, d + this.poisonMod('dodge'));
  }
  sizeMeleePenalty(): number {
    return sizeMeleePenalty(this.size);
  }

  /** monster::speed with stun/downed/fire slowdowns (real-time tiles per second on move_cost). */
  moveSpeed(moveCost: number): number {
    if (this.dead || this.hasEffect('downed')) return 0;
    let cost = this.has('FLIES') ? 100 : Math.max(moveCost, 1);
    // Diggers/swimmers ignore terrain costs of their medium (simplified).
    if (this.has('SWIMS') && moveCost > 100) cost = 100;
    // BALANCE.monsterSpeed: the difficulty's BN MONSTER_SPEED (walking only; swing rates stay BN's).
    let s = (this.speed / cost) * ACTION_SCALE * BALANCE.monsterSpeed;
    if (this.hasEffect('stunned')) s *= 0.5;
    return s;
  }

  /** Effective speed in CDDA moves for action costs (base speed plus effect speed bonuses). */
  get speed(): number {
    return Math.max(1, this.type.speed + this.poisonMod('speed'));
  }

  /**
   * monster::attitude toward the player, following monster.cpp: fleeing effect, aggro,
   * morale < 0 -> flee (or follow if angry enough & healthy), anger <= 0 -> ignore
   * (or flee when badly hurt), anger < 10 -> follow, else attack.
   */
  attitude(): Attitude {
    if (this.friendly) return 'friend';
    if (this.hasEffect('fleeing')) return 'flee';
    if (!this.aggroCharacter) return 'ignore';
    const anger = this.anger, morale = this.morale;
    if (morale < 0) {
      if (morale + anger > 0 && this.hp > this.hpMax / 3) return 'follow';
      return 'flee';
    }
    if (anger <= 0) return this.hp <= 0.6 * this.hpMax ? 'flee' : 'ignore';
    if (anger < 10) return 'follow';
    return 'attack';
  }

  isHostile(): boolean {
    return this.attitude() === 'attack';
  }

  /**
   * monster::sight_range: linear blend between vision_night and vision_day by light
   * (0..100, CDDA default_daylight_level = 100).
   */
  sightRange(light: number): number {
    if (!this.has('SEES')) return 0;
    const l = Math.max(0, Math.min(100, light));
    if (l <= 0) return this.type.vision_night;
    if (l >= 100) return this.type.vision_day;
    return (l * this.type.vision_day + (100 - l) * this.type.vision_night) / 100;
  }

  /** CDDA monster::wander_to: go investigate `x,y` for `seconds` unless already on something louder. */
  wanderTo(x: number, y: number, seconds: number, z = this.z): void {
    this.wanderX = x;
    this.wanderY = y;
    this.wanderZ = z;
    this.wanderTime = seconds;
    this.path = [];
  }

  /** Mean melee damage per hit (danger estimates / tests). */
  meanMeleeDamage(): number {
    let d = this.type.melee_dice * (this.type.melee_dice_sides + 1) / 2;
    for (const u of this.type.melee_damage ?? []) d += u.amount;
    return d;
  }

  /** Days since cataclysm when this monster should evolve, rolled at spawn. */
  rollUpgrade(currentDay: number): void {
    const d = nextUpgradeDay(this.type, this.rng);
    this.upgradeDay = d < 0 ? -1 : currentDay + d;
  }

  /** Turn into another monster type (upgrades, revives). Keeps position; hp scales. */
  polymorph(type: MonsterDef): void {
    const frac = this.hp / Math.max(1, this.hpMax);
    this.type = type;
    this.hp = Math.max(1, Math.round(this.hpMax * frac));
    this.anger = type.aggression;
    this.morale = type.morale;
    this.initSpecials();
  }
}

/** Pick the upgrade target for a monster at `day` (monster::try_upgrade). */
export function upgradeTarget(data: GameData, def: MonsterDef, rng: Rng, pick: (group: string) => string | undefined): MonsterDef | undefined {
  const up = def.upgrades;
  if (!up) return undefined;
  const id = up.into ?? (up.into_group ? pick(up.into_group) : undefined);
  if (!id || id === 'mon_null') return undefined;
  const t = data.monsters[id];
  if (!t) warnOnce('monster', id);
  void rng;
  return t;
}

/** Game day from game-clock seconds. */
export const dayOf = (seconds: number) => Math.floor(seconds / SECONDS_PER_DAY);

import { Rng, hashSeed } from '../core/rng';
import { MonsterStash } from './monstash';
import { ACTION_SCALE, MELEE_SCALE } from '../core/time';
import { pickFromMonsterGroup, expandItemGroup, getMonster, monsterName } from '../data/index';
import { warnOnce } from '../data/warn';
import type { MonsterDef } from '../data/types';
import type { Game, GameSystem } from './game';
import { moveWithCollision, CREATURE_RADIUS } from './physics';
import { Monster, dayOf, turnsToSeconds, upgradeTarget } from './monster';
import { Grid, clearWalk, hasLOS } from './los';
import { findPath } from './pathfind';
import { defaultMelee, trySpecial } from './monattack';
import { monsterMeleeAttack, type MonsterAttackResult } from './combat';
import type { Character } from './character';
import { BODY_PARTS } from './bodyparts';
import { createItem, fromSpawned, type Item } from './item';
import type { BodyPartId } from './bodyparts';
import { sfx } from '../audio/sfx';
import { bash } from './bash';
import { addField, fieldDamageAt } from './fields';
import { emitSound, heardVolume, type SoundCategory } from './sound';
import { lightAt, playerCanSee } from './vision';

// The monster simulation (CDDA monmove.cpp + monster.cpp, real-time). Monsters live in `all`
// forever once spawned; only those inside the "reality bubble" (ACTIVE_RADIUS tiles of the
// player, z +-1) are simulated each tick. The rest are dormant except for cheap horde drift
// toward loud noises they heard, so gunfire still pulls zombies in from afar like CDDA's
// overmap hordes.
//
// Per active monster per tick: timers -> (staggered, ~4 Hz) perceive + plan a goal -> special
// attacks -> melee -> move toward the goal (straight when the corridor is clear, else A* with
// a global per-tick node budget) -> separation from other monsters and the player.

export const ACTIVE_RADIUS = 60;
/** How often each monster re-plans (s). Staggered by a random phase per monster. */
const THINK_INTERVAL = 0.25;
/** A* expansions allowed per tick across all monsters. */
const PATH_BUDGET = 2500;
/** Seconds a hostile keeps chasing the last seen player position. */
const MEMORY = 8;
/** Player's own collision radius (physics.ts). */
const PLAYER_RADIUS = CREATURE_RADIUS;

export type GoalKind = 'none' | 'chase' | 'wander' | 'flee' | 'idle' | 'follow';

interface MonBrain {
  goal: GoalKind;
  gx: number;
  gy: number;
  speedMul: number;
  direct: boolean;
}

export interface Projectile {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  t: number;
  glyph: { symbol: string; color: string };
  onArrive: () => void;
}

/**
 * A creature other than the survivor that hostile monsters hunt (NPCs). Supplied by the NPC
 * system through MonsterSystem.extraTargets so monai.ts needs no NPC imports.
 */
export interface MonsterTarget {
  x: number;
  y: number;
  z: number;
  readonly dead: boolean;
  /** Character body that takes the hit (monsterMeleeAttack). */
  character: Character;
  /** "Rita Mendez" for messages. */
  name: string;
  /** Called after a monster attack resolved (damage after armor, 0 on a miss). */
  onHit(m: Monster, damage: number): void;
}

export interface CorpseRecord {
  item: Item;
  x: number;
  y: number;
  z: number;
  monId: string;
  /** Game seconds at death. */
  diedAt: number;
  /** Facing when it fell, for the renderer. */
  facing: number;
  /** CDDA dormant zombie (pseudo_dormant_* spawns): lies as a corpse until someone comes close. */
  dormant?: boolean;
}

/** pseudo_dormant_mon_zombie_fat -> mon_zombie_fat, mon_pseudo_dormant_zombie -> mon_zombie. */
export function dormantBase(id: string): string | null {
  if (id.startsWith('pseudo_dormant_')) return id.slice('pseudo_dormant_'.length);
  if (id.startsWith('mon_pseudo_dormant_')) return 'mon_' + id.slice('mon_pseudo_dormant_'.length);
  return null;
}

/** Sun/moon light 0..100 at an hour of day (CDDA default_daylight_level = 100). */
export function ambientLight(hour: number): number {
  const MOON = 5;
  if (hour >= 7 && hour <= 18) return 100;
  if (hour >= 5 && hour < 7) return MOON + ((hour - 5) / 2) * (100 - MOON);
  if (hour > 18 && hour <= 20) return MOON + ((20 - hour) / 2) * (100 - MOON);
  return MOON;
}

export class MonsterSystem implements GameSystem {
  readonly name = 'monsters';
  readonly all: Monster[] = [];
  active: Monster[] = [];
  readonly corpses: CorpseRecord[] = [];
  readonly projectiles: Projectile[] = [];
  /** Kill counts by monster id (mirrored into game.stats.kills when the UI provides it). */
  readonly kills = new Map<string, number>();
  readonly grid: Grid;
  readonly rng: Rng;
  grabbedBy: Monster | null = null;
  activeRadius = ACTIVE_RADIUS;
  /** Other creatures hostile monsters attack (NPCs); set by the NPC system. */
  extraTargets: () => MonsterTarget[] = () => [];
  /** Current non-player target per monster (chosen in think()). */
  readonly creatureTargets = new Map<Monster, MonsterTarget>();
  /** Extra light (0..100) the player carries, e.g. a lit flashlight; set by the renderer wiring. */
  playerLight: () => number = () => 0;
  /** Renderer/UI listeners. */
  readonly onSpawned: ((m: Monster) => void)[] = [];
  readonly onRemoved: ((m: Monster) => void)[] = [];
  readonly onDied: ((m: Monster, corpse: CorpseRecord | null) => void)[] = [];
  readonly onHurt: ((m: Monster, amount: number) => void)[] = [];
  readonly onCorpseGone: ((c: CorpseRecord) => void)[] = [];
  /** A corpse appeared without a death (dormant zombies placed by the spawner). */
  readonly onCorpse: ((c: CorpseRecord) => void)[] = [];
  /** Seconds since system start. */
  time = 0;
  private brains = new Map<Monster, MonBrain>();
  private activeTimer = 0;
  private dormantTimer = 0;
  private upgradeTimer = 0;
  private fieldTimer = 0;
  private spatial = new Map<number, Monster[]>();
  private pathQueue: Monster[] = [];
  private pathBudget = 0;
  private lastPX = NaN;
  private lastPY = NaN;
  private grabRollTimer = 0;
  private lightCache = 100;
  private dirty = false;
  /** Far idle monsters and evicted dormant corpses, per OMT column (monstash.ts). */
  readonly stash: MonsterStash;

  constructor(readonly game: Game) {
    this.grid = new Grid(game.map);
    this.stash = new MonsterStash(this);
    this.rng = new Rng(hashSeed(game.seed, 0x6d6f6e));
    game.events.on('sound', (s) => this.hear(s.x, s.y, s.z, s.volume, s.source));
  }

  // ------------------------------------------------------------------ population

  spawn(def: MonsterDef, x: number, y: number, z: number, opts: { friendly?: boolean; name?: string; rng?: Rng } = {}): Monster {
    const rng = opts.rng ?? new Rng(hashSeed(this.game.seed, Math.floor(x * 16), Math.floor(y * 16), z, this.all.length));
    const m = new Monster(this.game.data, def, x, y, z, rng);
    if (opts.friendly) m.friendly = true;
    if (opts.name) m.name = opts.name;
    m.rollUpgrade(dayOf(this.game.clock.seconds));
    this.all.push(m);
    this.brains.set(m, { goal: 'none', gx: x, gy: y, speedMul: 1, direct: true });
    // Newly spawned monsters near the player join the bubble immediately.
    if (this.inBubble(m)) this.activate(m);
    for (const f of this.onSpawned) f(m);
    return m;
  }

  spawnById(id: string, x: number, y: number, z: number, opts: { friendly?: boolean; name?: string; rng?: Rng } = {}): Monster | null {
    const def = getMonster(this.game.data, id);
    return def ? this.spawn(def, x, y, z, opts) : null;
  }

  remove(m: Monster): void {
    m.dead = true;
    this.dirty = true;
  }

  private inBubble(m: Monster): boolean {
    const p = this.game.player;
    return Math.abs(m.z - p.z) <= 1 && Math.max(Math.abs(m.x - p.x), Math.abs(m.y - p.y)) <= this.activeRadius && this.grid.known(m.tileX, m.tileY, m.z);
  }

  private activate(m: Monster): void {
    if (!m.dormant) return;
    m.dormant = false;
    this.active.push(m);
    // Dormant drift ignores walls; pop out of any wall we ended up inside.
    if (!this.grid.passable(m.tileX, m.tileY, m.z)) {
      outer: for (let r = 1; r <= 4; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (this.grid.passable(m.tileX + dx, m.tileY + dy, m.z)) {
              m.x = m.tileX + dx + 0.5;
              m.y = m.tileY + dy + 0.5;
              break outer;
            }
          }
    }
  }

  private refreshActive(): void {
    for (const m of this.all) {
      if (m.dead) continue;
      const inside = this.inBubble(m);
      if (inside && m.dormant) this.activate(m);
      else if (!inside && !m.dormant) m.dormant = true;
    }
    this.active = this.active.filter((m) => !m.dormant && !m.dead);
  }

  // ------------------------------------------------------------------ queries

  distToPlayer(m: Monster): number {
    const p = this.game.player;
    return Math.hypot(m.x - p.x, m.y - p.y) + (m.z !== p.z ? 100 : 0);
  }

  /** Center distance at which `m` can hit the player with a reach-`range` attack. */
  reach(m: Monster, range = 1): number {
    return m.radius + PLAYER_RADIUS + 0.75 + (range - 1);
  }

  inMeleeRange(m: Monster, range = 1): boolean {
    const p = this.game.player;
    if (p.dead || m.z !== p.z) return false;
    if (this.distToPlayer(m) > this.reach(m, range)) return false;
    return hasLOS(this.grid, m.tileX, m.tileY, p.tileX, p.tileY, m.z) && this.noWallBetween(m.x, m.y, p.x, p.y, m.z);
  }

  /** Diagonal attacks can't squeeze between two walls (CDDA can't attack through corners). */
  private noWallBetween(ax: number, ay: number, bx: number, by: number, z: number): boolean {
    const tx0 = Math.floor(ax), ty0 = Math.floor(ay), tx1 = Math.floor(bx), ty1 = Math.floor(by);
    if (tx0 !== tx1 && ty0 !== ty1) return this.grid.passable(tx1, ty0, z) || this.grid.passable(tx0, ty1, z);
    return true;
  }

  /** Straight unobstructed line from the monster to a point (projectiles, leaps). */
  clearLine(m: Monster, x: number, y: number): boolean {
    return clearWalk(this.grid, m.x, m.y, x, y, m.z, 0.05);
  }

  /** Light level at the player as seen by monsters: ambient (dimmer under a roof) + carried light. */
  playerLightLevel(): number {
    return this.lightCache;
  }

  /**
   * vision.ts lightAt at the survivor's tile (sun/moon through windows, lamps, fires, a lit
   * flashlight they carry): CDDA uses the light at the *target* to decide visibility.
   */
  private computeLight(): number {
    const p = this.game.player;
    return Math.max(lightAt(this.game, p.tileX, p.tileY, p.z), this.playerLight());
  }

  /** Effective range at which `m` notices the player (vision_day/night, crouching). */
  sightRangeToPlayer(m: Monster): number {
    let r = m.sightRange(this.lightCache);
    if (this.game.player.crouching) r *= 0.6;
    if (m.hasEffect('boomered')) r = Math.min(r, 1);
    return r;
  }

  /** Can the player see this monster? (vision.ts playerCanSee: range, LOS, light at its tile) */
  playerSees(m: Monster): boolean {
    const p = this.game.player;
    if (m.z !== p.z || p.dead) return false;
    if (p.hasEffect('boomered') || p.hasEffect('blind')) return this.distToPlayer(m) <= 1.5;
    // A debug/renderer flashlight isn't an item, so it doesn't show up in lightAt: let it
    // reveal what stands in front of the survivor.
    if (this.playerLight() > 0 && this.distToPlayer(m) <= 20 && hasLOS(this.grid, p.tileX, p.tileY, m.tileX, m.tileY, p.z)) return true;
    return playerCanSee(this.game, m.tileX, m.tileY, m.z);
  }

  /** Live monster standing on a tile (bubble only), for look mode / raycasts. */
  monsterAt(x: number, y: number, z: number): Monster | null {
    const l = this.spatial.get(key(x, y, z));
    if (l) for (const m of l) if (!m.dead && m.tileX === x && m.tileY === y && m.z === z) return m;
    return null;
  }

  monstersNear(x: number, y: number, z: number, r: number): Monster[] {
    const out: Monster[] = [];
    for (const m of this.active) if (!m.dead && m.z === z && Math.hypot(m.x - x, m.y - y) <= r) out.push(m);
    return out;
  }

  // ------------------------------------------------------------------ messages & world effects

  message(text: string, color?: string): void {
    this.game.message(text, color);
  }

  messageIfSeen(m: Monster, text: string, color?: string): void {
    if (this.playerSees(m)) this.message(text, color);
  }

  /** Fights that don't involve the survivor are narrated only up close (see npcai NARRATE_RANGE). */
  private narrateThirdParty(m: Monster, text: string, color?: string): void {
    if (this.distToPlayer(m) <= 20) this.messageIfSeen(m, text, color);
  }

  /**
   * Make a noise through sound.ts (AI hearing via the `sound` event, the survivor's "You hear…"
   * messages, audio). `sfxId: ''` when the caller already played it.
   */
  emitSound(x: number, y: number, z: number, volume: number, description: string, source?: unknown, sfxId?: string, category: SoundCategory = 'combat', ambient = false): void {
    // The survivor's own attacks aren't narrated back to them ("You hear Smack!").
    const mine = source === 'player';
    emitSound(this.game, { x, y, z }, volume, description, { source: mine ? this.game.player : source, sfxId, category, ambient: ambient || mine });
  }

  addField(x: number, y: number, z: number, type: string, intensity: number): void {
    if (!this.grid.known(x, y, z)) return;
    if (!this.game.data.misc.field_type?.[type]) {
      warnOnce('field_type', type);
      return;
    }
    addField(this.game, x, y, z, type, intensity);
  }

  launchProjectile(m: Monster, tx: number, ty: number, tz: number, glyph: { symbol: string; color: string }, speed: number, onArrive: () => void): void {
    const d = Math.max(0.01, Math.hypot(tx - m.x, ty - m.y));
    const t = d / speed;
    this.projectiles.push({ x: m.x, y: m.y, z: tz, vx: (tx - m.x) / t, vy: (ty - m.y) / t, t, glyph, onArrive });
  }

  /** Called by attacks after the player took damage: feedback events + HIT_AND_RUN. */
  onPlayerHurt(m: Monster, amount: number, bp?: BodyPartId): void {
    this.game.events.emit('playerHurt', { amount, bp, source: m });
    if (amount > 0) sfx.playerHurt(!this.game.player.male);
    if (m.has('HIT_AND_RUN')) m.addEffect('fleeing', turnsToSeconds(4));
  }

  /** Throw the player away from `m` (smash / hulk swings). */
  knockbackPlayer(m: Monster, tiles: number): void {
    const p = this.game.player;
    const d = Math.max(0.01, Math.hypot(p.x - m.x, p.y - m.y));
    [p.x, p.y] = moveWithCollision(this.game.map, p.x, p.y, p.z, ((p.x - m.x) / d) * tiles, ((p.y - m.y) / d) * tiles);
    p.addEffect('downed', (2 * 24) / ACTION_SCALE);
    this.releaseGrab();
    this.lastPX = p.x;
    this.lastPY = p.y;
  }

  releaseGrab(): void {
    const g = this.grabbedBy;
    if (g) g.effects.delete('grabbing');
    this.grabbedBy = null;
    if (this.game.player.hasEffect('grabbed')) this.game.player.effects.remove('grabbed');
  }

  // ------------------------------------------------------------------ non-player targets (NPCs)

  /** Nearest noticed extra target closer than `playerDist` (monsters go for whoever is nearest). */
  private pickCreatureTarget(m: Monster, playerDist: number): MonsterTarget | null {
    const list = this.extraTargets();
    if (!list.length) return null;
    const range = m.sightRange(this.lightCache);
    let best: MonsterTarget | null = null, bd = Math.min(playerDist, Math.max(range, 3.5));
    for (const t of list) {
      if (t.dead || t.z !== m.z) continue;
      const d = Math.hypot(t.x - m.x, t.y - m.y);
      if (d >= bd) continue;
      if (!hasLOS(this.grid, m.tileX, m.tileY, Math.floor(t.x), Math.floor(t.y), m.z)) continue;
      best = t;
      bd = d;
    }
    return best;
  }

  inMeleeRangeOf(m: Monster, t: MonsterTarget, range = 1): boolean {
    if (t.dead || t.z !== m.z) return false;
    if (Math.hypot(t.x - m.x, t.y - m.y) > this.reach(m, range)) return false;
    return hasLOS(this.grid, m.tileX, m.tileY, Math.floor(t.x), Math.floor(t.y), m.z) && this.noWallBetween(m.x, m.y, t.x, t.y, m.z);
  }

  /** Plain monster melee against an NPC; narrated only when the survivor can see it. */
  private meleeCreature(m: Monster, t: MonsterTarget): void {
    const hasDamage = m.type.melee_dice > 0 || (m.type.melee_damage ?? []).some((u) => u.amount > 0);
    if (!hasDamage) return;
    const c = t.character;
    const sink = c.onMessage;
    c.onMessage = null;
    let res: MonsterAttackResult;
    try {
      res = monsterMeleeAttack(m.type, c, this.rng, { name: m.TheName() });
    } finally {
      c.onMessage = sink;
    }
    if (res.hit) {
      sfx.monsterHit(m);
      const dmg = res.result?.damage ?? 0;
      const part = BODY_PART_NAMES[res.bp ?? 'torso'] ?? 'body';
      this.narrateThirdParty(m, `${m.TheName()} hits ${t.name}'s ${part}.`, dmg > 0 ? undefined : 'c_light_gray');
      t.onHit(m, dmg);
    } else {
      this.narrateThirdParty(m, `${m.TheName()} misses ${t.name}.`, 'c_light_gray');
      t.onHit(m, 0);
    }
  }

  // ------------------------------------------------------------------ hearing

  /**
   * sounds.cpp process_sounds + monster::hear_sound: heard volume = vol - dist (GOODHEARING
   * 2*vol - dist); position error shrinks with volume; wander time = volume turns (x6 good
   * hearing). Angry monsters walk to it, frightened ones away.
   */
  hear(x: number, y: number, z: number, vol: number, source?: unknown): void {
    if (vol <= 0) return;
    for (const m of this.all) {
      if (m.dead || m === source || !m.has('HEARS')) continue;
      // Sound through floors is heavily muffled.
      const v = m.z === z ? vol : Math.abs(m.z - z) === 1 ? vol / 3 : 0;
      if (v <= 0) continue;
      const dist = Math.max(Math.abs(m.x - x), Math.abs(m.y - y));
      if (v * 2 <= dist) continue;
      const good = m.has('GOODHEARING');
      // In the bubble, sound.ts adds weather and wall muffling; dormant monsters (whose
      // chunks may not exist) use the bare CDDA formula so we never trigger mapgen.
      const volume = m.dormant ? (good ? 2 * v - dist : v - dist) : heardVolume(this.game, { x, y, z, volume: v }, { x: m.tileX, y: m.tileY, z }, good ? 2 : 1);
      if (volume <= 0) continue;
      const err = volume < 2 ? 10 : volume < 5 ? 5 : volume < 10 ? 3 : volume < 20 ? 1 : 0;
      const tx = x + m.rng.int(-err, err), ty = y + m.rng.int(-err, err);
      const wander = turnsToSeconds(volume * (good ? 6 : 1));
      if (wander < m.wanderTime) continue;
      this.trigger(m, 'SOUND', volume);
      if (m.morale >= 0 && m.anger >= 10) m.wanderTo(tx, ty, wander);
      else if (m.morale < 0) m.wanderTo(2 * m.x - tx, 2 * m.y - ty, wander);
    }
  }

  /** monster::process_trigger: anger/fear/placate triggers from data. */
  trigger(m: Monster, kind: string, amount: number): void {
    const t = m.type as any;
    if ((t.anger_triggers as string[] | undefined)?.includes(kind)) m.anger = Math.min(100, m.anger + amount);
    if ((t.fear_triggers as string[] | undefined)?.includes(kind)) m.morale = Math.max(-100, m.morale - amount);
    if ((t.placate_triggers as string[] | undefined)?.includes(kind)) m.anger = Math.max(-100, m.anger - amount);
  }

  // ------------------------------------------------------------------ damage & death

  /**
   * Apply final (post-armor) damage to a monster. Handles HURT triggers, pack anger, blood and
   * death. `source` 'player' makes the monster (and CDDA-style its friends) hostile.
   */
  hurt(m: Monster, amount: number, source: 'player' | Monster | null, opts: { bleedType?: string } = {}): void {
    if (m.dead) return;
    const dmg = Math.max(0, Math.round(amount));
    m.hp -= dmg;
    m.hitFlash = 0.2;
    for (const f of this.onHurt) f(m, dmg);
    if (dmg > 0) {
      this.bleed(m, dmg, opts.bleedType);
      if (source === 'player') {
        m.aggroCharacter = true;
        m.addEffect('hit_by_player', 30);
      }
      this.trigger(m, 'HURT', 1 + Math.floor(dmg / 3));
      // FRIEND_ATTACKED: pack members of the same species join in (dogs, wolves).
      for (const o of this.monstersNear(m.x, m.y, m.z, 15)) {
        if (o === m || o.type.default_faction !== m.type.default_faction) continue;
        this.trigger(o, 'FRIEND_ATTACKED', 15);
        if (source === 'player' && (o.type as any).anger_triggers?.includes('FRIEND_ATTACKED')) o.aggroCharacter = true;
      }
      // Stagger hard hits: CDDA stuns on big bash crits via techniques; a light flinch here.
      if (dmg >= m.hpMax * 0.4 && m.rng.oneIn(3)) m.addEffect('stunned', 0.5);
    }
    if (m.hp <= 0) this.die(m, source);
  }

  /** CDDA monster::bleed / bloodType: warm flesh bleeds fd_blood; BILE/ACID_BLOOD override. */
  bloodType(def: MonsterDef): string | null {
    if (def.flags.includes('ACID_BLOOD')) return 'fd_acid';
    if (def.flags.includes('BILE_BLOOD')) return 'fd_bile';
    if ((def as any).bleed_rate === 0) return null;
    if (def.material.includes('veggy')) return 'fd_blood_veggy';
    if (def.material.includes('iflesh')) return 'fd_blood_insect';
    if (def.material.some((m) => m === 'flesh' || m === 'hflesh') && def.flags.includes('WARM')) return 'fd_blood';
    return null;
  }

  private bleed(m: Monster, dmg: number, override?: string): void {
    const type = override ?? this.bloodType(m.type);
    if (!type) return;
    // Heavier hits spray more; splatter lands under and just behind the monster.
    const n = dmg >= 15 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const x = Math.floor(m.x + (m.rng.next() - 0.5) * 1.5), y = Math.floor(m.y + (m.rng.next() - 0.5) * 1.5);
      if (this.grid.passable(x, y, m.z)) this.addField(x, y, m.z, type, dmg >= 20 ? 2 : 1);
    }
  }

  die(m: Monster, killer: 'player' | Monster | null): void {
    if (m.dead) return;
    m.dead = true;
    this.dirty = true;
    if (this.grabbedBy === m) this.releaseGrab();
    const def = m.type;
    const tx = m.tileX, ty = m.tileY;
    // game.stats.kills is filled by the UI from the creatureDied event (killer === player).
    if (killer === 'player') this.kills.set(def.id, (this.kills.get(def.id) ?? 0) + 1);
    for (const o of this.monstersNear(m.x, m.y, m.z, 15)) if (o.type.default_faction === def.default_faction) this.trigger(o, 'FRIEND_DIED', 15);
    const df = (def.death_function && typeof def.death_function === 'object' ? def.death_function : {}) as { message?: string; corpse_type?: string; effect?: { id?: string } };
    // Overkill gibs the body (CDDA mdeath splatter when damage >> max hp).
    const gibbed = m.hp < -m.hpMax && def.material.includes('flesh');
    const corpseType = gibbed ? 'SPLATTER' : df.corpse_type ?? 'NORMAL';
    const seen = this.playerSees(m);
    if (seen) {
      // Named monsters (mission targets) die by name, as they fought: "Sean McLaughlin dies!"
      const tmpl = gibbed ? 'The %s is torn apart!' : df.message ?? 'The %s dies!';
      const msg = m.name ? tmpl.replace(/\b[Tt]he %s/, m.name).replace('%s', m.name) : tmpl.replace('%s', monsterName(def));
      if (msg) this.message(msg, killer === 'player' ? 'c_light_green' : undefined);
    }
    sfx.monsterDeath(def.id, m, gibbed);
    switch (df.effect?.id) {
      case 'death_boomer': {
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) this.addField(tx + i, ty + j, m.z, 'fd_bile', 1);
        const p = this.game.player;
        if (p.z === m.z && Math.max(Math.abs(p.tileX - tx), Math.abs(p.tileY - ty)) <= 1) {
          p.addEffect('boomered', (5 * 24) / ACTION_SCALE);
          this.message("You're covered in bile!", 'c_red');
        }
        break;
      }
      case 'death_acid':
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (m.rng.oneIn(2) || (i === 0 && j === 0)) this.addField(tx + i, ty + j, m.z, 'fd_acid', 2);
        break;
      default:
        if (df.effect?.id) warnOnce('death_effect', df.effect.id);
    }
    let corpse: CorpseRecord | null = null;
    if (corpseType === 'NORMAL') corpse = this.dropCorpse(m);
    else if (corpseType === 'SPLATTER') {
      const gib = this.bloodType(def) === 'fd_blood' ? 'fd_gibs_flesh' : this.bloodType(def) ?? 'fd_gibs_flesh';
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (m.rng.oneIn(2) || (i === 0 && j === 0)) this.addField(tx + i, ty + j, m.z, gib, 2);
    }
    if (def.death_drops) {
      const rng = new Rng(hashSeed(this.game.seed, m.uid, 0xd40b));
      for (const s of expandItemGroup(this.game.data, def.death_drops, rng)) for (const it of fromSpawned(this.game.data, s)) this.game.map.addItem(tx, ty, m.z, it);
    }
    const blood = this.bloodType(def);
    if (blood && corpseType !== 'SPLATTER') this.addField(tx, ty, m.z, blood, 2);
    this.game.events.emit('creatureDied', { creature: m, killer: killer === 'player' ? this.game.player : killer });
    for (const f of this.onDied) f(m, corpse);
  }

  /** mdeath normal: a "corpse" item carrying the monster type (CDDA item::make_corpse). */
  private dropCorpse(m: Monster): CorpseRecord | null {
    return this.placeCorpse(m.type, m.x, m.y, m.z, { facing: m.facing, name: m.name });
  }

  placeCorpse(def: MonsterDef, x: number, y: number, z: number, opts: { facing?: number; name?: string; dormant?: boolean } = {}): CorpseRecord | null {
    const data = this.game.data;
    if (!data.items.corpse) {
      warnOnce('item', 'corpse');
      return null;
    }
    const it = createItem(data, 'corpse');
    it.vars.corpse = def.id;
    it.vars.corpse_name = monsterName(def);
    it.vars.weight = def.weight;
    it.vars.volume = def.volume;
    if (opts.name) it.vars.name = opts.name;
    this.game.map.addItem(Math.floor(x), Math.floor(y), z, it);
    const rec: CorpseRecord = { item: it, x, y, z, monId: def.id, diedAt: this.game.clock.seconds, facing: opts.facing ?? 0, dormant: opts.dormant };
    this.corpses.push(rec);
    for (const f of this.onCorpse) f(rec);
    return rec;
  }

  /** Dormant corpses spring up when the survivor comes within a few tiles (CDDA dormant trap). */
  private wakeDormant(): void {
    const p = this.game.player;
    for (const c of [...this.corpses]) {
      if (!c.dormant || c.z !== p.z || Math.hypot(c.x - p.x, c.y - p.y) > 3.5) continue;
      if (!this.corpseValid(c)) continue;
      const m = this.reviveCorpse(c);
      if (m) {
        m.hp = m.hpMax;
        this.messageIfSeen(m, `${m.TheName()} wakes up!`, 'c_red');
      }
    }
  }

  /** Is the corpse item still lying where it fell? (picked up / butchered corpses vanish) */
  corpseValid(c: CorpseRecord): boolean {
    return this.game.map.itemsAt(Math.floor(c.x), Math.floor(c.y), c.z).includes(c.item as any);
  }

  /** Forget a corpse whose item was consumed (butchered); removes it from the map too. */
  removeCorpseItem(item: Item, x: number, y: number, z: number): void {
    this.game.map.removeItem(x, y, z, item as any);
    const i = this.corpses.findIndex((c) => c.item === item);
    if (i >= 0) {
      const [c] = this.corpses.splice(i, 1);
      for (const f of this.onCorpseGone) f(c);
    }
  }

  findRevivableCorpse(m: Monster, range: number): CorpseRecord | null {
    let best: CorpseRecord | null = null, bd = Infinity;
    for (const c of this.corpses) {
      if (c.z !== m.z) continue;
      const def = this.game.data.monsters[c.monId];
      if (!def || !def.flags.includes('REVIVES') || !def.species.includes('ZOMBIE') || def.flags.includes('NO_NECRO')) continue;
      const d = Math.hypot(c.x - m.x, c.y - m.y);
      if (d > range || d >= bd || !this.corpseValid(c)) continue;
      if (!hasLOS(this.grid, m.tileX, m.tileY, Math.floor(c.x), Math.floor(c.y), m.z)) continue;
      best = c;
      bd = d;
    }
    return best;
  }

  reviveCorpse(c: CorpseRecord): Monster | null {
    const def = this.game.data.monsters[c.monId];
    if (!def) return null;
    this.game.map.removeItem(Math.floor(c.x), Math.floor(c.y), c.z, c.item as any);
    this.corpses.splice(this.corpses.indexOf(c), 1);
    for (const f of this.onCorpseGone) f(c);
    const m = this.spawn(def, c.x, c.y, c.z);
    m.hp = Math.max(1, Math.round(def.hp * 0.75));
    return m;
  }

  // ------------------------------------------------------------------ main loop

  update(game: Game, dt: number, gameDt: number): void {
    this.time += dt;
    this.grid.reset();
    const p = game.player;
    if (isNaN(this.lastPX)) {
      this.lastPX = p.x;
      this.lastPY = p.y;
    }
    this.lightCache = this.computeLight();
    this.activeTimer -= dt;
    if (this.activeTimer <= 0) {
      this.activeTimer = 0.5;
      this.refreshActive();
      this.wakeDormant();
    }
    this.dormantTimer -= dt;
    if (this.dormantTimer <= 0) {
      this.dormantTimer = 1;
      this.driftDormant(1);
    }
    this.stash.update(dt);
    this.fieldTimer -= dt;
    if (this.fieldTimer <= 0) {
      this.fieldTimer = 1 / ACTION_SCALE;
      this.fieldDamage();
    }
    this.upgradeTimer -= gameDt;
    if (this.upgradeTimer <= 0) {
      this.upgradeTimer = 600;
      this.processUpgrades();
    }
    this.buildSpatial();
    this.pathBudget = PATH_BUDGET;
    this.servicePaths();

    for (const m of this.active) {
      if (m.dead) continue;
      this.tickTimers(m, dt);
      m.thinkTimer -= dt;
      if (m.thinkTimer <= 0) {
        m.thinkTimer += THINK_INTERVAL;
        this.think(m);
      }
      this.act(m, dt);
    }
    this.separate();
    this.updateGrab(dt);
    this.updateProjectiles(dt);
    if (this.dirty) this.sweepDead();
    this.lastPX = p.x;
    this.lastPY = p.y;
  }

  private sweepDead(): void {
    this.dirty = false;
    const dead = this.all.filter((m) => m.dead);
    if (!dead.length) return;
    for (let i = this.all.length - 1; i >= 0; i--) if (this.all[i].dead) this.all.splice(i, 1);
    this.active = this.active.filter((m) => !m.dead);
    for (const m of dead) {
      this.brains.delete(m);
      this.creatureTargets.delete(m);
      for (const f of this.onRemoved) f(m);
    }
  }

  private tickTimers(m: Monster, dt: number): void {
    for (const [k, v] of m.effects) {
      const nv = v - dt;
      if (nv <= 0) m.effects.delete(k);
      else m.effects.set(k, nv);
    }
    m.attackCooldown = Math.max(0, m.attackCooldown - dt);
    m.busy = Math.max(0, m.busy - dt);
    m.hitFlash = Math.max(0, m.hitFlash - dt);
    m.wanderTime = Math.max(0, m.wanderTime - dt);
    m.lastSeenAge += dt;
    m.pathAge += dt;
    for (const s of m.specials) s.cooldown = Math.max(0, s.cooldown - dt);
  }

  private buildSpatial(): void {
    this.spatial.clear();
    for (const m of this.active) {
      if (m.dead) continue;
      const k = key(m.tileX, m.tileY, m.z);
      const l = this.spatial.get(k);
      if (l) l.push(m);
      else this.spatial.set(k, [m]);
    }
  }

  /**
   * Perception + planning, CDDA monster::plan (simplified): pick a goal among chasing the
   * player, the last seen position, a heard noise, fleeing, or idle shuffling.
   */
  private think(m: Monster): void {
    const p = this.game.player;
    const brain = this.brains.get(m)!;
    const dist = this.distToPlayer(m);
    const sameZ = m.z === p.z && !p.dead;
    const range = this.sightRangeToPlayer(m);
    m.seesPlayer = sameZ && dist <= range && hasLOS(this.grid, m.tileX, m.tileY, p.tileX, p.tileY, m.z);
    // Very close survivors are noticed by sound/smell even unseen (CDDA scent + footsteps).
    const heardSteps = sameZ && m.has('HEARS') && dist <= (p.crouching ? 1.5 : p.running ? 7 : 3.5) && hasLOS(this.grid, m.tileX, m.tileY, p.tileX, p.tileY, m.z);
    if (m.seesPlayer || heardSteps) {
      m.lastSeenX = p.x;
      m.lastSeenY = p.y;
      m.lastSeenAge = 0;
    }
    if (m.seesPlayer && dist <= 5) {
      this.trigger(m, 'PLAYER_CLOSE', 2);
      if (p.hpPercent() < 50) this.trigger(m, 'PLAYER_WEAK', 2);
    }
    if (m.seesPlayer) this.trigger(m, 'HOSTILE_SEEN', 1);
    // Anger and morale drift back toward the species baseline (monster::process_turn).
    const base = m.type;
    if (m.anger > base.aggression) m.anger -= 0.5;
    else if (m.anger < base.aggression) m.anger += 0.5;
    if (m.morale > base.morale) m.morale -= 0.5;
    else if (m.morale < base.morale) m.morale += 0.5;

    const att = m.attitude();
    brain.speedMul = 1;
    // NPCs nearer than the survivor (or when the survivor is out of sight) draw hostile monsters.
    const other = att === 'attack' && !m.friendly ? this.pickCreatureTarget(m, m.seesPlayer ? dist : Infinity) : null;
    if (other) this.creatureTargets.set(m, other);
    else this.creatureTargets.delete(m);
    if (other) {
      brain.goal = 'chase';
      brain.gx = other.x;
      brain.gy = other.y;
    } else if (att === 'attack' && (m.seesPlayer || (m.lastSeenAge < MEMORY && sameZ))) {
      brain.goal = 'chase';
      [brain.gx, brain.gy] = m.lastSeenAge === 0 ? [p.x, p.y] : [m.lastSeenX, m.lastSeenY];
    } else if (att === 'flee' && sameZ && (m.seesPlayer || dist < 8)) {
      brain.goal = 'flee';
      const d = Math.max(0.01, dist);
      brain.gx = m.x + ((m.x - p.x) / d) * 10;
      brain.gy = m.y + ((m.y - p.y) / d) * 10;
    } else if (att === 'follow' && m.seesPlayer && dist > 4) {
      brain.goal = 'follow';
      brain.gx = p.x;
      brain.gy = p.y;
      brain.speedMul = 0.8;
    } else if (m.wanderTime > 0) {
      brain.goal = 'wander';
      brain.gx = m.wanderX + 0.5;
      brain.gy = m.wanderY + 0.5;
    } else {
      if (brain.goal !== 'idle' && brain.goal !== 'none') {
        // Lost the trail: stand around briefly before shuffling off.
        brain.goal = 'none';
        m.idleTimer = 1 + m.rng.next() * 3;
      }
      m.idleTimer -= THINK_INTERVAL;
      if (m.idleTimer <= 0) {
        m.idleTimer = 3 + m.rng.next() * 9;
        if (m.rng.oneIn(2)) {
          brain.goal = 'idle';
          brain.gx = m.x + (m.rng.next() - 0.5) * 10;
          brain.gy = m.y + (m.rng.next() - 0.5) * 10;
          brain.speedMul = 0.5;
        } else brain.goal = 'none';
      }
    }
    if (brain.goal === 'idle') brain.speedMul = 0.5;
    if (brain.goal !== 'none') {
      const far = Math.hypot(brain.gx - m.x, brain.gy - m.y) > 40;
      brain.direct = !far && clearWalk(this.grid, m.x, m.y, brain.gx, brain.gy, m.z, m.radius * 0.9);
      if (brain.direct) m.path = [];
    }
    // Safe-mode "Spotted" warning the first time a hostile comes into view.
    if (!m.spotted && att === 'attack' && dist <= 50 && this.playerSees(m)) {
      m.spotted = true;
      this.spottedMessage(m);
    }
  }

  private lastSpotted = -Infinity;
  private spottedMessage(m: Monster): void {
    if (this.time - this.lastSpotted < 10) return;
    this.lastSpotted = this.time;
    this.message(`Spotted ${m.displayName()}--safe mode is on!`, 'c_light_red');
  }

  /** Attacks, then movement. */
  private act(m: Monster, dt: number): void {
    const p = this.game.player;
    const brain = this.brains.get(m)!;
    if (m.dashTime > 0) {
      const t = Math.min(dt, m.dashTime);
      m.dashTime -= t;
      [m.x, m.y] = moveWithCollision(this.game.map, m.x, m.y, m.z, m.dashVx * t, m.dashVy * t, m.radius);
      m.moving = true;
      return;
    }
    if (m.hasEffect('downed') || m.hasEffect('stunned') && m.rng.oneIn(3)) {
      m.moving = false;
      return;
    }
    const att = m.attitude();
    if (m.busy <= 0 && att === 'attack' && !p.dead) {
      // Special attacks first (they check their own range/conditions), then plain melee.
      for (const sa of m.specials) {
        if (sa.cooldown > 0 || p.dead) continue;
        const isMelee = sa.def.attack_type === 'melee' || sa.def.attack_type === 'bite';
        // Melee specials (grab, bite) spend the same moves as a plain swing in CDDA, so they
        // wait for the swing cooldown instead of landing on top of it.
        if (isMelee && m.attackCooldown > 0) continue;
        if (trySpecial(this, m, sa)) {
          const cd = typeof sa.def.cooldown === 'number' ? sa.def.cooldown : 0;
          sa.cooldown = Math.max(sa.cooldown, turnsToSeconds(cd));
          const cost = typeof sa.def.move_cost === 'number' ? sa.def.move_cost : 100;
          if (isMelee) m.attackCooldown = Math.max(m.attackCooldown, cost / m.speed / MELEE_SCALE);
          m.busy = Math.max(m.busy, isMelee ? 0.15 : 0);
          this.face(m, p.x, p.y);
          if (p.dead) return;
          break;
        }
      }
      if (m.attackCooldown <= 0 && m.busy <= 0 && !p.dead && this.inMeleeRange(m)) {
        this.face(m, p.x, p.y);
        defaultMelee(this, m);
        m.attackCooldown = (m.type.attack_cost || 100) / m.speed / MELEE_SCALE;
        m.busy = 0.15;
      }
    }
    const ct = this.creatureTargets.get(m);
    if (ct && !ct.dead && att === 'attack' && m.busy <= 0) {
      // Track the target between think() ticks and swing when adjacent.
      brain.gx = ct.x;
      brain.gy = ct.y;
      if (this.inMeleeRangeOf(m, ct)) {
        this.face(m, ct.x, ct.y);
        m.moving = false;
        if (m.attackCooldown <= 0) {
          this.meleeCreature(m, ct);
          m.attackCooldown = (m.type.attack_cost || 100) / m.speed / ACTION_SCALE;
          m.busy = 0.15;
        }
        return;
      }
    }
    if (m.busy > 0 || brain.goal === 'none') {
      m.moving = false;
      return;
    }
    if (brain.goal === 'chase' && !ct && this.inMeleeRange(m)) {
      m.moving = false;
      this.face(m, p.x, p.y);
      return;
    }
    this.moveToward(m, brain, dt);
  }

  private face(m: Monster, x: number, y: number): void {
    m.facing = Math.atan2(x - m.x, -(y - m.y));
  }

  private moveToward(m: Monster, brain: MonBrain, dt: number): void {
    // CDDA IMMOBILE (turrets, fungal towers, lab containment specimens): never moves.
    if (m.type.flags.includes('IMMOBILE')) {
      m.moving = false;
      return;
    }
    let tx = brain.gx, ty = brain.gy;
    const dGoal = Math.hypot(tx - m.x, ty - m.y);
    if (dGoal < 0.35) {
      m.moving = false;
      if (brain.goal === 'wander' || brain.goal === 'idle') brain.goal = 'none';
      return;
    }
    if (!brain.direct) {
      const needNew = !m.path.length || Math.hypot(m.pathGoalX - tx, m.pathGoalY - ty) > 2.5 || m.pathAge > 3 || m.stuckTime > 1;
      if (needNew && !m.pathPending) {
        m.pathPending = true;
        this.pathQueue.push(m);
      }
      if (m.path.length) {
        let [nx, ny] = m.path[0];
        if (Math.hypot(nx + 0.5 - m.x, ny + 0.5 - m.y) < 0.4 && m.path.length > 1) {
          m.path.shift();
          [nx, ny] = m.path[0];
        }
        if (!this.grid.passable(nx, ny, m.z)) {
          // Door/window/furniture in the way: open it or smash it (monmove.cpp bash_at).
          if (Math.hypot(nx + 0.5 - m.x, ny + 0.5 - m.y) < 1.3) {
            this.handleObstacle(m, nx, ny);
            m.moving = false;
            return;
          }
        }
        tx = nx + 0.5;
        ty = ny + 0.5;
      } else if (m.pathPending && m.stuckTime > 0.5) {
        m.moving = false;
        return;
      }
    }
    // Terrain move_cost is in units of 50 moves (CDDA: 2 = flat ground = 100 moves).
    const moveCost = (this.grid.moveCost(m.tileX, m.tileY, m.z) || 2) * 50;
    const speed = m.moveSpeed(moveCost) * brain.speedMul;
    const d = Math.max(0.001, Math.hypot(tx - m.x, ty - m.y));
    let dirx = (tx - m.x) / d, diry = (ty - m.y) / d;
    if (m.has('STUMBLES')) {
      // CDDA stumblers lurch sideways every few steps; a sway keeps that feel in real time.
      m.wobble += dt * (2 + m.rng.next() * 2);
      const a = Math.sin(m.wobble) * 0.55;
      const c = Math.cos(a), s = Math.sin(a);
      [dirx, diry] = [dirx * c - diry * s, dirx * s + diry * c];
    }
    const step = Math.min(speed * dt, d);
    const ox = m.x, oy = m.y;
    [m.x, m.y] = moveWithCollision(this.game.map, m.x, m.y, m.z, dirx * step, diry * step, m.radius);
    const moved = Math.hypot(m.x - ox, m.y - oy);
    m.vx = (m.x - ox) / dt;
    m.vy = (m.y - oy) / dt;
    m.moving = moved > 0.001;
    if (m.moving) {
      m.walkPhase += moved * 3;
      m.facing = Math.atan2(m.x - ox, -(m.y - oy));
    }
    if (moved < step * 0.3) {
      m.stuckTime += dt;
      if (m.stuckTime > 0.4) brain.direct = false;
    } else m.stuckTime = Math.max(0, m.stuckTime - dt);
  }

  /** CDDA: CAN_OPEN_DOORS monsters open doors; BASHES monsters smash through the seam. */
  private handleObstacle(m: Monster, x: number, y: number): void {
    const t = this.grid.ter(x, y, m.z);
    if (!t) return;
    this.face(m, x + 0.5, y + 0.5);
    if (m.has('CAN_OPEN_DOORS') && t.open && this.game.map.terrain.has(t.open)) {
      this.game.map.setTer(x, y, m.z, t.open);
      this.game.events.emit('mapChanged', { x, y, z: m.z });
      sfx.door('open', { x: x + 0.5, y: y + 0.5, z: m.z }, t.id);
      m.busy = 100 / m.speed / ACTION_SCALE;
      return;
    }
    if (!(m.has('BASHES') || m.has('DESTROYS'))) {
      m.path = [];
      return;
    }
    if (m.attackCooldown > 0) return;
    // calc_bash_skill: melee dice max; GROUP_BASH adds helpers pressing on the same obstacle.
    let str = m.type.melee_dice * m.type.melee_dice_sides * (m.has('DESTROYS') ? 2.5 : 1);
    if (m.has('GROUP_BASH')) {
      for (const o of this.monstersNear(x + 0.5, y + 0.5, m.z, 2.5)) if (o !== m && o.has('GROUP_BASH')) str += (o.type.melee_dice * o.type.melee_dice_sides) / 2;
    }
    bash(this.game, x, y, m.z, Math.round(str), { source: m });
    m.attackCooldown = 100 / m.speed / MELEE_SCALE;
    m.path = [];
    m.pathAge = 99;
  }

  /** Budgeted A*: serve queued requests until this tick's node budget runs out. */
  private servicePaths(): void {
    while (this.pathQueue.length && this.pathBudget > 0) {
      const m = this.pathQueue.shift()!;
      m.pathPending = false;
      if (m.dead || m.dormant) continue;
      const brain = this.brains.get(m);
      if (!brain) continue;
      const res = findPath(this.grid, m.tileX, m.tileY, Math.floor(brain.gx), Math.floor(brain.gy), m.z, {
        bash: m.has('BASHES') || m.has('DESTROYS'),
        doors: m.has('CAN_OPEN_DOORS'),
        maxNodes: Math.min(1500, Math.max(200, this.pathBudget)),
        margin: 10,
      });
      this.pathBudget -= res.expanded;
      m.path = res.tiles;
      m.pathGoalX = brain.gx;
      m.pathGoalY = brain.gy;
      m.pathAge = 0;
      m.stuckTime = 0;
    }
  }

  /** Circle separation between monsters and against the player (no walking through bodies). */
  private separate(): void {
    const p = this.game.player;
    for (const m of this.active) {
      if (m.dead) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const l = this.spatial.get(key(m.tileX + dx, m.tileY + dy, m.z));
          if (!l) continue;
          for (const o of l) {
            if (o.uid <= m.uid || o.dead) continue;
            const ddx = o.x - m.x, ddy = o.y - m.y;
            const d = Math.hypot(ddx, ddy);
            const min = (m.radius + o.radius) * 0.9;
            if (d >= min) continue;
            const push = (min - d) / 2;
            const nx = d > 1e-4 ? ddx / d : 1, ny = d > 1e-4 ? ddy / d : 0;
            [m.x, m.y] = moveWithCollision(this.game.map, m.x, m.y, m.z, -nx * push, -ny * push, m.radius);
            [o.x, o.y] = moveWithCollision(this.game.map, o.x, o.y, o.z, nx * push, ny * push, o.radius);
          }
        }
      if (m.z !== p.z || p.dead) continue;
      const ddx = p.x - m.x, ddy = p.y - m.y;
      const d = Math.hypot(ddx, ddy);
      const min = m.radius + PLAYER_RADIUS;
      if (d < min) {
        const nx = d > 1e-4 ? ddx / d : 1, ny = d > 1e-4 ? ddy / d : 0;
        const push = min - d;
        // Big monsters shove the survivor; the survivor can't shove big monsters.
        const pf = m.size === 'large' || m.size === 'huge' ? 0.8 : 0.5;
        [p.x, p.y] = moveWithCollision(this.game.map, p.x, p.y, p.z, nx * push * pf, ny * push * pf);
        [m.x, m.y] = moveWithCollision(this.game.map, m.x, m.y, m.z, -nx * push * (1 - pf), -ny * push * (1 - pf), m.radius);
      }
    }
  }

  /**
   * Grabbed survivors can't walk away: each attempt (at most one per CDDA turn) rolls to
   * break free against the grabber's grab_strength; failure snaps them back.
   */
  private updateGrab(dt: number): void {
    const g = this.grabbedBy;
    const p = this.game.player;
    if (!g) {
      if (p.hasEffect('grabbed')) p.effects.remove('grabbed');
      return;
    }
    if (g.dead || g.dormant || this.distToPlayer(g) > this.reach(g) + 0.4 || p.dead) {
      this.releaseGrab();
      return;
    }
    this.grabRollTimer = Math.max(0, this.grabRollTimer - dt);
    const moved = Math.hypot(p.x - this.lastPX, p.y - this.lastPY);
    if (moved < 1e-4) return;
    if (this.grabRollTimer > 0) {
      p.x = this.lastPX;
      p.y = this.lastPY;
      return;
    }
    this.grabRollTimer = 1 / ACTION_SCALE;
    const strength = (g.type as any).grab_strength ?? 20;
    const roll = this.rng.int(0, p.str + p.dex + p.getSkill('unarmed') * 2 + p.getSkill('melee'));
    if (roll > this.rng.int(0, Math.floor(strength / 2))) {
      this.message(`You break out of ${g.theName()}'s grab!`, 'c_light_green');
      this.releaseGrab();
      g.addEffect('stunned', 0.3);
    } else {
      this.message('You try to break free, but fail!', 'c_red');
      p.x = this.lastPX;
      p.y = this.lastPY;
    }
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      const t = Math.min(dt, pr.t);
      pr.x += pr.vx * t;
      pr.y += pr.vy * t;
      pr.t -= t;
      if (pr.t <= 0) {
        this.projectiles.splice(i, 1);
        pr.onArrive();
      }
    }
  }

  /**
   * Horde drift (overmap-style): dormant monsters that heard something walk straight toward
   * it at half speed, ignoring walls until they enter the bubble and resume real movement.
   */
  private driftDormant(dt: number): void {
    for (const m of this.all) {
      if (!m.dormant || m.dead || m.wanderTime <= 0) continue;
      m.wanderTime = Math.max(0, m.wanderTime - dt);
      const dx = m.wanderX - m.x, dy = m.wanderY - m.y;
      const d = Math.hypot(dx, dy);
      if (d < 1) continue;
      const step = Math.min(d, (m.type.speed / 100) * ACTION_SCALE * 0.5 * dt);
      m.x += (dx / d) * step;
      m.y += (dy / d) * step;
    }
  }

  /** Fire under a monster burns it once per turn (fields.ts fieldDamageAt, CDDA monster::process_effects). */
  private fieldDamage(): void {
    for (const m of this.active) {
      if (m.dead) continue;
      const d = fieldDamageAt(this.game, m.tileX, m.tileY, m.z, { materials: m.type.material, flags: m.type.flags, heatArmor: m.type.armor?.heat ?? 0 });
      if (!d || d.amount <= 0) continue;
      this.hurt(m, d.amount, null);
      m.addEffect('onfire', 1);
      // Burning animals panic; zombies keep coming.
      if (!m.has('UNBREAKABLE_MORALE')) m.morale -= 10;
    }
  }

  /** monster::try_upgrade for monsters in the bubble whose evolution day has come. */
  private processUpgrades(): void {
    const day = dayOf(this.game.clock.seconds);
    for (const m of this.active) {
      if (m.dead || m.upgradeDay < 0 || day < m.upgradeDay) continue;
      const target = upgradeTarget(this.game.data, m.type, m.rng, (g) => pickFromMonsterGroup(this.game.data, g, m.rng, { elapsed: this.game.clock.seconds })[0]?.id);
      if (target) m.polymorph(target);
      m.rollUpgrade(day);
      if (!target) m.upgradeDay = -1;
      for (const f of this.onSpawned) f(m);
    }
  }

  // ------------------------------------------------------------------ danger (activity interrupts)

  /** Nearest hostile the player can see within `range`, for "You see a zombie!" interrupts. */
  visibleHostile(range = 30): Monster | null {
    // Danger checks run every tick during activities; the answer only needs to be ~4 Hz fresh.
    const c = this.hostileCache;
    if (c && c.range === range && this.time - c.t < 0.25 && !(c.m?.dead)) return c.m;
    const m = this.findVisibleHostile(range);
    this.hostileCache = { t: this.time, range, m };
    return m;
  }
  private hostileCache: { t: number; range: number; m: Monster | null } | null = null;

  private findVisibleHostile(range: number): Monster | null {
    let best: Monster | null = null, bd = Infinity;
    for (const m of this.active) {
      if (m.dead || m.attitude() !== 'attack') continue;
      const d = this.distToPlayer(m);
      if (d > range || d >= bd) continue;
      if (!this.playerSees(m)) continue;
      best = m;
      bd = d;
    }
    return best;
  }
}

const BODY_PART_NAMES: Record<string, string> = Object.fromEntries(Object.entries(BODY_PARTS).map(([id, d]) => [id, d.name]));

function key(x: number, y: number, z: number): number {
  return ((x & 0x7ff) | ((y & 0x7ff) << 11) | ((z + 8) << 22)) >>> 0;
}

import { Rng, hashSeed } from '../core/rng';
import { ACTION_SCALE } from '../core/time';
import type { GameData } from '../data/types';
import { pickFromMonsterGroup } from '../data/index';
import { warnOnce } from '../data/warn';
import type { Game, GameSystem } from './game';
import { Grid, clearWalk, hasLOS } from './los';
import { findPath } from './pathfind';
import { moveWithCollision, CREATURE_RADIUS } from './physics';
import { aim, aimFloorMoa, applyFlatArmor, characterDefend, fireGun, hitMessage, meleeAttack, onDodged, pelletAngle, selectBodyPart, tryDodgeRoll, type MeleeResult } from './combat';
import { techniqueMessage, type TargetInfo } from './techniques';
import { tickMartialArts } from './martialarts';
import { turnsToEffectSeconds, turnsToSeconds } from './monster';
import { asArray, createItem, MAX_ITEM_DAMAGE, type Item } from './item';
import { consumeItem, itemsAt, L, moveItem, spawnItem } from './moves';
import type { Monster } from './monster';
import type { MonsterSystem, MonsterTarget } from './monai';
import { applyTechniqueToMonster, meleeVerb, monsterTargetInfo } from './playercombat';
import { emitSound, soundsHeardAt, type SoundCategory } from './sound';
import { sfx } from '../audio/sfx';
import { bresenham, invalidateNaturalLight, playerCanSee, isOutside, isDay } from './vision';
import { FACTION_FOLLOWERS, FACTION_NONE, Npc, generateNpc, restockShop, type NpcData, type NpcJSON, type NpcSpec } from './npc';
import { Dialogue, migrateTalkVars, type TalkWorld } from './talk';
import { NpcRules } from './npcrules';
import { MissionSystem, type MissionHost, type MissionInstance } from './missions';
import type { BodyPartId } from './bodyparts';
import { BODY_PARTS } from './bodyparts';
import { enemyFireOf, lobOf, lobSpeed } from './enemyfire';
import { landsWithEffect, roundEndsAt } from './blast';
import { flightSpeed, fliesVisibly, rangedClass } from './rangedfeel';
import { gunShortfall } from './gunmods';
import { bodyHeightOf } from './aimmodel';
import { LEVEL_HEIGHT, CHUNK } from '../world/coords';
import { consumeNpcFood } from './npcneeds';
import { MAX_RECOIL, SLEEPINESS, THIRST, type Character } from './character';
import { mutationStrikeText, VENOM_TURNS, venomEffect, venomMessage, venomTriggered, type MutationStrike } from './mutationattacks';
import { comfortAt } from './rest';
import { characterWorld } from './characterWorld';
import { hasFlag } from '../world/registry';
import { bash as bashTile, smashAbility } from './bash';
import type { CorpseRecord } from './monai';
import {
  NPC_DANGER_MAX, NPC_DANGER_VERY_LOW, characterDanger, confidenceMult, confidentGunRange, confidentThrowRange, emergency,
  followDistance, gunRange, isSilentGun, meleeValue, monsterDifficulty, okByRules, rlDist, speedRating, targetPriority,
  throwRange, tooClose, wontHitFriend, type EngagementCtx,
} from './npctactics';

/** Tiles within which fights between NPCs and monsters are narrated blow by blow. */
export const NARRATE_RANGE = 20;

// The NPC simulation (CDDA npcmove.cpp, real-time and much simplified). Like MonsterSystem,
// NPCs live forever once spawned and only those in the reality bubble are simulated.
// Each NPC re-plans at ~4 Hz and picks one goal:
//   fight   a hostile monster / NPC (or the survivor for KILL attitude): BN method_of_attack —
//           aim, then shoot within the confident range, reload, melee, close in (follower
//           rules decide targets and whether it may move: see assess / methodOfAttack)
//   flee    from danger when hurt or outmatched, or from the survivor (FLEE_TEMP)
//   follow  the survivor (followers), keeping a couple of tiles away
//   return  to the guard post (guards, shopkeepers, followers told to wait)
//   approach the survivor to talk (TALK) or mug them (MUG)
//   wander  around where they were placed (everyone else)
//   rest / investigate / pulp  BN address_needs and npc_investigate_sound
// This class is also the dialogue world (TalkWorld) and mission host (MissionHost): it owns
// the survivor's dialogue variables, faction trust and the mission list.

export const NPC_ACTIVE_RADIUS = 60;
const THINK = 0.25;
/** Tiles within which NPCs react to hostile monsters. */
const ENGAGE_RANGE = 10;

export interface NpcSpawnOpts {
  /** Stable id (mapgen placement) so the same NPC isn't spawned twice. */
  spawnKey?: string;
  attitude?: Npc['attitude'];
  faction?: string;
  /** Hand out a random mission (random survivors with GETS_RANDOM_MISSION-like luck). */
  randomMission?: boolean;
}

export interface NpcShot {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
  t: number;
}

type Foe = { kind: 'monster'; m: Monster } | { kind: 'npc'; n: Npc } | { kind: 'player' };

/** BN sound_t order (sounds.h): "low priority" sounds are those below alarm. */
const SOUND_ORDER: SoundCategory[] = ['background', 'weather', 'music', 'movement', 'speech', 'electronic_speech', 'activity', 'destructive_activity', 'alarm', 'combat', 'alert', 'order', 'sensory'];
const soundRank = (c: SoundCategory) => SOUND_ORDER.indexOf(c);
/** npc_follower_rules defaults: what non-allies go by (BN only applies the orders to allies). */
const DEFAULT_RULES = new NpcRules();

/**
 * BN npc_short_term_cache (npc.h ai_cache), the parts the follower rules need. Rebuilt by
 * think() at ~4 Hz; not saved (BN rebuilds it every turn too).
 */
interface NpcAiCache {
  /** ai_cache.danger: the current target's danger. */
  danger: number;
  /** ai_cache.danger_assessment (npc::emergency reads it). */
  assessment: number;
  /** ai_cache.total_danger: summed danger over distance (sound investigation stops above 1). */
  totalDanger: number;
  emergency: boolean;
  /** ai_cache.friends: positions of the survivor, allied NPCs and friendly monsters it sees. */
  friends: { x: number; y: number }[];
  /** ai_cache.sound_alerts: noises to investigate (BN npc::handle_sound). */
  soundAlerts: { x: number; y: number; z: number; volume: number }[];
  heardSounds: Set<number>;
  /** ai_cache.guard_pos: where an investigating NPC goes back to. */
  returnTo: { x: number; y: number; z: number } | null;
  /** Seconds spent going after the first alert (BN ai_cache.stuck). */
  investigateTime: number;
  /** npc::pulp_location. */
  pulp: CorpseRecord | null;
  /** Game seconds until which the survivor's hit marks it (effect_hit_by_player, 10 minutes). */
  hitByPlayerUntil: number;
  /** Shown "takes aim at you!" for this aim. */
  aimWarned: boolean;
  /** Tile the NPC stood on before its last step (close_doors closes it behind). */
  lastTile: { x: number; y: number; z: number } | null;
}

export class NpcSystem implements GameSystem, TalkWorld, MissionHost {
  readonly name = 'npcs';
  readonly npcs: Npc[] = [];
  readonly playerVars = new Map<string, string>();
  readonly globals = new Map<string, string>();
  readonly playerTalkEffects = new Map<string, number>();
  readonly factionTrust = new Map<string, number>();
  cash = 0;
  readonly rng: Rng;
  readonly missions: MissionSystem;
  readonly grid: Grid;
  /** Survivor kills by monster id / species (mission goals). */
  readonly kills = new Map<string, number>();
  readonly speciesKills = new Map<string, number>();
  /** Mapgen placements already turned into NPCs. */
  readonly spawnedKeys = new Set<string>();
  readonly shots: NpcShot[] = [];
  activeRadius = NPC_ACTIVE_RADIUS;
  time = 0;

  // Renderer / UI listeners
  readonly onSpawned: ((n: Npc) => void)[] = [];
  /**
   * Walkable stairs (src/stairs.ts): followers take the survivor's flight instead of appearing
   * upstairs. `follow` = start following over the flight (true = handled); `drive` = carry an
   * NPC that is on (or walking to) a flight this tick (true = its movement is done).
   */
  stairs: { follow(n: Npc): boolean; drive(n: Npc, dt: number): boolean } | null = null;
  readonly onRemoved: ((n: Npc) => void)[] = [];
  readonly onDied: ((n: Npc) => void)[] = [];
  readonly onHurt: ((n: Npc, amount: number) => void)[] = [];
  /** An NPC walked up wanting to talk (TALK/MUG attitude); the UI opens the dialogue. */
  onWantsTalk: ((n: Npc) => void) | null = null;
  /** Ask the survivor before attacking a non-hostile NPC; call `yes` to go ahead. */
  confirmAttack: ((n: Npc, yes: () => void) => void) | null = null;

  // TalkWorld / MissionHost hooks the install wires (worldgen, UI)
  startTrade?: TalkWorld['startTrade'];
  pickItem?: TalkWorld['pickItem'];
  pickOption?: TalkWorld['pickOption'];
  cityName?: () => string;
  omtAt?: (x: number, y: number, z: number) => string | undefined;
  findOmt?: MissionHost['findOmt'];
  omtRotation?: MissionHost['omtRotation'];
  reveal?: MissionHost['reveal'];
  mapgenUpdate?: MissionHost['mapgenUpdate'];

  private lastPlayerZ = NaN;
  private lastPX = 0;
  private lastPY = 0;
  private slowTimer = 0;
  private charAcc = new Map<Npc, number>();
  private restRoutingBudget = 1000;
  private readonly aiCache = new WeakMap<Npc, NpcAiCache>();
  private readonly difficultyCache = new Map<string, number>();
  /**
   * An NPC threw an armed explosive that landed at (x, y, z) (npcai alt attack; combatdepth.ts
   * hands it to ArmedExplosives so the fuse burns and the blast goes off there).
   */
  onThrownExplosive: ((it: Item, x: number, y: number, z: number, thrower: Npc) => void) | null = null;

  constructor(readonly game: Game, readonly nd: NpcData, readonly monsters: MonsterSystem | null) {
    this.rng = new Rng(hashSeed(game.seed, 0x6e7063));
    this.grid = new Grid(game.map);
    this.missions = new MissionSystem(this);
    if (monsters) {
      monsters.extraTargets = () => this.targets();
      monsters.onDied.push((m) => this.missions.onMonsterDied(m.uid));
    }
    game.events.on('creatureDied', (e) => {
      if (e.killer !== game.player) return;
      const m = e.creature as Monster | null;
      if (!m?.type) return;
      this.kills.set(m.type.id, (this.kills.get(m.type.id) ?? 0) + 1);
      for (const s of m.type.species ?? []) this.speciesKills.set(s, (this.speciesKills.get(s) ?? 0) + 1);
    });
  }

  // ---------------------------------------------------------------- TalkWorld / MissionHost

  get data(): GameData {
    return this.game.data;
  }
  get player() {
    return this.game.player;
  }
  now(): number {
    return this.game.clock.seconds;
  }
  message(text: string, color?: string): void {
    this.game.message(text, color);
  }
  npcByUid(uid: number): Npc | undefined {
    return this.npcs.find((n) => n.uid === uid);
  }
  killsOf(id: string): number {
    return this.kills.get(id) ?? 0;
  }
  killsOfSpecies(s: string): number {
    return this.speciesKills.get(s) ?? 0;
  }
  dialogueFor(npc: Npc | undefined): Dialogue | null {
    return npc ? new Dialogue(this, npc) : null;
  }
  /** Put a new item (a gift, a mission reward that didn't fit) on the ground. */
  dropItem(it: Item, x: number, y: number, z: number): void {
    spawnItem(it, L.ground(this.game.map, x, y, z), { force: true, quiet: true });
  }
  alliesNear(): Npc[] {
    const p = this.player;
    return this.npcs.filter((n) => !n.dead && n.isAlly() && n.z === p.z && Math.hypot(n.x - p.x, n.y - p.y) < 30);
  }
  totalKills(): number {
    return this.game.stats.kills ? [...Object.values(this.game.stats.kills as unknown as Record<string, number>)].reduce((a, b) => a + b, 0) : 0;
  }
  isDay(): boolean {
    return isDay(this.game.clock);
  }
  isOutside(x: number, y: number, z: number): boolean {
    return isOutside(this.game.map, x, y, z);
  }
  safeSpace(): boolean {
    return !this.monsters?.visibleHostile(30);
  }
  onHostile(n: Npc): void {
    this.alertFaction(n);
  }
  /** BN set_is_driving: at the controls of a vehicle that is moving (vehicle::is_moving: velocity != 0). */
  playerDriving(): boolean {
    const v = this.game.vehicles?.driving;
    return !!v && v.velocity !== 0;
  }
  /**
   * talk_function::go_to_sleep -> npc_sleep: lie down here (BN first looks for a bed within a
   * few tiles; the rest goal in think() does that for tired allies already).
   */
  npcGoToSleep(n: Npc): void {
    n.goal.kind = 'none';
    n.moving = false;
    n.sleepComfort = comfortAt(this.game, n.tileX, n.tileY, n.z).comfort;
    n.addEffect('lying_down', 30 * 60);
    if (playerCanSee(this.game, n.tileX, n.tileY, n.z)) this.message(`${n.name} lies down to sleep.`);
  }
  /** u_buy_monster / spawn_animal (g->place_critter_around): tame monsters on free tiles within 3. */
  spawnPets(monId: string, count: number, at: { x: number; y: number; z: number }, opts: { pacified: boolean; name?: string }): number {
    const def = this.data.monsters[monId];
    if (!def || !this.monsters) return 0;
    let placed = 0;
    for (let r = 1; r <= 3 && placed < count; r++)
      for (let dy = -r; dy <= r && placed < count; dy++)
        for (let dx = -r; dx <= r && placed < count; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = at.x + dx, y = at.y + dy;
          if (!this.grid.passable(x, y, at.z) || this.monsters.monsterAt(x, y, at.z) || this.npcAt(x, y, at.z)) continue;
          if (this.player.z === at.z && this.player.tileX === x && this.player.tileY === y) continue;
          // friendly = BN friendly -1 + effect_pet; friendly monsters never attack you, which is
          // what BN's extra "pacified" effect is for.
          this.monsters.spawn(def, x + 0.5, y + 0.5, at.z, { friendly: true, name: opts.name });
          placed++;
        }
    return placed;
  }

  // ---------------------------------------------------------------- population

  /** Create an NPC from a template id or a class id at a tile position (x, y are tile coords). */
  spawn(spec: NpcSpec, x: number, y: number, z: number, opts: NpcSpawnOpts = {}): Npc | null {
    if (opts.spawnKey && this.spawnedKeys.has(opts.spawnKey)) return null;
    if (spec.template && !this.nd.templates[spec.template]) {
      warnOnce('npc_template', spec.template);
      return null;
    }
    if (!spec.template && spec.cls && !this.nd.classes[spec.cls]) {
      warnOnce('npc_class', spec.cls);
      return null;
    }
    const seed = hashSeed(this.game.seed, Math.floor(x * 7), Math.floor(y * 7), z, this.npcs.length, 0x4e5043);
    const n = generateNpc(this.data, this.nd, spec, seed);
    n.x = Math.floor(x) + 0.5;
    n.y = Math.floor(y) + 0.5;
    n.z = z;
    n.facing = this.rng.next() * Math.PI * 2;
    n.spawnKey = opts.spawnKey;
    if (opts.attitude) n.attitude = opts.attitude;
    if (opts.faction) n.faction = opts.faction;
    if (n.mission === 'GUARD' || n.mission === 'SHOPKEEP' || n.mission === 'GUARD_PATROL' || n.hasTrait('RETURN_TO_START_POS')) n.guardPos = { x: Math.floor(x), y: Math.floor(y), z };
    n.onMessage = null;
    if (n.isShopkeeper() || this.nd.classes[n.classId]?.shopkeeper_item_group?.length) {
      restockShop(this.data, this.nd, n, seed ^ 0x5709, this.factionTrust.get(n.faction) ?? 0);
      n.restockAt = this.now() + 6 * 86400;
    }
    const tem = n.templateId ? this.nd.templates[n.templateId] : undefined;
    const offered = tem?.mission_offered;
    for (const id of Array.isArray(offered) ? offered : offered ? [offered] : []) this.missions.create(id, n);
    if (opts.randomMission && !offered) {
      const id = this.randomMissionId();
      if (id) this.missions.create(id, n);
    }
    if (opts.spawnKey) this.spawnedKeys.add(opts.spawnKey);
    this.npcs.push(n);
    this.placeNpc(n);
    for (const f of this.onSpawned) f(n);
    return n;
  }

  /** mission_type::get_random_id(ORIGIN_OPENER_NPC / ANY_NPC) limited to goals we can track. */
  private randomMissionId(): string | undefined {
    const ok = new Set(['MGOAL_FIND_ITEM', 'MGOAL_KILL_MONSTER_TYPE', 'MGOAL_KILL_MONSTER_SPEC', 'MGOAL_CONDITION']);
    const ids = Object.values(this.nd.missions)
      .filter((m) => ok.has(m.goal) && (m.origins ?? []).some((o) => o === 'ORIGIN_OPENER_NPC' || o === 'ORIGIN_ANY_NPC'))
      .map((m) => m.id)
      .sort();
    return ids.length ? this.rng.pick(ids) : undefined;
  }

  remove(n: Npc): void {
    const i = this.npcs.indexOf(n);
    if (i < 0) return;
    this.npcs.splice(i, 1);
    this.charAcc.delete(n);
    for (const f of this.onRemoved) f(n);
  }

  inBubble(n: Npc): boolean {
    const p = this.player;
    return Math.abs(n.z - p.z) <= 1 && Math.max(Math.abs(n.x - p.x), Math.abs(n.y - p.y)) <= this.activeRadius && this.grid.known(n.tileX, n.tileY, n.z);
  }

  active(): Npc[] {
    return this.npcs.filter((n) => !n.dead && this.inBubble(n));
  }

  npcAt(x: number, y: number, z: number): Npc | null {
    for (const n of this.npcs) if (!n.dead && n.tileX === x && n.tileY === y && n.z === z) return n;
    return null;
  }

  nearest(maxDist = Infinity, filter: (n: Npc) => boolean = () => true): Npc | null {
    const p = this.player;
    let best: Npc | null = null, bd = maxDist;
    for (const n of this.npcs) {
      if (n.dead || n.z !== p.z || !filter(n)) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bd) (bd = d), (best = n);
    }
    return best;
  }

  /** Monster-system view of living NPCs in the bubble. */
  private targets(): MonsterTarget[] {
    const out: MonsterTarget[] = [];
    for (const n of this.npcs) {
      if (n.dead || !this.inBubble(n)) continue;
      out.push({
        get x() { return n.x; }, get y() { return n.y; }, get z() { return n.z; }, get dead() { return n.dead; }, character: n, name: n.name,
        onHit: (m, dmg) => this.afterHit(n, dmg, { kind: 'monster', m }),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- dialogue

  /** Start a conversation, or explain why the NPC won't talk (hostile, asleep, dead). */
  talkTo(n: Npc): Dialogue | null {
    if (n.dead) return null;
    if (n.attitude === 'KILL') {
      this.message(`${n.name} is hostile!`, 'c_red');
      return null;
    }
    if (n.attitude === 'FLEE' || n.attitude === 'FLEE_TEMP') {
      this.message(`${n.name} is running away from you.`);
      return null;
    }
    if (n.isAsleep() || n.effects.has('lying_down')) {
      n.wakeUp();
      n.goal.kind = 'none';
    }
    const d = new Dialogue(this, n);
    d.start();
    n.facing = Math.atan2(this.player.x - n.x, -(this.player.y - n.y));
    return d;
  }

  // ---------------------------------------------------------------- main loop

  update(game: Game, dt: number, gameDt: number): void {
    this.time += dt;
    this.grid.reset();
    this.restRoutingBudget = 1000;
    const p = game.player;
    if (isNaN(this.lastPlayerZ)) this.lastPlayerZ = p.z;
    if (p.z !== this.lastPlayerZ) this.followAcrossLevels(this.lastPlayerZ);
    this.lastPlayerZ = p.z;
    for (let i = this.shots.length - 1; i >= 0; i--) if ((this.shots[i].t -= dt) <= 0) this.shots.splice(i, 1);

    this.slowTimer -= dt;
    const slow = this.slowTimer <= 0;
    if (slow) {
      this.slowTimer = 1;
      this.missions.checkMissions();
      this.missions.autoComplete();
      this.spawnMissionMonsters();
    }
    for (const n of this.npcs) {
      if (n.dead || !this.inBubble(n)) continue;
      // Martial-arts turn clock: dodges/blocks refresh each combat turn, buffs expire.
      tickMartialArts(n, dt);
      // Character needs/effects tick at 1 Hz (cheap enough for a handful of NPCs).
      const acc = (this.charAcc.get(n) ?? 0) + gameDt;
      if (slow) {
        n.sleepComfort = comfortAt(this.game, n.tileX, n.tileY, n.z).comfort;
        n.update(acc);
        this.charAcc.set(n, 0);
        if (n.isShopkeeper() && this.now() > n.restockAt) {
          restockShop(this.data, this.nd, n, hashSeed(n.uid, Math.floor(this.now() / 86400)), this.factionTrust.get(n.faction) ?? 0);
          n.restockAt = this.now() + 6 * 86400;
        }
      } else this.charAcc.set(n, acc);
      if (n.dead) {
        this.died(n, null);
        continue;
      }
      n.attackCooldown = Math.max(0, n.attackCooldown - dt);
      n.needsCooldown = Math.max(0, n.needsCooldown - dt);
      n.hitFlash = Math.max(0, n.hitFlash - dt);
      n.pathAge += dt;
      if (n.fleeTime > 0 && (n.fleeTime -= dt) <= 0 && n.attitude === 'FLEE_TEMP') n.attitude = 'NULL';
      // BN npc::address_player: WAIT_FOR_LEAVE (talk effect player_leaving) spends one patience
      // per turn, then attacks.
      if (n.attitude === 'WAIT_FOR_LEAVE' && (n.patience -= dt * ACTION_SCALE) <= 0) {
        n.patience = 0;
        n.attitude = 'KILL';
        this.onHostile(n);
      }
      n.thinkTimer -= dt;
      if (n.thinkTimer <= 0) {
        n.thinkTimer += THINK + this.rng.next() * 0.05;
        this.think(n);
      }
      if (this.stairs?.drive(n, dt)) continue;
      this.act(n, dt);
    }
    this.separate();
    this.lastPX = p.x;
    this.lastPY = p.y;
  }

  /** Followers near the stairs come along when the survivor changes level. */
  private followAcrossLevels(fromZ: number): void {
    const p = this.player;
    for (const n of this.npcs) {
      if (n.dead || !n.isFollower() || !n.following || n.z !== fromZ) continue;
      if (Math.hypot(n.x - this.lastPX, n.y - this.lastPY) > 6) continue;
      if (this.stairs?.follow(n)) continue;
      const spot = this.freeTileNear(p.tileX, p.tileY, p.z);
      if (!spot) continue;
      n.x = spot[0] + 0.5;
      n.y = spot[1] + 0.5;
      n.z = p.z;
      n.path = [];
    }
  }

  private freeTileNear(x: number, y: number, z: number): [number, number] | null {
    for (let r = 1; r <= 3; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.game.map.passable(x + dx, y + dy, z) && !this.npcAt(x + dx, y + dy, z)) return [x + dx, y + dy];
        }
    return null;
  }

  // ---------------------------------------------------------------- perception & planning

  private sees(n: Npc, x: number, y: number, z: number, range = 30): boolean {
    if (z !== n.z || Math.hypot(x - n.x, y - n.y) > range) return false;
    return hasLOS(this.grid, n.tileX, n.tileY, Math.floor(x), Math.floor(y), n.z);
  }

  /** Nearest thing this NPC should fight or fear. */
  private nearestFoe(n: Npc): { foe: Foe; x: number; y: number; d: number } | null {
    const p = this.player;
    let best: { foe: Foe; x: number; y: number; d: number } | null = null;
    const consider = (foe: Foe, x: number, y: number, z: number, range: number) => {
      const d = Math.hypot(x - n.x, y - n.y);
      if (z !== n.z || d > range || (best && d >= best.d)) return;
      if (!this.sees(n, x, y, z, range)) return;
      best = { foe, x, y, d };
    };
    if (this.monsters) {
      for (const m of this.monsters.monstersNear(n.x, n.y, n.z, ENGAGE_RANGE)) {
        if (m.dead || m.friendly || m.attitude() !== 'attack') continue;
        consider({ kind: 'monster', m }, m.x, m.y, m.z, ENGAGE_RANGE);
      }
    }
    const hostileToPlayer = n.attitude === 'KILL';
    if (hostileToPlayer && !p.dead) consider({ kind: 'player' }, p.x, p.y, p.z, 25);
    for (const o of this.npcs) {
      if (o === n || o.dead || o.z !== n.z) continue;
      // Hostile NPCs fight the survivor's friends and vice versa.
      const enemies = (hostileToPlayer && o.isFriendly() && !o.isEnemy()) || (!hostileToPlayer && n.isFriendly() && o.attitude === 'KILL');
      if (enemies) consider({ kind: 'npc', n: o }, o.x, o.y, o.z, 20);
    }
    return best;
  }

  // ---------------------------------------------------------------- follower rules (BN npcmove.cpp)

  ai(n: Npc): NpcAiCache {
    let c = this.aiCache.get(n);
    if (!c) {
      c = {
        danger: 0, assessment: -10, totalDanger: 0, emergency: false, friends: [], soundAlerts: [], heardSounds: new Set(),
        returnTo: null, investigateTime: 0, pulp: null, hitByPlayerUntil: -Infinity, aimWarned: false, lastTile: null,
      };
      this.aiCache.set(n, c);
    }
    return c;
  }

  /** npc::is_walking_with: a follower walking with the survivor (not told to wait). */
  walkingWith(n: Npc): boolean {
    return n.isFollower() && n.following && !n.guardPos;
  }

  /** npc::follow_distance (npctactics.ts). */
  followDist(n: Npc): number {
    const p = this.player;
    const t = this.grid.ter(p.tileX, p.tileY, p.z);
    const onStairs = !!t && (hasFlag(t, 'GOES_DOWN') || hasFlag(t, 'GOES_UP'));
    return followDistance(n.rules, { walkingWith: this.walkingWith(n), playerOnStairs: onStairs, seesPlayer: this.sees(n, p.x, p.y, p.z) });
  }

  /** The rules an NPC follows: an ally's orders, BN's defaults for everyone else (is_player_ally gates). */
  private allyRules(n: Npc): boolean {
    return n.isAlly();
  }

  private difficulty(m: Monster): number {
    let d = this.difficultyCache.get(m.type.id);
    if (d === undefined) this.difficultyCache.set(m.type.id, (d = monsterDifficulty(m.type)));
    return d;
  }

  /** npc::evaluate_enemy: monster difficulty, or character_danger for people; capped at NPC_DANGER_MAX. */
  private threatOf(n: Npc, foe: Foe): number {
    if (foe.kind === 'monster') return Math.min(this.difficulty(foe.m), NPC_DANGER_MAX);
    return Math.min(characterDanger(n, foe.kind === 'npc' ? foe.n : this.player), NPC_DANGER_MAX);
  }

  /**
   * npc::confident_range_cache (npc::invalidate_range_cache): the confident range of a wielded
   * gun at its best aim, else the weapon's reach.
   */
  private maxRange(n: Npc, inEmergency: boolean): number {
    const w = n.inv.wielded;
    if (w?.isGun()) return confidentGunRange(this.data, n, w, aimFloorMoa(n, w), confidenceMult(n.rules.aim, n.isAlly(), inEmergency));
    return w?.hasFlag('REACH_ATTACK') ? 2 : 1;
  }

  /** npc::average_damage_dealt = npc_ai::melee_value of the wielded weapon. */
  private averageDamage(n: Npc): number {
    return meleeValue(n, n.inv.wielded);
  }

  private foeHitByPlayer(foe: Foe): boolean {
    if (foe.kind === 'monster') return foe.m.hasEffect('hit_by_player');
    if (foe.kind === 'npc') return this.ai(foe.n).hitByPlayerUntil > this.now();
    return false;
  }

  /** Positions of the creatures this NPC counts as friends (BN ai_cache.friends). */
  private friendsOf(n: Npc): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    const p = this.player;
    if (!p.dead && p.z === n.z && n.isFriendly() && !n.isEnemy() && this.sees(n, p.x, p.y, p.z)) out.push({ x: p.x, y: p.y });
    for (const o of this.npcs) {
      if (o === n || o.dead || o.z !== n.z || Math.hypot(o.x - n.x, o.y - n.y) > 30) continue;
      const friends = (n.isFriendly() && o.isFriendly()) || (!!n.faction && n.faction !== FACTION_NONE && o.faction === n.faction && o.isEnemy() === n.isEnemy());
      if (friends) out.push({ x: o.x, y: o.y });
    }
    if (this.monsters && n.isFriendly()) for (const m of this.monsters.monstersNear(n.x, n.y, n.z, 30)) if (!m.dead && m.friendly) out.push({ x: m.x, y: m.y });
    return out;
  }

  /**
   * npc::assess_danger: rate every hostile creature the NPC sees, pick a target and keep the
   * danger numbers the follower rules read. Allies pick their target BN's way (engagement rule,
   * def_radius, priority by danger and distance, follow_close / emergency retreat); everyone
   * else keeps the port's nearest-foe choice (npcai's original behaviour).
   */
  private assess(n: Npc): { foe: Foe; x: number; y: number; d: number } | null {
    const c = this.ai(n);
    const p = this.player;
    const rules = n.rules;
    const ally = this.allyRules(n);
    const walking = this.walkingWith(n);
    const prevEmergency = emergency(n, n.personality.bravery, c.assessment);
    const fd = this.followDist(n);
    const maxRange = this.maxRange(n, prevEmergency);
    const dP = n.z === p.z ? rlDist(n.x, n.y, p.x, p.y) : Infinity;
    // must_retreat: a companion in trouble, or told to stay close, comes back first.
    const mustRetreat = walking && (prevEmergency || rules.hasFlag('follow_close')) && dP > fd;
    const noFighting = ally && rules.hasFlag('forbid_engage');
    const friends = this.friendsOf(n);
    c.friends = friends;
    const avgDamage = ally && rules.engagement === 'ENGAGE_WEAK' ? this.averageDamage(n) : 0;
    let assessment = 0, totalDanger = 0;
    let best: { foe: Foe; x: number; y: number; d: number; danger: number } | null = null;
    let highest = 1;
    const consider = (foe: Foe, x: number, y: number, hp: number, hpMax: number, speedR: number, isMonster: boolean) => {
      const threat = this.threatOf(n, foe);
      assessment += threat;
      if (mustRetreat || noFighting) return;
      const dist = rlDist(n.x, n.y, x, y);
      const scaled = isMonster ? Math.max(1, dist / Math.max(0.01, speedR)) : Math.max(1, Math.trunc((100 * dist) / Math.max(1, speedR * 100)));
      const hpPct = 1 - hp / Math.max(1, hpMax);
      const danger = isMonster ? Math.max(threat * (hpPct * 0.5 + 0.5), NPC_DANGER_VERY_LOW) : Math.max(threat, NPC_DANGER_VERY_LOW);
      totalDanger += (isMonster ? danger : threat) / scaled;
      let distToFriend = Infinity;
      for (const f of friends) distToFriend = Math.min(distToFriend, rlDist(x, y, f.x, f.y));
      const ctx: EngagementCtx = {
        rules, maxRange, followDist: fd, dist, scaledDist: scaled,
        distToPlayer: p.z === n.z ? rlDist(x, y, p.x, p.y) : Infinity, distToFriend,
        hitByPlayer: this.foeHitByPlayer(foe), targetHp: hp, averageDamage: avgDamage, inEmergency: prevEmergency,
      };
      // Rules only bind allies (is_player_ally); BN's defaults decide for everyone else.
      const close = tooClose(ally ? ctx : { ...ctx, rules: DEFAULT_RULES });
      if (!close && ally && !okByRules(ctx)) return;
      const pri = targetPriority(isMonster ? danger : threat, scaled, close);
      if (pri > highest) {
        highest = pri;
        best = { foe, x, y, d: Math.hypot(x - n.x, y - n.y), danger: isMonster ? danger : threat };
      }
    };
    if (this.monsters) {
      // Allies look as far as they can see (BN: daylight range); others only rate what they
      // might fight (their target is still the nearest foe within ENGAGE_RANGE).
      const range = ally ? 30 : ENGAGE_RANGE;
      for (const m of this.monsters.monstersNear(n.x, n.y, n.z, range)) {
        if (m.dead || m.friendly || m.attitude() !== 'attack') continue;
        if (!this.sees(n, m.x, m.y, m.z, range)) continue;
        consider({ kind: 'monster', m }, m.x, m.y, m.hp, m.hpMax, speedRating(m.type, m.speed), true);
      }
    }
    const hostileToPlayer = n.attitude === 'KILL';
    if (hostileToPlayer && !p.dead && this.sees(n, p.x, p.y, p.z, 25)) consider({ kind: 'player' }, p.x, p.y, 1, 1, p.speed / 100, false);
    for (const o of this.npcs) {
      if (o === n || o.dead || o.z !== n.z) continue;
      const enemies = (hostileToPlayer && o.isFriendly() && !o.isEnemy()) || (!hostileToPlayer && n.isFriendly() && o.attitude === 'KILL');
      if (enemies && this.sees(n, o.x, o.y, o.z, 20)) consider({ kind: 'npc', n: o }, o.x, o.y, 1, 1, o.speed / 100, false);
    }
    const anyHostile = assessment !== 0;
    // Friends make it less frightening (each NPC friend's and the survivor's threat, halved).
    const lessen = (threat: number) => {
      const min = assessment >= NPC_DANGER_VERY_LOW ? NPC_DANGER_VERY_LOW : -10;
      assessment = Math.max(min, assessment - threat * 0.5);
    };
    for (const o of this.npcs) {
      if (o === n || o.dead || o.z !== n.z || !n.isFriendly() || !o.isFriendly() || Math.hypot(o.x - n.x, o.y - n.y) > 30) continue;
      if (anyHostile) lessen(Math.min(characterDanger(n, o), NPC_DANGER_MAX));
    }
    if (anyHostile && !p.dead && n.isFriendly() && !n.isEnemy() && this.sees(n, p.x, p.y, p.z)) lessen(Math.min(characterDanger(n, p), NPC_DANGER_MAX));
    // BN returns early (assessment 0) when nothing hostile is in sight.
    if (anyHostile) {
      assessment *= 0.1;
      if (assessment <= 2) assessment = -10 + 5 * assessment;
    }
    c.assessment = assessment;
    c.totalDanger = totalDanger;
    c.emergency = emergency(n, n.personality.bravery, assessment);
    if (!ally) {
      // The port's original target choice for NPCs that aren't the survivor's allies.
      const near = this.nearestFoe(n);
      c.danger = near ? Math.max(this.threatOf(n, near.foe), NPC_DANGER_VERY_LOW) : 0;
      return near;
    }
    const b = best as { foe: Foe; x: number; y: number; d: number; danger: number } | null;
    c.danger = b ? b.danger : 0;
    return b ? { foe: b.foe, x: b.x, y: b.y, d: b.d } : null;
  }

  private think(n: Npc): void {
    const p = this.player;
    if (n.needsCooldown > 0) return;
    const dP = n.z === p.z ? Math.hypot(p.x - n.x, p.y - n.y) : Infinity;
    const g = n.goal;
    if (n.attitude === 'FLEE' || n.attitude === 'FLEE_TEMP') {
      this.setFlee(n, p.x, p.y);
      return;
    }
    const foe = this.assess(n);
    const kcal = n.storedKcal + n.stomach.kcal;
    const extreme = n.thirst > THIRST.DEHYDRATED || kcal < n.maxStoredKcal() * 0.75;
    const hungry = n.thirst > THIRST.THIRSTY || kcal < n.maxStoredKcal() * 0.95;
    if (!n.isAsleep() && !n.effects.has('lying_down') &&
        (extreme || (!foe && hungry && this.rng.oneIn(3)))) {
      const eaten = consumeNpcFood(n);
      if (eaten) {
        n.needsCooldown = eaten.moves / n.speed / ACTION_SCALE;
        n.moving = false;
        if (playerCanSee(this.game, n.tileX, n.tileY, n.z)) this.message(`${n.name} ${eaten.item.isLiquid() ? 'drinks' : 'eats'} ${eaten.item.baseName()}.`);
        return;
      }
      // BN consume_food explicitly replenishes non-allies when no eligible carried food exists.
      if (!n.isAlly()) { n.storedKcal = n.maxStoredKcal(); n.thirst = 0; }
    }
    if (foe) {
      if (n.effects.has('lying_down')) n.wakeUp();
      // Morale: hurt, unarmed timid NPCs run; everyone else fights (npc::assess_danger, simplified).
      const hp = n.hpPercent();
      const armed = !!n.inv.wielded;
      const brave = n.personality.bravery + (armed ? 3 : 0) + (n.isEnemy() ? 4 : 0);
      if (hp < 25 || (hp < 50 && brave < 5) || (!armed && brave < 2 && foe.d < 5)) {
        this.setFlee(n, foe.x, foe.y);
        if (this.rng.oneIn(8)) this.say(n, '<run_away>');
        return;
      }
      g.kind = 'fight';
      g.x = foe.x;
      g.y = foe.y;
      g.target = foe.foe;
      return;
    }
    if (g.kind !== 'pulp') g.target = undefined;
    if (n.isAsleep() || n.effects.has('lying_down')) { n.moving = false; return; }
    // BN npc::move: with no target, noises worth checking send an NPC that isn't walking with
    // the survivor to look (npc_investigate_sound), before its needs.
    if (this.investigate(n)) return;
    // address_needs (danger at most NPC_DANGER_VERY_LOW): one turn in three, pulp a corpse that
    // could get back up (BN find_corpse_to_pulp / do_pulp; allies only with allow_pulp).
    if (g.kind === 'pulp' && this.pulpTargetValid(n, g.target as CorpseRecord | undefined)) return;
    if (g.kind === 'pulp') (g.kind = 'none'), (g.target = undefined), (this.ai(n).pulp = null);
    if (this.rng.oneIn(3) && this.findCorpseToPulp(n)) return;
    // npcmove.cpp address_needs: ally rest is fatigue/permission based, not a clock schedule.
    const playerResting = p.isAsleep() || p.effects.has('lying_down');
    const tired = n.sleepiness >= SLEEPINESS.TIRED || (n.following && playerResting && n.sleepiness > SLEEPINESS.TIRED / 2);
    if (!n.isAlly() && tired && this.rng.oneIn(3)) n.sleepiness = 0; // BN's explicit offscreen-rest approximation.
    if (n.isAlly() && tired && (n.allowSleep || n.sleepiness > SLEEPINESS.MASSIVE || playerResting)) {
      if (g.kind === 'rest') return;
      if (this.rng.oneIn(3)) { this.planRest(n); return; }
    }
    if (g.kind === 'rest') g.kind = 'none';
    if ((n.attitude === 'TALK' || n.attitude === 'MUG') && dP < 20 && this.sees(n, p.x, p.y, p.z, 20)) {
      g.kind = 'approach';
      g.x = p.x;
      g.y = p.y;
      if (dP < 1.8) {
        const was = n.attitude;
        n.attitude = was === 'MUG' ? 'MUG' : 'NULL';
        if (this.time - n.lastSpeech > 20) {
          n.lastSpeech = this.time;
          this.onWantsTalk?.(n);
        }
        if (was === 'MUG') n.attitude = 'NULL';
      }
      return;
    }
    if (this.walkingWith(n)) {
      // npc_follow_player: keep within npc::follow_distance (2 with follow_distance_2 or out of
      // sight, else 4). Close but on the other side of a wall still means "catch up" (they'd
      // otherwise stand inside the shelter while you walk off down the street).
      const fd = this.followDist(n);
      if (dP > fd + 1.2 || (dP < Infinity && !this.sees(n, p.x, p.y, p.z, 8))) {
        g.kind = 'follow';
        g.x = p.x;
        g.y = p.y;
      } else g.kind = 'none';
      this.complain(n);
      return;
    }
    if (n.guardPos) {
      const gp = n.guardPos;
      const d = Math.hypot(gp.x + 0.5 - n.x, gp.y + 0.5 - n.y);
      if (n.mission === 'GUARD_PATROL' && d < 4 && this.rng.oneIn(12)) {
        g.kind = 'wander';
        g.x = gp.x + 0.5 + this.rng.int(-3, 3);
        g.y = gp.y + 0.5 + this.rng.int(-3, 3);
      } else if (d > 1.2 && g.kind !== 'wander') {
        g.kind = 'return';
        g.x = gp.x + 0.5;
        g.y = gp.y + 0.5;
      } else if (g.kind !== 'wander') {
        g.kind = 'none';
        if (dP < 6 && this.sees(n, p.x, p.y, p.z, 6)) n.facing = Math.atan2(p.x - n.x, -(p.y - n.y));
      }
      return;
    }
    // Idle survivors mill about (npc::move_pause / wander).
    n.idleTimer -= THINK;
    if (g.kind === 'wander' && Math.hypot(g.x - n.x, g.y - n.y) > 0.5) return;
    if (n.idleTimer <= 0) {
      n.idleTimer = 4 + this.rng.next() * 8;
      if (this.rng.oneIn(2)) {
        g.kind = 'wander';
        g.x = n.x + this.rng.int(-6, 6);
        g.y = n.y + this.rng.int(-6, 6);
      } else g.kind = 'none';
    }
  }

  private setFlee(n: Npc, fx: number, fy: number): void {
    const d = Math.max(0.01, Math.hypot(n.x - fx, n.y - fy));
    n.goal.kind = 'flee';
    n.goal.x = n.x + ((n.x - fx) / d) * 8;
    n.goal.y = n.y + ((n.y - fy) / d) * 8;
    n.goal.target = undefined;
  }

  /** NPC barks: snippet categories like <run_away>, shown when the survivor can see them. */
  say(n: Npc, tag: string): void {
    if (this.time - n.lastSpeech < 6) return;
    n.lastSpeech = this.time;
    const d = new Dialogue(this, n);
    const text = d.parseTags(tag);
    if (text === tag) return;
    if (playerCanSee(this.game, n.tileX, n.tileY, n.z)) this.message(`${n.name}: "${text}"`, 'c_light_gray');
    emitSound(this.game, { x: n.tileX, y: n.tileY, z: n.z }, 10, `${n.name} yelling "${text}"`, { category: 'speech', source: n, ambient: true });
  }

  // ---------------------------------------------------------------- acting

  private act(n: Npc, dt: number): void {
    const g = n.goal;
    if (n.needsCooldown > 0 || n.effects.has('downed') || n.isAsleep() || n.effects.has('lying_down')) {
      n.moving = false;
      return;
    }
    if (g.kind === 'fight' && g.target) {
      const foe = g.target as Foe;
      const pos = this.foePos(foe);
      if (!pos || this.foeDead(foe)) {
        g.kind = 'none';
        return;
      }
      g.x = pos.x;
      g.y = pos.y;
      n.facing = Math.atan2(pos.x - n.x, -(pos.y - n.y));
      this.methodOfAttack(n, foe, pos, dt);
      return;
    }
    switch (g.kind) {
      case 'none':
        n.moving = false;
        return;
      case 'flee':
        this.moveToward(n, g.x, g.y, dt, 1.4);
        return;
      case 'follow': {
        const fd = this.followDist(n);
        this.moveToward(n, g.x, g.y, dt, this.followPace(n, fd));
        if (Math.hypot(this.player.x - n.x, this.player.y - n.y) < fd + 0.5 && this.sees(n, this.player.x, this.player.y, this.player.z, fd + 1)) (g.kind = 'none'), (n.moving = false);
        return;
      }
      case 'pulp':
        this.actPulp(n, dt);
        return;
      case 'investigate':
        if (Math.hypot(g.x - n.x, g.y - n.y) < 0.6) {
          n.moving = false;
          return;
        }
        this.moveToward(n, g.x, g.y, dt, 1);
        return;
      case 'approach':
        if (Math.hypot(g.x - n.x, g.y - n.y) < 1.4) {
          n.moving = false;
          return;
        }
        this.moveToward(n, g.x, g.y, dt, 1);
        return;
      case 'rest': {
        const playerResting = this.player.isAsleep() || this.player.effects.has('lying_down');
        const tired = n.sleepiness >= SLEEPINESS.TIRED || (n.following && playerResting && n.sleepiness > SLEEPINESS.TIRED / 2);
        if (!tired || !(n.allowSleep || n.sleepiness > SLEEPINESS.MASSIVE || playerResting)) { g.kind = 'none'; return; }
        const tx = Math.floor(g.x), ty = Math.floor(g.y);
        const occupant = this.npcAt(tx, ty, n.z);
        if (!this.grid.passable(tx, ty, n.z) || (occupant && occupant !== n) || this.monsters?.monsterAt(tx, ty, n.z) ||
            (this.player.z === n.z && this.player.tileX === tx && this.player.tileY === ty)) {
          g.kind = 'none'; n.path = []; n.moving = false; return;
        }
        if (Math.hypot(g.x - n.x, g.y - n.y) < 0.4) {
          n.moving = false;
          n.sleepComfort = comfortAt(this.game, n.tileX, n.tileY, n.z).comfort;
          n.addEffect('lying_down', 30 * 60);
          if (playerCanSee(this.game, n.tileX, n.tileY, n.z)) this.message(`${n.name} lies down to sleep.`);
        } else this.moveToward(n, g.x, g.y, dt, 1);
        return;
      }
      case 'return': case 'wander':
        if (Math.hypot(g.x - n.x, g.y - n.y) < 0.4) {
          g.kind = 'none';
          n.moving = false;
          return;
        }
        this.moveToward(n, g.x, g.y, dt, g.kind === 'wander' ? 0.6 : 1);
        return;
    }
  }

  /**
   * npc::method_of_attack (npcmove.cpp) in real time: grenades in an emergency, a reach attack,
   * a confident shot (or side-step a friend in the line of fire), reload, melee, aim, and only
   * then close in, which ENGAGE_NO_MOVE / ENGAGE_FREE_FIRE (and ENGAGE_HIT before the survivor
   * has hit the target) forbid.
   */
  private methodOfAttack(n: Npc, foe: Foe, pos: { x: number; y: number }, dt: number): void {
    const c = this.ai(n);
    const ally = this.allyRules(n);
    const rules = ally ? n.rules : DEFAULT_RULES;
    const eng = rules.engagement;
    const dontMove = eng === 'ENGAGE_NO_MOVE' || eng === 'ENGAGE_FREE_FIRE';
    // Free fire may still step aside for a friend in the way; NO_MOVE may not.
    const dontMoveFF = eng === 'ENGAGE_NO_MOVE';
    const em = c.emergency;
    const canUseGun = (!ally || rules.hasFlag('use_guns')) && (c.danger >= 3 || em);
    const useSilent = ally && rules.hasFlag('use_silent');
    const notEngagedYet = ally && eng === 'ENGAGE_HIT' && !this.foeHitByPlayer(foe);
    const dist = Math.max(1, rlDist(n.x, n.y, pos.x, pos.y));
    const d = Math.hypot(pos.x - n.x, pos.y - n.y);
    const los = hasLOS(this.grid, n.tileX, n.tileY, Math.floor(pos.x), Math.floor(pos.y), n.z);
    const seen = this.sees(n, pos.x, pos.y, n.z, 30);

    if (em && n.attackCooldown <= 0 && this.altAttack(n, foe, pos, dt)) return;

    const w = n.inv.wielded;
    const short = w?.isGun() ? gunShortfall(n, w) : null;
    const gun = w?.isGun() && canUseGun && !short && !(useSilent && !isSilentGun(w)) ? w : null;
    const reachTiles = w?.hasFlag('REACH_ATTACK') ? 2 : 1;
    const reach = reachTiles + 0.35 + CREATURE_RADIUS + this.foeRadius(foe);
    // Reach attacks are silent and use no ammo, so they come first.
    if (reachTiles > 1 && d <= reach && los) {
      n.moving = false;
      if (n.attackCooldown <= 0) this.melee(n, foe);
      return;
    }
    if (gun) {
      const mult = confidenceMult(rules.aim, ally, em);
      const conf = confidentGunRange(this.data, n, gun, n.recoil, mult);
      if (seen && los && gunRange(n, gun) >= dist && conf >= dist) {
        if (wontHitFriend(n, pos, c.friends, conf)) {
          n.moving = false;
          // npc_shoot aims with what is left of the turn, then fires.
          if (n.attackCooldown <= 0) {
            this.shoot(n, gun, foe, pos);
            c.aimWarned = false;
          } else this.aimTick(n, gun, dt);
          return;
        }
        if (!dontMoveFF) {
          this.avoidFriendlyFire(n, pos, dt);
          return;
        }
      }
    }
    // Out of rounds: reload. A UPS-powered gun with no UPS charge to draw on is put away
    // (npc::wield_better_weapon, simplified) rather than dry-fired every turn.
    if (short === 'ups') {
      if (n.attackCooldown <= 0) this.muted(n, () => n.inv.unwield());
    } else if (short === 'ammo' && w) {
      n.moving = false;
      if (n.attackCooldown <= 0) this.reload(n, w);
      return;
    }
    if (d <= reach && los) {
      n.moving = false;
      if (n.attackCooldown <= 0) this.melee(n, foe);
      return;
    }
    // Not confident yet: aim if aiming can get the shot within the confident range.
    if (gun && seen && n.recoil > aimFloorMoa(n, gun) + 0.5 &&
        confidentGunRange(this.data, n, gun, aimFloorMoa(n, gun), confidenceMult(rules.aim, ally, em)) >= dist) {
      n.moving = false;
      this.aimTick(n, gun, dt);
      if (foe.kind === 'player' && !c.aimWarned && this.visible(n)) {
        c.aimWarned = true;
        this.message(`${n.name} takes aim at you!`, 'c_red');
      }
      return;
    }
    if (dontMove || notEngagedYet || this.player.z !== n.z && foe.kind === 'player') {
      n.moving = false;
      return;
    }
    this.moveToward(n, pos.x, pos.y, dt, 1.25);
  }

  /** npc::aim: spend this tick's moves bringing recoil down toward the sight's floor. */
  private aimTick(n: Npc, gun: Item, dt: number): void {
    aim(n, gun, n.speed * ACTION_SCALE * dt);
  }

  /**
   * npc::avoid_friendly_fire: step to the neighbouring tile that best trades distance to the
   * target for distance from the friends' centre.
   */
  private avoidFriendlyFire(n: Npc, tar: { x: number; y: number }, dt: number): void {
    const friends = this.ai(n).friends;
    if (!friends.length) return void (n.moving = false);
    const cx = Math.round(friends.reduce((s, f) => s + Math.floor(f.x), 0) / friends.length);
    const cy = Math.round(friends.reduce((s, f) => s + Math.floor(f.y), 0) / friends.length);
    const cands: [number, number][] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) cands.push([n.tileX + dx, n.tileY + dy]);
    cands.sort((a, b) => (rlDist(a[0], a[1], tar.x, tar.y) - rlDist(a[0], a[1], cx, cy)) - (rlDist(b[0], b[1], tar.x, tar.y) - rlDist(b[0], b[1], cx, cy)));
    for (const [x, y] of cands) {
      if (!this.grid.passable(x, y, n.z) || this.npcAt(x, y, n.z) || this.monsters?.monsterAt(x, y, n.z)) continue;
      if (this.player.z === n.z && this.player.tileX === x && this.player.tileY === y) continue;
      this.moveToward(n, x + 0.5, y + 0.5, dt, 1);
      return;
    }
    n.moving = false;
  }

  /**
   * npc::alt_attack (npcmove.cpp): throw an NPC_ALT_ATTACK item, or a live NPC_THROW_NOW one,
   * in an emergency; allies only with use_grenades. NPC_ACTIVATE items are armed (their
   * transform: a grenade's pin pulled) as they are thrown. BN arms first and may then hold the
   * live grenade while it side-steps a friend; the port's NPCs never carry a burning fuse
   * (ArmedExplosives only tracks the survivor's items and thrown ones), so they arm at the throw.
   */
  private altAttack(n: Npc, foe: Foe, tar: { x: number; y: number }, dt: number): boolean {
    if (this.allyRules(n) && !n.rules.hasFlag('use_grenades')) return false;
    const dist = rlDist(n.x, n.y, tar.x, tar.y);
    let used: Item | null = null;
    let usedDangerous = false;
    const check = (it: Item) => {
      const dangerous = it.hasFlag('NPC_THROW_NOW');
      if (!dangerous && usedDangerous) return;
      // Guns with bayonets inherit the thrown flag; never throw a gun.
      if (it.isGun()) return;
      if (!dangerous && !it.hasFlag('NPC_ALT_ATTACK')) return;
      if (!dangerous && throwRange(n, it) < dist) return;
      if (!dangerous && used) return;
      used = it;
      usedDangerous = usedDangerous || dangerous;
    };
    if (n.inv.wielded) check(n.inv.wielded);
    for (const it of n.inv.allItems()) if (it !== n.inv.wielded) check(it);
    const it = used as Item | null;
    if (!it) return false;
    const mult = confidenceMult(n.rules.aim, this.allyRules(n), this.ai(n).emergency);
    const conf = confidentThrowRange(n, it, mult);
    const friends = this.ai(n).friends;
    const wontHit = wontHitFriend(n, tar, friends, conf);
    if (dist <= conf && wontHit) {
      this.npcThrow(n, it, tar);
      return true;
    }
    if (wontHit) {
      // Out of range: close in.
      this.moveToward(n, tar.x, tar.y, dt, 1.25);
      return true;
    }
    if (!usedDangerous) {
      this.avoidFriendlyFire(n, tar, dt);
      return true;
    }
    // A live one that can't go at the target: as far away as is friendly-safe.
    let best = { x: tar.x, y: tar.y }, bestD = 0;
    for (let dy = -conf; dy <= conf; dy++) for (let dx = -conf; dx <= conf; dx++) {
      const x = n.tileX + dx + 0.5, y = n.tileY + dy + 0.5, dd = Math.max(Math.abs(dx), Math.abs(dy));
      if (dd < 2 || dd <= bestD || !wontHitFriend(n, { x, y }, friends, conf)) continue;
      best = { x, y };
      bestD = dd;
    }
    this.npcThrow(n, it, best);
    void foe;
    return true;
  }

  /** npc_throw: one of the item flies at `tar` (spread by throwing skill) and lands there. */
  private npcThrow(n: Npc, it: Item, tar: { x: number; y: number }): void {
    const from = n.inv.locOf(it);
    if (!from) return;
    if (!it.active && it.hasFlag('NPC_ACTIVATE')) {
      const r = this.muted(n, () => n.inv.use(it));
      if (!r.ok) return;
    }
    if (this.visible(n)) this.message(`${n.name} throws a ${it.name()}.`);
    const spread = Math.max(0.01, 0.25 - n.getSkill('throw') * 0.02 - (n.dex - 8) * 0.01);
    const dist = Math.hypot(tar.x - n.x, tar.y - n.y);
    const yaw = Math.atan2(tar.y - n.y, tar.x - n.x) + (this.rng.next() * 2 - 1) * spread;
    const range = Math.min(dist, throwRange(n, it));
    let lx = Math.floor(n.x + Math.cos(yaw) * range), ly = Math.floor(n.y + Math.sin(yaw) * range);
    // Stop short of a wall on the way (the item drops in front of it).
    for (const [x, y] of bresenham(n.tileX, n.tileY, lx, ly)) {
      if (!this.grid.passable(x, y, n.z)) break;
      [lx, ly] = [x, y];
    }
    const moved = moveItem(it, from, L.ground(this.game.map, lx, ly, n.z), { count: it.countByCharges ? 1 : undefined, force: true, quiet: true });
    if (!moved.ok) return;
    const flying = moved.item ?? it;
    n.attackCooldown = (100 + flying.weight() / 50) / 100 / ACTION_SCALE;
    n.practice('throw', 5 + Math.floor(range / 2));
    n.recoil = MAX_RECOIL;
    this.onThrownExplosive?.(flying, lx, ly, n.z, n);
    // The flight is only its picture (the item already lies where it lands, like the survivor's
    // throws): it passes through bodies.
    const flight = Math.max(1, Math.hypot(lx + 0.5 - n.x, ly + 0.5 - n.y));
    enemyFireOf(this.game).fire({
      kind: 'grenade', speed: lobSpeed('thrown', flight), arc: true,
      x: n.x, y: n.y, h: n.z * LEVEL_HEIGHT + 1.4, tx: lx + 0.5, ty: ly + 0.5, th: n.z * LEVEL_HEIGHT + 0.1, yawOff: 0,
      range: flight, z: n.z, from: n, spares: () => true,
    });
  }

  /** Followers' pace (npc_follow_player move_mode): BN matches the survivor unless move_own_pace. */
  private followPace(n: Npc, fd: number): number {
    const p = this.player;
    const dist = Math.hypot(p.x - n.x, p.y - n.y);
    const run = n.canRun() ? 2 : 1;
    if (n.rules.hasFlag('move_own_pace')) return dist > fd * 4 ? run : 1;
    const mode = p.running && p.canRun() ? run : p.crouching ? 0.5 : 1;
    // Port: real time leaves a walking follower behind for good, so far-behind followers
    // still hurry (the old 1.5× catch-up) whatever pace the survivor sets.
    return dist > 8 ? Math.max(mode, 1.5) : mode;
  }

  /**
   * npc::handle_sound + the npc_investigate_sound branch of npc::move: an NPC that isn't
   * walking with the survivor goes to look at movement noises it can't see the source of
   * (within 10 tiles, 50 for guards; ignore_noise makes it 0), and walks back afterwards.
   * Allies ignore their friends' quiet noises and anything the survivor can see.
   */
  private investigate(n: Npc): boolean {
    const c = this.ai(n);
    const g = n.goal;
    if (this.walkingWith(n)) {
      c.soundAlerts = [];
      if (g.kind === 'investigate') g.kind = 'none';
      return false;
    }
    this.hearSounds(n);
    // regen_ai_cache: alerts whose spot the NPC can see now are dealt with.
    c.soundAlerts = c.soundAlerts.filter((a) => !(a.z === n.z && this.sees(n, a.x + 0.5, a.y + 0.5, a.z, 30)));
    if (c.soundAlerts.length) {
      c.investigateTime += THINK;
      if (c.investigateTime > 10) {
        // ai_cache.stuck: give up on this one.
        c.soundAlerts.shift();
        c.investigateTime = 0;
      }
    }
    const a = c.soundAlerts[0];
    if (a) {
      if (!c.returnTo && !n.guardPos) c.returnTo = { x: n.tileX, y: n.tileY, z: n.z };
      g.kind = 'investigate';
      g.x = a.x + 0.5;
      g.y = a.y + 0.5;
      return true;
    }
    c.investigateTime = 0;
    if (g.kind === 'investigate') g.kind = 'none';
    // npc_return_to_guard_pos once the alerts are gone.
    const r = c.returnTo;
    if (r && !n.guardPos) {
      if (r.z !== n.z || Math.hypot(r.x + 0.5 - n.x, r.y + 0.5 - n.y) < 0.6) c.returnTo = null;
      else {
        g.kind = 'return';
        g.x = r.x + 0.5;
        g.y = r.y + 0.5;
        return true;
      }
    }
    return false;
  }

  private hearSounds(n: Npc): void {
    const c = this.ai(n);
    const p = this.player;
    for (const { sound: s, volume } of soundsHeardAt(this.game, n.tileX, n.tileY, n.z)) {
      if (c.heardSounds.has(s.id)) continue;
      c.heardSounds.add(s.id);
      if (c.heardSounds.size > 64) c.heardSounds.delete(c.heardSounds.values().next().value as number);
      const src = s.source;
      // Only sounds made by a creature reach handle_sound.
      if (!src || src === n) continue;
      const fromPlayer = src === p;
      const fromNpc = src instanceof Npc;
      const mon = !fromPlayer && !fromNpc && typeof src === 'object' && 'type' in (src as object) ? (src as Monster) : null;
      if (!fromPlayer && !fromNpc && !mon) continue;
      if (s.z === n.z && this.sees(n, s.x + 0.5, s.y + 0.5, s.z, 60)) continue;
      const playerAlly = fromPlayer && n.isAlly();
      const npcAlly = fromNpc && ((n.isFriendly() && (src as Npc).isFriendly()) || (n.faction !== FACTION_NONE && (src as Npc).faction === n.faction));
      const monNonhostile = !!mon && (mon.friendly || mon.attitude() !== 'attack');
      if (soundRank(s.category) < soundRank('alarm')) {
        if (playerAlly || npcAlly || monNonhostile) continue;
        if (n.isAlly() && playerCanSee(this.game, s.x, s.y, s.z)) continue;
        if ((fromNpc || fromPlayer) && soundRank(s.category) < soundRank('destructive_activity') && !n.isEnemy()) continue;
      }
      let investigateDist = n.mission === 'GUARD_ALLY' || n.mission === 'GUARD_PATROL' ? 50 : 10;
      if (n.rules.hasFlag('ignore_noise')) investigateDist = 0;
      if (c.totalDanger >= 1 || s.category !== 'movement') continue;
      if (rlDist(n.x, n.y, s.x, s.y) >= investigateDist) continue;
      const last = c.soundAlerts[c.soundAlerts.length - 1];
      if (!last || last.x !== s.x || last.y !== s.y || last.z !== s.z) c.soundAlerts.push({ x: s.x, y: s.y, z: s.z, volume });
    }
    if (c.soundAlerts.length > 1) c.soundAlerts.sort((a, b) => b.volume - a.volume).splice(10);
  }

  /** item::can_revive for a corpse record: REVIVES, not pulped or fully damaged. */
  private corpseCanRevive(cr: CorpseRecord): boolean {
    const def = this.data.monsters[cr.monId];
    const it = cr.item as Item;
    return !!def && def.flags.includes('REVIVES') && it.damage < MAX_ITEM_DAMAGE && !it.hasFlag('PULPED');
  }

  private pulpTargetValid(n: Npc, cr: CorpseRecord | undefined): boolean {
    if (!cr || !this.monsters || cr.z !== n.z || !this.monsters.corpseValid(cr) || !this.corpseCanRevive(cr)) return false;
    if (this.allyRules(n) && (!n.rules.hasFlag('allow_pulp') || this.game.vehicles?.driving)) return false;
    return true;
  }

  /**
   * npc::find_corpse_to_pulp: a reviving corpse within 6 tiles (of the survivor when walking
   * with them), in sight, reachable, not one that bleeds acid. Allies need allow_pulp and the
   * survivor out of a vehicle.
   */
  private findCorpseToPulp(n: Npc): boolean {
    const sys = this.monsters;
    if (!sys) return false;
    if (this.allyRules(n) && (!n.rules.hasFlag('allow_pulp') || this.game.vehicles?.driving)) return false;
    const c = this.ai(n);
    const walking = this.walkingWith(n);
    const around = walking ? this.player : n;
    let paths = 4;
    const ok = (cr: CorpseRecord): boolean => {
      if (cr.z !== n.z || rlDist(cr.x, cr.y, around.x, around.y) > 6) return false;
      if (!sys.corpseValid(cr) || !this.corpseCanRevive(cr)) return false;
      if (this.data.monsters[cr.monId]?.flags.includes('ACID_BLOOD')) return false;
      if (!this.sees(n, cr.x, cr.y, cr.z, 30)) return false;
      if (paths-- <= 0) return false;
      if (clearWalk(this.grid, n.x, n.y, cr.x, cr.y, n.z, CREATURE_RADIUS)) return true;
      return findPath(this.grid, n.tileX, n.tileY, Math.floor(cr.x), Math.floor(cr.y), n.z, { doors: true, maxNodes: 300, margin: 6 }).complete;
    };
    const old = c.pulp;
    let found: CorpseRecord | null = old && ok(old) ? old : null;
    if (!found) for (const cr of sys.corpses) if (ok(cr)) { found = cr; break; }
    if (!found) {
      c.pulp = null;
      return false;
    }
    if (found !== old && walking) this.speak(n, `Hold on, I want to pulp that ${(found.item as Item).name()}.`);
    c.pulp = found;
    n.goal = { kind: 'pulp', x: found.x, y: found.y, target: found };
    return true;
  }

  /**
   * do_pulp + activity_handlers::pulp_do_turn for an NPC: one smash per turn (slower when
   * winded). Each smash adds a damage level with chance pulp_power / (volume / 250 ml); at the
   * last level the corpse is PULPED and can't revive.
   */
  private actPulp(n: Npc, dt: number): void {
    const cr = n.goal.target as CorpseRecord | undefined;
    if (!this.pulpTargetValid(n, cr)) {
      n.goal.kind = 'none';
      return;
    }
    const tx = Math.floor(cr!.x), ty = Math.floor(cr!.y);
    if (rlDist(n.x, n.y, tx, ty) > 1) {
      this.moveToward(n, tx + 0.5, ty + 0.5, dt, 1);
      return;
    }
    n.moving = false;
    n.facing = Math.atan2(tx + 0.5 - n.x, -(ty + 0.5 - n.y));
    if (n.attackCooldown > 0) return;
    const w = n.inv.wielded;
    const cut = Math.max(w?.meleeDamage('cut') ?? 0, (w?.meleeDamage('stab') ?? 0) / 2);
    const effort = Math.max(0, n.str + (w?.meleeDamage('bash') ?? 0));
    const power = Math.sqrt(effort * Math.max(0, cut + 1)) * (40 + n.getSkill('survival') * 5);
    const it = cr!.item as Item;
    if (!(power > 0) || !isFinite(power)) {
      if (this.visible(n)) this.message(`${n.name} is unable to pulp the corpse.`);
      n.goal.kind = 'none';
      return;
    }
    const units = Math.max(1, (Number(it.vars.volume) || 62500) / 250);
    if (this.rng.next() < power / units) it.damage = Math.min(MAX_ITEM_DAMAGE, it.damage + 1000);
    if (this.rng.next() < power / units) {
      const r = (w?.hasFlag('MESSY') ? 2 : 1) + (this.rng.next() < power / 500 ? 1 : 0) + (this.rng.next() < power / 1000 ? 1 : 0);
      this.game.map.addField(tx + this.rng.int(-r, r), ty + this.rng.int(-r, r), n.z, 'fd_blood', 1);
    }
    n.modStamina(-effort);
    if (this.rng.oneIn(4)) n.practice('survival', 2);
    emitSound(this.game, { x: tx, y: ty, z: n.z }, 8, 'Smack!', { category: 'combat', source: n, ambient: true });
    sfx.meleeHit('flesh', { x: tx + 0.5, y: ty + 0.5, z: n.z }, { id: w?.typeId, skill: w ? w.meleeSkill() : 'unarmed' });
    const staminaRatio = n.stamina / Math.max(1, n.staminaMax());
    n.attackCooldown = 100 / Math.max(0.25, staminaRatio) / 100 / ACTION_SCALE;
    if (it.damage >= MAX_ITEM_DAMAGE) {
      if (!it.flags.includes('PULPED')) it.flags.push('PULPED');
      if (this.visible(n)) this.message(`${n.name} finished pulping the corpse.`);
      this.ai(n).pulp = null;
      n.goal.kind = 'none';
    }
  }

  /**
   * npc::complain: an ally the survivor can see voices infection, bites, fatigue, hunger, thirst
   * and bleeding, each on its own timer. allow_complain off silences all but the serious ones
   * (heavy infection, near-collapse fatigue), and nobody complains while either is asleep.
   * Radiation sickness is left out: the port's characters carry no radiation.
   */
  private complain(n: Npc): boolean {
    if (!n.isAlly() || !this.visible(n)) return false;
    const now = this.now();
    const p = this.player;
    const about = (key: string, durS: number, text: string, force = false): boolean => {
      const since = n.complaints.get(key);
      if (since !== undefined && now - since < durS) return false;
      const doComplain = force || (n.rules.hasFlag('allow_complain') && !p.isAsleep() && !n.isAsleep());
      if (!doComplain) return false;
      this.speak(n, text, true);
      n.complaints.set(key, now);
      return true;
    };
    const infected = n.effects.get('infected');
    if (infected) {
      const bp = infected.bp ? BODY_PARTS[infected.bp]?.name ?? infected.bp : 'body';
      if (about('infected', (4 - infected.intensity) * 3600, `My ${bp} wound is infected…`, infected.intensity >= 3)) return true;
    }
    const bite = n.effects.get('bite');
    if (bite) {
      const bp = bite.bp ? BODY_PARTS[bite.bp]?.name ?? bite.bp : 'body';
      if (about('bite', 3600, `The bite wound on my ${bp} looks bad.`)) return true;
    }
    if (n.sleepiness > SLEEPINESS.TIRED && about('fatigue', 30 * 60, '<yawn>', n.sleepiness > SLEEPINESS.MASSIVE - 100)) return true;
    const kcalPct = n.storedKcal / Math.max(1, n.maxStoredKcal());
    if (kcalPct < 0.9 && about('hunger', Math.max(3 * 3600, kcalPct * 60 * 7 * 60), '<hungry>')) return true;
    if (n.thirst > THIRST.VERY_THIRSTY && about('thirst', 2 * 3600, '<thirsty>')) return true;
    const bleed = n.effects.get('bleed');
    if (bleed) {
      const bp = bleed.bp ? BODY_PARTS[bleed.bp]?.name ?? bleed.bp : 'body';
      if (about('bleed', 5 * 60, `My ${bp} is bleeding!`)) return true;
    }
    return false;
  }

  /** npc::say: a line (snippet tags like <yawn> filled in) the survivor sees and hears. */
  speak(n: Npc, text: string, force = false): void {
    if (!force && this.time - n.lastSpeech < 6) return;
    n.lastSpeech = this.time;
    const line = new Dialogue(this, n).parseTags(text);
    if (playerCanSee(this.game, n.tileX, n.tileY, n.z)) this.message(`${n.name}: "${line}"`, 'c_light_gray');
    emitSound(this.game, { x: n.tileX, y: n.tileY, z: n.z }, 10, `${n.name} yelling "${line}"`, { category: 'speech', source: n, ambient: true });
  }

  /** BN npc_sleep searches nearby empty walkable spots. Routing stays in loaded tiles and a shared node budget. */
  private planRest(n: Npc): void {
    const bx = n.tileX, by = n.tileY;
    const current = n.rateSleepSpot(comfortAt(this.game, bx, by, n.z).comfort);
    const candidates: { x: number; y: number; score: number; distance: number }[] = [];
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const x = bx + dx, y = by + dy;
      if (!this.game.map.hasChunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK), n.z)) continue;
      if (!this.grid.passable(x, y, n.z) || this.npcAt(x, y, n.z) || this.monsters?.monsterAt(x, y, n.z)) continue;
      if (this.player.z === n.z && this.player.tileX === x && this.player.tileY === y) continue;
      const score = n.rateSleepSpot(comfortAt(this.game, x, y, n.z).comfort);
      if (score > current) candidates.push({ x, y, score, distance: Math.hypot(dx, dy) });
    }
    candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
    n.path = [];
    for (const { x, y } of candidates) {
      if (!clearWalk(this.grid, n.x, n.y, x + 0.5, y + 0.5, n.z, CREATURE_RADIUS)) {
        if (this.restRoutingBudget <= 0) continue;
        const route = findPath(this.grid, bx, by, x, y, n.z, { doors: true, margin: 6, maxNodes: Math.min(500, this.restRoutingBudget) });
        this.restRoutingBudget -= route.expanded;
        if (!route.complete) continue;
        n.path = route.tiles;
        n.pathGoalX = x + 0.5;
        n.pathGoalY = y + 0.5;
        n.pathAge = 0;
      }
      n.goal = { kind: 'rest', x: x + 0.5, y: y + 0.5 };
      return;
    }
    // BN also lies down in place when no better reachable sleep location is available.
    n.goal = { kind: 'rest', x: bx + 0.5, y: by + 0.5 };
  }

  private foePos(f: Foe): { x: number; y: number } | null {
    if (f.kind === 'monster') return f.m.dead ? null : { x: f.m.x, y: f.m.y };
    if (f.kind === 'npc') return f.n.dead ? null : { x: f.n.x, y: f.n.y };
    return { x: this.player.x, y: this.player.y };
  }
  private foeDead(f: Foe): boolean {
    return f.kind === 'monster' ? f.m.dead : f.kind === 'npc' ? f.n.dead : this.player.dead;
  }
  private foeRadius(f: Foe): number {
    return f.kind === 'monster' ? f.m.radius : CREATURE_RADIUS;
  }
  private foeName(f: Foe): string {
    return f.kind === 'monster' ? f.m.theName() : f.kind === 'npc' ? f.n.name : 'you';
  }

  /**
   * BN npc::get_pathfinding_pair / get_legacy_path_avoid for this NPC: doors unless avoid_doors,
   * bashing for non-allies and allies with allow_bash (up to npc::smash_ability), and with
   * hold_the_line the open doors and rough ground next to the survivor are never stepped on.
   */
  private pathRules(n: Npc): { doors: boolean; bash: boolean; bashMax: number; avoid?: (x: number, y: number) => boolean } {
    const ally = this.allyRules(n);
    const doors = !(ally && n.rules.hasFlag('avoid_doors'));
    const bash = !ally || n.rules.hasFlag('allow_bash');
    const bashMax = bash ? smashAbility(n).bash ?? 0 : 0;
    const hold = ally && n.rules.hasFlag('hold_the_line');
    let avoid: ((x: number, y: number) => boolean) | undefined;
    if (hold || !doors) {
      const p = this.player;
      const map = this.game.map;
      avoid = (x, y) => {
        const t = this.grid.ter(x, y, n.z);
        // avoid_doors: doors it could open are off limits, bashing them included.
        if (!doors && !!t?.open && map.terrain.has(t.open)) return true;
        if (!hold || p.z !== n.z || Math.max(Math.abs(x - p.tileX), Math.abs(y - p.tileY)) > 1) return false;
        // hold_the_line: map::close_door(p, inside, check_only) || move_cost > 2
        return (!!t?.close && map.terrain.has(t.close)) || this.grid.moveCost(x, y, n.z) > 2;
      };
    }
    return { doors, bash: bash && bashMax > 0, bashMax, avoid };
  }

  private moveToward(n: Npc, tx: number, ty: number, dt: number, speedMul: number): void {
    let gx = tx, gy = ty;
    const rules = this.pathRules(n);
    const lineAvoided = !!rules.avoid && bresenham(n.tileX, n.tileY, Math.floor(tx), Math.floor(ty)).some(([x, y], i) => i > 0 && rules.avoid!(x, y));
    const direct = !lineAvoided && Math.hypot(tx - n.x, ty - n.y) < 30 && clearWalk(this.grid, n.x, n.y, tx, ty, n.z, CREATURE_RADIUS * 0.9);
    if (!direct) {
      if (!n.path.length || Math.hypot(n.pathGoalX - tx, n.pathGoalY - ty) > 2 || n.pathAge > 2 || n.stuckTime > 1) {
        const resting = n.goal.kind === 'rest';
        if (resting && this.restRoutingBudget <= 0) { n.moving = false; return; }
        const res = findPath(this.grid, n.tileX, n.tileY, Math.floor(tx), Math.floor(ty), n.z,
          { doors: rules.doors, bash: rules.bash, bashMax: rules.bashMax, avoid: rules.avoid, maxNodes: resting ? Math.min(500, this.restRoutingBudget) : 900, margin: 8 });
        if (resting) {
          this.restRoutingBudget -= res.expanded;
          if (!res.complete) { n.goal.kind = 'none'; n.path = []; n.moving = false; return; }
        }
        n.path = res.tiles;
        n.pathGoalX = tx;
        n.pathGoalY = ty;
        n.pathAge = 0;
        n.stuckTime = 0;
      }
      if (n.path.length) {
        let [px, py] = n.path[0];
        if (Math.hypot(px + 0.5 - n.x, py + 0.5 - n.y) < 0.4 && n.path.length > 1) {
          n.path.shift();
          [px, py] = n.path[0];
        }
        if (!this.grid.passable(px, py, n.z) && Math.hypot(px + 0.5 - n.x, py + 0.5 - n.y) < 1.3) {
          this.passObstacle(n, px, py, rules);
          n.moving = false;
          return;
        }
        gx = px + 0.5;
        gy = py + 0.5;
      }
    }
    const cost = (this.grid.moveCost(n.tileX, n.tileY, n.z) || 2) * 50;
    const speed = (n.speed / Math.max(cost, 1)) * ACTION_SCALE * speedMul * [1, 0.5, 0.25][n.brokenLegs()];
    const d = Math.max(0.001, Math.hypot(gx - n.x, gy - n.y));
    const step = Math.min(speed * dt, d);
    const ox = n.x, oy = n.y;
    const fromTile = { x: n.tileX, y: n.tileY, z: n.z };
    [n.x, n.y] = moveWithCollision(this.game.map, n.x, n.y, n.z, ((gx - n.x) / d) * step, ((gy - n.y) / d) * step);
    const moved = Math.hypot(n.x - ox, n.y - oy);
    n.moving = moved > 0.001;
    if (n.moving) {
      n.walkPhase += moved * 3;
      n.facing = Math.atan2(n.x - ox, -(n.y - oy));
      n.burnMoveStamina(moved * cost, speedMul > 1.2 ? 'run' : 'walk');
      // npc::move_to: any step spoils the aim.
      n.recoil = MAX_RECOIL;
      if (n.tileX !== fromTile.x || n.tileY !== fromTile.y) this.leftTile(n, fromTile);
    }
    if (moved < step * 0.3) n.stuckTime += dt;
    else n.stuckTime = Math.max(0, n.stuckTime - dt);
  }

  /** npc::move_to's "close doors behind self": an ally with close_doors shuts the door it left. */
  private leftTile(n: Npc, from: { x: number; y: number; z: number }): void {
    if (!this.allyRules(n) || !n.rules.hasFlag('close_doors')) return;
    const map = this.game.map;
    const t = map.terAt(from.x, from.y, from.z);
    if (!t.close || !map.terrain.has(t.close)) return;
    // map::close_door refuses with anything in the doorway.
    if (map.itemsAt(from.x, from.y, from.z).length || map.furnAt(from.x, from.y, from.z).id !== 'f_null') return;
    const p = this.player;
    if (p.z === from.z && p.tileX === from.x && p.tileY === from.y) return;
    if (this.npcAt(from.x, from.y, from.z) || this.monsters?.monsterAt(from.x, from.y, from.z)) return;
    if (hasFlag(t, 'OPENCLOSE_INSIDE') && isOutside(map, n.tileX, n.tileY, n.z)) return;
    // The doorway is behind it now; don't let a stale path step walk it back to reopen it.
    while (n.path.length && n.path[0][0] === from.x && n.path[0][1] === from.y) n.path.shift();
    map.setTer(from.x, from.y, from.z, t.close);
    invalidateNaturalLight(this.game);
    this.game.events.emit('mapChanged', { x: from.x, y: from.y, z: from.z });
    sfx.door('close', { x: from.x + 0.5, y: from.y + 0.5, z: from.z }, t.id);
    emitSound(this.game, from, 10, 'swish', { category: 'movement', source: n, sfxId: '', ambient: true });
  }

  /** The next path tile is blocked: open it (a door), smash it (allow_bash), or route again. */
  private passObstacle(n: Npc, x: number, y: number, rules: { doors: boolean; bash: boolean; bashMax: number }): void {
    const t = this.grid.ter(x, y, n.z);
    const f = this.game.map.furnAt(x, y, n.z);
    const door = (!!t?.open && this.game.map.terrain.has(t.open)) || (!!f.open && this.game.map.furniture.has(f.open));
    if (door && rules.doors) return this.openDoor(n, x, y);
    if (rules.bash && n.attackCooldown <= 0) {
      const res = bashTile(this.game, x, y, n.z, smashAbility(n), { source: n });
      if (res.didBash) {
        // Character::smash: a weapon swing's worth of moves (80 % of attack time; 80 unarmed).
        const w = n.inv.wielded;
        n.attackCooldown = (w ? w.attackTime() * 0.8 : 80) / 100 / ACTION_SCALE;
        n.facing = Math.atan2(x + 0.5 - n.x, -(y + 0.5 - n.y));
        if (res.success && this.visible(n)) this.message(`${n.name} smashes the ${res.target}!`);
        if (res.success || res.canBash) return;
      }
    } else if (rules.bash) return;
    n.path = [];
    n.pathAge = 99;
  }

  /** NPCs open doors in their way (allies told avoid_doors never do: passObstacle). */
  private openDoor(n: Npc, x: number, y: number): void {
    const t = this.grid.ter(x, y, n.z);
    const map = this.game.map;
    if (t?.open && map.terrain.has(t.open)) {
      map.setTer(x, y, n.z, t.open);
      this.game.events.emit('mapChanged', { x, y, z: n.z });
      sfx.door('open', { x: x + 0.5, y: y + 0.5, z: n.z }, t.id);
      n.attackCooldown = Math.max(n.attackCooldown, 100 / n.speed / ACTION_SCALE);
      return;
    }
    const f = map.furnAt(x, y, n.z);
    if (f.open && map.furniture.has(f.open)) {
      map.setFurn(x, y, n.z, f.open);
      return;
    }
    n.path = [];
    n.pathAge = 99;
  }

  /** Circle separation: NPCs don't overlap the survivor, each other or monsters. */
  private separate(): void {
    const p = this.player;
    const act = this.npcs.filter((n) => !n.dead && this.inBubble(n));
    for (let i = 0; i < act.length; i++) {
      const n = act[i];
      const push = (ox: number, oy: number, min: number, share: number) => {
        const dx = n.x - ox, dy = n.y - oy;
        const d = Math.hypot(dx, dy);
        if (d >= min) return;
        const nx = d > 1e-4 ? dx / d : 1, ny = d > 1e-4 ? dy / d : 0;
        [n.x, n.y] = moveWithCollision(this.game.map, n.x, n.y, n.z, nx * (min - d) * share, ny * (min - d) * share);
      };
      if (p.z === n.z && !p.dead) push(p.x, p.y, CREATURE_RADIUS * 2, 1);
      for (let j = i + 1; j < act.length; j++) {
        const o = act[j];
        if (o.z !== n.z) continue;
        const dx = o.x - n.x, dy = o.y - n.y, d = Math.hypot(dx, dy);
        if (d >= CREATURE_RADIUS * 1.8) continue;
        const k = (CREATURE_RADIUS * 1.8 - d) / 2, nx = d > 1e-4 ? dx / d : 1, ny = d > 1e-4 ? dy / d : 0;
        [n.x, n.y] = moveWithCollision(this.game.map, n.x, n.y, n.z, -nx * k, -ny * k);
        [o.x, o.y] = moveWithCollision(this.game.map, o.x, o.y, o.z, nx * k, ny * k);
      }
      if (this.monsters) for (const m of this.monsters.monstersNear(n.x, n.y, n.z, 1.2)) push(m.x, m.y, m.radius + CREATURE_RADIUS, 0.6);
    }
  }

  // ---------------------------------------------------------------- combat

  /** Quiet a character's own "You hit…" messages while an NPC fights. */
  private muted<T>(c: { onMessage: ((t: string, c?: string) => void) | null }, fn: () => T): T {
    const s = c.onMessage;
    c.onMessage = null;
    try {
      return fn();
    } finally {
      c.onMessage = s;
    }
  }

  private visible(n: Npc): boolean {
    return playerCanSee(this.game, n.tileX, n.tileY, n.z);
  }

  /**
   * Blow-by-blow narration of fights the survivor isn't in: only when close. In real time a
   * distant brawl seen across a parking lot produced dozens of lines a second and buried
   * everything else in the log (CDDA's turn-based pace never had that problem).
   */
  private narrates(n: Npc): boolean {
    const p = this.game.player;
    return Math.hypot(n.x - p.x, n.y - p.y) <= NARRATE_RANGE && this.visible(n);
  }

  private melee(n: Npc, foe: Foe): void {
    const w = n.inv.wielded;
    if (foe.kind === 'monster') {
      const m = foe.m;
      // NPCs use weapon/style techniques too (same combat.ts path as the survivor).
      const res = this.muted(n, () => meleeAttack(n, { dodge: m.dodge(), armor: m.type.armor, sizeMeleePenalty: m.sizeMeleePenalty(), info: monsterTargetInfo(m) }, this.rng, m.theName(), { downable: !m.has('IMMOBILE') }));
      n.attackCooldown = res.cooldownSeconds;
      m.aggroCharacter = true;
      if (!res.hit) {
        if (this.narrates(n)) this.message(`${n.name} misses ${m.theName()}.`, 'c_light_gray');
        return;
      }
      let lastSpecial: { type: string; amount: number }[] | undefined;
      for (const strike of res.mutationStrikes ?? []) {
        if (m.dead) break;
        if (strike.roll() < 0) continue;
        lastSpecial = applyFlatArmor(strike.damage, m.type.armor);
        const damage = Math.floor(lastSpecial.reduce((sum, d) => sum + d.amount, 0));
        if (damage > 0 && this.narrates(n)) this.message(hitMessage(mutationStrikeText(strike, m.theName(), n.name), damage, false, true));
        this.monsters?.hurt(m, damage, null);
      }
      if (m.dead) return;
      let dom = 'bash', best = 0;
      for (const d of res.damage) if (d.amount > best) (best = d.amount), (dom = d.type);
      if (this.narrates(n)) {
        const tec = res.technique && techniqueMessage(res.technique, m.theName(), n.name);
        this.message(tec ? hitMessage(tec, res.total, res.crit, true) : `${n.name} ${verb3(meleeVerb(dom, res.total, (a, b) => this.rng.int(a, b)))} ${m.theName()}${res.total > 0 ? '' : ' but does no damage'}.`);
      }
      sfx.meleeHit(m.type.material[0] ?? 'flesh', m, { id: w?.typeId, skill: w ? w.meleeSkill() : 'unarmed' });
      emitSound(this.game, { x: m.tileX, y: m.tileY, z: m.z }, 8, 'Smack!', { category: 'combat', source: n, ambient: true });
      this.monsters?.hurt(m, res.total, null);
      const venom = venomEffect(n);
      if (venom && !m.dead && !m.resistsPoison() && venomTriggered(lastSpecial, !!res.primaryUnarmed, res.damage))
        m.addEffect(venom, turnsToSeconds(VENOM_TURNS));
      if (!m.dead && res.outcome) applyTechniqueToMonster(m, res.outcome, n.x, n.y, this.rng);
      return;
    }
    const target = foe.kind === 'npc' ? foe.n : this.player;
    const res = this.muted(n, () => meleeAttack(n, { dodge: tryDodgeRoll(target) / 5, specialDodge: () => tryDodgeRoll(target) }, this.rng, foe.kind === 'npc' ? foe.n.name : 'you'));
    n.attackCooldown = res.cooldownSeconds;
    if (!res.hit) {
      onDodged(target, n.getSkill('melee'));
      if (foe.kind === 'player') this.message(`${n.name} misses you.`);
      else if (this.narrates(n)) this.message(`${n.name} misses ${target.name}.`, 'c_light_gray');
      return;
    }
    const lastSpecial = this.applyMutationStrikes(n, target, res.mutationStrikes ?? []);
    if (target.dead) return;
    let bp: BodyPartId = selectBodyPart(this.rng, { hitRoll: res.hitSpread });
    const units = (res.rawDamage ?? res.damage).map((d) => ({ ...d }));
    // The defender blocks with a weapon or limb like against monsters (block_hit).
    bp = (foe.kind === 'player' ? characterDefend(target, units, bp, this.rng) : this.muted(target, () => characterDefend(target, units, bp, this.rng, true))).bp;
    const absorbed = target.inv.absorbHit(bp, units, this.rng);
    const r = this.muted(target, () => target.takeHit(bp, absorbed));
    this.applyVenom(n, target, lastSpecial, res, absorbed);
    sfx.meleeHit('flesh', { x: target === this.player ? this.player.x : (target as Npc).x, y: target === this.player ? this.player.y : (target as Npc).y, z: n.z }, { id: w?.typeId, skill: w ? w.meleeSkill() : 'unarmed' });
    if (foe.kind === 'player') {
      this.message(r.damage > 0 ? `${n.name} hits your ${BODY_PARTS[bp].name} for ${r.damage} damage.` : `${n.name} hits your ${BODY_PARTS[bp].name}, but your armor protects you.`, r.damage > 0 ? 'c_red' : undefined);
      this.game.events.emit('playerHurt', { amount: r.damage, bp, source: n });
      if (r.damage > 0) sfx.playerHurt(!this.player.male);
    } else {
      if (this.narrates(n)) this.message(`${n.name} hits ${foe.n.name}.`);
      this.afterHit(foe.n, r.damage, { kind: 'npc', n });
    }
  }

  /**
   * Each mutation strike rolls its own hit and dodge when it comes up, then gets its own
   * body-part, blocking, clothing and passive armor resolution. Returns what the last strike
   * that landed dealt after armor (for the venom check).
   */
  private applyMutationStrikes(attacker: Character, target: Character, strikes: MutationStrike[]): { type: string; amount: number }[] | undefined {
    let lastDealt: { type: string; amount: number }[] | undefined;
    for (const strike of strikes) {
      if (target.dead) break;
      const spread = strike.roll();
      if (spread < 0) { onDodged(target, attacker.getSkill('melee')); continue; }
      let bp = selectBodyPart(this.rng, { hitRoll: spread });
      const units = strike.damage.map(d => ({ ...d }));
      bp = this.muted(target, () => characterDefend(target, units, bp, this.rng, target !== this.player)).bp;
      const absorbed = target.inv.absorbHit(bp, units, this.rng);
      lastDealt = absorbed;
      const result = this.muted(target, () => target.takeHit(bp, absorbed));
      const playerAttack = attacker === this.player;
      const text = mutationStrikeText(strike, target === this.player ? 'you' : target.name, playerAttack ? undefined : attacker.name);
      if (result.damage > 0 && (playerAttack || target === this.player || this.narrates(attacker as Npc)))
        this.message(hitMessage(text, result.damage, false, !playerAttack), target === this.player ? 'c_red' : undefined);
      if (target === this.player) {
        this.game.events.emit('playerHurt', { amount: result.damage, bp, source: attacker });
        if (result.damage > 0) sfx.playerHurt(!this.player.male);
      } else this.afterHit(target as Npc, result.damage, playerAttack ? { kind: 'player' } : { kind: 'npc', n: attacker as Npc });
    }
    return lastDealt;
  }

  /** BN venom after the primary blow on a person; only the survivor is told. */
  private applyVenom(attacker: Character, target: Character, lastSpecial: { type: string; amount: number }[] | undefined, res: MeleeResult, primaryDealt: { type: string; amount: number }[]): void {
    const venom = venomEffect(attacker);
    if (!venom || target.dead || !venomTriggered(lastSpecial, !!res.primaryUnarmed, primaryDealt)) return;
    if (attacker === this.player) this.message(venomMessage(venom, target.name), 'c_light_green');
    this.muted(target, () => target.addEffect(venom, turnsToEffectSeconds(VENOM_TURNS)));
  }

  private reload(n: Npc, gun: Item): void {
    const r = this.muted(n, () => n.inv.reload(gun));
    if (!r.ok) {
      // Out of ammo: put the gun away and fight with fists (npc::wield_better_weapon, simplified).
      this.muted(n, () => n.inv.unwield());
      return;
    }
    n.attackCooldown = Math.max(0.5, (r.moves || 100) / 100 / ACTION_SCALE);
    sfx.reload(gun.typeId, n);
    if (this.narrates(n)) this.message(`${n.name} reloads ${n.male ? 'his' : 'her'} ${gun.baseName()}.`, 'c_light_gray');
  }

  private shoot(n: Npc, gun: Item, foe: Foe, pos: { x: number; y: number }): void {
    const shot = this.muted(n, () => fireGun(n, gun, this.rng));
    if (!shot.ok) return;
    n.attackCooldown = Math.max(shot.cooldownSeconds, 0.35);
    const ammo = gun.ammoData();
    sfx.gunshot(gun.typeId, n, { ammoType: typeof ammo?.ammo_type === 'string' ? ammo.ammo_type : undefined, loudness: shot.noise.volume });
    emitSound(this.game, { x: n.tileX, y: n.tileY, z: n.z }, shot.noise.volume, shot.noise.sound || 'Bang!', { category: 'combat', source: n, sfxId: '' });
    // The round flies (enemyfire.ts): the NPC's BN dispersion roll sets the direction; it hits
    // whatever it meets first — its foe, a follower or the survivor in the way, a wall.
    const cls = rangedClass(gun);
    const flies = fliesVisibly(cls);
    const th = foe.kind === 'monster' ? foe.m.z * LEVEL_HEIGHT + bodyHeightOf(foe.m) * 0.6 : n.z * LEVEL_HEIGHT + 1.2;
    const band = (mb: number) => (mb < 0.2 ? 1.5 : mb < 0.8 ? 1 : 0.5);
    // Multi-projectile ammo (BN ammo `shot`): every pellet flies on its own line off the rolled
    // direction (combat.ts pelletAngle) with the per-pellet damage, and hits whoever it meets.
    const pellets = shot.pellets && shot.pellets > 1 && shot.shotDamage ? shot.pellets : 1;
    const per = pellets > 1 ? shot.shotDamage! : shot.damage;
    const scaled = (mb: number) => per.map((u) => ({ type: u.type, amount: u.amount * band(mb), armor_penetration: u.armor_penetration, armor_multiplier: 1 }));
    // BN ballistics.cpp skips creatures friendly to the shooter within one tile of it.
    const spares = (b: unknown): boolean => {
      const o = b as { x: number; y: number };
      if (Math.max(Math.abs(Math.floor(o.x) - n.tileX), Math.abs(Math.floor(o.y) - n.tileY)) > 1) return false;
      if (b === this.player) return n.isFriendly();
      const other = b as Npc;
      return other instanceof Npc && ((n.isFriendly() && other.isFriendly()) || (!!n.faction && n.faction !== FACTION_NONE && other.faction === n.faction));
    };
    // Arrows and bolts drop on the survivor's gravity arc; a grenade launcher lobs, and a round that
    // does something where it lands (BN apply_ammo_effects: blast, fire, gas) sets it off there.
    const lob = lobOf(gun.def, ammo, cls);
    const lands = landsWithEffect(this.game, ammo);
    const heavy = lob !== null || (cls === 'launcher' && lands);
    const dist = Math.hypot(pos.x - n.x, pos.y - n.y);
    let stops = 0;
    for (let i = 0; i < pellets; i++) {
      const yawOff = shot.spread * Math.cos(shot.azimuth) + (pellets > 1 ? pelletAngle(shot.shotSpreadMoa ?? 0, this.rng, shot.shotHalfAngle) : 0);
      enemyFireOf(this.game).fire({
        kind: heavy ? 'grenade' : flies ? (cls === 'sling' ? 'stone' : 'arrow') : 'bullet',
        speed: lob ? lobSpeed(lob, dist) : heavy ? 45 : flies ? flightSpeed(cls, Number(ammo?.speed) || 100) : undefined,
        arc: flies || lob !== null,
        onEnd: lands ? (x, y, _h, _what, z) => void roundEndsAt(this.game, this.monsters ?? null, x, y, z, ammo, asArray(gun.def.ammo_effects as string[] | undefined), { npc: n }) : undefined,
        x: n.x, y: n.y, h: n.z * LEVEL_HEIGHT + 1.4, tx: pos.x, ty: pos.y, th, yawOff,
        range: Math.max(1, shot.range || 30), z: n.z, from: n, spares,
        onMonster: (mm, mb) => {
          const m = mm as Monster;
          const total = Math.floor(applyFlatArmor(scaled(mb), m.type.armor).reduce((s, x) => s + x.amount, 0));
          if (this.narrates(n)) this.message(`${n.name} shoots ${m.theName()}.`);
          sfx.bulletHit('flesh', m);
          m.aggroCharacter = true;
          this.monsters?.hurt(m, total, null);
        },
        onNpc: (t, mb) => {
          const target = t as Npc;
          const bp = selectBodyPart(this.rng);
          const res = this.muted(target, () => target.takeHit(bp, target.inv.absorbHit(bp, scaled(mb), this.rng)));
          if (this.narrates(n)) this.message(`${n.name} shoots ${target.name}.`);
          this.afterHit(target, res.damage, { kind: 'npc', n });
        },
        onPlayer: (mb) => {
          const bp = selectBodyPart(this.rng);
          const res = this.muted(this.player, () => this.player.takeHit(bp, this.player.inv.absorbHit(bp, scaled(mb), this.rng)));
          this.message(pellets > 1 ? `A pellet from ${n.name}'s shot hits your ${BODY_PARTS[bp].name} for ${res.damage} damage!` : `${n.name} shoots you in the ${BODY_PARTS[bp].name} for ${res.damage} damage!`, 'c_red');
          this.game.events.emit('playerHurt', { amount: res.damage, bp, source: n });
          if (res.damage > 0) sfx.playerHurt(!this.player.male);
        },
        onStop: () => {
          // Only when the whole load missed (every pellet stopped without a body).
          if (++stops === pellets && foe.kind === 'player') this.message(`${n.name} shoots at you and misses!`, 'c_light_red');
        },
      });
    }
  }

  /** Bookkeeping after an NPC took damage from anything: flash, death, grudges. */
  afterHit(n: Npc, dmg: number, from: Foe | { kind: 'npc'; n: Npc } | { kind: 'player'; stray: boolean }): void {
    if (dmg > 0) {
      n.hitFlash = 0.2;
      for (const f of this.onHurt) f(n, dmg);
    }
    n.checkDeath();
    if (n.dead) {
      this.died(n, from.kind === 'player' ? 'player' : null);
      return;
    }
    // A stray projectile (one aimed at someone else) hurts but does not provoke: BN
    // Creature::deal_projectile_attack never calls npc::on_attacked (src/game/npcfire.ts).
    if (from.kind === 'player' && !('stray' in from && from.stray)) {
      // melee.cpp: the survivor's hit flags the target for ENGAGE_HIT (effect_hit_by_player, 10 min).
      this.ai(n).hitByPlayerUntil = this.now() + 600;
      if (!n.isEnemy()) {
        n.op.anger += 5 + Math.floor(dmg / 2);
        n.makeAngry();
        this.alertFaction(n);
        if (n.attitude === 'KILL') this.say(n, '<swear!>');
      }
    }
  }

  /** Faction members nearby turn on the survivor too (guards defend each other). */
  alertFaction(n: Npc): void {
    if (n.faction === FACTION_FOLLOWERS || n.faction === 'no_faction' || !n.faction) return;
    for (const o of this.npcs) {
      if (o === n || o.dead || o.faction !== n.faction || o.isEnemy()) continue;
      if (o.z !== n.z || Math.hypot(o.x - n.x, o.y - n.y) > 25) continue;
      o.makeAngry();
    }
  }

  private died(n: Npc, killer: 'player' | null): void {
    if (n.dead_) return;
    n.dead_ = true;
    n.dead = true;
    if (this.visible(n)) this.message(`${n.name} dies!`, killer === 'player' ? 'c_light_green' : 'c_red');
    // Drop everything plus a corpse item (CDDA npc::die -> place_corpse).
    const map = this.game.map;
    const here = L.ground(map, n.tileX, n.tileY, n.z);
    for (const from of [L.hands(n), L.worn(n), L.inv(n)])
      for (const it of [...itemsAt(from)]) {
        // things that were part of them (bionic weapons, integrated armor) die with them
        if (it.hasFlag('NO_DROP') || it.hasFlag('INTEGRATED') || it.hasFlag('BIONIC_WEAPON')) consumeItem(it, from);
        else moveItem(it, from, here, { force: true, quiet: true });
      }
    if (this.data.items.corpse) {
      const c = createItem(this.data, 'corpse');
      c.vars.name = `corpse of ${n.name}`;
      c.vars.npc = n.uid;
      spawnItem(c, here, { force: true, quiet: true });
    }
    map.addField(n.tileX, n.tileY, n.z, 'fd_blood', 2);
    this.game.events.emit('creatureDied', { creature: n, killer: killer === 'player' ? this.player : killer });
    for (const f of this.onDied) f(n);
  }

  // ---------------------------------------------------------------- player attacks (PlayerCombat hooks)

  /** NPC nearest the crosshair within `reach` (tiles) and a small cone, same as monster melee targeting. */
  crosshairNpc(reach: number): Npc | null {
    const p = this.player;
    const look = this.game.lookAt?.(reach + 1.5);
    const hit = look?.kind === 'creature' ? (look.creature as { npc?: Npc } | undefined)?.npc : undefined;
    if (hit && !hit.dead && Math.hypot(hit.x - p.x, hit.y - p.y) - CREATURE_RADIUS <= reach) return hit;
    let best: Npc | null = null, bs = Infinity;
    for (const n of this.npcs) {
      if (n.dead || n.z !== p.z) continue;
      const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
      if (d - CREATURE_RADIUS > reach) continue;
      let a = Math.atan2(dx, -dy) - p.yaw;
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      if (Math.abs(a) > 0.5) continue;
      const s = Math.abs(a) + d * 0.1;
      if (s < bs) (bs = s), (best = n);
    }
    return best;
  }

  /** The NPC a shot would be aimed at (npcs.ts: PlayerCombat.crosshairNpc, the exact body test). */
  rangedTargetNpc: ((reach: number) => Npc | null) | null = null;

  /** The NPC the crosshair itself is on, within `reach` m (the look ray's creature without a combat hook). */
  crosshairNpcExact(reach: number): Npc | null {
    if (this.rangedTargetNpc) return this.rangedTargetNpc(reach);
    const look = this.game.lookAt?.(reach + 1.5);
    const n = look?.kind === 'creature' ? (look.creature as { npc?: Npc } | undefined)?.npc : undefined;
    return n && !n.dead && Math.hypot(n.x - this.player.x, n.y - this.player.y) - CREATURE_RADIUS <= reach ? n : null;
  }

  /** attackGuard: attacking a non-hostile NPC needs a yes first (CDDA query_yn). */
  guardAttack(): boolean {
    const w = this.player.inv.wielded;
    // A shot asks only about the NPC under the crosshair: BN's target_ui confirms the creature
    // you target, and one merely near the line of fire is a bystander (src/game/npcfire.ts).
    const n = w?.isGun() ? this.crosshairNpcExact(30) : this.crosshairNpc(w?.hasFlag('REACH_ATTACK') ? 2.2 : 1.2);
    if (!n || n.isEnemy() || !this.confirmAttack) return true;
    this.confirmAttack(n, () => {
      n.makeAngry();
      if (n.attitude === 'FLEE_TEMP') n.fleeTime = 20;
      this.alertFaction(n);
    });
    return false;
  }

  /** npcMelee hook: swing at the NPC under the crosshair when it's nearer than the monster. */
  playerMelee(reach: number, m: Monster | null): boolean {
    const n = this.crosshairNpc(reach);
    if (!n) return false;
    const p = this.player;
    if (m && Math.hypot(m.x - p.x, m.y - p.y) < Math.hypot(n.x - p.x, n.y - p.y)) return false;
    const w = p.inv.wielded;
    const info: TargetInfo = { size: 3, bodytype: 'human', isMonster: false, hasWeapon: !!n.inv.wielded, hasEffect: (id) => n.hasEffect(id), flags: [], species: ['HUMAN'] };
    const res = meleeAttack(p, { dodge: tryDodgeRoll(n) / 5, specialDodge: () => tryDodgeRoll(n), info }, this.rng, n.name);
    sfx.meleeSwing(undefined, { id: w?.typeId, skill: w ? w.meleeSkill() : 'unarmed' });
    this.lastPlayerSwing = res.cooldownSeconds;
    if (!res.hit) {
      onDodged(n, p.getSkill('melee'));
      this.afterHit(n, 0, { kind: 'player' });
      return true;
    }
    const lastSpecial = this.applyMutationStrikes(p, n, res.mutationStrikes ?? []);
    if (n.dead) return true;
    let bp = selectBodyPart(this.rng, { hitRoll: res.hitSpread });
    const units = (res.rawDamage ?? res.damage).map((d) => ({ ...d }));
    bp = this.muted(n, () => characterDefend(n, units, bp, this.rng, true)).bp;
    const absorbed = n.inv.absorbHit(bp, units, this.rng);
    const r = n.takeHit(bp, absorbed);
    this.applyVenom(p, n, lastSpecial, res, absorbed);
    // Techniques on people: downed/stunned become effects, disarms drop the weapon.
    const o = res.outcome;
    if (o && !n.dead) {
      if (o.downTurns > 0) n.addEffect('downed', turnsToEffectSeconds(o.downTurns));
      if (o.stunTurns > 0) n.addEffect('stunned', turnsToEffectSeconds(o.stunTurns));
      if (o.disarms && n.inv.wielded) {
        const r = moveItem(n.inv.wielded, L.hands(n), L.ground(this.game.map, n.tileX, n.tileY, n.z), { quiet: true });
        if (r.ok) this.message(`You disarm ${n.name}!`);
      }
    }
    let dom = 'bash', best = 0;
    for (const d of res.damage) if (d.amount > best) (best = d.amount), (dom = d.type);
    const verb = meleeVerb(dom, r.damage, (a, b) => this.rng.int(a, b));
    const tec = res.technique && techniqueMessage(res.technique, n.name);
    if (tec) this.message(hitMessage(tec, r.damage, res.crit));
    else this.message(r.damage > 0 ? `You ${verb} ${n.name}'s ${BODY_PARTS[bp].name} for ${r.damage} damage.${res.crit ? '  Critical!' : ''}` : `You ${verb} ${n.name} but do no damage.`);
    sfx.meleeHit('flesh', n, { id: w?.typeId, skill: w ? w.meleeSkill() : 'unarmed' });
    emitSound(this.game, { x: n.tileX, y: n.tileY, z: n.z }, 8, 'Smack!', { category: 'combat', source: this.player, sfxId: '', ambient: true });
    this.afterHit(n, r.damage, { kind: 'player' });
    return true;
  }
  /** Cooldown of the last NPC swing (PlayerCombat reads it through the hook wiring). */
  lastPlayerSwing = 0;

  // ---------------------------------------------------------------- missions: target monsters

  /** Spawn MGOAL_KILL_MONSTER targets once the survivor is near their spot. */
  private spawnMissionMonsters(): void {
    if (!this.monsters) return;
    const p = this.player;
    for (const m of this.missions.active()) {
      const t = m.targetMonster;
      if (!t || t.spawned || t.dead) continue;
      if (t.z !== p.z || Math.hypot(t.x - p.x, t.y - p.y) > 50 || !this.grid.known(t.x, t.y, t.z)) continue;
      this.spawnTarget(m);
    }
  }

  spawnTarget(m: MissionInstance): Monster | null {
    const t = m.targetMonster;
    if (!t || !this.monsters) return null;
    let id = t.monster;
    if (!id && t.group) id = pickFromMonsterGroup(this.data, t.group, this.rng, { elapsed: this.now() })[0]?.id;
    if (!id) {
      warnOnce('mission_monster', `${m.id}`, `[missions] ${m.id}: can't pick a target monster`);
      t.spawned = true;
      return null;
    }
    const spot = this.game.map.passable(t.x, t.y, t.z) ? [t.x, t.y] : this.freeTileNear(t.x, t.y, t.z) ?? [t.x, t.y];
    const mon = this.monsters.spawnById(id, spot[0] + 0.5, spot[1] + 0.5, t.z, { name: t.name });
    t.spawned = true;
    if (mon) t.uid = mon.uid;
    return mon;
  }

  /** Forget every NPC, mission and dialogue variable (new game / save without NPC data). */
  clear(): void {
    for (const n of [...this.npcs]) this.remove(n);
    this.missions.fromJSON({ nextUid: 1, missions: [] });
    for (const m of [this.playerVars, this.globals, this.playerTalkEffects, this.factionTrust, this.kills, this.speciesKills] as Map<string, unknown>[]) m.clear();
    this.spawnedKeys.clear();
    this.cash = 0;
  }

  // ---------------------------------------------------------------- save / load

  /** Serializable state for the save system (registerSaveable('npcs', ...)). */
  toJSON(): NpcSystemJSON {
    return {
      npcs: this.npcs.map((n) => n.npcJSON()),
      missions: this.missions.toJSON(),
      playerVars: [...this.playerVars], globals: [...this.globals], playerTalkEffects: [...this.playerTalkEffects],
      factionTrust: [...this.factionTrust], cash: this.cash, kills: [...this.kills], speciesKills: [...this.speciesKills],
      spawnedKeys: [...this.spawnedKeys],
    };
  }

  /** An NPC's drops land on its tile (src/game/moves.ts). */
  private placeNpc(n: Npc): void {
    n.groundLoc = () => L.ground(this.game.map, n.tileX, n.tileY, n.z);
    n.world = characterWorld(this.game, n);
  }

  fromJSON(j: NpcSystemJSON): void {
    for (const n of [...this.npcs]) this.remove(n);
    for (const nj of j.npcs) {
      const n = Npc.fromJSON(this.data, nj);
      n.onMessage = null;
      this.npcs.push(n);
      this.placeNpc(n);
      for (const f of this.onSpawned) f(n);
    }
    this.missions.fromJSON(j.missions);
    const fill = <K, V>(m: Map<K, V>, e: [K, V][]) => {
      m.clear();
      for (const [k, v] of e) m.set(k, v);
    };
    fill(this.playerVars, j.playerVars);
    fill(this.globals, j.globals);
    fill(this.playerTalkEffects, j.playerTalkEffects);
    fill(this.factionTrust, j.factionTrust);
    fill(this.kills, j.kills);
    fill(this.speciesKills, j.speciesKills);
    // Saves from before BN variable naming (npctalk_var_<type>_<context>_<name>) kept bare names.
    migrateTalkVars(this.nd, this.playerVars);
    for (const n of this.npcs) migrateTalkVars(this.nd, n.vars);
    this.cash = j.cash;
    this.spawnedKeys.clear();
    for (const k of j.spawnedKeys) this.spawnedKeys.add(k);
  }
}

export interface NpcSystemJSON {
  npcs: NpcJSON[];
  missions: ReturnType<MissionSystem['toJSON']>;
  playerVars: [string, string][];
  globals: [string, string][];
  playerTalkEffects: [string, number][];
  factionTrust: [string, number][];
  cash: number;
  kills: [string, number][];
  speciesKills: [string, number][];
  spawnedKeys: string[];
}

/** "clobber" -> "clobbers", "run through" -> "runs through" (third-person melee verbs). */
export function verb3(v: string): string {
  const [head, ...rest] = v.split(' ');
  const s = /(s|sh|ch|x|z)$/.test(head) ? `${head}es` : `${head}s`;
  return [s, ...rest].join(' ');
}

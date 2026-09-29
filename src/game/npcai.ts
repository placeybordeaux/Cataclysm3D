import { Rng, hashSeed } from '../core/rng';
import { ACTION_SCALE } from '../core/time';
import type { GameData } from '../data/types';
import { pickFromMonsterGroup } from '../data/index';
import { warnOnce } from '../data/warn';
import type { Game, GameSystem } from './game';
import { Grid, clearWalk, hasLOS } from './los';
import { findPath } from './pathfind';
import { moveWithCollision, CREATURE_RADIUS } from './physics';
import { applyFlatArmor, characterDefend, fireGun, hitMessage, meleeAttack, selectBodyPart, tryDodgeRoll, type ShotResult } from './combat';
import { techniqueMessage, type TargetInfo } from './techniques';
import { tickMartialArts } from './martialarts';
import { turnsToEffectSeconds } from './monster';
import { createItem, type Item } from './item';
import type { Monster } from './monster';
import type { MonsterSystem, MonsterTarget } from './monai';
import { applyTechniqueToMonster, meleeVerb, monsterTargetInfo } from './playercombat';
import { emitSound } from './sound';
import { sfx } from '../audio/sfx';
import { playerCanSee, isOutside, isDay } from './vision';
import { FACTION_FOLLOWERS, Npc, generateNpc, restockShop, type NpcData, type NpcJSON, type NpcSpec } from './npc';
import { Dialogue, type TalkWorld } from './talk';
import { MissionSystem, type MissionHost, type MissionInstance } from './missions';
import type { BodyPartId } from './bodyparts';
import { BODY_PARTS } from './bodyparts';

/** Tiles within which fights between NPCs and monsters are narrated blow by blow. */
export const NARRATE_RANGE = 20;

// The NPC simulation (CDDA npcmove.cpp, real-time and much simplified). Like MonsterSystem,
// NPCs live forever once spawned and only those in the reality bubble are simulated.
// Each NPC re-plans at ~4 Hz and picks one goal:
//   fight   a hostile monster / NPC (or the survivor for KILL attitude): melee, or shoot a
//           loaded gun from range, reloading when empty
//   flee    from danger when hurt or outmatched, or from the survivor (FLEE_TEMP)
//   follow  the survivor (followers), keeping a couple of tiles away
//   return  to the guard post (guards, shopkeepers, followers told to wait)
//   approach the survivor to talk (TALK) or mug them (MUG)
//   wander  around where they were placed (everyone else)
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
  dropItem(it: Item, x: number, y: number, z: number): void {
    this.game.map.addItem(x, y, z, it);
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
        x: n.x, y: n.y, z: n.z, get dead() { return n.dead; }, character: n, name: n.name,
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
    if (n.isAsleep()) n.wakeUp();
    const d = new Dialogue(this, n);
    d.start();
    n.facing = Math.atan2(this.player.x - n.x, -(this.player.y - n.y));
    return d;
  }

  // ---------------------------------------------------------------- main loop

  update(game: Game, dt: number, gameDt: number): void {
    this.time += dt;
    this.grid.reset();
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
      n.hitFlash = Math.max(0, n.hitFlash - dt);
      n.pathAge += dt;
      if (n.fleeTime > 0 && (n.fleeTime -= dt) <= 0 && n.attitude === 'FLEE_TEMP') n.attitude = 'NULL';
      n.thinkTimer -= dt;
      if (n.thinkTimer <= 0) {
        n.thinkTimer += THINK + this.rng.next() * 0.05;
        this.think(n);
      }
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

  private think(n: Npc): void {
    const p = this.player;
    const dP = n.z === p.z ? Math.hypot(p.x - n.x, p.y - n.y) : Infinity;
    const g = n.goal;
    if (n.attitude === 'FLEE' || n.attitude === 'FLEE_TEMP') {
      this.setFlee(n, p.x, p.y);
      return;
    }
    const foe = this.nearestFoe(n);
    if (foe) {
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
    g.target = undefined;
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
    if (n.isFollower() && n.following && !n.guardPos) {
      // Close but on the other side of a wall still means "catch up" (they'd otherwise stand
      // inside the shelter while you walk off down the street).
      if (dP > 3.2 || (dP < Infinity && !this.sees(n, p.x, p.y, p.z, 8))) {
        g.kind = 'follow';
        g.x = p.x;
        g.y = p.y;
      } else g.kind = 'none';
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
    if (n.effects.has('downed') || n.isAsleep()) {
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
      const d = Math.hypot(pos.x - n.x, pos.y - n.y);
      n.facing = Math.atan2(pos.x - n.x, -(pos.y - n.y));
      const gun = n.inv.wielded?.isGun() ? n.inv.wielded : null;
      if (gun && d > 1.6) {
        if (gun.ammoRemaining() <= 0) {
          if (n.attackCooldown <= 0) this.reload(n, gun);
        } else if (n.attackCooldown <= 0 && d < 30 && this.sees(n, pos.x, pos.y, n.z, 30)) {
          this.shoot(n, gun, foe, pos);
          n.moving = false;
          return;
        }
        if (gun.ammoRemaining() > 0) {
          n.moving = false;
          return;
        }
      }
      const reach = (n.inv.wielded?.hasFlag('REACH_ATTACK') ? 2 : 1) + 0.35 + CREATURE_RADIUS + this.foeRadius(foe);
      if (d <= reach && hasLOS(this.grid, n.tileX, n.tileY, Math.floor(pos.x), Math.floor(pos.y), n.z)) {
        n.moving = false;
        if (n.attackCooldown <= 0) this.melee(n, foe);
        return;
      }
      this.moveToward(n, pos.x, pos.y, dt, 1.25);
      return;
    }
    switch (g.kind) {
      case 'none':
        n.moving = false;
        return;
      case 'flee':
        this.moveToward(n, g.x, g.y, dt, 1.4);
        return;
      case 'follow':
        this.moveToward(n, g.x, g.y, dt, Math.hypot(g.x - n.x, g.y - n.y) > 8 ? 1.5 : 1);
        if (Math.hypot(this.player.x - n.x, this.player.y - n.y) < 2.5 && this.sees(n, this.player.x, this.player.y, this.player.z, 3)) (g.kind = 'none'), (n.moving = false);
        return;
      case 'approach':
        if (Math.hypot(g.x - n.x, g.y - n.y) < 1.4) {
          n.moving = false;
          return;
        }
        this.moveToward(n, g.x, g.y, dt, 1);
        return;
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

  private moveToward(n: Npc, tx: number, ty: number, dt: number, speedMul: number): void {
    let gx = tx, gy = ty;
    const direct = Math.hypot(tx - n.x, ty - n.y) < 30 && clearWalk(this.grid, n.x, n.y, tx, ty, n.z, CREATURE_RADIUS * 0.9);
    if (!direct) {
      if (!n.path.length || Math.hypot(n.pathGoalX - tx, n.pathGoalY - ty) > 2 || n.pathAge > 2 || n.stuckTime > 1) {
        const res = findPath(this.grid, n.tileX, n.tileY, Math.floor(tx), Math.floor(ty), n.z, { doors: true, maxNodes: 900, margin: 8 });
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
          this.openDoor(n, px, py);
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
    [n.x, n.y] = moveWithCollision(this.game.map, n.x, n.y, n.z, ((gx - n.x) / d) * step, ((gy - n.y) / d) * step);
    const moved = Math.hypot(n.x - ox, n.y - oy);
    n.moving = moved > 0.001;
    if (n.moving) {
      n.walkPhase += moved * 3;
      n.facing = Math.atan2(n.x - ox, -(n.y - oy));
      n.burnMoveStamina(moved * cost, speedMul > 1.2 ? 'run' : 'walk');
    }
    if (moved < step * 0.3) n.stuckTime += dt;
    else n.stuckTime = Math.max(0, n.stuckTime - dt);
  }

  /** NPCs open doors in their way (they never bash them, unlike zombies). */
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
      let dom = 'bash', best = 0;
      for (const d of res.damage) if (d.amount > best) (best = d.amount), (dom = d.type);
      if (this.narrates(n)) {
        const tec = res.technique && techniqueMessage(res.technique, m.theName(), n.name);
        this.message(tec ? hitMessage(tec, res.total, res.crit, true) : `${n.name} ${verb3(meleeVerb(dom, res.total, (a, b) => this.rng.int(a, b)))} ${m.theName()}${res.total > 0 ? '' : ' but does no damage'}.`);
      }
      sfx.meleeHit(m.type.material[0] ?? 'flesh', m, { id: w?.typeId, skill: w ? w.meleeSkill() : 'unarmed' });
      emitSound(this.game, { x: m.tileX, y: m.tileY, z: m.z }, 8, 'Smack!', { category: 'combat', source: n, ambient: true });
      this.monsters?.hurt(m, res.total, null);
      if (!m.dead && res.outcome) applyTechniqueToMonster(m, res.outcome, n.x, n.y, this.rng);
      return;
    }
    const target = foe.kind === 'npc' ? foe.n : this.player;
    const res = this.muted(n, () => meleeAttack(n, { dodge: tryDodgeRoll(target) / 5 }, this.rng, foe.kind === 'npc' ? foe.n.name : 'you'));
    n.attackCooldown = res.cooldownSeconds;
    if (!res.hit) {
      if (foe.kind === 'player') this.message(`${n.name} misses you.`);
      else if (this.narrates(n)) this.message(`${n.name} misses ${target.name}.`, 'c_light_gray');
      return;
    }
    let bp: BodyPartId = selectBodyPart(this.rng, { hitRoll: res.hitSpread });
    const units = res.damage.map((d) => ({ ...d }));
    // The defender blocks with a weapon or limb like against monsters (block_hit).
    bp = (foe.kind === 'player' ? characterDefend(target, units, bp, this.rng) : this.muted(target, () => characterDefend(target, units, bp, this.rng, true))).bp;
    const absorbed = target.inv.absorbHit(bp, units, this.rng);
    const r = this.muted(target, () => target.takeHit(bp, absorbed));
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

  private reload(n: Npc, gun: Item): void {
    const r = this.muted(n, () => n.inv.reload(gun));
    if (!r.ok) {
      // Out of ammo: put the gun away and fight with fists (npc::wield_better_weapon, simplified).
      n.inv.wielded = null;
      if (n.inv.stash(gun)) n.inv.wielded = gun;
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
    const d = Math.hypot(pos.x - n.x, pos.y - n.y);
    const miss = Math.abs(Math.tan(shot.spread * Math.cos(shot.azimuth)) * d);
    const r = this.foeRadius(foe);
    const aimYaw = Math.atan2(pos.x - n.x, -(pos.y - n.y)) + shot.spread * Math.cos(shot.azimuth);
    const endX = n.x + Math.sin(aimYaw) * d, endY = n.y - Math.cos(aimYaw) * d;
    this.shots.push({ x0: n.x, y0: n.y, x1: endX, y1: endY, z: n.z, t: 0.08 });
    if (miss > r * 1.4) {
      if (foe.kind === 'player') this.message(`${n.name} shoots at you and misses!`, 'c_light_red');
      return;
    }
    const mult = miss < r * 0.3 ? 1.5 : miss < r ? 1 : 0.5;
    const units = shot.damage.map((u) => ({ type: u.type, amount: u.amount * mult, armor_penetration: u.armor_penetration, armor_multiplier: 1 }));
    if (foe.kind === 'monster') {
      const m = foe.m;
      const total = Math.floor(applyFlatArmor(units, m.type.armor).reduce((s, x) => s + x.amount, 0));
      if (this.narrates(n)) this.message(`${n.name} shoots ${m.theName()}.`);
      sfx.bulletHit('flesh', m);
      m.aggroCharacter = true;
      this.monsters?.hurt(m, total, null);
      return;
    }
    const target = foe.kind === 'npc' ? foe.n : this.player;
    const bp = selectBodyPart(this.rng);
    const absorbed = target.inv.absorbHit(bp, units, this.rng);
    const res = this.muted(target, () => target.takeHit(bp, absorbed));
    if (foe.kind === 'player') {
      this.message(`${n.name} shoots you in the ${BODY_PARTS[bp].name} for ${res.damage} damage!`, 'c_red');
      this.game.events.emit('playerHurt', { amount: res.damage, bp, source: n });
      if (res.damage > 0) sfx.playerHurt(!this.player.male);
    } else {
      if (this.narrates(n)) this.message(`${n.name} shoots ${foe.n.name}.`);
      this.afterHit(foe.n, res.damage, { kind: 'npc', n });
    }
  }

  /** Bookkeeping after an NPC took damage from anything: flash, death, grudges. */
  afterHit(n: Npc, dmg: number, from: Foe | { kind: 'npc'; n: Npc }): void {
    if (dmg > 0) {
      n.hitFlash = 0.2;
      for (const f of this.onHurt) f(n, dmg);
    }
    n.checkDeath();
    if (n.dead) {
      this.died(n, from.kind === 'player' ? 'player' : null);
      return;
    }
    if (from.kind === 'player') {
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
    const items: Item[] = [...(n.inv.wielded ? [n.inv.wielded] : []), ...n.inv.worn];
    for (const it of items) map.addItem(n.tileX, n.tileY, n.z, it);
    n.inv.wielded = null;
    n.inv.worn = [];
    if (this.data.items.corpse) {
      const c = createItem(this.data, 'corpse');
      c.vars.name = `corpse of ${n.name}`;
      c.vars.npc = n.uid;
      map.addItem(n.tileX, n.tileY, n.z, c);
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

  /** attackGuard: attacking a non-hostile NPC needs a yes first (CDDA query_yn). */
  guardAttack(): boolean {
    const w = this.player.inv.wielded;
    const n = this.crosshairNpc(w?.isGun() ? 30 : w?.hasFlag('REACH_ATTACK') ? 2.2 : 1.2);
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
    const res = meleeAttack(p, { dodge: tryDodgeRoll(n) / 5, info }, this.rng, n.name);
    sfx.meleeSwing(undefined, { id: w?.typeId, skill: w ? w.meleeSkill() : 'unarmed' });
    this.lastPlayerSwing = res.cooldownSeconds;
    if (!res.hit) {
      this.afterHit(n, 0, { kind: 'player' });
      return true;
    }
    let bp = selectBodyPart(this.rng, { hitRoll: res.hitSpread });
    const units = res.damage.map((d) => ({ ...d }));
    bp = this.muted(n, () => characterDefend(n, units, bp, this.rng, true)).bp;
    const absorbed = n.inv.absorbHit(bp, units, this.rng);
    const r = n.takeHit(bp, absorbed);
    // Techniques on people: downed/stunned become effects, disarms drop the weapon.
    const o = res.outcome;
    if (o && !n.dead) {
      if (o.downTurns > 0) n.addEffect('downed', turnsToEffectSeconds(o.downTurns));
      if (o.stunTurns > 0) n.addEffect('stunned', turnsToEffectSeconds(o.stunTurns));
      if (o.disarms && n.inv.wielded) {
        const dropped = n.inv.wielded;
        n.inv.wielded = null;
        this.game.map.addItem(n.tileX, n.tileY, n.z, dropped);
        this.message(`You disarm ${n.name}!`);
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

  /** npcShot hook: first NPC on the bullet's path before `maxDist` takes the shot. */
  playerShot(yaw: number, maxDist: number, shot: ShotResult): { x: number; y: number } | null {
    const p = this.player;
    const dx = Math.sin(yaw), dy = -Math.cos(yaw);
    let best: Npc | null = null, bt = maxDist, missedBy = 1;
    for (const n of this.npcs) {
      if (n.dead || n.z !== p.z) continue;
      const ox = n.x - p.x, oy = n.y - p.y;
      const t = ox * dx + oy * dy;
      if (t <= 0 || t > bt) continue;
      const perp = Math.abs(ox * dy - oy * dx);
      if (perp > CREATURE_RADIUS) continue;
      best = n;
      bt = t;
      missedBy = perp / CREATURE_RADIUS;
    }
    if (!best) return null;
    const mult = missedBy < 0.2 ? 2 : missedBy < 0.5 ? 1.5 : missedBy < 0.8 ? 1 : 0.5;
    const units = shot.damage.map((u) => ({ type: u.type, amount: u.amount * mult, armor_penetration: u.armor_penetration, armor_multiplier: 1 }));
    const bp = selectBodyPart(this.rng);
    const r = best.takeHit(bp, best.inv.absorbHit(bp, units, this.rng));
    this.message(`You shoot ${best.name} in the ${BODY_PARTS[bp].name} for ${r.damage} damage.`);
    sfx.bulletHit('flesh', best);
    this.afterHit(best, r.damage, { kind: 'player' });
    return { x: p.x + dx * bt, y: p.y + dy * bt };
  }

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

  fromJSON(j: NpcSystemJSON): void {
    for (const n of [...this.npcs]) this.remove(n);
    for (const nj of j.npcs) {
      const n = Npc.fromJSON(this.data, nj);
      n.onMessage = null;
      this.npcs.push(n);
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

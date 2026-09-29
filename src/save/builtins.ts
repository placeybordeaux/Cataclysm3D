import type { Game } from '../game/game';
import type { MonsterSystem, CorpseRecord } from '../game/monai';
import type { Spawner } from '../game/spawner';
import type { Monster, MonEffect } from '../game/monster';
import type { CharacterJSON } from '../game/character';
import type { GameStatsJSON } from '../game/stats';
import type { Item, ItemJSON } from '../game/item';
import { Rng, hashSeed } from '../core/rng';
import { chunkKey } from '../world/coords';
import { forceWeather } from '../game/weather';
import { knownTraps } from '../game/traps';
import { registerSaveable, type LoadContext } from './registry';
import { decodeChunk, encodeChunk, Palette, paletteResolver, type ChunkJSON } from './chunks';
import { sanitizeItemJSON, type Warn } from './items';
import { installChunkTracking, type ChunkTracker } from './tracking';

// Save sections for the core systems. Each system's state is described next to its
// save/load pair; anything not listed is derived (recomputed next tick) or cosmetic.

export interface CoreSaveOptions {
  /** Monster system and spawner (src/monsters.ts installMonsters); omitted in map-only tests. */
  monsters?: { sys: MonsterSystem; spawner?: Spawner } | null;
  /** World generator: its queued z-level overlays are dropped when a save replaces the map. */
  worldgen?: { resetPending(): void } | null;
}

export function registerCoreSaveables(game: Game, opts: CoreSaveOptions = {}): ChunkTracker {
  const tracker = installChunkTracking(game);
  registerMap(game, tracker, opts);
  registerWorld(game);
  registerPlayer(game);
  if (opts.monsters) registerMonsters(game, opts.monsters.sys);
  if (opts.monsters?.spawner) {
    // Chunks generated before the save already produced their monsters (which are in the
    // save); regenerating them must not spawn a second copy.
    opts.monsters.spawner.skipChunk = (c) => tracker.priorGenerated.has(chunkKey(c.cx, c.cy, c.z));
  }
  return tracker;
}

// ------------------------------------------------------------------ map

interface MapSection {
  terrain: string[];
  furniture: string[];
  chunks: ChunkJSON[];
  /** Every chunk key ever generated ("cx,cy,z"), for the spawner and z-overlay bookkeeping. */
  generated: string[];
}

function registerMap(game: Game, tracker: ChunkTracker, opts: CoreSaveOptions): void {
  registerSaveable<MapSection>(game, 'map', {
    order: 0,
    save() {
      const map = game.map;
      const ter = new Palette(), furn = new Palette();
      const chunks: ChunkJSON[] = [];
      for (const c of map.loadedChunks()) if (tracker.isDirty(c)) chunks.push(encodeChunk(map, c, ter, furn));
      return { terrain: ter.ids, furniture: furn.ids, chunks, generated: tracker.generatedKeys() };
    },
    load(s, ctx) {
      const map = game.map;
      map.clearChunks();
      opts.worldgen?.resetPending();
      tracker.resetForLoad(s.generated ?? []);
      const ter = paletteResolver(s.terrain, (id) => map.terrain.has(id), (id) => map.terrain.index(id), 't_dirt', 'terrain', ctx.warn);
      const furn = paletteResolver(s.furniture, (id) => map.furniture.has(id), (id) => map.furniture.index(id), 'f_null', 'furniture', ctx.warn);
      for (const j of s.chunks) {
        const c = decodeChunk(ctx.data, j, ter, furn, ctx.warn);
        map.putChunk(c);
        tracker.markRestored(c);
      }
    },
  });
}

// ------------------------------------------------------------------ clock, stats, world memory

interface WorldSection {
  clock: number;
  stats: GameStatsJSON;
  overmapSeen: string[];
  /** cdda.setWeather override; generated weather is a pure function of (seed, time). */
  weatherForced: string | null;
  knownTraps: string[];
}

function registerWorld(game: Game): void {
  registerSaveable<WorldSection>(game, 'world', {
    order: 5,
    save: () => ({
      clock: game.clock.seconds,
      stats: game.stats.toJSON(),
      overmapSeen: [...game.overmapSeen],
      weatherForced: game.weather?.forced ?? null,
      knownTraps: [...knownTraps(game)],
    }),
    load(s, ctx) {
      game.clock.seconds = s.clock;
      game.clock.warp = 1;
      game.stats.load(s.stats);
      game.overmapSeen.clear();
      for (const k of s.overmapSeen) game.overmapSeen.add(k);
      if (game.weather) {
        try {
          forceWeather(game, s.weatherForced);
        } catch (e) {
          ctx.warn(`weather: ${(e as Error).message}`);
          forceWeather(game, null);
        }
      }
      const known = knownTraps(game);
      known.clear();
      for (const k of s.knownTraps ?? []) known.add(k);
    },
  });
}

// ------------------------------------------------------------------ player

interface PlayerSection {
  character: CharacterJSON;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  recoil: number;
  crouching: boolean;
}

function sanitizeCharacter(game: Game, j: CharacterJSON, warn: Warn): CharacterJSON {
  const inv = j.inventory;
  const clean = (it: ItemJSON | null) => (it ? sanitizeItemJSON(game.data, it, warn) : null);
  return {
    ...j,
    inventory: { wielded: clean(inv.wielded), worn: inv.worn.map(clean).filter((w): w is ItemJSON => !!w) },
  };
}

function registerPlayer(game: Game): void {
  registerSaveable<PlayerSection>(game, 'player', {
    order: 10,
    save() {
      const p = game.player;
      return { character: p.toJSON(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, recoil: p.recoil, crouching: p.crouching };
    },
    load(s, ctx) {
      const p = game.player;
      // Loading fires no trait/equip messages: CDDA restores silently.
      const sink = p.onMessage;
      p.onMessage = null;
      try {
        p.load(sanitizeCharacter(game, s.character, ctx.warn));
      } finally {
        p.onMessage = sink;
      }
      p.x = s.x;
      p.y = s.y;
      p.z = s.z;
      p.yaw = s.yaw;
      p.pitch = s.pitch;
      p.recoil = s.recoil;
      p.crouching = s.crouching;
      p.running = false;
    },
  });
}

// ------------------------------------------------------------------ monsters

interface MonsterJSON {
  id: string;
  x: number; y: number; z: number;
  hp: number;
  facing: number;
  anger: number;
  morale: number;
  aggro: boolean;
  friendly?: boolean;
  name?: string;
  horde?: boolean;
  effects?: [MonEffect, number][];
  attackCooldown?: number;
  busy?: number;
  /** Special attack cooldowns by special id. */
  specials?: [string, number][];
  upgradeDay: number;
  /** [x, y, seconds left] of the noise being investigated. */
  wander?: [number, number, number];
  /** [x, y, seconds ago] where the player was last seen; absent = never. */
  lastSeen?: [number, number, number];
}

interface CorpseJSON {
  /** Float position (renderer) — the item sits at the floor of it. */
  x: number; y: number; z: number;
  /** Index of the corpse item in the tile's item list. */
  idx: number;
  monId: string;
  diedAt: number;
  facing: number;
  dormant?: boolean;
}

interface MonstersSection {
  monsters: MonsterJSON[];
  corpses: CorpseJSON[];
  kills: [string, number][];
}

function monsterToJSON(m: Monster): MonsterJSON {
  const j: MonsterJSON = {
    id: m.type.id, x: m.x, y: m.y, z: m.z, hp: m.hp, facing: m.facing, anger: m.anger, morale: m.morale, aggro: m.aggroCharacter,
    upgradeDay: m.upgradeDay,
  };
  if (m.friendly) j.friendly = true;
  if (m.name) j.name = m.name;
  if (m.horde) j.horde = true;
  // 'grabbing' is tied to the grab link we don't persist (the survivor starts free).
  const eff = [...m.effects].filter(([e, t]) => t > 0 && e !== 'grabbing');
  if (eff.length) j.effects = eff;
  if (m.attackCooldown > 0) j.attackCooldown = m.attackCooldown;
  if (m.busy > 0) j.busy = m.busy;
  const sp = m.specials.filter((s) => s.cooldown > 0).map((s) => [String(s.def.id), s.cooldown] as [string, number]);
  if (sp.length) j.specials = sp;
  if (m.wanderTime > 0) j.wander = [m.wanderX, m.wanderY, m.wanderTime];
  if (Number.isFinite(m.lastSeenAge)) j.lastSeen = [m.lastSeenX, m.lastSeenY, m.lastSeenAge];
  return j;
}

function registerMonsters(game: Game, sys: MonsterSystem): void {
  registerSaveable<MonstersSection>(game, 'monsters', {
    order: 20,
    save() {
      const map = game.map;
      const corpses: CorpseJSON[] = [];
      for (const c of sys.corpses) {
        const tx = Math.floor(c.x), ty = Math.floor(c.y);
        if (!map.hasChunk(Math.floor(tx / 24), Math.floor(ty / 24), c.z)) continue;
        const idx = map.itemsAt(tx, ty, c.z).indexOf(c.item as never);
        if (idx < 0) continue;
        corpses.push({ x: c.x, y: c.y, z: c.z, idx, monId: c.monId, diedAt: c.diedAt, facing: c.facing, ...(c.dormant ? { dormant: true } : {}) });
      }
      return { monsters: sys.all.filter((m) => !m.dead).map(monsterToJSON), corpses, kills: [...sys.kills] };
    },
    load(s, ctx) {
      clearMonsters(sys);
      sys.kills.clear();
      for (const [id, n] of s.kills) sys.kills.set(id, n);
      for (const j of s.monsters) restoreMonster(game, sys, j, ctx);
      restoreCorpses(game, sys, s.corpses, ctx);
    },
    missing: () => clearMonsters(sys),
  });
}

/** Remove every monster, corpse record and projectile (listeners are told, e.g. the renderer). */
function clearMonsters(sys: MonsterSystem): void {
  sys.releaseGrab();
  for (const m of sys.all) sys.remove(m);
  for (const c of sys.corpses.splice(0)) for (const f of sys.onCorpseGone) f(c);
  sys.projectiles.length = 0;
}

function restoreMonster(game: Game, sys: MonsterSystem, j: MonsterJSON, ctx: LoadContext): void {
  const def = game.data.monsters[j.id];
  if (!def) return ctx.warn(`unknown monster "${j.id}" dropped`);
  const m = sys.spawn(def, j.x, j.y, j.z, {
    friendly: j.friendly,
    name: j.name,
    rng: new Rng(hashSeed(game.seed, Math.floor(j.x * 16), Math.floor(j.y * 16), j.z, sys.all.length, 0x10ad)),
  });
  m.hp = j.hp;
  m.horde = !!j.horde;
  m.facing = j.facing;
  m.anger = j.anger;
  m.morale = j.morale;
  m.aggroCharacter = j.aggro;
  m.upgradeDay = j.upgradeDay;
  m.effects.clear();
  for (const [e, t] of j.effects ?? []) m.effects.set(e, t);
  m.attackCooldown = j.attackCooldown ?? 0;
  m.busy = j.busy ?? 0;
  const cds = new Map(j.specials ?? []);
  for (const sp of m.specials) sp.cooldown = cds.get(String(sp.def.id)) ?? 0;
  if (j.wander) [m.wanderX, m.wanderY, m.wanderTime] = j.wander;
  if (j.lastSeen) [m.lastSeenX, m.lastSeenY, m.lastSeenAge] = j.lastSeen;
}

function restoreCorpses(game: Game, sys: MonsterSystem, list: CorpseJSON[], ctx: LoadContext): void {
  const map = game.map;
  for (const c of list) {
    const tx = Math.floor(c.x), ty = Math.floor(c.y);
    // Corpse chunks are always saved (dropping the corpse dirtied them); if not, the record is stale.
    if (!map.hasChunk(Math.floor(tx / 24), Math.floor(ty / 24), c.z)) {
      ctx.warn(`corpse of ${c.monId} at ${tx},${ty},${c.z}: its chunk wasn't saved, dropped`);
      continue;
    }
    const it = map.itemsAt(tx, ty, c.z)[c.idx] as Item | undefined;
    if (!it || it.typeId !== 'corpse') {
      ctx.warn(`corpse of ${c.monId} at ${tx},${ty},${c.z}: item missing, dropped`);
      continue;
    }
    const rec: CorpseRecord = { item: it, x: c.x, y: c.y, z: c.z, monId: c.monId, diedAt: c.diedAt, facing: c.facing, dormant: c.dormant };
    sys.corpses.push(rec);
    for (const f of sys.onCorpse) f(rec);
  }
}

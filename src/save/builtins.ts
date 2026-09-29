import type { Game } from '../game/game';
import type { MonsterSystem, CorpseRecord } from '../game/monai';
import type { Spawner } from '../game/spawner';
import { monsterToJSON, restoreMonster, type MonsterJSON } from '../game/monster_json';
import type { CharacterJSON } from '../game/character';
import type { GameStatsJSON } from '../game/stats';
import type { Item, ItemJSON } from '../game/item';
import { Rng, hashSeed } from '../core/rng';
import { chunkKey } from '../world/coords';
import { forceWeather } from '../game/weather';
import { knownTraps } from '../game/traps';
import { registerSaveable, type LoadContext } from './registry';
import { decodeChunk, encodeChunk, Palette, paletteResolver, type ChunkJSON } from './chunks';
import { sanitizeInventoryJSON, type Warn } from './items';
import { chunkTracker, installChunkTracking, type ChunkTracker } from './tracking';
import type { StashColumnJSON, StashedCorpse } from '../game/monstash';

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
  return { ...j, inventory: sanitizeInventoryJSON(game.data, j.inventory, warn) };
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
  /** Far monsters / clean-chunk dormant corpses folded into OMT columns (monstash.ts). */
  stash?: StashColumnJSON[];
}

function registerMonsters(game: Game, sys: MonsterSystem): void {
  registerSaveable<MonstersSection>(game, 'monsters', {
    order: 20,
    save() {
      const map = game.map;
      const tracker = chunkTracker(game);
      const corpses: CorpseJSON[] = [];
      const cleanDormant: StashedCorpse[] = [];
      for (const c of sys.corpses) {
        const tx = Math.floor(c.x), ty = Math.floor(c.y);
        const chunk = map.hasChunk(Math.floor(tx / 24), Math.floor(ty / 24), c.z) ? map.chunk(Math.floor(tx / 24), Math.floor(ty / 24), c.z) : null;
        if (!chunk) continue;
        const idx = map.itemsAt(tx, ty, c.z).indexOf(c.item as never);
        if (idx < 0) continue;
        // Spawner-laid dormant corpses are part of a clean chunk's baseline, and clean chunks
        // aren't saved: keep them in the stash, which lays them again when the chunk regenerates.
        if (c.dormant && tracker && !tracker.isDirty(chunk)) {
          cleanDormant.push({ monId: c.monId, x: c.x, y: c.y, z: c.z, facing: c.facing, diedAt: c.diedAt });
          continue;
        }
        corpses.push({ x: c.x, y: c.y, z: c.z, idx, monId: c.monId, diedAt: c.diedAt, facing: c.facing, ...(c.dormant ? { dormant: true } : {}) });
      }
      const stash = sys.stash.toJSON(cleanDormant);
      return { monsters: sys.all.filter((m) => !m.dead).map(monsterToJSON), corpses, kills: [...sys.kills], ...(stash.length ? { stash } : {}) };
    },
    load(s, ctx) {
      clearMonsters(sys);
      sys.kills.clear();
      for (const [id, n] of s.kills) sys.kills.set(id, n);
      for (const j of s.monsters) restoreMonster(sys, j, ctx.warn);
      restoreCorpses(game, sys, s.corpses, ctx);
      sys.stash.load(s.stash ?? []);
    },
    missing: () => clearMonsters(sys),
  });
}

/** Remove every monster, corpse record and projectile (listeners are told, e.g. the renderer). */
function clearMonsters(sys: MonsterSystem): void {
  sys.releaseGrab();
  for (const m of sys.all) sys.remove(m);
  for (const c of sys.corpses.splice(0)) for (const f of sys.onCorpseGone) f(c);
  sys.stash.clear();
  sys.projectiles.length = 0;
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

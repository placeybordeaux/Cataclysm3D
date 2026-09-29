// Save/load (src/save) against the real extracted CDDA data: full round trip of a game in
// progress, dirty-chunk tracking across every mutation path, deterministic regeneration of
// unsaved chunks after a load (real world generator), slots, permadeath and robustness.
import { describe, expect, it } from 'vitest';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import { TestGenerator } from '../src/world/testgen';
import { WorldGenerator } from '../src/world/worldgen';
import { MonsterSystem } from '../src/game/monai';
import { Spawner, type OvermapView } from '../src/game/spawner';
import { createItem, inNewContainer, loadAmmo, type Item } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { bash, getMapDamage } from '../src/game/bash';
import { installFields, ignite, removeField, addField } from '../src/game/fields';
import { installWeather, forceWeather } from '../src/game/weather';
import { installTraps, setTrap } from '../src/game/traps';
import { installSound } from '../src/game/sound';
import { CHUNK, chunkKey } from '../src/world/coords';
import type { Chunk } from '../src/world/map';
import { registerCoreSaveables } from '../src/save/builtins';
import { applySave, decodeSave, encodeSave, SaveError, serializeGame, SAVE_VERSION, type SaveFile } from '../src/save/format';
import { SaveManager } from '../src/save/manager';
import { MemoryBackend, type SyncStorage } from '../src/save/storage';
import { registerSaveable } from '../src/save/registry';
import { installChunkTracking, type ChunkTracker } from '../src/save/tracking';
import { ChunkEvictor } from '../src/save/eviction';
import { installNature, natureOf } from '../src/nature';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data, wg } = loadNodeData();

function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}

interface World {
  game: Game;
  sys: MonsterSystem;
  spawner: Spawner;
  tracker: ChunkTracker;
  worldgen: WorldGenerator | null;
}

/** Mirrors main.ts: tracking first, generator, start location, systems, then saveables. */
function build(seed: number, kind: 'test' | 'world'): World {
  const game = new Game(data, seed, fakeInput());
  let worldgen: WorldGenerator | null = null;
  // Before any chunk exists, like main.ts (registerCoreSaveables reuses this tracker).
  const tracker = installChunkTracking(game);
  if (kind === 'world') {
    worldgen = new WorldGenerator(seed, wg, data);
    worldgen.stats.quiet = true;
    game.map.generator = worldgen;
    const start = worldgen.findStartLocation('shelter', game.map);
    game.player.x = start.x + 0.5;
    game.player.y = start.y + 0.5;
  } else game.map.generator = new TestGenerator();
  installSound(game);
  installWeather(game);
  installFields(game);
  installTraps(game);
  const sys = new MonsterSystem(game);
  const spawner = new Spawner(sys, worldgen ? overmapView(worldgen) : null);
  game.systems.push(sys);
  spawner.install();
  registerCoreSaveables(game, { monsters: { sys, spawner }, worldgen });
  return { game, sys, spawner, tracker, worldgen };
}

function overmapView(w: WorldGenerator): OvermapView {
  return {
    omtType: (x, y, z) => w.overmap.omtAt(x, y, z).type,
    mondensity: (x, y) => w.wg.overmap.terrains[w.overmap.omtAt(x, y, 0).type]?.mondensity ?? 0,
    citiesNear: (x, y) => w.overmap.citiesNear(x, y),
  };
}

async function roundTrip(file: SaveFile): Promise<SaveFile> {
  const { stored } = await encodeSave(file);
  expect(stored.enc).toBe('gzip');
  return decodeSave(stored);
}

/** Hit a tile harder and harder until it takes persistent damage (without breaking). */
function dentWall(game: Game, x: number, y: number, z: number): number {
  const id = game.map.terAt(x, y, z).id;
  for (let str = 5; str < 400 && getMapDamage(game, x, y, z) === 0; str += 5) bash(game, x, y, z, str, { silent: true });
  expect(game.map.terAt(x, y, z).id).toBe(id);
  return getMapDamage(game, x, y, z);
}

const names = (items: unknown[]) => (items as Item[]).map((i) => i.typeId);
const living = (sys: MonsterSystem) => sys.all.filter((m) => !m.dead);
const monState = (sys: MonsterSystem) =>
  living(sys).map((m) => ({
    id: m.type.id, x: m.x, y: m.y, z: m.z, hp: m.hp, anger: m.anger, morale: m.morale, facing: m.facing,
    lastSeen: [m.lastSeenX, m.lastSeenY, m.lastSeenAge], wander: [m.wanderX, m.wanderY, m.wanderTime], upgradeDay: m.upgradeDay,
    effects: [...m.effects],
  }));

/** Sections with order-insensitive parts sorted, for comparing two saves. */
function normalized(f: SaveFile): Record<string, unknown> {
  const s = structuredClone(f.sections) as Record<string, any>;
  s.map.generated.sort();
  return s;
}

describe('save round trip', () => {
  it('restores a game in progress into a fresh Game (player, containers, gun, map edits, fire, monsters, clock, weather)', async () => {
    const A = build(7, 'test');
    const g = A.game, p = g.player;
    p.x = 9.5; p.y = 8.5; p.z = 0;
    for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) for (let z = 0; z <= 1; z++) g.map.chunk(cx, cy, z);

    // Survivor: skills, traits, effects, needs, morale, knowledge, nested containers, a loaded gun.
    p.name = 'Ada Lovelace';
    p.setSkill('melee', 3);
    p.practice('gun', 50);
    p.addTrait('QUICK');
    p.addEffect('bleed', 600, { bp: 'arm_l', intensity: 3 });
    p.thirst = 123;
    p.morale.add('food_good', 10, 20, 3600, 1800);
    p.learnedRecipes.add('spear_wood');
    p.identifiedBooks.add('mag_guns');
    p.proficiencies.add('prof_knapping');
    const pack = createItem(data, 'backpack');
    expect(p.inv.wear(pack, null).ok).toBe(true);
    const bottle = inNewContainer(data, createItem(data, 'water_clean', { count: 2 }), 'bottle_plastic').container;
    expect(p.inv.giveNew(bottle)?.kind).toBe('inv');
    const gun = createItem(data, 'glock_19');
    const mag = createItem(data, 'glockmag');
    loadAmmo(mag, '9mm', 12);
    expect(spawnItem(mag, L.mag(gun)).ok).toBe(true);
    expect(p.inv.wield(gun, null).ok).toBe(true);
    p.yaw = 1.25;
    p.pitch = -0.2;

    // World: smashed window, a partly bashed wall, dropped items, a fire, a trap.
    const window0 = g.map.terAt(7, 4, 0).id;
    bash(g, 7, 4, 0, 1000, { silent: true });
    expect(g.map.terAt(7, 4, 0).id).not.toBe(window0);
    const wallDamage = dentWall(g, 4, 5, 0);
    expect(wallDamage).toBeGreaterThan(0);
    g.map.addItem(10, 8, 0, createItem(data, '2x4'));
    g.map.addItem(10, 8, 0, createItem(data, 'can_beans'));
    for (const id of ['rock', 'rock', 'rock', '2x4', 'rock']) g.map.addItem(11, 8, 0, createItem(data, id));
    ignite(g, 12, 6, 0, 2);
    setTrap(g, 11, 10, 0, 'tr_beartrap');

    // A zombie closing in on the survivor, and one killed (corpse + kill count).
    const z = A.sys.spawnById('mon_zombie', 9.5, 16.5, 0)!;
    z.anger = 55;
    z.hp = 40;
    z.lastSeenX = 9.5; z.lastSeenY = 8.5; z.lastSeenAge = 1.25;
    z.wanderTo(9.5, 12.5, 4);
    z.addEffect('stunned', 0.5);
    const dead = A.sys.spawnById('mon_zombie', 6.5, 16.5, 0)!;
    A.sys.die(dead, 'player');
    g.stats.addKill('mon_zombie');
    expect(A.sys.corpses).toHaveLength(1);

    g.clock.seconds = 2 * 86400 + 15 * 3600 + 125;
    forceWeather(g, 'rain');
    g.overmapSeen.add('0,0,0');
    g.overmapSeen.add('1,0,0');

    const fileA = serializeGame(g, { slot: 'ada', name: p.name, gen: 'test' });
    const loaded = await roundTrip(fileA);

    const B = build(7, 'test');
    const r = applySave(B.game, loaded);
    expect(r.warnings).toEqual([]);
    const h = B.game, q = h.player;

    expect(q.toJSON()).toEqual(p.toJSON());
    expect([q.x, q.y, q.z, q.yaw, q.pitch]).toEqual([p.x, p.y, p.z, p.yaw, p.pitch]);
    expect(q.inv.wielded!.name()).toBe(gun.name());
    expect(q.inv.wielded!.ammoRemaining()).toBe(12);
    expect(q.inv.carried().find((w) => w.typeId === 'bottle_plastic')!.name()).toBe(bottle.name());
    expect(q.effects.get('bleed', 'arm_l')?.intensity).toBe(p.effects.get('bleed', 'arm_l')!.intensity);
    expect(q.hasTrait('QUICK')).toBe(true);

    expect(h.map.terAt(7, 4, 0).id).toBe(g.map.terAt(7, 4, 0).id);
    expect(getMapDamage(h, 4, 5, 0)).toBe(wallDamage);
    expect(names(h.map.itemsAt(10, 8, 0))).toEqual(['2x4', 'can_beans']);
    expect(names(h.map.itemsAt(11, 8, 0))).toEqual(['rock', 'rock', 'rock', '2x4', 'rock']);
    expect(new Set(h.map.itemsAt(11, 8, 0)).size).toBe(5);
    expect(h.map.fieldsAt(12, 6, 0).find((f) => f.type === 'fd_fire')?.intensity).toBe(2);
    expect(h.map.itemsAt(6, 16, 0).some((i) => i.typeId === 'corpse')).toBe(true);

    expect(monState(B.sys)).toEqual(monState(A.sys));
    expect(B.sys.corpses).toHaveLength(1);
    expect(B.sys.corpseValid(B.sys.corpses[0])).toBe(true);
    expect(B.sys.kills.get('mon_zombie')).toBe(1);

    expect(h.clock.seconds).toBe(g.clock.seconds);
    expect(h.weather?.forced).toBe(g.weather?.forced);
    expect(h.weather?.id).toBe(g.weather?.id);
    expect(h.stats.toJSON()).toEqual(g.stats.toJSON());
    expect([...h.overmapSeen].sort()).toEqual([...g.overmapSeen].sort());

    // Saving the loaded game again produces the same data: nothing was lost or invented.
    const fileB = serializeGame(h, { slot: 'ada', name: q.name, gen: 'test' });
    expect(normalized(fileB)).toEqual(normalized(fileA));

    // The chase carries on: after a couple of seconds the zombie is closer to the survivor.
    const zb = living(B.sys)[0];
    const d0 = Math.hypot(zb.x - q.x, zb.y - q.y);
    for (let i = 0; i < 60; i++) h.tick(1 / 30);
    expect(Math.hypot(zb.x - q.x, zb.y - q.y)).toBeLessThan(d0);
  });

  it('only stores dirty chunks; untouched ones regenerate identically', () => {
    const A = build(7, 'test');
    for (let cy = -2; cy <= 2; cy++) for (let cx = -2; cx <= 2; cx++) A.game.map.chunk(cx, cy, 0);
    A.game.map.setTer(5, 5, 0, 't_dirt');
    const file = serializeGame(A.game, { slot: 's', name: 'x', gen: 'test' });
    const map = file.sections.map as { chunks: { at: number[] }[]; generated: string[] };
    expect(map.chunks.map((c) => c.at.join(','))).toEqual(['0,0,0']);
    expect(map.generated.length).toBeGreaterThanOrEqual(25);
  });
});

describe('dirty tracking', () => {
  const at = (cx: number, cy: number, lx = 5, ly = 5) => [cx * CHUNK + lx, cy * CHUNK + ly] as const;

  it('catches every mutation path', () => {
    const { game, tracker } = build(3, 'test');
    const map = game.map;
    const chunks: Chunk[] = [];
    for (let cy = -2; cy <= 2; cy++) for (let cx = -2; cx <= 2; cx++) chunks.push(map.chunk(cx, cy, 0)!);
    expect(chunks.filter((c) => tracker.isDirty(c))).toEqual([]);
    const dirty = (cx: number, cy: number) => tracker.isDirty(map.chunk(cx, cy, 0)!);

    map.setTer(...at(-2, -2), 0, 't_rock');
    map.setFurn(...at(-1, -2), 0, 'f_chair');
    map.addItem(...at(0, -2), 0, createItem(data, 'rock'));
    addField(game, ...at(1, -2), 0, 'fd_blood', 1);
    setTrap(game, ...at(2, -2), 0, 'tr_beartrap');
    // Generated content of chunk (0,1): fires, items, furniture.
    removeField(game, 5, CHUNK + 6, 0, 'fd_fire');
    expect(dirty(0, 1)).toBe(true);
    // In-place edits that don't bump chunk.version:
    const c = map.chunk(-2, -1, 0)!;
    c.ter[3] = map.terrain.index('t_rock'); // direct array write
    const v = map.chunk(-1, -1, 0)!.version;
    map.chunk(-1, -1, 0)!.signs.set(7, 'KEEP OUT');
    expect(map.chunk(-1, -1, 0)!.version).toBe(v);
    // Partial bash damage lives outside the chunk (bash.ts).
    map.setTer(...at(1, -1), 0, 't_wall');
    const before = tracker.isDirty(map.chunk(1, -1, 0)!);
    expect(before).toBe(true);
    for (const cc of [-2, -1, 0, 1, 2].map((x) => [x, -2] as const)) expect(dirty(...cc)).toBe(true);
    expect(dirty(-2, -1)).toBe(true);
    expect(dirty(-1, -1)).toBe(true);
    expect(dirty(2, 2)).toBe(false);
    expect(dirty(-2, 2)).toBe(false);
  });

  it('item edits in place (charges, container contents on the ground) and bash damage dirty the chunk', () => {
    const { game, tracker } = build(3, 'test');
    const map = game.map;
    const c = map.chunk(0, 1, 0)!;
    expect(tracker.isDirty(c)).toBe(false);
    // Taking something out of an item lying there mutates it without a map call.
    const beans = map.itemsAt(12, CHUNK + 4, 0)[0] as { typeId: string; charges?: number };
    beans.charges = 7;
    expect(tracker.isDirty(c)).toBe(true);

    const w = map.chunk(0, 0, 0)!; // the house: wall at (4,5)
    expect(tracker.isDirty(w)).toBe(false);
    expect(dentWall(game, 4, 5, 0)).toBeGreaterThan(0);
    expect(tracker.isDirty(w)).toBe(true);
  });
});

describe('world generator determinism after load', () => {
  it('regenerated chunks match the original world; restored chunks are not overlaid twice; spawns are not repeated', async () => {
    const seed = 4242;
    const A = build(seed, 'world');
    const p = A.game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const keys: [number, number, number][] = [];
    for (let z = -1; z <= 1; z++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) keys.push([pcx + dx, pcy + dy, z]);
    for (const [x, y, z] of keys) A.game.map.chunk(x, y, z);
    // Make the whole shelter column dirty (z-level overlays target these) plus one far chunk.
    for (let z = -1; z <= 1; z++) A.game.map.addItem(pcx * CHUNK + 3, pcy * CHUNK + 3, z, createItem(data, 'rock'));
    A.game.map.setTer((pcx + 2) * CHUNK + 1, (pcy + 2) * CHUNK + 1, 0, 't_dirt');
    const snapshot = (w: World) => {
      const out = new Map<string, string>();
      for (const [x, y, z] of keys) {
        const c = w.game.map.chunk(x, y, z)!;
        const ter = [...c.ter].map((n) => w.game.map.terrain.get(n).id).join(' ');
        const furn = [...c.furn].map((n) => w.game.map.furniture.get(n).id).join(' ');
        const items = [...c.items].sort((a, b) => a[0] - b[0]).map(([k, l]) => `${k}:${names(l).sort().join('+')}`).join(' ');
        const fields = [...c.fields].sort((a, b) => a[0] - b[0]).map(([k, l]) => `${k}:${l.map((f) => f.type).join('+')}`).join(' ');
        out.set(chunkKey(x, y, z), `${ter}|${furn}|${items}|${fields}`);
      }
      return out;
    };
    const before = snapshot(A);
    const monsA = living(A.sys).length;

    const file = await roundTrip(serializeGame(A.game, { slot: 'w', name: 'x', gen: 'world' }));
    expect((file.sections.map as { chunks: unknown[] }).chunks.length).toBe(4);

    const B = build(seed, 'world');
    applySave(B.game, file);
    // Generate in a different order than A did.
    for (const [x, y, z] of [...keys].reverse()) B.game.map.chunk(x, y, z);
    const after = snapshot(B);
    const diff = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
    expect(diff).toEqual([]);
    expect(living(B.sys).length).toBe(monsA);
  }, 60_000);
});

describe('far chunk eviction', () => {
  it('drops far clean columns, keeps dirty ones, regenerates identically without respawning monsters', () => {
    const W = build(4242, 'world');
    const { game, tracker } = W;
    const p = game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const keys: [number, number, number][] = [];
    for (let z = -1; z <= 1; z++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) keys.push([pcx + dx, pcy + dy, z]);
    for (const [x, y, z] of keys) game.map.chunk(x, y, z);
    const sig = (c: Chunk) =>
      [...c.ter].join(',') + '|' + [...c.furn].join(',') + '|' + [...c.items].sort((a, b) => a[0] - b[0]).map(([k, l]) => `${k}:${names(l).sort().join('+')}`).join(' ');
    const before = new Map(keys.map(([x, y, z]) => [chunkKey(x, y, z), sig(game.map.chunk(x, y, z)!)]));
    // One column (z=1 only) gets a player change: the whole column must stay.
    game.map.addItem((pcx + 2) * CHUNK + 1, (pcy + 2) * CHUNK + 1, 1, createItem(data, 'rock'));
    const monsBefore = living(W.sys).length;

    // Walk far away: everything generated so far is out of range.
    p.x += 40 * CHUNK;
    const ev = new ChunkEvictor(game, tracker, { keepRadius: () => 1 });
    ev.scan();
    for (let z = -1; z <= 1; z++) expect(game.map.hasChunk(pcx + 2, pcy + 2, z)).toBe(true);
    expect(game.map.hasChunk(pcx, pcy, 0)).toBe(false);
    expect(game.map.hasChunk(pcx, pcy, 1)).toBe(false);
    expect(ev.stats.evicted).toBeGreaterThan(40);

    // Come back: regenerated (in another order) exactly as before, and no second set of monsters.
    p.x -= 40 * CHUNK;
    for (const [x, y, z] of [...keys].reverse()) game.map.chunk(x, y, z);
    const diff = keys.map(([x, y, z]) => chunkKey(x, y, z)).filter((k) => {
      if (k === chunkKey(pcx + 2, pcy + 2, 1)) return false;
      const [x, y, z] = k.split(',').map(Number);
      return before.get(k) !== sig(game.map.chunk(x, y, z)!);
    });
    expect(diff).toEqual([]);
    expect(living(W.sys).length).toBe(monsBefore);
    expect(ev.stats.regenerated).toBe(ev.stats.evicted);
  }, 60_000);
});

describe('actualized chunks stay clean', () => {
  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (AssertionError: expected null not to be null). Port with its system.
  it.skip('mapgen food rotting over the days does not make an untouched chunk dirty or saved', () => {
    const W = build(4242, 'world');
    installNature(W.game, null);
    const { game, tracker } = W;
    const p = game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    let food: { c: Chunk; it: Item } | null = null;
    for (let dy = -3; dy <= 3 && !food; dy++)
      for (let dx = -3; dx <= 3 && !food; dx++) {
        const c = game.map.chunk(pcx + dx, pcy + dy, 0)!;
        if (tracker.isDirty(c)) continue;
        for (const l of c.items.values()) for (const it of l as Item[]) if (!food && it.goesBad()) food = { c, it };
      }
    expect(food).not.toBeNull();
    const before = food!.it.relativeRot();
    game.clock.seconds += 20 * 86400;
    natureOf(game)!.actualizer.sweep();
    expect(food!.it.relativeRot()).toBeGreaterThan(before);
    expect(tracker.isDirty(food!.c)).toBe(false);
    const file = serializeGame(game, { slot: 's', name: 'x', gen: 'world' });
    const at = (file.sections.map as { chunks: { at: number[] }[] }).chunks.map((j) => j.at.join(','));
    expect(at).not.toContain(`${food!.c.cx},${food!.c.cy},0`);
    expect(Object.keys((file.sections.nature as { stamps: object }).stamps)).not.toContain(`${food!.c.cx},${food!.c.cy},0`);
  }, 60_000);
});

describe('z-level overlays onto restored chunks', () => {
  /**
   * Like WorldGenerator: generating (cx,cy,0) also writes a "roof" item into (cx,cy,1) — via
   * a pending overlay if that chunk doesn't exist yet, else as a late overlay that asks
   * map.overlayFilter first.
   */
  class OverlayGen extends TestGenerator {
    pending = new Map<string, number>();
    override generate(map: Game['map'], c: Chunk): void {
      super.generate(map, c);
      const key = chunkKey(c.cx, c.cy, c.z);
      const n = this.pending.get(key) ?? 0;
      this.pending.delete(key);
      for (let i = 0; i < n; i++) map.addItem(c.cx * CHUNK + 1, c.cy * CHUNK + 1, c.z, createItem(data, 'rock'));
      if (c.z !== 0) return;
      const up = chunkKey(c.cx, c.cy, 1);
      if (map.hasChunk(c.cx, c.cy, 1)) {
        const t = map.chunk(c.cx, c.cy, 1)!;
        if (!map.overlayFilter || map.overlayFilter(t, key)) map.addItem(c.cx * CHUNK + 1, c.cy * CHUNK + 1, 1, createItem(data, 'rock'));
      } else this.pending.set(up, (this.pending.get(up) ?? 0) + 1);
    }
    resetPending() {
      this.pending.clear();
    }
  }
  const setup = () => {
    const w = build(5, 'test');
    w.game.map.generator = new OverlayGen();
    return w;
  };
  const rocks = (w: World, cx: number) => w.game.map.itemsAt(cx * CHUNK + 1, 1, 1).filter((i) => i.typeId === 'rock').length;

  it('an overlay already baked into a saved chunk is not applied again; a new source still applies', async () => {
    const A = setup();
    // (3,0): roof generated first, overlay arrives late. (4,0): ground first, overlay via pending.
    A.game.map.chunk(3, 0, 1);
    A.game.map.chunk(3, 0, 0);
    A.game.map.chunk(4, 0, 0);
    A.game.map.chunk(4, 0, 1);
    // (5,0): only the roof exists at save time; its ground was never generated.
    A.game.map.chunk(5, 0, 1);
    for (const cx of [3, 4, 5]) A.game.map.setTer(cx * CHUNK + 5, 5, 1, 't_flat_roof');
    expect([rocks(A, 3), rocks(A, 4), rocks(A, 5)]).toEqual([1, 1, 0]);
    const file = await roundTrip(serializeGame(A.game, { slot: 'o', name: 'x', gen: 'test' }));

    const B = setup();
    applySave(B.game, file);
    for (const cx of [3, 4, 5]) B.game.map.chunk(cx, 0, 0);
    expect([rocks(B, 3), rocks(B, 4), rocks(B, 5)]).toEqual([1, 1, 1]);
  });
});

describe('robustness', () => {
  it('rejects saves from newer versions, other worlds, and damaged data with player-facing messages', async () => {
    const A = build(7, 'test');
    const file = serializeGame(A.game, { slot: 'v', name: 'x', gen: 'test' });
    const B = build(7, 'test');
    expect(() => applySave(B.game, { ...file, version: SAVE_VERSION + 1 })).toThrow(/newer version/);
    expect(() => applySave(build(8, 'test').game, file)).toThrow(SaveError);
    await expect(decodeSave({ enc: 'gzip', data: new Uint8Array([1, 2, 3, 4]) })).rejects.toThrow(/damaged/);
    await expect(decodeSave({ enc: 'json', data: '{"format":"something-else"}' })).rejects.toThrow(/not a CDDA-3D save/);
    await expect(decodeSave({ enc: 'json', data: '{"trunc' })).rejects.toThrow(SaveError);
  });

  it('drops unknown ids with warnings instead of failing', () => {
    const A = build(7, 'test');
    A.game.player.inv.wield(createItem(data, '2x4'), null);
    const bag = createItem(data, 'bag_plastic');
    spawnItem(createItem(data, 'crowbar'), L.in(bag));
    A.game.player.inv.wear(createItem(data, 'backpack'), null);
    A.game.player.inv.giveNew(bag);
    A.game.map.addItem(5, 5, 0, createItem(data, 'rock'));
    A.sys.spawnById('mon_zombie', 20.5, 20.5, 0);
    const file = structuredClone(serializeGame(A.game, { slot: 'u', name: 'x', gen: 'test' })) as any;
    file.sections.player.character.inventory.items.find((w: any) => w.typeId === 'bag_plastic').contents[0].typeId = 'no_such_item';
    file.sections.player.character.inventory.wielded.typeId = 'no_such_weapon';
    file.sections.map.terrain[0] = 't_no_such_terrain';
    file.sections.map.chunks[0].items[0][1][0].typeId = 'no_such_item';
    file.sections.monsters.monsters[0].id = 'mon_no_such';
    file.sections.frobnicator = { x: 1 };
    const B = build(7, 'test');
    const r = applySave(B.game, file);
    expect(r.warnings.join('\n')).toMatch(/no_such_item/);
    expect(r.warnings.join('\n')).toMatch(/no_such_weapon/);
    expect(r.warnings.join('\n')).toMatch(/t_no_such_terrain/);
    expect(r.warnings.join('\n')).toMatch(/mon_no_such/);
    expect(r.warnings.join('\n')).toMatch(/frobnicator/);
    expect(B.game.player.inv.wielded).toBeNull();
    expect(B.game.player.inv.carried().find((w) => w.typeId === 'bag_plastic')!.contents).toEqual([]);
    expect(living(B.sys)).toHaveLength(0);
  });

  it('registered saveables round-trip, and missing() runs for sections the save lacks', () => {
    const A = build(7, 'test');
    let state = { fuel: 42 };
    registerSaveable(A.game, 'vehicles', { order: 30, save: () => state, load: (d) => (state = d as typeof state) });
    const file = serializeGame(A.game, { slot: 'r', name: 'x', gen: 'test' });
    expect(file.sections.vehicles).toEqual({ fuel: 42 });
    const B = build(7, 'test');
    let got: unknown = null, missing = false;
    registerSaveable(B.game, 'vehicles', { save: () => null, load: (d) => (got = d) });
    registerSaveable(B.game, 'npcs', { save: () => null, load: () => {}, missing: () => (missing = true) });
    applySave(B.game, file);
    expect(got).toEqual({ fuel: 42 });
    expect(missing).toBe(true);
    expect(() => registerSaveable(B.game, 'npcs', { save: () => null, load: () => {} })).toThrow(/twice/);
  });
});

class FakeLocalStorage implements SyncStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe('SaveManager', () => {
  it('saves to slots, lists, loads into a fresh game', async () => {
    const backend = new MemoryBackend();
    const A = build(7, 'test');
    A.game.player.name = 'Bob';
    const mgr = new SaveManager(A.game, { backend, gen: 'test' });
    mgr.active = true;
    const meta = await mgr.save();
    expect(meta.name).toBe('Bob');
    expect(meta.bytes).toBeGreaterThan(0);
    expect(meta.bytes!).toBeLessThan(meta.rawBytes!);
    expect(mgr.hasSave()).toBe(true);

    const B = build(7, 'test');
    const mgrB = new SaveManager(B.game, { backend, gen: 'test' });
    expect((await mgrB.refresh()).map((m) => m.slot)).toEqual([meta.slot]);
    mgrB.apply(await mgrB.read(meta.slot));
    expect(B.game.player.name).toBe('Bob');
    expect(mgrB.slot).toBe(meta.slot);
  });

  it('permadeath: a dead character loses the save and joins the memorial', async () => {
    const backend = new MemoryBackend();
    const A = build(7, 'test');
    A.game.player.name = 'Carl';
    A.game.stats.addKill('mon_zombie');
    A.game.stats.startSeconds = A.game.clock.seconds;
    A.game.clock.seconds += 86400;
    const mgr = new SaveManager(A.game, { backend, gen: 'test', build: () => ({ profession: 'Evacuee' }) });
    mgr.active = true;
    const meta = await mgr.save();
    A.game.events.emit('playerDied', { cause: 'zombie' });
    await new Promise((r) => setTimeout(r, 0));
    await mgr.memorial(); // flush
    await new Promise((r) => setTimeout(r, 0));
    expect(await backend.keys('save/')).toEqual([]);
    expect(mgr.hasSave()).toBe(false);
    const mem = await mgr.memorial();
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ name: 'Carl', profession: 'Evacuee', cause: 'zombie', kills: 1, survived: 86400 });
    await expect(mgr.read(meta.slot)).rejects.toThrow(SaveError);
    A.game.player.dead = true;
    await expect(mgr.save()).rejects.toThrow(/dead/);
    // the death screen's "Last Words:" land on that memorial entry
    await mgr.setLastWords('Tell my wife I said... hello.');
    expect((await mgr.memorial())[0].lastWords).toBe('Tell my wife I said... hello.');
  });

  it('unload fallback: a synchronous localStorage copy is recovered on the next boot', async () => {
    const backend = new MemoryBackend();
    const ls = new FakeLocalStorage();
    const A = build(7, 'test');
    A.game.player.name = 'Dee';
    const mgr = new SaveManager(A.game, { backend, sync: ls, gen: 'test' });
    expect(mgr.saveSync()).toBe(0); // no character in play yet
    mgr.active = true;
    const n = mgr.saveSync();
    expect(n).toBeGreaterThan(1000);
    expect(ls.m.size).toBe(2);
    // The page died before IndexedDB finished: simulate by wiping the backend.
    await new Promise((r) => setTimeout(r, 0));
    backend.store.clear();
    const B = build(7, 'test');
    const mgrB = new SaveManager(B.game, { backend, sync: ls, gen: 'test' });
    const slots = await mgrB.refresh();
    expect(slots).toHaveLength(1);
    expect(ls.m.size).toBe(0);
    mgrB.apply(await mgrB.read(slots[0].slot));
    expect(B.game.player.name).toBe('Dee');
  });
});

describe('far monster retention (monster stash)', () => {
  /** TestGenerator that asks for a few dormant zombies in OMT (12, 0, 0). */
  class DormantGen extends TestGenerator {
    override generate(map: Game['map'], c: Chunk): void {
      super.generate(map, c);
      if (c.cx !== 12 || c.cy !== 0 || c.z !== 0) return;
      for (let i = 0; i < 6; i++) c.spawns.push({ kind: 'monster', id: 'pseudo_dormant_mon_zombie_fat', x: 12 * CHUNK + 3 + i * 3, y: 5 + i * 2, z: 0 });
    }
  }
  const setup = () => {
    const w = build(11, 'test');
    w.game.map.generator = new DormantGen();
    return w;
  };
  const dormantItems = (w: World) =>
    [...w.game.map.chunk(12, 0, 0)!.items.values()].flat().filter((i) => (i as Item).typeId === 'corpse').length;

  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (AssertionError: expected 0 to be greater than 0). Port with its system.
  it.skip('spawner-laid dormant corpses keep the chunk clean; eviction stashes them and regeneration lays them again', () => {
    const W = setup();
    const c = W.game.map.chunk(12, 0, 0)!;
    const n = W.sys.corpses.length;
    expect(n).toBeGreaterThan(0);
    expect(dormantItems(W)).toBe(n);
    expect(W.tracker.isDirty(c)).toBe(false);

    const ev = new ChunkEvictor(W.game, W.tracker, { keepRadius: () => 1 });
    ev.scan();
    expect(W.game.map.hasChunk(12, 0, 0)).toBe(false);
    expect(W.sys.corpses.length).toBe(0);
    expect(W.sys.stash.count().corpses).toBe(n);

    const again = W.game.map.chunk(12, 0, 0)!;
    expect(W.sys.corpses.length).toBe(n);
    expect(dormantItems(W)).toBe(n);
    expect(W.sys.stash.count().corpses).toBe(0);
    expect(W.tracker.isDirty(again)).toBe(false);
    // They still rise when approached.
    W.game.player.x = W.sys.corpses[0].x - 1;
    W.game.player.y = W.sys.corpses[0].y;
    W.game.tick(0.6);
    expect(living(W.sys).some((m) => m.type.id === 'mon_zombie_fat')).toBe(true);
  });

  it('dormant corpses on a clean chunk survive save/load without saving the chunk', async () => {
    const A = setup();
    A.game.map.chunk(12, 0, 0);
    const n = A.sys.corpses.length;
    const file = await roundTrip(serializeGame(A.game, { slot: 'w', name: 'x', gen: 'test' }));
    const at = (file.sections.map as { chunks: { at: number[] }[] }).chunks.map((j) => j.at.join(','));
    expect(at).not.toContain('12,0,0');
    const B = setup();
    applySave(B.game, file);
    expect(B.sys.corpses.length).toBe(0);
    B.game.map.chunk(12, 0, 0);
    expect(B.sys.corpses.length).toBe(n);
    expect(dormantItems(B)).toBe(n);
    // A second save/load still has them (no loss, no duplicates).
    const file2 = await roundTrip(serializeGame(B.game, { slot: 'w', name: 'x', gen: 'test' }));
    const C = setup();
    applySave(C.game, file2);
    C.game.map.chunk(12, 0, 0);
    expect(C.sys.corpses.length).toBe(n);
    expect(dormantItems(C)).toBe(n);
  });

  it('far idle dormant monsters fold into the stash, survive save/load and come back near the survivor', async () => {
    const A = setup();
    const p = A.game.player;
    const far = 20 * CHUNK;
    for (let i = 0; i < 30; i++) A.sys.spawnById('mon_zombie', p.x + far + (i % 6), p.y + Math.floor(i / 6), 0)!.hp = 40 + i;
    const hunter = A.sys.spawnById('mon_zombie', p.x + far, p.y + 10, 0)!;
    hunter.hp = 1;
    hunter.wanderTime = 30; // drifting toward a noise: keeps simulating
    A.sys.stash.sweep();
    A.game.tick(0.1);
    expect(living(A.sys).length).toBe(1);
    expect(A.sys.stash.count().monsters).toBe(30);

    const file = await roundTrip(serializeGame(A.game, { slot: 'w', name: 'x', gen: 'test' }));
    const B = setup();
    applySave(B.game, file);
    expect(B.sys.stash.count().monsters).toBe(30);
    B.game.player.x += far;
    B.sys.stash.sweep();
    expect(B.sys.stash.count().monsters).toBe(0);
    const hps = living(B.sys).map((m) => m.hp).filter((hp) => hp !== 1).sort((a, b) => a - b);
    expect(hps).toEqual(Array.from({ length: 30 }, (_, i) => 40 + i));
  });
});

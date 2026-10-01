// "No non-flying monster on a tile without a floor": placement is valid by construction
// (src/game/standing.ts) on every path — mapgen/overmap spawns over generated city chunks up to
// each column's top, debug spawns, stash restore, and the settle pass for dormant strays.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Input } from '../src/core/input';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { MonsterSystem } from '../src/game/monai';
import { Spawner } from '../src/game/spawner';
import { canStandAt, standingSpot, type StandMap } from '../src/game/standing';
import { VisibleLevels } from '../src/world/levels';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { WorldGenerator } from '../src/world/worldgen';
import type { WorldgenData } from '../src/world/worldgen_data';
import { loadNodeData } from '../tools/lib/node_data';

let data: GameData;
let wg: WorldgenData;
beforeAll(() => {
  ({ game: data, wg } = loadNodeData());
});

const fakeInput = () => ({ held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] }) as unknown as Input;

const unsupported = (game: Game, sys: MonsterSystem) =>
  sys.all.filter((m) => !m.dead && !m.has('FLIES') && !game.map.hasFloor(m.tileX, m.tileY, m.z)).map((m) => `${m.type.id}@${m.tileX},${m.tileY},${m.z}`);

/** z0 dirt; z1 a 6x6 floor slab at (8..13, 8..13) of every chunk, open air around it; rock below. */
class SlabGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    const T = (id: string) => map.terrain.index(id);
    c.ter.fill(c.z === 0 ? T('t_dirt') : c.z > 0 ? T('t_open_air') : T('t_rock'));
    if (c.z === 1) for (let y = 8; y < 14; y++) for (let x = 8; x < 14; x++) c.ter[y * 24 + x] = T('t_floor');
    c.empty = false;
  }
}

function slabWorld() {
  const game = new Game(data, 3, fakeInput());
  game.map.generator = new SlabGen();
  game.player.x = 200.5;
  game.player.y = 200.5;
  for (let y = 0; y <= 1; y++) for (let x = 0; x <= 1; x++) for (let z = 0; z <= 2; z++) game.map.chunk(x, y, z);
  const sys = new MonsterSystem(game);
  return { game, sys };
}

describe('standing.ts', () => {
  it('a fake map: same level within the OMT first, then straight down through air, else nowhere', () => {
    // floor only at (5,5,1) and everywhere at z0; a wall at (30,30,0)
    const map: StandMap = {
      passable: (x, y, z) => !(x === 30 && y === 30 && z === 0),
      hasFloor: (x, y, z) => z === 0 || (z === 1 && x === 5 && y === 5),
      hasChunk: () => true,
    };
    const walker = { flags: [] };
    expect(canStandAt(map, walker, 2, 2, 1)).toBe(false);
    expect(canStandAt(map, { flags: ['FLIES'] }, 2, 2, 1)).toBe(true);
    expect(standingSpot(map, walker, 2, 2, 1)).toEqual({ x: 5, y: 5, z: 1 });
    // (30, 30) is in the next OMT: (5, 5) is out of reach, so it drops, onto a wall: nowhere
    expect(standingSpot(map, walker, 30, 30, 1)).toBe(null);
    expect(standingSpot(map, walker, 31, 30, 1)).toEqual({ x: 31, y: 30, z: 0 });
  });

  it('MonsterSystem.spawn puts a walker asked onto open air on the nearest floor; a flyer stays', () => {
    const { game, sys } = slabWorld();
    const z = sys.spawnById('mon_zombie', 2.5, 2.5, 1)!;
    expect([z.tileX, z.tileY, z.z]).toEqual([8, 8, 1]);
    const out = sys.spawnById('mon_zombie', 30.5, 30.5, 2)!;
    // 2 levels of air above the next chunk's slab... (30,30) is outside (8..13): it drops to z0
    expect(game.map.hasFloor(out.tileX, out.tileY, out.z)).toBe(true);
    const bird = Object.values(data.monsters).find((d) => d.flags.includes('FLIES'))!;
    const b = sys.spawn(bird, 2.5, 2.5, 2);
    expect(b.z).toBe(2);
    expect(unsupported(game, sys)).toEqual([]);
  });

  it('a dormant monster on open air (an old save, a stash) settles without falling damage', () => {
    const { game, sys } = slabWorld();
    const m = sys.spawnById('mon_zombie', 10.5, 10.5, 1)!;
    // what a save made before the fix holds: a zombie in the air beside the slab
    m.x = 3.5;
    m.y = 3.5;
    expect(m.dormant).toBe(true);
    const hp = m.hp;
    expect(sys.settleDormant()).toBe(1);
    expect(game.map.hasFloor(m.tileX, m.tileY, m.z)).toBe(true);
    expect(m.hp).toBe(hp);
  });

  it('dormant horde drift stops at the edge of a floor instead of walking out over the street', () => {
    const { game, sys } = slabWorld();
    const m = sys.spawnById('mon_zombie', 12.5, 10.5, 1)!;
    m.wanderTo(40, 10.5, 600);
    for (let i = 0; i < 60; i++) (sys as unknown as { driftDormant(dt: number): void }).driftDormant(1);
    expect(game.map.hasFloor(m.tileX, m.tileY, m.z)).toBe(true);
    expect(m.wanderTime).toBe(0);
  });

  it('stash restore never lands a monster in the air', () => {
    const { game, sys } = slabWorld();
    const m = sys.spawnById('mon_zombie', 10.5, 10.5, 1)!;
    m.x = 3.5; // as if saved there
    sys.stash.stashRadius = 0;
    game.player.x = 2000;
    sys.stash.sweep();
    expect(sys.all.filter((x) => !x.dead).length).toBe(0);
    game.player.x = 12.5;
    game.player.y = 12.5;
    sys.stash.stashRadius = 7;
    sys.stash.sweep();
    expect(sys.all.filter((x) => !x.dead).length).toBe(1);
    expect(unsupported(game, sys)).toEqual([]);
  });
});

describe('real city: every generated level up to each column\'s top', () => {
  it('no non-flying monster stands on a tile without a floor after spawning (seed 443226190, apartment towers)', () => {
    const seed = 443226190;
    const game = new Game(data, seed, fakeInput());
    const gen = new WorldGenerator(seed, wg, data);
    gen.stats.quiet = true;
    game.map.generator = gen;
    const start = gen.findStartLocation('shelter', game.map);
    const city = gen.overmap.citiesNear(start.omx, start.omy).sort((a, b) => Math.hypot(a.x - start.omx, a.y - start.omy) - Math.hypot(b.x - start.omx, b.y - start.omy))[0];
    // the user's report: towers whose static spawns ("spawns": GROUP_ZOMBIE 8-10 per storey)
    // rolled onto the open air beside their upper storeys
    let tower: [number, number] | null = null;
    for (let r = 0; r < 12 && !tower; r++)
      for (let dy = -r; dy <= r && !tower; dy++)
        for (let dx = -r; dx <= r && !tower; dx++)
          if (gen.overmap.omtAt(city.x + dx, city.y + dy, 3).type.startsWith('apartments_con_tower')) tower = [city.x + dx, city.y + dy];
    expect(tower).not.toBe(null);
    game.player.x = tower![0] * 24 + 12;
    game.player.y = tower![1] * 24 + 12;
    const sys = new MonsterSystem(game);
    new Spawner(sys, {
      omtType: (x, y, z) => gen.overmap.omtAt(x, y, z).type,
      mondensity: (x, y) => gen.wg.overmap.terrains[gen.overmap.omtAt(x, y, 0).type]?.mondensity ?? 0,
      citiesNear: (x, y) => gen.overmap.citiesNear(x, y),
    }).install();
    const lv = new VisibleLevels(gen.overmap);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = tower![0] + dx, cy = tower![1] + dy;
        for (let z = -1; z <= lv.columnTop(cx, cy); z++) game.map.chunk(cx, cy, z);
      }
    const above = sys.all.filter((m) => m.z > 0).length;
    expect(above).toBeGreaterThan(10); // the towers' storeys are populated, as in BN
    expect(unsupported(game, sys)).toEqual([]);
  }, 120_000);
});

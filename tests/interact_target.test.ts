// What `e` acts on when a person stands at furniture (playtest: facing a refugee-center beggar
// with a bench between, `e` opened the Bench menu and the prompt said "Examine bench"). People
// are picked by their drawn body (targeting.ts personOnRay: an upright cylinder on their spot,
// not their tile's column) and win over anything they stand in front of or behind, unless
// something drawn hides them; interact() and interactionPrompt() ask the same aimedCreature().
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem } from '../src/game/npcai';
import type { Npc, NpcData } from '../src/game/npc';
import { aimedCreature, creatureTargets, interact, interactionPrompt, patchInteractUi } from '../src/game/interact';
import { personOnRay, playerViewRay, rayCylinder, targetTile } from '../src/game/targeting';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let nd: NpcData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: load('recipes.json'), misc: load('misc.json'),
  };
  nd = load('npcs.json');
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_floor') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

// The refugee-center lobby as found: you at (12, 14) facing north, a bench at (12, 13), the
// beggar behind it at (12, 12).
function world() {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
  const game = new Game(data, 5, input);
  game.map.generator = new FlatGen();
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) game.map.chunk(x, y, 0);
  const npcs = new NpcSystem(game, nd, new MonsterSystem(game));
  const p = game.player;
  p.x = 12.5;
  p.y = 14.5;
  p.yaw = 0;
  p.pitch = 0;
  game.map.setFurn(12, 13, 0, 'f_bench');
  const n = npcs.spawn({ template: 'refugee_beggar1' }, 12, 12, 0)!;
  n.x = 12.5;
  n.y = 12.5;
  // npcs.ts's hook, minus the renderer (the player's own view ray stands in for the camera).
  const talked: Npc[] = [];
  const hook = () => {
    const hit = personOnRay(game, npcs.npcs, playerViewRay(game), 3);
    if (!hit || hit.body.isEnemy()) return null;
    const b = hit.body;
    return { name: b.displayName(), dist: hit.t, label: `Talk to ${b.displayName()}`, run: () => talked.push(b), x: b.tileX, y: b.tileY, z: b.z, creature: b };
  };
  creatureTargets.length = 0;
  creatureTargets.push(hook);
  game.keys.register('world_menu', 'context menu', () => {});
  const menus: string[] = [];
  patchInteractUi({ menu: (title) => menus.push(title) });
  return { game, npcs, n, talked, menus };
}

describe('rayCylinder', () => {
  it('meets an upright body in front, misses beside and above it', () => {
    const o = { x: 0, y: 0, h: 1.6 };
    expect(rayCylinder(o, { x: 0, y: -1, h: 0 }, 0, -2, 0)).toBeCloseTo(1.6);
    expect(rayCylinder(o, { x: 0, y: -1, h: 0 }, 0.5, -2, 0)).toBeNull();
    // aimed over a short person's head still means them (pick height 1.9 m), not well above
    expect(rayCylinder(o, { x: 0, y: -1, h: 0.1 }, 0, -2, 0)).not.toBeNull();
    expect(rayCylinder(o, { x: 0, y: -1, h: 0.5 }, 0, -2, 0)).toBeNull();
    // behind the viewer: never
    expect(rayCylinder(o, { x: 0, y: 1, h: 0 }, 0, -2, 0)).toBeNull();
  });
});

describe('`e` with someone standing at a bench', () => {
  it('the beggar behind a knee-high bench is who `e` talks to, and the prompt says so', () => {
    const { game, n, talked, menus } = world();
    // the old tile march still finds the bench first: that is what used to win
    expect(targetTile(game)).toMatchObject({ x: 12, y: 13 });
    expect(aimedCreature(game)?.creature).toBe(n);
    expect(interactionPrompt(game)).toBe(`[e] Talk to ${n.displayName()}  [o] More…`);
    expect(interact(game)).toBe(true);
    expect(talked).toEqual([n]);
    expect(menus).toEqual([]);
  });

  it('looking down at the bench means the bench', () => {
    const { game, talked, menus } = world();
    game.player.pitch = -0.6;
    expect(aimedCreature(game)).toBeNull();
    expect(interactionPrompt(game)).toMatch(/^\[e\] .*bench/i);
    interact(game);
    expect(talked).toEqual([]);
    expect(menus).toEqual(['Bench']);
  });

  it('picks the drawn body, not the tile: someone walking across a tile edge, someone beside the crosshair', () => {
    const { game, n } = world();
    // drawn 0.15 m into the next tile east, crosshair on them: still them
    n.x = 13.15;
    game.player.yaw = Math.atan2(n.x - game.player.x, -(n.y - game.player.y));
    expect(aimedCreature(game)?.creature).toBe(n);
    // in the crosshair's tile but drawn 0.9 m to its side: the bench, not them
    n.x = 12.05;
    game.player.x = 12.95;
    game.player.yaw = 0;
    expect(aimedCreature(game)).toBeNull();
    expect(interactionPrompt(game)).toMatch(/bench/i);
  });

  it('a counter in front hides them where the crosshair is on it (box furniture is drawn solid)', () => {
    const { game, n } = world();
    game.map.setFurn(12, 13, 0, 'f_counter');
    // over the counter top: them; on its front: the counter
    game.player.pitch = -0.25;
    expect(aimedCreature(game)?.creature).toBe(n);
    game.player.pitch = -0.45;
    expect(aimedCreature(game)).toBeNull();
    expect(interactionPrompt(game)).not.toMatch(/Talk/);
  });

  it('a hostile in front hides whoever stands behind; out of reach is no one', () => {
    const { game, npcs, n } = world();
    const foe = npcs.spawn({ template: 'refugee_beggar2' }, 12, 13, 0)!;
    foe.x = 12.5;
    foe.y = 13.4;
    foe.attitude = 'KILL';
    expect(foe.isEnemy()).toBe(true);
    expect(aimedCreature(game)).toBeNull();
    foe.dead = true;
    expect(aimedCreature(game)?.creature).toBe(n);
    n.y = 9.5;
    expect(aimedCreature(game)).toBeNull();
  });

  it('an explicit tile (cdda.interact(x, y)) is about that tile', () => {
    const { game, talked, menus } = world();
    interact(game, { x: 12, y: 13, z: 0, dist: 1 });
    expect(talked).toEqual([]);
    expect(menus).toEqual(['Bench']);
  });
});

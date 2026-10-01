import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { aimHooks, aimSettings, bodyHeightOf, topAimHeight } from '../src/game/aimmodel';

// Top-down aim (src/game/playercombat.ts topAim): the facing is the aim, height is chosen
// (centre mass, the head while aiming, level at nothing), an optional cone assist.

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
});
afterEach(() => {
  aimHooks.topView = null;
  aimSettings.topAssist = false;
});

class Flat implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function world() {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
  const game = new Game(data, 9, input as unknown as Input);
  game.map.generator = new Flat();
  const p = game.player;
  p.x = 40.5;
  p.y = 40.5;
  p.yaw = 0;
  p.pitch = -1; // looking down from the top view: the shot must not care
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  aimHooks.topView = () => ({ eye: { x: p.x, y: p.y, h: 1.6 } });
  const gun = createItem(data, 'glock_19');
  spawnItem(createItem(data, 'glockmag', { ammo: '9mm' }), L.mag(gun));
  p.inv.wield(gun, null);
  const z = sys.spawnById('mon_zombie', p.x, p.y - 10, 0)!;
  z.hp = 100000;
  z.addEffect('stunned', 1000);
  return { game, sys, combat, input, z };
}

describe('top-view aim', () => {
  it('the facing aims: centre mass of the body on the line, whatever the (invisible) pitch', () => {
    const { combat, z } = world();
    const t = combat.topAim(0, 30);
    expect(t.target).toBe(z);
    expect(t.head).toBe(false);
    const hit = combat.castAim(t.yaw, t.pitch, 30, undefined, t.o);
    expect(hit.hit).toBe(z);
    expect(hit.h).toBeCloseTo(topAimHeight(bodyHeightOf(z), false), 1);
    expect(hit.zone).toBe('torso');
  });

  it('aiming (RMB) aims at the head', () => {
    const { combat, input, z } = world();
    input.mouseButtons = 4;
    const t = combat.topAim(0, 30);
    expect(t.head).toBe(true);
    expect(combat.castAim(t.yaw, t.pitch, 30, undefined, t.o).zone).toBe('head');
    void z;
  });

  it('at nothing the ray is level', () => {
    const { game, combat } = world();
    game.player.yaw = Math.PI / 2;
    const t = combat.topAim(0, 30);
    expect(t.target).toBeNull();
    expect(t.pitch).toBe(0);
  });

  it('a shot along the facing hits; turned away it misses', () => {
    const { game, combat, z } = world();
    let hp = z.hp;
    combat.aim.markShown(0, 0, performance.now());
    combat.fire();
    expect(z.hp).toBeLessThan(hp);
    hp = z.hp;
    game.player.yaw = 0.3;
    combat.cooldown = 0;
    combat.aim.markShown(0, 0, performance.now());
    combat.fire();
    expect(z.hp).toBe(hp);
  });

  it('the cone assist (off by default) takes a hostile just off the line', () => {
    const { game, combat, z } = world();
    game.player.yaw = (8 * Math.PI) / 180;
    expect(combat.topAim(0, 30).target).toBeNull();
    aimSettings.topAssist = true;
    expect(combat.topAim(0, 30).target).toBe(z);
  });
});

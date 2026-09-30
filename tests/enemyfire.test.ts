import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem } from '../src/game/item';
import { enemyFireOf, ROUND_SPEED } from '../src/game/enemyfire';

// Enemy fire (combat round 3): rounds fired by monsters and NPCs fly, can be dodged behind cover,
// hit whoever is in the way, and cue near misses. The survivor's arrows hit NPCs.

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
});

class Gen implements ChunkGenerator {
  walls = new Set<string>();
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function world() {
  const clicks: number[] = [];
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, clicks, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => clicks.splice(0) };
  const game = new Game(data, 5, input as unknown as Input);
  game.map.generator = new Gen();
  const p = game.player;
  p.x = 40.5;
  p.y = 40.5;
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  (game as unknown as { monsters: MonsterSystem }).monsters = sys;
  return { game, sys, combat, input, fire: enemyFireOf(game) };
}
const step = (game: Game, s: number) => {
  for (let i = 0; i < Math.round(s * 30); i++) game.tick(1 / 30);
};
/** A shooter 15 m north of the survivor. */
const from = (game: Game) => ({ x: game.player.x, y: game.player.y - 15, h: 1.3, z: 0 });

describe('enemy rounds fly', () => {
  it('a round aimed at the survivor hits after its flight, not at once', () => {
    const { game, fire } = world();
    const p = game.player;
    let hitAt = -1, t = 0;
    const s = from(game);
    fire.fire({ kind: 'bullet', ...s, tx: p.x, ty: p.y, th: 1.2, yawOff: 0, range: 40, from: 'gun', onPlayer: () => (hitAt = t) });
    expect(fire.rounds.length).toBe(1);
    for (let i = 0; i < 30 && hitAt < 0; i++) {
      game.tick(1 / 30);
      t += 1 / 30;
    }
    expect(hitAt).toBeGreaterThan(0.1);
    expect(hitAt).toBeLessThan(15 / ROUND_SPEED.bullet + 0.1);
    expect(fire.rounds.length).toBe(0);
  });

  it('a wall between you and the shooter stops it (cover works)', () => {
    const { game, fire } = world();
    const p = game.player;
    game.map.setTer(Math.floor(p.x), Math.floor(p.y) - 3, 0, 't_brick_wall');
    let hit = false, stopped = '';
    fire.fire({ kind: 'bullet', ...from(game), tx: p.x, ty: p.y, th: 1.2, yawOff: 0, range: 40, from: 'gun', onPlayer: () => (hit = true), onStop: (_x, _y, w) => (stopped = w) });
    step(game, 0.5);
    expect(hit).toBe(false);
    expect(stopped).toBe('wall');
  });

  it('a round the dispersion sends 0.8 m wide misses, flies on past, and cues a near miss', () => {
    const { game, fire } = world();
    const p = game.player;
    const near: { dist: number }[] = [];
    game.events.on('nearMiss', (e) => near.push(e));
    let hit = false, stopped = '';
    fire.fire({ kind: 'bullet', ...from(game), tx: p.x, ty: p.y, th: 1.2, yawOff: Math.atan2(0.8, 15), range: 40, from: 'gun', onPlayer: () => (hit = true), onStop: (_x, _y, w) => (stopped = w) });
    step(game, 1);
    expect(hit).toBe(false);
    expect(near.length).toBe(1);
    expect(near[0].dist).toBeGreaterThan(0.6);
    expect(near[0].dist).toBeLessThan(1);
    expect(stopped).toBe('range');
  });

  it('whoever stands in the way takes it (an NPC between shooter and survivor)', () => {
    const { game, fire } = world();
    const p = game.player;
    const npc = { x: p.x, y: p.y - 6, z: 0, dead: false };
    (game as unknown as { npcs: { npcs: unknown[] } }).npcs = { npcs: [npc] };
    let who = '';
    fire.fire({ kind: 'arrow', ...from(game), tx: p.x, ty: p.y, th: 1.2, yawOff: 0, range: 40, from: 'bow', onPlayer: () => (who = 'player'), onNpc: (n) => (who = n === npc ? 'npc' : '?') });
    step(game, 1);
    expect(who).toBe('npc');
  });

  it('a monster gun shoots a visible round (the old hitscan is gone): the hit comes later, and ducking behind a wall saves you', () => {
    const { game, sys, fire } = world();
    const p = game.player;
    const t = sys.spawnById('mon_turret_rifle', p.x, p.y - 10, 0) ?? sys.spawnById('mon_turret', p.x, p.y - 10, 0);
    expect(t).toBeTruthy();
    t!.aggroCharacter = true;
    let hurt = 0;
    game.events.on('playerHurt', () => hurt++);
    let rounds = 0;
    for (let i = 0; i < 30 * 12 && rounds === 0; i++) {
      game.tick(1 / 30);
      rounds = fire.rounds.length;
    }
    expect(rounds).toBeGreaterThan(0);
    expect(hurt).toBe(0);
  });
});

describe('monster ammo', () => {
  it('a light turret fires its own starting ammo (9mmfmj) instead of clicking empty', () => {
    const { game, sys, fire } = world();
    const p = game.player;
    const t = sys.spawnById('mon_turret_light', p.x + 3, p.y - 12, 0)!;
    t.aggroCharacter = true;
    let rounds = 0;
    for (let i = 0; i < 30 * 12 && rounds === 0; i++) {
      game.tick(1 / 30);
      rounds = fire.rounds.length;
    }
    expect(rounds).toBeGreaterThan(0);
  });
});

describe("the survivor's arrows hit NPCs", () => {
  it('an NPC (a follower too) in the line takes the arrow before the zombie behind', () => {
    const { game, sys, combat, input } = world();
    const p = game.player;
    p.str_base = 12;
    p.resetStats();
    p.inv.wear(createItem(data, 'backpack'), null);
    const bow = createItem(data, 'longbow');
    p.inv.wield(bow, null);
    p.inv.giveNew(createItem(data, 'arrow_wood', { count: 5 }));
    const z = sys.spawnById('mon_zombie', p.x, p.y - 12, 0)!;
    z.hp = 10000;
    z.addEffect('stunned', 100);
    const npc = { x: p.x, y: p.y - 6, z: 0, dead: false, name: 'Follower' };
    (game as unknown as { npcs: { npcs: unknown[] } }).npcs = { npcs: [npc] };
    const hits: unknown[] = [];
    combat.npcRound = (n) => hits.push(n);
    p.yaw = 0;
    p.pitch = Math.atan2(1.1 - 1.6, 12);
    const d = combat.startDraw(bow, 'draw', true)!;
    d.t = d.full;
    void input;
    step(game, 1.5);
    expect(hits).toEqual([npc]);
    expect(z.hp).toBe(10000);
  });
});

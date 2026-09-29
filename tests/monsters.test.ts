// Monsters & combat against the real extracted CDDA data: AI decisions, spawning
// determinism, damage/death, special attacks, player attacks and butchery yields.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem, ambientLight } from '../src/game/monai';
import { Spawner } from '../src/game/spawner';
import { PlayerCombat, meleeVerb } from '../src/game/playercombat';
import { butcherSeconds, butcherYield, yieldMult } from '../src/game/butchery';
import { createItem, type Item } from '../src/game/item';
import { findPath } from '../src/game/pathfind';
import { Grid, hasLOS } from '../src/game/los';
import { nextUpgradeDay, turnsToEffectSeconds } from '../src/game/monster';
import { evalCondition, fmt } from '../src/game/monattack';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'),
    furniture: load('furniture.json'),
    items: load('items.json'),
    itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'),
    monsterGroups: load('monster_groups.json'),
    recipes: [],
    misc: load('misc.json'),
  };
});

/** Open dirt everywhere; tests draw walls with map.setTer. */
class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}

function world(seed = 7): { game: Game; sys: MonsterSystem; combat: PlayerCombat; msgs: string[] } {
  const game = new Game(data, seed, fakeInput());
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  game.clock.seconds = 12 * 3600; // noon
  const msgs: string[] = [];
  game.events.on('message', (m) => msgs.push(m.text));
  return { game, sys, combat, msgs };
}

const step = (game: Game, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) game.tick(1 / 30);
};
const hpTotal = (game: Game) => Object.values(game.player.hp).reduce((s, h) => s + h.cur, 0);

describe('monster AI', () => {
  it('a zombie 5 tiles away sees the survivor, closes in and hurts them', () => {
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 12.5, 7.5, 0)!;
    const hp0 = hpTotal(game);
    step(game, 5);
    expect(z.seesPlayer).toBe(true);
    expect(sys.distToPlayer(z)).toBeLessThan(1.5);
    expect(hpTotal(game)).toBeLessThan(hp0);
  });

  it('zombies move at CDDA speed: speed 70 on flat ground ~ 2.1 tiles/s', () => {
    const { game, sys } = world();
    game.player.x = 40.5;
    const z = sys.spawnById('mon_zombie_tough', 12.5, 12.5, 0)!;
    z.type = { ...z.type, flags: z.type.flags.filter((f) => f !== 'STUMBLES') };
    const x0 = z.x;
    step(game, 2);
    const v = (z.x - x0) / 2;
    expect(v).toBeGreaterThan(z.type.speed / 100 * 3 * 0.85);
    expect(v).toBeLessThan(z.type.speed / 100 * 3 * 1.05);
  });

  it('a gunshot out of sight draws a zombie toward the noise', () => {
    const { game, sys } = world();
    // Wall between survivor and zombie so it can't see; the shot is loud enough to hear.
    for (let y = -20; y <= 40; y++) game.map.setTer(20, y, 0, 't_wall');
    const z = sys.spawnById('mon_zombie', 30.5, 12.5, 0)!;
    step(game, 0.5);
    expect(z.seesPlayer).toBe(false);
    game.events.emit('sound', { x: 12, y: 12, z: 0, volume: 60, description: 'BANG!' });
    expect(z.wanderTime).toBeGreaterThan(0);
    expect(Math.abs(z.wanderX - 12)).toBeLessThanOrEqual(1);
    const d0 = Math.hypot(z.x - 12, z.y - 12);
    step(game, 3);
    // Blocked by the wall it paths around (A*), always getting closer to the noise.
    expect(Math.hypot(z.x - 12, z.y - 12)).toBeLessThan(d0);
  });

  it('dormant monsters far away drift toward loud noises (horde behaviour)', () => {
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 12.5 + 70, 12.5, 0)!;
    step(game, 0.6);
    expect(z.dormant).toBe(true);
    game.events.emit('sound', { x: 12, y: 12, z: 0, volume: 80, description: 'BANG!' });
    const x0 = z.x;
    step(game, 3);
    expect(z.x).toBeLessThan(x0);
  });

  it('a rabbit flees from a nearby survivor', () => {
    const { game, sys } = world();
    const r = sys.spawnById('mon_rabbit', 15.5, 12.5, 0)!;
    expect(r.attitude()).toBe('flee');
    const d0 = sys.distToPlayer(r);
    step(game, 2);
    expect(sys.distToPlayer(r)).toBeGreaterThan(d0 + 2);
  });

  it('a dog ignores the survivor until hurt, then its pack turns on them', () => {
    const { game, sys } = world();
    const a = sys.spawnById('mon_dog', 16.5, 12.5, 0)!;
    const b = sys.spawnById('mon_dog', 17.5, 13.5, 0)!;
    step(game, 0.3);
    expect(a.attitude()).toBe('ignore');
    for (let i = 0; i < 3; i++) sys.hurt(a, 5, 'player');
    expect(a.anger).toBeGreaterThan(a.type.aggression);
    expect(b.anger).toBeGreaterThan(b.type.aggression);
  });

  it('night vision range is much shorter than daylight; a flashlight gives it back', () => {
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 12.5, 2.5, 0)!;
    game.clock.seconds = 2 * 3600;
    step(game, 0.4);
    expect(z.seesPlayer).toBe(false);
    sys.playerLight = () => 60;
    step(game, 0.4);
    expect(z.seesPlayer).toBe(true);
    expect(ambientLight(12)).toBe(100);
    expect(ambientLight(0)).toBeLessThan(10);
  });

  it('monsters evolve on their upgrade day', () => {
    const rng = new Rng(3);
    const d = nextUpgradeDay(data.monsters.mon_zombie, rng);
    expect(d).toBeGreaterThanOrEqual(1);
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 20.5, 20.5, 0)!;
    z.upgradeDay = 0;
    game.clock.seconds += 86400;
    step(game, 0.1);
    game.tick(1 / 30);
    // upgrade check runs every 600 game seconds; force a few ticks of game time
    for (let i = 0; i < 40; i++) game.tick(1);
    expect(z.type.id).not.toBe('mon_zombie');
  });
});

describe('pathing & line of sight', () => {
  it('A* routes around a wall and LOS is blocked by it', () => {
    const { game } = world();
    for (let y = 5; y <= 20; y++) game.map.setTer(15, y, 0, 't_wall');
    const grid = new Grid(game.map);
    expect(hasLOS(grid, 10, 12, 20, 12, 0)).toBe(false);
    expect(hasLOS(grid, 10, 12, 10, 2, 0)).toBe(true);
    const res = findPath(grid, 10, 12, 20, 12, 0);
    expect(res.complete).toBe(true);
    expect(res.tiles.every(([x, y]) => !(x === 15 && y >= 5 && y <= 20))).toBe(true);
    expect(res.tiles.at(-1)).toEqual([20, 12]);
  });

  it('never generates chunks while pathing', () => {
    const { game } = world();
    const grid = new Grid(game.map);
    const res = findPath(grid, 12, 12, 400, 12, 0, { maxNodes: 300 });
    expect(res.complete).toBe(false);
    expect(game.map.hasChunk(16, 0, 0)).toBe(false);
  });
});

describe('spawning', () => {
  function spawnSet(seed: number) {
    const { game, sys } = world(seed);
    const sp = new Spawner(sys, null, { safeRadius: 0 });
    const c = game.map.chunk(1, 1, 0)!;
    c.spawns = [
      { kind: 'group', id: 'GROUP_VANILLA', x: 36, y: 36, z: 0, area: [24, 24, 47, 47], count: 4 },
      { kind: 'monster', id: 'mon_dog', x: 30, y: 30, z: 0, count: 2 },
    ];
    sp.onChunk(c);
    return { ids: sys.all.map((m) => `${m.type.id}@${m.tileX},${m.tileY}`), chunk: c };
  }

  it('is deterministic per world seed and consumes spawn points', () => {
    const a = spawnSet(11), b = spawnSet(11);
    expect(a.ids).toEqual(b.ids);
    expect(a.ids.filter((s) => s.startsWith('mon_dog')).length).toBe(2);
    expect(a.ids.length).toBeGreaterThanOrEqual(4);
    expect(a.chunk.spawns.length).toBe(0);
  });

  it('place_monsters density scales the number of rolls (density * rng(10, 50))', () => {
    const { game, sys } = world(5);
    const sp = new Spawner(sys, null, { safeRadius: 0 });
    const c = game.map.chunk(-2, -2, 0)!;
    c.spawns = [{ kind: 'group', id: 'GROUP_ZOMBIE', x: -48, y: -48, z: 0, area: [-48, -48, -25, -25], density: 0.5 }];
    sp.onChunk(c);
    expect(sys.all.length).toBeGreaterThanOrEqual(3);
    expect(sys.all.length).toBeLessThanOrEqual(40);
  });

  it('keeps hostiles away from the survivor when a chunk generates next to them', () => {
    const { game, sys } = world(5);
    const sp = new Spawner(sys, null, { safeRadius: 10 });
    const c = game.map.chunk(0, 0, 0)!;
    c.spawns = [{ kind: 'monster', id: 'mon_zombie', x: 13, y: 13, z: 0, count: 3 }];
    sp.onChunk(c);
    expect(sys.all.length).toBe(0);
  });

  it('dormant zombies lie as corpses and rise when approached', () => {
    const { game, sys } = world(5);
    const sp = new Spawner(sys, null, { safeRadius: 0 });
    const c = game.map.chunk(1, 0, 0)!;
    c.spawns = [{ kind: 'monster', id: 'pseudo_dormant_mon_zombie_fat', x: 30, y: 12, z: 0 }];
    sp.onChunk(c);
    expect(sys.all.length).toBe(0);
    expect(sys.corpses.length).toBe(1);
    game.player.x = 28.5;
    step(game, 0.6);
    expect(sys.all.map((m) => m.type.id)).toEqual(['mon_zombie_fat']);
  });
});

describe('damage & death', () => {
  it('killing a zombie drops a corpse item, blood, counts the kill', () => {
    const { game, sys, msgs } = world();
    const z = sys.spawnById('mon_zombie', 13.5, 12.5, 0)!;
    step(game, 0.3);
    sys.hurt(z, 30, 'player');
    expect(z.hp).toBe(50);
    expect(game.map.fieldsAt(z.tileX, z.tileY, 0).length + game.map.fieldsAt(z.tileX - 1, z.tileY, 0).length + game.map.fieldsAt(z.tileX + 1, z.tileY, 0).length).toBeGreaterThanOrEqual(0);
    sys.hurt(z, 60, 'player');
    expect(z.dead).toBe(true);
    const items = game.map.itemsAt(13, 12, 0) as Item[];
    const corpse = items.find((i) => i.typeId === 'corpse');
    expect(corpse?.vars.corpse).toBe('mon_zombie');
    expect(game.map.fieldsAt(13, 12, 0).some((f) => f.type === 'fd_blood')).toBe(true);
    expect(sys.kills.get('mon_zombie')).toBe(1);
    expect(msgs).toContain('The zombie dies!');
    step(game, 0.1);
    expect(sys.all.includes(z)).toBe(false);
  });

  it('massive overkill gibs the body (no corpse)', () => {
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 14.5, 12.5, 0)!;
    sys.hurt(z, 500, 'player');
    expect((game.map.itemsAt(14, 12, 0) as Item[]).some((i) => i.typeId === 'corpse')).toBe(false);
  });

  it('boomers burst into bile', () => {
    const { game, sys } = world();
    const b = sys.spawnById('mon_boomer', 13.5, 12.5, 0)!;
    sys.hurt(b, 45, 'player');
    expect(game.map.fieldsAt(13, 12, 0).some((f) => f.type === 'fd_bile')).toBe(true);
    expect(game.player.hasEffect('boomered')).toBe(true);
  });

  it('a necromancer raises a nearby zombie corpse', () => {
    const { game, sys } = world();
    game.player.x = 60.5;
    const z = sys.spawnById('mon_zombie', 20.5, 20.5, 0)!;
    sys.die(z, null);
    expect(sys.corpses.length).toBe(1);
    const n = sys.spawnById('mon_zombie_necro', 24.5, 20.5, 0)!;
    n.aggroCharacter = true;
    // It only raises while hunting; give it a target in view.
    game.player.x = 30.5;
    game.player.y = 20.5;
    step(game, 2);
    expect(sys.all.some((m) => m.type.id === 'mon_zombie' && !m.dead)).toBe(true);
  });
});

describe('special attacks', () => {
  it('formats CDDA attack messages and evaluates grab conditions', () => {
    expect(fmt('%1$s grabs your %2$s!', 'The zombie', 'left arm')).toBe('The zombie grabs your left arm!');
    expect(fmt('%s lunges at you, but you dodge!', 'The zombie')).toBe('The zombie lunges at you, but you dodge!');
    const { sys } = world();
    const z = sys.spawnById('mon_zombie', 13.5, 12.5, 0)!;
    const bite = z.specials.find((s) => s.def.id === 'bite_humanoid')!;
    expect(evalCondition(sys, z, bite.def.condition)).toBe(false);
    z.addEffect('grabbing', 10);
    sys.game.player.addEffect('grabbed', 100);
    expect(evalCondition(sys, z, bite.def.condition)).toBe(true);
  });

  it('a shrieker shrieks (loud sound event) when the survivor is close', () => {
    const { game, sys } = world();
    const sounds: number[] = [];
    game.events.on('sound', (s) => sounds.push(s.volume));
    sys.spawnById('mon_zombie_shrieker', 15.5, 12.5, 0);
    step(game, 6);
    expect(sounds).toContain(50);
  });

  it('a hulk smash knocks the survivor back', () => {
    const { game, sys, msgs } = world();
    const h = sys.spawnById('mon_zombie_hulk', 13.6, 12.5, 0)!;
    for (const s of h.specials) s.cooldown = s.def.id === 'smash' ? 0 : 999;
    // Keep swinging until one lands (a dodge is possible), then check the survivor flew.
    let x0 = game.player.x;
    for (let i = 0; i < 20 && !msgs.some((m) => m.includes('hurls you')); i++) {
      x0 = game.player.x;
      h.specials.find((s) => s.def.id === 'smash')!.cooldown = 0;
      h.attackCooldown = 0;
      h.busy = 0;
      game.tick(1 / 30);
    }
    expect(msgs.some((m) => m.includes('hurls you'))).toBe(true);
    expect(Math.abs(game.player.x - x0)).toBeGreaterThan(0.5);
    expect(game.player.hasEffect('downed')).toBe(true);
  });

  it('grabbed survivors are held in place until they break free', () => {
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 13.4, 12.5, 0)!;
    step(game, 0.1);
    for (const s of z.specials) s.cooldown = 999;
    sys.grabbedBy = z;
    z.addEffect('grabbing', 100);
    game.player.addEffect('grabbed', 1000);
    // Weak survivor: str/dex 1 means the break-free roll rarely succeeds.
    game.player.str_base = 1;
    game.player.dex_base = 1;
    game.player.resetStats();
    const input = game.input as unknown as { held: Set<string> };
    input.held.add('KeyA');
    game.player.yaw = 0;
    step(game, 0.3);
    input.held.delete('KeyA');
    expect(game.player.x).toBeGreaterThan(12.0);
  });

  it('a zombie hunter leaps at the survivor', () => {
    const { game, sys } = world();
    const h = sys.spawnById('mon_zombie_hunter', 12.5, 9.3, 0)!;
    for (const s of h.specials) s.cooldown = s.def.id === 'leap' ? 0 : 999;
    let leapt = false;
    for (let i = 0; i < 30 && !leapt; i++) {
      game.tick(1 / 30);
      leapt = h.dashTime > 0;
    }
    expect(leapt).toBe(true);
  });

  it('converts CDDA turn durations for player effects', () => {
    expect(turnsToEffectSeconds(3)).toBe(24);
  });
});

describe('player attacks', () => {
  it('melee targets the monster in front, not the one behind', () => {
    const { game, sys, combat } = world();
    const front = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
    const behind = sys.spawnById('mon_zombie', 12.5, 13.6, 0)!;
    game.player.yaw = 0; // north
    step(game, 0.05);
    expect(combat.meleeTarget()).toBe(front);
    game.player.yaw = Math.PI;
    expect(combat.meleeTarget()).toBe(behind);
    game.player.yaw = Math.PI / 2;
    expect(combat.meleeTarget()).toBe(null);
  });

  it('a baseball bat kills a zombie and leaves a corpse', () => {
    const { game, sys, combat } = world(3);
    game.player.inv.wield(createItem(data, 'bat'));
    const z = sys.spawnById('mon_zombie', 12.5, 11.3, 0)!;
    game.player.yaw = 0;
    let swings = 0;
    for (let i = 0; i < 30 * 60 && !z.dead; i++) {
      game.player.yaw = Math.atan2(z.x - game.player.x, -(z.y - game.player.y));
      if (combat.cooldown <= 0) {
        combat.melee();
        swings++;
      }
      game.tick(1 / 30);
    }
    expect(z.dead).toBe(true);
    expect(swings).toBeGreaterThan(2);
    expect(game.map.itemsAt(z.tileX, z.tileY, 0).some((i) => i.typeId === 'corpse')).toBe(true);
    expect(game.player.getSkill('bashing')).toBeGreaterThanOrEqual(0);
  });

  it('bullets hit the first monster on the ray and stop at walls', () => {
    const { game, sys, combat } = world(4);
    const gun = createItem(data, 'glock_19');
    gun.magazineWell()!.insert(createItem(data, 'glockmag', { ammo: '9mm' }));
    game.player.inv.wield(gun);
    game.player.recoil = 0;
    game.player.setSkill('gun', 10);
    game.player.setSkill('pistol', 10);
    const z = sys.spawnById('mon_zombie', 12.5, 6.5, 0)!;
    game.player.yaw = 0;
    const r = combat.castRay(0, 30);
    expect(r.hit).toBe(z);
    game.map.setTer(12, 9, 0, 't_wall');
    expect(combat.castRay(0, 30).hit).toBe(null);
    game.map.setTer(12, 9, 0, 't_dirt');
    const before = gun.ammoRemaining();
    const sounds: number[] = [];
    game.events.on('sound', (s) => sounds.push(s.volume));
    combat.fire();
    expect(gun.ammoRemaining()).toBe(before - 1);
    expect(sounds.some((v) => v > 20)).toBe(true);
  });

  it('thrown items fly, hurt the monster they hit and land on the map', () => {
    const { game, sys, combat } = world(8);
    const z = sys.spawnById('mon_zombie', 12.5, 8.5, 0)!;
    const rock = createItem(data, 'rock');
    game.player.inv.wield(rock);
    game.player.yaw = 0;
    game.player.dex_base = 20;
    game.player.setSkill('throw', 10);
    game.player.resetStats();
    expect(combat.throwItem()).toBe(true);
    expect(game.player.inv.wielded).toBe(null);
    step(game, 0.5);
    expect(z.hp).toBeLessThan(z.hpMax);
    const landed = [7, 8, 9, 10, 11].some((y) => game.map.itemsAt(12, y, 0).includes(rock as any));
    expect(landed).toBe(true);
  });

  it('uses CDDA melee verbs', () => {
    expect(meleeVerb('bash', 5, () => 0)).toBe('hit');
    expect(meleeVerb('bash', 15, () => 0)).toBe('whack');
    expect(meleeVerb('cut', 12, () => 0)).toBe('cut');
    expect(meleeVerb('stab', 25, () => 0)).toBe('puncture');
  });
});

describe('butchery', () => {
  it('time follows butcher_time_to_cut (size x tool quality, quick vs full)', () => {
    const z = data.monsters.mon_zombie;
    expect(butcherSeconds(z, 30, 'quick')).toBe(Math.round((2700 * 70 * 2.4) / 100));
    expect(butcherSeconds(z, 30, 'full')).toBeGreaterThan(butcherSeconds(z, 30, 'quick'));
    expect(butcherSeconds(data.monsters.mon_rabbit, 30, 'quick')).toBeLessThan(butcherSeconds(z, 30, 'quick'));
  });

  it('deer yields meat, bones and more with full butchery and more skill', () => {
    const { game } = world();
    const c = game.player;
    const deer = data.monsters.mon_deer;
    const count = (items: Item[], id: string) => items.filter((i) => i.typeId === id).reduce((s, i) => s + Math.max(1, i.charges || 1), 0);
    const quick = butcherYield(data, c, deer, 30, 'quick', new Rng(1));
    const full = butcherYield(data, c, deer, 30, 'full', new Rng(1));
    expect(quick.ok && full.ok).toBe(true);
    expect(count(full.items, 'meat')).toBeGreaterThan(count(quick.items, 'meat'));
    expect(count(full.items, 'bone')).toBeGreaterThan(0);
    c.setSkill('survival', 8);
    const skilled = butcherYield(data, c, deer, 30, 'full', new Rng(1));
    expect(count(skilled.items, 'meat')).toBeGreaterThan(count(full.items, 'meat'));
    expect(yieldMult(8, 8, 30)).toBeGreaterThan(yieldMult(0, 8, 30));
  });

  it('zombies give tainted meat; harvest-exempt monsters give nothing', () => {
    const { game } = world();
    const z = butcherYield(data, game.player, data.monsters.mon_zombie, 30, 'full', new Rng(2));
    expect(z.items.some((i) => i.typeId === 'meat_tainted_human')).toBe(true);
    const b = butcherYield(data, game.player, data.monsters.mon_boomer, 30, 'full', new Rng(2));
    expect(b.ok).toBe(false);
  });
});

// Monsters & combat against the real extracted CDDA data: AI decisions, spawning
// determinism, damage/death, special attacks, player attacks and butchery yields.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { MELEE_SCALE } from '../src/core/time';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem, ambientLight, hordeSignal } from '../src/game/monai';
import { Spawner, densityCount } from '../src/game/spawner';
import { PlayerCombat, meleeVerb } from '../src/game/playercombat';
import { butcherSeconds, butcherYield, yieldMult } from '../src/game/butchery';
import { createItem, type Item } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { findPath } from '../src/game/pathfind';
import { Grid, hasLOS } from '../src/game/los';
import { nextUpgradeDay, turnsToEffectSeconds } from '../src/game/monster';
import { biteInfection, dodgeCheck, fmt, isMeleeSpecial, trySpecial } from '../src/game/monattack';
import { FEEL, setFeelDifficulty, telegraphSeconds } from '../src/game/combatfeel';
import { installAchievements } from '../src/achievements';
import { monsterFactionAttitude } from '../src/game/monfaction';

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

  it('an adjacent zombie attacks at its speed on the melee clock; grabs/bites share that budget', () => {
    // Classic keeps CDDA's swing rate: the zombie's tell fits inside its 100-move swing.
    setFeelDifficulty('classic');
    try {
      const { game, sys, msgs } = world();
      const z = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
      for (const k of Object.keys(game.player.hp)) game.player.hp[k as keyof typeof game.player.hp].max = game.player.hp[k as keyof typeof game.player.hp].cur = 100000;
      step(game, 20);
      const attacks = msgs.filter((m) => /^The zombie (hits|bites|claws|grabs|gropes|misses|lunges|tries)/.test(m)).length;
      const expected = (z.type.speed / 100) * MELEE_SCALE * 20;
      expect(telegraphSeconds(z.speed, 'melee') + FEEL.monsterRecovery).toBeLessThan(1 / ((z.type.speed / 100) * MELEE_SCALE));
      expect(attacks).toBeGreaterThan(expected * 0.7);
      expect(attacks).toBeLessThan(expected * 1.15);
    } finally {
      setFeelDifficulty('accessible');
    }
  });

  it('Accessible stretches a monster swing to fit its tell plus a recovery beat', () => {
    const { game, sys, msgs } = world();
    const z = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
    for (const k of Object.keys(game.player.hp)) game.player.hp[k as keyof typeof game.player.hp].max = game.player.hp[k as keyof typeof game.player.hp].cur = 100000;
    step(game, 20);
    const attacks = msgs.filter((m) => /^The zombie (hits|bites|claws|grabs|gropes|misses|lunges|tries)/.test(m)).length;
    const cycle = Math.max(1 / ((z.type.speed / 100) * MELEE_SCALE), telegraphSeconds(z.speed, 'melee') + FEEL.monsterRecovery);
    expect(attacks).toBeGreaterThan((20 / cycle) * 0.7);
    expect(attacks).toBeLessThan((20 / cycle) * 1.15);
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

  it('zombies smash through a closed door to reach a noise (bash.ts)', () => {
    const { game, sys } = world(9);
    // 5x5 room around the survivor with a door on the east wall.
    for (let y = 10; y <= 14; y++) for (let x = 10; x <= 14; x++) if (x === 10 || x === 14 || y === 10 || y === 14) game.map.setTer(x, y, 0, 't_wall');
    game.map.setTer(14, 12, 0, 't_door_c');
    for (let i = 0; i < 4; i++) sys.spawnById('mon_zombie', 17.5, 11.5 + i * 0.5, 0);
    let broke = false;
    for (let t = 0; t < 90 && !broke; t++) {
      game.events.emit('sound', { x: 12, y: 12, z: 0, volume: 20, description: 'a scream' });
      step(game, 1);
      broke = game.map.terAt(14, 12, 0).id !== 't_door_c';
    }
    expect(broke).toBe(true);
  });

  it('dormant horde members far away drift toward loud noises; lone unloaded zombies stay put', () => {
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 12.5 + 70, 12.5, 0)!;
    const loner = sys.spawnById('mon_zombie', 12.5 - 70, 12.5, 0)!;
    z.horde = true;
    step(game, 0.6);
    expect(z.dormant).toBe(true);
    game.events.emit('sound', { x: 12, y: 12, z: 0, volume: 80, description: 'BANG!' });
    const x0 = z.x, l0 = loner.x;
    step(game, 3);
    expect(z.x).toBeLessThan(x0);
    expect(loner.x).toBe(l0);
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
    // BN: half_life 14 x MONSTER_UPGRADE_FACTOR 2, EVOLVE_MAX_ITERS 5 -> within 1 + 5 x 28 days, 1/32 never
    let never = 0;
    for (let i = 0; i < 3200; i++) {
      const u = nextUpgradeDay(data.monsters.mon_zombie, rng);
      if (u < 0) never++;
      else expect(u).toBeLessThanOrEqual(1 + 5 * 28);
    }
    expect(never / 3200).toBeCloseTo(1 / 32, 1);
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
    const sp = new Spawner(sys, null, { safeRadius: 0, realtimeScale: 1 });
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
    const sp = new Spawner(sys, null, { safeRadius: 0, realtimeScale: 1 });
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

  it('dormant zombie corpses rise when approached (no BN data uses GEN_DORMANT; mechanism kept)', () => {
    const { game, sys } = world(5);
    sys.placeCorpse(data.monsters.mon_zombie_fat, 30.5, 12.5, 0, { dormant: true });
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

  it('boomers burst into bile (BN death_function ["BOOMER"]: no corpse)', () => {
    const { game, sys } = world();
    const b = sys.spawnById('mon_boomer', 13.5, 12.5, 0)!;
    sys.hurt(b, 45, 'player');
    expect(game.map.fieldsAt(13, 12, 0).some((f) => f.type === 'fd_bile')).toBe(true);
    // propagate_field(fd_bile, 15): the bile spreads beyond the boomer's own tile
    let tiles = 0;
    for (let y = 8; y <= 16; y++) for (let x = 9; x <= 17; x++) if (game.map.fieldsAt(x, y, 0).some((f) => f.type === 'fd_bile')) tiles++;
    expect(tiles).toBeGreaterThanOrEqual(9);
    expect(game.player.hasEffect('boomered')).toBe(true);
    expect((game.map.itemsAt(13, 12, 0) as Item[]).some((i) => i.typeId === 'corpse')).toBe(false);
    expect(sys.kills.get('mon_boomer')).toBe(1);
  });

  it('robots leave their broken item (BROKEN), acid zombies leak acid (ACID + NORMAL)', () => {
    const { game, sys } = world();
    game.player.x = 40.5;
    const bot = Object.values(data.monsters).find((d) => d.death_function?.includes('BROKEN') && data.items['broken_' + d.id.replace(/^mon_/, '')])!;
    const r = sys.spawnById(bot.id, 13.5, 12.5, 0)!;
    sys.hurt(r, r.hp + 1, 'player');
    expect((game.map.itemsAt(13, 12, 0) as Item[]).some((i) => i.typeId === 'broken_' + bot.id.replace(/^mon_/, ''))).toBe(true);
    const acidic = sys.spawnById('mon_zombie_acidic', 20.5, 12.5, 0)!;
    expect(acidic.type.death_function).toEqual(expect.arrayContaining(['ACID', 'NORMAL']));
    sys.hurt(acidic, acidic.hp + 1, 'player');
    expect(game.map.fieldsAt(20, 12, 0).some((f) => f.type === 'fd_acid')).toBe(true);
    expect((game.map.itemsAt(20, 12, 0) as Item[]).some((i) => i.typeId === 'corpse')).toBe(true);
  });

  it('corpses carry the implants their harvest hides (make_mon_corpse)', () => {
    const { game, sys } = world();
    game.player.x = 40.5;
    const z = sys.spawnById('mon_zombie', 13.5, 12.5, 0)!;
    sys.hurt(z, 81, 'player');
    const corpse = (game.map.itemsAt(13, 12, 0) as Item[]).find((i) => i.typeId === 'corpse')!;
    expect(JSON.parse(String(corpse.vars.dissectables))).toEqual([expect.objectContaining({ id: 'pheromone' })]);
  });

  it('a necromancer raises a nearby zombie corpse', () => {
    const { game, sys, msgs } = world();
    game.player.x = 60.5;
    const z = sys.spawnById('mon_zombie', 20.5, 20.5, 0)!;
    sys.die(z, null);
    expect(sys.corpses.length).toBe(1);
    const n = sys.spawnById('mon_zombie_necro', 24.5, 20.5, 0)!;
    n.aggroCharacter = true;
    // It only raises while hunting; give it a target in view.
    game.player.x = 30.5;
    game.player.y = 20.5;
    // BN resurrect: a turn of charging ("throws its arms wide") before the corpse rises.
    step(game, 4);
    expect(msgs).toContain('The zombie necromancer throws its arms wide.');
    expect(sys.all.some((m) => m.type.id === 'mon_zombie' && !m.dead)).toBe(true);
  });
});

describe('monster factions (BN monfaction.cpp)', () => {
  it('combines explicit and rolled bash before applying armor once', () => {
    const { sys } = world();
    const a = sys.spawnById('mon_zombie', 18.5, 12.5, 0)!;
    const b = sys.spawnById('mon_zombie', 19.5, 12.5, 0)!;
    a.type = { ...a.type, melee_skill: 100, melee_damage: [{ damage_type: 'bash', amount: 10 }], melee_dice: 10, melee_dice_sides: 1 };
    b.type = { ...b.type, dodge: 0, armor: { ...b.type.armor, bash: 15 } };
    const hp = b.hp;
    (sys as unknown as { meleeMonster(attacker: typeof a, victim: typeof b): void }).meleeMonster(a, b);
    expect(hp - b.hp).toBe(5);
  });

  it('monster kills retain source and do not award survivor kills or achievements', async () => {
    const { game, sys } = world();
    const achievements = await installAchievements(game, null, undefined, load('achievements.json'));
    achievements.begin(false);
    game.events.on('creatureDied', (e) => { if (e.killer === game.player) game.stats.addKill((e.creature as { type: { id: string } }).type.id); });
    const a = sys.spawnById('mon_zombie', 18.5, 12.5, 0)!;
    const b = sys.spawnById('mon_zombie', 19.5, 12.5, 0)!;
    const deaths: unknown[] = [];
    game.events.on('creatureDied', (e) => deaths.push(e.killer));
    sys.hurt(b, b.hp + 1, a);
    expect(b.dead).toBe(true);
    expect(deaths).toEqual([a]);
    expect(sys.kills.size).toBe(0);
    expect(game.stats.totalKills()).toBe(0);
    expect(achievements.tracker.value('num_avatar_kills')).toBe(0);
    expect(achievements.tracker.completion('achievement_kill_zombie')).toBe('pending');
  });

  it('wild wasps attack their hated bee faction independently of the player', () => {
    const { game, sys } = world(11);
    const wasp = sys.spawnById('mon_wasp', 24.5, 12.5, 0)!;
    const bee = sys.spawnById('mon_bee', 25.5, 12.5, 0)!;
    const hp = bee.hp;
    step(game, 0.8);
    expect(sys.monsterTargets.get(wasp)?.uid).toBe(bee.uid);
    expect(bee.hp).toBeLessThan(hp);
  });
  it('a friendly dog attacks a visible zombie without hurting the survivor', () => {
    const { game, sys } = world(22);
    const dog = sys.spawnById('mon_dog', 18.5, 12.5, 0)!;
    const zombie = sys.spawnById('mon_zombie', 19.5, 12.5, 0)!;
    dog.friendly = true;
    const hp = zombie.hp, playerHp = hpTotal(game);
    step(game, 1.5);
    expect(sys.monsterTargets.get(dog)).toBe(zombie);
    expect(zombie.hp).toBeLessThan(hp);
    expect(hpTotal(game)).toBe(playerHp);
  });

  it('third-party melee winds up before damage and whiffs when its target moves away', () => {
    const { game, sys } = world(22);
    const dog = sys.spawnById('mon_dog', 18.5, 12.5, 0)!;
    const zombie = sys.spawnById('mon_zombie', 19.5, 12.5, 0)!;
    dog.friendly = true;
    const hp = zombie.hp;
    const phases: string[] = [];
    game.events.on('monsterAttack', (e) => { if (e.monster === dog) phases.push(e.phase); });
    for (let i = 0; i < 30 && !dog.windup; i++) game.tick(1 / 60);
    expect(dog.windup).toBeTruthy();
    expect(phases).toEqual(['windup']);
    expect(zombie.hp).toBe(hp);
    zombie.x = 35.5;
    step(game, 0.5);
    expect(phases).toContain('whiff');
    expect(zombie.hp).toBe(hp);
  });

  it('same faction monsters do not fight each other and walls hide potential targets', () => {
    const { game, sys } = world();
    const a = sys.spawnById('mon_zombie', 24.5, 12.5, 0)!;
    const b = sys.spawnById('mon_zombie', 25.5, 12.5, 0)!;
    const dog = sys.spawnById('mon_dog', 27.5, 12.5, 0)!;
    dog.friendly = true;
    for (let y = 8; y < 17; y++) game.map.setTer(26, y, 0, 't_wall');
    const hp = [a.hp, b.hp];
    step(game, 0.5);
    expect(sys.monsterTargets.has(a)).toBe(false);
    expect(sys.monsterTargets.has(b)).toBe(false);
    expect(sys.monsterTargets.has(dog)).toBe(false);
    expect([a.hp, b.hp]).toEqual(hp);
  });
  it('resolves explicit, self, inherited and base-chain relations', () => {
    expect(monsterFactionAttitude(data, 'zombie', 'zombie')).toBe('FRIENDLY');
    expect(monsterFactionAttitude(data, 'zombie', 'blob')).toBe('FRIENDLY');
    expect(monsterFactionAttitude(data, 'zombie', 'nether')).toBe('NEUTRAL');
    // player -> human -> the root "" faction, which everyone is by_mood toward
    expect(monsterFactionAttitude(data, 'zombie', 'player')).toBe('BY_MOOD');
    // science inherits zombie's relations (base_faction)
    expect(monsterFactionAttitude(data, 'science', 'zombie')).toBe('FRIENDLY');
    expect(monsterFactionAttitude(data, 'science', 'bot')).toBe('NEUTRAL');
    expect(monsterFactionAttitude(data, 'herbivore', 'small_animal')).toBe('NEUTRAL');
  });
});

describe('special attacks', () => {
  it('formats BN attack messages; zombies carry BN bite / GRAB / scratch attacks', () => {
    expect(fmt('The %1$s grabs your %2$s!', 'zombie', 'left arm')).toBe('The zombie grabs your left arm!');
    expect(fmt('The %1$s lunges at your %2$s, battering it for %3$d damage!', 'zombie', 'head', '4')).toBe('The zombie lunges at your head, battering it for 4 damage!');
    const { sys } = world();
    const z = sys.spawnById('mon_zombie', 13.5, 12.5, 0)!;
    expect(z.specials.map((s) => s.def.id).sort()).toEqual(['GRAB', 'bite', 'scratch']);
    // "scratch" is the JSON monster_attack melee actor, merged into the monster's entry.
    const scratch = z.specials.find((s) => s.def.id === 'scratch')!;
    expect(scratch.def.attack_type).toBe('melee');
    expect(scratch.def.hit_dmg_u).toBe('The %1$s claws at you!');
    expect(isMeleeSpecial(scratch.def)).toBe(true);
    expect(isMeleeSpecial(z.specials.find((s) => s.def.id === 'GRAB')!.def)).toBe(true);
  });

  it('a bite infects only a grabbed survivor (bite_actor: one_in(14 - damage))', () => {
    const { game, sys } = world();
    let infected = 0;
    for (let i = 0; i < 200; i++) if (biteInfection(sys, 'arm_l', 4)) infected++;
    expect(infected).toBe(0);
    game.player.addEffect('grabbed', 100);
    for (let i = 0; i < 400; i++) if (biteInfection(sys, 'arm_l', 4)) infected++;
    // 1 in 10
    expect(infected).toBeGreaterThan(20);
    expect(infected).toBeLessThan(70);
    expect(game.player.hasEffect('bite', 'arm_l')).toBe(true);
  });

  it('mattack::dodge_check: 1 / (1 + 99 e^(-0.6 dodge)) after the attacker skill', () => {
    const { game, sys } = world();
    const z = sys.spawnById('mon_zombie', 13.5, 12.5, 0)!;
    const rate = () => {
      let n = 0;
      for (let i = 0; i < 2000; i++) if (dodgeCheck(sys, z)) n++;
      return n / 2000;
    };
    const base = rate();
    game.player.setSkill('dodge', 10);
    game.player.resetStats();
    expect(rate()).toBeGreaterThan(base + 0.1);
  });

  it('GRAB holds the survivor (grabbed intensity = grab_strength) or is batted away by dexterity', () => {
    const { game, sys, msgs } = world();
    const z = sys.spawnById('mon_zombie', 13.4, 12.5, 0)!;
    z.type = { ...z.type, melee_skill: 30 };
    const grab = z.specials.find((s) => s.def.id === 'GRAB')!;
    game.player.dex_base = 1;
    game.player.resetStats();
    let held = false;
    for (let i = 0; i < 30 && !held; i++) {
      trySpecial(sys, z, grab);
      held = game.player.hasEffect('grabbed');
    }
    expect(held).toBe(true);
    expect(sys.grabbedBy).toBe(z);
    expect(game.player.effects.intensity('grabbed')).toBeGreaterThanOrEqual(1);
    expect(msgs).toContain('The zombie grabs you!');
  });

  it('a shrieker shrieks (loud sound event) when the survivor is close', () => {
    const { game, sys } = world();
    const sounds: number[] = [];
    game.events.on('sound', (s) => sounds.push(s.volume));
    sys.spawnById('mon_zombie_shrieker', 15.5, 12.5, 0);
    step(game, 6);
    // BN mattack::shriek: volume 120
    expect(sounds).toContain(120);
  });

  it('a hulk SMASH flings the survivor (velocity dice x sides x 3)', () => {
    const { game, sys, msgs } = world();
    const h = sys.spawnById('mon_zombie_hulk', 13.6, 12.5, 0)!;
    const smash = () => h.specials.find((s) => s.def.id === 'SMASH')!;
    for (const s of h.specials) s.cooldown = s.def.id === 'SMASH' ? 0 : 999;
    const flung = () => msgs.some((m) => m.includes('sends you flying'));
    // Keep swinging until one lands (a dodge is possible), then check the survivor flew.
    let x0 = game.player.x;
    // Each smash is telegraphed first (combatfeel.ts): let the wind-up run, re-arm between tries.
    for (let i = 0; i < 300 && !flung(); i++) {
      x0 = game.player.x;
      if (!h.windup) {
        smash().cooldown = 0;
        h.attackCooldown = 0;
        h.busy = 0;
      }
      game.tick(1 / 30);
    }
    expect(flung()).toBe(true);
    expect(msgs).toContain('A blow from the zombie hulk sends you flying!');
    expect(Math.abs(game.player.x - x0)).toBeGreaterThan(0.5);
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
    game.player.inv.wield(createItem(data, 'bat'), null);
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

  it('every swing reports a playerAttack outcome for hit feedback, ending in a kill', () => {
    const { game, sys, combat } = world(3);
    game.player.inv.wield(createItem(data, 'bat'), null);
    const seen: string[] = [];
    game.events.on('playerAttack', (e) => {
      seen.push(e.outcome);
      if (e.outcome !== 'whiff') expect(e.target).toBe(z);
      if (e.outcome !== 'whiff' && e.outcome !== 'miss') expect(e.blood).toBe(sys.bloodType(z.type));
    });
    game.player.yaw = Math.PI / 2; // facing away: nothing to hit
    combat.melee();
    expect(seen).toEqual(['whiff']);
    const z = sys.spawnById('mon_zombie', 12.5, 11.3, 0)!;
    for (let i = 0; i < 30 * 60 && !z.dead; i++) {
      game.player.yaw = Math.atan2(z.x - game.player.x, -(z.y - game.player.y));
      if (combat.cooldown <= 0) combat.melee();
      game.tick(1 / 30);
    }
    expect(z.dead).toBe(true);
    expect(seen[seen.length - 1]).toBe('kill');
    expect(seen.filter((o) => o === 'kill')).toHaveLength(1);
  });

  it('bullets hit the first monster on the ray and stop at walls', () => {
    const { game, sys, combat } = world(4);
    const gun = createItem(data, 'glock_19');
    spawnItem(createItem(data, 'glockmag', { ammo: '9mm' }), L.mag(gun));
    game.player.inv.wield(gun, null);
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
    game.player.inv.wield(rock, null);
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
    // BN: medium 45000 moves; ACT_BUTCHER tool factor 1 + min(10 q, 100)% (2x at BUTCHER 10+)
    expect(butcherSeconds(z, 30, 'quick')).toBe(225);
    expect(butcherSeconds(z, 5, 'quick')).toBe(300);
    expect(butcherSeconds(z, 0, 'quick')).toBe(450);
    expect(butcherSeconds(z, 30, 'full')).toBe(225 * 6);
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

  it('zombies give tainted meat (BN "zombie" harvest); harvest-exempt monsters give nothing', () => {
    const { game } = world();
    const z = butcherYield(data, game.player, data.monsters.mon_zombie, 30, 'full', new Rng(2));
    expect(z.items.some((i) => i.typeId === 'meat_tainted')).toBe(true);
    expect(z.items.some((i) => i.typeId === 'bone_tainted')).toBe(true);
    // Blood only comes from bleeding a corpse, never from butchering it.
    expect(z.items.some((i) => i.typeId === 'blood_tainted')).toBe(false);
    const b = butcherYield(data, game.player, data.monsters.mon_boomer, 30, 'full', new Rng(2));
    expect(b.ok).toBe(false);
  });
});

describe('zombie density (CDDA SPAWN_DENSITY) and horde hearing', () => {
  it('densityCount thins spawns below 1 and multiplies above 1', () => {
    const rng = new Rng(3);
    let half = 0, dbl = 0;
    for (let i = 0; i < 2000; i++) {
      half += densityCount(4, 0.5, rng);
      dbl += densityCount(4, 2, rng);
    }
    expect(half / 2000).toBeCloseTo(2, 0);
    expect(dbl / 2000).toBe(8);
  });

  it('scales place_monsters spawns with the density option', () => {
    const count = (density: number) => {
      const { game, sys } = world(5);
      const sp = new Spawner(sys, null, { safeRadius: 0, density, realtimeScale: 1 });
      const c = game.map.chunk(-2, -2, 0)!;
      c.spawns = [{ kind: 'group', id: 'GROUP_ZOMBIE', x: -48, y: -48, z: 0, area: [-48, -48, -25, -25], density: 0.5 }];
      sp.onChunk(c);
      return sys.all.length;
    };
    expect(count(2)).toBeGreaterThan(count(0.5));
  });

  it('holds spawns until release, and drops them when a save replaces the map', () => {
    const { game, sys } = world(11);
    const sp = new Spawner(sys, null, { safeRadius: 0, realtimeScale: 1 });
    sp.hold();
    const c = game.map.chunk(1, 1, 0)!;
    c.spawns = [{ kind: 'monster', id: 'mon_zombie', x: 30, y: 30, z: 0, count: 1 }];
    sp.onChunk(c);
    expect(sys.all.length).toBe(0);
    sp.opts.density = 2;
    sp.release();
    expect(sys.all.length).toBe(2);
    sp.hold();
    const d = game.map.chunk(-1, 1, 0)!;
    d.spawns = [{ kind: 'monster', id: 'mon_zombie', x: -20, y: 30, z: 0, count: 1 }];
    sp.onChunk(d);
    sp.discardHeld();
    sp.release();
    expect(sys.all.length).toBe(2);
  });

  it('outside the bubble only hordes hear gunfire, out to CDDA signal range', () => {
    expect(hordeSignal(50)).toBe(0);
    expect(hordeSignal(74)).toBe(8);
    expect(hordeSignal(300)).toBe(25);
    const { game, sys } = world(3);
    const loner = sys.spawnById('mon_zombie', 12.5 + 80, 12.5, 0)!;
    const horde = sys.spawnById('mon_zombie', 12.5 - 80, 12.5, 0)!;
    const farHorde = sys.spawnById('mon_zombie', 12.5, 12.5 + 8 * 12 + 30, 0)!;
    horde.horde = farHorde.horde = true;
    step(game, 0.1);
    expect(loner.dormant && horde.dormant && farHorde.dormant).toBe(true);
    sys.hear(12, 12, 0, 74);
    expect(loner.wanderTime).toBe(0);
    expect(horde.wanderTime).toBeGreaterThan(0);
    expect(Math.hypot(horde.wanderX - 12, horde.wanderY - 12)).toBeLessThan(20);
    expect(farHorde.wanderTime).toBe(0);
  });
});

describe('gravity', () => {
  // Playtest: a tough zombie hovered on open air one level up after walking off a roof.
  it('a non-flyer on open air falls to the floor below and is hurt; flyers stay up', () => {
    const { game, sys } = world();
    expect(game.map.hasFloor(20, 20, 1)).toBe(false);
    // (spawning onto open air is placed on the floor already: standing.ts; here it walked off)
    const z = sys.spawnById('mon_zombie', 20.5, 20.5, 0)!;
    z.z = 1;
    const crow = sys.spawnById('mon_crow', 22.5, 20.5, 1);
    const hp0 = z.hp;
    step(game, 0.2);
    expect(z.z).toBe(0);
    expect(z.hp).toBeLessThan(hp0);
    if (crow) expect(crow.z).toBe(1);
  });
});

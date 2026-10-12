// The survivor's projectiles in the line of fire of NPCs (src/game/npcfire.ts): hitscan rounds,
// each shotgun pellet and flying arrows meet NPCs (followers and neutrals too) before what lies
// behind them; BN's consequences (stray hits don't provoke, the aimed-at NPC turns hostile,
// adjacent friends are spared), armor once per projectile, kill credit and dropped arrows.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem } from '../src/game/npcai';
import type { Npc, NpcData } from '../src/game/npc';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem } from '../src/game/item';
import { setAimModel } from '../src/game/aimmodel';
import { enemyFireOf } from '../src/game/enemyfire';
import { npcFireHooks, npcOnLine, npcOnRay, sparedAtShoulder, type NpcProjectile } from '../src/game/npcfire';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let nd: NpcData;
beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
  nd = load('npcs.json');
});
afterEach(() => setAimModel('sway'));

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function world(seed = 9) {
  const clicks: number[] = [];
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, clicks, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => clicks.splice(0) };
  const game = new Game(data, seed, input as unknown as Input);
  game.map.generator = new FlatGen();
  const p = game.player;
  p.x = 12.5;
  p.y = 12.5;
  p.yaw = 0; // north (-y)
  p.pitch = 0;
  p.str_base = 12;
  p.resetStats();
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const mons = new MonsterSystem(game);
  const combat = new PlayerCombat(game, mons);
  const npcs = new NpcSystem(game, nd, mons);
  (game as unknown as { monsters: MonsterSystem; npcs: NpcSystem }).monsters = mons;
  (game as unknown as { npcs: NpcSystem }).npcs = npcs;
  combat.npcFire = npcFireHooks(npcs);
  npcs.rangedTargetNpc = (reach) => combat.crosshairNpc(reach) as Npc | null;
  game.systems.push(mons, combat);
  game.clock.seconds = 12 * 3600;
  p.inv.wear(createItem(data, 'backpack'), null);
  const msgs: string[] = [];
  game.events.on('message', (m) => msgs.push(m.text));
  const attacks: { reason?: string; target?: unknown; outcome: string }[] = [];
  game.events.on('playerAttack', (e) => attacks.push(e));
  return { game, mons, npcs, combat, msgs, attacks };
}

/** A plain neutral survivor standing still at (x, y), nothing in hand. */
function person(npcs: NpcSystem, x: number, y: number): Npc {
  const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, Math.floor(x), Math.floor(y), 0)!;
  n.x = x;
  n.y = y;
  n.attitude = 'NULL';
  if (n.inv.wielded) n.inv.drop(n.inv.wielded);
  return n;
}

const hpOf = (n: Npc) => Object.values(n.hp).reduce((s, h) => s + h.cur, 0);
const pellets = (reason?: string) => Number(/^(\d+)\/\d+ pellets/.exec(reason ?? '')?.[1] ?? 0);

function shotgun(game: Game) {
  game.player.inv.wield(createItem(data, 'remington_870', { ammo: 'shot_00' }), null);
  game.player.recoil = 0;
}

describe('line-of-fire geometry', () => {
  const shooter = { x: 12.5, y: 12.5, z: 0 };
  it('a free-aim ray enters the nearest NPC column before the limit, zoned by height', () => {
    const a = { x: 12.5, y: 8.5, z: 0 }, b = { x: 12.5, y: 6.5, z: 0 };
    const eye = { x: 12.5, y: 12.5, h: 1.6 };
    const h = npcOnRay([b, a], eye, 0, 0, 30, { shooter })!;
    expect(h.n).toBe(a);
    expect(h.s).toBeCloseTo(4 - 0.33, 2);
    // level from a 1.6 m eye meets a 1.75 m person at the head; lower is the chest, then the legs
    expect(h.zone).toBe('head');
    expect(npcOnRay([a], eye, 0, Math.atan2(1.2 - 1.6, 4), 30, { shooter })!.zone).toBe('torso');
    expect(npcOnRay([a], eye, 0, Math.atan2(0.5 - 1.6, 4), 30, { shooter })!.zone).toBe('legs');
    expect(npcOnRay([a], eye, 0, Math.atan2(2.3 - 1.6, 4), 30, { shooter })).toBeNull();
    // a monster/wall nearer than it (the limit) keeps it
    expect(npcOnRay([a], eye, 0, 0, 3, { shooter })).toBeNull();
    // 0.5 m to the side: clear
    expect(npcOnRay([{ x: 13.0, y: 8.5, z: 0 }], eye, 0, 0, 30, { shooter })).toBeNull();
    // another level, or dead: never
    expect(npcOnRay([{ ...a, z: 1 }, { ...a, dead: true }], eye, 0, 0, 30, { shooter })).toBeNull();
  });

  it('the classic line uses the collision radius and reports missed_by', () => {
    const h = npcOnLine([{ x: 12.65, y: 8.5, z: 0 }], 12.5, 12.5, 0, 30, { shooter })!;
    expect(h.missedBy).toBeCloseTo(0.5, 5);
    expect(npcOnLine([{ x: 12.85, y: 8.5, z: 0 }], 12.5, 12.5, 0, 30, { shooter })).toBeNull();
  });

  it('BN: a creature friendly to the shooter within one tile is never hit; a stranger there is', () => {
    const friend = { x: 12.5, y: 11.5, z: 0, isFriendly: () => true };
    const stranger = { x: 12.5, y: 11.5, z: 0, isFriendly: () => false };
    expect(sparedAtShoulder(shooter, friend)).toBe(true);
    expect(sparedAtShoulder(shooter, { ...friend, y: 10.5 })).toBe(false);
    expect(npcOnLine([friend], 12.5, 12.5, 0, 30, { shooter })).toBeNull();
    expect(npcOnLine([stranger], 12.5, 12.5, 0, 30, { shooter })?.n).toBe(stranger);
  });
});

describe('hitscan rounds hit NPCs in the way', () => {
  it('free aim: the person in front of the zombie takes the slug, the zombie behind is untouched; the one you shot at turns hostile (BN on_target_accepted)', () => {
    const { game, mons, npcs, combat, msgs, attacks } = world();
    game.player.inv.wield(createItem(data, 'remington_870', { ammo: 'shot_slug' }), null);
    const n = person(npcs, 12.5, 8.5);
    n.personality.bravery = 10;
    const z = mons.spawnById('mon_zombie', 12.5, 4.5, 0)!;
    const zhp = z.hp, nhp = hpOf(n);
    expect(combat.crosshairNpc(30)).toBe(n);
    expect(combat.fire()).toBe(true);
    expect(hpOf(n)).toBeLessThan(nhp);
    expect(z.hp).toBe(zhp);
    expect(msgs.some((m) => m.startsWith(`You shoot ${n.name} in the`))).toBe(true);
    expect(n.isEnemy() || n.attitude === 'FLEE_TEMP').toBe(true);
    expect(attacks.at(-1)?.outcome).toMatch(/hit|crit|kill/);
  });

  it('classic dice: the round stops in the NPC in its path (never also in the zombie behind)', () => {
    setAimModel('dice');
    const { game, mons, npcs, combat } = world(3);
    game.player.inv.wield(createItem(data, 'remington_870', { ammo: 'shot_slug' }), null);
    const n = person(npcs, 12.5, 10.5);
    const z = mons.spawnById('mon_zombie', 12.5, 6.5, 0)!;
    z.hp = 100000;
    let npcHits = 0, both = 0;
    const real = combat.npcFire!.hit;
    combat.npcFire!.hit = (b, o) => {
      npcHits++;
      return real(b, o);
    };
    for (let i = 0; i < 6 && !n.dead; i++) {
      const before = z.hp, hits = npcHits;
      game.player.recoil = 0;
      combat.cooldown = 0;
      combat.burst = null;
      combat.fire();
      if (npcHits > hits && z.hp < before) both++;
    }
    expect(npcHits).toBeGreaterThan(0);
    expect(both).toBe(0);
  });
});

describe('every pellet finds its own body', () => {
  it('an NPC covering the whole cone takes all five pellets (armor rolled once each); none reach the zombie behind', () => {
    const { game, mons, npcs, combat, attacks } = world();
    shotgun(game);
    const n = person(npcs, 12.5, 9.5);
    const z = mons.spawnById('mon_zombie', 12.5, 5.5, 0)!;
    const zhp = z.hp;
    let absorbs = 0;
    const absorb = n.inv.absorbHit.bind(n.inv);
    n.inv.absorbHit = (bp, units, rng) => {
      absorbs++;
      return absorb(bp, units, rng);
    };
    const nhp = hpOf(n);
    expect(combat.fire()).toBe(true);
    expect(z.hp).toBe(zhp);
    const ev = attacks.find((a) => !a.target && pellets(a.reason) > 0)!;
    expect(pellets(ev.reason)).toBe(5);
    expect(absorbs).toBe(5);
    expect(hpOf(n)).toBeLessThan(nhp);
  });

  it('half in the cone: some pellets hit the NPC, the rest fly on to the zombie, and none counts twice', () => {
    const { game, mons, npcs, combat, attacks } = world(4);
    shotgun(game);
    // 3 m out, the 3° cone is ±0.16 m wide: an NPC 0.42 m to the side takes only the pellets on its side.
    const n = person(npcs, 12.5 + 0.42, 9.5);
    const z = mons.spawnById('mon_zombie', 12.5, 6.5, 0)!;
    z.hp = 100000;
    n.hp.torso.cur = n.hp.torso.max = 100000;
    let split = 0;
    for (let i = 0; i < 12; i++) {
      attacks.length = 0;
      game.player.recoil = 0;
      combat.cooldown = 0;
      combat.aim.kickX = combat.aim.kickY = 0;
      combat.fire();
      const toNpc = attacks.filter((a) => !a.target).reduce((s, a) => s + pellets(a.reason), 0);
      const toZombie = attacks.filter((a) => a.target === z).reduce((s, a) => s + pellets(a.reason), 0);
      expect(toNpc + toZombie).toBeLessThanOrEqual(5);
      if (toNpc > 0 && toZombie > 0) split++;
    }
    expect(split).toBeGreaterThan(0);
    // the crosshair was on the zombie: the person beside the line was a bystander (BN: no on_attacked)
    expect(combat.crosshairNpc(30)).toBeNull();
    expect(n.attitude).toBe('NULL');
  });

  it('classic dice pellets: the NPC in the way takes them, the zombie behind none', () => {
    setAimModel('dice');
    const { game, mons, npcs, combat, msgs } = world(5);
    shotgun(game);
    const n = person(npcs, 12.5, 11.5 - 0.6);
    n.hp.torso.cur = n.hp.torso.max = 100000;
    const z = mons.spawnById('mon_zombie', 12.5, 6.5, 0)!;
    const zhp = z.hp;
    combat.fire();
    expect(msgs.some((m) => m.startsWith(`${n.name} is hit by`))).toBe(true);
    expect(z.hp).toBe(zhp);
  });
});

describe('arrows hit NPCs', () => {
  function bowWorld(seed = 6) {
    const w = world(seed);
    const p = w.game.player;
    const bow = createItem(data, 'longbow');
    p.inv.wield(bow, null);
    p.inv.giveNew(createItem(data, 'arrow_wood', { count: 5 }));
    const loose = (seconds = 1.5) => {
      const d = w.combat.startDraw(bow, 'draw', true)!;
      d.t = d.full;
      for (let i = 0; i < seconds * 30; i++) w.combat.update(w.game, 1 / 30);
    };
    const arrows = () => {
      let c = 0;
      for (const it of p.inv.allItems()) if (it.typeId === 'arrow_wood') c += it.charges;
      for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) for (const it of w.game.map.itemsAt(x, y, 0) as { typeId: string; charges: number }[]) if (it.typeId === 'arrow_wood') c += it.charges;
      return c;
    };
    return { ...w, bow, loose, arrows };
  }

  it('a neutral the arrow is loosed at takes it; the arrow drops at their feet (BN embeds only in monsters) or breaks', () => {
    const { game, mons, npcs, msgs, loose, arrows } = bowWorld();
    const p = game.player;
    const n = person(npcs, 12.5, 6.5);
    const z = mons.spawnById('mon_zombie', 12.5, 0.5, 0)!;
    z.hp = 10000;
    const nhp = hpOf(n), before = arrows();
    p.pitch = Math.atan2(1.1 - 1.6, 6);
    loose();
    expect(hpOf(n)).toBeLessThan(nhp);
    expect(z.hp).toBe(10000);
    expect(msgs.some((m) => m.startsWith(`Your ${'wooden arrow'}`) || m.includes(n.name))).toBe(true);
    // the crosshair was on them: the one you shot at turns on you
    expect(n.attitude === 'KILL' || n.attitude === 'FLEE_TEMP').toBe(true);
    const broke = msgs.some((m) => /breaks/.test(m));
    expect(arrows()).toBe(before - (broke ? 1 : 0));
    if (!broke) expect((game.map.itemsAt(n.tileX, n.tileY, 0) as { typeId: string }[]).some((it) => it.typeId === 'arrow_wood')).toBe(true);
  });

  it('classic dice: an arrow an NPC avoids flies on (passed once, never hit twice)', () => {
    setAimModel('dice');
    const { game, npcs, combat } = bowWorld(8);
    const n = person(npcs, 12.5, 9.5);
    const calls: NpcProjectile[] = [];
    combat.npcFire!.hit = (_b, o) => {
      calls.push(o);
      return { total: 0, landed: 0, dodged: 1, head: false, dead: false };
    };
    game.player.pitch = Math.atan2(1.1 - 1.6, 3);
    const d = combat.startDraw(game.player.inv.wielded!, 'draw', true)!;
    d.t = d.full;
    let straightened = false;
    for (let i = 0; i < 60; i++) {
      combat.update(game, 1 / 30);
      // BN's dispersion roll sends a skill-0 arrow wide; this test is about what happens at the
      // NPC, so straighten the flight onto it as it leaves the bow.
      const f = combat.flights[0];
      if (f && !straightened) {
        straightened = true;
        f.dx = 0;
        f.dy = -1;
        f.yaw = 0;
      }
    }
    expect(straightened).toBe(true);
    expect(calls.length).toBe(1);
    expect(n.dead).toBeFalsy();
    expect(combat.flights.length).toBe(0);
  });
});

describe('consequences', () => {
  it('killing an NPC with a round credits the survivor; body and gear drop', () => {
    const { game, npcs, combat } = world();
    game.player.inv.wield(createItem(data, 'remington_870', { ammo: 'shot_slug' }), null);
    const n = person(npcs, 12.5, 9.5);
    for (const k of Object.keys(n.hp) as (keyof typeof n.hp)[]) n.hp[k].cur = 1;
    const deaths: unknown[] = [];
    game.events.on('creatureDied', (e) => deaths.push(e.killer));
    combat.fire();
    expect(n.dead).toBe(true);
    expect(deaths).toEqual([game.player]);
    expect((game.map.itemsAt(n.tileX, n.tileY, 0) as { typeId: string }[]).some((it) => it.typeId === 'corpse')).toBe(true);
  });

  it('a follower at your shoulder is spared (BN adjacent friendly fire); one two tiles out is hit and stays a follower', () => {
    const { game, mons, npcs, combat } = world();
    game.player.inv.wield(createItem(data, 'remington_870', { ammo: 'shot_slug' }), null);
    const f = person(npcs, 12.5, 11.5);
    f.attitude = 'FOLLOW';
    const z = mons.spawnById('mon_zombie', 12.5, 6.5, 0)!;
    z.hp = 10000;
    const fhp = hpOf(f);
    combat.fire();
    expect(hpOf(f)).toBe(fhp);
    expect(z.hp).toBeLessThan(10000);
    // Two tiles out and half a metre beside the crosshair: buckshot pellets on its side hit it,
    // a stray hit, so it stays a follower.
    shotgun(game);
    f.x = 12.5 + 0.42;
    f.y = 9.5;
    for (let i = 0; i < 12 && hpOf(f) === fhp; i++) {
      combat.cooldown = 0;
      game.player.recoil = 0;
      combat.aim.kickX = combat.aim.kickY = 0;
      combat.fire();
    }
    expect(hpOf(f)).toBeLessThan(fhp);
    expect(f.attitude).toBe('FOLLOW');
  });
});

describe('the attack confirmation (BN target_ui: only the creature you target)', () => {
  it('with a gun, a neutral beside the crosshair line is not asked about; the one it meets is', () => {
    const { game, npcs } = world();
    game.player.inv.wield(createItem(data, 'remington_870', { ammo: 'shot_slug' }), null);
    const n = person(npcs, 13.2, 8.5); // ~10° off the facing: inside the melee cone, not under the crosshair
    const asked: Npc[] = [];
    npcs.confirmAttack = (who) => asked.push(who);
    expect(npcs.guardAttack()).toBe(true);
    expect(asked).toEqual([]);
    n.x = 12.5;
    expect(npcs.guardAttack()).toBe(false);
    expect(asked).toEqual([n]);
  });
});

describe('NPC fire', () => {
  it('rounds pass through a creature friendly to the shooter within one tile of it', () => {
    const { game } = world();
    const p = game.player;
    const fire = enemyFireOf(game);
    let hit = 0;
    fire.fire({ kind: 'bullet', x: p.x, y: p.y + 1, h: 1.4, z: 0, tx: p.x, ty: p.y - 10, th: 1.2, yawOff: 0, range: 20, from: 'npc', spares: (b) => b === p, onPlayer: () => hit++ });
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(hit).toBe(0);
    fire.fire({ kind: 'bullet', x: p.x, y: p.y + 1, h: 1.4, z: 0, tx: p.x, ty: p.y - 10, th: 1.2, yawOff: 0, range: 20, from: 'npc', onPlayer: () => hit++ });
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(hit).toBe(1);
  });

  it('an NPC shotgun fires every pellet as its own round, each able to hit who is in the way', () => {
    const { game, npcs, mons } = world();
    const shooter = person(npcs, 12.5, 2.5);
    shooter.attitude = 'KILL';
    const gun = createItem(data, 'remington_870', { ammo: 'shot_00' });
    shooter.inv.wield(gun, null);
    const z = mons.spawnById('mon_zombie', 12.5, 20.5, 0)!;
    const fire = enemyFireOf(game);
    (npcs as unknown as { shoot(n: Npc, g: unknown, foe: unknown, pos: { x: number; y: number }): void }).shoot(shooter, gun, { kind: 'monster', m: z }, { x: z.x, y: z.y });
    expect(fire.rounds.length).toBe(5);
    // Each pellet its own line (distinct directions around the NPC's rolled aim): put the survivor
    // in the middle of the cluster 8 m out, as if they had walked into the line of fire.
    const dirs = new Set(fire.rounds.map((r) => r.dx.toFixed(4)));
    expect(dirs.size).toBe(5);
    const mx = fire.rounds.reduce((s, r) => s + r.dx, 0) / 5, my = fire.rounds.reduce((s, r) => s + r.dy, 0) / 5;
    const k = 8 / Math.hypot(mx, my);
    game.player.x = shooter.x + mx * k;
    game.player.y = shooter.y + my * k;
    let hurt = 0;
    game.events.on('playerHurt', () => hurt++);
    for (let i = 0; i < 30; i++) fire.update(game, 1 / 30);
    expect(hurt).toBeGreaterThan(0);
    expect(hurt).toBeLessThanOrEqual(5);
  });
});

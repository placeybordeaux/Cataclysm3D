import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { Character } from '../src/game/character';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem } from '../src/game/item';
import { tryDodgeRoll } from '../src/game/combat';
import { blockHit, logarithmicRange } from '../src/game/techniques';
import { refreshDefenses } from '../src/game/martialarts';
import {
  FEEL, FEEL_PRESETS, blockAttemptChance, defenseOf, guardScoreBonus, hitStopSeconds, setFeelDifficulty, sidestepDodgeRoll,
  surroundAngles, sweptArcTarget, swingTiming, telegraphSeconds,
} from '../src/game/combatfeel';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
});
afterEach(() => setFeelDifficulty('accessible'));

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}

function world(seed = 7) {
  const game = new Game(data, seed, fakeInput());
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  game.clock.seconds = 12 * 3600;
  const events: string[] = [];
  game.events.on('monsterAttack', (e) => events.push(e.phase));
  game.events.on('playerAttack', (e) => events.push(`player:${e.outcome}`));
  return { game, sys, combat, events };
}
const step = (game: Game, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) game.tick(1 / 30);
};
const tough = (game: Game) => {
  for (const k of Object.keys(game.player.hp)) game.player.hp[k as keyof typeof game.player.hp].max = game.player.hp[k as keyof typeof game.player.hp].cur = 100000;
};

describe('swing phase timing', () => {
  it('splits CDDA swing time into wind-up / strike / active / recovery that add back up', () => {
    const bat = swingTiming(0.5, 900);
    expect(bat.windup).toBeGreaterThan(FEEL.windupMin);
    expect(bat.windup + bat.strike + bat.active + bat.recovery).toBeCloseTo(bat.total);
    expect(bat.total).toBeCloseTo(0.5);
    // Heavier weapons wind up longer, but never past the share of the swing.
    const sledge = swingTiming(1.2, 5400);
    expect(sledge.windup).toBeGreaterThan(bat.windup);
    expect(sledge.windup).toBeLessThanOrEqual(FEEL.windupMax);
    const fist = swingTiming(0.3, 0);
    expect(fist.windup).toBe(FEEL.windupBase);
    // A very fast swing: the recovery floor stretches the cycle rather than skipping phases.
    const quick = swingTiming(0.12, 500);
    expect(quick.windup).toBeLessThanOrEqual(0.12 * FEEL.windupMaxShare + 1e-9);
    expect(quick.recovery).toBe(FEEL.recoveryMin);
  });

  it('hit-stop grows with the share of HP a blow takes, within bounds', () => {
    const light = hitStopSeconds(3, 80, false), heavy = hitStopSeconds(40, 80, false);
    expect(light).toBeGreaterThanOrEqual(FEEL.hitStopBase);
    expect(heavy).toBeGreaterThan(light);
    expect(hitStopSeconds(500, 80, true)).toBeLessThanOrEqual(FEEL.hitStopMax);
  });

  it('a phased swing resolves at contact, not on the click, and plays out its recovery', () => {
    const { game, sys, combat, events } = world();
    game.player.inv.wield(createItem(data, 'bat'), null);
    game.player.hit_bonus = 40;
    const z = sys.spawnById('mon_zombie', 12.5, 11.3, 0)!;
    z.hp = 10000;
    for (const s of z.specials) s.cooldown = 999;
    z.attackCooldown = 99;
    game.player.yaw = 0;
    step(game, 0.05);
    combat.attack();
    const s = combat.swing!;
    expect(s).toBeTruthy();
    const contact = s.timing.windup + s.timing.strike;
    let resolvedAt = -1;
    for (let t = 0; t < 1 && resolvedAt < 0; t += 1 / 30) {
      game.tick(1 / 30);
      if (events.some((e) => e.startsWith('player:'))) resolvedAt = s.t;
    }
    expect(resolvedAt).toBeGreaterThanOrEqual(contact - 1e-9);
    expect(resolvedAt).toBeLessThan(contact + 1 / 30 + 1e-9);
    expect(events).toContain('player:hit');
    // Hit-stop held the swing clock for a few frames, then the swing finishes.
    expect(combat.hitStop).toBeGreaterThan(0);
    step(game, 1);
    expect(combat.swing).toBe(null);
  });

  it('a swing at air whiffs once its active window closes', () => {
    const { game, combat, events } = world();
    game.player.inv.wield(createItem(data, 'bat'), null);
    combat.attack();
    step(game, 1);
    expect(events).toEqual(['player:whiff']);
  });
});

describe('swept-arc target selection', () => {
  const o = { x: 0, y: 0, yaw: 0 };
  const mk = (x: number, y: number, radius = 0.3) => ({ x, y, radius });
  it('prefers what the crosshair ray passes through, then the smallest angle', () => {
    const front = mk(0, -1), side = mk(0.8, -0.8);
    expect(sweptArcTarget(o, [side, front], 1.2, 0.7)).toBe(front);
    // Off the ray: the one nearer the aim wins even if it is farther away.
    const a = mk(0.5, -1.0), b = mk(-0.9, -0.6);
    expect(sweptArcTarget(o, [b, a], 1.2, 1.2)).toBe(a);
  });
  it('respects reach, arc width and walls', () => {
    expect(sweptArcTarget(o, [mk(0, -2)], 1.2, 0.7)).toBe(null);
    expect(sweptArcTarget(o, [mk(1, 0)], 1.2, 0.5)).toBe(null); // 90° off, narrow arc
    expect(sweptArcTarget(o, [mk(0.7, -0.7)], 1.2, 0.7)).not.toBe(null); // 45°, clipped by its size
    const behindWall = mk(0, -1);
    expect(sweptArcTarget(o, [behindWall], 1.2, 0.7, () => true)).toBe(null);
  });
  it('a thrust (narrow arc) misses what a swing (wide arc) catches', () => {
    const t = mk(0.8, -0.7);
    expect(sweptArcTarget(o, [t], 1.2, FEEL.arcThrust)).toBe(null);
    expect(sweptArcTarget(o, [t], 1.2, FEEL.arcSwing)).toBe(t);
  });
});

describe('monster telegraphs', () => {
  it('slower monsters and heavy blows telegraph longer; Accessible longer than Classic', () => {
    expect(telegraphSeconds(50, 'melee')).toBeGreaterThan(telegraphSeconds(150, 'melee'));
    expect(telegraphSeconds(100, 'heavy')).toBeGreaterThan(telegraphSeconds(100, 'melee'));
    const acc = telegraphSeconds(100, 'melee', FEEL_PRESETS.accessible), cls = telegraphSeconds(100, 'melee', FEEL_PRESETS.classic);
    expect(acc).toBeGreaterThan(cls);
    expect(acc).toBeGreaterThanOrEqual(0.3);
    expect(acc).toBeLessThanOrEqual(0.8);
  });

  it('a blow winds up, then resolves: telegraph strictly before the damage', () => {
    const { game, sys, events } = world();
    tough(game);
    const order: string[] = [];
    game.events.on('monsterAttack', (e) => order.push(e.phase));
    game.events.on('playerHurt', () => order.push('hurt'));
    game.events.on('message', (m) => /^The zombie/.test(m.text) && order.push('msg'));
    const z = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
    step(game, 0.05);
    expect(z.windup).toBeTruthy();
    expect(order[0]).toBe('windup');
    const total = z.windup!.total;
    expect(total).toBeCloseTo(telegraphSeconds(z.speed, 'melee'));
    // Nothing lands during the tell.
    step(game, total - 0.1);
    expect(order.filter((o) => o !== 'windup')).toEqual([]);
    step(game, 0.2);
    expect(order).toContain('resolved');
    expect(order.indexOf('windup')).toBeLessThan(order.indexOf('resolved'));
    void events;
  });

  it('backing out of reach during the tell makes the blow whiff', () => {
    const { game, sys } = world();
    tough(game);
    const hurt: number[] = [];
    game.events.on('playerHurt', (e) => hurt.push(e.amount));
    const phases: string[] = [];
    game.events.on('monsterAttack', (e) => phases.push(e.phase));
    const z = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
    step(game, 0.05);
    expect(z.windup).toBeTruthy();
    game.player.y += 1.5; // step back well past reach + lunge
    step(game, z.windup!.total + 0.1);
    expect(phases).toContain('whiff');
    expect(hurt).toEqual([]);
  });

  it('a hard hit staggers a monster out of its wind-up', () => {
    const { game, sys } = world();
    tough(game);
    const phases: string[] = [];
    game.events.on('monsterAttack', (e) => phases.push(e.phase));
    const z = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
    step(game, 0.05);
    expect(z.windup).toBeTruthy();
    sys.hurt(z, Math.ceil(z.hpMax * FEEL.staggerShare), 'player');
    expect(z.windup).toBe(null);
    expect(phases).toContain('interrupted');
    expect(z.flinch).toBeGreaterThan(0);
  });
});

describe('guard and side-step map onto CDDA block / dodge', () => {
  function survivor() {
    const c = new Character(data, { seed: 3 });
    c.str_base = 8;
    c.resetStats();
    return c;
  }
  it('guarding always attempts the block (BN rule) and adds the guard score', () => {
    expect(blockAttemptChance(0, false)).toBe(0);
    expect(blockAttemptChance(2, false)).toBeCloseTo(0.4);
    expect(blockAttemptChance(0, true)).toBe(1);
    expect(guardScoreBonus({ guarding: false, guardAge: 0 }).bonus).toBe(0);
    expect(guardScoreBonus({ guarding: true, guardAge: 5 })).toEqual({ bonus: FEEL.guardBlockBonus, parry: false });
    expect(guardScoreBonus({ guarding: true, guardAge: 0 })).toEqual({ bonus: FEEL.guardBlockBonus + FEEL.parryBonus, parry: true });

    const c = survivor();
    c.inv.wield(createItem(data, 'bat'), null);
    const rng = new Rng(7);
    // Melee 0: never blocks unguarded...
    refreshDefenses(c);
    expect(blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 3, rng).blocked).toBe(false);
    // ...but a held guard blocks every blow, with str 8 + WBLOCK 4 + melee 0 + guard bonus.
    const d = defenseOf(c);
    d.guarding = true;
    d.guardAge = 10;
    for (let i = 0; i < 3; i++) {
      const units = [{ type: 'bash', amount: 10 }];
      const b = blockHit(c, units, 'torso', 3, rng);
      expect(b.blocked).toBe(true);
      expect(b.parry).toBe(false);
      expect(units[0].amount).toBeCloseTo(10 * logarithmicRange(0, 40, 12 + FEEL.guardBlockBonus));
    }
    // A fresh guard is a parry: more blocked.
    d.guardAge = 0;
    const units = [{ type: 'bash', amount: 10 }];
    expect(blockHit(c, units, 'torso', 3, rng).parry).toBe(true);
    expect(units[0].amount).toBeCloseTo(10 * logarithmicRange(0, 40, 12 + FEEL.guardBlockBonus + FEEL.parryBonus));
    // Still can't block a huge attacker, guard or not.
    expect(blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 5, rng).blocked).toBe(false);
  });

  it('bare hands guard with the arms', () => {
    const c = survivor();
    defenseOf(c).guarding = true;
    defenseOf(c).guardAge = 10;
    const b = blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 3, new Rng(1));
    expect(b.blocked).toBe(true);
    expect(['arm_l', 'arm_r']).toContain(b.bp);
  });

  it('a side-step window gives the dodge roll its bonus without spending a dodge', () => {
    const c = survivor();
    refreshDefenses(c);
    const d = defenseOf(c);
    expect(sidestepDodgeRoll(2, d)).toBe(null);
    d.dodgeWindow = 0.2;
    expect(sidestepDodgeRoll(2, d)).toBe((2 + FEEL.dodgeBonus) * 5);
    const roll = tryDodgeRoll(c);
    expect(roll).toBeCloseTo((c.dodge() + FEEL.dodgeBonus) * 5);
    d.dodgeWindow = 0;
    // The turn's regular dodge is still there.
    expect(tryDodgeRoll(c)).toBeCloseTo(c.dodge() * 5);
  });

  it('Space side-steps the survivor sideways/back and opens the dodge window', () => {
    const { game, combat } = world();
    game.player.yaw = 0;
    const y0 = game.player.y;
    expect(combat.sidestep('Space')).toBe(true);
    expect(defenseOf(game.player).dodgeWindow).toBeGreaterThan(0);
    step(game, 0.3);
    expect(game.player.y - y0).toBeCloseTo(FEEL.dodgeDistance, 1); // back = +y when facing north
    expect(combat.sidestep('Space')).toBe(false); // cooldown
  });

  it('a parried grab never takes hold and staggers the grabber (BN mattack::grab)', () => {
    const { game, sys } = world();
    tough(game);
    game.player.inv.wield(createItem(data, 'bat'), null);
    const z = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
    for (const s of z.specials) s.cooldown = s.def.id === 'GRAB' ? 0 : 999;
    z.type = { ...z.type, melee_skill: 20 }; // make sure it connects
    step(game, 0.05);
    expect(z.windup?.special?.def.id).toBe('GRAB');
    // Raise the guard (RMB with a melee weapon) just before it lands.
    step(game, z.windup!.t - 0.1);
    (game.input as unknown as { mouseButtons: number }).mouseButtons = 4;
    step(game, 0.15);
    expect(defenseOf(game.player).guarding).toBe(true);
    expect(game.player.hasEffect('grabbed')).toBe(false);
    expect(z.hasEffect('stunned')).toBe(true);
  });

  it('struggling breaks a grab eventually, each failure building a bonus', () => {
    const { game, sys } = world();
    tough(game);
    const z = sys.spawnById('mon_zombie', 12.5, 11.4, 0)!;
    for (const s of z.specials) s.cooldown = 999;
    z.attackCooldown = 999;
    sys.grabbedBy = z;
    z.addEffect('grabbing', 100);
    game.player.addEffect('grabbed', 1000);
    game.player.str_base = 1;
    game.player.dex_base = 1;
    game.player.resetStats();
    let tries = 0;
    while (sys.grabbedBy && tries < 200) {
      const r = sys.struggle();
      if (r === 'wait') step(game, 1 / 30);
      else tries++;
    }
    expect(sys.grabbedBy).toBe(null);
    expect(defenseOf(game.player).struggle).toBe(0);
  });
});

describe('spacing', () => {
  it('surroundAngles spreads a stacked crowd into distinct slots', () => {
    const out = surroundAngles([0, 0.01, 0.02, -0.01].map((angle) => ({ angle, radius: 0.3 })), 1.1);
    const sorted = [...out].sort((a, b) => a - b);
    const need = 2 * Math.asin((0.6 + 0.12) / 2.2) - 1e-3;
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(need);
    // Already spread: untouched.
    expect(surroundAngles([{ angle: 0, radius: 0.3 }, { angle: Math.PI, radius: 0.3 }], 1.1)).toEqual([0, Math.PI]);
  });

  it('zombies arriving from one side surround the survivor and hold without jitter', () => {
    const { game, sys } = world();
    tough(game);
    const zs = [0, 1, 2, 3].map((i) => sys.spawnById('mon_zombie', 12.5 + (i - 1.5) * 0.4, 7.5 - i * 0.3, 0)!);
    for (const z of zs) for (const s of z.specials) s.cooldown = 999;
    step(game, 6);
    const p = game.player;
    const angles = zs.map((z) => Math.atan2(z.x - p.x, -(z.y - p.y))).sort((a, b) => a - b);
    // Spread over a wide arc rather than a single file.
    expect(angles[angles.length - 1] - angles[0]).toBeGreaterThan(1.2);
    for (const z of zs) expect(sys.distToPlayer(z)).toBeGreaterThan(z.radius + 0.3 - 0.05);
    // Holding: over half a second the ones in reach barely move.
    const before = zs.map((z) => [z.x, z.y]);
    step(game, 0.5);
    const moved = zs.map((z, i) => Math.hypot(z.x - before[i][0], z.y - before[i][1]));
    expect(moved.filter((d) => d < 0.05).length).toBeGreaterThanOrEqual(2);
  });
});

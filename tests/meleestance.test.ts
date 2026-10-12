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
import { ACTION_SCALE } from '../src/core/time';
import {
  FEEL, FEEL_PRESETS, defenseOf, guardScoreBonus, meleeControl, meleeStance, setFeelDifficulty, setMeleeControl, type StanceInputs,
} from '../src/game/combatfeel';
import { setAimModel } from '../src/game/aimmodel';

// The "ready to swing" melee control (combatfeel.meleeStance, PlayerCombat.setStance): RMB
// readies, LMB swings only while readied, readied = guarding and slower; the classic control
// ("anytime") keeps the old LMB-whenever + RMB guard.

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
  setFeelDifficulty('accessible');
  setMeleeControl('ready');
  setAimModel('sway');
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

/** Input with real click bookkeeping: `click()` queues an LMB press like the canvas listener does. */
function fakeInput() {
  const inp = {
    held: new Set<string>(), captured: false, mouseButtons: 0, clicks: [] as number[], onPress() {}, consumeMouse: () => [0, 0],
    consumeClicks(): number[] {
      const c = inp.clicks;
      inp.clicks = [];
      return c;
    },
  };
  return inp;
}

function world() {
  const input = fakeInput();
  const game = new Game(data, 7, input as unknown as Input);
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  game.clock.seconds = 12 * 3600;
  const refused: string[] = [];
  const attacks: string[] = [];
  game.events.on('attackRefused', (e) => refused.push(e.reason));
  game.events.on('playerAttack', (e) => attacks.push(e.outcome));
  game.player.inv.wield(createItem(data, 'bat'), null);
  const rmb = (on: boolean) => (input.mouseButtons = on ? input.mouseButtons | 4 : input.mouseButtons & ~4);
  const click = () => input.clicks.push(0);
  return { game, sys, combat, input, refused, attacks, rmb, click };
}
const step = (game: Game, seconds: number) => {
  for (let i = 0; i < Math.max(1, Math.round(seconds * 30)); i++) game.tick(1 / 30);
};

const base: StanceInputs = { rmb: false, running: false, blocked: false, downed: false, swinging: false };

describe('meleeStance (pure)', () => {
  it('ready control: RMB readies; readied = may swing, guards, walks at readyMoveMul and costs readyStaminaPerSec', () => {
    expect(meleeStance(base, 'ready')).toEqual({ ready: false, canSwing: false, guarding: false, moveMul: 1, staminaPerSec: 0 });
    expect(meleeStance({ ...base, rmb: true }, 'ready')).toEqual({ ready: true, canSwing: true, guarding: true, moveMul: FEEL.readyMoveMul, staminaPerSec: FEEL.readyStaminaPerSec });
  });
  it('ready control: your own swing drops the guard but not the stance; running lowers it', () => {
    const sw = meleeStance({ ...base, rmb: true, swinging: true }, 'ready');
    expect(sw).toMatchObject({ ready: true, canSwing: true, guarding: false, moveMul: FEEL.readyMoveMul });
    expect(meleeStance({ ...base, rmb: true, running: true }, 'ready')).toEqual({ ready: false, canSwing: false, guarding: false, moveMul: 1, staminaPerSec: 0 });
  });
  it('ready control: downed or driving you can still ready and swing, but not guard', () => {
    expect(meleeStance({ ...base, rmb: true, downed: true }, 'ready')).toMatchObject({ ready: true, canSwing: true, guarding: false });
    expect(meleeStance({ ...base, rmb: true, blocked: true }, 'ready')).toMatchObject({ ready: true, canSwing: true, guarding: false });
  });
  it('anytime control: the old rules (swing whenever, RMB guard at guardMoveMul, down during a swing)', () => {
    expect(meleeStance(base, 'anytime')).toEqual({ ready: false, canSwing: true, guarding: false, moveMul: 1, staminaPerSec: 0 });
    expect(meleeStance({ ...base, rmb: true }, 'anytime')).toEqual({ ready: false, canSwing: true, guarding: true, moveMul: FEEL.guardMoveMul, staminaPerSec: FEEL.guardStaminaPerSec });
    expect(meleeStance({ ...base, rmb: true, swinging: true }, 'anytime').guarding).toBe(false);
    expect(meleeStance({ ...base, rmb: true, running: true }, 'anytime').guarding).toBe(true);
  });
  it('the default control is ready; an unknown one throws', () => {
    expect(meleeControl()).toBe('ready');
    expect(() => setMeleeControl('sometimes' as never)).toThrow();
  });
});

describe('ready-stance numbers', () => {
  // Speed-70 zombie: speed/100 * ACTION_SCALE * the preset's monster speed (Accessible 0.9, Classic 1).
  const zombie = (monsterSpeed: number) => (70 / 100) * ACTION_SCALE * monsterSpeed;
  it('backing off readied about keeps pace with a speed-70 zombie (Accessible) and loses to it (Classic)', () => {
    const { game } = world();
    const walk = game.player.moveSpeed(100);
    expect(walk).toBeGreaterThan(2.7);
    const acc = walk * FEEL_PRESETS.accessible.readyMoveMul, cls = walk * FEEL_PRESETS.classic.readyMoveMul;
    expect(Math.abs(acc - zombie(0.9)) / zombie(0.9)).toBeLessThan(0.08);
    expect(cls).toBeLessThan(zombie(1));
    // ...and either way slower than walking with the weapon down.
    expect(acc).toBeLessThan(walk * 0.7);
  });
  it('standing readied never runs stamina down (drain below the base regen of 60/s), in either preset', () => {
    for (const d of ['accessible', 'classic'] as const) {
      setFeelDifficulty(d);
      const { game, combat, rmb } = world();
      const p = game.player;
      p.stamina = p.staminaMax() * 0.5;
      rmb(true);
      step(game, 20);
      expect(combat.stance?.ready).toBe(true);
      expect(p.stamina).toBeGreaterThan(p.staminaMax() * 0.5);
    }
  });
});

describe('PlayerCombat with the ready control', () => {
  it('LMB alone does not swing (and says why); RMB + LMB swings', () => {
    const { game, combat, refused, rmb, click } = world();
    click();
    step(game, 0.1);
    expect(combat.swing).toBe(null);
    expect(refused).toEqual(['hold right mouse to ready']);
    rmb(true);
    step(game, 0.1);
    click();
    step(game, 1 / 30);
    expect(combat.swing).not.toBe(null);
  });

  it('holding LMB without RMB never swings; holding both repeats', () => {
    const { game, combat, input, rmb } = world();
    input.mouseButtons = 1;
    step(game, 1);
    expect(combat.swing).toBe(null);
    rmb(true);
    let swings = 0;
    const begin = combat.beginSwing.bind(combat);
    combat.beginSwing = () => (swings++, begin());
    step(game, 4);
    expect(swings).toBeGreaterThanOrEqual(2);
  });

  it('readied walks at readyMoveMul, restored on release; Shift + movement lowers it to run', () => {
    const { game, combat, input, rmb } = world();
    const p = game.player;
    step(game, 0.1);
    expect(p.moveSpeedMul).toBe(1);
    rmb(true);
    step(game, 0.1);
    expect(p.moveSpeedMul).toBeCloseTo(FEEL.readyMoveMul);
    input.held.add('ShiftLeft');
    input.held.add('KeyS');
    step(game, 0.1);
    expect(combat.stance?.ready).toBe(false);
    expect(p.moveSpeedMul).toBe(1);
    input.held.delete('ShiftLeft');
    step(game, 0.1);
    expect(combat.stance?.ready).toBe(true);
    // re-raised after the run: a fresh raise, so the parry clock restarted
    expect(defenseOf(p).guardAge).toBeLessThan(0.2);
    rmb(false);
    step(game, 0.1);
    expect(p.moveSpeedMul).toBe(1);
    expect(defenseOf(p).guarding).toBe(false);
  });

  it('releasing RMB mid-swing: the swing still lands, but no new one starts', () => {
    const { game, sys, combat, rmb, click, attacks } = world();
    const z = sys.spawnById('mon_zombie', 12.5, 11.5, 0)!;
    z.hp = 1000;
    z.attackCooldown = 999;
    for (const s of z.specials) s.cooldown = 999;
    game.player.yaw = 0;
    rmb(true);
    step(game, 0.05);
    click();
    step(game, 1 / 30);
    expect(combat.swing).not.toBe(null);
    rmb(false);
    step(game, 2);
    expect(attacks.length).toBe(1);
    expect(combat.swing).toBe(null);
    click();
    step(game, 1);
    expect(attacks.length).toBe(1);
  });

  it('the guard is down during your own swing and comes back after it without a free parry', () => {
    const { game, combat, rmb, click } = world();
    const def = defenseOf(game.player);
    rmb(true);
    step(game, 1 / 30);
    expect(guardScoreBonus(def).parry).toBe(true); // a fresh raise is a parry
    click();
    step(game, 2 / 30); // (the stance is taken before the click starts the swing: one tick later)
    expect(def.guarding).toBe(false);
    for (let i = 0; i < 200 && combat.swing; i++) step(game, 1 / 30);
    step(game, 1 / 30);
    expect(def.guarding).toBe(true);
    expect(guardScoreBonus(def).parry).toBe(false);
  });

  it('downed: you can ready and swing from the ground but not guard', () => {
    const { game, combat, rmb, click } = world();
    game.player.addEffect('downed', 100);
    rmb(true);
    step(game, 1 / 30);
    expect(combat.stance).toMatchObject({ ready: true, guarding: false });
    click();
    step(game, 1 / 30);
    expect(combat.swing).not.toBe(null);
  });

  it('a gun, a menu or death drops the stance and its slowdown', () => {
    const { game, combat, input, rmb } = world();
    const p = game.player;
    rmb(true);
    step(game, 0.1);
    expect(p.moveSpeedMul).toBeCloseTo(FEEL.readyMoveMul);
    p.inv.wield(createItem(data, 'glock_19'), null);
    step(game, 0.1);
    expect(combat.stance).toBe(null);
    expect(p.moveSpeedMul).toBe(1);
    expect(defenseOf(p).guarding).toBe(false);
    p.inv.wield(createItem(data, 'bat'), null);
    step(game, 0.1);
    expect(combat.stance?.ready).toBe(true);
    (input as { captured: boolean }).captured = true;
    step(game, 0.1);
    expect(combat.stance).toBe(null);
    expect(p.moveSpeedMul).toBe(1);
  });

  it('side-stepping while readied keeps the stance', () => {
    const { game, combat, rmb } = world();
    rmb(true);
    step(game, 0.1);
    expect(combat.sidestep('Space')).toBe(true);
    step(game, 0.3);
    expect(combat.stance?.ready).toBe(true);
  });

  it('the classic control swings from the hip and guards only on RMB (no slowdown otherwise)', () => {
    setMeleeControl('anytime');
    const { game, combat, rmb, click, refused } = world();
    click();
    step(game, 1 / 30);
    expect(combat.swing).not.toBe(null);
    expect(refused).toEqual([]);
    expect(game.player.moveSpeedMul).toBe(1);
    for (let i = 0; i < 200 && combat.swing; i++) step(game, 1 / 30);
    rmb(true);
    step(game, 0.1);
    expect(defenseOf(game.player).guarding).toBe(true);
    expect(game.player.moveSpeedMul).toBeCloseTo(FEEL.guardMoveMul);
  });
});

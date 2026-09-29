// Difficulty presets (src/game/difficulty.ts, wiring in src/difficulty.ts) and the tactical
// pause state machine (src/game/pause.ts): what each knob reaches, persistence per world, the
// progression hook, permadeath, and pausing that doesn't undo itself.
import { afterEach, describe, expect, it } from 'vitest';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import { TestGenerator } from '../src/world/testgen';
import { WorldGenerator } from '../src/world/worldgen';
import { MonsterSystem } from '../src/game/monai';
import { Spawner } from '../src/game/spawner';
import { Character, THIRST } from '../src/game/character';
import { BALANCE } from '../src/game/balance';
import { FEEL, FEEL_PRESETS, setFeelDifficulty } from '../src/game/combatfeel';
import { clockScale, CLOCK_SCALE, getClockRate, setClockRate } from '../src/core/time';
import { turnsToEffectSeconds } from '../src/game/monster';
import {
  applyDifficultySettings, cycleKnob, difficultyState, DIFFICULTY_PRESETS, knob, KNOBS, matchingPreset, permadeath, registerDifficultyTargets,
  settingsFor, validateSettings, type DifficultySettings,
} from '../src/game/difficulty';
import { installDifficulty, setWorldDifficulty } from '../src/difficulty';
import { applyDifficulty, DIFFICULTIES } from '../src/progression/difficulty';
import { TacticalPause, tacticalPauseOf } from '../src/game/pause';
import { registerCoreSaveables } from '../src/save/builtins';
import { registerSaveable } from '../src/save/registry';
import { applySave, serializeGame } from '../src/save/format';
import { SaveManager } from '../src/save/manager';
import { MemoryBackend } from '../src/save/storage';
import { installChunkTracking } from '../src/save/tracking';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

const { game: data, wg } = loadNodeData();

function fakeInput(): Input {
  return {
    held: new Set<string>(), captured: false, captureTimeFlows: false, mouseButtons: 0, onPress() {}, onPriorityPress() {},
    capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [],
  } as unknown as Input;
}

function build(seed = 7) {
  const game = new Game(data, seed, fakeInput());
  installChunkTracking(game);
  game.map.generator = new TestGenerator();
  const sys = new MonsterSystem(game);
  const spawner = new Spawner(sys, null);
  game.systems.push(sys);
  spawner.install();
  registerCoreSaveables(game, { monsters: { sys, spawner }, worldgen: null });
  installDifficulty(game, { spawner });
  return { game, sys, spawner };
}

afterEach(() => {
  // Module-level live knobs: leave them as BN's for the other test files.
  BALANCE.monsterSpeed = 1;
  BALANCE.crashDamage = 1;
  setClockRate(1);
  setFeelDifficulty('accessible');
});

describe('difficulty presets', () => {
  it('both presets are complete, valid and distinct; Classic keeps the real-time spawn easing and BN needs', () => {
    for (const id of ['accessible', 'classic'] as const) {
      const s = DIFFICULTY_PRESETS[id];
      expect(validateSettings(s)).toEqual(s);
      expect(matchingPreset({ ...s })).toBe(id);
      for (const k of KNOBS) expect(k.choices, `${id}.${k.key} must be one of its knob choices`).toContain(s[k.key]);
    }
    const c = DIFFICULTY_PRESETS.classic;
    expect([c.hunger, c.thirst, c.fatigue, c.healing, c.cold, c.bleed, c.monsterSpeed, c.dayLength]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(c.spawnScale).toBe(0.75);
    expect(c.hordeScale).toBe(0.2);
    expect(c.permadeath).toBe(true);
    expect(c.pauseInMenus).toBe(false);
    const a = DIFFICULTY_PRESETS.accessible;
    expect(a.pauseInMenus).toBe(true);
    expect(a.feel).toBe('accessible');
    expect(a.spawnScale).toBeLessThan(c.spawnScale);
    expect(a.safeRadius).toBeGreaterThan(c.safeRadius);
    // Custom is a real, pickable choice in the new-game flow now.
    expect(DIFFICULTIES.find((d) => d.id === 'custom')?.unavailable).toBeUndefined();
  });

  it('refuses malformed settings loudly', () => {
    expect(() => validateSettings({ ...DIFFICULTY_PRESETS.classic, thirst: 'lots' })).toThrow(/thirst/);
    expect(() => validateSettings({ ...DIFFICULTY_PRESETS.classic, feel: 'nightmare' })).toThrow(/feel/);
    const { hunger: _, ...missing } = DIFFICULTY_PRESETS.classic;
    expect(() => validateSettings(missing)).toThrow(/hunger/);
    expect(() => validateSettings({ ...DIFFICULTY_PRESETS.classic, dayLength: 0 })).toThrow(/dayLength/);
  });

  it('cycles knob values, snapping odd values to their neighbours', () => {
    const k = knob('safeRadius');
    expect(cycleKnob(k, 10, 1)).toBe(16);
    expect(cycleKnob(k, 10, -1)).toBe(5);
    expect(cycleKnob(k, 48, 1)).toBe(0);
    expect(cycleKnob(k, 12, 1)).toBe(16);
    expect(cycleKnob(k, 12, -1)).toBe(10);
    expect(cycleKnob(knob('permadeath'), true, 1)).toBe(false);
  });

  it('applying a preset reaches every system: spawner, map, monsters, feel, survivor, clock, menus, ui2', () => {
    const { game, spawner } = build();
    let ui2Pause: boolean | null = null;
    registerDifficultyTargets(game, { setPauseInInventory: (on) => void (ui2Pause = on) });
    const s: DifficultySettings = { ...DIFFICULTY_PRESETS.accessible, monsterSpeed: 0.85, dayLength: 1.5, itemSpawnRate: 0.5 };
    applyDifficultySettings(game, 'custom', s);
    expect(spawner.opts.realtimeScale).toBe(s.spawnScale);
    expect(spawner.opts.cityHordeScale).toBe(s.hordeScale);
    expect(spawner.opts.safeRadius).toBe(s.safeRadius);
    expect(spawner.opts.dormantSafe).toBe(true);
    expect(game.map.itemSpawnRate).toBe(0.5);
    expect(BALANCE.monsterSpeed).toBe(0.85);
    expect(BALANCE.crashDamage).toBe(s.crashDamage);
    expect(FEEL.telegraph).toBe(FEEL_PRESETS.accessible.telegraph);
    expect(game.player.balance).toEqual({ hunger: s.hunger, thirst: s.thirst, fatigue: s.fatigue, healing: s.healing, bleed: s.bleed, cold: s.cold });
    expect(getClockRate()).toBeCloseTo(1 / 1.5);
    expect(game.pauseInMenus).toBe(true);
    expect(ui2Pause).toBe(true);
    expect(difficultyState(game)?.preset).toBe('custom');

    applyDifficultySettings(game, 'classic', settingsFor('classic'));
    expect(FEEL.telegraph).toBe(FEEL_PRESETS.classic.telegraph);
    expect(game.pauseInMenus).toBe(false);
    expect(ui2Pause).toBe(false);
    expect(BALANCE.monsterSpeed).toBe(1);
    expect(getClockRate()).toBe(1);
    expect(permadeath(game)).toBe(true);
  });

  it('a game nobody configured keeps BN numbers and permadeath', () => {
    const game = new Game(data, 3, fakeInput());
    expect(difficultyState(game)).toBeNull();
    expect(permadeath(game)).toBe(true);
    expect(game.player.balance.thirst).toBe(1);
  });
});

describe('knobs in the simulation', () => {
  it('needs multipliers scale hunger, thirst and fatigue per 5 minutes', () => {
    const day = (mul: number) => {
      const c = new Character(data, { seed: 5 });
      c.balance = { ...c.balance, hunger: mul, thirst: mul, fatigue: mul };
      c.thirst = 0;
      c.sleepiness = 0;
      const kcal0 = c.storedKcal;
      for (let i = 0; i < 12 * 60; i++) c.update(60);
      return { thirst: c.thirst, kcal: kcal0 - c.storedKcal, sleepiness: c.sleepiness };
    };
    const bn = day(1), half = day(0.5);
    expect(bn.thirst).toBeGreaterThan(THIRST.THIRSTY);
    expect(half.thirst / bn.thirst).toBeCloseTo(0.5, 1);
    expect(half.kcal / bn.kcal).toBeCloseTo(0.5, 1);
    expect(half.sleepiness / bn.sleepiness).toBeCloseTo(0.5, 1);
  });

  it('cold eases only the cold side of body temperature', () => {
    const c = new Character(data, { seed: 5 });
    c.env = { temperature: -5, wind: 20, precipitation: false };
    const bn = c.bodyTempTarget('torso');
    c.balance = { ...c.balance, cold: 0.5 };
    const eased = c.bodyTempTarget('torso');
    expect(eased).toBeGreaterThan(bn + 2);
    c.env = { temperature: 35, wind: 0, precipitation: false };
    const hot = c.bodyTempTarget('torso');
    c.balance = { ...c.balance, cold: 1 };
    expect(c.bodyTempTarget('torso')).toBeCloseTo(hot);
  });

  it('healing multiplier speeds natural regeneration', () => {
    const heal = (mul: number) => {
      const c = new Character(data, { seed: 9 });
      c.balance = { ...c.balance, healing: mul };
      c.hp.arm_l.cur = 1;
      // Tired enough to stay asleep the whole time (a rested sleeper wakes at once).
      c.sleepiness = 600;
      c.fallAsleep(12 * 3600);
      for (let i = 0; i < 8 * 60; i++) c.update(60);
      return c.hp.arm_l.cur - 1;
    };
    expect(heal(2)).toBeGreaterThanOrEqual(2 * heal(1) - 1);
    expect(heal(1)).toBeGreaterThan(0);
  });

  it('monster speed scales walking; day length keeps real-time effect durations', () => {
    const { game, sys } = build();
    const m = sys.spawn(data.monsters.mon_zombie, 12.5, 12.5, 0);
    BALANCE.monsterSpeed = 1;
    const v = m.moveSpeed(100);
    BALANCE.monsterSpeed = 0.8;
    expect(m.moveSpeed(100)).toBeCloseTo(v * 0.8);
    // A 2-turn stun lasts 2/ACTION_SCALE real seconds at any day length.
    setClockRate(0.5);
    expect(clockScale()).toBe(CLOCK_SCALE / 2);
    const realSeconds = turnsToEffectSeconds(2) / clockScale();
    setClockRate(1);
    expect(turnsToEffectSeconds(2) / clockScale()).toBeCloseTo(realSeconds);
    const t0 = game.clock.seconds;
    setClockRate(0.5);
    game.clock.advanceReal(10);
    expect(game.clock.seconds - t0).toBeCloseTo(10 * CLOCK_SCALE * 0.5);
  });

  it('item spawn rate thins whole mapgen spawns deterministically', () => {
    const count = (rate: number, seed: number) => {
      const map = makeMap(data, seed);
      const gen = new WorldGenerator(seed, wg, data);
      gen.stats.quiet = true;
      map.generator = gen;
      map.itemSpawnRate = rate;
      const st = gen.findStartLocation('shelter', map);
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) for (const items of map.chunk(st.omx + dx, st.omy + dy, 0)!.items.values()) n += items.length;
      return n;
    };
    const full = count(1, 11), half = count(0.5, 11);
    expect(half).toBeLessThan(full * 0.7);
    expect(half).toBeGreaterThan(full * 0.3);
    expect(count(0.5, 11)).toBe(half);
  });
});

describe('difficulty persistence', () => {
  it('Custom rules round-trip through the save and beat progression\'s stale hook on load', () => {
    // Stand-in for progression's section (order 65), which re-applies the run's recorded
    // preset on load; its record says 'accessible' (stale: changed mid-run in Options).
    const progLike = (g: Game) => registerSaveable<string>(g, 'progression-like', { order: 65, save: () => 'accessible', load: (d) => applyDifficulty(g, d as 'accessible') });
    const A = build();
    progLike(A.game);
    const custom: DifficultySettings = { ...DIFFICULTY_PRESETS.classic, thirst: 0.5, safeRadius: 32, pauseInMenus: true };
    setWorldDifficulty(A.game, 'custom', custom);
    const file = serializeGame(A.game, { slot: 's', name: 'x', gen: 'test' });
    expect((file.sections.difficulty as { preset: string }).preset).toBe('custom');

    const B = build();
    progLike(B.game);
    applyDifficultySettings(B.game, 'accessible', settingsFor('accessible'));
    applySave(B.game, file);
    expect(difficultyState(B.game)).toEqual({ preset: 'custom', settings: custom });
    expect(B.spawner.opts.safeRadius).toBe(32);
    expect(B.game.player.balance.thirst).toBe(0.5);

    // A later new game through the progression hook applies its own choice.
    applyDifficulty(B.game, 'classic');
    expect(difficultyState(B.game)?.preset).toBe('classic');
  });

  it('a damaged difficulty section falls back to its preset and says so', () => {
    const A = build();
    setWorldDifficulty(A.game, 'classic', settingsFor('classic'));
    const file = serializeGame(A.game, { slot: 's', name: 'x', gen: 'test' });
    (file.sections.difficulty as { settings: Record<string, unknown> }).settings.hunger = 'much';
    const B = build();
    const res = applySave(B.game, file);
    expect(res.warnings.join(' ')).toMatch(/hunger/);
    expect(difficultyState(B.game)).toEqual({ preset: 'classic', settings: settingsFor('classic') });
  });

  it('without permadeath the last save survives death; with it, it is deleted', async () => {
    for (const perma of [false, true]) {
      const backend = new MemoryBackend();
      const A = build();
      setWorldDifficulty(A.game, 'custom', { ...DIFFICULTY_PRESETS.accessible, permadeath: perma });
      const mgr = new SaveManager(A.game, { backend, gen: 'test' });
      mgr.active = true;
      await mgr.save();
      A.game.events.emit('playerDied', { cause: 'zombie' });
      await new Promise((r) => setTimeout(r, 0));
      await mgr.memorial();
      await new Promise((r) => setTimeout(r, 0));
      expect((await backend.keys('save/')).length, `permadeath ${perma}`).toBe(perma ? 0 : 1);
      expect(await mgr.memorial()).toHaveLength(1);
    }
  });
});

describe('tactical pause', () => {
  it('the key and menu holds are independent: closing a menu never cancels a manual pause', () => {
    const game = new Game(data, 1, fakeInput());
    const tp = new TacticalPause(game);
    expect(tp.paused).toBe(false);
    tp.toggle();
    expect(game.tacticalPause).toBe(true);
    tp.hold('menus', true);
    tp.hold('menus', false);
    expect(game.tacticalPause).toBe(true);
    tp.toggle();
    expect(game.tacticalPause).toBe(false);
    // Unpausing by key while an auto-pausing menu is open keeps time stopped until it closes.
    tp.hold('menus', true);
    tp.toggle();
    tp.toggle();
    expect(tp.manual).toBe(false);
    expect(game.tacticalPause).toBe(true);
    tp.hold('menus', false);
    expect(game.tacticalPause).toBe(false);
    expect(() => tp.hold('', true)).toThrow();
  });

  it('death clears it; a dead survivor cannot pause', () => {
    const game = new Game(data, 1, fakeInput());
    const tp = tacticalPauseOf(game);
    expect(tacticalPauseOf(game)).toBe(tp);
    tp.toggle();
    tp.hold('menus', true);
    tp.clear();
    expect(game.tacticalPause).toBe(false);
    game.player.dead = true;
    tp.toggle();
    expect(tp.paused).toBe(false);
  });

  it('while paused the world stands still but the view still turns', () => {
    const input = fakeInput() as unknown as { consumeMouse: () => [number, number] };
    const game = new Game(data, 1, input as unknown as Input);
    game.map.generator = new TestGenerator();
    tacticalPauseOf(game).toggle();
    const t0 = game.clock.seconds, yaw0 = game.player.yaw;
    input.consumeMouse = () => [100, 0];
    for (let i = 0; i < 30; i++) game.frame(1 / 30);
    expect(game.clock.seconds).toBe(t0);
    expect(game.player.yaw).not.toBe(yaw0);
    tacticalPauseOf(game).toggle();
    for (let i = 0; i < 30; i++) game.frame(1 / 30);
    expect(game.clock.seconds).toBeGreaterThan(t0);
  });

  it('the pause key does not collide with any other default binding', async () => {
    const { DEFAULT_BINDINGS } = await import('../src/ui/keys');
    const keys = DEFAULT_BINDINGS.tactical_pause;
    expect(keys).toContain('`');
    for (const [id, ks] of Object.entries(DEFAULT_BINDINGS)) if (id !== 'tactical_pause') for (const k of keys) expect(ks, `${id} uses ${k}`).not.toContain(k);
  });
});

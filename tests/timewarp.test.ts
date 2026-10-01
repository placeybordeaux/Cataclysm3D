// Fast-forward (src/game/timewarp.ts): more ticks per real second, never longer ticks, so an
// activity at ×8 comes out exactly as at ×1 — same game time, same interrupt, same messages —
// and the governor caps the speed to what a frame can afford.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game, TICK } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { createItem } from '../src/game/item';
import { findRecipe, startCraft } from '../src/game/crafting';
import { chaptersToLevel, startReading } from '../src/game/reading';
import { goToSleep, installRest, waitFor } from '../src/game/rest';
import { SPEED_STEPS, WarpGovernor, installTimeWarp, nextSpeed, timeWarp } from '../src/game/timewarp';
import { speedLabel, speedLine } from '../src/ui/timewarp_ui';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: load('recipes.json'), misc: load('misc.json'),
  };
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}

interface Snapshot {
  tick: number;
  seconds: number;
  fraction: number;
  log: string[];
  hp: number;
  zombie: string | null;
  survival: string;
}

/**
 * A noon field with the monster AI, the "You see a zombie!" interrupt (as src/monsters.ts
 * registers it), rest and fast-forward. `spawnAt`: the tick a zombie walks in `zombieDist`
 * tiles north.
 */
function world(spawnAt: number, zombieDist: number) {
  const game = new Game(data, 11, fakeInput());
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  game.systems.push(sys, new PlayerCombat(game, sys));
  game.activities.dangerChecks.push(() => {
    const m = sys.visibleHostile(30);
    return m ? `You see a ${m.displayName()}!` : null;
  });
  installRest(game);
  installTimeWarp(game);
  game.clock.seconds = 12 * 3600;
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  let tick = 0;
  let zombie: ReturnType<MonsterSystem['spawnById']> = null;
  let snap: Snapshot | null = null;
  const take = (a = game.activities.current): Snapshot => ({
    tick, seconds: +game.clock.seconds.toFixed(6), fraction: +(a?.fraction ?? 1).toFixed(6), log: [...log],
    hp: Object.values(game.player.hp).reduce((s, h) => s + h.cur, 0),
    zombie: zombie ? `${zombie.x.toFixed(4)},${zombie.y.toFixed(4)}` : null,
    survival: JSON.stringify(game.player.skills.survival ?? null),
  });
  game.activities.cancelHooks.push((a) => void (snap ??= take(a)));
  let had = false;
  game.systems.push({
    name: 'test-script',
    update() {
      tick++;
      if (tick === spawnAt) zombie = sys.spawnById('mon_zombie', 12.5, 12.5 - zombieDist, 0);
      // Finished without an interrupt (or woke up): the outcome is where it stands now.
      if (had && !game.activities.current) snap ??= take();
      had = !!game.activities.current;
    },
  });
  return { game, sys, log, snapshot: () => snap, take, ticks: () => tick };
}

/**
 * Real 60 Hz frames at `speed` until the activity ends. Also checks that once the speed dropped
 * to ×1, no frame ran more ticks than ×1 would (the leftover fast debt is converted back).
 */
function play(w: ReturnType<typeof world>, speed: number, maxFrames = 60 * 600): Snapshot {
  const tw = timeWarp(w.game);
  if (speed > 1) tw.set(speed);
  expect(w.game.simSpeed).toBe(speed);
  for (let f = 0; f < maxFrames && !w.snapshot(); f++) {
    const before = w.ticks();
    const wasFast = w.game.simSpeed > 1;
    w.game.frame(1 / 60);
    if (!wasFast) expect(w.ticks() - before).toBeLessThanOrEqual(1);
  }
  const s = w.snapshot();
  expect(s, 'the activity never ended').not.toBeNull();
  return s!;
}

/** Run the same scenario at ×1 and ×8; both must end the same way at the same game time. */
function compare(setup: (w: ReturnType<typeof world>) => void, spawnAt: number, zombieDist: number): { x1: Snapshot; x8: Snapshot; after: ReturnType<typeof world> } {
  const a = world(spawnAt, zombieDist);
  setup(a);
  const x1 = play(a, 1);
  const b = world(spawnAt, zombieDist);
  setup(b);
  const x8 = play(b, 8);
  expect(x8).toEqual(x1);
  if (process.env.TW_DEBUG) console.log(JSON.stringify({ ...x1, log: x1.log.slice(-8) }));
  return { x1, x8, after: b };
}

describe('fast-forward: ×8 ends exactly like ×1', () => {
  it('waiting: a zombie walks into view, the wait stops at the same game second and the speed drops to ×1', () => {
    const { x1, after } = compare((w) => expect(waitFor(w.game, 6 * 3600)).toBe(true), 150, 25);
    expect(x1.log.at(-1)).toBe('You see a zombie!');
    expect(x1.seconds - 12 * 3600).toBeGreaterThan(60);
    expect(after.game.activities.current).toBeNull();
    expect(after.game.simSpeed).toBe(1);
    expect(timeWarp(after.game).requested).toBe(1);
    expect(timeWarp(after.game).dropped).toBe('You see a zombie!');
  });

  it('reading until done: interrupted mid-chapter by a zombie, same skill progress', () => {
    const { x1 } = compare((w) => {
      const mag = createItem(data, 'mag_survival');
      w.game.player.inv.giveNew(mag);
      expect(startReading(w.game, mag, 'until_done')).toBe(true);
    }, 400, 25);
    expect(x1.log.at(-1)).toBe('You see a zombie!');
    expect(x1.survival).not.toBe('null');
  });

  it('crafting a wooden spear: the zombie interrupts at the same fraction', () => {
    const { x1 } = compare((w) => {
      const p = w.game.player;
      p.setSkill('fabrication', 2);
      p.setSkill('survival', 1);
      p.inv.wear(createItem(data, 'backpack'), null);
      for (const [id, n] of [['knife_folding'], ['sandpaper'], ['rag'], ['thread', 50]] as [string, number?][]) p.inv.giveNew(createItem(data, id, n !== undefined ? { count: n } : {}));
      w.game.map.addItem(13, 12, 0, createItem(data, 'stick_long'));
      w.game.map.addField(11, 11, 0, 'fd_fire', 1);
      const res = startCraft(w.game, findRecipe(data, 'spear_wood')!);
      expect(res.ok, res.msg).toBe(true);
    }, 60, 25);
    expect(x1.log.at(-1)).toBe('You see a zombie!');
    expect(x1.fraction).toBeGreaterThan(0);
    expect(x1.fraction).toBeLessThan(1);
  });

  it('sleeping: a zombie walks up and attacks; it wakes the sleeper at the same moment and drops to ×1', () => {
    const { x1, after } = compare((w) => {
      w.game.player.sleepiness = 400;
      expect(goToSleep(w.game)).toBe(true);
    }, 300, 4);
    // BN on_hurt: the first blow wakes you (and drops the speed to ×1)
    const firstHit = x1.log.findIndex((l) => /^The zombie (hits|bites|claws|grabs)/.test(l));
    expect(firstHit).toBeGreaterThanOrEqual(0);
    expect(x1.log.slice(firstHit)).toContain('You wake up.');
    expect(x1.log.slice(firstHit).filter((l) => /^The zombie/.test(l)).length).toBeLessThanOrEqual(2);
    expect(after.game.simSpeed).toBe(1);
  });

  it('a frame at ×8 runs 8× the ticks of a frame at ×1, each the same 1/30 s tick', () => {
    const w = world(1e9, 0);
    expect(waitFor(w.game, 6 * 3600)).toBe(true);
    timeWarp(w.game).set(8);
    const t0 = w.ticks(), s0 = w.game.clock.seconds, warp = w.game.clock.warp;
    // half a real second: 4 s of the wait's ~8 at ×1
    for (let f = 0; f < 30; f++) w.game.frame(1 / 60);
    expect(w.game.activities.current).not.toBeNull();
    const n = w.ticks() - t0;
    expect(n).toBeGreaterThanOrEqual(8 * 15 - 1);
    expect(n).toBeLessThanOrEqual(8 * 15 + 1);
    // game seconds per tick unchanged: TICK × clockScale × the activity's own warp
    expect((w.game.clock.seconds - s0) / n).toBeCloseTo(TICK * 24 * warp, 6);
  });

  it('being hurt stops an activity (BN on_hurt) and drops to ×1; hunger getting worse drops to ×1 without stopping', () => {
    const w = world(1e9, 0);
    expect(waitFor(w.game, 6 * 3600)).toBe(true);
    timeWarp(w.game).set(4);
    w.game.events.emit('playerHurt', { amount: 3, bp: 'torso' });
    expect(w.game.activities.current).toBeNull();
    expect(w.log.at(-1)).toBe('You were hurt!');
    expect(w.game.simSpeed).toBe(1);

    expect(waitFor(w.game, 6 * 3600)).toBe(true);
    w.game.tick(TICK);
    timeWarp(w.game).set(4);
    w.game.player.thirst = 300;
    w.game.tick(TICK);
    expect(w.game.player.thirstDescription()).toBe('Very Thirsty');
    expect(w.game.activities.current).not.toBeNull();
    expect(w.game.simSpeed).toBe(1);
    expect(timeWarp(w.game).dropped).toMatch(/^You feel /);
  });

  it('fast-forward only exists while a warped activity runs; the speed resets when it ends', () => {
    const w = world(1e9, 0);
    expect(timeWarp(w.game).available()).toBe(false);
    expect(timeWarp(w.game).cycle()).toBe(1);
    expect(waitFor(w.game, 60)).toBe(true);
    expect(timeWarp(w.game).cycle()).toBe(2);
    expect(timeWarp(w.game).cycle()).toBe(4);
    for (let f = 0; f < 600 && w.game.activities.current; f++) w.game.frame(1 / 60);
    expect(w.game.activities.current).toBeNull();
    expect(w.game.simSpeed).toBe(1);
    expect(timeWarp(w.game).requested).toBe(1);
  });

  it('the Rest window arms a speed that the next wait picks up', () => {
    const w = world(1e9, 0);
    timeWarp(w.game).arm(8);
    expect(waitFor(w.game, 3600)).toBe(true);
    w.game.tick(TICK);
    expect(w.game.simSpeed).toBe(8);
  });
});

describe('fast-forward cap (WarpGovernor)', () => {
  it('cycles ×1 → ×2 → ×4 → ×8 → ×16 → ×1', () => {
    const seen = [1];
    for (let i = 0; i < SPEED_STEPS.length; i++) seen.push(nextSpeed(seen.at(-1)!));
    expect(seen).toEqual([1, 2, 4, 8, 16, 1]);
  });

  it('a cheap tick on a fast machine: no cap', () => {
    const g = new WarpGovernor();
    for (let i = 0; i < 60; i++) g.observe(0.1, 1, 6, 1 / 60);
    expect(g.cap).toBe(16);
  });

  it('caps so drawing + ticks stay under 25 ms a frame', () => {
    const g = new WarpGovernor();
    // 2 ms a tick, 9 ms drawing, 60 Hz (half a tick per frame at ×1): (25 - 9) / 2 = 8 ticks = ×16 → fits;
    // 4 ms a tick: 4 ticks a frame = ×8.
    for (let i = 0; i < 60; i++) g.observe(4, 1, 9, 1 / 60);
    expect(g.cap).toBe(8);
    // drawing gets expensive: (25 - 17) / 4 = 2 ticks = ×4
    for (let i = 0; i < 60; i++) g.observe(4, 1, 17, 1 / 60);
    expect(g.cap).toBe(4);
  });

  it('never caps below ×1, even when a frame is over budget already', () => {
    const g = new WarpGovernor();
    for (let i = 0; i < 30; i++) g.observe(20, 1, 40, 1 / 20);
    expect(g.cap).toBe(1);
  });

  it('falls at once, rises one step at a time after half a second of room', () => {
    const g = new WarpGovernor();
    for (let i = 0; i < 60; i++) g.observe(8, 1, 9, 1 / 60);
    expect(g.cap).toBe(4);
    const caps: number[] = [];
    for (let i = 0; i < 420; i++) {
      g.observe(0.5, 1, 9, 1 / 60);
      caps.push(g.cap);
    }
    expect(caps.at(-1)).toBe(16);
    // monotone, one step at a time, at most one step per 0.5 s (30 frames)
    for (let i = 1; i < caps.length; i++) expect(caps[i] - caps[i - 1]).toBeLessThanOrEqual(1);
    const firstRise = caps.findIndex((c) => c > 4);
    expect(firstRise).toBeGreaterThanOrEqual(29);
  });

  it('a skipped draw (Lighter mode) teaches nothing about drawing cost', () => {
    const g = new WarpGovernor();
    for (let i = 0; i < 60; i++) g.observe(2, 4, 12, 1 / 60);
    const other = g.otherMs;
    for (let i = 0; i < 60; i++) g.observe(2, 4, null, 1 / 60);
    expect(g.otherMs).toBe(other);
  });

  it('rejects nonsense samples loudly', () => {
    expect(() => new WarpGovernor().observe(NaN, 1, 1, 1 / 60)).toThrow();
    expect(() => new WarpGovernor().observe(1, 1, 1, 0)).toThrow();
  });

  it('the ring line says the speed, the cap and the time left', () => {
    expect(speedLabel(8, 8)).toBe('×8');
    expect(speedLabel(8, 5)).toBe('×8 (capped ×5)');
    expect(speedLine({ name: 'reading Outdoor Adventures', wanted: 4, effective: 4, gameLeft: 1200, realLeft: 3, sleeping: false, clock: '' })).toBe('Reading · ×4 · 20 min left (~3 s)');
    expect(speedLine({ name: 'sleeping', wanted: 8, effective: 5, gameLeft: 0, realLeft: 0, sleeping: true, clock: '03:12' })).toBe('Sleeping · ×8 (capped ×5) · 03:12');
  });
});

describe('reading progress estimate', () => {
  it('chapters to the next level and to the book\'s max, from BN\'s experience formula', () => {
    const game = new Game(data, 3, fakeInput());
    const mag = createItem(data, 'mag_survival');
    const est = chaptersToLevel(game.player, mag)!;
    expect(est.nextLevel).toBe(1);
    expect(est.next).toBeGreaterThanOrEqual(1);
    expect(est.done).toBeGreaterThanOrEqual(est.next);
    game.player.setSkill('survival', est.maxLevel);
    expect(chaptersToLevel(game.player, mag)).toBeNull();
  });
});

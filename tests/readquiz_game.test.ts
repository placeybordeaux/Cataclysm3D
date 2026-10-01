// The reading minigame around a real reading activity (docs/ADAPTATION.md "Reading: field
// notes"): rewards, cooldowns, the "You know this" skim, interrupts, fast-forward, the skim
// game, and the tuning target (a good player reads about twice as fast).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { GameClock, clockScale } from '../src/core/time';
import type { GameData } from '../src/data/types';
import { ActivityManager } from '../src/game/activity';
import type { CraftHost } from '../src/game/crafting';
import { createItem, type Item } from '../src/game/item';
import { PlayerAvatar } from '../src/game/player';
import { reading, skillProgress, startReading, type ReadMode } from '../src/game/reading';
import { ReadQuizController, knowsBook } from '../src/game/readquiz/controller';
import { TUNING, type ReadingGame } from '../src/game/readquiz/session';
import { GameMap } from '../src/world/map';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: load('terrain.json'),
  furniture: load('furniture.json'),
  items: load('items.json'),
  itemGroups: load('item_groups.json'),
  monsters: {},
  monsterGroups: {},
  recipes: load('recipes.json'),
  misc: load('misc.json'),
};

interface Host extends CraftHost {
  log: string[];
  simSpeed: number;
}

/** Flat dirt, survivor at (5, 5), 8 AM (the crafting tests' world). */
function world(seed = 7): Host {
  const map = new GameMap(1);
  for (const t of Object.values(data.terrain)) map.terrain.add(t);
  for (const f of Object.values(data.furniture)) map.furniture.add(f);
  map.generator = { generate: (m, c) => c.ter.fill(m.terrain.index('t_dirt')) };
  const player = new PlayerAvatar(data, { seed });
  player.x = 5.5;
  player.y = 5.5;
  player.z = 0;
  const log: string[] = [];
  player.onMessage = (t) => log.push(t);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const host: any = { data, map, player, clock: new GameClock(), log, simSpeed: 1, input: { held: new Set(), captured: false }, message: (t: string) => log.push(t) };
  host.activities = new ActivityManager(host);
  return host as Host;
}

const FRAME = 1 / 30;
/** One real frame: the activity runs (simSpeed ticks of game time), then the quiz. */
function frame(h: Host, qc: ReadQuizController, paused = false): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!paused) for (let i = 0; i < h.simSpeed; i++) h.activities.update(h as any, FRAME, FRAME * clockScale() * h.clock.warp);
  qc.update(FRAME * 1000, paused);
}
function run(h: Host, qc: ReadQuizController, seconds: number): void {
  for (let t = 0; t < seconds && reading.current; t += FRAME) frame(h, qc);
}
function begin(h: Host, book: string, mode: ReadingGame = 'quiz', read: ReadMode = 'until_level') {
  reading.current = null;
  const it = createItem(data, book);
  expect(h.player.inv.giveNew(it)).not.toBeNull();
  const qc = new ReadQuizController(h, () => mode);
  expect(startReading(h, it, read)).toBe(true);
  return { it: it as Item, qc };
}

describe('reading minigame: rewards, cooldowns, skim, interrupts', { timeout: 120000 }, () => {
  it('a right answer jumps the chapter forward and practises the skill; a wrong one shows the answer and cools down', () => {
    const h = world();
    const { qc } = begin(h, 'cookbook');
    run(h, qc, TUNING.leadMs / 1000 + 0.1);
    const q = qc.quiz!;
    expect(q.phase).toBe('ask');
    expect(qc.live()).toBe(true);
    const a = h.activities.current!;
    const before = a.elapsed;
    const ex0 = h.player.skills.cooking?.exercise ?? 0;
    expect(qc.answer(q.question!.answer)).toBe('right');
    const jumped = a.elapsed - before;
    // 2.5 real seconds of reading at ×1, in game seconds through this chapter's own warp
    expect(jumped).toBeCloseTo(Math.min(TUNING.skipRealS * clockScale() * h.clock.warp, a.spec.duration * TUNING.skipMaxFrac, a.spec.duration - before), 5);
    expect(jumped).toBeGreaterThan(0);
    expect(qc.lastReward!.skippedS).toBeCloseTo(jumped, 5);
    expect((h.player.skills.cooking?.exercise ?? 0) - ex0).toBe(100); // 1 point × (level 0 + 1), stored ×100
    expect(qc.answer(0)).toBeNull(); // no double answers
    run(h, qc, TUNING.rightShowMs / 1000 + 0.1);
    expect(q.phase).toBe('ask');
    const wrong = (q.question!.answer + 1) % q.question!.options.length;
    const e1 = h.activities.current!.elapsed;
    expect(qc.answer(wrong)).toBe('wrong');
    expect(h.activities.current!.elapsed).toBe(e1); // no jump, no penalty
    expect(q.picked).toBe(wrong);
    expect(q.question).not.toBeNull(); // the right answer stays up to be read
    run(h, qc, (TUNING.cooldownMs - 300) / 1000);
    expect(q.phase).not.toBe('ask'); // still cooling down
    expect(qc.live()).toBe(false);
    run(h, qc, 0.5);
    expect(q.phase).toBe('ask');
    expect(qc.totals).toMatchObject({ right: 1, wrong: 1 });
  });

  it("practice never levels up by itself and stops at the book's max level", () => {
    const h = world();
    const { it, qc } = begin(h, 'mag_cooking');
    h.player.skills.cooking = { level: 0, exercise: 9990 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reward = (qc as any).reward.bind(qc) as (b: Item, s: number) => void;
    for (let i = 0; i < 50; i++) reward(it, 0);
    expect(h.player.getSkill('cooking')).toBe(0);
    expect(skillProgress(h.player, 'cooking')).toBeLessThan(1);
    h.player.setSkill('cooking', 1); // the magazine's max level
    const ex = h.player.skills.cooking.exercise;
    reward(it, 0);
    expect(h.player.skills.cooking.exercise).toBe(ex);
  });

  it('a jump never skips past the end of a chapter: the chapter still completes through the activity', () => {
    const h = world();
    const { qc } = begin(h, 'mag_cooking', 'quiz', 'once');
    run(h, qc, TUNING.leadMs / 1000 + 0.1);
    const a = h.activities.current!;
    a.elapsed = a.spec.duration - 1;
    qc.answer(qc.quiz!.question!.answer);
    expect(a.elapsed).toBe(a.spec.duration);
    expect(h.activities.current).toBe(a); // not completed behind the activity's back
    frame(h, qc);
    expect(h.activities.current).toBeNull();
    expect(h.log).toContain('You finish reading.');
  });

  it('already know it: "Skim it?" finishes the chapter at once, memorises its recipes, no skill', () => {
    const h = world();
    h.player.setSkill('cooking', 3);
    expect(knowsBook(h, createItem(data, 'cookbook'))).toBe(true);
    const { qc } = begin(h, 'cookbook');
    frame(h, qc);
    expect(qc.quiz!.phase).toBe('offer');
    expect(qc.live()).toBe(true);
    const known = h.player.learnedRecipes.size;
    expect(qc.answer(0)).toBe('skim');
    frame(h, qc);
    expect(reading.current).toBeNull();
    expect(h.activities.current).toBeNull();
    expect(h.player.getSkill('cooking')).toBe(3);
    expect(h.player.learnedRecipes.size).toBeGreaterThan(known);
    expect(qc.quiz).toBeNull();
  });

  it('declining the offer reads on with questions', () => {
    const h = world();
    h.player.setSkill('cooking', 3);
    const { qc } = begin(h, 'cookbook');
    frame(h, qc);
    expect(qc.answer(1)).toBe('read');
    run(h, qc, TUNING.leadMs / 1000 + 0.1);
    expect(qc.quiz!.phase).toBe('ask');
  });

  it('a book you still learn from gets no offer; a fun book gets no quiz', () => {
    const h = world();
    expect(knowsBook(h, createItem(data, 'cookbook'))).toBe(false);
    const { qc } = begin(h, 'novel_scifi');
    run(h, qc, 2);
    expect(qc.quiz).toBeNull();
    expect(qc.skim).toBeNull();
  });

  it('a zombie in view ends the reading and the quiz with it', () => {
    const h = world();
    const { qc } = begin(h, 'cookbook');
    run(h, qc, TUNING.leadMs / 1000 + 0.1);
    expect(qc.quiz!.phase).toBe('ask');
    h.activities.dangerChecks.push(() => 'You see a zombie!');
    frame(h, qc);
    expect(h.activities.current).toBeNull();
    expect(reading.current).toBeNull();
    expect(qc.quiz).toBeNull();
    expect(qc.live()).toBe(false);
    expect(qc.answer(0)).toBeNull();
    expect(h.log).toContain('You see a zombie!');
  });

  it('fast-forward pauses the quiz (no questions, frozen clocks, nothing to answer); back at ×1 it carries on', () => {
    const h = world();
    const { qc } = begin(h, 'cookbook');
    h.simSpeed = 4;
    run(h, qc, 3);
    expect(qc.frozen).toBe('fast');
    expect(qc.quiz!.phase).toBe('wait');
    expect(qc.quiz!.t).toBe(0);
    h.simSpeed = 1;
    run(h, qc, TUNING.leadMs / 1000 + 0.1);
    expect(qc.frozen).toBeNull();
    expect(qc.quiz!.phase).toBe('ask');
    const q = qc.quiz!.question;
    h.simSpeed = 8;
    frame(h, qc);
    expect(qc.live()).toBe(false);
    expect(qc.answer(q!.answer)).toBeNull();
    h.simSpeed = 1;
    frame(h, qc);
    expect(qc.quiz!.question).toBe(q); // the same question, waiting
    expect(qc.answer(q!.answer)).toBe('right');
  });

  it('the game paused: clocks stop, a question already up can still be answered', () => {
    const h = world();
    const { qc } = begin(h, 'cookbook');
    run(h, qc, TUNING.leadMs / 1000 + 0.1);
    for (let i = 0; i < 90; i++) frame(h, qc, true);
    expect(qc.frozen).toBe('paused');
    const q = qc.quiz!;
    expect(qc.answer((q.question!.answer + 1) % q.question!.options.length)).toBe('wrong');
    const t = q.t;
    for (let i = 0; i < 300; i++) frame(h, qc, true);
    expect(q.t).toBe(t); // the cooldown can't be waited out in a pause
    expect(q.phase).toBe('wrong');
  });

  it('skim: a key term in the lens is a hit and jumps; filler is a miss with a cooldown', () => {
    const h = world();
    const { qc } = begin(h, 'cookbook', 'skim');
    frame(h, qc);
    const s = qc.skim!;
    expect(s.terms.length).toBeGreaterThan(3);
    let guard = 0;
    while (!s.inLens()?.key && guard++ < 3000) frame(h, qc);
    const a = h.activities.current!;
    const e0 = a.elapsed;
    expect(qc.press()).toBe('hit');
    expect(a.elapsed).toBeGreaterThan(e0);
    guard = 0;
    while ((s.inLens()?.key || !s.inLens()) && guard++ < 3000) frame(h, qc);
    expect(qc.press()).toBe('miss');
    expect(s.cooldownMs).toBe(TUNING.skimCooldownMs);
    expect(qc.press()).toBeNull(); // cooling down
    expect(qc.totals).toMatchObject({ hits: 1, misses: 1 });
  });

  it('skim: clicking a visible key term is a hit wherever it is in the strip', () => {
    const h = world();
    const { qc } = begin(h, 'cookbook', 'skim');
    let guard = 0;
    const s = () => qc.skim!;
    const visibleKey = () => (qc.skim ? s().words.findIndex((w) => w.key && w.x > s().off && w.x + w.text.length < s().off + s().width) : -1);
    while (visibleKey() < 0 && guard++ < 3000) frame(h, qc);
    expect(qc.clickWord(visibleKey())).toBe('hit');
  });

  it('off: plain reading, no session', () => {
    const h = world();
    const { qc } = begin(h, 'cookbook', 'off');
    run(h, qc, 3);
    expect(qc.quiz).toBeNull();
    expect(qc.skim).toBeNull();
  });

  /** Real seconds to read `book` until the next level, with a simulated player. */
  function timeToLevel(book: string, player: 'none' | 'good' | 'careless', seed: number, game: ReadingGame = 'quiz', skill?: [string, number]): number {
    const h = world(seed);
    if (skill) h.player.setSkill(skill[0], skill[1]);
    const { qc } = begin(h, book, game);
    const rng = new Rng(seed);
    let t = 0;
    let think = 0;
    while (reading.current && t < 4000) {
      frame(h, qc);
      t += FRAME;
      if (game === 'skim') {
        // A good skimmer grabs a key term once it's well inside the lens.
        if (player !== 'none' && qc.skim && qc.skim.inLens()?.key && !qc.skim.inLens()!.hit) {
          think += FRAME;
          if (think > 0.4) qc.press(), (think = 0);
        }
        continue;
      }
      const q = qc.quiz;
      if (player === 'none' || !q || q.phase !== 'ask') {
        think = 0;
        continue;
      }
      think += FRAME;
      if (think >= (player === 'good' ? 2 : 1)) qc.answer(player === 'good' || rng.next() < 0.5 ? q.question!.answer : (q.question!.answer + 1) % q.question!.options.length);
    }
    expect(reading.current).toBeNull();
    return t;
  }

  it('tuning: a good player reads about twice as fast, a careless one a bit faster, never slower', () => {
    const cases: [string, [string, number]?][] = [['mag_cooking'], ['manual_first_aid'], ['textbook_survival', ['survival', 3]]];
    for (const [book, skill] of cases) {
      let base = 0, good = 0, careless = 0, skim = 0;
      for (const seed of [3, 5, 8]) {
        base += timeToLevel(book, 'none', seed, 'quiz', skill);
        good += timeToLevel(book, 'good', seed, 'quiz', skill);
        careless += timeToLevel(book, 'careless', seed, 'quiz', skill);
        skim += timeToLevel(book, 'good', seed, 'skim', skill);
      }
      const gx = base / good, cx = base / careless, sx = base / skim;
      console.log(`${book}: plain ${(base / 3).toFixed(0)} s · good quiz ${(good / 3).toFixed(0)} s (${gx.toFixed(2)}×) · careless ${(careless / 3).toFixed(0)} s (${cx.toFixed(2)}×) · good skim ${(skim / 3).toFixed(0)} s (${sx.toFixed(2)}×)`);
      expect(gx, book).toBeGreaterThan(1.6);
      expect(gx, book).toBeLessThan(2.6);
      expect(cx, book).toBeGreaterThan(1.0);
      expect(sx, book).toBeGreaterThan(1.2);
    }
  });
});

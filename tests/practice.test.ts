// Skill practice made visible (src/game/practice.ts, skill_hints.ts, src/ui/practice_feed.ts):
// every practice source reports, previews match what the action really gives (BN formulas), the
// HUD feed folds events sensibly, the "how to reach the next level" hints are real, and starting a
// disassembly from the inventory starts the activity and tells the screen to get out of the way.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameClock } from '../src/core/time';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { ActivityManager } from '../src/game/activity';
import { craftTime, findRecipe, learnRecipe, startCraft, type CraftHost } from '../src/game/crafting';
import { constructionGroups, getConstruction, startConstruction } from '../src/game/construction';
import { disassemblyStack, startDisassembly, uncraftRecipe } from '../src/game/disassembly';
import { DrivingPractice, drivingExperience } from '../src/game/driving_practice';
import { meleeTrain } from '../src/game/combat';
import { itemActionProviders } from '../src/game/inventory_view';
import { createItem, Item } from '../src/game/item';
import { L, spawnOnGround } from '../src/game/moves';
import { PlayerAvatar } from '../src/game/player';
import {
  ambient, constructionPractice, disassemblyPractice, effectiveFocus, exerciseForLevel, practiceListeners, practiceSettings, previewBook, previewConstruction,
  previewCraft, previewDisassembly, previewPractice, recentPractice, simpleTaskPractice, withPracticeSource, type PracticeEvent,
} from '../src/game/practice';
import { itemPracticeLines } from '../src/game/practice_info';
import { startReading } from '../src/game/reading';
import { skillHints } from '../src/game/skill_hints';
import { PracticeFeed, rowText } from '../src/ui/practice_feed';
import { BnInventoryModel } from '../src/ui2/bn/model';
import { craftingItemActions } from '../src/ui/craft2/actions';
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

interface TestHost extends CraftHost {
  log: string[];
  finish(): void;
}

/** A flat dirt world, the survivor at (5, 5) with a backpack, 8 AM (enough light to work). */
function world(seed = 7): TestHost {
  const map = new GameMap(1);
  for (const t of Object.values(data.terrain)) map.terrain.add(t);
  for (const f of Object.values(data.furniture)) map.furniture.add(f);
  map.generator = { generate: (m, c) => c.ter.fill(m.terrain.index('t_dirt')) };
  const player = new PlayerAvatar(data, { seed });
  player.x = 5.5;
  player.y = 5.5;
  player.z = 0;
  player.inv.wear(createItem(data, 'backpack'), null);
  const log: string[] = [];
  player.onMessage = (t) => log.push(t);
  const host: any = { data, map, player, clock: new GameClock(), log, input: { held: new Set(), captured: false }, message: (t: string) => log.push(t) };
  host.activities = new ActivityManager(host);
  host.finish = () => {
    for (let i = 0; i < 100000 && host.activities.current; i++) host.activities.update(host, 1 / 30, 30);
    expect(host.activities.current).toBeNull();
  };
  return host as TestHost;
}
const give = (h: TestHost, id: string) => {
  const it = createItem(data, id);
  expect(h.player.inv.giveNew(it)).not.toBeNull();
  return it;
};

let events: PracticeEvent[] = [];
const listen = (e: PracticeEvent) => events.push(e);
beforeEach(() => {
  events = [];
  practiceListeners.push(listen);
  practiceSettings.simpleTasks = false;
  ambient.source = () => null;
});
afterEach(() => {
  practiceListeners.splice(practiceListeners.indexOf(listen), 1);
  practiceSettings.simpleTasks = false;
});

describe('disassembly practice (BN crafting.cpp: difficulty × 2, capped at difficulty)', () => {
  it('a toaster (difficulty 0) teaches nothing, and the event says why and what', () => {
    const h = world();
    give(h, 'screwdriver');
    const toaster = give(h, 'toaster');
    const r = uncraftRecipe(data, 'toaster')!;
    expect(r.skill_used).toBe('electronics');
    expect(r.difficulty ?? 0).toBe(0);
    const pv = previewDisassembly(h.player, r)!;
    expect(pv.verdict).toBe('too_simple');
    expect(pv.text).toBe('Too simple to train Electronics (difficulty 0)');
    expect(startDisassembly(h, toaster)).toBe(true);
    h.finish();
    const e = events.filter((x) => x.skill === 'electronics');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ blocked: 'no_amount', gained: 0, explicit: true, source: 'Disassembling the toaster' });
    expect(h.player.skills.electronics?.exercise ?? 0).toBe(0);
  });

  it('a curling iron (difficulty 1) trains Electronics by exactly the previewed amount', () => {
    const h = world();
    give(h, 'screwdriver');
    const iron = give(h, 'curling_iron');
    const r = uncraftRecipe(data, 'curling_iron')!;
    expect(disassemblyPractice(r)).toEqual({ skill: 'electronics', amount: 2, cap: 1, token: false });
    const pv = previewDisassembly(h.player, r)!;
    expect(pv.verdict).toBe('trains');
    expect(pv.text).toMatch(/^Trains Electronics up to level 2 \(\+2% of level 1 each time\)/);
    const focus = effectiveFocus(h.player);
    expect(startDisassembly(h, iron)).toBe(true);
    h.finish();
    const e = events.find((x) => x.skill === 'electronics')!;
    expect(e.blocked).toBeNull();
    expect(e.gained).toBe(Math.round((2 * focus) / 100));
    expect(pv.perAction).toBeCloseTo((2 * focus) / 100 / exerciseForLevel(0));
    expect(recentPractice(h.player, 'electronics')[0]).toMatchObject({ source: 'Disassembling the curling iron', gained: e.gained });
  });

  it('above the cap it reports "cap", and the preview says too simple at your level', () => {
    const h = world();
    give(h, 'screwdriver');
    h.player.setSkill('electronics', 2);
    const iron = give(h, 'curling_iron');
    const pv = previewDisassembly(h.player, uncraftRecipe(data, 'curling_iron')!)!;
    expect(pv.verdict).toBe('capped');
    expect(pv.text).toMatch(/^Too simple to train Electronics at your level/);
    startDisassembly(h, iron);
    h.finish();
    expect(events.find((x) => x.skill === 'electronics')).toMatchObject({ blocked: 'cap', gained: 0 });
  });

  it('"Practice from simple tasks" (adaptation, off by default): a toaster gives a token up to level 1', () => {
    const r = uncraftRecipe(data, 'toaster')!;
    expect(practiceSettings.simpleTasks).toBe(false);
    practiceSettings.simpleTasks = true;
    expect(simpleTaskPractice(r)).toEqual({ amount: 15, cap: 0 });
    const h = world();
    give(h, 'screwdriver');
    give(h, 'screwdriver');
    const pv = previewDisassembly(h.player, r)!;
    expect(pv).toMatchObject({ verdict: 'trains', token: true, upTo: 1 });
    startDisassembly(h, give(h, 'toaster'));
    h.finish();
    expect(events.find((x) => x.skill === 'electronics')!.gained).toBeGreaterThan(0);
    h.player.setSkill('electronics', 1);
    expect(previewDisassembly(h.player, r)!.verdict).toBe('capped');
  });
});

describe('every practice source reports', () => {
  it('crafting: the whole craft gains about what the card previews (focus drains as it trains)', () => {
    // The wooden spear setup from crafting.test.ts (fabrication 2, a knife, a long stick, rag, thread).
    const h = world();
    const p = h.player;
    p.setSkill('fabrication', 2);
    p.setSkill('survival', 1);
    give(h, 'knife_folding');
    give(h, 'sandpaper');
    give(h, 'rag');
    h.player.inv.giveNew(createItem(data, 'thread', { count: 50 }));
    h.map.addItem(6, 5, 0, createItem(data, 'stick_long'));
    h.map.addField(4, 4, 0, 'fd_fire', 1);
    const r = findRecipe(data, 'spear_wood')!;
    const pv = previewCraft(p, r, 1, craftTime(p, r, 1, 1) * 100)[0];
    expect(pv.skill).toBe('fabrication');
    // 20 steps × (d×15+10)×batch_mult/20 = the preview's whole-craft amount.
    const bm = 1 + (craftTime(p, r, 1, 1) * 100) / 30000;
    expect(pv.amount).toBe(Math.round((r.difficulty * 15 + 10) * bm));
    const focus = effectiveFocus(p);
    const res = startCraft(h, r);
    expect(res.ok, res.msg).toBe(true);
    h.finish();
    const fab = events.filter((e) => e.skill === 'fabrication');
    expect(fab.length).toBeGreaterThan(10);
    expect(fab.every((e) => e.source === 'Crafting wooden spear')).toBe(true);
    const gained = fab.reduce((n, e) => n + e.gained, 0);
    // Focus drains a point or so per practice, so the real total sits a little under the preview.
    expect(gained).toBeGreaterThan((pv.amount * focus) / 100 * 0.7);
    expect(gained).toBeLessThan((pv.amount * focus) / 100 * 1.15);
  });

  it('construction: award_xp is exactly constructionPractice, credited to the build', () => {
    const con = constructionGroups(data).flatMap((g) => g.constructions).find((c) => (c.required_skills ?? []).some(([, l]) => l >= 1) && !c.pre_terrain && !c.pre_furniture)!;
    expect(con).toBeDefined();
    const h = world();
    for (const [s, l] of con.required_skills ?? []) h.player.setSkill(s, l);
    const want = constructionPractice(con);
    const pv = previewConstruction(h.player, con);
    expect(pv.map((p) => p.amount)).toEqual(want.map((w) => w.amount));
    // Practice the way complete_construction does (the site rules are tested elsewhere).
    withPracticeSource('Building: test', () => {
      for (const w of want) h.player.practice(w.skill, w.amount, w.cap);
    });
    for (const w of want) expect(events.find((e) => e.skill === w.skill)).toMatchObject({ requested: w.amount, source: 'Building: test' });
    expect(getConstruction(data, con.id)).toBeDefined();
    void startConstruction;
  });

  it('reading reports as a book source with the preview range', () => {
    const h = world();
    const mag = give(h, 'mag_survival');
    h.player.identifiedBooks.add(mag.typeId);
    const d = mag.def;
    const pv = previewBook(h.player, { skill: d.skill as string, req: d.required_level ?? 0, level: d.max_level ?? 0, time: d.time ?? 60 })!;
    expect(pv.verdict).toBe('trains');
    expect(startReading(h, mag, 'once')).toBe(true);
    h.finish();
    const e = events.find((x) => x.via === 'book')!;
    expect(e).toMatchObject({ skill: 'survival', explicit: true });
    expect(e.source).toMatch(/^Reading /);
    expect(e.gained).toBeGreaterThan(0);
  });

  it('combat: swings train implicitly (no named source), recorded as Fighting', () => {
    const h = world();
    const pipe = createItem(data, 'pipe');
    for (let i = 0; i < 4; i++) meleeTrain(h.player, pipe, true, new Rng(i + 1));
    const melee = events.filter((e) => e.skill === 'melee');
    expect(melee.length).toBe(4);
    expect(melee.every((e) => !e.explicit && e.source === null)).toBe(true);
    expect(recentPractice(h.player, 'melee')[0].source).toBe('Fighting');
  });

  it('an ambient activity names the source when the caller did not', () => {
    const h = world();
    ambient.source = () => 'butchering the zombie';
    h.player.practice('survival', 10, 4);
    expect(events[0]).toMatchObject({ source: 'butchering the zombie', explicit: false });
  });

  it('driving: BN character_turn experience, one roll in eight per turn while moving', () => {
    expect(drivingExperience(400, 0)).toBe(2);
    expect(drivingExperience(0, 3200 / 223.694)).toBeCloseTo(2);
    const h = world();
    const v = { velocity: 15, name: 'car', mass: () => 1200 };
    const sys = new DrivingPractice();
    const game: any = { vehicles: { driving: v }, player: h.player };
    for (let i = 0; i < 400; i++) sys.update(game, 1, 1);
    const drv = events.filter((e) => e.skill === 'driving');
    expect(drv.length).toBeGreaterThan(20);
    expect(drv.length).toBeLessThan(90);
    expect(drv[0].source).toBe('Driving the car');
  });
});

describe('previews', () => {
  it('a skill already at 10 is maxed; zero amount is too simple; level above cap is capped', () => {
    const h = world();
    expect(previewPractice(h.player, 'fabrication', 0, 3).verdict).toBe('too_simple');
    h.player.setSkill('fabrication', 4);
    expect(previewPractice(h.player, 'fabrication', 10, 3).verdict).toBe('capped');
    h.player.setSkill('fabrication', 10);
    expect(previewPractice(h.player, 'fabrication', 10, 10).verdict).toBe('maxed');
  });

  it('item info: weapons, guns and disassembly say what they train', () => {
    const h = world();
    const lines = (id: string) => itemPracticeLines(h.player, createItem(data, id)).map((l) => l.text);
    expect(lines('toaster')).toContain('Disassembling: Too simple to train Electronics (difficulty 0)');
    expect(lines('pipe').some((t) => /^Fighting with it trains Bashing/.test(t))).toBe(true);
  });
});

describe('the HUD feed', () => {
  const ev = (p: Partial<PracticeEvent>): PracticeEvent =>
    ({ who: null as any, skill: 'electronics', source: 'Disassembling the toaster', explicit: true, requested: 0, gained: 0, cap: 0, levelBefore: 0, level: 0, progressBefore: 0, progress: 0, levelUp: false, blocked: null, via: 'practice', ...p });
  const name = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  it('a chosen task that teaches nothing shows why; an implicit one stays quiet', () => {
    const f = new PracticeFeed();
    f.push(ev({ blocked: 'no_amount' }), 0, name);
    f.push(ev({ blocked: 'cap', explicit: false, source: null, skill: 'melee' }), 0, name);
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0].title).toBe('Disassembling the toaster');
    expect(rowText(f.cards[0].rows[0])).toBe('Electronics: no practice, too simple to learn from');
  });

  it('gains fold per source and skill; a gain beats a blocked step; cards expire', () => {
    const f = new PracticeFeed();
    const src = { source: 'Crafting a knife', skill: 'fabrication' };
    f.push(ev({ ...src, gained: 4, progress: 0.04 }), 0, name);
    f.push(ev({ ...src, blocked: 'focus' }), 10, name);
    f.push(ev({ ...src, gained: 4, progress: 0.08 }), 20, name);
    expect(f.cards).toHaveLength(1);
    expect(rowText(f.cards[0].rows[0])).toBe('Fabrication +8% · 8% to level 1');
    f.push(ev({ source: null, explicit: false, skill: 'melee', gained: 3, progress: 0.03 }), 30, name);
    expect(f.cards.map((c) => c.title)).toEqual(['Fighting', 'Crafting a knife']);
    expect(f.tick(30 + 5000)).toBe(true);
    expect(f.cards).toHaveLength(0);
  });

  it('a level-up row says so', () => {
    const f = new PracticeFeed();
    f.push(ev({ gained: 2, level: 1, levelBefore: 0, levelUp: true }), 0, name);
    expect(rowText(f.cards[0].rows[0])).toBe('Electronics reached level 1!');
  });
});

describe('how to reach the next level', () => {
  it('suggests the things around you that still train it, nearest first, at most 5 lines', () => {
    const h = world();
    give(h, 'screwdriver');
    give(h, 'curling_iron');
    give(h, 'toaster');
    give(h, 'manual_electronics');
    const hints = skillHints(h, 'electronics');
    expect(hints.length).toBeLessThanOrEqual(5);
    const text = hints.map((x) => x.text);
    expect(text).toContain('Disassemble the curling iron (Electronics 1)');
    // The toaster teaches nothing (difficulty 0): never suggested.
    expect(text.some((t) => /toaster/.test(t))).toBe(false);
    expect(text.some((t) => /^Read .*up to 3/.test(t))).toBe(true);
    expect(hints[0].kind).toBe('now');
  });

  it('names the caps that block you', () => {
    const h = world();
    h.player.setSkill('survival', 6);
    const text = skillHints(h, 'survival').map((x) => x.text);
    expect(text).toContain('Starting fires no longer teaches it past level 5');
    expect(text).not.toContain('Start a fire');
    give(h, 'mag_survival');
    expect(skillHints(h, 'survival').some((x) => x.kind === 'cap' && /books only go to level/i.test(x.text))).toBe(true);
  });

  it('known recipes that still train you show up, with whether you can make them now', () => {
    const h = world();
    const r = data.recipes.find((x) => x.skill_used === 'fabrication' && x.difficulty === 1 && x.result && !x.never_learn)!;
    learnRecipe(h.player, r.id);
    const t = skillHints(h, 'fabrication').map((x) => x.text);
    expect(t.some((s) => s.startsWith('Craft ') && s.includes('(Fabrication 1)'))).toBe(true);
  });

  it('a mastered skill says so', () => {
    const h = world();
    h.player.setSkill('melee', 10);
    expect(skillHints(h, 'melee')).toEqual([{ text: 'Melee is at its maximum.', kind: 'cap' }]);
  });
});

describe('disassembly from the inventory', () => {
  it('the Disassemble action starts the activity at once and asks the screens to close', () => {
    const h = world();
    give(h, 'screwdriver');
    const toaster = give(h, 'toaster');
    const provider = (who: any, it: Item, loc: any) => (who === h.player ? craftingItemActions(h, it, loc) : []);
    itemActionProviders.push(provider);
    try {
      let closed = 0;
      const scope = { who: h.player, map: h.map, at: { x: 5, y: 5, z: 0 } } as any;
      const model = new BnInventoryModel(() => scope, { activityStarted: () => closed++ });
      model.refresh(true);
      const v = model.viewOfItem(toaster)!;
      const act = model.actions(v.view, v.loc).find((a): a is { label: string; action: () => void; note?: string } => 'label' in a && /^Disassemble \(/.test(a.label))!;
      expect(act.note).toBe('Too simple to train Electronics (difficulty 0)');
      act.action();
      expect(h.activities.current?.spec.kind).toBe('disassemble');
      expect(closed).toBe(1);
    } finally {
      itemActionProviders.splice(itemActionProviders.indexOf(provider), 1);
    }
  });

  it('"Disassemble all" queues the rest of a stack on the ground', () => {
    const h = world();
    give(h, 'screwdriver');
    const irons = [0, 1, 2].map(() => {
      const it = createItem(data, 'curling_iron');
      spawnOnGround(h.map, 5, 5, 0, it);
      return it;
    });
    const more = disassemblyStack(h, irons[0]);
    expect(more).toHaveLength(2);
    expect(startDisassembly(h, irons[0], { then: more })).toBe(true);
    expect(h.activities.current!.spec.name).toBe('disassembling the curling iron (2 more after this)');
    h.finish();
    expect(h.map.itemsAt(5, 5, 0).filter((i) => (i as Item).typeId === 'curling_iron')).toHaveLength(0);
    expect(events.filter((e) => e.skill === 'electronics')).toHaveLength(3);
    void L;
  });
});

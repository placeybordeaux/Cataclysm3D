// Crafting, construction, disassembly and reading against the real extracted Bright Nights data.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameClock } from '../src/core/time';
import type { GameData } from '../src/data/types';
import { ActivityManager } from '../src/game/activity';
import {
  abandonCraft, availableRecipes, canCraft, continueCraft, craftingInventory, craftQueue, craftState, craftTime, findRecipe, inProgressCrafts, knowsRecipe,
  lightSpeedMultiplier, startCraft, successChance, type CraftHost,
} from '../src/game/crafting';
import { canBuild, cancelConstruction, continueConstruction, getConstruction, siteOk, siteProblem, startConstruction, unfinishedAt, unfinishedState } from '../src/game/construction';
import { disassemblyRequirements, startDisassembly, uncraftRecipe } from '../src/game/disassembly';
import { useFirestarter } from '../src/game/fire';
import { createItem, defaultAmmoId, fromSpawned, Item, loadAmmo } from '../src/game/item';
import { census, L, type Loc } from '../src/game/moves';
import { PlayerAvatar } from '../src/game/player';
import { bookMastery, cantRead, startReading, timeToRead } from '../src/game/reading';
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
  /** Run the current activity (and any follow-ups) to completion. */
  finish(maxSteps?: number): void;
  /** Advance the current activity by `seconds` of game time. */
  work(seconds: number): void;
}

/** A flat dirt world with the survivor at (5, 5) wearing a backpack, 8 AM. */
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
  const host: any = {
    data, map, player, clock: new GameClock(), log,
    input: { held: new Set(), captured: false },
    message: (t: string) => log.push(t),
  };
  host.activities = new ActivityManager(host);
  host.finish = (max = 100000) => {
    for (let i = 0; i < max && host.activities.current; i++) host.activities.update(host, 1 / 30, 30);
    expect(host.activities.current).toBeNull();
  };
  host.work = (s: number) => {
    for (let t = 0; t < s && host.activities.current; t += 10) host.activities.update(host, 1 / 30, 10);
  };
  return host as TestHost;
}

const give = (h: TestHost, id: string, count?: number) => {
  const it = createItem(data, id, count !== undefined ? { count } : {});
  expect(h.player.inv.giveNew(it)).not.toBeNull();
  return it;
};
const carried = (h: TestHost, id: string) => h.player.inv.allItems().filter((i) => i.typeId === id);
const onGround = (h: TestHost, id: string) => h.map.itemsAt(5, 5, 0).filter((i) => (i as Item).typeId === id) as Item[];
const total = (h: TestHost, id: string) => [...carried(h, id), ...onGround(h, id)].reduce((n, it) => n + it.count(), 0);

/** Everything the survivor carries plus the ground around them (census scope). */
const scope = (h: TestHost): Loc[] => {
  const out: Loc[] = [L.hands(h.player), L.worn(h.player), L.inv(h.player)];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) out.push(L.ground(h.map, x, y, 0));
  return out;
};
const counts = (h: TestHost) => Object.fromEntries(census(scope(h)).counts);

describe('known recipes', () => {
  it('autolearn needs the recipe skill at difficulty plus skills_required', () => {
    const h = world();
    const spear = findRecipe(data, 'spear_wood')!;
    expect(knowsRecipe(h.player, spear)).toBe(false);
    h.player.setSkill('fabrication', 2);
    expect(knowsRecipe(h.player, spear)).toBe(false); // still needs survival 1
    h.player.setSkill('survival', 1);
    expect(knowsRecipe(h.player, spear)).toBe(true);
  });

  it('a book in reach offers its recipes once skill is sufficient (BN: no identification needed)', () => {
    const h = world();
    give(h, 'mag_survival');
    const has = () => availableRecipes(h.player, craftingInventory(h)).some((k) => k.recipe.id === 'cattail_jelly' && k.source === 'mag_survival');
    expect(has()).toBe(false); // survival 0 < book level 1
    h.player.setSkill('survival', 1);
    expect(has()).toBe(true);
    expect(knowsRecipe(h.player, findRecipe(data, 'cattail_jelly')!)).toBe(false); // only while the book is at hand
  });
});

/** Survivor ready to make BN's fire-hardened spear: CUT 1, SANDING 1, fire, a long stick, a rag, 20 thread. */
function spearSetup(seed = 7): TestHost {
  const h = world(seed);
  const p = h.player;
  p.setSkill('fabrication', 2);
  p.setSkill('survival', 1);
  give(h, 'knife_folding');
  give(h, 'sandpaper');
  give(h, 'rag');
  give(h, 'thread', 50);
  // Long sticks are bulky: leave it on the ground next to us (crafting reaches 2 tiles).
  h.map.addItem(6, 5, 0, createItem(data, 'stick_long'));
  h.map.addField(4, 4, 0, 'fd_fire', 1);
  return h;
}

describe('crafting spear_wood end to end', () => {
  it('reports missing requirements in BN terms, with structured rows for the UI', () => {
    const h = world();
    const r = findRecipe(data, 'spear_wood')!;
    const ch = canCraft(h, r);
    expect(ch.ok).toBe(false);
    expect(ch.missing).toContain('1 tool with cutting of 1 or more');
    expect(ch.missing).toContain('nearby fire');
    expect(ch.missing).toContain('1 long stick');
    expect(ch.req.components[0].alts[0]).toMatchObject({ kind: 'component', id: 'stick_long', need: 1, avail: 0, have: false });
    expect(ch.req.qualities[0].alts[0]).toMatchObject({ kind: 'quality', id: 'CUT', need: 1, avail: 0 });
  });

  it('components go into an in-progress craft, fabrication is practised, and a spear comes out', () => {
    const h = spearSetup();
    const p = h.player;
    const r = findRecipe(data, 'spear_wood')!;
    expect(canCraft(h, r).missing).toEqual([]);
    expect(craftTime(p, r)).toBe(120); // BN seconds, no proficiencies
    const before = counts(h);
    const res = startCraft(h, r);
    expect(res.ok, res.msg).toBe(true);
    // the stick left the ground and sits in the craft: nothing vanished
    expect(h.map.itemsAt(6, 5, 0)).toHaveLength(0);
    const craft = res.craft!;
    expect(craft.contents.map((c) => c.typeId).sort()).toEqual(['rag', 'stick_long', 'thread']);
    expect(p.inv.has(craft)).toBe(true);
    expect(counts(h)).toEqual({ ...before, craft: 1 });
    expect(craft.name()).toBe('in progress wooden spear (0%)');
    h.finish();
    expect(total(h, 'spear_wood')).toBe(1);
    expect(carried(h, 'thread')[0].charges).toBe(30);
    expect(p.skills.fabrication.exercise).toBeGreaterThan(0);
    expect(h.log).toContain('You craft wooden spear from memory.');
    expect(carried(h, 'craft')).toHaveLength(0);
  });

  it('works slowly in the dark; BLIND_IMPOSSIBLE recipes need light', () => {
    const h = world();
    h.clock.seconds = 23 * 3600;
    const r = findRecipe(data, 'pointy_stick_long')!;
    give(h, 'knife_folding');
    h.map.addItem(6, 5, 0, createItem(data, 'stick_long'));
    expect(lightSpeedMultiplier(h, r)).toBeCloseTo(0.6); // default recipes: 60% speed in full dark
    expect(canCraft(h, r).ok).toBe(true);
    const hard = { ...r, flags: ['BLIND_IMPOSSIBLE'] };
    expect(canCraft(h, hard).missing).toContain("You can't see to craft!");
    h.map.addField(3, 5, 0, 'fd_fire', 1); // a campfire lights the work
    expect(lightSpeedMultiplier(h, hard)).toBe(1);
  });

  it('success chance comes from BN dice: trivial recipes never fail, skill helps', () => {
    const h = world();
    expect(successChance(h.player, findRecipe(data, 'pointy_stick_long')!)).toBe(1);
    const spear = findRecipe(data, 'spear_wood')!;
    const low = successChance(h.player, spear);
    h.player.setSkill('fabrication', 4);
    h.player.setSkill('survival', 3);
    expect(successChance(h.player, spear)).toBeGreaterThan(low);
  });
});

describe('in-progress crafts (conservation)', () => {
  it('stopping keeps the craft (and its progress) with its components; continuing finishes it', () => {
    const h = spearSetup(11);
    const r = findRecipe(data, 'spear_wood')!;
    const before = counts(h);
    const craft = startCraft(h, r).craft!;
    h.work(40);
    h.activities.cancel('You stop.');
    const st = craftState(data, craft)!;
    expect(st.progress).toBeGreaterThan(0);
    expect(st.progress).toBeLessThan(1);
    expect(counts(h)).toEqual({ ...before, craft: 1 });
    expect(census(scope(h)).aliased).toEqual([]);
    expect(inProgressCrafts(h).map((c) => c.item)).toEqual([craft]);
    expect(craft.name()).toMatch(/\(\d+%\)$/);
    // its components can't be pulled out by hand
    expect(h.player.inv.unload(craft).ok).toBe(false);
    const res = continueCraft(h, craft);
    expect(res.ok, res.msg).toBe(true);
    h.finish();
    expect(total(h, 'spear_wood')).toBe(1);
    expect(carried(h, 'craft')).toHaveLength(0);
  });

  it('taking an in-progress craft apart gives every component back', () => {
    const h = spearSetup();
    const before = counts(h);
    const craft = startCraft(h, findRecipe(data, 'spear_wood')!).craft!;
    h.activities.cancel('You stop.');
    expect(abandonCraft(h, craft)).toBe(true);
    expect(counts(h)).toEqual(before);
    expect(census(scope(h)).aliased).toEqual([]);
  });

  it('continuing needs the tools at hand', () => {
    const h = world();
    const knife = createItem(data, 'knife_folding');
    h.map.addItem(6, 6, 0, knife);
    h.map.addItem(6, 5, 0, createItem(data, 'stick_long'));
    const craft = startCraft(h, findRecipe(data, 'pointy_stick_long')!).craft!;
    h.activities.cancel('You stop.');
    h.map.removeItem(6, 6, 0, knife);
    expect(continueCraft(h, craft).ok).toBe(false);
    expect(h.log.at(-1)).toMatch(/cutting of 1/);
  });

  it('mishaps destroy components, which are replaced before going on; nothing is ever duplicated', () => {
    let sawFailure = false;
    for (let seed = 1; seed < 60 && !sawFailure; seed++) {
      const h = world(seed);
      h.player.setSkill('fabrication', 2);
      h.player.setSkill('survival', 1);
      h.player.int_base = 4;
      give(h, 'knife_folding');
      give(h, 'sandpaper');
      for (let i = 0; i < 4; i++) give(h, 'rag');
      give(h, 'thread', 200);
      for (let i = 0; i < 4; i++) h.map.addItem(6, 5, 0, createItem(data, 'stick_long'));
      h.map.addField(4, 4, 0, 'fd_fire', 1);
      startCraft(h, findRecipe(data, 'spear_wood')!);
      h.finish();
      if (h.log.some((l) => l.startsWith('You mess up'))) sawFailure = true;
      expect(census(scope(h)).aliased).toEqual([]);
    }
    expect(sawFailure).toBe(true);
  });

  it('the queue runs crafts one after another', async () => {
    const h = world(3);
    give(h, 'knife_folding');
    for (let i = 0; i < 3; i++) h.map.addItem(6, 5, 0, createItem(data, 'stick_long'));
    const q = craftQueue(h);
    const r = findRecipe(data, 'pointy_stick_long')!;
    q.add(r);
    q.add(r, 2);
    q.resume();
    expect(h.activities.current?.spec.kind).toBe('craft');
    for (let i = 0; i < 10 && (h.activities.current || q.entries.length); i++) {
      h.finish();
      await Promise.resolve();
    }
    expect(total(h, 'pointy_stick_long')).toBe(3);
    expect(q.running).toBe(false);
  });
});

describe('crafting inventory sources', () => {
  it('a quality is satisfied by a knife lying within reach, not by one too far away', () => {
    const h = world();
    const r = findRecipe(data, 'pointy_stick_long')!; // CUT 1
    h.map.addItem(5, 7, 0, createItem(data, 'stick_long'));
    h.map.addItem(9, 5, 0, createItem(data, 'knife_folding'));
    expect(canCraft(h, r).missing).toEqual(['1 tool with cutting of 1 or more']);
    const knife = h.map.itemsAt(9, 5, 0)[0];
    h.map.removeItem(9, 5, 0, knife);
    h.map.addItem(7, 4, 0, knife);
    expect(canCraft(h, r).ok).toBe(true);
    startCraft(h, r);
    h.finish();
    expect(h.map.itemsAt(7, 4, 0)).toContain(knife); // tools stay where they were
    expect(carried(h, 'pointy_stick_long')).toHaveLength(1);
  });

  it('boiling water: fire comes from a nearby fd_fire, BOIL from a pot; clean water fills the bottle', () => {
    const h = world();
    const r = findRecipe(data, 'water_clean')!;
    give(h, 'pot');
    for (const it of fromSpawned(data, { id: 'water', count: 1, charges: 2 } as any)) h.player.inv.giveNew(it);
    expect(canCraft(h, r).missing).toEqual([expect.stringContaining('fire')]);
    h.map.addField(6, 6, 0, 'fd_fire', 1);
    expect(canCraft(h, r).ok).toBe(true);
    expect(canCraft(h, r, 3).ok).toBe(false); // only 2 units of water
    startCraft(h, r, { batch: 2 });
    h.finish();
    const bottle = carried(h, 'bottle_plastic')[0];
    expect(bottle.name()).toBe('clean water (plastic bottle) (2/2)');
    expect(carried(h, 'water')).toHaveLength(0);
  });
});

describe('fire', () => {
  it('a lighter on a pile of sticks makes an fd_fire', () => {
    const h = world();
    const lighter = createItem(data, 'lighter');
    expect(loadAmmo(lighter, defaultAmmoId(data, 'lighter_fluid')!, 10)).toBe(10);
    h.player.inv.giveNew(lighter);
    const before = lighter.ammoRemaining();
    h.map.addItem(5, 4, 0, createItem(data, 'stick_long'));
    const r = useFirestarter(h, lighter, lighter.def.use_action as any, 5, 4, 0);
    expect(r.ok).toBe(true);
    h.finish();
    expect(h.map.fieldsAt(5, 4, 0).map((f) => f.type)).toEqual(['fd_fire']);
    expect(lighter.ammoRemaining()).toBe(before - 1);
    expect(h.log).toContain('You successfully light a fire.');
  });
});

describe('construction', () => {
  it('boarding up a window turns t_window into t_window_boarded', () => {
    const h = world();
    h.map.setTer(6, 5, 0, 't_window');
    const con = getConstruction(data, 'constr_window_boarded')!;
    give(h, 'hammer');
    h.map.addItem(4, 6, 0, createItem(data, '2x4'));
    h.map.addItem(4, 6, 0, createItem(data, '2x4'));
    h.map.addItem(4, 5, 0, createItem(data, '2x4'));
    h.map.addItem(4, 5, 0, createItem(data, '2x4'));
    give(h, 'nail', 10);
    expect(siteOk(h, con, 6, 5, 0)).toBe(true);
    expect(siteProblem(h, con, 5, 6, 0)).toMatch(/barricadable window/); // dirt isn't a window
    expect(canBuild(h, con).ok).toBe(true);
    expect(startConstruction(h, con, 6, 5, 0)).toBe(true);
    h.finish();
    expect(h.map.terAt(6, 5, 0).id).toBe('t_window_boarded');
    expect(h.player.inv.countOf('nail')).toBe(2);
    expect(h.map.itemsAt(4, 6, 0)).toHaveLength(0);
    expect(h.log).toContain('You finished construction: Board Up Window.');
    expect(unfinishedAt(h, 6, 5, 0)).toBeNull();
  });

  it('a half wall: stopping leaves an unfinished construction holding the materials; continuing finishes it', () => {
    const h = world();
    h.player.setSkill('fabrication', 2);
    const con = getConstruction(data, 'constr_wall_half')!;
    give(h, 'hammer');
    give(h, 'nail', 20);
    for (let i = 0; i < 10; i++) h.map.addItem(5, 7, 0, createItem(data, '2x4'));
    const before = counts(h);
    expect(startConstruction(h, con, 6, 6, 0)).toBe(true);
    expect(h.player.inv.countOf('nail')).toBe(0);
    h.work(300);
    h.activities.cancel('You stop.');
    const site = unfinishedAt(h, 6, 6, 0)!;
    expect(site).not.toBeNull();
    expect(unfinishedState(data, site)!.progress).toBeGreaterThan(0);
    expect(counts(h)).toEqual({ ...before, craft: 1 });
    expect(h.map.terAt(6, 6, 0).id).toBe('t_dirt');
    // it stays on its site
    expect(h.player.inv.pickUp(site, L.ground(h.map, 6, 6, 0)).ok).toBe(false);
    expect(siteOk(h, con, 6, 6, 0)).toBe(false); // one site per tile
    expect(continueConstruction(h, site, 6, 6, 0)).toBe(true);
    h.finish();
    expect(h.map.terAt(6, 6, 0).id).toBe('t_wall_half');
    expect(h.player.skills.fabrication.exercise).toBeGreaterThan(0);
    expect(counts(h).craft).toBeUndefined();
  });

  it('cancelling an unfinished construction gives the materials back', () => {
    const h = world();
    h.player.setSkill('fabrication', 2);
    const con = getConstruction(data, 'constr_wall_half')!;
    give(h, 'hammer');
    give(h, 'nail', 20);
    for (let i = 0; i < 10; i++) h.map.addItem(5, 7, 0, createItem(data, '2x4'));
    const before = counts(h);
    startConstruction(h, con, 6, 6, 0);
    h.activities.cancel('You stop.');
    expect(cancelConstruction(h, unfinishedAt(h, 6, 6, 0)!, 6, 6, 0)).toBe(true);
    expect(counts(h)).toEqual(before);
    expect(census(scope(h)).aliased).toEqual([]);
  });
});

describe('disassembly', () => {
  it('a long stick comes apart into two sticks (BN: no tool needed)', () => {
    const h = world();
    const r = uncraftRecipe(data, 'stick_long')!;
    expect(disassemblyRequirements(data, r).qualities).toEqual([]);
    h.player.inv.wield(createItem(data, 'stick_long'), null);
    expect(startDisassembly(h, h.player.inv.wielded!)).toBe(true);
    h.finish();
    expect(carried(h, 'stick_long')).toHaveLength(0);
    expect(total(h, 'stick')).toBe(2);
    expect(h.log.some((l) => /^You recover 2 /.test(l))).toBe(true);
  });

  it('reversible recipes can be taken apart (makeshift knife); sewing becomes cutting', () => {
    const r = uncraftRecipe(data, 'makeshift_knife');
    expect(r).toBeDefined();
    expect(disassemblyRequirements(data, r!).components.length).toBeGreaterThan(0);
    const sewn = { ...r!, qualities: [[{ id: 'SEW', level: 1 }]] } as any;
    expect(disassemblyRequirements(data, sewn).qualities).toEqual([[{ id: 'CUT', level: 1 }]]);
  });

  it('books tear into paper', () => {
    const r = uncraftRecipe(data, 'mag_survival')!;
    expect(r.components[0][0]).toMatchObject({ id: 'paper', count: 20 });
  });
});

describe('reading', () => {
  it('identifies at once, trains survival up to max_level and memorises the recipes it contains', () => {
    const h = world();
    const p = h.player;
    const mag = give(h, 'mag_survival');
    expect(timeToRead(p, mag)).toBe(8 * 60); // an 8-minute chapter at Int 8
    expect(startReading(h, mag)).toBe(true);
    expect(p.identifiedBooks.has('mag_survival')).toBe(true);
    expect(h.log).toContain("You skim Outdoor Adventures to find out what's in it.");
    h.finish(); // continuous: reads until the skill goes up
    expect(p.getSkill('survival')).toBe(1);
    expect(h.log.some((l) => /^You (learn a little about survival!|increase survival to level 1)/i.test(l)), h.log.join("\n")).toBe(true);
    // at survival 1 the book's level-1 recipes are memorised on the next session
    expect(startReading(h, mag, 'once')).toBe(true);
    h.finish();
    expect(p.learnedRecipes.has('cattail_jelly')).toBe(true);
    expect(h.log).toContain('You memorize a recipe for cattail jelly.');
    expect(bookMastery(p, mag)).toBe('mastered');
  });

  it("can't read in the dark", () => {
    const h = world();
    const mag = give(h, 'mag_survival');
    h.clock.seconds = 23 * 3600;
    expect(cantRead(h, mag)).toBe("It's too dark to read!");
  });
});

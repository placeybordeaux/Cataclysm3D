import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { AchievementsData } from '../src/game/achievements';
import { emptyProfile, parseProfile, Profile, PROFILE_KEY, STAT_IDS, type StatId } from '../src/progression/profile';
import {
  available, newlyEarned, nextUp, progressLines, reqMet, statGoal, unlockMet, validateCatalogue, type Catalogue, type KnownIds, type UnlockEnv,
} from '../src/progression/unlocks';
import { craftableDiff, NUDGES, NudgeQueue, reachSignature, recipeNudgeText } from '../src/progression/discovery';
import { SCENARIO_PLACEMENT } from '../src/progression/placement';
import { buildFor, kitPreview, professionDef, scenarioOptions, startCards } from '../src/progression/starts';
import { DEFAULT_BINDINGS } from '../src/ui/keys';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let ach: AchievementsData;
let rawCat: unknown;
let known: KnownIds;
let cat: Catalogue;

beforeAll(() => {
  data = { terrain: {}, furniture: {}, items: load('items.json'), itemGroups: load('item_groups.json'), monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json') } as unknown as GameData;
  ach = load('achievements.json');
  rawCat = load('unlocks.json');
  known = {
    professions: new Set(Object.keys(data.misc.profession ?? {})),
    scenarios: new Set(Object.keys(data.misc.scenario ?? {})),
    achievements: new Set(Object.keys(ach.achievements)),
    placeableScenarios: new Set(Object.keys(SCENARIO_PLACEMENT)),
  };
  cat = validateCatalogue(rawCat, known);
});

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const envOf = (stats: Partial<Record<StatId, number>>, achievements: string[] = []): UnlockEnv => ({
  achievements: new Set(achievements),
  stat: (id) => stats[id] ?? 0,
});

describe('unlock catalogue (public/data/unlocks.json)', () => {
  it('validates against BN professions, scenarios and achievements', () => {
    expect(cat.unlocks.length).toBeGreaterThan(15);
    // Every card's art sprite is a real item.
    for (const u of cat.unlocks) if (u.icon) expect(data.items[u.icon], `${u.id} icon ${u.icon}`).toBeTruthy();
  });

  it('rejects unknown ids, bad kinds and unplaceable scenarios, listing every problem', () => {
    const bad = {
      version: 1,
      unlocks: [
        { id: 'free', kind: 'start', name: 'x', requirement: [], grants: { profession: 'unemployed', scenario: 'evacuee' } },
        { id: 'a', kind: 'profession', name: 'A', requirement: [{ achievement: 'nope' }], grants: { profession: 'not_a_prof' } },
        { id: 'b', kind: 'scenario', name: 'B', requirement: [{ stat: 'bogus', gte: 1 }], grants: { scenario: 'lab_chal' } },
        { id: 'b', kind: 'cosmetic', name: 'dup', requirement: [], grants: {} },
      ],
    };
    let msg = '';
    try {
      validateCatalogue(bad, known);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/unknown achievement nope/);
    expect(msg).toMatch(/unknown profession not_a_prof/);
    expect(msg).toMatch(/unknown stat bogus/);
    expect(msg).toMatch(/lab_chal has no start placement/);
    expect(msg).toMatch(/duplicate id/);
    expect(msg).toMatch(/kind cosmetic doesn't match/);
  });

  it('needs a free start (the quick start)', () => {
    expect(() => validateCatalogue({ version: 1, unlocks: [] }, known)).toThrow(/no requirement/);
  });

  it('grants only choices: professions, scenarios, titles, the creator — never stats or items', () => {
    for (const u of cat.unlocks) expect(Object.keys(u.grants).every((k) => ['profession', 'scenario', 'title', 'creator'].includes(k)), u.id).toBe(true);
  });
});

describe('unlock evaluation', () => {
  const ids = () => new Set<string>();
  it('earns nothing for a brand-new profile; the free start is available without being "earned"', () => {
    const got = newlyEarned(cat, envOf({}), () => false);
    expect(got).toEqual([]);
    const evac = cat.unlocks.find((u) => u.id === 'start_evacuee')!;
    expect(available(evac, () => false, false)).toBe(true);
  });

  it('earns the ladder from stats and achievements', () => {
    const rec = ids();
    const e1 = newlyEarned(cat, envOf({ deaths: 1 }, ['achievement_kill_zombie']), (id) => rec.has(id)).map((u) => u.id);
    expect(e1).toEqual(expect.arrayContaining(['prof_convict', 'prof_security']));
    expect(e1).not.toContain('prof_cop');
    for (const id of e1) rec.add(id);
    // Already recorded: not "new" again.
    expect(newlyEarned(cat, envOf({ deaths: 1 }, ['achievement_kill_zombie']), (id) => rec.has(id))).toEqual([]);
    const e2 = newlyEarned(cat, envOf({ deaths: 1, zombie_kills: 10 }, ['achievement_kill_zombie']), (id) => rec.has(id)).map((u) => u.id);
    expect(e2).toEqual(['prof_cop']);
  });

  it('"any" requirements accept either the achievement or the stat', () => {
    const creator = cat.unlocks.find((u) => u.kind === 'creator')!;
    expect(unlockMet(creator, envOf({ best_days: 6 }))).toBe(false);
    expect(unlockMet(creator, envOf({ best_days: 7 }))).toBe(true);
    expect(unlockMet(creator, envOf({}, ['achievement_survive_7_days']))).toBe(true);
  });

  it('Classic mode makes everything available without recording it', () => {
    for (const u of cat.unlocks) expect(available(u, () => false, true)).toBe(true);
    const cop = cat.unlocks.find((u) => u.id === 'prof_cop')!;
    expect(available(cop, () => false, false)).toBe(false);
    expect(available(cop, (id) => id === 'prof_cop', false)).toBe(true);
  });

  it('progress lines read like goals with counts', () => {
    const cop = cat.unlocks.find((u) => u.id === 'prof_cop')!;
    const [l] = progressLines(cop, envOf({ zombie_kills: 4 }), (x) => x);
    expect(l).toMatchObject({ text: 'Kill 10 zombies', done: false, count: '4/10' });
    expect(l.fraction).toBeCloseTo(0.4);
    const hitch = cat.unlocks.find((u) => u.id === 'prof_hitchhiker')!;
    expect(progressLines(hitch, envOf({ distance_m: 12_500 }), (x) => x)[0].count).toBe('12.5 km/42.2 km');
    expect(statGoal('zombie_kills', 1)).toBe('Kill a zombie');
    expect(reqMet({ any: [{ stat: 'kills', gte: 5 }, { achievement: 'x' }] }, envOf({ kills: 5 }))).toBe(true);
  });

  it('"next up" picks the closest unearned unlocks', () => {
    const next = nextUp(cat, envOf({ zombie_kills: 9, deaths: 1 }), (id) => id === 'prof_convict', 2);
    expect(next[0].u.id).toBe('prof_cop');
    expect(next.every((n) => n.u.id !== 'prof_convict' && n.u.id !== 'start_evacuee')).toBe(true);
  });

  it('every stat has a goal wording', () => {
    for (const s of STAT_IDS) expect(statGoal(s, 3)).toBeTruthy();
  });
});

describe('progression profile persistence', () => {
  it('round-trips stats, sets, unlocks and options through storage', () => {
    const store = new MemStore();
    const a = new Profile(store);
    a.add('zombie_kills', 3);
    a.add('distance_m', 120.5);
    a.max('best_days', 2);
    a.max('best_days', 1);
    expect(a.note('towns', 's:Bethlehem')).toBe(true);
    expect(a.note('towns', 's:Bethlehem')).toBe(false);
    a.unlock('prof_cop', 'Alice');
    a.mark('hintsShown', 'first_zombie');
    a.setOption('classic', true);
    a.flush();
    const b = new Profile(store);
    expect(b.stat('zombie_kills')).toBe(3);
    expect(b.stat('best_days')).toBe(2);
    expect(b.stat('towns_visited')).toBe(1);
    expect(b.isUnlocked('prof_cop')).toBe(true);
    expect(b.data.unlocked.prof_cop.by).toBe('Alice');
    expect(b.has('hintsShown', 'first_zombie')).toBe(true);
    expect(b.data.options.classic).toBe(true);
    // Title-screen announcements are taken once.
    expect(b.takeUnseen()).toEqual(['prof_cop']);
    expect(new Profile(store).takeUnseen()).toEqual([]);
  });

  it('does not write until flushed (frequent stats are batched)', () => {
    const store = new MemStore();
    const a = new Profile(store);
    a.add('distance_m', 1);
    expect(store.getItem(PROFILE_KEY)).toBeNull();
    a.flush();
    expect(store.getItem(PROFILE_KEY)).not.toBeNull();
  });

  it('export → import reproduces the profile; a bad import throws and changes nothing', () => {
    const a = new Profile(new MemStore());
    a.add('deaths', 2);
    a.unlock('prof_convict', 'Bob');
    const json = a.export();
    const b = new Profile(new MemStore());
    b.import(json);
    expect(b.data).toEqual(a.data);
    expect(() => b.import('{nope')).toThrow(/not valid JSON/);
    expect(() => b.import(JSON.stringify({ v: 1, stats: { deaths: -1 } }))).toThrow(/non-negative/);
    expect(() => b.import(JSON.stringify({ v: 2 }))).toThrow(/version/);
    expect(() => b.import(JSON.stringify({ v: 1, stats: { made_up: 1 } }))).toThrow(/unknown stat made_up/);
    expect(b.stat('deaths')).toBe(2);
  });

  it('keeps an unreadable stored profile aside instead of crashing', () => {
    const store = new MemStore();
    store.setItem(PROFILE_KEY, '{"v":1,"stats":{"deaths":"lots"}}');
    const p = new Profile(store);
    expect(p.data).toEqual(emptyProfile());
    expect(store.getItem(`${PROFILE_KEY}.broken`)).toContain('lots');
  });

  it('parseProfile fills defaults for a minimal document', () => {
    expect(parseProfile({ v: 1 })).toEqual(emptyProfile());
  });
});

describe('discovery rate limiter', () => {
  const mk = (shown = new Set<string>()) => ({ shown, q: new NudgeQueue((id) => shown.has(id)) });

  it('shows at most one nudge per 20 s, queueing the rest', () => {
    const { q } = mk();
    q.offer('first_hunger', 6, 0);
    q.offer('first_night', 6, 0);
    expect(q.next(0, false)?.id).toBe('first_hunger');
    expect(q.next(5_000, false)).toBeNull();
    expect(q.next(19_999, false)).toBeNull();
    expect(q.next(20_000, false)?.id).toBe('first_night');
  });

  it('waits while blocked (combat, a window open) and resumes when calm', () => {
    const { q } = mk();
    q.offer('first_zombie', 9, 0);
    expect(q.next(100, true)).toBeNull();
    expect(q.next(60_000, true)).toBeNull();
    expect(q.next(61_000, false)?.id).toBe('first_zombie');
  });

  it('is once per profile: shown ids are not offered again, even if queued meanwhile', () => {
    const { shown, q } = mk(new Set(['first_zombie']));
    expect(q.offer('first_zombie', 9, 0)).toBe('seen');
    q.offer('first_night', 6, 0);
    shown.add('first_night'); // e.g. shown by another path / imported profile
    expect(q.next(0, false)).toBeNull();
    expect(q.queue).toEqual([]);
  });

  it('dedupes, orders by priority, and lets repeatable (recipe) nudges come back', () => {
    const { shown, q } = mk();
    expect(q.offer('first_rain', 3, 0)).toBe('queued');
    expect(q.offer('first_rain', 3, 0)).toBe('duplicate');
    q.offer('first_bleed', 10, 0);
    expect(q.next(0, false)?.id).toBe('first_bleed');
    q.offer('craft', 3, 0, true);
    shown.add('craft');
    expect(q.offer('craft', 3, 0, true)).toBe('duplicate');
    expect(q.next(20_000, false)?.id).toBe('first_rain');
    expect(q.next(40_000, false)?.id).toBe('craft');
    expect(q.offer('craft', 3, 50_000, true)).toBe('queued');
  });

  it('drops stale nudges (the moment passed) and overflows lowest priority first', () => {
    const { q } = mk();
    q.offer('first_rain', 3, 0);
    expect(q.next(6 * 60_000, false)).toBeNull();
    for (const [i, id] of ['a', 'b', 'c', 'd', 'e', 'f'].entries()) q.offer(id, 5 + i, 0);
    expect(q.offer('low', 1, 0)).toBe('dropped');
    expect(q.offer('high', 99, 0)).toBe('queued');
    expect(q.queue[0].id).toBe('high');
    expect(q.queue.length).toBe(6);
  });
});

describe('craftable-diff detection', () => {
  it('reports recipes that just became craftable, never crafted or announced', () => {
    const crafted = new Set(['spear_wooden']);
    const told = new Set(['torch']);
    const prev = new Set(['bandages']);
    const now = new Set(['bandages', 'spear_wooden', 'torch', 'pointy_stick', 'sling']);
    expect(craftableDiff(prev, now, (id) => crafted.has(id), (id) => told.has(id)).sort()).toEqual(['pointy_stick', 'sling']);
    // Nothing changed: nothing new.
    expect(craftableDiff(now, now, () => false, () => false)).toEqual([]);
    // Dropping out and coming back is new again (unless announced — the caller marks those).
    expect(craftableDiff(new Set(), new Set(['bandages']), () => false, () => false)).toEqual(['bandages']);
  });

  it('groups several recipes into one nudge', () => {
    expect(recipeNudgeText(['wooden spear']).title).toBe('You could craft: wooden spear');
    const t = recipeNudgeText(['torch', 'sling', 'long pointy stick']);
    expect(t.title).toBe('3 new recipes');
    expect(t.body).toMatch(/long pointy stick, sling and torch/);
    expect(recipeNudgeText(['a', 'b', 'c', 'd', 'e']).body).toMatch(/a, b, c and 2 more/);
    expect(() => recipeNudgeText([])).toThrow();
  });

  it('reach signatures ignore order but see counts', () => {
    expect(reachSignature(['rock', 'stick', 'rock'])).toBe(reachSignature(['stick', 'rock', 'rock']));
    expect(reachSignature(['rock', 'stick'])).not.toBe(reachSignature(['rock', 'stick', 'stick']));
  });
});

describe('discovery tips', () => {
  it('name only keys that exist', () => {
    for (const d of Object.values(NUDGES))
      for (const m of `${d.title} ${d.body} ${d.journal}`.matchAll(/<keybind:([a-z_0-9]+)>/g)) expect(DEFAULT_BINDINGS[m[1]], `${d.id}: ${m[1]}`).toBeTruthy();
    expect(DEFAULT_BINDINGS.journal).toEqual(['J']);
  });
});

describe('starts', () => {
  it('the quick start is an Evacuee with the BN survivor kit', () => {
    const kit = kitPreview(data, professionDef(data, 'unemployed'), true);
    expect(kit.map((k) => k.id)).toEqual(expect.arrayContaining(['pockknife', 'lighter', 'mbag']));
    expect(kit.some((k) => /water/.test(k.name))).toBe(true);
    const b = buildFor(data, { unlockId: 'start_evacuee', profession: 'unemployed', scenario: 'evacuee', name: ' Kay Ng ', male: false, difficulty: 'accessible', title: '' });
    expect(b.name).toBe('Kay Ng');
    expect(b.scenario.id).toBe('evacuee');
    // Sidegrades: every start gets the same base stats and no traits.
    expect(b.stats).toEqual({ str: 8, dex: 8, int: 8, per: 8 });
    expect([...b.traits]).toEqual([]);
    expect(() => buildFor(data, { unlockId: 'x', profession: 'unemployed', scenario: 'evacuee', name: '  ', male: true, difficulty: 'accessible', title: '' })).toThrow(/name/);
    expect(() => buildFor(data, { unlockId: 'x', profession: 'unemployed', scenario: 'lab_chal', name: 'A', male: true, difficulty: 'accessible', title: '' })).toThrow(/placed/);
  });

  it('cards follow the ladder; scenario options include only unlocked, placeable ones', () => {
    const rec = new Set<string>();
    const cards = startCards(data, cat, (id) => rec.has(id), false);
    expect(cards.filter((c) => c.available).map((c) => c.unlock.id)).toEqual(['start_evacuee']);
    const evac = cards[0];
    expect(scenarioOptions(data, cat, evac, (id) => rec.has(id), false).map((s) => s.id)).toEqual(['evacuee']);
    rec.add('scen_wilderness');
    rec.add('scen_missed');
    expect(scenarioOptions(data, cat, evac, (id) => rec.has(id), false).map((s) => s.id).sort()).toEqual(['evacuee', 'missed', 'wilderness']);
    expect(startCards(data, cat, () => false, true).every((c) => c.available)).toBe(true);
  });
});

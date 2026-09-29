import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { Game } from '../src/game/game';
import { AchievementTracker, GlobalAchievements, type AchievementsData, type WorldQueries } from '../src/game/achievements';
import { installAchievements } from '../src/achievements';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let ach: AchievementsData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
  ach = load('achievements.json');
});

function queries(specials: Record<string, string> = {}, kills: Record<string, number> = {}): WorldQueries {
  return {
    speciesOf: (id) => data.monsters[id]?.species ?? [],
    terrainFlags: (id) => data.terrain[id]?.flags ?? [],
    isSwimmingTerrain: (id) => !!data.terrain[id]?.flags?.includes('DEEP_WATER'),
    itemFlags: (id) => data.items[id]?.flags ?? [],
    oterTypeOf: (id) => id,
    specialAt: (pos) => specials[pos] ?? '',
    // BN's kill-tier achievements use kill_requirements, which read the kill tracker.
    kills: () => kills,
  };
}

/** BN data plus synthetic defs for runtime mechanisms BN's own data doesn't exercise. */
function withExtra(extra: Partial<Record<keyof AchievementsData, Record<string, unknown>>>): AchievementsData {
  return {
    achievements: { ...ach.achievements, ...extra.achievements },
    statistics: { ...ach.statistics, ...extra.statistics },
    transformations: { ...ach.transformations, ...extra.transformations },
    scores: { ...ach.scores, ...extra.scores },
  } as AchievementsData;
}


/** A tracker at game time `t` (seconds since start), with the avatar created. */
function tracker(specials?: Record<string, string>, d0: AchievementsData = ach) {
  const d = d0;
  const killCounts: Record<string, number> = {};
  const t = new AchievementTracker(d, queries(specials, killCounts));
  let now = 0;
  t.now = () => now;
  t.startSeconds = () => 0;
  const done: string[] = [];
  t.onCompleted = (a) => done.push(a.id);
  // BN's avatar_id statistic reads game_start (src/achievements.ts emits both).
  t.emit('game_start', { avatar_id: 'avatar' });
  t.emit('game_avatar_new', { avatar_id: 'avatar', is_new_game: true, is_debug: false });
  t.flush();
  const kill = (mon: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      killCounts[mon] = (killCounts[mon] ?? 0) + 1;
      t.emit('character_kills_monster', { killer: 'avatar', victim_type: mon });
    }
    t.flush();
  };
  const wake = () => {
    t.emit('character_wakes_up', { character: 'avatar' });
    t.flush();
  };
  return { t, done, kill, wake, at: (s: number) => void (now = s) };
}

describe('achievements (BN achievements.json semantics)', () => {
  it('counts zombie kills through avatar_kills -> species transformations', () => {
    const { t, done, kill } = tracker();
    kill('mon_dog');
    expect(t.value('num_avatar_kills')).toBe(1);
    expect(t.value('num_avatar_zombie_kills')).toBe(0);
    expect(done).not.toContain('achievement_kill_zombie');
    kill('mon_zombie');
    expect(t.value('num_avatar_zombie_kills')).toBe(1);
    expect(done).toContain('achievement_kill_zombie');
    expect(t.completion('achievement_kill_zombie')).toBe('completed');
    // kills by someone else don't count
    t.emit('character_kills_monster', { killer: 'npc', victim_type: 'mon_zombie' });
    t.flush();
    expect(t.value('num_avatar_zombie_kills')).toBe(1);
  });

  it('kill-count achievements (kill_requirements) unlock at their target and hidden_by reveals the next tier', () => {
    const { t, done, kill } = tracker();
    const k100 = ach.achievements.achievement_kill_monsters_100;
    expect(k100.kill_requirements?.[0].count).toBe(100);
    expect(t.isHidden(k100)).toBe(true);
    kill('mon_zombie', 9);
    expect(done).not.toContain('achievement_kill_monsters_10');
    kill('mon_dog');
    expect(done).toContain('achievement_kill_monsters_10');
    expect(t.isHidden(k100)).toBe(false);
    // species-limited tier: 50 zombies, revealed by the first zombie kill
    expect(t.isHidden(ach.achievements.achievement_kill_zombie_50)).toBe(false);
    expect(done).not.toContain('achievement_kill_zombie_50');
    kill('mon_zombie', 41);
    expect(done).toContain('achievement_kill_zombie_50');
  });

  it('requirement lines show numeric progress', () => {
    const { t } = tracker();
    t.emit('avatar_moves', { mount: '', terrain: 't_floor', movement_mode: 'run', underwater: false, z: 0 }, 5);
    t.flush();
    expect(t.requirementLines(ach.achievements.achievement_marathon)[0]?.text).toMatch(/^5\/42196 /);
  });

  it('time_constraint <=: a kill in the first minute completes, a later one fails', () => {
    const a = tracker();
    a.at(30);
    a.kill('mon_zombie');
    expect(a.t.completion('achievement_kill_in_first_minute')).toBe('completed');
    const b = tracker();
    b.at(120);
    expect(b.t.completion('achievement_kill_in_first_minute')).toBe('failed');
    b.kill('mon_zombie');
    expect(b.done).not.toContain('achievement_kill_in_first_minute');
  });

  it('survive a day: needs a wake-up after a day (time_constraint >=)', () => {
    const { t, done, at, wake } = tracker();
    at(10 * 3600);
    wake();
    expect(t.completion('achievement_survive_one_day')).toBe('pending');
    at(25 * 3600);
    wake();
    expect(done).toContain('achievement_survive_one_day');
    expect(t.isHidden(ach.achievements.achievement_survive_7_days)).toBe(false);
    expect(t.completion('achievement_survive_7_days')).toBe('pending');
  });

  it('Pacifist: a week without kills completes on a wake-up; any kill spoils it', () => {
    const a = tracker();
    a.at(8 * 86400);
    a.wake();
    expect(a.done).toContain('achievement_kill_pacifist');
    const b = tracker();
    b.kill('mon_zombie');
    b.at(8 * 86400);
    b.wake();
    expect(b.done).not.toContain('achievement_kill_pacifist');
  });

  // BN has no "conduct" type; the runtime keeps DDA conduct semantics, tested on a synthetic def.
  it('conducts never complete, and fail once broken (synthetic conduct)', () => {
    const d = withExtra({
      achievements: {
        test_conduct_zero_kills: { id: 'test_conduct_zero_kills', name: 'Pacifist', conduct: true, requirements: [{ event_statistic: 'num_avatar_kills', is: '<=', target: 0 }] },
      },
    });
    const { t, done, kill, wake } = tracker(undefined, d);
    wake();
    expect(t.completion('test_conduct_zero_kills')).toBe('pending');
    kill('mon_zombie');
    expect(t.completion('test_conduct_zero_kills')).toBe('failed');
    expect(done).not.toContain('test_conduct_zero_kills');
  });

  it('movement statistics: z extremes, running and walking', () => {
    const { t, done } = tracker();
    t.emit('avatar_moves', { mount: '', terrain: 't_floor', movement_mode: 'run', underwater: false, z: 0 }, 5);
    t.emit('avatar_moves', { mount: '', terrain: 't_stairs_up', movement_mode: 'walk', underwater: false, z: -3 });
    t.flush();
    expect(t.value('num_moves_ran')).toBe(5);
    expect(t.value('num_moves_walked')).toBe(1);
    expect(t.value('num_moves')).toBe(6);
    expect(t.value('min_move_z')).toBe(-3);
    expect(done).not.toContain('achievement_reach_min_z_level');
    t.emit('avatar_moves', { mount: '', terrain: 't_rock_floor', movement_mode: 'walk', underwater: false, z: -10 });
    t.flush();
    expect(done).toContain('achievement_reach_min_z_level');
  });

  // BN has no "entered an overmap special" statistic; exercise avatar_enters_omt and the
  // oter_type_of_oter / overmap_special_at field transformations with DDA-shaped defs.
  it('entering an overmap special (synthetic avatar_enters_omt chain)', () => {
    const d = withExtra({
      transformations: {
        t_enters_oter_type: { id: 't_enters_oter_type', event_type: 'avatar_enters_omt', new_fields: { oter_type_id: { oter_type_of_oter: 'oter_id' } }, drop_fields: ['oter_id'] },
        t_enters_special: { id: 't_enters_special', event_transformation: 't_enters_oter_type', new_fields: { overmap_special_id: { overmap_special_at: 'pos' } } },
      },
      statistics: { last_special: { id: 'last_special', stat_type: 'last_value', event_transformation: 't_enters_special', field: 'overmap_special_id' } },
      achievements: { test_visit_refugees: { id: 'test_visit_refugees', name: 'Visit', requirements: [{ event_statistic: 'last_special', is: '==', target: ['overmap_special_id', 'evac_center'] }] } },
    });
    const { t, done } = tracker({ '5,5,0': 'evac_center' }, d);
    t.emit('avatar_enters_omt', { pos: '5,5,0', oter_id: 'evac_center_1' });
    t.flush();
    expect(t.value('last_special')).toBe('evac_center');
    expect(done).toContain('test_visit_refugees');
  });

  it('mutation thresholds and skill_requirements achievements are tracked', () => {
    const { t, done } = tracker();
    t.emit('crosses_mutation_threshold', { character: 'avatar', category: 'LIZARD' });
    t.flush();
    const lizard = Object.values(ach.achievements).find((a) => a.requirements.some((r) => r.event_statistic === 'num_avatar_mutation_threshold_lizard'))!;
    expect(done).toContain(lizard.id);
    const skill = Object.values(ach.achievements).find((a) => a.skill_requirements?.some((s) => s.skill === 'melee'))!;
    expect(t.achievementSupported(skill)).toBe(true);
    // BN tracks the Mycus threshold through its own event.
    const mycus = Object.values(ach.achievements).find((a) => a.requirements.some((r) => r.event_statistic === 'num_avatar_mutation_threshold_mycus'))!;
    expect(t.achievementSupported(mycus)).toBe(true);
  });

  it('the BN avatar_id statistic comes from game_start, which the port supports', () => {
    expect(ach.statistics.avatar_id.event_type).toBe('game_start');
    const t = new AchievementTracker(ach, queries());
    expect(t.achievementSupported(ach.achievements.achievement_kill_zombie)).toBe(true);
  });

  it('marks achievements fed by events this port never emits as unsupported', () => {
    const d = withExtra({
      transformations: { t_headshots: { id: 't_headshots', event_type: 'character_gets_headshot' } },
      statistics: { num_headshots: { id: 'num_headshots', stat_type: 'count', event_transformation: 't_headshots' } },
      achievements: { test_headshots: { id: 'test_headshots', name: 'Headshots', requirements: [{ event_statistic: 'num_headshots', is: '>=', target: 1 }] } },
    });
    const { t } = tracker(undefined, d);
    expect(t.achievementSupported(d.achievements.test_headshots)).toBe(false);
    expect(t.achievementSupported(ach.achievements.achievement_kill_zombie)).toBe(true);
  });

  it('scores read their statistics', () => {
    const { t, kill } = tracker();
    kill('mon_zombie', 2);
    expect(ach.scores.score_kills.statistic).toBe('num_avatar_kills');
    expect(t.value(ach.scores.score_kills.statistic)).toBe(2);
  });

  it('round-trips through JSON (save/load)', () => {
    const { t, kill } = tracker();
    kill('mon_zombie', 3);
    const j = JSON.parse(JSON.stringify(t.toJSON()));
    const u = new AchievementTracker(ach, queries());
    u.load(j);
    expect(u.value('num_avatar_zombie_kills')).toBe(3);
    expect(u.completion('achievement_kill_zombie')).toBe('completed');
  });

  it('global store keeps completions across characters', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    new GlobalAchievements(store).add('achievement_kill_zombie', 'Alice');
    const g = new GlobalAchievements(store);
    expect(g.has('achievement_kill_zombie')).toBe(true);
    expect(g.get('achievement_kill_zombie')?.avatars).toEqual(['Alice']);
  });
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}
const fakeInput = () => ({ held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] }) as unknown as Input;

describe('achievements install (game events -> BN events)', () => {
  it('feeds kills, moves, skills and wake-ups from the running game', async () => {
    const game = new Game(data, 3, fakeInput());
    game.map.generator = new FlatGen();
    game.player.x = 12.5;
    game.player.y = 12.5;
    const h = await installAchievements(game, null, undefined, ach);
    const msgs: string[] = [];
    game.events.on('message', (m) => msgs.push(m.text));
    h.begin(false);
    // BN kill achievements check kill_requirements against game.stats.kills, which src/ui
    // counts from creatureDied; there is no UI here, so count the kill like it does.
    game.stats.addKill('mon_zombie');
    game.events.emit('creatureDied', { creature: { type: { id: 'mon_zombie' } }, killer: game.player });
    game.tick(1 / 30);
    expect(h.tracker.completion('achievement_kill_zombie')).toBe('completed');
    expect(msgs.some((m) => /One Down, Billions to Go/i.test(m))).toBe(true);
    game.player.x += 1;
    game.tick(1 / 30);
    expect(h.tracker.value('num_moves')).toBeGreaterThanOrEqual(1);
    game.player.setSkill('melee', 4);
    for (let i = 0; i < 20; i++) game.tick(1 / 30);
    expect(h.tracker.value('num_gains_melee')).toBeGreaterThanOrEqual(1);
    expect(h.completedThisRun().map((a) => a.id)).toContain('achievement_kill_zombie');
  });
});

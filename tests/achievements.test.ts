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

function queries(specials: Record<string, string> = {}): WorldQueries {
  return {
    speciesOf: (id) => data.monsters[id]?.species ?? [],
    terrainFlags: (id) => data.terrain[id]?.flags ?? [],
    isSwimmingTerrain: (id) => !!data.terrain[id]?.flags?.includes('DEEP_WATER'),
    itemFlags: (id) => data.items[id]?.flags ?? [],
    oterTypeOf: (id) => id,
    specialAt: (pos) => specials[pos] ?? '',
  };
}

/** A tracker at game time `t` (seconds since start), with the avatar created. */
function tracker(specials?: Record<string, string>) {
  const t = new AchievementTracker(ach, queries(specials));
  let now = 0;
  t.now = () => now;
  t.startSeconds = () => 0;
  const done: string[] = [];
  t.onCompleted = (a) => done.push(a.id);
  t.emit('game_avatar_new', { avatar_id: 'avatar', is_new_game: true, is_debug: false });
  t.flush();
  const kill = (mon: string, n = 1) => {
    for (let i = 0; i < n; i++) t.emit('character_kills_monster', { killer: 'avatar', victim_type: mon });
    t.flush();
  };
  return { t, done, kill, at: (s: number) => void (now = s) };
}

describe('achievements (CDDA achievements.json semantics)', () => {
  it('counts zombie kills through avatar_kills_monster -> species transformations', () => {
    const { t, done, kill } = tracker();
    kill('mon_dog');
    expect(t.value('num_avatar_monster_kills')).toBe(1);
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

  it('kill-count achievements unlock at their target and hidden_by reveals the next tier', () => {
    const { t, done, kill } = tracker();
    const k100 = ach.achievements.achievement_kill_100_monsters;
    expect(t.isHidden(k100)).toBe(true);
    kill('mon_zombie', 9);
    expect(done).not.toContain('achievement_kill_10_monsters');
    kill('mon_zombie');
    expect(done).toContain('achievement_kill_10_monsters');
    expect(t.isHidden(k100)).toBe(false);
    expect(t.requirementLines(k100)[0]?.text).toMatch(/^10\/100 /);
    expect(t.isHidden(ach.achievements.achievement_kill_1000_monsters)).toBe(true);
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

  it('survive a day: needs a wake-up after 16 hours (time_constraint >=)', () => {
    const { t, done, at } = tracker();
    at(10 * 3600);
    t.emit('character_wakes_up', { character: 'avatar' });
    t.flush();
    expect(t.completion('achievement_survive_one_day')).toBe('pending');
    at(17 * 3600);
    t.emit('character_wakes_up', { character: 'avatar' });
    t.flush();
    expect(done).toContain('achievement_survive_one_day');
    expect(t.isHidden(ach.achievements.achievement_survive_7_days)).toBe(false);
    expect(t.completion('achievement_survive_7_days')).toBe('pending');
  });

  it('conducts never complete, and fail once broken', () => {
    const { t, done, kill } = tracker();
    const pacifist = ach.achievements.conduct_zero_kills;
    expect(pacifist.conduct).toBe(true);
    t.emit('character_wakes_up', { character: 'avatar' });
    t.flush();
    expect(t.completion('conduct_zero_kills')).toBe('pending');
    kill('mon_zombie');
    expect(t.completion('conduct_zero_kills')).toBe('failed');
    expect(done).not.toContain('conduct_zero_kills');
    // "Merciful" is hidden by Pacifist until Pacifist fails
    expect(t.isHidden(ach.achievements.conduct_zero_character_kills)).toBe(false);
  });

  it('movement statistics: z extremes, running, and entering an overmap special', () => {
    const { t, done } = tracker({ '5,5,0': 'evac_center' });
    t.emit('avatar_moves', { mount: '', terrain: 't_floor', movement_mode: 'run', underwater: false, z: 0 }, 5);
    t.emit('avatar_moves', { mount: '', terrain: 't_stairs_up', movement_mode: 'walk', underwater: false, z: -3 });
    t.flush();
    expect(t.value('num_moves_ran')).toBe(5);
    expect(t.value('num_moves_walked')).toBe(1);
    expect(t.value('min_move_z')).toBe(-3);
    t.emit('avatar_enters_omt', { pos: '5,5,0', oter_id: 'evac_center_1' });
    t.flush();
    expect(t.value('last_overmap_special_avatar_entered')).toBe('evac_center');
    const home = Object.values(ach.achievements).find((a) => a.requirements.some((r) => Array.isArray(r.target) && r.target[1] === 'evac_center'))!;
    expect(done).toContain(home.id);
  });

  it('marks achievements fed by events this port never emits as unsupported', () => {
    const { t } = tracker();
    const plane = Object.values(ach.achievements).find((a) => a.requirements.some((r) => r.event_statistic === 'num_moves_acft_ctrl_direct'))!;
    expect(t.achievementSupported(plane)).toBe(false);
    expect(t.achievementSupported(ach.achievements.achievement_kill_zombie)).toBe(true);
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

describe('achievements install (game events -> CDDA events)', () => {
  it('feeds kills, moves, skills and wake-ups from the running game', async () => {
    const game = new Game(data, 3, fakeInput());
    game.map.generator = new FlatGen();
    game.player.x = 12.5;
    game.player.y = 12.5;
    const h = await installAchievements(game, null, undefined, ach);
    const msgs: string[] = [];
    game.events.on('message', (m) => msgs.push(m.text));
    h.begin(false);
    game.events.emit('creatureDied', { creature: { type: { id: 'mon_zombie' } }, killer: game.player });
    game.tick(1 / 30);
    expect(h.tracker.completion('achievement_kill_zombie')).toBe('completed');
    expect(msgs.some((m) => m.includes('One down, billions to go'))).toBe(true);
    game.player.x += 1;
    game.tick(1 / 30);
    expect(h.tracker.value('num_moves')).toBeGreaterThanOrEqual(1);
    game.player.setSkill('melee', 4);
    for (let i = 0; i < 20; i++) game.tick(1 / 30);
    expect(h.tracker.value('num_gains_melee_level_4')).toBe(1);
    expect(h.completedThisRun().map((a) => a.id)).toContain('achievement_kill_zombie');
  });
});

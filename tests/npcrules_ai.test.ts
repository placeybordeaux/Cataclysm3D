// The NPC AI obeying BN's npc_follower_rules (src/game/npcrules.ts, npctactics.ts, npcai.ts):
// engagement, aim, guns/silence/grenades, friendly fire, following distance and pace, doors,
// bashing, pulping, complaining and noise investigation. Each rule gets a scripted follower
// against real BN data (zombies, guns, terrain), set the way the dialogue menus set it.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem } from '../src/game/npcai';
import { Npc, type NpcData } from '../src/game/npc';
import { Dialogue } from '../src/game/talk';
import { createItem, defaultLoad, loadAmmo, MAX_ITEM_DAMAGE, type Item } from '../src/game/item';
import { MAX_RECOIL, SLEEPINESS } from '../src/game/character';
import { enemyFireOf } from '../src/game/enemyfire';
import { emitSound } from '../src/game/sound';
import { NpcRules, STORED_ONLY, AI_HONORED, ALLY_RULES } from '../src/game/npcrules';
import { resetWarnings } from '../src/data/warn';
import {
  confidenceMult, confidentGunRange, defenseRadius, emergency, followDistance, isSilentGun, monsterDifficulty, okByRules,
  rangeWithEvenChance, evenGoodTable, tooClose, wontHitFriend, type EngagementCtx,
} from '../src/game/npctactics';
import type { Monster } from '../src/game/monster';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let nd: NpcData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
  nd = load('npcs.json');
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function world(seed = 31) {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
  const game = new Game(data, seed, input as unknown as Input);
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -2; y <= 3; y++) for (let x = -2; x <= 3; x++) game.map.chunk(x, y, 0);
  const mons = new MonsterSystem(game);
  const npcs = new NpcSystem(game, nd, mons);
  (game as unknown as { monsters: MonsterSystem; npcs: NpcSystem }).monsters = mons;
  (game as unknown as { npcs: NpcSystem }).npcs = npcs;
  game.systems.push(mons, npcs);
  game.clock.seconds = 12 * 3600;
  const msgs: string[] = [];
  game.events.on('message', (m) => msgs.push(m.text));
  const step = (s: number, each?: () => void) => {
    for (let i = 0; i < Math.round(s * 30); i++) {
      game.tick(1 / 30);
      each?.();
    }
  };
  /** A recruited follower ("follow" effect, as the recruitment dialogue does) with a fixed loadout. */
  const ally = (x: number, y: number, weapon: string | null = null): Npc => {
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, x, y, 0)!;
    new Dialogue(npcs, n).effect('follow');
    for (const it of [...n.inv.allItems()]) n.inv.drop(it);
    n.inv.wear(createItem(data, 'backpack'), null);
    n.personality.bravery = 10;
    n.storedKcal = n.maxStoredKcal();
    n.thirst = 0;
    if (weapon) {
      const w = createItem(data, weapon);
      const a = defaultLoad(w);
      if (a) loadAmmo(w, a);
      expect(n.inv.wield(w, null).ok).toBe(true);
    }
    return n;
  };
  const zombie = (x: number, y: number, id = 'mon_zombie'): Monster => {
    const m = mons.spawnById(id, x + 0.5, y + 0.5, 0)!;
    m.aggroCharacter = true;
    return m;
  };
  /** One planning pass, right now (NpcSystem.think is private; the update loop calls it at 4 Hz). */
  const think = (n: Npc) => {
    npcs.grid.reset();
    (npcs as unknown as { think(n: Npc): void }).think(n);
  };
  const setTer = (x: number, y: number, id: string) => game.map.setTer(x, y, 0, id);
  /** Rounds NPCs fire (the recoil they fired at and who fired). */
  const shots: { by: unknown; recoil: number }[] = [];
  const ef = enemyFireOf(game);
  const fire = ef.fire.bind(ef);
  ef.fire = ((o: Parameters<typeof fire>[0]) => {
    const by = o.from as Npc;
    shots.push({ by, recoil: by.recoil });
    return fire(o);
  }) as typeof ef.fire;
  return { game, mons, npcs, msgs, step, ally, zombie, think, setTer, shots };
}

/** Pin a monster in place (keeps a scenario's geometry while time runs). */
const pin = (m: Monster, x: number, y: number) => () => {
  m.x = x + 0.5;
  m.y = y + 0.5;
};

describe('BN arithmetic (npctactics.ts)', () => {
  const ctx = (o: Partial<EngagementCtx> & { engagement?: string }): EngagementCtx => {
    const rules = new NpcRules();
    if (o.engagement) rules.engagement = o.engagement;
    return {
      rules, maxRange: 1, followDist: 2, dist: 5, scaledDist: 7, distToPlayer: 20, distToFriend: 20,
      hitByPlayer: false, targetHp: 80, averageDamage: 10, inEmergency: false, ...o,
    };
  };

  it('ok_by_rules per engagement rule (npcmove.cpp assess_danger)', () => {
    expect(okByRules(ctx({ engagement: 'ENGAGE_NONE', dist: 1 }))).toBe(false);
    // CLOSE: close to the survivor, or within reach and half the defence radius away
    expect(okByRules(ctx({ engagement: 'ENGAGE_CLOSE' }))).toBe(false);
    expect(okByRules(ctx({ engagement: 'ENGAGE_CLOSE', distToPlayer: 6 }))).toBe(true);
    expect(okByRules(ctx({ engagement: 'ENGAGE_CLOSE', maxRange: 5, dist: 5, scaledDist: 3 }))).toBe(true);
    expect(okByRules(ctx({ engagement: 'ENGAGE_WEAK', targetHp: 80 }))).toBe(false);
    expect(okByRules(ctx({ engagement: 'ENGAGE_WEAK', targetHp: 9 }))).toBe(true);
    expect(okByRules(ctx({ engagement: 'ENGAGE_HIT' }))).toBe(false);
    expect(okByRules(ctx({ engagement: 'ENGAGE_HIT', hitByPlayer: true }))).toBe(true);
    expect(okByRules(ctx({ engagement: 'ENGAGE_NO_MOVE', maxRange: 4, dist: 5 }))).toBe(false);
    expect(okByRules(ctx({ engagement: 'ENGAGE_FREE_FIRE', maxRange: 6, dist: 5 }))).toBe(true);
    expect(okByRules(ctx({ engagement: 'ENGAGE_ALL', dist: 40 }))).toBe(true);
    const forbid = ctx({ engagement: 'ENGAGE_ALL' });
    forbid.rules.flags.add('forbid_engage');
    expect(okByRules(forbid)).toBe(false);
  });

  it('def_radius and "too close" (always fair game, rules or not)', () => {
    expect(defenseRadius(ctx({}))).toBe(6);
    const close = ctx({});
    close.rules.flags.add('follow_close');
    expect(defenseRadius(close)).toBe(2);
    expect(defenseRadius(ctx({ engagement: 'ENGAGE_FREE_FIRE', maxRange: 9 }))).toBe(9);
    expect(defenseRadius(ctx({ engagement: 'ENGAGE_NONE', maxRange: 1 }))).toBe(1);
    expect(defenseRadius(ctx({ inEmergency: true, maxRange: 3 }))).toBe(3);
    // near a friend counts, unless the NPC only defends itself
    expect(tooClose(ctx({ distToFriend: 4 }))).toBe(true);
    expect(tooClose(ctx({ engagement: 'ENGAGE_NO_MOVE', distToFriend: 0 }))).toBe(false);
    expect(tooClose(ctx({ engagement: 'ENGAGE_NO_MOVE', dist: 1 }))).toBe(true);
  });

  it('confidence_mult by aim rule; even-chance ranges from BN hit_range.json', () => {
    expect(confidenceMult('AIM_WHEN_CONVENIENT', true, false)).toBe(1);
    expect(confidenceMult('AIM_WHEN_CONVENIENT', true, true)).toBe(1.5);
    expect(confidenceMult('AIM_SPRAY', true, false)).toBe(2);
    expect(confidenceMult('AIM_PRECISE', true, false)).toBe(0.75);
    expect(confidenceMult('AIM_PRECISE', true, true)).toBe(1);
    expect(confidenceMult('AIM_STRICTLY_PRECISE', true, true)).toBe(0.5);
    expect(confidenceMult('AIM_SPRAY', false, false)).toBe(1); // only allies take orders
    const t = evenGoodTable(data);
    expect(t[0]).toBe(1724); // data/json/hit_range.json
    expect(rangeWithEvenChance(t, 3000)).toBe(0);
    expect(rangeWithEvenChance(t, 100)).toBe(17); // even_good[16] = 101, [17] = 95
  });

  it('follow_distance: 2 with follow_distance_2 or out of sight, 4 otherwise, 1 on stairs', () => {
    const r = new NpcRules();
    expect(followDistance(r, { walkingWith: true, playerOnStairs: false, seesPlayer: true })).toBe(2); // default rules carry it
    r.flags.delete('follow_distance_2');
    expect(followDistance(r, { walkingWith: true, playerOnStairs: false, seesPlayer: true })).toBe(4);
    expect(followDistance(r, { walkingWith: true, playerOnStairs: false, seesPlayer: false })).toBe(2);
    expect(followDistance(r, { walkingWith: true, playerOnStairs: true, seesPlayer: true })).toBe(1);
  });

  it('wont_hit_friend keeps 30° (more for close friends) clear of the line of fire', () => {
    const from = { x: 10.5, y: 10.5 }, tar = { x: 20.5, y: 10.5 };
    expect(wontHitFriend(from, tar, [{ x: 15.5, y: 10.5 }], 5)).toBe(false);
    expect(wontHitFriend(from, tar, [{ x: 15.5, y: 16.5 }], 5)).toBe(true);
    expect(wontHitFriend(from, tar, [{ x: 11.5, y: 10.5 }], 5)).toBe(true); // adjacent: the round spares them
    expect(wontHitFriend(from, tar, [{ x: 12.5, y: 11.5 }], 5)).toBe(false); // 2 tiles: 60° cone
    expect(wontHitFriend(from, { x: 11.5, y: 10.5 }, [{ x: 15.5, y: 10.5 }], 5)).toBe(true); // point blank
  });

  it('mtype difficulty and npc::emergency', () => {
    expect(monsterDifficulty(data.monsters.mon_zombie)).toBe(4);
    expect(monsterDifficulty(data.monsters.mon_zombie_hulk)).toBeGreaterThan(monsterDifficulty(data.monsters.mon_zombie_brute));
    const { ally } = world();
    const n = ally(30, 30);
    expect(emergency(n, 10, -10)).toBe(false);
    n.stamina = 0;
    expect(emergency(n, 2, 0)).toBe(true); // winded
    n.stamina = n.staminaMax();
    expect(emergency(n, 2, 7)).toBe(true); // 7 > 2 × 3 at full health
  });

  it('cbm_reserve / cbm_recharge thresholds (npc::can_use_offensive_cbm, wants_to_recharge_cbm)', () => {
    const r = new NpcRules();
    expect(r.canUseOffensiveCbm(60, 100)).toBe(true); // SOME keeps 50 %
    expect(r.canUseOffensiveCbm(40, 100)).toBe(false);
    r.cbmReserve = 'CBM_RESERVE_NONE';
    expect(r.canUseOffensiveCbm(1, 100)).toBe(true);
    r.cbmReserve = 'CBM_RESERVE_ALL';
    expect(r.canUseOffensiveCbm(100, 100)).toBe(false);
    expect(r.wantsToRechargeCbm(40, 100, true)).toBe(true); // SOME: below 50 %
    expect(r.wantsToRechargeCbm(40, 100, false)).toBe(false);
    r.cbmRecharge = 'CBM_RECHARGE_NONE';
    expect(r.wantsToRechargeCbm(11, 100, true)).toBe(false);
    r.cbmRecharge = 'CBM_RECHARGE_ALL';
    expect(r.wantsToRechargeCbm(89, 100, true)).toBe(true);
  });

  it('use_silent: BN item::is_silent is gun noise under 50', () => {
    const fake = (v: number) => ({ gunNoise: () => ({ volume: v, sound: '' }) }) as unknown as Item;
    expect(isSilentGun(fake(49))).toBe(true);
    expect(isSilentGun(fake(50))).toBe(false);
    const ar = createItem(data, 'ar15');
    loadAmmo(ar, defaultLoad(ar)!);
    expect(isSilentGun(ar)).toBe(false); // 5.56 is loud
  });
});

describe('engagement rules', () => {
  it('ENGAGE_CLOSE (default) fights a zombie nearby; ENGAGE_NONE leaves it until it is in reach', () => {
    const { ally, zombie, think } = world();
    const n = ally(30, 30, 'bat');
    const z = zombie(30, 26);
    think(n);
    expect(n.goal.kind).toBe('fight');
    n.rules.engagement = 'ENGAGE_NONE';
    n.goal.kind = 'none';
    think(n);
    expect(n.goal.kind).not.toBe('fight');
    z.x = 30.5; z.y = 29.5; // adjacent: self defence
    think(n);
    expect(n.goal.kind).toBe('fight');
  });

  it('ENGAGE_CLOSE takes on what threatens the survivor, ENGAGE_NONE does not', () => {
    const { game, ally, zombie, think } = world();
    const n = ally(30, 30, 'bat');
    game.player.x = 30.5; game.player.y = 20.5;
    zombie(30, 17); // 3 from the survivor, 13 from the NPC
    think(n);
    expect(n.goal.kind).toBe('fight');
    n.rules.engagement = 'ENGAGE_NONE';
    think(n);
    expect(n.goal.kind).not.toBe('fight');
  });

  it('ENGAGE_ALL goes after a dangerous monster far off that ENGAGE_CLOSE ignores', () => {
    const { ally, zombie, think } = world();
    const n = ally(30, 30, 'bat');
    zombie(30, 20, 'mon_zombie_hulk'); // 10 tiles, far from the survivor
    think(n);
    expect(n.goal.kind).not.toBe('fight');
    n.rules.engagement = 'ENGAGE_ALL';
    think(n);
    expect(n.goal.kind).toBe('fight');
  });

  it('ENGAGE_WEAK only picks on what one blow would kill', () => {
    const { ally, zombie, think } = world();
    const n = ally(30, 30, 'bat');
    n.rules.engagement = 'ENGAGE_WEAK';
    // outside the defence radius (6) so the rule decides
    const z = zombie(30, 22, 'mon_zombie_hulk');
    think(n);
    expect(n.goal.kind).not.toBe('fight');
    z.hp = 1;
    think(n);
    expect(n.goal.kind).toBe('fight');
  });

  it('ENGAGE_HIT waits for the survivor to hit it first', () => {
    const { ally, zombie, think } = world();
    const n = ally(30, 30, 'bat');
    n.rules.engagement = 'ENGAGE_HIT';
    const z = zombie(30, 20, 'mon_zombie_hulk');
    think(n);
    expect(n.goal.kind).not.toBe('fight');
    z.addEffect('hit_by_player', 30);
    think(n);
    expect(n.goal.kind).toBe('fight');
  });

  it('ENGAGE_NO_MOVE holds position: melee only what comes into reach, never closes in', () => {
    const { game, ally, zombie, step } = world();
    const n = ally(30, 30, 'bat');
    game.player.x = 31.5; game.player.y = 31.5; // close by: no reason to follow
    n.rules.engagement = 'ENGAGE_NO_MOVE';
    const z = zombie(30, 27);
    step(2, pin(z, 30, 27));
    expect(Math.hypot(n.x - 30.5, n.y - 30.5)).toBeLessThan(0.3);
    expect(z.hp).toBe(z.hpMax);
    // default rules: the same NPC walks up and hits it
    n.rules.engagement = 'ENGAGE_CLOSE';
    step(4, pin(z, 30, 27));
    expect(z.dead || z.hp < z.hpMax).toBe(true);
  });

  it('ENGAGE_FREE_FIRE shoots from where it stands but never chases', () => {
    const { game, ally, zombie, step, shots } = world();
    const n = ally(30, 30, 'ar15');
    game.player.x = 31.5; game.player.y = 31.5;
    n.rules.clearFlag('allow_pulp'); // or it walks over to pulp the first one
    n.rules.engagement = 'ENGAGE_FREE_FIRE';
    const z = zombie(30, 26); // inside its confident range once aimed
    step(4, pin(z, 30, 26));
    expect(shots.some((s) => s.by === n)).toBe(true);
    expect(Math.hypot(n.x - 30.5, n.y - 30.5)).toBeLessThan(0.3);
    const far = zombie(30, 15); // too far to trust a shot: stands, doesn't chase
    z.hp = 0; z.dead = true;
    const before = shots.length;
    step(3, pin(far, 30, 15));
    expect(shots.length).toBe(before);
    expect(Math.hypot(n.x - 30.5, n.y - 30.5)).toBeLessThan(0.3);
  });

  it('forbid_engage: no targets at all, even a zombie next to it', () => {
    const { ally, zombie, think } = world();
    const n = ally(30, 30, 'bat');
    n.rules.flags.add('forbid_engage');
    zombie(30, 29);
    think(n);
    expect(n.goal.kind).not.toBe('fight');
  });
});

describe('aim rule', () => {
  /** Recoil at the ally's first shot at a pinned zombie 4 tiles away under `aimRule`. */
  const firstShot = (aimRule: string) => {
    const { ally, zombie, step, shots } = world();
    const n = ally(30, 30, 'ar15');
    n.rules.aim = aimRule;
    const z = zombie(30, 26);
    for (let i = 0; i < 300 && !shots.some((s) => s.by === n); i++) step(1 / 30, pin(z, 30, 26));
    return shots.find((s) => s.by === n);
  };

  it('aims before firing (BN npc::aim) instead of shooting unaimed', () => {
    const s = firstShot('AIM_WHEN_CONVENIENT')!;
    expect(s).toBeTruthy();
    expect(s.recoil).toBeLessThan(MAX_RECOIL / 3);
  });

  it('AIM_SPRAY fires sooner and looser than AIM_PRECISE', () => {
    const spray = firstShot('AIM_SPRAY')!, precise = firstShot('AIM_PRECISE')!;
    expect(spray.recoil).toBeGreaterThan(precise.recoil);
  });

  it("AIM_STRICTLY_PRECISE doesn't shoot beyond what it can aim for; it closes in instead", () => {
    const { ally, zombie, step, shots } = world();
    const n = ally(30, 30, 'ar15');
    n.rules.aim = 'AIM_STRICTLY_PRECISE';
    n.rules.engagement = 'ENGAGE_ALL';
    const w = n.inv.wielded!;
    const best = confidentGunRange(data, n, w, 0, 0.5);
    const z = zombie(30, 30 - (best + 2));
    step(1, pin(z, 30, 30 - (best + 2)));
    expect(shots.some((s) => s.by === n)).toBe(false);
    expect(n.y).toBeLessThan(30.3); // walked toward it
  });
});

describe('guns, silence, grenades, friendly fire', () => {
  it('use_guns off: melee only, no rounds spent', () => {
    const { ally, zombie, step, shots } = world();
    const n = ally(30, 30, 'ar15');
    n.rules.clearFlag('use_guns');
    const z = zombie(30, 26);
    step(3, pin(z, 30, 26));
    expect(shots.some((s) => s.by === n)).toBe(false);
  });

  it('use_silent: a loud gun stays quiet', () => {
    const { game, ally, zombie, step, shots } = world();
    const n = ally(30, 30, 'ar15');
    game.player.x = 31.5; game.player.y = 31.5;
    n.rules.engagement = 'ENGAGE_NO_MOVE'; // keep the range: no walking up to club it
    n.rules.setFlag('use_silent');
    const ammo = n.inv.wielded!.ammoRemaining();
    const z = zombie(30, 27);
    step(3, pin(z, 30, 27));
    expect(shots.some((s) => s.by === n)).toBe(false);
    expect(n.inv.wielded!.ammoRemaining()).toBe(ammo);
    n.rules.clearFlag('use_silent');
    step(3, pin(z, 30, 27));
    expect(shots.some((s) => s.by === n)).toBe(true);
  });

  it("holds fire with the survivor in the line of fire and side-steps (wont_hit_friend / avoid_friendly_fire)", () => {
    const { game, ally, zombie, step, shots } = world();
    const n = ally(30, 30, 'ar15');
    n.rules.engagement = 'ENGAGE_ALL';
    const z = zombie(30, 25);
    game.player.x = 30.5; game.player.y = 27.5; // between them
    const x0 = n.x;
    for (let i = 0; i < 20; i++) {
      game.tick(1 / 30);
      pin(z, 30, 25)();
      game.player.x = 30.5; game.player.y = 27.5;
    }
    expect(shots.some((s) => s.by === n)).toBe(false);
    expect(Math.abs(n.x - x0)).toBeGreaterThan(0.05); // stepped aside
  });

  it('use_grenades: in an emergency it arms and throws an alt-attack explosive; never with the rule off', () => {
    for (const allowed of [true, false]) {
      const { game, ally, zombie, step, npcs, msgs } = world();
      game.player.x = 31.5; game.player.y = 31.5; // an emergency far from the survivor means running back to them
      const thrown: Item[] = [];
      npcs.onThrownExplosive = (it) => void thrown.push(it);
      // npc::emergency narrows it to self-defence (targets within its confident range), so it
      // carries a gun to have one 4 tiles off.
      const n = ally(30, 30, 'ar15');
      if (!allowed) n.rules.clearFlag('use_grenades');
      // BN data gives no grenade NPC_ALT_ATTACK (only molotov_lit is NPC_THROW_NOW); the item flag
      // is what npc::alt_attack looks for, so the test grenade carries it.
      const g = createItem(data, 'grenade');
      g.flags.push('NPC_ALT_ATTACK', 'NPC_ACTIVATE');
      expect(n.inv.giveNew(g)).not.toBeNull();
      n.stamina = 0; // winded: npc::emergency
      n.personality.bravery = 0;
      const z = zombie(30, 26);
      step(0.5, pin(z, 30, 26));
      if (allowed) {
        expect(thrown.length).toBe(1);
        expect(thrown[0].typeId).toBe('grenade_act');
        expect(thrown[0].active).toBe(true);
        expect(msgs.some((m) => m.includes('throws a'))).toBe(true);
      } else expect(thrown.length).toBe(0);
    }
  });
});

describe('following', () => {
  it('follow_distance_2 (default) keeps ~2 tiles; without it ~4', () => {
    for (const [two, lo, hi] of [[true, 1.5, 3.3], [false, 3.4, 5.3]] as const) {
      const { game, ally, step } = world();
      const n = ally(13, 12);
      if (!two) n.rules.clearFlag('follow_distance_2');
      game.player.x = 30.5;
      step(8);
      const d = Math.hypot(n.x - game.player.x, n.y - game.player.y);
      expect(d).toBeGreaterThan(lo);
      expect(d).toBeLessThan(hi);
    }
  });

  it('follow_close: a follower out of place comes back instead of fighting', () => {
    const { game, ally, zombie, think } = world();
    const n = ally(30, 30, 'bat');
    game.player.x = 30.5; game.player.y = 40.5; // 10 tiles away
    zombie(30, 26);
    think(n);
    expect(n.goal.kind).toBe('fight');
    n.rules.setFlag('follow_close');
    think(n);
    expect(n.goal.kind).toBe('follow');
  });

  it('move_own_pace: runs to catch up, walks near; otherwise matches the survivor (crouching)', () => {
    const { game, ally, npcs } = world();
    const n = ally(30, 30);
    const pace = (fd: number) => (npcs as unknown as { followPace(n: Npc, fd: number): number }).followPace(n, fd);
    game.player.x = 34.5; game.player.y = 30.5;
    game.player.crouching = true;
    expect(pace(2)).toBe(0.5);
    n.rules.setFlag('move_own_pace');
    expect(pace(2)).toBe(1);
    game.player.x = 45.5;
    expect(pace(2)).toBe(2);
  });
});

describe('doors and obstacles', () => {
  /** A closed 5×5 room (walls at x/y 20 and 26) with one gap at (23, 20) holding `gap`. */
  const room = (setTer: (x: number, y: number, id: string) => void, gap: string) => {
    for (let i = 20; i <= 26; i++) {
      setTer(i, 20, 't_wall'); setTer(i, 26, 't_wall'); setTer(20, i, 't_wall'); setTer(26, i, 't_wall');
    }
    setTer(23, 20, gap);
  };

  it('avoid_doors keeps it inside a room with a closed door; by default it opens the door', () => {
    for (const avoid of [true, false]) {
      const { game, ally, step, setTer } = world();
      room(setTer, 't_door_c');
      const n = ally(23, 23);
      if (avoid) n.rules.setFlag('avoid_doors');
      game.player.x = 23.5; game.player.y = 12.5;
      step(6);
      const inside = n.y > 20.5;
      expect(inside).toBe(avoid);
      expect(game.map.terAt(23, 20, 0).id).toBe(avoid ? 't_door_c' : 't_door_o');
    }
  });

  it('close_doors shuts the door behind it', () => {
    for (const close of [true, false]) {
      const { game, ally, step, setTer } = world();
      room(setTer, 't_door_c');
      const n = ally(23, 23);
      if (close) n.rules.setFlag('close_doors');
      game.player.x = 23.5; game.player.y = 12.5;
      step(8);
      expect(n.y).toBeLessThan(20);
      expect(game.map.terAt(23, 20, 0).id).toBe(close ? 't_door_c' : 't_door_o');
    }
  });

  it('allow_bash: smashes the window out of a closed room; without it, stays put', () => {
    for (const allow of [true, false]) {
      const { game, ally, step, setTer } = world();
      room(setTer, 't_window');
      const n = ally(23, 23, 'bat');
      if (allow) n.rules.setFlag('allow_bash');
      game.player.x = 23.5; game.player.y = 12.5;
      step(12);
      expect(game.map.terAt(23, 20, 0).id === 't_window').toBe(!allow);
      expect(n.y < 20.5).toBe(allow);
    }
  });

  it("hold_the_line: won't step into the open doorway next to the survivor", () => {
    for (const hold of [true, false]) {
      const { game, ally, step, setTer } = world();
      room(setTer, 't_door_o');
      const n = ally(23, 23);
      if (hold) n.rules.setFlag('hold_the_line');
      game.player.x = 24.5; game.player.y = 19.5; // outside, diagonal to the doorway
      let entered = false;
      step(6, () => { if (n.tileX === 23 && n.tileY === 20) entered = true; });
      expect(entered).toBe(!hold);
    }
  });
});

describe('pulping, complaining, noise', () => {
  it('allow_pulp: pulps a zombie corpse nearby so it cannot rise; off, leaves it', () => {
    for (const allow of [true, false]) {
      const { game, ally, mons, step, msgs } = world();
      const n = ally(30, 30, 'bat');
      game.player.x = 29.5; game.player.y = 31.5; // walking with the survivor: corpses within 6 of them
      if (!allow) n.rules.clearFlag('allow_pulp');
      const rec = mons.placeCorpse(data.monsters.mon_zombie, 32.5, 30.5, 0)!;
      step(20);
      const it = rec.item as Item;
      if (allow) {
        expect(it.damage).toBe(MAX_ITEM_DAMAGE);
        expect(it.hasFlag('PULPED')).toBe(true);
        expect(msgs.some((m) => m.includes('finished pulping'))).toBe(true);
        const necro = mons.spawnById('mon_zombie_necro', 34.5, 30.5, 0)!;
        expect(mons.findRevivableCorpse(necro, 10)).toBeNull();
      } else {
        expect(it.damage).toBe(0);
        expect(n.goal.kind).not.toBe('pulp');
      }
    }
  });

  it('allow_complain: a hungry follower says so; told to stay quiet it does not, but serious trouble still comes out', () => {
    const { game, ally, step, msgs } = world();
    const n = ally(14, 12);
    game.player.yaw = Math.PI / 2;
    n.storedKcal = n.maxStoredKcal() * 0.8;
    n.rules.clearFlag('allow_complain');
    step(1);
    expect(msgs.filter((m) => m.startsWith(`${n.name}:`)).length).toBe(0);
    n.sleepiness = SLEEPINESS.MASSIVE; // past massive − 100: complains regardless
    step(1);
    expect(msgs.filter((m) => m.startsWith(`${n.name}:`)).length).toBe(1);
    n.sleepiness = 0;
    n.rules.setFlag('allow_complain');
    step(1);
    const said = msgs.filter((m) => m.startsWith(`${n.name}:`));
    expect(said.length).toBe(2);
    // timers persist with the NPC (BN npc::complaints)
    const back = Npc.fromJSON(data, n.npcJSON());
    expect([...back.complaints.keys()].sort()).toEqual(['fatigue', 'hunger']);
  });

  it('ignore_noise: an ally left on guard goes to look at a noise it cannot see; told to ignore it, stays', () => {
    for (const ignore of [true, false]) {
      const { game, npcs, ally, zombie, step, setTer, think } = world();
      const n = ally(30, 30, 'bat');
      new Dialogue(npcs, n).effect('assign_guard'); // TALK_FRIEND "Guard this position."
      if (ignore) n.rules.setFlag('ignore_noise');
      for (let y = 22; y <= 38; y++) setTer(33, y, 't_wall');
      const z = zombie(36, 30);
      step(0.1);
      emitSound(game, { x: 36, y: 30, z: 0 }, 20, 'footsteps', { category: 'movement', source: z, ambient: true });
      think(n);
      expect(n.goal.kind === 'investigate').toBe(!ignore);
    }
  });
});

describe('rule bookkeeping', () => {
  it('every rule but allow_pick_up and the CBM rules is honoured; those warn naming the missing system', () => {
    for (const r of ALLY_RULES) expect(AI_HONORED.has(r)).toBe(r !== 'allow_pick_up');
    expect(AI_HONORED.has('engagement') && AI_HONORED.has('aim')).toBe(true);
    expect(Object.keys(STORED_ONLY).sort()).toEqual(['allow_pick_up', 'cbmRecharge', 'cbmReserve']);
    const { npcs, ally } = world();
    const n = ally(30, 30);
    const d = new Dialogue(npcs, n);
    resetWarnings();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    d.effect({ toggle_npc_rule: 'allow_pick_up' });
    d.effect({ set_npc_cbm_reserve_rule: 'CBM_RESERVE_NONE' });
    d.effect({ toggle_npc_rule: 'close_doors' });
    const w = spy.mock.calls.map((c) => String(c[0])).filter((x) => x.includes('[npc rules]'));
    spy.mockRestore();
    expect(w.some((x) => x.includes('"allow_pick_up"') && x.includes('find_item'))).toBe(true);
    expect(w.some((x) => x.includes('"cbmReserve"') && x.includes('no bionics'))).toBe(true);
    expect(w.some((x) => x.includes('"close_doors"'))).toBe(false);
  });
});

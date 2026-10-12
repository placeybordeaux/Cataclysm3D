// NPCs against the real extracted Bright Nights data: generation from templates/classes, the
// dialogue engine on real talk topics (conditions, effects, trials, variables), missions, trade
// valuation, and the real-time AI (followers fighting zombies, zombies attacking NPCs).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem, verb3 } from '../src/game/npcai';
import { Npc, generateNpc, rollClassSkills, rollDistribution, type NpcData } from '../src/game/npc';
import { consumeNpcFood, npcWillEat, rateNpcFood } from '../src/game/npcneeds';
import { Rng } from '../src/core/rng';
import { Dialogue, parseDuration } from '../src/game/talk';
import { evalMath, type MathHost } from '../src/game/talkmath';
import { createItem, fromSpawned, inNewContainer } from '../src/game/item';
import { census, L, spawnItem } from '../src/game/moves';
import { expandItemGroup } from '../src/data/itemgroups';
import { TradeSession, adjustedPrice, priceAdjustment, tradingPrice } from '../src/game/trade';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let nd: NpcData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'),
    furniture: load('furniture.json'),
    items: load('items.json'),
    itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'),
    monsterGroups: load('monster_groups.json'),
    recipes: [],
    misc: load('misc.json'),
  };
  nd = load('npcs.json');
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

function world(seed = 11) {
  const game = new Game(data, seed, fakeInput());
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const mons = new MonsterSystem(game);
  const npcs = new NpcSystem(game, nd, mons);
  // As installMonsters does: NPC rounds (enemyfire.ts) find the monsters they fly into here.
  (game as unknown as { monsters: MonsterSystem }).monsters = mons;
  game.player.inv.wear(createItem(data, 'backpack'), null);
  game.systems.push(mons, npcs);
  game.clock.seconds = 12 * 3600;
  const msgs: string[] = [];
  game.events.on('message', (m) => msgs.push(m.text));
  const step = (s: number) => {
    for (let i = 0; i < Math.round(s * 30); i++) game.tick(1 / 30);
  };
  return { game, mons, npcs, msgs, step };
}

describe('npc generation', () => {
  it('rolls class distributions like npc_class.cpp', () => {
    const rng = new Rng(1);
    expect(rollDistribution({ constant: 3 }, rng)).toBe(3);
    for (let i = 0; i < 20; i++) {
      const v = rollDistribution({ rng: [1, 3] }, rng);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
    }
    expect(rollDistribution({ sum: [{ constant: 2 }, { constant: -3 }] }, rng)).toBe(-1);
    // NC_SCAVENGER: ALL = 3d2-3 (0..3), pistol gets +2..5 on top.
    const sk = rollClassSkills(nd.classes.NC_SCAVENGER, Object.keys(data.misc.skill), rng);
    expect(sk.pistol).toBeGreaterThanOrEqual(2);
    expect(sk.cooking).toBeLessThanOrEqual(3);
  });

  it('builds the refugee center merchant from its template: name, class gear, shop stock, mission', () => {
    const { npcs } = world();
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    // BN's merchant has no unique name: a random one plus the template's name_suffix.
    expect(n.name).toMatch(/^\S+/);
    expect(n.displayName()).toBe(`${n.name}, Merchant`);
    expect(n.faction).toBe('free_merchants');
    expect(n.isShopkeeper()).toBe(true);
    // BN's plain "shopkeeper_item_group" id is normalized to DDA's list form by extract:npcs.
    expect(n.stock.length).toBeGreaterThan(3);
    expect(n.inv.worn.length).toBeGreaterThan(0);
    expect(npcs.missions.offeredBy(n).map((m) => m.id)).toEqual(['MISSION_FREE_MERCHANTS_EVAC_1']);
  });

  it('random class NPCs get names, clothes and a weapon from npc_* groups', () => {
    const n = generateNpc(data, nd, { cls: 'NC_SCAVENGER' }, 1234);
    expect(n.name).toMatch(/^\S+ \S+/);
    expect(n.inv.worn.length).toBeGreaterThan(2);
    expect(n.getSkill('pistol')).toBeGreaterThanOrEqual(2);
  });

  it('gunmen wield the gun (not a spare magazine) and it is loaded, magazine included', () => {
    let guns = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const n = generateNpc(data, nd, { template: 'bandit' }, seed);
      const w = n.inv.wielded;
      if (!w) continue;
      expect(w.def.type, `seed ${seed}: wields ${w.typeId}`).not.toBe('MAGAZINE');
      expect((w.def.subtypes as string[] | undefined) ?? []).not.toContain('MAGAZINE');
      // modular guns (ammo "NULL") take their caliber from gunmods, which aren't modelled
      if (!w.isGun() || !w.ammoTypes().some((a) => a !== 'NULL')) continue;
      guns++;
      expect(w.ammoRemaining(), `seed ${seed}: ${w.typeId} is empty`).toBeGreaterThan(0);
    }
    expect(guns).toBeGreaterThan(10);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const name = n.name;
    n.vars.set('foo', 'bar');
    n.op.trust = 3;
    const j = JSON.parse(JSON.stringify(npcs.toJSON()));
    const w2 = new NpcSystem(game, nd, null);
    w2.fromJSON(j);
    const m = w2.npcs[0];
    expect(m.name).toBe(name);
    expect(m.vars.get('foo')).toBe('bar');
    expect(m.op.trust).toBe(3);
    expect(m.stock.length).toBe(n.stock.length);
    expect(w2.missions.offeredBy(m).length).toBe(1);
  });
});

describe('dialogue math', () => {
  const host = (): MathHost & { vars: Map<string, string> } => {
    const vars = new Map<string, string>();
    return {
      vars,
      getVar: (s, n) => vars.get(`${s}:${n}`),
      setVar: (s, n, v) => (v === undefined ? vars.delete(`${s}:${n}`) : vars.set(`${s}:${n}`, v)),
      call: (name, args, kw) => (name === 'time_since' && args[0] === 'cataclysm' && kw.unit === 'days' ? 31 : undefined),
    };
  };
  it('evaluates CDDA math strings with variables and assignments', () => {
    const h = host();
    expect(evalMath("time_since('cataclysm', 'unit':'days') >= 30", h)).toBe(1);
    evalMath('u_counter_refugee_center_refugee_happiness += 2', h);
    evalMath('u_counter_refugee_center_refugee_happiness++', h);
    expect(h.vars.get('u:counter_refugee_center_refugee_happiness')).toBe('3');
    expect(evalMath('u_counter_refugee_center_refugee_happiness >= 3 && !has_var(u_nope)', h)).toBe(1);
    expect(evalMath('max( 2, 5 ) == 5', h)).toBe(1);
    expect(evalMath('exodii_FM_negotiation_success != 1', h)).toBe(1);
    expect(parseDuration('1 d')).toBe(86400);
  });
  it('third-person verbs', () => {
    expect(verb3('smash')).toBe('smashes');
    expect(verb3('run through')).toBe('runs through');
    expect(verb3('hit')).toBe('hits');
  });
});

describe('dialogue on real talk topics', () => {
  it('expands actual BN punctuation-bearing snippet categories and says the BN goodbye', () => {
    const { npcs } = world(3);
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const d = npcs.talkTo(n)!;
    expect(data.misc.snippet!['<swear!>']).toContain(d.parseTags('<swear!>'));
    expect(data.misc.snippet!['<no>']).toContain(d.parseTags('<no>'));
    expect(d.parseTags('<missing_category>')).toBe('<missing_category>');
    n.restockAt = 3 * 86400 + 8 * 3600;
    expect(d.parseTags('Come back after <restock_time_point>.')).toBe('Come back after Spring 4, 08:00.');
    // BN npctalk.cpp returns the literal translated goodbye at TALK_DONE.
    const bye = (d as unknown as { byeMessage(): string }).byeMessage();
    expect(bye).toBe('Bye.');
  });


  it('merchant: merged topic definitions, conditional responses, and topic changes', () => {
    const { npcs, game } = world(3);
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const d = npcs.talkTo(n)!;
    let v = d.view();
    expect(v.id).toBe('TALK_EVAC_MERCHANT');
    // dynamic_line switches on u_is_wearing badge_marshal
    expect(v.line).toMatch(/Welcome[.…]/);
    expect(v.line).not.toMatch(/marshal/);
    const notes = "What's with these 'free merchant certified notes'?";
    // u_has_item FMCNote: hidden until the survivor carries a note
    expect(v.responses.some((r) => r.text === notes)).toBe(false);
    // responses from later definitions of the same topic are appended, but hidden by their conditions
    expect(v.responses.some((r) => r.text.startsWith('Are you interested in buying any processed lumber'))).toBe(false);
    game.player.inv.giveNew(createItem(data, 'FMCNote'));
    const again = new Dialogue(npcs, n);
    again.start();
    expect(again.view().responses.some((r) => r.text === notes)).toBe(true);
    const plans = v.responses.find((r) => r.text === 'What are you doing here?')!;
    expect(plans).toBeTruthy();
    d.choose(plans.index);
    v = d.view();
    expect(v.id).toBe('TALK_EVAC_MERCHANT_PLANS');
    expect(v.line.length).toBeGreaterThan(20);
  });

  it('stranger greeting: CDDA persuade/intimidate chances and hostile effect', () => {
    const { npcs, game } = world(5);
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    n.personality = { aggression: -5, bravery: 2, collector: 0, altruism: 2 };
    n.op = { trust: 0, fear: 0, value: 0, anger: 0, owed: 0 };
    const d = npcs.talkTo(n)!;
    const v = d.view();
    expect(['TALK_STRANGER_NEUTRAL', 'TALK_STRANGER_FRIENDLY']).toContain(v.id);
    const intim = v.responses.find((r) => r.text.includes('Get out of here or I'))!;
    expect(intim.text).toMatch(/^\[INTIMIDATE \d+%\]/);
    // talk_trial::calc_chance: difficulty 20 + u intimidation (str*2) - npc intimidation + fear*2 - bravery*2.
    const u = game.player;
    const expected = Math.max(0, Math.min(100, 20 + u.str * 2 - n.intimidation() + 0 - 2 * 2));
    expect(intim.text).toContain(`[INTIMIDATE ${expected}%]`);
    // Force the failure branch: hostile.
    (d as unknown as { w: { rng: { int: () => number } } }).w.rng.int = () => 99;
    d.choose(intim.index);
    expect(n.attitude).toBe('KILL');
    expect(d.done).toBe(true);
  });

  it('follow: persuading a stranger to join makes a follower, TALK_FRIEND afterwards', () => {
    const { npcs } = world(8);
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    n.personality = { aggression: -5, bravery: 5, collector: 0, altruism: 5 };
    const d = npcs.talkTo(n)!;
    const sugg = d.view().responses.find((r) => r.text.includes('We should travel together'))!;
    d.choose(sugg.index);
    expect(d.current).toBe('TALK_SUGGEST_FOLLOW');
    const keep = d.view().responses.find((r) => r.text.includes('We\'re friends, aren\'t we?') || r.text.includes('I can keep you safe'))!;
    expect(keep).toBeTruthy();
    // Apply the success branch directly (the effect list is what's being tested).
    d.effect('follow');
    expect(n.isAlly()).toBe(true);
    expect(n.following).toBe(true);
    const d2 = npcs.talkTo(n)!;
    expect(d2.view().id).toBe('TALK_FRIEND');
    // "Guard this position" / "I need you to come with me"
    d2.effect('assign_guard');
    expect(n.following).toBe(false);
    expect(n.guardPos).not.toBeNull();
    d2.effect('stop_guard');
    expect(n.following).toBe(true);
  });

  it('conditions: compare_string, u_has_items, is_season, npc_has_effect, trait', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    npcs.playerVars.set('x', 'yes');
    expect(d.cond({ compare_string: ['yes', { u_val: 'x' }] })).toBe(true);
    expect(d.cond({ not: { compare_string: ['yes', { npc_val: 'x' }] } })).toBe(true);
    expect(d.cond({ u_has_items: { item: 'FMCNote', count: 2 } })).toBe(false);
    for (let i = 0; i < 5; i++) game.player.inv.giveNew(createItem(data, 'FMCNote'));
    expect(d.cond({ u_has_items: { item: 'FMCNote', count: 2 } })).toBe(true);
    expect(d.cond({ is_season: 'SPRING' })).toBe(true);
    d.effect({ npc_add_effect: 'asked_to_follow', duration: 3600 });
    expect(d.cond({ npc_has_effect: 'asked_to_follow' })).toBe(true);
    expect(d.cond({ and: ['npc_male', { u_has_trait: 'NOPE' }] })).toBe(false);
    expect(d.cond({ or: ['npc_male', { u_has_trait: 'NOPE' }] })).toBe(true);
    // Unsupported conditions warn and are false.
    expect(d.cond({ u_has_mutation_category_fancy: 'X' })).toBe(false);
  });

  it('effects: u_spawn_item, u_sell_item (owed), u_add_var, math, u_buy_item from owed credit', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    d.effect({ u_spawn_item: 'FMCNote', count: 3 });
    expect(game.player.inv.countOf('FMCNote')).toBe(3);
    d.effect([{ u_add_var: 'flag', value: 'yes' }, { math: ['u_counter += 2'] }]);
    // BN get_talk_varname: no type/context = "npctalk_var_" + name
    expect(npcs.playerVars.get('npctalk_var_flag')).toBe('yes');
    expect(npcs.playerVars.get('counter')).toBe('2');
    d.effect({ u_sell_item: 'FMCNote', count: 2, cost: 500 });
    expect(game.player.inv.countOf('FMCNote')).toBe(1);
    expect(n.op.owed).toBe(500);
    d.effect({ u_buy_item: 'bandages', cost: 300 });
    expect(game.player.inv.countOf('bandages')).toBeGreaterThan(0);
    expect(n.op.owed).toBe(200);
  });
});

describe('missions', () => {
  it('find-item mission: offer, accept, complete, hand over, reward effect', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const def = Object.values(nd.missions).find((m) => m.goal === 'MGOAL_FIND_ITEM' && m.item === 'inhaler') ?? Object.values(nd.missions).find((m) => m.goal === 'MGOAL_FIND_ITEM' && m.item && data.items[m.item])!;
    const inst = npcs.missions.create(def.id, n)!;
    const d = npcs.talkTo(n)!;
    // TALK_MISSION_LIST offers "Tell me about it."
    d.effect([]);
    (d as unknown as { addTopic(t: string): void }).addTopic('TALK_MISSION_LIST');
    const v = d.view();
    const tell = v.responses.find((r) => r.text === 'Tell me about it.')!;
    expect(tell).toBeTruthy();
    d.choose(tell.index);
    expect(d.current).toBe('TALK_MISSION_OFFER');
    expect(d.view().line).toContain(def.dialogue!.offer.slice(0, 20));
    const yes = d.view().responses.find((r) => r.text === "I'll do it!")!;
    d.choose(yes.index);
    expect(inst.status).toBe('active');
    expect(npcs.missions.isComplete(inst, n)).toBe(false);
    for (let i = 0; i < (def.count ?? 1); i++) game.player.inv.giveNew(createItem(data, def.item!));
    expect(npcs.missions.isComplete(inst, n)).toBe(true);
    const d2 = npcs.talkTo(n)!;
    expect(d2.view().id).toBe('TALK_MISSION_INQUIRE');
    const done = d2.view().responses.find((r) => r.text.startsWith('Yup!'))!;
    expect(done).toBeTruthy();
    d2.choose(done.index);
    expect(inst.status).toBe('succeeded');
    expect(game.player.inv.countOf(def.item!)).toBe(0);
  });

  it('kill-monster-type mission counts kills after accepting', () => {
    const { npcs, mons, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    nd.missions.TEST_KILL = { id: 'TEST_KILL', name: 'Kill zombies', goal: 'MGOAL_KILL_MONSTER_TYPE', monster_type: 'mon_zombie', monster_kill_goal: 2 } as never;
    const inst = npcs.missions.create('TEST_KILL', n)!;
    npcs.missions.assign(inst, null);
    for (let i = 0; i < 2; i++) {
      const z = mons.spawnById('mon_zombie', 20.5, 20.5, 0)!;
      mons.die(z, 'player');
      game.events.emit('creatureDied', { creature: z, killer: game.player });
    }
    expect(npcs.missions.isComplete(inst, n)).toBe(true);
    delete nd.missions.TEST_KILL;
  });

  it('Clear Back Bay runs its inline start/end update_mapgen on evac_center_9 and spawns the boss', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const calls: { src: unknown; at: { x: number; y: number; z: number }; drop?: boolean }[] = [];
    // A fake overmap: evac_center_9 three OMTs east.
    npcs.findOmt = (pred) => (pred('evac_center_9') ? { x: 3, y: 0 } : null);
    npcs.mapgenUpdate = (src, at, opts) => (calls.push({ src, at, drop: opts?.dropMissionTargets }), true);
    const inst = npcs.missions.create('MISSION_FREE_MERCHANTS_EVAC_1', n)!;
    npcs.missions.assign(inst, npcs.dialogueFor(n));
    // BN has no named update_mapgen here: the start update is inline.
    expect(calls.length).toBe(1);
    const start = calls[0];
    expect(typeof start.src).not.toBe('string');
    expect(start.drop).toBe(true);
    expect(start.at).toEqual({ x: 3, y: 0, z: 0 });
    // the boss zombie (GROUP_REFUGEE_BOSS_ZOMBIE) the start update places is the mission target,
    // spawned by the mission system
    expect(inst.targetMonster).toBeTruthy();
    calls.length = 0;
    inst.targetMonster!.dead = true;
    npcs.missions.succeed(inst, null);
    expect(calls.length).toBe(1);
    expect((calls[0].src as { set: unknown[] }).set.length).toBe(1);
  });
});

describe('trade', () => {
  it('CDDA price adjustment curve', () => {
    expect(priceAdjustment(0)).toBe(1);
    expect(priceAdjustment(2)).toBeCloseTo(1.13, 5);
    expect(priceAdjustment(-2)).toBeCloseTo(1 / 1.13, 5);
    expect(priceAdjustment(9)).toBeCloseTo(priceAdjustment(5), 5);
  });

  it('prices a container by its contents too', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const p = game.player;
    const box = inNewContainer(data, createItem(data, '9mm', { count: 20 }), 'bag_canvas').container;
    const rounds = box.contents[0];
    expect(rounds.charges).toBe(20);
    const boxOnly = adjustedPrice(data, nd, n, p, box, 1, true);
    const price = tradingPrice(data, nd, n, p, box, true);
    expect(price).toBe(boxOnly + adjustedPrice(data, nd, n, p, rounds, rounds.charges, true));
    expect(price).toBeGreaterThan(0);
    spawnItem(box, L.stock(n));
    const row = new TradeSession(data, nd, p, n).theirs.find((e) => e.item === box)!;
    expect(row.price).toBe(price);
  });

  it('values goods with the int/speech markup, currency at face value, and settles the balance', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const p = game.player;
    p.int_base = 8;
    n.int_base = 8;
    n.setSkill('speech', 0);
    p.setSkill('speech', 0);
    p.resetStats();
    n.resetStats();
    const knife = createItem(data, 'knife_hunting');
    const base = knife.def.price_postapoc ?? knife.def.price ?? 0;
    // Equal int/speech: net adjustment 1 -> NPC sells at +25%, buys at -25%.
    expect(adjustedPrice(data, nd, n, p, knife, 1, true)).toBe(Math.ceil(base * 1.25));
    expect(adjustedPrice(data, nd, n, p, knife, 1, false)).toBe(Math.ceil(base * 0.75));
    const note = createItem(data, 'FMCNote');
    expect(adjustedPrice(data, nd, n, p, note, 1, true)).toBe(adjustedPrice(data, nd, n, p, note, 1, false));

    for (let i = 0; i < 3; i++) p.inv.giveNew(createItem(data, 'FMCNote'));
    n.stock.push(knife);
    const s = new TradeSession(data, nd, p, n);
    const notes = s.yours.find((e) => e.item.typeId === 'FMCNote')!;
    expect(notes.max).toBe(3);
    const theirKnife = s.theirs.find((e) => e.item === knife)!;
    s.toggle(theirKnife);
    expect(s.balance()).toBe(-theirKnife.price);
    n.op = { trust: 0, fear: 0, value: 0, anger: 0, owed: 0 };
    n.personality.altruism = 0;
    const enough = Math.ceil(theirKnife.price / (notes.price / 3));
    if (enough <= 3) {
      s.setCount(notes, enough);
      expect(s.canAccept().ok).toBe(true);
      expect(s.commit(() => {})).toBe(true);
      expect(p.inv.countOf('knife_hunting')).toBe(1);
      expect(p.inv.countOf('FMCNote')).toBe(3 - enough);
      expect(n.stock).not.toContain(knife);
      expect(n.op.owed).toBeGreaterThanOrEqual(0);
    } else {
      expect(s.canAccept().ok).toBe(false);
    }
  });

  it('selling a wielded bag hands over the bag with its contents, once (v1 sold the contents twice)', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow'); // friends swap freely
    const p = game.player;
    const bag = inNewContainer(data, createItem(data, '9mm', { count: 40 }), 'bag_canvas').container;
    expect(p.inv.wield(bag, null).ok).toBe(true);
    const scope = [L.hands(p), L.worn(p), L.inv(p), L.hands(n), L.worn(n), L.inv(n), L.stock(n), L.ground(game.map, p.tileX, p.tileY, p.z)];
    const before = census(scope).counts;
    const s = new TradeSession(data, nd, p, n);
    // the rounds are inside the bag, not separate goods
    expect(s.yours.filter((e) => e.item.typeId === '9mm')).toEqual([]);
    s.toggle(s.yours.find((e) => e.item === bag)!);
    expect(s.commit()).toBe(true);
    expect(p.inv.wielded).toBeNull();
    expect(census(scope).counts).toEqual(before);
    expect(census(scope).aliased).toEqual([]);
  });

  it('refuses a lopsided deal, followers trade freely', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    n.op = { trust: 0, fear: 0, value: 0, anger: 0, owed: 0 };
    n.personality.altruism = 0;
    n.stock.push(createItem(data, 'knife_hunting'));
    const s = new TradeSession(data, nd, game.player, n);
    s.toggle(s.theirs.find((e) => e.item.typeId === 'knife_hunting')!);
    expect(s.canAccept().ok).toBe(false);
    new Dialogue(npcs, n).effect('follow');
    expect(s.canAccept().ok).toBe(true);
  });
});

describe('save', () => {
  it("round-trips NPCs, missions and dialogue vars through the 'npcs' saveable", async () => {
    const { installNpcs } = await import('../src/npcs');
    const { serializeGame, applySave } = await import('../src/save/format');
    const build = async () => {
      const game = new Game(data, 77, fakeInput());
      game.map.generator = new FlatGen();
      game.player.x = 12.5;
      game.player.y = 12.5;
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) game.map.chunk(x, y, 0);
      const h = await installNpcs(game, null, null, null, undefined, nd);
      return { game, sys: h.sys };
    };
    const A = await build();
    const n = A.sys.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const name = n.name;
    const d = A.sys.talkTo(n)!;
    d.effect([{ u_add_var: 'met', value: 'yes' }, { npc_add_var: 'mood', value: 'good' }, 'follow']);
    const inst = A.sys.missions.offeredBy(n)[0];
    A.sys.missions.assign(inst, d);
    n.op.trust = 4;
    const file = JSON.parse(JSON.stringify(serializeGame(A.game, { slot: 't', name: 'x', gen: 'test' })));
    const B = await build();
    B.sys.spawn({ cls: 'NC_SCAVENGER' }, 13, 13, 0);
    applySave(B.game, file);
    expect(B.sys.npcs.length).toBe(1);
    const m = B.sys.npcs[0];
    expect(m.name).toBe(name);
    expect(m.isAlly()).toBe(true);
    expect(m.op.trust).toBe(4);
    expect(m.vars.get('npctalk_var_mood')).toBe('good');
    expect(B.sys.playerVars.get('npctalk_var_met')).toBe('yes');
    expect(B.sys.missions.active().map((x) => x.id)).toEqual(['MISSION_FREE_MERCHANTS_EVAC_1']);
    expect(B.sys.missions.assignedFrom(m).length).toBe(1);
  });
});

describe('coverage', () => {
  it('every extracted talk topic renders (line + responses) without throwing', () => {
    const { npcs } = world(31);
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    let lines = 0;
    for (const id of Object.keys(nd.topics)) {
      const d = new Dialogue(npcs, n);
      (d as unknown as { topics: string[] }).topics.push(id);
      const v = d.view();
      if (v.line) lines++;
      for (const r of v.responses) expect(typeof r.text).toBe('string');
    }
    expect(lines).toBeGreaterThan(Object.keys(nd.topics).length * 0.8);
  }, 60000);
});

describe('npc AI', () => {
  it('zombies attack a nearby NPC and the armed NPC fights back', () => {
    const { npcs, mons, step, game } = world(21);
    game.player.x = 2.5;
    game.player.y = 2.5;
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 30, 30, 0)!;
    if (n.inv.wielded) n.inv.drop(n.inv.wielded);
    n.inv.wield(createItem(data, 'machete'), null);
    n.personality.bravery = 8;
    const hp0 = Object.values(n.hp).reduce((s, p) => s + p.cur, 0);
    const z = mons.spawnById('mon_zombie', 32.5, 30.5, 0)!;
    step(12);
    const hp1 = Object.values(n.hp).reduce((s, p) => s + p.cur, 0);
    expect(z.dead || z.hp < z.hpMax).toBe(true);
    expect(hp1 <= hp0).toBe(true);
    expect(mons.creatureTargets.size + (z.dead ? 1 : 0)).toBeGreaterThan(0);
  });

  it('a follower walks after the survivor', () => {
    const { npcs, step, game } = world(22);
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 13, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    game.player.x = 30.5;
    game.player.y = 12.5;
    step(6);
    expect(Math.hypot(n.x - game.player.x, n.y - game.player.y)).toBeLessThan(5);
  });

  // BN gunmode_checks_weapon / fire_gun: UPS-powered guns draw ups_charges from carried UPS.
  it('an NPC fires a laser rifle on carried UPS charge, and puts it away without any', () => {
    const { npcs, mons, step, game } = world(24);
    game.player.x = 2.5;
    game.player.y = 2.5;
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 30, 30, 0)!;
    if (n.inv.wielded) n.inv.drop(n.inv.wielded);
    for (const it of n.inv.allItems()) if (it.hasFlag('IS_UPS')) n.inv.drop(it);
    n.inv.wear(createItem(data, 'backpack'), null);
    n.personality.bravery = 10;
    const ups = createItem(data, 'adv_UPS_off', { charges: 200 });
    expect(n.inv.giveNew(ups)).not.toBeNull();
    const rifle = createItem(data, 'laser_rifle');
    expect(n.inv.wield(rifle, null).ok).toBe(true);
    const z = mons.spawnById('mon_zombie', 30.5, 24.5, 0)!;
    step(4);
    // adv_UPS: 40 useful charges cost 20 of its own per shot.
    expect(ups.ammoRemaining()).toBeLessThan(200);
    expect((200 - ups.ammoRemaining()) % 20).toBe(0);
    expect(z.dead || z.hp < z.hpMax).toBe(true);

    const m = npcs.spawn({ cls: 'NC_SCAVENGER' }, 60, 30, 0)!;
    if (m.inv.wielded) m.inv.drop(m.inv.wielded);
    for (const it of m.inv.allItems()) if (it.hasFlag('IS_UPS')) m.inv.drop(it);
    m.personality.bravery = 10;
    const dry = createItem(data, 'laser_rifle');
    expect(m.inv.wield(dry, null).ok).toBe(true);
    mons.spawnById('mon_zombie', 60.5, 24.5, 0);
    step(4);
    expect(m.inv.wielded).not.toBe(dry);
  });

  it('a KILL-attitude bandit attacks the survivor', () => {
    const { npcs, step, game } = world(23);
    const n = npcs.spawn({ template: 'thug' }, 16, 12, 0, { attitude: 'KILL' })!;
    if (n.inv.wielded) n.inv.drop(n.inv.wielded);
    n.inv.wield(createItem(data, 'bat'), null);
    const hp0 = game.player.hpPercent();
    step(10);
    expect(game.player.hpPercent()).toBeLessThan(hp0);
  });
});

describe('vehicles and NPCs', () => {
  it('a player-driven car runs an NPC over: damage, message, flung clear, angry or dead', async () => {
    const { VehicleSystem, composeCreatureHooks, monsterCreatureHooks, npcCreatureHooks } = await import('../src/game/vehicles');
    const { has } = await import('../src/game/vehicle');
    const { game, mons, npcs, msgs } = world();
    (game as unknown as { npcs: NpcSystem }).npcs = npcs;
    const vs = new VehicleSystem(game, load('vehicles.json'));
    game.systems.push(vs);
    vs.creatureHooks = composeCreatureHooks([monsterCreatureHooks(mons), npcCreatureHooks(game, vs)]);
    const v = vs.spawn('car', 10, 20, 0, 0, { fuel: 100, status: 2, rng: new Rng(7) })!;
    for (const q of v.parts) if (has(q, 'OPENABLE')) q.open = false;
    v.locked = false;
    game.player.x = 10.5;
    game.player.y = 20.5;
    vs.takeControls(v);
    vs.startEngine(v);
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 20, 20, 0)!;
    n.x = 20.5;
    n.y = 20.5;
    const hp0 = n.hp.torso.cur;
    expect(n.isEnemy()).toBe(false);
    v.velocity = 15; // ~34 mph
    vs.scriptedInput = true;
    vs.input = { throttle: 0, steer: 0, brake: false };
    for (let i = 0; i < 30; i++) game.tick(1 / 30);
    expect(msgs.some((m) => m.includes(`You hit ${n.name} with your ${v.name}!`))).toBe(true);
    expect(n.dead || n.hp.torso.cur < hp0).toBe(true);
    // the car went through, not stopped dead against a person
    expect(v.x).toBeGreaterThan(20);
    if (!n.dead) {
      expect(vs.at(n.tileX, n.tileY, 0)).toBeNull();
      expect(n.isEnemy()).toBe(true);
    }
  });
});


describe('monster NPC melee telegraphs', () => {
  it('announces a windup before NPC damage and misses a victim that moves away', () => {
    const { game, mons, npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 24, 12, 0)!;
    const zombie = mons.spawnById('mon_zombie', n.x + 1, n.y, 0)!;
    const hp = Object.values(n.hp).reduce((sum, p) => sum + p.cur, 0);
    const phases: string[] = [];
    game.events.on('monsterAttack', (e) => { if (e.monster === zombie) phases.push(e.phase); });
    for (let i = 0; i < 30 && !zombie.windup; i++) mons.update(game, 1 / 60, 1 / 60);
    expect(zombie.windup).toBeTruthy();
    expect(mons.creatureTargets.get(zombie)?.character).toBe(n);
    expect(phases).toEqual(['windup']);
    expect(Object.values(n.hp).reduce((sum, p) => sum + p.cur, 0)).toBe(hp);
    n.x += 10;
    for (let i = 0; i < 40; i++) mons.update(game, 1 / 60, 1 / 60);
    expect(phases).toContain('whiff');
    expect(Object.values(n.hp).reduce((sum, p) => sum + p.cur, 0)).toBe(hp);
  });
});


describe('BN ally rest permission and fatigue', () => {
  it('uses the real miscellaneous rules menu and preserves the permission through save/load', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    d.effect('follow');
    d.topics.push('TALK_MISC_RULES');
    let response = d.view().responses.find(r => r.text === 'Sleep when you feel tired.')!;
    expect(response).toBeTruthy();
    expect(n.allowSleep).toBe(false);
    d.choose(response.index);
    expect(n.allowSleep).toBe(true);
    response = d.view().responses.find(r => r.text === 'Stay awake.')!;
    expect(response).toBeTruthy();
    const saved = n.npcJSON();
    expect(Npc.fromJSON(data, saved).allowSleep).toBe(true);
    // a save from before follower rules had neither field: BN's default (stay awake)
    delete saved.allowSleep;
    delete saved.rules;
    expect(Npc.fromJSON(data, saved).allowSleep).toBe(false);
    d.choose(response.index);
    expect(n.allowSleep).toBe(false);
    d.effect({ set_npc_rule: 'allow_sleep' });
    expect(n.allowSleep).toBe(true);
    d.effect({ clear_npc_rule: 'allow_sleep' });
    expect(n.allowSleep).toBe(false);
  });

  it('keeps tired allies awake by default; allowed allies find a bed and naturally sleep', () => {
    const { npcs, game, step } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    n.following = false;
    n.sleepiness = 400;
    step(3);
    expect((n.isAsleep() || n.effects.has('lying_down'))).toBe(false);
    game.map.setFurn(16, 12, 0, 'f_bed');
    n.allowSleep = true;
    step(8);
    expect(n.tileX).toBe(16);
    expect(n.tileY).toBe(12);
    expect((n.isAsleep() || n.effects.has('lying_down'))).toBe(true);
    expect(n.sleepComfort).toBeGreaterThan(0);
    const at = [n.x, n.y];
    step(2);
    expect([n.x, n.y]).toEqual(at);
    const loaded = Npc.fromJSON(data, n.npcJSON());
    expect((loaded.isAsleep() || loaded.effects.has('lying_down'))).toBe(true);
    expect(loaded.sleepiness).toBe(n.sleepiness);
    npcs.talkTo(n);
    n.sleepiness = 0;
    step(1);
    expect(n.isAsleep() || n.effects.has('lying_down')).toBe(false);
    expect(n.goal.kind).not.toBe('rest');
  });
  it('interrupts lying down when a visible enemy arrives, without resetting fatigue', () => {
    const { npcs, game, step } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    n.allowSleep = true;
    n.sleepiness = 400;
    n.addEffect('lying_down', 1800);
    n.addEffect('meth', 60); // prevent a natural sleep roll before the threat is assessed
    npcs.spawn({ template: 'thug' }, 17, 12, 0, { attitude: 'KILL' });
    step(0.5);
    expect(n.effects.has('lying_down')).toBe(false);
    expect(['fight', 'flee']).toContain(n.goal.kind);
    expect(n.sleepiness).toBeGreaterThanOrEqual(400);
  });

  it('consumes one real carried water portion, preserves its container, and refuses waste/drugs/parasites', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    for (const it of [...n.inv.topLevel()]) n.inv.drop(it);
    n.thirst = 200;
    n.storedKcal = n.maxStoredKcal();
    const { container: bottle, rest } = inNewContainer(data, createItem(data, 'water_clean', { charges: 2 }), 'bottle_plastic');
    expect(rest).toBeNull();
    n.inv.giveNew(bottle);
    const water = bottle.contents[0];
    const result = consumeNpcFood(n);
    expect(result?.item).toBe(water);
    expect(water.charges).toBe(1);
    expect(n.inv.has(bottle)).toBe(true);
    expect(n.thirst).toBe(150);
    expect(n.stomach.kcal).toBe(0);
    expect(rateNpcFood(n, createItem(data, 'bread'))).toBe(0);
    expect(rateNpcFood(n, createItem(data, 'meat'))).toBe(0);
    expect(rateNpcFood(n, createItem(data, 'mutagen'))).toBe(0);
    n.thirst = 0;
    expect(consumeNpcFood(n)).toBeNull();
    expect(water.charges).toBe(1);
  });

  it('hungry allies consume food through their AI and never fabricate recovery without supplies', () => {
    const { npcs, step } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    for (const it of [...n.inv.topLevel()]) n.inv.drop(it);
    n.storedKcal = n.maxStoredKcal() * 0.5;
    n.thirst = 0;
    const bread = createItem(data, 'bread', { charges: 2 });
    n.inv.giveNew(bread);
    step(0.25);
    expect(bread.charges).toBe(1);
    expect(n.stomach.kcal).toBe(84);
    expect(n.needsCooldown).toBeGreaterThan(0);
    n.inv.drop(bread);
    const before = n.storedKcal;
    step(2);
    expect(n.storedKcal).toBeLessThanOrEqual(before);
    expect(n.storedKcal).toBeLessThan(n.maxStoredKcal() * 0.75);
  });

  it('honors actual mutation dietary vitamins and refuses nausea or stomach overfill without spending portions', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    for (const it of [...n.inv.topLevel()]) n.inv.drop(it);
    // the class's rolled starting traits (VEGETARIAN, ANTIJUNK…) would mask the rules under test
    n.traits.clear();
    n.storedKcal = n.maxStoredKcal() * 0.5;
    n.thirst = 200;
    const bread = createItem(data, 'bread', { charges: 2 });
    n.inv.giveNew(bread);
    n.addTrait('CARNIVORE');
    expect(npcWillEat(n, bread)).toBe(false);
    expect(consumeNpcFood(n)).toBeNull();
    expect(bread.charges).toBe(2);
    n.traits.delete('CARNIVORE');
    n.addTrait('ANTIWHEAT');
    expect(npcWillEat(n, bread)).toBe(false);
    n.traits.delete('ANTIWHEAT');
    n.addEffect('nausea', 60);
    expect(npcWillEat(n, bread)).toBe(false);
    n.effects.remove('nausea');
    n.stomach.kcal = n.maxStoredKcal() - n.storedKcal - 20;
    expect(npcWillEat(n, bread)).toBe(false);
    expect(consumeNpcFood(n)).toBeNull();
    expect(bread.charges).toBe(2);
    n.stomach.kcal = 0;
    expect(npcWillEat(n, bread)).toBe(true);
    n.addTrait('LACTOSE');
    expect(npcWillEat(n, createItem(data, 'milk'))).toBe(false);
    n.traits.delete('LACTOSE');
    expect(npcWillEat(n, createItem(data, 'human_flesh'))).toBe(false);
    n.addTrait('CANNIBAL');
    expect(npcWillEat(n, createItem(data, 'human_flesh'))).toBe(true);
  });

  it('uses BN explicit non-ally supply and fatigue approximation while allies remain supply-dependent', () => {
    const { npcs, step } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    for (const it of [...n.inv.topLevel()]) n.inv.drop(it);
    n.storedKcal = n.maxStoredKcal() * 0.5;
    n.thirst = 500;
    n.sleepiness = 400;
    step(2);
    expect(n.storedKcal).toBe(n.maxStoredKcal());
    expect(n.thirst).toBe(0);
    expect(n.sleepiness).toBe(0);
    expect(n.inv.allItems()).toHaveLength(0);
    expect(n.isAsleep() || n.effects.has('lying_down')).toBe(false);
    new Dialogue(npcs, n).effect('follow');
    n.storedKcal = n.maxStoredKcal() * 0.5;
    n.thirst = 500;
    n.sleepiness = 400;
    step(2);
    expect(n.storedKcal).toBeLessThan(n.maxStoredKcal() * 0.75);
    expect(n.thirst).toBeGreaterThanOrEqual(500);
    expect(n.sleepiness).toBeGreaterThanOrEqual(400);
  });

  it('protects nested unfinished craft components and tools while retaining normal bag and bottle access', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    for (const it of [...n.inv.topLevel()]) n.inv.drop(it);
    const pack = createItem(data, 'backpack');
    expect(n.inv.wear(pack, null).ok).toBe(true);
    const craft = createItem(data, 'craft');
    craft.vars = { craft_recipe: 'food_fixture', craft_batch: 2, craft_progress: 0.375, craft_next_failure: 0.5 };
    const escrow = createItem(data, 'bread', { charges: 7 });
    const escrowTool = createItem(data, 'knife_hunting');
    expect(spawnItem(escrow, L.in(craft), { force: true }).ok).toBe(true);
    expect(spawnItem(escrowTool, L.in(craft), { force: true }).ok).toBe(true);
    const { container: craftBag } = inNewContainer(data, craft, 'bag_canvas');
    n.inv.giveNew(craftBag);
    expect(n.inv.has(craftBag)).toBe(true);
    const before = craft.toJSON();
    const uid = n.uid;
    n.storedKcal = n.maxStoredKcal() * 0.5;
    n.thirst = 200;
    expect(npcWillEat(n, craft)).toBe(false);
    expect(consumeNpcFood(n)).toBeNull();
    expect(craft.toJSON()).toEqual(before);
    expect(craft.contents[0]).toBe(escrow);
    expect(craft.contents[1]).toBe(escrowTool);
    expect(escrow.charges).toBe(7);
    expect(n.uid).toBe(uid);
    // Synthetic required-tool variant isolates the BN comestible.tool branch without altering extracted data.
    const toolData = { ...data, items: { ...data.items, bread: { ...data.items.bread, tool: 'knife_hunting' } } };
    const needsTool = createItem(toolData, 'bread');
    expect(npcWillEat(n, needsTool)).toBe(false); // escrowed tool cannot satisfy active needs
    const looseTool = createItem(data, 'knife_hunting');
    expect(spawnItem(looseTool, L.inv(n)).ok).toBe(true);
    expect(npcWillEat(n, needsTool)).toBe(true);
    const normalBread = createItem(data, 'bread', { charges: 2 });
    const { container: normalBag } = inNewContainer(data, normalBread, 'bag_canvas');
    n.inv.giveNew(normalBag);
    expect(n.inv.has(normalBag)).toBe(true);
    expect(consumeNpcFood(n)?.item).toBe(normalBread);
    expect(normalBread.charges).toBe(1);
    const { container: bottle } = inNewContainer(data, createItem(data, 'water_clean', { charges: 2 }), 'bottle_plastic');
    expect(spawnItem(bottle, L.inv(n)).ok).toBe(true);
    n.storedKcal = n.maxStoredKcal(); n.stomach.kcal = 0;
    expect(consumeNpcFood(n)?.item).toBe(bottle.contents[0]);
    expect(bottle.contents[0].charges).toBe(1);
    expect(n.inv.has(bottle)).toBe(true);
    expect(n.inv.has(craft)).toBe(true);
    expect(craft.toJSON()).toEqual(before);
    expect(craft.contents).toEqual([escrow, escrowTool]);
  });

  it('routes a tired permitted ally around a wall to a better bed without generating chunks', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    n.following = false;
    n.allowSleep = true;
    n.sleepiness = 400;
    for (let y = 10; y <= 14; y++) game.map.setTer(16, y, 0, 't_wall');
    game.map.setFurn(18, 12, 0, 'f_bed');
    const chunks = [...game.map.loadedChunks()].length;
    // Isolate NPC movement/rest from unrelated Game falling systems which load support terrain below the player.
    for (let i = 0; i < 300; i++) npcs.update(game, 1 / 30, 1 / 30);
    expect([n.tileX, n.tileY]).toEqual([18, 12]);
    expect(n.isAsleep() || n.effects.has('lying_down')).toBe(true);
    expect([...game.map.loadedChunks()].length).toBe(chunks);
  });

  it('cancels an approach when another creature occupies the sleeping spot', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    n.following = false; n.allowSleep = true; n.sleepiness = 400;
    game.map.setFurn(18, 12, 0, 'f_bed');
    for (let i = 0; i < 30 && n.goal.kind !== 'rest'; i++) npcs.update(game, 1 / 30, 1 / 30);
    expect(n.goal.kind).toBe('rest');
    expect([n.goal.x, n.goal.y]).toEqual([18.5, 12.5]);
    const occupant = npcs.spawn({ cls: 'NC_SCAVENGER' }, 18, 12, 0)!;
    occupant.addEffect('downed', 60);
    npcs.update(game, 1 / 30, 1 / 30);
    expect(n.goal.kind).toBe('none');
    expect(n.path).toHaveLength(0);
    expect(n.isAsleep() || n.effects.has('lying_down')).toBe(false);
    expect([n.tileX, n.tileY]).not.toEqual([18, 12]);
  });

  it('replans a changed route using complete paths instead of following a stale partial path', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    n.following = false; n.allowSleep = true; n.sleepiness = 400;
    for (let y = 10; y <= 14; y++) game.map.setTer(16, y, 0, 't_wall');
    game.map.setFurn(18, 12, 0, 'f_bed');
    for (let i = 0; i < 30 && n.goal.kind !== 'rest'; i++) npcs.update(game, 1 / 30, 1 / 30);
    expect(n.path.length).toBeGreaterThan(0);
    const topRoute = n.path.some(([, y]) => y < 10);
    // Close the initially selected side; the opposite side remains reachable.
    for (let y = topRoute ? 6 : 15; y <= (topRoute ? 9 : 18); y++) game.map.setTer(16, y, 0, 't_wall');
    n.pathAge = 3;
    npcs.update(game, 1 / 30, 1 / 30);
    expect(n.path.some(([, y]) => topRoute ? y > 14 : y < 10)).toBe(true);
    for (let i = 0; i < 300; i++) npcs.update(game, 1 / 30, 1 / 30);
    expect([n.tileX, n.tileY]).toEqual([18, 12]);
    expect(n.isAsleep() || n.effects.has('lying_down')).toBe(true);
  });

  it('applies player mutation strikes against character armor separately from the primary blow', () => {
    const { npcs, game } = world();
    const target = npcs.spawn({ cls: 'NC_SCAVENGER' }, 13, 12, 0, { attitude: 'KILL' })!;
    for (const item of [...target.inv.topLevel()]) target.inv.drop(item);
    target.addEffect('downed', 60);
    target.inv.naturalArmor.push((_bp, type) => type === 'stab' ? 15 : 100);
    game.player.yaw = Math.PI / 2;
    game.player.dex_base = 40;
    game.player.addTrait('FANGS');
    const hp = Object.values(target.hp).reduce((s, p) => s + p.cur, 0);
    expect(npcs.playerMelee(1.5, null)).toBe(true);
    expect(hp - Object.values(target.hp).reduce((s, p) => s + p.cur, 0)).toBe(5);
  });

  it('venomous fangs poison a person; a blocked bite does not', () => {
    const { npcs, game } = world();
    const target = npcs.spawn({ cls: 'NC_SCAVENGER' }, 13, 12, 0, { attitude: 'KILL' })!;
    for (const item of [...target.inv.topLevel()]) target.inv.drop(item);
    target.addEffect('downed', 60);
    target.inv.naturalArmor.push((_bp, type) => type === 'stab' ? 15 : 100);
    game.player.yaw = Math.PI / 2;
    game.player.dex_base = 40;
    game.player.addTrait('FANGS');
    game.player.addTrait('POISONOUS2');
    expect(npcs.playerMelee(1.5, null)).toBe(true);
    expect(target.hasEffect('badpoison')).toBe(true);
    const shielded = npcs.spawn({ cls: 'NC_SCAVENGER' }, 13, 12, 0, { attitude: 'KILL' })!;
    for (const item of [...shielded.inv.topLevel()]) shielded.inv.drop(item);
    target.dead = true;
    shielded.addEffect('downed', 60);
    shielded.inv.naturalArmor.push(() => 100);
    expect(npcs.playerMelee(1.5, null)).toBe(true);
    expect(shielded.hasEffect('badpoison')).toBe(false);
  });

  it('lets NPC mutation strikes damage an armored monster without granting player kill credit', () => {
    const { npcs, mons, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    new Dialogue(npcs, n).effect('follow');
    for (const item of [...n.inv.topLevel()]) n.inv.drop(item);
    n.dex_base = 40; n.personality.bravery = 10; n.addTrait('FANGS');
    const monster = mons.spawn({ ...data.monsters.mon_zombie, hp: 5, armor: { bash: 100, stab: 15 } }, 15.2, 12.5, 0);
    npcs.update(game, 1 / 30, 1 / 30);
    expect(monster.dead).toBe(true);
    expect(npcs.totalKills()).toBe(0);
    expect(npcs.kills.size).toBe(0);
  });

});

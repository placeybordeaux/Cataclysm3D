// NPCs against the real extracted CDDA data: generation from templates/classes, the dialogue
// engine on real talk topics (conditions, effects, trials, variables), missions, trade
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
import { generateNpc, rollClassSkills, rollDistribution, type NpcData } from '../src/game/npc';
import { Rng } from '../src/core/rng';
import { Dialogue, parseDuration } from '../src/game/talk';
import { evalMath, type MathHost } from '../src/game/talkmath';
import { createItem } from '../src/game/item';
import { TradeSession, adjustedPrice, priceAdjustment } from '../src/game/trade';

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
  game.player.inv.wear(createItem(data, 'backpack'));
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

  it('builds Smokes from his template: name, class gear, shop stock, mission', () => {
    const { npcs } = world();
    const n = npcs.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
    expect(n.name).toBe('Smokes');
    expect(n.displayName()).toBe('Smokes, Merchant');
    expect(n.faction).toBe('free_merchants');
    expect(n.isShopkeeper()).toBe(true);
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
    const n = npcs.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
    n.vars.set('foo', 'bar');
    n.op.trust = 3;
    const j = JSON.parse(JSON.stringify(npcs.toJSON()));
    const w2 = new NpcSystem(game, nd, null);
    w2.fromJSON(j);
    const m = w2.npcs[0];
    expect(m.name).toBe('Smokes');
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
  it('expands punctuation snippets with an ellipsis and the default goodbye', () => {
    const { npcs } = world(3);
    const n = npcs.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
    const d = npcs.talkTo(n)!;
    expect(d.parseTags('I gotta go<punc.…>')).toMatch(/^I gotta go[.…]$/);
    expect(d.parseTags('Go<punc…!>')).toMatch(/^Go[…!]$/);
    // TALK_DONE says a CDDA <end_talking_bye> line, never a raw "<bye>" tag.
    const bye = (d as unknown as { byeMessage(): string }).byeMessage();
    expect(bye).not.toMatch(/[<>]/);
    expect(bye.length).toBeGreaterThan(0);
  });


  it('Smokes: first meeting sets u_val, then the talk menu opens', () => {
    const { npcs } = world(3);
    const n = npcs.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
    const d = npcs.talkTo(n)!;
    let v = d.view();
    expect(v.id).toBe('TALK_FREE_MERCHANTS_MERCHANT');
    expect(v.line.length).toBeGreaterThan(3);
    const who = v.responses.find((r) => r.text.startsWith('Who are you?'))!;
    expect(who).toBeTruthy();
    // Not yet met: "I wanted to talk." is hidden.
    expect(v.responses.some((r) => r.text === 'I wanted to talk.')).toBe(false);
    d.choose(who.index);
    expect(npcs.playerVars.get('general_meeting_u_met_Gavin')).toBe('yes');
    v = d.view();
    expect(v.id).toBe('TALK_FREE_MERCHANTS_MERCHANT_Intro');
    // Back to the main topic: the "met" branch is now available.
    const back = new Dialogue(npcs, n);
    back.start();
    expect(back.view().responses.some((r) => r.text === 'I wanted to talk.')).toBe(true);
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
    const n = npcs.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    npcs.playerVars.set('x', 'yes');
    expect(d.cond({ compare_string: ['yes', { u_val: 'x' }] })).toBe(true);
    expect(d.cond({ not: { compare_string: ['yes', { npc_val: 'x' }] } })).toBe(true);
    expect(d.cond({ u_has_items: { item: 'FMCNote', count: 2 } })).toBe(false);
    for (let i = 0; i < 5; i++) game.player.inv.pickUp(createItem(data, 'FMCNote'));
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
    const n = npcs.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    d.effect({ u_spawn_item: 'FMCNote', count: 3 });
    expect(game.player.inv.countOf('FMCNote')).toBe(3);
    d.effect([{ u_add_var: 'flag', value: 'yes' }, { math: ['u_counter += 2'] }]);
    expect(npcs.playerVars.get('flag')).toBe('yes');
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
    for (let i = 0; i < (def.count ?? 1); i++) game.player.inv.pickUp(createItem(data, def.item!));
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
});

describe('trade', () => {
  it('CDDA price adjustment curve', () => {
    expect(priceAdjustment(0)).toBe(1);
    expect(priceAdjustment(2)).toBeCloseTo(1.13, 5);
    expect(priceAdjustment(-2)).toBeCloseTo(1 / 1.13, 5);
    expect(priceAdjustment(9)).toBeCloseTo(priceAdjustment(5), 5);
  });

  it('values goods with the int/speech markup, currency at face value, and settles the balance', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
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

    for (let i = 0; i < 3; i++) p.inv.pickUp(createItem(data, 'FMCNote'));
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
    const n = A.sys.spawn({ template: 'free_merchants_merchant' }, 14, 12, 0)!;
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
    expect(m.name).toBe('Smokes');
    expect(m.isAlly()).toBe(true);
    expect(m.op.trust).toBe(4);
    expect(m.vars.get('mood')).toBe('good');
    expect(B.sys.playerVars.get('met')).toBe('yes');
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
    n.inv.wielded = null;
    n.inv.wield(createItem(data, 'machete'));
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

  it('a KILL-attitude bandit attacks the survivor', () => {
    const { npcs, step, game } = world(23);
    const n = npcs.spawn({ template: 'thug' }, 16, 12, 0, { attitude: 'KILL' })!;
    n.inv.wielded = null;
    n.inv.wield(createItem(data, 'bat'));
    const hp0 = game.player.hpPercent();
    step(10);
    expect(game.player.hpPercent()).toBeLessThan(hp0);
  });
});

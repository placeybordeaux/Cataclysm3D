// BN dialogue conditions and effects the port used to skip (docs/IMPLEMENTATION_GAPS.md
// "Dialogue"), each exercised through the real extracted talk topics: variable naming and
// integer variables, {"and"} dynamic lines, the refugee beggars' food hand-over (for_category
// repeat responses + u_bulk_trade_accept), Vanessa's barber chair, follower rules, background
// stories from class trait groups, skills, trait flags, debt, leaving, sleeping, driving.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { MonsterSystem } from '../src/game/monai';
import { NpcSystem } from '../src/game/npcai';
import { Npc, generateNpc, type NpcData } from '../src/game/npc';
import { Dialogue, migrateTalkVars, talkVarName } from '../src/game/talk';
import { createItem, inNewContainer } from '../src/game/item';
import { resetWarnings, warnedIds } from '../src/data/warn';
import { ACTION_SCALE } from '../src/core/time';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let nd: NpcData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: load('recipes.json'), misc: load('misc.json'),
  };
  nd = load('npcs.json');
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

function world(seed = 11) {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
  const game = new Game(data, seed, input);
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const mons = new MonsterSystem(game);
  const npcs = new NpcSystem(game, nd, mons);
  game.player.inv.wear(createItem(data, 'backpack'), null);
  game.systems.push(mons, npcs);
  game.clock.seconds = 12 * 3600;
  const msgs: string[] = [];
  game.events.on('message', (m) => msgs.push(m.text));
  return { game, mons, npcs, msgs };
}

/** Open a conversation on a given topic (what choosing the response leading there does). */
function at(npcs: NpcSystem, n: Npc, topic: string): Dialogue {
  const d = new Dialogue(npcs, n);
  d.topics.push(topic);
  return d;
}
const pick = (d: Dialogue, text: string | RegExp) => {
  const r = d.view().responses.find((x) => (typeof text === 'string' ? x.text === text : text.test(x.text)));
  if (!r) throw new Error(`no response ${text} in ${d.current}: ${d.view().responses.map((x) => x.text).join(' | ')}`);
  return r;
};

describe('BN dialogue variables', () => {
  it('stores npctalk_var_<type>_<context>_<name>, adjusts integers and compares them (Boris cleanup -> Rhyzaea)', () => {
    const { npcs } = world();
    const n = npcs.spawn({ template: 'refugee_RhyzaeaJohnny' }, 14, 12, 0)!;
    // TALK_REFUGEE_Accept_Boris_Mission_1's speaker effect: npc_add_var + u_adjust_var
    const d = at(npcs, n, 'TALK_REFUGEE_Accept_Boris_Mission_1');
    d.view();
    expect(n.vars.get('npctalk_var_mission_Boris_mission_1_cleanup_asked')).toBe('yes');
    expect(npcs.playerVars.get('npctalk_var_mission_cleanup_promises_Boris_mission_1')).toBe('1');
    // the same bare name under another context is a different variable (BN), not the same one
    expect(npcs.playerVars.get('npctalk_var_mission_completed_Boris_mission_1')).toBeUndefined();
    d.effect({ u_adjust_var: 'Boris_mission_1', type: 'mission', context: 'cleanup_promises', adjustment: 2 });
    expect(npcs.playerVars.get('npctalk_var_mission_cleanup_promises_Boris_mission_1')).toBe('3');

    // Rhyzaea's situation line is a u_compare_var ladder on refugee_happiness
    const line = () => at(npcs, n, 'TALK_REFUGEE_Rhyzaea_Situation').view().line;
    expect(line()).toMatch(/barely hanging on.*without help/);
    const happier = { u_adjust_var: 'refugee_happiness', type: 'counter', context: 'refugee_center', adjustment: 3 };
    d.effect({ ...happier, adjustment: 1 });
    expect(line()).toMatch(/Things are maybe looking up/);
    d.effect({ ...happier, adjustment: 2 });
    expect(line()).toMatch(/There have been a lot of improvements/);
    d.effect(happier);
    expect(line()).toMatch(/It's tense here/);
    expect(d.cond({ u_compare_var: 'refugee_happiness', type: 'counter', context: 'refugee_center', op: '==', value: 6 })).toBe(true);
    expect(d.cond({ u_compare_var: 'refugee_happiness', type: 'counter', context: 'refugee_center', op: '<', value: 6 })).toBe(false);
    // the "cleanup crew" response hides once cleanup_asked is set on her
    expect(d.cond({ npc_has_var: 'cleanup_asked', type: 'mission', context: 'Boris_mission_1', value: 'yes' })).toBe(true);
  });

  it('migrates bare-named variables from older saves to the BN names the data uses', () => {
    const vars = new Map([['beggars_recruited', 'yes'], ['sentinel_X_y', 'yes'], ['Boris_mission_1', '2']]);
    resetWarnings();
    migrateTalkVars(nd, vars);
    expect(vars.get('npctalk_var_general_recruit_beggars_recruited')).toBe('yes');
    expect(vars.get('sentinel_X_y')).toBe('yes');
    // stored under two contexts in BN data: can't be told apart, kept and reported
    expect(vars.get('Boris_mission_1')).toBe('2');
    expect(warnedIds()).toContain('talk_var_migrate:Boris_mission_1');
    expect(talkVarName({ u_add_var: 'met' }, 'u_add_var')).toBe('npctalk_var_met');
  });

  it('{"and": [...]} dynamic lines concatenate (BN dynamic_line_t), with the conditional middle part', () => {
    const { npcs } = world();
    const n = npcs.spawn({ template: 'refugee_beggar2' }, 14, 12, 0)!;
    const d = at(npcs, n, 'TALK_REFUGEE_BEGGAR_2_JOBSDONE');
    expect(d.view().line).toMatch(/^"Well… I had it all pretty together, and I feel bad with all the help you've given me already, but now the masters/);
    npcs.playerVars.set('npctalk_var_general_recruit_beggars_recruited', 'yes');
    expect(at(npcs, n, 'TALK_REFUGEE_BEGGAR_2_JOBSDONE').view().line).toMatch(/together, but the others have left, and now the masters/);
  });
});

describe('refugee center', () => {
  it('feeding a beggar: for_category food responses, then u_bulk_trade_accept hands the food over', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'refugee_beggar1' }, 14, 12, 0)!;
    const u = game.player;
    u.inv.giveNew(createItem(data, 'apple'));
    u.inv.giveNew(createItem(data, 'apple'));
    u.inv.giveNew(createItem(data, 'rock'));
    const d = at(npcs, n, 'TALK_REFUGEE_BEGGAR_1');
    d.choose(pick(d, 'Hey, here, I might have some food for you.  Let me check.').index);
    expect(d.current).toBe('TALK_REFUGEE_BEGGAR_1_GIVE_FOOD');
    const offers = d.view().responses.filter((r) => r.text.startsWith('Here, you can have this'));
    // one per food type, in front of the topic's own responses (BN inserts repeat responses first)
    expect(offers.map((r) => r.text)).toEqual(['Here, you can have this apple.']);
    expect(d.view().responses[0].text).toBe('Here, you can have this apple.');
    d.choose(offers[0].index);
    expect(d.current).toBe('TALK_REFUGEE_BEGGAR_1_GAVE_FOOD');
    d.view();
    expect(n.hasTalkEffect('beggar_has_eaten', npcs.now())).toBe(true);
    d.choose(pick(d, 'No problem.  See you around.').index);
    // every apple changes hands (lobby_beggars have no currency: nothing comes back)
    expect(u.inv.countOf('apple')).toBe(0);
    // the NPC keeps them: carried if they have room, else with their goods (like u_sell_item)
    expect(n.inv.countOf('apple') + n.stock.filter((it) => it.typeId === 'apple').reduce((a, it) => a + it.count(), 0)).toBe(2);
    expect(u.inv.countOf('rock')).toBe(1);
  });

  it('a sealed can of beans you carry is food to a beggar; one left on the ground is not', () => {
    // BN json_talk_topic::gen_responses: for_category without include_containers matches
    // items_with(type->category_force == food), and items_with walks into containers, so the
    // beans inside a sealed can count (named after the beans, the cur_item). The playtest that
    // saw no offer had no pockets: the apple went to the hands, the can to the ground.
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'refugee_beggar1' }, 14, 12, 0)!;
    const u = game.player;
    const can = inNewContainer(data, createItem(data, 'can_beans'), 'can_medium').container;
    expect(can.def.container_data?.unseals_into).toBeTruthy();
    u.inv.giveNew(can);
    const offers = () => {
      const d = at(npcs, n, 'TALK_REFUGEE_BEGGAR_1_GIVE_FOOD');
      return { d, list: d.view().responses.filter((r) => r.text.startsWith('Here, you can have this')) };
    };
    expect(offers().list.map((r) => r.text)).toEqual(['Here, you can have this canned beans.']);
    // u_bulk_trade_accept takes the food (BN use_charges empties the can), the tin stays yours
    const { d, list } = offers();
    d.choose(list[0].index);
    d.choose(pick(d, 'No problem.  See you around.').index);
    expect(u.inv.countOf('can_beans')).toBe(0);
    expect(u.inv.allItems().some((it) => it.typeId.startsWith('can_medium'))).toBe(true);
    expect(n.inv.countOf('can_beans') + n.stock.filter((it) => it.typeId === 'can_beans').length).toBeGreaterThan(0);

    const ground = inNewContainer(data, createItem(data, 'can_beans'), 'can_medium').container;
    game.map.addItem(u.tileX, u.tileY, 0, ground);
    expect(offers().list).toEqual([]);
  });

  it("Vanessa's haircut: pay six merch, choose a style (barber_hair), the old one is replaced", () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'refugee_VanessaToby' }, 14, 12, 0)!;
    const u = game.player;
    for (let i = 0; i < 6; i++) u.inv.giveNew(createItem(data, 'FMCNote'));
    u.traits.add('hair_crewcut');
    let title = '';
    npcs.pickOption = (t, options, onPick) => {
      title = t;
      onPick(options.indexOf('Hair style: mohawk'));
    };
    const d = at(npcs, n, 'TALK_REFUGEE_Vanessa_Haircut');
    d.choose(pick(d, 'Please give me a haircut.').index);
    expect(title).toBe('Choose a new hairstyle');
    expect(u.hasTrait('hair_mohawk')).toBe(true);
    expect(u.hasTrait('hair_crewcut')).toBe(false);
    expect(u.inv.countOf('FMCNote')).toBe(0);
    expect(u.morale.level()).toBeGreaterThan(0);
  });

  it('the merchant only offers a reward for the beggars to someone with Speech (u_has_skill)', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)!;
    const reward = (d: Dialogue) => d.view().responses.some((r) => r.text.startsWith('[SPEECH]'));
    expect(reward(at(npcs, n, 'TALK_EVAC_MERCHANT_BEGGARS1'))).toBe(false);
    game.player.setSkill('speech', 1);
    expect(reward(at(npcs, n, 'TALK_EVAC_MERCHANT_BEGGARS1'))).toBe(true);
    expect(new Dialogue(npcs, n).cond({ u_has_skill: { skill: 'speech' } })).toBe(false);
  });
});

describe('random survivors', () => {
  it('class trait groups give NPCs a background story, which unlocks "chat about your history"', () => {
    let withStory = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const n = generateNpc(data, nd, { cls: 'NC_SCAVENGER' }, seed);
      if ([...n.traits].some((t) => t.startsWith('BGSS_'))) withStory++;
      // MALE_/FEMALE_PREFERRED traits are filtered for the other sex (trait_group::traits_from)
      const flags = [...n.traits].flatMap((t) => n.traitDef(t)?.flags ?? []);
      expect(flags).not.toContain(n.male ? 'FEMALE_PREFERRED' : 'MALE_PREFERRED');
    }
    expect(withStory).toBeGreaterThan(20);
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    n.traits.add('BGSS_No_Past_1');
    const d = new Dialogue(npcs, n);
    d.effect('follow');
    expect(d.cond({ npc_has_trait_flag: 'BG_SURVIVAL_STORY' })).toBe(true);
    expect(d.cond({ u_has_trait_flag: 'BG_SURVIVAL_STORY' })).toBe(false);
    expect(at(npcs, n, 'TALK_FRIEND').view().responses.some((r) => r.text === 'Mind if we just chat for a bit about your history?')).toBe(true);
  });

  it('npc_need follows BN: strictly above the amount, hunger = calorie shortfall / 10', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    n.storedKcal = n.maxStoredKcal() - 1600;
    expect(d.cond({ npc_need: 'hunger', amount: 160 })).toBe(false);
    n.storedKcal -= 10;
    expect(d.cond({ npc_need: 'hunger', amount: 160 })).toBe(true);
    n.sleepiness = 191;
    expect(d.cond({ npc_need: 'fatigue', level: 'TIRED' })).toBe(false);
    expect(d.cond('npc_is_sleepy')).toBe(true);
    n.sleepiness = 192;
    expect(d.cond({ npc_need: 'fatigue', level: 'TIRED' })).toBe(true);
  });

  it('"Okay, I\'m going." (player_leaving): they wait out their patience, then attack', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 30, 12, 0)!;
    n.personality.aggression = 5;
    const d = at(npcs, n, 'TALK_DEMAND_LEAVE');
    d.choose(pick(d, "Okay, I'm going.").index);
    expect(n.attitude).toBe('WAIT_FOR_LEAVE');
    expect(n.patience).toBe(10);
    npcs.update(game, 9 / ACTION_SCALE, 0);
    expect(n.attitude).toBe('WAIT_FOR_LEAVE');
    npcs.update(game, 2 / ACTION_SCALE, 0);
    expect(n.attitude).toBe('KILL');
  });

  it('asking for equipment with a mininuke runs add_debt (parse_mod terms × TOTAL)', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    n.op = { trust: 2, fear: 0, value: 1, anger: 0, owed: 0 };
    n.personality.altruism = 3;
    game.player.inv.giveNew(createItem(data, 'mininuke'));
    const d = at(npcs, n, 'TALK_SHARE_EQUIPMENT');
    d.effect({ add_debt: [['TRUST', 1], ['VALUE', 3], ['ALTRUISM', 2], ['TOTAL', 300]] });
    expect(n.op.owed).toBe((2 + 3 + 6) * 300);
    d.effect('deny_equipment');
    expect(d.cond({ npc_has_effect: 'asked_for_item' })).toBe(true);
    // BN's TALK_SHARE_EQUIPMENT names the effect as a bare string condition: false in BN
    expect(d.cond('asked_for_item')).toBe(false);
  });
});

describe('followers', () => {
  it('combat and misc rules menus read and write the rules, which survive a save', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    d.effect('follow');
    expect(d.cond({ npc_rule: 'use_guns' })).toBe(true);
    expect(d.cond({ npc_engagement_rule: 'ENGAGE_CLOSE' })).toBe(true);
    const c = at(npcs, n, 'TALK_COMBAT_COMMANDS');
    const before = c.view().responses.map((r) => r.text);
    expect(before).toContain("Don't use ranged weapons anymore.");
    d.effect({ toggle_npc_rule: 'use_guns' });
    expect(n.rules.hasFlag('use_guns')).toBe(false);
    d.effect({ set_npc_engagement_rule: 'ENGAGE_NONE' });
    d.effect({ set_npc_aim_rule: 'AIM_PRECISE' });
    d.effect({ set_npc_cbm_reserve_rule: 'CBM_RESERVE_ALL' });
    expect(d.cond({ npc_engagement_rule: 'ENGAGE_NONE' })).toBe(true);
    expect(d.cond({ npc_aim_rule: 'AIM_PRECISE' })).toBe(true);
    expect(d.cond({ npc_cbm_reserve_rule: 'CBM_RESERVE_ALL' })).toBe(true);
    // the combat menu now offers the opposite choice
    const after = at(npcs, n, 'TALK_COMBAT_COMMANDS').view().responses.map((r) => r.text);
    expect(after).not.toContain("Don't use ranged weapons anymore.");
    expect(after.join('\n')).toMatch(/ranged weapons/);
    // an override wins over the flag (npc_follower_rules::has_flag)
    n.rules.overrideEnable.add('follow_close');
    expect(d.cond({ npc_override: 'follow_close' })).toBe(true);
    expect(d.cond({ npc_rule: 'follow_close' })).toBe(false);
    d.effect('clear_overrides');
    expect(d.cond({ npc_override: 'follow_close' })).toBe(false);
    // BN's ally_rule_strs has no investigate_noises: false / no-op there too
    expect(d.cond({ npc_rule: 'investigate_noises' })).toBe(false);
    const back = Npc.fromJSON(data, JSON.parse(JSON.stringify(n.npcJSON())));
    expect(back.rules.hasFlag('use_guns')).toBe(false);
    expect(back.rules.engagement).toBe('ENGAGE_NONE');
    expect(back.rules.aim).toBe('AIM_PRECISE');
  });

  it('copy_npc_rules takes another follower\'s rules; go_to_sleep lies them down', () => {
    const { npcs, msgs } = world();
    const a = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const b = npcs.spawn({ cls: 'NC_SCAVENGER' }, 15, 13, 0)!;
    new Dialogue(npcs, a).effect('follow');
    new Dialogue(npcs, b).effect('follow');
    b.rules.engagement = 'ENGAGE_ALL';
    b.rules.flags.add('allow_bash');
    npcs.pickOption = (_t, options, onPick) => onPick(options.indexOf(b.name));
    new Dialogue(npcs, a).effect('copy_npc_rules');
    expect(a.rules.engagement).toBe('ENGAGE_ALL');
    expect(a.rules.hasFlag('allow_bash')).toBe(true);
    new Dialogue(npcs, a).effect('go_to_sleep');
    expect(a.effects.has('lying_down')).toBe(true);
    expect(msgs.some((m) => m.includes('lies down to sleep'))).toBe(true);
  });

  it('u_driving is true only at the controls of a moving vehicle', () => {
    const { npcs, game } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    expect(d.cond('u_driving')).toBe(false);
    game.vehicles = { driving: { velocity: 0 } } as never;
    expect(d.cond('u_driving')).toBe(false);
    game.vehicles = { driving: { velocity: 1200 } } as never;
    expect(d.cond('u_driving')).toBe(true);
    expect(d.cond('npc_driving')).toBe(false);
  });
});

describe('misc effects', () => {
  it('u_learn_recipe (Isherwood cattail jelly) and u_spend_ecash / u_has_ecash', () => {
    const { npcs, game, msgs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    d.effect({ u_learn_recipe: 'cattail_jelly' });
    expect(game.player.learnedRecipes.has('cattail_jelly')).toBe(true);
    expect(msgs.some((m) => /You learn how to craft/.test(m))).toBe(true);
    npcs.cash = 500;
    expect(d.cond({ u_has_ecash: 500 })).toBe(true);
    d.effect({ u_spend_ecash: 700 });
    expect(npcs.cash).toBe(-200);
  });

  it('u_buy_monster pays from what the NPC owes and places a tame animal', () => {
    const { npcs, mons } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    n.op.owed = 1000;
    new Dialogue(npcs, n).effect({ u_buy_monster: 'mon_chicken', cost: 400, count: 2 });
    expect(n.op.owed).toBe(600);
    const pets = mons.all.filter((m) => m.type.id === 'mon_chicken');
    expect(pets.length).toBe(2);
    expect(pets.every((m) => m.friendly)).toBe(true);
  });

  it('unsupported kinds warn naming the missing system (never silently pass)', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    resetWarnings();
    const warns: string[] = [];
    const w0 = console.warn;
    console.warn = (m: string) => void warns.push(m);
    try {
      expect(d.cond('u_has_stolen_item')).toBe(false);
      d.effect('do_construction');
      d.effect('start_training');
    } finally {
      console.warn = w0;
    }
    expect(warns).toEqual([
      '[talk] unsupported condition "u_has_stolen_item": item ownership (stolen items) is not implemented (treated as false)',
      '[talk] unsupported effect "do_construction": NPC activities are not implemented (no-op)',
      '[talk] unsupported effect "start_training": NPC training is not implemented (no-op)',
    ]);
  });
});

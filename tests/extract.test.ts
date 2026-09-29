// Checks the committed public/data/*.json against values read by hand from the CDDA JSON
// (~/code/Cataclysm-DDA/data/json). If CDDA is updated these may need refreshing; the
// file/line each value came from is noted so that is quick.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { expandItemGroup, getMisc, itemCountName, itemName, pickFromMonsterGroup, possibleItems, recipesFor } from '../src/data/index';
import type { GameData, ItemGroupDef, RecipeDef } from '../src/data/types';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: load('terrain.json'),
  furniture: load('furniture.json'),
  items: load('items.json'),
  itemGroups: load('item_groups.json'),
  monsters: load('monsters.json'),
  monsterGroups: load('monster_groups.json'),
  recipes: load('recipes.json'),
  misc: load('misc.json'),
};
const recipe = (id: string): RecipeDef => {
  const r = data.recipes.find((x) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
};

describe('items', () => {
  it('2x4 (items/resources/wood.json): units, to_hit object, melee damage', () => {
    const p = data.items['2x4'];
    expect(p).toMatchObject({
      name: 'plank', name_plural: 'planks', type: 'GENERIC', subtypes: [], category: 'spare_parts',
      weight: 2440, volume: 4130, longest_side: 122, price: 1000, price_postapoc: 10,
      material: ['wood'], symbol: '/', color: 'brown', melee_damage: { bash: 16 }, bashing: 16,
      // grip none(1) + length long(2) + surface any(2) + balance uneven(1) - 7
      to_hit: -1,
    });
    expect(p.flags).toEqual(['FRAGILE_MELEE', 'FIREWOOD']);
    expect(itemName(p)).toBe('plank');
    expect(itemCountName(p, 3)).toBe('3 planks');
  });

  it('bp_223 (items/ammo/223.json): proportional on price, damage (incl. barrels), recoil; extend/delete', () => {
    const a = data.items['bp_223'];
    expect(a.type).toBe('AMMO');
    expect(a.name).toBe('.223 Remington, black powder');
    expect(a.name_plural).toBe('.223 Remington, black powder'); // str_sp
    expect(a.price).toBe(84); // 2 USD 80 cent * 0.3
    expect(a.recoil).toBe(855); // 1500 * 0.57f, computed in float like C++
    expect(a.dispersion).toBe(36); // 30 * 1.2
    expect(a.damage).toHaveLength(1);
    expect(a.damage![0].amount).toBeCloseTo(22.23, 4); // 39 * 0.57
    expect(a.damage![0].armor_penetration).toBe(1); // 2 * 0.5
    expect((a.damage![0].barrels as any[])[0]).toEqual({ barrel_length: 2.8, amount: expect.closeTo(7.41, 4) });
    expect(a.flags).not.toContain('IRREPLACEABLE_CONSUMABLE');
    expect(a.effects).toEqual(['COOKOFF', 'RECYCLED', 'BLACKPOWDER', 'MUZZLE_SMOKE']);
    expect(a.weight).toBe(12);
    expect(a.ammo_type).toBe('223');
  });

  it('556 / 556_m995: relative damage chains', () => {
    const m855 = data.items['556'];
    expect(m855.damage![0]).toMatchObject({ damage_type: 'bullet', amount: 36, armor_penetration: 12 }); // 39-3, 2+10
    expect(m855.dispersion).toBe(50); // 30 + 20
    expect(m855.recoil).toBe(1650); // 1500 * 1.1
    expect(m855.material).toEqual(['steel', 'brass', 'lead', 'powder']);
    expect(m855.looks_like).toBe('223');
    const m995 = data.items['556_m995'];
    expect(m995.damage![0]).toMatchObject({ amount: 33, armor_penetration: 20 }); // 36-3, 12+8
    expect(m995.looks_like).toBe('556');
  });

  it('every item has the normalized core fields', () => {
    for (const it of Object.values(data.items)) {
      expect(typeof it.weight, it.id).toBe('number');
      expect(typeof it.volume, it.id).toBe('number');
      expect(Array.isArray(it.flags), it.id).toBe(true);
      expect(Array.isArray(it.material), it.id).toBe(true);
      expect(typeof it.name, it.id).toBe('string');
      expect(typeof it.to_hit, it.id).toBe('number');
    }
  });
});

describe('monsters', () => {
  it('mon_zombie (monsters/zed-classic.json) inherits from abstract mon_zombie_base', () => {
    const z = data.monsters['mon_zombie'];
    expect(z).toMatchObject({
      name: 'zombie', name_plural: 'zombies', hp: 80, speed: 70, volume: 62500, weight: 81500,
      melee_skill: 4, melee_dice: 2, melee_dice_sides: 3, vision_night: 3, vision_day: 40, dodge: 0,
      default_faction: 'zombie', species: ['ZOMBIE', 'HUMAN'], symbol: 'Z', color: 'light_green',
      death_drops: 'default_zombie_death_drops', attack_cost: 100,
      upgrades: { half_life: 120, into_group: 'GROUP_ZOMBIE_UPGRADE' },
    });
    expect(z.flags).toEqual(expect.arrayContaining(['SEES', 'HEARS', 'PUSH_MON', 'CLUMSY_ATTACKS']));
    expect(z.special_attacks).toContainEqual({ id: 'grab', cooldown: 2 });
    expect(z.special_attacks).toContainEqual({ id: 'PARROT', cooldown: 400 });
    expect(z.looks_like).toBeUndefined(); // parent is abstract
  });

  it('mon_zombie_crawler: overrides, extend + delete flags, looks_like = copy-from', () => {
    const c = data.monsters['mon_zombie_crawler'];
    expect(c).toMatchObject({ hp: 60, speed: 20, melee_skill: 2, vision_day: 10, color: 'pink_green', looks_like: 'mon_zombie' });
    expect(c.flags).toContain('ATTACK_LOWER');
    expect(c.flags).toContain('CLUMSY_ATTACKS'); // from mon_zombie's extend
    expect(c.flags).not.toContain('PUSH_MON');
    // GEN_DORMANT generates a pseudo_dormant twin, as MonsterGenerator does
    expect(data.monsters['pseudo_dormant_mon_zombie_crawler']).toMatchObject({ hp: 5, speed: 1, zombify_into: 'mon_zombie_crawler' });
  });

  it('monster groups: default monster and weighted picks', () => {
    const g = data.monsterGroups['GROUP_PARK_SCENIC'];
    expect(g.default).toBe('mon_zombie');
    expect(g.monsters[0]).toMatchObject({ group: 'GROUP_CIVILIANS_STANDARD', weight: 100, cost_multiplier: 0 });
    const rng = new Rng(11);
    for (let i = 0; i < 50; i++) {
      for (const s of pickFromMonsterGroup(data, 'GROUP_PARK_SCENIC', rng)) expect(data.monsters[s.id], s.id).toBeDefined();
    }
  });
});

describe('terrain & furniture', () => {
  it('t_wall (furniture_and_terrain/terrain-walls.json): abstract chain + bash', () => {
    const w = data.terrain['t_wall'];
    expect(w).toMatchObject({
      name: 'wall', move_cost: 0, coverage: 100, roof: 't_flat_roof', symbol: '#', color: 'light_gray',
      connect_groups: ['WALL'], connects_to: ['WALL'],
      bash: { str_min: 30, str_max: 210, sound: 'crash!', sound_fail: 'whump!', ter_set: 't_null', items: 'wall_bash_results' },
    });
    expect(w.flags).toEqual(['NOITEM', 'SUPPORTS_ROOF', 'WALL', 'NO_SCENT', 'AUTO_WALL_SYMBOL', 'BLOCK_WIND', 'MINEABLE', 'FLAMMABLE', 'WIRED_WALL']);
    expect(w.looks_like).toBeUndefined(); // copy-from is abstract
  });

  it('t_door_glass_frosted_c (terrain-doors.json): inherits bash/deconstruct/roof, own open', () => {
    const d = data.terrain['t_door_glass_frosted_c'];
    expect(d).toMatchObject({ move_cost: 0, roof: 't_flat_roof', open: 't_door_glass_frosted_o', looks_like: 't_door_glass_c', color: 'white' });
    expect(d.bash).toMatchObject({ str_min: 6, str_max: 20, ter_set: 't_door_frame' });
    expect(d.bash!.items).toEqual({ subtype: 'collection', entries: [{ item: 'glass_shard', count: [42, 84] }] });
    expect(d.deconstruct).toMatchObject({ ter_set: 't_door_frame' });
    expect(d.flags).not.toContain('TRANSPARENT');
  });

  it('f_chair (furniture-seats.json)', () => {
    expect(data.furniture['f_chair']).toMatchObject({ name: 'wooden chair', symbol: '#', color: 'brown', move_cost_mod: 1, required_str: 4, bash: { str_min: 6, str_max: 25 } });
  });

  it('every bash ter_set / open / close points at real terrain', () => {
    for (const t of Object.values(data.terrain)) {
      for (const id of [t.open, t.close, t.bash?.ter_set]) if (id && id !== 't_null') expect(data.terrain[id], `${t.id} -> ${id}`).toBeDefined();
    }
  });
});

describe('item groups', () => {
  it('wall_bash_results expands to real items', () => {
    const rng = new Rng(2);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) for (const it of expandItemGroup(data, 'wall_bash_results', rng)) {
      expect(data.items[it.id], it.id).toBeDefined();
      seen.add(it.id);
    }
    expect(seen).toContain('splinter'); // count [1, 5], prob 100
  });

  it('legacy "items" pairs + migrations (itemgroups/activities_hobbies.json "games")', () => {
    const g = data.itemGroups['games'];
    expect(g.subtype).toBe('distribution');
    expect(g.entries).toContainEqual({ item: 'chess', prob: 50 });
    expect(g.entries).toContainEqual({ group: 'decks_of_cards', prob: 50 });
    // "uno" is a MIGRATION to deck_of_cards variant "uno"
    expect(g.entries).toContainEqual({ item: 'deck_of_cards', prob: 30, variant: 'uno' });
  });

  it('every group only references known items (mapgen owners can rely on this)', () => {
    for (const id of Object.keys(data.itemGroups)) {
      for (const i of possibleItems(data, id)) if (i !== 'corpse') expect(data.items[i], `${id}: ${i}`).toBeDefined();
    }
  });
});

describe('recipes', () => {
  it('spear_wood (recipes/weapon/piercing.json)', () => {
    const r = recipe('spear_wood');
    expect(r).toMatchObject({ result: 'spear_wood', skill_used: 'fabrication', difficulty: 2, time: 2700, autolearn: true, skills_required: [['survival', 1]] });
    expect(r.qualities).toEqual([[{ id: 'CUT', level: 2 }]]);
    expect(r.tools).toEqual([[{ id: 'fire', count: -1 }]]);
    expect(r.components).toEqual([[{ id: 'stick_long', count: 1 }, { id: 'pointy_stick_long', count: 1 }]]);
    expect(recipesFor(data, 'spear_wood').map((x) => x.id)).toContain('spear_wood');
  });

  it('vh_autoclave: `using` soldering_standard x5 is expanded', () => {
    const r = recipe('vh_autoclave');
    expect(r.time).toBe(1800);
    expect(r.skills_required).toEqual([['electronics', 4]]);
    expect(r.components).toEqual([
      [{ id: 'autoclave', count: 1 }], [{ id: 'cable', count: 1 }], [{ id: 'power_supply', count: 2 }], [{ id: 'solder_wire', count: 5 }],
    ]);
    expect(r.tools).toEqual([[
      { id: 'soldering_iron', count: 5 }, { id: 'integrated_electrokit', count: 5 }, { id: 'soldering_iron_portable', count: 5 },
      { id: 'integrated_welder', count: 5 }, { id: 'small_repairkit', count: 5 }, { id: 'large_repairkit', count: 5 },
    ]]);
  });

  it('firecracker_pack: LIST component cordage_short is inlined', () => {
    const r = recipe('firecracker_pack');
    expect(r.time).toBe(180);
    expect(r.difficulty).toBe(0);
    expect(r.components[2]).toEqual([{ id: 'string_6', count: 1 }, { id: 'cordage_6', count: 1 }, { id: 'cordage_6_leather', count: 1 }]);
    expect(r.components.flat().some((c) => c.list)).toBe(false);
  });

  it('step recipes: apron_cotton variant copies steps; time is the sum', () => {
    const r = recipe('apron_cotton_maid_apron');
    expect(r.result).toBe('apron_cotton');
    expect(r.steps?.map((s) => s.time)).toEqual([5400, 5400]);
    expect(r.time).toBe(10800);
  });

  it('no recipe references unknown items after LIST/using expansion', () => {
    for (const r of data.recipes) {
      for (const c of [...r.components.flat(), ...r.tools.flat()]) expect(data.items[c.id], `${r.id}: ${c.id}`).toBeDefined();
    }
  });
});

describe('misc', () => {
  it('profession unemployed (professions.json): items as collection groups', () => {
    const p = getMisc(data, 'profession', 'unemployed');
    expect(p.name).toBe('Survivor');
    expect(p.points).toBe(0);
    const both: ItemGroupDef = p.items.both;
    expect(both.subtype).toBe('collection');
    expect(both.entries.slice(0, 4)).toEqual([{ item: 'jeans' }, { item: 'longshirt' }, { item: 'socks' }, { item: 'sneakers' }]);
    expect(both.entries[4]).toEqual({ group: 'charged_smart_phone', 'contents-item': ['guidebook'] });
    const spawned = expandItemGroup(data, both, new Rng(1)).map((i) => i.id);
    expect(spawned).toEqual(expect.arrayContaining(['jeans', 'longshirt', 'socks', 'sneakers']));
  });

  it('has the expected misc types', () => {
    for (const t of ['material', 'requirement', 'tool_quality', 'ammunition_type', 'profession', 'scenario', 'start_location', 'mutation',
      'effect_type', 'martial_art', 'technique', 'harvest', 'field_type', 'trap', 'construction', 'construction_group', 'body_part',
      'sub_body_part', 'skill', 'item_category', 'monster_faction', 'species', 'snippet', 'vehicle', 'vehicle_part', 'bionic',
      'proficiency', 'fault', 'morale_type', 'addiction_type', 'practice', 'item_action', 'emit', 'speech', 'dream', 'uncraft']) {
      expect(Object.keys(data.misc[t] ?? {}).length, t).toBeGreaterThan(0);
    }
    expect(data.misc.material.wood).toBeDefined();
    expect(data.misc.tool_quality.HAMMER).toBeDefined();
    expect(data.misc.monster_faction.zombie).toBeDefined();
    expect(data.misc.snippet.addict_alcohol_mild_awake[0]).toBe('You could use a drink.');
    expect(data.misc.speech.mon_mi_go).toContainEqual({ sound: '"Hello?"', volume: 20 });
  });
});

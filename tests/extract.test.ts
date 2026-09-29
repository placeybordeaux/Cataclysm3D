// Checks the committed public/data/*.json against values read by hand from the Bright
// Nights JSON (~/code/Cataclysm-BN/data/json). If BN is updated these may need refreshing;
// the file each value came from is noted so that is quick.

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
  it('2x4 (items/resources/wood.json): units, BN int to_hit, bashing, stackable', () => {
    const p = data.items['2x4'];
    expect(p).toMatchObject({
      name: 'plank', name_plural: 'planks', type: 'GENERIC', subtypes: [], category: 'scrap_wood',
      weight: 2200, volume: 4400, price: 1000, price_postapoc: 10, material: ['wood'], symbol: '/', color: 'brown',
      to_hit: 1, bashing: 10, melee_damage: { bash: 10 }, techniques: ['WBLOCK_1'],
      // "stackable": true -> count_by_charges with the default stack of 1
      stackable: true, count_by_charges: true, stack_size: 1,
    });
    // default thrown damage: bashing + weight in kg (load_basic_info)
    expect(p.thrown_damage).toEqual([{ damage_type: 'bash', amount: 12.2 }]);
    expect(itemName(p)).toBe('plank');
    expect(itemCountName(p, 3)).toBe('3 planks');
  });

  it('bp_223 (items/ammo/223.json): proportional price/damage/recoil, extend effects, looks_like', () => {
    const a = data.items['bp_223'];
    expect(a).toMatchObject({ type: 'AMMO', subtypes: ['AMMO'], ammo_type: '223', looks_like: '223', count_by_charges: true });
    expect(a.price).toBe(140); // 280 cent * 0.5
    expect(a.price_postapoc).toBe(450); // 9 USD * 0.5
    expect(a.recoil).toBe(1140); // 1500 * 0.76
    expect(a.dispersion).toBe(36); // 30 * 1.2
    expect(a.damage).toHaveLength(1);
    expect(a.damage![0].amount).toBeCloseTo(33.6, 6); // 42 * 0.8
    expect(a.damage![0].armor_penetration).toBe(9); // 18 * 0.5
    expect(a.effects).toEqual(['COOKOFF', 'RECYCLED', 'BLACKPOWDER', 'MUZZLE_SMOKE']);
  });

  it('bottle_plastic / water (items/containers.json, comestibles/drink.json): the container model', () => {
    expect(data.items.bottle_plastic).toMatchObject({
      type: 'CONTAINER', subtypes: ['CONTAINER'], volume: 500, rigid: true,
      container_data: { contains: 500, seals: true, watertight: true, preserves: false },
    });
    // water: COMESTIBLE + an ammo_data slot object, counted by charges, default container a bottle
    expect(data.items.water).toMatchObject({
      type: 'COMESTIBLE', subtypes: ['AMMO', 'COMESTIBLE'], phase: 'liquid', container: 'bottle_plastic',
      count_by_charges: true, stack_size: 1, volume: 250, ammo_type: 'water', quench: 50,
    });
    // spawning water alone gives a full bottle (item::in_its_container)
    expect(expandItemGroup(data, { subtype: 'collection', entries: [{ item: 'water' }] }, new Rng(1))).toEqual([
      { id: 'bottle_plastic', count: 1, contents: [{ id: 'water', count: 1, charges: 2 }] },
    ]);
  });

  it('backpack / jeans (items/armor): storage, portions, rigid and layers', () => {
    expect(data.items.backpack).toMatchObject({
      type: 'ARMOR', storage: 15000, rigid: false, layer: 'BELTED',
      armor: [{ covers: ['torso'], coverage: 15, encumbrance: 3, max_encumbrance: 15 }],
    });
    expect(data.items.jeans).toMatchObject({
      storage: 500, rigid: true, layer: 'REGULAR', warmth: 10,
      armor: [{ covers: ['leg_l', 'leg_r'], coverage: 95, encumbrance: 16, max_encumbrance: 16 }],
    });
    // holster: "leg_either" makes it sided; its holster use_action is exposed as data
    expect(data.items.holster).toMatchObject({ sided: true, layer: 'WAIST', holster: { max_volume: 1000, min_volume: 250, multi: 1, draw_cost: 100 } });
  });

  it('glock_19 / glockmag (items/gun/9mm.json, items/magazine/9mm.json): magazines', () => {
    expect(data.items.glock_19).toMatchObject({
      type: 'GUN', ammo: ['9mm'], clip_size: 0, magazine_well: 250, skill: 'pistol',
      magazine_default: { '9mm': 'glockmag' }, modes: [['DEFAULT', 'semi', 1]],
    });
    expect(data.items.glock_19.magazines!['9mm']).toContain('glockmag');
    expect(data.items.glockmag).toMatchObject({
      type: 'MAGAZINE', ammo_type: ['9mm'],
      magazine: { ammo_type: ['9mm'], capacity: 15, count: 0, default_ammo: '9mm', reliability: 8, reload_time: 100 },
    });
    expect(data.items.glockmag.capacity).toBeUndefined(); // lives in `magazine` only
  });

  it('sa_cryptology_key (items/book/computer.json): legacy int "time" is minutes', () => {
    expect(data.items.sa_cryptology_key).toMatchObject({ type: 'BOOK', time: 40 * 60, required_level: 7, max_level: 10, intelligence: 12, skill: 'computer' });
  });

  it('flamethrower_simple (items/gun/flammable.json): gun_data is loaded after the flat members and wins', () => {
    const f = data.items.flamethrower_simple;
    expect(f.subtypes).toEqual(['GUN']);
    // flat "ammo": "flammable" is read first, then load_basic_info reads gun_data's "gasoline"
    expect(f.ammo).toEqual(['gasoline']);
  });

  it('every item has the normalized core fields and a known category', () => {
    for (const it of Object.values(data.items)) {
      expect(typeof it.volume, it.id).toBe('number');
      expect(it.volume, it.id).toBeGreaterThanOrEqual(1);
      expect(typeof it.weight, it.id).toBe('number');
      expect(Array.isArray(it.subtypes), it.id).toBe(true);
      expect(typeof it.count_by_charges, it.id).toBe('boolean');
      expect(data.misc.item_category[it.category], `${it.id} category ${it.category}`).toBeDefined();
      expect(it.pocket_data, it.id).toBeUndefined();
    }
  });
});

describe('monsters', () => {
  it('mon_zombie (monsters/zed-classic.json)', () => {
    const z = data.monsters.mon_zombie;
    expect(z).toMatchObject({
      name: 'zombie', species: ['ZOMBIE', 'HUMAN'], default_faction: 'zombie', volume: 62500, weight: 81500, hp: 80, speed: 70,
      melee_skill: 4, melee_dice: 3, melee_dice_sides: 3, vision_day: 40, vision_night: 3, harvest: 'zombie',
      death_function: ['NORMAL'], upgrades: { half_life: 14, into_group: 'GROUP_ZOMBIE_UPGRADE' },
    });
    expect(z.special_attacks).toEqual([{ type: 'bite', cooldown: 5, id: 'bite' }, { id: 'GRAB', cooldown: 7 }, { id: 'scratch', cooldown: 20 }]);
    expect(z.armor).toMatchObject({ bash: 0, cut: 0, stab: 0, heat: 0 });
  });

  it('mon_unstable_grub (zed_acid.json): copy-from mon_zombie_dog, extend flags, "extend" on scalar harvest is ignored', () => {
    const g = data.monsters.mon_unstable_grub;
    expect(g.harvest).toBe('zombie_leather'); // mon_zombie_dog's; BN ignores extend.harvest
    expect(g.flags).toEqual(expect.arrayContaining(['INTERIOR_AMMO', 'ACIDPROOF', 'ACID_BLOOD', 'STUMBLES']));
    expect(g.looks_like).toBe('mon_ant_acid_larva');
    expect(g.melee_damage).toEqual([{ damage_type: 'cut', amount: 1 }]); // "melee_cut": 1
    expect(g.death_function).toEqual(['ACID', 'MELT']);
  });

  it('monster groups (monstergroups/zombies.json GROUP_ZOMBIE): keyed by name, freq_total 1000', () => {
    const g = data.monsterGroups.GROUP_ZOMBIE;
    expect(g).toMatchObject({ id: 'GROUP_ZOMBIE', default: 'mon_zombie', freq_total: 1000, is_animal: false });
    expect(g.monsters[0]).toEqual({ monster: 'mon_zombie', weight: 1, cost_multiplier: 7, pack_size: [5, 20] });
    expect(g.name_plural).toBeUndefined();
    const rng = new Rng(11);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const s of pickFromMonsterGroup(data, 'GROUP_ZOMBIE', rng)) seen.add(s.id);
    expect(seen.has('mon_zombie')).toBe(true);
    expect(seen.has('mon_zombie_fat')).toBe(true);
    for (const id of seen) expect(data.monsters[id], id).toBeDefined();
  });

  it('MONSTER_BLACKLIST (default_blacklist.json) removes its monsters from every group', () => {
    const black = data.misc.monster_blacklist.default as string[];
    expect(black).toEqual(expect.arrayContaining(['mon_zombie_dancer', 'mon_zombie_jackson', 'mon_shia']));
    for (const g of Object.values(data.monsterGroups)) for (const m of g.monsters) expect(black.includes(m.monster), g.id).toBe(false);
  });
});

describe('terrain & furniture', () => {
  it('t_wall (terrain-walls.json): bash, and its aliases t_wall_h/t_wall_v resolve to it', () => {
    const w = data.terrain.t_wall;
    expect(w).toMatchObject({ move_cost: 0, roof: 't_flat_roof', symbol: 'LINE_OXOX', color: 'light_gray' });
    expect(w.bash).toMatchObject({ str_min: 40, str_max: 210, ter_set: 't_null', items: 'wall_bash_results' });
    expect(data.terrain.t_wall_h).toEqual(w);
    expect(data.terrain.t_wall_v.id).toBe('t_wall');
  });

  it('t_door_c (terrain-doors.json): open, deconstruct/bash item groups default to collections', () => {
    const d = data.terrain.t_door_c;
    expect(d).toMatchObject({ open: 't_door_o', roof: 't_flat_roof', coverage: 95 });
    expect(d.deconstruct).toMatchObject({ ter_set: 't_door_frame' });
    expect((d.deconstruct!.items as ItemGroupDef).subtype).toBe('collection');
    expect((d.bash!.items as ItemGroupDef).entries).toContainEqual({ item: 'nail', charges: [0, 2] });
  });

  it('every bash ter_set / open / close points at real terrain', () => {
    for (const t of Object.values(data.terrain)) {
      for (const v of [t.open, t.close, t.bash?.ter_set]) if (v && v !== 't_null') expect(data.terrain[v], `${t.id} -> ${v}`).toBeDefined();
    }
  });
});

describe('item groups', () => {
  it('wall_bash_results expands to real items', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 30; i++) for (const s of expandItemGroup(data, 'wall_bash_results', rng)) expect(data.items[s.id], s.id).toBeDefined();
  });

  it('every group only references known items and groups', () => {
    for (const id of Object.keys(data.itemGroups)) for (const i of possibleItems(data, id)) expect(data.items[i] ?? (i === 'corpse' ? 1 : undefined), `${id}: ${i}`).toBeDefined();
  });

  it('migrations (obsoletion/explosives.json): bootleg_grenade -> improvised_grenade everywhere', () => {
    expect(data.misc.item_migration.bootleg_grenade).toMatchObject({ replace: 'improvised_grenade' });
    for (const id of Object.keys(data.itemGroups)) expect(possibleItems(data, id).has('bootleg_grenade'), id).toBe(false);
  });
});

describe('recipes', () => {
  it('spear_wood (recipes/weapon/piercing.json): time, autolearn: true expanded, LISTs inlined', () => {
    const r = recipe('spear_wood');
    expect(r).toMatchObject({
      type: 'recipe', result: 'spear_wood', skill_used: 'fabrication', difficulty: 2, time: 120, result_mult: 1, contained: false,
      skills_required: [['survival', 1]], autolearn: [['survival', 1], ['fabrication', 2]],
    });
    expect(r.qualities).toEqual([[{ id: 'CUT', level: 1 }], [{ id: 'SANDING', level: 1 }]]);
    expect(r.tools).toEqual([[{ id: 'fire', count: -1 }]]);
    expect(r.components[0]).toEqual([{ id: 'stick_long', count: 1 }]);
    expect(r.components[1].map((c) => c.id)).toEqual(expect.arrayContaining(['rag', 'felt_patch', 'leather']));
    expect(recipesFor(data, 'spear_wood').map((x) => x.id)).toContain('spear_wood');
  });

  it('vh_autoclave (recipes/other/vehicles.json): `using` soldering_standard x5 is expanded', () => {
    const r = recipe('vh_autoclave');
    expect(r.tools).toEqual([[{ id: 'soldering_iron', count: 5 }, { id: 'soldering_ethanol', count: 50 }, { id: 'toolset', count: 5 }]]);
    expect(r.components).toContainEqual([{ id: 'solder_wire', count: 5 }]);
    expect(r.reversible).toBe(true);
  });

  it('firecracker_pack: LIST component cordage_short is inlined', () => {
    const r = recipe('firecracker_pack');
    expect(r.components[2].map((c) => c.id)).toEqual(expect.arrayContaining(['string_6', 'cordage_6', 'thread']));
  });

  it('no recipe references unknown items after LIST/using expansion', () => {
    for (const r of data.recipes) {
      for (const alts of [...r.components, ...r.tools]) for (const c of alts) expect(data.items[c.id], `${r.id}: ${c.id}`).toBeDefined();
      for (const [b] of r.book_learn ?? []) expect(data.items[b]?.subtypes, `${r.id}: ${b}`).toContain('BOOK');
    }
  });
});

describe('misc', () => {
  it('profession unemployed (professions.json): items are collection groups', () => {
    const p = getMisc(data, 'profession', 'unemployed');
    expect(p.points).toBe(0);
    expect(p.items.both.subtype).toBe('collection');
    expect(p.items.both.entries).toContainEqual({ item: 'lighter', charges: 25 });
    expect(p.items.both.entries).toContainEqual({ item: 'jeans' });
    expect(p.items.male.entries).toEqual([{ item: 'boxer_shorts' }]);
  });

  it('has the expected misc types', () => {
    for (const k of [
      'material', 'requirement', 'tool_quality', 'ammunition_type', 'profession', 'scenario', 'mutation', 'mutation_category',
      'effect_type', 'martial_art', 'technique', 'harvest', 'construction', 'bionic', 'skill', 'item_category', 'snippet',
      'uncraft', 'body_part', 'species', 'monster_attack', 'spell', 'enchantment', 'external_option', 'item_migration',
    ]) expect(data.misc[k], k).toBeDefined();
    // DDA-only systems are gone
    for (const k of ['proficiency', 'practice', 'vitamin_type', 'limb_score', 'sub_body_part']) expect(data.misc[k], k).toBeUndefined();
  });
});

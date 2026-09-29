import fs from 'node:fs';
import path from 'node:path';
import type { EffectTypeDef, GameData, ItemDef, MonsterDef } from '../../src/data/types';

// Real Bright Nights item definitions, picked by id from the extracted public/data (the same
// normalized ItemDefs the game loads), plus hand-written monster/material/effect rows in
// src/data/types.ts units (ml, g, seconds). tests/realdata.test.ts checks behaviour against the
// whole data set; the fixture tests pin the item/inventory model on this small, stable subset.

const dataDir = path.join(__dirname, '../../public/data');
const allItems = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8')) as Record<string, ItemDef>;
const realMisc = JSON.parse(fs.readFileSync(path.join(dataDir, 'misc.json'), 'utf8')) as Record<string, Record<string, unknown>>;

/** The ids the fixture tests use (containers, clothes, holsters, guns, magazines, ammo, food, tools). */
export const FIXTURE_ITEMS = [
  // containers: sealed bottles and jar, cans that unseal, open bucket/pot, soft bags
  'bottle_plastic', 'bottle_plastic_small', 'jar_glass', 'can_medium', 'can_medium_unsealed', 'can_food', 'can_food_unsealed', 'bucket', 'pot', 'bag_plastic', 'bag_canvas', 'wrapper',
  // food, drink, medicine
  'water_clean', 'water', 'can_beans', 'chocolate', 'aspirin', 'bandages', 'disinfectant',
  // clothes and worn storage
  'backpack', 'rucksack', 'duffelbag', 'purse', 'jeans', 'pants', 'hoodie', 'jacket_leather', 'hat_hard', 'sneakers', 'socks', 'tshirt',
  // holsters, sheaths, bandoliers
  'holster', 'sheath', 'legpouch_large', 'survivor_pack', 'bandolier_pistol', 'quiver', 'tool_belt',
  // guns (magazine-fed, revolver and shotgun with integral magazines), magazines, ammo
  'glock_19', 'glockmag', 'glockbigmag', '9mm', 'sw_619', '38_special', '38_speedloader', '357mag_fmj', 'remington_870', 'shot_00',
  // tools and odds
  'pipe', 'crowbar', 'knife_combat', 'flashlight', 'flashlight_on', 'light_battery_cell', 'light_disposable_cell', 'battery', 'lighter', 'chem_butane', 'rock', 'rag', 'gasoline',
];

const items: ItemDef[] = FIXTURE_ITEMS.map((id) => {
  const d = allItems[id];
  if (!d) throw new Error(`fixture: public/data has no item ${id}`);
  return d;
});

const zombie: MonsterDef = {
  // monsters/zed-classic.json mon_zombie (copy-from mon_zombie_base resolved)
  id: 'mon_zombie', name: 'zombie', name_plural: 'zombies', attack_cost: 100, luminance: 0, material: ['flesh'], symbol: 'Z', color: 'light_green', species: ['ZOMBIE', 'HUMAN'], default_faction: 'zombie',
  volume: 62500, weight: 81500, hp: 80, speed: 70, aggression: 100, morale: 100, melee_skill: 4, melee_dice: 2, melee_dice_sides: 3,
  melee_damage: [{ damage_type: 'cut', amount: 0 }], dodge: 0, vision_day: 40, vision_night: 3, armor: { electric: 1 },
  flags: ['SEES', 'HEARS', 'STUMBLES', 'WARM', 'GRABS', 'BASHES', 'GROUP_BASH', 'POISON', 'NO_BREATHE', 'REVIVES', 'PUSH_MON', 'FILTHY', 'CLUMSY_ATTACKS'],
};

// BN materials.json: flat `<type>_resist` fields (bash/cut/bullet...), dmg_adj for display names.
const material = (id: string, resist: Record<string, number>) => ({
  id, name: id, dmg_adj: ['lightly damaged', 'damaged', 'very damaged', 'thoroughly damaged'],
  ...Object.fromEntries(Object.entries(resist).map(([k, v]) => [`${k}_resist`, v])),
});
const materials = Object.fromEntries(
  [
    material('cotton', { bash: 1, cut: 1, acid: 3, heat: 0, bullet: 1 }),
    material('denim', { bash: 2, cut: 2.25, acid: 4, heat: 0, bullet: 2 }),
    material('nylon', { bash: 1, cut: 1, acid: 9, heat: 2, bullet: 3 }),
    material('leather', { bash: 1, cut: 3, acid: 4, heat: 2, bullet: 2 }),
    material('plastic', { bash: 2, cut: 2, acid: 9, heat: 1, bullet: 1 }),
    material('rubber', { bash: 5, cut: 1, acid: 5, heat: 2, bullet: 1 }),
    material('steel', { bash: 6, cut: 6, acid: 7, heat: 3, bullet: 3 }),
    material('kevlar', { bash: 1, cut: 3, acid: 5, heat: 40, bullet: 2, stab: 5 }),
  ].map((m) => [m.id, m]),
);

// effects.json: a data-side override to prove misc.effect_type is read (same as CDDA).
const effectTypes: Record<string, EffectTypeDef> = {
  winded: { id: 'winded', name: ['Winded'], apply_message: 'Your breath gives out!', remove_message: 'You catch your breath.', rating: 'bad', max_duration: '30 s', base_mods: { per_mod: [-1], speed_mod: [-10], pain_min: [1], pain_chance: [5], pain_max_val: [20] } },
  // BN aspirin's painkiller (effects.json pkill1)
  pkill1: structuredClone(realMisc.effect_type.pkill1) as EffectTypeDef,
};

const skills = Object.fromEntries(
  [['melee', 'melee'], ['bashing', 'bashing weapons'], ['cutting', 'cutting weapons'], ['stabbing', 'piercing weapons'], ['unarmed', 'unarmed combat'],
    ['dodge', 'dodging'], ['gun', 'marksmanship'], ['pistol', 'handguns'], ['firstaid', 'health care']].map(([id, name]) => [id, { id, name: { str: name } }]),
);

export function makeData(): GameData {
  return {
    terrain: {},
    furniture: {},
    items: Object.fromEntries(items.map((i) => [i.id, structuredClone(i)])),
    itemGroups: {},
    monsters: { mon_zombie: structuredClone(zombie) },
    monsterGroups: {},
    recipes: [],
    misc: { material: structuredClone(materials), effect_type: structuredClone(effectTypes), skill: skills, ammunition_type: structuredClone(realMisc.ammunition_type) },
  };
}

import type { EffectTypeDef, GameData, ItemDef, MonsterDef } from '../../src/data/types';

// A handful of real CDDA definitions (data/json/items/..., monsters/zed-classic.json,
// effects.json), hand-normalized to src/data/types.ts units: ml, g, seconds, lengths in cm.
// tests/realdata.test.ts checks the same behaviour against public/data.

const base = { symbol: '?', color: 'white', flags: [] as string[], material: [] as string[] };

// Fixture rows omit name_plural/category/to_hit/subtypes; mk() fills them in.
type Partial1 = Partial<ItemDef> & { id: string; name: string; type: string; subtypes?: string[] };
/** Fill the fields the extractor always emits. */
const mk = (d: Partial1): ItemDef => ({
  weight: 0,
  volume: 0,
  ...base,
  name_plural: d.name + 's',
  category: 'other',
  to_hit: -2,
  subtypes: d.type !== 'ITEM' && d.type !== 'GENERIC' ? [d.type] : [],
  ...d,
  type: d.type === 'ITEM' ? (d.subtypes?.[0] ?? 'GENERIC') : d.type,
});

const items: ItemDef[] = ([
  // containers/containers.json
  { ...base, id: 'bottle_plastic', type: 'ITEM', subtypes: [], name: 'plastic bottle', weight: 13, volume: 510, longest_side: 22, material: ['plastic'], flags: ['COLLAPSE_CONTENTS'],
    pocket_data: [{ pocket_type: 'CONTAINER', watertight: true, rigid: true, transparent: true, max_contains_volume: 500, max_item_volume: 17, max_contains_weight: 1250, sealed_data: { spoil_multiplier: 0.5 }, moves: 400 }] },
  // comestibles/drink.json
  { ...base, id: 'water_clean', type: 'ITEM', subtypes: ['COMESTIBLE', 'AMMO'], comestible_type: 'DRINK', name: 'clean water', weight: 250, volume: 250, charges: 1, phase: 'liquid', quench: 50, material: ['water'], flags: ['EATEN_COLD'], container: 'bottle_plastic', ammo_type: 'water' },
  // comestibles/other.json ("spoils_in": "2 days")
  { ...base, id: 'can_beans', type: 'ITEM', subtypes: ['COMESTIBLE'], comestible_type: 'FOOD', name: 'canned beans', weight: 256, volume: 250, spoils_in: 2 * 86400, quench: -1, calories: 203, material: ['bean'], flags: ['EATEN_HOT'] },
  // a tasty snack for the morale test (comestibles/junkfood.json chocolate: fun 20)
  { ...base, id: 'chocolate', type: 'ITEM', subtypes: ['COMESTIBLE'], comestible_type: 'FOOD', name: 'chocolate bar', weight: 50, volume: 250, spoils_in: 360 * 86400, calories: 266, fun: 20, material: ['junk'] },
  // comestibles/med.json
  { ...base, id: 'aspirin', type: 'ITEM', subtypes: ['COMESTIBLE'], comestible_type: 'MED', name: 'aspirin', weight: 1, volume: 1, material: ['drug_filler'],
    use_action: { type: 'consume_drug', activation_message: 'You take some %s.', effects: [{ id: 'pkill1_nsaid', duration: 9000 }] } },
  // tool/med.json
  { ...base, id: 'bandages', type: 'ITEM', subtypes: [], name: 'bandage', weight: 70, volume: 27, material: ['cotton'], flags: ['SINGLE_USE'],
    use_action: { type: 'heal', bandages_power: 4, bleed: 15, move_cost: 6000 } },
  { ...base, id: 'disinfectant', type: 'ITEM', subtypes: ['COMESTIBLE'], comestible_type: 'MED', name: 'disinfectant', weight: 27, volume: 25, charges: 10, phase: 'liquid', material: ['alcohol'],
    use_action: { type: 'heal', disinfectant_power: 4, bite: 0.95, move_cost: 3000 } },
  // armor/storage.json
  { ...base, id: 'backpack', type: 'ITEM', subtypes: ['ARMOR'], name: 'backpack', weight: 633, volume: 2000, material: ['nylon'], flags: ['BELTED'], warmth: 6, material_thickness: 2,
    pocket_data: [
      { pocket_type: 'CONTAINER', max_contains_volume: 25000, max_contains_weight: 30000, max_item_length: 40, moves: 300 },
      { pocket_type: 'CONTAINER', holster: true, max_contains_volume: 510, max_contains_weight: 1000, max_item_length: 24, min_item_length: 18, moves: 80 },
    ],
    armor: [{ encumbrance: [2, 25], coverage: 60, covers: ['torso'] }] },
  // armor/legs_clothes.json
  { ...base, id: 'jeans', type: 'ITEM', subtypes: ['ARMOR'], name: 'jeans', name_plural: 'jeans', weight: 600, volume: 2000, material: ['denim'], flags: ['VARSIZE', 'POCKETS'], warmth: 10, material_thickness: 0.65,
    pocket_data: [
      { pocket_type: 'CONTAINER', max_contains_volume: 1250, max_contains_weight: 4000, max_item_length: 19, moves: 80 },
      { pocket_type: 'CONTAINER', max_contains_volume: 1250, max_contains_weight: 4000, max_item_length: 19, moves: 80 },
    ],
    armor: [{ encumbrance: [7, 11], coverage: 100, covers: ['leg_l', 'leg_r'] }] },
  // armor/torso_clothes.json
  { ...base, id: 'hoodie', type: 'ITEM', subtypes: ['ARMOR'], name: 'hoodie', weight: 420, volume: 3000, material: ['cotton'], flags: ['VARSIZE', 'POCKETS', 'HOOD', 'OUTER'], warmth: 20, material_thickness: 1,
    pocket_data: [{ pocket_type: 'CONTAINER', max_contains_volume: 3000, max_contains_weight: 4000, max_item_length: 36, moves: 80 }],
    armor: [{ covers: ['torso'], coverage: 95, encumbrance: [6, 12] }, { covers: ['arm_l', 'arm_r'], coverage: 95, encumbrance: [6, 6] }] },
  // armor/coats.json
  { ...base, id: 'jacket_leather', type: 'ITEM', subtypes: ['ARMOR'], name: 'leather jacket', weight: 1450, volume: 2000, material: ['leather'], flags: ['VARSIZE', 'POCKETS', 'OUTER'], warmth: 25, material_thickness: 1,
    armor: [{ covers: ['torso'], coverage: 100, encumbrance: [8, 12] }, { covers: ['arm_l', 'arm_r'], coverage: 100, encumbrance: [12, 12] }] },
  // armor/hats.json
  { ...base, id: 'hat_hard', type: 'ITEM', subtypes: ['ARMOR'], name: 'hard hat', weight: 430, volume: 2500, material: ['plastic'], flags: ['WATERPROOF', 'PADDED'], warmth: 5,
    armor: [{ material: [{ type: 'plastic', covered_by_mat: 100, thickness: 4 }], coverage: 100, covers: ['head'] }] },
  // armor/boots.json (portions merged)
  { ...base, id: 'sneakers', type: 'ITEM', subtypes: ['ARMOR'], name: 'sneakers (pair)', weight: 454, volume: 1500, material: ['cotton', 'rubber'], flags: ['VARSIZE'], warmth: 20, material_thickness: 1,
    armor: [{ covers: ['foot_l', 'foot_r'], encumbrance: 4, coverage: 100 }] },
  // gun/9mm.json (copy-from gun_base_handgun_semi resolved)
  { ...base, id: 'glock_19', type: 'GUN', name: 'Glock 19 pistol', weight: 600, volume: 386, longest_side: 21.1, barrel_length: 10.2, material: ['plastic', 'steel'], flags: ['ALLOWS_BODY_BLOCK'],
    skill: 'pistol', ammo: ['9mm'], dispersion: 480, sight_dispersion: 60, handling: 10, reload: 150, melee_damage: { bash: 7 }, to_hit: -2,
    pocket_data: [{ magazine_well: 250, pocket_type: 'MAGAZINE_WELL', item_restriction: ['glockmag_10', 'glock17_10', 'glockmag', 'glockbigmag', 'glock17_17', 'glock17_22'] }] },
  // magazine/9mm.json
  { ...base, id: 'glockmag', type: 'ITEM', subtypes: ['MAGAZINE'], name: 'Glock 9x19mm 15-round magazine', weight: 70, volume: 76, longest_side: 11.1, material: ['plastic', 'steel'], flags: ['MAG_COMPACT'], ammo_type: '9mm',
    pocket_data: [{ pocket_type: 'MAGAZINE', rigid: true, ammo_restriction: { '9mm': 15 } }] },
  // ammo/9mm.json (barrel-specific damage dropped: base amount 23)
  { ...base, id: '9mm', type: 'ITEM', subtypes: ['AMMO'], name: '9x19mm JHP', weight: 12, volume: 115, longest_side: 3, material: ['brass', 'lead', 'powder'], count: 50, stack_size: 50, ammo_type: '9mm', range: 14,
    damage: [{ damage_type: 'bullet', amount: 23 }], dispersion: 60, recoil: 500 },
  // resources/metal.json
  { ...base, id: 'pipe', type: 'ITEM', subtypes: [], name: 'pipe', weight: 600, volume: 370, longest_side: 60, material: ['steel'], qualities: [['HAMMER', 1]], melee_damage: { bash: 10 },
    to_hit: 0 },
  // tool/entry_tools.json
  { ...base, id: 'crowbar', type: 'ITEM', subtypes: ['TOOL'], name: 'crowbar', weight: 1456, volume: 520, longest_side: 46, material: ['steel'], flags: ['BELT_CLIP', 'DURABLE_MELEE'],
    qualities: [['PRY', 3], ['HAMMER', 1], ['PRYING_NAIL', 1]], melee_damage: { bash: 19, cut: 1 }, to_hit: 0 },
  // melee/swords_and_blades.json
  { ...base, id: 'knife_combat', type: 'ITEM', subtypes: ['TOOL'], name: 'National Guard bayonet', weight: 270, volume: 184, longest_side: 30, material: ['hc_steel', 'plastic'],
    qualities: [['CUT', 2], ['CUT_FINE', 1], ['BUTCHER', 19]], melee_damage: { stab: 21 }, to_hit: -1 },
  // tool/lighting.json + battery.json + ammo.json
  { ...base, id: 'flashlight', type: 'ITEM', subtypes: ['TOOL'], name: 'flashlight (off)', weight: 140, volume: 121, longest_side: 13.6, material: ['plastic', 'aluminum'], charges_per_use: 1, tool_ammo: ['battery'],
    use_action: { type: 'transform', msg: 'You turn the flashlight on.', target: 'flashlight_on', need_charges: 1, need_charges_msg: 'The batteries are dead.' },
    pocket_data: [{ pocket_type: 'MAGAZINE_WELL', rigid: true, flag_restriction: ['BATTERY_MEDIUM'], default_magazine: 'medium_battery_cell' }] },
  { ...base, id: 'flashlight_on', type: 'ITEM', subtypes: ['TOOL'], name: 'flashlight (on)', weight: 140, volume: 121, longest_side: 13.6, material: ['plastic', 'aluminum'], tool_ammo: ['battery'], power_draw: 1.56, revert_to: 'flashlight',
    flags: ['SPAWN_ACTIVE'], use_action: { type: 'transform', msg: 'You turn the flashlight off.', target: 'flashlight' },
    pocket_data: [{ pocket_type: 'MAGAZINE_WELL', rigid: true, flag_restriction: ['BATTERY_MEDIUM'], default_magazine: 'medium_battery_cell' }] },
  { ...base, id: 'medium_battery_cell', type: 'ITEM', subtypes: ['MAGAZINE'], name: 'medium battery', weight: 85, volume: 17, longest_side: 6.5, material: ['budget_steel', 'plastic'], flags: ['BATTERY_MEDIUM'], ammo_type: 'battery',
    pocket_data: [{ pocket_type: 'MAGAZINE', rigid: true, ammo_restriction: { battery: 56 } }] },
  { ...base, id: 'battery', type: 'ITEM', subtypes: ['AMMO'], name: 'battery', weight: 0, volume: 100, material: ['battery'], ammo_type: 'battery', count: 100 },
] as Partial1[]).map(mk);

const zombie: MonsterDef = {
  // monsters/zed-classic.json mon_zombie (copy-from mon_zombie_base resolved)
  id: 'mon_zombie', name: 'zombie', name_plural: 'zombies', attack_cost: 100, luminance: 0, material: ['flesh'], symbol: 'Z', color: 'light_green', species: ['ZOMBIE', 'HUMAN'], default_faction: 'zombie',
  volume: 62500, weight: 81500, hp: 80, speed: 70, aggression: 100, morale: 100, melee_skill: 4, melee_dice: 2, melee_dice_sides: 3,
  melee_damage: [{ damage_type: 'cut', amount: 0 }], dodge: 0, vision_day: 40, vision_night: 3, armor: { electric: 1 },
  flags: ['SEES', 'HEARS', 'STUMBLES', 'WARM', 'GRABS', 'BASHES', 'GROUP_BASH', 'POISON', 'NO_BREATHE', 'REVIVES', 'PUSH_MON', 'FILTHY', 'CLUMSY_ATTACKS'],
};

// materials.json resist values (bash/cut/bullet...), dmg_adj for display names.
const material = (id: string, resist: Record<string, number>) => ({ id, name: id, resist, dmg_adj: ['lightly damaged', 'damaged', 'very damaged', 'thoroughly damaged'] });
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
    misc: { material: structuredClone(materials), effect_type: structuredClone(effectTypes), skill: skills },
  };
}

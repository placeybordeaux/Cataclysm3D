// Normalized CDDA content as emitted by tools/extract into public/data/*.json.
// The extractor resolves copy-from/extend/delete/relative/proportional and normalizes
// units, so runtime code never parses "250 ml" or "30 m" strings.
//
// Units convention (everywhere in this codebase):
//   volume: ml, weight: g, length: tiles (1 tile == 1 m), duration: game seconds,
//   energy: kJ (for batteries: charges), money: cents, temperature: celsius.
//
// Fields are optional unless CDDA always has them. Extend these interfaces freely, but
// keep names close to the CDDA JSON key (snake_case preserved) so the docs at
// ~/code/Cataclysm-DDA/doc/JSON/*.md stay a valid reference.

/** CDDA color name, e.g. "c_red", "light_gray", "i_yellow". Kept verbatim. */
export type CddaColor = string;

export interface Glyph {
  symbol: string;
  color: CddaColor;
}

export interface BashInfo {
  str_min: number;
  str_max: number;
  sound?: string;
  sound_fail?: string;
  ter_set?: string;
  furn_set?: string;
  items?: ItemGroupRef;
}

export interface DeconstructInfo {
  ter_set?: string;
  furn_set?: string;
  items?: ItemGroupRef;
}

export interface TerrainDef extends Glyph {
  id: string;
  name: string;
  description?: string;
  move_cost: number; // 0 = impassable
  coverage?: number;
  flags: string[];
  connects_to?: string;
  connect_groups?: string[];
  open?: string;
  close?: string;
  bash?: BashInfo;
  deconstruct?: DeconstructInfo;
  roof?: string;
  transforms_into?: string;
  light_emitted?: number;
  looks_like?: string;
  examine_action?: string;
  harvest_by_season?: unknown;
}

export interface FurnitureDef extends Glyph {
  id: string;
  name: string;
  description?: string;
  move_cost_mod: number; // -1 = impassable
  coverage?: number;
  required_str?: number;
  flags: string[];
  open?: string;
  close?: string;
  bash?: BashInfo;
  deconstruct?: DeconstructInfo;
  light_emitted?: number;
  looks_like?: string;
  examine_action?: string;
  crafting_pseudo_item?: string | string[];
  max_volume?: number;
}

export type ItemGroupRef = string | ItemGroupDef;

export interface ItemGroupEntry {
  item?: string;
  group?: string;
  distribution?: ItemGroupEntry[];
  collection?: ItemGroupEntry[];
  prob?: number;
  count?: number | [number, number];
  charges?: number | [number, number];
  "container-item"?: string;
  damage?: number | [number, number];
}

export interface ItemGroupDef {
  id?: string;
  subtype: 'distribution' | 'collection';
  entries: ItemGroupEntry[];
  on_overflow?: string;
}

export interface DamageUnit {
  damage_type: string; // "bash" | "cut" | "stab" | "bullet" | "heat" | ...
  amount: number;
  armor_penetration?: number;
  armor_multiplier?: number;
}

export interface ItemDef extends Glyph {
  id: string;
  type: string; // CDDA type: GENERIC, TOOL, COMESTIBLE, ARMOR, GUN, AMMO, MAGAZINE, BOOK, GUNMOD, ...
  name: string;
  name_plural?: string;
  description?: string;
  category?: string;
  weight: number; // g
  volume: number; // ml
  longest_side?: number; // tiles*100 ~ cm
  price?: number;
  material: string[];
  flags: string[];
  // melee
  bashing?: number;
  cutting?: number;
  to_hit?: number;
  techniques?: string[];
  qualities?: [string, number][];
  use_action?: unknown;
  // comestible
  comestible_type?: string;
  calories?: number;
  quench?: number;
  fun?: number;
  spoils_in?: number;
  healthy?: number;
  addiction_type?: string;
  // tool / charges
  max_charges?: number;
  initial_charges?: number;
  charges_per_use?: number;
  ammo?: string[];
  // armor
  armor?: unknown[];
  warmth?: number;
  encumbrance?: number;
  environmental_protection?: number;
  // gun
  skill?: string;
  ranged_damage?: DamageUnit[];
  range?: number;
  dispersion?: number;
  recoil?: number;
  reload?: number;
  modes?: [string, string, number][];
  magazines?: [string, string[]][];
  // ammo
  ammo_type?: string;
  damage?: DamageUnit[];
  count?: number;
  // book
  skill_book?: string;
  required_level?: number;
  max_level?: number;
  time?: number;
  intelligence?: number;
  // containers
  pocket_data?: unknown[];
  [extra: string]: unknown;
}

export interface MonsterAttack {
  id?: string;
  type?: string;
  cooldown?: number;
  [k: string]: unknown;
}

export interface MonsterDef extends Glyph {
  id: string;
  name: string;
  description?: string;
  species: string[];
  default_faction: string;
  volume: number;
  weight: number;
  hp: number;
  speed: number;
  aggression: number;
  morale: number;
  melee_skill: number;
  melee_dice: number;
  melee_dice_sides: number;
  melee_damage?: DamageUnit[];
  dodge: number;
  armor?: Record<string, number>; // damage type -> armor
  vision_day: number;
  vision_night: number;
  hearing?: number;
  special_attacks?: unknown[];
  death_function?: unknown;
  death_drops?: ItemGroupRef;
  harvest?: string;
  flags: string[];
  upgrades?: { half_life?: number; into_group?: string; into?: string };
  luminance?: number;
  looks_like?: string;
  diff?: number;
  [extra: string]: unknown;
}

export interface MonsterGroupDef {
  id: string;
  default?: string;
  monsters: { monster?: string; group?: string; weight?: number; freq?: number; cost_multiplier?: number; pack_size?: [number, number]; starts?: number; ends?: number }[];
}

export interface RecipeComponent {
  id: string;
  count: number;
  /** true when id refers to a requirement list (CDDA "LIST") */
  list?: boolean;
}

export interface RecipeDef {
  result: string;
  id_suffix?: string;
  category: string;
  subcategory?: string;
  skill_used?: string;
  difficulty: number;
  skills_required?: [string, number][];
  time: number;
  book_learn?: unknown;
  autolearn?: boolean | [string, number][];
  qualities: { id: string; level: number; amount?: number }[][];
  tools: RecipeComponent[][];
  components: RecipeComponent[][];
  byproducts?: [string, number][];
  result_mult?: number;
  charges?: number;
  batch_time_factors?: [number, number];
  flags?: string[];
  proficiencies?: unknown[];
  reversible?: boolean;
}

export interface GameData {
  terrain: Record<string, TerrainDef>;
  furniture: Record<string, FurnitureDef>;
  items: Record<string, ItemDef>;
  itemGroups: Record<string, ItemGroupDef>;
  monsters: Record<string, MonsterDef>;
  monsterGroups: Record<string, MonsterGroupDef>;
  recipes: RecipeDef[];
  /** Everything else keyed by CDDA type then id (materials, professions, effects, ...). */
  misc: Record<string, Record<string, any>>;
}

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

/** CDDA melee_accuracy object; summed to an integer to_hit (item_factory.cpp melee_accuracy). */
export interface MeleeAccuracy {
  grip?: 'bad' | 'none' | 'solid' | 'weapon';
  length?: 'hand' | 'short' | 'long';
  surface?: 'point' | 'line' | 'any' | 'every';
  balance?: 'clumsy' | 'uneven' | 'neutral' | 'good';
}

/** One entry of CDDA `pocket_data` (item_pocket.cpp). Volumes ml, weights g; lengths share
 *  whatever unit the extractor uses for `longest_side`. */
export interface PocketData {
  pocket_type?: 'CONTAINER' | 'MAGAZINE' | 'MAGAZINE_WELL' | 'MOD' | 'CORPSE' | 'SOFTWARE' | 'EBOOK' | 'CABLE';
  max_contains_volume?: number;
  max_contains_weight?: number;
  max_item_volume?: number;
  min_item_volume?: number;
  max_item_length?: number;
  min_item_length?: number;
  /** ammo_type -> max rounds, e.g. { "9mm": 15 } */
  ammo_restriction?: Record<string, number>;
  item_restriction?: string[];
  flag_restriction?: string[];
  /** MAGAZINE_WELL: how much of the magazine's volume disappears into the gun. */
  magazine_well?: number;
  default_magazine?: string;
  watertight?: boolean;
  airtight?: boolean;
  rigid?: boolean;
  holster?: boolean;
  open_container?: boolean;
  transparent?: boolean;
  /** Moves to take an item out of this pocket. */
  moves?: number;
  sealed_data?: { spoil_multiplier?: number };
  spoil_multiplier?: number;
  weight_multiplier?: number;
  volume_multiplier?: number;
  extra_encumbrance?: number;
  ripoff?: number;
  description?: string;
}

/** One entry of CDDA `armor` (islot_armor portion data). */
export interface ArmorPortion {
  covers?: string[];
  specifically_covers?: string[];
  coverage?: number;
  /** [base, when pockets full] or a single number. */
  encumbrance?: number | [number, number];
  cover_melee?: number;
  cover_ranged?: number;
  cover_vitals?: number;
  material?: { type: string; covered_by_mat?: number; thickness?: number }[];
  layers?: string[];
}

/** CDDA effect_type (doc/JSON/EFFECTS_JSON.md). Durations may arrive as seconds or "30 m". */
export interface EffectTypeDef {
  id: string;
  name?: (string | { str: string })[];
  desc?: string[];
  max_intensity?: number;
  max_effective_intensity?: number;
  max_duration?: number | string;
  int_dur_factor?: number | string;
  int_add_val?: number;
  int_decay_step?: number;
  int_decay_tick?: number;
  int_decay_remove?: boolean;
  apply_message?: string;
  remove_message?: string;
  rating?: 'good' | 'bad' | 'neutral' | 'mixed';
  base_mods?: Record<string, number[]>;
  scaling_mods?: Record<string, number[]>;
  resist_traits?: string[];
  resist_effects?: string[];
  removes_effects?: string[];
  blocks_effects?: string[];
  main_parts_only?: boolean;
  show_in_info?: boolean;
  flags?: string[];
  miss_messages?: [string, number][];
  [extra: string]: unknown;
}

export interface EnchantmentValue {
  value: string;
  add?: number;
  multiply?: number;
}

/** CDDA mutation/trait. Only a few fields are interpreted (see character.ts traitMod). */
export interface MutationDef {
  id: string;
  name?: string | { str: string };
  description?: string;
  points?: number;
  starting_trait?: boolean;
  enchantments?: ({ values?: EnchantmentValue[]; condition?: unknown } | string)[];
  flags?: string[];
  [extra: string]: unknown;
}

export interface MaterialDef {
  id: string;
  name?: string;
  resist?: Record<string, number>;
  density?: number;
  /** Adjectives for damage levels 1..4, e.g. ["lightly damaged", "damaged", ...]. */
  dmg_adj?: (string | { str: string })[];
  [extra: string]: unknown;
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
  /** Legacy integer, or CDDA's {grip,length,surface,balance} object (see item.ts toHitFromAccuracy). */
  to_hit?: number | MeleeAccuracy;
  /** Modern CDDA melee damage map, e.g. { bash: 10 } (bashing/cutting are the legacy form). */
  melee_damage?: Record<string, number>;
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
  armor?: ArmorPortion[];
  material_thickness?: number;
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
  /** AMMO: its type; MAGAZINE: list of accepted types. */
  ammo_type?: string | string[];
  damage?: DamageUnit[];
  count?: number;
  // book
  skill_book?: string;
  required_level?: number;
  max_level?: number;
  time?: number;
  intelligence?: number;
  // containers
  pocket_data?: PocketData[];
  // --- misc fields read by src/game (all optional, CDDA key names) ---
  /** Modern CDDA: "type": "ITEM" + "subtypes": ["GUN", ...]. Legacy: type holds the subtype. */
  subtypes?: string[];
  /** Units per `volume` for count-by-charges items (ammo, liquids). Defaults to charges/count. */
  stack_size?: number;
  /** Default charges for comestibles/ammo ("charges" in CDDA JSON). */
  charges?: number;
  phase?: 'solid' | 'liquid' | 'gas' | 'plasma';
  stackable?: boolean;
  /** Default container item id (e.g. water -> bottle_plastic). */
  container?: string;
  sealed?: boolean;
  /** Gun/ammo noise; ammo defaults to range*2 + damage*2 like item_factory.cpp. */
  loudness?: number;
  handling?: number;
  sight_dispersion?: number;
  barrel_length?: number;
  /** Reload cost in moves (guns: per round for integral mags; magazines: "reload_time"). */
  reload_time?: number;
  display_type?: string;
  /** Tools: seconds per charge while active; revert_to when out of charges. */
  turns_per_charge?: number;
  revert_to?: string;
  stim?: number;
  sleepiness_mod?: number;
  /** Stolen from islot_armor: CDDA "sided" / "non_functional" etc are ignored. */
  environmental_protection_with_filter?: number;
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

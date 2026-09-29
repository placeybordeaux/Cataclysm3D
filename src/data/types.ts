// Normalized CDDA content as emitted by tools/extract into public/data/*.json.
// The extractor resolves copy-from/extend/delete/relative/proportional and normalizes
// units, so runtime code never parses "250 ml" or "30 m" strings.
//
// Units convention (everywhere in this codebase):
//   volume: ml, weight: g, duration: game seconds, energy: kJ, power: W, money: cents,
//   temperature: celsius. Item/pocket lengths (longest_side, barrel_length, ...) are in cm;
//   map distances are tiles (1 tile == 1 m).
//
// Items use modern CDDA's `type: "ITEM"` + `subtypes`; `ItemDef.type` is a convenience
// "primary" subtype (GUN > GUNMOD > AMMO > MAGAZINE > COMESTIBLE > BOOK > BIONIC_ITEM >
// TOOL > ARMOR > ...; GENERIC if none), `subtypes` is authoritative.
//
// Fields are optional unless CDDA always has them. Extend these interfaces freely, but
// keep names close to the CDDA JSON key (snake_case preserved) so the docs at
// ~/code/Cataclysm-DDA/doc/JSON/*.md stay a valid reference. Every def also carries the
// remaining CDDA keys verbatim (after unit conversion), hence the index signatures.

/** CDDA color name, e.g. "c_red", "light_gray", "i_yellow". Kept verbatim. */
export type CddaColor = string;

export interface Glyph {
  symbol: string;
  color: CddaColor;
  /** CDDA allows [spring, summer, autumn, winter] arrays; symbol/color hold the spring entry. */
  symbol_seasonal?: string[];
  color_seasonal?: CddaColor[];
}

export interface BashInfo {
  str_min: number;
  str_max: number;
  sound?: string;
  sound_fail?: string;
  ter_set?: string;
  furn_set?: string;
  items?: ItemGroupRef;
  [extra: string]: unknown;
}

export interface DeconstructInfo {
  ter_set?: string;
  furn_set?: string;
  items?: ItemGroupRef;
  [extra: string]: unknown;
}

export interface TerrainDef extends Glyph {
  id: string;
  name: string;
  description?: string;
  move_cost: number; // 0 = impassable
  coverage?: number;
  flags: string[];
  connects_to?: string[];
  connect_groups?: string[];
  rotates_to?: string[];
  open?: string;
  close?: string;
  bash?: BashInfo;
  deconstruct?: DeconstructInfo;
  roof?: string;
  transforms_into?: string;
  light_emitted?: number;
  /** explicit looks_like, else the copy-from parent (for sprite fallback) */
  looks_like?: string;
  examine_action?: unknown;
  harvest_by_season?: unknown;
  [extra: string]: unknown;
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
  examine_action?: unknown;
  crafting_pseudo_item?: string | string[];
  max_volume?: number;
  connects_to?: string[];
  connect_groups?: string[];
  rotates_to?: string[];
  [extra: string]: unknown;
}

export type ItemGroupRef = string | ItemGroupDef;

/**
 * One entry of an item group (doc/JSON/ITEM_SPAWN.md). The extractor folds the legacy
 * "items"/"groups" arrays, "count-min"/"count-max", object-form "container-item" etc. into
 * this single shape. Exactly one of item / group / distribution / collection is set.
 */
export interface ItemGroupEntry {
  item?: string;
  group?: string;
  distribution?: ItemGroupEntry[];
  collection?: ItemGroupEntry[];
  /** default 100. In a collection: percent chance (<= 100). In a distribution: relative weight. */
  prob?: number;
  /** default 1; [min, max] is rolled once per entry */
  count?: number | [number, number];
  /** -1 = default/full; [min, -1] = min up to capacity */
  charges?: number | [number, number];
  damage?: number | [number, number];
  /** each spawned item is put in its own container of this type */
  'container-item'?: string;
  /** all `count` items of this entry go together into one container of this type */
  'entry-wrapper'?: string;
  'container-variant'?: string;
  'container-group'?: string;
  'contents-item'?: string[];
  'contents-group'?: string[];
  'ammo-item'?: string;
  'ammo-group'?: string;
  variant?: string;
  'custom-flags'?: string[];
  sealed?: boolean;
  active?: boolean;
  /** holiday-only entry ("halloween", "christmas", ...) */
  event?: string;
  [extra: string]: unknown;
}

export interface ItemGroupDef {
  id?: string;
  subtype: 'distribution' | 'collection';
  entries: ItemGroupEntry[];
  /** everything the group creates goes into one container of this type */
  'container-item'?: string;
  'container-variant'?: string;
  on_overflow?: string;
  /** percent chance that guns/magazines/tools spawn loaded / with a magazine */
  ammo?: number;
  magazine?: number;
  sealed?: boolean;
}

export interface DamageUnit {
  damage_type: string; // "bash" | "cut" | "stab" | "bullet" | "heat" | ...
  amount: number;
  armor_penetration?: number;
  armor_multiplier?: number;
  [extra: string]: unknown;
}

/** CDDA melee_accuracy object; summed to an integer to_hit (item_factory.cpp melee_accuracy). */
export interface MeleeAccuracy {
  grip?: 'bad' | 'none' | 'solid' | 'weapon';
  length?: 'hand' | 'short' | 'long';
  surface?: 'point' | 'line' | 'any' | 'every';
  balance?: 'clumsy' | 'uneven' | 'neutral' | 'good';
}

/** One entry of CDDA `pocket_data` (item_pocket.cpp). Volumes ml, weights g; lengths in cm like
 *  `longest_side`. */
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
  /** primary subtype (see header): GENERIC, TOOL, COMESTIBLE, ARMOR, GUN, AMMO, MAGAZINE, BOOK, GUNMOD, ... */
  type: string;
  /** CDDA `subtypes`, e.g. ["TOOL", "ARMOR"]; empty for generic items */
  subtypes: string[];
  name: string;
  name_plural: string;
  description?: string;
  /** item category id: explicit, or CDDA's per-subtype fallback (guns, ammo, tools, clothing, food, ...) */
  category: string;
  weight: number; // g
  volume: number; // ml
  longest_side?: number; // cm
  price?: number; // cents
  price_postapoc?: number; // cents
  material: string[];
  /** only present when portions are uneven, e.g. { steel: 3, wood: 1 } */
  material_portions?: Record<string, number>;
  flags: string[];
  looks_like?: string;
  // melee
  /** damage type -> amount, e.g. { bash: 16 } */
  melee_damage?: Record<string, number>;
  /** convenience: melee_damage.bash */
  bashing?: number;
  /** convenience: max(melee_damage.cut, melee_damage.stab) */
  cutting?: number;
  /** computed from CDDA's { grip, length, surface, balance } object; -2 when absent */
  to_hit: number;
  techniques?: string[];
  qualities?: [string, number][];
  use_action?: unknown;
  // comestible
  comestible_type?: string;
  calories?: number;
  quench?: number;
  fun?: number;
  spoils_in?: number; // seconds
  healthy?: number;
  addiction_type?: unknown;
  charges?: number;
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
  // gun / book (both use CDDA's "skill" key)
  skill?: string;
  ranged_damage?: DamageUnit[];
  thrown_damage?: DamageUnit[];
  range?: number;
  dispersion?: number;
  recoil?: number;
  reload?: number;
  modes?: unknown[][];
  // ammo
  /** AMMO: its type; MAGAZINE: list of accepted types. */
  ammo_type?: string | string[];
  /** stack size of one "charge" unit for ammo */
  count?: number;
  damage?: DamageUnit[];
  // book
  required_level?: number;
  max_level?: number;
  time?: number; // seconds to read
  intelligence?: number;
  chapters?: number;
  // containers
  pocket_data?: PocketData[];
  // --- misc fields read by src/game (all optional, CDDA key names) ---
  /** Units per `volume` for count-by-charges items (ammo, liquids). Defaults to charges/count. */
  stack_size?: number;
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
  /** Magazines: moves per round loaded (CDDA default 100). */
  reload_time?: number;
  display_type?: string;
  /** Tools: seconds per charge while active; revert_to when out of charges. */
  turns_per_charge?: number;
  /** Active tools: W (see header; older data may carry "1560 mW" strings). */
  power_draw?: number | string;
  revert_to?: string;
  stim?: number;
  sleepiness_mod?: number;
  max_worn?: number;
  [extra: string]: unknown;
}

/** special_attacks entry; the ["ID", cooldown] shorthand is normalized to { id, cooldown }. */
export interface MonsterAttack {
  id: string;
  type?: string;
  cooldown?: number;
  [k: string]: unknown;
}

export interface MonsterDef extends Glyph {
  id: string;
  name: string;
  name_plural: string;
  description?: string;
  species: string[];
  default_faction: string;
  volume: number; // ml
  weight: number; // g
  hp: number;
  speed: number;
  /** moves per melee attack (default 100) */
  attack_cost: number;
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
  material: string[];
  special_attacks?: MonsterAttack[];
  death_function?: unknown;
  death_drops?: ItemGroupRef;
  harvest?: string;
  flags: string[];
  /** half_life / age_grow are in days, as in CDDA */
  upgrades?: { half_life?: number; into_group?: string; into?: string; age_grow?: number; [k: string]: unknown };
  luminance: number;
  looks_like?: string;
  diff?: number;
  [extra: string]: unknown;
}

export interface MonsterGroupEntry {
  monster?: string;
  group?: string;
  /** relative weight ("freq" in old JSON); default 1 */
  weight: number;
  cost_multiplier?: number;
  pack_size?: [number, number];
  /** game seconds since the cataclysm */
  starts?: number;
  ends?: number;
  conditions?: string[];
  event?: string;
  [k: string]: unknown;
}

export interface MonsterGroupDef {
  id: string;
  /** explicit default, else the highest-weight monster entry (as CDDA computes it) */
  default?: string;
  is_animal?: boolean;
  monsters: MonsterGroupEntry[];
  [k: string]: unknown;
}

/**
 * Component or tool alternative. For tools, count > 0 is charges consumed and -1 means
 * "must be present". Recipes/constructions arrive with LIST references already inlined.
 */
export interface RecipeComponent {
  id: string;
  count: number;
  /** true when id refers to a requirement list (CDDA "LIST"); never set after expansion */
  list?: boolean;
  /** component is not returned on disassembly */
  no_recover?: boolean;
}

export interface QualityRequirement {
  id: string;
  level: number;
  /** number of tools needed with this quality (default 1) */
  amount?: number;
}

/** Outer array: all required (AND). Inner array: alternatives (OR). */
export interface RequirementData {
  components: RecipeComponent[][];
  tools: RecipeComponent[][];
  qualities: QualityRequirement[][];
}

export interface RecipeStep {
  name: string;
  time: number; // seconds
  activity_level?: string;
  tools: RecipeComponent[][];
  qualities: QualityRequirement[][];
  proficiencies?: unknown[];
  [k: string]: unknown;
}

/**
 * Normalized recipe (also the shape of misc.uncraft and misc.practice entries). `using`
 * references and LIST entries are expanded into components/tools/qualities.
 */
export interface RecipeDef extends RequirementData {
  /** CDDA recipe id: result [+ "_" + variant] [+ "_" + id_suffix] */
  id: string;
  type?: string;
  result: string;
  id_suffix?: string;
  variant?: string;
  category: string;
  subcategory?: string;
  skill_used?: string;
  difficulty: number;
  skills_required?: [string, number][];
  /** seconds; for step recipes, the sum of the step times */
  time: number;
  activity_level?: string;
  book_learn?: unknown;
  autolearn?: boolean | [string, number][];
  /** step recipes: per-step time/tools/qualities; top-level tools/qualities hold the union */
  steps?: RecipeStep[];
  byproducts?: [string, number][];
  byproduct_group?: ItemGroupRef;
  result_mult?: number;
  charges?: number;
  batch_time_factors?: [number, number];
  flags?: string[];
  proficiencies?: unknown[];
  reversible?: boolean | { time: number };
  never_learn?: boolean;
  [k: string]: unknown;
}

export interface GameData {
  terrain: Record<string, TerrainDef>;
  furniture: Record<string, FurnitureDef>;
  items: Record<string, ItemDef>;
  itemGroups: Record<string, ItemGroupDef>;
  monsters: Record<string, MonsterDef>;
  monsterGroups: Record<string, MonsterGroupDef>;
  recipes: RecipeDef[];
  /**
   * Everything else keyed by misc type then id (materials, professions, effects, ...).
   * Keys are CDDA types, lower-cased where CDDA shouts (ITEM_CATEGORY -> item_category,
   * MONSTER_FACTION -> monster_faction, SPECIES -> species, SPELL -> spell,
   * MIGRATION -> item_migration). Special shapes:
   *   snippet: category -> string[];  speech: monster id -> {sound, volume}[];
   *   dream: mutation category -> {messages, strength}[];  requirement: RequirementData;
   *   uncraft / practice: RecipeDef;  construction: requirements expanded like recipes;
   *   profession.items.{both,male,female}: ItemGroupDef (collection).
   */
  misc: Record<string, Record<string, any>>;
}

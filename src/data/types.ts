// Normalized Cataclysm: Bright Nights content as emitted by tools/extract into
// public/data/*.json. The extractor resolves copy-from/extend/delete/relative/proportional
// with BN's rules and normalizes units, so runtime code never parses "250 ml" or "30 m".
// docs/BN_DATA_MODEL.md explains the item/container/magazine/armor model and the BN
// carrying rules; read it before touching inventory code.
//
// Units convention (everywhere in this codebase):
//   volume: ml, weight: g, duration: game seconds, energy: kJ, power: W, money: cents,
//   temperature: celsius, sound: dB. Map distances are tiles (1 tile == 1 m).
//   BN legacy integers are converted by the extractor: item volumes given as bare ints are
//   250 ml steps, recipe times are moves (100 per second), book times minutes, ...
//
// Items keep BN's per-kind `type` (GENERIC, TOOL, ARMOR, TOOL_ARMOR, CONTAINER, ...);
// `subtypes` lists the item "slots" (C++ islot_*) the type has, including ones inherited
// through copy-from and ones added by slot objects like "armor_data". Test for behaviour
// with `subtypes`, not `type`.
//
// Fields are optional unless BN always has them. Extend these interfaces freely, but keep
// names equal to the BN JSON key (snake_case preserved) so BN's C++ loaders
// (~/code/Cataclysm-BN/src/item_factory.cpp etc.) stay the reference. Every def also
// carries the remaining BN keys verbatim (after unit conversion), hence the index
// signatures.

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
 * One entry of a BN item group (item_factory.cpp add_entry). The extractor folds the
 * legacy "items"/"groups" arrays and "count-min"/"count-max" into this single shape.
 * Exactly one of item / group / distribution / collection is set.
 */
export interface ItemGroupEntry {
  item?: string;
  group?: string;
  distribution?: ItemGroupEntry[];
  collection?: ItemGroupEntry[];
  /** default 100. In a collection: percent chance (<= 100). In a distribution: relative weight. */
  prob?: number;
  /** default 1; [min, max] is rolled once per entry and repeats the item/group */
  count?: number | [number, number];
  /** absent = item default. -1 on either side means "as much as fits" (Item_modifier::modify) */
  charges?: number | [number, number];
  /** damage level rolled per item (x1000 in the C++ damage scale) */
  damage?: number | [number, number];
  /** gun dirt (default 0..500 when an entry has modifiers) */
  dirt?: number | [number, number];
  /** each created item is put into its own one of these (else its default "container") */
  'container-item'?: string;
  'container-group'?: string;
  /** created and put inside each created item (after the container is applied) */
  'contents-item'?: string[];
  'contents-group'?: string[];
  /** ammo type loaded into guns/magazines/tools when charges are set or ammo is rolled */
  'ammo-item'?: string;
  'ammo-group'?: string;
  'custom-flags'?: string[];
  /** item is activated after creation */
  active?: boolean;
  /** profession legacy [id, snippet] items: the snippet id for the item's description */
  snippet?: string;
  [extra: string]: unknown;
}

export interface ItemGroupDef {
  id?: string;
  subtype: 'distribution' | 'collection';
  entries: ItemGroupEntry[];
  /** percent chance that guns/tools/magazines this group makes spawn loaded (inherited by entries) */
  ammo?: number;
  /** percent chance that guns/tools spawn with their default magazine */
  magazine?: number;
}

export interface DamageUnit {
  damage_type: string; // "bash" | "cut" | "stab" | "bullet" | "heat" | "acid" | "cold" | "electric" | ...
  amount: number;
  armor_penetration?: number;
  armor_multiplier?: number;
  damage_multiplier?: number;
  [extra: string]: unknown;
}

/** @deprecated DDA melee_accuracy object; BN's to_hit is a plain int. Kept for old callers. */
export interface MeleeAccuracy {
  grip?: 'bad' | 'none' | 'solid' | 'weapon';
  length?: 'hand' | 'short' | 'long';
  surface?: 'point' | 'line' | 'any' | 'every';
  balance?: 'clumsy' | 'uneven' | 'neutral' | 'good';
}

/**
 * @deprecated DDA `pocket_data`. BN has no pockets; the extractor no longer emits this.
 * src/data/bncompat.ts derives an approximation from the BN model so the DDA-era inventory
 * keeps running until it is rewritten (TODO(BN inventory)). New code must not use it.
 */
export interface PocketData {
  pocket_type?: 'CONTAINER' | 'MAGAZINE' | 'MAGAZINE_WELL' | 'MOD' | 'CORPSE' | 'SOFTWARE' | 'EBOOK' | 'CABLE' | 'E_FILE_STORAGE';
  ememory_max?: number;
  forbidden?: boolean;
  max_contains_volume?: number;
  max_contains_weight?: number;
  max_item_volume?: number;
  min_item_volume?: number;
  max_item_length?: number;
  min_item_length?: number;
  ammo_restriction?: Record<string, number>;
  item_restriction?: string[];
  flag_restriction?: string[];
  magazine_well?: number;
  default_magazine?: string;
  watertight?: boolean;
  airtight?: boolean;
  rigid?: boolean;
  holster?: boolean;
  open_container?: boolean;
  transparent?: boolean;
  moves?: number;
  sealed_data?: { spoil_multiplier?: number };
  spoil_multiplier?: number;
  weight_multiplier?: number;
  volume_multiplier?: number;
  extra_encumbrance?: number;
  ripoff?: number;
  description?: string;
}

/**
 * One armor portion (BN armor_portion_data, or the legacy top-level covers/coverage/
 * encumbrance/max_encumbrance folded into a single portion).
 */
export interface ArmorPortion {
  /** body part ids ("torso", "arm_l", ...); "arms"/"arm_either" etc. are expanded */
  covers: string[];
  /** percent of hits on the covered parts that hit this item */
  coverage: number;
  /** encumbrance when empty */
  encumbrance: number;
  /**
   * encumbrance when the item's storage is full (item::get_encumber_when_containing). For
   * non-rigid items encumbrance rises linearly from `encumbrance` to this with contents;
   * 0 means "+1 per 500 ml carried".
   */
  max_encumbrance: number;
  /** @deprecated DDA per-portion fields; never emitted for BN */
  specifically_covers?: string[];
  cover_melee?: number;
  cover_ranged?: number;
  cover_vitals?: number;
  material?: { type: string; covered_by_mat?: number; thickness?: number }[];
  layers?: string[];
}

/**
 * BN islot_container (itype.h): an item that holds ONE stack of ONE item type (a bottle of
 * water, a can of beans, a box of nails). From type "CONTAINER" or a "container_data" object.
 */
export interface ContainerData {
  /** inner volume, ml */
  contains: number;
  /** can be resealed (only sealed containers keep liquids when carried; see BN_DATA_MODEL.md) */
  seals: boolean;
  /** can hold liquids */
  watertight: boolean;
  /** contents do not spoil */
  preserves: boolean;
  /** changing the contents turns the container into this item (opening a can) */
  unseals_into?: string;
}

/** BN islot_magazine: a detachable magazine (or ammo belt / speedloader). */
export interface MagazineData {
  /** accepted ammunition_type ids */
  ammo_type: string[];
  /** rounds it holds */
  capacity: number;
  /** rounds of default_ammo it spawns with (belts) */
  count: number;
  /** default ammo item id (explicit, else the first ammo_type's default; filled by the extractor) */
  default_ammo?: string;
  /** 0..10 */
  reliability: number;
  /** moves per round loaded */
  reload_time: number;
  /** ammo belts drop one of these per round fired */
  linkage?: string;
  /** another magazine this one reloads like */
  reloads_like?: string;
}

/** use_action "holster" (holster_actor::load): sheaths, holsters, quivers, tool belts. */
export interface HolsterData {
  max_volume: number;
  /** default max_volume / 3 */
  min_volume: number;
  /** g; -1 = no limit */
  max_weight: number;
  /** how many items it holds */
  multi: number;
  draw_cost: number;
  /** item flags it accepts (any) */
  flags: string[];
  /** gun skills it accepts (any) */
  skills: string[];
}

/** use_action "bandolier" (bandolier_actor): rounds of the listed ammo types, loose. */
export interface BandolierData {
  capacity: number;
  ammo: string[];
  draw_cost: number;
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
  /** BN effect_type "permanent": instances never lose duration. */
  permanent?: boolean;
  [extra: string]: unknown;
}

export interface EnchantmentValue {
  value: string;
  add?: number;
  multiply?: number;
  /** BN enchantment "max" (added on top for can_max values like LUMINATION). */
  max?: number;
}

/** BN enchantment object (enchantment.cpp load): `conditions` ids all hold → values apply. */
export interface EnchantmentDef {
  id?: string;
  values?: EnchantmentValue[];
  conditions?: string[];
  /** Legacy single condition ("has"/"condition" keys). */
  condition?: unknown;
  flags?: string[];
  [extra: string]: unknown;
}

/** CDDA mutation/trait. Only a few fields are interpreted (see character.ts traitMod). */
export interface MutationDef {
  id: string;
  name?: string | { str: string };
  description?: string;
  points?: number;
  starting_trait?: boolean;
  /** BN: ids of standalone `enchantment` objects (or inline objects in fallbacks). */
  enchantments?: (EnchantmentDef | string)[];
  /** BN inline enchantments (mutation_data.cpp "mut_enchantments"). */
  mut_enchantments?: EnchantmentDef[];
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

/**
 * Normalized BN item type (itype). Keys are BN JSON keys; slot objects (armor_data,
 * gun_data, book_data, ammo_data, gunmod_data, bionic_data, pet_armor_data) are flattened
 * onto the item. The container/magazine/armor parts are normalized (see ContainerData,
 * MagazineData, ArmorPortion); docs/BN_DATA_MODEL.md explains how they fit together.
 */
export interface ItemDef extends Glyph {
  id: string;
  /** BN JSON type, verbatim: GENERIC TOOL COMESTIBLE ARMOR TOOL_ARMOR PET_ARMOR GUN GUNMOD
   *  AMMO MAGAZINE BOOK CONTAINER BIONIC_ITEM TOOLMOD ENGINE WHEEL FUEL BATTERY */
  type: string;
  /**
   * Item slots (C++ islot_*) this item has, sorted: TOOL ARMOR PET_ARMOR GUN GUNMOD TOOLMOD
   * AMMO MAGAZINE COMESTIBLE BOOK CONTAINER BIONIC_ITEM ENGINE WHEEL FUEL BATTERY SEED
   * BREWABLE ARTIFACT RELIC MILLING. Includes slots inherited through copy-from. Empty for
   * plain GENERIC items. Use this (not `type`) to test what an item can do.
   */
  subtypes: string[];
  name: string;
  name_plural: string;
  description?: string;
  /** item category id: explicit, or BN calc_category (guns, magazines, ammo, tools, clothing, food, drugs, books, mods, bionics, weapons, other) */
  category: string;
  /** g, for one item (count_by_charges: for one charge... see `volume`) */
  weight: number;
  /**
   * ml, >= 1. For count_by_charges items this is the volume of `stack_size` charges
   * (item::volume: ceil(charges * volume / stack_size)).
   */
  volume: number;
  /** volume/weight when installed as a gunmod/toolmod (default volume/weight) */
  integral_volume: number;
  integral_weight: number;
  price: number; // cents
  /** cents; defaults to price */
  price_postapoc: number;
  material: string[];
  flags: string[];
  /** LIGHT_<n> flags become this (finalize_pre) */
  light_emission?: number;
  looks_like?: string;
  /** "stackable": true makes a non-ammo/non-food item count by charges */
  stackable: boolean;
  /** itype::count_by_charges: stackable, AMMO or COMESTIBLE. Such an item is one stack with `charges`. */
  count_by_charges: boolean;
  /** count_by_charges only: charges per `volume` (default = the default charges, max 200) */
  stack_size?: number;
  /**
   * false = soft item whose volume grows by its contents' volume (item::volume) and, if
   * worn, whose encumbrance grows toward max_encumbrance as the carried volume grows.
   */
  rigid: boolean;
  phase: 'solid' | 'liquid' | 'gas' | 'plasma';
  /** default container id this item spawns/crafts in (water -> bottle_plastic) */
  container?: string;
  /** present when the item is a container (type CONTAINER or a container_data object) */
  container_data?: ContainerData;

  // --- melee (BN "bashing"/"cutting" ints; the STAB flag makes cutting a stab)
  bashing: number;
  cutting: number;
  /** derived: { bash: bashing, cut|stab: cutting }, positive entries only */
  melee_damage: Record<string, number>;
  /** BN int to_hit (default 0) */
  to_hit: number;
  /** default: bash = bashing + weight in kg */
  thrown_damage?: DamageUnit[];
  techniques?: string[];
  /** [quality id, level] */
  qualities: [string, number][];
  /** verbatim: a string, an object or an array of both */
  use_action?: unknown;
  /** derived from a "holster" use_action */
  holster?: HolsterData;
  /** derived from a "bandolier" use_action */
  bandolier?: BandolierData;
  min_strength?: number;
  min_skills?: [string, number][];

  // --- worn (ARMOR slot)
  /** one or more portions; empty covers = worn on no body part (e.g. some belts) */
  armor?: ArmorPortion[];
  /** covers used an "_either" form: worn on one side, may be switched */
  sided?: boolean;
  /** clothing layer from flags (finalize_pre) */
  layer?: 'PERSONAL' | 'UNDERWEAR' | 'REGULAR' | 'WAIST' | 'OUTER' | 'BELTED' | 'AURA';
  /** ml of carrying capacity this item gives when worn (armor/pet armor "storage") */
  storage?: number;
  material_thickness?: number;
  environmental_protection?: number;
  warmth?: number;
  /** worn: multiplies the wearer's weight capacity */
  weight_capacity_modifier?: number;
  /** worn: g added to the wearer's weight capacity */
  weight_capacity_bonus?: number;

  // --- charges, ammo and magazines
  /**
   * GUN/TOOL: ammunition_type ids it uses. Ammo sits either in an integral magazine
   * (GUN clip_size / TOOL max_charges > 0, stored as item charges) or in a detachable
   * magazine from `magazines`.
   */
  ammo?: string[];
  /** TOOL: integral capacity (0 = uses magazines or no ammo) */
  max_charges?: number;
  initial_charges?: number;
  charges_per_use?: number;
  turns_per_charge?: number;
  power_draw?: number;
  revert_to?: string;
  /** GUN: integral magazine capacity (0 = detachable magazines) */
  clip_size?: number;
  /** GUN: moves to reload */
  reload?: number;
  /** ammo type -> compatible magazine item ids */
  magazines?: Record<string, string[]>;
  /** ammo type -> default magazine (the first listed) */
  magazine_default?: Record<string, string>;
  /** ml of an inserted magazine's volume that disappears into the item (item::volume) */
  magazine_well: number;
  /** present on MAGAZINE items */
  magazine?: MagazineData;
  /** AMMO: its ammunition_type id; MAGAZINE: the accepted types (same as magazine.ammo_type) */
  ammo_type?: string | string[];
  /** AMMO: default stack size ("count", def_charges) */
  count?: number;
  /** AMMO: dB; derived from range and damage when unset (finalize_pre) */
  loudness?: number;
  damage?: DamageUnit[];
  range?: number;
  dispersion?: number;
  recoil?: number;
  casing?: string;
  effects?: string[];

  // --- guns / gunmods
  skill?: string;
  ranged_damage?: DamageUnit[];
  handling?: number;
  sight_dispersion?: number;
  /** ml ("barrel_length" is BN's deprecated alias and is folded in) */
  barrel_volume?: number;
  /** [id, name, shots, flags?]; DEFAULT always present, legacy "burst" adds AUTO */
  modes?: unknown[][];
  valid_mod_locations?: [string, number][];
  built_in_mods?: string[];
  default_mods?: string[];
  ups_charges?: number;
  location?: string;
  mod_targets?: string[];
  damage_modifier?: DamageUnit[];

  // --- comestibles
  comestible_type?: string;
  /** default charges of a food/drug stack */
  charges?: number;
  calories?: number;
  quench?: number;
  fun?: number;
  healthy?: number;
  /** seconds (BN ints are hours) */
  spoils_in?: number;
  stim?: number;
  fatigue_mod?: number;
  addiction_type?: unknown;
  addiction_potential?: number;
  vitamins?: [string, number][];

  // --- books
  required_level?: number;
  max_level?: number;
  /** seconds per chapter-ish reading session (BN int minutes, converted) */
  time?: number;
  intelligence?: number;
  chapters?: number;
  martial_art?: string;

  // --- bionics
  /** BIONIC_ITEM: installed bionic id ("bionic_id", else the item id) */
  bionic_id?: string;
  difficulty?: number;

  /** @deprecated DDA; never emitted for BN. See src/data/bncompat.ts. */
  pocket_data?: PocketData[];
  /** @deprecated DDA; never emitted for BN (no length in BN) */
  longest_side?: number;
  /** @deprecated DDA; never emitted for BN */
  material_portions?: Record<string, number>;
  /** @deprecated DDA; BN has no item variants */
  variants?: unknown;
  /** @deprecated DDA flag-style field */
  sealed?: boolean;
  /** @deprecated DDA; BN has "stackable" + count_by_charges */
  display_type?: string;
  /** @deprecated DDA gun/magazine fields read by old code; BN uses magazine.reload_time */
  reload_time?: number;
  sleepiness_mod?: number;
  max_worn?: number;
  encumbrance?: number;
  [extra: string]: unknown;
}

/** special_attacks entry; the ["ID", cooldown] shorthand is normalized to { id, cooldown }. */
export interface MonsterAttack {
  id: string;
  /** "monster_attack" (a named C++ attack; id is the name) or an actor type: leap, melee, bite, gun, spell, ... */
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
  /** includes the legacy "melee_cut" bonus as a cut unit */
  melee_damage?: DamageUnit[];
  dodge: number;
  /** damage type -> armor, from BN armor_bash/armor_cut/... (stab/acid default from cut) */
  armor: Record<string, number>;
  vision_day: number;
  vision_night: number;
  material: string[];
  special_attacks?: MonsterAttack[];
  /** named mdeath functions, ["NORMAL"] by default */
  death_function?: string[];
  death_drops?: ItemGroupRef;
  /** @deprecated DDA-only dissect harvest; BN has none (never emitted) */
  dissect?: string;
  /** harvest id (default "human") */
  harvest?: string;
  /** own flags plus every species' flags (apply_species_attributes) */
  flags: string[];
  /** half_life / age_grow are in days */
  upgrades?: { half_life?: number; into_group?: string; into?: string; age_grow?: number; [k: string]: unknown };
  luminance: number;
  /** intensity added to the target's "grabbed" effect by GRAB (BN default 1) */
  grab_strength?: number;
  looks_like?: string;
  diff?: number;
  [extra: string]: unknown;
}

export interface MonsterGroupEntry {
  monster: string;
  /** BN "freq": out of the group's freq_total */
  weight: number;
  cost_multiplier: number;
  pack_size?: [number, number];
  /** game seconds since the cataclysm (BN JSON is hours) */
  starts?: number;
  ends?: number;
  /** DAY NIGHT DUSK DAWN SPRING SUMMER AUTUMN WINTER */
  conditions?: string[];
  [k: string]: unknown;
}

export interface MonsterGroupDef {
  id: string;
  /** returned when the roll picks no entry (BN requires it) */
  default: string;
  is_animal: boolean;
  /** roll range: rng(1, freq_total); default 1000 */
  freq_total: number;
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
 * Normalized BN recipe (also the shape of misc.uncraft entries). `using` references and
 * LIST entries are expanded into components/tools/qualities.
 */
export interface RecipeDef extends RequirementData {
  /** BN recipe id: result [+ "_" + id_suffix] */
  id: string;
  type: 'recipe' | 'uncraft';
  result: string;
  id_suffix?: string;
  category: string;
  subcategory?: string;
  skill_used?: string;
  difficulty: number;
  skills_required?: [string, number][];
  /** seconds (BN int moves / 100, or the duration string) */
  time: number;
  /** false, or the skill levels that autolearn it (true is expanded like recipe::finalize) */
  autolearn: false | [string, number][];
  /** [book id, level]; -1 = "use the recipe difficulty" */
  book_learn?: [string, number][];
  /** skills whose levels let you learn it by disassembling */
  decomp_learn?: [string, number][];
  byproducts?: [string, number][];
  result_mult: number;
  /** result spawns inside `container` (else its default container) */
  contained: boolean;
  container?: string;
  charges?: number;
  batch_time_factors?: [number, number];
  flags?: string[];
  /** uncraft: always true. (The DDA "{time}" object form never appears in BN.) */
  reversible?: boolean | { time: number };
  never_learn?: boolean;
  /** @deprecated DDA-only; never emitted for BN */
  steps?: RecipeStep[];
  /** @deprecated DDA-only; never emitted for BN */
  byproduct_group?: ItemGroupRef;
  /** @deprecated DDA-only (BN has no proficiencies); never emitted */
  proficiencies?: unknown[];
  /** @deprecated DDA-only; never emitted */
  variant?: string;
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
   * Keys are BN types, lower-cased where BN shouts (ITEM_CATEGORY -> item_category,
   * MONSTER_FACTION -> monster_faction, SPECIES -> species, SPELL -> spell,
   * MIGRATION -> item_migration). Special shapes:
   *   snippet: category -> string[];  speech: monster id -> {sound, volume}[];
   *   dream: mutation category -> {messages, strength}[];  requirement: RequirementData;
   *   uncraft: RecipeDef;  construction: requirements expanded like recipes;
   *   profession.items.{both,male,female}: ItemGroupDef (collection);
   *   profession_item_substitutions: "item:<id>" / "trait:<id>" -> subs, "bonus:<n>" -> {group, bonus}.
   */
  misc: Record<string, Record<string, any>>;
}

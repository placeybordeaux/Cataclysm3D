# Bright Nights data model

How `public/data/*.json` describes Cataclysm: Bright Nights (BN) content after
`npm run extract`, and what the runtime must do with it. The types are in
`src/data/types.ts`. The reference is BN's C++ in `~/code/Cataclysm-BN/src` (the checkout
ships no JSON docs); file and function names below point into it.

Status: the core data (terrain, furniture, items, item groups, monsters, monster groups,
recipes, misc) is BN. The item/inventory runtime (`src/game/item.ts`, `inventory.ts`) is
still the DDA pocket model, kept alive by `src/data/bncompat.ts` (TODO(BN inventory)).
Gameplay tests that encode DDA behaviour are `it.skip`ped with `TODO(BN)` notes
(`grep -rn "TODO(BN)" tests`).

## 1. Pipeline and loader API

`tools/extract/cdda.ts` is shared by every extractor. Stable exports:

| export | what |
| --- | --- |
| `defaultCddaDir()` | `$CDDA_DIR`, else `~/code/Cataclysm-BN` |
| `loadCddaObjects(dir, {types, excludeTypes})` | raw objects of `data/json` grouped by `type`, sorted load order |
| `resolveFamily(objs, hooks, prepare)` | copy-from resolution → `{byId, abstracts, duplicates, aliases, warnings}` |
| `loadResolved(types, dir)` | load + prepare + resolve; family names (`"ITEM"`) expand to all their types |
| `FAMILY_HOOKS`, `familyOf`, `familyTypes`, `ITEM_TYPES`, `objectIds`, `objectAliases` | family rules |
| `APPENDING_FAMILIES` | `item_group`, `monstergroup`: no copy-from in BN, use `mergeItemGroups` / `normalizeMonsterGroups` |

Inheritance, as the C++ does it:

- **Precedence differs by reader.** Items (and every member read with `assign()`,
  assign.h) take `relative`, else `proportional`, else the explicit value — a modifier wins
  over an explicit value in the same object. `generic_factory` types (`optional()`) take the
  explicit value, else `proportional`, else `relative`. Exactly one applies, and modifiers act
  on the *inherited* value. Hook: `modifierFirst` (set for `ITEM`).
- `proportional` is a double product truncated at the internal unit (int members, ml,
  cents, mg): `280 cent × 0.7 = 196`, `1500 × 0.76 = 1140`. (DDA used a 32-bit float.)
- `extend`/`delete` act on sets (flags, …). Qualities behave like the C++ map: extending an
  existing id replaces its level; delete removes only an exact `[id, level]` match. `extend`
  on a true scalar (`"harvest"`) is ignored, as in BN.
- Items: a copy-from keeps the parent's *slots* (a GENERIC copied from a TOOL is a tool).
  `looks_like` defaults to the copy-from id (abstract parents excluded, they have no sprite).
  Legacy armor fields on a child edit portion 0 of an inherited `armor_portion_data`.
- Terrain/furniture: `open`/`close`/`roof`/`transforms_into` ARE inherited (DDA reset them);
  `bash` merges field-wise; `deconstruct`/`pry` replace; `hacksaw`/`oxytorch`/`boltcut` are
  never inherited.
- generic_factory `"alias"` ids map to the same object (`t_wall_h` → `t_wall`); output files
  contain the alias keys too. The legacy `"ident"` id is accepted.
- A self-copy-from with no earlier definition is discarded with a warning (BN reports
  "circular dependency, this object is discarded").
- Recipes: id = `result` + `_` + `id_suffix`; inline `components/tools/qualities` never
  inherit, `using` does. No recipe variants.
- Item groups: no copy-from; a repeated id **appends** entries (same subtype required),
  `"purge": true` resets, `"delete": [{item}|{group}]` removes the first direct match.
- Monster groups: keyed by `"name"`; a repeated name **extends** unless `"override": true`.

## 2. Units

Base units everywhere: ml, g, game seconds, kJ, cents, °C, dB. BN strings (`"250 ml"`,
`"2 USD 50 cent"`, `"10 days 19 hours"`, `"40 dB"`) are converted. BN *legacy integers* in
non-base units are converted by `prepare.ts` (also inside `relative`, never inside
`proportional`):

| member | BN int unit | C++ |
| --- | --- | --- |
| item `volume`, `integral_volume`, `storage`, `magazine_well`, `barrel_volume`, `contains`, pet vol | 250 ml steps | `assign(units::volume)`, `legacy_volume_factor` |
| furniture `keg_capacity`, terrain `max_volume` | 250 ml steps | `legacy_volume_reader`, assign |
| comestible `spoils_in` | hours | `assign(..., 1_hours)` |
| book `time` | minutes | `load(islot_book&)` |
| gunmod `install_time`, recipe/uncraft `time` | moves (100/s) | `to_moves` |
| seed `grow` | days | `assign(..., 1_days)` |
| monster group entry `starts`/`ends` | hours | `LoadMonsterGroup` |

Mass ints are grams, money ints cents, energy ints kJ — already base units. Gun `reload`,
magazine `reload_time` and monster `attack_cost` stay in moves (they are per-action costs).

## 3. The item model (`ItemDef`)

`type` is BN's JSON type verbatim (GENERIC TOOL COMESTIBLE ARMOR TOOL_ARMOR PET_ARMOR GUN
GUNMOD AMMO MAGAZINE BOOK CONTAINER BIONIC_ITEM TOOLMOD ENGINE WHEEL FUEL BATTERY). Ask what
an item *can do* with `subtypes`: the sorted list of C++ slots (`TOOL`, `ARMOR`, `GUN`,
`AMMO`, `MAGAZINE`, `COMESTIBLE`, `BOOK`, `CONTAINER`, `BIONIC_ITEM`, `GUNMOD`, `TOOLMOD`,
`PET_ARMOR`, `SEED`, `BREWABLE`, `FUEL`, …), including inherited ones and those added by
slot objects (`armor_data`, `gun_data`, `ammo_data`, `book_data`, `container_data`, …). Slot
objects are flattened onto the item (the slot object wins over a flat member, like
`load_basic_info` which reads them last). Water is `COMESTIBLE` with subtypes
`["AMMO", "COMESTIBLE"]`.

Always present: `weight` (g), `volume` (ml, ≥ 1), `integral_volume/weight`, `price`,
`price_postapoc`, `material[]`, `flags[]`, `category` (explicit if it exists, else
`calc_category`), `to_hit` (int), `bashing`, `cutting` (+ derived `melee_damage`),
`qualities` (`[id, level][]`), `stackable`, `count_by_charges`, `rigid`, `phase`,
`magazine_well`, `thrown_damage` (default: bash = bashing + weight in kg).

### Stacks and charges

`count_by_charges` = `stackable || AMMO || COMESTIBLE` (itype::count_by_charges; note *all*
comestibles, solid food too — DDA only counted non-solids). Such an item is one stack whose
`charges` is the count. `stack_size` = charges per `volume` (default: the default charges —
comestible `charges` (1), ammo `count`, tool `initial_charges`; max 200). Volume of a stack:
`ceil(charges × volume / stack_size)` (item::volume); weight: `weight × charges`.
`chargesPerVolume(def, ml)` (src/data/itemgroups.ts) is item::charges_per_volume.

### Containers — `container_data`

```ts
container_data?: { contains: number /* ml */; seals: boolean; watertight: boolean; preserves: boolean; unseals_into?: string }
```

From type `CONTAINER` (flat members) or a `container_data` object on any type. BN rules
(item.cpp):

- A container holds **one stack of one item type** (`contents.front()`); "You can't mix loads".
- Liquids need `watertight`. Carried liquids need a container that `seals`; an unsealable
  watertight container is a *bucket* (`is_bucket`: watertight, !seals, no `unseals_into`) and
  only holds liquid on the ground or wielded (`get_remaining_capacity_for_liquid(allow_bucket)`).
- Capacity: `charges_per_volume(contains)` of the content. Non-rigid containers you carry can
  only grow into your free carrying volume.
- `preserves`: contents do not rot. `unseals_into`: any change to the contents turns the
  container into that item (opening a can).
- Only sealing containers are reloadable (filled via reload); `can_contain` otherwise only
  checks the liquid/watertight rule.
- Default containers: `container` (item id). Item groups and crafting put items into it
  (`item::in_its_container`), liquids filled to capacity.

### Worn storage — `storage`

There are no pockets. Every worn item with `storage` (armor and pet armor, ml; clothing
mods add 250 ml per level) adds to **one pool**. What you carry that is not worn or wielded
is a flat inventory that must fit the pool. See §4.

### Armor — `armor`, `layer`, `sided`

`armor: { covers: bodypart[], coverage, encumbrance, max_encumbrance }[]` — BN
`armor_portion_data` or the legacy top-level `covers/coverage/encumbrance/max_encumbrance`.
Covers are body part ids; `arms`/`hands`/`legs`/`feet` expand to both sides and the
`*_either` forms also set `sided` (worn on one side, switchable). `layer` comes from flags
(PERSONAL, SKINTIGHT→UNDERWEAR, WAIST, OUTER, BELTED, AURA, else REGULAR). Also
`material_thickness`, `environmental_protection`, `warmth`, `storage`,
`weight_capacity_modifier`, `weight_capacity_bonus`, `valid_mods`.

Encumbrance (item::get_encumber / get_encumber_when_containing): a portion's `encumbrance`,
plus for *non-rigid* items (`rigid: false`, or any portion with `encumbrance !=
max_encumbrance`) a share of the carried volume: the worn item's `storage × (carried volume −
rigid storage) / non-rigid storage` of "contents", then `+ (max − enc) × contents / capacity`
(or `+1 per 500 ml` when `max_encumbrance` is 0). FIT+VARSIZE halves (min −10); wrong size
×2 / ×3.

### Holsters, sheaths, quivers, bandoliers

Still `use_action`s in BN; exposed as data:
`holster: {max_volume, min_volume (default max/3), max_weight (-1 = none), multi, draw_cost,
flags[], skills[]}` — holds up to `multi` items whose volume is in range, that are not
active, that have one of `flags` or whose gun skill is in `skills` (holster_actor::can_holster).
`bandolier: {capacity, ammo[], draw_cost}` — loose rounds of those ammo types. Their contents
live in the item (`item_contents`), so a *worn* holster's pistol does not use carrying volume.

### Guns, tools, magazines, ammo

- `ammo: string[]` — ammunition types a GUN or TOOL uses (`ammo_types`).
- **Integral magazine**: GUN `clip_size > 0` or TOOL `max_charges > 0` with no default
  magazine (`item::magazine_integral`). The rounds are the item's `charges` of one ammo item
  type (`ammo_current`).
- **Detachable magazine**: `magazines: {ammoType: itemId[]}`, `magazine_default: {ammoType:
  itemId}` (first listed). One magazine is inserted *into* the item (`magazine_current`);
  `magazine_well` ml of its volume disappears into the item (volume += max(mag − well, 0)).
- `magazine: {ammo_type[], capacity, count, default_ammo, reliability, reload_time, linkage?,
  reloads_like?}` on MAGAZINE items; rounds are an ammo item inside it. `default_ammo` is
  filled from the ammunition type's default. `count > 0` = spawns loaded (belts).
- AMMO: `ammo_type` (one id), `count` (default stack), `damage[]`, `range`, `dispersion`,
  `recoil`, `loudness` (dB, derived when unset), `casing`, `effects`.
- `ammoCapacity`, `defaultAmmo` in src/data/itemgroups.ts mirror item::ammo_capacity /
  ammo_default for fresh items. Gunmods/toolmods sit in the item's contents too
  (`capacity_multiplier`, `magazine_adaptor`, `ammo_modifier` change the above).
- Guns: `skill`, `ranged_damage[]`, `dispersion`, `recoil`, `handling`, `reload` (moves),
  `barrel_volume` (ml; BN's `barrel_length` alias is folded in), `modes` (`[id, name,
  shots, flags?]`, DEFAULT always present), `valid_mod_locations`, `built_in_mods`,
  `default_mods`, `ups_charges`.

### Comestibles, books, bionics

Comestibles: `comestible_type`, `charges` (default 1), `calories` (from legacy `nutrition` ×
2500/288), `quench`, `fun`, `healthy`, `spoils_in` (s), `stim`, `fatigue_mod`, `addiction_type`,
`addiction_potential`, `vitamins`, `tool` (needed to consume), `cooks_like`, `rot_spawn`,
`brewable`, `seed_data`. Books: `skill`, `required_level`, `max_level`, `intelligence`, `time`
(s), `fun`, `chapters`, `martial_art` (legacy `manual_<x>` → `style_<x>`). BIONIC_ITEM:
`bionic_id` (explicit, else the item id), `difficulty`.

## 4. Carrying rules (BN)

| rule | BN C++ |
| --- | --- |
| Volume capacity = Σ worn items' `storage` (item::get_storage) × `packmule_modifier` mutations + CARRY_STORAGE enchantments | `Character::volume_capacity_reduced_by` |
| Carried volume = Σ volume of inventory items; **worn and wielded items do not count** | `Character::volume_carried` → `inventory::volume` |
| Can pick up if carried + item volume ≤ capacity | `Character::can_pick_volume` |
| Weight capacity = 13 kg (÷4 tiny, ÷2 small, ×2 large, ×4 huge) + Str × 4 kg, × `weight_capacity_modifier` mutations + CARRY_WEIGHT enchantment, × every worn item's `weight_capacity_modifier`, × bionic modifiers, + worn and bionic `weight_capacity_bonus` (+22.5 kg AEP_CARRY_MORE) | `Creature::weight_capacity`, `Character::weight_capacity` |
| Carried weight = worn + inventory + wielded (a wielded item heavier than capacity is exempt with a LIFT tool nearby) | `Character::weight_carried_reduced_by` |
| You may carry up to 4× capacity ("unsafe"), over 1× is overburdened | `Character::can_pick_weight` |
| Item volume: count_by_charges formula; non-rigid adds contents' volume; inserted magazine protrudes past `magazine_well`; gunmods add integral volume (× volume_multiplier) | `item::volume` |
| Item weight: `weight` (× charges), + contents (non-guns), + integral ammo, + gunmods & magazine for guns | `item::weight` |

So in BN a backpack is not a box you open: it raises the shared carrying volume; anything
not worn or in hands is "in the inventory". Containers (bottles, cans, boxes) are real
nested items holding one stack; holsters/sheaths/bandoliers hold their own items.

## 5. Item groups (src/data/itemgroups.ts)

Entries: `item | group | collection | distribution`, `prob`, `count`, `charges` (`[min, -1]` =
up to capacity), `damage` (×1000 at runtime), `dirt`, `container-item | container-group`,
`contents-item[]`, `contents-group[]`, `ammo-item | ammo-group`, `custom-flags`, `active`.
Group: `subtype`, `entries`, `ammo` / `magazine` percent (inherited by entries). BN has no
`entry-wrapper`, group-level `container-item`, `on_overflow`, variants or holiday `event`s;
the extractor rejects them. Expansion (item_group.cpp): every created item goes into its
entry's container or its default container, liquids filled; guns/magazines/tools with charges
are loaded (a magazine-fed gun gets its default magazine, filled); `ammo`/`magazine` chances
load/insert a default magazine into empty guns and tools; VARSIZE items get FIT one time in
three. `SpawnedItem` carries `charges`, `ammo`, `contents`, `flags`, `damage`, `active`.

## 6. Monsters

`MonsterDef.armor` is a damage-type map built from BN's `armor_bash/cut/stab/bullet/acid/fire
(→heat)/cold/electric/dark/light/psi` (stab defaults to 0.8 × cut, acid to 0.5 × cut).
Species flags and anger/fear/placate triggers are merged in. `melee_cut` becomes a cut unit.
`death_function` is a list of named mdeath functions (default `["NORMAL"]`; an `on_death`
object also spawns monsters). `special_attacks` entries are `{id, cooldown}` for named C++
attacks (`GRAB`, `SHRIEK`, …, or JSON `monster_attack`s like `scratch`) or actor objects
`{type: leap|melee|bite|gun|spell|deployer, ...}`. `harvest` defaults to `"human"`. No DDA
`dissect`, weakpoints, `GEN_DORMANT`, or `pseudo_dormant_*` twins.

Monster groups: `{id, default, is_animal, freq_total (1000), monsters: {monster, weight
(freq), cost_multiplier, pack_size?, starts?, ends?, conditions?}[]}`. Picking
(GetResultFromGroup): roll 1..freq_total, walk *valid* entries (invalid ones don't consume
the roll), else the default monster. No nested groups. `MONSTER_BLACKLIST` members are
removed (misc.monster_blacklist).

## 7. Recipes and requirements

`RecipeDef`: `type` recipe|uncraft, `result`, `category`, `subcategory`, `skill_used`,
`difficulty`, `skills_required`, `time` (s), `autolearn: false | [skill, level][]` (`true`
expanded like recipe::finalize: skills_required + skill_used at difficulty), `book_learn:
[book, level][]` (-1 = recipe difficulty), `decomp_learn`, `byproducts: [id, n][]`,
`result_mult`, `charges`, `contained` + `container` (result spawns in it, else in its default
container), `batch_time_factors`, `flags`, `reversible`, `never_learn`, and
`components/tools/qualities` with `using` and `LIST` expanded (tool counts are charges, -1 =
presence; `using` multiplies). Recipes for MIGRATION'd results are dropped. `misc.uncraft`
has disassembly-only recipes. `misc.nested_category` holds BN nested recipe menus.

## 8. What downstream systems must change (DDA → BN)

- **Inventory / items (next agent).** Replace pockets with §3–§4: flat inventory checked
  against worn `storage`; containers hold one stack (`container_data`); liquids need sealed
  containers when carried; holsters/bandoliers from `holster`/`bandolier`; magazines inserted
  into guns/tools, integral charges otherwise; non-rigid volume and encumbrance growth; all
  comestibles count by charges. Delete `src/data/bncompat.ts`. Saves: `ItemJSON.pockets` has
  no BN meaning.
- **Item groups at runtime.** `fromSpawned` must honour the new `SpawnedItem` fields
  (`damage` ×1000 scale, `active`, FIT flag, gun → magazine → ammo nesting).
- **Crafting.** No proficiencies, no practice recipes, no recipe variants or steps, no
  `byproduct_group`; `time` is seconds; `autolearn` is already expanded to skill levels;
  `book_learn` pairs; `contained`/`container`; `result_mult`; charges on results;
  `decomp_learn` for learning by disassembly; `nested_category` menus. Tool qualities and
  requirement semantics are unchanged.
- **Mutations.** BN mutagen is not vitamin-driven: consumables use `use_action`
  `{"type": "mutagen", "mutation_category", "is_weak", "is_strong"}` and
  `{"type": "mutagen_iv", "mutation_category"}` (iuse_actor.cpp mutagen_actor). Categories
  carry `threshold_muts` (tiers), `mutagen_message`/`mutagen_hunger|thirst|pain|fatigue|morale`,
  `iv_*` fields, `junkie_message`, memorial texts. Thresholds: tiers crossed in order; the
  primary (highest `mutation_category_level`) category must be > 50 and wins `x_in_y(level (+50
  for URSINE/ALPHA), Σ levels)` (mutation.cpp test_crossing_threshold). No primers/catalysts.
- **Bionics.** BN bionic JSON: `capacity`, `act_cost`, `deact_cost`, `react_cost`,
  `trigger_cost`, `kcal_trigger_cost`, `time`, `occupied_bodyparts`, `fake_item`,
  `fuel_options`, `fuel_capacity`, `fuel_efficiency`, `passive_fuel_efficiency`,
  `exothermic_power_gen`, `power_gen_emission`, `coverage_power_gen_penalty`, `encumbrance`,
  `env_protec`, `bash/cut/bullet_protec`, `stat_bonus`, `weight_capacity_*`,
  `canceled_mutations`, `included_bionics`, `upgraded_bionic`, `required_bionics`,
  `learned_spells`, `enchantments`, `flags`. Energy strings are kJ in our data. CBM items
  install `bionic_id`.
- **Martial arts / techniques.** BN techniques have no dialogue `condition`; gating is
  `ma_requirements` (`skill_requirements`, `weapon_damage_requirements`, `req_buffs`,
  `req_flags`, `mutations_required`, `unarmed_allowed`, `melee_allowed`,
  `unarmed_weapons_allowed`, `weapon_categories_allowed`, `strictly_unarmed`,
  `wall_adjacent`) plus `human_target`/`downed_target`/`stunned_target`, `crit_tec`,
  `crit_ok`, `defensive`, `dummy`, `weighting`, `aoe`, `knockback_*`, `stun_dur`,
  `down_dur`, `disarms`, `take_weapon`, `side_switch`, `miss_recovery`, `grab_break`.
  Items' `techniques`, `to_hit` int and `bashing`/`cutting` feed melee (no DDA
  melee_accuracy object, no per-portion armor materials).
- **Professions / scenarios.** Profession `items.{both,male,female}` are collection item
  groups (legacy arrays become entries; `[id, snippet]` pairs keep `snippet`), plus `skills`,
  `traits`, `CBMs`, `pets`, `vehicle`, `addictions`, `spells`, `missions`, `flags`, `points`,
  `starting_cash`, gendered names/descriptions. `profession_item_substitutions` are keyed
  `item:` / `trait:` / `bonus:` (BN's `item_group` mode). No DDA proficiencies or hobbies.
- **Achievements.** BN has `achievement` with `requirements`, `time_constraint`,
  `skill_requirements`, `kill_requirements`, `hidden_by`; no conducts; plus
  `event_statistic`, `event_transformation`, `score` (achievements extractor owns them).
- **Effects.** BN `effect_type` keeps `name`/`desc`/`reduced_desc`, `rating`
  (good|neutral|bad|mixed), `max_duration`, `int_dur_factor`, `apply/remove_message`,
  memorial logs, `resist_traits`, `resist_effects`, `removes_effects`, `blocks_effects`,
  `base_mods`/`scaling_mods`; durations are seconds. BN adds `disease_type`.
- **Monsters' special attacks.** Named attacks resolve to C++ functions (monattack.cpp) or
  JSON `monster_attack`s (`scratch`, `impale`, `bleed`, `sting`, `acid_spray`, …); actor types
  are leap, melee, bite, gun, spell, deployer. `attack_effs`, `special_when_hit`,
  `starting_ammo`, `death_function`, `upgrades` (half_life days, into/into_group) as in §6.
- **Misc keys** now present: `external_option` (BN game-balance options), `enchantment_*`,
  `mutation_flag`, `disease_type`, `monster_blacklist`, `item_migration` (BN MIGRATION:
  `replace`, `flags`, `charges`, `contents` for old saves). Gone: `proficiency*`, `practice`,
  `limb_score`, `sub_body_part`, `weakpoint_set`, `vitamin_type`-driven mutagen, DDA
  `damage_type` objects, `fault_fix`, `ememory`/e-files.

# Power armor and the armor interface CBM

Wear a power armor exoskeleton, its plating and a helmet, and carry a charged UPS. Open the
inventory (`i`), right-click the exoskeleton and choose **Activate**. The exoskeleton engages, and
the worn helmet and plating switch on with it, each with BN's message. The suit then draws power
every second while game time passes. **Turn off** on the exoskeleton switches everything back off.
The plating and helmet can't be switched on their own: they say "Activate via main piece.".

With a **Power Armor Interface** CBM installed and switched on in the bionics panel (`p`), the suit
runs on bionic power instead of the UPS, at half the cost (Mk. II: a quarter). When neither source
can pay, the suit shuts down with "You need a UPS or Bionic Power Interface to run the …!".

The item tooltip says which state the piece is in and what powers it, for example "On: draws
2.25 kJ/s from your UPS (300 kJ left)." or "On: draws 2.25 kJ/s from your bionic power through
your armor interface (1.13 kJ/s of bionic power).".

Exo-suits (`exosuit_*`) are plain `transform` items, not power armor: wear one, carry a charged UPS
(or charge its own cell at a vehicle charger), and **Use** it. It must be worn first, as in BN
`iuse_transform::use`. Its STRENGTH/SPEED apply while it is worn and on. (BN gives the exo-suits no
climate control; the power armor exoskeletons, the cooling suits, RM13 and the phase immersion suit
have it.)

A running power armor exoskeleton also keeps you comfortable: it pulls your body temperature 4 °C
toward normal on the arms and legs and 8 °C on the torso and head (see "Relic passive effects and
climate control" below). At −20 °C with the suit off you end up "Very cold!"; with it on,
"Comfortable". In 30 °C sun the switched-off suit leaves you warm or worse; switched on, you stay comfortable.

**Examine** (right-click → Examine) on any item with passive effects lists them as BN does,
for example "While active and While worn", then "Affects Strength (+2)" and "Keeps you comfortable
against All temperatures ( All Bodyparts ) (+4 °C)". When you have the item, the header also says
"(in effect)" or "(not in effect)". The amounts in brackets are the port's addition.

Code: `src/game/powerArmor.ts`, installed on every character in the `Character` constructor. The
interface power source is attached in `src/game/bodymods.ts`. Item passive effects:
`src/game/relicEnchant.ts`, with the enchantment value tree in `src/game/enchantValues.ts`, where
the character is in `src/game/characterWorld.ts`, and climate control in
`Character.climateCorrected`. Tests: `tests/powerArmor.test.ts`, `tests/relicEnchant.test.ts`.
Real input: `tools/realinput.ts --only powerarmor` (`tools/realinput_powerarmor.ts`).

## BN rules and units

Sources (Cataclysm-BN `src/`, data in `data/json/items/armor/power_armor.json` and
`data/json/bionics.json`):

- **Switching** is `set_transform_iuse::use` (`iuse_actor.cpp`). The exoskeleton has
  `set_charges: 2`. If a powered `BIONIC_ARMOR_INTERFACE` bionic is installed
  (`character_funcs::can_interface_armor`), the check is `Character::has_power()` only. Otherwise it
  is `item::units_remaining`: the item's own charge plus the useful charge of the UPSes you carry
  (`Inventory.upsCharges()`). Failing prints `set_charges_msg`, "You need a UPS or a bionic armor
  interface to power this.". The port adds the reload-help hint after it when no interface is
  powered.
- Then `iuse_transform::use` runs. `need_worn` gives "You need to wear the %1$s before activating
  it.". Next the `msg` prints, the item converts to `target`, and it becomes active if the action
  says `active`. It costs `moves` (0 here, the default). After that, every worn item with `flag`
  (`POWERARMOR_EXTERNAL`) whose active state equals `turn_off` gets
  `set_transformed_iuse::bypass`. That is a transform with its own message. The worn order is
  innermost layer first, so the helmet switches before the `OUTER` plating.
- `set_transformed_iuse::can_use` refuses direct use with "Activate via main piece." because
  `restricted` defaults to true.
- **Running** is `item::process_tool` (`item.cpp`). `power_draw` is in mW. The energy is
  `power_draw × seconds / 1e6` kJ, so the draws are: `power_armor_exo_1_on` 2250000 mW
  (2.25 kJ/s), `_exo_2_on` 1.5, `_exo_3_on` 0.75, `helmet_basic_on` 0.5, `helmet_heavy_on` 0.75,
  `helmet_light_on` 0.25. Plating has no draw. The order of payment is:
  1. the item's own charge (`ammo_consume`; power armor has none);
  2. for power armor, bionic power through a powered interface
     (`use_charges_if_avail(itype_bio_armor)`);
  3. a carried UPS if the item has `USE_UPS` (`Inventory.useUpsCharges`, the only UPS drain path).
- **Bionic cost** comes from `Character::has_charges` / `use_charges(itype_bio_armor)`
  (`character.cpp`): kJ / `fuel_efficiency`, using the best powered interface. That is 2 for
  `bio_power_armor_interface` and 4 for `_mkII`. Neither bionic has an `act_cost` or upkeep; both
  are `BIONIC_TOGGLED`.
- **Out of power**: when energy is left unpaid, `USE_UPS` items print "You need a UPS or Bionic
  Power Interface to run the %s!". An exoskeleton (it has `set_transform`) also turns its active
  `POWERARMOR_EXTERNAL` pieces off. Then the item reverts to `revert_to` and deactivates. Each piece
  pays its own draw, so a helmet can run out on its own.
- A restricted `set_transformed` piece that is active with no active `POWERARMOR_EXO` worn reverts
  at the start of `process_tool`. For example, the plating switches off if you take the running
  exoskeleton off. The exoskeleton itself keeps running when taken off, as in BN.
- **Active state** changes only what BN data changes:
  - The `_on` item type: encumbrance (exo_1 30 → 10, plating_1 30 → 20, helmet_basic 50 → 10),
    environmental protection, flags and `power_draw`. `hearing_protection` and
    `weight_capacity_bonus` also change.
  - Relic `passive_effects` with conditions `[WORN, ACTIVE]` (`enchantment::is_active`,
    `data/json/enchantment_conditions.json`): STRENGTH +2/+4/+6 for exo 1/2/3 and CLIMATE_CONTROL
    2000. These go through `src/game/relicEnchant.ts` like every other item's.
- **Wearing** follows `Character::can_wear` (`character.cpp`) with BN's messages:
  - no power armor over other gear unless that gear is `POWERARMOR_COMPATIBLE`;
  - one exoskeleton;
  - components only with power armor;
  - no externals over an exoskeleton or over each other;
  - no overlapping plating;
  - mods need an exo or external to attach to, with at most 2 per part (3 on the torso);
  - no non-compatible clothing over parts covered while wearing power armor.

  The existing footwear rule now exempts `POWERARMOR_PLATING`, and the headgear rule exempts power
  armor, as in BN.

## Relic passive effects and climate control

### BN rules and units

Sources are Cataclysm-BN `src/`:

- **Which items count.** `Character::recalculate_enchantment_cache` (`character.cpp`) walks
  `visit_items` and adds every item enchantment whose `enchantment::is_active(guy, item)` holds.
  `visitable<Character>::visit_items` (`visitable.cpp`) visits the wielded item, then the worn
  items, then the inventory. It also visits everything inside them, except that it never looks
  inside a gun or a magazine.
- **Where effects come from.** `item::get_enchantments` (`item.cpp`) returns the type's
  `relic_data.passive_effects`. `relic::load` (`relic.cpp`) loads each one as an enchantment. An
  entry with an `"id"` is replaced by that named enchantment, such as `DRONE_CAM` or the legacy
  `AEP_*` ones.
- **Conditions.** `enchantment::load` puts `"conditions"`, the legacy `"has"` string and the
  `"condition"` string into one set. `is_active` requires all of them; an empty set means always.
  The functions are in `enchantments/enchantment_condition.cpp`, and their ids and types are in
  `data/json/enchantment_conditions.json`:
  - `global`: ALWAYS; DAWN, DAY, DUSK and NIGHT (`calendar.cpp`: sunrise and sunset with a one-hour
    twilight); ACTIVE and INACTIVE, which test `item::is_active`.
  - `character`: INSIDE and OUTSIDE (`map::is_outside`); UNDERGROUND (z < 0) and ABOVEGROUND
    (z ≥ 0); UNDERWATER (`map::is_divable`: deep, swimmable water).
  - `item_and_character`: HELD (`has_item`, which is true for anything `visit_items` reaches),
    WIELD (`is_wielding`: the primary weapon only) and WORN (`is_worn`: directly worn, not inside a
    worn bag).
- **Value tree.** `enchantment_value::load` and `define_child_enchantments`
  (`enchantment_value.cpp`) generate children from a value's `suffixes`. A lookup sums the
  value's own amount and its parents', recursively and without removing duplicates
  (`enchantment::get_value_add`). CLIMATE_CONTROL has two suffix sets: COOLING/HEATING, then the
  body parts. Following the loader exactly gives these parents:
  - `CLIMATE_CONTROL_COOLING_ARM_L` → `_COOLING_ARM` (→ `_COOLING` → `CLIMATE_CONTROL`) and
    `CLIMATE_CONTROL_ARM_L` (→ `CLIMATE_CONTROL_ARM`, which has no parent);
  - `CLIMATE_CONTROL_COOLING_TORSO` → `_COOLING` (→ `CLIMATE_CONTROL`) and
    `CLIMATE_CONTROL_TORSO` (→ `CLIMATE_CONTROL`).

  So a plain CLIMATE_CONTROL counts **twice** on the torso, head, eyes and mouth, and once on the
  limbs. This is BN's arithmetic and is kept.
- **Climate control.** `Character::temp_corrected_by_climate_control` (`character.cpp`) runs in
  `update_bodytemp_bps` on each part's convergent temperature, after wind chill, clothing and sun
  and before bonus warmth:
  - Above `BODYTEMP_NORM` (37 °C), it subtracts
    `bonus_from_enchantments(to_legacy_bodypart_temp(T), "CLIMATE_CONTROL_COOLING_<PART>")`. Then,
    if `in_climate_control()`, it subtracts 1250 more. The result is never below NORM.
  - Below NORM, it adds the climate-control 1250 first, then the HEATING bonus. The result is never
    above NORM.
- **Units** (`units/body_temperature.h`): one legacy body-temperature unit is 2 m°C, so 500 = 1 °C.
  The exoskeletons' 2000 is 4 °C, and the cooling suits' and RM13's 1250 is 2.5 °C. The base for a
  `multiply` is the legacy temperature `5000 + (m°C − 37000) / 2`, truncated, where 0 = 27 °C.
- **In climate control.** `Character::in_climate_control` is true in three cases:
  - `M_SKIN3` while asleep on a FUNGUS tile;
  - any worn item with the `CLIMATE_CONTROL` flag (no BN item has the flag, but mods may);
  - standing on an inside vehicle tile (`vpart_position::is_inside`, `vehicle::refresh_insides`)
    of a vehicle with `total_power_w() > 0`.

### What the port does

- `src/game/relicEnchant.ts` visits the character as BN does and evaluates every condition above.
  It is the `Character.enchantProviders` entry for all items, so wielded, worn and carried (nested)
  items all apply. It replaced the earlier worn-only `wornRelicEnchant`.
- STRENGTH, DEXTERITY, INTELLIGENCE, PERCEPTION and SPEED were already read by `resetStats`, and
  BLISTER_COUNT by the thermal code, so the debug artifacts' INT/PER and the hawkeye's PERCEPTION
  now work too. CLIMATE_CONTROL is now read by `Character.climateCorrected`.
- **Fails loudly.** An unknown condition id, a condition type with no built-in function (`item`, or
  Lua-defined), or a missing named enchantment throws with the item id the first time that item
  type is looked at. A test parses every item in the data. DAY, OUTSIDE and the other conditions
  that need to know where the character is throw if `Character.world` is unset. It is set for the
  player (`game.ts`) and for NPCs (`npcai.ts placeNpc`), but not for a bare `Character` in unit
  tests.
- `Character.enchant` now uses the BN value tree (`src/game/enchantValues.ts`), with
  multiplicity. Single-suffix values like HEALTH_POINTS_ARM_L and PAIN_GAIN resolve as before.
- Climate control applies to the port's six main body parts (torso, head, arms, legs), using
  `CLIMATE_CONTROL_{COOLING,HEATING}_<PART>`. The worn `CLIMATE_CONTROL` flag, M_SKIN3 on fungus
  and powered vehicle interiors all count as in climate control.

## Adaptations (deliberate)

- **No random rounding.** BN rounds the sub-kJ remainder with `x_in_y`. Here the unpaid fraction is
  a debt kept on the item as `vars.power_armor_kj`. It is paid each time it reaches a whole kJ. It
  survives saves and on/off toggles, so toggling can't dodge the bill. `paid + owed` always equals
  `draw × time` exactly, and the tests check this. Unpaid energy when the suit runs out is dropped,
  as in BN.
- **Exact bionic cost.** BN's `has_charges(itype_bio_armor, q)` truncates `q / efficiency` to an
  integer. With one kJ at efficiency 2, it only needs `power ≥ 0` before draining 0.5 kJ, and
  clamping at 0 then creates energy. The port charges per kJ and needs `power ≥ 1 / efficiency`.
  Below that, the UPS pays.
- **BN quirk kept:** with a powered interface but no bionic power, Activate refuses even if you
  carry a charged UPS. That is BN's `set_transform` check. Switch the interface off to use the UPS.
- A transform `msg`'s `%s` is now filled with the item's name, as BN's `string_format` does. Before,
  "The %s engages." was printed raw, for exo-suits too.
- **DAY/DAWN/DUSK/NIGHT** use BN's rule (sunrise + 1 h ≤ day ≤ sunset, and so on), but with
  sunrise and sunset from `src/game/sun.ts`, so they match the sky. BN computes them from its own
  sunrise-hours table.
- **Vehicle interiors**: a tile is inside when it is roofed and each of its four neighbours has a
  roof or a closed obstacle. BN's loop also skips an obstacle that is itself "inside". That rule
  depends on the order of its loop, and is left out. BN rechecks the vehicle only every 20 turns
  (60 after a miss) to "simulate acclimation"; the port checks every turn.
- The Examine list adds the amounts in brackets and an "(in effect)" note. BN shows only the
  descriptions.

## Not ported

- Climate control on hands, feet, eyes and mouth: the port keeps one temperature per main body part
  (frostbite on hands, feet and mouth uses the main part's temperature), so `CLIMATE_CONTROL_HAND*`,
  `_FOOT*`, `_EYES` and `_MOUTH` values have nothing to act on. The cooling mask's `_HEAD` value
  works.
- Flags on the `_on` items: `HEAVY_WEAPON_SUPPORT`, `RECON_VISION`, `THERMOMETER`, `WATCH`,
  `ELECTRIC_IMMUNE`, and the helmets' named `DRONE_CAM` enchantment. None of these is implemented
  anywhere in the port.
- Radiation protection from a power armor suit with a helmet (`Character::is_rad_immune`): the port
  has no radiation. The same goes for the intimidation bonus.
- NPCs switching power armor on (`COMBAT_NPC_USE`, `npcmove.cpp`). NPCs that do wear power armor
  follow the same wear, draw and shutdown rules.
- Parts of passive effects other than `values`: `ench_effects` (debug artifacts),
  `intermittent_activation` spells, `mutations` granted while held (the Cube of Shame's CARNIVORE),
  `hit_you_effect` (stinger and triffid weapons), enchantment `flags` (RM13's FIRE_FIELD_IMMUNE)
  and `special_vision`. These are ignored, not errors.
- Values no port system reads: NOISE (RM13 −30; the port's footsteps use a different volume scale
  from BN's 60), FLASH_PROTECTION (no flashbangs), ARMOR_PSI, CLAIRVOYANCE, the RANGED_* values of
  the test hawkeye, MELEE_DAMAGE_DARK, WEIGHTMOD and OVERKILL. They are summed (the tests read
  them) but nothing uses them.
- Per-item ("dynamic") relic data: the port's items have no instance relic data, only the type's.
- Sided `POWERARMOR_MOD` allowances and `Character::can_swap`: the port has no left/right item sides,
  so every mod counts against both sides.
- Power-armor mods that need an interface (`iuse_transform` with `POWERARMOR_MOD`) and `transform`
  items with `need_charges`: no BN power armor mod uses either. The code throws if a power armor
  action has an unsupported field instead of ignoring it.

## Evidence

`tests/powerArmor.test.ts` has 17 tests on real BN data. They cover:

- the wear rules;
- the power check, including the `set_charges` 2 boundary and the interface quirk;
- `need_worn`, and the messages and order on and off;
- "Activate via main piece.";
- `_on` encumbrance and the +2 STRENGTH;
- UPS draw, interface (Mk I and Mk II) draw, an unpowered interface, and the bionic→UPS hand-off;
- shutdown and orphaned pieces;
- toggle conservation, and save/load of the active state and the owed fraction.

`tests/relicEnchant.test.ts` has 19 tests on real BN data. They cover:

- the CLIMATE_CONTROL value tree, including the double count on the torso;
- every item in the data parsing;
- each condition: WORN + ACTIVE (the exoskeleton), WORN (the hawkeye's PERCEPTION in `per`),
  WIELD (the clairvoyance rod), the legacy `"has": "WIELD"` (AEP_STR_UP, +4 STR), HELD + ACTIVE
  nested in a bag (the Cube of Shame's −2 INT/PER), no conditions (the chaos dagger), nothing
  visited inside a gun, and ABOVEGROUND (the radiation triangle);
- INSIDE, OUTSIDE, UNDERGROUND, UNDERWATER, ACTIVE, INACTIVE, DAY and NIGHT, on a copy of the
  tinfoil hat, since no BN item uses them;
- an unknown condition throwing;
- climate-control arithmetic (exo and cooling suit), the worn flag and the vehicle-interior rule;
- the exoskeleton keeping you "Comfortable" at −20 °C and in 30 °C sun, where the switched-off
  suit doesn't;
- the Examine text.

The real-input run (`--only powerarmor --params look=classic`) passed 28/28 checks. It includes
right-click → Examine on the running exoskeleton, with the passive effects "(in effect)", and
climate control reading 4000 legacy on the torso and 2000 on the arms. Screenshots are
in `docs/screenshots/gaps/`:

| File | Shows |
| --- | --- |
| `power-armor-off-tooltip.png` | Worn exoskeleton tooltip: encumbrance 30, "Off: Activate it to power the suit…", overloaded at 60.2/45 kg |
| `power-armor-activate-menu.png` | Right-click menu on the worn exoskeleton with **Activate** |
| `power-armor-examine-enchantments.png` | Examine on the running exoskeleton: "While active and While worn (in effect)", Affects Strength (+2), Keeps you comfortable … (+4 °C) |
| `power-armor-on-ups.png` | After Activate: "(active)", encumbrance 10, "On: draws 2.25 kJ/s from your UPS (300 kJ left)", carry limit 75.5 kg from +2 STR |
| `power-armor-plating-menu.png` | The plating's **Turn off** menu; the log shows the BN messages for helmet and plating |
| `power-armor-interface-on.png` | Bionics panel with the Power Armor Interface switched on |
| `power-armor-on-bionic.png` | Tooltip: drawing through the armor interface (1.13 kJ/s of bionic power); UPS left at 215 |
| `power-armor-shut-down.png` | Both sources empty: BN shutdown messages for the helmet and the exoskeleton, the plating feels heavier, power 0/100 |
| `power-armor-refused.png` | Activate with nothing to draw from: "You need a UPS or a bionic armor interface to power this." |

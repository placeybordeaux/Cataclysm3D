# Bright Nights farming and seasonal harvests

Seeds use the extracted `seed_data` slot. Default BN growth scales `grow` by the
91-day season relative to BN's 14-day reference, then divides it into three
stages. A ripe crop stays ripe until collected. The hidden planted seed and its
birthday survive save/load and lazy chunk actualization. Current extracted plant
furniture has no non-default growth multipliers; custom multiplier variants are
not covered by this port.

Examine a dirt mound while carrying seeds, select the seed, and stand still for
30 game seconds. Moving cancels without consuming anything. Completion rechecks
soil, occupancy, seed inventory, and current temperature before moving one seed
charge to the plot. BN requires at least 10°C today above ground, including local
heat; roofed soil and underground planting are permitted. Fertilizer advances the
birthday by 60% of one growth stage and is available once per stage.

Terrain harvests use BN inline seasonal entries. Blueberries are harvested in
spring; apple trees provide apples in autumn and sticks in other seasons.
Foraging marks underbrush with its season-specific harvested terrain.

References: BN `itype.cpp:islot_seed::get_plant_epoch`,
`iexamine.cpp:dirtmound/fertilize_plant/get_harvest_items`,
`map/mapbuffer.cpp:grow_plant`, and `activity_handlers.cpp:forage_finish`.

Validation: 23 nature tests, including ten migrated previously skipped cases,
planting cancellation/occupied-site charge conservation, remote growth and
compressed save/load. Typecheck and production build pass. Headful Chromium
OS-input `e`, `a` opened the seed picker and started planting; movement cancelled
with four seed charges retained; a completed planting left three carried charges
and one hidden charge in `f_plant_seed`. Picker and planted-crop screenshots were
inspected at [seed picker](screenshots/gaps/farming-menu.png) and
[planted crop](screenshots/gaps/farming-planted.png).

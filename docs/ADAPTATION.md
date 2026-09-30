# Adapting Cataclysm for a first-person, real-time game

CDDA-3D is to Cataclysm what a TV series is to the novel it's based on. We keep the story
and what makes it good, and we change whatever only works on the page (here: a turn-based
ASCII roguelike played in a terminal). This doc sets out the principles, then lists the
friction points found by playing the first half hour as a new player, in priority order,
with what wave 3 did about each one.

Related: `docs/DESIGN_V2.md` (product direction), `docs/UX_REVIEW.md` (input model),
`docs/COMBAT_FEEL.md` (combat is covered by the aim/feel work, not here).

## What we keep

- **The fantasy.** You're an ordinary person the day after the world ended. Nobody is coming
  to help. You live because of what you find, make and decide.
- **The depth of the systems.** Real items with weight and volume. Calories, thirst, body
  temperature, wounds, noise, smell, light. Crafting from what's lying around. Monsters that
  evolve. The same BN data and rules, with units taken from the C++ source.
- **The dread.** Zombies are slow but come in crowds, noise brings them in, night is dark, and
  running away is often the right call.
- **Emergent stories.** Nothing is scripted. A fire spreads, a car crashes into a horde, a
  survivor robs you. The game's job is to show these moments clearly, not to plan them.

## What we change, and why

| Cataclysm (page) | CDDA-3D (screen) | Why |
|---|---|---|
| Hidden dice: you miss because a roll failed | Skill you can see: a steadier crosshair, stronger hits, readable wind-ups (aim/feel work) | In first person a miss you can't see a reason for feels like a bug. |
| Walls of text in the message log | Feedback in the world and at the crosshair: progress rings, "?" markers, cards on what you look at, one-line toasts | Players look at the crosshair, not the log. |
| Menus for everything (examine, pick up, wait, sleep) | Interaction in the world: look at it and press `e`, quick-loot at the crosshair, drag and drop | The world is 3D now, so use it. |
| Turns, "heartbeats", moves | Seconds. Long jobs run as a few real seconds with the clock sped up | Real time has no turns. Naming them is a leftover. |
| Numbers with no explanation ("comfort 0", "(2/2)", "Bloated" next to "Famished") | Words that say what it means and what to do about it | A newcomer can't read the rating scale. A veteran loses nothing. |
| Veteran lore in tips ("Safe Mode rules", "helicopters", "go prone") | Tips about this game: guard when they wind up, stand still for timed jobs, the tactical pause | A tip is a promise about the game you're playing. |
| Keyboard-first, a letter for every command | Mouse-first, a few keys, everything rebindable, big click targets | The first screen should say "click here to play". |
| Faithful to the letter (e.g. day one in late-winter weather) | Faithful to the intent (BN's own default start is mid-spring) | When what the game shows and what it says disagree, players stop trusting either. |

Rules of thumb for future changes:

1. **Show it where the player is looking.** The crosshair is the centre of attention. The log
   is a history, not a way to talk to the player.
2. **Say it in words, then numbers.** Keep the numbers (in tooltips or the detailed HUD) for
   veterans, but lead with a word and an action ("Full, still famished: wait, then eat regular meals").
3. **Two contradictory signals is a bug.** If the HUD says one thing and the world shows
   another, fix whichever is wrong. That can mean the data, the rules or the art.
4. **Keep the old version one option away** when it's cheap: every change below has a switch.
5. **Never drop a system to make it easier.** Explain it, pace it (difficulty presets, tactical
   pause), or make it visible instead.

## Playtest: the first half hour (wave 3)

This was real keyboard and mouse input (puppeteer + xdotool on Xvfb, `tools/drive.ts
--headful`) at 1280×720, `look=classic`: new game → quick start → shelter → first loot →
first drink/meal → wait → sleep. Fixed items link to their switch. Combat, 3D characters,
furniture/vehicle models and distance readability belong to the other wave-3 areas and are
only noted here.

### Friction points, by priority

| # | Friction | Where | Status |
|---|---|---|---|
| 1 | **It is always a snowstorm.** BN `weather_type` data keeps its thresholds in a `requirements` object. The port only read DDA's `condition`/`required_weathers`, so every type matched and the last one, `snowstorm`, won every refresh (-7 °C snowstorm on a green spring morning, "Chilly" within a minute of waking up). | `src/game/weather.ts` | **Fixed**: `meetsBnRequirements` implements `weather_gen.cpp`. Two skipped `TODO(BN)` weather tests were rewritten for BN and now run. |
| 2 | **Spring day 1 is late winter.** Even with the right weather types, the seasonal cycle puts the port's start (spring day 1) at -2 °C mornings with snow a third of the time. BN itself starts new worlds mid-spring (`INITIAL_DAY` = 15 of a 30-day season). | weather/season | **Fixed**: the climate runs an eighth of a year ahead of the clock (45 days). The first week now has no snow on any seed: median 7 °C at 08:00, a mix of sun and showers. Winter still snows. Options → Climate (`?climate=bn\|old`). |
| 3 | **The title menu is a one-line terminal row** with 11 px tall click targets. | title screen | **Fixed**: big-button layouts (Options → Title screen, `?title=center\|side\|classic`). Default `center`. |
| 4 | **Nothing near the crosshair for timed actions.** Progress was a bar above the hotbar, and walking cancelled the job with a log line ("I pressed e on the fireplace and nothing happened"). | activities | **Fixed**: a ring around the crosshair with the job name and "stand still". An interruption flashes the reason there. Options → Activity progress (`?actui=ring\|bar\|both`). |
| 5 | **Tip of the day mentions features the port doesn't have** ("You can make your own Safe Mode rules in the pause menu" was the first tip seen). | tips | **Fixed**: all 86 BN tips reviewed. 47 kept, 11 rewritten for first person/real time, 28 dropped, and 9 tips added for this port. Options → Tips. A test fails if BN adds a tip nobody has reviewed. |
| 6 | **"Bloated" next to "Famished"** reads as a contradiction. It's two BN states: the stomach (too much at once) and the body's reserves. | HUD needs | **Fixed**: folded into the hunger icon as "Full, still famished", with a tooltip saying what it means and what to do. On a fed survivor it says "Full". |
| 7 | **The wait menu says "Wait 20 heartbeats".** | wait menu | **Fixed**: "20 seconds", "1 minute". |
| 8 | **The sleep menu shows a raw rating**: "(wooden floor, comfort 0)", and doesn't say you aren't tired. | sleep menu | **Fixed**: "(wooden floor, hard: a bed or sleeping bag would help)" plus "You aren't tired yet: you may just lie awake." |
| 9 | **Loot "?" markers draw over the title screen** (`#ui2` sits above the old `#ui` root). | title screen | **Fixed**: world/HUD layers are hidden while the title is up. |
| 10 | **Looking at a cupboard from up close hits the wrong one.** At about 0.3 m the crosshair card showed the empty neighbour ("Empty"), and `e` said "The cupboard is empty" three times while the one in front held 10 jackets. `g` (area loot) worked. | quick-loot targeting | Open, handed to the furniture agent: `lootTargetAt` should prefer the tile in front (`cdda.frontTile`) when the ray hits a neighbour's top face. |
| 11 | **The quick-loot card's bars look like the container's fill.** "Cupboard / Empty / 635 ml / 6.5 L / 3.25 kg / 45 kg" shows your own carried volume and weight next to the cupboard's name. | quick-loot card | **Fixed**: a "You carry" line above the bars. |
| 12 | **"Took 2 emergency jackets. 1 left behind." then "8 left behind"** in the same toast: one counts stacks, the other items. | take all | **Fixed**: both count items ("Took 2 emergency jackets. 8 left behind:"). |
| 13 | **Take-all on a shelter cupboard grabs 2 of 10 identical jackets.** A newcomer wanted to wear one. Double-click in the inventory wears it, but nothing suggests that when it's cold. | first loot | **Fixed (round 2)**: clothing on the quick-loot card gets "[O] Wear" (the player's wear key). When you're cold, the card also says "You're cold: [O] puts it on". |
| 14 | **The eat menu lists the bottle and the water inside separately**, with CDDA charge notation "(2/2)". | eat menu | **Fixed (round 2)**: a container row covers what's in it, and it reads "clean water (plastic bottle) · 2 servings" (`src/ui2/bn/eat_rows.ts`). |
| 15 | **Drinking one bottle when you're not thirsty makes you "Bloated"** (BN-faithful: excess quench). | needs | Now shown as a dim "Full" on the hunger icon. The rule is kept. |
| 16 | **Wait and Sleep are old terminal-style menus** in an otherwise ui2 game. | menus | **Fixed (round 2)**: both keys open one ui2 **Rest** window (see below). Options → Rest menus → Classic keeps the old ones. |
| 17 | **Time runs fast while you read the first toasts**: 08:01 → 08:23 in about 40 s of looking around. | clock | By design (real-time clock scale). Worth a "day length" note in the Start window. |

Not covered by this run: the first zombie fight and crafting a first weapon were only started,
not played through (combat feel is its own area). The weather and ring fixes apply to both.

### Round 2: first craft, first night, next morning

This was played the same way, with real input: seed 743667900, then fresh games. The run
covered Start → putting on a jacket from a locker → crafting a makeshift sling → waiting until
dusk → the first night (light, trying to sleep) → waiting until dawn → Continue from the title.

| # | Friction | Where | Status |
|---|---|---|---|
| 18 | **You wake up on a road, not in the shelter**, with a zombie in view, while the log says "you wake up in the evac shelter". Another special's road connection started on the shelter's overmap tile and paved it (`road_end_east`). | `overmap.ts buildRoad` | **Fixed**: roads never start on or pave another special. `tests/start_shelter.test.ts` checks 21 seeds, including this one. Existing worlds on affected seeds get their shelter back on regeneration. |
| 19 | **Every flashlight is dark.** BN keeps item light in `light_emission` (LIGHT_n flags fold into it). The port read the DDA-era `light` field, which no BN item has, so a flashlight or the phone's flashlight app gave 0 light. `F` said "You don't have a light source" while you carried a phone with a flashlight app. | `vision.ts`, `lightitems.ts`, `lightmap.ts` | **Fixed**: `defLight` and `itemLight` follow BN `item::getlight_emit`, including CHARGEDIM. Three skipped `TODO(BN)` light tests now run. |
| 20 | **A sun icon after dusk.** The HUD used 06:00–20:00 as "day". "Wait until dusk" ended at 18:43 under a sun icon, in pitch black. | HUD clock | **Fixed**: it follows the sun (`isDay`). |
| 21 | **"Night falls" came two hours late** (a fixed 20:30). | discovery tips | **Fixed**: it fires at civil dusk (`isNight`). |
| 22 | **"You don't have a light source."** is a dead end. | `lightitems.ts` | **Fixed**: the message says where lights are found (lockers, drawers, cars, or a fire). |
| 23 | **The phone's light ran flat overnight.** Lying down with the flashlight app on drained about 18 charges per 15 game minutes. | Rest | **Fixed**: lying down from the Rest window switches your light off and says so. |
| 24 | **The hotbar showed "0" in red for the phone** once its flashlight app was on (the use_action changes the item's type). | hotbar | **Fixed**: a slot follows its item through a transform (by reference, or by `revert_to` after a reload). |
| 25 | **"Day 1" at 05:30 the next morning.** The HUD counted 24-hour periods since the start, while the clock said "Spring, day 2". | HUD, Esc menu, journal | **Fixed**: `runDay` turns over at midnight. |
| 26 | **"Continue" opened a list of saves.** | title screen | **Fixed**: Continue loads the most recent save directly (`game.continueLatest`). The list is still under the small Load button. |
| 27 | **The loot card covered the crafting bar** when crafting next to the locker you took the parts from. | quick-loot card | **Fixed**: the card is hidden while a timed job runs. |
| 28 | **An item card from the crafting window stayed on screen for the whole craft.** Enter closed the window and the mouse was captured, so no pointer move ever hid it. | tooltips | **Fixed**: tooltips hide on pointer-lock changes and on Enter, Esc and Backspace. |
| 29 | **The activity ring sat on top of "[e] Go down the stairs".** | crosshair | **Fixed**: the interaction prompt hides while the ring shows. |
| 30 | **Crafting opens on "All known": 305 recipes** (acid bomb, atomic coffee…) with 1 craftable. The discovery toast had already named the one you can make. | crafting | **Fixed (round 3)**, see below. |
| 31 | **Waiting 21 hours straight** (until dawn, from the morning) never stops for hunger, thirst or tiredness. BN only interrupts for dangerous levels. | wait | Kept (BN). The Rest window shows your tiredness. |

### Round 3: day 2, food, a house, a car, a gun fight

This was played the same way on seed 743667900, from the second morning. Setup used debug
calls only to skip walking, to clear monsters, and to hand over a loaded pistol; everything
else was real keyboard and mouse. Aim and vehicle findings went to the lead rather than being
fixed here, because other agents own those areas.

| # | Friction | Where | Status |
|---|---|---|---|
| 32 | **Crafting shows the recipes you can't make, not the ones you nearly can.** | crafting | **Fixed**: it opens on **Craftable**. Below that list is an **"Almost: one thing short"** section, and a new **Almost** tab shows recipes up to two things short. Each row says what's missing in words ("missing 2 more rags", "missing a cutting tool"). Recipes where you already hold part of what's missing come first, and weapons, food and clothes come before chemistry (106 recipes were one short, and the list used to start with "ammonium nitrate pellets"). The section shows at most 12, with a link to the tab. With nothing craftable, the screen opens on Almost. Options → Crafting list → Craftable only turns the section off. |
| 33 | **Stuck walking past a tree.** In a forest the survivor stopped dead against the corner of a lone tree tile: axis-by-axis sliding has nothing to slide along when you walk straight at a corner. | `physics.ts` | **Fixed**: movement steps around a lone blocked corner (at most the step length per frame, toward whichever side is free). Walls still stop you. `tests/physics_corner.test.ts`. |
| 34 | **"Night falls" at 05:26.** A tip queued during "Wait until dawn" showed at sunrise. | discovery tips | **Fixed**: `first_night` only fires in the evening. Tips about passing states (night, rain, cold) are checked again at the moment they would show, and dropped if the state has passed. |
| 35 | **"You spot a nurse to the west!"** BN names some zombies by their old job, which reads like a survivor to rescue. | monster names | **Fixed**: the nurse and surgeon zombies are called "zombie nurse" and "zombie surgeon" in messages and labels. |
| 36 | **Loading a save faced you north.** The title screen's slow pan put back the view it started with, over the one the save restored. | title screen | **Fixed**: Continue and Load keep the saved view. |
| 37 | **Hungry, in front of a cupboard full of food, with no obvious way to eat.** | loot card | **Fixed**: the card offers **[E] Eat** or **[E] Drink** (your eat key) next to Take, just like Wear. When hungry or thirsty it says "You're hungry: [E] eats it here". |
| 38 | **The loot card covered the second zombie.** Killing the first one opened a 13-row card for its corpse while the next one closed in. | loot card | **Fixed**: the card hides while a hostile is within 6 m or you were hit or attacked in the last 3 s. |
| 39 | **The death screen opened scrolled to the bottom**: focusing the "Last words" field scrolled "You died" and the summary out of view at 720p. | death screen | **Fixed** (the field is focused without scrolling). |
| 40 | **The house marked on the map was an empty building site**, and the walk to it went through slow forest with no path. | map | Kept (that's Cataclysm). A route line to the destination would help. |
| 41 | **"You could craft jam sandwich" while `g` said "There is nothing to pick up nearby"**: crafting reaches further than picking up. | crafting / pickup | Kept (BN ranges). Worth wording: "nothing within arm's reach". |
| 42 | **No credits and no attribution in the game.** | title screen, Esc menu | **Fixed**, see Credits below. |

Reported to the lead (not fixed here):
- **Vehicles.** At an open car door, `e` closes the door. There's no "Get in" or "Drive" prompt, and `^` says "No vehicle controls in reach" until you've walked into the car. In the doorway the camera clips through the roof. The front doors stay open while you drive.
- **Combat pacing.** Two zombies spawned 14 m and 18 m away were on the survivor within about 4 s of real time. The new 3D zombie heads are very large close up. "GRABBED … mash [e] to break free" overlaps the "[e] Break free" prompt under the crosshair. The pistol at the hip is barely visible (a fist at the bottom right).

### Credits (round 3)

Credits is on the title screen (`R`) and in the Esc menu (`c`). It says clearly that this is
an unofficial fan adaptation, and gives the attributions the licences require. Every fact
comes from a licence file:
- Cataclysm: Bright Nights (and before it DDA and Cataclysm): CC BY-SA 3.0 Unported (`Cataclysm-BN/LICENSE.txt`).
- UltimateCataclysm tileset by I-am-Erk and the CDDA-Tilesets contributors: CC BY-SA 3.0 (`vendor/tilesets/readme.md`). Filler trees by Yar (`tileset.txt`).
- CC-Sounds soundpack (pack CC BY-SA 4.0, per-file CC0/CC BY): the screen links `audio/CREDITS.md`.
- CO.AG music (CC BY-SA 4.0, used with the composer's permission).
- Terminus (SIL OFL 1.1, copyright lines from `public/fonts/LICENSE-OFL-Terminus-Font.txt`) and GNU Unifont (GPLv2+ with the font embedding exception, from BN's `LICENSE.txt`).

A test checks the credits still match the shipped licence files. No licence file in the repo
covers this project's own code: the credits only claim CC BY-SA for the derived content.

## What changed (wave 3, "adaptation")

- `src/game/weather.ts`: `meetsBnRequirements`, `climateSeconds`/`BN_START_CLIMATE_OFFSET_DAYS`
  (also used for the rot temperature in `actualize.ts` and the frost check in `farming.ts`).
- `src/ui/adaptation.ts`: Options → Climate.
- `src/ui/title_screen.ts`, `src/ui/title.css`: title layouts. Entries, keys and actions stay
  in `menus.ts`. With a save, the big button becomes **Continue**.
- `src/ui/activity_ring.ts`, `.css`: the crosshair ring. `hud_modern.ts` hides its bottom bar
  in ring mode.
- `src/ui/tips_adapted.ts`: the tip review, port tips, Options → Tips, and the sleep-menu wording.
- `src/ui/hud_logic.ts`: hunger + bloated as one state (`EFFECTS_SHOWN_AS_NEEDS`).
- `src/game/rest.ts`, `src/worldInteraction.ts`: the wait/sleep menu wording.
- Tests: `tests/adaptation.test.ts`, weather tests in `tests/world_interaction.test.ts`.

Round 2:
- `src/ui/rest_ui.ts`, `.css`: the Rest window (sleep and wait in one). It shows the spot in
  words, how tired you are, whether you're indoors, "Until dawn · in 9 h", and why you can't
  rest (a monster in view). It wraps the `sleep` and `wait` keys that `worldInteraction.ts` registers.
- `src/ui2/bn/eat_rows.ts`: the eat picker's rows. `popups.ts` gains `PickRow.label`, and
  `model.ts` gains `hostOf(loc)`.
- `src/ui2/loot/install.ts`: Wear on the card, and the card hides during timed jobs.
  `quick.ts`: the "You carry" line.
- `src/game/vision.ts` `defLight`/`itemLight`, `lightitems.ts`, `render/lightmap.ts`: BN
  `light_emission`.
- `src/world/overmap/overmap.ts` `buildRoad`: specials are never paved over.
- `src/ui/hud_logic.ts` `runDay`, used by the HUD, the Esc menu and the journal.
  `hud_modern.ts`: the sun icon comes from `isDay`.
- `src/progression/install.ts`: `first_night` fires at dusk.
- `src/ui2/tooltip.ts`: tooltips hide on lock, Enter, Esc and Backspace.
  `src/ui2/bn/install.ts`: the hotbar follows transformed items.
- `src/game/game.ts` (hot file, one additive optional field `continueLatest`),
  `src/save/install.ts`, `src/ui/menus.ts`: Continue.

Round 3:
- `src/ui/craft2/craft_model.ts`: `shortfall`/`shortfallText`, the `almost` filter, and the
  ordering. `crafting_screen.ts`: `openingFilter`, the section and Options → Crafting list.
- `src/game/physics.ts`: corner rounding in `moveWithCollision`, which monsters and NPCs use too.
- `src/progression/install.ts`: `STILL_TRUE` re-check, and `first_night` in the evening only.
- `src/game/monster.ts`: `zombieAwareName`.
- `src/ui2/loot/install.ts`: `verbFor` (Wear / Eat / Drink), and the card hides in a fight.
- `src/ui/death_screen.ts`: focus without scrolling.
- `src/ui/credits.ts`, `.css`: Credits. `menus.ts` and `escmenu.ts` add the entry, and the
  classic title row highlights each entry's own shortcut letter.

### Switches

| What | Option | URL |
|---|---|---|
| Title screen | Options → Title screen: Big buttons / Side column / Classic row | `?title=center\|side\|classic` |
| Activity progress | Options → Activity progress: Crosshair ring / Bottom bar / Both | `?actui=ring\|bar\|both` |
| Tips | Options → Tips: Adapted / Cataclysm originals | — |
| Climate | Options → Climate: Mid-spring start (BN) / Early spring (old) | `?climate=bn\|old` |
| Rest menus | Options → Rest menus: Modern (Rest window) / Classic (CDDA sleep y/n + wait list) | — |
| Crafting list | Options → Crafting list: Craftable + one short (default) / Craftable only | — |

Screenshots: `docs/screenshots/wave3/adaptation/`.

| Screenshot (1920×1080, GPU, full look) | Shows |
|---|---|
| `title_classic_before.png` | The old one-line menu (still `?title=classic`) |
| `title_center.png`, `title_side.png` | The two button layouts |
| `start_spring_weather.png` | Day 1 at 08:00: "Light Drizzle 6 °C" (was "Snowstorm -7 °C") |
| `activity_ring.png`, `activity_interrupted.png` | The crosshair ring, and the flash when moving interrupts it |
| `sleep_menu.png` | The sleep menu in words |
| `rest_window.png` | Round 2: the Rest window (sleep + wait) |
| `eat_picker.png` | Round 2: one row for the bottle of water, "· 2 servings" |
| `loot_wear_when_cold.png`, `loot_wear_cold_hint_classic.png` | Round 2: "[O] Wear" on the loot card, and the "You're cold" hint (classic look, 1280×720) |
| `first_night_phone_light.png` | Round 2: 18:40, moon icon, the phone's flashlight app lighting the room |
| `title_continue_classic.png` | Round 2: with a save, Continue on top (classic look) |
| `credits.jpg` | Round 3: the Credits window (classic look, 1280×720, JPEG) |
| `crafting_almost.jpg` | Round 3: crafting opens on Craftable with "Almost: one thing short" |
| `loot_eat_when_hungry.jpg` | Round 3: "[E] Eat" and "You're hungry" on a kitchen cupboard |
| `drive_hatchback.jpg` | Round 3: driving the modelled hatchback, 25 mph |
| `map_day2.jpg` | Round 3: the map on day 2 with a destination set |

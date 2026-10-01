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
| 40 | **The house marked on the map was an empty building site**, and the walk to it went through slow forest with no path. | map | **Route added (round 4)**, see below. The empty house is kept (that's Cataclysm). |
| 41 | **"You could craft jam sandwich" while `g` said "There is nothing to pick up nearby"**: crafting reaches further than picking up. | crafting / pickup | Kept (BN ranges). Worth wording: "nothing within arm's reach". |
| 42 | **No credits and no attribution in the game.** | title screen, Esc menu | **Fixed**, see Credits below. |

Reported to the lead (not fixed here):
- **Vehicles.** At an open car door, `e` closes the door. There's no "Get in" or "Drive" prompt, and `^` says "No vehicle controls in reach" until you've walked into the car. In the doorway the camera clips through the roof. The front doors stay open while you drive.
- **Combat pacing.** Two zombies spawned 14 m and 18 m away were on the survivor within about 4 s of real time. The new 3D zombie heads are very large close up. "GRABBED … mash [e] to break free" overlaps the "[e] Break free" prompt under the crosshair. The pistol at the hip is barely visible (a fist at the bottom right).

### Round 4: route to the destination

A destination set on the map (right-click, then **Set as destination**) now gets a walking
route. The route prefers roads (cost 1), then fields and parking lots, then buildings, then
forest and thick forest. It never goes through open water (bridges are fine), and it's
re-planned whenever you step into another overmap tile.
- **On the map**: a dashed line from you to the destination, and its label gives the walking distance ("House · 72 m walk").
- **In the world**, two variants (Options → Route guide, or `?route=trail|beacon|off`):
  - **Trail** (default): a faint line of small amber diamonds on the ground for the next 30 m. It follows walkable tiles (through doors) toward the next leg of the route, fades with distance, and only shows marks you can see.
  - **Beacon**: one pulsing pin with a label ("House · 68 m") over the next leg of the route.
  - **Off**: compass only (the compass pip and distance stay in every mode).
- Shots: `route_map.jpg`, `route_trail.jpg`, `route_beacon.jpg`.

"Suggested places to loot": the game has no system that picks places for the player (the
refugee centre and mission targets are the only automatic map markers), so there was nothing
to bias away from empty building sites.

### Real-input suite (round 4, `tools/realinput.ts --gpu`)

The title and quit checks looked for `.mm-item`, the old title row. Every title layout now
marks its entries `.title-entry[data-key]`, and the checks use that. They pass on all three
layouts (`--params title=center|side|classic`).

The full run passed 47 of 50 scenarios. `craft` failed because a search in the Craftable tab
had lost the "names first" ordering: "spear" + Enter crafted the long pointy stick. Fixed, and
it passes on a re-run. `aim` and `aimzones` fail, and belong to the combat agent (reported).

### Round 5: refugee center, a job, a small base, the car, days 2–3

This was played the same way on seed 743667900. It covered:
- walking to the refugee center with the route guide;
- talking to a beggar and the Old Guard representative, taking the "Kill Bandits" job and opening the mission log;
- building a barricade on grass (construction screen, ghost placement, the crosshair ring);
- lighting a fire with a lighter;
- looking into beds;
- getting into a car and heading for another town with the road atlas and the driving beacon;
- waiting until dusk, sleeping through the night outdoors, and waking on day 3.

Setup calls moved the survivor between spots and handed over materials. Driving went badly: my scripted steering hit walls and parked cars, so I stopped there. That's a problem with my bot, not the game. Engine start, controls, gauges and the beacon all worked.

| # | Friction | Where | Status |
|---|---|---|---|
| 43 | **The route to the refugee center ended at a locked back door.** A destination on a big special went to whichever tile you clicked, and the route ran through the fence and the main building. | map, route | **Fixed**: on a special with an entrance (its road connection in the data), the menu offers **Set as destination: Refugee Center entrance**. The route also stays out of other specials' tiles (walls, fences). |
| 44 | **"6 OMT north-west"** in the mission log and the job tracker. | missions | **Fixed**: "about 140 m north-west" (`distanceText`). |
| 45 | **"Track" only drew a ring on the map.** | missions | **Fixed**: tracking a job also makes it the map destination, so the compass, map line and route guide lead there. Untracking clears it. |
| 46 | **"Difficulty 5" on the first job offered: kill armed bandits, on day 1.** | job card | **Fixed**: difficulty 3–4 adds "Risky: be ready for trouble"; 5 and up adds "Dangerous: expect a real fight. New survivors usually say no, or come back with a gun and friends." |
| 47 | **No barricade, pit or grave could be built on grass or dirt.** BN decides diggability from `digging_results`; the port tested DDA's `DIGGABLE` flag, which only 2 BN terrains still have ("too hard to dig" everywhere). | `construction.ts`, `nature.ts`, `zlevels.ts` | **Fixed**: `isDiggable()` follows BN `ter_t::is_diggable` (fall damage on soft ground too). Test: `tests/diggable.test.ts`. |
| 48 | **"It fits next to you, but something is missing."** never said what. | construction | **Fixed**: rows say "missing 10 more rocks" or "missing Fabrication skill 1 (you have 0)", the footer lists what's missing, ready and one-short stages sort first, and "site" became "soft ground (dirt or grass)" / "any open spot". |
| 49 | **Esc out of crafting or construction landed on the pause menu.** Esc in the search field closed the screen, the game grabbed the mouse, the same Esc dropped it, and the pointer policy read that as "the player left". | `core/input.ts` | **Fixed**: Esc is timestamped in the capture phase, before any field handler stops it. You now land on the "click to resume" hint, as with every other Esc. |
| 50 | **An empty lighter "(0/25)" looked as usable as the full one** in the Use picker. | Use picker | **Fixed**: greyed, sorted last, "Empty (0/25): it needs charges to use." |
| 51 | **Nothing showed the way while driving** (the trail is for walking). | route guide | **Fixed**: in Trail mode, driving switches to the beacon, placed further along the route. |
| 52 | **Two distances for the same place**: compass "Dana · 970 m", beacon "Dana · 1463 m". | route guide | **Fixed**: the beacon says "… m on foot" / "… m along the route" (the compass stays straight-line). |
| 53 | **No idea another town exists.** CDDA fog hides everything past 15 OMTs, so "drive to another town" meant guessing. | map | **Adapted**: see "Road atlas" below. |
| 54 | **"The weather changed to Rain! / Drizzle! / Light Drizzle! / Cloudy!"** in a row after one wait. | messages | **Adapted**: see "Weather messages" below. |
| 55 | **Slept outdoors "Very Hungry, Very Thirsty"** and woke up worse: BN doesn't stop a rest for that. | Rest window | **Fixed**: the Rest window warns first ("You're hungry and thirsty: drink something first…"). |
| 56 | **Beds need Fabrication 2–4**, and a new survivor has 0. "Build Makeshift Bed" is listed but can't be built. | construction | Proposal (below). |
| 57 | **Refuelling a car isn't implemented** (no siphoning, no pumps). | vehicles | Reported to the lead (vehicle area, already in the STATUS backlog). |
| 58 | **The refugee center parking lot is crammed** with cars and a bus, easy to wedge a car between them and the wall. | mapgen | Kept (BN layout). |

#### Adaptations built this round (all behind switches)
- **Road atlas** (Options → Map: Road atlas / Explored only (CDDA)). The map shows the names of towns within 60 OMTs (in italics until seen) and faint lines for the roads to them, as if you knew the county from a road map. Buildings stay fogged. Right-clicking an unexplored town offers it by name ("Dana (unexplored)"). Shot: `r5_road_atlas.jpg`.
- **Weather messages** (Options → Weather messages: Changes you notice / Every change (CDDA)). You get a message when rain, a storm or snow starts or stops, not for every shade of drizzle, and none while time is sped up.

#### Systems too obscure for newcomers: proposals
Rough cost and value, cheapest first. The ones marked **built** are done; the rest are proposals.

| System | Why it's obscure | Proposed adaptation | Cost |
|---|---|---|---|
| Map fog past 15 OMTs | You can't plan a trip to a town you don't know exists | **Built**: road atlas | small |
| Mission distances in OMT | A unit only veterans know | **Built**: metres | tiny |
| Diggable ground | "Too hard to dig" everywhere (a bug that looked like obscurity) | **Built**: BN rule | tiny |
| Construction skill gates (bed = Fabrication 2–4) | The first thing you'd build is locked behind a skill you can't see how to train | **Built** (round 6, switch "First beds"): straw and makeshift beds at Fabrication 0, 1.5× slower | small |
| Water safety (boil river and toilet water) | Needs a pot, a fire and a recipe; the tip says "boil it" but not how | **Built** (round 6): "Boil water" on a lit fire (BN recipe `water_clean` under the hood) | small |
| Fire spreading | Lighting sticks in a grass field works, and can burn the field | **Built** (round 6, switch "Fire safety"): a warning, and a second try to light it anyway | small |
| Faction standing (Old Guard, Free Merchants) | The card says "Neutral"; how to change it is hidden | **Built** (round 6): a line on the NPC card and tooltips on the faction and opinion chips | small |
| Vehicle refuelling | Not implemented; in BN, siphoning and pumps need menu actions | **Proposal** (vehicle area): "[e] Fill up" at a gas pump with a car next to it; "Siphon fuel" on a parked car when you carry a hose and a container | medium |
| Morale and focus | Numbers that change learning speed invisibly | **Built** (round 6): a "learning slowly: low morale" message, at most once an hour | small |
| Food spoilage | "(old)" and "(rotten)" appear with no timeline | **Built** (round 6): "Fresh: about 9 days at room temperature, about 4 weeks in a fridge" on the item card | small |

### Round 6: the proposals built, and days 2–5

#### Built (the ones that change rules have a switch; off = BN exactly)
- **First beds** (Options → First beds: No skill needed (slower) / Fabrication 1–2 (BN)).
  `constr_straw_bed` and `constr_makeshift_bed` need no Fabrication and take 1.5× as long; the
  construction screen says "(slow without the skill)". Proper beds keep their gate, and the XP
  you earn is BN's. `src/game/adaptation_rules.ts`.
- **Fire safety** (Options → Fire safety: Warn outside a fire ring / No warning (BN)). Lighting a
  fire off a fire container, next to something that burns or under a roof, says why, "Fires
  spread. A fire ring (10 rocks: smash a boulder with a hammer), a brazier or a fireplace keeps it in. Use the lighter again to
  light it anyway." A second try within 30 s lights it.
- **Boil water** on a lit fire (`e` on it). With unclean water and a pot: "Boil water (2 servings
  of clean water)", which runs BN's `water_clean` recipe (same time, tools and practice). No
  pot: it says what's missing. The fire's menu is titled "Fire", and the loot card no longer
  sits on a burning pile (it used to take the firewood out).
- **Freshness** on food cards: "Fresh: about 9 days at room temperature, about 4 weeks in a
  fridge. Frozen, it keeps.", "Going off soon", "Rotten: eating it will make you sick.", and for
  a sealed can "Keeps while sealed. Once opened: …". From BN's rot model (3600 points an hour at
  65 °F, doubling every 16 °F).
- **Faction standing**: the NPC card says "Finished jobs and kind answers earn their trust;
  threats and violence make them afraid or angry." The faction chip's tooltip names the group
  and says its members give out jobs.
- **Low morale slows learning**: "You're learning slowly: your low morale (-25) makes it hard to
  focus. Something tasty, warmth, rest or a good book helps." At most once an hour of game time.
- **Fire goes out** note: "the rain put it out", "it has burned through its fuel", or, when wood
  is left, "The fire goes out before the wood on it burned up. Light it again; a fire ring burns
  hotter and keeps going."
- Long flash notes wrap and stay up longer (by length) instead of running off the screen.

Skipped as asked: refuelling (vehicle area).

#### Playing days 2–5 (real input, seed 743667900)
Built a straw bed at Fabrication 0 and slept in it; walked to a pond past a chain-link fence
(climbed it with `e`), filled a bottle, lit sticks by the bed (warning, then lit), boiled the
water at the fire, ate the last food, and lived on pond water to the morning of day 5 (Very
Hungry, Very Thirsty, unhurt).

| # | Friction | Where | What happened |
|---|---|---|---|
| 59 | **A campfire on a woodpile went out in ~20 min with every stick unburnt**, whenever time was sped up (waiting, crafting, eating). | fields | **Fixed** (BN fidelity): the fields system simulated 8 turns a frame and decayed the rest in bulk, which ignores fuel; fires now get their turns one by one (budgeted). Fuel uses `roll_remainder` as BN does, and a fire in a fire ring or brazier burns at BN's contained rates (intensity 3, volume-independent), so a ring fire really lasts. On open ground a small fire still dies fast: that's BN. |
| 60 | **"The fire goes out: it has burned through its fuel"** with the wood still there. | fire-out note | **Fixed**: says the wood didn't burn up and points at a fire ring. |
| 61 | **"Drink from the shallow water"** gave no hint that it's unclean. | water menu | **Fixed**: "Drink the unclean shallow water" (BN asks "This looks unclean, sure you want to drink it?"; the label carries that instead of a y/n popup). Note: in BN unclean water carries **no disease**; the journal's "can make you sick" was wrong and now says it's unclean and how to boil it. The boil label says "clean water", not "safe". |
| 62 | **On a straw bed the Rest window said "a bed or sleeping bag would help"**, and the log followed "This is a comfortable place to sleep" with "You'd sleep better in a bed". | Rest window, sleep hints | **Fixed**: "straw bed, a little hard: a mattress, a proper bed or a sleeping bag would be better"; the bed hint only on bare ground. |
| 63 | **"You try to sleep, but you just can't."** twice at 23:00 after a long sleep, with no reason. | sleep | **Fixed**: "…: you aren't tired yet. Stay up a few more hours, then try again." when that's why. |
| 64 | **Two bottles of water were listed as two different things** in the eat picker ("clean water (plastic bottle)" and "clean water · In your plastic bottle"). | eat picker | **Fixed**: one row, "clean water (plastic bottles) · 4 servings". |
| 65 | **A loot card next to "[e] Talk to …"** when an NPC stood in front of a pile; `e` talks. | loot card | **Fixed**: no card while a creature is under the crosshair. |
| 66 | **Days of "Very Hungry" with no idea where food is.** | tips | **Fixed**: a "Nothing to eat" tip (very hungry, no food on you): kitchens, stores, crates; thirst first. Also: the hunger tip's list spelled "Very hungry"/"Starving!", which the game never reports. |
| 67 | **The fire warning says "a fire ring (10 rocks)"**, but outside the walled compound there was one rock in 40 tiles. | fire safety | **Fixed** (round 7): "10 rocks: smash a boulder with a hammer". BN: `f_boulder_small` bashes into 16–32 rocks (`str_min` 16), medium 35–50, large 50–70, `f_rubble_rock` 5–10; within 90 tiles of this shelter there were 12 small and 4 medium boulders and 9 rock rubble piles. Bare hands at Str 8 "don't seem to be damaging" it; with a hammer it broke after 35 hits into 27 rocks. (BN also lets you "clear up" rock rubble with a digging tool; the port has no such action, only smashing.) |
| 68 | **The hotbar showed "water ×3"** in a slot with no such item on me. | hotbar | **Fixed** (round 7): the first-run hotbar bound both the starting bottle ("clean water (plastic bottle)") and the water inside it; the second slot counted every clean water carried. It no longer binds the contents of a bottle it already bound. Hotbars saved before the fix keep the old slot (right-click clears it). |
| 69 | **The warehouse compound north of the shelter has no way in on its south side** (a long concrete wall); the fruit crates inside were out of reach on foot. | mapgen | **BN as designed** (round 7): it is `lab_mutagen_6_level`, the surface of a unique underground lab. Its core and residence blocks are walled; the way in is the `lab_security_z0` checkpoint on the parking side, which connects to the road (north of the lab here: doors on the checkpoint's north face, locked gates beside). The Evac Shelter just happens to sit against the lab's south wall. The "fruit and organs" crates are lab stores. |

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

Round 5:
- `src/world/overmap/overmap.ts` `specialEntrance`, `src/ui/overmap_ui.ts`: the entrance destination, the road atlas (`mapAtlasOn`, Options → Map) and town names in the map menu.
  `src/ui/route.ts`: the route avoids other specials, the beacon while driving, and the "on foot" / "along the route" label.
- `src/screens/logic/missions.ts` `distanceText`, and `src/screens/missions.ts`: metres, and Track sets the destination. `src/screens/dialogue.ts`: what the difficulty means.
- `src/world/registry.ts` `isDiggable`, used by `construction.ts`, `nature.ts` and `zlevels.ts`.
- `src/ui/craft2/construction_screen.ts`: what's missing, the site wording and the order.
- `src/core/input.ts`: the Esc timestamp in the capture phase.
- `src/ui2/bn/install.ts`: empty tools greyed out in the Use picker.
- `src/game/weather.ts` `weatherMessageFilter`, and `src/ui/adaptation.ts`: Options → Weather messages.
- `src/ui/rest_ui.ts` `restNeedsWarning`.
- Tests: `tests/diggable.test.ts`, plus cases in `tests/adaptation.test.ts` and `tests/screens.test.ts`.

Round 6:
- `src/game/adaptation_rules.ts` (switches, `effectiveSkills`/`effectiveTime`), used by
  `construction.ts` and `ui/craft2/construction_screen.ts`; `src/ui/adaptation.ts` registers the
  Options.
- `src/game/fire.ts` `fireSpreadRisk` and the warning in `useFirestarter`; `src/game/boil.ts`
  (Boil water provider); `src/game/interact.ts` ("Fire" title, "Drink the unclean …").
- `src/game/fields.ts`: fires simulated per turn in bulk, `roll_remainder` fuel, contained burn
  rates, `fireOutNote`.
- `src/game/freshness.ts`, shown through `ItemView.note` (`ui2/logic/items.ts`, `ui2/tooltip.ts`,
  `ui2/bn/model.ts`).
- `src/screens/dialogue.ts` (`STANDING_SHORT`, `STANDING_HOWTO`, `FACTION_HOWTO`),
  `screens.css`.
- `src/game/character.ts` (`lastSlowLearningNote`, the note in `practice`).
- `src/game/rest.ts` (`cantSleep`, the bed hint), `src/ui/tips_adapted.ts` (straw bed wording),
  `src/ui2/bn/eat_rows.ts` (stacked bottles), `src/ui2/loot/install.ts` (no card on a fire or
  under an NPC), `src/ui2/dragdrop.ts` and `ui2.css` (flash notes wrap).
- `src/progression/discovery.ts`, `install.ts`: "Nothing to eat", the thirst text, the hunger
  state spellings.
- Tests: `tests/adaptation_rules.test.ts`, `tests/fire_fuel.test.ts`, cases in
  `tests/adaptation.test.ts`; `tests/crafting.test.ts` turns the fire warning off for its
  lighter test (its test map counts as indoors).

Round 7:
- `src/ui2/ui2.css`: toasts slide in a short way with a fade (on ultrawide the first stepped
  frame of the old full-width slide sat at the screen edge: QA wave 3 #8).
- `src/ui2/bn/install.ts` `firstRunHotbar`: not the contents of a bottle it already bound.
- `src/game/fire.ts`: where rocks come from.

Round 4:
- `src/ui/route.ts`, `.css`: `omtCost`, `planOmtRoute` (A* over overmap tiles), `currentRoute`,
  and the Trail and Beacon displays (DOM marks on the ui2 world layer; nothing in the renderer).
  `overmap_ui.ts` draws the dashed route and the walking distance.
- `menus.ts`, `title_screen.ts`: `.title-entry[data-key]` on every layout.
  `tools/realinput.ts` uses it.
- `craft_model.ts`: a search puts name matches first in Craftable and Almost too.
- Tests: `tests/route.test.ts`, plus a craft2 search case.

### Switches

| What | Option | URL |
|---|---|---|
| Title screen | Options → Title screen: Big buttons / Side column / Classic row | `?title=center\|side\|classic` |
| Activity progress | Options → Activity progress: Crosshair ring / Bottom bar / Both | `?actui=ring\|bar\|both` |
| Tips | Options → Tips: Adapted / Cataclysm originals | — |
| Climate | Options → Climate: Mid-spring start (BN) / Early spring (old) | `?climate=bn\|old` |
| Rest menus | Options → Rest menus: Modern (Rest window) / Classic (CDDA sleep y/n + wait list) | — |
| Crafting list | Options → Crafting list: Craftable + one short (default) / Craftable only | — |
| Route guide | Options → Route guide: Trail on the ground (default) / Beacon ahead / Off | `?route=trail\|beacon\|off` |
| Map | Options → Map: Road atlas (default) / Explored only (CDDA) | — |
| Weather messages | Options → Weather messages: Changes you notice (default) / Every change (CDDA) | — |
| First beds | Options → First beds: No skill needed (slower) (default) / Fabrication 1–2 (BN) | — |
| Fire safety | Options → Fire safety: Warn outside a fire ring (default) / No warning (BN) | — |
| Reading minigame | Options → Reading: Field notes (default) / Skim / Off (plain BN reading) | `?reading=quiz\|skim\|off` |

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
| `route_map.jpg` | Round 4: the dashed walking route on the map, "House · 72 m walk" |
| `route_trail.jpg` | Round 4: the Trail variant, ground marks toward the house |
| `route_beacon.jpg` | Round 4: the Beacon variant |
| `r5_route_to_entrance.jpg` | Round 5 (960×540 JPEG, classic look): the route to the Refugee Center **entrance** |
| `r5_job_offer.jpg`, `r5_mission_log.jpg` | Round 5: the job offer and the mission log (shot before the difficulty hint and metres were added) |
| `r5_construction_missing.jpg` | Round 5: construction rows and the footer say what's missing |
| `r5_barricade_building.jpg` | Round 5: building a barricade on grass, with the crosshair ring |
| `r5_road_atlas.jpg` | Round 5: the road atlas, with Dana set as the destination |
| `r5_beacon_driving.jpg` | Round 5: the beacon while driving |
| `r5_rest_dead_tired.jpg` | Round 5: the Rest window at dusk, dead tired (shot before the hunger/thirst warning) |
| `r6_fire_warning.jpg` | Round 6 (960×540 JPEG): the fire-spread warning, wrapped |
| `r6_boil_prompt.jpg`, `r6_boiling.jpg` | Round 6: "[e] Boil water" on a lit fire, and boiling (shot with the first label wording) |
| `r6_straw_bed_ready.jpg` | Round 6: the straw bed buildable at Fabrication 0, "(slow without the skill)" |
| `r6_straw_bed_rest.jpg` | Round 6: the Rest window on the straw bed |
| `r6_freshness.jpg` | Round 6: "Fresh: about 9 days at room temperature, about 4 weeks in a fridge" on bread |
| `r6_faction_howto.jpg` | Round 6: the NPC card's standing line under "The Free Merchants" and "Neutral" |
| `r6_eat_two_bottles.jpg` | Round 6: the eat picker (shot with one bottle left) |
| `r6_fire_out_note.jpg` | Round 6: "The fire goes out before the wood on it burned up" |
| `r6_day5_no_food.jpg` | Round 6: day 5, the journal's "Nothing to eat" entry |
| `r7_tip_ultrawide_first_frame.jpg` | Round 7 (1720×652, 2.64:1): a discovery tip 60 ms after it appears, already in the HUD column |
| `r7_hotbar_first_run.jpg` | Round 7: first-run hotbar, lighter / water / smartphone, no second "water" slot |
| `r7_boulder_rocks.jpg` | Round 7: a small boulder smashed with a hammer, rocks on the ground |

## Grab and drag (BN `G`), and the hotbar's quick-draw

User report: "When I have long bow in my quick bar and press it, it wears it. The expectation
is that it wields it. Also I remember being able to drag items in Cataclysm, is that no longer
there? Was that skipped in the transition?" — it was skipped; both are fixed.

### Hotbar: weapons are wielded

The hotbar ran the item's double-click action, which prefers **Wear** for anything with armor
data — and BN gives every bow armor data (it can be slung, layer BELTED). A hotbar slot is a
quick-draw now (`src/game/hotbar_choice.ts`, rule table in `docs/UI2.md`): any gun (bows,
crossbows, slings, pistols, rifles; carried or slung) and any melee weapon (BN
`weapon_category`, or melee damage above BN's `MELEE_STAT` 5) is **wielded**; clothing, packs,
holsters and shields are worn; food, drinks and bandages are consumed; tools are used. Pressing
the slot of what you hold puts it away (unchanged). A worn holster's slot draws from it. When
the chosen action is impossible the slot says why instead of doing something else.
`tests/hotbar_choice.test.ts` is a table over real BN items; real input: `--only hotbow`.

### Grab and drag

BN's grab (handle_action.cpp `grab()`, game.cpp `grabbed_furn_move`, grab.cpp
`grabbed_veh_move`, map.cpp `move_furn`), ported rule for rule onto the tile grid
(`src/game/grab.ts`) and played in real time (`src/grab.ts`):

- **`G`** grabs the furniture or vehicle you aim at (or the tile in front of you) — adjacent
  only, like BN — and `G` again lets go. Also: **`o`** on it → "Grab the dresser (drag it)",
  `e` menus that already offer a choice, and a vehicle part's `e` menu. Throwing moved from `G`
  to BN's own `t` (both rebindable). The HUD banner says "Holding the dresser · Walk to push or
  pull · [G] let go".
- **Walking while holding** is tile steps: WASD relative to where you look, snapped to 8
  directions. Toward it pushes, straight away pulls (you need room behind you), sideways nudges
  it while you stay (twice → out of reach → you let go). Each step lasts the BN time it costs:
  your walk plus `str_req × 10` moves for furniture (a dresser at Str 10: ~0.6 s a tile),
  `400 × str_req / str` for a vehicle. You glide tile to tile; the furniture model slides
  (`src/render/grabView.ts`: a stand-in drawn until the chunk mesh has the piece in its new
  tile); carts roll and turn to face the way they go. Mouse look stays free.
- **Strength**: furniture `required_str` (+1 per 4 kg of items on the tile); BN's strain roll
  ("You strain yourself trying to move the heavy safe!", pain), "The safe is really heavy!"
  (3000+ moves) within 3 points, "too heavy for you to budge" below that. Vehicles: BN's mass /
  wheels / terrain formula (a shopping cart needs Str 1; a car ~7 on a road), "You lack the
  strength to move the …".
- **Blocked**: walls, other furniture, vehicles, creatures, traps, non-FLAT ground ("The dresser
  collides with something."), a cluttered tile for non-container furniture ("There's stuff in
  the way."); vehicles use `VehicleSystem.dragBlocker` (BN's just-detect collision, honouring the
  drawn body): nothing is damaged. A bump is reported once; hold the key again after changing it.
- **Contents**: container furniture (dressers, lockers, safes: BN `CONTAINER`/`SEALED`) carries
  its items; other furniture leaves them behind ("Stuff spills from the table!") — BN, and it
  surprises veterans too. Every item moves through `moves.ts` (conserved; test). A small fire
  moves with a pushed brazier.
- **Noise**: "a scraping noise." at `min(80, 40 + 2 × required_str)` — zombies hear you
  barricading.
- **Barricades**: the moved furniture is ordinary map furniture, so monsters path around it or
  bash it (the pathfinder prices a bashable dresser in a doorway by its bash strength; test).
- **Ends** on `G`, death, sleep, driving, a z-level change, or being moved off your tile.
  Saved mid-drag (save section `grab`).

Not ported: grabbing creatures (BN's `G` on a monster), dragging up/down ramps, harnessed
animals, vehicle theft checks, BN's exact wheel traction (FLAT ground 1, else 0.5 here).
Refrigerators can't be grabbed — BN data gives `f_fridge` `required_str: -1`.

Tests: `tests/grab.test.ts` (push, pull, nudge, wall, too heavy, strain, contents conserved,
stuff in the way, barricade pathing, shopping cart push/pull/wall). Real input: `tools/realinput.ts
--only grab` (push a dresser into a wall, o-menu grab + pull a chair, push a cart, a safe too
heavy, save/load while holding). Screenshots (`docs/screenshots/wave3/hotbar-grab/`, GPU, full
look): `grab_push_shoulder.jpg` (mid-push, shoulder camera, the banner), `grab_nudged_out_of_reach.jpg`
(a diagonal nudge pushed it out of reach: "You let go of the dresser."), `grab_cart.jpg` (pushing a
shopping cart). `e` on furniture keeps doing what it did (look in the dresser, examine the chair):
Grab only joins `e` menus that already had a choice.

## Reload help: "what does this take, and where did I see some?"

User report: "an annoying thing about flashlights and exo-skeletons is that I thought maybe I have
the batteries I need, but then I try to reload them and it says 'no ammo'". BN's reload_ui says
"You need a compatible magazine to reload the flashlight!" / "You don't have any batteries to
reload your …". That's true, but it doesn't say *which* battery. BN has ultra-light, light, light
high-capacity, medium and heavy batteries, each disposable, rechargeable or plutonium, and a
flashlight takes exactly two of them. A veteran knows this. A new player walks past the right
battery in the next drawer.

Now a failed reload (the reload key, the inventory's Reload, NPCs too) or a tool that won't switch
on (the hotbar / activate: "The flashlight's batteries are dead.") says **what it takes** in plain
words, taken from BN's fields (`magazines` well, `ammo` types, `NO_RELOAD`, `USE_UPS`, `RECHARGE`).
It gives 1–3 examples, picked in this order: (a) ones you **saw** recently, and where ("You saw 2
light batteries in a dresser 40 m northwest."); (b) else the **most common** in BN spawn data (item
group weights); (c) else any that fit. It also names the failure:

| Situation | Message (real BN items) |
|---|---|
| none carried | "Your flashlight takes a light disposable battery or a light battery. You have none. The light disposable battery is the most common." |
| …after looking at a pile | "… You have none. You saw 2 light batteries on the floor 4 m northeast." |
| batteries all flat | "Your light batteries are all flat. Rechargeable ones need a battery charger, and there's no charging in this version yet. Disposable ones come charged, like the light disposable battery." |
| wrong size | "Your medium battery doesn't fit: the flashlight takes a light disposable battery or a light battery." |
| loose rounds, no magazine | "You have 9x19mm JHPs, but the Glock 19 loads from a magazine: it takes a Glock magazine, … (9x19mm)." |
| other calibre loaded | "The S&W 619 still has .38 Specials in it: unload it first to load .357 magnum FMJs." |
| exo-suit / power armor | "Your powered survivor suit can't be reloaded: it runs on a UPS you carry. … A UPS takes a heavy battery or a heavy battery (high-capacity)." |
| smartphone | "Your smartphone can't be reloaded: it's recharged from a battery charger or a UPS, and there's no charging in this version yet." |
| dead tool, charged battery carried | "The flashlight's batteries are dead. You have a light disposable battery with charge: reload the flashlight with it." |
| full | unchanged: "The Glock 19 is already fully loaded!" |

The same **"Takes: …"** line (plus "You saw …" when you have) is on the ui2 item tooltip (the
inventory and the hotbar), the examine card and the look card for any item that reloads.

Memory: `src/game/seenitems.ts` remembers only reload-relevant items (ammo, magazines, batteries,
UPSes): up to 3 places per type, at most 400 types, saved as the `seenItems` section. The scan
(`src/ui2/loot/seen.ts`, once a second) sees what the pile markers see: floor piles and furniture
tops in line of sight within 12 tiles, and storage you've searched (`LootMemory`), never the
inside of a drawer you haven't opened. A place is dropped from the hints once its tile is
loaded and the item is gone.

Rule changes that came with it, from BN: `NO_RELOAD` items (smartphones, exo-suits) are refused
(BN `item::is_reloadable`). `USE_UPS` tools draw from the UPSes you carry once their own charge is
gone, for switching on and for running (BN `item::units_remaining` / `use_charges(itype_UPS)`).
Before this, an exo-suit could never be powered here. A flat battery still goes in (BN allows it),
but the message says it's flat. Not ported: battery chargers and recharging stations (so
rechargeables found flat stay flat, and the messages say so), the power-armor interface CBM,
and power armor's `set_transform` activation.

Code: `src/game/reloadhelp.ts` (UI-free), wired into `Inventory.reload` / `useTransform`.
Tests: `tests/reloadhelp.test.ts` is a table over real BN items (flashlight, heavy-duty
flashlight, headlamps, UPS, smartphone, exo-suits, power armor, Glock 19, S&W 619, bows,
crossbow, magazines, batteries). It also covers example order, every failure mode, the UPS draw,
and the memory's scan / save / load / stale pile. Real input: `tools/realinput.ts --only
reloadhelp` (a flashlight with no battery, `r`, look at a pile of light batteries, `r` again, hover
the hotbar slot). Screenshots: `docs/screenshots/wave3/reload-help/`.

## Reading: field notes (the reading minigame)

In BN, reading a skill book means picking "read", then waiting. Here a chapter is 2–8 real
seconds, and leveling a skill from a book takes about 20 chapters, so 1–3 minutes of watching a
bar. Now reading is also an **optional, light minigame** (in the spirit of Skyrim's lockpicking)
that **teaches Cataclysm** as you go. "Field notes" questions come from the game's own data, so
they're always correct and nobody has to write them by hand.

**The loop.** While you read, a small card shows up up-and-right of the crosshair with a question
about what the book teaches and 3–4 answers. Click the right one (or press 1–4): "Right!", and
the chapter jumps forward ("+3 min of reading · +practice"). Miss: the card marks your pick (red,
struck out) and the right answer (green), says why ("You need an acetylene torch as a tool for a
charcoal smoker."), and the next question waits about 5 s. Reading goes on underneath either
way, so ignoring the card costs nothing. No skill loss, no book damage.

| Screenshot (1600×900, GPU, half-size JPEG) | Shows |
|---|---|
| `docs/screenshots/wave3/reading/1_question.jpg` | A cookbook question by the crosshair; the reading card below |
| `…/2_right.jpg` | Right answer: "+3 min of reading · +practice", the chapter bar jumped |
| `…/3_wrong.jpg` | Wrong answer: the pick struck out, the right one green, why, "Next note in 5 s" |
| `…/4_mouse.jpg` | After a left click: the card has the cursor (gold outline), hovering an answer |
| `…/5_zombie.jpg` | A zombie in view: the reading stops and the card goes with it |
| `…/6_skim.jpg`, `…/7_skim_hit.jpg`, `…/7b_skim_miss.jpg` | The Skim variant: terms drift through the lens; a catch; filler grabbed |
| `…/8_known.jpg` | "You know everything Cooking on a Budget teaches. Skim it?" |

### Variants (Options → Reading, `?reading=`)

1. **Field notes** (`quiz`, default): as above.
2. **Skim** (`skim`): a strip of text drifts right to left through a lens. The key terms are the
   book's recipe names and the answers to its questions, underlined among filler (common words
   and words from the book's description). Press 1 while a key term is in the lens, or click one
   anywhere in the strip: "+2 min of reading". Grab filler and "Lost your place…": the strip greys
   out for 3 s. It's a timing game rather than a knowledge game, but you still see the book's
   vocabulary (the recipes it holds) go past.
3. **Off** (`off`): plain BN reading, as before.

### What gets asked: templates by skill

Every book draws from weighted templates: its **recipes** first (any book with `book_learn`
entries), then its **skill's** own. Martial-arts manuals use their style plus the melee templates.

| Template | Skills | Example (real output) |
|---|---|---|
| `recipe_uses` | any book with recipes | "Which of these goes into making liver & onions?" Grapes · **Onion** · Spaghetti marinara · … |
| `recipe_quality` | recipes with tool qualities | "Making condensed milk takes a tool for food cooking. Which of these will do?" Kris · Electric polisher · **Cast-iron pot** ("food cooking 3, needs 3") |
| `book_makes` | recipes | "Which of these does Bon Appetit show you how to make?" Agar · **Condensed milk** · Pork stick |
| `recipe_hardest` | books with ≥4 recipes | "Which of these takes the most skill to make?" Makeshift stethoscope · **Antiseptic** · Rehydration drink · Saline solution |
| `quality_item` | cooking, survival, traps, fabrication, tailor, mechanics, driving, electronics, computer, first aid | "Which of these is a tool for jacking?" Folding knife · RM42 fighting knife · **Scissor jack** · Nail bomb |
| `spoils_first` | cooking, survival | "Which of these goes bad first?" Raw potato · **Cake** ("about 2.2 days") · Chili pepper |
| `never_spoils` | cooking | "Which of these keeps without spoiling?" |
| `heal` | first aid, survival | "Which of these stops bleeding?" / "…disinfects a wound?" Antiseptic · GHB · Weak mixed alcohol · Inhaler |
| `battery_fits` | electronics, computer, mechanics | "Which battery fits a flashlight?" **Light battery** · Medium battery · … (the same `magazines` well the reload helper reads) |
| `needs_power` | electronics, computer | "Which of these runs on batteries?" |
| `engine_fuel` | mechanics, driving | "What does a large 1-cylinder engine run on?" Diesel · Coal · **Gasoline** · Battery |
| `car_needs` | mechanics, driving | "Besides an engine, which of these does a car need to drive?" Windshield · **Drive by wire controls** · Cargo rack · … |
| `gun_ammo` | gun, pistol, rifle, shotgun, smg, launcher, archery | "What does the Remington 1100 competition fire?" Wooden small game bolt · **Shotgun slug** · 5.56 tracer · Signal flare |
| `gun_magazine` | guns | "Which magazine fits the Glock 19?" |
| `gun_skill` | pistol, rifle, shotgun, smg, launcher, archery | "Which of these do you shoot with the Shotguns skill?" **Remington 870 Wingmaster** · Glock 17 · … |
| `weapon_class` | bashing, cutting, stabbing, melee, unarmed, guns | "Which of these is one of the Two-handed Axes?" Forked spear · … · **Battle axe** |
| `damage_most` | bashing, cutting, stabbing, melee, unarmed, throw | "Which of these does the most cutting damage in melee?" Throwing knife · **Nodachi** (47) · Bullwhip |
| `ma_technique`, `ma_style`, `ma_weapon` | martial-arts manuals, unarmed, melee | "Which of these is a Karate technique?" / "Which martial art teaches Knifehand strike?" / "Which of these weapons can you fight with in Barbaran Montante?" |
| `price_most` | barter, speech | "Which of these would a trader value most these days?" (`price_postapoc`) |
| `encumbrance_most` | dodge, swimming, tailor | "Which of these hampers your movement most when worn?" |
| `swim_gear` | swimming | "Which of these keeps you afloat?" **Flotation vest** · Zentai · Loincloth · … (FIN / FLOTATION / SWIM_GOGGLES / WATERPROOF) |
| `throwing` | throw, traps | "Which of these is made for throwing?" (BN `NPC_THROWN`) |
| `material_of`, `made_of` | most skills, as a fallback | "What is hunting cap mostly made of?" **Wool** · … / "Which of these is made of rubber?" |

Difficulty follows the book's level (`max(required_level, max_level)`). Beginner books (≤2) get
3 options, items that actually spawn (BN item-group weights), and comparisons won by at least
2.5×. Mid books (≤5) get 4 options and a 1.8× margin. Advanced books get 4 options, any item,
and a 1.35× margin.

**Always correct.** Each question carries its rule (option → right or wrong), checked over the
real data:

- exactly one option passes the rule;
- the player sees *names*, and BN reuses names, so an option is only offered when **every** item
  (material, technique, part…) of that name agrees with the rule;
- recipes are judged together with every recipe of the same display name (you can't tell the
  variants apart);
- `cooks_like` stand-ins count as ingredients;
- comparisons need the margin above.

`tests/readquiz.test.ts` runs every template over every quiz book in BN (233 books: 200 skill
books, 32 martial-arts manuals, 1 recipe-only book). It re-checks all of the above independently
(each option's name resolved back to every thing that bears it), and requires ≥8 distinct sound
questions per book. Fun-only books (novels, holy books, comics: 83) have no quiz and read exactly
as before. `tools/readquiz-dump.ts <book ids> [--all] [--template id]` prints samples.

### Rewards and tuning (`src/game/readquiz/session.ts` TUNING)

| | Value | Why |
|---|---|---|
| First question | 1.5 s after you start | settle in first |
| Right answer | skips the reading that would take **2.5 real s at ×1**, at most 60% of a chapter; next question 1.1 s later | the chapter's own clock warp converts it to game minutes ("+3 min"), so it's the same feel for a 5-minute magazine and an hour-long textbook |
| Practice | +1 × (level+1) BN exercise points per right answer | inside BN's caps: nothing once the skill reaches the book's max level, and never a level-up by itself (stops one point short; the level comes at a chapter's end, as BN's `readBook` does it) |
| Wrong answer | right answer shown 2.6 s, next question 5 s after the miss | you learned it; a short pause, no penalty |
| Skim hit / miss | 2.5 s of reading / 3 s blanked strip | |

Measured over whole "read until you gain a level" runs, three seeds each
(`tests/readquiz_game.test.ts`, simulated players):

| Book | Plain | Good quiz (right, ~2 s per question) | Careless (1 s, half wrong) | Good skimmer |
|---|---|---|---|---|
| Bon Appetit (cooking 0→1) | 133 s | 71 s (**1.9×**) | 97 s (1.4×) | 98 s (1.4×) |
| The Big Book of First Aid (0→1) | 125 s | 65 s (**1.9×**) | 91 s (1.4×) | 86 s (1.5×) |
| survival textbook (3→4) | 139 s | 76 s (**1.8×**) | 104 s (1.3×) | 91 s (1.5×) |

So a good player reads about twice as fast, not instantly. The test fails outside 1.6–2.6×.

### "You know this. Skim it?"

When your skill is already at the book's max level, or a recipe-only book's recipes are all
memorised, the card asks first: **[1] Skim it (done in a moment)** or **[2] Read it anyway**.
Skimming ends the chapter at once and resolves it as BN would:

- the recipes your skill can follow are memorised;
- the book's morale applies;
- no skill is gained, since you're past what the book teaches;
- the run stops ("You finish reading.").

### Input and mouse-look

Reading is a stand-still job, but it shouldn't take the mouse away:

- **Number keys 1–4** answer while a question is up and no menu is open. At any other time they
  do what they always do (the hotbar). Skim: 1 grabs.
- **The mouse** stays mouse-look until you engage. A left click while a question is up never
  attacks: it frees the cursor and the card takes the clicks (gold outline, "click an answer").
  Clicking an answer, clicking off the card, or pressing a movement key gives mouse-look back
  straight away, with no extra click. Without pointer lock (the free-cursor menu option, or
  automation) the buttons are simply clickable.
- **Moving** still stops reading, engaged or not. Interrupts (a hostile in view, getting hurt,
  dangerous cold) end the reading, and the card goes with it.
- The card never advertises Esc. The keys are drawn as keycaps, so the 1 never reads as an l
  in the pixel font.

### Fast-forward (×2–×16, `src/game/timewarp.ts`)

**The quiz pauses above ×1.** At ×2 and up, no new questions appear. A question already up hides
and waits ("Field notes wait while time runs fast."), and its timers stop. Back at ×1 it's there
again. The jump itself is game time (`skipReading`), so it would work at any speed. The reason
for pausing is attention: fast-forward means "get this over with". The quiz is the *other* way
through a book faster: a good quiz player is roughly ×2 fast-forward, earned. Dropping to ×1
when a question appears would fight the player's choice. The game's own pauses (tactical pause,
a menu that stops time) also freeze the timers, so a cooldown can't be waited out for free. A
question already on screen can still be answered then.

### Code, tests, gaps

- `src/game/readquiz/questions.ts`: the generators, pure (GameData + book + Rng → Question).
  Vehicle questions need vehicles.json, which the UI hands over (`setQuizVehicles`) once loaded.
- `src/game/readquiz/session.ts`: the quiz and skim state machines, real time, no DOM. TUNING
  lives here.
- `src/game/readquiz/controller.ts`: one session per reading run, across chapters. Rewards,
  the skim offer, freezing.
- `src/ui/readquiz.ts` / `.css`: the card, Options → Reading, keys, click-to-engage, and
  `cdda.readquiz.state()` for QA.
- Hooks in `src/game/reading.ts` (additive): `skipReading(host, gameSeconds)` is the progress
  jump (never past a chapter's end, so the chapter still completes through the activity), and
  `readingPractice(c, book, points)`.
- Tests: `tests/readquiz.test.ts` (generators over every book), `tests/readquiz_game.test.ts`
  (right/wrong/cooldown, practice caps, no skipping past a chapter, the offer, interrupts,
  fast-forward and pause freezing, skim hits/misses/clicks, the ×2 tuning).
- Real input: `tools/realinput.ts --only readquiz,readskim,readknown --gpu`. These open a
  cookbook with R, answer right with the number key (the chapter jumps), answer wrong (marked,
  about 5 s cooldown), click an answer with the mouse after engaging, then a zombie interrupts.
  They also play the Skim variant (catch and miss) and the "Skim it?" offer.

Gaps:

- Questions are generated, so some are odd but true. A "tool for cutting" might be a replica
  sword when no kitchen knife was drawn. Distractors are plausible, never curated.
- A few templates lean on data flags whose meaning a player can't check in-game yet (`NPC_THROWN`
  for "made for throwing").
- `car_needs` encodes BN's driving rule (controls, wheels, a tank) by hand. Every other template
  reads data only.
- No streak bonus and no sound yet. The card doesn't scale its text beyond the ui2 font size
  setting.
- The skim variant's filler is generic; it could use the book's own snippets.

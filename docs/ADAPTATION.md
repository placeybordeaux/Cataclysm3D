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
| 10 | **Looking at a cupboard from up close hits the wrong one.** At about 0.3 m the crosshair card showed the empty neighbour ("Empty"), and `e` said "The cupboard is empty" three times while the one in front held 10 jackets. `g` (area loot) worked. | quick-loot targeting | Open: needs `lootTargetAt` to prefer the tile in front (`cdda.frontTile`) when the ray hits a neighbour's top face. Furniture shape is another area's work, so this is left for them. |
| 11 | **The quick-loot card's bars look like the container's fill.** "Cupboard / Empty / 635 ml / 6.5 L / 3.25 kg / 45 kg" shows your own carried volume and weight next to the cupboard's name. | quick-loot card | **Fixed**: a "You carry" line above the bars. |
| 12 | **"Took 2 emergency jackets. 1 left behind." then "8 left behind"** in the same toast: one counts stacks, the other items. | take all | **Fixed**: both count items ("Took 2 emergency jackets. 8 left behind:"). |
| 13 | **Take-all on a shelter cupboard grabs 2 of 10 identical jackets.** A newcomer wanted to wear one. Double-click in the inventory wears it, but nothing suggests that when it's cold. | first loot | Open: a "Wear" button on clothing in the quick-loot card when you're chilly. |
| 14 | **The eat menu lists the bottle and the water inside separately**, with CDDA charge notation "(2/2)". | eat menu | Open (inventory area). |
| 15 | **Drinking one bottle when you're not thirsty makes you "Bloated"** (BN-faithful: excess quench). | needs | Now shown as a dim "Full" on the hunger icon. The rule is kept. |
| 16 | **Wait and Sleep are old terminal-style menus** in an otherwise ui2 game. | menus | Wording fixed. Porting them to ui2 is open. |
| 17 | **Time runs fast while you read the first toasts**: 08:01 → 08:23 in about 40 s of looking around. | clock | By design (real-time clock scale). Worth a "day length" note in the Start window. |

Not covered by this run: the first zombie fight and crafting a first weapon were only started,
not played through (combat feel is its own area). The weather and ring fixes apply to both.

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

### Switches

| What | Option | URL |
|---|---|---|
| Title screen | Options → Title screen: Big buttons / Side column / Classic row | `?title=center\|side\|classic` |
| Activity progress | Options → Activity progress: Crosshair ring / Bottom bar / Both | `?actui=ring\|bar\|both` |
| Tips | Options → Tips: Adapted / Cataclysm originals | — |
| Climate | Options → Climate: Mid-spring start (BN) / Early spring (old) | `?climate=bn\|old` |

Screenshots: `docs/screenshots/wave3/adaptation/`.

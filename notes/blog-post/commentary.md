# Commentary from the build

Quotable moments from the transcripts, verbatim (quoted spans are exact; `…` marks cuts). Times are
PDT. Attribution: **the user**, **the lead** (the coordinating Claude Code session), or **a subagent
(area)** using the agent's task title. Session 1 = Sep 28 22:25 → Sep 29 22:43; session 2 = after the
`/clear`. To find or re-verify any quote: `python3 scripts/grep_transcripts.py '<phrase>'`.

---

## 1. Fidelity bugs: when the port disagreed with Cataclysm

These are the best blog material: each is a case where reading Cataclysm's JSON "the obvious way"
was wrong, and the fix came from reading the C++.

### The weather was always a snowstorm
> "The biggest finding is a real bug: **with BN data the weather was always a snowstorm.** BN's
> `weather_type` entries keep their thresholds in a `requirements` object. `weatherConditions` only
> read DDA's `condition` and `required_weathers`, so every weather type matched and the last one,
> `snowstorm`, won on every refresh. That explains the "Snowstorm -7 °C on a green spring morning".
> It also meant the whole game ran in snowstorm col[d]…"

— a subagent (new-player adaptation pass), Sep 29 23:45, session 2. A leftover from the DDA→BN
switch: DDA and BN spell the same concept differently, and a matcher that finds no conditions
matches everything.

### Flashlights: first 1000× too hungry, then dark
> "**Cause:** Bright Nights gives item power draw in milliwatts, but our code read it as watts, so
> everything electric drained 1000× too fast. Your flashlight (10 W) was emptying a full battery in
> about 10 game seconds, well under one real second."

— the lead, Sep 29 18:08, session 1, answering the user's "flashlights are running out of power
almost immediately". Just before, while fixing it:

> "The existing test was written around the bug: its comment literally says "10 kW power_draw: 1 kJ
> per 0.1 s". I'll correct it to BN's real rate."

— the lead, Sep 29 18:08. And the next night, a second, unrelated flashlight bug:

> "**Flashlights gave no light at all.** Bright Nights stores item light under a different field than
> the one the code read. So a flashlight lit nothing, and `F` said "You don't have a light source"
> while you carried a phone with a flashlight app."

— a subagent (new-player adaptation pass), Sep 30 00:26, session 2.

### 1.4-metre tyres
> "Wheel sizes were a bug I found: BN gives wheel sizes in cm, but they were read as inches, so tyres
> were 1.4 m tall and poked through the bonnet into the view."

— a subagent (driving camera & visibility), Sep 29 11:09, session 1.

These two unit bugs became a standing rule in `docs/STATUS.md`: "**Units come from BN's C++, not
guesses.** Two big wave-2 bugs were unit mistakes: `power_draw` is mW (flashlights died in a second),
wheel sizes are cm (1.4 m tyres)." The wave-3 vehicle agent then reported "Wheel size comes from BN's
rim diameter in cm (checked against the C++ loader)."

### Broken windows drawn as floor decals
> "Broken windows and doors were really mis-classified. CDDA drops their WINDOW/DOOR flags, so they
> were drawn as a floor decal or a fence pane. That's where the floating blue squares came from."

— a subagent (furniture and props models), Sep 30 00:38, session 2.

### Nothing could be dug, anywhere
> "**Nothing could be built on grass or dirt.** BN decides whether ground can be dug from the
> terrain's `digging_results`; our code checked DDA's `DIGGABLE` flag, which only 2 BN terrains still
> have. So barricades, pits and graves were "too hard to dig" everywhere."

— a subagent (new-player adaptation pass), Sep 30 02:19, session 2.

### Fires that went out with the wood unburnt
> "**Fires going out with the wood unburnt** (BN fidelity, `src/game/fields.ts`). Whenever time was
> sped up (waiting, crafting, eating), only 8 turns a frame were simulated and the rest decayed in
> bulk, which ignores fuel. Fires now get their turns one at a time within a budget. Fuel also rounds
> the way BN does, and fires in a fire ring or brazier now burn at BN's contained rates, which the
> port was missing."

— a subagent (new-player adaptation pass), Sep 30 04:40, session 2. Forty minutes earlier, mid-hunt:

> "BN uses `roll_remainder(frd.fuel_produced)` (random rounding), while the port uses `Math.round`,
> so a small wood fire's fuel always rounds to 0. I'll check BN's `can_burn` before fixing."

— the same subagent, Sep 30 04:16. A real-time-specific bug: turn-based Cataclysm never has to
"fast-forward" a fire.

### Worlds that paved over the start
> "**Some worlds started you on a road, not in the shelter.** On seed 743667900 a road was built over
> the shelter's map tile, so you woke next to a zombie."

— a subagent (new-player adaptation pass), Sep 30 00:26.

### v1's tileset and data surprises
> "**Black blobs hanging off every tree:** UltiCa's top-down drop shadows, stood upright as
> billboards." … "**Loot silently lost:** item groups treated `container-item: "null"` as "wrap in the
> null item", so pills, cheese and seasonings vanished."

— a subagent (QA1: first-hour playtest), Sep 29 01:09, session 1. A 2D tileset's baked-in shadows
make no sense once a sprite stands up in 3D.

### The levitating tough zombie
> User: "There's also a tough zombie just levitating in the game right now"
>
> The lead: "Fixed and live in your tab. Monsters could walk off roofs and upper floors onto open air,
> and nothing made them fall."

— Sep 29 19:08 / 19:10, session 1.

### "It sounds like a gun"
> User: "it's super hard to tell why I am missing with my long bow, also it sounds like a gun and has
> the mussel flash lol"
>
> The lead: "Good catches, and they're related. Bows go through the same hitscan firearm path, so they
> get the gunshot sound and muzzle flash. Ranged misses also only report hit or miss, with no reason,
> while melee shows one."

— Sep 29 17:09, session 1.

### Clouds and a shader precision bug
> "The cause was the random-number hash in the sky shader: it used `sin()` of large numbers, and the
> GPU rounded neighbouring cell corners differently, so the noise jumped a[cross cells]…"

— a subagent (POLISH B: render issues), Sep 29 13:53. Same report: "**Green "Z":** it was a zombie
soldier with no tileset art. 72 monsters like it now get a stand-in sprite".

---

## 2. Lessons the team wrote down

### "Real input only"
The first human playtest found in minutes what three QA agents had missed:

> User: "when I try and run (shift) forward (w) it goes to the wear menu. Also interact says to hit
> esc to get out, which then makes the mouse not be captured anymore."
>
> The lead: "Both are real bugs, and the second is a design flaw. … The QA agents drove the game
> through the debug API more than through real input, which is how these slipped through."

— Sep 29 07:17. Five minutes later: "Earlier QA drove the game through debug helpers rather than real
keyboard and mouse input, which is how these got past three playtest agents."

The UX review agent then found why automation couldn't see it:

> "puppeteer's own Escape skips the browser's shortcut handling, so it never releases pointer lock.
> That is how the original Esc bug got past earlier QA."

— a subagent (UX review), Sep 29 08:20. It rebuilt testing around a real headed Chromium on Xvfb
driven by xdotool. Later, even a real-input check can lie:

> "“A click on the paused view only resumes (no attack)” also relied on a log message, so it passed
> vacuously. With the attack-event check it showed a real regression"

— a subagent (FIX: three real-input regressions), Sep 29 12:02.

### Item conservation as an invariant
> User: "…some bugs (item duplication when unloading a bag is pretty bad)"
>
> The lead: "The unload-bag duplication is exactly the kind of bug that should never ship, and it goes
> on the fix list first."

— Sep 29 08:37. The inventory agent's post-mortem, three hours later:

> "I fuzzed the `v1-dda` build, checking every item's count after each UI action. I couldn't replay
> the playtester's exact session, but I found and reproduced these paths: - **No action checked where
> the item was.** … - **A wielded bag's contents were listed twice** in `i` … This is most likely what
> the playtester saw."

— a subagent (INVENTORY model v2 on BN), Sep 29 10:34. Result: one `moves.ts` path for every item
move, randomized tests of thousands of moves, and a lint test that fails if anything bypasses it.

### Parallel worktrees, lead merges
From `docs/STATUS.md` ("Rules that paid off"): "**Parallel agents in worktrees, small additive edits to
hot files, lead merges.** When two branches rewrite the same flow, send the merge back to the agent
that knows it." In practice:

> "That branch also conflicts in the shared test script, because the inventory screens changed the
> same scenario block. I'll send it back for the merge."

— the lead, Sep 29 12:02.

> "Merging hit a conflict in the real-input test runner: the collision and stairs agents had each
> registered a new scenario. I kept both. Frame time was unchanged."

— the lead, Sep 30 11:14, session 2.

---

## 3. Being wrong, and saying so

> "The fix is live in your tab, but it's for my best guess at the cause, which I couldn't reproduce
> directly. **What I believe happened:** any held W/A/S/D cancelled an activity on the very next tick,
> even a key you were already holding when you pressed `e`."

— the lead, Sep 29 22:32, session 1, on the user's "I try to start a fire in a fireplace and it just
says I stopped trying".

> "The **25 ms house-view spike** turned out to be the benchmark's own setup, not the game."

— the lead, Sep 30 04:29, session 2.

> "There were three causes: 1. **Test harness:** the suites reused a rifle that an earlier scenario
> had nearly emptied. … 2. **Real bug — arrows flew about 0.2 m high:** the drawn eye rides the ground
> relief … but free-aim arrows launched from a flat 1.6 m. … 3. **Test harness:** …"

— a subagent (aim-based combat skill model), Sep 30 02:36.

> "**5) needs one more answer.** I asked an either/or and you said "yes", so I can't tell which you
> meant"

— the lead, Sep 30 10:14, session 2, after the user answered eight vehicle-design questions in one
message.

> "BN's source shows unclean water carries no disease, so the journal's "can make you sick" was wrong"

— a subagent (new-player adaptation pass), Sep 30 04:40: the port's own tutorial text had invented a
rule Cataclysm doesn't have.

On the first night, the lead's honest caveat about the art direction it had been asked to imitate:

> "**Graphics:** Shadowglass's developer hasn't published their method, so I copied what's visible"

— the lead, Sep 29 03:51. A day later the user pushed back ("it's not just flat 2d sprites"), and
after researching it properly:

> "**Shadowglass.** It isn't flat sprites, and it isn't voxels either. It uses ordinary low-poly 3D
> models with fixed-size pixel-art textures and no smoothing, lighting in hard steps with a second
> light so shapes don't flatten, choppy low-framerate animation, and different versions of things for
> close up and far aw[ay]…"

— the lead, Sep 30 05:11, session 2.

The lead also critiqued its own agents' art; this brief went back to the characters agent:

> "**The sprite projection makes camo noise.** Projecting the 32x48 sprite onto box faces turns
> zombies and NPCs into speckled mush. … **Silhouettes are too Minecraft.**"

— the lead to a subagent (3D characters), Sep 29 23:49, session 2.

---

## 4. Design debates

### Faithful vs fun
> "A lone character in town died within about a minute several times. That's faithful to CDDA but
> harsh in real time, so I left it as a balance decision."

— a subagent (QA3), Sep 29 03:50. The user's answer, twelve hours later, set the whole v2 direction:

> "The new goal here is to bring some of the things that made the game special to a whole new
> audiance that can't get over the look/feel of the game running as the tiles based version. This
> means letting go of the style of menu, allowing for things like drag and drop, etc."

— the user, Sep 29 08:37.

### Hidden dice in first person
> "**Defence was hidden dice.** Blocking was a secret roll and dodging automatic, so the player had
> nothing active to do against a blow."

— a subagent (COMBAT FEEL overhaul), Sep 29 09:18. The user went further for wave 3:

> "making a player miss their shot because their skill isn't high enough really doesn't feel good in
> FPV. Instead could we balance it to e.g. make their crosshair bob and weave more when they have low
> skill … We don't need to keep with all of the stuff that already exists here, this is a different
> flavor almost like a TV adaptation of a book. We should modify the source matieral to fit the
> medium."

— the user, Sep 29 22:49. BN's dice model stayed as an option (`Options → Aim model → dice`).

### Onboarding: tutorial or unlocks?
Offered "Interactive tutorial start (Recommended)", the user wrote their own answer instead:

> "Let's actually take some notes from modern game dev and introduce some achivements and dynamic
> unlocks. Hitting the player with a full character creation screen at first is overwhelming, maybe
> unlock new characters as the player hits achivements"

— the user, Sep 29 08:41. Follow-up question → "Persistent unlocks, fair runs": sidegrades only.

### Deathmobiles
> "**Short answer:** "Deathmobile" is not a system, item or book in either game. It is a
> player-culture word that shows up in DDA's data only twice, both as flavour text."

— a subagent (deathmobile lore research), Sep 30 10:01. Its sibling surveying other games:

> "**The mobile base is the big fantasy.** … This is CDDA's signature (RVs and "deathmobiles" full of
> kitchens, beds and solar panels). A first-person 3D version where you walk inside your rolling base
> and use its workstations is the strongest differentiator on offer."

— a subagent (3D games vehicle building survey), Sep 30 10:01. The user chose "B plus E" (a ladder of
chassis sizes you adopt and bolt parts onto), with "keeping with the theme of stuff taking some time,
yeah it takes time".

### Visual variants instead of one guess
The user's standing preference ("build multiple approaches and an easy way to switch") shows up
everywhere. When they said driving was "SO flat, it feels extremely retro", the lead replied with four
switchable looks:

> "**A. Crisp** … **B. Voxel** … **C. Terrain** … **D. Full:** all three together, likely the new
> default."

— the lead, Sep 29 10:44. The user later picked their defaults from the in-game gallery:
"voxel, clear, 168m, toon, palette, stable, 3d models, styled skins, sprites, 2d art, world-fixed
cards, modelled, painted, on, models, modelled bodies, true to life, sway" (Sep 30 10:32).

---

## 5. Small moments

- "The render looks strong, and top-down is lovely." — the lead, Sep 28 23:08, 43 minutes in.
- "Worldgen is merged. The game now boots into a real CDDA evac shelter (the brick building with
  lockers and benches) in a generated town, rendered in the pixel-art style." — the lead, Sep 28 23:10.
- "I'd say you did an extremely impressive job the first run" — the user, Sep 29 08:37.
- "Followers: recruiting one early is effectively out of reach (a 5% persuasion chance, as in CDDA)."
  — the lead's v1 known-gaps list, Sep 29 03:51.
- "I left out BN's dexterity-based spill roll: losing the fuel you came for to a hidden roll teaches a
  new player nothing." — a subagent (vehicle models), Sep 30 04:06, on gas pumps.
- "Bonnets don't open: Bright Nights has no bonnet part, so there's nothing to hook them to." — the
  lead, Sep 30 01:50.
- "Wrecks can't sit at odd angles, because the map data only places vehicles at right angles." — the
  lead, Sep 30 01:50.
- "You've hit your session limit · resets 3:40am (America/Los_Angeles)" — every wave-3 agent at
  02:18, Sep 30. They resumed after the reset.

---

## 6. The long tail (Oct 1 → Oct 26)

After the first snapshot the pace changed: the user played one long game and reported what felt
wrong, and the lead turned each report into a subagent. These sessions are not split into
"session 1/2"; dates say when.

### A tank with a car's tyres
> "Oh I just stumbled upon an abrams tank, it doesn't have the 3D model applied to it"

— the user, Oct 10 09:04.

> "**Why it looked wrong:** the game treated it like a home-made frame vehicle. Each of its 22 track
> pieces was drawn as a 1.6 m car tyre…"

— the lead, Oct 10 09:19. The same afternoon the user asked "how do I use the turrets on the tank?";
the lead answered "**Turrets:** you can't use them yet." An overnight agent built them, and by 00:21:
"Your view moves the turret: it turns and raises the barrel toward where you look."

### Why kiting was easy
> "it seems like it's really not that hard to fight a mob of zombies by kiting them with a melee
> weapon, which isn't my memory in the 2d turn based version. Why is that?"

— the user, Oct 12 12:46.

> "**1. Swinging doesn't slow your walking.** In the 2D game, every swing spends roughly a turn you
> could have used to move. A speed-100 survivor gets about 10 actions for every 7 a zombie gets, so
> a "hit, step back" pattern loses ground and the zombie keeps hitting you."

— the lead, Oct 12 12:47. The fix: right mouse readies a weapon, and only a readied weapon swings.

### The recipe for a fart
> "Okay and the sound they make while attacking straight up sounds like a fart, what's up with that?"

— the user, Oct 12 14:31.

> "I can't listen to it myself, so I'll render the old and new sounds to WAV files you can play, and
> check their spectra to confirm the low buzz is gone."

> "The zombie wind-up was a synthesised low buzz (85–120 Hz) that slid upward with a 9 Hz wobble.
> For hulk-sized blows it was played slower, which made it lower still. That's pretty much the
> recipe for a fart."

— the lead, Oct 12 14:33 and 14:35.

### Pixel art, not voxels
> "I think we're missing a lot when it comes to thinking of it as a love letter to 2D pixel art made
> 3D, not voxel."

— the user, Oct 12 17:45, asking for a subagent with Blender installed. Its honest verdict on
swapping to the sprite at a distance, relayed by the lead at 18:51: "…the sprite is drawn side-on,
facing right, but in first person most zombies walk towards you. So a far horde becomes a row of
side-views that turn to face you at 30 m." The models stayed behind a switch.

### Buildings popping in
> "I am still seeing stuff pop into existance, is this due to a world sim limitation or a rendering
> limitation"

— the user, Oct 15 18:59. The lead measured it (rendering, at the draw-distance edge) and proposed
"Real low-poly far proxies. This is what you asked about: the same idea as the zombie LOD and
Minecraft's Distant Horizons mod." Five rounds of play followed ("a radio tower looks like a tall
large building and then totally transforms when I get close"), ending in a QA pass whose commit
title is the lesson: "proxies match the real geometry tile by tile; stand-ins were the tall boxes".

### Vehicle feel
> "generally vehicle physics should feel fun and relatable, going for a GTA 3 or GTA vice city feel
> that is video gamy, but fun."

— the user, Oct 9 19:42. It became a standing rule: crashes and driving aim for arcade feel, not
BN's physics.

### Saying what wasn't tested
> "I tested it in a headless browser (software rendering, not a real GPU) on a staged scene, not
> your actual drive, so it's worth a night drive past some buildings to confirm."

— the lead, Oct 13 13:53, on the headlight flicker fix.

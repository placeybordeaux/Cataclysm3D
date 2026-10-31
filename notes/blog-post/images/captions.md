# Blog image suite: captions

Everything numbered 01–63 was rendered in the engine on 2026-09-30 from game code at commit
`e7e9bf1` (branch `bn`, wave 3 plus walkable stairs), world seed 1, with the **factory default
look** (the user's picks from the style gallery: voxel style, clear haze, 168 m draw distance,
toon form lighting, palette grading, 3D creature models, modelled vehicles). The machine's RTX 5080
rendered them through headless Chromium (ANGLE/Vulkan) at 1920x1080. Files are half-size JPEGs
(960x540, q82). `-hero.jpg` files are the full-size 1920x1080 frames (q85).

**Regenerate** from the repo root inside `nix-shell`:

```
~/claude-stuff/bin/heavy --kind gpu --mem 2 --name "cdda3d blog shots" -- \
  npx tsx notes/blog-post/scripts/blog-shots.ts --gpu            # all shots, or --only id1,id2
notes/blog-post/scripts/evolution.sh                              # 70-79 and 51 (git history + composites)
notes/blog-post/scripts/contact-sheet.sh /tmp/sheet               # review sheets
```

The shot definitions are in `scripts/shots.js`: each one is a few lines of `cdda.*` debug setup
(teleport, clock, weather, spawns). Most reuse the doc screenshot viewpoints in
`tools/look-views.js`, `char-views.js` and `vehicle-views.js`, the same ones the in-game style
gallery (`/?gallery`) uses. Scenery shots hide the HUD and the first-person hands. Shots 40–44 keep the HUD.
The tileset views (61, 63) come from `scripts/tiles-view.js`, which redraws the live map tile by
tile from the same UltiCa atlas into a 2D canvas.

Seed-1 landmarks: the Evac Shelter at OMT (53,39) outside Holden; the refugee center at
(28,43); a microlab surface building at (54,47); a cabin at (84,42) near Needham.

## Places

### 01-evac-shelter-outside.jpg
**Caption:** The Evac Shelter, where every Cataclysm game begins, seen from outside on a spring morning.
**Shows:** BN's `shelter` overmap special (`shelter_west`), built from BN's own mapgen JSON: the long low building with its double doors and a parking strip.
**How:** `teleportOmt(53, 39, 0, 2, 16)`, 09:30, looking east. Shot `01-evac-shelter-outside`.

### 01-evac-shelter-outside-hero.jpg
**Caption:** The Evac Shelter from outside (full-size hero).
**How:** The same frame at 1920x1080.

### 02-evac-shelter-inside.jpg
**Caption:** The first thing a new survivor sees: benches and lockers inside the shelter.
**Shows:** The shelter interior from BN's mapgen, with its lockers (searchable for starting supplies) and benches.
**How:** `lookView('shelter')`: the start tile at 11:00.

### 03-town-street.jpg
**Caption:** A residential street in Holden on a spring afternoon: brick bungalows, hydrangeas and parked cars.
**Shows:** A BN-generated town. The houses, sidewalks, shrubs and trees are the tileset's terrain placed by BN city mapgen.
**How:** `lookView('street')`, the docs' standard comparison viewpoint, 15:30.

### 03-town-street-hero.jpg
**Caption:** A residential street in Holden (full-size hero).
**How:** The same frame at 1920x1080.

### 04-refugee-center.jpg
**Caption:** Inside the Refugee Center lobby.
**Shows:** BN's `evac_center` special. The refugees are BN NPC templates.
**How:** `cdda.teleportRefugeeCenter('lobby')` (stands beside a `refugee_beggar1`), 10:30.
**Note:** A view from outside the fence (`'outside'`) only showed a field and a fence, so the lobby was used instead.

### 05-lab-entrance.jpg
**Caption:** A science lab's surface building: a beige concrete block with glass doors and a row of garages.
**Shows:** BN's `microlab_generic_surface` (the 4x4 microlab special).
**How:** `teleportOmt(54, 47, 0, 12, 23)`, 14:00, looking north.

### 06-lab-inside.jpg
**Caption:** Five floors down in a lab, a flashlight picks out a workstation and the loot on its counter.
**Shows:** A BN lab level (z = −5) with its computer console and counters.
**How:** `cdda.faceLabLoot()`, which stands two tiles from the highest-value loot pile (here a science ID card), with the flashlight on.

### 07-forest-cabin.jpg
**Caption:** A log cabin half-hidden in the woods near Needham, late afternoon.
**Shows:** BN's `cabin_3` special.
**How:** `teleportOmt(84, 43, 0, 12, 2)`, 16:00, looking north.

### 08-top-down-town.jpg
**Caption:** The town centre from the top-down camera, with the roofs cut away to show the rooms.
**Shows:** The tile-based world seen from above, closest to how Cataclysm itself looks.
**How:** `lookView('top')` with `rig.topDistance = 75`. The top camera looks down at 60°, not straight down.

## Creatures

### 10-horde-near.jpg
**Caption:** A mixed zombie horde shambling up the street toward you.
**Shows:** 12 zombies: zombie, fat zombie, cop, child, brute, tough, runner, firefighter, soldier and a hulk. They are 3D bodies built from boxes and painted from each monster's UltiCa sprite.
**How:** `charView('horde_near')` (spawned 4–10 m ahead).

### 10-horde-near-hero.jpg
**Caption:** A zombie horde up close (full-size hero).
**How:** The same frame at 1920x1080.

### 11-horde-road.jpg
**Caption:** The same horde 18–30 m down the road. The views that keep them readable at a distance were a wave-3 goal.
**How:** `charView('horde_mid')`.

### 12-special-zombies.jpg
**Caption:** Special zombies: a boomer, a hulk, a skeleton, and acidic, shocker and scorched zombies.
**How:** `charView('zombies2')`.

### 13-dogs-animals.jpg
**Caption:** Wildlife and worse: a squirrel, a rabbit, a giant cockroach, a giant wolf spider, a crow, a blob, a deer and a bear.
**How:** `charView('critters')`.

### 14-zoo.jpg
**Caption:** Every body plan: turrets, a riotbot, a triffid, a fungaloid, a manhack, a rattlesnake, a feral human, a moose, a horse, a zombear, a mi-go and more.
**Shows:** One monster per procedural body plan (humanoid, quadruped, insect, flyer, blob, serpent, plant, machine), chosen from BN `bodytype`, species and flags.
**How:** `charView('zoo')`.

### 15-npc-group.jpg
**Caption:** A group of survivors (NPCs). Each is painted from its BN outfit.
**How:** `charView('crowd')`.

### 16-night-zombies.jpg
**Caption:** Night on the street: two zombies and a dog caught in the flashlight's cone.
**How:** `charView('night')`.

### 17-third-person.jpg
**Caption:** The survivor in third-person view, with their 3D body painted from the clothes they wear.
**How:** `charView('third')`.

## Vehicles

### 20-armored-vehicles.jpg
**Caption:** BN's armoured car, humvee and SWAT truck lined up in a field.
**Shows:** Vehicle prototypes from BN's JSON. The wave-3 modelled bodies are picked by vehicle class and size, so the armour plating is not drawn yet. They read as an SUV, a sedan and a police van. That is a known gap (vehicles v3 is in progress), not a deathmobile.
**How:** `vehicleView('lineup:armored_car,humvee,truck_swat')`.

### 21-wreck-pileup.jpg
**Caption:** A pile-up of wrecked cars blocking a town road at dusk.
**Shows:** Seven prototypes (car, SUV, pickup, sedan, box van, sports car, police car) spawned wrecked (`status: 1`) at jumbled angles on a straight road, like BN's `police_pileup` map extra.
**How:** `roadTrip()`, then `spawnVehicle(proto, dx, dy, yaw, { status: 1, force: true })` for each car, 16:30.

### 22-drive-night.jpg
**Caption:** Driving at night: headlights sweep across a street of abandoned cars.
**How:** `vehicleView('drivechase')`: a car on a straight road at 23:12, with the headlights on and the chase camera.

### 22-drive-night-hero.jpg
**Caption:** Driving at night with headlights (full-size hero).
**How:** The same frame at 1920x1080.

### 23-drive-cockpit.jpg
**Caption:** The same drive from the driver's seat, with the dashboard gauges lit.
**How:** `vehicleView('drive')`.

### 24-parked-cars.jpg
**Caption:** A rusty box van left in town by mapgen, one of BN's vehicle spawns.
**How:** `vehicleView('street')`.

## Time and weather

### 30-dusk.jpg
**Caption:** Dusk on the same street: the sky turns orange and the first stars come out.
**How:** `lookView('street')`, then `setHour(duskHour())` (15 minutes before the real sunset for the season).
**Caveat:** `tools/look-views.js` has an empty duplicate `name === 'dusk'` branch, so `lookView('dusk')` did nothing when this was shot, and the shot does these steps by hand. Fixed the same day in `08d782a`.

### 31-night-flashlight.jpg
**Caption:** Midnight, with only a flashlight to see by.
**How:** `lookView('night')`.

### 32-rain.jpg
**Caption:** Rain on the street.
**How:** `lookView('rain')`.

### 33-snow.jpg
**Caption:** Winter: snow on the ground, bare trees and frosted shrubs.
**How:** `lookView('snow')` (`setSeason('winter')` plus snow weather).

### 34-autumn-forest.jpg
**Caption:** A forest in autumn, with red maples among the pines.
**How:** `lookView('autumn')`.

### 34-autumn-forest-hero.jpg
**Caption:** An autumn forest (full-size hero).
**How:** The same frame at 1920x1080.

### 35-winter-forest.jpg
**Caption:** The same forest in winter.
**How:** `lookView('winterforest')`.

## Interiors and screens (HUD on)

### 40-house-looting.jpg
**Caption:** Looting a house: the crosshair on a wooden rack shows "[e] Look at the items on the wooden rack (7)", and `?` marks show storage you haven't searched yet.
**How:** `lookView('house')` with the HUD kept, then `lookAt` the nearest item pile.

### 41-inventory.jpg
**Caption:** The drag-and-drop inventory: equipment paper-doll, carried items by pocket, and nearby containers. It replaces Cataclysm's text menus.
**How:** `giveItem` (backpack, jeans, hoodie, sneakers worn; crowbar, flashlight, food, and so on), then `cdda.ui2.toggleInventory()`. Time pauses while it's open.

### 42-crafting.jpg
**Caption:** Crafting from BN's recipe list, with tabs, a "craftable now" list, and "almost" recipes that show what's missing.
**How:** Some rags, sticks and a knife given, then `cdda.openCrafting()`.

### 43-dialogue.jpg
**Caption:** Talking to the Free Merchants' trader at the refugee center, with BN's real dialogue tree.
**How:** `teleportRefugeeCenter('merchant')`, then `cdda.talk()`. The topic is `TALK_EVAC_MERCHANT`.

### 44-map.jpg
**Caption:** The overmap: Holden, the shelter and the roads out, drawn in the tileset's overmap style with a legend.
**How:** `cdda.ui.open('map')` from the shelter.

## The five visual styles (same street, same frame)

### 50-style-full.jpg
**Caption:** Visual style "full".
**How:** `?look=full`, `lookView('street')`.

### 50-style-classic.jpg
**Caption:** Visual style "classic".
**How:** `?look=classic`.

### 50-style-crisp.jpg
**Caption:** Visual style "crisp".
**How:** `?look=crisp`.

### 50-style-terrain.jpg
**Caption:** Visual style "terrain".
**How:** `?look=terrain`.

### 50-style-voxel.jpg
**Caption:** Visual style "voxel", the current default.
**How:** `?look=voxel`. It matches 03, apart from the reload.

### 51-styles-strip.jpg
**Caption:** All five visual styles side by side: full, classic, crisp, terrain, voxel.
**How:** `evolution.sh` (ImageMagick `+append` of the five 50-style images).

## Tileset vs 3D: the same place

### 60-compare-town-3d.jpg
**Caption:** Holden's central crossroads in the 3D engine's top-down camera, with five zombies on the road.
**How:** Town centre, 13:00, five `mon_zombie` spawned, top camera facing north. The height is set so the frame spans the same ~34 m as the tile view (it is a 60° oblique view, so the match is approximate).

### 61-compare-town-tiles.jpg
**Caption:** The same crossroads drawn tile by tile from the UltiCa tileset, the way the 2D game shows it.
**How:** Straight after 60, `tilesTopDown({ cx, cy })` from `scripts/tiles-view.js`: 32 px tiles of terrain, furniture, top item and monsters from the live map.
**Caveat:** This is an approximation of the 2D renderer. There are no vehicles or fields, and wall connections use a simple same-id or wall-group rule.

### 62-compare-shelter-3d.jpg
**Caption:** The Evac Shelter from above in 3D, with the roof cut away.
**How:** `teleportOmt(53, 39)`, top camera facing north, 11:00.

### 63-compare-shelter-tiles.jpg
**Caption:** The Evac Shelter from the UltiCa tileset.
**How:** `tilesTopDown` straight after 62. Two flowers (`f_dandelion`, `f_sunflower`) have no UltiCa sprite and are left out.

### 77-tiles-vs-3d-shelter.jpg
**Caption:** The Evac Shelter as the 2D tileset draws it (left) and in Cataclysm3D (right).
**How:** `evolution.sh`: 63 and 62 side by side (1920x540).

### 78-tiles-vs-3d-town.jpg
**Caption:** A town crossroads as the 2D tileset draws it (left) and in Cataclysm3D (right).
**How:** `evolution.sh`: 61 and 60 side by side.

## Then and now (v1 → v2 → wave 3)

### 70-v1-shelter.jpg
**Caption:** v1 (Cataclysm: DDA data), the shelter at game start, 2026-09-29.
**How:** `git show f13503c:docs/screenshots/01_shelter_start.png` (the v1 README gallery, GPU at 1920x1080), downscaled. The shelter is furnished with DDA's chairs, and the HUD is the curses-style side panel.

### 71-v1-street.jpg
**Caption:** v1, a town street at golden hour: flat sprite zombies and a baseball bat.
**How:** `f13503c:docs/screenshots/02_town_street_golden_hour.png`. The viewpoint differs from 74 and 03 (v1 used another world, DDA's).

### 72-v1-zombie.jpg
**Caption:** v1 melee: a camera-facing sprite zombie grabs you while the message log scrolls.
**How:** `f13503c:docs/screenshots/03_zombie_melee.png`.

### 73-v2-shelter.jpg
**Caption:** v2 (Bright Nights data, end of the second push), inside the shelter.
**How:** `git show 941157a:docs/screenshots/looks/full_shelter.png` ("full" look, the v2 default).

### 74-v2-street.jpg
**Caption:** v2, the same street viewpoint as today's 03.
**How:** `941157a:docs/screenshots/looks/full_street.png`.

### 75-evolution-street.jpg
**Caption:** The street through the project: v1 (DDA), v2 (BN), wave 3 (today).
**How:** 71, 74 and 03 side by side (640x360 each).

### 76-evolution-shelter.jpg
**Caption:** The shelter through the project: v1, v2, wave 3.
**How:** 70, 73 and 02 side by side.

### 79-v1-vs-now-zombies.jpg
**Caption:** Zombies then and now: v1's camera-facing sprite billboard (left) and wave 3's modelled, sprite-painted bodies (right).
**How:** 72 and 10 side by side.

## Recreating the official screenshots

Two published screenshots rebuilt tile by tile in the engine: the **Cataclysm: Bright Nights readme
title image** and the **Cataclysm: DDA "UltiCa showcase, Sep 2021"**. Both originals are CC BY-SA
3.0 (© the Cataclysm: Bright Nights and Cataclysm: DDA contributors; UltiCa tileset by its
authors), copied unmodified into `images/originals/` and cropped for the comparisons. Inventories,
method and mismatches: `recreations.md`.

Rendered from `bn` plus this branch's small camera additions (`rig.topPitch`, `rig.topFocus`,
`renderer.topCutaway`) and the electricity-field fix, seed 1, factory default look (voxel) unless
the file says `-full`. Regenerate:

```
~/claude-stuff/bin/heavy --kind gpu --mem 2 --name "cdda3d recreations" -- \
  npx tsx notes/blog-post/scripts/blog-shots.ts --gpu --shots notes/blog-post/scripts/recreate-shots.js --raw /tmp/rc-raw
python3 notes/blog-post/scripts/recreate-compose.py --raw /tmp/rc-raw          # inside nix-shell (magick)
```

### rc-bn-compare.jpg
**Caption:** The Bright Nights title image, panel by panel: the original (left, CC BY-SA 3.0, BN contributors) and our rebuild seen straight down (right).
**How:** each panel's map area cropped from the original; ours is the matching `rc-<scene>-top` capture cropped to the same tiles. Sidebars left out.

### rc-dda-compare.jpg
**Caption:** The DDA UltiCa showcase (top, CC BY-SA 3.0, DDA contributors) and the same four scenes rebuilt in Cataclysm3D (bottom), in the same layout.
**How:** four `rc-dda_*-top` captures cropped to 19×25 tiles and scaled to the original's panel size; 75% size.

### rc-bn-strip.jpg
**Caption:** The Bright Nights title image (top) and the same four places from the ground in Cataclysm3D: the burning yard, the roundabout horde, the lab fence, the temple on the lake.
**How:** the original scaled to 1280 wide over the four `rc-bn_*-fp` views in a 2×2 grid.

### rc-dda-strip.jpg
**Caption:** The DDA UltiCa showcase (top) and the same four places from the ground: the bus and the horde, the autumn woods, the cabin farm, the lab.
**How:** the original scaled to 1600 wide over the four `rc-dda_*-fp` views.

### rc-bn_fire-pair.jpg
**Caption:** BN title, panel 1: two houses and a grass fire with zombies walking into it. Original left, ours right.
**How:** `recreate.stamp('bn_fire')`, straight-down camera with the cutaway off so roofs show.

### rc-bn_horde-pair.jpg
**Caption:** BN title, panel 2: a horde cut down at a roundabout. Ours is lit at 17:18 instead of 8:04 PM.

### rc-bn_lab-pair.jpg
**Caption:** BN title, panel 3: electrified chain-link fences in a science lab tower.

### rc-bn_temple-pair.jpg
**Caption:** BN title, panel 4: the Arcana mod's "floating temple", rebuilt from core stone, pews and a red carpet on deep water.

### rc-dda_street-pair.jpg
**Caption:** DDA showcase, panel A: a hulk in a bus, a special-zombie horde, and a mall with mannequins and changing rooms.

### rc-dda_forest-pair.jpg
**Caption:** DDA showcase, panel B: autumn woods with triffids. Our 3D canopies are wider than the 2D tree sprites, so the same trees cover more ground.

### rc-dda_farm-pair.jpg
**Caption:** DDA showcase, panel C: a log cabin, crop rows and swampy ground.

### rc-dda_lab-pair.jpg
**Caption:** DDA showcase, panel D: a laboratory wing with a sealed central chamber.

### rc-bn_fire-fp.jpg
**Caption:** The BN title's burning yard from the road: zombies walking into the fire between two houses.
**How:** `recreate.fp('bn_fire')`: first person at the road, looking up the grass strip.

### rc-bn_horde-fp.jpg
**Caption:** The BN title's roundabout horde from the median, among the bodies and the blood.

### rc-bn_lab-fp.jpg
**Caption:** The BN title's lab: electrified fences, crawlers at the gate, the planter and statue.

### rc-bn_temple-fp.jpg
**Caption:** Inside our stand-in for the floating temple: pews, the red altar carpet, remains on the floor.

### rc-dda_street-fp.jpg
**Caption:** The DDA showcase street from the sidewalk: the bus, the horde and the blood.

### rc-dda_forest-fp.jpg
**Caption:** The DDA showcase's autumn woods from the ground.

### rc-dda_farm-fp.jpg
**Caption:** The DDA showcase's cabin farm from the fields.

### rc-dda_lab-fp.jpg
**Caption:** Inside the DDA showcase's lab: benches and scientist zombies.

### rc-bn_fire-fp-full.jpg
**Caption:** The burning yard in the `full` visual style, for comparison with the default voxel style.

### rc-dda_street-fp-full.jpg
**Caption:** The DDA showcase street in the `full` visual style.

### rc-bn_fire-fp-hero.jpg
**Caption:** Full-size (1920x1080) version of rc-bn_fire-fp: the BN title's burning yard from the road.

### rc-bn_horde-fp-hero.jpg
**Caption:** Full-size version of rc-bn_horde-fp: the roundabout horde at sunset.

### rc-dda_street-fp-hero.jpg
**Caption:** Full-size version of rc-dda_street-fp: the DDA showcase's bus and horde.

### rc-dda_farm-fp-hero.jpg
**Caption:** Full-size version of rc-dda_farm-fp: the DDA showcase's cabin farm.

## Since the first snapshot (Sep 30 → Oct 26)

These `w-*` images were not rendered for the blog. They are the agents' own evidence screenshots
from `docs/screenshots/` (and the far-LOD worktree's `shots/farlod/`), copied as they are.

### w-zombie-bodies.jpg
**Caption:** Zombie bodies, round 7 (Oct 12): the UltiCa sprites (top), the boxy bodies from before, the hunched shamble that became the default, and the "caricature" alternative.
**How:** `docs/screenshots/zombies/compare_common.jpg`, from the zombie lineup views in `tools/char-views.js`; switch `?zstyle=boxy|caricature`. See `docs/CHARACTERS.md`.

### w-sprite3d.png
**Caption:** "A love letter to 2D pixel art made 3D, not voxel": a subagent with Blender built low-poly zombies (bottom) to read like the tileset sprites (top) at a distance.
**How:** `docs/screenshots/sprite3d/compare_all.png`, sprite over model at 3×. Behind `?zstyle=sprite3d`; not the default. See `docs/SPRITE3D.md`.

### w-gib-ragdoll.jpg
**Caption:** Hit hard enough to gib, a zombie no longer vanishes: torso, head and limbs fly as loose rag-doll pieces (70 km/h, frame strip).
**How:** `docs/screenshots/runover/gib_side_70.jpg`, from the real-input run-over capture scenario. Asked for on Oct 12: "the game should ragdoll their limbs & torso".

### w-far-lod.png
**Caption:** Far LOD (Oct 15–17): buildings past the 168 m draw distance are proxies built from the real map, dissolved into the real geometry as you approach, so towers stop popping in while you drive.
**How:** `shots/farlod/qa_city.png` from the `farlodqa` real-input QA scenario at `e8fe3a3`. See `docs/FAR_LOD.md`.

### w-bike-rider.jpg
**Caption:** Riders (Sep 30): the survivor's own body seated on bikes and in cars outside first person, with IK hands and feet and a pedalling crank. It fixed a "ghost bicycle (no person)".
**How:** `docs/screenshots/wave3/vehicles/riders/bicycle_turning.jpg`.

### w-stairs-follow.jpg
**Caption:** Walkable stairs (Sep 30): modelled flights, spirals and ladders you walk up and down; here a zombie follows you up from the shelter basement.
**How:** `docs/screenshots/wave3/stairs/zombie_follows_2.jpg`. See `docs/STAIRS.md`.

### w-reading-quiz.jpg
**Caption:** The reading minigame (Sep 30): field-notes questions generated from game data. A right answer buys reading time, a miss a short cooldown.
**How:** `docs/screenshots/wave3/reading/1_question.jpg`. The user's idea, "like lock picking in skyrim".

### w-crafting-assembly.png
**Caption:** Crafting as assembly (gap work, Oct): while a real craft runs, a card shows its actual components; each part you drag or key into its slot saves 4% of the batch's work, up to 20%.
**How:** `docs/screenshots/gaps/crafting-assembly.png` (ten flashlights). Prototyped first as a standalone mock the user asked for; Options > Craft assembly: Grid / Exploded / Off. See `docs/CRAFT_ASSEMBLY.md`.

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
**Caveat:** `tools/look-views.js` has an empty duplicate `name === 'dusk'` branch, so `lookView('dusk')` does nothing. The shot does these steps by hand. This is worth a one-line fix in the repo.

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
**Caption:** The Evac Shelter as the 2D tileset draws it (left) and in CDDA-3D (right).
**How:** `evolution.sh`: 63 and 62 side by side (1920x540).

### 78-tiles-vs-3d-town.jpg
**Caption:** A town crossroads as the 2D tileset draws it (left) and in CDDA-3D (right).
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

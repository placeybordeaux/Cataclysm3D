# Recreating the official screenshots

Two published Cataclysm images, rebuilt tile by tile in Cataclysm3D and photographed from above (to
match the original framing) and from the ground (what the same place looks like in our engine).

| original | source | licence |
|---|---|---|
| **Bright Nights readme title image** (1280×720, four panels) | `docs/en/contribute/img/readme-title.png` in [cataclysmbn/Cataclysm-BN](https://github.com/cataclysmbn/Cataclysm-BN/blob/main/docs/en/contribute/img/readme-title.png) (downloaded; not in the local clone) | CC BY-SA 3.0: the BN `LICENSE.txt` puts the game and `docs/en/*` under CC BY-SA 3.0 (the rest of `docs/` is AGPL). © the Cataclysm: Bright Nights contributors. |
| **DDA "UltiCa showcase, Sep 2021"** (2390×800, four panels) | `data/screenshots/ultica-showcase-sep-2021.png` in [CleverRaven/Cataclysm-DDA](https://github.com/CleverRaven/Cataclysm-DDA/raw/master/data/screenshots/ultica-showcase-sep-2021.png) | CC BY-SA 3.0 (DDA `LICENSE.txt`). © the Cataclysm: DDA contributors; UltiCa tileset by its authors (CC BY-SA). |

Copies of both are in `images/originals/`. Our images are derivatives of CC BY-SA data (BN JSON and
the UltiCa tileset) and are shared under the same licence.

## How they were made

- `scripts/recreate-scenes.js`: each panel as a character grid transcribed by eye from the original
  (terrain and furniture), plus monsters (posed with the `IMMOBILE` trick from `tools/char-views.js`),
  corpses (spawned then killed), items, fields (fire, blood, electricity) and vehicles. Stamped into
  an open field block on seed 1 (OMTs 63–66 × 45–48), with a margin around the panel so buildings
  aren't cut off at ground level.
- `scripts/recreate-shots.js`: per scene a straight-down view (`rc-<scene>-top`) and a first-person
  view (`rc-<scene>-fp`), rendered by `scripts/blog-shots.ts --shots scripts/recreate-shots.js --gpu`.
  The straight-down view uses three small, additive fields added for this work:
  `rig.topPitch` (default 60°, set to 89.9°), `rig.topFocus` (centre the top-down camera on the
  panel instead of the player) and `renderer.topCutaway` (default on; off keeps roofs and upper
  levels in the top-down view). Nothing changes in normal play. Game time is paused just before each
  capture so fire smoke and short-lived fields hold still.
- `src/render/tileKinds.ts`: `fd_electricity` (electrified fences, shocker zombies) was an invisible
  field; it is now drawn as a pale blue cloud. A real gap found while rebuilding BN panel 3.
- `scripts/recreate-compose.py --raw <dir>`: crops our top view to the panel's tile size and builds
  the pair, compare and strip images.
- Look: the user's default (**voxel** style, 3D models) for everything; the `full` style is shown for
  two first-person views for comparison.


## 1. Bright Nights readme title image

A 2×2 collage of four in-game screenshots, each with BN's curses sidebar on the right (the first
panel's message log is in Korean). All four use the UltiCa tileset; tile sizes differ per panel
(32 px in panel 1, about 26 px in panel 2, about 21 px in panels 3 and 4).

### Panel 1 (top left): a house roof above a grass fire — `bn_fire`

| | original | ours |
|---|---|---|
| Sidebar | "Place: House roof", sky cloudy, lighting bright, spring day 8 | spring, 15:00, BN weather `cloudy` |
| Terrain | two houses with dark-brown shingle roofs; a grass strip between them; front yards; a paved path to each front door; a sidewalk along the bottom | same layout: `t_wall_w` houses with `t_shingle_flat_roof` on z+1, grass, `t_sidewalk` paths, sidewalk, plus a road below the panel |
| Fields | two 3×3 blocks of fire running down the grass strip into the yard; one blood splat on the sidewalk | `fd_fire` intensity 3 on the same 18 tiles; `fd_blood` |
| Furniture / flora | two mailboxes; purple and white flowers; a row of three shrubs; a flowering bush, a young tree and a tall-grass patch by the wall; a chimney on the left roof | mailboxes, tulip and bluebell, `t_shrub` ×4, `t_tree_young`, tall grass; no chimney |
| Items | two coils of rope on the grass | 2 × `rope_30` |
| Monsters | 5 visible: a zombie child, a zombie, a fat zombie, a tough zombie in the fire; one zombie on the right sidewalk. The sidebar lists 10 zombies, 2 fat, 2 firefighters, 3 tough, 2 children, 2 rot-weilers, 3 brainless, a nurse. | the 5 posed at the same tiles, plus the rest of the list off-panel on the road; one corpse on the blood splat |
| Player | on the roof edge of the left house | on the grass just below that edge (see mismatches) |

### Panel 2 (top right): a horde at a roundabout — `bn_horde`

| | original | ours |
|---|---|---|
| Sidebar | "Location: road", 8:04 PM spring day 2, weapon M2HB Browning (auto); nearby: 5 zombies, 2 fat, 2 hazmat, 3 tough, 2 zapper, 7 zombie technicians | 17:18 (see mismatches), clear |
| Terrain | dark asphalt; yellow lane dots in pairs; a sidewalk-and-grass median running north; a round concrete planter island with a dead tree, a young tree and shrubs | `t_pavement` with `t_pavement_y` lines at the same places; median of `t_sidewalk` / grass; a 5×5 island ringed with sidewalk, `t_tree_dead`, `t_tree_young`, shrubs; a street light |
| Monsters | about 40 zombies packed around the lane line, many already dead | 21 posed zombies in the sidebar's mix plus 8 corpses |
| Fields / items | blood over the whole fight, trails, spent casings | `fd_blood` over ~60% of a 11×10 area plus trails; `50_casing` scattered |

### Panel 3 (bottom left): a science lab tower — `bn_lab`

| | original | ours |
|---|---|---|
| Sidebar | "Location: science lab tower", clear, bright, 9:16 AM spring day 14; the log mentions popping open a crate | 09:18, clear |
| Terrain | slate floor; a triangle of dirt at the top; a wooden walkway running down the middle past the player; chain-link fences with gates; stone walls; stairs at the bottom | `t_thconc_floor`, `t_dirt`, `t_floor` / `t_metal_floor` walkway, `t_chainfence` + `t_chaingate_c`, `t_wall`, `t_stairs_down` |
| Fields | live electricity along the fences (about 20 tiles) | `fd_electricity` on the same tiles |
| Furniture | a terminal, a desk and a bookcase on the left; a planter with a statue by the fence | `t_console`, `f_table`, `f_bookcase`, `f_indoor_plant` ×2 + `f_statue` |
| Monsters | two red hostile crawlers by the fence; two grey robots | `mon_zombie_crawler` ×2, `mon_secubot` ×2 |
| Items | blood and a body at the fence, two blue key cards, casings, a canister | `fd_blood`, a scientist corpse, `id_science` ×2, casings, `canister_empty` |
| Player | on the walkway with a headlamp | same tile, flashlight on in first person |

### Panel 4 (bottom right): the "floating temple" — `bn_temple`

| | original | ours |
|---|---|---|
| Sidebar | "Location: floating temple", weapon shrike's misericorde, 5:23 PM spring day 28; the log is a fight with "the host of the archon" | 17:24 |
| Content | a location from the **Arcana** mod, which Cataclysm3D doesn't load | rebuilt from core pieces |
| Terrain | a stone temple on dark water: a nave with pews, a black altar on a red carpet, white chairs, a corridor to a vestry with a cauldron, a blue orb, deep-water basins | `t_rock_floor` and `t_wall` on `t_water_dp`, `f_bench` pews, `t_carpet_red`, `f_armchair`, `f_woodstove`, `f_sink` |
| Monsters | skeletal remains and blood across the nave | `mon_skeleton` corpses ×4, a zombie corpse, `fd_blood` |

## 2. DDA "UltiCa showcase, Sep 2021"

Four portrait panels side by side, 32 px tiles, no UI.

### Panel A: a bus, a horde, a mall — `dda_street`

| | original | ours |
|---|---|---|
| Street | asphalt with a dashed yellow centre line; a city bus full of seats with a huge pale hulk inside; broken glass around the bus | `t_pavement` / `t_pavement_y`; BN `bus` prototype; `mon_zombie_hulk` placed inside; `glass_shard` items |
| Horde | ~25 special zombies (acid, spitters, shockers, fungal, soldiers, cops) in pools and trails of blood, a few bodies | 22 posed: acidic, spitter, electric, fungus, soldier, cop, runner, plain; `fd_blood`; 5 corpses |
| Sidewalk | three rows of paving | `t_sidewalk` |
| Mall | wood floor; four mannequins; heaps of rubble; green sale signs; a blue sofa; a glass atrium with two pines; a red rug; a stepped row of changing rooms with ~12 zombies; stairs; a grass verge and the next building on the right | `t_floor`, `f_mannequin` ×4, `f_rubble` ×5, `f_sign` ×3, `f_trashcan`, `f_sofa`, `t_wall_glass` atrium with `t_tree_pine`, `t_carpet_red`, changing rooms of `t_wall_w`, `t_stairs_down`, grass strip |

### Panel B: autumn forest — `dda_forest`

| | original | ours |
|---|---|---|
| Flora | ~45 trees: red maples, yellow birches, orange broadleaves, a few pines and dead trees; tall grass with dirt patches; blue flowers, ferns, a spiky agave | the same trees by position: `t_tree_maple`, `t_tree_birch`, `t_tree_hickory`, `t_tree_pine`, `t_tree_dead`; `t_grass_long`; autumn season |
| Monsters | a pink carnivorous flower, green sprouting plants with orange tips, a yellow creature beside a dropped rifle | `mon_triffid_young`, `mon_triffid_sprig` ×4, `mon_skitterbot` (a best guess for the yellow creature) and an `m1a` on the ground |

### Panel C: log cabin farm — `dda_farm`

| | original | ours |
|---|---|---|
| Buildings | a log cabin: lockers, a table and chairs, a bed, a rack, counters with a wood stove, a glass fridge; an annex with crates, counters and lockers; a second small log building with a barrel and counters | `t_wall_log`, `t_floor`, `f_locker`, `f_table`, `f_chair`, `f_bed`, `f_rack`, `f_counter`, `f_woodstove`, `f_glass_fridge`, `f_crate_c`, `f_wood_keg` |
| Yard | two stone ovens and a chair by the door; three rows of crops (seedlings and mature plants) in dirt | `f_boulder_small` ×2 as the ovens; `t_dirtmound` rows with `f_plant_seedling` / `f_plant_mature` |
| Surroundings | trees; a creek on the left; swampy tall grass with scattered puddles | `t_tree`, `t_water_sh`, `t_grass_long` |
| Player | a survivor between the cabin and the crops | same spot |

### Panel D: laboratory — `dda_lab`

| | original | ours |
|---|---|---|
| Layout | white tile rooms with lab benches, lockers and glass walls down the left; a wide grey corridor; a central chamber ringed with glass cabinets, a scientist at a bench; smaller labs below; a pink tile patch; a road with a yellow centre line on the right | `t_linoleum_white`, `f_lab_bench`, `f_locker`, `t_wall_glass`, `t_thconc_floor` corridor, `t_metal_floor` ring with `f_glass_cabinet`, `t_floor_red`, road |
| Monsters | yellow six-legged robots, scientist zombies, a brute by a terminal, green crawlers outside, a bloody body | `mon_skitterbot` ×4, `mon_zombie_scientist` ×5, `mon_zombie_brute` by a `t_console`, `mon_zombie_dog` ×3, a corpse on blood |

## What matched

- **Layout, tile for tile, within the transcription's accuracy.** Walls, floors, fences, roads and
  lane markings, crop rows, furniture and monsters sit on the same tiles as in the originals (the
  pair images line up when flipped between). The grids were transcribed by eye from the PNGs, so
  expect the odd tile off by one, especially in the dense forest and the horde.
- **Content ids.** Everything placed is real BN data: the same kinds of terrain, furniture, monsters,
  items and fields the original shows, with the substitutions listed below.
- **Time, season and weather** from the sidebars where one exists (BN), or read from the art (DDA:
  the autumn forest, summer elsewhere).

## What couldn't be recreated, and why

- **The UI.** BN's curses sidebar (body status, the Korean message log, the minimap) isn't in the
  comparison: Cataclysm3D replaced it with its own HUD. The comparisons crop the originals to their map
  area, and our shots hide the HUD.
- **The camera.** Our straight-down view is a perspective camera at 89.9°, so walls and tall things
  show their tops and lean slightly away from the centre. The 2D game shows the side of each sprite.
  3D tree canopies are wider than the tile they stand on, which is why the forest panel looks denser
  and greener from above even though the trees are on the same tiles.
- **BN panel 1, the survivor on the roof.** In the original the survivor stands on the roof edge.
  Our pitched roofs vanish while the player is on their level (so you can see where you're
  standing), so ours stands on the grass just below. The chimney isn't placed.
- **BN panel 2, time of day.** The original says 8:04 PM but draws the scene fully lit (the 2D game
  doesn't darken the map by time of day). At 20:04 our street is almost black, so ours is set at
  17:18, at sunset. The original shows about 40 zombies; ours has 21 standing plus 8 bodies. The
  M2HB the survivor fires isn't shown.
- **BN panel 3, electricity.** The lab's live electricity (`fd_electricity`) was not drawn at all by
  the renderer before this work (an invisible field). It is now drawn as a pale blue dithered cloud,
  like smoke (`src/render/tileKinds.ts`). It reads from above and from the ground, but as a haze
  rather than the original's crackling arcs. The
  original's red crawlers and grey robots are guesses at the monster ids (`mon_zombie_crawler`,
  `mon_secubot`).
- **BN panel 4 is mod content.** The "floating temple", "shrike's misericorde" and "the host of the
  archon" come from the Arcana mod, which Cataclysm3D doesn't load. The temple is rebuilt from core
  stone, pews, a red carpet and skeleton remains on deep water; the cauldron and blue orb are
  stood in by a stove and a sink. The black "wings" in the original (unseen tiles) are water in ours.
- **DDA panels use DDA content; we run on BN.** The showcase is from DDA's 2021 mall, forest, farm
  and lab mapgen, with DDA monsters. We rebuilt them from BN pieces: BN's `bus` for the city bus,
  `mon_zombie_hulk` for the pale giant in the bus, `mon_skitterbot` for the yellow six-legged robots
  (a best guess, as is the yellow creature in the forest), `f_boulder_small` for the stone ovens,
  `f_sign` for the green sale signs, `mon_zombie_dog` for the green crawlers.
- **Lighting and palette.** The 2D game draws everything at full brightness with UltiCa's colours.
  Ours has sun, shadows, haze and the voxel look's palette grading, so the same tiles read darker
  and warmer, and blood decals are round splats rather than UltiCa's spray pattern.
- **Not placed:** small items the originals show only as a few pixels (the forest's ferns and the
  agave, the mall's clothes, most of the lab's clutter) and the vehicle's seats seen through the roof.

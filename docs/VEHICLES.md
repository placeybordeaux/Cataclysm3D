# Vehicles: modelled bodies (wave 3)

Feedback: *"the cars look terrible! so boxy and weird"*. A Bright Nights vehicle is a grid of
parts (frame, boards, doors, windscreen, seats, wheels ... one tile each). v2 drew that grid
literally: one box per part, so a car read as a stack of tiles (and doors, which BN flags
`OPENABLE` rather than `DOOR`, came out as coloured blocks). Wave 3 keeps the grid for
gameplay (collision, interaction, damage) but draws each vehicle as **one cohesive low-poly
body** in the Shadowglass style: shaped geometry, a fixed-density pixel-art skin, stepped
lighting.

## Switching

| how | |
| --- | --- |
| Options > **Vehicle look** | modelled bodies (default) / part blocks (the v2 look), persisted |
| `?vehicles=model` / `?vehicles=parts` | URL override (anything else throws) |
| `cdda.vehicleLook('parts')` | live; every vehicle rebuilds next frame |
| Options > **Vehicle width** / `?vehiclewidth=real\|fill` / `cdda.vehicleWidth('fill')` | model look only: `real` (default) draws real-world proportions; `fill` stretches bodies to the grid footprint. Collision follows the drawn body either way (below), so `real` has no invisible wall |

`fill` for comparison (same views as the first two rows below):

| ![](screenshots/wave3/vehicles/fill_lineup-car-sedan-car_sports.jpg) | ![](screenshots/wave3/vehicles/fill_lineup-suv-pickup-cube_van.jpg) |
| --- | --- |

## How it works

`src/render/vehicleLayout.ts` reads the grid (pure, unit-tested):

- **Body style** from the prototype id with a grid fallback: sedan, hatch, sports, SUV,
  pickup, van (box vans, ambulances, RVs), minivan, bus, truck (semi, flatbed, fire,
  hazmat), motorcycle, bicycle, frame (everything else). Each style has dimensions
  (`STYLE_PARAMS`: sill, beltline, bonnet, roof, box, windscreen rake, crown, shoulder
  radius, tumblehome, lamp placement, chrome/black bumpers...).
- **Livery** from the id: police (black & white, light bar), ambulance (white, red stripe,
  cross, beacons), school bus (yellow, black rub rails, bonnet, warning lamps), transit bus,
  fire, military, FBI, SWAT, security, hazmat, ice cream, hippie (two-tone + flowers).
  Otherwise the spawn paint.
- **Sections** along the length: bonnet rows ahead of the windscreen row, cabin rows, rear
  glass, and behind the cabin a box (full boards), a pickup bed (open top), a trunk / flat
  deck. Wheels (diameter from BN's rim size in **cm**, `vpart_info::wheel_info` `"425 mm"` ->
  42.5, plus a sidewall), doors (the front door reaches forward to the A-pillar), side glass
  per row.
- **Proportions**: BN grids are fat and long (a car is 4 x 6 tiles). Bodies are drawn at
  real-world proportions scaled ~1.15-1.2x to the world (doors and people are big here):
  a sedan ~5.6 x 2.1 x 1.62 m vs a real one's ~4.8 x 1.8 x 1.45. Width is `widthPerCol` per
  column, length is shortened around the grid's middle by `lengthScale` (`xOf`); seats keep
  their columns (`zOf`) and move along with the length, and the driving camera uses the
  drawn seat. BN's generic `car` (a roofed cargo row behind the rear seats) is drawn as a
  notchback sedan, not a wagon.
- **Collision follows the drawn body** (`src/game/vehicleShape.ts`): map overlays can
  resolve collision with sub-tile shapes (`MapOverlay.shaped` / `collide`, used by
  `physics.ts` for the player, monsters and NPCs). Each obstacle mount's cell is clipped to
  the body outline in mount space (so a car turned 45 deg works too); open doors and aisles
  stay walkable. Being *in* a vehicle (`playerOn`), riding along when it moves, a door
  blocked by you standing in it, and run-overs all use the body: a zombie on the verge 0.4 m
  from the paint is not run over, one in the lane is. The crosshair has to reach the paint.
  Vehicle-vs-vehicle and vehicle-vs-terrain crashes stay tile-based (CDDA's model). The
  renderer supplies the outline (`vehicleSystem.bodyShape`); headless (tests, sim) and the
  `parts` look keep whole tiles. Real-input check: `tools/realinput.ts --only carside`.

`src/render/vehicleModel.ts` builds the geometry:

- A **side profile**: nose -> bonnet -> sloped windscreen -> roof -> rear glass / hatch /
  cab back / box -> tail, over a sill with **wheel-arch cut-outs** per axle; convex corners
  chamfered.
- **Side walls** = the profile at +-half width with the window openings (and open or
  missing doors) cut out; **skin strip** = the profile lofted across the width with rounded
  shoulders, a crown (bonnet / roof / nose bulge), plan taper at the ends and tumblehome
  above the beltline. Windscreen and rear glass are strip segments drawn as glass; side
  glass fills the openings. Everything is a double-sided shell, so the cabin reads from the
  inside (inner faces shade as grey trim).
- Parts: wheels (tread, sidewalls, five-spoke rim) sitting in the arches, seats with
  backrests and headrests, dash, instrument binnacle, steering wheel, bumpers, mirrors,
  exhaust, chassis block, pickup bed floor, emissive head / tail lamps (the existing
  headlight spot + light-map beam are unchanged), roof light bars / beacons (they flash
  while the lights are on).
- State: open doors swing out ~65 deg on the front hinge (the hole shows the interior), an
  open tailgate / shutter / hatch leaves the tail open, broken glass is gone with jagged
  shards left in the frame, flat tyres squash and the body sags onto that corner, broken
  parts rust and dent, blood splashes, heavily wrecked vehicles are burnt out.
- Roof panels hide in top-down view (you look into the cabin, like CDDA's map).
- Cabins get less sky light (like building interiors) and dark trim, and the glass is tinted
  more from outside, so seats read dark through the windows instead of glowing.
- Parked vehicles were left with the wheel wherever it was: about half have the front
  wheels turned up to ~23 deg (per vehicle, stable). The driven vehicle's wheels steer and
  roll; ridden bikes lean into turns.
- **Distance LOD**: past 50 m (back inside 42 m) a vehicle is rebuilt without its cabin
  interior, mirrors and exhaust, with coarser wheels and no shadow casting.

`src/render/vehicleSkin.ts` paints the per-vehicle **skin** at **32 texels/m**, nearest
filtering, onto five sheets the geometry projects onto by face normal (two sides, top, front,
rear): stepped shading bands (shoulder highlight, darker rocker), crease lines, black window
trim and pillars (or body-colour on utility vehicles), door seams and handles, wheel-arch
lips, side markers, fuel filler, grille with slats, head / tail lamp lenses, licence plates,
box-van ribs and rear doors, roof ribs / rails, livery stripes and emblems, then weathering:
road grime from the sills up, rust along the sills and arches that spreads with wear, dents
on damaged rows, blood. Painting runs in a **Web Worker** (`vehicleSkinWorker.ts`); the body
shows its flat paint colour for the frame or two until the skin lands.

`src/render/vehicleBikes.ts`: motorcycles (forks, triple clamp, teardrop tank, saddle,
finned engine, swingarm, shocks, exhaust, round headlamp) and bicycles (diamond frame, wire
wheels with see-through spokes, saddle, bars, cranks). The grid is 3-4 tiles long, so the
wheelbase is pulled in to a real bike's around the grid centre. Parked bikes lean on the
kickstand.

`src/render/vehicleFrame.ts`: the tidy fallback for grids that aren't a car, truck, bus or
bike (golf carts, tractors, carts, APCs, boats, player-built rigs): chassis plates, panels on
the outside edges only, real seats and wheels, glass in frames, machinery as rounded blocks,
turret barrels. Nothing is squeezed there; every part sits on its tile.

Cockpit camera: eye height and lateral position come from the model (seat top + ~0.68 m,
kept above the bonnet), the dash sits under the bonnet line so the car is a band at the
bottom of the view with the A-pillars framing the road.

### The driver's seat (round 3, `src/render/vehicleCockpit.ts`)

Built only for the vehicle you drive (the model's `cockpit` anchors, placed from the eye so
it all sits between the bonnet line, ~14 deg down, and the view's bottom edge, 36 deg):

- **Dials**: a hooded binnacle with a speedometer (0-120 mph, red from 100) and a fuel gauge
  (E-F, red at E), 64x64 pixel-art faces painted in code (3x5 pixel numerals). The needles
  follow the real values (`v.velocity`, main fuel tank or the battery for EVs) with a little
  lag. Unlit (readable at night too).
- **Steering wheel** as its own mesh, turning with the front wheels (x2.6); your **fists**
  ride on the rim at ten-to-two and the forearms stretch from the elbows each frame. Sleeve
  and skin colours come from your outfit composite (like the on-foot 3D arms,
  `src/render/chars/fpView.ts`), so a red jacket drives in red sleeves.
- **Windscreen film**: a faint lit (goes dark at night) texture inside the glass: dust haze
  thicker at the base and corners, two wiper arcs swept cleaner, the odd fleck and a soft
  diagonal reflection band. A few % alpha: the road reads through it.
- **Wipers** parked at the base of the windscreen and an **interior mirror** under the roof
  (every car, not only yours). **A-pillars** are one shoulder quad now (the windscreen glass
  runs further into the rounding).

### Lids, wrecks and more silhouettes (round 3)

- **Trunk lids and hatches open**: BN's `door_trunk` (the only lid part: BN has no bonnet part
  or engine-bay interaction, so bonnets stay shut) swings up on its hinge when opened through
  the part menu (cargo access needs it open): a sedan's lid at the foot of the rear window, a
  hatchback's / SUV's glass hatch at the roof's rear edge; long lids (limousines) open less so
  they clear a z-level. Pickup tailgates and box-van shutters stay openings.
- **Wrecks** (status 1 is what BN spawns on city roads, so most road cars): glass flecks on the
  road by every smashed window (sideways out of doors, ahead of / behind a broken windscreen /
  rear window), a soot scorch under burnt-out shells, soot on their paint instead of rust,
  open doors that *hang* (swung wider, drooping at the far end) on damaged doors / wrecks,
  and the body sits lower on destroyed tyres. BN's placements only give axis-aligned facings
  (`road_vehicles.json` `*_wrecks`: 90/180/270), so wrecks aren't yawed; the tilt comes from
  their flat tyres.
- **Silhouettes by spawn frequency**: `tools/vehicle-freq.ts` generates the world around the
  start for several seeds and ranks what mapgen spawns with the style each gets. The road
  vehicles were covered; round 3 fixed the ones that read wrong: **RVs** (a tall box over
  the cab with the overcab bunk, motorhome two-tone), **food trucks** (cab + tall box, orange
  stripe), **fire engines** (crew cab + locker body), **semis** (sleeper cab, chrome stacks,
  fifth wheel), **trailers** (one tall box on high sills), **limousines** (the chauffeur's
  partition glass no longer cuts the cabin in two). Carts, forklifts, quad bikes and golf
  carts stay on the tidy frame look.

### Cockpit polish (round 4)

- **A-pillars**: the eye now sits over the seat's back half (`MODEL_EYE_FORWARD`) and saloons
  have a shorter windscreen run, so the pillar top is ~0.6 m ahead instead of at your cheek;
  the pillar is one narrow shoulder strip at the windscreen corner, and interior faces are a
  lighter trim grey. The road on the left reads past it.
- **Steering wheel**: a round rim (16 segments of an 8-sided tube), a lighter upper arc,
  three spokes and a hub with a horn pad.
- **Hands**: the characters agent's modelled first-person fists (`fistRig` / `FIST_GRIP`
  exported from `src/render/chars/fpView.ts`, curled fingers, thumb, sleeve cuffs, painted
  from your outfit by the shared skin store), placed on the rim at ten-to-two in their own
  small `CharLayer` under the cockpit (`src/render/vehicleHands.ts`), so they turn with the
  wheel. Falls back to simple fists without the character renderer.
- **Dashboard**: grained (leather swatch, a little more sky light) with a lighter lip along
  its top edge.
- **Wipers** sweep while it rains (render weather rain / storm, or the game weather's
  `rains`), faster in storms, and park when it stops. Rain streaks no longer fall inside the
  cabin in the cockpit view (`Weather.clearRadius`).
- Smaller interior mirror, tucked up against the glass.

### Filling up (round 4, `src/game/refuel.ts`)

Look at a gas / diesel pump with a vehicle parked within ~2.5 tiles and `e` offers **Fill up the
Car with gasoline (N L)**. BN keeps a pump's fuel as a liquid item on the pump tile (mapgen
`place_gaspumps`) and `iexamine::gaspump` hands it to the liquid handler, whose
`ACT_FILL_LIQUID` moves 2/3 L per game second: filling is a timed activity at that rate
(interruptible, partial fills kept), charges in ml (`fuels.<id>.chargesPerL` = 1000). Empty
tanks take the fuel the engine burns; a vehicle that doesn't burn it says so. BN's dexterity
spill roll is left out. The pump tile isn't a quick-loot target any more (its fuel is the
pump's). Real input: `tools/realinput.ts --only refuel`. Siphoning isn't done.

### Playtest fixes (round 3)

- `e` at an open door (any side) offers **Drive / Get in**; closing is under More...
- `^` from beside the car finds the controls (the seat distance was measured from a tile
  corner); broken controls are skipped.
- Standing in a doorway ducks the camera under the roof (`rig.eyeCap`) instead of clipping.
- Doors (not trunk lids / shutters) swing shut once you drive off (> 1.5 m/s).
- Real input: `tools/realinput.ts --only cardoors` checks all four.

## Screenshots (RTX 5080, 1600x900, look `full`)

Regenerate: `~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run "npx tsx tools/vehicle-shots.ts --gpu model parts"`
(views in `tools/vehicle-views.js`; `--views 'a;b'` to pick). JPEG q75 (at q85 these
low-res, upscaled frames come out larger than PNG). Left: v2 part blocks (`parts`); right:
modelled bodies (`model`).

| view | before (`parts`) | after (`model`) |
| --- | --- | --- |
| town street, a used box van | ![](screenshots/wave3/vehicles/parts_street.jpg) | ![](screenshots/wave3/vehicles/model_street.jpg) |
| hatchback, sedan, sports car | ![](screenshots/wave3/vehicles/parts_lineup-car-sedan-car_sports.jpg) | ![](screenshots/wave3/vehicles/model_lineup-car-sedan-car_sports.jpg) |
| SUV, pickup, cube van | ![](screenshots/wave3/vehicles/parts_lineup-suv-pickup-cube_van.jpg) | ![](screenshots/wave3/vehicles/model_lineup-suv-pickup-cube_van.jpg) |
| police, ambulance, hippie van | ![](screenshots/wave3/vehicles/parts_lineup-policecar-ambulance-hippie_van.jpg) | ![](screenshots/wave3/vehicles/model_lineup-policecar-ambulance-hippie_van.jpg) |
| pickup from behind | ![](screenshots/wave3/vehicles/parts_solo-pickup-140.jpg) | ![](screenshots/wave3/vehicles/model_solo-pickup-140.jpg) |
| transit bus | ![](screenshots/wave3/vehicles/parts_solo-bus-30-0-4.jpg) | ![](screenshots/wave3/vehicles/model_solo-bus-30-0-4.jpg) |
| school bus | ![](screenshots/wave3/vehicles/parts_solo-schoolbus-30-0-4.jpg) | ![](screenshots/wave3/vehicles/model_solo-schoolbus-30-0-4.jpg) |
| motorcycle | ![](screenshots/wave3/vehicles/parts_solo-motorcycle-70-0-1.5.jpg) | ![](screenshots/wave3/vehicles/model_solo-motorcycle-70-0-1.5.jpg) |
| bicycle | ![](screenshots/wave3/vehicles/parts_solo-bicycle-70-0-1.5.jpg) | ![](screenshots/wave3/vehicles/model_solo-bicycle-70-0-1.5.jpg) |
| smashed sedan (glass out, flat tyre, door open) | ![](screenshots/wave3/vehicles/parts_solo-sedan-30-smashed-2.jpg) | ![](screenshots/wave3/vehicles/model_solo-sedan-30-smashed-2.jpg) |
| golf cart, tractor, APC (frame fallback) | ![](screenshots/wave3/vehicles/parts_lineup-golf_cart-tractor_plow-apc.jpg) | ![](screenshots/wave3/vehicles/model_lineup-golf_cart-tractor_plow-apc.jpg) |
| street at night, headlights on | ![](screenshots/wave3/vehicles/parts_nightstreet.jpg) | ![](screenshots/wave3/vehicles/model_nightstreet.jpg) |
| driving, cockpit | ![](screenshots/wave3/vehicles/parts_driveday.jpg) | ![](screenshots/wave3/vehicles/model_driveday.jpg) |
| driving, chase cam | ![](screenshots/wave3/vehicles/parts_drivedaychase.jpg) | ![](screenshots/wave3/vehicles/model_drivedaychase.jpg) |
| night driving, chase cam | ![](screenshots/wave3/vehicles/parts_drivechase.jpg) | ![](screenshots/wave3/vehicles/model_drivechase.jpg) |

Round 4 (half size): cockpit by day, in the rain (wipers), at night, and the chase cam.

| | |
| --- | --- |
| ![](screenshots/wave3/vehicles/r4/model_driveday.jpg) | ![](screenshots/wave3/vehicles/r4/model_driverain.jpg) |
| ![](screenshots/wave3/vehicles/r4/model_drive.jpg) | ![](screenshots/wave3/vehicles/r4/model_drivedaychase.jpg) |

Round 3 (model look only):

| | |
| --- | --- |
| cockpit, day: dials, wheel, hands, wipers, film | ![](screenshots/wave3/vehicles/r3_driveday.jpg) |
| cockpit, night: the dials stay readable | ![](screenshots/wave3/vehicles/r3_drive.jpg) |
| hatchback with the hatch open | ![](screenshots/wave3/vehicles/r3_solo-car_hatch-200-trunk-2.jpg) |
| burnt-out wreck | ![](screenshots/wave3/vehicles/r3_solo-sedan-40-burnt-2.jpg) |
| smashed glass on the road | ![](screenshots/wave3/vehicles/r3_solo-sedan-30-smashed-2.jpg) |
| RV / motorhome | ![](screenshots/wave3/vehicles/r3_solo-rv-40-0-4.jpg) |
| semi tractor | ![](screenshots/wave3/vehicles/r3_solo-semi_truck-50-0-4.jpg) |
| food truck | ![](screenshots/wave3/vehicles/r3_solo-food_truck-40-0-3.jpg) |
| limousine | ![](screenshots/wave3/vehicles/r3_solo-limousine-70-0-4.jpg) |
| a town street (wrecks as mapgen left them) | ![](screenshots/wave3/vehicles/r3_street-1.jpg) |

## Performance

GPU (`tools/vehicle-shots.ts --gpu --bench --size 3440x1304`, RTX 5080 shared with other
jobs, so frame times are noisy): frame time is unchanged within noise (street p50 23.9 vs
23.2 ms, chase 28.2 vs 27.5 ms); triangles +~5k (+1%); ~10-16 more draw calls in a street.

CPU, per vehicle when it streams into view (built at most one per frame past a 4 ms budget,
the driven vehicle and nearby changes immediately):

| | parts | model (main thread) | model skin (worker) |
| --- | --- | --- | --- |
| sedan | ~1.8 ms | ~3.5 ms geometry | ~4.5 ms |
| bus | | ~5.5 ms geometry | ~7 ms |

(Chromium on a loaded 24-core box; the first build after load pays JIT warm-up, up to ~30
ms once.) Rebuilds on door / light changes reuse the painted skin (keyed by paint, livery,
damage and blood). Memory: one ~200x300 RGBA skin per car in view (~250 kB, a bus ~750 kB).
Build stats: `cdda.renderer.vehicleView.buildStats`.

Driving through town at 40 mph (`tools/bench-stream.ts --runs drive`, 1080p, RTX 5080):
model vs parts: frame p50 16.7 / 16.7 ms, p99 33.4 / 33.4 ms, `beforeRender` (where vehicle
builds happen) mean 0.54 / 0.48 ms and at most 1.9 ms in the slowest frames. The hitches
are chunk streaming and GPU waits, not vehicles.

## Tests

`tests/vehicleModel.test.ts`: style classification, sections (sedan, pickup bed, box van),
seats stay in their tiles, wheel units (cm rims, bicycle wheels), every prototype builds
without NaNs, footprints stay inside the grid (open doors excepted), window / arch cut-outs,
open-door leaves, skin coverage at 32 texels/m, skins survive structured cloning (worker),
skin reuse on door / light changes, frame fallback, proportions, parked steering, LOD.
`tests/vehicleShape.test.ts`: walking into the side stops at the paint (tile rules without a
shape), a car turned 45 deg, walking in through an open door, closing a door from beside
it, driving past someone on the verge, running over what's in the lane only.

## Known gaps / ideas

- Parked vehicles' wheels don't roll (only the driven one's are separate meshes).
- The collision outline is a rectangle: you touch the bumper corners a few cm before the
  rounded paint. Vehicle-vs-vehicle / terrain crashes are still tile-based.
- The LOD keeps the same skin (it's per vehicle, cheap).
- Semi tractors and trailers are separate BN vehicles and aren't coupled.
- Boats, aircraft and tanks use the frame fallback (tracks are drawn as big wheels).
- Bonnets never open (BN has no bonnet part); tailgates and shutters open as a hole.
- The mirror shows a flat tint,
  not a reflection.
- Only the driven vehicle gets the cockpit rig; a passenger seat has no view extras.
- The part-block look (`parts`) is kept as it was in v2, including its door bug.

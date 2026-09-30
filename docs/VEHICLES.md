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

## v3 phase 1: chassis templates (drawn body = gameplay body)

Vehicles v3 (`docs/design/VEHICLES_V3.md`, research in `docs/research/VEHICLE_BUILDING.md`)
moves every vehicle onto an authored **chassis template**. Phase 1 (this) is templates +
mapping, no building yet: the body a vehicle is drawn with, collides with, is boarded through
and is crashed into is now one thing, owned by the game (`src/game/chassis/`), and every BN
part sits in a typed socket of it.

**Templates** (`src/game/chassis/templates.ts`), a ladder of rungs:

| rung | templates (BN vehicles on them, of 257) |
| --- | --- |
| bike | `bicycle` 7, `scooter` 4, `motorcycle` 8 (sidecars fit) |
| car | `hatch` 3, `sedan` 12, `sports` 8 |
| utility | `suv` 15, `pickup` 3, `minivan` 3, `van` 1 |
| heavy | `box_truck` 15 (cube vans, ambulances, food trucks, RVs), `bus` 4, `semi_cab` 1, `heavy_truck` 8 (fire engines, flatbeds, army trucks), `trailer` 18 (the box trailer and BN's 17 tankers) |
| home | `rig`: the top rung (a long deck with a walkable box), defined now; nothing spawns it (built in phase 3) |
| frame | `frame` 35 (golf carts, tractors, draisines, forklifts...), `frame_small` 27 (carts, chairs), `frame_tracked` 21 (tanks, APCs), `frame_boat` 26, `frame_air` 38 |

A template has a family (`body`: an authored shell; `bike`; `frame`: an honest home-made
grid that collides with its cells), the style the renderer draws it with, a grid envelope it
accepts (body columns x rows), the real-scale body it promises (length / width ranges the
tests hold every mapped vehicle to), its engine-bay rows and its dimensions (sill, belt,
roof, box, rake... the wave-3 `STYLE_PARAMS`, which moved here from the renderer).

**Sockets** (`mapping.ts`): `frame` (structure; belly tanks, non-wheel running gear),
`wheel` (axle + wheel), `cabin` (centre parts in the cab: seats, controls, aisles), `panel`
per side (`left` / `right` / `front` / `rear`: doors, glass, boards, armour, and protrusions
hung on it: wing mirrors), `roof` (roof, on_roof, on_ceiling), `engine` (engine_block, the
tanks and batteries by it) and `interior` (bed / box / deck load space). Each carries the BN
locations it takes and the BN cell it stands for, and has a position on the body
(`socketPos`). BN's empty-location and `on_*` parts (lights, horns, batteries, seatbelts,
alarms) are fittings riding on their cell's host socket.

**Mapping** (`mapChassis`, `pickTemplate`): the template comes from the prototype id (the
wave-3 rules split into rungs), else the grid; a grid outside the named template's envelope
falls back to the frame family (by what it's built from: floats, wings/rotors, tracks or
armour, a cart-sized grid). Every installed BN part object goes into a socket, untouched
(condition, faults, fuel, cargo items stay on it): nothing is copied, so nothing can be lost.
A part the template has no socket for (an engine in a sedan's trunk, a part off the body's
columns) is **kept, installed and working**, in `chassis.overflow` with the reason, and
`VehicleSystem.add` reports it (`[chassis] ...` warning once per prototype). Stock BN data:
**0 of 26,885 parts overflow**. The template is chosen once and saved: a stripped or modified
vehicle keeps its body (only choosing checks the envelope).

Where it is used (`src/game/chassis/index.ts`):

| | |
| --- | --- |
| `chassisOf(v)` | template + sockets + overflow; mapped when a vehicle enters the world (`VehicleSystem.add`: mapgen spawns, debug spawns, saves) and kept current |
| `layoutOf(v)` | the template placed on the grid: nose / tail / half width, sections, wheels, doors (cached per vehicle version and width mode). The renderer's `analyze()` is this now: **the modelled look draws the template** |
| `chassisBodyRect(v)` | the collision outline (the renderer hands it to `VehicleSystem.bodyShape` in the modelled look): terrain, vehicles, creatures, run-overs, `playerOn`, the crosshair, doorways, cargo reach, refuelling reach all use it |
| `hitMount(v, x, y)` | crash damage by side: the contact point's side of the body -> that side's nearest panel socket -> its BN cell -> `collisionPart` (armour, then what blocks, then the frame, as BN) |
| `chassisSeats(v)` | every seat / bed with its drawn position (mount space, inside its cell), cushion height and whether it's the driver's. The driver is seated there; **riders** (NPCs / the survivor drawn seated) should use this: world position `v.mountToWorld(s.x, s.y)`, height `v.z * LEVEL_HEIGHT + s.h`, facing `v.facing` |
| `noseX(v)` | the headlight beam starts at the template's nose |
| `cellAtPoint(v, x, y)` | the part under the crosshair on the paint (a turned car no longer picks the tile centre's part) |

Other gameplay changes: `e` gets you out through the nearest door you can **walk to inside**
(the bus driver's door is across the cab; before, `e` in a bus only let go of the wheel), and
stair flights (`src/game/stairwalk.ts` walls their footprint off for walkers) now stop
vehicles too (`VehicleSystem.obstacle`: any other map overlay that makes a tile impassable),
and mapgen won't place a vehicle on one. BN part stats and behaviour (engines, fuel, wheels,
mass, speed) are unchanged. Headless (tests, the sim) and the `parts` look keep colliding with
whole grid tiles (`bodyShape` null), exactly as before.

**Data**: the vehicle extractor now reads BN's `blueprint` + `palette` prototypes and
single-part mount entries (`{x, y, part}`), which it skipped: 26 prototypes were empty (the
17 tankers, the airship, airboat, F-35, Harrier, airliners, catamaran...) and others had lost
parts (the JLTVs, scooters, superbike, tractors, wagons). 64 prototypes changed; parts and
groups are identical.

**Saves**: each vehicle saves `chassis: { template, v: 1 }`. A save from before v3 (no
`chassis`) is migrated once on load: the same mapping as spawns, keeping every part's
condition, fuel and cargo (`console.info` says how many); saving again writes the templates.
The dev hot-reload snapshot is a save, so it carries them too. Chassis data newer than the
build refuses to load (loudly); an unknown template name is re-mapped with a warning.

**Debug**: `cdda.chassis(uid?)` (template, why, sockets by kind, seats, overflow),
`cdda.chassisCensus()` (templates of every vehicle in the world, overflow, migrated),
`cdda.chassisOverlay(true)` (the template body = collision outline in yellow, sockets as
coloured crosses: panel orange, cabin cyan, engine pink, interior blue, roof green, frame
grey; seats white with the driver's red; overflow red X). `npx tsx tools/chassis-report.ts`
maps all 257 prototypes and prints the table above (`--proto ID` lists one's sockets).

**Tests**: `tests/chassis.test.ts`: all 257 prototypes map, every part in exactly one socket
or the overflow; the familiar vehicles land on the familiar rungs; every shaped body is
inside its template's promise and its grid; seats sit in their cells and the body, every
driver can get in and the road vehicles' passengers can walk to their seats; part state and
cargo items survive mapping and a save round trip (all 257, used and wrecked); overflow for
an engine in the trunk and a ram off the side; the rig on a flatbed's grid; crash sides;
the bus driver seated on the drawn seat and climbing out; stair flights stop a car (body and
whole tiles) and refuse spawns; the pre-v3 save fixture (`tests/fixtures/vehicles_pre_v3.json`,
`tools/dev/gen-vehicle-save-fixture.ts`) migrates with nothing lost. Real input:
`tools/realinput.ts --only chassisdrive` drives a pickup, a cube van and a bus 40+ m through
a town with W / Space / V / e: the drawn shell within 10 cm of the collision outline, seated
on the template seat, no scratch, `e` climbs out to stand outside the body.

BN's own data walls some seats in (no door into the room): the surv_rv's and tour bus's
beds, the bubble car's cabin (its canopy doors open onto windscreen), the Apache's and
Medevac wreck's gunner seats, two airliner seats and the F-15's cockpit (its canopy opens
onto the wings). Drivers still get in from beside the vehicle (`GET_IN_RANGE`) except the
F-15.

Screenshots (half size; `before` = the `bn` branch, `after` = phase 1): see
`docs/screenshots/vehicles-v3/phase1/`.

| | before (`bn`) | after (phase 1) |
| --- | --- | --- |
| bike and car rungs: bicycle, scooter, motorcycle, mini, car, sports | ![](screenshots/vehicles-v3/phase1/before_bikes-cars.jpg) | ![](screenshots/vehicles-v3/phase1/after_bikes-cars.jpg) |
| utility: SUV, pickup, minivan, van, box truck | ![](screenshots/vehicles-v3/phase1/before_utility.jpg) | ![](screenshots/vehicles-v3/phase1/after_utility.jpg) |
| heavy: bus, semi cab, heavy truck, trailer | ![](screenshots/vehicles-v3/phase1/before_heavy.jpg) | ![](screenshots/vehicles-v3/phase1/after_heavy.jpg) |
| frame family: golf cart, tractor (now with all its BN parts), APC, sea scooter (was drawn as a motorcycle), JLTV | ![](screenshots/vehicles-v3/phase1/before_frames.jpg) | ![](screenshots/vehicles-v3/phase1/after_frames.jpg) |
| a BN tanker (was an empty prototype: spawning one hung the page) | (nothing) | ![](screenshots/vehicles-v3/phase1/after_tanker.jpg) |

The bodies look as in wave 3 on purpose: the templates took over the wave-3 shapes, so
drawn = gameplay changed underneath, not the paint. `cdda.chassisOverlay(true)`: template body
(yellow) = collision outline, sockets, seats (driver red):

| | |
| --- | --- |
| ![](screenshots/vehicles-v3/phase1/overlay_car_pickup_van.jpg) | ![](screenshots/vehicles-v3/phase1/overlay_bus.jpg) |
| ![](screenshots/vehicles-v3/phase1/overlay_top.jpg) | real input: the bus driven through town ![](screenshots/vehicles-v3/phase1/drive_bus.jpg) |
| pickup ![](screenshots/vehicles-v3/phase1/drive_pickup.jpg) | cube van (box truck) ![](screenshots/vehicles-v3/phase1/drive_cube_van.jpg) |

Known gaps: tankers are drawn as a flat deck (their tanks aren't modelled: per-part visuals
are phase 5); the sea scooter / flying motorcycle now get the frame look; panels hold BN's
side parts but nothing is drawn per socket yet.

What phases 2-3 build on: `v.template` (saved, authoritative) is the adopted vehicle's body;
sockets list what can be stripped (phase 2: `socket.parts` -> items through `moves.ts`) and
where parts install (phase 3: a socket's `accepts` + BN's per-part gating); `overflow` is the
"doesn't fit, here's why" list the planner shows; `mapChassis(v, 'rig')` already places the
top rung on a long grid. Missing for them: a `Vehicle.removePart` (the part index is
append-only today), sockets that exist without a part in them (today a socket is created by
the part that fills it: the planner needs the template's empty sockets too), and per-socket
visuals (plates over windows, rams, roof racks: phase 5).

## How it works

`src/game/chassis/layout.ts` (was `src/render/vehicleLayout.ts`, which re-exports it) places
the vehicle's chassis template on its grid (pure, unit-tested):

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
  Driving crashes follow the body too (below). The renderer supplies the outline
  (`vehicleSystem.bodyShape`); headless (tests, sim) and the `parts` look keep whole tiles.
  Real-input check: `tools/realinput.ts --only carside`.

### Driving collision (crashes follow the drawn body)

Crashes used to be CDDA's whole tiles: a car's 4 x 6 grid stopped against a wall or a
parked car with up to ~1 m of air beside the paint, and a gap that looked wide enough (the
refugee center's crammed lot) wasn't. Now, when a vehicle has a drawn body
(`VehicleSystem.bodyRect`), `collidePose` in `src/game/vehicles.ts` tests that body as an
**oriented box** (`vehicleShape.ts`: `rectObb`, separating-axis tests):

- **Terrain**: against every tile square the box newly overlaps (at the next pose, not at
  the current one). *What* blocks is unchanged, BN's per-tile rules (`obstacleAt`: bashable
  terrain / furniture that isn't flat floor, tiny things only under wheels, then impassable
  tiles), and so is the response (`resolveCollision`: smash / bash through, part damage, stop,
  the driver's jolt). Tiles are taken nearest the body's centre first, so a square hit lands
  on the middle of the nose.
- **Other vehicles**: box vs box (theirs is their drawn body, or one unit square per mount
  when they have none: frame builds). Light ones (< 20% of the mass) are still shoved aside;
  the shove checks the shoved vehicle's boxes against the pusher's box, terrain and other
  vehicles.
- **Which part takes it**: the contact point (the corners of one box inside the other, or
  the point of the body nearest the tile) goes to the nearest mount (`nearestMount`), and
  `collisionPart` picks armour / obstacle / frame there as before, on both vehicles.
- **Stepping**: shaped bodies move in substeps of at most 0.25 m / 4 deg (a bicycle, the
  thinnest thing to hit, is ~0.6 m across, so nothing is skipped at 60 mph or on a long
  frame), and a substep that ends in a crash is **bisected** (7 halvings) so the vehicle
  stops where the paint touches, within a few mm, not a substep short. Tiles keep 0.3 m /
  8 deg steps.
- **Overlapping grids**: two bodies can now sit closer than their grids, so the tile index
  is a multimap. `at()` returns the vehicle whose body covers the tile centre (the latest
  indexed when both or neither do), `occupantAt` / `playerOn` the one whose body you're in,
  `moveCost` is 0 if any occupant blocks.
- Creatures, run-overs and `playerOn` already used the body; the part that hits a creature
  is now the mount nearest it too.

| how | |
| --- | --- |
| `cdda.vehicleCrashes('tiles')` / `('body')` | crashes on whole tiles even in the model look (the old behaviour, for comparison); creatures keep the body. Default `body` |

Headless (tests, sim) and the `parts` look have no body shape and keep whole-tile
collision exactly as before. Cost: ~0.05 ms per driven frame vs ~0.03 ms on tiles
(Node, a car at 40 mph weaving past parked cars).

Tests: `tests/vehicleCollision.test.ts` (0.3 m past a parked car and along a wall, a
3-tile gap the 4-tile grid can't take, head-on stop at the paint with the front damaged,
OBB vs OBB square and at 30 deg with damage at the contact, a lane change in a 4-tile alley,
turning into a wall stops at the corner, no tunnelling at 60 mph including a 0.25 s frame,
a bicycle shoved at 60 mph, overlapping grids, run-overs while squeezing past; each "whole
tiles" counterpart too). Real input: `tools/realinput.ts --only drivecollide` (W / S / V
through xdotool): passes a parked car with 0.3 m of air (and, with `vehicleCrashes('tiles')`,
the same pass crashes), rams a parked car and a concrete wall and checks the bumper stops
within 3 cm, then at the refugee center (seed 1) lines up with a 2.57 m gap between a car
and a pickup (the body is 2.20 m wide, the grid 4 m), creeps in until the nose meets the
building beyond, and reverses back out, without a scratch on any of the three.

| | |
| --- | --- |
| 0.3 m past a parked car (top-down, V) | ![](screenshots/wave3/vehicles/collision/pass_top.jpg) |
| the same pass on whole tiles: stopped by air | ![](screenshots/wave3/vehicles/collision/pass_tiles_top.jpg) |
| rammed a parked car: bumper to bumper | ![](screenshots/wave3/vehicles/collision/ram_car.jpg) |
| rammed a concrete wall: the bumper on the wall | ![](screenshots/wave3/vehicles/collision/ram_wall.jpg) |
| refugee center lot: in the gap between a car and a pickup | ![](screenshots/wave3/vehicles/collision/lot_top.jpg) |
| ...from the driver's seat | ![](screenshots/wave3/vehicles/collision/lot_cockpit.jpg) |

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

### Your body in the seat (riders, `src/render/vehicleRider.ts`)

Playtest: "the third person view for the bicycle shows a ghost bicycle (no person)". The 3D
player model used to hide whenever you drove. Now, with 3D characters, outside first person
(chase and top-down cameras) the survivor sits in the seat of the vehicle being driven:

- **Anchors from the model**: every build says where the rider goes (`ModelBuild.ride`, mount
  space): hips on the saddle / seat, torso lean, hand targets (handlebar grips, or ten-to-two
  on the steering wheel's rim), feet (pegs, the floor under the pedals, or a bicycle crank).
  `vehicleBikes.ts` (bicycle: leaning far over flat bars, pedalling; motorcycle / scooter:
  astride behind the tank, feet on pegs), `vehicleModel.ts` (cars: back in the driver seat,
  slight recline), `vehicleFrame.ts` (open frames: golf carts, tractors). Anything without
  anchors (the part-block look) gets a generic upright seat on the driver's tile.
- **Pose**: two-bone IK per limb (`src/render/chars/ridePose.ts`, driven by `PoseIn.ride` in
  the humanoid rig) puts the hand centres and ankles exactly on the targets (unit-tested
  against the built matrices; out-of-reach targets straighten the limb toward them).
- **Placement**: `VehicleRenderer.update` poses the body last, from the lean pivot's world
  matrix, so it follows position, yaw and a bike's lean into turns in the same frame (no
  lag); `CharInstance.rootOverride` carries the transform.
- **Pedalling**: the ridden bicycle's crank (arms + pedals) is its own mesh turning with the
  distance ridden (`CRANK_M_PER_TURN` = 5 m a turn); the crank and the feet on it update at the
  characters' stepped rate (`charSettings.fps`), like other body animation.
- **Cars**: the hands follow the cockpit's turning wheel (`Cockpit.gripPoints`) up to ~57 deg
  (`GRIP_TURN_MAX`), then slide round the rim (full lock is 90 deg of wheel, out of a seated
  body's reach; a test sweeps the range for six body styles); the
  first-person fists hide while the body is drawn, and the driven car's outside glass is
  tinted lighter (0.4 instead of 0.72 opacity) so you can see yourself through it.
- **Unchanged**: first person / the cockpit camera (the fists on the wheel), the billboard
  character mode (the survivor is hidden while driving, as before). `cdda.vehicleRiders(false)`
  brings back the old riderless look for comparison; `cdda.renderer.vehicleView.riderCheck()`
  reports hand / foot error and visibility (the `riders` real-input scenario uses it).
- **NPCs**: nobody else rides. NPCs never board or drive vehicles in this build (no passenger
  system), so there is nobody to seat; the `Rider` / anchors are ready for it.

| before (ghost bike) | bicycle, stopped | bicycle, turning |
| --- | --- | --- |
| ![](screenshots/wave3/vehicles/riders/bicycle_before_ghost.jpg) | ![](screenshots/wave3/vehicles/riders/bicycle_stopped.jpg) | ![](screenshots/wave3/vehicles/riders/bicycle_turning.jpg) |
| **motorcycle, stopped** | **motorcycle, turning** | **car, chase (crop)** |
| ![](screenshots/wave3/vehicles/riders/motorcycle_stopped.jpg) | ![](screenshots/wave3/vehicles/riders/motorcycle_turning.jpg) | ![](screenshots/wave3/vehicles/riders/car_chase_crop.jpg) |
| **car, chase, turning** | **car, top-down** | **bicycle, riding** |
| ![](screenshots/wave3/vehicles/riders/car_chase_turning.jpg) | ![](screenshots/wave3/vehicles/riders/car_top.jpg) | ![](screenshots/wave3/vehicles/riders/bicycle_straight.jpg) |

Real input: `heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/realinput.ts --gpu --only riders'`
(W / A / S held through xdotool, V cycles the cameras, the mouse orbits the chase camera).

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
`tests/vehicleCollision.test.ts`: driving crashes against the body (see "Driving collision").
Riders: `tests/render/ridePose.test.ts` (IK lands hands / ankles on their targets in the built
rig), `tests/vehicleModel.test.ts` "where the rider sits" (anchors for bikes and cars, the
ridden bicycle's crank).

## Known gaps / ideas

- Parked vehicles' wheels don't roll (only the driven one's are separate meshes).
- The collision outline is a rectangle: you (and crashes) touch the bumper corners a few cm
  before the rounded paint; mirrors poke a little past it and don't collide.
- Driving crashes: a blocked substep stops the whole move (turn and travel together): there's
  no sliding along a wall, so a swinging corner that touches stops the car and you back off.
  The vehicle turns about its mount (0, 0) (the driver's seat area), not the rear axle, so
  the tail swings out more than a real car's (unchanged, now visible to a few cm). Vehicles
  still don't push each other (only light ones are shoved), and nobody else's moving vehicle
  is tested against yours mid-step (each moves in its own simulate).
- Monster pathfinding and `map.passable` still see whole vehicle tiles.
- The LOD keeps the same skin (it's per vehicle, cheap).
- Semi tractors and trailers are separate BN vehicles and aren't coupled.
- Boats, aircraft and tanks use the frame fallback (tracks are drawn as big wheels).
- Bonnets never open (BN has no bonnet part); tailgates and shutters open as a hole.
- The mirror shows a flat tint,
  not a reflection.
- Only the driven vehicle gets the cockpit rig; a passenger seat has no view extras.
- Riders: bicycle / motorcycle handlebars and forks don't turn with the steering (the front
  wheel does), so the hands stay put; the rider doesn't lean further than the bike or brace
  on a stop; a wielded weapon is simply not drawn while riding. Nobody sits in passenger seats
  (no NPC passengers exist yet).
- The part-block look (`parts`) is kept as it was in v2, including its door bug.

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
| Options > **Vehicle width** / `?vehiclewidth=real\|fill` / `cdda.vehicleWidth('fill')` | model look only: `real` (default) draws car proportions (a car ~2.6 m on its 4-tile grid, so you stop ~0.7 m short of the paint: collision is still the grid); `fill` widens bodies to ~0.3 m inside the footprint (chunkier, but you touch what you see) |

`fill` for comparison (same views as the first two rows below):

| ![](screenshots/wave3/vehicles/fill_lineup-car-sedan-car_sports.png) | ![](screenshots/wave3/vehicles/fill_lineup-suv-pickup-cube_van.png) |
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
- **Width is squeezed**: a car is 4 tiles wide; drawn to scale that is a 4 m pancake. The
  body is `widthPerCol` per column (a car ~2.6 m). Seats keep their grid positions (`zOf`)
  so a passenger's eye and seat agree; the driving camera uses the drawn seat.

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

## Screenshots (RTX 5080, 1600x900, look `full`)

Regenerate: `~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run "npx tsx tools/vehicle-shots.ts --gpu model parts"`
(views in `tools/vehicle-views.js`; `--views 'a;b'` to pick). Left: v2 part blocks
(`parts`); right: modelled bodies (`model`).

| view | before (`parts`) | after (`model`) |
| --- | --- | --- |
| town street, a used box van | ![](screenshots/wave3/vehicles/parts_street.png) | ![](screenshots/wave3/vehicles/model_street.png) |
| hatchback, sedan, sports car | ![](screenshots/wave3/vehicles/parts_lineup-car-sedan-car_sports.png) | ![](screenshots/wave3/vehicles/model_lineup-car-sedan-car_sports.png) |
| SUV, pickup, cube van | ![](screenshots/wave3/vehicles/parts_lineup-suv-pickup-cube_van.png) | ![](screenshots/wave3/vehicles/model_lineup-suv-pickup-cube_van.png) |
| police, ambulance, hippie van | ![](screenshots/wave3/vehicles/parts_lineup-policecar-ambulance-hippie_van.png) | ![](screenshots/wave3/vehicles/model_lineup-policecar-ambulance-hippie_van.png) |
| pickup from behind | ![](screenshots/wave3/vehicles/parts_solo-pickup-140.png) | ![](screenshots/wave3/vehicles/model_solo-pickup-140.png) |
| transit bus | ![](screenshots/wave3/vehicles/parts_solo-bus-30-0-4.png) | ![](screenshots/wave3/vehicles/model_solo-bus-30-0-4.png) |
| school bus | ![](screenshots/wave3/vehicles/parts_solo-schoolbus-30-0-4.png) | ![](screenshots/wave3/vehicles/model_solo-schoolbus-30-0-4.png) |
| motorcycle | ![](screenshots/wave3/vehicles/parts_solo-motorcycle-70-0-1.5.png) | ![](screenshots/wave3/vehicles/model_solo-motorcycle-70-0-1.5.png) |
| bicycle | ![](screenshots/wave3/vehicles/parts_solo-bicycle-70-0-1.5.png) | ![](screenshots/wave3/vehicles/model_solo-bicycle-70-0-1.5.png) |
| smashed sedan (glass out, flat tyre, door open) | ![](screenshots/wave3/vehicles/parts_solo-sedan-30-smashed-2.png) | ![](screenshots/wave3/vehicles/model_solo-sedan-30-smashed-2.png) |
| golf cart, tractor, APC (frame fallback) | ![](screenshots/wave3/vehicles/parts_lineup-golf_cart-tractor_plow-apc.png) | ![](screenshots/wave3/vehicles/model_lineup-golf_cart-tractor_plow-apc.png) |
| street at night, headlights on | ![](screenshots/wave3/vehicles/parts_nightstreet.png) | ![](screenshots/wave3/vehicles/model_nightstreet.png) |
| driving, cockpit | ![](screenshots/wave3/vehicles/parts_driveday.png) | ![](screenshots/wave3/vehicles/model_driveday.png) |
| driving, chase cam | ![](screenshots/wave3/vehicles/parts_drivedaychase.png) | ![](screenshots/wave3/vehicles/model_drivedaychase.png) |
| night driving, chase cam | ![](screenshots/wave3/vehicles/parts_drivechase.png) | ![](screenshots/wave3/vehicles/model_drivechase.png) |

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

## Tests

`tests/vehicleModel.test.ts`: style classification, sections (sedan, pickup bed, box van),
seats stay in their tiles, wheel units (cm rims, bicycle wheels), every prototype builds
without NaNs, footprints stay inside the grid (open doors excepted), window / arch cut-outs,
open-door leaves, skin coverage at 32 texels/m, skins survive structured cloning (worker),
skin reuse on door / light changes, frame fallback.

## Known gaps / ideas

- Wheels don't turn with steering or spin (they're merged into one mesh per vehicle).
- No distance LOD: a far car gets the same skin as a near one (cheap enough so far).
- With `real` width the collision footprint is still the grid, so you bump into air ~0.7 m
  beside a car (`fill` trades proportions for that). A true fix needs a finer collision
  shape in the vehicle system.
- Semi trucks have no trailer in BN's grid; the tractor unit reads as a long cab truck.
- Boats, aircraft and tanks use the frame fallback (tracks are drawn as big wheels).
- Hood / trunk lids don't open; tailgates and shutters open as a hole.
- The part-block look (`parts`) is kept as it was in v2, including its door bug.

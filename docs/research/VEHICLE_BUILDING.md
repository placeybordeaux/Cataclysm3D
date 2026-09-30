# Research: vehicle building and the deathmobile

Status: desk research (2026-09-30), no code changed. It answers the user's prompt:

> "TBH we'll probably need to overhaul vehicle building to better suit actually being 3d and
> shrinking the car models so they look better. I am leaning towards allowing building your
> own car, but restrict it to only a set preset that's actually larger than what's default
> available in the game? There is some lore in the game about making your own deathmobile,
> please do some background research and then we'll think about what we can do from there"

Related docs: `docs/VEHICLES.md` (the wave-3 modelled bodies), `docs/ADAPTATION.md` (the "TV
adaptation" principles), `ARCHITECTURE.md` § Vehicles.

## TL;DR

- **Cataclysm's building is a free grid of 1 m cells.** Each cell holds a stack of parts, one
  part per *location* slot (structure, under, center, armor, roof, on_roof, engine_block,
  fuel_source...). Parts are gated by flag prerequisites (a wheel needs a wheel mount, a
  turret needs a turret mount), skill, tool qualities and lift/jack ratings that scale with
  vehicle mass. BN has about 440 part definitions (about 800 ids once shapes are expanded) and
  257 prototypes. Each part is its own 15–60 minute job. A car-sized build is **hundreds of
  separate actions**.
- **"Deathmobile" is a player-culture word, not a system.** The game data mentions it only in
  flavour text: a survivor note about "scrapper Joe's deathmobile" and "a mountain of metal on
  wheels, which I live in". BN adds the Road Warrior profession, who starts with the
  "Wasteland Interceptor" and a cattle dog. Players split builds into two archetypes:
  - the **deathmobile**: a heavy-framed, armoured ram for ploughing through hordes;
  - the **mobile base**: a big solar-powered home with a kitchen, fridge, bed, workshop and
    turrets.
- **What players love:** a named vehicle to show off, being self-sufficient, a fortress on
  wheels, clever tuning, and a long project. It usually starts from a good found vehicle (semi,
  APC, van), not from scratch.
- **What players hate:** in-game time burned on installs and repairs, lift and jack gating (BN
  even ships a "No Lifting Reqs" mod), the game picking the wrong component, not knowing *why*
  a part won't fit, hunting for parts and fuel, and huge builds that are miserable to drive.
- **3D games that do this well** constrain the shape and free up the choices:
  - Rust: a chassis with 2, 3 or 4 sockets, modules in the sockets, engine parts inside the
    modules.
  - Mad Max: one car with slot upgrades that change its silhouette.
  - Pacific Drive: one hero wagon with bolt-on panels.
  - Subnautica's Cyclops: a mobile base you walk around inside.

  Free-form block builders (Crossout, Robocraft, Scrap Mechanic, Stormworks) attract dedicated
  builders but produce ugly metas and put newcomers off.
- **Five directions are laid out in [§4](#4-design-directions)**:
  - **A.** The user's idea: a preset deathmobile chassis, larger than the stock vehicles.
  - **B.** Chassis templates in a few sizes, with sockets.
  - **C.** Adopt and refit found vehicles.
  - **D.** An honest free grid that looks home-made.
  - **E.** A cross-cutting "plan it, then queue the work" build mode.

  My recommendation is **B with A as its flagship** (a small ladder of chassis whose top rung
  is the big deathmobile platform), plus **E** for the user experience, plus salvage from
  **C**. Direction D can be kept one switch away for veterans.

---

## 1. How vehicle building works in Cataclysm

Paths are relative to `~/code/Cataclysm-BN`. BN's vehicle code lives in `src/vehicle/`. DDA is
cited where it differs.

### 1.1 Frames and mounting (the grid)

- **Starting a vehicle** is a construction, "Start a New Vehicle" (`constr_veh`,
  `data/json/construction/construct_other.json:128-140`). It takes any part flagged
  `INITIAL_PART` and installs it at mount (0,0) of an empty prototype
  (`src/construction.cpp:1981-2012, 2410-2430`).
- **The first part on a tile must have `location: "structure"`.** That covers frames, rams,
  external cargo and cranes (`src/vehicle/vehicle.cpp:1753-1754`).
- **Every later part** must go on a tile that has structure or is orthogonally next to it
  (`vehicle.cpp:1788-1795`).
- **Removing structure** is allowed only when nothing else is left on that tile, and not if a
  flood fill says the vehicle would split in two (`vehicle.cpp:1900-1955`).
- **Stacking rule: one part per location per tile.** Parts with an empty location stack
  freely; `turret_mount` is one of these. Two `CARGO` parts can never share a tile
  (`vehicle.cpp:1774-1786`). There is no numeric cap per tile. A typical car tile holds a
  frame, a wheel mount, a wheel, a center part (seat, door, cargo), armor, a roof and
  something on the roof.
- **Location values in BN data.** Counts of each value:

  | Location | Count |
  |---|---|
  | center | 80 |
  | structure | 46 |
  | under | 37 |
  | on_roof | 24 |
  | fuel_source | 10 |
  | armor | 9 |
  | roof | 5 |
  | anywhere | 5 |
  | on_ceiling | 4 |
  | engine_block | 4 |
  | axle | 4 |

  BN keeps location as a free string, and `finalize()` hardcodes its draw order
  (`src/vehicle/veh_type.cpp:572-611`). DDA made location a JSON type
  (`vehicle_part_location`, DDA `doc/JSON/JSON_INFO.md:2987-3000`).
- **Prerequisite chains** come from `requires_flag` in `data/json/vehicleparts/vp_flags.json`
  and are checked at `vehicle.cpp:1802-1814`:
  - ALTERNATOR needs an engine with E_ALTERNATOR.
  - TURRET needs TURRET_MOUNT.
  - WHEEL needs a light, medium or heavy WHEEL_MOUNT.
  - Batteries need BATTERY_MOUNT.
  - ON_ROOF needs ROOF.
  - Curtains need WINDOW.
  - Door locks and motors need OPENABLE.
  - SEATBELT needs BELTABLE.

  You cannot remove a part while a dependent part is still attached.
- **Other exclusions:**
  - Nothing mounts onto a tile whose base part is `PROTRUSION` (rams, mirrors).
  - Mirrors and `OPAQUE` parts can't share a tile.
  - Each tile takes one turret mount (`vehicle.cpp:1755-1843`).
- **Wheels:**
  - The centre of mass must lie inside the wheels' bounding box (`vehicle.cpp:4923-4944`).
  - A single wheel works only if it is `STABLE` and the vehicle has at most 3 structure parts
    (`vehicle.cpp:4768-4780`).

### 1.2 Requirements: skills, tools, lifting, time

- **Requirement format.** Each part has `requirements.{install,removal,repair}` with skills,
  time and either `using` requirement ids or inline tools and components
  (`veh_type.cpp:215-252`). The part's own item is always consumed on install.
  - Defaults: install 1 h, removal half of install, repair 1 h (`veh_type.h:292-320`).
  - Each skill level above the requirement cuts 10% off the time, up to 50%. Each helper takes
    another 10% (`veh_type.cpp:874-892`).
- **Common requirement ids** (`data/json/requirements/vehicle.json`, `toolsets.json`):

  | Requirement id | What it needs | Used by about |
  |---|---|---|
  | `welding_standard` | GLARE 2 plus welder, toolset or oxy-torch charges | 270 parts |
  | `vehicle_bolt` | WRENCH 2 | 160 parts |
  | `vehicle_screw` | SCREW 1 | 98 parts |
  | `vehicle_weld_removal` | SAW_M 2 | 67 parts |
  | `vehicle_nail_install` | HAMMER 2 plus nails | — |

  Skills are almost all **mechanics** (about 1000 references), then electronics (48), then
  fabrication (6).
- **Lifting and jacking** (`src/vehicle/veh_interact.cpp:806-846`):
  - Wheels (`NEEDS_JACKING`) need a JACK quality of `ceil(min(mass, 8500 kg) / 500 kg)`,
    which tops out at 17 (`veh_interact.cpp:110-115`).
  - Instead of a jack you can use strength of mass/10 kg (helpers count), or a `SELF_JACK`
    part on the vehicle.
  - Every other part needs LIFT of `ceil(weight / 500 kg)` or enough strength.
  - BN bundles a mod that turns all of this off: `data/mods/No_Lift_Requirements`.
- **Extra gates:**
  - Each additional `E_HIGHER_SKILL` engine raises the mechanics requirement.
  - A new steerable axle requires mechanics `min(10, axles + 5)` (`veh_interact.cpp:728-766`).
  - Some engines exclude each other (`vehicle.cpp:1502-1522`).
- **Repair.** A broken part needs its full install requirements again. A damaged part needs
  its repair requirements multiplied by the damage level (0–4) (`src/vehicle/veh_utils.cpp:103`).
- **Examples:**

  | Part | Install | Notes |
  |---|---|---|
  | Frame | mech 1, 20 min, welding ×10 | 400 hp, DR 52 (`frames.json:51-76`) |
  | Heavy-duty frame | mech 3, 40 min, welding ×20 | 760 hp, DR 112 (`frames.json:144-158`) |
  | Wooden frame | mech 0, 30 min, nails | no welder needed (`frames.json:79-95`) |
  | Wheel | mech 0, 15 min, bolts | `under`, needs jacking and a wheel mount (`wheel.json:164-189`) |
  | V8 gasoline | mech 3, 60 min, bolts | 242 kW (`combustion.json:276-295`) |
  | Military composite plating | mech 6, 60 min, welding | `armor` location (`plating.json:175-198`) |
  | Turret mount / turret | mech 1, 20 min, welding / 100 s | the turret is made from a real gun item (`turret.json:1-12, 651-672`) |
  | Solar panel | mech 4, 60 min, bolts | `on_roof`, 80 W (`power.json:164-185`) |
  | Minireactor | mech 6, 60 min, welding | 100 kW electric (`power.json:298-322`) |

### 1.3 Size

- **No maximum vehicle size exists** in BN's vehicle code. Mapgen clamps prototypes to a 24×24
  area, but the Osprey helicopter is 21×19 anyway. Veterans' rule of thumb is "no more than 5
  tiles wide and 8–10 long", because larger builds are painful to drive through wreck-clogged
  towns (mlangsdorf, Discourse 17299).
- **Stock grid sizes** in BN, in tiles (length × width). These match our
  `public/data/vehicles.json`:

  | Vehicle | Grid | Occupied tiles | Parts |
  |---|---|---|---|
  | bicycle | 3×1 | 3 | 11 |
  | motorcycle | 4×1 | 4 | 21 |
  | sports car | 5×4 | 20 | 64 |
  | car | 6×4 | 24 | 79 |
  | SUV / pickup | 7×4 | 28 | 87–90 |
  | humvee / armoured car | 7×5 | 35 | 128 |
  | APC | 9×5 | 42 | 173 |
  | RV | 9×7 | 47 | 159 |
  | cube van | 8×7 | — | — |
  | semi | 10×8 | 60 | 148 |
  | school bus | 11×5 | 55 | 155 |
  | bus | 14×7 | 72 | 197 |

  **Important for the 3D problem:** a real car is about 1.8 m wide, yet it gets 4 cells
  because the side mirrors and doors take whole cells. The grid is a gameplay abstraction
  that is roughly 2× too wide and 1.2× too long. That is why the modelled look squeezes width
  (`widthPerCol` about 0.53 m, `src/render/vehicleLayout.ts:67`) and why collision had to
  follow the drawn body (`src/game/vehicleShape.ts`).

### 1.4 Power and fuel

All units come from the loader; BN stores plain integers in watts (`veh_type.h:243-259`,
`veh_type.cpp:415-417`).

- **Engines** (`location: engine_block`):
  - `power` is the maximum output in W.
  - `energy_consumption` is the fuel burn in W.
  - `m2c` is the ratio of safe power to maximum power.
  - `fuel_options` lists the accepted fuels. Diesel engines take diesel, biodiesel, lamp oil,
    motor oil and JP-8. Gasoline engines take gasoline, avgas, ethanol and methanol
    (`combustion.json`).
  - Electric motors run from 0.8 to 475 kW on batteries (`engine.json`).
  - Sails and animal harnesses also exist.
- **Several engines:** total power is scaled by 4/(4+n−1), and alternators subtract from it
  (`vehicle.cpp:3879-3902`).
- **Electrical parts** (`epower`, in W):

  | Source | Output |
  |---|---|
  | Car alternator | 780 W |
  | Solar panel | 40 or 80 W (the v2 panel ×2, v3 ×6) |
  | Wind turbine | 30 or 90 W |
  | Water wheel | 240 or 540 W |
  | Minireactor | 100 kW |

  Consumers draw negative epower: a fridge uses −60 W and a heater −700 W. A car battery
  stores 3000 kJ.
- **Tanks** (`fuel_source`) take their capacity from the base item's container volume, not
  from the part's `size` field (`vehicle_part.cpp:298-304`).
- **The self-sufficiency arc** players chase: gas → diesel or biodiesel → hybrid (small engine
  plus generator plus electric motor) → solar and batteries. An NPC hint points at it: "If I'd
  plan for the long run, I'd consider learning about steam engines, or maybe making biodiesel"
  (DDA `data/json/npcs/hints.json:158`).

### 1.5 Combat parts

- **Armour** (`location: armor`) takes the whole hit. The part under it takes the damage minus
  the armour's resistance. Roof and on-roof parts are not covered (`vehicle.cpp:6774-6798`).
- **Rams** are structure-location parts with `PROTRUSION` and `OBSTACLE`, so nothing else can
  mount on them. Their `damage_modifier` is 150 (steel), 200 (spiked) or 250 (horizontal
  blade, `SHARP`) (`rams.json`).
  - Quirk: `dmg_mod/100` uses integer division, so 150 and 170 both become ×1
    (`vehicle_move.cpp:592-594`).
  - Spiked plating is armour that hits back.
- **Crash shock** spreads over the whole vehicle, falling off with distance, whenever the hit
  is big enough (`src/map/map.cpp:1353-1375`). Shock absorbers reduce it. This is why fragile
  interior parts (solar panels, kitchens) break first, a long-standing player complaint (DDA
  issue #3053).
- **Turrets** are real guns mounted on a turret mount on the roof. Turret controls add
  auto-fire, and `USE_TANKS` feeds a turret from the vehicle's tanks.

### 1.6 Utility parts: the "mobile base"

- **BN has no explicit mobile-base concept.** It emerges because nearby vehicle tiles feed the
  crafting inventory: cargo contents, `CRAFTER` integrated tools powered by the batteries, and
  `FAUCET` water from the tanks (`src/inventory.cpp:573-620`).
- **The parts** (`data/json/vehicleparts/crafting.json`, `cargo.json`, `furniture.json`):

  | Group | Parts |
  |---|---|
  | Crafting stations | Kitchen unit (faucet plus hotplate, pot, pan, 50 L cargo), welding rig, craft rig (dehydrator, vacuum sealer, purifier...), chem lab, forge, kiln, workbenches, 3D printer, reloading press |
  | Water and cold storage | Water purifier, shower, fridge and freezer (200 L each; the fridge draws 60 W) |
  | Living | Beds and reclining seats (sleep), autodoc, recharge station, heater, cooler, NBC seal |
  | Cargo | 500 L cargo space, lockable boxes, animal compartments, bike rack |

- **The hull:** roofs, doors (`OPENABLE`, `BOARDABLE`), windshields, boards (opaque walls),
  curtains, headlights and floodlights. Dome lights are a flag on the dashboard, not a part of
  their own.
- **NPCs can work on vehicles** through the `VEHICLE_REPAIR` and `VEHICLE_DECONSTRUCT` zone
  activities (`src/activity_item_handling.cpp:109-137`).

### 1.7 What BN changed versus DDA

- **Part shapes.** An abstract part's `shapes` array generates `<id>_<direction>` ids, and the
  UI has a "Change shape" mode (`veh_type.cpp:528-544`). DDA uses `variants` instead.
- **Blueprint prototypes.** A vehicle can be defined as a blueprint plus a palette; 26
  prototypes are defined that way. Paint colours come from palettes.
- **Three-dimensional mounts.** Mount points take an optional z (vanilla data never uses it),
  and parts have a per-part `z_terrain` for ramps.
- **More vehicle types:** aircraft and balloon parts (BALLOON, WING, PROPELLER, LADDER,
  EXTENDABLE), and a `wheel_type` enum (standard, off_road, treads, rail...).
- **Units are plain integers in W.** DDA writes strings such as `"15000 W"`.
- **No appliances.** DDA has them; BN does not.
- **`can_mount` returns a bare bool,** so BN's UI can't say *why* a part won't fit. DDA returns
  reasons ("There's no structure to support it.").

### 1.8 The interaction screen (`veh_interact`), and why it is tedious

- **The screen.** Modes are install, repair, mend, refill, remove, siphon, unload, assign
  crew, change shape, relabel and rename (`veh_interact.cpp:229-256`). None work while the
  vehicle is moving. Install, repair and remove also need light and morale.
- **One part = one activity.** There is no batch install. The only batch path is NPC zone
  activities.
- **Moving the cursor tile by tile.** Parts that can't be installed are dumped below a divider
  with no reason given.
- **Stacked prerequisites** (frame → wheel mount → wheel, turret mount → turret, roof → solar
  panel) are invisible until you know them.
- **Each part has its own tool, skill and lift/jack check.** The jack must be rated for the
  *whole vehicle's* mass, and welding charges must be within reach.
- **The scale of the work:** 24 tiles and about 80 parts × 20–60 minutes each, for a car.

### 1.9 What our port implements today

Our port can drive, fuel, handle doors and trunks, crash, run things over, hotwire, and
open cargo panels. It cannot yet do construction, install, remove, repair, towing, turrets or
siphoning.

- `src/game/vehicle.ts`: the grid (`addPart`, `partsAt`, `occupiedTiles`), mass, power,
  drag, fuel, electrics, collisions and spawning. It is data-complete: 813 part ids and 257
  prototypes in `public/data/vehicles.json`.
- `src/game/vehicles.ts`: the system, driving, crashes and run-overs.
- `src/game/vehicleShape.ts`: collision against the drawn body.
- `src/ui/vehicle_ui.ts`: the part menu (cargo, controls, **hotwire**, parts list),
  refuelling (`src/game/refuel.ts`) and the cargo panel.
- Rendering (`docs/VEHICLES.md`): 11 modelled body styles picked from the prototype id, with
  `src/render/vehicleFrame.ts` as the "tidy fallback" for odd grids and player-built rigs.

Part *data* for building exists, but no building rules, jobs or user interface do.

---

## 2. The deathmobile: lore and player culture

### 2.1 In the game's own data

"Deathmobile" is **not** an item, book, achievement or prototype in either game. It appears
only in flavour text:

- **Direct mentions of "deathmobile":**
  - Survivor note_224 (BN `data/json/snippets/survivor_notes.json:585`, DDA :556): "…heard
    scrapper Joe put one [a hybrid's engine controller] in his deathmobile and now doesn't need
    gas at all… then again, Joe is full of shit…"
  - DDA `data/json/snippets/robot_finds_kitten.json:439`: "Looks like a fully-functional
    deathmobile."
- **The best single line of lore** is survivor note_113 (BN `survivor_notes.json:286`): *"This
  thing isn't a car any more. It's just a fucking mountain of metal on wheels, which I live
  in."*
- **Mad Max flavour:**
  - Gas pump description (BN `terrain-manufactured.json`): "There's plenty left over to fuel
    your inner road warrior."
  - NPC chat (DDA `talk_tags_chat.json:209`): "Less dirt, more Mad Max."
  - Followers ask for "a vehicle with a bit more legroom next time"
    (`talk_tags_follower.json:524-556`).
- **BN only: the Road Warrior profession** (`data/json/professions.json:5957-5962`). "You lived
  by your wheels during the first few months of the apocalypse…" You start with
  `car_roadwarrior`, the **"Wasteland Interceptor"** (`data/json/vehicles/custom_vehicles.json:169-171`),
  and an Australian cattle dog. It is a direct Mad Max nod.
- **Survivor-built prototypes** already in the data:
  - Survivor Car, Survivor RV and Technical (both games).
  - Bandit Bulldozer and Meth Bike (BN).
  - Mobile Meth Lab (DDA).
  - Homebuilt Wooden Plane (BN).
- **BN's in-game help** (`data/help/texts.json:248`): "You can even create a vehicle from
  scratch… Tuning a vehicle for speed, fuel consumption, off-road capacity, protection against
  threats, and cargo capacity is a complicated process."
- **Mechanics books and magazines** are the progression path: *Under the Hood*, the army
  field-repair manual, *Popular Mechanics*, *Car Craft* and the car owner's manual
  (`items/book/mechanics.json`, `driving.json`).

The fantasy is in the game, but only implied. It is the players who named it.

### 2.2 Player culture

The source is Discourse. Reddit and Steam couldn't be fetched; see the gaps in
[Sources](#sources). The community's own definitions (MutaMan, "Mobile base/deathmobile",
Discourse 24001):

- **Deathmobile:** "a 3x3-5 heavy framed, offroad-capable, steel or military composite armour
  plated ram on wheels" that reaches "top speeds of 80+ to plow through hordes."
- **Mobile base:** a "really large solar-powered behemoth of ample storage space, a crafting
  area, sleeping spot, freezer, a driving seat 3 or more spaces away from your walls so that
  grabber zombies can't simply yank you out, and turrets galore."

**What players love:**

| Theme | Evidence |
|---|---|
| Identity and showing off | "Post Apocalyptic Car Show: Deathmobile Expo 2018" thread. Named rigs ("Rolling Thunder", "Z-1 Abrams" with 4 solar arrays and 3 minireactors). |
| Self-sufficiency | "big vans covered in solar panels, with a bed, a forge, a welder, and cargo space". Essentials: "welder, a chemistry/cooking station and a refrigerator". A diesel kept "as a failsafe". |
| Mobile fortress | "Mobile fortress base, complete with living space, storage, crafting, and firepower". "Carry 40 tonnes of cargo in an 18 tonne vehicle". |
| Tuning and problem solving | Heavy-duty frames at the front for ramming, ammo kept away from the outer tiles, hybrids, stowable boards. |
| A long project that starts from a good find | Refit a semi ("entirely heavy duty frames, room for expansion"), a SWAT van, an APC. Build "just the cockpit" first as a mini-deathmobile. Start with a wooden bike. |
| Several vehicles for different jobs | "4 for different situations". |

**What players find tedious:**

| Pain | Evidence |
|---|---|
| Game time burned while nothing happens | Refitting a van took "several hours real time and close to 2 seasons game time. Most of that time was spent doing nothing at all." A dev (mlangsdorf): "each bush hit turns into several hours of repairs. This is unfun." (Discourse 12585) |
| Lift and jack gating | "Being unable to harvest tires from wrecks without being able to lift the entire thing is badly broken." "Multiple jacks don't count." (Discourse 11800; DDA #25285). BN ships the No Lifting Reqs mod. |
| The wrong component is picked | "the most damaged steel frame ever instead of the stack of perfectly new shiny ones" (DDA #53847). To get the right battery you must carry the empty one. |
| No reasons, no planning | No blueprint or preview tool exists anywhere. The only export is a debug "Export vehicle as prototype". |
| Huge builds are miserable to drive | "8 tile wide, 16 tile long land boat monstrosity… a great deal of IRL time just trying to move it" (Discourse 26602). Bushes stop 17-tonne trucks (DDA #28453). |
| Collision spreads to fragile parts | Solar panels and kitchens shatter before the frame does (DDA #3053). |
| Bugs on huge builds | A 12-engine build that wouldn't move (#18125); a crash when adding parts to a 50-tonne vehicle (#65481). |

---

## 3. How 3D games do vehicle building

| Game | What you build | How fine-grained | Parts from | Looks and scale | Lesson |
|---|---|---|---|---|---|
| **Rust** (modular cars) | A car from a chassis and modules | A chassis with **2, 3 or 4 sockets**. Modules take 1 or 2 sockets (cockpit, armoured cockpit, engine, storage, camper, flatbed, passenger, fuel). Each engine module has a nested **engine-parts grid** (carburettor, crankshaft, pistons, plugs, valves) in **low, medium and high quality**. | ~60 roadside wrecks with random modules, crafting, junk piles, traders | Every combination reads as a real car or truck, because modules are authored to fit shared rails. Weight costs speed. | Closest match to CDDA shrunk to first person. Two socket levels separate "shape" from "tuning". The **car lift** is a powered garage station where you drag modules into sockets. Field repair is done with a hammer. The camper module is a mobile respawn point. |
| **Pacific Drive** | One hero station wagon | Fixed slots (4 wheels, 5 doors, panels, bumpers, lights, engine, roof gadgets) with tiered parts (duct-taped → shielded) | ~143 blueprints, crafted in the garage | Always the same wagon, dressed up. Parts are fitted by hand in first person. | Attachment to one car ("one of the best vehicles in videogames"). Haunted "quirks" make repair a puzzle. Players complain about the grind of upgrade trees and materials. |
| **Mad Max (2015)** | The Magnum Opus | 18+ slot categories (ram grill, armour, engine, exhaust, tyres, suspension, spikes, harpoon, body style, hood ornament) | Scrap currency, convoy kills | Every upgrade **changes the silhouette**. Weight trades against handling. Archangel presets. | A visible bolt-on beats a +2.5% stat. The in-world mechanic, Chumbucket, repairs the car when you step out. |
| **Crossout / Robocraft** | Free-form combat vehicles | Blocks inside a cabin's mass and energy budget | Crafting, market | Wedge and brick metas: "the optimal shape is ugly". | Free-form building plus balance is a trap. Robocraft lost players after changing its building rules and shut down in 2025. |
| **Trailmakers / Scrap Mechanic / Besiege / Stormworks** | Anything | A free block grid with physics | Crafting and loot in survival modes | Anything goes. Stormworks can build whole cockpits. | A huge ceiling and a huge learning curve ("still learning after 3,500 hours"). Trailmakers' centre-of-mass and force overlays help. Scrap Mechanic's physics differ between Creative and Survival, which breaks trust. |
| **DayZ** | Repair a found car | Attachment slots on the car: wheels, battery, spark plug, radiator, doors, hood | Scavenging | Stock models | Fragile cars plus unreliable physics make players furious. |
| **7 Days to Die** | Minibike, 4x4... | A recipe (chassis, engine, battery, wheels) plus 3–4 mod slots | Crafting, magazines gate the skill | Mods barely show | Invisible mods don't register with players. |
| **State of Decay 2** | Upgrade a found car | Light, medium or heavy upgrade **kits** applied in a base parking spot | Auto shop, traders | Visible armour and rams | Low friction suits a game about managing people. |
| **Jalopy / My Summer Car / The Long Drive** | A DIY car | Individual components (My Summer Car goes down to bolts and spanner sizes) | Buying, finding | A real car | Pride of getting it running is the cult appeal. Realism goes stale; Car Mechanic Simulator is "satisfying for 20–30 h, then tedious". |
| **Road Redemption** | — | Stat upgrades | Currency | Bikes don't change | "+2.5% feels meaningless." |
| **Subnautica Cyclops** | A mobile base (a submarine) | A 6-slot upgrade console in the engine room, a fabricator on board, lockers, beds and a docked mini-sub | Crafting | A big, clunky, walkable interior | Players love it as a "mini mobile base" they walk around inside. |
| **Death Stranding / No Man's Sky / Sunkenland** | Cargo trucks, exocraft, boats | Weapon add-ons / a tech-slot grid / a modded base on a boat | — | — | Load against terrain is the real trade-off. The appetite for "my base moves" is under-served. |

**Lessons that apply across these games:**

1. **One hero vehicle you personalise creates attachment.** A garage full of anonymous
   vehicles creates utility, not affection.
2. **Changes should be visible.** Every meaningful part should change the mesh, even crudely
   (plates welded over windows).
3. **Sockets or a constrained grid keep builds looking like real vehicles.** Free-form
   building attracts dedicated builders and loses newcomers.
4. **Nested granularity works.** A shape layer (chassis and modules) sits above a
   tuning/condition layer (engine parts, quality, wear). Casual players only touch the top
   layer.
5. **Part quality and condition are the power knob,** and salvage feeds them.
6. **The garage is a place.** Big edits happen at a lift or workshop; small fixes happen
   anywhere with a tool.
7. **Show weight and physics before you drive.** The preview must match the simulation.
8. **The mobile base you walk around inside is the most-praised feature** wherever it exists.
   In first person it is our strongest differentiator.

---

## 4. Design directions

### The problem, stated

- **The grid is too big for the car.** BN's grid is about 2× a real car's width, because
  mirrors and doors take whole 1 m cells. Drawn at real scale it looks like a pancake; drawn
  squeezed, it disagrees with the tiles.
- **Wave 3 patched this for spawned vehicles only.** Collision follows the drawn body. But a
  *player-built* grid has no body style to draw, so it falls back to `vehicleFrame.ts`, where
  every part sits on its own 1 m tile.
- **Any building system has to decide two things:**
  1. What the unit of building is (a 1 m cell, a smaller cell, a socket, a module).
  2. Who owns the silhouette (the player's grid, or an authored chassis).

### A. The user's idea: one preset chassis, larger than the stock vehicles

You can't lay frames freely. There is one authored chassis, "the rig", sized somewhere
between a box truck and a school bus. Think of the Survivor RV cut down to a flatbed: a cab at
the front, a long deck and a roof. You find or earn it (a chassis stripped at a truck depot, or
a quest), and then fill fixed zones:

- **Nose:** ram, blade or plough.
- **Cab:** controls, dash, seats.
- **Engine bay:** engine, alternator, tank.
- **Sides:** armour panels, doors, windows, boards.
- **Deck interior:** a grid of cells for the kitchen, bed, fridge, workbench, cargo...
- **Roof:** solar panels, turret, rack, floodlights.
- **Under:** wheels and axles.

| | |
|---|---|
| Newcomers | Very friendly. The shape is given, so the choices are "what goes here". |
| Deathmobile fantasy | Strong for *the* deathmobile and mobile base. Weak for "my bike" or "my rice-burner interceptor". Every player's rig looks alike. |
| 3D look and scale | Best. One chassis authored at real scale, with collision equal to the drawn body by construction. It is bigger than stock, so there is room to walk around inside (the Cyclops lesson). |
| Physics honesty | Easy. The footprint is fixed and known. |
| Found vehicles | Only as parts donors. You can't adopt a found SWAT van, which cuts against the common player path. |
| BN data reuse | Parts map by `location` onto zones; the power, fuel, cargo and crafter data carry over directly. |
| Cost | Lowest of the building options: one model plus zone rules plus a user interface. |

### B. Chassis templates in a few sizes, with sockets (Rust-style)

Direction A generalised into a ladder of chassis:

- **Bike frame:** 1 wide, a few sockets.
- **Car:** 2 axles, cab plus trunk.
- **Pickup or van:** cab plus bed or box.
- **Truck or bus:** a long deck. **This top rung is direction A's "rig".**

Each template is an authored body at real scale with typed sockets, and those sockets map onto
BN's locations:

| Socket | BN locations |
|---|---|
| Frame | structure |
| Wheel | under |
| Cabin cell | center |
| Panel | armor, plus doors, windows and boards |
| Roof | roof, on_roof |
| Engine bay | engine_block, fuel_source, alternator |

Interior cells stay a small grid. The outer shell is sockets, so the silhouette stays a
vehicle. Panels are authored per template (plates welded over windows, spikes, a cow-catcher),
so every upgrade shows.

| | |
|---|---|
| Newcomers | Friendly. The ladder is a progression (bike → car → van → rig) that teaches one layer at a time. |
| Deathmobile fantasy | Strong. Your own named rig, with variety in size and role. It supports "several vehicles for different jobs". |
| 3D look and scale | Good. Each template is authored at real scale, so no squeezing. The existing modelled body styles (`vehicleModel.ts`) are already half of this: the styles become templates. |
| Physics honesty | Good. The template gives the collision body, and crashes can hit sockets by side. |
| Found vehicles | Natural. A found sedan *is* a car template with sockets filled. You adopt it, strip it, refit it. Wrecks are socket donors. |
| BN data reuse | High. Parts keep their stats; only placement changes (location → socket). Quality and condition come from BN's damage levels and faults. |
| Cost | Medium to high. Templates, a socket editor, mapping every BN part to socket kinds, and saves that migrate old grids. |

### C. Adopt and refit found vehicles (Mad Max / Pacific Drive)

No building from scratch at all. You claim a found vehicle as *your* car (name it, and its
history and marks persist). Upgrades are slot categories over its existing body: ram, armour
per side, window mesh, roof rack or panels, engine swap, tyres, one or two interior modules.
The deathmobile comes from progressively armouring an APC, bus or semi.

| | |
|---|---|
| Newcomers | Most friendly. It's a garage menu, or bolt-ons in the world. |
| Deathmobile fantasy | Medium. Strong on identity and power fantasy, weak on the "I designed this" pride and the free mobile-base layout. |
| 3D look and scale | Good. It reuses the wave-3 models and adds bolt-on meshes per style. |
| Physics honesty | Good. The body collision already exists. |
| Found vehicles | Central. |
| BN data reuse | Medium. Many parts are dropped or folded into slot tiers. |
| Cost | Lowest overall. |

### D. An honest free grid: BN's rules with a home-made look (the "faithful" option)

Keep BN's free 1 m grid and the full part rules. Don't try to make custom builds look like
factory cars: draw them as what they are, welded frames, plate walls and a boxy home-made rig
(Mad Max rather than Toyota). That is honest at 1 m scale, and collision is simply the grid.
Factory cars keep their modelled bodies. Once you weld a frame onto one, it switches to the
home-made look for that section.

| | |
|---|---|
| Newcomers | Poor, unless direction E is added. The build space is huge, with invisible prerequisite chains. |
| Deathmobile fantasy | Maximum for veterans: total freedom, and the lore fits ("a mountain of metal on wheels"). |
| 3D look and scale | Home-made rigs look fine (they're meant to be boxy). A 1 m frame cell is a real welded frame. Mixed factory/home-made vehicles are the hard part. |
| Physics honesty | Exact. The grid is the collision. |
| Found vehicles | Same as BN. |
| BN data reuse | Complete. |
| Cost | Medium: the rules port, a first-person build interface, a better `vehicleFrame` look. It risks the "Crossout wedge" problem, and huge builds are miserable to drive. Size caps would help. |

### E. Cross-cutting: plan first, then queue the work (applies to A–D)

This fixes the tedium that players complain about most, whichever direction is picked.

- **A blueprint or ghost mode.** Place parts as translucent ghosts on the vehicle in 3D. Each
  ghost shows green, or red *with a reason* ("needs a wheel mount", "needs a jack rated for
  3 t", "needs mechanics 4"). BN's `can_mount` returns only a bool, so we'd port DDA's reasons.
  Stats update live: mass, top speed, power budget, range, cargo, centre of mass.
- **Commit queues all the jobs.** It collects the materials (picking the *best* component, not
  the worst), then runs as one long activity. The clock runs fast; it pauses on danger; NPC
  helpers speed it up (BN's helper −10% already exists).
- **The garage is a place.** A lift, jack or crane station (or a found auto shop) waives the
  lift gate for big jobs. Small jobs work anywhere with a tool. This replaces the per-part
  JACK/LIFT maths with a readable rule. Keep the maths as an option; it matches BN's No
  Lifting Reqs mod.
- **Salvage is the inverse:** mark the parts you want on a wreck and queue "strip these".

---

### Recommendation (for discussion)

**B with A as its flagship, plus E, plus C's adoption.** Concretely:

1. **Start with A, the one big rig**, because it is the user's instinct, the cheapest, and it
   proves the socket and template machinery. Size it around 3 m × 9–10 m, like a box truck:
   big enough to walk around in, not so big it's a "land boat". Mount it on the existing
   collision-follows-body path.
2. **Next, make the existing modelled styles into templates** (sedan, pickup, van, bus). A
   found vehicle is then adoptable and refittable on the same sockets (C), and wrecks become
   donors.
3. **Build E on top:** ghost placement with reasons, then one queued job.
4. **Keep D, the free grid, one option away** for veterans, drawn as a home-made rig
   ("keep the old version one option away", `docs/ADAPTATION.md`).

## 5. Open questions for the user

1. **Scope of "a set preset".** Should there be one rig only (A), or a ladder of chassis sizes
   (B) with the rig as the top rung? Can the player adopt a found vehicle as their own?
2. **Rig size and role.** Should the rig be a ramming deathmobile (about 3×6 and fast) or a
   rolling home (about 3×10, with a walkable interior, kitchen, bed and workbench)? Or one
   chassis with two deck variants?
3. **How is the rig obtained?** A found stripped chassis (truck depot, junkyard), crafted from
   frames at a garage, or given by a story beat (BN's Road Warrior start)?
4. **Should stock vehicles stay in BN's 1 m grid** (with the width squeeze) while only built
   vehicles use authored templates? Or do we move everything to templates, which would fix the
   collision mismatch for all vehicles but means a data migration?
5. **Gating.** Keep BN's skill, tool and lift requirements per part, or collapse them to "you
   need a garage or lift for structural work, and mechanics level X for this tier"?
6. **Time.** Installs as sped-up real-time jobs (current activity model), or instant in a
   garage menu with game time charged?
7. **Walkable interior while moving.** The mobile-base dream implies walking around inside
   while someone else drives, or while parked. Is that in scope? Our physics currently rides
   the player along (`playerOn`).
8. **Turrets and NPC crews:** in this pass or later?

## Sources

**Source code and data** (read-only; paths as cited inline):

- BN, `~/code/Cataclysm-BN`:
  - `src/vehicle/{vehicle.cpp, veh_type.cpp, veh_type.h, veh_interact.cpp, veh_utils.cpp, vehicle_move.cpp, vehicle_part.cpp, vehicle_use.cpp}`
  - `src/construction.cpp`, `src/inventory.cpp`, `src/map/map.cpp`
  - `data/json/vehicleparts/*.json`, `data/json/vehicles/*.json`
  - `data/json/requirements/{vehicle,toolsets}.json`
  - `data/json/professions.json`, `data/json/snippets/survivor_notes.json`
  - `data/help/texts.json`, `data/mods/No_Lift_Requirements/`
- DDA, `~/code/Cataclysm-DDA`: `doc/JSON/JSON_INFO.md`, `doc/VEHICLES_JSON.md`,
  `src/vehicle.cpp`, `src/debug_menu.cpp:1045-1048`, `data/json/npcs/hints.json`,
  `data/json/snippets/robot_finds_kitten.json`, `data/json/items/book/mechanics.json`
- This repo: `src/game/vehicle.ts`, `src/game/vehicles.ts`, `src/game/vehicleShape.ts`,
  `src/ui/vehicle_ui.ts`, `src/render/vehicleLayout.ts`, `public/data/vehicles.json`,
  `docs/VEHICLES.md`, `ARCHITECTURE.md` § Vehicles

**Community, Cataclysm:**

- https://discourse.cataclysmdda.org/t/mobile-base-deathmobile/24001
- https://discourse.cataclysmdda.org/t/post-apocalyptic-car-show-deathmobile-expo-2018/17277
- https://discourse.cataclysmdda.org/t/need-to-make-a-deathmobile-but-im-not-sure-what-to-do/14522
- https://discourse.cataclysmdda.org/t/advanced-deathmobile-building/15072
- https://discourse.cataclysmdda.org/t/deathmobile-tips-for-a-newbie/17299
- https://discourse.cataclysmdda.org/t/deathmobiles-talk/26602
- https://discourse.cataclysmdda.org/t/vehicle-build-repair-times-thru-the-roof-colors-changed/12585
- https://discourse.cataclysmdda.org/t/help-with-new-lifting-jack-rules/11800
- https://discourse.cataclysmdda.org/t/vehicle-building/25168
- https://cataclysmdda.miraheze.org/wiki/Sandbox:Building_a_Vehicle
- https://srgnis.github.io/cdda-wiki/cdda_wiki/Vehicle_construction
- DDA issues: [#3053](https://github.com/CleverRaven/Cataclysm-DDA/issues/3053),
  [#18125](https://github.com/CleverRaven/Cataclysm-DDA/issues/18125),
  [#25285](https://github.com/CleverRaven/Cataclysm-DDA/issues/25285),
  [#28453](https://github.com/CleverRaven/Cataclysm-DDA/issues/28453),
  [#53847](https://github.com/CleverRaven/Cataclysm-DDA/issues/53847),
  [#65481](https://github.com/CleverRaven/Cataclysm-DDA/issues/65481)
- DDA PRs: [#25193](https://github.com/CleverRaven/Cataclysm-DDA/pull/25193),
  [#43013](https://github.com/CleverRaven/Cataclysm-DDA/pull/43013)
- https://docs.cataclysmdda.org/JSON/VEHICLES_JSON.html ·
  https://docs.cataclysmbn.org/mod/json/reference/vehicles/vehicles_spawning/

**Other games:**

- Rust: https://www.rustafied.com/modular-vehicles-in-rust-guide ·
  https://www.corrosionhour.com/rust-modular-cars-guide/ ·
  https://wiki.facepunch.com/rust/vehicle_parts ·
  https://www.rustafied.com/updates/2020/7/2/modular-vehicles-are-here ·
  https://www.rustafied.com/updates/2020/5/15/vehicles-what-you-need-to-know
- Pacific Drive: https://www.pcgamer.com/pacific-drive-review/ ·
  https://www.psu.com/reviews/pacific-drive-review-ps5/ ·
  https://www.escapistmagazine.com/pacific-drive-is-an-electric-road-trip-with-brilliant-frustrating-systems-review/ ·
  https://www.destructoid.com/reviews/review-pacific-drive/
- Mad Max: https://gameinformer.com/b/features/archive/2015/03/16/building-your-nightmarish-dream-car-in-mad-max.aspx ·
  https://madmax-game.fandom.com/wiki/Garage
- Crossout: https://steamcommunity.com/app/386180/discussions/0/1480982338950040360
- Robocraft: https://en.wikipedia.org/wiki/Robocraft
- Trailmakers: https://trailmakers.wiki.gg/wiki/Building_Tools
- Scrap Mechanic: https://medium.com/beyond-the-game/scrap-mechanic-review-e9a99328504d
- Besiege: https://www.pcgamer.com/besiege-review/
- Stormworks: https://en.wikipedia.org/wiki/Stormworks:_Build_and_Rescue
- DayZ: https://xgamingserver.com/blog/dayz-vehicles-find-repair-cars/ ·
  https://feedback.bistudio.com/T153448
- 7 Days to Die: https://7daystodie.wiki.gg/wiki/Minibike
- State of Decay 2: https://twinfinite.net/guides/state-of-decay-2-upgrade-vehicles-how/
- Jalopy: https://jalopy.fandom.com/wiki/Laika_601
- The Long Drive: https://the-long-drive.fandom.com/wiki/Engine_Swapping
- My Summer Car: https://www.gamepressure.com/my-summer-car/the-basics/z1c80f
- Car Mechanic Simulator: https://www.gamepressure.com/editorials/reviews/car-mechanic-simulator-2021-review/zf46e
- Road Redemption: https://www.well-played.com.au/road-redemption-review/
- Subnautica: https://wiki.subnautica.com/sn/Cyclops · https://wiki.subnautica.com/sn/Upgrade_Modules
- Death Stranding: https://deathstranding.fandom.com/wiki/Pickup_Off-Roader
- No Man's Sky: https://nomanssky.fandom.com/wiki/Exocraft
- Sunkenland: https://www.nexusmods.com/sunkenland/mods/70

**Gaps:**

- Reddit (r/cataclysmdda) and Steam discussion pages couldn't be fetched, so player sentiment
  comes from Discourse, GitHub, wikis and reviews.
- Several GitHub issue summaries (#25285, #28453, #3053) come from search snippets; the issues
  themselves were not opened.
- Pacific Drive's hands-on install flow and some Rust lift details (price, public lifts) rest
  on weaker sources.

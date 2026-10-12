# World transport: what generates (audit 2026-10-09)

Read-only audit of overmap generation against BN (`~/code/Cataclysm-BN`: `src/overmap/overmap.cpp`,
`data/json/overmap/*`). Code read: `src/world/overmap/overmap.ts`, `tools/extract/mapgen.ts`,
`src/world/worldgen.ts`, `src/world/mapgen/bnbuiltin.ts`. Seeds 1, 2, 3, 42 and 743667900 were
probed over 3×3 regions (288×288 OMTs), z0 to −4, rendering one chunk of every oter type found.

## Status (2026-10-11, genVersion 2)

Everything below is gated on the world's generation version (`WORLDGEN_VERSION` in
`src/world/overmap/overmap.ts`, recorded in saves as `world.genVersion`). Saves made before it
run genVersion 1 and keep generating exactly the world they stored chunks of
(`tests/overmap_genversion.test.ts`); new games get genVersion 2.

| Item | State |
|---|---|
| Railroad station (`railroad_city`) | Town building, JSON mapgen, stairs to z−1. Existed before this work. |
| Railroad track network | Not a gap: BN core never lays rails (no special uses `local_railroad`). |
| Subway stations | Town building, JSON, stairs down to the z−2 platform. Existed before. |
| Subway tunnels | **Built.** `subway_tunnel` connections at z−2 join stations, urban_30/39, the mall, microlabs, lab cargo stations, lab train depots and mine stations, per region (`connections.ts`); genVersion 3 continues them across region edges (`seams.ts`, below). Rendered by the `mapgen_subway` port; track meets every station. |
| Sewers | **Built.** A sewer hub under every town centre, manholes on four-way streets, `sewer_tunnel` at z−1 joining them (BN's "city" layout). Rendered by the `mapgen_sewer` port plus BN's `mx_sewer_*` map extras. Covers stay shut until pried; a ladder under each leads down and back up. |
| `UNIQUE` specials | **Fixed.** At most one per region, chance scaled by region area; mutagen labs went from ~150 to 1–2 per 3×3 regions. Start-region guarantees kept. |
| Road stubs over underground connections | **Fixed.** Only `local_road` connections at z0 become roads. |
| Classic lab basement | **BN's mutable lab**: escape cells (~80%), train depots at z−2/−4 joined to the subway, deeper levels. |
| `lab_escape` start | **Built** for `lab_chal` / `lab_staff` (unlocked by reaching a lab). |
| Other mutable specials | **Placed** by one BN-faithful solver (`mutable.ts`): Anthill, Acid Anthill, Lab with Anthill, Slime Pit, Ice Lab, stream, and mine_tunnel under the four mines. |

Integration notes (lead): city sewer hubs are reserved at z−1 when the manhole candidate is
recorded, before any special places, as BN lays them while building the city (an anthill had
taken the rock under a town centre). `tests/transport_integration.test.ts` checks the hand-off
on real seeds: every station is entered by a tunnel whose track meets the platform (straight or
diagonally, as BN's tee does), and every manhole has a sewer with a ladder below it.
Real-input checks: `tools/realinput.ts --only sewer` (pry, climb down, climb out) and
`--only labescape`.

Remaining limits: genVersion 2 tunnels never cross region edges (networks are per region; genVersion 3 subways do, sewers deliberately don't); sunken_lab is
placed from genVersion 3 (lake columns, see "Lakes in depth") but rare; special-level roaming monster groups (e.g. GROUP_ANT) aren't spawned;

Remaining limits: tunnels never cross region edges (networks are per region); sunken_lab isn't
placed (no lake columns); special-level roaming monster groups (e.g. GROUP_ANT) spawn from
genVersion 3 ("Special spawns" below);
z is clamped to −7..5; `mx_portal`/`mx_casings` subway extras are C++ functions and not ported.

The sections below are each part's own notes.

## Overmap fixes (genVersion 2)

Every change below is gated on `Overmap.genVersion >= 2` (`WORLDGEN_VERSION`); saves made before
it run genVersion 1 and generate exactly as before (`tests/overmap_genversion.test.ts` pins nine
region hashes, z−4..1, for seeds 1, 42 and 743667900).

**`UNIQUE`.** BN `place_specials` (overmap.cpp 6392–6418) gives a `UNIQUE` special
`x_in_y(min, max)` chance of one per 180×180 overmap. A region is 96²/180² ≈ 0.28 of that, so
the chance is scaled by the area: the same expected count per OMT, at most one per region. The
start-region guarantees stay (one mutagen lab, one classic `Lab` and one microlab within a trek
of the start town: CBMs and mutagen need a lab, and BN only promises one somewhere on a much
larger overmap).

**Connections.** Only `local_road` at z0 is paved by `buildRoad`, as before. Every other special
or city-building connection (BN place_special 5904–5970 builds city buildings' connections too;
we used to drop them) becomes a `Region.connectionRequests` entry, built after the region's
terrain is final by `src/world/overmap/connections.ts`, a port of BN's overmap_connection:
`pick_subtype_for`/`can_start_at`/`has` (overmap_connection.cpp), `lay_out_connection` +
`greedy_path` (overmap.cpp 5220–5300, simple_pathfinding.cpp 42–115: best-first, existing
tunnel ×1 vs ×5 estimate, no turns through stations) and `build_connection`'s line bits
(5396–5500). Layout as in BN: `sewer_tunnel` ("city") links to the owning city's centre, then
to the nearest earlier sewer; `subway_tunnel` ("p2p") to the nearest earlier subway endpoint
(ten tries); failing both, a one-tile stub opening into the special so the next one can link to
it. The tunnel end opens into the special from the connection's `from` point (BN initial_dir).
Requests from code without a special def fall back to the one neighbour the special owns.

**Sewers.** Every city centre gets `sewer_isolated` at z−1 under a `road_nesw_manhole`
(overmap.cpp 4459–4460), and one in eight street branch points that end up a four-way road get
another, joined to the centre by `sewer_tunnel` (5161–5164, 4474–4476). Deviation: the centre's
manhole is only placed when it is a four-way (its mapgen is road_four_way); the sewer hub under
it is always there.

**Subways.** `sub_station`, `urban_30`/`urban_39`, the mall, microlabs and the mutagen lab's
cargo station (z−4) connect with `subway_tunnel`. BN never links subways across overmaps
(connections_out is only fed by paths that happen to reach the border), and neither do we across
regions: a region's tunnels are built from its own requests only, so nothing depends on which
neighbour generated first (tested). With regions smaller than BN overmaps, networks are smaller.

Extraction: `sewer` and the connection subtypes' terrains are in overmap.json, plus
`connections` (BN overmap_connections.json) — `CONNECTIONS_BUILT` in tools/extract/mapgen.ts.

`tsx tools/transport_probe.ts` (3×3 regions around the start, z−4..0):

| seed | mutagen labs v1 → v2 | microlabs v1 → v2 | manholes | sewer tiles | subway tiles (z−2) | subway networks | stations joined |
|---|---|---|---|---|---|---|---|
| 1 | 147 → 2 | 139 → 2 | 46 (all joined) | 594 | 628 | 9 | 35/35 |
| 2 | 135 → 1 | 176 → 3 | 43 | 737 | 701 | 6 | 29/29 |
| 3 | 178 → 1 | 176 → 1 | 46 | 675 | 466 | 6 | 19/19 |
| 42 | 155 → 2 | 146 → 2 | 36 | 203 | 253 | 6 | 17/17 |
| 743667900 | 171 → 2 | 168 → 2 | 34 | 340 | 264 | 8 | 17/17 |

Known limits: the mutagen lab's z−4 subway is always a stub (BN: no other z−4 subway to link
to either); a sewer or subway request whose point is already taken by another special's
underground is skipped (BN `can_start_at`); z0 requests other than roads throw.

## Underground transport OMTs: mapgen (branch transport-undermap)

What each sewer/subway OMT draws once the overmap places it (placement is a separate piece of
work). Tests: `tests/undermap.test.ts` (synthetic overmap fixtures, real data).

- **`subway_*`** (`bnbuiltin.ts` `mapgenSubway`, port of BN `src/mapgen/mapgen_functions.cpp`
  `mapgen_subway`, ~790): the five BN layouts (straight, diagonal curve, tee, four-way, dead end
  with buffer stops), cave moss and mushrooms, VehicleSpawn `default_subway_deadend` (half the
  dead ends hold 1-2 `trains_draisine`). Track runs on columns 4/8/15/19 like the JSON of
  `underground_sub_station`, `underground_lab_cargo_stationA_sub_station` and
  `microlab_sub_station`, so a tunnel whose line points at a station meets its track; BN's tee
  enters its stem with diagonal track one tile off those columns. `subway_isolated` keeps BN's
  groundcover (BN's switch has no case for 0 connections). BN's `SUBWAY` oter flag (neighbour
  pulls a connection in) is honoured but no BN terrain has it.
- **`sewer_*`** (`mapgenSewer`, BN `mapgen_sewer`, ~1106): rock with a 4-wide sewage channel
  (rows/columns 10-13) towards each connected side, a 2x4 centre pool for `sewer_isolated`, and
  `sewer` loot. BN's look comes from the **map extra**: region `map_extras.sewer` has chance 1, so
  every sewer gets one of 21 `mx_sewer_*` update_mapgen layouts (pipes, pumps, grates, walkways,
  maintenance rooms). `subway` rolls `map_extras.subway` (1 in 75: corpses of soldiers,
  scientists, campers; `mx_portal`/`mx_casings` are BN C++ and only counted as unsupported).
  `worldgen.ts` `applyMapExtra` runs extras for these two builtins only (BN runs every oter's
  extras; doing that generally would change existing chunks), with its own RNG stream and
  BN's suffix rotation. The extractor ships the tables as `mapgen.json` `extras`.
- **Manholes**: `road_nesw_manhole` keeps BN's cover position range (6..18 both axes) but takes
  it from an RNG keyed on the OMT (`manholeSpot`), and a sewer OMT under one puts
  `t_ladder_up` at the same tile, plus a concrete passage to the channel if the extra walled it
  in. Not BN: BN draws no ladder, drops you onto whatever is below and gives no way back up.
  The ladder is a walkable ladder link (docs/STAIRS.md); `<` from it lands on the cover.
- **Monsters**: the oters' own `spawns` (`sewer` GROUP_SEWER, `subway` GROUP_SUBWAY, 1-6 at
  30 %) go through the existing `addOterSpawns`; extras add their own `place_monster`s.
- **Lab sewer room** (`lab.ts` `drawSewerRoom`, lab.lua `draw_sewer_room`) fires for a classic lab
  OMT beside a `sewer`: the channel crosses the lab behind bars and lines up with the sewer's.
  Not BN: the room keeps the lab's stairs (lab.lua drops them, stranding the levels below).
- Debug: `cdda.stageOmts({"x,y,z": "sewer_nesw", ...})` stages oters for chunks not generated
  yet, for QA scenes. Screenshots (seed 1, staged next to the start):
  `docs/screenshots/transport/undermap_*.png` (manhole at z0, its ladder at z−1, sewer
  walkway, sewer and subway top-down, tunnel into a station).

Known limits: the stair system cuts a stairwell through the manhole cover above a ladder, so
covers read as open holes and need no prying (BN: pry, or climb up through the cover); the
railroad track sprites render very bright underground; tunnels rely on the overmap setting the
line bit towards stations (BN `build_connection` does).
   once #4 exists), and the `lab_escape` start. Done for genVersion 2, see below.
6. ~~**Other mutable specials**~~: done for genVersion 2 except sunken_lab, see below.

## Fuller lab_basement (genVersion 2, done)

BN's classic lab is a fixed `Lab` special (z0 `lab_stairs` bunker) whose `place_nested` grows the
mutable `lab_basement` (`data/json/overmap/overmap_mutable/lab.json`) one level down, rotated like
the bunker (`overmap.cpp` 6000–6011). genVersion 2 grows it with a port of BN's mutable special
solver, `src/world/overmap/mutable.ts` (`mutable_overmap_special_data::place`, `joins_tracker`,
`mutable_overmap_phase_remainder::satisfy`/`can_place`, `z_constraints`: `overmap.cpp` 1246–2390;
`int_distribution`: `distribution.cpp` 40–140). genVersion 1 keeps the old 4×4-box grower
(`placeLabBasementV1`); `tests/lab_basement.test.ts` pins five regions' oter grids at version 1.

- **Shape.** Shared `size` is `[4, 4]`, so every `scale: "size"` rule multiplies by 4: ~16 lab rooms
  and ~16 stairs-over-core chunks in phase 1 (the chunks only at the current bottom level), then
  the later phases. BN labs are therefore deep: seeds 1–10 (53 labs) median 60 OMTs, 50 of 53 reach
  our floor, z−7 (`MIN_Z`; BN's is −10). Once the lab rooms run out, the leftover stair chunks
  pile up on the bottom two levels (BN does the same at −9/−10).
- **Escape cells.** The `lab_escape` chunk (`lab_escape_entrance` + `lab_escape_cells` north of it,
  never rotated) at z −10..−4 with `{"chance": 0.2}` × size 4 = 80% (`chance_distribution::sample`:
  `chance * scale >= rng_float(0, 1)`), not 20%. Measured 81%. The cells reject lab joins north,
  east and west, so they hang off the entrance alone. Mapgen: `data/json/mapgen/lab/lab_escape.json`
  (five 3×6 cells, four with a zombie, the middle one with a smashed window into the entrance room
  and its `mon_zombie_brute`).
- **Train depots.** `lab_train_depot` at z−2 and at z−4, `{"chance": 1}` × 4, so one on each
  wherever a frontier OMT fits (measured 100% / 100%). Its north side rejects lab joins and carries
  `"connections": {"north": {"connection": "subway_tunnel"}}`, rotated with the special: the depot
  pushes a `Region.connectionRequests` entry (`connection: "subway_tunnel"`, the OMT next to its
  open side, region-local, at the depot's z, `uid` = the Lab) for the subway builder. The oter is
  NO_ROTATE; its mapgen (`lab_trains.json`) opens a tunnel mouth (`lab_train_subway_<dir>`) on any
  side whose neighbour is a `subway_tunnel` oter whose line points back
  (`jmapgen_nested::neighbor_connection_check`, `mapgen.cpp` 2780–2815; now honoured by
  `jsonmapgen.ts` from the extracted `connectionTerrains`). With no subway there it is a sealed room.
- **Start.** `lab_chal` and `lab_staff` (BN `allowed_locs` include `sloc_lab_escape_cells`) map to
  placement `lab_escape` in `src/progression/placement.ts`: the nearest `lab_escape_cells`
  (`Overmap.findUnderground`), an empty cell in it (flood fill, no monster spawn, ≤ 30 tiles).
  The start region's guaranteed classic lab regrows with fresh RNGs (≤ 64 tries) until it has the
  cells, so the start always exists without the overmap depending on the scenario. Both are
  scenario unlocks (`public/data/unlocks.json`, reach a lab). BN offers `sloc_lab_random`,
  `sloc_lab_finale` and the Ice Lab ones too; we only place the cells.
- **Not done.** The challenge scenarios' forced traits and bionics aren't applied (starts are
  sidegrades, docs/DESIGN_V2.md). The other mutables are in the next section.
- **Solver.** Two solver ports were written in parallel; they were merged into one
  (`mutable.ts`, see the next section). placeLabBasement grows through `MutableSpecial.grow`,
  which runs that solver on a scratch overlay so the escape-cell retries need no undo.

## Mutable specials (genVersion 2)

BN grows `"subtype": "mutable"` specials from a root terrain by matching *joins* on the six
faces of each OMT, phase by phase (`overmap.cpp` `mutable_overmap_special_data::place`,
`joins_tracker`, `mutable_overmap_phase_remainder::satisfy/can_place`, ~1227–2390). We port it:

- **Extraction** (`tools/extract/mutable.ts`, called from `mapgen.ts`, into the one `mutables` map
  also holding `lab_basement`): every mutable special
  normalized to `MutableSpecialDef` (joins with opposites/into_locations, overmaps with typed
  joins and connections, rules with `max`/`weight`/`scale`/`z`/`join`/`rotate`, chunks,
  `check_for_locations[_area]`, `shared`). Unknown shapes throw (`om_pos` is unsupported and
  unused). Shipped: the specials in `MUTABLE_WILD_SPECIALS` and the mutable specials they nest.
  Their terrains are extracted after all earlier content, so existing mapgen ids keep working.
- **Solver** (`src/world/overmap/mutable.ts`, the one solver for every mutable special; of the two
  ports written in parallel this one was kept because it records BN's `joins_used` for mapgen,
  scales fixed `max` values like `fixed_distribution::sample` (v × scale), keeps BN's two
  "finished" verdicts apart and runs on any `MutableGrid`; the lab port's overlay-and-commit
  growth survives as `MutableSpecial.grow` on top of it): a line-for-line port, including BN's quirks
  (a candidate must match every mandatory join on its OMTs because `best_result` starts at
  {0, 0}; rules weigh `min(max, weight)`; a phase ends when nothing is unresolved or every rule
  is exhausted; terrain is committed as it goes and never rolled back). It only sees the world
  through `MutableGrid`, so it is unit-tested on synthetic grids (`tests/mutable_solver.test.ts`).
- **Placement** (`src/world/overmap/mutable_place.ts`, one call in `generateRegion` after
  `placeSpecials`, on its own RNG stream `hashSeed(seed, rx, ry, 0x6d75)`): BN `place_specials`
  for `mutableWildSpecials` — biggest first, shuffled candidate tiles, `random_special_rotation`
  (connection scoring), `can_place_special` (required locations incl. nested specials, default
  terrain below/above ground accepted), cities only when `requires_city` (BN's
  `can_belong_to_city` subtracts the city size twice; kept), SPECIALS_SPACING 6 between them.
  Nested: `lab_basement` → `placeLabBasement`, `mine_tunnel` → the solver.
  Connections: `local_road` at z0 through the road builder; everything else (Ice Lab
  `lab_train_depot` and the mines' `subway_tunnel`) is pushed to `Region.connectionRequests`.
- **Occurrences / UNIQUE.** BN numbers are per 180×180 overmap; a region is 96×96
  (`REGION_AREA` = 0.284). UNIQUE (Anthill, Acid Anthill, Lab with Anthill, Ice Lab): a
  `min/max × REGION_AREA` chance of one per region (BN: `x_in_y(min, max)` per overmap).
  Others: `roll_remainder(rng_float(min, max(min, max × land_ratio)) × REGION_AREA)`.
  The ordinary-special UNIQUE fix should use the same scaling so the two agree.
- **Joins for mapgen.** The joins the solver matched are kept (`Overmap.joinAt`); JSON mapgen's
  nested `"joins"` conditions now read them (the ant tunnel under an anthill gets its slope up).
- **Mapgen.** Ant tunnels, anthills, streams, mines' fixed parts, lab escape/train depot: JSON.
  Ice Lab: `lua:lab_ice` (lab.ts). Ported here: `mine`/`mine_down`/`mine_finale` (BN C++
  `draw_mine`, minus artifacts), `slimepit`/`slimepit_down` (`slimepit.lua`), `rock`
  (`mapgen_rock_partial`). Linear JSON mapgen now uses BN's inverted linear rotation
  (`oterRotation`), which only the ant tunnels exercise. Nothing falls back.
- **Reach** (`tools/dev/probe_mutable_render.ts`, flood fill from outside, seeds 1, 2, 42):
  anthills 100 % of OMTs, Ice Labs ~90 % (BN's lab.lua puts stairs only on `t_thconc_floor`,
  so some ice floor plans get none — same in BN), slime pits all levels (the rest is solid
  `rock` filler), mines all levels but a few seams: `draw_mine` narrows a side 1 time in 10
  and two narrowed sides can seal a seam (BN-faithful; rock is mineable). Spiral/Amigara mine
  finales are fixed-special content, often sealed by design.

Counts per 3×3 regions (seed: Anthill / Acid / Lab+Anthill / Slime Pit / Ice Lab / stream /
mine_tunnel): s1 0/1/0/1/0/3/8, s2 0/1/0/1/1/2/11, s3 1/0/1/5/2/2/9, s4 0/1/1/4/1/2/16,
s42 0/0/2/4/2/1/7, s743667900 0/0/2/5/0/1/4 (after the lab_basement merge: the deeper BN labs
occupy rock the later specials would have used, so placements moved). `tools/dev/probe_mutable.ts <seed>...` prints these.

Not done: **sunken_lab** (done for genVersion 3, see "Lakes in depth"); special-level roaming monster groups (`spawns`, e.g.
GROUP_ANT 1000–2000) — the OMTs' own spawns (ants, ants_food) do fire; z is clamped to our
MIN_Z..MAX_Z (−7..5) instead of BN's −10..10.

## Cross-region subways (genVersion 3)

genVersion 2 built every tunnel network inside one 96×96 region, so subways came out as 7–9
separate networks per 3×3 regions, none reaching a station in another region. genVersion 3 lets
subway tunnels cross region edges; genVersion 1 and 2 output is unchanged (pinned by
`tests/overmap_genversion.test.ts`, and `tests/overmap_seams.test.ts` checks v2 has no crossing).

**BN.** BN never links networks across overmaps on purpose: `build_connection` only records a
path end that happens to touch the border in `connections_out` (src/overmap/overmap.cpp:5463),
and an overmap generated later picks up its already-generated neighbours' border points
(`populate_connections_out_from_neighbors`, overmap.cpp:3680–3711) — order dependent, which we
can't afford. Its overmaps are 180×180 though, so per-overmap networks are big; ours have
0.28 of the area. Layouts: `subway_tunnel` is `"layout": "p2p"` (data/json/overmap/
overmap_connections.json:27: each new endpoint links to the nearest earlier one), `sewer_tunnel`
has the default `city` layout (src/overmap/overmap_connection.cpp:195: each manhole links to its
own city's centre).

**Seams** (`src/world/overmap/seams.ts`). Regions generate lazily, in any order, so a crossing is
derived from the seed alone, like road portals (`overmap.ts portal()`): for every region edge,
keyed by the region that owns it (the one to the west/north), `hashSeed(seed, ox, oy, side,
0x5e4, 1) % 100 < 35` decides whether a subway crosses and `hashSeed(…, 2)` its offset along the
edge (kept 8 OMTs from corners). Both neighbours compute the same point. Each region then:

1. reserves its half of every crossing on its edges at z−2 right after the base terrain, before
   cities and specials (`reserveSeams`): `subway` with the one line bit that points across the
   edge. Fixed specials skip occupied z≠0 tiles and the mutable/lab solvers need their own
   locations (`subterranean_subway` is used by none), so nothing can take it;
   `buildConnections` throws if one was overwritten (none over 750 regions, seeds 100–129);
2. builds its own connection requests exactly as before (stations, labs, mines…);
3. joins each half to its network with the p2p rule (`ConnectionBuilder.connect` with
   `initialDir` pointing back across the edge): the nearest earlier subway endpoint, ten tries; in
   a region without a subway the first crossing is a stub and later ones link to it, so a region
   with no stations still carries a line through.

Nothing a region builds depends on its neighbours, so the result is order independent (tested:
a region generated alone hashes the same as after its eight neighbours, z−7..1), and the halves
always line up because each carries the across-edge bit from step 1.

**Sewers don't cross**, by design: a BN sewer belongs to one city, and our cities never straddle
a region edge (`placeCities` keeps the centre `size + 3` from the edge, `layOutStreet` keeps
streets 2 from it), so each city's sewer already lies in one region. A crossing would only join
two different towns' sewers, which BN never does. Sewer networks are unchanged (23–26 per 3×3).

**Measured** (`tsx tools/transport_probe.ts`, 3×3 regions around the start, z−2; a station
"reaches another region" when its network also holds a station in a different region):

| seed | subway networks v2 → v3 | stations reaching another region v2 → v3 | subway tiles v2 → v3 |
|---|---|---|---|
| 1 | 9 → 3 | 0 → 46/46 | 1271 → 2042 |
| 2 | 7 → 4 | 0 → 28/32 | 932 → 1505 |
| 3 | 8 → 6 | 0 → 17/25 | 1018 → 1475 |
| 42 | 9 → 4 | 0 → 28/33 | 894 → 1810 |
| 743667900 | 9 → 4 | 0 → 23/26 | 823 → 1915 |

The crossing chance is one constant (`KINDS` in seams.ts). At 50% the same block became 1–3
networks (73–100% of stations reaching another region); at 25%, 5–8 networks and 22–88%. 35%
keeps "sometimes" with most stations on an inter-region line. Generation cost: 46.1 → 49.5 ms
per region.

**Rendering.** The seam OMTs are ordinary `subway_*` tiles; `tests/overmap_seams.test.ts`
renders both sides of every seam on the start region's edges (seed 42) and checks every rail
tile on one side of the shared edge has rail opposite it. Real input: `tools/realinput.ts --only
subwayseam` stands the survivor in a crossing tunnel and walks it with a held W from one region
into the next, staying at z−2.

**Limits.** Only z−2 subways cross (the mutagen lab's z−4 cargo subway stays a stub). A crossing
whose region has no subway and no other crossing is a short dead end at the edge (no stairs reach
it). Crossings link to the nearest endpoint, not a deliberately chosen station, so lines can be
long (≈50 tiles per crossing half); total z−2 tunnel roughly doubles.

## Lakes in depth (genVersion 3)

BN generates lakes in 3D (`overmap.cpp` `place_lakes`, 3889–4007); genVersion 3 ports it. Code:
`src/world/overmap/lakes.ts`, `Overmap.baseLand` / `placeLakeColumns`, `mapgenLakeUnderwaterShore`
(`src/world/mapgen/builtin.ts`), `swimVertical` (`src/game/water.ts`). Tests: `tests/lakes.test.ts`.

- **Shore ring.** A lake OMT with any of its eight neighbours outside the lake (rivers count as
  lake) is `lake_shore`, else `lake_surface` (BN 3947–3959). The z0 chunks don't change: our
  `mapgenWater` already drew shores on lake tiles next to land; lake_surface keeps BN's JSON (all
  deep water). Roads/bridges treat lake_shore like lake_surface; lake_shore has no GROUP_RIVER spawns
  (BN). BN's `lake_size_min` (20) isn't applied: our lake noise predates it and keeps small lakes.
- **Columns.** Under lake_surface: `lake_water_cube` z−1..−4, `lake_bed` z−5; under lake_shore:
  `lake_underwater_shore` z−1..−5 (BN default region `lake_depth` −5). Laid right after base terrain,
  before cities, tunnel seams and specials, as BN does, so they take the rock first: tunnels route
  around them (BN subway/sewer locations are subterranean rock), manholes are skipped over a lake
  street, and specials needing rock there don't fit. `Overmap.lakeColumnAt(x, y, z)` answers from
  the noise alone, without generating a region.
- **Seams.** A cross-region subway seam whose tile, or its partner across the edge, is under a lake
  at z−2 is dropped by both neighbours (each computes it from the noise, so the regions still agree
  whichever generates first). BN would never lay a subway there either.
- **Mapgen.** `lake_water_cube`: BN JSON, all `t_water_cube`. `lake_bed`: BN JSON (lake_bed_palette,
  12×12 nested chunks: trees, hot springs, debris, toxic waste, safes, corpses, pests).
  `lake_underwater_shore`: BN's builtin `lake_shore` below z0 keeps the surface's shoreline on every
  level; ours follows our surface shoreline instead (mapgenWater's bank distance, no RNG): water
  cubes / lake bed (one in four moss, BN's 1-in-20 plant rolls) exactly under the surface's deep
  water, `t_rock` under the bank and shallows.
- **Swimming down** (BN `game::vertical_move` swim branch, `game.cpp` 14522–14615): in deep water
  `>` dives under (no level change; refused wearing FLOTATION), `>` again swims into a water cube
  below, `<` swims up and, at the top, surfaces (needs swim speed < 500, fins or MUTATION_SWIM). In
  a water cube you are always underwater (oxygen runs down, then drowning). A dive stays under until
  `<`; only an involuntary sinking still kicks back up on its own (our older real-time choice). The
  eye floats mid-level inside a water cube. Not BN: nothing underwater is drawn differently (no
  tint/fog) and it is dark below z0 (as in BN: sunlight doesn't reach z<0).
- **sunken_lab** (`data/json/overmap/overmap_mutable/lab.json`): a fixed LAKE special,
  `lake_bed_lab_entrance_roof` at z−4 (in a water cube), `lake_bed_lab_entrance` at z−5 (on the
  bed: a dry bulkhead cross with doors at its arms and stairs down), `lake_bed_lab_entrance_airlock`
  at z−6 (stairs up, scuba lockers), nesting `lab_basement` at its four neighbours at z−6
  (`placeLabBasement`, each only if it still fits). Placed by `placeMutableSpecials`' new **lake
  zone** (BN `place_specials` zone::lake: candidates are lake_surface OMTs, count
  `roll_remainder(rng_float(0, 5 × lake ratio))` × region area), in a second call with its own RNG
  stream after the mutable specials (BN sorts by z0 area; sunken_lab has none). City distance
  [20, −1] isn't enforced (BN's `requires_city` ignores an unbounded range).
- **Rare.** BN scales the count by the share of lake_surface, and our lakes are small (≈1% of
  OMTs, ≈0.35% lake_surface; BN's are large, low-frequency noise): measured 3 sunken labs in 1470
  regions (`tsx tools/dev/probe_lakes.ts --scan --radius 3 1..30`: seed 10 region 2,0; seed 19
  region 1,−2; seed 24 region 0,0 at OMT 21,14). Each grew 66–94 lab OMTs at z−6/−7; our MIN_Z −7
  cuts BN's depth (labs reach z−10 there).
- **Real input**: `tools/realinput.ts --only sunkenlab` (reloads on seed 24): `>` dives, `>` ×5 swims
  to the bed, `e` opens the outer and inner bulkhead doors, held W walks into the dry room, `>`
  takes the stairs into the airlock; 18/18 with `--gpu` (SwiftShader takes long enough to build the
  water levels that the load gate holds the game for a while).

Not done: **sunken_lab** (a fixed special under lakes: needs `lake_water_cube`/`lake_bed`
columns, which we don't generate); special-level roaming monster groups (`spawns`, e.g.
GROUP_ANT 1000–2000) came with genVersion 3 ("Special spawns" below); z is clamped to our
MIN_Z..MAX_Z (−7..5) instead of BN's −10..10.

## Special spawns (genVersion 3)

BN overmap specials can carry `"spawns": {"group", "population", "radius"}`: a roaming
population placed on the overmap when the special is, which turns into monsters as the player
comes near. Before genVersion 3 we ignored it, so an anthill had only its OMTs' own spawns
(`ants`/`ants_food`), not BN's colony around it.

**BN semantics** (all ported):
- `overmap_special_spawns::deserialize` (overmap.cpp 589): group and population mandatory,
  radius optional (default 0). The extractor ships them on fixed specials (`SpecialDef.spawns`,
  `tools/extract/mapgen.ts`) as well as mutable ones (`tools/extract/mutable.ts`).
- `place_special` (overmap.cpp 5991–5998, reached for wilderness specials, mutable specials and
  city buildings alike: `place_building` → `place_special`, 5107): `pop = rng(population)`,
  `rad = rng(radius)`, one `mongroup` at the special's origin `p` (a mutable special's root), in
  submap coordinates (`project_to<coords::sm>`: the OMT's north-west submap), not a horde.
- `add_mon_group` (6568–6630) splits it into radius-1 groups, one per submap: radius 1 stays one
  group with all of `pop` (radius 0 too); otherwise every submap with `trig_dist ≤ rad` (the float
  distance truncated into an int, so a 5×5 square at radius 2) gets
  `(rad − dist)/rad × pop/(π rad² + 1)`, its fraction one more point with `x_in_y(frac × 10000, 10000)`.
  The linear fall-off leaves about a third of `pop` in the groups (an anthill's 1000–2000 →
  ~350–700).
- `map::spawn_monsters_submap_group` (map/map.cpp 7837–7953): a group spawns when its submap is
  in the reality bubble (11×11 submaps, every z), on its submap's tiles that are free,
  passable with a floor (`allow_on_terrain`), outside (`is_outside`: open sky) and not seen by
  the player — sight is ignored on the bubble's outermost ring, on another z, and on a new game
  or load (`spawn_monsters(true)`). The population is rolled with `GetResultFromGroup`, each pick
  costing `max(1, cost_multiplier × pack)` (BN's `for (m = 0; m < pop; m++)` runs against the
  shrinking `pop`, so a group yields fewer monsters than its points; kept), each monster tries
  10 random spots, and the group is cleared — also when no spot exists (not a horde).
  `process_mongroups` (only `dying` groups) and `move_hordes`/`signal_hordes` (only hordes) never
  touch these groups, so nothing else changes them.

**Here.** `src/world/overmap/mongroups.ts` `specialMonGroups` (place_special + add_mon_group, its
own RNG per special uid, so no other generation draw moves). `Overmap` calls it from
`placeSpecial` (fixed and city specials, origin z0) and from mutable_place.ts through
`MutableHost.addSpawns` (at the root), only when `genVersion >= 3`, and indexes the groups by
submap (`monGroupsAt(sx, sy)`, `monGroupsOf(uid)`; only regions already generated: a group can lie
in a neighbouring region and joins the index with its special's region). `src/game/mongroups.ts`
`MonGroupSpawner` (installed by `installMonsters` when there is a world generator) scans the bubble
once a real second — which covers both BN triggers, new submaps on the edge as the map shifts and
the 2.5-minute whole-bubble pass — and materialises groups as above. Spawned monsters are
ordinary monsters (saved in `monsters`, stashed when far). Save section `mongroups` (order 21) is
the sorted list of spent group keys (`"sx,sy,z,uid"`); the groups regenerate with the overmap. A
save without it has spent none.

Which specials have them (BN data; the ones we place): Anthill and Lab with Anthill (GROUP_ANT
1000–2000, r 10–30), Acid Anthill (GROUP_ANT_ACID, same), Slime Pit (GROUP_GOO 100–200, r 2–10),
and three city park buildings: `triffid_sprout` (GROUP_TRIFFID_OUTER 100–160, r 0–10),
`fungal_buds` (GROUP_FUNGI_BUDS 200–320, r 0–20), `mi-go_foward_camp` (GROUP_MI-GO_CAMP_OM
10–16, r 1–5). The other BN specials with spawns (Bee Hive, wasp towers, fungal bloom/tower,
triffid grove, Mi-Go camps, power stations, Shipwreck, Large Dermatik Nest) aren't placed by our
overmap; they get their groups as soon as they are (no code change: `placeSpecial` does it).

`tsx tools/dev/probe_spawns.ts [seed...]` lists them over 3×3 regions. Seed 2: 27 specials with
spawns, 3859 population points in all (3 Anthills 408–536, 2 Labs with Anthill 448/647, 3 Slime
Pits 50–66, the rest park growths). Seed 1: 24, 2266 points (one Anthill, 507).

Tests: `tests/special_spawns.test.ts` (BN split math and ranges; every placed special with BN
spawns has its groups at its origin within its radius; genVersion 2 places none; walking up to a
seed 2 anthill one submap at a time spawns groups only on the bubble's edge and drains the
colony's population; spawns wait for the title-screen hold and for ungenerated chunks; save/load
keeps the spent set and spawns nothing twice; a genVersion 2 world spawns nothing).
Real input: `tools/realinput.ts --only antcolony` (W toward the nearest anthill from just outside
its spread; ants come into view, the colony's unspent population drains; seed 1, 6/6: 60 s of W
took the survivor from 181 to 100 tiles off the hill, 68 groups spawned 81 ants, unspent 507 →
388, up to 66 ants in sight; `docs/screenshots/transport/spawns_antcolony.png`). Debug:
`cdda.specialSpawns('Anthill')`, `cdda.monGroups(r)`, `cdda.monGroupStats()`, `cdda.monGroupScan()`.

Not BN / limits: the port's safe radius (no hostile within `SpawnerOptions.safeRadius`) applies,
as to every spawn; the Zombie density option does not scale these groups (BN doesn't either);
a group waits while its chunk or the chunk above (for `is_outside`) isn't generated, where BN
always has the whole bubble loaded; BN's uniform-submap shortcut (spawning into a roofed uniform
submap) isn't modelled; the evolve rolls of `GetUpgradedMonsterGroup` aren't (as for every group
here). BN populations are large for real time: ~100 ants come out within the bubble at a hill's
centre, and a park's `fungal_buds` brings ~100 fungal monsters into a town.

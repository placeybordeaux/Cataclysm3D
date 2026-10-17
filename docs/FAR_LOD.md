# Far LOD: why buildings pop in, and what to do about it

Status: built (2026-10-17), default `proxy-dissolve`. Investigation first (2026-10-15), then what was built and measured at the end.

## What pops, and why: rendering, not the world sim

The world sim has no visible edge. Map chunks are generated when the renderer wants them (at the
168 m draw radius, under the fade, plus idle-time prefetch), monsters spawn when their chunk
generates (never within 10 m of you), and dormant ones are drawn out to the draw distance with a
12 m fade. Only the renderer has hard switches.

Measured with the telemetry (`tools/perf-bench.ts --routes city40,citywalk --save`, then
`python3 tools/pop-report.py`): where each chunk was first shown, by its nearest edge's distance
from the player at that moment.

| route | first shown at 144-216 m | closer than 144 m |
|---|---|---|
| citywalk (3 mph, 54 m) | 90 of 93 | 3 upper levels at 120-144 m |
| city40 (40 mph, 520 m) | 571 of 680 | 109: basements (101, `below`) and the car's own column's upper levels (8) |

Streaming keeps up (`unbuilt in view: 0 s` on both routes), so a building never appears up close.
It appears **at the draw-distance edge, and the edge is mostly visible**: the default haze
(`atmosphere.ts` "Clear") reaches only `edgeLevel` 0.25 of sky colour at the draw distance, so a
chunk arriving there is ~75 % visible. Beyond the edge the skyline (`skyline.ts`) draws
overmap-derived impostors: a generic house box with a gable roof per house OMT, blocky town
buildings, a tall box for apartments/offices. When the real chunk lands the impostor goes and the
real building takes its place: different footprint, height, roof and colour, in one frame. That
morph is the pop. It happens at any speed, which is why it shows on foot too.

Two smaller contributors at the same edge:

* **Upper storeys trail their ground level** (separate chunks): p50 209 ms, p90 833 ms at
  40 mph (28 / 343 ms walking). The stand-ins (`placeholders.ts`) only look at z 0, so a tall
  building can arrive in two steps.
* **No crossfade anywhere** in the chunk path: the impostor, the stand-in and the near-ring LOD
  flips (voxel props, 3D trees at ~43 m; the flora middle ring at ~79 m) all swap in one frame.
  Creatures already dissolve (`monsterView.ts` fadeFar, `chars/spriteLod.ts`); chunks do not.

## Techniques

1. **Hide the edge in haze** (a setting, no code): raise `edgeLevel` so the hand-off happens
   behind more sky. "Light haze" (0.4) is already in Options > World detail > Distance haze;
   "Heavy (v2)" (1.0) hides it completely. Costs the crisp far view the "Clear" preset is for.
2. **Dissolve at the hand-off** (cheap, generic): a new chunk mesh fades in with a screen-door
   dither over ~0.5-1 s, or by distance across the last ~20 m inside the edge, while the impostor
   fades out over the same span. Ordered dither suits the pixel-art pipeline and needs no
   transparency sorting. The same fade covers stand-in → real, upper storeys, near-ring and
   middle-ring LOD flips, and vehicle LOD. Does not fix the shape mismatch; turns a pop into a
   dissolve.
3. **Real far proxies (HLOD, "Distant Horizons" style)**: build the far ring from the real map
   instead of the overmap. Per chunk, from mapgen output: for each tile column the top of the
   solid stuff across its levels and a colour from the tile's atlas average (roof, wall, ground,
   tree crown), greedy-merged into boxes, one merged mesh per chunk (a few hundred triangles;
   coarser cells, 2x2 or 4x4 tiles, further out). Kept from the draw radius out to ~2x (336 m),
   so at the hand-off the proxy already has the building's real footprint, height and roof
   colour, and the real chunk only adds detail. Cache by chunk version, so a revisited area has
   its proxies at once.
   * Cost: mapgen is cheap (city40: p50 0.1 ms, p90 0.3 ms per chunk-level, ~13 ms per second of
     driving); the full mesher is what is expensive (p50 3.5 ms per chunk), and a proxy does not
     use it. A ring from 8 to 14 chunks is ~400 columns; at 40 mph ~20 new columns a second.
   * Sharp edge: generating into the live map fires the chunk hooks: spawner, NPCs, vehicles,
     dormant corpses, save tracking, eviction (`map.onChunkGenerated`). Proxies need a second
     `WorldGenerator` with the same seed writing into a scratch `GameMap` with no hooks: the same
     terrain (generation is deterministic per seed and chunk), no side effects. Edits the player
     made (a burnt house) are not in it until the real chunk is built once and the proxy is
     rebuilt from the live chunk.
   * Can move to a Web Worker later (scratch map + proxy builder have no DOM or renderer
     dependency), the one thing earlier perf work found mapgen alone did not justify.
4. **Stand-ins per storey**: count a column as built only when every level it draws is shown, so
   the stand-in or proxy holds until the whole building is ready. Small change in
   `placeholders.ts`; best together with 2 or 3.

## What was built

Modes (`src/render/farLod.ts`; `?farlod=proxy-dissolve|proxy|dissolve|current`, Options > World
detail > Far detail, `cdda.setFarLod`, persisted):

* **proxy-dissolve** (default): far proxies, and the hand-off to chunks is a dissolve.
* **proxy**: far proxies, hand-off in one frame.
* **dissolve**: no proxies; stand-ins fade in, chunks dissolve in over them.
* **current**: the old behaviour.

Pieces:

* **Far proxies** (`farProxy.ts`): per column, per tile the top of what stands there across its
  levels (walls a storey, roofs and floors as slabs, ground-level tree crowns from 2.2 to 7 m) in
  the atlas average colour of the tile (`AtlasTextureSource.averageColor`), greedy-merged into
  boxes (2x2-tile cells beyond 11 chunks), out to 1.75x the draw radius, merged per 4x4 columns.
  Columns the live map has are read from it (edits included); the rest come from a second
  `WorldGenerator` sharing the live overmap, writing into a scratch `GameMap` with no chunk
  hooks, dropped right after. Built in `requestIdleCallback` time (in the frame only after
  500 ms without idle time, and never while the streaming is behind). The camera's far plane
  follows the ring (200 m -> ~370 m at radius 8).
* **Hand-off** (`Handoff`, run in the chunk manager's `afterUpdate`, so a chunk built this
  frame is faded before it is drawn): a column more than 1.5 chunks out holds its proxy (or
  stand-in) and keeps its chunks undrawn until every level the manager wants is shown
  (`ChunkManager.columnComplete`: the same span and radii as entry creation, tower tops skipped
  while driving), then the chunks dissolve in over 0.6 s while the cover dissolves out on the
  complementary pixels. A level arriving after the hand-off fades in on its own; a rebuild of a
  shown level (LOD flip, edit) just shows. Covers appearing at the far edge fade in.
* **Dissolve** (`dissolve.ts`, `materials.ts` DISSOLVE_SOLID): 4x4 Bayer screen-door in the world
  material; a fading mesh wears a shared clone of its page material per step (17 steps x in/out:
  same program, no compile); fully out is simply not drawn. Non-world meshes (3D trees, glass,
  puddles, prop cards) switch at half way.
* **Per-storey hold**: stand-ins too go only when the hand-off says the column is done.

Sharp edges: proxies have no furniture, vehicles or 3D tree shapes; proxy ground sits 0.2 m
under the real ground; the scratch generator duplicates generation work for columns you'll
later reach (mapgen is cheap: p50 0.1 ms per chunk-level, ~0.4 ms per proxy column incl.
generation); a proxy built from scratch doesn't know edits until the live chunk exists.

## Measured

Real-input `farlod` scenario (`tools/realinput.ts --only farlod --gpu`): the benchmark's city
road, camera still, chunk building held while everything beyond 60 m is dropped, then released
and photographed; change per step above the animation floor (grass, clouds):

| mode | worst single step | total change |
|---|---|---|
| current | 16.1 | 22.4 |
| dissolve | 2.0 | 9.2 |
| proxy | 1.6 | 5.2 |
| proxy-dissolve | 1.5 | 4.9 |

`current` puts most of the change in one frame (the stand-in boxes, far taller than the real
buildings, swap for the meshes); with proxies there is less to change at all.

Cost (`perf-bench city40`, Chromium on the GPU, 3440x1304, back to back on the same machine
state): 883 frames `current` vs 863 `proxy-dissolve` in 30 s; main loop mean 22.0 -> 22.8 ms.
The first version (building in the frame, a clone per fading mesh, whole-ring rescans every
frame) cost 11-13 %.

Tools: `tools/pop-report.py` (where chunks first appear, from a telemetry dump), the `citywalk`
perf route, `cdda.restreamEdge(m)` and `cdda.holdBuilds(on)` for captures, `cdda.farLod()` stats.

## Round 2 (2026-10-17): "stuff far off just fully disappears"

Measured with `cdda.farLod().uncovered` (columns in the proxy ring with neither their chunks
nor a proxy drawn) on the `farlodleave` scenario (40 mph down the city road), and the shapes
with `cdda.proxyView(true)` (chunks hidden, every proxy drawn) and `cdda.proxyCheck()` (proxy
top vs the real meshes' top per column) on `farlodshape`.

* **Holes behind and beside you** (24-74 columns inside the draw radius + 2 while driving):
  a column whose chunks were dropped had its proxy *deleted* for a rebuild from the live map,
  and the rebuild waited for idle time, which the busy page rarely had (and proxies yielded
  whenever streaming was behind). Now the old proxy stays drawn and is rebuilt only if the
  live chunks differ from what it was built of (a signature of levels and versions); idle time
  only counts when it had room; the frame always builds a missing column near the draw edge.
  Result: 0 uncovered inside the radius + 2 throughout; the rim (~340 m) refills within ~1 s
  of each chunk crossing.
* **Towers two storeys short**: a proxy built from the live map only had the levels the chunk
  manager had made (tower tops are skipped while driving). Each level now comes from the live
  map if it has it, else from the scratch generator.
* **Roofs**: the volume looks' hipped roofs (chunkMesh.ts PITCHED, arch.ts) are modelled
  (stepped, height = tiles to the roof edge x 0.5, capped at 6 tiles).
* **Trees**: crowns were 4.6-6.8 m solid slabs in the sprite's dark trunk-and-leaf average; the
  real trees are 4.8-5.6 m (chunkMesh.ts) with lifted leaf colours (flora.ts). Now 4.7-5.6 m
  tops varying per 2x2 tiles, the colour from the top 60 % of the sprite lifted 1.45x, and
  solid to the ground (dark below 2 m): open underneath, the eye went through to a pale road
  far behind, a bright line along the horizon.
* **Far ground ring over proxies**: the skyline pulls everything beyond its near distance
  toward the camera (to fit the old 200 m far plane); with proxies to ~370 m the pulled ground
  ring landed in front of distant proxies. The pull now starts past the proxy ring
  (`SkylineLayer.uniforms.uNear`), the far plane sized to match.

Proxy vs real tops over 169 city columns: mean |difference| 1.04 m -> 0.91 m (the rest is
rooftop clutter and furniture, which proxies don't model). Ground bands: within ~5-10 % of the
real view's colour.

Cost: hiding a handed-over column collapses its vertices in its block's merged mesh instead of
re-merging the block (1-2 ms a block, ~20 hand-offs a second at 40 mph). `perf-bench city40`:
812 frames `current` vs 769 `proxy-dissolve` (-5 %; most of it the in-frame building budget,
which runs because the headless benchmark gets almost no idle time).

Hand-off capture (`farlod`, HUD hidden: a tutorial toast had been counted as a pop): biggest
single step 16.4 current, 1.6 dissolve, 1.8 proxy, 2.1 proxy-dissolve; total change 22.8 /
5.8 / 4.8 / 4.9.

## Round 3 (2026-10-17): tall buildings vanish as you approach; a radio tower is a block

* **Tower tops**: storeys above the eye's window are only built within R - 2 and not at all
  while driving (levels.ts levelRadius, chunkManager), so the hand-off counted a tower's column
  complete with its lower floors and hid the proxy; the rest vanished until much nearer (in the
  heavier hazes the lower floors are faint too, so the whole building went). Now a handed-over
  column keeps a **cap**: its proxy clipped at the top of the highest level the chunks draw
  (`clipQuads`), raised once a late storey has faded in. `farlodleave` watches ten tall
  buildings ahead while driving at 40 mph: the chunks alone drew as little as 16-25 % of their
  height; with the caps all ten stay at 100 %.
* **Radio towers**: `t_radio_tower` is see-through impassable terrain (a fence panel to the
  mesher) that the proxy took for floor slabs, so the heightfield filled the tower's footprint
  solid to the top. Lattice stacked over two or more levels is now a thin post per tile (a
  mast), and a floor with no wall under it (platforms, bridge decks, catwalks, overhangs) is a
  0.3 m deck instead of a box to the ground. The overmap silhouette no longer takes
  `radio_tower` for a tall building (it matched `tower`). `farlodmast` shots.
* **Building rate**: with almost no idle time (headless, or a busy page) the ring took 10+ s to
  fill after a teleport. Block meshes are now written straight from the quad records (they cost
  as much as building through GeomBuilder), and standing still gets a 4 ms in-frame budget.

perf-bench city40, same machine state: 858 frames `current` vs 800 `proxy-dissolve` (-7 %).

## The original plan


Build 2 and 3 behind a switch (`?farlod=impostor|dissolve|proxy|proxy-dissolve`, Options), with
4 under all of them, and measure each with the routes above plus a frame-strip capture of a
building crossing the edge (real input, as with `beamflicker`). "impostor" stays the current
behaviour for comparison.

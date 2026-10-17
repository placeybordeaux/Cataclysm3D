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

## The original plan


Build 2 and 3 behind a switch (`?farlod=impostor|dissolve|proxy|proxy-dissolve`, Options), with
4 under all of them, and measure each with the routes above plus a frame-strip capture of a
building crossing the edge (real input, as with `beamflicker`). "impostor" stays the current
behaviour for comparison.

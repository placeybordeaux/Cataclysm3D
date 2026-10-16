# Far LOD: why buildings pop in, and what to do about it

Status: investigation (2026-10-15). Nothing here is built yet; the plan at the end is a proposal.

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

## Proposed plan

Build 2 and 3 behind a switch (`?farlod=impostor|dissolve|proxy|proxy+dissolve`, Options), with
4 under all of them, and measure each with the routes above plus a frame-strip capture of a
building crossing the edge (real input, as with `beamflicker`). "impostor" stays the current
behaviour for comparison.

# Visual styles ("looks")

The feedback was "everything is so flat, it feels extremely retro". The target is
*Project Shadowglass*-style 3D pixel art: real 3D geometry with rich dynamic light, rendered
low-res and point-filtered, not a 1993 raycaster. Five switchable styles let you compare:

| look | what it adds |
| --- | --- |
| `classic` | the original: ~360 px image (3-4x upscale), billboards, flat ground, 100-colour palette |
| `crisp` | image quality, no new geometry: auto resolution (540-720 px, integer upscale), SSAO, 2048 PCF sun shadows (stepped penumbra after banding), per-texel luminance bump, rounded sprite normals, rim + fill light, interior bounce light, aerial perspective, bloom, lighter dither, smooth grading |
| `voxel` | sprites become volumes: inflated voxel furniture, flat voxel items, 3D trees (trunk + branches + leaf clumps coloured from the sprite), window frames/mullions/sills, door casings, plinths, cornices, fences from posts/rails/pickets, raised sidewalks with curbs, hipped shingle roofs with eaves, flat-roof parapets |
| `terrain` | the ground: relief on natural ground with rural road ditches, dense swaying grass cards, rocks/twigs/leaves, sidewalk litter, sky-reflecting puddles, macro colour variation, an overmap skyline beyond the draw distance |
| `full` | crisp + voxel + terrain (**default**) |

Switch with **Options > Visual style** (persisted), `?look=<name>`, or `cdda.setLook(name)`
(live). Individual features: `cdda.lookTweak({ssao: 0, grass: false})` (names in
`src/render/look.ts`). The palette look stays one Options entry away (Colour grading).

**Distance readability (wave 3)**, applies to every look: a sky-matched distance fade instead of
the grey fog wall, a far ground ring to the horizon, lighter aerial perspective, overcast weather,
no washed-out sky around the sun. **Options > Distance haze** (`clear` default / `light` /
`legacy` = the old fog; `?haze=`, `cdda.setHaze`, `cdda.hazeTweak`) and **Options > Draw
distance** (96 / 120 / 168 m). Round 2 added **Options > Form lighting** (`toon` default /
`bold` / `soft` = v2; `?form=`, `cdda.setForm`, `cdda.formTweak`), stable cutout mips on grass and
leaf cards, and a screen-round sun. Round 3 replaced the trees and bushes with modelled species
(**Options > Trees**: `models` default / `clumps` = v2; see [FLORA.md](FLORA.md)). Details, before/after shots and perf: [READABILITY.md](READABILITY.md).
The shots below were regenerated with it.

## Comparison (1920x1080, RTX 5080)

Columns: classic, crisp, voxel, terrain, full. Regenerate with
`~/claude-stuff/bin/heavy --mem 2 --kind gpu -- nix-shell --run "npx tsx tools/look-shots.ts --gpu classic crisp voxel terrain full"`
(viewpoints in `tools/look-views.js`, seed 1). Shots are JPEG q85 at half size (960x540,
~100 KB each; dithered pixel art compresses badly as PNG); `--png` gives full-size PNGs.

| view | classic | crisp | voxel | terrain | full |
| --- | --- | --- | --- | --- | --- |
| shelter | ![](screenshots/looks/classic_shelter.jpg) | ![](screenshots/looks/crisp_shelter.jpg) | ![](screenshots/looks/voxel_shelter.jpg) | ![](screenshots/looks/terrain_shelter.jpg) | ![](screenshots/looks/full_shelter.jpg) |
| street | ![](screenshots/looks/classic_street.jpg) | ![](screenshots/looks/crisp_street.jpg) | ![](screenshots/looks/voxel_street.jpg) | ![](screenshots/looks/terrain_street.jpg) | ![](screenshots/looks/full_street.jpg) |
| house | ![](screenshots/looks/classic_house.jpg) | ![](screenshots/looks/crisp_house.jpg) | ![](screenshots/looks/voxel_house.jpg) | ![](screenshots/looks/terrain_house.jpg) | ![](screenshots/looks/full_house.jpg) |
| forest | ![](screenshots/looks/classic_forest.jpg) | ![](screenshots/looks/crisp_forest.jpg) | ![](screenshots/looks/voxel_forest.jpg) | ![](screenshots/looks/terrain_forest.jpg) | ![](screenshots/looks/full_forest.jpg) |
| night + flashlight | ![](screenshots/looks/classic_night.jpg) | ![](screenshots/looks/crisp_night.jpg) | ![](screenshots/looks/voxel_night.jpg) | ![](screenshots/looks/terrain_night.jpg) | ![](screenshots/looks/full_night.jpg) |
| top-down | ![](screenshots/looks/classic_top.jpg) | ![](screenshots/looks/crisp_top.jpg) | ![](screenshots/looks/voxel_top.jpg) | ![](screenshots/looks/terrain_top.jpg) | ![](screenshots/looks/full_top.jpg) |

## Performance (RTX 5080, `--bench`)

Live telemetry (F3), streaming while driving and the regression benchmark: [PERF.md](PERF.md).

`render` = renderer-only ms/frame synchronised with the GPU (`cdda.benchRender`);
fps = uncapped rAF interval, which also carries the simulation.

| look | 1080p street fps / render ms | 1080p forest fps / render ms | 3440x1304 street render ms | 3440x1304 forest render ms |
| --- | --- | --- | --- | --- |
| classic | 217 / 1.1 | 233 / 0.9 | 1.8 | 1.4 |
| crisp | 204 / 1.3 | 156 / 1.6 | 2.3 | 1.9 |
| voxel | 143 / 1.8 | 159 / 1.6 | 2.1 | 1.5 |
| terrain | 139 / 1.9 | 154 / 1.7 | 2.0 | 1.8 |
| full | 132 / 2.2 | 139 / 2.0 | 2.5 | 1.6 |

At 3440x1304 every look ran at 64-74 fps p50 with the machine shared (frame work ~18 ms
for classic too, i.e. CPU contention from other jobs, not rendering). GPU cost is never the
limit: full is ~1 ms/frame more than classic.

Streaming (ghost sprint at 7 tiles/s through town, `cdda.benchRun`, 1080p, main-loop ms):

| look | p50 | p95 | p99 | max | slowest chunk build |
| --- | --- | --- | --- | --- | --- |
| classic | 3.5 | 8.6 | 13.1 | 16 | 4 ms |
| terrain | 3.8 | 11.1 | 16.9 | 25 | 9 ms |
| full | 5.4 | 23.3 | 35.6 | 64 | 22 ms |

**Since the meshing time-slicing** (`tools/bench-stream.ts`, 1080p, 60 Hz vsync, 25 s runs from
the street view; `loop` = our rAF callback, `work` also counts the delay before it; "40 mph"
is the same ghost run at 17.9 tiles/s):

| full, main-loop ms | work p50 | work p99 | work max | loop p99 | loop max | worst meshing in a frame |
| --- | --- | --- | --- | --- | --- | --- |
| sprint 7 t/s, before | 3.0 | 18.0 | 33.2 | 12.6 | 32.9 | 14 ms (one chunk) |
| sprint 7 t/s, after | 3.9 | 11.0 | 13.2 | 10.5 | 12.2 | 5.3 ms |
| 40 mph, before | 3.5 | 20.1 | 30.0 | 18.1 | 29.6 | 14.5 ms + grass 12 ms |
| 40 mph, after | 4.9 | 11.8 | 17.3 | 10.6 | 16.2 | 10 ms (an edit next to the player) |

Chunk builds, 3D trees, grass and skyline rebuilds are generators stepped under per-frame
budgets (chunks 4 ms, 10 ms for edits beside the player; grass 1.5 ms; skyline 1 ms), the
old mesh staying up until the new one is done, chunks ahead of the camera first
(`src/render/steps.ts`, `chunkManager.ts`). At 3440x1304 the loop is the same (p99 11-12 ms);
headless Chromium's frame interval there is set by presenting the big canvas (classic too),
not by our code. The old table below is kept for history.

Full's cost while moving fast was meshing the volumetric chunks near the player
(`chunks.lodRadius` = 1.8 chunks): voxel furniture/items and 3D trees exist only there,
billboards beyond. At walking speed this is spread thin; sprinting/driving through dense
town is where the occasional 30-60 ms frame remains (see "next" below).

## Recommendation

**`full` as the default.** It is the only style that stops reading as "retro": buildings get
roofs, frames and sills, trees are volumes that shade like crowns, the ground has relief and
grass you walk through, and the horizon has a skyline. The crisp image (540-720 px, SSAO,
soft stepped shadows, smooth grading) is what makes the new geometry read; voxel without
crisp still looks chunky, crisp without voxel still looks flat. Keep `classic` for players
who want the original pixel look.

Next steps if we go on: per-building roof colours and gables; voxel monsters; a proper
normal/height page for atlas sprites instead of luminance bump.

## Implementation map

- `src/render/look.ts` feature table; `renderer.setLook/applyLook`; `src/render/lookInstall.ts`
  (Options entry, `cdda.setLook/lookTweak/benchView/voxelStats`).
- Image: `post.ts` (SSAO, bloom, aerial perspective, skyline haze, debug views),
  `grading.ts lowResSize` (targetHeight 0 = auto), `materials.ts` (rim, bounce, bump,
  sprite rounding), `lights.ts` (fill light, `setShadow`).
- Furniture, fixtures, doors, windows and ground items are modelled (low-poly, 32 texels/m
  pixel textures from the sprite palette) by default in the volume looks; the voxel versions
  stay one switch away (Options > Furniture, `?furniture=voxel`): see `docs/FURNITURE.md`.
  Dropped guns, melee weapons and tools are their held 3D mesh lying down (`furniture/groundHeld.ts`;
  in Crisp/Terrain only items without a tileset sprite; Classic unchanged; Options > Dropped
  weapons, `?grounditems=held|shape`): docs/CHARACTERS.md "Dropped weapons on the ground".
- Volumes: `voxel.ts` (sprite inflation/extrusion), `trees.ts` (3D trees), `arch.ts`
  (frames, casings, bands, fences, hipped roofs), wired in `chunkMesh.ts`.
- Ground: `ground.ts` (relief + curbs, `renderer.groundAt` for sprites and the eye),
  `grass.ts`, `props.ts` (props + puddle material), `skyline.ts`.
  Puddles go on asphalt only (`surfaceKind`: painted as pavement, minus doors/gates/guardrails):
  BN's ROAD flag means "smooth for vehicles" and is on most built floors, so keying puddles on it
  put a dark sky-mirror puddle on wooden, metal and linoleum floors under open sky (roofless
  ruins, decks, the gallery showroom); sidewalks and concrete now get their litter.
- Fixed along the way: the first-person viewmodel pass cleared the depth buffer, so fog and
  outlines never applied in first person (post.ts now squeezes the viewmodel's depth).

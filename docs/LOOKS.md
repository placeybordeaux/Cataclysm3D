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

## Comparison (1920x1080, RTX 5080)

Columns: classic, crisp, voxel, terrain, full. Regenerate with
`~/claude-stuff/bin/heavy --mem 2 --kind gpu -- nix-shell --run "npx tsx tools/look-shots.ts --gpu classic crisp voxel terrain full"`
(viewpoints in `tools/look-views.js`, seed 1).

| view | classic | crisp | voxel | terrain | full |
| --- | --- | --- | --- | --- | --- |
| shelter | ![](screenshots/looks/classic_shelter.png) | ![](screenshots/looks/crisp_shelter.png) | ![](screenshots/looks/voxel_shelter.png) | ![](screenshots/looks/terrain_shelter.png) | ![](screenshots/looks/full_shelter.png) |
| street | ![](screenshots/looks/classic_street.png) | ![](screenshots/looks/crisp_street.png) | ![](screenshots/looks/voxel_street.png) | ![](screenshots/looks/terrain_street.png) | ![](screenshots/looks/full_street.png) |
| house | ![](screenshots/looks/classic_house.png) | ![](screenshots/looks/crisp_house.png) | ![](screenshots/looks/voxel_house.png) | ![](screenshots/looks/terrain_house.png) | ![](screenshots/looks/full_house.png) |
| forest | ![](screenshots/looks/classic_forest.png) | ![](screenshots/looks/crisp_forest.png) | ![](screenshots/looks/voxel_forest.png) | ![](screenshots/looks/terrain_forest.png) | ![](screenshots/looks/full_forest.png) |
| night + flashlight | ![](screenshots/looks/classic_night.png) | ![](screenshots/looks/crisp_night.png) | ![](screenshots/looks/voxel_night.png) | ![](screenshots/looks/terrain_night.png) | ![](screenshots/looks/full_night.png) |
| top-down | ![](screenshots/looks/classic_top.png) | ![](screenshots/looks/crisp_top.png) | ![](screenshots/looks/voxel_top.png) | ![](screenshots/looks/terrain_top.png) | ![](screenshots/looks/full_top.png) |

## Performance (RTX 5080, `--bench`)

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

Full's cost while moving fast is meshing the volumetric chunks near the player
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

Next steps if we go on: move voxel/tree meshing off the main thread (or into idle slices) to
remove the sprint hitches; per-building roof colours and gables; voxel monsters; a proper
normal/height page for atlas sprites instead of luminance bump.

## Implementation map

- `src/render/look.ts` feature table; `renderer.setLook/applyLook`; `src/render/lookInstall.ts`
  (Options entry, `cdda.setLook/lookTweak/benchView/voxelStats`).
- Image: `post.ts` (SSAO, bloom, aerial perspective, skyline haze, debug views),
  `grading.ts lowResSize` (targetHeight 0 = auto), `materials.ts` (rim, bounce, bump,
  sprite rounding), `lights.ts` (fill light, `setShadow`).
- Volumes: `voxel.ts` (sprite inflation/extrusion), `trees.ts` (3D trees), `arch.ts`
  (frames, casings, bands, fences, hipped roofs), wired in `chunkMesh.ts`.
- Ground: `ground.ts` (relief + curbs, `renderer.groundAt` for sprites and the eye),
  `grass.ts`, `props.ts` (props + puddle material), `skyline.ts`.
- Fixed along the way: the first-person viewmodel pass cleared the depth buffer, so fog and
  outlines never applied in first person (post.ts now squeezes the viewmodel's depth).

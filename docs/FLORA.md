# Trees and vegetation (wave 3, readability round 3)

Feedback: trees were the most "voxel-blob" thing left and fill most forest and suburban frames.
Trunks were square pillars, crowns camo-noise clumps of identical round blobs, bushes fuzzy
green noise, nothing read as a species, and past 43 m every tree became the flat UltiCa
billboard (a pop at the LOD edge).

## What is built now (`src/render/flora.ts`, `src/render/floraArt.ts`)

Every tree/bush terrain id maps to a family with its own layout, built as real geometry in the
world material (toon bands, light map, sun shadows, fill light):

| family | ids | shape |
| --- | --- | --- |
| round | t_tree, maple, oak-likes, elm, walnut, beech, chestnut... | 8-sided trunk with root flare, forking limbs, a crown of 10 low-poly leaf lumps in three bands (bumpy outline), ragged leaf-mass cutout cards through each lump |
| willow | t_tree_willow | low wide dome with hanging leaf curtains |
| conifer | pine, juniper (spruce/fir/cedar ids too) | straight trunk, 5 star-edged drooping cone tiers with undersides; snow caps in winter |
| birch | t_tree_birch | white bark with dark lenticels, slim trunk, narrow tall crown |
| fruit | apple, pear, cherry, peach, plum, mulberry, almond... | short trunk, wide low dome; white/pink blossom in spring, fruit dots in summer/autumn (none when harvested) |
| sapling | t_tree_young | thin stem, three small lumps |
| dead | t_tree_dead, hickory_dead (and any deciduous tree in winter) | bare limbs with forks and twig cutouts |
| deadconifer | t_tree_deadpine | straight trunk with short stubs |
| bush / underbrush / fern | t_shrub_*, t_underbrush, t_fern | lumps on the ground; roses, hydrangea, lilac as 2x2 flower dots, blueberry/raspberry/blackberry/grape as berries (blossom in spring) |

* Colours come from the tree's own seasonal UltiCa sprite: a 4-step ramp from its crown pixels
  (gap, mid, light, highlight) and bark from its trunk rows, so species tint, autumn colours and
  winter carry over. Pale grey pixels count as snow, not leaves.
* Textures are painted at 32 texels/m: leaf clusters (3-px blades with lit tips), drooping
  needles, furrowed / plated / birch / smooth bark, snow, twig and drape cutouts. They live on a
  private 2048 atlas page (`FloraAtlas`, wrapped padding so mips don't bleed); ~17 % used after
  a forest + town.
* Lumps' normals lean toward the crown's volume normal, so a crown shades as one mass (lit top,
  dark underside, stepped by the toon bands) with lumps in it.
* 3 layout variants per family, random yaw; heights: conifers x1.35, birch x1.12, fruit x0.8.
* No wind sway (the geometry is static world mesh); sway of <1 px at distance only flickered.

## LOD without pops

Chunk rings (chunkManager): near (lodRadius 1.8 chunks, ~43 m) full detail; middle ring
(`midRadius` 3.3, ~80 m) the *same layout* with 5-sided trunks, coarser lumps, no cutout cards;
beyond, two crossed impostor cards per tree painted from that same layout and palette (volume
normals, so the sun side still lights up). A tree keeps its silhouette and colours at every
distance; only detail changes at the ring edges.

## Switches

* **Options > Trees** (persisted): `models` (default) / `clumps` (the v2 trees: sprite-revolved
  blob cards near, billboards beyond). `?flora=models|clumps`, `cdda.setFlora(name)`,
  `cdda.floraStats()` (atlas use, middle radius). Needs a look with `trees3d` (voxel, full);
  classic/crisp/terrain keep their billboards by design.
* Views in `tools/look-views.js`: `lineup` (one of every family on open ground, 14 m),
  `lineup-spring|autumn|winter`, `lineupfar` (60 m: middle/far LOD), `autumn`, `springforest`,
  `winterforest`. `tools/bench-stream.ts --view forest --yaw -20` streams through woods.

## Screenshots

See `screenshots/wave3/flora/` (JPEG): v2 clumps vs. models in the forest and street, the
lineup in each season, and the far lineup.

## Performance

See the table at the end of this file (filled from `look-shots --bench` and `bench-stream`).

## Known gaps

* Lumps are smooth-shaded low-poly: up close (< 2 m) their facets and the 32 texel/m leaves are
  big; walking into a crown fills the view (v2 clumps dissolved near the eye).
* Middle ring -> impostor switch still changes the crown outline a little (cards vs lumps).
* t_fern renders as a low bush; no frond model.
* No wind.

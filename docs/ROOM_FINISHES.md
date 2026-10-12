# Connected room finishes and deep water

Painted finishes now resolve the whole connected loaded room instead of clipping at each chunk's 14-tile query margin. An 80×40 warehouse therefore has one anchor, furniture classification and finish from either end. Open or partially unloaded regions receive no invented partial room. Floods stop at 16,384 floor tiles.

Completed rooms are cached per map and level, with a maximum of 65,536 cached floor tile references. Every touched column, including boundary walls and missing neighbours, snapshots chunk identity and mutation version from the floor level through the highest possible roof level. Terrain, furniture, roofs, loading, eviction and replacement invalidate affected rooms. Open regions are not shared-cached. Coordinates use exact strings; world locations beyond ±32,768 retain their original coordinates.

`tools/bench-room-finish.ts` measures actual painted chunk meshing on a fully loaded 80×40 warehouse (eight chunks, no dressing): two warm rounds, eight measured rounds, 80 meshes each, alternating old/new order. Run through the repository's Nix/heavy resource wrapper, with `--baseline` pointing at the original chunk mesher and its original room module. The initial uncached whole-room change measured 3.054 ms/chunk versus 1.983 ms baseline; the final cached implementation with robust coordinates measured **1.781 ms/chunk versus 2.142 ms baseline** (17% lower). This fixture measures repeated meshing; a first classification and invalidation still pay the bounded flood cost. It does not claim universal speedups or a worker mesher.

Bright Nights deep water has both `LIQUID` and `GOES_DOWN` (diving). Liquid now takes precedence in render classification, so it remains a water surface instead of receiving stair geometry. Actual stairs retain their stair shape; simulation stair-link rules are unaffected.

GPU screenshots inspected after reloading the current source:

- [80×40 warehouse finish across chunk boundaries](screenshots/gaps/warehouse-finishes.png): camera (1353.5, 1025.5), eastward along the south interior wall, crossing x=1368 and x=1392. Debug lamps illuminate the otherwise windowless warehouse.
- [First-person deep water beside stairs](screenshots/gaps/deep-water-stairs.png)
- [Overhead water surfaces and stair openings](screenshots/gaps/deep-water-stairs-top.png)

Validation: production build, TypeScript check and 21 targeted render tests passed. These cover the extracted liquid definitions, large-room consistency, unbounded coordinates, bounded floods, shared cache reuse, and real GameMap mutation/load/evict/replacement dependency snapshots. The previously skipped common-terrain test now runs against Bright Nights data.

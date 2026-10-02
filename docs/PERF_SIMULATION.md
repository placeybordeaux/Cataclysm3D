# Simulation performance investigation

The first simulation change reuses A* scratch arrays. It preserves the algorithm's Float32
cost storage, heap ordering, budget, tile queries, partial paths and output ownership. Each
search still clears its active range, so doors, destroyed walls and moving vehicle overlays
remain visible immediately. Nested calls and exceptional large searches allocate private
storage; `finally` releases the shared workspace after exceptions. Retention is capped at
262144 tiles (3.25 MiB). Result paths remain independent allocations.

## CPU comparison

Run `nix-shell --run 'npx tsx tools/perf-pathfind.ts --real-grid'`. For a comparison, export the
previous `src/game/pathfind.ts` to a temporary `.ts` file and add `--baseline /tmp/pathfind-before.ts`.
The tool warms both implementations, checks exact results, and alternates six trials in each
order. `--real-grid` uses actual `GameMap`, `Grid` and registry lookups; without it the queries
use a synthetic grid to isolate the search. The deterministic fixture has walls, doors, gaps,
mixed bash/door capabilities, variable bounds and 50/250/1500-node budgets. This is a CPU
microbenchmark, not a city gameplay profile or browser GC measurement.

Measured on the development box, 1200 searches per trial (231120 expansions, 34580 path steps):

| Grid | Previous median | Scratch reuse median | Improvement |
| --- | ---: | ---: | ---: |
| Synthetic | 93.75 ms | 88.24 ms | 5.9% |
| Actual chunk/registry lookup | 117.80 ms | 112.57 ms | 4.4% |

All 120 varied queries returned exactly equal tiles, expansion counts and completion flags.
The previous implementation allocates 42,202,940 typed-array bytes per 1200-search trial.
After workspace growth, the new implementation avoids those repeated allocations; the fixture
needs a 16384-tile workspace (208 KiB). This is an allocation count from the implementation,
not a measurement of reclaimed bytes or GC pause duration. Heap arrays and output tiles still
allocate. Existing monster tests plus four new lifetime tests pass (51 checks); the new tests
cover map mutation, changing bounds, result ownership, nested calls, callback exceptions and
searches exceeding the retention cap.

## Workers and WASM

`tools/perf-worker-boundary.mjs` measures **Node worker_threads**, not browser workers: 500
warmed round trips each, echoing only a request ID. The 81 KiB payload models one 144x144
Float32 cost slab. This excludes constructing the slab from the game, path computation,
result transfer and browser scheduling.

| Payload | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Request ID only | 0.005 ms | 0.007 ms | 0.014 ms |
| Clone 81 KiB slab | 0.019 ms | 0.033 ms | 0.094 ms |
| Copy then transfer 81 KiB slab | 0.018 ms | 0.029 ms | 0.072 ms |

These costs are small enough to justify a browser prototype if a gameplay CPU profile shows
pathfinding matters. They do not justify shipping one without that profile. The current
monster system has a 2500-expansion budget per tick (individual searches normally capped at
1500); NPC searches have a separate 900-expansion limit. The real-grid fixture averages about
0.094 ms per search, with about 193 expansions. A whole-tick budget is modest on this box.

A practical prototype would keep immutable chunk terrain/furniture cost slabs in a persistent
worker, send only changed chunks plus moving-overlay updates, and batch requests. Version the
world and each monster goal; discard outdated replies, revalidate the next step against current
collision, and preserve deterministic request order and expansion budgets. Door/bashing
capabilities require distinct costs, including the algorithm's diagonal corner rules. Moving
vehicles override movement costs, so terrain-only snapshots are insufficient. Sending the
entire `Game` is unsuitable: class methods, event callbacks and mutable item ownership do not
form a serializable boundary. Offloading full simulation would first require explicit commands,
events and ownership for all those mutations, with added response latency to attacks and input.

WASM has a similar prerequisite: A* must query a packed cost snapshot, rather than cross a
JS/WASM boundary for each terrain/furniture/overlay lookup. Once that boundary exists, compare
an equally packed TypeScript implementation before attributing gains to WASM. Preserve Float32
rounding and heap tie ordering or paths and RNG-dependent gameplay may diverge.

## Next measurements

Use warmed city, combat crowd and fire scenarios in Chromium and Firefox to measure the
simulation share and its long-frame correlation. Compare browser allocation profiles before
and after scratch reuse. If perception/grid lookup dominates instead of A*, an occupancy/cost
cache with explicit invalidation may outperform either workers or WASM. `MonsterSystem`
also rebuilds its spatial map with per-cell arrays every tick, and field turns build snapshot
tuples; these are candidates for allocation profiling, not established bottlenecks. Preserve
snapshot iteration semantics when optimizing fire spread and field removal.

The parent's pristine 12-second Chromium profiles sampled about 261 ms of pathfinding self
time in citystand and 133 ms in city40 (roughly 2.2% and 1.1% of wall time). Overall sampled
GC was 150 ms and 113 ms respectively. Those observations establish that A* is relevant but
also limit the likely whole-frame gain from a 4–6% kernel improvement; they do not isolate
which allocations caused the sampled GC.

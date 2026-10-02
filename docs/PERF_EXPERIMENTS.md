# Performance branch: first investigation (2026-10-02)

Target: broad desktop support, preserve default visuals, expose optional quality tradeoffs.
All measurements below are from the development machine, an RTX 5080 with 24 logical CPU
cores. They do not establish performance on integrated GPUs or other desktops.

## Changes retained

* A* shares bounded typed-array scratch buffers, preserving search order, Float32 costs,
  budgets, map mutation visibility, nested calls, exceptions and independent path results.
  [Simulation measurements and worker/WASM evaluation](PERF_SIMULATION.md).
* Meshing uses job-local quad scratch arrays and avoids per-quad corner/UV temporaries.
  Classic/macro-tint/relief attributes and indices match the old implementation bit for bit
  for all four rotations. Interleaved jobs have separate scratch arrays.
* Sprite updates upload the pending instance span; character updates upload the active
  prefix. Pending writes survive skipped rendering and mesh growth. Initial GPU allocation
  still covers capacity. A single sprite update transfers 128 B versus 8192 B at initial
  capacity, or 32768 B after growth to 256 instances; this is a payload comparison, not FPS.
* Identity scene and chunk containers no longer dirty all descendant world matrices each
  frame. Static trees/chunks snapshot local transforms at installation; world updates remain
  enabled for parent changes and newly installed geometry. Dynamic objects remain automatic.
* Static chunk/tree/batch materials receive the MRT patch at installation, including custom
  extras and hidden children, so the application no longer scans those static subtrees every
  frame. Other scene objects and material replacements remain in the dynamic scan.
* Display pixel ratio is an optional persisted setting (Native, 0.5, 1, 1.5, 2), with
  `?pixelRatio=` overriding it. Native remains the default. Scene render resolution is still
  controlled independently by the existing Render resolution option. Because integer scaling
  depends on buffer dimensions, pixel ratio can also change the low-resolution image slightly.

## Whole-game Chromium comparison

Pristine versus final source, identical updated harness, seed 1, default voxel look and draw
distance, 1920x1080 at DPR 1, three 20-second routes, real GPU, CPU profiling enabled,
no screenshots during measurement. The world-drawn gate passed every shadow mode with the
flashlight on and off. Both pristine and final runs passed the existing budgets.

| Route | Mean loop ms before / after | Loop p99 ms before / after | Draw CPU mean ms before / after |
| --- | ---: | ---: | ---: |
| City standing | 14.84 / 12.19 | 30.7 / 26.2 | 4.28 / 3.51 |
| City driving 40 mph | 12.39 / 11.86 | 21.7 / 21.0 | 6.17 / 6.23 |
| Forest driving | 8.85 / 8.17 | 17.2 / 17.3 | 3.45 / 3.15 |

The static material scan's scene section fell from 0.47/0.57/0.36 ms to 0.08/0.07/0.03 ms
(standing/city/forest). CPU profile `multiplyMatrices` self samples fell from 605/684/459 ms
over each route to 206/221/105 ms. `updateMatrixWorld` still traverses objects and its own self
samples did not fall; the saved matrix multiplies and material traversal are the identified win.

Both driving routes had zero seconds of clear-view holes; runway p10 stayed around ten
seconds. Frame-interval p99 remained near 33.4 ms in the city and 16.8 ms in the forest.
Standing draw calls differed (539 versus 511), and simulation evolves with frame timing, so
this single paired run cannot attribute every aggregate improvement to one patch. CPU profiling
also adds overhead. No claim of an across-desktop FPS improvement follows from these numbers.

Sampled GC totals were mixed: city standing 252→213 ms, city driving 138→170 ms, forest
230→240 ms over each 20-second profile. Allocation reductions are established by isolated
sampling below; these gameplay runs do **not** establish lower GC pause time.

## Meshing CPU and allocation microbenchmarks

Synthetic 24x24 grass chunks; seven rounds of 300 chunks without profiling for CPU timings.
A separate 300-chunk sampled allocation run includes objects already collected by GC.

| Mode | CPU ms/chunk before | After | Sampled allocation estimate before / after |
| --- | ---: | ---: | ---: |
| Classic | 1.146 | 1.015 | 594.7 / 434.4 MB |
| Macro tint | 1.495 | 1.127 | 1118.7 / 496.6 MB |
| Relief | 1.844 | 1.475 | 1363.7 / 722.6 MB |

Allocation estimates are statistical and include temporary objects. Nursery heap peaks were
similar (~16 MB), illustrating why peak heap and retained memory alone miss allocation churn.
These results measure this mesher fixture, not city gameplay or frame-rate gains.

Reproduce with `nix-shell --run 'node --expose-gc --import tsx tools/bench-mesh-alloc.ts
--compare /path/to/pristine/src/render/chunkMesh.ts'` (one shell line). Add
`--heap-profile /tmp/mesh-heaps --chunks 300 --rounds 1` for allocation profiles. Baseline
modules must use the same ESM form; module-format differences can skew JIT timing.

## Renderer backend experiment

`tools/perf-backends.ts` compares the existing WebGLRenderer, WebGPURenderer's forced WebGL
backend and its verified WebGPU backend. The scene contains 1000 identical cubes, comparing
separate meshes and one InstancedMesh at pixel ratios 1 and 2. Each case warms for 60 frames
then records 150 frames. CPU ms means command submission, not GPU completion. The original
run used Chromium 154 with Vulkan ANGLE and `--enable-unsafe-webgpu`; this tests an experimental
path, not browser defaults. The tool rejects automatic fallback in the WebGPU case.

| 1080p, ratio 1 | Existing WebGL CPU mean ms | Universal renderer WebGL | WebGPU |
| --- | ---: | ---: | ---: |
| Separate meshes | 0.557 | 1.496 | 1.017 |
| Instanced | 0.105 | 0.313 | 0.217 |

WebGPU was faster than its matched universal-renderer WebGL backend in this simple scene,
but slower than the existing WebGLRenderer. This does not decide the backend for the game:
the scene omits custom shaders, shadows, MRT, postprocessing, streaming and simulation.
Instancing improved all paths. At ratio 2, presentation showed occasional long intervals on
WebGL paths; the scene is refresh-capped and CPU submission timings do not isolate fill cost.

The [official migration guide](https://threejs.org/manual/pages/webgpurenderer) says
ShaderMaterial, RawShaderMaterial and onBeforeCompile customizations require a TSL/node-material
port. The game uses those throughout its world, sprites, character/depth shaders, sky, weather
and post pipeline. MRT is supported in the new renderer; shader compatibility is the obstacle.
A complete TSL port is a separate experiment, justified only with a representative scene and
matching visual checks. WebGL remains the runtime default.

Official references used in the investigation: [BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html),
[BufferAttribute ranges](https://threejs.org/docs/pages/BufferAttribute.html),
[Object3D matrix updates](https://threejs.org/docs/pages/Object3D.html),
[display resolution](https://threejs.org/manual/pages/responsive.html).

## HiDPI display experiment

The game ran in a 1920x1080 CSS viewport with a simulated 2x display, explicit `px=360`,
then compared Native, 1 and 0.5 pixel ratios in forward and reverse order. Each case warmed
1.5 seconds and recorded six seconds; screenshots were captured after measurement.

| Setting | Canvas | Scene buffer | Mean frame interval, two trials | Mean GPU ms, two trials |
| --- | --- | --- | --- | --- |
| Native (2x) | 3840x2160 | 642x362 | 27.37 / 26.96 | 1.57 / 1.06 |
| 1x | 1920x1080 | 642x362 | 16.85 / 16.90 | 0.83 / 0.83 |
| 0.5x | 960x540 | 482x272 | 17.00 / 16.85 | 0.81 / 0.79 |

This supports an optional display-ratio setting: ratio 1 preserved the low-resolution scene
buffer in this fixture and substantially improved presentation. Ratio 0.5 changed scene
resolution through integer scaling and did not show an additional frame-rate benefit here.
The evolving monster simulation and dev-box presentation path remain confounders; no
cross-hardware or universal GPU-time improvement is claimed. Native stays the default.
`tools/perf-display.ts` reproduces the trials; `--verify-only` checks stored settings, URL
precedence and the Options row. Raw results and inspected screenshots are under
`/tmp/cdda-perf-display`.

## Benchmark instrumentation

`perf-bench` now supports `--dpr` and `--heap-profile DIR`. Allocation sampling includes
collected objects and stops before dump serialization. Allocation profiling adds overhead;
run it separately from performance comparisons. CPU profiler startup caused an artificial
~280 ms first interval; the tool now waits two animation frames before resetting telemetry.
The same updated harness runs against pristine and changed source. Avoid `--shots` during
performance measurements because screenshots can disturb presentation.

Pristine source is isolated under `/tmp/cdda-perf-pristine`; source edits during earlier
baseline startup contaminated those runs, which were discarded. Raw CPU profiles and JSON
telemetry are kept under `/tmp/cdda-perf-measured-base` and `/tmp/cdda-perf-measured-after`.
Existing committed budgets are not rewritten to conceal regressions or adapt to this hardware.

## Remaining larger experiments

A persistent worker with packed terrain/furniture/overlay cost slabs, batched versioned path
requests and stale reply rejection is plausible. Measure browser snapshot/update costs and
compare packed TypeScript before WASM; Node worker round trips alone do not establish browser
wins. Full simulation offloading requires explicit state/event ownership and must preserve
input/combat latency and deterministic ordering.

Texture arrays could consolidate atlas-page draw calls while streaming, when far-block
batching is deferred. This requires shader/atlas changes and maximum-layer/capability checks
on integrated GPUs. Whole-scene culling must include shadow cameras; blindly hiding geometry
outside the player camera can remove visible shadows. Those changes are not shipped here.

## Validation and artifacts

Typecheck, production build, and all 114 test files pass: 1536 tests passed, 19 skipped.
The default world-drawn gate passed all shadow modes with flashlight toggles in Chromium.
Additional tests verify static-transform behavior, pending GPU ranges against the actual
Three WebGLAttributes implementation, static-material preparation, scratch buffer lifetime,
and interleaved meshing. Compact measurement metadata is checked in at
[perf-results/2026-10-02.json](perf-results/2026-10-02.json); raw profiles remain in `/tmp`.

Firefox also passed the world-drawn gate and the city standing/driving route budgets at
1920x1080. City driving had zero clear-view holes, runway p10 9.78 s and loop p99 27 ms.
This is a compatibility/performance check of the final source, not a paired Firefox gain.

The display setting restored from persisted storage, URL precedence passed, and its Options
row was inspected in `/tmp/cdda-perf-display/options.png`. The harness accepts the game's
existing leave-page confirmation when navigating between checks.

The browser heap sampler was exercised on a separate five-second city-driving route at
1280x720; it emitted a valid collected-object allocation profile with 1189 call sites
(`/tmp/cdda-browser-heaps/city40.heapprofile`). That diagnostic run passed its route budgets
but is not used as an allocation A/B or a frame-time comparison.

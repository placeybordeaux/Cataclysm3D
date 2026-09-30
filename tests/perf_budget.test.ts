import { describe, expect, it } from 'vitest';
import { WorldGenerator } from '../src/world/worldgen';
import { CHUNK } from '../src/world/coords';
import { buildChunkMeshSteps, ShapeTable, type MeshExtras } from '../src/render/chunkMesh';
import { ProceduralTextureSource } from '../src/render/proceduralSource';
import { LOOKS } from '../src/render/look';
import { ModelFactory } from '../src/render/furniture/index';
import { SurfacePainter, surfaceState } from '../src/render/surfaces';
import { Dresser } from '../src/render/dressing';
import { VoxelFactory } from '../src/render/voxel';
import { Img } from '../src/render/pixelArt';
import { loadNodeData, makeMap } from '../tools/lib/node_data';

// Headless streaming cost check (docs/PERF.md): generate and mesh a dense town block of seed 1
// the way the game does under the default look (voxel + modelled furniture, painted surfaces,
// set dressing) and hold it to budgets. The budgets are generous on purpose — the machine this
// runs on is shared (load 10-15) — so they catch a blow-up (a mesher change that doubles the
// geometry or a step that stops yielding), not a 10 % drift; tools/perf-bench.ts (npm run
// perf) is the fine-grained check on the GPU. Geometry counts are deterministic and checked
// tighter.

const { game, wg } = loadNodeData();

function setup() {
  const seed = 1;
  const map = makeMap(game, seed);
  const gen = new WorldGenerator(seed, wg, game);
  gen.stats.quiet = true;
  map.generator = gen;
    const src = new ProceduralTextureSource(game);
  const models = new ModelFactory();
  models.itemDefs = game.items;
  const painter = new SurfacePainter(game.terrain, models.atlas);
  // what furniture/install.ts does for the volume looks (painted is the default style)
  surfaceState.enabled = true;
  surfaceState.style = 'painted';
  const dresser = new Dresser(models.atlas);
  const white = src.custom('white', () => {
    const im = new Img(4, 4);
    im.fill([255, 255, 255]);
    return im;
  });
  // item and glyph frames are painted on a DOM canvas: in Node, ground items get the white frame
  const nodeSrc = Object.assign(Object.create(src) as ProceduralTextureSource, { item: () => white, glyph: () => white });
  const extras = (near: boolean): MeshExtras => ({
    f: LOOKS.voxel, ground: null, white, near, voxels: new VoxelFactory(), models, surfaces: painter, dressing: dresser,
  });
  return { map, gen, src: nodeSrc, extras, shapes: new ShapeTable(map) };
}

describe('streaming cost (headless)', () => {
  it('a dense town block generates and meshes within budget, in small steps', () => {
    const { map, src, extras, shapes } = setup();
    // 3x3 OMTs around the centre of Holden (the town next to the start shelter), z 0 and 1
    const cols: [number, number][] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cols.push([40 + dx, 46 + dy]);
    const tGen = performance.now();
    for (const [cx, cy] of cols) for (const z of [-1, 0, 1, 2]) map.chunk(cx, cy, z);
    // neighbours the mesher reads (walls on chunk borders, rooms across them)
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (const z of [-1, 0, 1, 2]) map.chunk(40 + dx, 46 + dy, z);
    const genMs = performance.now() - tGen;
    let verts = 0, maxStep = 0, meshMs = 0, chunks = 0, steps = 0;
    for (const [cx, cy] of cols)
      for (const z of [0, 1]) {
        const c = map.chunk(cx, cy, z)!;
        const g = buildChunkMeshSteps(map, shapes, src, c, 'summer', undefined, extras(false));
        const t0 = performance.now();
        let s0 = t0;
        for (;;) {
          const r = g.next();
          const t = performance.now();
          maxStep = Math.max(maxStep, t - s0);
          s0 = t;
          steps++;
          if (r.done) {
            for (const gb of r.value.pages.values()) verts += gb.vertexCount;
            break;
          }
        }
        meshMs += performance.now() - t0;
        chunks++;
      }
    const perChunk = meshMs / chunks;
    console.log(`[perf_budget] mapgen 5x5x4 OMTs ${genMs.toFixed(0)} ms; mesh ${chunks} chunks ${meshMs.toFixed(0)} ms (${perChunk.toFixed(1)} ms/chunk), ${steps} steps, longest step ${maxStep.toFixed(1)} ms, ${verts} vertices`);
    // First chunks pay for warming caches (models, painted pages): generous budgets.
    expect(genMs).toBeLessThan(8000);
    expect(perChunk).toBeLessThan(250);
    // the time-slicing granularity (chunkMesh yields per row and on a 2.5 ms timer)
    expect(maxStep).toBeLessThan(400);
    // geometry is deterministic: ~101k vertices for these 18 chunks (2026-09-30). A band, not an
    // exact count, so ordinary mesher work doesn't trip it; 1.6x means something blew up.
    expect(verts).toBeGreaterThan(50_000);
    expect(verts).toBeLessThan(160_000);
    void CHUNK;
  });
});

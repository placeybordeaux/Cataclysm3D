// CPU-only allocation benchmark: no browser or GPU. Run from the repository root:
// nix-shell --run 'node --expose-gc --import tsx tools/bench-mesh-alloc.ts'
// Add --heap-profile DIR for separate sampled allocation profiles per scenario (timings
// then include profiler overhead). --compare PATH optionally
// imports another checkout's src/render/chunkMesh.ts (its dependencies must resolve).
// Hashes cover every emitted geometry attribute and index; compare checks exact output.
// Heap growth is sampled between builds and can miss brief peaks. Retained heap after GC
// is reported separately; these figures are diagnostics, not regression thresholds.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GameMap } from '../src/world/map';
import type { TerrainDef, FurnitureDef } from '../src/data/types';
import { buildChunkMesh, ShapeTable, type MeshExtras } from '../src/render/chunkMesh';
import type { TileFrame, TileTextureSource } from '../src/render/textureSource';
import { LOOKS } from '../src/render/look';
import { GroundField } from '../src/render/ground';

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const count = Number(option('--chunks', '300')), rounds = Number(option('--rounds', '7'));
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(rounds) || rounds < 1) throw new Error('chunks and rounds must be positive integers');
const heapDir = option('--heap-profile', '');
const inspector = heapDir ? new Session() : null;
inspector?.connect();
if (heapDir) mkdirSync(heapDir, { recursive: true });
const compare = option('--compare', '');
const baseline = compare ? (await import(pathToFileURL(resolve(compare)).href)).buildChunkMesh as typeof buildChunkMesh : null;
const map = new GameMap(1);
for (const t of Object.values(JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>)) map.terrain.add(t);
for (const f of Object.values(JSON.parse(readFileSync('public/data/furniture.json', 'utf8')) as Record<string, FurnitureDef>)) map.furniture.add(f);
map.generator = { generate(m, c) { c.ter.fill(m.terrain.index(c.z < 0 ? 't_rock' : c.z > 0 ? 't_open_air' : 't_grass')); } };
const page = new THREE.Texture(), shapes = new ShapeTable(map), chunk = map.chunk(0, 0, 0)!;
const frame: TileFrame = { texture: page, uv: [.1, .2, .8, .9], w: 16, h: 16, rotate: 0 };
const src: TileTextureSource = { terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame };
for (let cx = -2; cx <= 2; cx++) for (let cy = -2; cy <= 2; cy++) for (let z = -1; z <= 1; z++) map.chunk(cx, cy, z);
const ground = new GroundField(map);
ground.relief = true;
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
const digest = (g: THREE.BufferGeometry) => {
  const h = createHash('sha256');
  for (const a of Object.values(g.attributes)) h.update(Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength));
  h.update(Buffer.from(g.index!.array.buffer));
  return h.digest('hex');
};
for (const mode of ['classic', 'macro', 'relief']) {
  const extras: MeshExtras | undefined = mode === 'classic' ? undefined : {
    f: { ...LOOKS.classic, macroTint: true }, ground: mode === 'relief' ? ground : null, white: frame, near: false,
  };
  for (const rotate of [0, 1, 2, 3] as const) {
    frame.rotate = rotate;
    const actual = buildChunkMesh(map, shapes, src, chunk, 'summer', undefined, extras).pages.get(page)!.build();
    const hash = digest(actual);
    actual.dispose();
    if (baseline) {
      const expected = baseline(map, shapes, src, chunk, 'summer', undefined, extras).pages.get(page)!.build();
      if (digest(expected) !== hash) throw new Error(`Geometry changed: ${mode}, rotation ${rotate}`);
      expected.dispose();
    }
    console.log(`${mode} rotation=${rotate} sha256=${hash}`);
  }
  for (const [name, build] of [...(baseline ? [['baseline', baseline] as const] : []), ['current', buildChunkMesh] as const]) {
    for (let i = 0; i < 100; i++) build(map, shapes, src, chunk, 'summer', undefined, extras);
    const times: number[] = [];
    gc?.();
    const startHeap = process.memoryUsage().heapUsed;
    let peakHeap = startHeap;
    if (inspector) await inspector.post('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let round = 0; round < rounds; round++) {
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        build(map, shapes, src, chunk, 'summer', undefined, extras);
        if ((i & 31) === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }
      times.push((performance.now() - start) / count);
    }
    let sampledAllocatedMB: number | null = null;
    if (inspector) {
      const { profile } = await inspector.post('HeapProfiler.stopSampling');
      writeFileSync(resolve(heapDir, `${mode}-${name}.heapprofile`), JSON.stringify(profile));
      const sum = (node: typeof profile.head): number => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
      sampledAllocatedMB = sum(profile.head) / 1048576;
    }
    gc?.();
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ mode, name, chunks: count * rounds, medianMsPerChunk: times[Math.floor(times.length / 2)], sampledAllocatedMB, sampledHeapGrowthMB: (peakHeap - startHeap) / 1048576, retainedHeapGrowthMB: gc && !inspector ? (process.memoryUsage().heapUsed - startHeap) / 1048576 : null }));
  }
}

inspector?.disconnect();

// Isolate room-finish meshing cost on a fully loaded 80×40 warehouse.
// Run through heavy in nix-shell. --baseline accepts a comparison chunkMesh module.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GameMap } from '../src/world/map';
import { CHUNK } from '../src/world/coords';
import { buildChunkMesh, ShapeTable, type MeshExtras } from '../src/render/chunkMesh';
import { SurfacePainter, surfaceState } from '../src/render/surfaces';
import { ModelAtlas } from '../src/render/furniture/atlas';
import type { TerrainDef, FurnitureDef } from '../src/data/types';
import type { TileFrame, TileTextureSource } from '../src/render/textureSource';

const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;
const furniture = JSON.parse(readFileSync('public/data/furniture.json', 'utf8')) as Record<string, FurnitureDef>;
const at = process.argv.indexOf('--baseline');
const baseline = at >= 0 ? (await import(pathToFileURL(resolve(process.argv[at + 1])).href)).buildChunkMesh as typeof buildChunkMesh : null;
const map = new GameMap(1);
Object.values(terrain).forEach(t => map.terrain.add(t));
Object.values(furniture).forEach(f => map.furniture.add(f));
map.generator = { generate: (m, c) => {
  for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) {
    const tx = c.cx * CHUNK + x, ty = c.cy * CHUNK + y;
    const inside = tx >= 0 && tx <= 81 && ty >= 0 && ty <= 41;
    const wall = inside && (tx === 0 || tx === 81 || ty === 0 || ty === 41);
    c.ter[y * CHUNK + x] = m.terrain.index(c.z === 1 ? inside ? 't_flat_roof' : 't_open_air' : c.z < 0 ? 't_rock' : wall ? 't_wall' : inside ? 't_floor' : 't_grass');
  }
} };
for (let z = -1; z <= 1; z++) for (let cy = -1; cy <= 2; cy++) for (let cx = -1; cx <= 4; cx++) map.chunk(cx, cy, z);
map.setFurn(1, 1, 0, 'f_rack');
const chunks = Array.from({ length: 8 }, (_, i) => map.chunk(i % 4, Math.floor(i / 4), 0)!);
const shape = new ShapeTable(map);
const frame: TileFrame = { texture: new THREE.Texture(), uv: [0, 0, 1, 1], w: 32, h: 32 };
const source: TileTextureSource = { terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame };
surfaceState.enabled = true;
surfaceState.style = 'painted';
const atlas = new ModelAtlas();
const surfaces = new SurfacePainter(terrain, atlas);
const samples: Record<string, number[]> = { current: [], ...(baseline ? { baseline: [] } : {}) };
const count = 10;
// Alternate order each round; first two rounds warm code, texture palettes and JIT.
for (let round = 0; round < 10; round++) {
  const order = baseline ? round % 2 ? [['baseline', baseline], ['current', buildChunkMesh]] as const : [['current', buildChunkMesh], ['baseline', baseline]] as const : [['current', buildChunkMesh]] as const;
  for (const [name, build] of order) {
    const start = performance.now();
    for (let i = 0; i < count; i++) for (const chunk of chunks) build(map, shape, source, chunk, 'summer', undefined, { surfaces } as MeshExtras);
    if (round >= 2) samples[name].push((performance.now() - start) / (count * chunks.length));
  }
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
console.log(JSON.stringify({ fixture: '80×40 warehouse, eight chunks, fully loaded roofs, painted surfaces, no dressing', rounds: 8, meshesPerRound: count * chunks.length, msPerChunk: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, { mean: mean(values), rounds: values }])) }, null, 2));

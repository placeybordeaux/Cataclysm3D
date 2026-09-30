import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { TerrainDef } from '../../src/data/types';
import { GameMap, type Chunk, type ChunkGenerator } from '../../src/world/map';
import { CHUNK } from '../../src/world/coords';
import { ChunkManager, type ChunkProbe } from '../../src/render/chunkManager';
import type { SpriteLayer } from '../../src/render/sprites';
import type { TileFrame, TileTextureSource } from '../../src/render/textureSource';

// Build order of the chunk manager (docs/PERF.md): 'need' builds what the player will see
// first — ahead of a moving car before behind it — and treats LOD flips as cosmetic, never
// ahead of an unbuilt chunk. Time is faked (every performance.now() call advances it 20 us), so
// the number of build steps per frame and the order are deterministic whatever the load.

const terrain = JSON.parse(readFileSync('public/data/terrain.json', 'utf8')) as Record<string, TerrainDef>;
const page = new THREE.Texture();
const frame: TileFrame = { texture: page, uv: [0, 0, 1, 1], w: 16, h: 16 };
const stubSource: TileTextureSource = { terrain: () => frame, furniture: () => frame, item: () => frame, glyph: () => frame, sprite: () => frame };
const stubSprites = { addStatic: () => ({ setVisible() {}, dispose() {} }) } as unknown as SpriteLayer;

function world(): GameMap {
  const m = new GameMap(1);
  for (const t of Object.values(terrain)) m.terrain.add(t);
  const gen: ChunkGenerator = {
    generate(map, c: Chunk) {
      c.ter.fill(map.terrain.index(c.z === 0 ? 't_grass' : c.z < 0 ? 't_rock' : 't_open_air'));
    },
  };
  m.generator = gen;
  return m;
}

interface Built { cx: number; cy: number; z: number; first: boolean; kind: string }
function manager(schedule: 'need' | 'distance') {
  const cm = new ChunkManager(world(), stubSprites, stubSource);
  cm.schedule = schedule;
  cm.radius = 4;
  cm.levelsBelow = 0;
  cm.levelsAbove = 0;
  cm.budgetMs = 1;
  cm.boostBudgetMs = 1;
  cm.urgentBudgetMs = 1;
  const built: Built[] = [];
  const probe: ChunkProbe = { want() {}, drop() {}, built: (cx, cy, z, first, _ms, _w, kind) => void built.push({ cx, cy, z, first, kind }) };
  cm.probe = probe;
  return { cm, built };
}

let now = 0;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => (now += 0.02));
});
afterEach(() => vi.restoreAllMocks());

/** Run frames at 60 Hz moving at (vx, vy) tiles/s from (x, y); returns the final position. */
function drive(cm: ChunkManager, x: number, y: number, vx: number, vy: number, frames: number): [number, number] {
  for (let i = 0; i < frames; i++) {
    cm.update(x, y, 0, () => true);
    now += 1000 / 60;
    x += vx / 60;
    y += vy / 60;
  }
  return [x, y];
}

describe('chunk build schedule', () => {
  it("'need' builds the chunks ahead of a car before those behind it", () => {
    const res: Record<string, { ahead: number; behind: number }> = {};
    for (const schedule of ['need', 'distance'] as const) {
      const { cm, built } = manager(schedule);
      // looking and driving east at 27 m/s (60 mph)
      cm.forward.x = 1;
      cm.forward.y = 0;
      drive(cm, 12, 12, 27, 0, 90);
      const first = built.filter((b) => b.first).slice(0, 30);
      res[schedule] = { ahead: first.filter((b) => b.cx > 0).length, behind: first.filter((b) => b.cx < 0).length };
    }
    expect(res.need.ahead).toBeGreaterThan(res.need.behind * 3);
    expect(res.need.ahead).toBeGreaterThan(res.distance.ahead);
  });

  it("'need' builds the player's own 3x3 first after a teleport, even behind the camera (load curtain)", () => {
    const { cm, built } = manager('need');
    cm.forward.x = 1;
    cm.forward.y = 0;
    drive(cm, 1000 * 24 + 12, 12, 0, 0, 600);
    const first9 = built.filter((b) => b.first).slice(0, 9).map((b) => `${b.cx - 1000},${b.cy}`).sort();
    expect(first9).toEqual(['-1,-1', '-1,0', '-1,1', '0,-1', '0,0', '0,1', '1,-1', '1,0', '1,1']);
  });

  it("'need' never spends a step on a LOD flip while a chunk in view is unbuilt, and never downgrades while moving", () => {
    const { cm, built } = manager('need');
    cm.lodRadius = 1.8;
    cm.forward.x = 1;
    cm.forward.y = 0;
    // stand still until everything is built (near ring included)
    drive(cm, 12, 12, 0, 0, 2000);
    expect(cm.stats.pending).toBe(0);
    built.length = 0;
    // drive east for 3 s: the near ring moves; new chunks appear at the frontier
    drive(cm, 12, 12, 20, 0, 180);
    const rebuilds = built.filter((b) => !b.first && b.kind !== 'trees');
    const firsts = built.filter((b) => b.first);
    expect(firsts.length).toBeGreaterThan(0);
    // chunks left behind the near ring (west of the player's chunk) keep their detailed mesh
    const px = 12 + 20 * 3;
    const downgrades = rebuilds.filter((b) => b.cx < Math.floor(px / CHUNK) - 1);
    expect(downgrades).toEqual([]);
  });

  it("'distance' (the wave-3 order) still rebuilds LOD flips in distance order", () => {
    const { cm, built } = manager('distance');
    cm.lodRadius = 1.8;
    drive(cm, 12, 12, 0, 0, 2000);
    built.length = 0;
    drive(cm, 12, 12, 20, 0, 180);
    expect(built.some((b) => !b.first)).toBe(true);
  });

  it('standing still, everything gets built and the downgrades happen too', () => {
    const { cm } = manager('need');
    cm.lodRadius = 1.8;
    drive(cm, 12, 12, 0, 0, 2000);
    const [x, y] = drive(cm, 12, 12, 20, 0, 180);
    drive(cm, x, y, 0, 0, 4000);
    expect(cm.stats.pending).toBe(0);
  });
});

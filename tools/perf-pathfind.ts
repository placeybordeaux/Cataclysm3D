// CPU-only, repeatable A* benchmark. Optional --baseline <module.ts> also checks exact
// results against an older implementation. Run in nix-shell: npx tsx tools/perf-pathfind.ts.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { findPath, type PathOpts } from '../src/game/pathfind';
import { Grid } from '../src/game/los';
import { GameMap } from '../src/world/map';
import type { TerrainDef } from '../src/data/types';

const floor = { id: 'floor', move_cost: 2 };
const wall = { id: 'wall', move_cost: 0, bash: { str_min: 16 } };
const door = { id: 'door', move_cost: 0, open: 'floor', bash: { str_min: 4 } };
const furniture = { id: 'f_null', move_cost_mod: 0 };
// Long walls with doors and gaps force expansions instead of just straight corridors.
const terrain = (x: number, y: number) => x % 11 === 0 && y % 17 !== 0 ? (y % 17 === 8 ? door : wall) : floor;
const syntheticGrid = {
  ter: terrain,
  furn: () => furniture,
  moveCost: (x: number, y: number) => terrain(x, y).move_cost,
} as unknown as Grid;
const realGrid = process.argv.includes('--real-grid');
let grid = syntheticGrid;
if (realGrid) {
  const map = new GameMap(1);
  for (const def of [floor, wall, door]) map.terrain.add(def as TerrainDef);
  // Cover all case bounds, then exercise the actual chunk/registry lookup path.
  for (let y = -48; y < 96; y++) for (let x = -48; x < 96; x++) map.setTer(x, y, 0, terrain(x, y).id);
  grid = new Grid(map);
}
const cases = Array.from({ length: 120 }, (_, i) => ({
  sx: 1 + i % 7, sy: i % 13, gx: 15 + i % 49, gy: 8 + i % 37,
  opts: { maxNodes: [50, 250, 1500][i % 3], margin: [4, 12, 20][i % 3], doors: i % 2 === 0, bash: i % 4 === 0 } satisfies PathOpts,
}));
type Finder = typeof findPath;
function run(fn: Finder, repeats: number) {
  let expanded = 0, steps = 0;
  const start = performance.now();
  for (let r = 0; r < repeats; r++) for (const c of cases) {
    if (realGrid) grid.reset();
    const result = fn(grid, c.sx, c.sy, c.gx, c.gy, 0, c.opts);
    expanded += result.expanded;
    steps += result.tiles.length;
  }
  return { ms: performance.now() - start, expanded, steps };
}
const baselineArg = process.argv.indexOf('--baseline');
const baseline: Finder | undefined = baselineArg >= 0
  ? (await import(pathToFileURL(resolve(process.argv[baselineArg + 1])).href)).findPath : undefined;
if (baseline) for (const c of cases) {
  const args = [grid, c.sx, c.sy, c.gx, c.gy, 0, c.opts] as const;
  if (JSON.stringify(findPath(...args)) !== JSON.stringify(baseline(...args))) throw new Error(`Mismatch ${JSON.stringify(c)}`);
}
for (const fn of baseline ? [baseline, findPath] : [findPath]) run(fn, 5);
const trials: { name: string; ms: number; expanded: number; steps: number }[] = [];
for (let i = 0; i < 6; i++) {
  // Alternate order to reduce drift from CPU load and temperature.
  const order = baseline ? (i % 2 ? [['current', findPath], ['baseline', baseline]] : [['baseline', baseline], ['current', findPath]]) : [['current', findPath]];
  for (const [name, fn] of order as [string, Finder][]) trials.push({ name, ...run(fn, 10) });
}
const scratchBytesPerBatch = cases.reduce((sum, c) => sum + (Math.abs(c.gx - c.sx) + 2 * c.opts.margin + 1)
  * (Math.abs(c.gy - c.sy) + 2 * c.opts.margin + 1) * 13, 0);
const maxScratchNodes = Math.max(...cases.map((c) => (Math.abs(c.gx - c.sx) + 2 * c.opts.margin + 1)
  * (Math.abs(c.gy - c.sy) + 2 * c.opts.margin + 1)));
console.log(JSON.stringify({ grid: realGrid ? 'real' : 'synthetic', searchesPerTrial: cases.length * 10,
  baselineScratchBytesPerTrial: scratchBytesPerBatch * 10,
  retainedScratchBytes: 2 ** Math.ceil(Math.log2(maxScratchNodes)) * 13,
  exactBaselineMatch: baseline ? true : undefined, trials }, null, 2));

import type { Grid } from './los';
import { findPath } from './pathfind';
import type { StairLink } from './stairs';

interface Point { x: number; y: number; z: number }
/** Pick a loaded, reachable flight toward a goal on an adjacent level. Paths are budgeted,
 * and only complete paths count, so a nearer staircase behind a wall cannot win. */
export function routeToStair(grid: Grid, links: Iterable<StairLink>, from: Point, to: Point, sharedBudget?: { remaining: number }): { link: StairLink; up: boolean } | null {
  if (sharedBudget && sharedBudget.remaining <= 0) return null;
  if (Math.abs(to.z - from.z) !== 1 || !grid.passable(Math.floor(to.x), Math.floor(to.y), to.z)) return null;
  const up = to.z > from.z;
  const candidates = [...links].filter((l) => l.z === (up ? from.z : to.z)).map((link) => {
    const entry = link.path.at(up ? 0 : link.path.len), exit = link.path.at(up ? link.path.len : 0);
    return { link, entry, exit, estimate: Math.hypot(from.x - entry.x, from.y - entry.y) + Math.hypot(to.x - exit.x, to.y - exit.y) };
  }).filter((c) => Math.hypot(from.x - c.entry.x, from.y - c.entry.y) <= 30).sort((a, b) => a.estimate - b.estimate);
  let best: StairLink | null = null, score = Infinity, budget = Math.min(1000, sharedBudget?.remaining ?? 1000);
  for (const c of candidates.slice(0, 4)) {
    if (budget <= 0) break;
    if (!grid.passable(Math.floor(c.entry.x), Math.floor(c.entry.y), from.z) || !grid.passable(Math.floor(c.exit.x), Math.floor(c.exit.y), to.z)) continue;
    const approach = findPath(grid, Math.floor(from.x), Math.floor(from.y), Math.floor(c.entry.x), Math.floor(c.entry.y), from.z, { maxNodes: Math.min(300, budget), margin: 4 });
    budget -= approach.expanded;
    if (sharedBudget) sharedBudget.remaining -= approach.expanded;
    if (!approach.complete || budget <= 0) continue;
    const depart = findPath(grid, Math.floor(c.exit.x), Math.floor(c.exit.y), Math.floor(to.x), Math.floor(to.y), to.z, { maxNodes: Math.min(300, budget), margin: 4 });
    budget -= depart.expanded;
    if (sharedBudget) sharedBudget.remaining -= depart.expanded;
    if (!depart.complete) continue;
    const cost = approach.tiles.length + c.link.path.len + depart.tiles.length;
    if (cost < score) { best = c.link; score = cost; }
  }
  return best ? { link: best, up } : null;
}

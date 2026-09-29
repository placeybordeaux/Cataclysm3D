import type { Grid } from './los';

// Budgeted A* on the tile grid for monster pathing (CDDA monster::path uses the same idea
// with bash/door costs from path_settings). A per-tick node budget keeps 150 chasing
// monsters from stalling a frame: requests that don't fit wait for the next tick.

export interface PathOpts {
  /** Can bash through bashable impassable tiles (doors, windows, furniture). */
  bash?: boolean;
  /** Can open doors (CAN_OPEN_DOORS). */
  doors?: boolean;
  /** Max node expansions for this search. */
  maxNodes?: number;
  /** How far outside the start/goal bounding box the search may wander. */
  margin?: number;
}

export interface PathResult {
  /** Tile coords from the first step to the goal (start excluded). */
  tiles: [number, number][];
  /** Nodes expanded (for budgeting). */
  expanded: number;
  /** True when the goal was reached; false = partial path toward the closest node. */
  complete: boolean;
}

/** Cost to enter a tile in units of flat-ground steps (100 moves), or Infinity. */
export function tileCost(grid: Grid, x: number, y: number, z: number, opts: PathOpts): number {
  const t = grid.ter(x, y, z);
  if (!t) return Infinity;
  const mc = grid.moveCost(x, y, z);
  // move_cost 2 (= 100 moves) is flat ground, cost 1.
  if (mc > 0) return mc / 2;
  if (opts.doors && t.open) return 2;
  if (opts.bash) {
    const f = grid.furn(x, y, z)!;
    const bash = f.id !== 'f_null' && f.move_cost_mod < 0 ? f.bash : t.bash;
    // Stronger obstacles are more expensive so zombies prefer doors/windows over walls.
    if (bash && typeof bash.str_min === 'number') return 6 + Math.min(60, bash.str_min / 2);
  }
  return Infinity;
}

class Heap {
  private k: number[] = [];
  private p: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, pri: number): void {
    const k = this.k, p = this.p;
    let i = k.length;
    k.push(key);
    p.push(pri);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (p[j] <= pri) break;
      k[i] = k[j];
      p[i] = p[j];
      i = j;
    }
    k[i] = key;
    p[i] = pri;
  }
  pop(): number {
    const k = this.k, p = this.p;
    const top = k[0];
    const lk = k.pop()!, lp = p.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        k[i] = k[c];
        p[i] = p[c];
        i = c;
      }
      k[i] = lk;
      p[i] = lp;
    }
    return top;
  }
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * A* from tile (sx,sy) to (gx,gy) on level z. Diagonals may not cut wall corners. When the
 * goal is unreachable within the budget, returns the path to the node closest to the goal
 * so the monster still makes progress (CDDA falls back to moving straight at the target).
 */
export function findPath(grid: Grid, sx: number, sy: number, gx: number, gy: number, z: number, opts: PathOpts = {}): PathResult {
  const maxNodes = opts.maxNodes ?? 1500;
  const margin = opts.margin ?? 12;
  const x0 = Math.min(sx, gx) - margin, y0 = Math.min(sy, gy) - margin;
  const w = Math.abs(gx - sx) + 2 * margin + 1, h = Math.abs(gy - sy) + 2 * margin + 1;
  const N = w * h;
  const g = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const costCache = new Float32Array(N).fill(-1);
  const idx = (x: number, y: number) => (y - y0) * w + (x - x0);
  const inb = (x: number, y: number) => x >= x0 && y >= y0 && x < x0 + w && y < y0 + h;
  const cost = (x: number, y: number) => {
    const i = idx(x, y);
    let c = costCache[i];
    if (c < 0) costCache[i] = c = tileCost(grid, x, y, z, opts);
    return c;
  };
  const hfn = (x: number, y: number) => {
    const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const open = new Heap();
  const s = idx(sx, sy);
  g[s] = 0;
  open.push(s, hfn(sx, sy));
  let expanded = 0;
  let best = s, bestH = hfn(sx, sy);
  const goal = idx(gx, gy);
  while (open.size && expanded < maxNodes) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    const cx = (cur % w) + x0, cy = Math.floor(cur / w) + y0;
    if (cur === goal) {
      best = cur;
      bestH = 0;
      break;
    }
    const hc = hfn(cx, cy);
    if (hc < bestH) {
      bestH = hc;
      best = cur;
    }
    for (const [dx, dy, dl] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inb(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      // The goal tile itself may be "blocked" by the target standing in a doorway etc.
      let c = ni === goal ? Math.min(cost(nx, ny), 1) : cost(nx, ny);
      if (!isFinite(c)) continue;
      if (dx && dy && (!isFinite(cost(cx + dx, cy)) || !isFinite(cost(cx, cy + dy)) || cost(cx + dx, cy) > 3 || cost(cx, cy + dy) > 3)) continue;
      const ng = g[cur] + c * dl;
      if (ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        open.push(ni, ng + hfn(nx, ny));
      }
    }
  }
  const tiles: [number, number][] = [];
  for (let n = best; n !== s && n >= 0; n = from[n]) tiles.push([(n % w) + x0, Math.floor(n / w) + y0]);
  tiles.reverse();
  return { tiles, expanded, complete: best === goal };
}

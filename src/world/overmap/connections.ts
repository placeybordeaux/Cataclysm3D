import type { ConnectionSubtype, OterDef, OvermapConnectionDef } from '../worldgen_data';
import { MinHeap } from './heap';
import { OmtRef, isLinear, isRotatable } from './oter';

// BN overmap_connection layout and building (overmap_connection.cpp pick_subtype_for /
// can_start_at / has, overmap.cpp lay_out_connection, build_connection, the connection part of
// place_special, and simple_pathfinding.cpp greedy_path), ported for the underground networks
// (sewer_tunnel at z-1, subway_tunnel at z-2). It works on one region at a time: a BN overmap is
// 180x180 OMTs and links connections only within itself, our regions are REGION wide and do the
// same, so the result never depends on which neighbour generated first.

/** om_direction order, the same as overmap.ts DX/DY and oter.ts LINE_* bits (1 << dir). */
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const opposite = (d: number) => (d + 2) % 4;
const parallel = (a: number, b: number) => a % 2 === b % 2;
/** BN om_lines::is_straight: dead ends count as straight, they can still be extended. */
const isStraight = (l: number) => l === 1 || l === 2 || l === 4 || l === 5 || l === 8 || l === 10;

/** Terrain access for one region at one z; null outside it. */
export interface ConnectionGrid {
  readonly size: number;
  get(x: number, y: number, z: number): OmtRef | null;
  set(x: number, y: number, z: number, ref: OmtRef): void;
}

/** A path node, BN pf::directed_node: `dir` points at the next node towards the source, -1 at the source. */
interface PathNode {
  x: number;
  y: number;
  dir: number;
}

export interface ConnectionTarget {
  x: number;
  y: number;
  z: number;
  connection: string;
  /** BN cube_direction the connection leaves the special in (from -> point), -1 for none */
  initialDir: number;
  /** owning city centre, region-local, for "city" layout connections */
  city?: { x: number; y: number };
}

export class ConnectionBuilder {
  /** BN overmap_connection_cache: start points of built connections, by connection id and z. */
  private cache = new Map<string, { x: number; y: number }[]>();

  constructor(
    private readonly grid: ConnectionGrid,
    private readonly defs: Record<string, OterDef>,
    private readonly connections: Record<string, OvermapConnectionDef>,
    private readonly locationSets: Map<string, Set<string>>,
  ) {}

  connection(id: string): OvermapConnectionDef {
    const c = this.connections[id];
    if (!c) throw new Error(`overmap connection ${id} is not in overmap.json (tools/extract/mapgen.ts CONNECTIONS_BUILT)`);
    for (const st of c.subtypes) if (!this.defs[st.terrain]) throw new Error(`overmap connection ${id}: terrain ${st.terrain} is not extracted`);
    return c;
  }

  /**
   * BN pick_subtype_for. A subtype without locations only ever applies where its terrain already
   * is, and wins outright; otherwise the cheapest allowed subtype. BN breaks ties with a weighted
   * roll, which only matters for local_road's bridge/dam, so the first is taken.
   */
  pickSubtype(c: OvermapConnectionDef, ref: OmtRef | null): ConnectionSubtype | null {
    if (!ref) return null;
    let best: ConnectionSubtype | null = null;
    for (const st of c.subtypes) {
      if (!(ref.type === st.terrain || st.locations.some((l) => this.locationSets.get(l)?.has(ref.type)))) continue;
      if (!st.locations.length) return st;
      if (!best || st.basicCost < best.basicCost) best = st;
    }
    return best;
  }

  private allowsTurns(st: ConnectionSubtype | null): boolean {
    return !!st && isLinear(this.defs[st.terrain]);
  }

  canStartAt(c: OvermapConnectionDef, ref: OmtRef | null): boolean {
    return this.allowsTurns(this.pickSubtype(c, ref));
  }

  has(c: OvermapConnectionDef, ref: OmtRef | null): boolean {
    return !!ref && c.subtypes.some((st) => st.terrain === ref.type);
  }

  private inbounds(x: number, y: number, clearance = 0): boolean {
    const n = this.grid.size;
    return x >= clearance && y >= clearance && x < n - clearance && y < n - clearance;
  }

  /** BN lay_out_connection (must_be_unexplored is always false here). */
  layOut(c: OvermapConnectionDef, src: { x: number; y: number }, dst: { x: number; y: number }, z: number): PathNode[] {
    const g = this.grid;
    const score = (cur: PathNode, prev: PathNode | null): [number, number] | null => {
      const id = g.get(cur.x, cur.y, z);
      const st = this.pickSubtype(c, id);
      if (!st || !id) return null;
      const existing = this.has(c, id);
      if (existing && isRotatable(this.defs[id.type]) && cur.dir >= 0 && !parallel(id.rot, cur.dir)) return null;
      if (prev && prev.dir >= 0 && prev.dir !== cur.dir && !this.allowsTurns(this.pickSubtype(c, g.get(prev.x, prev.y, z)))) return null;
      if (prev && prev.dir < 0 && cur.dir >= 0) {
        // BN: a connection that can't turn and starts near the border must leave it perpendicularly.
        const back = opposite(cur.dir);
        if (!this.canStartAt(c, g.get(prev.x, prev.y, z)) && !this.inbounds(cur.x, cur.y, 1) && this.inbounds(prev.x + DX[back], prev.y + DY[back])) return null;
      }
      let est = st.orthogonal ? Math.abs(dst.x - cur.x) + Math.abs(dst.y - cur.y) : Math.trunc(Math.hypot(dst.x - cur.x, dst.y - cur.y));
      if (!existing) est *= 5;
      if (!this.inbounds(cur.x, cur.y, 1)) est *= 2;
      return [st.basicCost, est];
    };
    return this.greedyPath(src, dst, score);
  }

  /**
   * BN pf::greedy_path: best-first on node cost + estimate (not accumulated cost), so it hugs
   * existing connections the estimate rewards. Nodes come back destination first.
   */
  private greedyPath(src: { x: number; y: number }, dst: { x: number; y: number }, score: (cur: PathNode, prev: PathNode | null) => [number, number] | null): PathNode[] {
    const n = this.grid.size;
    if (src.x === dst.x && src.y === dst.y) return [];
    if (!this.inbounds(src.x, src.y) || !this.inbounds(dst.x, dst.y)) return [];
    if (!score({ x: src.x, y: src.y, dir: -1 }, null)) return [];
    const closed = new Uint8Array(n * n);
    const open = new Float64Array(n * n);
    const dirs = new Int8Array(n * n);
    const heap = new MinHeap();
    const si = src.y * n + src.x;
    open[si] = Infinity;
    heap.push(si * 5 + 4, 1000);
    while (heap.size) {
      const key = heap.pop();
      const i = Math.floor(key / 5), md = key % 5 === 4 ? -1 : key % 5;
      if (closed[i]) continue;
      closed[i] = 1;
      const mx = i % n, my = Math.floor(i / n);
      if (mx === dst.x && my === dst.y) {
        const out: PathNode[] = [];
        let x = mx, y = my;
        while (x !== src.x || y !== src.y) {
          const d = dirs[y * n + x];
          out.push({ x, y, dir: d });
          x += DX[d];
          y += DY[d];
        }
        out.push({ x, y, dir: -1 });
        return out;
      }
      for (let d = 0; d < 4; d++) {
        const px = mx + DX[d], py = my + DY[d];
        if (!this.inbounds(px, py)) continue;
        const ni = py * n + px;
        if (closed[ni]) continue;
        const s = score({ x: px, y: py, dir: d }, { x: mx, y: my, dir: md });
        if (!s) continue;
        const pri = s[0] + s[1];
        if (open[ni] === 0 || open[ni] > pri) {
          dirs[ni] = opposite(d);
          open[ni] = pri;
          heap.push(ni * 5 + d, pri);
        }
      }
    }
    return [];
  }

  /** BN build_connection(connection, path, z, initial_dir). */
  build(c: OvermapConnectionDef, path: PathNode[], z: number, initialDir = -1): boolean {
    if (!path.length) return false;
    const g = this.grid;
    let prevDir = initialDir;
    for (const node of path) {
      const id = g.get(node.x, node.y, z);
      const st = this.pickSubtype(c, id);
      if (!st || !id) throw new Error(`overmap connection ${c.id}: no subtype for ${id?.type} at ${node.x},${node.y},${z} on a laid-out path`);
      const newDir = node.dir;
      if (isLinear(this.defs[st.terrain])) {
        let line = this.has(c, id) && id.line >= 0 ? id.line : 0;
        if (newDir >= 0) line |= 1 << newDir;
        if (prevDir >= 0) line |= 1 << opposite(prevDir);
        for (let d = 0; d < 4; d++) {
          const nx = node.x + DX[d], ny = node.y + DY[d];
          // BN joins start/end nodes to out-of-bounds neighbours (connections_out); our tunnels
          // stay inside their region, so a tunnel at the edge just ends there.
          if (!this.inbounds(nx, ny)) continue;
          const near = g.get(nx, ny, z);
          if (!near || !this.has(c, near)) continue;
          if (isLinear(this.defs[near.type])) {
            // BN checks the near line against new_dir, not d: kept as BN has it.
            if (isStraight(near.line) || (newDir >= 0 && near.line & (1 << newDir))) {
              g.set(nx, ny, z, { type: near.type, rot: 0, line: near.line | (1 << opposite(d)) });
              line |= 1 << d;
            }
          } else if (isRotatable(this.defs[near.type]) && parallel(d, near.rot)) line |= 1 << d;
        }
        if (line === 0) throw new Error(`overmap connection ${c.id}: invalid path at ${node.x},${node.y},${z}`);
        g.set(node.x, node.y, z, { type: st.terrain, rot: 0, line });
      } else if (id.type !== st.terrain && (newDir >= 0 || prevDir >= 0)) {
        // Only reachable for a non-linear subtype over its own terrain (a subway station), which
        // BN re-rotates along the path; that can flip a placed station, so it stays as placed.
        g.set(node.x, node.y, z, { type: st.terrain, rot: newDir >= 0 ? newDir : prevDir, line: -1 });
      }
      prevDir = newDir;
    }
    const key = `${c.id}@${z}`;
    let pts = this.cache.get(key);
    if (!pts) this.cache.set(key, (pts = []));
    pts.push({ x: path[0].x, y: path[0].y });
    return true;
  }

  /**
   * The connection part of BN place_special: link to the owning city's centre ("city" layout),
   * else to the nearest earlier connection of the same kind (ten tries), else lay a one-tile stub
   * pointing out of the special so a later one can link to it.
   */
  connect(t: ConnectionTarget): boolean {
    const c = this.connection(t.connection);
    if (!this.canStartAt(c, this.grid.get(t.x, t.y, t.z))) return false;
    const dst = { x: t.x, y: t.y };
    let linked = false;
    if (c.layout === 'city' && t.city) linked = this.build(c, this.layOut(c, t.city, dst, t.z), t.z, t.initialDir);
    if (!linked) {
      // BN rl_dist with the default (square) metric; a stable sort keeps ties in build order.
      const pts = [...(this.cache.get(`${c.id}@${t.z}`) ?? [])].sort((a, b) => cheb(a, dst) - cheb(b, dst));
      let attempts = 0;
      for (const p of pts) if ((linked = this.build(c, this.layOut(c, p, dst, t.z), t.z, t.initialDir)) || ++attempts > 10) break;
    }
    if (!linked && t.initialDir >= 0) linked = this.build(c, [{ x: t.x, y: t.y, dir: opposite(t.initialDir) }], t.z);
    return linked;
  }

  /** Every start point a built connection left, for tests and probes. */
  starts(connection: string, z: number): readonly { x: number; y: number }[] {
    return this.cache.get(`${connection}@${z}`) ?? [];
  }
}

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

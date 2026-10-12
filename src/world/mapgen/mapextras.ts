import type { Rng } from '../../core/rng';
import type { SpawnedItem } from '../../data/itemgroups';
import { MapBuffer, OMT } from './buffer';

// Ports of Cataclysm: Bright Nights' C++ map extras (src/mapgen/map_extras.cpp,
// map_extra_function generators) that the region tables we apply (subway, sewer; see
// WorldGenerator.applyMapExtra) can pick. JSON (update_mapgen) extras run through the JSON
// interpreter instead. Each function works on the OMT's base buffer in local 0..23 coordinates,
// unrotated, like BN's mapgen_constructor.

export interface MapExtraEnv {
  expandItems(ref: unknown, rng: Rng): SpawnedItem[];
  /** Terrain flags; undefined = unknown terrain id. */
  terrainFlags(id: string): readonly string[] | undefined;
  /** Terrain and furniture at buffer tile i let a creature through (mapgen_constructor::passable). */
  passable(buf: MapBuffer, i: number): boolean;
  /** Terrain bashing `id` leaves (bash.ter_set); undefined = not bashable (bash.str_max == -1). */
  terrainBash(id: string): string | undefined;
  /** Furniture bashing `id` leaves ('' = none); undefined = not bashable. */
  furnitureBash(id: string): string | undefined;
  /** field_type's max intensity (its intensity_levels); throws for an unknown field. */
  fieldMaxIntensity(id: string): number;
}

type P = readonly [number, number];
const SEEX = 12, SEEY = 12;
const idx = (p: P) => MapBuffer.idx(p[0], p[1]);

/** mapgen_constructor::points_in_rectangle: the inclusive rectangle, clipped to the OMT. */
function rect(x0: number, y0: number, x1: number, y1: number): P[] {
  const out: P[] = [];
  for (let y = Math.max(0, Math.min(y0, y1)); y <= Math.min(OMT - 1, Math.max(y0, y1)); y++)
    for (let x = Math.max(0, Math.min(x0, x1)); x <= Math.min(OMT - 1, Math.max(x0, x1)); x++) out.push([x, y]);
  return out;
}
/** points_in_radius: the (2r+1)^2 square around c, clipped. */
const radius = (c: P, r: number): P[] => rect(c[0] - r, c[1] - r, c[0] + r, c[1] + r);

/** BN random_point(range, pred): ten random tries, then a random pick among every point that fits. */
function randomPoint(rng: Rng, range: P[], pred: (p: P) => boolean): P | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of range) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  for (let k = 0; k < 10; k++) {
    const p: P = [rng.int(x0, x1), rng.int(y0, y1)];
    if (pred(p)) return p;
  }
  const ok = range.filter(pred);
  return ok.length ? rng.pick(ok) : null;
}

/** BN line_to(p1, p2, t = 0) (line.cpp bresenham): the start excluded, the end included; the
 *  start alone when both are the same point. Used by add_splatter_trail and mx_casings. */
export function lineTo(from: P, to: P): P[] {
  if (from[0] === to[0] && from[1] === to[1]) return [from];
  const out: P[] = [];
  const sx = Math.sign(to[0] - from[0]), sy = Math.sign(to[1] - from[1]);
  const ax = Math.abs(to[0] - from[0]) * 2, ay = Math.abs(to[1] - from[1]) * 2;
  let [x, y] = from, t = 0;
  if (ax === ay) {
    while (x !== to[0]) (x += sx), (y += sy), out.push([x, y]);
  } else if (ax > ay) {
    while (x !== to[0]) {
      if (t > 0) (y += sy), (t -= ax);
      x += sx;
      t += ay;
      out.push([x, y]);
    }
  } else {
    while (y !== to[1]) {
      if (t > 0) (x += sx), (t -= ay);
      y += sy;
      t += ax;
      out.push([x, y]);
    }
  }
  return out;
}

function hasNoFloor(env: MapExtraEnv, buf: MapBuffer, p: P): boolean {
  return env.terrainFlags(buf.ter[idx(p)])?.includes('NO_FLOOR') ?? false;
}

/** field::add_field through mapgen_constructor::add_field: intensities of the same field stack, capped. */
function addField(env: MapExtraEnv, buf: MapBuffer, p: P, type: string, intensity: number): void {
  const max = env.fieldMaxIntensity(type);
  const i = idx(p);
  let l = buf.fields.get(i);
  if (!l) buf.fields.set(i, (l = []));
  const f = l.find((e) => e.type === type);
  if (f) f.intensity = Math.min(max, f.intensity + intensity);
  else l.push({ type, intensity: Math.min(max, intensity), age: 0 });
}

function addItems(buf: MapBuffer, p: P, list: SpawnedItem[]): void {
  // Every pile is its own copy (BN copy_list item::spawn): nothing is shared between tiles.
  for (const e of structuredClone(list)) buf.addItem(idx(p), e.count === 1 ? { typeId: e.id, spawned: e } : { typeId: e.id, count: e.count, spawned: e });
}

/** mapgen_constructor::destroy: bash at strength 999 (furniture first, then terrain) while impassable, up to 26 times. */
function destroy(env: MapExtraEnv, buf: MapBuffer, i: number): void {
  for (let count = 0; count <= 25 && !env.passable(buf, i); count++) {
    const f = buf.furn[i] ? env.furnitureBash(buf.furn[i]) : undefined;
    if (f !== undefined) buf.furn[i] = f;
    else {
      const t = env.terrainBash(buf.ter[i]);
      if (t === undefined) return;
      buf.ter[i] = t;
    }
  }
}

/** mapgen_constructor::make_rubble(p, rubble, t_dirt, overwrite = false). */
function makeRubble(env: MapExtraEnv, buf: MapBuffer, p: P, rubble: string): void {
  const i = idx(p);
  const furnBashable = !!buf.furn[i] && env.furnitureBash(buf.furn[i]) !== undefined;
  const bashable = () => (!!buf.furn[i] && env.furnitureBash(buf.furn[i]) !== undefined) || env.terrainBash(buf.ter[i]) !== undefined;
  if (furnBashable) buf.furn[i] = '';
  if (!env.passable(buf, i) && bashable()) destroy(env, buf, i);
  if (!env.passable(buf, i)) buf.ter[i] = 't_dirt';
  buf.furn[i] = rubble;
}

/**
 * mx_portal: a shimmering portal trap on a random floor tile away from the edge, rock rubble on
 * it and the 8 tiles around, then 0-4 single nether creatures (GROUP_NETHER_PORTAL, one roll
 * each, not density-scaled: place_spawns(..., individual = true)) each on its own heap of rubble.
 */
export function mxPortal(env: MapExtraEnv, buf: MapBuffer, rng: Rng): boolean {
  const points = rect(1, 1, SEEX * 2 - 2, SEEY * 2 - 2);
  const portal = randomPoint(rng, points, (p) => !hasNoFloor(env, buf, p) && !buf.traps.has(idx(p)));
  if (!portal) return false;
  for (const p of radius(portal, 1)) if (!hasNoFloor(env, buf, p)) makeRubble(env, buf, p, 'f_rubble_rock');
  buf.traps.set(idx(portal), 'tr_portal');
  const n = rng.int(0, 4);
  for (let k = 0; k < n; k++) {
    // BN also skips tiles with a creature on the main map (its own TODO calls that check wrong);
    // nothing stands in an OMT that is still being generated, so it never applies here.
    const at = randomPoint(rng, points, (p) => !hasNoFloor(env, buf, p) && (p[0] !== portal[0] || p[1] !== portal[1]));
    if (!at) break;
    makeRubble(env, buf, at, 'f_rubble_rock');
    buf.spawns.push({ kind: 'group', id: 'GROUP_NETHER_PORTAL', x: at[0], y: at[1], count: 1, individual: true });
  }
  return true;
}

/**
 * mx_casings: the aftermath of a shootout, one of four layouts: a pile of spent casings
 * (item group ammo_casings, the same roll copied onto each tile), a field of them, a firing
 * line, or two shooters' piles; each with 1-3 heaps of map_extra_casings trash near the
 * middle and, half the time, blood and a bloody rag (sometimes a blood trail).
 */
export function mxCasings(env: MapExtraEnv, buf: MapBuffer, rng: Rng): boolean {
  const casings = () => env.expandItems('ammo_casings', rng);
  const items = casings();
  const inner = () => [rng.int(1, SEEX * 2 - 2), rng.int(1, SEEY * 2 - 2)] as const;
  // BN writes `for (int i = 0; i < rng(1, 3); i++)`, re-rolling the bound every iteration (so 1
  // heap 1/3 of the time, 2 for 4/9, 3 for 2/9); kept as written.
  const trash = (center: P) => {
    for (let i = 0; i < rng.int(1, 3); i++) addItems(buf, rng.pick(radius(center, 10)), env.expandItems('map_extra_casings', rng));
  };
  const rag = (center: P) => buf.addItem(idx(rng.pick(radius(center, 3))), { typeId: 'rag_bloody' });
  const trail = (from: P) => {
    const to = rng.pick(radius(from, rng.int(1, 4)));
    for (const p of lineTo(from, to)) addField(env, buf, p, 'fd_blood', 1);
  };
  const pile = (at: P, list: SpawnedItem[]) => {
    for (const p of radius(at, rng.int(1, 2))) if (rng.oneIn(2)) addItems(buf, p, list);
  };
  /** A wounded shooter at `at`: blood, then maybe a rag near it and a trail. */
  const wounded = (at: P) => {
    if (!rng.oneIn(2)) return;
    addField(env, buf, at, 'fd_blood', rng.int(1, 3));
    if (rng.oneIn(2)) rag(at);
    if (rng.oneIn(2)) trail(at);
  };
  const mid: P = [SEEX, SEEY];
  switch (rng.int(1, 4)) {
    case 1: {
      // Pile of random casings in a random place.
      const at = inner();
      pile(at, items);
      trash(mid);
      wounded(at);
      break;
    }
    case 2: {
      // The whole OMT littered with casings.
      for (let i = 0; i < SEEX * 2; i++) for (let j = 0; j < SEEY * 2; j++) if (rng.oneIn(20)) addItems(buf, [i, j], items);
      trash(mid);
      if (rng.oneIn(2)) {
        const at = rng.pick(radius(mid, rng.int(1, 10)));
        addField(env, buf, at, 'fd_blood', rng.int(1, 3));
        if (rng.oneIn(2)) rag(at);
      }
      break;
    }
    case 3: {
      // Someone moved and fired: casings, some bloodied, along the way.
      const from = inner(), to = inner();
      for (const p of lineTo(from, to)) {
        if (!rng.oneIn(2)) continue;
        addItems(buf, p, items);
        if (rng.oneIn(2)) addField(env, buf, p, 'fd_blood', rng.int(1, 3));
      }
      trash(mid);
      // BN's comment says "at the destination", but the blood goes where the line started and
      // the rag near where it ended; kept as BN does it.
      if (rng.oneIn(2)) {
        addField(env, buf, from, 'fd_blood', rng.int(1, 3));
        if (rng.oneIn(2)) rag(to);
      }
      break;
    }
    case 4: {
      // Two shooters, two piles (each its own casings roll); the first in the north-west quarter.
      const first = [rng.int(1, SEEX - 2), rng.int(1, SEEY - 2)] as const, second = inner();
      const firstItems = casings(), secondItems = casings();
      pile(first, firstItems);
      pile(second, secondItems);
      trash(mid);
      wounded(first);
      wounded(second);
      break;
    }
  }
  return true;
}

/** BN map_extra_function generators we port, by generator_id. */
export const MAP_EXTRA_FUNCTIONS: Record<string, (env: MapExtraEnv, buf: MapBuffer, rng: Rng) => boolean> = {
  mx_portal: mxPortal,
  mx_casings: mxCasings,
};

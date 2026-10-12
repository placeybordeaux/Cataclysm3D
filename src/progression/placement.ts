// Where a scenario starts. The world is built around the evac shelter (main.ts); scenarios
// that start elsewhere move the survivor once the start is chosen, before spawns are
// released. Only scenarios listed here can be unlocked (unlocks.ts validates against this),
// so the picker never offers a start the world can't honour.

import type { Game } from '../game/game';
import type { GameMap } from '../world/map';
import type { Overmap, OmtInfo } from '../world/overmap/overmap';
import { CHUNK } from '../world/coords';

export type Placement = 'shelter' | 'town' | 'wilderness' | 'lab_escape';

/** BN scenario id → how we place it (BN start_location lists, reduced to what we generate). */
export const SCENARIO_PLACEMENT: Record<string, Placement> = {
  evacuee: 'shelter',
  missed: 'town',
  wilderness: 'wilderness',
  // BN's lab challenges allow sloc_lab_random, sloc_lab_escape_cells, sloc_lab_finale and the
  // Ice Lab ones; we start them in sloc_lab_escape_cells (oter lab_escape_cells), which the
  // start region's classic lab always has (overmap.ts placeLabBasement, genVersion 2).
  lab_chal: 'lab_escape',
  lab_staff: 'lab_escape',
};

export interface PlacementHost {
  map: GameMap;
  overmap: Overmap;
}

export interface Spot {
  x: number;
  y: number;
  z: number;
  /** Player-facing place name ("a house in Bethlehem", "the woods"). */
  where: string;
}

const isHouse = (o: OmtInfo) => /^house/.test(o.type) && !/roof|basement|second/.test(o.type);
const isForest = (o: OmtInfo) => o.type === 'forest' || o.type === 'forest_thick';

/** OMTs in Chebyshev rings from `from`, radius min..max, first match. */
function ring(ov: Overmap, from: { x: number; y: number }, min: number, max: number, pred: (o: OmtInfo, x: number, y: number) => boolean): { x: number; y: number } | null {
  for (let r = min; r <= max; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = from.x + dx, y = from.y + dy;
        if (pred(ov.omtAt(x, y, 0), x, y)) return { x, y };
      }
  return null;
}

/** A free tile in an OMT: indoors (roofed) first when `indoors`, else in the open. */
function freeTile(map: GameMap, ox: number, oy: number, indoors: boolean): { x: number; y: number } | null {
  if (!map.chunk(ox, oy, 0)) return null;
  const roofed = (x: number, y: number) => map.hasFloor(x, y, 1);
  const cand: [number, number][] = [];
  for (let y = oy * CHUNK + 2; y < (oy + 1) * CHUNK - 2; y++)
    for (let x = ox * CHUNK + 2; x < (ox + 1) * CHUNK - 2; x++)
      if (map.passable(x, y, 0) && map.furnAt(x, y, 0).id === 'f_null' && roofed(x, y) === indoors) cand.push([x, y]);
  if (!cand.length) return null;
  const cx = ox * CHUNK + CHUNK / 2, cy = oy * CHUNK + CHUNK / 2;
  cand.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  return { x: cand[0][0], y: cand[0][1] };
}

/**
 * A free tile in one of the experiment cells of a lab_escape_cells OMT: the small rooms
 * (flood-filled over passable tiles, stopping at the OMT edge) with no monster placed in them,
 * nearest the room's middle. BN's start_location::place_player takes any inside tile of the
 * OMT; the cells are the point of the scenario, so we pick an empty one (in BN's mapgen the
 * one with the broken window, your way out).
 */
function cellTile(map: GameMap, ox: number, oy: number, z: number): { x: number; y: number } | null {
  const ch = map.chunk(ox, oy, z);
  if (!ch) return null;
  const x0 = ox * CHUNK, y0 = oy * CHUNK;
  const seen = new Uint8Array(CHUNK * CHUNK);
  const monsters = new Set(ch.spawns.filter((s) => s.z === z).map((s) => `${s.x},${s.y}`));
  for (let i = 0; i < CHUNK * CHUNK; i++) {
    if (seen[i] || !map.passable(x0 + (i % CHUNK), y0 + Math.floor(i / CHUNK), z)) continue;
    const room: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      room.push(k);
      const lx = k % CHUNK, ly = Math.floor(k / CHUNK);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = lx + dx, ny = ly + dy, n = ny * CHUNK + nx;
        if (nx < 0 || ny < 0 || nx >= CHUNK || ny >= CHUNK || seen[n] || !map.passable(x0 + nx, y0 + ny, z)) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    // a cell is 3x6 tiles; the corridor outside them is several times that
    if (room.length > 30 || room.some((k) => monsters.has(`${x0 + (k % CHUNK)},${y0 + Math.floor(k / CHUNK)}`))) continue;
    const free = room.filter((k) => map.furnAt(x0 + (k % CHUNK), y0 + Math.floor(k / CHUNK), z).id === 'f_null');
    if (!free.length) continue;
    const mx = room.reduce((a, k) => a + (k % CHUNK), 0) / room.length, my = room.reduce((a, k) => a + Math.floor(k / CHUNK), 0) / room.length;
    free.sort((a, b) => Math.hypot((a % CHUNK) - mx, Math.floor(a / CHUNK) - my) - Math.hypot((b % CHUNK) - mx, Math.floor(b / CHUNK) - my));
    return { x: x0 + (free[0] % CHUNK), y: y0 + Math.floor(free[0] / CHUNK) };
  }
  return null;
}

/**
 * Find the start for a placement near `origin` (the shelter, in OMT coords). Returns null
 * for 'shelter' (stay put). Throws when the world has nowhere fitting: the caller shows
 * that rather than silently starting somewhere else.
 */
/** What progression's fresh-start clearing may look at on a monster. */
export interface StartClearCandidate {
  x: number; y: number; z: number; dead: boolean; scripted?: boolean;
  attitude(): string;
}

/**
 * Hostiles to remove from around a fresh start: mapgen/spawner monsters within `radius` of
 * the survivor. Monsters a script or the debug API placed on purpose stay: the clearing runs
 * for a second after the start, and silently deleting a monster a test just spawned there made
 * "kill a zombie" checks fail with nothing to fight.
 */
export function startClearVictims<M extends StartClearCandidate>(all: readonly M[], p: { x: number; y: number; z: number }, radius: number): M[] {
  return all.filter((m) => !m.dead && !m.scripted && m.attitude() === 'attack' && m.z === p.z && Math.hypot(m.x - p.x, m.y - p.y) <= radius);
}

export function findStart(host: PlacementHost, placement: Placement, origin: { x: number; y: number }): Spot | null {
  const { map, overmap: ov } = host;
  if (placement === 'shelter') return null;
  if (placement === 'lab_escape') {
    const hit = ov.findUnderground('lab_escape_cells', origin, 1);
    if (!hit) throw new Error('no lab escape cells near the start (this world predates them: start a new world)');
    const t = cellTile(map, hit.x, hit.y, hit.z);
    if (!t) throw new Error(`the escape cells at ${hit.x},${hit.y},${hit.z} have no empty cell`);
    return { ...t, z: hit.z, where: 'a locked cell deep in a science lab' };
  }
  if (placement === 'town') {
    const city = ov.closestCity(origin.x, origin.y, 1);
    const from = city ? { x: city.x, y: city.y } : origin;
    // Several candidates: a house whose chunk has no free indoor tile (all furniture) is skipped.
    for (let tries = 0, min = 0; tries < 6; tries++) {
      const o = ring(ov, from, min, 30, (t) => isHouse(t));
      if (!o) break;
      const t = freeTile(map, o.x, o.y, true);
      if (t) return { ...t, z: 0, where: city ? `a house in ${city.name}` : 'a house in town' };
      min = Math.max(Math.abs(o.x - from.x), Math.abs(o.y - from.y)) + 1;
    }
    throw new Error('no house with a free floor tile near the start');
  }
  // Wilderness: deep in a forest (all eight neighbours forest too), away from the shelter.
  const deep = (_o: OmtInfo, x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!isForest(ov.omtAt(x + dx, y + dy, 0))) return false;
    return true;
  };
  for (const [min, pred] of [[6, deep], [4, (o: OmtInfo) => isForest(o)]] as const) {
    const o = ring(ov, origin, min, 40, pred);
    if (!o) continue;
    const t = freeTile(map, o.x, o.y, false);
    if (t) return { ...t, z: 0, where: 'the woods' };
  }
  throw new Error('no forest near the start');
}

/** Move the survivor to a spot (new game only; spawns are still held). */
export function moveSurvivor(game: Game, s: Spot): void {
  const p = game.player;
  p.x = s.x + 0.5;
  p.y = s.y + 0.5;
  p.z = s.z;
}

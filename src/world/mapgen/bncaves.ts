import type { Rng } from '../../core/rng';
import { otMatch } from '../overmap/oter';
import type { BuiltinEnv } from './bnbuiltin';
import { MapBuffer } from './buffer';
import type { MapgenDat } from './jsonmapgen';

// Ports of the BN generators for the caves its mutable specials dig (and mapgen_rock_partial,
// the "rock" filler around slime pits):
//  - mine / mine_down / mine_finale: C++ mapgen_constructor::draw_mine (src/mapgen/mapgen.cpp),
//    reached through draw_map's "mine" prefix branch (there is no JSON or Lua for them);
//  - slimepit / slimepit_down: data/json/lua/mapgen/slimepit.lua (luamethod "slimepit").
// Artifacts (spawn_artifact in the mine finale) are left out: we have no artifact generator.

const SEEX = 12, SEEY = 12, W = SEEX * 2, H = SEEY * 2;
const EAST_EDGE = W - 1, SOUTH_EDGE = H - 1;
const idx = MapBuffer.idx;

function square(buf: MapBuffer, ter: string, x1: number, y1: number, x2: number, y2: number): void {
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) if (x >= 0 && y >= 0 && x < W && y < H) buf.ter[idx(x, y)] = ter;
}

/** CDDA line(): Bresenham between two points (inclusive). */
function line(buf: MapBuffer, ter: string, x1: number, y1: number, x2: number, y2: number): void {
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1), sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
  let err = dx - dy, x = x1, y = y1;
  for (;;) {
    if (x >= 0 && y >= 0 && x < W && y < H) buf.ter[idx(x, y)] = ter;
    if (x === x2 && y === y2) break;
    const e2 = 2 * err;
    if (e2 > -dy) (err -= dy), (x += sx);
    if (e2 < dx) (err += dx), (y += sy);
  }
}

function itemsAt(env: BuiltinEnv, buf: MapBuffer, rng: Rng, group: string, chance: number, x: number, y: number): void {
  if (rng.int(1, 100) > chance) return;
  for (const e of env.expandItems(group, rng)) buf.addItem(idx(x, y), e.count === 1 ? { typeId: e.id, spawned: e } : { typeId: e.id, count: e.count, spawned: e });
}

function corpse(buf: MapBuffer, x: number, y: number): void {
  buf.addItem(idx(x, y), { typeId: 'corpse' } as never);
}

/** mapgen_constructor::draw_mine */
export function mapgenMine(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer): void {
  const rng = dat.rng;
  const type = dat.oter.type;
  const at = (dx: number, dy: number, dz = 0) => dat.omtAt(dx, dy, dz);
  const isMine = (dx: number, dy: number) => otMatch('mine', at(dx, dy), env.terrains, 'PREFIX');
  const ter = (x: number, y: number) => buf.ter[idx(x, y)];

  if (type === 'mine' || type === 'mine_down') {
    const fac = (dx: number, dy: number) => (isMine(dx, dy) ? (rng.oneIn(10) ? 0 : -2) : 4);
    const n = fac(0, -1), e = fac(1, 0), s = fac(0, 1), w = fac(-1, 0);
    for (let i = 0; i < W; i++)
      for (let j = 0; j < H; j++) {
        const ir = W - 1 - i, jr = H - 1 - j;
        const open = i >= w + rng.int(0, 2) && i <= EAST_EDGE - e - rng.int(0, 2) && j >= n + rng.int(0, 2) && j <= SOUTH_EDGE - s - rng.int(0, 2)
          && i + j >= 3 && ir + jr >= 3 && i + jr >= 3 && j + ir >= 3;
        buf.ter[idx(i, j)] = open ? 't_rock_floor' : 't_rock';
      }

    // Not an entrance; maybe some hazards!
    switch (rng.int(0, 4)) {
      case 1: {
        const x = rng.int(9, 14), y = rng.int(9, 14);
        buf.ter[idx(x, y)] = 't_rock';
        buf.addField(idx(x, y), 'fd_gas_vent', 2);
        break;
      }
      case 2: {
        const sx = rng.int(6, SEEX), sy = rng.int(6, SEEY);
        const ex = rng.int(SEEX + 1, W - 7), ey = rng.int(SEEY + 1, H - 7);
        const num = rng.int(2, 4);
        for (let k = 0; k < num; k++) line(buf, 't_lava', sx + rng.int(-1, 1), sy + rng.int(-1, 1), ex + rng.int(-1, 1), ey + rng.int(-1, 1));
        for (let y = sy; y <= ey; y++)
          for (let x = sx; x <= ex; x++) if (ter(x, y) === 't_rock_floor' && rng.oneIn(10)) buf.addItem(idx(x, y), { typeId: 'chunk_sulfur' });
        break;
      }
      case 3: {
        const wx = rng.int(9, 14), wy = rng.int(9, 14);
        for (let i = wx - 3; i < wx + 3; i++)
          for (let j = wy - 3; j < wy + 3; j++) if (!rng.oneIn(4)) buf.furn[idx(i, j)] = 'f_wreckage';
        break;
      }
      case 4: {
        const bodies = rng.int(4, 8);
        const floor: [number, number][] = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ter(x, y) === 't_rock_floor' && !buf.furn[idx(x, y)]) floor.push([x, y]);
        for (let k = 0; k < bodies && floor.length; k++) {
          const [x, y] = rng.pick(floor);
          corpse(buf, x, y);
          itemsAt(env, buf, rng, 'mon_zombie_miner_death_drops', 100, x, y);
        }
        break;
      }
    }

    // A clear 6x6 rock-floor patch in the middle, or one cleared by force after 10 tries.
    const centrePatch = (): [number, number] => {
      let tries = 0, px = 0, py = 0, okay = true;
      do {
        px = rng.int(SEEX - 6, SEEX + 1);
        py = rng.int(SEEY - 6, SEEY + 1);
        okay = true;
        for (let i = px; i <= px + 5 && okay; i++) for (let j = py; j <= py + 5 && okay; j++) if (ter(i, j) !== 't_rock_floor') okay = false;
        if (!okay) tries++;
      } while (!okay && tries < 10);
      if (tries === 10) square(buf, 't_rock_floor', px, py, px + 5, py + 5);
      return [px, py];
    };

    if (type === 'mine_down') {
      const open: number[] = [];
      if (n === 4) open.push(0);
      if (e === 4) open.push(1);
      if (s === 4) open.push(2);
      if (w === 4) open.push(3);
      if (!open.length) {
        const [px, py] = centrePatch();
        square(buf, 't_slope_down', px + 1, py + 1, px + 2, py + 2);
      } else {
        switch (rng.pick(open)) {
          case 0: square(buf, 't_rock_floor', SEEX - 3, 6, SEEX + 2, SEEY); line(buf, 't_slope_down', SEEX - 2, 6, SEEX + 1, 6); break;
          case 1: square(buf, 't_rock_floor', SEEX + 1, SEEY - 3, W - 7, SEEY + 2); line(buf, 't_slope_down', W - 7, SEEY - 2, W - 7, SEEY + 1); break;
          case 2: square(buf, 't_rock_floor', SEEX - 3, SEEY + 1, SEEX + 2, H - 7); line(buf, 't_slope_down', SEEX - 2, H - 7, SEEX + 1, H - 7); break;
          case 3: square(buf, 't_rock_floor', 6, SEEY - 3, SEEX, SEEY + 2); line(buf, 't_slope_down', 6, SEEY - 2, 6, SEEY + 1); break;
        }
      }
    }

    if (at(0, 0, 1).type === 'mine_down') {
      // BN tests n_fac == 6, which never happens (fac is 4, 0 or -2), so the slope up always
      // goes in the middle; kept as written.
      const [px, py] = centrePatch();
      square(buf, 't_slope_up', px + 1, py + 1, px + 2, py + 2);
    }
  } else if (type === 'mine_finale') {
    for (let i = 0; i < W; i++)
      for (let j = 0; j < H; j++)
        buf.ter[idx(i, j)] = i > rng.int(1, 3) && i < W - rng.int(2, 4) && j > rng.int(1, 3) && j < H - rng.int(2, 4) ? 't_rock_floor' : 't_rock';
    if (at(0, -1).type === 'mine') square(buf, 't_rock_floor', SEEX, 0, SEEX + 1, 3);
    if (at(1, 0).type === 'mine') square(buf, 't_rock_floor', W - 4, SEEY, EAST_EDGE, SEEY + 1);
    if (at(0, 1).type === 'mine') square(buf, 't_rock_floor', SEEX, H - 4, SEEX + 1, SOUTH_EDGE);
    if (at(-1, 0).type === 'mine') square(buf, 't_rock_floor', 0, SEEY, 3, SEEY + 1);
    // The Thing dog
    const bodies = rng.int(4, 8);
    for (let k = 0; k < bodies; k++) {
      const x = rng.int(4, W - 5), y = rng.int(4, W - 5);
      corpse(buf, x, y);
      itemsAt(env, buf, rng, 'mon_zombie_miner_death_drops', 60, x, y);
    }
    buf.spawns.push({ kind: 'group', id: 'GROUP_DOG_THING', x: SEEX, y: SEEX, x2: SEEX + 1, y2: SEEX + 1, density: 1 });
  } else return;

  // Patches of cave moss, some with mushrooms.
  for (let i = 0; i < W; i++)
    for (let j = 0; j < H; j++) {
      if (rng.oneIn(10) && ter(i, j) === 't_rock_floor') {
        buf.ter[idx(i, j)] = 't_moss_underground';
        if (rng.oneIn(15)) buf.furn[idx(i, j)] = 'f_cave_mushrooms';
      }
    }
}

/** mapgen_rock_partial: solid rock, crumbling into rock floor towards slime pit / cavern neighbours. */
export function mapgenRockPartial(dat: MapgenDat, buf: MapBuffer): void {
  const rng = dat.rng;
  buf.ter.fill('t_rock');
  const fac = (dx: number, dy: number) => (['cavern', 'slimepit', 'slimepit_down'].includes(dat.omtAt(dx, dy, 0).type) ? 6 : 0);
  const n = fac(0, -1), e = fac(1, 0), s = fac(0, 1), w = fac(-1, 0);
  for (let i = 0; i < W; i++)
    for (let j = 0; j < H; j++)
      if (rng.int(0, n) > j || rng.int(0, s) > H - 1 - j || rng.int(0, w) > i || rng.int(0, e) > W - 1 - i) buf.ter[idx(i, j)] = 't_rock_floor';
}

/** slimepit.lua slimepit.draw */
export function mapgenSlimepit(env: BuiltinEnv, dat: MapgenDat, buf: MapBuffer, groundcover: () => string): void {
  const rng = dat.rng;
  if (dat.z === 0) for (let i = 0; i < W * H; i++) buf.ter[i] = groundcover();
  else buf.ter.fill('t_rock_floor');
  // The Lua loops 0..24 inclusive; set_ter_at ignores the out-of-range column/row.
  for (let i = 0; i <= 24; i++)
    for (let j = 0; j <= 24; j++) if (rng.int(0, 4) === 1 && i < W && j < H) buf.ter[idx(i, j)] = 't_slime';
  if (dat.oter.type === 'slimepit_down') buf.ter[idx(rng.int(3, 20), rng.int(3, 20))] = 't_slope_down';
  else if (dat.omtAt(0, 0, 1).type === 'slimepit_down') {
    const r = rng.int(1, 4);
    const [x, y] = r === 1 ? [rng.int(0, 2), rng.int(0, 2)] : r === 2 ? [rng.int(0, 2), rng.int(21, 23)] : r === 3 ? [rng.int(21, 23), rng.int(0, 2)] : [rng.int(21, 23), rng.int(21, 23)];
    buf.ter[idx(x, y)] = 't_slope_up';
  }
  buf.spawns.push({ kind: 'group', id: 'GROUP_BLOB', x: 0, y: 0, x2: 23, y2: 23, density: 0.15 });
  // map:place_items("sewer", 40, whole OMT)
  if (rng.int(1, 100) <= 40) {
    const i = rng.int(0, W * H - 1);
    for (const e of env.expandItems('sewer', rng)) buf.addItem(i, e.count === 1 ? { typeId: e.id, spawned: e } : { typeId: e.id, count: e.count, spawned: e });
  }
}

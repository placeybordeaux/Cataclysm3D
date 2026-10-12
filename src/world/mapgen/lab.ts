import type { OterDef } from '../worldgen_data';
import { otMatch, type MatchType, type OmtRef } from '../overmap/oter';
import { MapBuffer, OMT } from './buffer';
import type { Levels, MapgenDat, MapgenRunner } from './jsonmapgen';

// Port of Cataclysm: Bright Nights' Lua lab generator (data/json/lua/mapgen/lab.lua, method
// "lua" / luamethod "lab" and "lab_ice" in data/json/mapgen/lab/lab.json). BN moved the old
// C++ draw_lab here: the surface lab_stairs is a concrete bunker with an ID-card door; below,
// every lab/lab_filler/lab_stairs/lab_core/lab_finale OMT runs one of the JSON floor plans
// (lab_4side, lab_1side, lab_4side_filler, lab_finale_1level and the _ice variants), then gets
// its outer walls (doors towards neighbouring lab OMTs), stairs linking the levels, ceiling
// lights and, one time in ten, flooding / gas / fungus.

const ROT = { type: 'TYPE', prefix: 'PREFIX', contains: 'CONTAINS' } as const;

export interface LabEnv {
  runner: MapgenRunner;
  terrains: Record<string, OterDef>;
}

/** `map.is_ot_match(name, oter, type)` from the Lua API. */
function match(env: LabEnv, name: string, r: OmtRef, how: MatchType): boolean {
  return otMatch(name, r, env.terrains, how);
}

/** lab.draw / lab.ice_draw (the ice variant only adds a map temperature, which we don't model;
 *  its rooms come from the *_ice floor plans picked by id). */
export function mapgenLab(env: LabEnv, dat: MapgenDat, levels: Levels): void {
  const buf = levels.get(0)!;
  const rng = dat.rng;
  const at = (dx: number, dy: number, dz = 0) => dat.omtAt(dx, dy, dz);
  const north = at(0, -1), east = at(1, 0), south = at(0, 1), west = at(-1, 0);
  const self = dat.oter;
  const idx = MapBuffer.idx;
  const flags = (id: string) => env.runner.env.terrainFlags(id) ?? [];
  const furnFlags = (id: string) => (id ? env.runner.env.furnitureFlags(id) ?? [] : []);

  if (dat.z === 0) {
    drawEntryRoom(env, dat, levels);
    return;
  }

  const sewer = { top: match(env, 'sewer', north, ROT.type), left: match(env, 'sewer', east, ROT.type), bottom: match(env, 'sewer', south, ROT.type), right: match(env, 'sewer', west, ROT.type) };
  if (sewer.top || sewer.left || sewer.bottom || sewer.right) {
    drawSewerRoom(buf, sewer);
    // Not BN: lab.lua's sewer room has no stairs, so a lab_stairs OMT beside a sewer strands
    // the levels below it. Its concrete floor takes them like any other room.
    addStairs();
  } else drawNormalRoom();

  // nearby_overmap_adjustments: slime pits and anthills eat into the lab.
  for (const fuzzy of ['slimepit', 'ants']) {
    if (![north, south, east, west].some((n) => match(env, fuzzy, n, ROT.contains))) continue;
    if (fuzzy === 'slimepit') drawSlimepit();
    else drawAnts();
  }
  if (rng.int(1, 10) === 1) {
    const r = rng.int(0, 4);
    if (r === 0) flood(true);
    else if (r === 1) flood(false);
    else if (r <= 3) gasLeak();
    else fungal();
  }

  function drawNormalRoom(): void {
    const walls = { top: 0, bottom: 0, left: 0, right: 0 };
    let borders = 4;
    if (match(env, 'lab', north, ROT.contains)) (walls.top = 2), borders--;
    if (match(env, 'lab', east, ROT.contains)) (walls.right = 2), borders--;
    if (match(env, 'lab', south, ROT.contains)) (walls.bottom = 2), borders--;
    if (match(env, 'lab', west, ROT.contains)) (walls.left = 2), borders--;
    const gen = (id: string) => {
      if (!env.runner.runOmt(id, { ...dat, rotation: 0, adjRotation: 0 }, levels)) env.runner.env.stats.unknownId('lab floor plan', id);
    };
    const rotateTowardsOpenSide = () => {
      if (walls.right === 2) buf.rotate(1);
      else if (walls.bottom === 2) buf.rotate(2);
      else if (walls.left === 2) buf.rotate(3);
    };
    const isIce = match(env, 'ice', self, ROT.contains);
    if (match(env, 'finale', self, ROT.contains)) gen(isIce ? 'lab_finale_1level_ice' : 'lab_finale_1level');
    else if (borders === 3) {
      gen(isIce && rng.int(1, 4) === 1 ? 'lab_1side_ice' : 'lab_1side');
      rotateTowardsOpenSide();
    } else if (match(env, 'filler', self, ROT.contains)) gen('lab_4side_filler');
    else gen('lab_4side');
    drawWalls(walls);
    addStairs();
    drawLights();
  }

  function addStairs(): void {
    if (match(env, 'stairs', at(0, 0, 1), ROT.contains)) insertStairs('t_stairs_up');
    else if (match(env, 'stairs', self, ROT.contains)) insertStairs('t_stairs_down');
  }

  function drawWalls(walls: { top: number; bottom: number; left: number; right: number }): void {
    const exterior = match(env, 'tower_lab', self, ROT.prefix) ? 't_reinforced_glass' : 't_concrete_wall';
    const interior = 't_concrete_wall';
    const clear = (i: number) => {
      buf.furn[i] = '';
      buf.items.delete(i);
    };
    for (let i = 0; i < OMT; i++) {
      if (walls.top === 0) (buf.ter[idx(i, 0)] = exterior), clear(idx(i, 0));
      if (walls.left === 0) (buf.ter[idx(0, i)] = exterior), clear(idx(0, i));
      // South and east edges are always walls: a doorway in the middle towards another lab OMT.
      buf.ter[idx(i, 23)] = walls.bottom === 2 ? (i === 11 || i === 12 ? 't_door_metal_c' : interior) : exterior;
      clear(idx(i, 23));
      buf.ter[idx(23, i)] = walls.right === 2 ? (i === 11 || i === 12 ? 't_door_metal_c' : interior) : exterior;
      clear(idx(23, i));
    }
  }

  function insertStairs(id: string): void {
    const pts: number[] = [];
    for (let i = 0; i < OMT * OMT; i++) if (buf.ter[i] === 't_thconc_floor' && !buf.furn[i] && !buf.traps.has(i)) pts.push(i);
    if (pts.length) buf.ter[rng.pick(pts)] = id;
  }

  function drawLights(): void {
    const chance = match(env, 'central_lab', self, ROT.prefix) ? 1 : Math.floor(Math.pow(rng.int(1, 12), 1.6));
    if (chance <= 0) return;
    for (let i = 0; i < OMT; i++)
      for (let j = 0; j < OMT; j++) {
        // Lua precedence: `i + j % 4 == 0` is i + (j % 4) == 0.
        if (!((i * j) % 2 === 0 || i + (j % 4) === 0) && rng.int(0, chance) === 1) {
          const k = idx(i, j);
          if (buf.ter[k] === 't_thconc_floor' || buf.ter[k] === 't_strconc_floor') buf.ter[k] = 't_thconc_floor_olight';
          else if (buf.ter[k] === 't_floor') buf.ter[k] = 't_floor_olight';
        }
      }
  }

  function drawSlimepit(): void {
    const top = match(env, 'slimepit', north, ROT.type) ? 12 : 0;
    const right = match(env, 'slimepit', west, ROT.type) ? 12 : 24;
    const left = match(env, 'slimepit', east, ROT.type) ? 12 : 0;
    const bottom = match(env, 'slimepit', south, ROT.type) ? 12 : 24;
    for (let i = 0; i < OMT; i++)
      for (let j = 0; j < OMT; j++) {
        if (!(j < top || j > bottom || i > right || i < left)) continue;
        const k = idx(i, j);
        if (rng.int(1, 5) === 1) (buf.ter[k] = 't_slime'), (buf.furn[k] = 'f_rubble_rock');
        else if (rng.int(1, 5) !== 1) buf.ter[k] = 't_slime';
      }
  }

  function drawAnts(): void {
    for (let i = 0; i < OMT; i++)
      for (let j = 0; j < OMT; j++) {
        if (!(i + j > 10 && i + j < 36 && Math.abs(i - j) < 13)) continue;
        const k = idx(i, j), tf = flags(buf.ter[k]);
        if (tf.includes('DOOR') || tf.includes('WALL')) {
          if (i === 0 || j === 0 || i === 23 || j === 24 || rng.int(1, 4) === 1 || (rng.int(1, 3) !== 3 && (i === 11 || i === 12 || j === 11 || j === 12))) {
            buf.ter[k] = 't_rock_floor';
            buf.furn[k] = 'f_rubble_rock';
          }
        } else if (rng.int(1, 20) === 1 && !tf.includes('GOES_DOWN') && !tf.includes('GOES_UP')) {
          buf.furn[k] = '';
          buf.ter[k] = 't_rock_floor';
        }
      }
  }

  function flood(full: boolean): void {
    if (match(env, 'stairs', self, ROT.contains) || match(env, 'ice', self, ROT.contains)) return;
    const fluid = rng.int(1, 3) === 1 ? 't_sewage' : 't_water_sh';
    for (let i = 0; i < OMT * OMT; i++) {
      const t = buf.ter[i];
      const wet = full ? rng.int(1, 10) !== 1 : rng.int(1, 5) === 1;
      if (wet) {
        if (t === 't_thconc_floor' || t === 't_strconc_floor' || t === 't_thconc_floor_olight') buf.ter[i] = fluid;
      } else if (flags(t).includes('DOOR') && (full ? rng.int(1, 3) !== 1 : rng.int(1, 3) === 1)) {
        buf.ter[i] = fluid;
        buf.furn[i] = 'f_rubble';
      }
    }
  }

  function gasLeak(): void {
    // lab.lua assigns the gas vent to the wrong variable, so it is always a smoke vent.
    for (let i = 0; i < OMT * OMT; i++) {
      if (rng.int(1, 200) === 1 && (buf.ter[i] === 't_thconc_floor' || buf.ter[i] === 't_strconc_floor')) buf.addField(i, 'fd_smoke_vent', 1);
    }
  }

  function fungal(): void {
    for (let i = 0; i < OMT * OMT; i++) {
      if (rng.int(1, 5) === 1) continue;
      const tf = flags(buf.ter[i]);
      const flat = tf.includes('FLAT') || furnFlags(buf.furn[i]).includes('FLAT');
      if (flat) {
        buf.ter[i] = 't_fungus_floor_in';
        if (furnFlags(buf.furn[i]).includes('ORGANIC')) buf.furn[i] = 'f_fungal_clump';
      } else if (tf.includes('DOOR')) buf.ter[i] = 't_fungus_floor_in';
      else if (tf.includes('WALL')) buf.ter[i] = 't_fungus_wall';
    }
  }
}

/** draw_sewer_room: a lab OMT next to a sewer becomes a sewage channel behind bars. */
function drawSewerRoom(buf: MapBuffer, w: { top: boolean; bottom: boolean; left: boolean; right: boolean }): void {
  const see = 12;
  for (let i = 0; i < OMT; i++)
    for (let j = 0; j < OMT; j++) {
      const k = MapBuffer.idx(i, j);
      buf.ter[k] = 't_thconc_floor';
      if (((w.left || w.right) && j > see - 3 && j < see + 2) || ((w.top || w.bottom) && i > see - 3 && i < see + 2)) buf.ter[k] = 't_sewage';
      // lab.lua tests j == 24 (off the map) for the south edge; we wall j == 23 like the east edge.
      if (i === 0 || i === 23 || j === 0 || j === 23) {
        const along = i === 0 || i === 23 ? j : i;
        buf.ter[k] = buf.ter[k] === 't_sewage' ? 't_bars' : along === see - 1 || along === see ? 't_door_metal_c' : 't_concrete_wall';
      }
    }
}

function drawEntryRoom(env: LabEnv, dat: MapgenDat, levels: Levels): void {
  const buf = levels.get(0)!;
  const idx = MapBuffer.idx;
  for (let i = 0; i < OMT; i++)
    for (let j = 0; j < OMT; j++) {
      const wall = i <= 1 || i >= 22 || j <= 1 || j >= 22 || (j > 1 && j < 22 && (i === 10 || i === 13));
      buf.ter[idx(i, j)] = wall ? 't_concrete_wall' : 't_thconc_floor';
    }
  buf.ter[idx(11, 0)] = buf.ter[idx(12, 0)] = 't_door_metal_locked';
  buf.ter[idx(11, 1)] = buf.ter[idx(12, 1)] = 't_thconc_floor';
  buf.ter[idx(10, 0)] = 't_card_science';
  buf.ter[idx(10, 12)] = buf.ter[idx(13, 12)] = buf.ter[idx(10, 11)] = buf.ter[idx(13, 11)] = 't_door_metal_c';
  buf.ter[idx(11, 21)] = buf.ter[idx(12, 21)] = 't_stairs_down';
  buf.spawns.push({ kind: 'group', id: 'GROUP_TURRET', x: 12, y: 5, count: 1 });
  for (const [x, y] of [[2, 2], [2, 14], [14, 2], [14, 14]]) env.runner.runNested('lab_room_7x7', x, y, dat, levels);
  // Face the card-reader door towards the road.
  const road = (dx: number, dy: number) => match(env, 'road', dat.omtAt(dx, dy, 0), ROT.type);
  if (road(1, 0)) buf.rotate(1);
  else if (road(0, 1)) buf.rotate(2);
  else if (road(-1, 0)) buf.rotate(3);
}

// Grabbing and dragging furniture and vehicles: BN's `G` grab (handle_action.cpp grab(),
// game::grabbed_move, grabbed_furn_move in game.cpp, grabbed_veh_move in grab.cpp,
// map::move_furn). Pure rules on the tile grid; the real-time stepping, animation, keys and
// HUD live in src/grab.ts, the sliding furniture model in src/render/grabView.ts.
//
// BN keeps `grab_point`: the grabbed tile relative to the player. Walking in its direction
// pushes, walking directly away pulls, any other direction nudges the furniture sideways while
// you stay put (a vehicle instead lets you walk around it). Everything costs BN moves; the
// caller turns moves into real seconds.

import { Rng, hashSeed } from '../core/rng';
import { hasFlag } from '../world/registry';
import type { Game } from './game';
import { L, destroyWhere, itemsAt, moveItem, transaction } from './moves';
import type { Item } from './item';
import { emitSound } from './sound';
import { trapAt } from './traps';
import { PLAYER_BASE_STAMINA_BURN_RATE } from './character';
import { findField, addField, removeField } from './fields';
import type { Vehicle } from './vehicle';

export type GrabKind = 'furniture' | 'vehicle';

export interface GrabState {
  kind: GrabKind;
  /** BN grab_point: the grabbed tile minus the player's tile (x, y; same z). */
  dx: number;
  dy: number;
}

/** What one attempted step did. */
export interface GrabStep {
  /**
   * BN grabbed_move's return: true = the grab used up the turn and the player stays where they
   * are (collided, strained, nudged sideways); false = the player now walks one tile by dp.
   */
  handled: boolean;
  /** BN moves the drag itself cost, on top of the player's own walking. */
  moves: number;
  /** Furniture that moved (for the slide animation). */
  furniture?: { id: string; from: [number, number, number]; to: [number, number, number] };
  /** Vehicle that moved, and its pose before/after (for the roll animation). */
  vehicle?: { v: Vehicle; from: [number, number, number]; to: [number, number, number] };
  /** The grab ended during this step. */
  released?: boolean;
  /** Half the walking stamina (BN: a vehicle on wheels carries its own weight). */
  wheeled?: boolean;
}

export interface FurnitureEffort {
  strReq: number;
  adjustedStr: number;
  /** BN moves spent on the drag (str_req × 10). */
  moveCost: number;
  staminaCost: number;
}

/** BN multiply_ratio_round_up. */
function ratioUp(value: number, num: number, den: number): number {
  const d = Math.max(1, den);
  return Math.floor((value * num + d - 1) / d);
}

// Per-game rng and state, kept off Game so this stays an additive feature.
const states = new WeakMap<Game, { grab: GrabState | null; rng: Rng }>();
function st(game: Game): { grab: GrabState | null; rng: Rng } {
  let s = states.get(game);
  if (!s) states.set(game, (s = { grab: null, rng: new Rng(hashSeed(game.seed, 0x67a8b)) }));
  return s;
}

export function grabState(game: Game): GrabState | null {
  return st(game).grab;
}
/** Replace the rng (tests make the strain / heavy rolls deterministic). */
export function setGrabRng(game: Game, rng: Rng): void {
  st(game).rng = rng;
}
/** Restore a saved grab (validated by the caller). */
export function setGrabState(game: Game, g: GrabState | null): void {
  st(game).grab = g ? { kind: g.kind, dx: g.dx, dy: g.dy } : null;
}

/** BN furn_t::is_movable (move_str_req >= 0). BN requires required_str on every furniture. */
export function furnitureStrReq(def: { id: string; required_str?: number }): number {
  return def.required_str ?? -1;
}

/** Grabbed tile in world coordinates. */
export function grabbedTile(game: Game): [number, number, number] | null {
  const g = grabState(game);
  if (!g) return null;
  const p = game.player;
  return [p.tileX + g.dx, p.tileY + g.dy, p.z];
}

/** Name of what you're holding ("dresser", "Shopping Cart"), or null. */
export function grabbedName(game: Game): string | null {
  const t = grabbedTile(game);
  const g = grabState(game);
  if (!t || !g) return null;
  if (g.kind === 'vehicle') return game.vehicles?.at(t[0], t[1], t[2])?.v.name ?? null;
  const f = game.map.furnAt(t[0], t[1], t[2]);
  return f.id === 'f_null' ? null : f.name;
}

/** Can the player grab what's at (x, y, z)? The target and why not, without grabbing. */
export function grabTarget(game: Game, x: number, y: number, z: number): { kind: GrabKind; name: string } | { reason: string } {
  const p = game.player;
  const dx = x - p.tileX, dy = y - p.tileY;
  if (z !== p.z || Math.max(Math.abs(dx), Math.abs(dy)) > 1) return { reason: 'That is out of reach: step next to it.' };
  if (dx === 0 && dy === 0) return { reason: 'You get a hold of yourself.' };
  const veh = game.vehicles?.at(x, y, z);
  if (veh) return { kind: 'vehicle', name: veh.v.name };
  const f = game.map.furnAt(x, y, z);
  if (f.id === 'f_null') return { reason: "There's nothing to grab there!" };
  if (furnitureStrReq(f) < 0) return { reason: `You can not grab the ${f.name}` };
  return { kind: 'furniture', name: f.name };
}

/** BN grab(): take hold of the vehicle or furniture at (x, y, z). Returns the message. */
export function grab(game: Game, x: number, y: number, z: number): { ok: boolean; msg: string } {
  const t = grabTarget(game, x, y, z);
  if ('reason' in t) return { ok: false, msg: t.reason };
  const p = game.player;
  st(game).grab = { kind: t.kind, dx: x - p.tileX, dy: y - p.tileY };
  if (t.kind === 'furniture') {
    const f = game.map.furnAt(x, y, z);
    // BN map::can_move_furniture: str_cur against move_str_req (contents not counted here)
    if (p.str < furnitureStrReq(f)) return { ok: true, msg: `You grab the ${f.name}. It feels really heavy.` };
  }
  return { ok: true, msg: `You grab the ${t.name}.` };
}

/** BN: grab key while holding something, or anything that ends the grab. */
export function release(game: Game): string | null {
  const name = grabbedName(game);
  st(game).grab = null;
  return name ? `You release the ${name}.` : null;
}

/** BN furniture_contents_strength_req: 1 strength per 4 kg of items on the tile. */
function contentsStrReq(game: Game, x: number, y: number, z: number): number {
  let g = 0;
  for (const it of game.map.itemsAt(x, y, z) as Item[]) g += it.weight();
  return Math.floor(g / 4000);
}

/** BN furniture_move_effort_for (flat moves; ramps aren't modelled here). */
export function furnitureEffort(game: Game, x: number, y: number, z: number): FurnitureEffort {
  const f = game.map.furnAt(x, y, z);
  const strReq = Math.max(0, furnitureStrReq(f) + contentsStrReq(game, x, y, z));
  const adjustedStr = game.player.str;
  // PLAYER_BASE_STAMINA_BURN_RATE × 7 scaled so a dresser (str 8) is the anchor
  let staminaCost = ratioUp(PLAYER_BASE_STAMINA_BURN_RATE * 7, strReq, 8);
  staminaCost = ratioUp(staminaCost, Math.max(1, strReq), Math.max(Math.max(1, strReq), adjustedStr));
  return { strReq, adjustedStr, moveCost: strReq * 10, staminaCost };
}

const isContainerFurn = (flags: string[]) => ['CONTAINER', 'FIRE_CONTAINER', 'SEALED'].some((f) => flags.includes(f));

/** BN game::is_empty: walkable (or liquid) and nobody there. */
function isEmpty(game: Game, x: number, y: number, z: number): boolean {
  const walk = game.map.passable(x, y, z) || hasFlag(game.map.terAt(x, y, z), 'LIQUID');
  return walk && !game.creatureAt(x, y, z);
}

/**
 * BN map::move_furn: the furniture, its contents (container furniture only: other furniture
 * leaves them behind, "Stuff spills"), a small fire (not when pulled). Liquids at the
 * destination are wiped. Every item goes through moves.ts.
 */
export function moveFurniture(game: Game, from: [number, number, number], to: [number, number, number], pulling: boolean): boolean {
  const map = game.map;
  const [fx, fy, fz] = from, [tx, ty, tz] = to;
  const f = map.furnAt(fx, fy, fz);
  if (f.id === 'f_null' || map.furnAt(tx, ty, tz).id !== 'f_null') return false;
  const srcLoc = L.ground(map, fx, fy, fz), dstLoc = L.ground(map, tx, ty, tz);
  const dst = itemsAt(dstLoc);
  const onlyLiquid = dst.every((it) => it.isLiquid());
  const dstT = map.terAt(tx, ty, tz);
  const dstItemOk = !['NOITEM', 'SWIMMABLE', 'DESTROY_ITEM'].some((fl) => hasFlag(dstT, fl));
  const srcItemOk = isContainerFurn(f.flags);
  const fire = findField(game, fx, fy, fz, 'fd_fire');
  map.setFurn(tx, ty, tz, f.id);
  map.setFurn(fx, fy, fz, 'f_null');
  if (fire && fire.intensity === 1 && !pulling) {
    removeField(game, fx, fy, fz, 'fd_fire');
    addField(game, tx, ty, tz, 'fd_fire', 1, fire.age);
  }
  if (dst.length && onlyLiquid) destroyWhere(dstLoc, () => true);
  const src = [...itemsAt(srcLoc)];
  if (src.length) {
    if (dstItemOk && srcItemOk) {
      // BN swaps the two stacks (the destination can only hold items here when the furniture
      // is a container: other furniture refuses a cluttered tile).
      const back = [...itemsAt(dstLoc)];
      transaction(() => {
        for (const it of src) {
          const r = moveItem(it, srcLoc, dstLoc, { force: true, quiet: true });
          if (!r.ok) throw new Error(`grab: moving ${it.typeId} with the ${f.name} failed: ${r.msg}`);
        }
        for (const it of back) {
          const r = moveItem(it, dstLoc, srcLoc, { force: true, quiet: true });
          if (!r.ok) throw new Error(`grab: moving ${it.typeId} out of the ${f.name}'s way failed: ${r.msg}`);
        }
      });
    } else game.message(`Stuff spills from the ${f.name}!`);
  }
  return true;
}

/**
 * BN game::grabbed_move for a step `dp` (one tile, 8 directions). Rolls BN's strain and
 * heavy-furniture dice. Moves the furniture / vehicle when it goes; the caller moves the player
 * when `handled` is false.
 */
export function grabbedMove(game: Game, dpx: number, dpy: number): GrabStep {
  const g = grabState(game);
  if (!g) return { handled: false, moves: 0 };
  return g.kind === 'vehicle' ? grabbedVehMove(game, dpx, dpy) : grabbedFurnMove(game, dpx, dpy);
}

function grabbedFurnMove(game: Game, dpx: number, dpy: number): GrabStep {
  const s = st(game);
  const g = s.grab!;
  const map = game.map;
  const p = game.player;
  const px = p.tileX, py = p.tileY, z = p.z;
  const fpos: [number, number, number] = [px + g.dx, py + g.dy, z];
  const say = (t: string, c?: string) => game.message(t, c);
  if (map.furnAt(...fpos).id === 'f_null') {
    say('No furniture at grabbed point.', 'c_light_gray');
    s.grab = null;
    return { handled: false, moves: 0, released: true };
  }
  const f = map.furnAt(...fpos);
  const pushing = dpx === g.dx && dpy === g.dy;
  const pulling = dpx === -g.dx && dpy === -g.dy;
  const shifting = !pushing && !pulling;
  const fdest: [number, number, number] = [fpos[0] + dpx, fpos[1] + dpy, z];
  const hasFloor = map.hasFloor(...fdest);
  const dstTer = map.terAt(...fdest);
  const canmove = map.passable(...fdest)
    && !game.creatureAt(...fdest)
    && (!pulling || isEmpty(game, px + dpx, py + dpy, z))
    && (!hasFloor || hasFlag(dstTer, 'FLAT'))
    && map.furnAt(...fdest).id === 'f_null'
    && !game.vehicles?.at(...fdest)
    && (!hasFloor || !trapAt(game, ...fdest));
  if (furnitureStrReq(f) < 0) {
    say(`You can't move the ${f.name}.`);
    s.grab = null;
    return { handled: false, moves: 0, released: true };
  }
  const dst = map.itemsAt(...fdest) as Item[];
  const onlyLiquid = dst.every((it) => it.isLiquid());
  const srcItemOk = isContainerFurn(f.flags);
  const effort = furnitureEffort(game, ...fpos);
  const rng = s.rng;
  if (!canmove) {
    say(`The ${f.name} collides with something.`);
    return { handled: true, moves: 50 };
  } else if (effort.strReq > effort.adjustedStr && rng.oneIn(Math.max(20 - effort.strReq - effort.adjustedStr, 2))) {
    say(`You strain yourself trying to move the heavy ${f.name}!`, 'c_light_red');
    p.modPain(1);
    return { handled: true, moves: 100 };
  } else if (!srcItemOk && !onlyLiquid && dst.length > 0) {
    say("There's stuff in the way.");
    return { handled: true, moves: 50 };
  }
  let moves = effort.moveCost;
  p.modStamina(-effort.staminaCost, false);
  if (effort.strReq > effort.adjustedStr) {
    const penalty = Math.trunc(effort.strReq ** 2 + 100);
    if (penalty <= 1000) {
      if (effort.adjustedStr >= effort.strReq - 3) {
        moves += Math.max(3000, penalty * 10);
        say(`The ${f.name} is really heavy!`, 'c_light_red');
        if (rng.oneIn(3)) {
          say(`You fail to move the ${f.name}.`, 'c_light_red');
          return { handled: true, moves };
        }
      } else {
        say(`The ${f.name} is too heavy for you to budge.`, 'c_light_red');
        return { handled: true, moves: moves + 100 };
      }
    }
    moves += penalty;
    if (penalty > 500) say(`Moving the heavy ${f.name} is taking a lot of time!`);
    else if (penalty > 200 && rng.oneIn(3)) say(`It takes some time to move the heavy ${f.name}.`);
  }
  emitSound(game, { x: fdest[0], y: fdest[1], z }, Math.min(80, 40 + furnitureStrReq(f) * 2), 'a scraping noise.', { category: 'movement', source: p, sfxId: 'misc', sfxVariant: 'scraping' });
  if (!moveFurniture(game, fpos, fdest, pulling)) return { handled: true, moves };
  const moved = { id: f.id, from: fpos, to: fdest };
  if (shifting) {
    // nudged sideways: you stay, it's now somewhere else next to you (or out of reach)
    const ddx = fdest[0] - px, ddy = fdest[1] - py;
    if (Math.abs(ddx) < 2 && Math.abs(ddy) < 2) {
      g.dx = ddx;
      g.dy = ddy;
      return { handled: true, moves, furniture: moved };
    }
    say(`You let go of the ${f.name}.`);
    s.grab = null;
    return { handled: true, moves, furniture: moved, released: true };
  }
  g.dx = fdest[0] - (px + dpx);
  g.dy = fdest[1] - (py + dpy);
  if (pushing && !map.passable(...fpos)) {
    // BN: "Not sure how that chair got into a wall, but don't let player follow."
    say(`You let go of the ${f.name} as it slides past ${map.terAt(...fdest).name}.`);
    s.grab = null;
    return { handled: true, moves, furniture: moved, released: true };
  }
  return { handled: false, moves, furniture: moved };
}

/** Vehicle heading (degrees, 0 east, clockwise) of a step direction: BN tileray::init(dp). */
function headingOf(dx: number, dy: number): number {
  return ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
}

/**
 * BN grab.cpp get_vehicle_str_requirement / offroad_str_req_cap. Wheel cost from the terrain
 * under each wheel (map move cost, 2 = flat). Traction: BN scales by k_traction of the wheels'
 * terrain; here 1 on FLAT ground, 0.5 elsewhere (grass, dirt roads are FLAT in BN data).
 */
export function vehicleStrReq(game: Game, v: Vehicle): number {
  const massKg = v.mass();
  const base = Math.floor(massKg / 100);
  const cap = Math.floor(massKg / 10);
  let need: number;
  if (!v.validWheelConfig()) need = base * 10;
  else {
    const wheels = v.wheels;
    let all = 0, flat = 0;
    for (const w of wheels) {
      const [wx, wy] = v.mountToWorld(w.mx, w.my);
      const tx = Math.floor(wx), ty = Math.floor(wy);
      const mapcost = game.map.terAt(tx, ty, v.z).move_cost;
      all += Math.floor(base / wheels.length) * mapcost;
      if (hasFlag(game.map.terAt(tx, ty, v.z), 'FLAT')) flat++;
    }
    // one wheel (a shopping cart's caster) or more than four: counts as four
    const eff = wheels.length > 4 || wheels.length <= 1 ? 4 : wheels.length;
    const traction = flat === wheels.length ? 1 : 0.5;
    need = Math.floor((1 + Math.floor(all / eff)) / traction);
  }
  return Math.min(need, cap);
}

function grabbedVehMove(game: Game, dpx: number, dpy: number): GrabStep {
  const s = st(game);
  const g = s.grab!;
  const p = game.player;
  const vs = game.vehicles;
  const px = p.tileX, py = p.tileY, z = p.z;
  const occ = vs?.at(px + g.dx, py + g.dy, z);
  if (!vs || !occ) {
    game.message('No vehicle at grabbed point.', 'c_light_gray');
    s.grab = null;
    return { handled: false, moves: 0, released: true };
  }
  const v = occ.v;
  const grabbedMount: [number, number] = [occ.mx, occ.my];
  if (vs.at(px, py, z)?.v === v) {
    // standing on it: BN turns the grab around and lets you walk
    if (!isEmpty(game, px + dpx, py + dpy, z)) return { handled: true, moves: 0 };
    g.dx = -dpx;
    g.dy = -dpy;
    return { handled: false, moves: 0 };
  }
  const nextX = px + dpx, nextY = py + dpy;
  let vdx = -g.dx, vdy = -g.dy;
  const prevGrab = { dx: g.dx, dy: g.dy };
  let nextGrab = { dx: g.dx, dy: g.dy };
  let zigzag = false;
  if (dpx === g.dx && dpy === g.dy) {
    vdx = dpx; vdy = dpy; // pushing
  } else if (Math.abs(dpx + vdx) !== 2 && Math.abs(dpy + vdy) !== 2) {
    // walking around it: nothing moves but you (and only if you can take the step: BN would
    // shift the grab point even when the walk then fails)
    if (!isEmpty(game, nextX, nextY, z)) return { handled: true, moves: 0 };
    g.dx = prevGrab.dx - dpx;
    g.dy = prevGrab.dy - dpy;
    return { handled: false, moves: 0 };
  } else if ((dpx === prevGrab.dx || dpy === prevGrab.dy) && nextGrab.dx !== 0 && nextGrab.dy !== 0) {
    // zig-zag pull: diagonal to it and moving away, but not straight away
    vdx = dpx === -vdx ? 0 : vdx;
    vdy = dpy === -vdy ? 0 : vdy;
    nextGrab = { dx: -vdx, dy: -vdy };
    zigzag = true;
  } else nextGrab = { dx: -dpx, dy: -dpy }; // pulling
  // You have to be able to step where you're going before you haul it after you.
  if (!isEmpty(game, nextX, nextY, z)) {
    game.message(`There's no room to pull the ${v.name}.`);
    return { handled: true, moves: 50 };
  }
  const strReq = vehicleStrReq(game, v);
  const str = p.str;
  let moves = 0;
  if (strReq <= str) {
    if (!v.validWheelConfig())
      emitSound(game, { x: v.x, y: v.y, z }, Math.min(80, strReq * 2), 'a scraping noise.', { category: 'movement', source: p, sfxId: 'misc', sfxVariant: 'scraping' });
    moves += Math.trunc((400 * strReq) / Math.max(1, str));
    p.modStamina(-Math.trunc((200 * strReq) / Math.max(1, str)));
    const ex = s.rng.dice(1, 6) - 1 + strReq;
    if (ex > str + 1) {
      game.message(`You strain yourself to move the ${v.name}!`, 'c_light_red');
      moves += 200;
      p.modPain(1);
    } else if (ex >= str) {
      game.message(`It takes some time to move the ${v.name}.`);
      moves += 200;
    }
  } else {
    game.message(`You lack the strength to move the ${v.name}`, 'c_light_red');
    return { handled: true, moves: 100 };
  }
  // BN get_move_dir: face the way it goes, then shift it so the grabbed part stays next to you.
  const poseFor = (dx: number, dy: number, from: { dx: number; dy: number }): [number, number, number] | string => {
    const nf = headingOf(dx, dy);
    // the grabbed part lands on the centre of the tile next to where you'll stand
    const [rx, ry] = v.mountToWorld(grabbedMount[0], grabbedMount[1], nf, 0, 0);
    const nx = nextX + from.dx + 0.5 - rx, ny = nextY + from.dy + 0.5 - ry;
    const why = vs.dragBlocker(v, nx, ny, nf);
    return why ?? [nx, ny, nf];
  };
  let pose = poseFor(vdx, vdy, nextGrab);
  if (typeof pose === 'string' && zigzag) {
    const alt = poseFor(-prevGrab.dx, -prevGrab.dy, { dx: -dpx, dy: -dpy });
    if (typeof alt !== 'string') {
      pose = alt;
      nextGrab = { dx: -dpx, dy: -dpy };
    }
  }
  if (typeof pose === 'string') {
    game.message(`The ${v.name} collides with ${pose}.`);
    return { handled: true, moves };
  }
  const from: [number, number, number] = [v.x, v.y, v.facing];
  v.x = pose[0];
  v.y = pose[1];
  v.facing = pose[2];
  v.velocity = 0;
  vs.reindex(v);
  const [wx, wy] = v.mountToWorld(grabbedMount[0], grabbedMount[1]);
  g.dx = Math.floor(wx) - nextX;
  g.dy = Math.floor(wy) - nextY;
  return { handled: false, moves, vehicle: { v, from, to: pose }, wheeled: v.wheels.length > 0 };
}

import { Item, type ItemJSON } from './item';
import { bodyLocs, consumeItem, L, locate, spawnItem, spawnOnGround } from './moves';
import { has, type Vehicle, type VehiclePart } from './vehicle';
import { motionOf } from './vehicleImpact';
import type { BodyRect } from './vehicleShape';
import type { VehicleSystem } from './vehicles';

// Towing with BN's heavy duty tow cable (docs/VEHICLES.md "Towing").
//
// BN (src/iuse.cpp tow_attach, src/vehicle/vehicle.cpp do_towing_move / no_towing_slack /
// tow_cable_too_far / set_tow_directions / invalidate_towing, src/map/map.cpp vehicle move):
// use the cable on a vehicle (the one that will tow), carry the loose end (6 tiles of cable)
// to a second vehicle (the one towed); both get an `hd_tow_cable` part and the item goes into
// them. The cable is slack until the two parts are 8 tiles apart, then BN drives the towed
// vehicle after the tower each turn (same speed, 1.8x past 12 tiles, steered toward the tower
// or dragged sideways skidding when the cable is on its middle third). It snaps at 25 tiles,
// across z-levels, or when the cable part is destroyed. The tower accelerates as if it weighed
// both, and can't thrust when that acceleration drops under 89 vmiph/turn ("struggles to pull").
//
// Here the cable is a rope constraint in the real-time momentum physics (vehicleImpact.ts):
// slack below the taut length, and once taut each frame an impulse along the cable stops the
// hooks separating (equal and opposite, so a heavy load slows the tower and a tank drags a
// car). The towed vehicle rolls free (BN: no parking brake when towed) and its far axle grips
// sideways, so it trails behind and swings through turns like a trailer. On top of BN's breaks
// the cable snaps on overload: a hard jerk (or sustained strain) past CABLE_BREAK_N.

/**
 * Taut length, hook to hook, m. BN no_towing_slack: rl_dist >= 8 between the two cable parts'
 * tiles. The hooks here sit on the paint, about half a tile out from each part's tile centre.
 */
export const TOW_TAUT_M = 7;
/** BN tow_cable_too_far: rl_dist >= 25 between the parts snaps it (hooks: 24 m). */
export const TOW_SNAP_M = 24;
/**
 * The loose end's reach while you carry it. BN process_cable: charges = max_charges (6) -
 * rl_dist(you, first end); under 1 "The over-extended cable breaks loose!".
 */
export const CABLE_REACH = 6;
/**
 * Overload (not BN): the cable snaps when its tension, low-passed over TENSION_TAU, passes this.
 * A rigid cable turns a jerk into an impulse of about m_red * dv, so this is a jerk of ~17 m/s
 * (39 mph) for an Abrams on a car, ~3 m/s for an Abrams on an Abrams, and never steady pulling.
 */
export const CABLE_BREAK_N = 120_000;
export const TENSION_TAU = 0.2;
/** BN vehicle::thrust: `accel < 89` (vmiph per turn) while towing = no thrust. In m/s². */
export const TOW_MIN_ACCEL = 89 * 0.00447;
/**
 * Slack and closing in: the towed vehicle brakes. BN do_towing_move gives the towed vehicle
 * accel_y 1 under `rl_dist < 6`, which selfdrive turns into thrust(-1): a brake of max_brake 894
 * vmiph per turn, ~4 m/s². (In BN that branch sits behind the taut check and never runs; BN
 * instead sets the towed vehicle's speed to the tower's every turn.) Here it brakes as soon as
 * the cable goes slack with the two closing, at BN's 4 m/s² or harder if that won't stop the
 * closing a metre short of the tower, up to TOW_BRAKE_MAX (more than a hard-braking tower's
 * 10.4 m/s²): stop, and the car you pull stops behind you instead of rear-ending you.
 */
export const TOW_BRAKE_M = TOW_TAUT_M - 0.05;
const TOW_BRAKE = 894 * 0.00447;
const TOW_BRAKE_MAX = 12;
/** Position correction of an over-stretched cable: fraction of the stretch per frame, capped. */
const BAUMGARTE = 0.2;
const MAX_BIAS = 2;
/** Sideways grip of the towed vehicle's far axle (tyres), as μg on half its weight. */
const AXLE_GRIP = 0.9 * 9.81 * 0.5;
/** The axle by the hook while the cable is slack: wheels castering free, they only damp the swing (s). */
const NEAR_TAU = 0.3;
/** How far the towed vehicle's steered wheels turn toward the pull, deg (a car's full lock). */
const TOW_STEER_MAX = 35;
/** How far from a hook you can attach the cable (BN choose_adjacent: the next tile), m. */
export const ATTACH_REACH = 1.6;
/** Hook height over the vehicle's level floor, m (a tow eye under the bumper). */
export const HOOK_H = 0.45;

export type TowDirection = 'front' | 'side' | 'back';

/**
 * BN vehicle::set_tow_directions: where the cable sits along the vehicle. Thirds of the grid's
 * length (mount_max.x - mount_min.x + 1, +x forward): rear third 'back' (towed rear first, in
 * reverse), middle 'side' (dragged sideways, skidding), front 'front'. Under 3 long: 'front'.
 */
export function towDirection(v: Vehicle, mx: number): TowDirection {
  const [x0, , x1] = v.bounds();
  const length = x1 - x0 + 1;
  if (length < 3) return 'front';
  const trisect = Math.floor(length / 3);
  const n = Math.abs(mx - x0);
  return n <= trisect ? 'back' : n <= trisect * 2 ? 'side' : 'front';
}

export interface TowHook {
  mx: number;
  my: number;
}

export interface TowLink {
  tower: Vehicle;
  towed: Vehicle;
  /** The cable parts' mounts on the tower (a) and the towed vehicle (b). */
  a: TowHook;
  b: TowHook;
  /** Low-passed cable tension, N. */
  tension: number;
  /** Hook-to-hook distance last step, m (the renderer's sag). */
  dist: number;
  /** The tower's speed along the cable last step (its deceleration, for the towed brakes). */
  towerAlong?: number;
}

export interface TowLinkJSON {
  tower: number;
  towed: number;
  a: TowHook;
  b: TowHook;
}

/** A carried cable with one end on a vehicle (BN cable_connection_data con1, kept on the item). */
export interface LooseEnd {
  cable: Item;
  v: Vehicle;
  hook: TowHook;
}

const VAR_UID = 'tow_uid', VAR_MX = 'tow_mx', VAR_MY = 'tow_my';

export const isTowCable = (it: Item): boolean => it.hasFlag('TOW_CABLE');

/**
 * Mount-space point on the body outline nearest the mount (where the hook sits on the paint).
 * On the nose or tail, a hook on one of the middle columns sits on the centre line: BN grids are
 * an even number of tiles wide, so "the middle" is half a tile off, and a hook pulled half a
 * metre off-centre crabs the towed vehicle ~10 deg for good (the rope then lines up with its
 * rear axle, as a trailer's would).
 */
export function hookOnBody(b: BodyRect, mx: number, my: number): [number, number] {
  const x = Math.max(b.x0, Math.min(b.x1, mx)), y = Math.max(b.y0, Math.min(b.y1, my));
  const d = [x - b.x0, b.x1 - x, y - b.y0, b.y1 - y];
  const i = d.indexOf(Math.min(...d));
  const cy = (b.y0 + b.y1) / 2;
  const yEnd = Math.abs(my - cy) <= 0.6 ? cy : y;
  return i === 0 ? [b.x0, yEnd] : i === 1 ? [b.x1, yEnd] : i === 2 ? [x, b.y0] : [x, b.y1];
}

export class TowSystem {
  readonly links: TowLink[] = [];
  /** Seconds until the "struggles to pull" message may repeat. */
  private struggleMsgIn = 0;

  constructor(readonly vs: VehicleSystem) {}

  private get game() {
    return this.vs.game;
  }

  linkOf(v: Vehicle): TowLink | undefined {
    return this.links.find((l) => l.tower === v || l.towed === v);
  }
  isTowing(v: Vehicle): boolean {
    return this.links.some((l) => l.tower === v);
  }
  isTowed(v: Vehicle): boolean {
    return this.links.some((l) => l.towed === v);
  }

  /** The cable part of `v` (BN get_tow_part). */
  cablePart(v: Vehicle): VehiclePart | undefined {
    return v.parts.find((p) => has(p, 'TOW_CABLE'));
  }

  /** World position of a hook (on the paint at that mount). */
  hookWorld(v: Vehicle, h: TowHook): [number, number] {
    const [hx, hy] = hookOnBody(this.vs.physRect(v), h.mx, h.my);
    return v.mountToWorld(hx, hy);
  }

  /**
   * BN process_map_connection checks for one end on `v` at mount (mx, my): a vehicle with no
   * cable yet, and an outside square (BN is_external_part: a neighbour that isn't this vehicle).
   * Null = fine, else why not.
   */
  attachReason(v: Vehicle, mx: number, my: number): string | null {
    if (this.linkOf(v) || this.cablePart(v)) return 'That vehicle already has a tow-line attached.';
    if (!v.partsAt(mx, my).length) return "There's no vehicle there.";
    if (!this.isExternal(v, mx, my)) return "You can't attach the tow-line to an internal part.";
    return null;
  }

  /**
   * BN choose_adjacent for the cable: the outside squares of vehicles whose hook you can reach
   * from where you stand (within ATTACH_REACH of the paint), nearest first, one per vehicle.
   */
  reachableHooks(): { v: Vehicle; mx: number; my: number; dist: number }[] {
    const p = this.game.player;
    const out: { v: Vehicle; mx: number; my: number; dist: number }[] = [];
    for (const v of this.vs.list) {
      if (v.z !== p.z || Math.hypot(v.x - p.x, v.y - p.y) > 30) continue;
      let best: { v: Vehicle; mx: number; my: number; dist: number } | null = null;
      for (const k of new Set(v.parts.map((q) => `${q.mx},${q.my}`))) {
        const [mx, my] = k.split(',').map(Number);
        if (!this.isExternal(v, mx, my)) continue;
        const [hx, hy] = this.hookWorld(v, { mx, my });
        const dist = Math.hypot(hx - p.x, hy - p.y);
        if (dist <= ATTACH_REACH && (!best || dist < best.dist)) best = { v, mx, my, dist };
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** BN vehicle::is_external_part: a neighbouring square isn't this vehicle. */
  isExternal(v: Vehicle, mx: number, my: number): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!v.hasMount(mx + dx, my + dy)) return true;
    return false;
  }

  /** How far you are from a hook (for "move closer"). */
  reachTo(v: Vehicle, mx: number, my: number): number {
    const p = this.game.player;
    const [hx, hy] = this.hookWorld(v, { mx, my });
    return v.z === p.z ? Math.hypot(hx - p.x, hy - p.y) : Infinity;
  }

  /** The loose end of a cable you carry (BN: con1 set, con2 empty), if any. */
  looseEnd(): LooseEnd | null {
    const p = this.game.player;
    for (const item of p.inv.allItems()) {
      if (!isTowCable(item) || item.vars[VAR_UID] === undefined) continue;
      const v = this.vs.list.find((x) => x.uid === Number(item.vars[VAR_UID]));
      if (!v) continue;
      return { cable: item, v, hook: { mx: Number(item.vars[VAR_MX]), my: Number(item.vars[VAR_MY]) } };
    }
    return null;
  }

  /** BN item::reset_cable: forget where the end was attached. */
  resetCable(cable: Item, msg?: string): void {
    delete cable.vars[VAR_UID];
    delete cable.vars[VAR_MX];
    delete cable.vars[VAR_MY];
    if (msg) this.game.message(msg);
  }

  /**
   * Use the cable on vehicle `v` at mount (mx, my): the first end (this vehicle will tow) or,
   * with one end already on another vehicle, the second (this vehicle will be towed) and link
   * them. Returns the message (also logged).
   */
  useCable(cable: Item, v: Vehicle, mx: number, my: number): { ok: boolean; msg: string } {
    const say = (ok: boolean, msg: string) => (this.game.message(msg, ok ? undefined : 'c_light_red'), { ok, msg });
    const from = locate(cable, bodyLocs(this.game.player));
    if (!from) return say(false, `You need to carry the ${cable.baseName()} to attach it.`);
    if (this.reachTo(v, mx, my) > ATTACH_REACH) return say(false, `Stand next to that part of the ${v.name} to attach the cable.`);
    const loose = cable.vars[VAR_UID] !== undefined ? this.looseEnd() : null;
    if (loose && loose.cable === cable) {
      if (loose.v === v) return say(false, 'You cannot set a vehicle to tow itself!');
      const why = this.attachReason(v, mx, my);
      if (why) return say(false, why);
      if (loose.v.z !== v.z) return say(false, 'The other end is on another level.');
      const tower = loose.v, a = loose.hook;
      this.resetCable(cable);
      const j = cable.toJSON();
      if (!consumeItem(cable, from)) throw new Error('tow cable: carried cable vanished while linking');
      this.link(tower, a, v, { mx, my }, j);
      return say(true, `You link up the ${tower.name} and the ${v.name}.`);
    }
    const why = this.attachReason(v, mx, my);
    if (why) return say(false, why);
    cable.vars[VAR_UID] = v.uid;
    cable.vars[VAR_MX] = mx;
    cable.vars[VAR_MY] = my;
    return say(true, `You attach the ${cable.baseName()} to the ${v.name}. Carry the loose end to the vehicle it will pull (within ${CABLE_REACH - 1} m).`);
  }

  /**
   * Install the cable parts and link `tower` -> `towed` (BN: install_part on both mounts,
   * tow_data.set_towing). The cable item's JSON rides on the tower's part (vehicleWork's
   * installedItem convention); the towed side's part carries nothing, as in BN.
   */
  link(tower: Vehicle, a: TowHook, towed: Vehicle, b: TowHook, cable: ItemJSON): TowLink {
    const def = this.vs.vdata.parts.hd_tow_cable;
    if (!def) throw new Error('vehicles.json has no hd_tow_cable part');
    const pa = tower.addPart(def, a.mx, a.my);
    pa.installedItem = cable;
    towed.addPart(def, b.mx, b.my);
    tower.version++;
    towed.version++;
    const l: TowLink = { tower, towed, a, b, tension: 0, dist: 0 };
    l.dist = this.hookDistance(l);
    this.links.push(l);
    return l;
  }

  hookDistance(l: TowLink): number {
    const [ax, ay] = this.hookWorld(l.tower, l.a), [bx, by] = this.hookWorld(l.towed, l.b);
    return Math.hypot(ax - bx, ay - by);
  }

  /**
   * End a link (BN invalidate_towing): both cable parts come off and the cable item comes back
   * once: to `to` ('carry': your inventory, else at your feet; 'drop': the ground under the
   * tower's hook, as BN drops it at the part). `msg` is logged.
   */
  unlink(l: TowLink, to: 'carry' | 'drop', msg?: string, color?: string): Item | null {
    const i = this.links.indexOf(l);
    if (i >= 0) this.links.splice(i, 1);
    let cable: Item | null = null;
    for (const v of [l.tower, l.towed]) {
      const p = v.partsAt(v === l.tower ? l.a.mx : l.b.mx, v === l.tower ? l.a.my : l.b.my).find((q) => has(q, 'TOW_CABLE')) ?? this.cablePart(v);
      if (!p) continue;
      if (p.installedItem && !cable) cable = Item.fromJSON(this.game.data, p.installedItem);
      v.removePart(p);
    }
    if (cable) this.giveBack(cable, to, l);
    if (msg) this.game.message(msg, color);
    return cable;
  }

  private giveBack(cable: Item, to: 'carry' | 'drop', l: TowLink): void {
    const g = this.game, p = g.player;
    // Reeled in: into your pack if it fits, else in your hands if they're free, else at your feet.
    if (to === 'carry' && (spawnItem(cable, L.inv(p), { quiet: true }).ok || (!p.inv.wielded && spawnItem(cable, L.hands(p), { quiet: true }).ok))) return;
    const [x, y] = to === 'carry' ? [p.x, p.y] : this.hookWorld(l.tower, l.a);
    spawnOnGround(g.map, Math.floor(x), Math.floor(y), to === 'carry' ? p.z : l.tower.z, cable);
  }

  /** Snap the cable (BN: "A towing cable snaps off of %s."); it falls by the tower's hook. */
  snap(l: TowLink, why = `A towing cable snaps off of the ${l.towed.name}.`): void {
    this.unlink(l, 'drop', why, 'c_light_red');
    this.vs.emitSound(l.tower, 30, 'a loud twang!', undefined, 'destructive_activity');
  }

  /**
   * BN vehicle::thrust while towing: the acceleration the tower would have pulling both masses
   * (ground_acceleration with the towed weight added); under 89 vmiph/turn while rolling forward
   * the engine can't push ("struggles to pull ... on this surface!"). False = no thrust.
   */
  canPull(v: Vehicle, offroad: number, throttle: number, dt: number): boolean {
    this.struggleMsgIn = Math.max(0, this.struggleMsgIn - dt);
    if (throttle <= 0 || v.velocity <= 0) return true;
    const l = this.links.find((x) => x.tower === v);
    if (!l) return true;
    const m = v.mass(), m2 = l.towed.mass();
    if ((v.acceleration(v.velocity, offroad) * m) / (m + m2) >= TOW_MIN_ACCEL) return true;
    if (this.struggleMsgIn <= 0 && this.vs.driving === v) {
      this.game.message(`The ${v.name} struggles to pull the ${l.towed.name} on this surface!`);
      this.struggleMsgIn = 3;
    }
    return false;
  }

  /**
   * One frame of cable physics, after every vehicle has moved: check what breaks it, then
   * stop the hooks separating past the taut length with an impulse through both bodies, then
   * let the towed vehicle's far axle grip sideways. Also the loose end's reach.
   */
  step(dt: number): void {
    if (dt <= 0) return;
    this.checkLooseEnd();
    for (const l of [...this.links]) {
      const why = this.broken(l);
      if (why !== null) {
        if (why) this.snap(l, why);
        else this.unlink(l, 'drop');
        continue;
      }
      const d = this.hookDistance(l);
      l.dist = d;
      if (d >= TOW_SNAP_M) {
        this.snap(l);
        continue;
      }
      const J = this.pull(l, d, dt);
      l.tension += (J / dt - l.tension) * Math.min(1, dt / TENSION_TAU);
      if (l.tension > CABLE_BREAK_N) {
        this.snap(l, `The tow cable snaps under the strain of the ${l.towed.name}!`);
        continue;
      }
      this.grip(l, dt);
      this.brakeIfClosing(l, d, dt);
    }
  }

  /** Under TOW_BRAKE_M (slack) with the towed vehicle rolling up on the tower: it brakes. */
  private brakeIfClosing(l: TowLink, d: number, dt: number): void {
    const v = l.towed;
    const [ax, ay] = this.hookWorld(l.tower, l.a), [bx, by] = this.hookWorld(v, l.b);
    const nx = (ax - bx) / Math.max(d, 1e-6), ny = (ay - by) / Math.max(d, 1e-6);
    const [tvx, tvy] = this.vs.planarVelocity(l.tower), [vx, vy] = this.vs.planarVelocity(v);
    // The tower's own deceleration along the cable (it keeps slowing while we brake).
    const towerAlong = tvx * nx + tvy * ny;
    const towerDecel = l.towerAlong === undefined ? 0 : Math.max(0, (l.towerAlong - towerAlong) / dt);
    l.towerAlong = towerAlong;
    if (d >= TOW_BRAKE_M || this.vs.driving === v || Math.abs(v.velocity) < 1e-3) return;
    const closing = (vx - tvx) * nx + (vy - tvy) * ny;
    if (closing <= 0) return;
    // BN's brake, or harder: enough to stop closing before the hooks are a metre apart while the
    // tower goes on slowing (a hard-braking tower outbrakes BN's 4 m/s²); at most TOW_BRAKE_MAX.
    const need = (closing * closing) / (2 * Math.max(0.1, d - 1)) + towerDecel;
    const dv = Math.min(TOW_BRAKE_MAX, Math.max(TOW_BRAKE, need)) * dt;
    v.velocity = Math.abs(v.velocity) <= dv ? 0 : v.velocity - Math.sign(v.velocity) * dv;
  }

  /** Why the link can't go on: a message (snapped), '' (gone quietly), null (fine). */
  private broken(l: TowLink): string | null {
    const list = this.vs.list;
    if (!list.includes(l.tower) || !list.includes(l.towed)) return '';
    const pa = l.tower.partsAt(l.a.mx, l.a.my).find((p) => has(p, 'TOW_CABLE'));
    const pb = l.towed.partsAt(l.b.mx, l.b.my).find((p) => has(p, 'TOW_CABLE'));
    // BN map::vehmove: towing across z-levels (a bridge, a ramp) snaps the cable.
    if (l.tower.z !== l.towed.z) return `A towing cable snaps off of the ${l.towed.name}.`;
    // BN UNMOUNT_ON_DAMAGE: a destroyed cable part ends the tow.
    if (!pa || !pb || pa.hp <= 0 || pb.hp <= 0) return `The tow cable between the ${l.tower.name} and the ${l.towed.name} breaks!`;
    return null;
  }

  /** The rope impulse (N·s) this frame: none while slack. */
  private pull(l: TowLink, d: number, dt: number): number {
    const stretch = d - TOW_TAUT_M;
    if (stretch <= 0 || d < 1e-6) return 0;
    const [ax, ay] = this.hookWorld(l.tower, l.a), [bx, by] = this.hookWorld(l.towed, l.b);
    const nx = (ax - bx) / d, ny = (ay - by) / d;
    const ca = this.vs.contactBody(l.tower, ax, ay), cb = this.vs.contactBody(l.towed, bx, by);
    const sep = (ca.pvx - cb.pvx) * nx + (ca.pvy - cb.pvy) * ny;
    const want = sep + Math.min(MAX_BIAS, (BAUMGARTE * stretch) / dt);
    if (want <= 0) return 0;
    const cross = (rx: number, ry: number) => rx * ny - ry * nx;
    const ka = cross(ax - ca.cx, ay - ca.cy), kb = cross(bx - cb.cx, by - cb.cy);
    const k = 1 / ca.m + 1 / cb.m + (ka * ka) / ca.I + (kb * kb) / cb.I;
    const J = want / k;
    this.vs.applyImpulse(l.towed, J * nx, J * ny, bx, by);
    this.vs.applyImpulse(l.tower, -J * nx, -J * ny, ax, ay);
    return J;
  }

  /**
   * The towed vehicle's tyres, in place of the flat slide / spin decay (vehicleImpact.ts
   * decayMotion `towed`): each axle stops sliding across its wheels, up to the grip of half the
   * weight. The axle away from the cable rolls straight. The one by the hook steers toward the
   * pull, as BN's do_towing_move steers the towed vehicle at the tower (get_turn_from_angle,
   * selfdrive), within TOW_STEER_MAX; while the cable is slack it only damps the swing (NEAR_TAU).
   * So a vehicle pulled by the nose follows the tower's line through turns like a trailer.
   * BN's 'side' tow (the cable on the middle third) is dragged skidding.
   */
  private grip(l: TowLink, dt: number): void {
    const v = l.towed;
    if (this.vs.driving === v) return;
    const dir = towDirection(v, l.b.mx);
    const m = motionOf(v);
    if (dir === 'side') {
      if (l.dist > TOW_TAUT_M - 0.05) m.skid = Math.max(m.skid, 0.1);
      return;
    }
    const xs = v.wheels.filter((w) => w.hp > 0).map((w) => w.mx);
    if (!xs.length) return;
    const far = dir === 'front' ? Math.min(...xs) : Math.max(...xs), near = dir === 'front' ? Math.max(...xs) : Math.min(...xs);
    this.axleGrip(v, far, dt, 0, v.facing);
    if (near === far) return;
    if (l.dist < TOW_TAUT_M - 0.05) return this.axleGrip(v, near, dt, NEAR_TAU, v.facing);
    const [ax, ay] = this.hookWorld(l.tower, l.a), [bx, by] = this.hookWorld(v, l.b);
    // The pull's bearing off the vehicle's axis, folded into +-90 (a rear-first tow steers the same way).
    let rel = ((((Math.atan2(ay - by, ax - bx) * 180) / Math.PI - v.facing) % 360) + 540) % 360 - 180;
    if (rel > 90) rel -= 180;
    else if (rel < -90) rel += 180;
    this.axleGrip(v, near, dt, 0, v.facing + Math.max(-TOW_STEER_MAX, Math.min(TOW_STEER_MAX, rel)));
  }

  /**
   * Stop axle `ax` sliding across wheels pointing `heading` (deg): Coulomb, up to the tyres' grip
   * on half the weight (tau 0), or viscous over `tau` seconds (wheels castering free).
   */
  private axleGrip(v: Vehicle, ax: number, dt: number, tau: number, heading: number): void {
    const b = this.vs.physRect(v);
    const [px, py] = v.mountToWorld(ax, (b.y0 + b.y1) / 2);
    const rad = (heading * Math.PI) / 180;
    const sx = -Math.sin(rad), sy = Math.cos(rad);
    const c = this.vs.contactBody(v, px, py);
    const vlat = c.pvx * sx + c.pvy * sy;
    if (Math.abs(vlat) < 1e-4) return;
    const r = (px - c.cx) * sy - (py - c.cy) * sx;
    const k = 1 / c.m + (r * r) / c.I;
    const cap = AXLE_GRIP * c.m * dt;
    const want = (-vlat / k) * (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
    const j = Math.max(-cap, Math.min(cap, want));
    this.vs.applyImpulse(v, j * sx, j * sy, px, py);
  }

  /** BN process_cable: the loose end you carry pulls free past its reach, or if its vehicle went. */
  private checkLooseEnd(): void {
    const p = this.game.player;
    for (const item of p.inv.allItems()) {
      if (!isTowCable(item) || item.vars[VAR_UID] === undefined) continue;
      const v = this.vs.list.find((x) => x.uid === Number(item.vars[VAR_UID]));
      if (!v || v.z !== p.z) {
        this.resetCable(item, 'You notice the cable has disconnected from a vehicle!');
        continue;
      }
      const [hx, hy] = this.hookWorld(v, { mx: Number(item.vars[VAR_MX]), my: Number(item.vars[VAR_MY]) });
      // BN rl_dist (square distance) from you to the attached end, in tiles.
      if (Math.max(Math.abs(Math.floor(hx) - Math.floor(p.x)), Math.abs(Math.floor(hy) - Math.floor(p.y))) >= CABLE_REACH) this.resetCable(item, 'The over-extended cable breaks loose!');
    }
  }

  toJSON(): TowLinkJSON[] {
    return this.links.map((l) => ({ tower: l.tower.uid, towed: l.towed.uid, a: { ...l.a }, b: { ...l.b } }));
  }

  /**
   * Relink after the vehicles loaded (BN game::validate_linked_vehicles). A link whose vehicles
   * or cable parts are gone is dropped with a warning, and its leftover parts come off.
   */
  fromJSON(list: TowLinkJSON[], warn: (msg: string) => void): void {
    this.links.length = 0;
    const byUid = new Map(this.vs.list.map((v) => [v.uid, v]));
    for (const j of list) {
      const tower = byUid.get(j.tower), towed = byUid.get(j.towed);
      const ok = tower && towed && tower.partsAt(j.a.mx, j.a.my).some((p) => has(p, 'TOW_CABLE')) && towed.partsAt(j.b.mx, j.b.my).some((p) => has(p, 'TOW_CABLE'));
      if (!ok) {
        warn(`towing: dropped a tow link ${j.tower} -> ${j.towed} (vehicle or cable part missing)`);
        continue;
      }
      const l: TowLink = { tower: tower!, towed: towed!, a: { ...j.a }, b: { ...j.b }, tension: 0, dist: 0 };
      l.dist = this.hookDistance(l);
      this.links.push(l);
    }
    // Cable parts no link explains (a save edited by hand, a dropped link): the cable comes off
    // onto the ground there, so it isn't lost and nothing is left half-linked.
    for (const v of this.vs.list) {
      if (this.linkOf(v)) continue;
      const p = this.cablePart(v);
      if (!p) continue;
      warn(`towing: ${v.name} had a tow cable part with no link; removed`);
      if (p.installedItem) {
        const [x, y] = v.mountToWorld(p.mx, p.my);
        spawnOnGround(this.game.map, Math.floor(x), Math.floor(y), v.z, Item.fromJSON(this.game.data, p.installedItem));
      }
      v.removePart(p);
    }
  }

  clear(): void {
    this.links.length = 0;
  }
}

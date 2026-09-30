import type { Game } from './game';
import type { MapOverlay } from '../world/map';
import { LEVEL_HEIGHT } from '../world/coords';
import { HEADING, LANDING_IN, StairIndex, levelAt, type StairLink, type StairVariant, STAIR_VARIANTS, DX, DY } from './stairs';

// Walking up and down stairs (docs/STAIRS.md). A creature that walks into the bottom (or top)
// of a flight is carried along its path (stairs.ts StairPath): position, height and — on
// spirals and ladders — facing follow the path, driven by how hard you push along it. Its
// level (z) switches where the eye passes the ceiling (SWITCH_H), with a `lift` in metres
// relative to that level that the renderer adds to the eye and to drawn bodies. The flight's
// tiles are blocked for ordinary walking (a map overlay), so there's no stepping onto a
// flight from the side or out of a stairwell.
//
// Everyone uses the same paths: the player (Game.stairStep), monsters chasing across levels
// (MonsterSystem.stairs) and the `<` / `>` keys, which now climb the flight on their own.

/** Anything with a position that can ride a flight. */
export interface Walker {
  x: number;
  y: number;
  z: number;
}

export interface Climb {
  link: StairLink;
  /** distance along the path (0 bottom landing .. len top landing) */
  s: number;
  /** sideways offset on wide straight flights (m) */
  lat: number;
  /** offset from the path where we joined it; fades out over `blendLen` metres */
  bx: number;
  by: number;
  blendLen: number;
  blendFrom: number;
  /** +1 / -1: travelling on its own (key shortcut, monsters); 0: driven by input */
  auto: number;
  /** last path facing (the view turns with a spiral) */
  head: number;
  /** height above the link's lower floor */
  h: number;
  /** lift relative to the walker's current z (what renderers add) */
  lift: number;
  /** last tread index (footstep per tread) */
  tread: number;
  /** blocked at an end this tick (closed door on the landing, someone standing there) */
  held: boolean;
}

const climbs = new WeakMap<object, Climb>();
export const climbOf = (w: object): Climb | undefined => climbs.get(w);
/** Metres a walker is lifted above its level's floor (0 off the stairs). */
export const liftOf = (w: object): number => climbs.get(w)?.lift ?? 0;
export const isClimbing = (w: object): boolean => climbs.has(w);

/** Speed on a flight relative to walking on flat ground, per kind (along the 3D path). */
const SPEED = { stairs: 0.72, slope: 0.85, ladder: 0.38 };
/** Running up stairs: allowed, but not the doubling it is on flat ground. */
const RUN_ON_STAIRS = 0.72;
/** How far (m) outside an entry edge you may be and still step onto the flight. */
const ENTRY_REACH = 0.42;

/** Rise of one tread (or rung) of a link, for footsteps and the per-step head bob. */
export function treadRise(l: StairLink): number {
  if (l.kind === 'ladder') return 0.3;
  if (l.kind === 'slope') return 0.5;
  return LEVEL_HEIGHT / riserCount(l);
}

/** Risers of a flight (shared with the model so steps you hear are steps you see). */
export function riserCount(l: StairLink): number {
  if (l.shape === 'spiral') return Math.round((Math.abs(l.spiral!.sweep) / (2 * Math.PI)) * 12);
  if (l.shape === 'ladder') return Math.round(LEVEL_HEIGHT / 0.3);
  // one tile: a steep ship's stair; longer runs toward a normal 18-19 cm riser
  return l.run <= 1 ? 10 : 14;
}

export interface TreadEvent {
  walker: Walker;
  link: StairLink;
  up: boolean;
  running: boolean;
}

export class StairWalker {
  readonly index: StairIndex;
  /** walkers currently on a flight (for queueing and variant switches) */
  private riding = new Set<Walker>();
  /** called on each tread (footsteps) */
  readonly onTread: ((e: TreadEvent) => void)[] = [];
  /** called when a walker gets on or off a flight */
  readonly onAttach: ((w: Walker, l: StairLink, up: boolean) => void)[] = [];
  readonly onDetach: ((w: Walker, l: StairLink, top: boolean) => void)[] = [];
  /**
   * A walker held at a flight's end by a closed door on the landing: try to open it (CDDA
   * opens doors by walking into them). Returns a message when it can't (locked); null = opened.
   */
  openDoor: ((w: Walker, x: number, y: number, z: number) => string | null) | null = null;
  /** the player's latest completed trip: where monsters chasing across levels head for */
  lastTrip: { link: StairLink; up: boolean; time: number } | null = null;
  time = 0;

  /** Ordinary walking can't enter a flight or its stairwell. */
  readonly overlay: MapOverlay = {
    moveCost: (x, y, z) => (this.index.enabled && this.index.at(x, y, z) ? 0 : undefined),
  };

  constructor(readonly game: Game, variant: StairVariant) {
    this.index = new StairIndex(game.map, variant);
  }

  get variant(): StairVariant {
    return this.index.variant;
  }

  setVariant(v: StairVariant): void {
    if (!STAIR_VARIANTS.includes(v)) throw new Error(`unknown stairs variant ${v}: ${STAIR_VARIANTS.join('|')}`);
    // everyone mid-flight lands on the nearer end first: the flights are about to change shape
    for (const w of [...this.riding]) {
      const c = climbs.get(w)!;
      this.detach(w, c.s > c.link.path.len / 2);
    }
    this.index.reset(v);
    this.lastTrip = null;
  }

  /** Solve the flights around the player (call once per tick, outside physics). */
  prepare(): void {
    const p = this.game.player;
    this.index.ensureAround(p.tileX, p.tileY, p.z, 1);
  }

  // --------------------------------------------------------------------- joining a flight

  /**
   * The flight end a walker at (x, y, z) would step onto moving along (wx, wy) (unit or 0),
   * or null. `reach` widens the capture (monsters steer less precisely than feet).
   */
  entryFor(w: Walker, wx: number, wy: number, reach = ENTRY_REACH): { link: StairLink; top: boolean; lat: number } | null {
    if (!this.index.enabled) return null;
    const tx = Math.floor(w.x), ty = Math.floor(w.y);
    let best: { link: StairLink; top: boolean; lat: number } | null = null, bd = Infinity;
    for (let d = 0; d < 4; d++) {
      const l = this.index.at(tx + DX[d], ty + DY[d], w.z);
      if (!l) continue;
      const top = l.z + 1 === w.z;
      const ends = top ? l.top : l.bottom;
      if (!ends.some(([ex, ey]) => ex === tx && ey === ty)) continue;
      const e = this.endGeometry(l, top);
      // along: how far past the entry edge (toward the flight) the walker is; lat: sideways,
      // on the path's own lateral axis (cos head, sin head) like attach() uses
      const rx = w.x - e.ex, ry = w.y - e.ey;
      const along = rx * e.ix + ry * e.iy;
      const lat = rx * Math.cos(e.head) + ry * Math.sin(e.head);
      if (along < -reach || Math.abs(lat) > l.lane + 0.36) continue;
      if (wx * e.ix + wy * e.iy < 0.35) continue;
      const dist = -along;
      if (dist < bd) (bd = dist), (best = { link: l, top, lat });
    }
    return best;
  }

  /** Entry edge midpoint and the inward direction (toward the flight) at one end. */
  private endGeometry(l: StairLink, top: boolean): { ex: number; ey: number; ix: number; iy: number; head: number } {
    const p = l.path.at(top ? l.path.len : 0);
    // facing at the ends is the direction of travel going up
    const hx = Math.sin(p.head), hy = -Math.cos(p.head);
    const ix = top ? -hx : hx, iy = top ? -hy : hy;
    return { ex: p.x + ix * LANDING_IN, ey: p.y + iy * LANDING_IN, ix, iy, head: p.head };
  }

  /** Put walker `w` on flight `l` at its bottom (top = false) or top end. */
  attach(w: Walker, l: StairLink, top: boolean, opts: { lat?: number; auto?: number } = {}): Climb {
    const s = top ? l.path.len : 0;
    const p = l.path.at(s);
    const lat = Math.max(-l.lane, Math.min(l.lane, opts.lat ?? 0));
    const nx = Math.cos(p.head), ny = Math.sin(p.head);
    const px = p.x + nx * lat, py = p.y + ny * lat;
    const off = Math.hypot(w.x - px, w.y - py);
    const c: Climb = {
      link: l, s, lat, bx: w.x - px, by: w.y - py, blendLen: Math.max(0.4, off * 1.5), blendFrom: s,
      auto: opts.auto ?? 0, head: p.head, h: p.h, lift: 0, tread: Math.floor(p.h / treadRise(l)), held: false,
    };
    climbs.set(w, c);
    this.riding.add(w);
    this.place(w, c);
    for (const f of this.onAttach) f(w, l, !top);
    return c;
  }

  /** Step off at the top (true) or bottom landing. */
  detach(w: Walker, top: boolean): void {
    const c = climbs.get(w);
    if (!c) return;
    const l = c.link;
    const p = l.path.at(top ? l.path.len : 0);
    const nx = Math.cos(p.head), ny = Math.sin(p.head);
    w.x = p.x + nx * c.lat;
    w.y = p.y + ny * c.lat;
    w.z = top ? l.z + 1 : l.z;
    climbs.delete(w);
    this.riding.delete(w);
    if (w === this.game.player) this.lastTrip = { link: l, up: top, time: this.time };
    for (const f of this.onDetach) f(w, l, top);
  }

  /** Walker position from its climb state. */
  private place(w: Walker, c: Climb): void {
    const l = c.link;
    const p = l.path.at(c.s);
    const nx = Math.cos(p.head), ny = Math.sin(p.head);
    // the join offset fades out over the first stretch travelled
    const k = Math.max(0, 1 - Math.abs(c.s - c.blendFrom) / c.blendLen);
    w.x = p.x + nx * c.lat + c.bx * k;
    w.y = p.y + ny * c.lat + c.by * k;
    const lv = levelAt(l, p.h);
    w.z = lv.z;
    c.h = p.h;
    c.lift = lv.lift;
  }

  /**
   * Move walker `w` along its flight by `ds` metres (+ up, - down). Returns 'top' / 'bottom'
   * when it stepped off, else null. Waits at an end whose landing is blocked (a closed door,
   * someone standing there) and behind other climbers.
   */
  advance(w: Walker, ds: number, running = false): 'top' | 'bottom' | null {
    const c = climbs.get(w);
    if (!c) return null;
    const l = c.link, len = l.path.len;
    c.held = false;
    let s = c.s + ds;
    // queue behind whoever is ahead on the same flight
    for (const o of this.riding) {
      if (o === w) continue;
      const oc = climbs.get(o)!;
      if (oc.link !== l) continue;
      const gap = 0.62;
      if (ds > 0 && oc.s > c.s && s > oc.s - gap) s = Math.max(c.s, oc.s - gap);
      if (ds < 0 && oc.s < c.s && s < oc.s + gap) s = Math.min(c.s, oc.s + gap);
    }
    const map = this.game.map;
    const endFree = (top: boolean) => {
      const tz = top ? l.z + 1 : l.z;
      let free = true;
      for (const [x, y] of top ? l.top : l.bottom) {
        if (map.passable(x, y, tz)) continue;
        // walking into a closed door opens it; only once per hold, not every tick
        if (this.openDoor && !c.held && map.terAt(x, y, tz).open) this.openDoor(w, x, y, tz);
        free &&= map.passable(x, y, tz);
      }
      return free;
    };
    // stop on the last step before a blocked landing (never pushed back if already past it)
    const capTop = len - LANDING_IN - 0.08, capBottom = LANDING_IN + 0.08;
    if (ds > 0 && s > capTop && !endFree(true)) {
      s = Math.min(s, Math.max(c.s, capTop));
      c.held = true;
    }
    if (ds < 0 && s < capBottom && !endFree(false)) {
      s = Math.max(s, Math.min(c.s, capBottom));
      c.held = true;
    }
    c.s = Math.max(0, Math.min(len, s));
    this.place(w, c);
    const t = Math.floor(c.h / treadRise(l) + 1e-6);
    if (t !== c.tread) {
      const up = t > c.tread;
      c.tread = t;
      for (const f of this.onTread) f({ walker: w, link: l, up, running });
    }
    if (c.s >= len) {
      this.detach(w, true);
      return 'top';
    }
    if (c.s <= 0 && ds < 0) {
      this.detach(w, false);
      return 'bottom';
    }
    return null;
  }

  /**
   * A walker standing inside a flight's footprint without riding it (a save from before,
   * a spawn, a creature placed by a script): move it to the landing of its level.
   */
  unstick(w: Walker): boolean {
    if (climbs.has(w)) return false;
    const l = this.index.at(Math.floor(w.x), Math.floor(w.y), w.z);
    if (!l) return false;
    const top = w.z === l.z + 1;
    const p = l.path.at(top ? l.path.len : 0);
    w.x = p.x;
    w.y = p.y;
    return true;
  }

  // --------------------------------------------------------------------- the player

  /**
   * Game.stairStep: the player's movement this tick when stairs are involved. (fx, fy) is the
   * WASD axis input (right, forward). True = handled (normal walking is skipped).
   */
  playerStep(fx: number, fy: number, dt: number): boolean {
    const g = this.game, p = g.player;
    if (!this.index.enabled) return false;
    const len = Math.hypot(fx, fy);
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const wx = len ? (fy * sin + fx * cos) / len : 0;
    const wy = len ? (-fy * cos + fx * sin) / len : 0;
    let c = climbs.get(p);
    if (!c) {
      if (!len) return false;
      if (this.unstick(p)) return false;
      const e = this.entryFor(p, wx, wy);
      if (!e) return false;
      c = this.attach(p, e.link, e.top, { lat: e.lat });
    }
    const l = c.link;
    const pt = l.path.at(c.s);
    const hx = Math.sin(pt.head), hy = -Math.cos(pt.head);
    // push along the path: forward input toward the facing climbs, away descends
    let f = wx * hx + wy * hy;
    if (Math.abs(f) < 0.2) f = 0;
    if (c.auto) {
      // the shortcut keys climb on their own until you push the other way
      if (f * c.auto < -0.3) c.auto = 0;
      else f = c.auto;
    }
    const ladder = l.kind === 'ladder';
    const running = p.running && p.canRun() && !ladder;
    // moveSpeed doubles when running; stairs keep less of that (and ladders none)
    let v = p.moveSpeed(100) * SPEED[l.kind];
    if (p.running && p.canRun()) v *= ladder ? 0.5 : RUN_ON_STAIRS;
    const ds = Math.sign(f) * Math.min(1, Math.abs(f) / 0.7) * v * dt;
    if (l.lane > 0 && len) {
      const lat = -wx * hy + wy * hx;
      c.lat = Math.max(-l.lane, Math.min(l.lane, c.lat + lat * v * dt));
    }
    const ox = p.x, oy = p.y;
    const end = ds ? this.advance(p, ds, running) : (this.place(p, c), null);
    // the view turns with a spiral (or while stepping off a ladder), so W stays "onward"
    const head = l.path.at(end === 'top' ? l.path.len : end === 'bottom' ? 0 : c.s).head;
    if (l.shape !== 'straight') p.yaw += head - c.head;
    c.head = head;
    if (ds) p.onMoved(Math.min(1, Math.hypot(p.x - ox, p.y - oy) + Math.abs(ds) * 0.5), ds > 0 ? 150 : 100);
    return true;
  }

  /** `<` / `>`: climb the nearest flight in that direction by itself. False if none is near. */
  autoClimb(w: Walker, up: boolean): boolean {
    if (!this.index.enabled) return false;
    const c = climbs.get(w);
    if (c) {
      c.auto = up ? 1 : -1;
      return true;
    }
    this.prepare();
    let best: { l: StairLink; d: number } | null = null;
    for (const l of this.index.all()) {
      if ((up ? l.z : l.z + 1) !== w.z) continue;
      const p = l.path.at(up ? 0 : l.path.len);
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d < 2.3 && (!best || d < best.d)) best = { l, d };
    }
    if (!best) return false;
    this.attach(w, best.l, !up, { auto: up ? 1 : -1 });
    return true;
  }

  /** Link a stair tile (x, y, z) belongs to (as flight, stairwell or plain tile), if any. */
  linkAt(x: number, y: number, z: number): StairLink | null {
    return this.index.at(x, y, z) ?? this.index.plainLink(x, y, z);
  }

  // --------------------------------------------------------------------- saving

  /** The player's climb as JSON (null when not on a flight). */
  saveState(): { key: number; z: number; s: number; lat: number; auto: number } | null {
    const c = climbs.get(this.game.player);
    return c ? { key: c.link.key, z: c.link.z, s: c.s, lat: c.lat, auto: c.auto } : null;
  }

  /** Restore a saved climb: re-solve the flight and put the player back on it. */
  loadState(st: { key: number; z: number; s: number; lat: number; auto: number } | null): void {
    const p = this.game.player;
    climbs.delete(p);
    this.riding.delete(p);
    if (!st || !this.index.enabled) return;
    this.prepare();
    const l = [...this.index.all()].find((k) => k.key === st.key && k.z === st.z);
    if (!l) {
      // the flight has another shape now (other variant): stand on the nearer landing
      this.unstick(p);
      return;
    }
    const c = this.attach(p, l, false, { lat: st.lat, auto: st.auto });
    c.bx = c.by = 0;
    c.s = Math.max(0, Math.min(l.path.len, st.s));
    this.place(p, c);
    c.head = l.path.at(c.s).head;
    c.tread = Math.floor(c.h / treadRise(l));
  }
}

/** Facing (player yaw convention) of direction index d. */
export const headingOf = (d: number) => HEADING[d];

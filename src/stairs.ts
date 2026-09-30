import type { Game } from './game/game';
import type { DebugApi } from './debug';
import type { MonsterSystem } from './game/monai';
import type { Monster } from './game/monster';
import { STAIR_VARIANTS, type StairVariant, type StairLink } from './game/stairs';
import { StairWalker, climbOf, isClimbing, liftOf } from './game/stairwalk';
import { stairHooks } from './game/zlevels';
import { registerSaveable } from './save/registry';
import { openDoor } from './game/interact';
import { L } from './game/moves';
import type { NpcSystem } from './game/npcai';
import type { Npc } from './game/npc';
import { moveWithCollision } from './game/physics';

// Wires walkable stairs (docs/STAIRS.md) into the game: the variant switch (`?stairs=`,
// Options > Stairs, cdda.stairs.setVariant), the player's movement hook, the `<` / `>`
// shortcut, falling, monsters following you up and down, saving mid-climb and the debug API.
// The renderer side (models, stairwell, camera lift, footsteps) is render/stairs/install.ts.

const STORE_KEY = 'cdda3d.stairs';
const LABEL: Record<StairVariant, string> = { flight: 'Flights', compact: 'Compact', classic: 'Classic' };

function initialVariant(): StairVariant {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('stairs') : null;
  if (q) {
    if (!STAIR_VARIANTS.includes(q as StairVariant)) throw new Error(`?stairs must be one of ${STAIR_VARIANTS.join('|')}, got ${q}`);
    return q as StairVariant;
  }
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    if (s && STAIR_VARIANTS.includes(s as StairVariant)) return s as StairVariant;
  } catch { /* storage blocked: default */ }
  return 'flight';
}

export function storeStairVariant(v: StairVariant): void {
  try {
    localStorage.setItem(STORE_KEY, v);
  } catch { /* storage blocked */ }
}

export const STAIR_LABEL = LABEL;

/** Seconds after a player's trip that chasing monsters still head for that flight. */
const FOLLOW_WINDOW = 25;
/** A chaser that saw you this recently follows you onto a flight. */
const FOLLOW_MEMORY = 12;

export interface StairsHandle {
  walker: StairWalker;
  setVariant(v: StairVariant, persist?: boolean): void;
  /** called after a variant change (the renderer rebuilds meshes) */
  onVariant: ((v: StairVariant) => void)[];
}

export function installStairs(game: Game, opts: { monsters?: MonsterSystem; api?: DebugApi; variant?: StairVariant } = {}): StairsHandle {
  const walker = new StairWalker(game, opts.variant ?? initialVariant());
  game.map.overlays.push(walker.overlay);
  game.stairStep = (fx, fy, dt) => walker.playerStep(fx, fy, dt);
  stairHooks.climbing = (w) => isClimbing(w);
  let doorMsgAt = -10;
  walker.openDoor = (w, x, y, z) => {
    const why = openDoor(game, x, y, z);
    // the player hears why they are stuck on the top step (once in a while, not every tick)
    if (why && w === game.player && walker.time - doorMsgAt > 3) {
      doorMsgAt = walker.time;
      game.message(why);
    }
    return why;
  };
  stairHooks.auto = (dir) => walker.autoClimb(game.player, dir === 'up');
  game.systems.push({
    name: 'stairs',
    update(_g, dt) {
      walker.time += dt;
      walker.prepare();
    },
  });

  // --- monsters: follow the survivor up and down the flight they took
  const wants = new WeakMap<Monster, { link: StairLink; up: boolean }>();
  // the player's trip is known the moment they set foot on a flight
  walker.onAttach.push((w, link, up) => {
    if (w === game.player) walker.lastTrip = { link, up, time: walker.time };
  });
  const sys = opts.monsters;
  if (sys) {
    sys.stairs = {
      busy: (m) => isClimbing(m),
      fall(m) {
        if (isClimbing(m)) walker.detach(m, false);
        wants.delete(m);
      },
      drive(m, dt) {
        const c = climbOf(m);
        if (c) {
          const kind = c.link.kind;
          const v = m.moveSpeed(100) * (kind === 'ladder' ? 0.38 : kind === 'slope' ? 0.85 : 0.72);
          const dir = c.auto || 1;
          const ox = m.x, oy = m.y;
          walker.advance(m, dir * v * dt);
          const cc = climbOf(m);
          const head = c.link.path.at(c.s).head + (dir < 0 ? Math.PI : 0);
          m.facing = head;
          m.moving = true;
          m.walkPhase += (Math.hypot(m.x - ox, m.y - oy) + v * dt * 0.5) * 3;
          m.vx = m.vy = 0;
          if (!cc) wants.delete(m);
          return true;
        }
        const want = wants.get(m);
        if (!want) return false;
        const l = want.link;
        if (m.z !== (want.up ? l.z : l.z + 1) || !walker.index.at(l.tiles[0][0], l.tiles[0][1], l.z)) {
          wants.delete(m);
          return false;
        }
        const e = l.path.at(want.up ? 0 : l.path.len);
        if (Math.hypot(m.x - e.x, m.y - e.y) < 0.5) {
          walker.attach(m, l, !want.up, { auto: want.up ? 1 : -1 });
          return true;
        }
        return false;
      },
      plan(m, brain) {
        const p = game.player;
        const trip = walker.lastTrip;
        if (!trip || p.dead || m.friendly || m.attitude() !== 'attack') {
          wants.delete(m);
          return;
        }
        const from = trip.up ? trip.link.z : trip.link.z + 1;
        // chase across levels: the survivor is on the flight or went up/down it lately
        const onIt = climbOf(p)?.link === trip.link;
        const gone = p.z !== m.z && p.z === (trip.up ? trip.link.z + 1 : trip.link.z) && walker.time - trip.time < FOLLOW_WINDOW;
        if (m.z !== from || !(onIt || gone) || m.lastSeenAge > FOLLOW_MEMORY) {
          wants.delete(m);
          return;
        }
        const e = trip.link.path.at(trip.up ? 0 : trip.link.path.len);
        if (Math.hypot(m.x - e.x, m.y - e.y) > 30) return;
        brain.goal = 'chase';
        brain.gx = e.x;
        brain.gy = e.y;
        brain.speedMul = 1;
        wants.set(m, { link: trip.link, up: trip.up });
      },
    };
  }

  // what you drop on a flight tumbles down to its foot (not onto a stairwell's thin air)
  const ground = game.player.groundLoc;
  game.player.groundLoc = () => {
    const c = climbOf(game.player);
    if (!c) return ground?.() ?? null;
    const [bx, by] = c.link.bottom[0];
    return L.ground(game.map, bx, by, c.link.z);
  };

  // --- saving mid-climb
  registerSaveable(game, 'stairs', {
    order: 12,
    save: () => walker.saveState(),
    load: (data) => walker.loadState(data as ReturnType<StairWalker['saveState']>),
    missing: () => walker.loadState(null),
  });

  const handle: StairsHandle = {
    walker,
    onVariant: [],
    setVariant(v, persist = false) {
      walker.setVariant(v);
      if (persist) storeStairVariant(v);
      for (const f of handle.onVariant) f(v);
    },
  };

  // --- automation
  if (opts.api) {
    const api = opts.api as DebugApi & Record<string, unknown>;
    api.stairs = {
      variant: () => walker.variant,
      setVariant: (v: StairVariant) => (handle.setVariant(v), v),
      /** Links near the player (shape, run, landings, footprint) */
      near: (r = 30) => {
        const p = game.player;
        walker.prepare();
        return [...walker.index.all()]
          .filter((l) => Math.abs(l.tiles[0][0] - p.x) < r && Math.abs(l.tiles[0][1] - p.y) < r && Math.abs(l.z - p.z) <= 1)
          .map((l) => describe(l));
      },
      /** The link at a tile (flight, well or plain tile). */
      at: (x: number, y: number, z: number) => {
        walker.index.ensureAround(x, y, z, 1);
        const l = walker.linkAt(x, y, z);
        return l ? describe(l) : null;
      },
      /** The player's climb: s, path length, height, lift, level. */
      climb: () => {
        const c = climbOf(game.player);
        return c ? { key: c.link.key, shape: c.link.shape, s: c.s, len: c.link.path.len, h: c.h, lift: c.lift, z: game.player.z, auto: c.auto, held: c.held } : null;
      },
      liftOf: (w: object) => liftOf(w),
      /** Stand at a flight's bottom (or top) landing facing onto it (tests, screenshots). */
      standAt: (x: number, y: number, z: number, top = false) => {
        walker.index.ensureAround(x, y, z, 1);
        const l = walker.linkAt(x, y, z) ?? walker.linkAt(x, y, z + 1);
        if (!l) return null;
        const p = game.player;
        const e = l.path.at(top ? l.path.len : 0);
        p.x = e.x;
        p.y = e.y;
        p.z = top ? l.z + 1 : l.z;
        p.yaw = e.head + (top ? Math.PI : 0);
        return describe(l);
      },
    };
  }
  return handle;
}

/**
 * Followers take the flight too: when the survivor changes level over a flight, a following
 * NPC walks to its foot (or top) and climbs it instead of appearing next to them.
 */
export function installStairNpcs(game: Game, stairs: StairsHandle, npcs: NpcSystem): void {
  const walker = stairs.walker;
  const wants = new WeakMap<Npc, { link: StairLink; up: boolean; t: number }>();
  npcs.stairs = {
    follow(n) {
      const trip = walker.lastTrip;
      if (!trip || walker.time - trip.time > 30) return false;
      if (n.z !== (trip.up ? trip.link.z : trip.link.z + 1)) return false;
      wants.set(n, { link: trip.link, up: trip.up, t: 0 });
      return true;
    },
    drive(n, dt) {
      const c = climbOf(n);
      const v = 3 * 0.72;
      if (c) {
        const dir = c.auto || 1;
        walker.advance(n, dir * v * dt);
        n.facing = c.link.path.at(c.s).head + (dir < 0 ? Math.PI : 0);
        n.moving = true;
        n.walkPhase += v * dt * 1.5;
        return true;
      }
      const w = wants.get(n);
      if (!w) return false;
      const l = w.link;
      const e = l.path.at(w.up ? 0 : l.path.len);
      const d = Math.hypot(e.x - n.x, e.y - n.y);
      w.t += dt;
      if (d < 0.45 || w.t > 6) {
        // (stuck behind something for 6 s: step onto the flight anyway)
        wants.delete(n);
        walker.attach(n, l, !w.up, { auto: w.up ? 1 : -1 });
        return true;
      }
      const ox = n.x, oy = n.y;
      const step = Math.min(d, 3 * dt);
      [n.x, n.y] = moveWithCollision(game.map, n.x, n.y, n.z, ((e.x - n.x) / d) * step, ((e.y - n.y) / d) * step);
      n.facing = Math.atan2(n.x - ox, -(n.y - oy));
      n.moving = true;
      n.walkPhase += step * 1.5;
      return true;
    },
  };
}

function describe(l: StairLink) {
  const b = l.path.at(0), t = l.path.at(l.path.len);
  return {
    key: l.key, x: l.tiles[0][0], y: l.tiles[0][1], z: l.z, kind: l.kind, shape: l.shape, ter: l.terId, run: l.run, width: l.width,
    sweepDeg: l.spiral ? Math.round((l.spiral.sweep * 180) / Math.PI) : undefined, dIn: l.dIn, dOut: l.dOut,
    bottom: l.bottom, top: l.top, footprint: l.lower, plain: l.plain, len: +l.path.len.toFixed(2),
    start: { x: +b.x.toFixed(2), y: +b.y.toFixed(2) }, end: { x: +t.x.toFixed(2), y: +t.y.toFixed(2) },
  };
}

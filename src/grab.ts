import type { Game } from './game/game';
import type { DebugApi } from './debug';
import type { Renderer } from './render/renderer';
import { ACTION_SCALE } from './core/time';
import { grab, grabbedMove, grabbedName, grabbedTile, grabState, grabTarget, release, setGrabState, type GrabStep } from './game/grab';
import { targetTile, frontTile } from './game/targeting';
import { interactionProviders } from './game/interact';
import { registerSaveable } from './save/registry';
import { hud } from './ui/hud';
import { worldContextProviders } from './ui2/world';
import { installGrabView, type GrabView } from './render/grabView';
import { vehiclePartMenuExtras } from './ui/vehicle_ui';
import type { Vehicle } from './game/vehicle';

// Grab and drag in real time (BN `G`; rules in src/game/grab.ts, docs/ADAPTATION.md "Grab").
// BN moves furniture a tile per turn; here holding something turns walking into tile steps:
// WASD (relative to where you look, snapped to 8 directions) asks for one step, the rules decide
// what moves, and the step plays out over the BN time it cost (your walk + the drag's moves) with
// you gliding tile to tile behind it, the furniture model sliding (render/grabView.ts), a cart
// rolling. Mouse look stays free. The grab key lets go; so do stairs, driving, sleep and death.

/** A step animation: the player (and a vehicle) glide between tile poses. */
interface Anim {
  t: number;
  dur: number;
  from: [number, number];
  to: [number, number];
  veh?: { v: Vehicle; from: [number, number, number]; to: [number, number, number] };
}

export interface GrabHandle {
  toggle(): void;
  view: GrabView | null;
}

const lerpAngle = (a: number, b: number, k: number) => a + ((((b - a) % 360) + 540) % 360 - 180) * k;

export function installGrab(game: Game, renderer: Renderer | null, api?: DebugApi): GrabHandle {
  const view = renderer ? installGrabView(renderer, game.map) : null;
  const p = game.player;
  let anim: Anim | null = null;
  /** The tile you stand on while holding it (anything else moving you lets go). */
  let anchor: [number, number, number] | null = null;
  /** A step that went nowhere: wait for the keys to change before bumping again (no spam). */
  let bumped: string | null = null;
  let banner = '';

  // Holding something takes over walking. Composed with whatever else claims movement
  // (driving sets game.movementOverride directly), and every system that asks "is movement
  // overridden?" (side-step, guard, swimming) sees the grab too.
  let inner = game.movementOverride;
  Object.defineProperty(game, 'movementOverride', {
    configurable: true,
    get: () => () => grabState(game) !== null || !!inner?.(),
    set: (f: (() => boolean) | null) => { inner = f; },
  });

  const letGo = (msg?: string | null) => {
    const m = msg === undefined ? release(game) : (release(game), msg);
    if (m) game.message(m);
    finishAnim();
    anchor = null;
    bumped = null;
  };

  const snapTo = (x: number, y: number) => {
    p.x = x + 0.5;
    p.y = y + 0.5;
  };

  const finishAnim = () => {
    if (!anim) return;
    [p.x, p.y] = anim.to;
    if (anim.veh) {
      const { v, to } = anim.veh;
      [v.x, v.y, v.facing] = to;
      game.vehicles?.reindex(v);
    }
    anim = null;
  };

  const toggle = () => {
    if (grabState(game)) return letGo();
    if (p.dead || p.isAsleep()) return;
    if (game.vehicles?.driving) return game.message("You can't grab anything while driving.", 'c_light_gray');
    // What you aim at, else what's in front of you (a low cart under the crosshair's line)
    const cands = [targetTile(game), frontTile(game)].filter((t): t is NonNullable<typeof t> => !!t);
    let why = "There's nothing to grab there!";
    for (const t of cands) {
      const r = grabTarget(game, t.x, t.y, t.z);
      if ('reason' in r) {
        if (t === cands[0]) why = r.reason;
        continue;
      }
      const res = grab(game, t.x, t.y, t.z);
      game.message(res.msg);
      if (res.ok) {
        anchor = [p.tileX, p.tileY, p.z];
        // step onto the middle of your tile: every drag step starts from a tile centre
        anim = { t: 0, dur: 0.12, from: [p.x, p.y], to: [p.tileX + 0.5, p.tileY + 0.5] };
      }
      return;
    }
    game.message(why, 'c_light_gray');
  };
  game.keys.register('grab', 'Grab / let go (walk to push or pull furniture and carts)', toggle);

  /** 8-way step from WASD relative to the view (null = no key). */
  const wantedStep = (): [number, number] | null => {
    const k = game.input.held;
    let fx = 0, fy = 0;
    if (k.has('KeyW')) fy += 1;
    if (k.has('KeyS')) fy -= 1;
    if (k.has('KeyD')) fx += 1;
    if (k.has('KeyA')) fx -= 1;
    if (!fx && !fy) return null;
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const wx = fy * sin + fx * cos, wy = -fy * cos + fx * sin;
    const oct = Math.round(Math.atan2(wy, wx) / (Math.PI / 4));
    const a = oct * (Math.PI / 4);
    return [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
  };

  const startStep = (dx: number, dy: number, r: GrabStep) => {
    const x0 = p.tileX, y0 = p.tileY;
    const walks = !r.handled && game.map.passable(x0 + dx, y0 + dy, p.z);
    const cost = walks ? (game.map.terAt(x0 + dx, y0 + dy, p.z).move_cost || 2) * 50 : 0;
    const speed = walks ? p.moveSpeed(cost) : 1;
    // BN: the drag's moves come on top of your walk; moves → seconds at your speed
    const dur = (walks ? 1 / Math.max(0.05, speed) : 0) + r.moves / (Math.max(1, p.speed) * ACTION_SCALE);
    anim = { t: 0, dur: Math.max(0.12, dur), from: [p.x, p.y], to: walks ? [x0 + dx + 0.5, y0 + dy + 0.5] : [p.x, p.y] };
    if (walks) {
      anchor = [x0 + dx, y0 + dy, p.z];
      // BN: pulling something on wheels burns half the walking stamina
      p.onMoved(r.wheeled ? 0.5 : 1, cost);
    }
    if (r.vehicle) {
      const { v, from, to } = r.vehicle;
      anim.veh = { v, from, to };
      [v.x, v.y, v.facing] = from; // rolled from here by the animation (its tiles are already reserved)
    }
    if (r.furniture) view?.slide(r.furniture.id, r.furniture.from, r.furniture.to, anim.dur);
    if (!walks && !r.furniture && !r.vehicle) bumped = `${dx},${dy}`;
    if (r.released) {
      anchor = null;
      if (!walks) anim = null;
    }
  };

  game.systems.push({
    name: 'grab',
    update: (_g, realDt) => {
      const g = grabState(game);
      if (!g) {
        if (anim) finishAnim();
        return;
      }
      // things that end a grab (BN releases on the same)
      if (p.dead || p.isAsleep() || game.vehicles?.driving || (anchor && anchor[2] !== p.z)) return letGo();
      if (!anim && anchor && (p.tileX !== anchor[0] || p.tileY !== anchor[1])) return letGo(`You let go of the ${grabbedName(game) ?? 'thing you were holding'}.`);
      if (anim) {
        anim.t = Math.min(anim.dur, anim.t + realDt);
        const k = anim.t / anim.dur;
        p.x = anim.from[0] + (anim.to[0] - anim.from[0]) * k;
        p.y = anim.from[1] + (anim.to[1] - anim.from[1]) * k;
        if (anim.veh) {
          const { v, from, to } = anim.veh;
          v.x = from[0] + (to[0] - from[0]) * k;
          v.y = from[1] + (to[1] - from[1]) * k;
          v.facing = ((lerpAngle(from[2], to[2], k) % 360) + 360) % 360;
        }
        if (anim.t >= anim.dur) finishAnim();
        return;
      }
      if (game.input.captured && !game.input.menuWalk) return;
      // (normal walking, which reads Shift, is off while holding something)
      p.running = (game.input.held.has('ShiftLeft') || game.input.held.has('ShiftRight')) && !game.runVeto?.();
      const d = wantedStep();
      if (!d) {
        bumped = null;
        return;
      }
      const key = `${d[0]},${d[1]}`;
      if (bumped === key) return;
      bumped = null;
      if (!grabbedTile(game)) return letGo();
      const r = grabbedMove(game, d[0], d[1]);
      startStep(d[0], d[1], r);
    },
  });

  // "Holding the dresser — walk to push or pull · [G] let go"
  game.systems.push({
    name: 'grab-hud',
    update: () => {
      const name = grabState(game) ? grabbedName(game) : null;
      const straining = anim && anim.dur > 2 ? `Straining… ${Math.ceil(anim.dur - anim.t)} s` : '';
      const text = name ? `Holding the ${name}|${straining}` : '';
      if (text === banner) return;
      banner = text;
      const key = game.keys.label('grab');
      hud.setBanner('grab', name ? { text: `Holding the ${name}`, sub: straining || `Walk to push or pull · [${key}] let go`, tone: straining ? 'warn' : 'info', small: !straining } : null);
    },
  });

  // `o` on furniture / a vehicle next to you
  worldContextProviders.push((t) => {
    if (t.kind !== 'furniture' && t.kind !== 'vehicle') return [];
    if (grabState(game)) {
      const gt = grabbedTile(game);
      return gt && gt[0] === t.x && gt[1] === t.y ? [{ label: `Let go of the ${grabbedName(game)}`, key: game.keys.keyFor('grab'), time: 0, action: () => letGo() }] : [];
    }
    const r = grabTarget(game, t.x, t.y, t.z);
    if ('reason' in r) return [];
    return [{ label: `Grab the ${r.name} (drag it)`, key: game.keys.keyFor('grab'), time: 0, action: () => grabAt(t.x, t.y, t.z) }];
  });

  const grabAt = (x: number, y: number, z: number) => {
    if (grabState(game)) letGo();
    const res = grab(game, x, y, z);
    game.message(res.msg);
    if (res.ok) {
      anchor = [p.tileX, p.tileY, p.z];
      anim = { t: 0, dur: 0.12, from: [p.x, p.y], to: [p.tileX + 0.5, p.tileY + 0.5] };
    }
  };

  // `e` menus: furniture (only where `e` already offers a choice: src/game/interact.ts keeps a
  // lone action one key press) and a vehicle part's menu
  interactionProviders.push((g, x, y, z) => {
    if (grabState(g) || g.map.furnAt(x, y, z).id === 'f_null') return [];
    const r = grabTarget(g, x, y, z);
    if ('reason' in r || r.kind !== 'furniture') return [];
    return [{ id: 'grab', label: `Grab the ${r.name} (drag it)`, run: () => grabAt(x, y, z) }];
  });
  vehiclePartMenuExtras.push((g, v, mx, my) => {
    const [wx, wy] = v.mountToWorld(mx, my);
    const x = Math.floor(wx), y = Math.floor(wy);
    const r = grabTarget(g, x, y, v.z);
    if ('reason' in r) return [];
    return [{ label: `Grab the ${v.name} (push it by hand)`, hotkey: 'G', value: () => grabAt(x, y, v.z) }];
  });

  // Saved mid-drag: the grab point relative to the player (loads after the player, map, vehicles)
  registerSaveable(game, 'grab', {
    order: 60,
    save: () => grabState(game),
    load: (j, ctx) => {
      finishAnim();
      setGrabState(game, null);
      anchor = null;
      if (!j) return;
      const s = j as { kind?: unknown; dx?: unknown; dy?: unknown };
      if ((s.kind !== 'furniture' && s.kind !== 'vehicle') || typeof s.dx !== 'number' || typeof s.dy !== 'number') {
        ctx.warn(`grab: dropped a malformed grab ${JSON.stringify(j)}`);
        return;
      }
      setGrabState(game, { kind: s.kind, dx: s.dx, dy: s.dy });
      if (!grabbedName(game)) {
        ctx.warn('grab: nothing at the saved grab point, let go');
        setGrabState(game, null);
        return;
      }
      anchor = [p.tileX, p.tileY, p.z];
      snapTo(p.tileX, p.tileY);
    },
    missing: () => {
      setGrabState(game, null);
      anchor = null;
    },
  });

  if (api) {
    api.grab = {
      state: () => ({ grab: grabState(game), name: grabbedName(game), tile: grabbedTile(game), animating: !!anim, standIns: view?.active() ?? 0 }),
      toggle,
      at: (x: number, y: number) => grabAt(x, y, p.z),
      release: () => letGo(),
    };
  }
  return { toggle, view };
}

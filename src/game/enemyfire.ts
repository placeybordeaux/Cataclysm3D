import type { Game, GameSystem } from './game';
import { CREATURE_RADIUS } from './physics';
import { arcHump, GRAVITY } from './rangedfeel';
import { LEVEL_HEIGHT } from '../world/coords';

// Rounds fired *by* monsters and NPCs (combat round 3): every bullet, arrow, bolt and stone is
// a real thing in the air that the player can see coming and see miss. The shooter still rolls
// BN's dispersion for the direction (monguns.ts / npcai.ts), so enemy accuracy is BN's; this
// module only flies the round along that direction at a readable speed and resolves it against
// whatever it actually reaches — a wall (so cover works), the survivor, an NPC, a monster — and
// tells the survivor about rounds that pass close (the near-miss cue: a zip and a flinch).
//
// Pure game logic (no three.js): src/render/enemyFireFx.ts draws `rounds`, src/aim.ts plays the
// near-miss cue. One EnemyFire per game, created on first use (enemyFireOf).
//
// Arrows, bolts, stones and grenades fly on the same gravity arc as the survivor's own arrows
// (`arc`, rangedfeel.arcHump): they rise and meet the line to what they were aimed at exactly at
// that distance, so the shooter's BN hit odds are unchanged, then keep falling past it. Bullets
// stay straight. BN itself has no drop (projectiles fly straight on the tile grid); the arc is
// the port's picture of the flight, as for the survivor.
//
// Ceilings and roofs: BN's round flies level and lands where it was aimed, so the picture must not
// change that indoors. A lob under a ceiling is flattened (`ceilingSpeed`: launched faster, its
// apex kept 0.2 m under every ceiling over its path to the aim point), so it still comes down where
// BN puts it. What still meets a ceiling (a round past its aim point, a level change in the arc's
// way, an arc whose own line is at the ceiling) stops there like BN's "two floors in a row" rule
// (ballistics.cpp: a projectile changing level through a floor stops on its previous tile): it
// ends just under the ceiling ('ceiling'), so a grenade goes off there, on the shooter's level. An
// arc that rises over a wall into the level above (out of doors, over a one-storey building) flies
// on above the roof and lands on it, or collides with what stands up there.

export type RoundKind = 'bullet' | 'arrow' | 'stone' | 'grenade';

/** On-screen speeds (m/s): a bullet crosses 20 m in ~0.2 s — a visible streak, not a teleport. */
export const ROUND_SPEED: Record<RoundKind, number> = { bullet: 90, arrow: 40, stone: 14, grenade: 18 };

/**
 * On-screen speed (m/s) of a lobbed grenade aimed `dist` m away: picked from a flight time so the
 * lob reads as a lob (a thrown one hangs ~1 s at 8 m, its apex ~1.2 m over the line; a launched
 * 40 mm round a little flatter and quicker). BN's ammo `speed` (80 for 40 mm) only feeds dodging.
 */
export function lobSpeed(how: 'thrown' | 'launched', dist: number): number {
  const t = how === 'thrown' ? Math.max(0.6, Math.min(1.6, 0.5 + dist / 15)) : Math.max(0.5, Math.min(1.5, 0.35 + dist / 30));
  return Math.max(6, Math.max(1, dist) / t);
}

/**
 * Is this a lobbed round? Thrown "guns" (skill throw: a SWAT zombie's tear gas grenade) and
 * grenade launchers (GRENADE_LAUNCHERS, or any launcher whose round is as slow as a 40 mm
 * grenade: BN ammo speed ≤ 100) lob; rockets and tank guns fly straight. Null = not lobbed.
 */
export function lobOf(gunDef: object, ammoDef: object | null | undefined, cls: string): 'thrown' | 'launched' | null {
  const gun = gunDef as { skill?: unknown; weapon_category?: unknown };
  const ammo = ammoDef as { speed?: unknown } | null | undefined;
  if (gun.skill === 'throw') return 'thrown';
  if (cls !== 'launcher') return null;
  const cats = ([] as unknown[]).concat(gun.weapon_category ?? []);
  // BN ammo speed defaults to 1000 (item_factory load_ammo) when the round doesn't say.
  if (cats.includes('GRENADE_LAUNCHERS') || (typeof ammo?.speed === 'number' ? ammo.speed : 1000) <= 100) return 'launched';
  return null;
}

export interface Body {
  x: number;
  y: number;
  z: number;
  dead?: boolean;
  radius?: number;
}

export interface EnemyRound {
  kind: RoundKind;
  /** Where it left (absolute: x east, y south, h up) and its unit direction. */
  x0: number;
  y0: number;
  h0: number;
  dx: number;
  dy: number;
  dh: number;
  z: number;
  speed: number;
  /** Metres flown so far and the most it flies. */
  s: number;
  maxS: number;
  /** The shooter (never hit by its own round). */
  from: unknown;
  /** Bodies the round passes through: BN skips creatures friendly to the shooter within one tile of it. */
  spares?: (b: unknown) => boolean;
  /** What it can hit, and what happens when it does (missedBy = plan distance / body radius, 0..1). */
  onPlayer?: (missedBy: number) => void;
  onNpc?: (n: Body, missedBy: number) => void;
  onMonster?: (m: Body, missedBy: number) => void;
  onStop?: (x: number, y: number, what: 'wall' | 'ground' | 'ceiling' | 'range') => void;
  /** A gravity arc that meets the aim line `aimDist` m (plan) from the launch point; absent = straight. */
  arc?: { aimDist: number };
  /**
   * Called once when the round ends, however it ends, with where (for a blast: BN explodes it
   * there) and the level it ended on (an arc can carry a round onto a roof).
   */
  onEnd?: (x: number, y: number, h: number, what: 'body' | 'wall' | 'ground' | 'ceiling' | 'range', z: number) => void;
  /** The level the round is flying through now (starts at `z`; an arc can rise into the next). */
  level?: number;
  /** Already cued a near miss / done. */
  whizzed?: boolean;
  done?: boolean;
}

/** Heights of a standing / crouching survivor and of other bodies (m). */
const PLAYER_H = 1.8, PLAYER_CROUCH_H = 1.2, BODY_H = 1.8;
/** Bullets passing within this (m, plan) of the survivor zip past audibly. */
export const NEAR_MISS = 1.4;

export class EnemyFire implements GameSystem {
  readonly name = 'enemy-fire';
  readonly rounds: EnemyRound[] = [];
  constructor(readonly game: Game) {}

  /**
   * Fire a round from (x, y, h) toward (tx, ty, th) turned `yawOff` rad sideways (the BN
   * dispersion the shooter rolled); it flies on past the aim point up to `range` m.
   */
  fire(o: Omit<EnemyRound, 'x0' | 'y0' | 'h0' | 'dx' | 'dy' | 'dh' | 's' | 'maxS' | 'speed' | 'arc'> & {
    x: number; y: number; h: number; tx: number; ty: number; th: number; yawOff: number; range: number; speed?: number;
    /** Fly a gravity arc that meets (tx, ty, th) instead of a straight line. */
    arc?: boolean;
  }): EnemyRound {
    const d = Math.max(0.01, Math.hypot(o.tx - o.x, o.ty - o.y));
    const yaw = Math.atan2(o.tx - o.x, -(o.ty - o.y)) + o.yawOff;
    // Horizontal error only (as BN's 2D dispersion): it passes at the aimed height.
    const slope = (o.th - o.h) / d;
    const n = Math.hypot(1, slope);
    const r: EnemyRound = {
      ...o, x0: o.x, y0: o.y, h0: o.h, dx: Math.sin(yaw) / n, dy: -Math.cos(yaw) / n, dh: slope / n, s: 0,
      maxS: Math.max(1, o.range) * n, speed: o.speed ?? ROUND_SPEED[o.kind],
      arc: o.arc ? { aimDist: d } : undefined,
    };
    if (r.arc) r.speed = Math.max(r.speed, ceilingSpeed(this.game, r));
    this.rounds.push(r);
    return r;
  }

  /** Where a round is now. */
  static at(r: EnemyRound, s = r.s): { x: number; y: number; h: number } {
    const hump = r.arc ? arcHump(s * Math.hypot(r.dx, r.dy), r.arc.aimDist, r.speed) : 0;
    return { x: r.x0 + r.dx * s, y: r.y0 + r.dy * s, h: r.h0 + r.dh * s + hump };
  }

  update(_game: Game, dt: number): void {
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      this.step(r, dt);
      if (r.done) this.rounds.splice(i, 1);
    }
  }

  /** Advance one round by dt: the first wall, floor or body on the way stops it. */
  step(r: EnemyRound, dt: number): void {
    const game = this.game;
    const s0 = r.s, s1 = Math.min(r.maxS, s0 + r.speed * dt);
    const plan = Math.hypot(r.dx, r.dy) || 1;
    // Walls, floors, ceilings and roofs: march the segment tile by tile and level by level.
    let stopS = Infinity, stopWhat: 'wall' | 'ground' | 'ceiling' = 'wall';
    let lastTx = NaN, lastTy = NaN;
    let level = r.level ?? r.z;
    for (let s = s0; s <= s1; s += 0.1) {
      const p = EnemyFire.at(r, s);
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      const lv = Math.floor(p.h / LEVEL_HEIGHT);
      if (lv > level) {
        // Rising into the level above: its floor is this level's ceiling.
        if (game.map.hasFloor(tx, ty, level + 1)) {
          stopS = s;
          stopWhat = 'ceiling';
          break;
        }
        level = lv;
        lastTx = NaN;
      } else if (lv < level) {
        // Coming down onto this level's floor (the ground, a roof), or through open air below.
        if (game.map.hasFloor(tx, ty, level) || level <= r.z) {
          stopS = s;
          stopWhat = 'ground';
          break;
        }
        level = lv;
        lastTx = NaN;
      }
      if (tx === lastTx && ty === lastTy) continue;
      lastTx = tx;
      lastTy = ty;
      if (s > 0.6 && !game.map.passable(tx, ty, level) && game.map.opaque(tx, ty, level)) {
        stopS = s;
        stopWhat = 'wall';
        break;
      }
    }
    r.level = level;
    const end = Math.min(s1, stopS);
    // Bodies: closest approach in plan within this stretch, at a height the body covers.
    type Hit = { s: number; player: boolean; apply: () => void };
    let best: Hit | null = null;
    const test = (b: Body, height: number, radius: number, apply: (missedBy: number) => void) => {
      if (b === r.from || b.dead || b.z !== r.z || r.spares?.(b)) return;
      const ox = b.x - r.x0, oy = b.y - r.y0;
      const t = (ox * r.dx + oy * r.dy) / (plan * plan); // parameter s at closest approach
      if (t < s0 || t > end) return;
      const perp = Math.abs(ox * r.dy - oy * r.dx) / plan;
      if (perp > radius) return;
      const h = EnemyFire.at(r, t).h - b.z * 2.6;
      if (h < 0 || h > height) return;
      if (!best || t < best.s) best = { s: t, player: b === p, apply: () => apply(perp / radius) };
    };
    const p = game.player;
    const pr = CREATURE_RADIUS + 0.05;
    if (r.onPlayer && !p.dead) test(p, p.crouching ? PLAYER_CROUCH_H : PLAYER_H, pr, r.onPlayer);
    if (r.onNpc) for (const n of npcsOf(game)) test(n, BODY_H, CREATURE_RADIUS + 0.05, (mb) => r.onNpc!(n, mb));
    if (r.onMonster) for (const m of monstersOf(game)) test(m, BODY_H, (m.radius ?? 0.3) * 1.05, (mb) => r.onMonster!(m, mb));
    // Near miss: it goes past the survivor close by without hitting them.
    if (!r.whizzed && r.onPlayer && !p.dead && p.z === r.z) {
      const ox = p.x - r.x0, oy = p.y - r.y0;
      const t = (ox * r.dx + oy * r.dy) / (plan * plan);
      const perp = Math.abs(ox * r.dy - oy * r.dx) / plan;
      const stopped = best ? (best as Hit).s : Infinity;
      if (t >= s0 && t <= Math.min(end, stopped) && perp <= NEAR_MISS && !(best && (best as Hit).player)) {
        r.whizzed = true;
        const at = EnemyFire.at(r, t);
        game.events.emit('nearMiss', { x: at.x, y: at.y, z: r.z, dist: perp, kind: r.kind, side: Math.sign(ox * r.dy - oy * r.dx) || 1 });
      }
    }
    if (best) {
      r.s = (best as Hit).s;
      r.done = true;
      (best as Hit).apply();
      const at = EnemyFire.at(r, r.s);
      r.onEnd?.(at.x, at.y, at.h, 'body', r.z);
      return;
    }
    r.s = end;
    if (end >= stopS) {
      r.done = true;
      const at = EnemyFire.at(r, end);
      r.onStop?.(at.x, at.y, stopWhat);
      // BN ballistics.cpp: a round stopped by a wall ends on the tile before it; one stopped by a
      // ceiling, just under it on the level it flew on.
      const back = stopWhat === 'wall' ? EnemyFire.at(r, Math.max(0, end - 0.35)) : stopWhat === 'ceiling' ? { ...at, h: Math.min(at.h, (level + 1) * LEVEL_HEIGHT - 0.05) } : at;
      r.onEnd?.(back.x, back.y, back.h, stopWhat, level);
      return;
    }
    if (end >= r.maxS) {
      r.done = true;
      const at = EnemyFire.at(r, end);
      r.onStop?.(at.x, at.y, 'range');
      r.onEnd?.(at.x, at.y, at.h, 'range', r.level ?? r.z);
    }
  }
}

/** Room left (m) between an arc and a ceiling over it: the round's body and a little air. */
export const CEILING_CLEARANCE = 0.2;

/**
 * The slowest speed (m/s) at which `r`'s arc stays CEILING_CLEARANCE under the ceilings it flies
 * under on its way to the point it was aimed at (where it meets its line again): the apex of
 * arcHump = g·s(D−s)/(2v²) must fit under (ceiling − line height). The ceilings counted are those
 * over the stretch it leaves from (thrown from indoors) and the stretch it comes down in (lobbed
 * through a doorway into a room); a building in between, under open sky on both sides, is
 * something to lob over. 0 = no ceiling to keep under. A line already at a ceiling can't be
 * helped (the round meets it, see step).
 */
export function ceilingSpeed(game: Game, r: EnemyRound): number {
  if (!r.arc) return 0;
  const plan = Math.hypot(r.dx, r.dy) || 1;
  const D = Math.max(0.5, r.arc.aimDist);
  const samples: { ps: number; room: number | null }[] = [];
  for (let ps = 0.25; ps < D; ps += 0.25) {
    const s = ps / plan;
    const x = Math.floor(r.x0 + r.dx * s), y = Math.floor(r.y0 + r.dy * s), line = r.h0 + r.dh * s;
    const lv = Math.floor(line / LEVEL_HEIGHT);
    // Under a ceiling: a space the round could fly through, with a floor above it.
    const covered = game.map.passable(x, y, lv) && game.map.hasFloor(x, y, lv + 1);
    samples.push({ ps, room: covered ? (lv + 1) * LEVEL_HEIGHT - CEILING_CLEARANCE - line : null });
  }
  let need = 0;
  const fit = (q: { ps: number; room: number | null }) => {
    if (q.room === null || q.room <= 0.05) return;
    need = Math.max(need, Math.sqrt((GRAVITY * q.ps * (D - q.ps)) / (2 * q.room)));
  };
  for (const q of samples) {
    if (q.room === null) break;
    fit(q);
  }
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].room === null) break;
    fit(samples[i]);
  }
  return need;
}

function npcsOf(game: Game): Body[] {
  return ((game as unknown as { npcs?: { npcs: Body[] } }).npcs?.npcs ?? []).filter((n) => !n.dead);
}

function monstersOf(game: Game): Body[] {
  return ((game as unknown as { monsters?: { active: Body[] } }).monsters?.active ?? []).filter((m) => !m.dead);
}

const systems = new WeakMap<Game, EnemyFire>();

/** The game's enemy-fire system (created and added to game.systems on first use). */
export function enemyFireOf(game: Game): EnemyFire {
  let f = systems.get(game);
  if (!f) {
    f = new EnemyFire(game);
    systems.set(game, f);
    game.systems.push(f);
  }
  return f;
}

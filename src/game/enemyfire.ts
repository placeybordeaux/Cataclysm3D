import type { Game, GameSystem } from './game';
import { CREATURE_RADIUS } from './physics';

// Rounds fired *by* monsters and NPCs (combat round 3): every bullet, arrow, bolt and stone is
// a real thing in the air that the player can see coming and see miss. The shooter still rolls
// BN's dispersion for the direction (monguns.ts / npcai.ts), so enemy accuracy is BN's; this
// module only flies the round along that direction at a readable speed and resolves it against
// whatever it actually reaches — a wall (so cover works), the survivor, an NPC, a monster — and
// tells the survivor about rounds that pass close (the near-miss cue: a zip and a flinch).
//
// Pure game logic (no three.js): src/render/enemyFireFx.ts draws `rounds`, src/aim.ts plays the
// near-miss cue. One EnemyFire per game, created on first use (enemyFireOf).

export type RoundKind = 'bullet' | 'arrow' | 'stone';

/** On-screen speeds (m/s): a bullet crosses 20 m in ~0.2 s — a visible streak, not a teleport. */
export const ROUND_SPEED: Record<RoundKind, number> = { bullet: 90, arrow: 40, stone: 14 };

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
  /** What it can hit, and what happens when it does (missedBy = plan distance / body radius, 0..1). */
  onPlayer?: (missedBy: number) => void;
  onNpc?: (n: Body, missedBy: number) => void;
  onMonster?: (m: Body, missedBy: number) => void;
  onStop?: (x: number, y: number, what: 'wall' | 'ground' | 'range') => void;
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
  fire(o: Omit<EnemyRound, 'x0' | 'y0' | 'h0' | 'dx' | 'dy' | 'dh' | 's' | 'maxS' | 'speed'> & {
    x: number; y: number; h: number; tx: number; ty: number; th: number; yawOff: number; range: number; speed?: number;
  }): EnemyRound {
    const d = Math.max(0.01, Math.hypot(o.tx - o.x, o.ty - o.y));
    const yaw = Math.atan2(o.tx - o.x, -(o.ty - o.y)) + o.yawOff;
    // Horizontal error only (as BN's 2D dispersion): it passes at the aimed height.
    const slope = (o.th - o.h) / d;
    const n = Math.hypot(1, slope);
    const r: EnemyRound = {
      ...o, x0: o.x, y0: o.y, h0: o.h, dx: Math.sin(yaw) / n, dy: -Math.cos(yaw) / n, dh: slope / n, s: 0,
      maxS: Math.max(1, o.range) * n, speed: o.speed ?? ROUND_SPEED[o.kind],
    };
    this.rounds.push(r);
    return r;
  }

  /** Where a round is now. */
  static at(r: EnemyRound, s = r.s): { x: number; y: number; h: number } {
    return { x: r.x0 + r.dx * s, y: r.y0 + r.dy * s, h: r.h0 + r.dh * s };
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
    // Walls (and the floor): march the segment tile by tile.
    let stopS = Infinity, stopWhat: 'wall' | 'ground' = 'wall';
    let lastTx = NaN, lastTy = NaN;
    for (let s = s0; s <= s1; s += 0.1) {
      const p = EnemyFire.at(r, s);
      if (p.h - r.z * 2.6 <= 0) {
        stopS = s;
        stopWhat = 'ground';
        break;
      }
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      if (tx === lastTx && ty === lastTy) continue;
      lastTx = tx;
      lastTy = ty;
      if (s > 0.6 && !game.map.passable(tx, ty, r.z) && game.map.opaque(tx, ty, r.z)) {
        stopS = s;
        stopWhat = 'wall';
        break;
      }
    }
    const end = Math.min(s1, stopS);
    // Bodies: closest approach in plan within this stretch, at a height the body covers.
    type Hit = { s: number; player: boolean; apply: () => void };
    let best: Hit | null = null;
    const test = (b: Body, height: number, radius: number, apply: (missedBy: number) => void) => {
      if (b === r.from || b.dead || b.z !== r.z) return;
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
      return;
    }
    r.s = end;
    if (end >= stopS) {
      r.done = true;
      const at = EnemyFire.at(r, end);
      r.onStop?.(at.x, at.y, stopWhat);
      return;
    }
    if (end >= r.maxS) {
      r.done = true;
      const at = EnemyFire.at(r, end);
      r.onStop?.(at.x, at.y, 'range');
    }
  }
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

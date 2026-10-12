import { ACTION_SCALE } from '../core/time';
import type { GameData } from '../data/types';
import { Character } from './character';

// The avatar: a Character (stats, body, needs, inventory — src/game/character.ts) plus a
// position and view direction in the 3D world.

/** How far mouse-look tilts the view up or down (rad): a hair short of straight up/down. */
export const PITCH_LIMIT = 1.5;

export class PlayerAvatar extends Character {
  x = 9.5;
  y = 16.5;
  z = 0;
  // The view angles are guarded where they are set: a NaN pitch/yaw used to reach every view-ray
  // march (targeting.ts, the loot hover) as NaN tile coordinates, and generating a chunk and
  // overmap region "at NaN" ran the road A* forever until the tab died of OOM. A bad value now
  // throws at the assignment (the debug API caller, or the code that computed it), and pitch is
  // held to the mouse-look limit so a debug write can't leave it past straight up/down either.
  private _yaw = 0;
  private _pitch = 0;
  /** yaw 0 looks north (-y); positive yaw turns clockwise (toward east). */
  get yaw(): number {
    return this._yaw;
  }
  set yaw(v: number) {
    if (!Number.isFinite(v)) throw new Error(`player.yaw must be finite, got ${v}`);
    this._yaw = v;
  }
  /** Radians, up positive, held to ±PITCH_LIMIT. */
  get pitch(): number {
    return this._pitch;
  }
  set pitch(v: number) {
    if (!Number.isFinite(v)) throw new Error(`player.pitch must be finite, got ${v}`);
    this._pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, v));
  }
  /** Walk-speed multiplier from what the hands are doing (combat guard; set by PlayerCombat). */
  moveSpeedMul = 1;

  constructor(data: GameData, opts: { seed?: number } = {}) {
    super(data, opts);
    this.name = 'You';
  }

  /**
   * Tiles per real second for current movement mode. CDDA: tiles/turn = speed / move_cost;
   * run mode doubles speed (costs stamina), crouch halves it. Hurt legs (run_cost), leg
   * encumbrance and being downed slow you further.
   */
  moveSpeed(moveCost = 100): number {
    if (this.dead || this.isAsleep() || this.effects.has('downed')) return 0;
    const running = this.running && this.canRun();
    const modeMul = running ? 2 : this.crouching ? 0.5 : 1;
    let cost = Math.max(moveCost, 1);
    // Character::run_cost: damaged legs add up to 50 each; movecost_modifier mutations; flat
    // ground gets movecost_flatground_modifier (Fleet-Footed) + FLAT_MOVE_COST, obstacles
    // movecost_obstacle_modifier + OBSTACLE_MOVE_COST (never below 100).
    if (moveCost > 100) {
      cost *= this.mutationValue('movecost_obstacle_modifier');
      cost = Math.max(100, cost + this.enchantBonus('OBSTACLE_MOVE_COST', cost));
    }
    for (const leg of ['leg_l', 'leg_r'] as const) cost += 50 * (1 - this.hp[leg].cur / this.hp[leg].max);
    cost *= this.mutationValue('movecost_modifier');
    if (moveCost < 105) {
      cost *= this.mutationValue('movecost_flatground_modifier');
      cost += this.enchantBonus('FLAT_MOVE_COST', cost);
    }
    // BN run_cost: leg and foot encumbrance add a little, not a percentage (jeans + sneakers
    // ≈ +7 moves). A multiplier here made a dressed survivor walk no faster than a zombie.
    cost += ((this.inv.encumbrance('foot_l') + this.inv.encumbrance('foot_r')) * 2.5 + (this.inv.encumbrance('leg_l') + this.inv.encumbrance('leg_r')) * 1.5) / 10;
    cost = Math.max(20, this.byEnchant(cost, 'MOVE_COST'));
    return (this.speed / cost) * ACTION_SCALE * modeMul * this.moveSpeedMul;
  }

  /** Report `tiles` walked on terrain of `moveCost` so stamina drains like CDDA. */
  onMoved(tiles: number, moveCost = 100): void {
    const running = this.running && this.canRun();
    const moves = (tiles * moveCost) / (running ? 2 : this.crouching ? 0.5 : 1);
    this.burnMoveStamina(moves, running ? 'run' : this.crouching ? 'crouch' : 'walk');
    // Moving spoils your aim (CDDA resets recoil when you move).
    this.recoil = Math.min(3000, this.recoil + tiles * 300);
  }

  get tileX(): number {
    return Math.floor(this.x);
  }
  get tileY(): number {
    return Math.floor(this.y);
  }
}

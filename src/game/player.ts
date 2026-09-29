import { ACTION_SCALE } from '../core/time';

// Scaffold player: position + view direction. The survival/character systems (stats,
// body parts, needs, inventory) are layered on by src/game/character.ts.

export class PlayerAvatar {
  x = 9.5;
  y = 16.5;
  z = 0;
  /** yaw 0 looks north (-y); positive yaw turns clockwise (toward east). */
  yaw = 0;
  pitch = 0;
  /** CDDA speed stat; 100 = normal. */
  speed = 100;
  running = false;
  crouching = false;

  /** Tiles per real second for current movement mode. */
  moveSpeed(moveCost = 100): number {
    // CDDA: tiles/turn = speed / move_cost; run mode halves move cost (costs stamina).
    const modeMul = this.running ? 2 : this.crouching ? 0.5 : 1;
    return (this.speed / Math.max(moveCost, 1)) * ACTION_SCALE * modeMul;
  }
  get tileX(): number {
    return Math.floor(this.x);
  }
  get tileY(): number {
    return Math.floor(this.y);
  }
}

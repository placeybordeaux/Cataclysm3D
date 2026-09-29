import { EventBus } from '../core/events';
import { GameClock } from '../core/time';
import type { Input } from '../core/input';
import type { GameData } from '../data/types';
import { GameMap } from '../world/map';
import { PlayerAvatar } from './player';
import { moveWithCollision } from './physics';

// Game owns all simulation state and advances it with a fixed timestep; rendering and UI
// only read from it. Subsystems register via `systems` so features can be added without
// editing this file's update loop.

export const TICK = 1 / 30;

export interface GameSystem {
  name: string;
  /** realDt: seconds of real time; gameDt: game-clock seconds elapsed this tick. */
  update(game: Game, realDt: number, gameDt: number): void;
}

export class Game {
  readonly events = new EventBus();
  readonly clock = new GameClock();
  readonly map: GameMap;
  readonly player = new PlayerAvatar();
  readonly systems: GameSystem[] = [];
  paused = false;
  private acc = 0;
  mouseSensitivity = 0.0025;

  constructor(readonly data: GameData, readonly seed: number, readonly input: Input) {
    this.map = new GameMap(seed);
    for (const t of Object.values(data.terrain)) this.map.terrain.add(t);
    for (const f of Object.values(data.furniture)) this.map.furniture.add(f);
  }

  message(text: string, color?: string): void {
    this.events.emit('message', { text, color });
  }

  frame(realDt: number): void {
    // Mouse look is applied per frame (not per tick) so it stays perfectly smooth.
    const [mx, my] = this.input.consumeMouse();
    const p = this.player;
    p.yaw += mx * this.mouseSensitivity;
    p.pitch = Math.max(-1.5, Math.min(1.5, p.pitch - my * this.mouseSensitivity));
    if (this.paused) return;
    this.acc = Math.min(this.acc + realDt, 0.25);
    while (this.acc >= TICK) {
      this.tick(TICK);
      this.acc -= TICK;
    }
  }

  tick(dt: number): void {
    const gameDt = this.clock.advanceReal(dt);
    this.updatePlayerMovement(dt);
    for (const s of this.systems) s.update(this, dt, gameDt);
  }

  private updatePlayerMovement(dt: number): void {
    const p = this.player;
    const k = this.input.held;
    if (this.input.captured) return;
    let fx = 0, fy = 0;
    if (k.has('KeyW')) fy += 1;
    if (k.has('KeyS')) fy -= 1;
    if (k.has('KeyD')) fx += 1;
    if (k.has('KeyA')) fx -= 1;
    p.running = k.has('ShiftLeft');
    if (fx === 0 && fy === 0) return;
    const len = Math.hypot(fx, fy);
    fx /= len; fy /= len;
    // forward = (sin yaw, -cos yaw) in world (x east, y south)
    const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
    const wx = fy * sin + fx * cos;
    const wy = -fy * cos + fx * sin;
    const cost = this.map.moveCost(p.tileX, p.tileY, p.z) || 100;
    const v = p.moveSpeed(cost) * dt;
    [p.x, p.y] = moveWithCollision(this.map, p.x, p.y, p.z, wx * v, wy * v);
  }
}

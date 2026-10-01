import type { Game, GameSystem } from './game';
import { withPracticeSource } from './practice';

// Driving practice (BN character_turn.cpp, end of process_turn): every turn at the controls of a
// moving vehicle, one in eight, practice(driving, 1 + mass / 400 kg + |velocity| / 3200 vmiph),
// the fraction rolled. The port had driving as a skill but nothing trained it.

const MPS_TO_VMIPH = 223.694; // m/s → 1/100 mph (BN velocity units)

/** BN's experience for one driving practice roll (before the remainder roll). */
export function drivingExperience(massKg: number, velocityMps: number): number {
  return 1 + massKg / 400 + Math.abs(velocityMps * MPS_TO_VMIPH) / 3200;
}

export class DrivingPractice implements GameSystem {
  readonly name = 'drivingPractice';
  private acc = 0;
  update(game: Game, _realDt: number, gameDt: number): void {
    const v = game.vehicles?.driving;
    if (!v || Math.abs(v.velocity) < 0.5) {
      this.acc = 0;
      return;
    }
    const p = game.player;
    this.acc += gameDt;
    for (; this.acc >= 1; this.acc--) {
      if (!p.rng.oneIn(8)) continue;
      const exp = p.rollRemainder(drivingExperience(v.mass(), v.velocity));
      withPracticeSource(`Driving the ${v.name}`, () => p.practice('driving', exp));
    }
  }
}

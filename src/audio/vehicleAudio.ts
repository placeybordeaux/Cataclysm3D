import type { Voice } from './audio';
import { getAudioEngine } from './sfx';

// Vehicle sounds after CDDA sounds.cpp / vehicle_use.cpp:
//   - variants: engine_start / engine_stop / engine_working_* use the engine part id if the
//     pack has it (engine_v8), else electric / muscle / wind / combustion by fuel;
//   - engine loop: engine_working_internal while you drive (not positional), else
//     engine_working_external at the vehicle (do_vehicle_exterior_engine_sfx), pitched by
//     speed within CDDA's gears (do_vehicle_engine_sfx), with a gear_shift clunk on shifts;
//   - horn: vehicle/horn_loud|horn_medium|horn_low by the horn's loudness.
// Everything is a no-op until installAudio() has set the engine (tests, no audio).

/** What this module needs from a vehicle (src/game/vehicle.ts Vehicle satisfies it). */
export interface AudioVehicle {
  uid: number;
  x: number;
  y: number;
  z: number;
  /** m/s along the facing, negative = reversing */
  velocity: number;
  engineOn: boolean;
  readonly engines: { enabled: boolean; hp: number; def: { id: string; fuel_type?: string } }[];
  maxVelocity(safe?: boolean): number;
}

/** First variant of `id` the sound pack has, else the last one given (CDDA-style fallback chains). */
export function pickVariant(id: string, ...variants: string[]): string {
  const e = getAudioEngine();
  if (e) for (const v of variants) if (e.has(id, v, true)) return v;
  return variants[variants.length - 1];
}

/** CDDA engine sfx variant for a vehicle's first working engine. */
export function engineVariant(id: string, v: AudioVehicle): string {
  const e = v.engines.find((p) => p.enabled && p.hp > 0) ?? v.engines[0];
  if (!e) return 'combustion';
  const ft = e.def.fuel_type;
  const byFuel = ft === 'battery' ? 'electric' : ft === 'muscle' ? 'muscle' : ft === 'wind' ? 'wind' : 'combustion';
  return pickVariant(id, e.def.id, byFuel);
}

/** vehicle_use.cpp honk_horn: loud / medium / low horn by the part's bonus (loudness). */
export function hornVariant(bonus: number): string {
  const want = bonus >= 110 ? 'horn_loud' : bonus >= 80 ? 'horn_medium' : 'horn_low';
  // CC-Sounds only has the medium horn; any horn beats silence.
  return pickVariant('vehicle', want, 'horn_medium');
}

/** sounds.cpp gear thresholds as fractions of the safe speed; gear n spans [G[n-1], G[n]). */
const GEARS = [0, 1 / 12, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 1.3];

/** CDDA current_gear: -1 reverse, 0 standing, 1..6 by speed / safe speed. */
export function gearFor(velocity: number, safe: number): number {
  if (velocity <= -0.45) return -1;
  const s = Math.abs(velocity);
  if (s < 0.45 || safe <= 0) return 0;
  for (let g = 1; g < GEARS.length - 1; g++) if (s <= GEARS[g] * safe) return g;
  return 6;
}

/**
 * Loop playback rate: idle at 0.85, revving up through each gear and dropping back at the
 * shift (CDDA pitches its loop by speed too; a rising rev reads better than its falling one).
 */
export function engineRate(velocity: number, safe: number): number {
  const g = gearFor(velocity, safe);
  if (g === 0) return 0.85;
  if (g === -1) return 1.1;
  const s = Math.abs(velocity) / safe;
  const lo = GEARS[g - 1], hi = GEARS[g];
  const frac = Math.max(0, Math.min(1, (s - lo) / (hi - lo)));
  return 0.9 + 0.08 * g + 0.45 * frac;
}

interface Loop {
  voice: Voice;
  internal: boolean;
  safe: number;
  safeAge: number;
  gear: number;
}

/** Hear engines this far away at most (tiles); the nearest few play. */
const HEAR_TILES = 48;
const MAX_LOOPS = 3;

export class EngineSounds {
  private loops = new Map<AudioVehicle, Loop>();

  /** Per frame: keep a loop on the nearest running engines, following them and their revs. */
  update(list: readonly AudioVehicle[], listener: { x: number; y: number; z: number }, driving: AudioVehicle | null, dt: number): void {
    const eng = getAudioEngine();
    if (!eng) return;
    const want = list
      .filter((v) => v.engineOn && v.z === listener.z && Math.hypot(v.x - listener.x, v.y - listener.y) <= HEAR_TILES)
      .sort((a, b) => Math.hypot(a.x - listener.x, a.y - listener.y) - Math.hypot(b.x - listener.x, b.y - listener.y))
      .slice(0, MAX_LOOPS);
    for (const [v, l] of this.loops) {
      if (!want.includes(v)) {
        l.voice.stop(0.4);
        this.loops.delete(v);
      }
    }
    for (const v of want) {
      const internal = v === driving;
      let l = this.loops.get(v);
      if (l && (l.internal !== internal || l.voice.ended)) {
        l.voice.stop(0.3);
        this.loops.delete(v);
        l = undefined;
      }
      const pos = { x: v.x, y: v.y, z: v.z };
      if (!l) {
        const id = internal ? 'engine_working_internal' : 'engine_working_external';
        const voice = eng.play(id, engineVariant(id, v), internal ? { loop: true, fadeIn: 0.4, volume: 0.7 } : { pos, loop: true, fadeIn: 0.4, range: HEAR_TILES });
        if (!voice) continue;
        l = { voice, internal, safe: v.maxVelocity(true), safeAge: 0, gear: 0 };
        this.loops.set(v, l);
      }
      if ((l.safeAge += dt) > 1) (l.safeAge = 0), (l.safe = v.maxVelocity(true));
      if (!internal) l.voice.setPosition(pos);
      l.voice.setRate(engineRate(v.velocity, l.safe));
      const gear = gearFor(v.velocity, l.safe);
      // do_vehicle_engine_sfx: a gear change clunks (lower pitch up, higher down); only the driver hears it.
      if (internal && gear !== l.gear && gear > 0 && l.gear >= 0) eng.play('vehicle', 'gear_shift', { volume: 0.6, pitchJitter: 0.05 })?.setRate(gear > l.gear ? 0.8 : 1.2, 0);
      l.gear = gear;
    }
  }

  stopAll(): void {
    for (const l of this.loops.values()) l.voice.stop(0.2);
    this.loops.clear();
  }
}

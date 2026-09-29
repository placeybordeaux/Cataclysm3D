import { LEVEL_HEIGHT } from '../world/coords';

// Pure positional-audio math: where a sound is relative to the listener, how loud it is,
// and how muffled. Kept free of WebAudio so it can be unit tested.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Listener extends Vec3 {
  /** player yaw: 0 looks north (-y), positive turns clockwise (toward +x / east) */
  yaw: number;
}

/**
 * Source position in the listener's frame, in WebAudio convention (listener at the origin
 * facing -Z, +X to the right, +Y up), in metres. World tiles are 1 m; z-levels are
 * LEVEL_HEIGHT m apart (three.js: world(x,y,z) -> (x, z*LEVEL_HEIGHT, y)).
 */
export function listenerSpace(l: Listener, s: Vec3): { x: number; y: number; z: number; dist: number } {
  const dx = s.x - l.x;
  const dy = s.y - l.y;
  const up = (s.z - l.z) * LEVEL_HEIGHT;
  const sin = Math.sin(l.yaw), cos = Math.cos(l.yaw);
  // forward = (sin, -cos), right = (cos, sin) in world x/y (see Game.updatePlayerMovement)
  const right = dx * cos + dy * sin;
  const forward = dx * sin - dy * cos;
  return { x: right, y: up, z: -forward, dist: Math.hypot(dx, dy, up) };
}

/** CDDA get_heard_volume (sounds.cpp): 100 at the player, -100/24 per tile, 0 at 24 tiles. */
export function cddaHeardVolume(distTiles: number): number {
  return Math.max(0, Math.round(-4.166666 * distTiles - 1 + 100));
}

/**
 * Distance gain 0..1. CDDA fades everything to silence over 24 tiles regardless of loudness,
 * which feels wrong in first person for gunshots, so `range` (tiles until silence) scales
 * with the sound's loudness; the curve is CDDA's linear ramp softened near the listener.
 */
export function distanceGain(dist: number, range = 24, minGain = 0): number {
  if (range <= 0) return minGain;
  const t = Math.min(1, Math.max(0, dist - 1) / range);
  // (1-t)^2 instead of linear: inverse-square-ish near field without a hard edge at range.
  return Math.max(minGain, (1 - t) * (1 - t));
}

/** Tiles until silence for a CDDA loudness (sound event volume, ~= tiles it carries). */
export function rangeForLoudness(cddaVolume: number): number {
  return Math.min(120, Math.max(12, cddaVolume * 1.2));
}

/**
 * Tiles strictly between a and b on a 2D Bresenham line (endpoints excluded), capped at
 * `maxSteps`. Used to count walls between the listener and a sound.
 */
export function lineTiles(ax: number, ay: number, bx: number, by: number, maxSteps = 64): [number, number][] {
  const out: [number, number][] = [];
  let x = ax, y = ay;
  const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < maxSteps; i++) {
    if (x === bx && y === by) break;
    const e2 = 2 * err;
    if (e2 >= dy) (err += dy), (x += sx);
    if (e2 <= dx) (err += dx), (y += sy);
    if (x === bx && y === by) break;
    out.push([x, y]);
  }
  return out;
}

/**
 * Number of sound-blocking things between listener and source: opaque tiles along the line
 * on the listener's level, plus 2 per floor/ceiling crossed. Cheap stand-in for real
 * propagation (CDDA itself ignores walls for sfx).
 */
export function countOccluders(l: Vec3, s: Vec3, opaque: (x: number, y: number, z: number) => boolean, maxSteps = 48): number {
  const lx = Math.floor(l.x), ly = Math.floor(l.y), lz = Math.round(l.z);
  const sx = Math.floor(s.x), sy = Math.floor(s.y), sz = Math.round(s.z);
  let n = Math.abs(sz - lz) * 2;
  for (const [x, y] of lineTiles(lx, ly, sx, sy, maxSteps)) if (opaque(x, y, lz)) n++;
  return n;
}

/**
 * Lowpass cutoff (Hz) and extra gain for a sound: walls/floors muffle strongly, and air
 * absorbs highs with distance so far sounds read as far even at the same loudness.
 */
export function muffle(occluders: number, dist: number): { cutoff: number; gain: number } {
  const air = 20000 / (1 + dist / 25);
  if (occluders <= 0) return { cutoff: Math.max(2500, air), gain: 1 };
  const cutoff = Math.max(220, Math.min(air, 2400 * Math.pow(0.45, occluders - 1)));
  const gain = Math.max(0.15, Math.pow(0.6, occluders));
  return { cutoff, gain };
}

/** Gain for a CDDA sound-effect volume (100 = as recorded) times a user/extra factor. */
export function effectGain(cddaVolume: number, extra = 1): number {
  return Math.max(0, (cddaVolume / 100) * extra);
}

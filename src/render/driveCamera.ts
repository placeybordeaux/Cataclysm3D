// Camera math for driving (pure: no three.js scene access, unit-tested in
// tests/driveCamera.test.ts). CameraRig (camera.ts) uses these while the player is at the
// wheel; VehicleRenderer (vehicleMesh.ts) fills a DriveView from the vehicle every frame.
//
// Conventions match the player: yaw 0 = north (-y), clockwise, so forward in world (x, y) is
// (sin yaw, -cos yaw). Vehicle facing is degrees clockwise from east, hence heading = facing + 90.

/** Driving camera modes, cycled with the camera key while driving (separately from on foot). */
export type DriveCam = 'chase' | 'cockpit' | 'top';
export const DRIVE_CAMS: DriveCam[] = ['chase', 'cockpit', 'top'];

/** What the camera needs to know about the vehicle being driven, refreshed every frame. */
export interface DriveView {
  /** Vehicle centre (bounding box middle), world x / y (map), floor height (m). */
  x: number;
  y: number;
  base: number;
  /** Heading as a yaw (rad): the direction the vehicle points. */
  heading: number;
  /** Driver's eye, world x / y and absolute height (m). */
  eyeX: number;
  eyeY: number;
  eyeH: number;
  /** Length / width (m). */
  length: number;
  width: number;
  /** Signed speed along the heading, m/s. */
  speed: number;
  /** 0 on pavement .. 1 on rough ground (drives the camera shake). */
  rough: number;
}

export function headingFromFacing(facingDeg: number): number {
  return ((facingDeg + 90) * Math.PI) / 180;
}

/** Angle wrapped into [-pi, pi). */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Ease angle `from` toward `to` by fraction k (0..1) along the short way round. */
export function approachAngle(from: number, to: number, k: number): number {
  return from + wrapAngle(to - from) * k;
}

/**
 * Driver eye height above the vehicle floor level (m): ~1.2 m in a car; vans, buses and big
 * trucks sit the driver higher (their bodies are drawn at car height, so this stays under the
 * 1.8 m roof line).
 */
export function eyeHeightFor(lengthM: number, massKg: number): number {
  if (lengthM >= 9 || massKg >= 2000) return 1.45;
  if (lengthM >= 7 || massKg >= 1300) return 1.3;
  return 1.2;
}

/** Chase camera distance behind the vehicle centre and height above its floor (m). */
export function chaseOffsets(lengthM: number): { dist: number; rise: number } {
  const l = Math.max(2, lengthM);
  return { dist: 3.2 + l * 0.8, rise: 2.4 + l * 0.2 };
}

/** FOV (deg) widened with speed: +`maxAdd` at `fullAt` m/s and beyond (a sense of speed). */
export function speedFov(base: number, speed: number, maxAdd: number, fullAt = 25): number {
  return base + maxAdd * Math.min(1, Math.abs(speed) / fullAt);
}

export interface ChasePose {
  x: number;
  y: number;
  h: number;
  /** Camera yaw (player convention) and pitch (rad, negative = looking down). */
  yaw: number;
  pitch: number;
}

/**
 * Chase camera pose: `dist` metres behind the vehicle centre along `camYaw`, `rise` above its
 * floor, aimed at a point a little ahead of the vehicle (further ahead with speed so the road
 * you're about to reach stays in view). `pitchOffset` is the player's mouse pitch.
 */
export function chasePose(v: DriveView, camYaw: number, dist: number, rise: number, pitchOffset = 0): ChasePose {
  const fx = Math.sin(camYaw), fy = -Math.cos(camYaw);
  const x = v.x - fx * dist, y = v.y - fy * dist, h = v.base + rise;
  const ahead = v.length * 0.5 + 3 + Math.min(10, Math.max(0, v.speed) * 0.35);
  const aimH = v.base + 0.9;
  const pitch = Math.max(-1.2, Math.min(0.5, -Math.atan2(h - aimH, dist + ahead) + pitchOffset));
  return { x, y, h, yaw: camYaw, pitch };
}

/**
 * How far back the chase camera can go before something solid gets between it and the car:
 * marches from the vehicle centre toward the desired spot and stops short of the first
 * blocked tile. `blocked(tx, ty)` answers for integer tiles; tiles under the vehicle itself
 * are skipped by starting outside its footprint.
 */
export function chaseReach(v: DriveView, camYaw: number, want: number, blocked: (tx: number, ty: number) => boolean): number {
  const fx = Math.sin(camYaw), fy = -Math.cos(camYaw);
  const start = Math.min(want, v.length * 0.5 + 0.6);
  for (let t = start; t <= want; t += 0.25) {
    if (blocked(Math.floor(v.x - fx * t), Math.floor(v.y - fy * t))) return Math.max(start, t - 0.6);
  }
  return want;
}

/**
 * Road feel: a small camera jitter growing with speed, much stronger on rough ground.
 * Deterministic in `t` (seconds) so it's smooth frame to frame. Returns metres up and a pitch
 * wobble in radians.
 */
export function rideShake(t: number, speed: number, rough: number): { dh: number; dpitch: number } {
  const s = Math.min(1, Math.abs(speed) / 20);
  const amp = s * (0.004 + 0.035 * Math.max(0, Math.min(1, rough)));
  const n = Math.sin(t * 23.1) * 0.5 + Math.sin(t * 37.7 + 1.3) * 0.3 + Math.sin(t * 61.3 + 2.1) * 0.2;
  const m = Math.sin(t * 17.3 + 0.7) * 0.6 + Math.sin(t * 43.9) * 0.4;
  return { dh: n * amp, dpitch: m * amp * 0.25 };
}

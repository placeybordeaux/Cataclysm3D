import * as THREE from 'three';
import type { PlayerAvatar } from '../game/player';
import type { GameMap } from '../world/map';
import { LEVEL_HEIGHT } from '../world/coords';
import { approachAngle, chaseOffsets, chasePose, chaseReach, DRIVE_CAMS, rideShake, speedFov, type DriveCam, type DriveView } from './driveCamera';

// Camera modes (cycled with V):
//   first  - eye at 1.6 m (1.0 crouched) with a small walking head-bob
//   third  - over the right shoulder, pulled in when a wall is behind the player
//   top    - CDDA-style view from high above at ~60 deg, yaw follows the player so WASD
//            stays screen-relative. Pixel-stabilized: the camera is snapped to the low-res
//            pixel grid and the remainder is applied as a sub-pixel shift at blit time, so
//            the world doesn't shimmer while walking (t3ssel8r's trick).

//
// While driving (VehicleRenderer sets `drive` every frame) the camera key cycles the driving
// cameras instead, remembered separately (and across sessions): chase (default: behind and
// above the car, smoothed, pulled in by walls) -> cockpit (the driver's seat, looking where
// the car points; the mouse looks around relative to the car) -> top-down. `mode` then reads
// as the matching on-foot mode (chase = third, cockpit = first) so everything that asks
// "is this top-down / first person" keeps working.

export type CameraMode = 'first' | 'third' | 'top';
export const CAMERA_MODES: CameraMode[] = ['first', 'third', 'top'];

const DRIVE_CAM_KEY = 'cdda3d.driveCam';
const DRIVE_AS_MODE: Record<DriveCam, CameraMode> = { chase: 'third', cockpit: 'first', top: 'top' };
const MODE_AS_DRIVE: Record<CameraMode, DriveCam> = { third: 'chase', first: 'cockpit', top: 'top' };

function storedDriveCam(): DriveCam {
  try {
    const v = localStorage.getItem(DRIVE_CAM_KEY) as DriveCam | null;
    return v && DRIVE_CAMS.includes(v) ? v : 'chase';
  } catch {
    return 'chase';
  }
}

const EYE = 1.6;
const EYE_CROUCH = 1.0;
const TOP_PITCH = (60 * Math.PI) / 180;

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  /** On-foot camera mode (what `mode` is when not driving). */
  footMode: CameraMode = 'first';
  /** Driving camera, remembered separately from the on-foot one. */
  driveCam: DriveCam = storedDriveCam();
  /** The vehicle being driven (VehicleRenderer refreshes it before every frame), or null. */
  drive: DriveView | null = null;
  /** Driving FOVs (vertical, deg) and how much they widen at speed. */
  fovCockpit = 72;
  fovChase = 64;
  fovSpeedAdd = 8;
  private chaseYaw = NaN;
  private chaseDist = NaN;
  private time = 0;
  fovFirst = 70;
  fovTop = 36;
  topDistance = 22;
  thirdDistance = 2.6;
  /** Systems that carry the player without walking (driving) switch the head-bob off. */
  suppressBob = false;
  /** Added to the eye height (metres): swimming puts the head at the water line (src/nature.ts). */
  eyeOffset = 0;
  /** Metres the player stands above their level's floor: walking a flight (render/stairs, set per frame). */
  lift = 0;
  /**
   * Highest the first-person eye may be (absolute, metres), or null: standing in a car's
   * doorway ducks you under its roof instead of putting the camera through it
   * (VehicleRenderer sets it every frame).
   */
  eyeCap: number | null = null;
  /** Aim-down-sights target 0..1 (src/feel.ts sets it while RMB is held with a gun) and its FOV. */
  ads = 0;
  adsFov = 50;
  private adsBlend = 0;
  /**
   * Free aim (src/game/aimmodel.ts): the share of the weapon's recoil kick the view shows, in
   * screen angles (x right, y up; radians). Set every frame by src/aim.ts; the reticle shows the rest.
   */
  readonly aimView = { x: 0, y: 0 };
  /** Gun kick (radians): added to the view, springs back over ~0.15 s. `kick()` adds to it. */
  private kickPitch = 0;
  private kickYaw = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private lastX = NaN;
  private lastY = NaN;
  /** Sub-pixel remainder (low-res px) for the blit; zero except in top mode. */
  readonly subPixel = new THREE.Vector2();
  /** Point the lights/shadows should centre on (player feet in top mode, eye otherwise). */
  readonly focus = new THREE.Vector3();
  /**
   * First person: quantize yaw/pitch to the angle of one low-res pixel, so a slow turn
   * scrolls the image in whole-pixel steps (exact at the screen centre) instead of
   * resampling every texel at a new sub-pixel phase each frame.
   */
  snapRotation = true;

  /** Knock the view (gun recoil): pitch up by `pitch` rad, sideways by `yaw`; it springs back. */
  kick(pitch: number, yaw = 0): void {
    this.kickPitch = Math.min(0.12, this.kickPitch + pitch);
    this.kickYaw += yaw;
  }

  /** Effective camera mode: the driving camera's on-foot equivalent while driving. */
  get mode(): CameraMode {
    return this.drive ? DRIVE_AS_MODE[this.driveCam] : this.footMode;
  }
  set mode(m: CameraMode) {
    if (this.drive) this.setDriveCam(MODE_AS_DRIVE[m]);
    else this.footMode = m;
  }

  setDriveCam(c: DriveCam): void {
    this.driveCam = c;
    try {
      localStorage.setItem(DRIVE_CAM_KEY, c);
    } catch {
      // not persisted
    }
  }

  update(dt: number, p: PlayerAvatar, map: GameMap, aspect: number, lowResHeight: number): void {
    const cam = this.camera;
    cam.aspect = aspect;
    this.time += dt;
    if (this.drive) {
      this.updateDriving(dt, p, map, lowResHeight);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      return;
    }
    this.chaseYaw = NaN;
    this.adsBlend += (this.ads - this.adsBlend) * Math.min(1, dt * 12);
    const back = Math.exp(-dt * 16);
    this.kickPitch *= back;
    this.kickYaw *= back;
    const fovFirst = this.fovFirst + (this.adsFov - this.fovFirst) * this.adsBlend;
    const eyeH = (p.crouching ? EYE_CROUCH : EYE) + this.eyeOffset;
    const base = p.z * LEVEL_HEIGHT + this.lift;

    // head-bob amplitude follows actual ground speed (so bumping a wall doesn't bob)
    const moved = Number.isNaN(this.lastX) ? 0 : Math.hypot(p.x - this.lastX, p.y - this.lastY);
    this.lastX = p.x; this.lastY = p.y;
    const speed = dt > 0 ? moved / dt : 0;
    const targetAmp = this.suppressBob ? 0 : Math.min(speed / 3, 1.4) * 0.035;
    this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
    this.bobPhase += moved * 2.4;
    this.subPixel.set(0, 0);

    const fwdX = Math.sin(p.yaw), fwdZ = -Math.cos(p.yaw);
    if (this.mode === 'first') {
      cam.fov = fovFirst;
      const bobY = Math.abs(Math.sin(this.bobPhase)) * this.bobAmp * 1.6 - this.bobAmp * 0.8;
      const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.6;
      cam.position.set(p.x - fwdZ * bobX, Math.min(base + eyeH + bobY, this.eyeCap ?? Infinity), p.y + fwdX * bobX);
      if (this.snapRotation) {
        const q = (2 * Math.tan((cam.fov * Math.PI) / 360)) / lowResHeight;
        cam.rotation.set(Math.round(p.pitch / q) * q + this.kickPitch + this.aimView.y, -Math.round(p.yaw / q) * q - this.kickYaw - this.aimView.x, 0, 'YXZ');
      } else cam.rotation.set(p.pitch + this.kickPitch + this.aimView.y, -p.yaw - this.kickYaw - this.aimView.x, 0, 'YXZ');
      this.focus.copy(cam.position);
    } else if (this.mode === 'third') {
      cam.fov = fovFirst;
      const eye = tmpEye.set(p.x, base + eyeH + 0.15, p.y);
      const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
      const dir = tmpDir.set(fwdX * cp, sp, fwdZ * cp);
      const right = tmpRight.set(-fwdZ, 0, fwdX);
      // pull in toward the player if a wall is between
      let dist = this.thirdDistance;
      for (let t = 0.3; t <= this.thirdDistance; t += 0.1) {
        const x = eye.x - dir.x * t + right.x * 0.5 * (t / this.thirdDistance);
        const z = eye.z - dir.z * t + right.z * 0.5 * (t / this.thirdDistance);
        if (map.opaque(Math.floor(x), Math.floor(z), p.z) && !map.passable(Math.floor(x), Math.floor(z), p.z)) {
          dist = Math.max(0.3, t - 0.3);
          break;
        }
      }
      const k = dist / this.thirdDistance;
      cam.position.copy(eye).addScaledVector(dir, -dist).addScaledVector(right, 0.5 * k);
      cam.position.y += 0.2 * k;
      cam.rotation.set(p.pitch, -p.yaw, 0, 'YXZ');
      this.focus.set(p.x, base + eyeH, p.y);
    } else {
      this.placeTop(p.x, base + 0.5, p.y, p.yaw, this.topDistance, lowResHeight);
      this.focus.set(p.x, base + 1, p.y);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Driving cameras (see the header). The player's yaw already turns with the vehicle
   *  (vehicles.ts move), so `p.yaw - heading` is where the mouse has looked, relative to the car. */
  private updateDriving(dt: number, p: PlayerAvatar, map: GameMap, lowResHeight: number): void {
    const cam = this.camera, v = this.drive!;
    this.subPixel.set(0, 0);
    this.lastX = NaN;
    const look = p.yaw - v.heading;
    const shake = rideShake(this.time, v.speed, v.rough);
    if (this.driveCam === 'cockpit') {
      cam.fov = speedFov(this.fovCockpit, v.speed, this.fovSpeedAdd);
      cam.position.set(v.eyeX, v.eyeH + shake.dh, v.eyeY);
      let yaw = p.yaw, pitch = p.pitch;
      if (this.snapRotation) {
        const q = (2 * Math.tan((cam.fov * Math.PI) / 360)) / lowResHeight;
        yaw = Math.round(yaw / q) * q;
        pitch = Math.round(pitch / q) * q;
      }
      cam.rotation.set(pitch + shake.dpitch + this.kickPitch, -yaw - this.kickYaw, 0, 'YXZ');
      this.focus.copy(cam.position);
    } else if (this.driveCam === 'chase') {
      cam.fov = speedFov(this.fovChase, v.speed, this.fovSpeedAdd + 2);
      // The camera trails the car's heading (a short lag sells the turn and hides steering
      // jitter); mouse look is added on top without lag.
      if (Number.isNaN(this.chaseYaw)) this.chaseYaw = v.heading;
      this.chaseYaw = approachAngle(this.chaseYaw, v.heading, 1 - Math.exp(-dt * 3.5));
      const yaw = this.chaseYaw + look;
      const { dist, rise } = chaseOffsets(v.length);
      const z = Math.round(v.base / LEVEL_HEIGHT);
      const reach = chaseReach(v, yaw, dist, (tx, ty) => map.opaque(tx, ty, z) && !map.passable(tx, ty, z));
      // Pull in at once when something's in the way, ease back out.
      if (Number.isNaN(this.chaseDist) || reach < this.chaseDist) this.chaseDist = reach;
      else this.chaseDist += (reach - this.chaseDist) * (1 - Math.exp(-dt * 2));
      const k = this.chaseDist / dist;
      const pose = chasePose(v, yaw, this.chaseDist, rise * (0.55 + 0.45 * k), p.pitch * 0.6);
      cam.position.set(pose.x, pose.h + shake.dh * 0.5, pose.y);
      cam.rotation.set(pose.pitch + shake.dpitch * 0.5, -pose.yaw, 0, 'YXZ');
      this.focus.set(v.x, v.base + 1, v.y);
    } else {
      this.placeTop(v.x, v.base + 0.5, v.y, p.yaw, this.topDistance + Math.min(12, v.length), lowResHeight);
      this.focus.set(v.x, v.base + 1, v.y);
    }
  }

  /** Top-down pose around a target, pixel-stabilized (see the header). */
  private placeTop(tx: number, th: number, ty: number, yaw: number, distance: number, lowResHeight: number): void {
    {
      const cam = this.camera;
      cam.fov = this.fovTop;
      const target = tmpEye.set(tx, th, ty);
      cam.rotation.set(-TOP_PITCH, -yaw, 0, 'YXZ');
      cam.updateMatrixWorld();
      const right = tmpRight.setFromMatrixColumn(cam.matrixWorld, 0);
      const up = tmpUp.setFromMatrixColumn(cam.matrixWorld, 1);
      const back = tmpDir.setFromMatrixColumn(cam.matrixWorld, 2);
      // world size of one low-res pixel at the focus distance
      const pix = (2 * distance * Math.tan((cam.fov * Math.PI) / 360)) / lowResHeight;
      const rx = target.dot(right), uy = target.dot(up), bz = target.dot(back);
      const sx = Math.floor(rx / pix) * pix, sy = Math.floor(uy / pix) * pix;
      this.subPixel.set((rx - sx) / pix, (uy - sy) / pix);
      cam.position.set(0, 0, 0).addScaledVector(right, sx).addScaledVector(up, sy).addScaledVector(back, bz + distance);
    }
  }

  /** Next camera: the driving cameras while driving (chase -> cockpit -> top), else on-foot. */
  cycle(): CameraMode {
    if (this.drive) this.setDriveCam(DRIVE_CAMS[(DRIVE_CAMS.indexOf(this.driveCam) + 1) % DRIVE_CAMS.length]);
    else this.footMode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.footMode) + 1) % CAMERA_MODES.length];
    return this.mode;
  }
}

const tmpEye = new THREE.Vector3(), tmpDir = new THREE.Vector3(), tmpRight = new THREE.Vector3(), tmpUp = new THREE.Vector3();

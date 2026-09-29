import * as THREE from 'three';
import type { PlayerAvatar } from '../game/player';
import type { GameMap } from '../world/map';
import { LEVEL_HEIGHT } from '../world/coords';

// Camera modes (cycled with V):
//   first  - eye at 1.6 m (1.0 crouched) with a small walking head-bob
//   third  - over the right shoulder, pulled in when a wall is behind the player
//   top    - CDDA-style view from high above at ~60 deg, yaw follows the player so WASD
//            stays screen-relative. Pixel-stabilized: the camera is snapped to the low-res
//            pixel grid and the remainder is applied as a sub-pixel shift at blit time, so
//            the world doesn't shimmer while walking (t3ssel8r's trick).

export type CameraMode = 'first' | 'third' | 'top';
export const CAMERA_MODES: CameraMode[] = ['first', 'third', 'top'];

const EYE = 1.6;
const EYE_CROUCH = 1.0;
const TOP_PITCH = (60 * Math.PI) / 180;

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  mode: CameraMode = 'first';
  fovFirst = 70;
  fovTop = 36;
  topDistance = 22;
  thirdDistance = 2.6;
  /** Systems that carry the player without walking (driving) switch the head-bob off. */
  suppressBob = false;
  /** Added to the eye height (metres): swimming puts the head at the water line (src/nature.ts). */
  eyeOffset = 0;
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

  update(dt: number, p: PlayerAvatar, map: GameMap, aspect: number, lowResHeight: number): void {
    const cam = this.camera;
    cam.aspect = aspect;
    const eyeH = (p.crouching ? EYE_CROUCH : EYE) + this.eyeOffset;
    const base = p.z * LEVEL_HEIGHT;

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
      cam.fov = this.fovFirst;
      const bobY = Math.abs(Math.sin(this.bobPhase)) * this.bobAmp * 1.6 - this.bobAmp * 0.8;
      const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.6;
      cam.position.set(p.x - fwdZ * bobX, base + eyeH + bobY, p.y + fwdX * bobX);
      if (this.snapRotation) {
        const q = (2 * Math.tan((cam.fov * Math.PI) / 360)) / lowResHeight;
        cam.rotation.set(Math.round(p.pitch / q) * q, -Math.round(p.yaw / q) * q, 0, 'YXZ');
      } else cam.rotation.set(p.pitch, -p.yaw, 0, 'YXZ');
      this.focus.copy(cam.position);
    } else if (this.mode === 'third') {
      cam.fov = this.fovFirst;
      const eye = tmpEye.set(p.x, base + eyeH + 0.15, p.y);
      const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
      const dir = tmpDir.set(fwdX * cp, sp, fwdZ * cp);
      const right = tmpRight.set(-fwdZ, 0, fwdX);
      // At the wheel (suppressBob is set while driving) the shoulder camera sat inside the
      // cabin staring at the roof: pull back and up to a chase camera instead.
      const chase = this.suppressBob;
      if (chase) {
        cam.position.copy(eye).addScaledVector(dir, -CHASE_DIST);
        cam.position.y += CHASE_RISE;
        cam.rotation.set(p.pitch - CHASE_TILT, -p.yaw, 0, 'YXZ');
        this.focus.set(p.x, base + eyeH, p.y);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        return;
      }
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
      cam.fov = this.fovTop;
      const target = tmpEye.set(p.x, base + 0.5, p.y);
      cam.rotation.set(-TOP_PITCH, -p.yaw, 0, 'YXZ');
      cam.updateMatrixWorld();
      const right = tmpRight.setFromMatrixColumn(cam.matrixWorld, 0);
      const up = tmpUp.setFromMatrixColumn(cam.matrixWorld, 1);
      const back = tmpDir.setFromMatrixColumn(cam.matrixWorld, 2);
      // world size of one low-res pixel at the focus distance
      const pix = (2 * this.topDistance * Math.tan((cam.fov * Math.PI) / 360)) / lowResHeight;
      const rx = target.dot(right), uy = target.dot(up), bz = target.dot(back);
      const sx = Math.floor(rx / pix) * pix, sy = Math.floor(uy / pix) * pix;
      this.subPixel.set((rx - sx) / pix, (uy - sy) / pix);
      cam.position.set(0, 0, 0).addScaledVector(right, sx).addScaledVector(up, sy).addScaledVector(back, bz + this.topDistance);
      this.focus.set(p.x, base + 1, p.y);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  cycle(): CameraMode {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    return this.mode;
  }
}

/** Chase camera while driving (third-person mode): metres behind, above, and downward tilt (rad). */
const CHASE_DIST = 7.5, CHASE_RISE = 2.6, CHASE_TILT = 0.2;

const tmpEye = new THREE.Vector3(), tmpDir = new THREE.Vector3(), tmpRight = new THREE.Vector3(), tmpUp = new THREE.Vector3();

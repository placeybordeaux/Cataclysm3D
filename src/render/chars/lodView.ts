import { LEVEL_HEIGHT } from '../../world/coords';
import type { Renderer } from '../renderer';
import type { SpriteHandle } from '../sprites';
import type { TileFrame } from '../textureSource';
import type { CharInstance } from './charLayer';
import { spriteInfo } from './index';
import type { Rig } from './rig';
import { lodMix, newLodState, spriteFit, type LodMix, type LodState, type ZLod } from './spriteLod';

// The sprite half of the sprite <-> 3D distance LOD (spriteLod.ts, docs/SPRITE3D.md): one
// billboard of the creature's own UltiCa sprite, kept next to its 3D body and shown, faded or
// flipped against it by distance. The body itself is still posed and animated every frame by
// CreatureModel; this only fades / narrows it and picks its close-range mesh.

export interface LodInput {
  /** where the body stands (tile coords) and its level; lift = m above the level floor */
  x: number;
  y: number;
  z: number;
  lift: number;
  /** horizontal distance to the camera (m) */
  dist: number;
  /** the draw-distance dissolve of far figures, 0..1 (applies to both pictures) */
  fadeFar: number;
  visible: boolean;
  /** camera right vector in tile coords (x east, y south) */
  camRight: [number, number];
}

/** Flipped frame: the same pixels mirrored (UltiCa creatures face right). */
function mirrored(f: TileFrame): TileFrame {
  return { ...f, uv: [f.uv[2], f.uv[1], f.uv[0], f.uv[3]] };
}

export class CreatureLod {
  private h: SpriteHandle;
  private st: LodState;
  private flipped = false;
  private readonly height: number;
  private readonly sink: number;
  private readonly aspect: number;
  private readonly frameR: TileFrame;
  private readonly frameL: TileFrame;

  constructor(renderer: Renderer, frame: TileFrame, readonly rig: Rig, fallbackHeight: number, mode: ZLod, dist: number) {
    this.frameR = frame;
    this.frameL = mirrored(frame);
    // size the sprite so its drawn figure is as tall as the body (not the frame at a fixed
    // px/m: UltiCa zombies fill ~29 of 48 rows) and its feet, not the empty rows, touch down
    const info = spriteInfo(frame);
    if (info) {
      const fit = spriteFit(rig.height, frame.h, info.box[1], info.box[3]);
      this.height = fit.height;
      this.sink = fit.sink;
    } else {
      this.height = fallbackHeight;
      this.sink = 0;
    }
    this.aspect = frame.w / Math.max(1, frame.h);
    this.st = newLodState(dist, mode);
    this.h = renderer.sprites.add({ x: 0, y: 0, z: 0, frame, height: this.height });
    this.h.setVisible(false);
  }

  flash(color: number, seconds: number): void {
    this.h.flash(color, seconds);
  }

  hide(): void {
    this.h.setVisible(false);
  }

  remove(): void {
    this.h.remove();
  }

  /** This frame's mix (advances the pop / flip state): before CreatureModel.update, which takes
   * the body's fade and visibility from it (bodyFade). */
  plan(dt: number, mode: ZLod, dist: number): LodMix {
    return lodMix(mode, dist, this.st, dt);
  }

  /** After CreatureModel.update: narrow the body (flip) and place / fade the sprite. */
  apply(inst: CharInstance, mix: LodMix, s: LodInput): void {
    if (mix.modelWidth !== 1) (inst.sxz *= mix.modelWidth, inst.dirty = true);
    const op = mix.spriteOpacity * (1 - s.fadeFar);
    if (!s.visible || op <= 0.001) {
      this.h.setVisible(false);
      return;
    }
    // mirror the art when the body walks toward the left of the screen (hysteresis: a zombie
    // coming straight at you keeps whichever way it was drawn)
    const fx = Math.sin(inst.yaw), fy = -Math.cos(inst.yaw);
    const side = fx * s.camRight[0] + fy * s.camRight[1];
    const want = side < -0.2 ? true : side > 0.2 ? false : this.flipped;
    if (want !== this.flipped) {
      this.flipped = want;
      this.h.setFrame(want ? this.frameL : this.frameR, this.height);
    }
    this.h.set(s.x, s.y, s.z + (s.lift - this.sink) / LEVEL_HEIGHT);
    this.h.setSize(this.height * this.aspect * mix.spriteWidth, this.height);
    this.h.setOpacity(op);
    this.h.setVisible(true);
  }
}

/** The body's dithered fade for a mix and the far-figure dissolve. */
export function bodyFade(mix: LodMix, fadeFar: number): number {
  return 1 - (1 - fadeFar) * (1 - mix.modelFade);
}

/** Close-range mesh on / off (sprite3d bodies; harmless on painted ones). */
export function setDetail(inst: CharInstance, on: boolean): void {
  if (on === inst.detail) return;
  inst.detail = on;
  // the instance moves to another batch: its fixed attributes have to be written there
  inst.layer?.touch(true);
}

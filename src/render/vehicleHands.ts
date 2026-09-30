import * as THREE from 'three';
import type { Game } from '../game/game';
import { AtlasTextureSource } from './atlasSource';
import { CharLayer, type CharInstance } from './chars/charLayer';
import { FIST_GRIP, fistRig } from './chars/fpView';
import { charLayers, frameKey, spriteInfo } from './chars/index';
import type { Renderer } from './renderer';

// The driver's hands on the wheel, made from the same modelled fist + sleeve rig and painter
// as the on-foot first-person arms (render/chars/fpView.ts), so a jacket's cuff and the curl
// of the fingers match what you see walking. They're world geometry in the car (not the
// first-person overlay), in their own small CharLayer parented under the cockpit so they
// ride with the vehicle frame and the wheel's rotation without a frame of lag.

export interface WheelHands {
  readonly group: THREE.Group;
  /** Place both fists: `grips[i]` is the grip point's frame (vehicle-local) for L, R. */
  update(dt: number, grips: [THREE.Matrix4, THREE.Matrix4], world: { x: number; y: number; z: number }): void;
  dispose(): void;
}

/** null when the character renderer isn't available (headless, sprite viewmodel builds). */
export function makeWheelHands(game: Game, renderer: Renderer): WheelHands | null {
  let store;
  try {
    store = charLayers(renderer).store;
  } catch {
    return null;
  }
  const src = renderer.source;
  const p = game.player;
  let outfit = src.sprite('player');
  if (src instanceof AtlasTextureSource) {
    const worn = p.inv.worn.length ? p.inv.worn.map((w) => w.typeId) : ['jeans', 'tshirt', 'sneakers', 'jacket_flannel'];
    outfit = src.composite(src.layersFor(worn, null, p.male ? 'male' : 'female')) ?? outfit;
  }
  const key = frameKey(outfit);
  const layer = new CharLayer(false, 'wheel-hands');
  const insts: CharInstance[] = ([-1, 1] as const).map((side) => {
    const rig = fistRig(side);
    // same skin key scheme as fpView ('L' is its left arm), so the painted pages are shared
    const inst = layer.add(rig, store.get(rig, { key: `fp:${key}:${side < 0 ? 'L' : 'wheelR'}`, info: () => spriteInfo(outfit) }));
    inst.rootOverride = new THREE.Matrix4();
    return inst;
  });
  const grip = new THREE.Matrix4().makeTranslation(-FIST_GRIP[0], -FIST_GRIP[1], -FIST_GRIP[2]);
  return {
    group: layer.group,
    update(dt, grips, world) {
      insts.forEach((inst, i) => {
        // wrist = grip frame, stepped back from where the fingers close
        inst.rootOverride!.copy(grips[i]).multiply(grip);
        inst.x = world.x;
        inst.y = world.y;
        inst.z = world.z;
        inst.dirty = true;
      });
      layer.flush(dt, store);
    },
    dispose() {
      for (const i of insts) i.remove();
      layer.dispose();
    },
  };
}

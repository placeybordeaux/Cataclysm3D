import * as THREE from 'three';
import type { Renderer } from '../renderer';
import { LEVEL_HEIGHT } from '../../world/coords';
import { bodyShapeOf } from './archetype';
import { CharLayer, type CharInstance } from './charLayer';
import { charLayers } from './index';
import type { PartDef, Rig } from './rig';

// Small world-space meshes for things that were camera-facing pixel sprites: arrows and
// bolts (flying, stuck in the ground, walls and monsters), sling stones, monster projectiles
// (acid globs, bile), bullet sparks. Pooled instances on their own CharLayer; each frame the
// owner calls begin(), place() per object, end() (unused instances hide).
//
// Rig space: the object points along -z from its origin (an arrow's tip is the origin).

type RGB = [number, number, number];
export type FxKind = 'arrow' | 'bolt' | 'stone' | 'glob' | 'spark';

function rigOf(parts: PartDef[]): Rig {
  return { shape: bodyShapeOf({ id: 'fx' }), parts, height: 0.1, hover: 0, lie: { angle: 0, lift: 0, side: false }, texels: 4, pose() {} };
}

function buildRig(kind: FxKind, color: RGB): Rig {
  const P: PartDef[] = [];
  const add = (name: string, parent: number, joint: [number, number, number], size: [number, number, number], center: [number, number, number], c: RGB, o: Partial<PartDef> = {}) => {
    P.push({ name, parent, joint, size, center, src: { color: c }, kind: 'thin', ...o });
    return P.length - 1;
  };
  switch (kind) {
    case 'arrow':
    case 'bolt': {
      const L = kind === 'bolt' ? 0.4 : 0.72;
      const w = kind === 'bolt' ? 0.012 : 0.009;
      add('head', -1, [0, 0, 0], [0.018, 0.006, 0.05], [0, 0, 0.025], [184, 188, 196], { taper: [0.15, 0.4, 1, 1], taperAxis: 'z' });
      add('shaft', -1, [0, 0, 0.045], [w, w, L - 0.045], [0, 0, (L - 0.045) / 2], [138, 106, 64]);
      add('shaft2', 1, [0, 0, (L - 0.045) / 2], [w, w, L - 0.045], [0, 0, 0], [122, 90, 52], { rest: [0, 0, Math.PI / 4] });
      // crossed fletching at the tail
      add('fletchA', -1, [0, 0, L - 0.07], [0.004, 0.034, 0.08], [0, 0, 0], [232, 228, 220]);
      add('fletchB', -1, [0, 0, L - 0.07], [0.034, 0.004, 0.08], [0, 0, 0], [184, 50, 42]);
      break;
    }
    case 'stone':
      add('stone', -1, [0, 0, 0], [0.04, 0.034, 0.04], [0, 0, 0], [140, 138, 132]);
      add('stone2', 0, [0, 0, 0], [0.04, 0.034, 0.04], [0, 0, 0], [168, 166, 158], { rest: [0, Math.PI / 4, 0] });
      break;
    case 'glob':
      // a wobbling blob with a trailing drip
      add('glob', -1, [0, 0, 0], [0.13, 0.11, 0.13], [0, 0, 0], color);
      add('glob2', 0, [0, 0, 0], [0.12, 0.12, 0.12], [0, 0, 0], color.map((v) => Math.min(255, v * 1.2)) as RGB, { rest: [0.6, 0.6, 0] });
      add('tail', -1, [0, 0, 0.08], [0.06, 0.06, 0.1], [0, 0, 0.03], color.map((v) => v * 0.8) as RGB, { taper: [1, 1, 0.3, 0.3], taperAxis: 'z' });
      break;
    case 'spark':
      add('spark', -1, [0, 0, 0], [0.05, 0.05, 0.05], [0, 0, 0], color, { rest: [0.6, 0.6, 0] });
      add('spark2', -1, [0, 0, 0], [0.08, 0.015, 0.015], [0, 0, 0], color, { rest: [0, 0, 0.8] });
      break;
  }
  return rigOf(P);
}

const _m = new THREE.Matrix4();
const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

export class FxMeshes {
  private layer = new CharLayer(true, 'fx-meshes');
  private rigs = new Map<string, Rig>();
  private pools = new Map<string, { list: CharInstance[]; used: number }>();

  constructor(private renderer: Renderer) {
    renderer.scene.add(this.layer.group);
    const L = charLayers(renderer);
    this.layer.groundAt = null;
    renderer.beforeRender.push((dt) => this.layer.flush(dt, L.store));
  }

  begin(): void {
    for (const p of this.pools.values()) p.used = 0;
  }

  /**
   * Place one object: `x, y` tile coords, `z` level, `h` metres above the level floor, pointing
   * along `dir` (tile-space x, y, and up), scaled by `scale`.
   */
  place(kind: FxKind, x: number, y: number, z: number, h: number, dir: [number, number, number], color: RGB = [200, 200, 200], scale = 1): void {
    const key = `${kind}:${kind === 'glob' || kind === 'spark' ? color.join(',') : ''}`;
    let rig = this.rigs.get(key);
    if (!rig) this.rigs.set(key, (rig = buildRig(kind, color)));
    let pool = this.pools.get(key);
    if (!pool) this.pools.set(key, (pool = { list: [], used: 0 }));
    let inst = pool.list[pool.used];
    if (!inst) {
      const store = charLayers(this.renderer).store;
      inst = this.layer.add(rig, store.get(rig, { key: `fx:${key}`, info: () => null }));
      inst.rootOverride = new THREE.Matrix4();
      pool.list.push(inst);
    }
    pool.used++;
    _eye.set(x, z * LEVEL_HEIGHT + h, y);
    _to.set(x + dir[0], z * LEVEL_HEIGHT + h + dir[2], y + dir[1]);
    // lookAt makes +z point from target to eye: the object's -z then points along dir
    _m.lookAt(_eye, _to, Math.abs(dir[2]) > 0.95 * Math.hypot(dir[0], dir[1], dir[2]) ? SIDE : UP);
    _m.setPosition(_eye);
    if (scale !== 1) _m.scale(new THREE.Vector3(scale, scale, scale));
    inst.rootOverride!.copy(_m);
    inst.dirty = true;
    inst.x = x; inst.y = y; inst.z = z;
    inst.setVisible(true);
  }

  end(): void {
    for (const p of this.pools.values()) for (let i = p.used; i < p.list.length; i++) p.list[i].setVisible(false);
  }
}

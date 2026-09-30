import * as THREE from 'three';
import type { TileFrame } from '../textureSource';
import { bodyShapeOf } from './archetype';
import { CharLayer, SkinStore } from './charLayer';
import { makeRig, HUM, type PartDef, type PoseIn, type Rig } from './rig';

// Human figures that are furniture — mannequins and statues — baked into the chunk geometry
// as posed humanoid rigs (docs/CHARACTERS.md round 5) instead of a camera-facing sprite or a
// voxel lump: the same body as the people walking past, standing still, in plastic or stone.
// Each part box becomes six quads textured from its skin net on a figure skin page, so they
// cost nothing per frame and get the world's light map, shadows and outlines.

type RGB = [number, number, number];
interface QuadSink {
  quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], n: [number, number, number], uv: readonly number[], f: TileFrame, ao?: readonly number[]): void;
}

const FIGURES: Record<string, { color: RGB; detail: 'metal' | 'grain'; pose: 'stand' | 'hero' }> = {
  f_mannequin: { color: [218, 196, 168], detail: 'metal', pose: 'stand' },
  f_statue: { color: [152, 152, 146], detail: 'grain', pose: 'hero' },
};

export function isFigure(id: string): boolean {
  return id in FIGURES;
}

const store = new SkinStore();
const layer = new CharLayer(false, 'figures');
const rigs = new Map<string, Rig>();
const PAGE = 1024;

function figureRig(id: string): Rig {
  let r = rigs.get(id);
  if (r) return r;
  const spec = FIGURES[id];
  const base = makeRig({ ...bodyShapeOf({ id: 'npc', bodytype: 'human', species: ['HUMAN'] }), scale: id === 'f_statue' ? 1.1 : 1 });
  // one material all over (plastic / stone), no face or clothes
  const parts: PartDef[] = base.parts.map((p) => ({ ...p, src: { color: spec.color, detail: spec.detail } }));
  r = { ...base, parts };
  rigs.set(id, r);
  return r;
}

const _n3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
// paint.ts face order: right, front, left, back, top, bottom — normal, u axis, v axis (down)
const FACES: [number[], number[], number[]][] = [
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
  [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
];

/**
 * Bake figure furniture `id` standing at tile (x, y) on `base` (three.js y), facing `yaw`
 * (Monster.facing convention: 0 = north, clockwise). Returns false if `id` is not a figure.
 */
export function bakeFigure(geo: (f: TileFrame) => QuadSink, id: string, x: number, y: number, base: number, yaw: number, seed: number): boolean {
  const spec = FIGURES[id];
  if (!spec) return false;
  const rig = figureRig(id);
  const skin = store.get(rig, { key: `figure:${id}`, info: () => null });
  store.upload();
  const tex = store.texture(skin.page);
  const inst = layer.add(rig, skin);
  inst.x = x + 0.5;
  inst.y = y + 0.5;
  inst.z = 0;
  inst.lift = base;
  inst.yaw = yaw;
  const p: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: (seed & 255) / 255 };
  inst.setPose(p);
  // a shop dummy stands arms slightly out; a statue raises one arm
  const rot = inst.pose.rot;
  rot[HUM.uArmR * 3 + 2] += 0.18;
  rot[HUM.uArmL * 3 + 2] -= 0.18;
  if (spec.pose === 'hero') {
    rot[HUM.uArmR * 3] += 2.7;
    rot[HUM.fArmR * 3] += 0.3;
    rot[HUM.head * 3] -= 0.15;
  }
  inst.dirty = true;
  inst.build(null);
  const m = new THREE.Matrix4();
  for (let i = 0; i < rig.parts.length; i++) {
    m.fromArray(inst.mats, i * 16);
    _n3.getNormalMatrix(m);
    const r = skin.rects;
    const ox = r[i * 5], oy = r[i * 5 + 1], W = r[i * 5 + 2], H = r[i * 5 + 3], D = r[i * 5 + 4];
    const rects: [number, number, number, number][] = [[0, D, D, H], [D, D, W, H], [D + W, D, D, H], [2 * D + W, D, W, H], [D, 0, W, D], [D + W, 0, W, D]];
    FACES.forEach(([nv, uv, vv], f) => {
      const [fx, fy, fw, fh] = rects[f];
      // skin pages are DataTextures (not flipped): v = row / PAGE, bottom of the face first
      const frame: TileFrame = { texture: tex, uv: [(ox + fx) / PAGE, (oy + fy + fh) / PAGE, (ox + fx + fw) / PAGE, (oy + fy) / PAGE], w: fw, h: fh };
      const corner = (a: number, b: number): [number, number, number] => {
        _v.set(nv[0] * 0.5 + uv[0] * (a - 0.5) + vv[0] * (b - 0.5), nv[1] * 0.5 + uv[1] * (a - 0.5) + vv[1] * (b - 0.5), nv[2] * 0.5 + uv[2] * (a - 0.5) + vv[2] * (b - 0.5)).applyMatrix4(m);
        return [_v.x, _v.y, _v.z];
      };
      _n.set(nv[0], nv[1], nv[2]).applyMatrix3(_n3).normalize();
      geo(frame).quad(corner(0, 1), corner(1, 1), corner(1, 0), corner(0, 0), [_n.x, _n.y, _n.z], [0, 0, 1, 1], frame);
    });
  }
  inst.remove();
  return true;
}

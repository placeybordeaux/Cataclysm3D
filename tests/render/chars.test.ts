import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { archetypeOf, bodyShapeOf, ARCHETYPES, type Archetype } from '../../src/render/chars/archetype';
import { makeRig, type PoseIn } from '../../src/render/chars/rig';
import { analyseSprite, netSize, paintPart, texelDims, type Img } from '../../src/render/chars/paint';
import { CharLayer, type Skin } from '../../src/render/chars/charLayer';
import monsters from '../../public/data/monsters.json';

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number };
const MON = monsters as unknown as Record<string, Mon>;

const idle: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.3 };

/** World-space bounds of every part box of a rig in a pose (instance at the origin, level 0). */
function bounds(arch: Archetype | Mon, pose: Partial<PoseIn> = {}, setup?: (i: ReturnType<CharLayer['add']>) => void) {
  const shape = typeof arch === 'string' ? { ...bodyShapeOf({ id: 'x' }), arch } : bodyShapeOf(arch);
  const rig = makeRig(shape);
  const layer = new CharLayer(false);
  const skin: Skin = { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 };
  const inst = layer.add(rig, skin);
  setup?.(inst);
  inst.setPose({ ...idle, ...pose });
  inst.build(null);
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const unit = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  for (let i = 0; i < rig.parts.length; i++) {
    m.fromArray(inst.mats, i * 16);
    box.union(unit.clone().applyMatrix4(m));
  }
  return { box, rig };
}

describe('archetypes from BN monster data', () => {
  it('reads bodytype first', () => {
    expect(archetypeOf(MON.mon_zombie)).toBe('humanoid');
    expect(archetypeOf(MON.mon_dog)).toBe('quadruped');
    expect(archetypeOf(MON.mon_rabbit)).toBe('critter');
    expect(archetypeOf(MON.mon_giant_cockroach)).toBe('insect');
    expect(archetypeOf(MON.mon_spider_wolf_giant)).toBe('insect');
    expect(archetypeOf(MON.mon_crow)).toBe('flyer');
    expect(archetypeOf(MON.mon_blob)).toBe('blob');
    expect(archetypeOf(MON.mon_bear)).toBe('quadruped');
  });
  it('falls back on species, flags and symbol when bodytype is missing', () => {
    expect(archetypeOf(MON.mon_manhack)).toBe('flyer');
    expect(archetypeOf(MON.mon_triffid)).toBe('plant');
    expect(archetypeOf(MON.mon_tankbot)).toBe('machine');
    expect(archetypeOf(MON.mon_zombie_ears)).toBe('humanoid');
    expect(archetypeOf(MON.mon_mosquito)).toBe('flyer');
  });
  it('gives every BN monster a body', () => {
    const seen = new Set<Archetype>();
    for (const m of Object.values(MON)) {
      const a = archetypeOf(m);
      expect(ARCHETYPES).toContain(a);
      seen.add(a);
      expect(() => makeRig(bodyShapeOf(m))).not.toThrow();
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
  it('builds zombie variants from the name and volume', () => {
    expect(bodyShapeOf(MON.mon_zombie_fat).girth).toBeGreaterThan(1.3);
    expect(bodyShapeOf(MON.mon_zombie_child).scale).toBeLessThan(0.85);
    expect(bodyShapeOf(MON.mon_zombie_hulk).scale).toBeGreaterThan(1.3);
    expect(bodyShapeOf(MON.mon_zombie).zombie).toBe(true);
    expect(bodyShapeOf(MON.mon_spider_wolf_giant).legCount).toBe(8);
    expect(bodyShapeOf(MON.mon_giant_cockroach).legCount).toBe(6);
  });
});

describe('procedural rigs', () => {
  it('stand on the floor and are the size they claim', () => {
    for (const id of ['mon_zombie', 'mon_dog', 'mon_rabbit', 'mon_giant_cockroach', 'mon_spider_wolf_giant', 'mon_blob', 'mon_triffid', 'mon_zombie_hulk', 'mon_deer']) {
      const { box, rig } = bounds(MON[id]);
      expect(Math.abs(box.min.y), id).toBeLessThan(0.06 * rig.shape.scale + 0.02);
      expect(Math.abs(box.max.y - rig.height), id).toBeLessThan(0.12 * rig.shape.scale + 0.05);
    }
  });
  it('makes an adult zombie about 1.75 m with its head at eye level', () => {
    const { box, rig } = bounds(MON.mon_zombie);
    expect(box.max.y).toBeGreaterThan(1.6);
    expect(box.max.y).toBeLessThan(1.85);
    const head = rig.parts.find((p) => p.name === 'head')!;
    expect(head).toBeTruthy();
  });
  it('faces -z at yaw 0 (north) and turns clockwise', () => {
    // the zombie reaches forward: its arms stick out in front
    const north = bounds(MON.mon_zombie).box;
    expect(north.min.z).toBeLessThan(-0.4);
    const east = bounds(MON.mon_zombie, {}, (i) => (i.yaw = Math.PI / 2)).box;
    expect(east.max.x).toBeGreaterThan(0.4);
  });
  it('lies flat when dead and toppled', () => {
    const { box } = bounds(MON.mon_zombie, { dead: true, down: 1 }, (i) => {
      i.fall = Math.PI / 2;
      i.fallDx = 0;
      i.fallDy = 1;
      i.lift = 0.11;
    });
    expect(box.max.y).toBeLessThan(0.6);
    expect(box.min.y).toBeGreaterThan(-0.1);
    expect(box.max.z).toBeGreaterThan(1.4);
  });
  it('raises the arms during a wind-up', () => {
    const rest = bounds(MON.mon_zombie).box;
    const wind = bounds(MON.mon_zombie, { windup: 1, windKind: 'heavy' }).box;
    expect(wind.max.y).toBeGreaterThan(rest.max.y + 0.15);
  });
});

describe('sprite painting', () => {
  // a 4x6 "person": red head row, blue body, green legs, transparent border
  const img: Img = { w: 6, h: 8, data: new Uint8Array(6 * 8 * 4) };
  const set = (x: number, y: number, c: [number, number, number]) => img.data.set([...c, 255], (y * 6 + x) * 4);
  for (let y = 1; y < 7; y++) for (let x = 1; x < 5; x++) set(x, y, y < 3 ? [200, 60, 60] : y < 5 ? [60, 60, 200] : [60, 200, 60]);
  const info = analyseSprite(img);

  it('finds the opaque box', () => {
    expect(info.box).toEqual([1, 1, 5, 7]);
  });
  it('projects the crop onto the front face of the net', () => {
    const dims: [number, number, number] = [4, 6, 2];
    const [nw, nh] = netSize(...dims);
    expect([nw, nh]).toEqual([12, 8]);
    const dst: Img = { w: nw, h: nh, data: new Uint8Array(nw * nh * 4) };
    paintPart(dst, 0, 0, dims, { rect: [0, 0, 1, 1], proj: 'front' }, info);
    const px = (x: number, y: number) => Array.from(dst.data.slice((y * nw + x) * 4, (y * nw + x) * 4 + 3));
    // front face starts at (D, D) = (2, 2): top row red, bottom row green
    expect(px(3, 2)[0]).toBeGreaterThan(150);
    expect(px(3, 7)[1]).toBeGreaterThan(130);
    // every net texel is opaque
    for (let i = 3; i < dst.data.length; i += 4) {
      const x = (i >> 2) % nw, y = Math.floor((i >> 2) / nw);
      const inNet = (y >= 2) || (x >= 2 && x < 10);
      if (inNet) expect(dst.data[i]).toBe(255);
    }
  });
  it('sizes nets at 32 texels per metre', () => {
    expect(texelDims([0.25, 0.27, 0.25])).toEqual([8, 9, 8]);
    expect(texelDims([0.01, 0.01, 0.01])).toEqual([1, 1, 1]);
  });
});

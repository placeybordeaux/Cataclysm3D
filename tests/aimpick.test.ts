import { describe, expect, it } from 'vitest';
import { bodyShapeOf } from '../src/render/chars/archetype';
import { makeRig, type PoseIn } from '../src/render/chars/rig';
import { CharLayer, type Skin } from '../src/render/chars/charLayer';
import { pickModel } from '../src/render/aimPick';
import { zoneOfPart } from '../src/game/aimmodel';
import monsters from '../public/data/monsters.json';

// Free-aim hit zones against the drawn 3D characters (src/render/aimPick.ts): a ray through a
// part's box picks that part, so "the head" is wherever the model draws it — on top of a zombie,
// out in front of a dog.

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number };
const MON = monsters as unknown as Record<string, Mon>;
const idle: PoseIn = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed: 0.3 };

/** A posed model at the origin facing `yaw` (0 = north), and the world centre of each part (game coords). */
function model(id: string, yaw = 0) {
  const rig = makeRig(bodyShapeOf(MON[id]));
  const layer = new CharLayer(false);
  const skin: Skin = { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 };
  const inst = layer.add(rig, skin);
  inst.yaw = yaw;
  inst.setPose(idle);
  inst.build(null);
  const centre = (name: string) => {
    const i = rig.parts.findIndex((p) => p.name === name);
    if (i < 0) throw new Error(`${id} has no part ${name}: ${rig.parts.map((p) => p.name).join(' ')}`);
    const e = inst.mats.subarray(i * 16, i * 16 + 16);
    return { x: e[12], y: e[14], h: e[13] };
  };
  return { inst, rig, centre };
}

/** Shoot from 10 m south (looking north) at a point; the zone that part is. */
function shootAt(inst: Parameters<typeof pickModel>[0], at: { x: number; y: number; h: number }, eye = 1.6) {
  const o = { x: at.x, y: at.y + 10, h: eye };
  const d0 = { x: at.x - o.x, y: at.y - o.y, h: at.h - o.h };
  const n = Math.hypot(d0.x, d0.y, d0.h);
  const r = pickModel(inst, o, { x: d0.x / n, y: d0.y / n, h: d0.h / n });
  return r ? { zone: zoneOfPart(r.part), part: r.part, t: r.t } : r;
}

describe('free-aim hit zones from the 3D models', () => {
  it('zombie: head, torso, legs are where they are drawn; between the legs misses', () => {
    const { inst, centre } = model('mon_zombie');
    expect(shootAt(inst, centre('head'))?.zone).toBe('head');
    expect(shootAt(inst, centre('torso'))?.zone).toBe('torso');
    expect(shootAt(inst, centre('shinL'))?.zone).toBe('legs');
    const knee = centre('shinL');
    expect(shootAt(inst, { x: 0, y: 0, h: knee.h })).toBeNull();
    // Beside the body entirely.
    expect(shootAt(inst, { x: 1.2, y: 0, h: 1.2 })).toBeNull();
    // t is metres along the ray: the head is ~10 m away.
    expect(shootAt(inst, centre('head'))!.t).toBeGreaterThan(9.5);
    expect(shootAt(inst, centre('head'))!.t).toBeLessThan(10.5);
  });

  it('dog: the head is up front and low, where the model puts it (not "the top 17 %")', () => {
    // Side-on: the dog faces east, we shoot from the south.
    const { inst, centre } = model('mon_dog', Math.PI / 2);
    const head = centre('head');
    expect(shootAt(inst, head)?.zone).toBe('head');
    expect(head.x).toBeGreaterThan(0.1); // in front of its centre
    expect(head.h).toBeLessThan(1);
    expect(shootAt(inst, centre('body'))?.zone).toBe('torso');
  });

  it('part names map to zones (NOHEAD keeps a head-shaped part as torso)', () => {
    expect(zoneOfPart('head')).toBe('head');
    expect(zoneOfPart('earL')).toBe('head');
    expect(zoneOfPart('head', true)).toBe('torso');
    expect(zoneOfPart('thighR')).toBe('legs');
    expect(zoneOfPart('legFL')).toBe('legs');
    expect(zoneOfPart('uArmR')).toBe('limb');
    expect(zoneOfPart('tail')).toBe('limb');
    expect(zoneOfPart('hips')).toBe('torso');
  });

  it('an unbuilt or hidden model defers to the column rule', () => {
    const rig = makeRig(bodyShapeOf(MON.mon_zombie));
    const layer = new CharLayer(false);
    const inst = layer.add(rig, { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 });
    expect(pickModel(inst, { x: 0, y: 10, h: 1.6 }, { x: 0, y: -1, h: 0 })).toBeUndefined();
    inst.setPose(idle);
    inst.build(null);
    inst.setVisible(false);
    expect(pickModel(inst, { x: 0, y: 10, h: 1.6 }, { x: 0, y: -1, h: 0 })).toBeUndefined();
  });
});

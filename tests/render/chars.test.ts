import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { archetypeOf, bodyShapeOf, weaponOf, ARCHETYPES, type Archetype } from '../../src/render/chars/archetype';
import { paintStyled, personPalette } from '../../src/render/chars/styled';
import { buildHeld, heldClass, heldVariant } from '../../src/render/chars/held';
import { makeRig, type PoseIn } from '../../src/render/chars/rig';
import { analyseSprite, netSize, paintPart, texelDims, type Img } from '../../src/render/chars/paint';
import { CharLayer, type Skin } from '../../src/render/chars/charLayer';
import monsters from '../../public/data/monsters.json';
import { bodyHeightOf } from '../../src/game/aimmodel';

type Mon = { id: string; bodytype?: string; species?: string[]; flags?: string[]; symbol?: string; volume?: number; name?: unknown; description?: string };
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
  it('selects distinct common quadruped families from BN identity', () => {
    const families = { mon_dog: 'canine', mon_deer: 'cervid', mon_moose: 'cervid', mon_horse: 'equine', mon_horse_foal: 'equine', mon_bear: 'bear', mon_pig: 'pig', mon_gator: 'reptile', mon_cougar: 'feline' };
    for (const [id, family] of Object.entries(families)) expect(bodyShapeOf(MON[id]).variant, id).toBe(family);
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
    for (const id of ['mon_zombie', 'mon_dog', 'mon_rabbit', 'mon_giant_cockroach', 'mon_spider_wolf_giant', 'mon_blob', 'mon_triffid', 'mon_zombie_hulk', 'mon_deer', 'mon_horse', 'mon_moose', 'mon_bear', 'mon_pig', 'mon_gator', 'mon_cougar']) {
      const { box, rig } = bounds(MON[id]);
      expect(Math.abs(box.min.y), id).toBeLessThan(0.06 * rig.shape.scale + 0.02);
      expect(Math.abs(box.max.y - rig.height), id).toBeLessThan(0.12 * rig.shape.scale + 0.05);
    }
  });
  it('adds family anatomy with ordered, animated parents', () => {
    const anatomy = { mon_horse: ['neck', 'mane', 'hoof'], mon_deer: ['neck', 'clovenHoof'], mon_bear: ['shoulderHump', 'paw'], mon_pig: ['nosePad', 'tailCurl', 'clovenHoof'], mon_gator: ['tailTip', 'backPlate'], mon_cougar: ['paw'] };
    for (const [id, names] of Object.entries(anatomy)) {
      const rig = makeRig(bodyShapeOf(MON[id]));
      for (const name of names) expect(rig.parts.some(p => p.name.startsWith(name)), `${id} ${name}`).toBe(true);
      for (let i = 0; i < rig.parts.length; i++) expect(rig.parts[i].parent, `${id} ${i}`).toBeLessThan(i);
      for (const pose of [{ gait: 1, phase: 0.35 }, { windup: 1 }, { strike: 1 }, { dead: true, down: 1 }] as Partial<PoseIn>[]) {
        const { box } = bounds(MON[id], pose);
        for (const n of [...box.min.toArray(), ...box.max.toArray()]) expect(Number.isFinite(n), id).toBe(true);
      }
    }
    for (const id of Object.keys(anatomy)) {
      const rig = makeRig(bodyShapeOf(MON[id]));
      const { box } = bounds(MON[id], { dead: true, down: 1 }, i => { i.fall = rig.lie.angle; i.fallDx = 1; i.fallDy = 0; i.lift = rig.lie.lift; });
      for (const n of [...box.min.toArray(), ...box.max.toArray()]) expect(Number.isFinite(n), `${id} corpse`).toBe(true);
      expect(box.max.y, `${id} corpse`).toBeLessThan(rig.height + 0.1);
    }
    expect(makeRig(bodyShapeOf(MON.mon_dog)).parts.length).toBe(10);
    // A generic deer can be male or female: identity alone doesn't add antlers.
    expect(makeRig(bodyShapeOf(MON.mon_deer)).parts.some(p => p.name.includes('antler'))).toBe(false);
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

describe('crawlers (game/crawl.ts)', () => {
  it('reads crawling from the BN data, not from a walker', () => {
    expect(bodyShapeOf(MON.mon_zombie_crawler).crawl).toBe('drag');
    expect(bodyShapeOf(MON.mon_crawler).crawl).toBe('drag');
    expect(bodyShapeOf(MON.mon_zombie_crawler_pupa).crawl).toBe('legless');
    expect(bodyShapeOf(MON.mon_zombie_creepy).crawl).toBe('fours');
    for (const id of ['mon_zombie', 'mon_zombie_child', 'mon_zombie_gasbag_crawler', 'mon_sludge_crawler', 'mon_zombie_thorny']) expect(bodyShapeOf(MON[id]).crawl, id).toBeUndefined();
  });
  it('lies low on the floor, never through it, crawling or not, and is as tall as it says', () => {
    for (const id of ['mon_zombie_crawler', 'mon_crawler', 'mon_zombie_crawler_pupa', 'mon_zombie_creepy']) {
      for (const pose of [{}, { gait: 1, phase: 0.25 }, { gait: 1, phase: 0.625 }, { windup: 1 }] as Partial<PoseIn>[]) {
        const { box, rig } = bounds(MON[id], pose);
        expect(box.min.y, `${id} ${JSON.stringify(pose)}`).toBeGreaterThan(-0.06);
        expect(rig.height, id).toBeLessThan(0.8);
        // rearing up to bite stands taller for a moment
        expect(box.max.y, id).toBeLessThan(rig.height + (pose.windup ? 0.3 : 0.08));
        if (!pose.windup) expect(Math.abs(box.max.y - rig.height), id).toBeLessThan(0.08);
      }
    }
    // the dragging crawler is long, not tall: the legs trail behind
    const { box } = bounds(MON.mon_zombie_crawler);
    expect(box.max.z - box.min.z).toBeGreaterThan(1.6);
    // the half-corpse has no legs to trail (scaled to nothing)
    const rig = makeRig(bodyShapeOf(MON.mon_zombie_crawler_pupa));
    const inst = new CharLayer(false).add(rig, { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 });
    inst.setPose(idle);
    inst.build(null);
    for (const name of ['thighR', 'shinL', 'footR']) {
      const i = rig.parts.findIndex((q) => q.name === name);
      // the box's axes (the matrix's 3x3) are all zero
      expect(Math.max(...Array.from(inst.mats.subarray(i * 16, i * 16 + 12)).map(Math.abs)), name).toBeLessThan(1e-6);
    }
  });
  it('crawls: the arms move through a stroke (not the walk cycle) while the legs drag', () => {
    const a = bounds(MON.mon_zombie_crawler, { gait: 1, phase: 0 }).box, b = bounds(MON.mon_zombie_crawler, { gait: 1, phase: 0.3 }).box;
    expect(a.equals(b)).toBe(false);
  });
  it("the game's body column (no model drawn) is a crawler's height too", () => {
    expect(bodyHeightOf({ size: 'medium', type: MON.mon_zombie_crawler })).toBeLessThan(0.6);
    expect(bodyHeightOf({ size: 'medium', type: MON.mon_zombie })).toBe(1.7);
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

describe('styled person skins', () => {
  // a crude 12x24 person: brown hair, pink face, red shirt, blue pants, black shoes
  const img: Img = { w: 12, h: 24, data: new Uint8Array(12 * 24 * 4) };
  const band = (y0: number, y1: number, c: [number, number, number]) => {
    for (let y = y0; y < y1; y++) for (let x = 1; x < 11; x++) img.data.set([...c, 255], (y * 12 + x) * 4);
  };
  band(0, 2, [90, 60, 30]);
  band(2, 5, [230, 180, 150]);
  band(5, 13, [200, 40, 40]);
  band(13, 22, [40, 60, 150]);
  band(22, 24, [30, 30, 30]);
  const info = analyseSprite(img);

  it('reads a semantic palette off the sprite', () => {
    const pp = personPalette(info, false);
    expect(pp.hair[0]).toBeGreaterThan(pp.hair[2]);
    expect(pp.skin[0]).toBeGreaterThan(200);
    expect(pp.shirt[0]).toBeGreaterThan(150);
    expect(pp.pants[2]).toBeGreaterThan(120);
  });
  it('paints a face on the front and hair on the back of the head', () => {
    const pp = personPalette(info, false);
    const dims: [number, number, number] = [8, 8, 8];
    const [nw, nh] = netSize(...dims);
    const dst: Img = { w: nw, h: nh, data: new Uint8Array(nw * nh * 4) };
    paintStyled(dst, 0, 0, dims, 'head', pp, 0.5);
    const px = (x: number, y: number) => Array.from(dst.data.slice((y * nw + x) * 4, (y * nw + x) * 4 + 3));
    // back face (x 24..31, y 8..15): hair on the top rows
    expect(px(27, 9)[0]).toBeLessThan(140);
    // the front face's eye row (y = 8 + 4) has a dark pupil
    const row = [...Array(8)].map((_, i) => px(8 + i, 12));
    expect(Math.min(...row.map((c) => c[0] + c[1] + c[2]))).toBeLessThan(150);
  });
});

describe('weapons', () => {
  it('maps wielded items to meshes', () => {
    expect(weaponOf(null)).toBe('none');
    expect(weaponOf({ isGun: () => true, def: { skill: 'rifle', volume: 3000 } })).toBe('rifle');
    expect(weaponOf({ isGun: () => true, def: { skill: 'pistol', volume: 400 } })).toBe('pistol');
    expect(weaponOf({ isGun: () => false, def: { volume: 2000 } })).toBe('long');
    expect(weaponOf({ isGun: () => false, def: { volume: 250 } })).toBe('short');
    const rig = makeRig({ ...bodyShapeOf({ id: 'npc', bodytype: 'human', species: ['HUMAN'] }), weapon: 'rifle' });
    expect(rig.parts[rig.parts.length - 1].name).toBe('weapon');
  });
});

describe('detailed NPC held items', () => {
  const pal = analyseSprite({ w: 1, h: 1, data: new Uint8Array([120, 80, 50, 255]) }).pal;
  const body = bodyShapeOf({ id: 'npc', bodytype: 'human', species: ['HUMAN'] });
  it('attaches every detailed part to the weapon grip with valid parent ordering', () => {
    for (const cls of ['rifle', 'pistol', 'axe', 'knife', 'spear', 'hammer'] as const) {
      const held = buildHeld(cls, pal, 1000);
      const rig = makeRig({ ...body, weapon: cls === 'rifle' || cls === 'pistol' ? cls : 'long' }, { held });
      const grip = rig.parts.findIndex(p => p.name === 'weapon');
      expect(rig.parts.filter(p => p.name.startsWith('weapon:'))).toHaveLength(held.parts.length);
      rig.parts.forEach((p, index) => expect(p.parent, `${cls}:${p.name}`).toBeLessThan(index));
      for (const part of rig.parts.filter(p => p.name.startsWith('weapon:'))) {
        let parent = part.parent;
        while (parent > grip) parent = rig.parts[parent].parent;
        expect(parent).toBe(grip);
      }
    }
  });
  it('keeps item variant details and stows the whole subtree while crawling', () => {
    const ar = buildHeld('rifle', pal, 3000, 'ar'), ak = buildHeld('rifle', pal, 3000, 'ak');
    const names = (h: typeof ar) => makeRig({ ...body, weapon: 'rifle' }, { held: h }).parts.map(p => p.name);
    expect(names(ar)).not.toEqual(names(ak));
    const rig = makeRig({ ...body, weapon: 'rifle', crawl: 'drag' }, { held: ar });
    const inst = new CharLayer(false).add(rig, { page: 0, rects: new Int32Array(rig.parts.length * 5), refs: 0 });
    for (const pose of [idle, { ...idle, ride: { lean: .1, hands: [[.2,.8,-.3],[-.2,.8,-.3]], feet: [[.2,.1,-.3],[-.2,.1,-.3]] } }] as PoseIn[]) {
    inst.setPose(pose); inst.build(null);
    rig.parts.forEach((part, i) => {
      if (!part.name.startsWith('weapon')) return;
      const matrix = inst.mats.subarray(i * 16, i * 16 + 16);
      const axes = [0,1,2,4,5,6,8,9,10].map(j => Math.abs(matrix[j]));
      expect(Math.max(...axes), part.name).toBeLessThan(1e-6);
    });
    }
  });
});

describe('first-person held items', () => {
  const pal = analyseSprite({ w: 1, h: 1, data: new Uint8Array([120, 80, 50, 255]) }).pal;
  it('classifies wielded items', () => {
    const gun = (skill: string) => ({ typeId: 'x', isGun: () => true, def: { skill } });
    expect(heldClass(gun('pistol'))).toBe('pistol');
    expect(heldClass(gun('shotgun'))).toBe('shotgun');
    expect(heldClass(gun('smg'))).toBe('smg');
    expect(heldClass({ typeId: 'crossbow', isGun: () => true, def: { skill: 'rifle' } })).toBe('crossbow');
    expect(heldClass({ typeId: 'bat' })).toBe('bat');
    expect(heldClass({ typeId: 'knife_combat' })).toBe('knife');
    expect(heldClass({ typeId: 'fire_ax' })).toBe('axe');
    expect(heldClass({ typeId: 'spear_wood' })).toBe('spear');
    expect(heldClass({ typeId: 'katana' })).toBe('sword');
    expect(heldClass({ typeId: 'machete' })).toBe('machete');
    expect(heldClass({ typeId: 'pipe' })).toBe('pipe');
    expect(heldClass({ typeId: 'flashlight' })).toBe('flashlight');
    expect(heldClass({ typeId: 'can_beans' })).toBe('generic');
  });
  it('builds every class with valid parents, guns with a muzzle', () => {
    for (const c of ['pistol', 'rifle', 'shotgun', 'smg', 'launcher', 'crossbow', 'knife', 'machete', 'sword', 'axe', 'bat', 'pipe', 'spear', 'hammer', 'flashlight', 'generic'] as const) {
      const h = buildHeld(c, pal, 1000);
      expect(h.parts.length, c).toBeGreaterThan(0);
      h.parts.forEach((p, i) => expect(p.parent < i, `${c}:${p.name}`).toBe(true));
      if (h.gun) expect(h.muzzle, c).not.toBeNull();
    }
  });
});

describe('weapon variants', () => {
  it('tells common weapons apart', () => {
    const it = (typeId: string, o: Record<string, unknown> = {}) => ({ typeId, isGun: () => !!o.gun, def: o as never });
    expect(heldVariant(it('model_10_revolver', { gun: true, weapon_category: ['REVOLVERS'] }), 'pistol')).toBe('revolver');
    expect(heldVariant(it('m1911', { gun: true }), 'pistol')).toBe('1911');
    expect(heldVariant(it('glock_19', { gun: true }), 'pistol')).toBe('auto');
    expect(heldVariant(it('shotgun_d'), 'shotgun')).toBe('double');
    expect(heldVariant(it('remington_870'), 'shotgun')).toBe('pump');
    expect(heldVariant(it('ak47'), 'rifle')).toBe('ak');
    expect(heldVariant(it('remington_700', { weapon_category: ['RIFLES', 'MANUAL_ACTION'] }), 'rifle')).toBe('hunting');
    expect(heldVariant(it('m4a1'), 'rifle')).toBe('ar');
    expect(heldVariant(it('marlin_1894c', { weapon_category: ['RIFLES', 'MANUAL_ACTION'], looks_like: 'ar15' }), 'rifle')).toBe('lever');
    expect(heldVariant(it('marlin_9a'), 'rifle')).toBe('lever');
    expect(heldVariant(it('henry_big_boy'), 'rifle')).toBe('lever_brass');
    expect(heldVariant(it('1895sbl'), 'rifle')).toBe('lever_stainless');
    expect(heldVariant(it('browning_blr'), 'rifle')).toBe('lever_box');
    expect(heldVariant(it('winchester_1887', { looks_like: 'browning_blr' }), 'shotgun')).toBe('lever');
    expect(heldVariant(it('crowbar'), 'pipe')).toBe('crowbar');
    expect(heldVariant(it('knife_chef'), 'knife')).toBe('kitchen');
    expect(heldVariant(it('hammer_sledge'), 'hammer')).toBe('sledge');
    expect(heldVariant(it('hatchet'), 'axe')).toBe('hatchet');
  });
  it('gives lever actions a tube magazine, lever loop and hammer, no bolt handle or scope', () => {
    const pal = analyseSprite({ w: 1, h: 1, data: new Uint8Array([120, 80, 50, 255]) }).pal;
    const names = buildHeld('rifle', pal, 2500, 'lever').parts.map((p) => p.name);
    for (const n of ['tube', 'lever', 'loopB', 'hammer', 'gate', 'stock', 'butt']) expect(names).toContain(n);
    for (const n of ['scope', 'mag']) expect(names).not.toContain(n);
    const blr = buildHeld('rifle', pal, 3000, 'lever_box').parts.map((p) => p.name);
    expect(blr).toContain('mag');
    expect(blr).not.toContain('tube');
  });
  it('builds every variant with valid parents', () => {
    const pal = analyseSprite({ w: 1, h: 1, data: new Uint8Array([120, 80, 50, 255]) }).pal;
    for (const [c, v] of [['pistol', 'revolver'], ['pistol', '1911'], ['shotgun', 'double'], ['shotgun', 'single'], ['rifle', 'ak'], ['rifle', 'hunting'], ['rifle', 'lever'], ['rifle', 'lever_brass'], ['rifle', 'lever_stainless'], ['rifle', 'lever_box'], ['shotgun', 'lever'], ['pipe', 'crowbar'], ['knife', 'kitchen'], ['hammer', 'sledge'], ['axe', 'hatchet'], ['axe', 'fire']] as const) {
      const h = buildHeld(c, pal, 1000, v);
      h.parts.forEach((p, i) => expect(p.parent < i, `${c}/${v}:${p.name}`).toBe(true));
      if (h.gun) expect(h.muzzle).not.toBeNull();
    }
  });
});

describe('round 6 body plans', () => {
  it('picks distinct plans for common bugs, fliers and zombie kinds', () => {
    const v = (id: string) => bodyShapeOf(MON[id]).variant;
    expect(v('mon_wasp')).toBe('wasp');
    expect(v('mon_bee')).toBe('bee');
    expect(v('mon_ant')).toBe('ant');
    expect(v('mon_spider_wolf_giant')).toBe('spider');
    expect(v('mon_mosquito_giant')).toBe('mosquito');
    expect(v('mon_crow')).toBe('bird');
    expect(v('mon_bat')).toBe('bat');
    expect(v('mon_boomer')).toBe('bloated');
    expect(v('mon_zombie_hulk')).toBe('hulk');
    expect(v('mon_skeleton')).toBe('skeletal');
  });
  it('builds them all with valid parents, and hair/headgear pieces for people', () => {
    for (const id of ['mon_wasp', 'mon_bee', 'mon_ant', 'mon_fly', 'mon_mosquito_giant', 'mon_dragonfly_giant', 'mon_crow', 'mon_bat', 'mon_boomer', 'mon_zombie_hulk', 'mon_skeleton', 'mon_zombie_acidic', 'mon_zombie_electric', 'mon_zombie_scorched']) {
      const rig = makeRig(bodyShapeOf(MON[id]));
      rig.parts.forEach((p, i) => expect(p.parent < i, `${id}:${p.name}`).toBe(true));
    }
    for (const hair of ['short', 'long', 'ponytail', 'cap', 'hat', 'helmet'] as const) {
      const rig = makeRig({ ...bodyShapeOf({ id: 'npc', bodytype: 'human', species: ['HUMAN'] }), hair });
      expect(rig.parts.some((p) => p.name.startsWith('head') && p.name !== 'head'), hair).toBe(true);
    }
  });
});
